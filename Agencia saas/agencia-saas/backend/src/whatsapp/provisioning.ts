import { withTenant } from '../db.js';
import { encryptToken, decryptToken } from '../security/vault.js';
import { graph } from './providers/metaCloud.js';
import { twilioApi, twilioGet, twilioPost } from './providers/twilio.js';
import { audit } from '../audit/audit.js';
import { applyQuality } from './webhooks.js';

/*
 * FLUXO RECOMENDADO DE ISOLAMENTO
 * 1) O dono do negócio faz o Embedded Signup (pop-up oficial da Meta dentro da plataforma):
 *    cria/escolhe o PRÓPRIO portfólio e WABA. A agência recebe acesso como Tech Provider.
 *    -> limites, qualidade e eventuais punições ficam restritos àquele negócio.
 * 2) Se o cliente não tem número, a plataforma compra um número virtual (Twilio) e o adiciona ao WABA.
 * 3) A Meta liga para o número com o código; a ligação é gravada e o operador digita o código no painel.
 */

/** Passo 1 — troca o `code` do Embedded Signup por token e liga o WABA do cliente ao app da agência. */
export async function connectEmbeddedSignup(tenantId: string, actorId: string,
                                            p: { code: string; wabaId: string; phoneNumberId?: string }) {
  const tokenRes = await fetch(`https://graph.facebook.com/${process.env.META_API_VERSION}/oauth/access_token?` +
    new URLSearchParams({ client_id: process.env.META_APP_ID!, client_secret: process.env.META_APP_SECRET!, code: p.code }));
  const { access_token } = (await tokenRes.json()) as any;
  if (!access_token) throw Object.assign(new Error('Não foi possível concluir a conexão com a Meta'), { status: 400 });

  await graph(`${p.wabaId}/subscribed_apps`, access_token, {});      // passa a receber webhooks deste WABA
  const waba = await graph(`${p.wabaId}?fields=owner_business_info`, access_token);

  await withTenant(tenantId, async c => {
    await c.query(`INSERT INTO channel_connections (tenant_id, provider, external_id, token_cipher)
                   VALUES ($1, 'whatsapp', $2, $3)
                   ON CONFLICT (tenant_id, provider, external_id) DO UPDATE SET token_cipher = EXCLUDED.token_cipher`,
                  [tenantId, p.wabaId, encryptToken(access_token)]);
    await audit({ actorId, tenantId, action: 'wa.embedded_signup', target: p.wabaId }, c);
  });
  if (p.phoneNumberId) await registerNumber(tenantId, p.wabaId, p.phoneNumberId, waba.owner_business_info?.id);
}

/** Passo 2 — compra um número virtual com voz na Twilio (Brasil exige pacote regulatório aprovado). */
export async function buyVirtualNumber(tenantId: string, actorId: string, areaCode?: string) {
  const qs = new URLSearchParams({ VoiceEnabled: 'true', ...(areaCode ? { Contains: `+55${areaCode}` } : {}) });
  const list = await twilioGet(twilioApi(`AvailablePhoneNumbers/BR/Local.json?${qs}`));
  const candidate = list.available_phone_numbers?.[0]?.phone_number;
  if (!candidate) throw Object.assign(new Error('Nenhum número disponível nessa região agora'), { status: 409 });

  const bought = await twilioPost(twilioApi('IncomingPhoneNumbers.json'), {
    PhoneNumber: candidate,
    VoiceUrl: `${process.env.PUBLIC_URL}/webhooks/whatsapp/twilio/voz`,
    BundleSid: process.env.TWILIO_BR_BUNDLE_SID!, AddressSid: process.env.TWILIO_BR_ADDRESS_SID!,
  });
  const numberId = await withTenant(tenantId, async c => {
    const { rows } = await c.query(`INSERT INTO wa_numbers (tenant_id, provider, phone_e164, twilio_number_sid, status)
                                    VALUES ($1, 'meta_cloud', $2, $3, 'provisioning') RETURNING id`,
                                   [tenantId, bought.phone_number, bought.sid]);
    await audit({ actorId, tenantId, action: 'wa.number_bought', target: bought.phone_number }, c);
    return rows[0].id as string;
  });
  return { numberId, phone: bought.phone_number as string };
}

/** Passo 3 — adiciona o número ao WABA do cliente e pede o código por LIGAÇÃO (cai na gravação). */
export async function addNumberToWaba(tenantId: string, numberId: string, wabaId: string, displayName: string) {
  const { n, token } = await withTenant(tenantId, async c => ({
    n: (await c.query(`SELECT phone_e164 FROM wa_numbers WHERE id = $1`, [numberId])).rows[0],
    token: decryptToken((await c.query(`SELECT token_cipher FROM channel_connections
                                       WHERE provider = 'whatsapp' AND external_id = $1`, [wabaId])).rows[0].token_cipher),
  }));
  const local = n.phone_e164.replace(/^\+55/, '');
  const created = await graph(`${wabaId}/phone_numbers`, token, { cc: '55', phone_number: local, verified_name: displayName });
  await graph(`${created.id}/request_code`, token, { code_method: 'VOICE', language: 'pt_BR' });
  await withTenant(tenantId, c => c.query(
    `UPDATE wa_numbers SET phone_number_id = $2, waba_id = $3, verified_name = $4, status = 'awaiting_code' WHERE id = $1`,
    [numberId, created.id, wabaId, displayName]));
}

/** Passo 4 — operador ouviu a gravação e digitou o código. Verifica e registra na Cloud API. */
export async function submitVerificationCode(tenantId: string, actorId: string, numberId: string, code: string) {
  const n = await withTenant(tenantId, async c =>
    (await c.query(`SELECT phone_number_id, waba_id FROM wa_numbers WHERE id = $1 AND status = 'awaiting_code'`, [numberId])).rows[0]);
  if (!n) throw Object.assign(new Error('Número não está aguardando código'), { status: 409 });
  const token = await tokenFor(tenantId, n.waba_id);
  await graph(`${n.phone_number_id}/verify_code`, token, { code });
  await registerNumber(tenantId, n.waba_id, n.phone_number_id);
  await audit({ actorId, tenantId, action: 'wa.number_verified', target: n.phone_number_id });
}

async function tokenFor(tenantId: string, wabaId: string) {
  return withTenant(tenantId, async c => decryptToken((await c.query(
    `SELECT token_cipher FROM channel_connections WHERE provider = 'whatsapp' AND external_id = $1`, [wabaId])).rows[0].token_cipher));
}

async function registerNumber(tenantId: string, wabaId: string, phoneNumberId: string, portfolioId?: string) {
  const token = await tokenFor(tenantId, wabaId);
  const pin = String(Math.floor(100000 + Math.random() * 900000));   // PIN da verificação em duas etapas
  await graph(`${phoneNumberId}/register`, token, { messaging_product: 'whatsapp', pin });
  const info = await graph(`${phoneNumberId}?fields=display_phone_number,verified_name,name_status,quality_rating,whatsapp_business_manager_messaging_limit`, token);
  const e164 = `+${String(info.display_phone_number).replace(/\D/g, '')}`;
  const numberId = await withTenant(tenantId, async c => (await c.query(`
    INSERT INTO wa_numbers (tenant_id, provider, phone_e164, phone_number_id, waba_id, portfolio_id, verified_name, name_status, status)
    VALUES ($1, 'meta_cloud', $2, $3, $4, $5, $6, $7, 'active')
    ON CONFLICT (phone_e164) DO UPDATE SET phone_number_id = EXCLUDED.phone_number_id, waba_id = EXCLUDED.waba_id,
      portfolio_id = coalesce(EXCLUDED.portfolio_id, wa_numbers.portfolio_id), verified_name = EXCLUDED.verified_name,
      name_status = EXCLUDED.name_status, status = 'active', verification_rec_url = NULL
    RETURNING id`, [tenantId, e164, phoneNumberId, wabaId, portfolioId ?? null, info.verified_name, info.name_status])).rows[0].id);
  // guarde o PIN cifrado se quiser migrar o número no futuro (aqui omitido por simplicidade)
  await applyQuality(tenantId, numberId, info.quality_rating ?? 'UNKNOWN', info.whatsapp_business_manager_messaging_limit);
}

/** Checagem periódica (ex.: a cada 6h): qualidade, limite e status do nome de exibição. */
export async function refreshNumberHealth(tenantId: string, numberId: string) {
  const n = await withTenant(tenantId, async c =>
    (await c.query(`SELECT phone_number_id, waba_id FROM wa_numbers WHERE id = $1`, [numberId])).rows[0]);
  if (!n?.phone_number_id) return;
  const info = await graph(`${n.phone_number_id}?fields=quality_rating,name_status,whatsapp_business_manager_messaging_limit`,
                           await tokenFor(tenantId, n.waba_id));
  await applyQuality(tenantId, numberId, info.quality_rating ?? 'UNKNOWN', info.whatsapp_business_manager_messaging_limit);
}
