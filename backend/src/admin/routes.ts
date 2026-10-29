import { Router } from 'express';
import { z } from 'zod';
import { withAdmin, withService, adminPool } from '../db.js';
import { requireAdmin, requireRecentMfa } from '../middleware/auth.js';
import crypto from 'node:crypto';
import argon2 from 'argon2';
import { accountId, balance, post } from '../finance/ledger.js';
import { audit } from '../audit/audit.js';
import { redis } from '../redis.js';
import { pauseAllTenantCampaigns } from '../integrations/meta/ads.js';
import { billingReady, createCharge, createSubscription } from '../finance/billing.js';
import { panicInfo, setPanic } from '../security/panic.js';

export const adminRouter = Router();
adminRouter.use(requireAdmin);

// ---------- Dashboard: MRR e DRE por cliente ----------
adminRouter.get('/dashboard', async (_req, res) => {
  const data = await withAdmin(async c => {
    const mrr = await c.query(`
      SELECT coalesce(sum(amount_cents), 0)::text AS mrr_cents FROM payments
       WHERE kind = 'subscription' AND status = 'confirmed' AND confirmed_at >= date_trunc('month', now())`);
    // DRE do mês: Assinatura + Setup + Taxa de gestão - Custos de API = Lucro líquido
    // (a verba de mídia do cliente é repasse, não receita da agência)
    const dre = await c.query(`
      WITH m AS (SELECT date_trunc('month', now()) AS ini)
      SELECT t.id, t.name,
        coalesce(sum(p.amount_cents) FILTER (WHERE p.kind = 'subscription'), 0)::text AS assinatura,
        coalesce(sum(p.amount_cents) FILTER (WHERE p.kind IN ('setup','a_la_carte')), 0)::text AS setup_avulsos,
        coalesce(sum(p.amount_cents) FILTER (WHERE p.kind = 'media_budget'), 0)::text AS verba_midia_bruta,
        coalesce(sum(p.amount_cents * t.media_fee_bps / 10000) FILTER (WHERE p.kind = 'media_budget'), 0)::text AS taxa_gestao,
        (SELECT coalesce(sum(cost_cents), 0) FROM api_usage u, m WHERE u.tenant_id = t.id AND u.period = m.ini::date)::text AS custo_api
      FROM tenants t
      LEFT JOIN payments p ON p.tenant_id = t.id AND p.status = 'confirmed'
                          AND p.confirmed_at >= (SELECT ini FROM m)
      GROUP BY t.id ORDER BY t.name`);
    const profitAcc = await accountId(c, 'platform_profit');
    const fundAcc = await accountId(c, 'agency_media_fund');
    const counts = (await c.query(`SELECT count(*) FILTER (WHERE status = 'active')::int AS ativos,
                                          count(*) FILTER (WHERE status <> 'active')::int AS bloqueados FROM tenants`)).rows[0];
    const ia = (await c.query(`SELECT t.name, u.cost_cents::text, u.quota_cents::text FROM api_usage u JOIN tenants t ON t.id = u.tenant_id
                               WHERE u.period = date_trunc('month', now())::date ORDER BY u.cost_cents DESC LIMIT 10`)).rows;
    const pend = (await c.query(`SELECT count(*)::int AS n FROM content_items WHERE status = 'pending_approval'`)).rows[0].n;
    return { mrrCents: mrr.rows[0].mrr_cents, dre: dre.rows, clientes: counts, usoIA: ia, conteudosPendentes: pend,
             carteiraPessoalCents: (await balance(c, profitAcc)).toString(),
             fundoMidiaCents: (await balance(c, fundAcc)).toString() };
  });
  res.json(data);
});

// ---------- Saque PIX (step-up + limite diário + chave pré-cadastrada com carência) ----------
adminRouter.post('/withdrawals', requireRecentMfa, async (req, res) => {
  const b = z.object({ amountCents: z.coerce.bigint().positive(), pixKeyId: z.string().uuid() }).parse(req.body);
  const cap = BigInt(process.env.WITHDRAWAL_DAILY_CAP_CENTS ?? '0');

  const w = await withService(async c => {
    const key = (await c.query(`SELECT key_value, key_type FROM pix_keys WHERE id = $1 AND active_from <= now()`,
                               [b.pixKeyId])).rows[0];
    if (!key) throw Object.assign(new Error('Chave PIX inexistente ou em carência de 24h'), { status: 400 });

    const profit = await accountId(c, 'platform_profit');
    const pending = await accountId(c, 'withdrawals_pending');
    const bal = await balance(c, profit, true);                         // trava a conta
    const today = BigInt((await c.query(`SELECT coalesce(sum(amount_cents),0)::text s FROM withdrawals
                     WHERE created_at >= current_date AND status <> 'failed'`)).rows[0].s);
    if (b.amountCents > bal) throw Object.assign(new Error('Saldo insuficiente'), { status: 400 });
    if (today + b.amountCents > cap) throw Object.assign(new Error('Limite diário de saque atingido'), { status: 400 });

    const { rows } = await c.query(`INSERT INTO withdrawals (amount_cents, pix_key_id, requested_by)
                                    VALUES ($1, $2, $3) RETURNING id`, [b.amountCents.toString(), b.pixKeyId, req.user!.sub]);
    await post(c, [{ account: profit, cents: -b.amountCents, memo: 'Saque solicitado' },
                   { account: pending, cents: b.amountCents, memo: 'Saque em trânsito' }]);
    await audit({ actorId: req.user!.sub, ip: req.ip, action: 'withdrawal.requested',
                  meta: { cents: b.amountCents.toString() } }, c);
    return { id: rows[0].id, key };
  });

  // Transferência PIX pela API do Asaas (fora da transação do banco)
  const r = await fetch(`${process.env.ASAAS_API_URL}/transfers`, {
    method: 'POST',
    headers: { access_token: process.env.ASAAS_API_KEY!, 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: Number(b.amountCents) / 100, pixAddressKey: w.key.key_value,
                           pixAddressKeyType: w.key.key_type, description: `Saque ${w.id}`,
                           externalReference: w.id }),
  });
  const out = await r.json();
  await withService(async c => {
    await c.query(`UPDATE withdrawals SET status = $1, gateway_transfer_id = $2 WHERE id = $3`,
                  [r.ok ? 'sent' : 'failed', out.id ?? null, w.id]);
    if (!r.ok) {   // estorno contábil
      await post(c, [{ account: await accountId(c, 'withdrawals_pending'), cents: -b.amountCents, memo: 'Saque falhou' },
                     { account: await accountId(c, 'platform_profit'), cents: b.amountCents, memo: 'Estorno de saque' }]);
    }
  });
  res.status(r.ok ? 200 : 502).json({ ok: r.ok, withdrawalId: w.id });
});

// ---------- Kill Switch ----------
adminRouter.post('/tenants/:id/kill', requireRecentMfa, async (req, res) => {
  const tenantId = z.string().uuid().parse(req.params.id);
  const reason = z.string().min(5).parse(req.body?.reason);
  const users = await withAdmin(async c => {
    await c.query(`UPDATE tenants SET status = 'killed' WHERE id = $1`, [tenantId]);
    const u = await c.query(`UPDATE users SET token_version = token_version + 1 WHERE tenant_id = $1 RETURNING id`, [tenantId]);
    await c.query(`UPDATE wa_numbers SET status = 'paused' WHERE tenant_id = $1`, [tenantId]);   // para o WhatsApp também
    await audit({ actorId: req.user!.sub, tenantId, ip: req.ip, action: 'tenant.killed', meta: { reason } }, c);
    return u.rows.map(r => r.id as string);
  });
  await Promise.all(users.map(id => redis.del(`authstate:${id}`)));   // efeito imediato
  await pauseAllTenantCampaigns(tenantId);                             // para de gastar verba
  res.json({ ok: true });
});

// ---------- Gestor de Tráfego Próprio (Fundo de Mídia da Agência) ----------
adminRouter.post('/agency-campaigns/fund', requireRecentMfa, async (req, res) => {
  const b = z.object({ campaignId: z.string().uuid(), amountCents: z.coerce.bigint().positive() }).parse(req.body);
  await withService(async c => {
    const fund = await accountId(c, 'agency_media_fund');
    if (b.amountCents > await balance(c, fund, true)) throw Object.assign(new Error('Fundo insuficiente'), { status: 400 });
    await post(c, [{ account: fund, cents: -b.amountCents, memo: `Injeção na campanha ${b.campaignId}` },
                   { account: await accountId(c, 'gateway_clearing'), cents: b.amountCents, memo: 'Pago à plataforma de anúncios' }]);
    await audit({ actorId: req.user!.sub, ip: req.ip, action: 'agency_fund.injected',
                  target: b.campaignId, meta: { cents: b.amountCents.toString() } }, c);
  });
  // Em seguida: atualizar o orçamento da campanha própria via Meta/Google Ads (ver integrations/meta/ads.ts)
  res.json({ ok: true });
});

// ---------- Clientes (tenants) ----------
adminRouter.get('/tenants', async (_req, res) => {
  res.json(await withAdmin(async c => (await c.query(`
    SELECT t.id, t.name, t.slug, t.niche, t.city, t.plan, t.status, t.suspended_reason, t.created_at,
           t.asaas_subscription_id IS NOT NULL AS cobranca_ativa,
           (SELECT email FROM users u WHERE u.tenant_id = t.id AND u.role = 'owner' ORDER BY u.created_at LIMIT 1) AS owner_email,
           (SELECT count(*)::int FROM wa_numbers n WHERE n.tenant_id = t.id AND n.status = 'active') AS wa_ativos,
           (SELECT min(quality_rating) FROM wa_numbers n WHERE n.tenant_id = t.id) AS wa_qualidade,
           (SELECT count(*)::int FROM channel_connections cc WHERE cc.tenant_id = t.id AND (cc.needs_reconnect
              OR cc.expires_at < now() + interval '10 days')) AS conexoes_atencao
      FROM tenants t ORDER BY t.created_at DESC`)).rows));
});

const slugify = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'cliente';

/** Cadastra o negócio + usuário responsável. A senha provisória aparece UMA vez; o 2FA é feito no 1º login. */
adminRouter.post('/tenants', async (req, res) => {
  const b = z.object({
    name: z.string().trim().min(2).max(120), niche: z.string().trim().max(60).optional(),
    city: z.string().trim().max(80).optional(), document: z.string().trim().max(20).optional(),
    plan: z.string().default('starter'), mediaFeeBps: z.number().int().min(0).max(5000).optional(),
    ownerName: z.string().trim().min(2).max(120), ownerEmail: z.string().email(),
    ownerPhone: z.string().regex(/^\+\d{10,15}$/).optional(), startBilling: z.boolean().default(false),
  }).parse(req.body);
  const tempPassword = crypto.randomBytes(9).toString('base64url');
  const hash = await argon2.hash(tempPassword, { type: argon2.argon2id });

  const out = await withAdmin(async c => {
    if (!(await c.query(`SELECT 1 FROM plans WHERE id = $1 AND active`, [b.plan])).rowCount)
      throw Object.assign(new Error('Plano inexistente'), { status: 400 });
    if ((await c.query(`SELECT 1 FROM users WHERE email = $1`, [b.ownerEmail.toLowerCase()])).rowCount)
      throw Object.assign(new Error('Já existe um usuário com este e-mail'), { status: 409 });
    const slug = `${slugify(b.name)}-${crypto.randomBytes(2).toString('hex')}`;
    const t = (await c.query(`INSERT INTO tenants (name, slug, niche, city, document, plan, media_fee_bps)
                              VALUES ($1, $2, $3, $4, $5, $6, coalesce($7, 1500)) RETURNING id`,
                             [b.name, slug, b.niche ?? null, b.city ?? null, b.document ?? null, b.plan, b.mediaFeeBps ?? null])).rows[0];
    await c.query(`INSERT INTO users (tenant_id, email, password_hash, phone_e164, role, name, must_change_password)
                   VALUES ($1, $2, $3, $4, 'owner', $5, true)`,
                  [t.id, b.ownerEmail.toLowerCase(), hash, b.ownerPhone ?? null, b.ownerName]);
    await c.query(`INSERT INTO business_dossier (tenant_id, data) VALUES ($1, $2)`,
                  [t.id, { nome: b.name, nicho: b.niche, cidade: b.city }]);
    await audit({ actorId: req.user!.sub, tenantId: t.id, ip: req.ip, action: 'tenant.created', meta: { plan: b.plan } }, c);
    return t.id as string;
  });

  let billing: unknown = null;
  if (b.startBilling) {
    try {
      billing = await withAdmin(async c => {
        const subscriptionId = await createSubscription(c, out, b.ownerEmail);
        const setup = (await c.query(`SELECT setup_cents::text FROM plans WHERE id = $1`, [b.plan])).rows[0].setup_cents;
        const charge = BigInt(setup) > 0n ? await createCharge(c, out, 'setup', BigInt(setup), 'Setup da conta', b.ownerEmail) : null;
        return { subscriptionId, setupInvoice: charge?.invoiceUrl };
      });
    } catch (e: any) { billing = { error: e.message }; }
  }
  res.status(201).json({ id: out, ownerEmail: b.ownerEmail.toLowerCase(), tempPassword, billing });
});

adminRouter.post('/tenants/:id/billing', async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const r = await withAdmin(async c => {
    const owner = (await c.query(`SELECT email FROM users WHERE tenant_id = $1 AND role = 'owner' LIMIT 1`, [id])).rows[0];
    const subscriptionId = await createSubscription(c, id, owner?.email);
    await audit({ actorId: req.user!.sub, tenantId: id, ip: req.ip, action: 'billing.subscription_started' }, c);
    return { subscriptionId };
  });
  res.json(r);
});

adminRouter.patch('/tenants/:id', async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const b = z.object({ plan: z.string().optional(), mediaFeeBps: z.number().int().min(0).max(5000).optional(),
                       document: z.string().max(20).optional(), niche: z.string().max(60).optional(),
                       city: z.string().max(80).optional() }).parse(req.body);
  await withAdmin(async c => {
    if (b.plan && !(await c.query(`SELECT 1 FROM plans WHERE id = $1`, [b.plan])).rowCount)
      throw Object.assign(new Error('Plano inexistente'), { status: 400 });
    await c.query(`UPDATE tenants SET plan = coalesce($2, plan), media_fee_bps = coalesce($3, media_fee_bps),
                     document = coalesce($4, document), niche = coalesce($5, niche), city = coalesce($6, city) WHERE id = $1`,
                  [id, b.plan ?? null, b.mediaFeeBps ?? null, b.document ?? null, b.niche ?? null, b.city ?? null]);
    if (b.plan) await c.query(`UPDATE api_usage SET quota_cents = (SELECT ai_quota_cents FROM plans WHERE id = $2)
                                WHERE tenant_id = $1 AND period = date_trunc('month', now())::date`, [id, b.plan]);
    await audit({ actorId: req.user!.sub, tenantId: id, ip: req.ip, action: 'tenant.updated', meta: b }, c);
  });
  res.json({ ok: true });
});

adminRouter.post('/tenants/:id/reactivate', requireRecentMfa, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const users = await withAdmin(async c => {
    await c.query(`UPDATE tenants SET status = 'active', suspended_reason = NULL WHERE id = $1`, [id]);
    await audit({ actorId: req.user!.sub, tenantId: id, ip: req.ip, action: 'tenant.reactivated' }, c);
    return (await c.query(`SELECT id FROM users WHERE tenant_id = $1`, [id])).rows;
  });
  await Promise.all(users.map(u => redis.del(`authstate:${u.id}`)));   // libera na hora, sem esperar o cache
  res.json({ ok: true });
});

/** Gera nova senha provisória para o responsável (ex.: perdeu o celular do 2FA). Exige 2FA recente. */
adminRouter.post('/tenants/:id/reset-owner', requireRecentMfa, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const tempPassword = crypto.randomBytes(9).toString('base64url');
  const hash = await argon2.hash(tempPassword, { type: argon2.argon2id });
  const ids = await withAdmin(async c => {
    const r = await c.query(`UPDATE users SET password_hash = $2, must_change_password = true, totp_enabled = false,
                               totp_secret_cipher = NULL, token_version = token_version + 1, failed_logins = 0, locked_until = NULL
                             WHERE tenant_id = $1 AND role = 'owner' RETURNING id, email`, [id, hash]);
    await audit({ actorId: req.user!.sub, tenantId: id, ip: req.ip, action: 'tenant.owner_reset' }, c);
    return r.rows;
  });
  await Promise.all(ids.map(u => redis.del(`authstate:${u.id}`)));
  res.json({ email: ids[0]?.email, tempPassword });
});

// ---------- Planos (tiers) ----------
adminRouter.get('/plans', async (_req, res) => {
  res.json(await withAdmin(async c => (await c.query(`SELECT * FROM plans ORDER BY price_cents`)).rows));
});

adminRouter.put('/plans/:id', async (req, res) => {
  const id = z.string().regex(/^[a-z0-9_-]{2,30}$/).parse(req.params.id);
  const b = z.object({ name: z.string().min(2).max(60), priceCents: z.number().int().min(0),
                       setupCents: z.number().int().min(0).default(0), aiQuotaCents: z.number().int().min(0),
                       waNumbersMax: z.number().int().min(0).max(50), postsPerMonth: z.number().int().min(0).max(200),
                       active: z.boolean().default(true) }).parse(req.body);
  await withAdmin(async c => {
    await c.query(`INSERT INTO plans (id, name, price_cents, setup_cents, ai_quota_cents, wa_numbers_max, posts_per_month, active)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                   ON CONFLICT (id) DO UPDATE SET name = $2, price_cents = $3, setup_cents = $4, ai_quota_cents = $5,
                     wa_numbers_max = $6, posts_per_month = $7, active = $8`,
                  [id, b.name, b.priceCents, b.setupCents, b.aiQuotaCents, b.waNumbersMax, b.postsPerMonth, b.active]);
    await audit({ actorId: req.user!.sub, ip: req.ip, action: 'plan.saved', target: id, meta: b }, c);
  });
  res.json({ ok: true });
});

// ---------- Tesouraria: chaves PIX e saques ----------
adminRouter.get('/pix-keys', async (_req, res) => {
  res.json(await withAdmin(async c => (await c.query(
    `SELECT id, key_type, regexp_replace(key_value, '.(?=.{4})', '•', 'g') AS key_masked, active_from,
            active_from <= now() AS ativa FROM pix_keys ORDER BY active_from DESC`)).rows));
});

/** Nova chave PIX só passa a valer 24h depois (carência contra invasor que troca a chave e saca). */
adminRouter.post('/pix-keys', requireRecentMfa, async (req, res) => {
  const b = z.object({ keyType: z.enum(['CPF', 'CNPJ', 'EMAIL', 'PHONE', 'EVP']), keyValue: z.string().trim().min(5).max(140) }).parse(req.body);
  const id = await withAdmin(async c => {
    const r = await c.query(`INSERT INTO pix_keys (key_type, key_value, created_by) VALUES ($1, $2, $3) RETURNING id`,
                            [b.keyType, b.keyValue, req.user!.sub]);
    await audit({ actorId: req.user!.sub, ip: req.ip, action: 'pix_key.created', meta: { type: b.keyType } }, c);
    return r.rows[0].id;
  });
  res.status(201).json({ id, ativaEm: '24 horas' });
});

adminRouter.get('/withdrawals', async (_req, res) => {
  res.json(await withAdmin(async c => (await c.query(
    `SELECT w.id, w.amount_cents::text, w.status, w.created_at, k.key_type FROM withdrawals w
       JOIN pix_keys k ON k.id = w.pix_key_id ORDER BY w.created_at DESC LIMIT 50`)).rows));
});

// ---------- Central de Auditoria e Segurança ----------
const SECURITY_ACTIONS = ['auth.login_failed', 'auth.mfa_failed', 'auth.step_up_failed', 'auth.new_device',
  'webhook.rejected', 'payment.amount_mismatch', 'payment.chargeback', 'tenant.killed', 'security.panic_on', 'security.panic_off'];

adminRouter.get('/audit', async (req, res) => {
  const q = z.object({ tenantId: z.string().uuid().optional(), action: z.string().max(60).optional(),
                       security: z.enum(['1']).optional(), before: z.coerce.number().int().optional() }).parse(req.query);
  res.json(await withAdmin(async c => (await c.query(`
    SELECT a.id, a.at, a.action, a.target, a.meta, host(a.ip) AS ip, t.name AS tenant, u.email AS actor
      FROM audit_log a LEFT JOIN tenants t ON t.id = a.tenant_id LEFT JOIN users u ON u.id = a.actor_id
     WHERE ($1::uuid IS NULL OR a.tenant_id = $1) AND ($2::text IS NULL OR a.action LIKE $2 || '%')
       AND ($3::text[] IS NULL OR a.action = ANY($3)) AND ($4::bigint IS NULL OR a.id < $4)
     ORDER BY a.id DESC LIMIT 100`,
    [q.tenantId ?? null, q.action ?? null, q.security ? SECURITY_ACTIONS : null, q.before ?? null])).rows));
});

adminRouter.get('/security/summary', async (_req, res) => {
  const data = await withAdmin(async c => {
    const s = (await c.query(`
      SELECT count(*) FILTER (WHERE action = 'auth.login_failed')::int AS logins_falhos,
             count(*) FILTER (WHERE action IN ('auth.mfa_failed','auth.step_up_failed'))::int AS codigos_errados,
             count(*) FILTER (WHERE action = 'auth.new_device')::int AS novos_dispositivos,
             count(*) FILTER (WHERE action = 'webhook.rejected')::int AS webhooks_rejeitados,
             count(*) FILTER (WHERE action IN ('payment.chargeback','payment.amount_mismatch'))::int AS fraudes
        FROM audit_log WHERE at > now() - interval '24 hours'`)).rows[0];
    const ips = (await c.query(`SELECT host(ip) AS ip, count(*)::int AS tentativas FROM audit_log
                                WHERE action = 'auth.login_failed' AND at > now() - interval '24 hours' AND ip IS NOT NULL
                                GROUP BY ip ORDER BY 2 DESC LIMIT 5`)).rows;
    // integridade da cadeia de hash dos últimos 500 registros
    const chain = (await c.query(`
      SELECT count(*)::int AS quebras FROM (
        SELECT prev_hash, lag(hash) OVER (ORDER BY id) AS anterior, id FROM audit_log
         WHERE id > (SELECT coalesce(max(id), 0) - 500 FROM audit_log)) x
       WHERE x.anterior IS NOT NULL AND x.prev_hash IS DISTINCT FROM x.anterior`)).rows[0];
    return { ultimas24h: s, ipsSuspeitos: ips, cadeiaIntegra: chain.quebras === 0 };
  });
  res.json({ ...data, panic: await panicInfo() });
});

// ---------- MODO PÂNICO: desliga IA, anúncios e envios de WhatsApp de todos os clientes ----------
adminRouter.post('/security/panic', requireRecentMfa, async (req, res) => {
  const b = z.object({ on: z.boolean(), reason: z.string().trim().min(5).max(300).optional(),
                       pauseAds: z.boolean().default(true) }).parse(req.body);
  if (b.on && !b.reason) return res.status(400).json({ error: 'Informe o motivo' });
  await setPanic(b.on, b.reason);
  await audit({ actorId: req.user!.sub, ip: req.ip, action: b.on ? 'security.panic_on' : 'security.panic_off', meta: { reason: b.reason } });
  let campanhasPausadas = 0;
  if (b.on && b.pauseAds) {
    const tenants = await withAdmin(async c => (await c.query(`SELECT DISTINCT tenant_id FROM ad_campaigns WHERE status <> 'paused'`)).rows);
    for (const t of tenants) campanhasPausadas += await pauseAllTenantCampaigns(t.tenant_id).catch(() => 0);
  }
  res.json({ ok: true, panic: await panicInfo(), campanhasPausadas });
});

// ---------- Cobrança avulsa para um cliente (verba de mídia, serviço avulso) ----------
adminRouter.post('/tenants/:id/charges', async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const b = z.object({ kind: z.enum(['media_budget', 'a_la_carte', 'setup']), amountCents: z.coerce.bigint().positive(),
                       description: z.string().min(3).max(200) }).parse(req.body);
  if (!billingReady()) return res.status(503).json({ error: 'Configure ASAAS_API_KEY para gerar cobranças' });
  const r = await withAdmin(async c => {
    const owner = (await c.query(`SELECT email FROM users WHERE tenant_id = $1 AND role = 'owner' LIMIT 1`, [id])).rows[0];
    const charge = await createCharge(c, id, b.kind, b.amountCents, b.description, owner?.email);
    await audit({ actorId: req.user!.sub, tenantId: id, ip: req.ip, action: 'billing.charge_created',
                  meta: { kind: b.kind, cents: b.amountCents.toString() } }, c);
    return charge;
  });
  res.status(201).json(r);
});
