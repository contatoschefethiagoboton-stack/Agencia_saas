import crypto from 'node:crypto';
import type { PoolClient } from 'pg';

type Kind = 'gateway_clearing' | 'tenant_media_wallet' | 'platform_profit'
          | 'agency_media_fund' | 'withdrawals_pending' | 'api_costs';

export async function accountId(c: PoolClient, kind: Kind, tenantId: string | null = null) {
  const { rows } = await c.query(
    `INSERT INTO fin_accounts (kind, tenant_id) VALUES ($1, $2)
     ON CONFLICT (kind, tenant_id) DO UPDATE SET kind = EXCLUDED.kind RETURNING id`, [kind, tenantId]);
  return rows[0].id as string;
}

/** Lança uma transação de partidas dobradas. O banco recusa no COMMIT se não somar zero. */
export async function post(c: PoolClient, lines: { account: string; cents: bigint; memo?: string }[],
                           refPayment?: string) {
  const txn = crypto.randomUUID();
  for (const l of lines) {
    await c.query(`INSERT INTO ledger_entries (txn_id, account_id, amount_cents, memo, ref_payment)
                   VALUES ($1, $2, $3, $4, $5)`, [txn, l.account, l.cents.toString(), l.memo ?? null, refPayment ?? null]);
  }
  return txn;
}

export async function balance(c: PoolClient, account: string, lock = false): Promise<bigint> {
  if (lock) await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [account]);
  const { rows } = await c.query(
    `SELECT coalesce(sum(amount_cents), 0)::text AS b FROM ledger_entries WHERE account_id = $1`, [account]);
  return BigInt(rows[0].b);
}
