import { withTenant } from '../db.js';
import { assertNotPanicking } from '../security/panic.js';

export type AiProvider = 'anthropic' | 'images';
const KEYS: Record<AiProvider, [() => string | undefined, string]> = {
  anthropic: [() => process.env.ANTHROPIC_API_KEY, 'IA não configurada (ANTHROPIC_API_KEY)'],
  images: [() => process.env.IMAGE_API_KEY || process.env.OPENAI_API_KEY, 'Geração de fotos não configurada (IMAGE_API_KEY)'],
};

/** Teto de consumo de IA por cliente/mês, por provedor (texto e imagens). Bloqueia ANTES de chamar a API. */
export async function guardedAiCall<T>(tenantId: string, estimateCents: number,
                                       call: () => Promise<{ result: T; costCents: number }>,
                                       provider: AiProvider = 'anthropic'): Promise<T> {
  await assertNotPanicking();
  if (!KEYS[provider][0]()) throw Object.assign(new Error(KEYS[provider][1]), { status: 503 });
  const reserved = await withTenant(tenantId, async c => {
    const { rows } = await c.query(`
      INSERT INTO api_usage (tenant_id, provider, period, cost_cents, quota_cents)
      VALUES ($1, $3, date_trunc('month', now())::date, $2,
              coalesce((SELECT CASE WHEN t.vip THEN 100000000 ELSE p.ai_quota_cents END
                          FROM tenants t JOIN plans p ON p.id = t.plan WHERE t.id = $1), 5000))
      ON CONFLICT (tenant_id, provider, period)
        DO UPDATE SET cost_cents = api_usage.cost_cents + EXCLUDED.cost_cents
        WHERE api_usage.cost_cents + EXCLUDED.cost_cents <= api_usage.quota_cents
      RETURNING 1`, [tenantId, estimateCents, provider]);
    return rows.length > 0;
  });
  if (!reserved) throw Object.assign(new Error('Limite mensal de IA atingido para este cliente'), { status: 429 });

  let out: { result: T; costCents: number };
  try { out = await call(); }
  catch (e) {   // falhou: devolve a reserva
    await withTenant(tenantId, c => c.query(
      `UPDATE api_usage SET cost_cents = greatest(cost_cents - $2, 0) WHERE tenant_id = $1 AND provider = $3
         AND period = date_trunc('month', now())::date`, [tenantId, estimateCents, provider]));
    throw e;
  }
  const { result, costCents } = out;
  // ajusta a reserva pelo custo real
  await withTenant(tenantId, c => c.query(
    `UPDATE api_usage SET cost_cents = cost_cents + $2 WHERE tenant_id = $1 AND provider = $3
       AND period = date_trunc('month', now())::date`, [tenantId, costCents - estimateCents, provider]));
  return result;
}
