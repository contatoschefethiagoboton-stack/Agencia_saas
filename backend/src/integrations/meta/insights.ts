import { withTenant } from '../../db.js';
import { redis } from '../../redis.js';
import { decryptToken } from '../../security/vault.js';
import { graphGet } from './graph.js';

/*
 * MÉTRICAS REAIS do painel do cliente: Instagram (conta profissional) e Meta Ads.
 * Cada bloco é independente: se um falhar (permissão, token expirado), os outros aparecem
 * e o erro vai junto para a tela explicar o que reconectar. Cache de 15 min no Redis.
 */
export async function clientMetrics(tenantId: string, days: 7 | 30) {
  const key = `metrics:${tenantId}:${days}`;
  const hit = await redis.get(key);
  if (hit) return JSON.parse(hit);

  const conns = await withTenant(tenantId, async c =>
    (await c.query(`SELECT provider, external_id, name, token_cipher FROM channel_connections
                    WHERE provider IN ('instagram', 'meta_ads')`)).rows);
  const ig = conns.find(c => c.provider === 'instagram');
  const ads = conns.find(c => c.provider === 'meta_ads');
  const until = Math.floor(Date.now() / 1000);
  const since = until - days * 86_400;
  const out: any = { periodo: days, instagram: null, anuncios: null, erros: [] as string[] };

  if (ig) {
    const t = decryptToken(ig.token_cipher);
    out.instagram = { conta: ig.name };
    try {
      const prof = await graphGet(ig.external_id, t, { fields: 'followers_count,media_count,username' });
      out.instagram.seguidores = prof.followers_count; out.instagram.posts = prof.media_count;
    } catch (e) { out.erros.push(`Instagram (perfil): ${(e as Error).message}`); }
    try {
      const tot = await graphGet(`${ig.external_id}/insights`, t, { metric: 'reach,views,accounts_engaged,total_interactions',
        period: 'day', metric_type: 'total_value', since: String(since), until: String(until) });
      for (const m of tot.data ?? []) out.instagram[m.name] = m.total_value?.value ?? null;
    } catch (e) { out.erros.push(`Instagram (alcance): ${(e as Error).message}`); }
    try {
      const daily = await graphGet(`${ig.external_id}/insights`, t, { metric: 'reach', period: 'day', since: String(since), until: String(until) });
      out.instagram.alcanceDiario = (daily.data?.[0]?.values ?? []).map((v: any) => ({ dia: v.end_time?.slice(0, 10), valor: v.value }));
    } catch { out.instagram.alcanceDiario = []; }
    try {
      const media = await graphGet(`${ig.external_id}/media`, t, { fields: 'id,caption,media_type,timestamp,like_count,comments_count,permalink', limit: '50' });
      out.instagram.melhores = (media.data ?? [])
        .filter((m: any) => Date.parse(m.timestamp) / 1000 >= since)
        .map((m: any) => ({ legenda: (m.caption ?? '').split('\n')[0].slice(0, 90), tipo: m.media_type, data: m.timestamp,
                            curtidas: m.like_count ?? 0, comentarios: m.comments_count ?? 0, link: m.permalink }))
        .sort((a: any, b: any) => (b.curtidas + 2 * b.comentarios) - (a.curtidas + 2 * a.comentarios)).slice(0, 5);
    } catch (e) { out.erros.push(`Instagram (posts): ${(e as Error).message}`); }
  }

  if (ads) {
    try {
      const r = await graphGet(`act_${ads.external_id}/insights`, decryptToken(ads.token_cipher),
        { fields: 'spend,reach,impressions,clicks,cpc,actions', date_preset: days === 7 ? 'last_7d' : 'last_30d' });
      const d = r.data?.[0] ?? {};
      const act = (type: string) => Number((d.actions ?? []).find((a: any) => a.action_type === type)?.value ?? 0);
      out.anuncios = { conta: ads.name, gasto: Number(d.spend ?? 0), alcance: Number(d.reach ?? 0), cliques: Number(d.clicks ?? 0),
                       cpc: d.cpc ? Number(d.cpc) : null,
                       conversas: act('onsite_conversion.messaging_conversation_started_7d'), cliquesLink: act('link_click') };
    } catch (e) { out.erros.push(`Meta Ads: ${(e as Error).message}`); }
  }

  await redis.set(key, JSON.stringify(out), { EX: 900 });
  return out;
}
