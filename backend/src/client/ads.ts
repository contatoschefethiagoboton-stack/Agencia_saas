import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { withTenant } from '../db.js';
import { audit } from '../audit/audit.js';
import { accountId, balance } from '../finance/ledger.js';
import { adsConnection, createOnMeta, metaAudienceSize, projectReach, setCampaignStatus } from '../integrations/meta/ads.js';
import { graphPost } from '../integrations/meta/graph.js';

/** Campanhas de tráfego local: o cliente cria, vê a projeção, aprova e acompanha — sem Gerenciador de Anúncios. */
export const adsRouter = Router();
const tid = (req: Request) => req.user!.tid!;
const ownerOnly = (req: Request, res: Response, next: NextFunction) =>
  req.user?.role === 'owner' ? next() : res.status(403).json({ error: 'Só o responsável pela conta mexe em anúncios' });
const MIN_BUDGET = 15_000;   // R$ 150/mês: abaixo disso a Meta mal entrega

adsRouter.get('/', async (req, res) => {
  res.json(await withTenant(tid(req), async c => {
    const conn = await adsConnection(c);
    const campanhas = (await c.query(`SELECT id, name, objective, status, monthly_budget_cents::text, spend_cents_month::text, radius_km,
                                             link, headline, message, media_id, projection, error, created_at, approved_at
                                      FROM ad_campaigns WHERE NOT is_agency_own ORDER BY created_at DESC`)).rows;
    // saldo de mídia pago pelo cliente à plataforma (split no ledger) — informativo
    let carteira: string | null = null;
    try { carteira = (await balance(c, await accountId(c, 'tenant_media_wallet', tid(req)))).toString(); } catch { carteira = null; }
    return { conectado: Boolean(conn.adAccountId && conn.pageId), contaAnuncios: Boolean(conn.adAccountId), pagina: Boolean(conn.pageId),
             campanhas, carteiraMidiaCents: carteira };
  }));
});

const Draft = z.object({
  name: z.string().trim().min(3).max(80), objective: z.enum(['trafego', 'alcance']),
  monthlyBudgetCents: z.number().int().min(MIN_BUDGET).max(10_000_000), radiusKm: z.number().int().min(1).max(80),
  lat: z.number().min(-34).max(6), lng: z.number().min(-74).max(-28),            // território brasileiro
  link: z.string().url().regex(/^https:\/\//, 'Use um link https (site ou wa.me)'),
  headline: z.string().trim().min(3).max(40), message: z.string().trim().min(10).max(600), mediaId: z.string().uuid(),
});

adsRouter.post('/projection', async (req, res) => {
  const b = Draft.pick({ objective: true, monthlyBudgetCents: true, radiusKm: true, lat: true, lng: true }).parse(req.body);
  const local = projectReach(b.monthlyBudgetCents);
  const meta = await withTenant(tid(req), async c => {
    const conn = await adsConnection(c);
    if (!conn.adAccountId || !conn.token) return null;
    return metaAudienceSize(conn.adAccountId, conn.token, b.objective, b.lat, b.lng, b.radiusKm).catch(() => null);
  });
  res.json({ ...local, ...(meta ?? {}), fonte: meta ? 'meta' : 'estimativa' });
});

/** Cria o rascunho e já monta tudo na Meta com a campanha PAUSADA. Nada gasta até a aprovação. */
adsRouter.post('/', ownerOnly, async (req, res) => {
  const b = Draft.parse(req.body);
  const projection = projectReach(b.monthlyBudgetCents);
  const id = await withTenant(tid(req), async c => {
    if (!(await c.query(`SELECT 1 FROM media WHERE id = $1 AND kind IN ('art', 'photo')`, [b.mediaId])).rowCount)
      throw Object.assign(new Error('Imagem não encontrada'), { status: 400 });
    const r = await c.query(`INSERT INTO ad_campaigns (tenant_id, platform, name, objective, monthly_budget_cents, radius_km, lat, lng,
                               link, headline, message, media_id, projection, created_by, status)
                             VALUES ($1, 'meta', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'draft') RETURNING id`,
                            [tid(req), b.name, b.objective, b.monthlyBudgetCents, b.radiusKm, b.lat, b.lng, b.link, b.headline, b.message,
                             b.mediaId, projection, req.user!.sub]);
    await audit({ actorId: req.user!.sub, tenantId: tid(req), ip: req.ip, action: 'ads.draft_created', target: r.rows[0].id,
                  meta: { budget: b.monthlyBudgetCents, radius: b.radiusKm } }, c);
    return r.rows[0].id as string;
  });
  const out = await build(tid(req), id);
  res.status(201).json({ id, ...out });
});

async function build(tenantId: string, id: string) {
  try {
    await withTenant(tenantId, c => createOnMeta(c, tenantId, id));
    return { status: 'pending_approval' };
  } catch (e) {
    const msg = (e as Error).message.slice(0, 400);
    await withTenant(tenantId, c => c.query(`UPDATE ad_campaigns SET status = 'failed', error = $2 WHERE id = $1`, [id, msg]));
    return { status: 'failed', error: msg };
  }
}

adsRouter.post('/:id/retry', ownerOnly, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const ok = await withTenant(tid(req), async c => (await c.query(
    `UPDATE ad_campaigns SET status = 'draft', error = NULL WHERE id = $1 AND status IN ('failed', 'draft') RETURNING 1`, [id])).rowCount);
  if (!ok) return res.status(409).json({ error: 'Só dá para tentar de novo campanha com erro' });
  res.json(await build(tid(req), id));
});

/** Aprovar = autorizar o gasto do mês. Liga a campanha na Meta. */
adsRouter.post('/:id/approve', ownerOnly, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  await withTenant(tid(req), async c => {
    const a = (await c.query(`SELECT status, external_campaign_id, monthly_budget_cents::text, spend_cents_month::text
                              FROM ad_campaigns WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!a || !['pending_approval', 'paused'].includes(a.status) || !a.external_campaign_id)
      throw Object.assign(new Error('Esta campanha não pode ser ativada agora'), { status: 409 });
    if (Number(a.spend_cents_month) >= Number(a.monthly_budget_cents))
      throw Object.assign(new Error('A verba do mês já foi usada. Aumente a verba para reativar.'), { status: 409 });
    const { token } = await adsConnection(c);
    if (!token) throw Object.assign(new Error('Conta de anúncios desconectada'), { status: 409 });
    await setCampaignStatus(a.external_campaign_id, token, 'ACTIVE');
    await c.query(`UPDATE ad_campaigns SET status = 'active', error = NULL, approved_by = coalesce(approved_by, $2),
                     approved_at = coalesce(approved_at, now()) WHERE id = $1`, [id, req.user!.sub]);
    await audit({ actorId: req.user!.sub, tenantId: tid(req), ip: req.ip, action: 'ads.activated', target: id,
                  meta: { budget: a.monthly_budget_cents } }, c);
  });
  res.json({ ok: true });
});

adsRouter.post('/:id/pause', async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  await withTenant(tid(req), async c => {
    const a = (await c.query(`SELECT status, external_campaign_id FROM ad_campaigns WHERE id = $1`, [id])).rows[0];
    if (a?.status !== 'active') throw Object.assign(new Error('A campanha não está ativa'), { status: 409 });
    const { token } = await adsConnection(c);
    if (token) await setCampaignStatus(a.external_campaign_id, token, 'PAUSED');
    await c.query(`UPDATE ad_campaigns SET status = 'paused' WHERE id = $1`, [id]);
    await audit({ actorId: req.user!.sub, tenantId: tid(req), ip: req.ip, action: 'ads.paused', target: id }, c);
  });
  res.json({ ok: true });
});

/** Muda a verba do mês (vale também para liberar uma campanha pausada por teto). */
adsRouter.patch('/:id', ownerOnly, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const cents = z.number().int().min(MIN_BUDGET).max(10_000_000).parse(req.body?.monthlyBudgetCents);
  await withTenant(tid(req), async c => {
    const a = (await c.query(`SELECT status, external_adset_id FROM ad_campaigns WHERE id = $1`, [id])).rows[0];
    if (!a || ['ended', 'failed', 'draft'].includes(a.status)) throw Object.assign(new Error('Campanha não encontrada'), { status: 404 });
    const { token } = await adsConnection(c);
    if (a.external_adset_id && token)
      await graphPost(a.external_adset_id, token, { daily_budget: Math.max(100, Math.floor(cents / 30.4)) });
    await c.query(`UPDATE ad_campaigns SET monthly_budget_cents = $2, error = NULL WHERE id = $1`, [id, cents]);
    await audit({ actorId: req.user!.sub, tenantId: tid(req), ip: req.ip, action: 'ads.budget_changed', target: id, meta: { cents } }, c);
  });
  res.json({ ok: true });
});

/** Encerra: pausa na Meta (se existir) e tira da lista ativa. */
adsRouter.delete('/:id', ownerOnly, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  await withTenant(tid(req), async c => {
    const a = (await c.query(`SELECT status, external_campaign_id FROM ad_campaigns WHERE id = $1`, [id])).rows[0];
    if (!a) throw Object.assign(new Error('Campanha não encontrada'), { status: 404 });
    const { token } = await adsConnection(c);
    if (a.external_campaign_id && token) await setCampaignStatus(a.external_campaign_id, token, 'PAUSED').catch(() => {});
    await c.query(`UPDATE ad_campaigns SET status = 'ended' WHERE id = $1`, [id]);
    await audit({ actorId: req.user!.sub, tenantId: tid(req), ip: req.ip, action: 'ads.ended', target: id }, c);
  });
  res.json({ ok: true });
});
