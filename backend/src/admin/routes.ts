import { Router } from 'express';
import { z } from 'zod';
import { withAdmin, withService, adminPool } from '../db.js';
import { requireAdmin, requireRecentMfa } from '../middleware/auth.js';
import { issueOtp, verifyOtp } from '../auth/otp.js';
import { setSession } from '../auth/session.js';
import { accountId, balance, post } from '../finance/ledger.js';
import { audit } from '../audit/audit.js';
import { redis } from '../redis.js';
import { pauseAllTenantCampaigns } from '../integrations/meta/ads.js';

export const adminRouter = Router();
adminRouter.use(requireAdmin);

// ---------- Step-up 2FA (antes de saque, kill switch, troca de chave PIX) ----------
adminRouter.post('/step-up', async (req, res) => {
  const c = await adminPool.connect();
  try {
    const { rows } = await c.query('SELECT phone_e164 FROM users WHERE id = $1', [req.user!.sub]);
    res.json({ challengeId: await issueOtp(c, req.user!.sub, rows[0].phone_e164, 'withdrawal') });
  } finally { c.release(); }
});
adminRouter.post('/step-up/verify', async (req, res) => {
  const b = z.object({ challengeId: z.string().uuid(), code: z.string().regex(/^\d{6}$/) }).parse(req.body);
  const ok = await withAdmin(c => verifyOtp(c, b.challengeId, req.user!.sub, 'withdrawal', b.code));
  if (!ok) return res.status(401).json({ error: 'Código inválido ou expirado' });
  setSession(res, { ...req.user!, mfaAt: Math.floor(Date.now() / 1000) });
  res.json({ ok: true });
});

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
    return { mrrCents: mrr.rows[0].mrr_cents, dre: dre.rows,
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
