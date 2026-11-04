import { Router } from 'express';
import { z } from 'zod';
import { adminPool, withSystem, withTenant } from '../db.js';
import { audit } from '../audit/audit.js';
import { asaas, billingReady } from '../finance/billing.js';
import { encryptToken, decryptToken } from '../security/vault.js';
import { assertNotPanicking } from '../security/panic.js';
import { verifyUserCode } from '../auth/mfa.js';
import { notify } from '../notify.js';
import { mailReady, sendMail } from '../mail.js';
import { requireRecentMfa } from '../middleware/auth.js';

/*
 * CARTEIRA — cada cliente tem uma SUBCONTA no Asaas (instituição de pagamento autorizada pelo Banco Central).
 * O dinheiro fica no Asaas; aqui guardamos só a chave da subconta (cifrada) e o histórico.
 *
 * Toda saída de dinheiro (envio a outro cliente ou saque para banco) exige:
 *   1. código do autenticador NA HORA (vale uma vez; 5 erros = 15 min sem transações);
 *   2. carteira aprovada e não bloqueada; modo pânico desligado;
 *   3. nenhum aparelho novo, troca de senha ou redefinição de 2FA nas últimas 24 h (golpe de conta invadida);
 *   4. limite por operação e por dia; mais de 10 saídas em 1 hora bloqueia a carteira e avisa o administrador;
 *   5. saque só para chave PIX cadastrada há mais de 24 h; e-mail a cada saque e a cada chave nova;
 *   6. chave de idempotência: o mesmo pedido nunca sai duas vezes.
 */
export const walletRouter = Router();
const tid = (req: any) => req.user!.tid as string;
const TX_MAX = () => Number(process.env.WALLET_TX_MAX_CENTS ?? 500_000);        // R$ 5.000 por operação
const DAY_MAX = () => Number(process.env.WALLET_DAILY_MAX_CENTS ?? 1_000_000);  // R$ 10.000 por dia
const HOUR_MAX = 10;
const err = (msg: string, status = 400) => Object.assign(new Error(msg), { status });
const reais = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

async function account(tenantId: string) {
  return withTenant(tenantId, async c => (await c.query(`SELECT * FROM wallet_accounts WHERE tenant_id = $1`, [tenantId])).rows[0]);
}
const keyOf = (w: any) => decryptToken(w.api_key_cipher);

walletRouter.get('/', async (req, res) => {
  const w = await account(tid(req));
  if (!w) return res.json({ open: false, ready: billingReady(), limits: { txMax: TX_MAX(), dayMax: DAY_MAX() } });
  const [bal, st, keys, txs] = await Promise.all([
    w.status === 'active' ? asaas('/finance/balance', undefined, { apiKey: keyOf(w), panicOk: true }).catch(() => null) : null,
    w.status !== 'blocked' ? asaas('/financialTransactions?limit=30', undefined, { apiKey: keyOf(w), panicOk: true }).catch(() => null) : null,
    withTenant(tid(req), async c => (await c.query(`SELECT id, key_type, regexp_replace(key_value, '.(?=.{4})', '•', 'g') AS key_masked, active_from,
                                                            active_from <= now() AS ativa FROM wallet_payout_keys WHERE removed_at IS NULL ORDER BY created_at`)).rows),
    withTenant(tid(req), async c => (await c.query(`SELECT w.id, w.kind, w.amount_cents::int, w.status, w.description, w.error, w.created_at, t.name AS contraparte
                                                      FROM wallet_txs w LEFT JOIN tenants t ON t.id = w.counterparty_tenant ORDER BY w.created_at DESC LIMIT 50`)).rows),
  ]);
  res.json({ open: true, status: w.status, blockedReason: w.blocked_reason, pixKey: w.pix_key, balanceCents: bal ? Math.round(bal.balance * 100) : null,
             statement: (st?.data ?? []).map((t: any) => ({ date: t.date, valueCents: Math.round(t.value * 100), description: t.description, type: t.type })),
             payoutKeys: keys, txs, limits: { txMax: TX_MAX(), dayMax: DAY_MAX() } });
});

/** Abre a subconta. Os dados vão direto ao Asaas (exigência do Banco Central para conta de pagamento). */
walletRouter.post('/open', requireRecentMfa, async (req, res) => {
  const b = z.object({ birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), mobilePhone: z.string().regex(/^\d{10,11}$/),
                       postalCode: z.string().regex(/^\d{8}$/), address: z.string().trim().min(3).max(120), addressNumber: z.string().trim().min(1).max(10),
                       province: z.string().trim().min(2).max(80), incomeValue: z.number().positive().max(1e9) }).parse(req.body);
  await assertNotPanicking();
  if (await account(tid(req))) throw err('Carteira já aberta', 409);
  const t = (await adminPool.query(`SELECT t.name, t.document, u.email FROM tenants t JOIN users u ON u.tenant_id = t.id AND u.role IN ('owner', 'platform_admin')
                                     WHERE t.id = $1 ORDER BY u.created_at LIMIT 1`, [tid(req)])).rows[0];
  if (!t?.document) throw err('Cadastre o CPF da conta antes de abrir a carteira (fale com o suporte)');
  const a = await asaas('/accounts', { name: t.name, email: t.email, cpfCnpj: t.document.replace(/\D/g, ''), ...b });
  if (!a.apiKey || !a.walletId) throw err('Asaas não devolveu a subconta. Tente de novo.', 502);
  await withTenant(tid(req), c => c.query(`INSERT INTO wallet_accounts (tenant_id, asaas_account_id, wallet_id, api_key_cipher) VALUES ($1, $2, $3, $4)`,
                                          [tid(req), a.id, a.walletId, encryptToken(a.apiKey)]));
  await audit({ actorId: req.user!.sub, tenantId: tid(req), ip: req.ip, action: 'wallet.opened' });
  res.status(201).json({ ok: true });
});

/** Documentos pedidos pelo Asaas (selfie, documento com foto) e situação da aprovação. */
walletRouter.post('/refresh', async (req, res) => {
  const w = await account(tid(req));
  if (!w) throw err('Abra a carteira primeiro', 404);
  const st = await asaas('/myAccount/status', undefined, { apiKey: keyOf(w), panicOk: true });
  const docs = await asaas('/myAccount/documents', undefined, { apiKey: keyOf(w), panicOk: true }).catch(() => ({ data: [] }));
  if (w.status === 'pending' && st.general === 'APPROVED') {
    let pix = w.pix_key;
    if (!pix) {
      const keys = await asaas('/pix/addressKeys?status=ACTIVE', undefined, { apiKey: keyOf(w) });
      pix = keys?.data?.[0]?.key ?? (await asaas('/pix/addressKeys', { type: 'EVP' }, { apiKey: keyOf(w) })).key;
    }
    await withTenant(tid(req), c => c.query(`UPDATE wallet_accounts SET status = 'active', pix_key = $2 WHERE tenant_id = $1`, [tid(req), pix ?? null]));
    await audit({ actorId: req.user!.sub, tenantId: tid(req), ip: req.ip, action: 'wallet.approved' });
  }
  res.json({ general: st.general, documents: (docs.data ?? []).map((d: any) => ({ title: d.title, status: d.status, onboardingUrl: d.onboardingUrl })) });
});

/** Depósito: QR Code PIX da própria subconta (o dinheiro cai direto na carteira do cliente). */
walletRouter.post('/deposit', async (req, res) => {
  const b = z.object({ amountCents: z.number().int().min(100).max(100_000_000).optional() }).parse(req.body);
  const w = await account(tid(req));
  if (w?.status !== 'active' || !w.pix_key) throw err('Carteira ainda não aprovada');
  const qr = await asaas('/pix/qrCodes/static', { addressKey: w.pix_key, description: 'Depósito na carteira', value: b.amountCents ? b.amountCents / 100 : undefined },
                         { apiKey: keyOf(w) });
  res.json({ qr: qr.encodedImage ? `data:image/png;base64,${qr.encodedImage}` : null, copiaECola: qr.payload });
});

/** Confere o destinatário antes de enviar (mostra o nome parcialmente, para o cliente não errar a pessoa). */
walletRouter.get('/recipient', async (req, res) => {
  const email = z.string().email().parse(req.query.email).toLowerCase();
  const r = await withSystem(async c => (await c.query(`SELECT t.id, t.name FROM users u JOIN tenants t ON t.id = u.tenant_id JOIN wallet_accounts w ON w.tenant_id = t.id
                                     WHERE u.email = $1 AND t.status = 'active' AND w.status = 'active'`, [email])).rows[0]);
  if (!r || r.id === tid(req)) return res.status(404).json({ error: 'Nenhuma carteira ativa com este e-mail' });
  res.json({ name: r.name.split(/\s+/).map((p: string, i: number) => (i === 0 ? p : `${p[0]}.`)).join(' ') });
});

/** Regras antifraude comuns a envio e saque. */
async function guardOut(req: any, amountCents: number) {
  await assertNotPanicking();
  if (!(await verifyUserCode(req.user.sub, req.body?.code))) {
    await audit({ actorId: req.user.sub, tenantId: tid(req), ip: req.ip, action: 'wallet.code_failed' });
    throw err('Código do autenticador inválido. Digite o código atual do aplicativo.', 401);
  }
  const w = await account(tid(req));
  if (!w || w.status !== 'active') throw err(w?.status === 'blocked' ? `Carteira bloqueada: ${w.blocked_reason ?? 'fale com o suporte'}` : 'Carteira ainda não aprovada', 403);
  if (amountCents > TX_MAX()) throw err(`Limite por operação: ${reais(TX_MAX())}`);
  const risky = (await adminPool.query(
    `SELECT action FROM audit_log WHERE actor_id = $1 AND at > now() - make_interval(secs => $2)
        AND action IN ('auth.new_device', 'auth.password_changed', 'auth.password_reset', 'auth.totp_enabled') LIMIT 1`,
    [req.user.sub, Number(process.env.WALLET_COOLDOWN_SEC ?? 86_400)])).rows[0];
  if (risky && !req.user.imp) throw err('Por segurança, saídas de dinheiro ficam bloqueadas por 24 horas depois de entrar por um aparelho novo ou trocar senha/2FA.', 403);
  const used = await withTenant(tid(req), async c => (await c.query(
    `SELECT coalesce(sum(amount_cents) FILTER (WHERE created_at >= date_trunc('day', now())), 0)::bigint AS dia,
            count(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS hora
       FROM wallet_txs WHERE kind IN ('saque', 'envio') AND status IN ('pending', 'done')`)).rows[0]);
  if (Number(used.dia) + amountCents > DAY_MAX()) throw err(`Limite diário de ${reais(DAY_MAX())} atingido`);
  if (used.hora >= HOUR_MAX) {
    await withTenant(tid(req), c => c.query(`UPDATE wallet_accounts SET status = 'blocked', blocked_reason = 'Muitas saídas em pouco tempo (análise de segurança)' WHERE tenant_id = $1`, [tid(req)]));
    await audit({ actorId: req.user.sub, tenantId: tid(req), ip: req.ip, action: 'wallet.blocked_velocity' });
    throw err('Muitas saídas em pouco tempo: a carteira foi bloqueada para análise. Fale com o suporte.', 403);
  }
  return w;
}

const zOut = { amountCents: z.number().int().min(100), code: z.string(), idempotencyKey: z.string().uuid() };

/** Transferência entre clientes da plataforma (de subconta para subconta no Asaas). */
walletRouter.post('/send', async (req, res) => {
  const b = z.object({ ...zOut, email: z.string().email(), description: z.string().trim().max(140).optional() }).parse(req.body);
  const w = await guardOut(req, b.amountCents);
  const dest = await withSystem(async c => (await c.query(`SELECT t.id, t.name, w.wallet_id FROM users u JOIN tenants t ON t.id = u.tenant_id JOIN wallet_accounts w ON w.tenant_id = t.id
                                        WHERE u.email = $1 AND t.status = 'active' AND w.status = 'active'`, [b.email.toLowerCase()])).rows[0]);
  if (!dest || dest.id === tid(req)) throw err('Nenhuma carteira ativa com este e-mail', 404);
  const tx = await withTenant(tid(req), async c => (await c.query(
    `INSERT INTO wallet_txs (tenant_id, kind, amount_cents, counterparty_tenant, description, idempotency_key, ip)
     VALUES ($1, 'envio', $2, $3, $4, $5, $6::inet) ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING id`,
    [tid(req), b.amountCents, dest.id, b.description ?? null, b.idempotencyKey, req.ip ?? null])).rows[0]);
  if (!tx) throw err('Este envio já foi feito (pedido repetido)', 409);
  try {
    const t = await asaas('/transfers', { value: b.amountCents / 100, walletId: dest.wallet_id, description: b.description ?? 'Transferência entre clientes' }, { apiKey: keyOf(w) });
    await withSystem(async c => {
      await c.query(`UPDATE wallet_txs SET status = 'done', external_id = $2, pair_id = gen_random_uuid() WHERE id = $1`, [tx.id, t.id]);
      await c.query(`INSERT INTO wallet_txs (tenant_id, kind, amount_cents, counterparty_tenant, description, external_id, status, pair_id)
                     SELECT $1, 'recebimento', $2, $3, $4, $5, 'done', pair_id FROM wallet_txs WHERE id = $6`,
                    [dest.id, b.amountCents, tid(req), b.description ?? null, t.id, tx.id]);
    });
  } catch (e) {
    await withTenant(tid(req), c => c.query(`UPDATE wallet_txs SET status = 'failed', error = $2 WHERE id = $1`, [tx.id, (e as Error).message.slice(0, 300)]));
    throw e;
  }
  await audit({ actorId: req.user!.sub, tenantId: tid(req), ip: req.ip, action: 'wallet.sent', target: dest.id, meta: { cents: b.amountCents } });
  await notify(dest.id, 'sistema', `Você recebeu ${reais(b.amountCents)}`, b.description ?? 'Transferência de outro cliente da plataforma.');
  await notify(tid(req), 'sistema', `Você enviou ${reais(b.amountCents)} para ${dest.name}`);
  res.json({ ok: true });
});

walletRouter.post('/payout-keys', async (req, res) => {
  const b = z.object({ keyType: z.enum(['CPF', 'CNPJ', 'EMAIL', 'PHONE', 'EVP']), keyValue: z.string().trim().min(5).max(140), code: z.string() }).parse(req.body);
  if (!(await verifyUserCode(req.user!.sub, b.code))) throw err('Código do autenticador inválido', 401);
  const id = await withTenant(tid(req), async c => {
    if ((await c.query(`SELECT count(*)::int AS n FROM wallet_payout_keys WHERE removed_at IS NULL`)).rows[0].n >= 5) throw err('Máximo de 5 chaves de saque');
    return (await c.query(`INSERT INTO wallet_payout_keys (tenant_id, key_type, key_value) VALUES ($1, $2, $3) RETURNING id`, [tid(req), b.keyType, b.keyValue])).rows[0].id;
  });
  await audit({ actorId: req.user!.sub, tenantId: tid(req), ip: req.ip, action: 'wallet.payout_key_added', meta: { type: b.keyType } });
  const email = (await adminPool.query(`SELECT email FROM users WHERE id = $1`, [req.user!.sub])).rows[0]?.email;
  if (email && mailReady()) void sendMail(email, 'Nova chave de saque cadastrada',
    `Uma chave PIX de saque (${b.keyType}) foi cadastrada na sua carteira. Ela só poderá ser usada daqui a 24 horas. Se não foi você, remova a chave e troque a senha agora.`,
    `<p>Uma chave PIX de saque (<b>${b.keyType}</b>) foi cadastrada na sua carteira. Ela só poderá ser usada daqui a 24 horas.</p><p>Se não foi você, remova a chave e troque a senha agora.</p>`).catch(() => {});
  res.status(201).json({ id, ativaEm: '24 horas' });
});

walletRouter.delete('/payout-keys/:id', async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  await withTenant(tid(req), c => c.query(`UPDATE wallet_payout_keys SET removed_at = now() WHERE id = $1`, [id]));
  await audit({ actorId: req.user!.sub, tenantId: tid(req), ip: req.ip, action: 'wallet.payout_key_removed', target: id });
  res.json({ ok: true });
});

/** Saque para conta bancária (PIX), só para chave cadastrada há mais de 24 h. */
walletRouter.post('/withdraw', async (req, res) => {
  const b = z.object({ ...zOut, payoutKeyId: z.string().uuid() }).parse(req.body);
  const w = await guardOut(req, b.amountCents);
  const key = await withTenant(tid(req), async c => (await c.query(
    `SELECT * FROM wallet_payout_keys WHERE id = $1 AND removed_at IS NULL AND active_from <= now()`, [b.payoutKeyId])).rows[0]);
  if (!key) throw err('Chave de saque inexistente ou ainda na carência de 24 horas');
  const tx = await withTenant(tid(req), async c => (await c.query(
    `INSERT INTO wallet_txs (tenant_id, kind, amount_cents, payout_key_id, idempotency_key, ip, description)
     VALUES ($1, 'saque', $2, $3, $4, $5::inet, 'Saque via PIX') ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING id`,
    [tid(req), b.amountCents, key.id, b.idempotencyKey, req.ip ?? null])).rows[0]);
  if (!tx) throw err('Este saque já foi pedido (pedido repetido)', 409);
  try {
    const t = await asaas('/transfers', { value: b.amountCents / 100, operationType: 'PIX', pixAddressKey: key.key_value,
                                          pixAddressKeyType: key.key_type, description: 'Saque da carteira', externalReference: tx.id }, { apiKey: keyOf(w) });
    await withTenant(tid(req), c => c.query(`UPDATE wallet_txs SET status = 'done', external_id = $2 WHERE id = $1`, [tx.id, t.id]));
  } catch (e) {
    await withTenant(tid(req), c => c.query(`UPDATE wallet_txs SET status = 'failed', error = $2 WHERE id = $1`, [tx.id, (e as Error).message.slice(0, 300)]));
    throw e;
  }
  await audit({ actorId: req.user!.sub, tenantId: tid(req), ip: req.ip, action: 'wallet.withdraw', meta: { cents: b.amountCents } });
  const email = (await adminPool.query(`SELECT email FROM users WHERE id = $1`, [req.user!.sub])).rows[0]?.email;
  if (email && mailReady()) void sendMail(email, `Saque de ${reais(b.amountCents)} enviado`,
    `Um saque de ${reais(b.amountCents)} foi enviado para a sua chave PIX. Se não foi você, fale com o suporte imediatamente.`,
    `<p>Um saque de <b>${reais(b.amountCents)}</b> foi enviado para a sua chave PIX.</p><p>Se não foi você, fale com o suporte imediatamente.</p>`).catch(() => {});
  res.json({ ok: true });
});
