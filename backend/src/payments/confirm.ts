import type { PoolClient } from 'pg';
import { accountId, post } from '../finance/ledger.js';
import { splitMediaBudget } from '../finance/split.js';
import { audit } from '../audit/audit.js';
import { redis } from '../redis.js';

const KINDS = ['subscription', 'setup', 'media_budget', 'a_la_carte'];

/**
 * Cobranças recorrentes nascem no gateway (a assinatura gera uma cobrança por mês).
 * Se o pagamento ainda não existe aqui, cria a partir dos dados RECONSULTADOS no gateway,
 * usando externalReference "<tenantId>|<tipo>" que a plataforma mesma definiu.
 */
export async function ensurePayment(c: PoolClient, gateway: 'asaas' | 'mercadopago', gatewayPaymentId: string,
                                    externalReference: string | undefined, cents: bigint, subscriptionId?: string) {
  const exists = (await c.query(`SELECT 1 FROM payments WHERE gateway = $1 AND gateway_payment_id = $2`,
                                [gateway, gatewayPaymentId])).rowCount;
  if (exists) return;
  let [tenantId, kind] = String(externalReference ?? '').split('|');
  if ((!tenantId || !kind) && subscriptionId) {   // cobrança mensal gerada pela assinatura: acha o cliente pela assinatura
    tenantId = (await c.query(`SELECT id FROM tenants WHERE asaas_subscription_id = $1`, [subscriptionId])).rows[0]?.id;
    kind = 'subscription';
  }
  if (!/^[0-9a-f-]{36}$/i.test(tenantId ?? '') || !KINDS.includes(kind)) return;
  const t = (await c.query(`SELECT 1 FROM tenants WHERE id = $1`, [tenantId])).rowCount;
  if (!t) return;
  await c.query(`INSERT INTO payments (tenant_id, gateway, gateway_payment_id, kind, amount_cents)
                 VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
                [tenantId, gateway, gatewayPaymentId, kind, cents.toString()]);
}

export async function confirmPayment(c: PoolClient, gateway: 'asaas' | 'mercadopago', eventId: string,
                                     gatewayPaymentId: string, paidCents: bigint, ip?: string) {
  // idempotência
  const ev = await c.query(`INSERT INTO webhook_events (gateway, event_id) VALUES ($1, $2)
                            ON CONFLICT DO NOTHING RETURNING 1`, [gateway, eventId]);
  if (!ev.rowCount) return;

  const { rows } = await c.query(
    `SELECT p.id, p.tenant_id, p.kind, p.amount_cents::text AS amount, p.status, t.media_fee_bps, t.status AS tenant_status,
            (SELECT price_cents::text FROM plans WHERE id = t.plan) AS plan_cents
       FROM payments p JOIN tenants t ON t.id = p.tenant_id
      WHERE p.gateway = $1 AND p.gateway_payment_id = $2 FOR UPDATE OF p`, [gateway, gatewayPaymentId]);
  const p = rows[0];
  if (!p || p.status === 'confirmed') return;

  // valor pago precisa bater com o valor cobrado — nunca confiar no que o cliente informou
  if (BigInt(p.amount) !== paidCents) {
    await audit({ tenantId: p.tenant_id, ip, action: 'payment.amount_mismatch',
                  meta: { expected: p.amount, paid: paidCents.toString() } }, c);
    return;
  }

  await c.query(`UPDATE payments SET status = 'confirmed', confirmed_at = now() WHERE id = $1`, [p.id]);
  const clearing = await accountId(c, 'gateway_clearing');
  const profit = await accountId(c, 'platform_profit');

  if (p.kind === 'media_budget') {
    const s = splitMediaBudget(paidCents, p.media_fee_bps, Number(process.env.PLATFORM_PROFIT_SHARE_BPS ?? 6000));
    await post(c, [
      { account: clearing, cents: -s.grossCents, memo: 'Verba de mídia recebida' },
      { account: await accountId(c, 'tenant_media_wallet', p.tenant_id), cents: s.clientMediaCents, memo: 'Mídia do cliente' },
      { account: profit, cents: s.profitCents, memo: 'Taxa de gestão — lucro' },
      { account: await accountId(c, 'agency_media_fund'), cents: s.agencyFundCents, memo: 'Taxa de gestão — fundo de mídia' },
    ], p.id);
  } else {
    await post(c, [
      { account: clearing, cents: -paidCents, memo: `Recebimento ${p.kind}` },
      { account: profit, cents: paidCents, memo: `Receita ${p.kind}` },
    ], p.id);
  }
  // LIBERAÇÃO AUTOMÁTICA: cadastro aguardando pagamento só ativa se o valor pago for o preço do plano
  if (p.kind === 'subscription' && p.tenant_status === 'awaiting_payment') {
    if (BigInt(p.plan_cents ?? -1) === paidCents) {
      await c.query(`UPDATE tenants SET status = 'active', decided_at = now() WHERE id = $1 AND status = 'awaiting_payment'`, [p.tenant_id]);
      await audit({ tenantId: p.tenant_id, ip, action: 'tenant.activated_by_payment', meta: { cents: paidCents.toString() } }, c);
    } else {
      await audit({ tenantId: p.tenant_id, ip, action: 'payment.amount_mismatch', meta: { expected: p.plan_cents, paid: paidCents.toString(), motivo: 'valor diferente do plano' } }, c);
    }
  }
  // inadimplente que pagou volta a ficar ativo (não reativa conta travada por fraude ou kill switch)
  if (p.tenant_status === 'suspended')
    await c.query(`UPDATE tenants SET status = 'active', suspended_reason = NULL
                    WHERE id = $1 AND suspended_reason = 'inadimplencia'`, [p.tenant_id]);
  await audit({ tenantId: p.tenant_id, ip, action: 'payment.confirmed',
                meta: { gateway, kind: p.kind, cents: paidCents.toString() } }, c);
}

/**
 * ESCUDO ANTIFRAUDE — chargeback/estorno: estorna no ledger exatamente o que entrou,
 * marca o pagamento, TRAVA a conta do cliente e derruba as sessões. Só o admin reativa.
 */
export async function reversePayment(c: PoolClient, gateway: 'asaas' | 'mercadopago', eventId: string,
                                     gatewayPaymentId: string, reason: 'chargeback' | 'refunded', ip?: string) {
  const ev = await c.query(`INSERT INTO webhook_events (gateway, event_id) VALUES ($1, $2)
                            ON CONFLICT DO NOTHING RETURNING 1`, [gateway, eventId]);
  if (!ev.rowCount) return;
  const p = (await c.query(`SELECT id, tenant_id, status FROM payments WHERE gateway = $1 AND gateway_payment_id = $2
                            FOR UPDATE`, [gateway, gatewayPaymentId])).rows[0];
  if (!p || p.status === reason) return;

  if (p.status === 'confirmed') {
    const lines = (await c.query(`SELECT account_id, sum(amount_cents)::text AS cents FROM ledger_entries
                                  WHERE ref_payment = $1 GROUP BY account_id`, [p.id])).rows;
    if (lines.length) await post(c, lines.map(l => ({ account: l.account_id, cents: -BigInt(l.cents),
                                                      memo: reason === 'chargeback' ? 'Estorno por chargeback' : 'Reembolso' })), p.id);
  }
  await c.query(`UPDATE payments SET status = $2 WHERE id = $1`, [p.id, reason]);
  if (reason === 'chargeback') {
    await c.query(`UPDATE tenants SET status = 'suspended', suspended_reason = 'chargeback' WHERE id = $1`, [p.tenant_id]);
    const users = await c.query(`UPDATE users SET token_version = token_version + 1 WHERE tenant_id = $1 RETURNING id`, [p.tenant_id]);
    await Promise.all(users.rows.map(u => redis.del(`authstate:${u.id}`)));   // trava na hora, sem esperar o cache
  }
  await audit({ tenantId: p.tenant_id, ip, action: `payment.${reason}`, target: gatewayPaymentId,
                meta: { gateway, locked: reason === 'chargeback' } }, c);
}

/** Mensalidade vencida: suspende (não vale para VIP nem para a conta do administrador). Pagou, volta sozinho. */
export async function overduePayment(c: PoolClient, gateway: 'asaas', eventId: string, subscriptionId: string | undefined, ip?: string) {
  const ev = await c.query(`INSERT INTO webhook_events (gateway, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING 1`, [gateway, eventId]);
  if (!ev.rowCount || !subscriptionId) return;
  const t = (await c.query(`UPDATE tenants SET status = 'suspended', suspended_reason = 'inadimplencia'
                            WHERE asaas_subscription_id = $1 AND status = 'active' AND NOT vip AND NOT is_platform RETURNING id`, [subscriptionId])).rows[0];
  if (!t) return;
  const users = await c.query(`SELECT id FROM users WHERE tenant_id = $1`, [t.id]);
  await Promise.all(users.rows.map(u => redis.del(`authstate:${u.id}`)));   // vale na hora, sem esperar o cache da sessão
  await audit({ tenantId: t.id, ip, action: 'billing.overdue_suspended' }, c);
}
