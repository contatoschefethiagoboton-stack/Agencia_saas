import { Router } from 'express';
import { z } from 'zod';
import { withAdmin } from '../db.js';
import { getCandles, INTERVALS, normalizeSymbol } from '../market/data.js';
import { strategyIds } from '../market/strategies.js';
import { requireAdmin, requireRecentMfa } from '../middleware/auth.js';
import crypto from 'node:crypto';
import argon2 from 'argon2';
import { audit } from '../audit/audit.js';
import { redis } from '../redis.js';
import { createCharge, createSubscription } from '../finance/billing.js';
import { panicInfo, setPanic } from '../security/panic.js';
import { setSession } from '../auth/session.js';
import { mailReady, sendMail } from '../mail.js';
import { publicUrl } from '../config.js';

export const adminRouter = Router();
adminRouter.use(requireAdmin);

// ---------- Visão geral ----------
adminRouter.get('/dashboard', async (_req, res) => {
  res.json(await withAdmin(async c => {
    const mrr = (await c.query(`
      SELECT coalesce(sum(amount_cents), 0)::text AS mrr_cents FROM payments
       WHERE kind = 'subscription' AND status = 'confirmed' AND confirmed_at >= date_trunc('month', now())`)).rows[0].mrr_cents;
    const clientes = (await c.query(`SELECT count(*) FILTER (WHERE status = 'active')::int AS ativos,
                                            count(*) FILTER (WHERE status IN ('suspended', 'killed'))::int AS bloqueados,
                                            count(*) FILTER (WHERE status = 'pending')::int AS aguardando,
                                            count(*) FILTER (WHERE vip)::int AS vip FROM tenants`)).rows[0];
    const robos = (await c.query(`SELECT count(*) FILTER (WHERE status = 'active' AND NOT is_master)::int AS ativos,
                                         count(*) FILTER (WHERE status = 'active' AND mode = 'live')::int AS reais,
                                         count(*) FILTER (WHERE status = 'error')::int AS com_erro,
                                         count(*) FILTER (WHERE copy_of IS NOT NULL)::int AS seguidores,
                                         count(*) FILTER (WHERE is_master)::int AS masters FROM bots`)).rows[0];
    const ops = (await c.query(`SELECT count(*) FILTER (WHERE entry_at > now() - interval '24 hours')::int AS ops_24h,
                                       count(*) FILTER (WHERE status = 'open')::int AS abertas,
                                       count(*) FILTER (WHERE status = 'open' AND mode = 'live')::int AS abertas_reais FROM bot_trades`)).rows[0];
    const conexoes = (await c.query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'error')::int AS com_erro FROM broker_connections`)).rows[0];
    const erros = (await c.query(`SELECT b.name, b.symbol, b.status_reason, t.name AS cliente FROM bots b LEFT JOIN tenants t ON t.id = b.tenant_id
                                  WHERE b.status = 'error' ORDER BY b.last_tick_at DESC NULLS LAST LIMIT 10`)).rows;
    return { mrrCents: mrr, clientes, robos, ops, conexoes, erros };
  }));
});

// ---------- Kill Switch ----------
adminRouter.post('/tenants/:id/kill', requireRecentMfa, async (req, res) => {
  const tenantId = z.string().uuid().parse(req.params.id);
  const reason = z.string().min(5).parse(req.body?.reason);
  const users = await withAdmin(async c => {
    await c.query(`UPDATE tenants SET status = 'killed' WHERE id = $1`, [tenantId]);
    const u = await c.query(`UPDATE users SET token_version = token_version + 1 WHERE tenant_id = $1 RETURNING id`, [tenantId]);
    await c.query(`UPDATE bots SET status = 'paused', status_reason = 'Conta bloqueada pelo administrador' WHERE tenant_id = $1 AND status = 'active'`, [tenantId]);
    await audit({ actorId: req.user!.sub, tenantId, ip: req.ip, action: 'tenant.killed', meta: { reason } }, c);
    return u.rows.map(r => r.id as string);
  });
  await Promise.all(users.map(id => redis.del(`authstate:${id}`)));   // efeito imediato
  res.json({ ok: true });
});

// ---------- Clientes (tenants) ----------
adminRouter.get('/tenants', async (_req, res) => {
  res.json(await withAdmin(async c => (await c.query(`
    SELECT t.id, t.name, t.slug, t.niche, t.city, t.plan, t.status, t.suspended_reason, t.created_at,
           t.vip, t.vip_note, t.signup,
           (SELECT max(a.at) FROM audit_log a WHERE a.tenant_id = t.id AND a.action = 'auth.login_ok') AS ultimo_acesso,
           t.asaas_subscription_id IS NOT NULL AS cobranca_ativa,
           (SELECT email FROM users u WHERE u.tenant_id = t.id AND u.role = 'owner' ORDER BY u.created_at LIMIT 1) AS owner_email,
           (SELECT count(*)::int FROM bots b WHERE b.tenant_id = t.id AND b.status = 'active') AS robos_ativos,
           (SELECT count(*)::int FROM bots b WHERE b.tenant_id = t.id AND b.status = 'active' AND b.mode = 'live') AS robos_reais,
           (SELECT count(*)::int FROM broker_connections bc WHERE bc.tenant_id = t.id) AS corretoras
      FROM tenants t ORDER BY (t.status = 'pending') DESC, t.created_at DESC`)).rows));
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
    if ((await c.query(`SELECT vip FROM tenants WHERE id = $1`, [id])).rows[0]?.vip)
      throw Object.assign(new Error('Cliente VIP: isento de cobrança. Tire o VIP para cobrar.'), { status: 409 });
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
                       city: z.string().max(80).optional(), vip: z.boolean().optional(),
                       vipNote: z.string().trim().max(200).optional() }).parse(req.body);
  await withAdmin(async c => {
    if (b.plan && !(await c.query(`SELECT 1 FROM plans WHERE id = $1`, [b.plan])).rowCount)
      throw Object.assign(new Error('Plano inexistente'), { status: 400 });
    await c.query(`UPDATE tenants SET plan = coalesce($2, plan), media_fee_bps = coalesce($3, media_fee_bps),
                     document = coalesce($4, document), niche = coalesce($5, niche), city = coalesce($6, city) WHERE id = $1`,
                  [id, b.plan ?? null, b.mediaFeeBps ?? null, b.document ?? null, b.niche ?? null, b.city ?? null]);
    if (b.vip !== undefined || b.vipNote !== undefined)
      await c.query(`UPDATE tenants SET vip = coalesce($2, vip), vip_note = coalesce($3, vip_note) WHERE id = $1`, [id, b.vip ?? null, b.vipNote ?? null]);
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
                       setupCents: z.number().int().min(0).default(0), maxBots: z.number().int().min(0).max(200),
                       liveTrading: z.boolean(), copyTrade: z.boolean(), description: z.string().max(200).optional(),
                       active: z.boolean().default(true) }).parse(req.body);
  await withAdmin(async c => {
    await c.query(`INSERT INTO plans (id, name, price_cents, setup_cents, max_bots, live_trading, copy_trade, description, active)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                   ON CONFLICT (id) DO UPDATE SET name = $2, price_cents = $3, setup_cents = $4, max_bots = $5,
                     live_trading = $6, copy_trade = $7, description = $8, active = $9`,
                  [id, b.name, b.priceCents, b.setupCents, b.maxBots, b.liveTrading, b.copyTrade, b.description ?? null, b.active]);
    await audit({ actorId: req.user!.sub, ip: req.ip, action: 'plan.saved', target: id, meta: b }, c);
  });
  res.json({ ok: true });
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

// ---------- MODO PÂNICO: congela todos os robôs e novas conexões de corretora ----------
adminRouter.post('/security/panic', requireRecentMfa, async (req, res) => {
  const b = z.object({ on: z.boolean(), reason: z.string().trim().min(5).max(300).optional() }).parse(req.body);
  if (b.on && !b.reason) return res.status(400).json({ error: 'Informe o motivo' });
  await setPanic(b.on, b.reason);
  await audit({ actorId: req.user!.sub, ip: req.ip, action: b.on ? 'security.panic_on' : 'security.panic_off', meta: { reason: b.reason } });
  res.json({ ok: true, panic: await panicInfo() });
});

/**
 * ABRIR O PAINEL DO CLIENTE: o administrador vê o painel do cliente (robôs, corretoras, avisos) para dar suporte,
 * sem a senha do cliente. Exige 2FA recente; tudo o que for feito fica na auditoria com o
 * e-mail do administrador; cliente bloqueado não pode ser aberto.
 */
adminRouter.post('/tenants/:id/impersonate', requireRecentMfa, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const t = await withAdmin(async c => {
    const t = (await c.query(`SELECT name, status FROM tenants WHERE id = $1`, [id])).rows[0];
    if (!t) throw Object.assign(new Error('Cliente não encontrado'), { status: 404 });
    if (t.status !== 'active') throw Object.assign(new Error('Cliente bloqueado: reative antes de abrir o painel'), { status: 409 });
    await audit({ actorId: req.user!.sub, tenantId: id, ip: req.ip, action: 'support.panel_opened' }, c);
    return t;
  });
  setSession(res, { sub: req.user!.sub, tid: id, role: 'owner', tv: req.user!.tv, mfaAt: req.user!.mfaAt, imp: true });
  res.json({ ok: true, cliente: t.name });
});

// ---------- Aprovação de cadastro (cliente que se cadastrou sozinho só entra depois disto) ----------
adminRouter.post('/tenants/:id/approve', async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const owner = await withAdmin(async c => {
    const r = await c.query(`UPDATE tenants SET status = 'active', decided_at = now(), decided_by = $2
                             WHERE id = $1 AND status IN ('pending', 'rejected') RETURNING name`, [id, req.user!.sub]);
    if (!r.rowCount) throw Object.assign(new Error('Este cadastro não está aguardando aprovação'), { status: 409 });
    await audit({ actorId: req.user!.sub, tenantId: id, ip: req.ip, action: 'tenant.approved' }, c);
    const o = (await c.query(`SELECT email, name FROM users WHERE tenant_id = $1 AND role = 'owner' LIMIT 1`, [id])).rows[0];
    return { ...o, business: r.rows[0].name };
  });
  if (owner?.email && mailReady())
    void sendMail(owner.email, 'Seu acesso foi liberado', `Olá${owner.name ? `, ${owner.name.split(' ')[0]}` : ''}! O cadastro de "${owner.business}" foi aprovado. Entre em ${publicUrl()}`,
      `<p>Olá${owner.name ? `, ${owner.name.split(' ')[0]}` : ''}!</p><p>O cadastro de <b>${owner.business}</b> foi aprovado.</p><p><a href="${publicUrl()}">Entrar na plataforma</a></p>`)
      .catch(e => console.error('[e-mail]', (e as Error).message));
  res.json({ ok: true });
});

adminRouter.post('/tenants/:id/reject', async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const reason = z.string().trim().max(300).optional().parse(req.body?.reason);
  await withAdmin(async c => {
    const r = await c.query(`UPDATE tenants SET status = 'rejected', decided_at = now(), decided_by = $2, suspended_reason = $3
                             WHERE id = $1 AND status = 'pending'`, [id, req.user!.sub, reason ?? null]);
    if (!r.rowCount) throw Object.assign(new Error('Este cadastro não está aguardando aprovação'), { status: 409 });
    await audit({ actorId: req.user!.sub, tenantId: id, ip: req.ip, action: 'tenant.rejected', meta: { reason } }, c);
  });
  res.json({ ok: true });
});

// ---------- Copy trade: estratégias master da plataforma (sempre simuladas; os clientes copiam com a própria conta) ----------
adminRouter.get('/masters', async (_req, res) => {
  res.json(await withAdmin(async c => (await c.query(`
    SELECT b.id, b.name, b.market, b.symbol, b.interval, b.strategy, b.status, b.status_reason, b.public_description, b.created_at,
           (SELECT count(*)::int FROM bots f WHERE f.copy_of = b.id) AS seguidores,
           (SELECT count(*)::int FROM bots f WHERE f.copy_of = b.id AND f.mode = 'live') AS seguidores_reais,
           count(t.id) FILTER (WHERE t.status = 'closed')::int AS trades,
           count(t.id) FILTER (WHERE t.status = 'closed' AND t.pnl > 0)::int AS wins,
           coalesce(sum((t.exit_price / t.entry_price - 1) * 100) FILTER (WHERE t.status = 'closed'), 0)::float AS ret_total
      FROM bots b LEFT JOIN bot_trades t ON t.bot_id = b.id WHERE b.is_master GROUP BY b.id ORDER BY b.created_at DESC`)).rows));
});

adminRouter.post('/masters', async (req, res) => {
  const b = z.object({ name: z.string().trim().min(2).max(60), market: z.enum(['crypto', 'b3', 'us']), symbol: z.string().max(20),
                       interval: z.enum(INTERVALS), strategy: z.string().refine(s => strategyIds.includes(s), 'Estratégia desconhecida'),
                       stopLossPct: z.number().min(0.1).max(50).nullable().optional(), takeProfitPct: z.number().min(0.1).max(500).nullable().optional(),
                       description: z.string().trim().min(10).max(600) }).parse(req.body);
  const symbol = normalizeSymbol(b.market, b.symbol);
  await getCandles(b.market, symbol, b.interval, 100);
  const id = await withAdmin(async c => {
    const r = await c.query(`INSERT INTO bots (tenant_id, name, market, symbol, interval, strategy, mode, amount, stop_loss_pct, take_profit_pct,
                               status, is_master, public_description)
                             VALUES (NULL, $1, $2, $3, $4, $5, 'paper', 1000, $6, $7, 'active', true, $8) RETURNING id`,
                            [b.name, b.market, symbol, b.interval, b.strategy, b.stopLossPct ?? null, b.takeProfitPct ?? null, b.description]);
    await audit({ actorId: req.user!.sub, ip: req.ip, action: 'master.created', target: r.rows[0].id, meta: { symbol, strategy: b.strategy } }, c);
    return r.rows[0].id;
  });
  res.status(201).json({ id });
});

adminRouter.patch('/masters/:id', async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const b = z.object({ status: z.enum(['active', 'paused']).optional(), description: z.string().trim().min(10).max(600).optional() }).parse(req.body);
  await withAdmin(async c => {
    const r = await c.query(`UPDATE bots SET status = coalesce($2, status), status_reason = NULL, public_description = coalesce($3, public_description)
                             WHERE id = $1 AND is_master`, [id, b.status ?? null, b.description ?? null]);
    if (!r.rowCount) throw Object.assign(new Error('Estratégia não encontrada'), { status: 404 });
    await audit({ actorId: req.user!.sub, ip: req.ip, action: 'master.updated', target: id, meta: b }, c);
  });
  res.json({ ok: true });
});

adminRouter.delete('/masters/:id', async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  await withAdmin(async c => {
    // seguidores param de copiar (posições abertas deles continuam com o próprio stop/alvo até fecharem)
    await c.query(`UPDATE bots SET status = 'paused', status_reason = 'A estratégia copiada foi encerrada pela plataforma' WHERE copy_of = $1`, [id]);
    await c.query(`DELETE FROM bots WHERE id = $1 AND is_master`, [id]);
    await audit({ actorId: req.user!.sub, ip: req.ip, action: 'master.deleted', target: id }, c);
  });
  res.json({ ok: true });
});
