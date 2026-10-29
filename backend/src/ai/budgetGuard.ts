import { withTenant } from '../db.js';

/** Teto de consumo de IA por cliente/mês. Bloqueia ANTES de chamar a API. */
export async function guardedAiCall<T>(tenantId: string, estimateCents: number,
                                       call: () => Promise<{ result: T; costCents: number }>): Promise<T> {
  const reserved = await withTenant(tenantId, async c => {
    const { rows } = await c.query(`
      INSERT INTO api_usage (tenant_id, provider, period, cost_cents)
      VALUES ($1, 'anthropic', date_trunc('month', now())::date, $2)
      ON CONFLICT (tenant_id, provider, period)
        DO UPDATE SET cost_cents = api_usage.cost_cents + EXCLUDED.cost_cents
        WHERE api_usage.cost_cents + EXCLUDED.cost_cents <= api_usage.quota_cents
      RETURNING 1`, [tenantId, estimateCents]);
    return rows.length > 0;
  });
  if (!reserved) throw Object.assign(new Error('Limite mensal de IA atingido para este cliente'), { status: 429 });

  const { result, costCents } = await call();
  // ajusta a reserva pelo custo real
  await withTenant(tenantId, c => c.query(
    `UPDATE api_usage SET cost_cents = cost_cents + $2 WHERE tenant_id = $1 AND provider = 'anthropic'
       AND period = date_trunc('month', now())::date`, [tenantId, costCents - estimateCents]));
  return result;
}
