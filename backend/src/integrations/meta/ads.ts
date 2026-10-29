import { withService } from '../../db.js';

const G = () => `https://graph.facebook.com/${process.env.META_API_VERSION}`;

async function graph(path: string, token: string, body?: Record<string, unknown>) {
  const r = await fetch(`${G()}/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json();
  if (!r.ok) throw new Error(`Meta API: ${json?.error?.message ?? r.status}`);
  return json;
}

/** Projeção simples (estimativa): para números da própria Meta use o endpoint delivery_estimate. */
export function projectReach(monthlyBudgetCents: number, cpmCentsLow = 800, cpmCentsHigh = 2500) {
  return { impressoesMin: Math.round(monthlyBudgetCents / cpmCentsHigh * 1000),
           impressoesMax: Math.round(monthlyBudgetCents / cpmCentsLow * 1000) };
}

/**
 * Cria campanha + conjunto no raio do comércio, SEMPRE em PAUSED.
 * Só é ativada depois da aprovação do cliente no painel.
 * Pré-requisitos: app aprovado na Meta (ads_management), conta de anúncios do cliente
 * compartilhada com o Business Manager da agência e forma de pagamento ativa.
 */
export async function createLocalCampaign(opts: {
  adAccountId: string; token: string; name: string; monthlyBudgetCents: number;
  lat: number; lng: number; radiusKm: number;
}) {
  const campaign = await graph(`act_${opts.adAccountId}/campaigns`, opts.token, {
    name: opts.name, objective: 'OUTCOME_TRAFFIC', status: 'PAUSED', special_ad_categories: [],
  });
  const adset = await graph(`act_${opts.adAccountId}/adsets`, opts.token, {
    name: `${opts.name} — raio ${opts.radiusKm} km`, campaign_id: campaign.id, status: 'PAUSED',
    daily_budget: Math.floor(opts.monthlyBudgetCents / 30.4),   // centavos (unidade mínima da moeda)
    billing_event: 'IMPRESSIONS', optimization_goal: 'LINK_CLICKS', bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
    targeting: { geo_locations: { custom_locations: [
      { latitude: opts.lat, longitude: opts.lng, radius: opts.radiusKm, distance_unit: 'kilometer' }] } },
  });
  return { campaignId: campaign.id as string, adsetId: adset.id as string };
}

export const setCampaignStatus = (campaignId: string, token: string, status: 'ACTIVE' | 'PAUSED') =>
  graph(campaignId, token, { status });

/** Usado pelo Kill Switch. Obtém tokens decifrados do cofre (implementar decryptToken). */
export async function pauseAllTenantCampaigns(tenantId: string) {
  const rows = await withService(async c => {
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    return (await c.query(`SELECT external_campaign_id FROM ad_campaigns
                           WHERE platform = 'meta' AND external_campaign_id IS NOT NULL`)).rows;
  });
  // for (const r of rows) await setCampaignStatus(r.external_campaign_id, await decryptToken(...), 'PAUSED');
  return rows.length;
}
