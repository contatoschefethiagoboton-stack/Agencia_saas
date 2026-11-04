import { Router } from 'express';
import { z } from 'zod';
import { adminPool, withTenant } from '../db.js';
import { audit } from '../audit/audit.js';
import { billingReady, changeSubscriptionBillingType, changeSubscriptionPlan, pendingPayUrl } from '../finance/billing.js';

/** Minha assinatura: plano, forma de pagamento, cobranças e troca de plano. */
export const accountRouter = Router();
const tid = (req: any) => req.user!.tid as string;

accountRouter.get('/', async (req, res) => {
  const t = (await adminPool.query(
    `SELECT t.plan, t.status, t.vip, t.is_platform, t.billing_type, t.asaas_subscription_id, p.name AS plan_name, p.price_cents::int
       FROM tenants t JOIN plans p ON p.id = t.plan WHERE t.id = $1`, [tid(req)])).rows[0];
  const pays = (await adminPool.query(
    `SELECT kind, amount_cents::int, status, confirmed_at FROM payments WHERE tenant_id = $1 ORDER BY coalesce(confirmed_at, now()) DESC LIMIT 24`, [tid(req)])).rows;
  const payUrl = t.asaas_subscription_id && billingReady() ? await pendingPayUrl(t.asaas_subscription_id).catch(() => null) : null;
  res.json({ plan: t.plan, planName: t.plan_name, priceCents: t.price_cents, status: t.status, billingType: t.billing_type,
             semCobranca: t.vip || t.is_platform, payUrl, payments: pays });
});

accountRouter.post('/plan', async (req, res) => {
  const plan = z.object({ plan: z.string().max(20) }).parse(req.body).plan;
  if (req.user!.role === 'member') return res.status(403).json({ error: 'Só o titular troca o plano' });
  const out = await withTenant(tid(req), async c => {
    const p = (await c.query(`SELECT id, name, price_cents::int FROM plans WHERE id = $1 AND active`, [plan])).rows[0];
    if (!p) throw Object.assign(new Error('Plano inexistente'), { status: 400 });
    const t = (await adminPool.query(`SELECT plan, asaas_subscription_id, vip, is_platform FROM tenants WHERE id = $1`, [tid(req)])).rows[0];
    if (t.plan === p.id) return p;
    if (t.asaas_subscription_id && !t.vip && !t.is_platform) await changeSubscriptionPlan(t.asaas_subscription_id, p.name, p.price_cents);
    // menos robôs no plano novo: os excedentes são pausados (nada é apagado)
    const max = (await c.query(`SELECT max_bots FROM plans WHERE id = $1`, [p.id])).rows[0].max_bots;
    await c.query(`UPDATE bots SET status = 'paused', status_reason = 'Plano trocado: limite de robôs menor'
                   WHERE id IN (SELECT id FROM bots WHERE tenant_id = $1 ORDER BY created_at OFFSET $2)`, [tid(req), t.vip ? 50 : max]);
    await adminPool.query(`UPDATE tenants SET plan = $2 WHERE id = $1`, [tid(req), p.id]);
    await audit({ actorId: req.user!.sub, tenantId: tid(req), ip: req.ip, action: 'billing.plan_changed', meta: { de: t.plan, para: p.id } }, c);
    return p;
  });
  res.json({ ok: true, plan: out.id });
});

accountRouter.post('/billing-type', async (req, res) => {
  const bt = z.object({ billingType: z.enum(['PIX', 'CREDIT_CARD']) }).parse(req.body).billingType;
  const t = (await adminPool.query(`SELECT asaas_subscription_id FROM tenants WHERE id = $1`, [tid(req)])).rows[0];
  if (t.asaas_subscription_id) await changeSubscriptionBillingType(t.asaas_subscription_id, bt);
  await adminPool.query(`UPDATE tenants SET billing_type = $2 WHERE id = $1`, [tid(req), bt]);
  await audit({ actorId: req.user!.sub, tenantId: tid(req), ip: req.ip, action: 'billing.type_changed', meta: { bt } });
  res.json({ ok: true });
});
