import { servicePool, withTenant } from '../../db.js';
import { decryptToken } from '../../security/vault.js';
import { isPanicking } from '../../security/panic.js';
import { audit } from '../../audit/audit.js';
import { graphGet, graphPost } from './graph.js';
import { publishGbp } from '../google/google.js';
import { publishTiktok } from '../tiktok/tiktok.js';
import { isAuthError, markReconnect } from '../health.js';

/*
 * PUBLICADOR: a cada 30s pega os conteúdos APROVADOS cujo horário chegou e publica
 * no Facebook (página), no Instagram (conta profissional) e no Google Meu Negócio do próprio cliente.
 * Nada que não foi aprovado é publicado. Falha nunca é repetida sozinha (evita post duplicado):
 * o cliente vê o erro no painel e clica em "Tentar de novo".
 */
interface Item { id: string; tenant_id: string; channel: 'instagram' | 'facebook' | 'google_business' | 'tiktok'; kind: string;
                 payload: { caption: string; hashtags?: string[]; image_url?: string; images?: string[] } }

const captionOf = (p: Item['payload']) => [p.caption, (p.hashtags ?? []).join(' ')].filter(Boolean).join('\n\n').slice(0, 2200);
const imagesOf = (p: Item['payload']) => (p.images?.length ? p.images : p.image_url ? [p.image_url] : []).slice(0, 10);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Instagram processa a mídia antes de publicar: espera o contêiner ficar FINISHED. */
async function waitContainer(id: string, token: string) {
  for (let i = 0; i < 20; i++) {
    const s = await graphGet(id, token, { fields: 'status_code' });
    if (s.status_code === 'FINISHED') return;
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new Error('O Instagram não aceitou a imagem (formato JPG, até 8 MB, link público)');
    await sleep(3_000);
  }
  throw new Error('O Instagram demorou demais para processar a imagem');
}

async function publishInstagram(igId: string, token: string, it: Item) {
  const imgs = imagesOf(it.payload);
  if (!imgs.length) throw new Error('O Instagram exige imagem: adicione o link da arte no card do conteúdo');
  let creation: string;
  if (it.kind === 'story') {
    creation = (await graphPost(`${igId}/media`, token, { image_url: imgs[0], media_type: 'STORIES' })).id;
  } else if (imgs.length === 1) {
    creation = (await graphPost(`${igId}/media`, token, { image_url: imgs[0], caption: captionOf(it.payload) })).id;
  } else {
    const children: string[] = [];
    for (const url of imgs) children.push((await graphPost(`${igId}/media`, token, { image_url: url, is_carousel_item: true })).id);
    for (const ch of children) await waitContainer(ch, token);
    creation = (await graphPost(`${igId}/media`, token, { media_type: 'CAROUSEL', children: children.join(','), caption: captionOf(it.payload) })).id;
  }
  await waitContainer(creation, token);
  const pub = await graphPost(`${igId}/media_publish`, token, { creation_id: creation });
  const info = await graphGet(pub.id, token, { fields: 'permalink' }).catch(() => ({}));
  return { id: pub.id as string, permalink: (info as any).permalink as string | undefined };
}

async function publishFacebook(pageId: string, token: string, it: Item) {
  const imgs = imagesOf(it.payload);
  const message = captionOf(it.payload);
  let id: string;
  if (!imgs.length) id = (await graphPost(`${pageId}/feed`, token, { message })).id;
  else if (imgs.length === 1) { const r = await graphPost(`${pageId}/photos`, token, { url: imgs[0], caption: message }); id = r.post_id ?? r.id; }
  else {
    const media = [];
    for (const url of imgs) media.push({ media_fbid: (await graphPost(`${pageId}/photos`, token, { url, published: false })).id });
    id = (await graphPost(`${pageId}/feed`, token, { message, attached_media: media })).id;
  }
  return { id, permalink: `https://www.facebook.com/${id}` };
}

export async function publishItem(tenantId: string, itemId: string) {
  const svc = <T>(fn: (c: any) => Promise<T>) => withTenant(tenantId, fn, servicePool);
  const { it, conn, phone } = await svc(async c => {
    const it = (await c.query(`SELECT id, tenant_id, channel, kind, payload FROM content_items WHERE id = $1`, [itemId])).rows[0] as Item;
    const conn = (await c.query(`SELECT external_id, token_cipher, needs_reconnect FROM channel_connections WHERE provider = $1`, [it.channel])).rows[0];
    const phone = (await c.query(`SELECT data->>'telefone' AS t FROM business_dossier WHERE tenant_id = $1`, [tenantId])).rows[0]?.t;
    return { it, conn, phone };
  });
  try {
    const nome = { instagram: 'Instagram', facebook: 'Facebook', google_business: 'Google Meu Negócio', tiktok: 'TikTok' }[it.channel];
    if (!conn) throw new Error(`${nome} não conectado. Conecte em Conexões.`);
    if (conn.needs_reconnect) throw new Error(`O acesso ao ${nome} expirou ou foi removido. Reconecte em Conexões.`);
    const r = it.channel === 'google_business' ? await publishGbp(tenantId, conn, it.payload, phone)
      : it.channel === 'tiktok' ? await publishTiktok(tenantId, conn, it.payload)
      : it.channel === 'instagram' ? await publishInstagram(conn.external_id, decryptToken(conn.token_cipher), it)
      : await publishFacebook(conn.external_id, decryptToken(conn.token_cipher), it);
    await svc(async c => {
      await c.query(`UPDATE content_items SET status = 'published', external_id = $2, permalink = $3, published_at = now(), error = NULL
                     WHERE id = $1`, [it.id, r.id, r.permalink ?? null]);
      await audit({ tenantId, action: 'content.published', target: it.id, meta: { channel: it.channel, post: r.id } }, c);
    });
  } catch (e) {
    if (conn && isAuthError(e)) await markReconnect(tenantId, it.channel, e);
    const msg = (e as Error).message.slice(0, 500);
    await svc(async c => {
      await c.query(`UPDATE content_items SET status = 'failed', error = $2 WHERE id = $1`, [it.id, msg]);
      await audit({ tenantId, action: 'content.publish_failed', target: it.id, meta: { channel: it.channel, error: msg } }, c);
    });
  }
}

export async function runPublisher() {
  for (;;) {
    if (!(await isPanicking())) {
      const { rows } = await servicePool.query('SELECT * FROM content_claim_due(10)');
      for (const r of rows) await publishItem(r.tenant_id, r.id);   // um por vez: respeita limites da API
    }
    await sleep(Number(process.env.PUBLISHER_INTERVAL_MS ?? 30_000));
  }
}
