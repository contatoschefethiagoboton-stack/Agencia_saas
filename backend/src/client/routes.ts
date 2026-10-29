import { Router, type Request } from 'express';
import { z } from 'zod';
import { withTenant } from '../db.js';
import { audit } from '../audit/audit.js';
import { generateMonthlyCalendar, ingestDossier, reviseItem } from '../ai/contentEngine.js';
import { htmlToText, safeFetchText } from '../security/safeFetch.js';
import { metaConnectRouter } from '../integrations/meta/oauth.js';
import { clientMetrics } from '../integrations/meta/insights.js';
import { redis } from '../redis.js';
import { generateArt, generateArtsForMonth, previewArt, TEMPLATES } from '../art/service.js';
import { imageInfo } from '../art/render.js';
import { generatePhoto, imagesReady } from '../ai/images.js';
import { googleConnectRouter, googleReady } from '../integrations/google/google.js';
import { metaReady } from '../integrations/meta/graph.js';
import { adsRouter } from './ads.js';
import { tiktokConnectRouter, tiktokReady } from '../integrations/tiktok/tiktok.js';
import { connectionAlerts } from '../integrations/health.js';

/** Painel do negócio. Tudo passa por withTenant: o RLS garante que um cliente nunca vê dados de outro. */
export const clientRouter = Router();
const tid = (req: Request) => req.user!.tid!;
clientRouter.use((req, res, next) => (req.user?.tid ? next() : res.status(403).json({ error: 'Área do cliente' })));

// ---------- Resumo do painel ----------
clientRouter.get('/summary', async (req, res) => {
  res.json(await withTenant(tid(req), async c => {
    const t = (await c.query(`SELECT t.name, t.city, t.niche, t.plan, p.name AS plan_name, p.posts_per_month
                              FROM tenants t LEFT JOIN plans p ON p.id = t.plan WHERE t.id = $1`, [tid(req)])).rows[0];
    const content = (await c.query(`SELECT status, count(*)::int AS n FROM content_items
                                    WHERE scheduled_for >= date_trunc('month', now()) GROUP BY status`)).rows;
    const ia = (await c.query(`SELECT cost_cents::text, quota_cents::text FROM api_usage
                               WHERE provider = 'anthropic' AND period = date_trunc('month', now())::date`)).rows[0];
    const wa = (await c.query(`SELECT count(*) FILTER (WHERE status = 'active')::int AS ativos, count(*)::int AS total,
                                      (SELECT count(*)::int FROM wa_conversations WHERE mode = 'human') AS aguardando_humano,
                                      (SELECT count(*)::int FROM wa_messages WHERE direction = 'in' AND created_at > now() - interval '30 days') AS recebidas_30d,
                                      (SELECT count(*)::int FROM wa_messages WHERE author = 'ai' AND created_at > now() - interval '30 days') AS respondidas_ia_30d
                                 FROM wa_numbers`)).rows[0];
    const dossier = (await c.query(`SELECT data, updated_at FROM business_dossier WHERE tenant_id = $1`, [tid(req)])).rows[0];
    const canais = (await c.query(`SELECT provider FROM channel_connections`)).rows.map(r => r.provider);
    const campanhas = (await c.query(`SELECT platform, status, monthly_budget_cents::text FROM ad_campaigns`)).rows;
    const filled = dossier ? Object.values(dossier.data).filter(v => v && (!Array.isArray(v) || v.length)).length : 0;
    const alertas = await connectionAlerts(tid(req));
    return { alertas, negocio: t, conteudo: Object.fromEntries(content.map(r => [r.status, r.n])), ia: ia ?? null, whatsapp: wa,
             dossie: { completo: filled >= 6, campos: filled, atualizado: dossier?.updated_at ?? null }, canais, campanhas };
  }));
});

// ---------- O que está ligado nesta instalação (a tela esconde o que não existe) ----------
clientRouter.get('/features', (_req, res) => res.json({
  meta: metaReady(), google: googleReady(), tiktok: tiktokReady(), fotosIA: imagesReady(), textoIA: Boolean(process.env.ANTHROPIC_API_KEY) }));

// ---------- Conexões com redes sociais ----------
clientRouter.use('/connect/meta', metaConnectRouter);
clientRouter.use('/connect/google', googleConnectRouter);
clientRouter.use('/connect/tiktok', tiktokConnectRouter);
clientRouter.use('/ads', adsRouter);

clientRouter.get('/connections', async (req, res) => {
  res.json(await withTenant(tid(req), async c => (await c.query(
    `SELECT provider, external_id, name, expires_at, connected_at, needs_reconnect, last_error,
            expires_at IS NOT NULL AND expires_at < now() + interval '10 days' AS expiring
       FROM channel_connections ORDER BY provider`)).rows));
});

clientRouter.delete('/connections/:provider', async (req, res) => {
  if (req.user!.role !== 'owner') return res.status(403).json({ error: 'Só o responsável pela conta pode desconectar' });
  const provider = z.enum(['facebook', 'instagram', 'meta_ads', 'tiktok', 'google_business', 'google_ads']).parse(req.params.provider);
  await withTenant(tid(req), async c => {
    await c.query(`DELETE FROM channel_connections WHERE provider = $1`, [provider]);
    await audit({ actorId: req.user!.sub, tenantId: tid(req), ip: req.ip, action: 'channels.disconnected', target: provider }, c);
  });
  await redis.del([`metrics:${tid(req)}:7`, `metrics:${tid(req)}:30`, `gtoken:${tid(req)}`, `ttoken:${tid(req)}`]);
  res.json({ ok: true });
});

/** Métricas reais (Instagram + Meta Ads) quando as contas estão conectadas. */
clientRouter.get('/metrics', async (req, res) => {
  const days = req.query.days === '7' ? 7 : 30;
  res.json(await clientMetrics(tid(req), days));
});

// ---------- Identidade visual e biblioteca de fotos ----------
const MAX_UPLOAD = 5 * 1024 * 1024;
clientRouter.get('/media', async (req, res) => {
  const kind = z.enum(['photo', 'logo', 'art']).default('photo').parse(req.query.kind);
  res.json(await withTenant(tid(req), async c => (await c.query(
    `SELECT id, kind, width, height, source, prompt, content_item_id, created_at FROM media WHERE kind = $1
      ORDER BY created_at DESC LIMIT 200`, [kind])).rows));
});

clientRouter.get('/media/:id/raw', async (req, res) => {
  const m = await withTenant(tid(req), async c => (await c.query(`SELECT mime, bytes FROM media WHERE id = $1`,
                                                                  [z.string().uuid().parse(req.params.id)])).rows[0]);
  if (!m) return res.status(404).end();
  res.set('Cache-Control', 'private, max-age=86400').type(m.mime).send(m.bytes);
});

clientRouter.post('/media', async (req, res) => {
  const b = z.object({ kind: z.enum(['photo', 'logo']), dataBase64: z.string().max(7_200_000) }).parse(req.body);
  const bytes = Buffer.from(b.dataBase64, 'base64');
  if (bytes.length > MAX_UPLOAD) return res.status(413).json({ error: 'A imagem precisa ter até 5 MB' });
  const info = imageInfo(bytes);
  if (!info) return res.status(400).json({ error: 'Envie uma imagem JPG ou PNG' });
  if (info.width < 200 || info.height < 200 || info.width > 8000 || info.height > 8000)
    return res.status(400).json({ error: 'Imagem pequena ou grande demais (mínimo 200 px)' });
  const id = await withTenant(tid(req), async c => {
    if (b.kind === 'photo' && (await c.query(`SELECT count(*)::int AS n FROM media WHERE kind = 'photo'`)).rows[0].n >= 80)
      throw Object.assign(new Error('Limite de 80 fotos. Apague algumas antes de enviar mais.'), { status: 409 });
    if (b.kind === 'logo') await c.query(`DELETE FROM media WHERE kind = 'logo'`);
    const r = await c.query(`INSERT INTO media (tenant_id, kind, mime, bytes, width, height) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
                            [tid(req), b.kind, info.mime, bytes, info.width, info.height]);
    if (b.kind === 'logo') await c.query(`UPDATE business_dossier SET data = jsonb_set(data, '{marca}', coalesce(data->'marca', '{}') || jsonb_build_object('logoId', $2::text))
                                          WHERE tenant_id = $1`, [tid(req), r.rows[0].id]);
    await audit({ actorId: req.user!.sub, tenantId: tid(req), ip: req.ip, action: `media.${b.kind}_uploaded` }, c);
    return r.rows[0].id;
  });
  res.status(201).json({ id });
});

/** Foto criada por IA a partir de uma descrição; entra na biblioteca de fotos. */
clientRouter.post('/media/ai', async (req, res) => {
  const prompt = z.string().trim().min(8).max(500).parse(req.body?.prompt);
  const id = await generatePhoto(tid(req), prompt);
  await audit({ actorId: req.user!.sub, tenantId: tid(req), ip: req.ip, action: 'media.ai_photo', target: id });
  res.status(201).json({ id });
});

clientRouter.delete('/media/:id', async (req, res) => {
  await withTenant(tid(req), c => c.query(`DELETE FROM media WHERE id = $1 AND kind IN ('photo', 'logo')`,
                                          [z.string().uuid().parse(req.params.id)]));
  res.json({ ok: true });
});

clientRouter.put('/brand', async (req, res) => {
  const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
  const b = z.object({ primaria: color, secundaria: color }).parse(req.body);
  await withTenant(tid(req), async c => {
    await c.query(`INSERT INTO business_dossier (tenant_id, data) VALUES ($1, jsonb_build_object('marca', $2::jsonb))
                   ON CONFLICT (tenant_id) DO UPDATE SET data = jsonb_set(business_dossier.data, '{marca}',
                     coalesce(business_dossier.data->'marca', '{}') || $2::jsonb), updated_at = now()`, [tid(req), JSON.stringify(b)]);
    await audit({ actorId: req.user!.sub, tenantId: tid(req), ip: req.ip, action: 'brand.saved', meta: b }, c);
  });
  res.json({ ok: true });
});

clientRouter.get('/art/preview', async (req, res) => {
  const template = z.enum(TEMPLATES as [string, ...string[]]).default('destaque').parse(req.query.template);
  res.set('Cache-Control', 'no-store').type('image/jpeg').send(await previewArt(tid(req), template as any));
});

/** Artes em lote: todos os posts do mês para Instagram/Facebook que ainda não têm imagem. */
clientRouter.post('/content/arts', async (req, res) => {
  const month = z.string().regex(/^\d{4}-\d{2}$/).default(new Date().toISOString().slice(0, 7)).parse(req.body?.month);
  const n = await generateArtsForMonth(tid(req), month);
  await audit({ actorId: req.user!.sub, tenantId: tid(req), ip: req.ip, action: 'content.arts_generated', meta: { month, n } });
  res.json({ ok: true, geradas: n });
});

// ---------- Dossiê (memória do comércio) ----------
clientRouter.get('/dossier', async (req, res) => {
  res.json(await withTenant(tid(req), async c =>
    (await c.query(`SELECT data, version, updated_at FROM business_dossier WHERE tenant_id = $1`, [tid(req)])).rows[0] ?? { data: {} }));
});

clientRouter.put('/dossier', async (req, res) => {
  const data = z.record(z.unknown()).parse(req.body?.data);
  if (JSON.stringify(data).length > 60_000) return res.status(413).json({ error: 'Dossiê grande demais' });
  await withTenant(tid(req), async c => {
    await c.query(`INSERT INTO business_dossier (tenant_id, data) VALUES ($1, $2)
                   ON CONFLICT (tenant_id) DO UPDATE SET data = $2, version = business_dossier.version + 1, updated_at = now()`,
                  [tid(req), data]);
    await audit({ actorId: req.user!.sub, tenantId: tid(req), ip: req.ip, action: 'dossier.saved' }, c);
  });
  res.json({ ok: true });
});

/** Leitura automática: site do negócio, cardápio/catálogo em PDF e anotações livres. */
clientRouter.post('/dossier/ingest', async (req, res) => {
  const b = z.object({ websiteUrl: z.string().url().optional(), pdfBase64: z.string().max(14_000_000).optional(),
                       notes: z.string().max(8000).optional() }).parse(req.body);
  if (!b.websiteUrl && !b.pdfBase64 && !b.notes) return res.status(400).json({ error: 'Envie o site, um PDF ou anotações' });
  if (b.pdfBase64 && !Buffer.from(b.pdfBase64.slice(0, 12), 'base64').toString('latin1').startsWith('%PDF'))
    return res.status(400).json({ error: 'O arquivo precisa ser PDF' });
  const siteText = b.websiteUrl ? htmlToText(await safeFetchText(b.websiteUrl)) : undefined;
  const dossier = await ingestDossier(tid(req), { siteText, pdfBase64: b.pdfBase64, notes: b.notes });
  await audit({ actorId: req.user!.sub, tenantId: tid(req), ip: req.ip, action: 'dossier.ingested',
                meta: { site: b.websiteUrl, pdf: Boolean(b.pdfBase64) } });
  res.json({ data: dossier });
});

// ---------- Motor de conteúdo ----------
clientRouter.post('/content/generate', async (req, res) => {
  const month = z.string().regex(/^\d{4}-\d{2}$/).default(new Date().toISOString().slice(0, 7)).parse(req.body?.month);
  const n = await generateMonthlyCalendar(tid(req), month);
  // já entrega com as artes prontas para aprovar (o cliente vê o post como vai sair)
  const artes = await generateArtsForMonth(tid(req), month).catch(e => { console.error('[artes]', e); return 0; });
  await audit({ actorId: req.user!.sub, tenantId: tid(req), ip: req.ip, action: 'content.calendar_generated', meta: { month, n, artes } });
  res.json({ ok: true, criados: n, artes });
});

clientRouter.get('/content', async (req, res) => {
  const month = z.string().regex(/^\d{4}-\d{2}$/).default(new Date().toISOString().slice(0, 7)).parse(req.query.month);
  res.json(await withTenant(tid(req), async c => (await c.query(
    `SELECT id, channel, kind, payload, status, feedback, revision, scheduled_for, error, permalink, published_at FROM content_items
      WHERE to_char(scheduled_for AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM') = $1 ORDER BY scheduled_for`, [month])).rows));
});

// ---------- Aprovação (filtro humano) ----------
export const approvalsRouter = Router();
approvalsRouter.use((req, res, next) => (req.user?.tid ? next() : res.status(403).json({ error: 'Área do cliente' })));

approvalsRouter.get('/', async (req, res) => {
  res.json(await withTenant(tid(req), async c => (await c.query(
    `SELECT id, channel, kind, payload, status, feedback, revision, scheduled_for FROM content_items
      WHERE status IN ('pending_approval', 'changes_requested') ORDER BY scheduled_for`)).rows));
});

approvalsRouter.post('/approve-all', async (req, res) => {
  const n = await withTenant(tid(req), async c => {
    const r = await c.query(`UPDATE content_items SET status = 'approved', decided_by = $1, decided_at = now()
                             WHERE status = 'pending_approval'`, [req.user!.sub]);
    await audit({ actorId: req.user!.sub, tenantId: tid(req), ip: req.ip, action: 'content.approved_all', meta: { n: r.rowCount } }, c);
    return r.rowCount;
  });
  res.json({ ok: true, aprovados: n });
});

/** Arte do post: link público da imagem (Canva, Drive público, site). Instagram exige imagem. */
approvalsRouter.put('/:id/media', async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const images = z.array(z.string().url().regex(/^https:\/\//, 'Use um link https')).max(10).parse(req.body?.images);
  await withTenant(tid(req), async c => {
    await c.query(`DELETE FROM media WHERE content_item_id = $1 AND kind = 'art'`, [id]);
    const r = await c.query(`UPDATE content_items SET payload = (payload - 'image_url' - 'art') || jsonb_build_object('images', $2::jsonb)
                             WHERE id = $1 AND status IN ('pending_approval', 'changes_requested', 'approved', 'failed')`,
                            [id, JSON.stringify(images)]);
    if (!r.rowCount) throw Object.assign(new Error('Este conteúdo não pode mais ser alterado'), { status: 409 });
  });
  res.json({ ok: true });
});

/** Publicação falhou: o cliente confere e manda de novo (nunca é repetida sozinha, para não duplicar post). */
approvalsRouter.post('/:id/retry', async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  await withTenant(tid(req), async c => {
    const r = await c.query(`UPDATE content_items SET status = 'approved', error = NULL, scheduled_for = greatest(scheduled_for, now())
                             WHERE id = $1 AND status = 'failed'`, [id]);
    if (!r.rowCount) throw Object.assign(new Error('Só dá para tentar de novo o que falhou'), { status: 409 });
    await audit({ actorId: req.user!.sub, tenantId: tid(req), ip: req.ip, action: 'content.retry', target: id }, c);
  });
  res.json({ ok: true });
});

approvalsRouter.post('/:id/revise', async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  await reviseItem(tid(req), id);
  await regenerateIfGenerated(tid(req), id);
  res.json({ ok: true });
});

/** Gera ou refaz a arte: trocar modelo, trocar foto ou tirar a foto. */
approvalsRouter.post('/:id/art', async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const b = z.object({ template: z.enum(TEMPLATES as [string, ...string[]]).optional(),
                       photoId: z.string().uuid().nullable().optional() }).parse(req.body ?? {});
  const r = await withTenant(tid(req), c => generateArt(c, tid(req), id, b as any));
  res.json({ ok: true, ...r });
});

/** Cria uma foto por IA para este post (a partir da sugestão de imagem da IA ou de uma descrição) e refaz a arte com ela. */
approvalsRouter.post('/:id/photo-ai', async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const custom = z.string().trim().min(8).max(500).optional().parse(req.body?.prompt);
  const item = await withTenant(tid(req), async c => (await c.query(`SELECT kind, payload FROM content_items WHERE id = $1`, [id])).rows[0]);
  if (!item) return res.status(404).json({ error: 'Conteúdo não encontrado' });
  const prompt = custom ?? item.payload.imagePrompt ?? String(item.payload.caption ?? '').split('\n')[0].slice(0, 300);
  if (!prompt || prompt.length < 8) return res.status(400).json({ error: 'Descreva a foto que você quer' });
  const photoId = await generatePhoto(tid(req), prompt);
  const current = item.payload.art?.template;
  const template = item.kind === 'carousel' ? undefined : ['oferta', 'bastidores', 'destaque'].includes(current) ? current : 'destaque';
  const r = await withTenant(tid(req), c => generateArt(c, tid(req), id, { template, photoId }));
  await audit({ actorId: req.user!.sub, tenantId: tid(req), ip: req.ip, action: 'media.ai_photo', target: id });
  res.json({ ok: true, photoId, ...r });
});

/** Texto reescrito pela IA: a arte gerada automaticamente acompanha (link colado à mão é mantido). */
async function regenerateIfGenerated(tenantId: string, id: string) {
  await withTenant(tenantId, async c => {
    const gen = (await c.query(`SELECT payload->'art'->>'generated' = 'true' AS g FROM content_items WHERE id = $1`, [id])).rows[0]?.g;
    if (gen) await generateArt(c, tenantId, id);
  }).catch(e => console.error('[artes]', e));
}

approvalsRouter.post('/:id', async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const b = z.object({ decision: z.enum(['approve', 'reject', 'changes']), feedback: z.string().trim().min(3).max(1000).optional() })
    .parse(req.body);
  if (b.decision === 'changes' && !b.feedback) return res.status(400).json({ error: 'Escreva o que quer mudar' });
  const status = { approve: 'approved', reject: 'rejected', changes: 'changes_requested' }[b.decision];
  await withTenant(tid(req), async c => {
    const r = await c.query(`UPDATE content_items SET status = $1, decided_by = $2, decided_at = now(), feedback = $4
                             WHERE id = $3 AND status = 'pending_approval'`, [status, req.user!.sub, id, b.feedback ?? null]);
    if (!r.rowCount) throw Object.assign(new Error('Item não encontrado'), { status: 404 });
    await audit({ actorId: req.user!.sub, tenantId: tid(req), ip: req.ip, action: `content.${status}`, target: id }, c);
  });
  // pedido de ajuste: a IA reescreve na hora e o item volta para a fila
  if (b.decision === 'changes') {
    try { await reviseItem(tid(req), id); await regenerateIfGenerated(tid(req), id); return res.json({ ok: true, revisado: true }); }
    catch (e: any) { return res.json({ ok: true, revisado: false, aviso: e.message }); }
  }
  res.json({ ok: true });
});
