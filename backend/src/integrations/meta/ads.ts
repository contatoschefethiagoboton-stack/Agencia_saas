import { withTenant, servicePool } from '../../db.js';
import { decryptToken } from '../../security/vault.js';
import { assertNotPanicking } from '../../security/panic.js';

const G = () => `https://graph.facebook.com/${process.env.META_API_VERSION}`;

async function graph(path: string, token: string, body?: Record<string, unknown>) {
  // pausar campanha é sempre permitido, mesmo em modo pânico (é o que o pânico quer)
  if (!(body && body.status === 'PAUSED' && Object.keys(body).length === 1)) await assertNotPanicking();
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

/** Usado pelo Kill Switch e pelo Modo Pânico: pausa na Meta todas as campanhas do cliente. */
export async function pauseAllTenantCampaigns(tenantId: string) {
  const { rows, token } = await withTenant(tenantId, async c => {
    const rows = (await c.query(`SELECT id, external_campaign_id FROM ad_campaigns
                                 WHERE platform = 'meta' AND external_campaign_id IS NOT NULL AND status <> 'paused'`)).rows;
    const conn = (await c.query(`SELECT token_cipher FROM channel_connections WHERE provider = 'meta_ads' LIMIT 1`)).rows[0];
    return { rows, token: conn ? decryptToken(conn.token_cipher) : null };
  }, servicePool);
  let paused = 0;
  for (const r of rows) {
    try {
      if (token) await setCampaignStatus(r.external_campaign_id, token, 'PAUSED');
      await withTenant(tenantId, c => c.query(`UPDATE ad_campaigns SET status = 'paused' WHERE id = $1`, [r.id]), servicePool);
      paused++;
    } catch (e) { console.error('[meta-ads] falha ao pausar', r.external_campaign_id, e); }
  }
  return paused;
}
