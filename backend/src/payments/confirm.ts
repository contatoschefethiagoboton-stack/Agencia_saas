import type { PoolClient } from 'pg';
import { accountId, post } from '../finance/ledger.js';
import { splitMediaBudget } from '../finance/split.js';
import { audit } from '../audit/audit.js';

export async function confirmPayment(c: PoolClient, gateway: 'asaas' | 'mercadopago', eventId: string,
                                     gatewayPaymentId: string, paidCents: bigint, ip?: string) {
  // idempotência
  const ev = await c.query(`INSERT INTO webhook_events (gateway, event_id) VALUES ($1, $2)
                            ON CONFLICT DO NOTHING RETURNING 1`, [gateway, eventId]);
  if (!ev.rowCount) return;

  const { rows } = await c.query(
    `SELECT p.id, p.tenant_id, p.kind, p.amount_cents::text AS amount, p.status, t.media_fee_bps
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
  await audit({ tenantId: p.tenant_id, ip, action: 'payment.confirmed',
                meta: { gateway, kind: p.kind, cents: paidCents.toString() } }, c);
}
