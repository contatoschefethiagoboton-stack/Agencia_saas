import type { PoolClient } from 'pg';
import { withTenant, servicePool } from '../../db.js';
import { decryptToken } from '../../security/vault.js';
import { isPanicking } from '../../security/panic.js';
import { audit } from '../../audit/audit.js';
import { graphGet, graphPost } from './graph.js';
import { isAuthError, markReconnect } from '../health.js';

/*
 * TRÁFEGO LOCAL SEM GERENCIADOR DE ANÚNCIOS
 * Fluxo: rascunho -> projeção -> criada na Meta com a CAMPANHA PAUSADA -> cliente aprova -> ativa.
 * O conjunto e o anúncio nascem ativos dentro da campanha pausada: quem liga e desliga é só a campanha.
 * Vigia de verba: a cada 15 min confere o gasto do mês e pausa ao atingir o teto aprovado.
 */

/** Pausar é sempre permitido, mesmo em modo pânico (é o que o pânico quer). */
const graph = (path: string, token: string, body: Record<string, unknown>) =>
  graphPost(path, token, body, { allowInPanic: body.status === 'PAUSED' && Object.keys(body).length === 1 });

const OBJ = {
  trafego: { objective: 'OUTCOME_TRAFFIC', goal: 'LINK_CLICKS', label: 'cliques' },
  alcance: { objective: 'OUTCOME_AWARENESS', goal: 'REACH', label: 'pessoas alcançadas' },
} as const;
export type Objective = keyof typeof OBJ;

export const targetingFor = (lat: number, lng: number, radiusKm: number) => ({
  geo_locations: { custom_locations: [{ latitude: lat, longitude: lng, radius: radiusKm, distance_unit: 'kilometer' }] },
  age_min: 18,
  targeting_automation: { advantage_audience: 0 },        // respeita o raio escolhido
});

/** Projeção local (referências de CPM/CTR de negócio local no Brasil); a Meta refina com delivery_estimate. */
export function projectReach(monthlyBudgetCents: number, cpmCentsLow = 800, cpmCentsHigh = 2500) {
  const impMin = Math.round(monthlyBudgetCents / cpmCentsHigh * 1000), impMax = Math.round(monthlyBudgetCents / cpmCentsLow * 1000);
  return { impressoesMin: impMin, impressoesMax: impMax,
           alcanceMin: Math.round(impMin / 2.2), alcanceMax: Math.round(impMax / 1.6),
           cliquesMin: Math.round(impMin * 0.008), cliquesMax: Math.round(impMax * 0.018) };
}

/** Público estimado pela própria Meta no raio (quando a conta de anúncios está conectada). */
export async function metaAudienceSize(adAccountId: string, token: string, objective: Objective, lat: number, lng: number, radiusKm: number) {
  const r = await graphGet(`act_${adAccountId}/delivery_estimate`, token, {
    optimization_goal: OBJ[objective].goal, targeting_spec: JSON.stringify(targetingFor(lat, lng, radiusKm)) });
  const d = r.data?.[0];
  return d ? { publicoMin: d.estimate_mau_lower_bound ?? d.estimate_mau ?? null, publicoMax: d.estimate_mau_upper_bound ?? d.estimate_mau ?? null } : null;
}

export async function adsConnection(c: PoolClient) {
  const rows = (await c.query(`SELECT provider, external_id, token_cipher FROM channel_connections
                               WHERE provider IN ('meta_ads', 'facebook')`)).rows;
  const ads = rows.find(r => r.provider === 'meta_ads'), page = rows.find(r => r.provider === 'facebook');
  return { adAccountId: ads?.external_id as string | undefined, token: ads ? decryptToken(ads.token_cipher) : undefined,
           pageId: page?.external_id as string | undefined };
}

/** Cria campanha (PAUSADA) + conjunto no raio + criativo com a arte + anúncio. Grava os ids externos. */
export async function createOnMeta(c: PoolClient, tenantId: string, campaignId: string) {
  const a = (await c.query(`SELECT * FROM ad_campaigns WHERE id = $1`, [campaignId])).rows[0];
  const conn = await adsConnection(c);
  if (!conn.adAccountId || !conn.token) throw new Error('Conecte a conta de anúncios em Conexões');
  if (!conn.pageId) throw new Error('Conecte a Página do Facebook em Conexões (o anúncio sai em nome dela)');
  const img = (await c.query(`SELECT bytes FROM media WHERE id = $1`, [a.media_id])).rows[0];
  if (!img) throw new Error('Escolha a imagem do anúncio');
  const o = OBJ[a.objective as Objective];
  const act = `act_${conn.adAccountId}`;

  const up = await graph(`${act}/adimages`, conn.token, { bytes: img.bytes.toString('base64') });
  const hash = (Object.values(up.images ?? {})[0] as any)?.hash;
  if (!hash) throw new Error('A Meta não aceitou a imagem do anúncio');
  const camp = await graph(`${act}/campaigns`, conn.token, { name: a.name, objective: o.objective, status: 'PAUSED',
    special_ad_categories: [], is_adset_budget_sharing_enabled: false });
  await c.query(`UPDATE ad_campaigns SET external_campaign_id = $2 WHERE id = $1`, [campaignId, camp.id]);
  const adset = await graph(`${act}/adsets`, conn.token, {
    name: `${a.name} — raio ${a.radius_km} km`, campaign_id: camp.id, status: 'ACTIVE',
    daily_budget: Math.max(100, Math.floor(Number(a.monthly_budget_cents) / 30.4)),   // centavos
    billing_event: 'IMPRESSIONS', optimization_goal: o.goal, bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
    targeting: targetingFor(Number(a.lat), Number(a.lng), a.radius_km) });
  const whats = /wa\.me|whatsapp/i.test(a.link);
  const creative = await graph(`${act}/adcreatives`, conn.token, { name: a.name, object_story_spec: { page_id: conn.pageId,
    link_data: { image_hash: hash, link: a.link, message: a.message, name: a.headline,
                 call_to_action: { type: whats ? 'CONTACT_US' : 'LEARN_MORE', value: { link: a.link } } } } });
  const ad = await graph(`${act}/ads`, conn.token, { name: a.name, adset_id: adset.id, creative: { creative_id: creative.id }, status: 'ACTIVE' });
  await c.query(`UPDATE ad_campaigns SET external_adset_id = $2, external_creative_id = $3, external_ad_id = $4,
                   status = 'pending_approval', error = NULL WHERE id = $1`, [campaignId, adset.id, creative.id, ad.id]);
}

export const setCampaignStatus = (campaignId: string, token: string, status: 'ACTIVE' | 'PAUSED') =>
  graph(campaignId, token, { status });

/** Usado pelo Kill Switch e pelo Modo Pânico: pausa na Meta todas as campanhas do cliente. */
export async function pauseAllTenantCampaigns(tenantId: string) {
  const { rows, token } = await withTenant(tenantId, async c => {
    const rows = (await c.query(`SELECT id, external_campaign_id FROM ad_campaigns
                                 WHERE platform = 'meta' AND external_campaign_id IS NOT NULL AND status = 'active'`)).rows;
    return { rows, token: (await adsConnection(c)).token };
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

/** Vigia de verba: atualiza o gasto do mês e pausa a campanha que chegou ao teto aprovado. */
export async function checkSpend(tenantId: string, campaignId: string) {
  await withTenant(tenantId, async c => {
    const a = (await c.query(`SELECT external_campaign_id, monthly_budget_cents::text FROM ad_campaigns WHERE id = $1 AND status = 'active'`, [campaignId])).rows[0];
    if (!a?.external_campaign_id) return;
    const { token } = await adsConnection(c);
    if (!token) return;
    const r = await graphGet(`${a.external_campaign_id}/insights`, token, { fields: 'spend', date_preset: 'this_month' });
    const spent = Math.round(Number(r.data?.[0]?.spend ?? 0) * 100);
    await c.query(`UPDATE ad_campaigns SET spend_cents_month = $2, spend_checked_at = now() WHERE id = $1`, [campaignId, spent]);
    if (spent >= Number(a.monthly_budget_cents)) {
      await setCampaignStatus(a.external_campaign_id, token, 'PAUSED');
      await c.query(`UPDATE ad_campaigns SET status = 'paused', error = 'Verba do mês atingida: pausada automaticamente' WHERE id = $1`, [campaignId]);
      await audit({ tenantId, action: 'ads.budget_reached', target: campaignId, meta: { spent } }, c);
    }
  }, servicePool);
}

export async function runAdsGuard() {
  for (;;) {
    if (!(await isPanicking())) {
      const { rows } = await servicePool.query('SELECT * FROM ads_active_campaigns()');
      for (const r of rows) await checkSpend(r.tenant_id, r.id).catch(async e => {
        console.error('[vigia de verba]', (e as Error).message);
        if (isAuthError(e)) await markReconnect(r.tenant_id, 'meta_ads', e);   // sem acesso não dá para vigiar: avisa o cliente
      });
    }
    await new Promise(r => setTimeout(r, Number(process.env.ADS_GUARD_INTERVAL_MS ?? 15 * 60_000)));
  }
}
