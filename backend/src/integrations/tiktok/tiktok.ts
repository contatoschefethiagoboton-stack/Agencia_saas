import crypto from 'node:crypto';
import { Router, type Request } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { servicePool, withTenant } from '../../db.js';
import { redis } from '../../redis.js';
import { audit } from '../../audit/audit.js';
import { encryptToken, decryptToken } from '../../security/vault.js';
import { assertNotPanicking } from '../../security/panic.js';
import { publicUrl } from '../../config.js';

/*
 * TIKTOK (Content Posting API): publica as artes como CARROSSEL DE FOTOS, com música automática.
 * - Antes da auditoria do app pelo TikTok, só é possível publicar como "Somente eu" (SELF_ONLY).
 *   Depois de aprovado, defina TIKTOK_PRIVACY=PUBLIC_TO_EVERYONE.
 * - O TikTok baixa as imagens do nosso domínio: ele precisa ser verificado no portal do TikTok
 *   (arquivo servido em /<TIKTOK_VERIFY_FILENAME>).
 * - Roteiros de vídeo continuam sendo gravados e postados pelo cliente.
 */
export const tiktokReady = () => Boolean(process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET);
const API = () => process.env.TIKTOK_API_OVERRIDE ?? 'https://open.tiktokapis.com';
const AUTH = () => process.env.TIKTOK_AUTH_URL ?? 'https://www.tiktok.com/v2/auth/authorize/';
const redirectUri = () => `${publicUrl()}/oauth/tiktok/callback`;

async function tokenRequest(params: Record<string, string>) {
  const r = await fetch(`${API()}/v2/oauth/token/`, { method: 'POST', signal: AbortSignal.timeout(20_000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_key: process.env.TIKTOK_CLIENT_KEY!, client_secret: process.env.TIKTOK_CLIENT_SECRET!, ...params }) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`invalid_grant: ${j?.error_description ?? j?.error ?? 'o TikTok recusou a conexão'}`);
  return j as { access_token: string; refresh_token: string; expires_in: number; refresh_expires_in: number; open_id: string };
}

async function tt(path: string, token: string, body?: unknown) {
  const r = await fetch(`${API()}${path}`, { method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || (j.error?.code && j.error.code !== 'ok'))
    throw Object.assign(new Error(`TikTok: ${j?.error?.message || j?.error?.code || r.status}`), { status: 502,
      code: /access_token|token/.test(j?.error?.code ?? '') ? 190 : undefined });
  return j.data ?? {};
}

/** Token de acesso (24 h) renovado com o refresh token; o TikTok pode devolver um refresh novo, que é regravado. */
async function accessToken(tenantId: string, refreshCipher: Buffer) {
  const hit = await redis.get(`ttoken:${tenantId}`);
  if (hit) return hit;
  const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: decryptToken(refreshCipher) });
  if (t.refresh_token && t.refresh_token !== decryptToken(refreshCipher))
    await withTenant(tenantId, c => c.query(`UPDATE channel_connections SET token_cipher = $1, expires_at = now() + make_interval(secs => $2)
                                             WHERE provider = 'tiktok'`, [encryptToken(t.refresh_token), t.refresh_expires_in]), servicePool);
  await redis.set(`ttoken:${tenantId}`, t.access_token, { EX: Math.max(60, t.expires_in - 300) });
  return t.access_token;
}

export async function publishTiktok(tenantId: string, conn: { token_cipher: Buffer },
                                    p: { caption: string; headline?: string; hashtags?: string[]; images?: string[]; image_url?: string }) {
  await assertNotPanicking();
  const imgs = (p.images?.length ? p.images : p.image_url ? [p.image_url] : []).slice(0, 35);
  if (!imgs.length) throw new Error('O TikTok exige imagem: gere a arte do post');
  const token = await accessToken(tenantId, conn.token_cipher);
  const creator = await tt('/v2/post/publish/creator_info/query/', token, {});
  const options: string[] = creator.privacy_level_options ?? ['SELF_ONLY'];
  const wanted = process.env.TIKTOK_PRIVACY ?? 'SELF_ONLY';
  const privacy = options.includes(wanted) ? wanted : options.includes('SELF_ONLY') ? 'SELF_ONLY' : options[0];
  const title = (p.headline ?? p.caption.split('\n')[0]).replace(/#[\p{L}\p{N}_]+/gu, '').trim().slice(0, 90);
  const description = [p.caption, (p.hashtags ?? []).join(' ')].filter(Boolean).join('\n\n').slice(0, 4000);
  const init = await tt('/v2/post/publish/content/init/', token, {
    post_info: { title, description, privacy_level: privacy, disable_comment: false, auto_add_music: true },
    source_info: { source: 'PULL_FROM_URL', photo_cover_index: 0, photo_images: imgs },
    post_mode: 'DIRECT_POST', media_type: 'PHOTO' });
  // o TikTok baixa as fotos e publica em segundo plano: acompanha até concluir
  for (let i = 0; i < 30; i++) {
    const s = await tt('/v2/post/publish/status/fetch/', token, { publish_id: init.publish_id });
    if (s.status === 'PUBLISH_COMPLETE') {
      const id = s.publicaly_available_post_id?.[0] ?? s.publicly_available_post_id?.[0] ?? init.publish_id;
      return { id: String(id), permalink: undefined as string | undefined };   // o TikTok não devolve o link direto
    }
    if (s.status === 'FAILED') throw new Error(`TikTok recusou a publicação: ${s.fail_reason ?? 'motivo não informado'}`);
    await new Promise(r => setTimeout(r, Number(process.env.TIKTOK_POLL_MS ?? 4000)));
  }
  throw new Error('O TikTok ainda está processando; confira no app antes de tentar de novo');
}

// ---------- conexão ----------
type State = { tid: string; sub: string; n: string; purpose: 'tiktok_oauth' };
export const tiktokConnectRouter = Router();
const tid = (req: Request) => req.user!.tid!;

tiktokConnectRouter.post('/start', async (req, res) => {
  if (req.user!.role !== 'owner') return res.status(403).json({ error: 'Só o responsável pela conta pode conectar' });
  if (!tiktokReady()) return res.status(503).json({ error: 'A integração com o TikTok ainda não foi configurada pela agência' });
  await assertNotPanicking();
  const state = jwt.sign({ tid: tid(req), sub: req.user!.sub, n: crypto.randomBytes(12).toString('hex'), purpose: 'tiktok_oauth' } satisfies State,
                         process.env.JWT_SECRET!, { expiresIn: '10m', algorithm: 'HS256' });
  const u = new URL(AUTH());
  u.search = new URLSearchParams({ client_key: process.env.TIKTOK_CLIENT_KEY!, response_type: 'code',
    scope: 'user.info.basic,video.publish', redirect_uri: redirectUri(), state }).toString();
  res.json({ url: u.toString() });
});

export const tiktokCallbackRouter = Router();
tiktokCallbackRouter.get('/callback', async (req, res) => {
  const back = (q: string) => res.redirect(`/#conexoes?${q}`);
  let st: State;
  try { st = jwt.verify(String(req.query.state ?? ''), process.env.JWT_SECRET!, { algorithms: ['HS256'] }) as State; }
  catch { return back('erro=' + encodeURIComponent('A conexão expirou. Tente de novo.')); }
  if (st.purpose !== 'tiktok_oauth') return back('erro=estado');
  if (req.query.error) return back('erro=' + encodeURIComponent('Conexão com o TikTok cancelada'));
  if (await redis.get(`tiktok:used:${st.n}`)) return back('erro=' + encodeURIComponent('Este link de conexão já foi usado'));
  await redis.set(`tiktok:used:${st.n}`, '1', { EX: 900 });
  try {
    const t = await tokenRequest({ grant_type: 'authorization_code', code: String(req.query.code ?? ''), redirect_uri: redirectUri() });
    const info = await tt('/v2/user/info/?fields=open_id,display_name', t.access_token);
    const name = info.user?.display_name ? `@${info.user.display_name}` : 'Conta TikTok';
    await withTenant(st.tid, async c => {
      await c.query(`DELETE FROM channel_connections WHERE provider = 'tiktok'`);
      await c.query(`INSERT INTO channel_connections (tenant_id, provider, external_id, name, token_cipher, expires_at, connected_by)
                     VALUES ($1, 'tiktok', $2, $3, $4, now() + make_interval(secs => $5), $6)`,
                    [st.tid, t.open_id, name, encryptToken(t.refresh_token), t.refresh_expires_in, st.sub]);
      await audit({ actorId: st.sub, tenantId: st.tid, ip: req.ip, action: 'channels.connected', meta: { providers: ['tiktok'] } }, c);
    }, servicePool);
    await redis.set(`ttoken:${st.tid}`, t.access_token, { EX: Math.max(60, t.expires_in - 300) });
    back('tiktok=ok');
  } catch (e) {
    await audit({ actorId: st.sub, tenantId: st.tid, ip: req.ip, action: 'channels.oauth_failed', meta: { provider: 'tiktok', error: (e as Error).message } });
    back('erro=' + encodeURIComponent((e as Error).message.replace(/^invalid_grant: /, '')));
  }
});

/** Arquivo de verificação de domínio exigido pelo TikTok para baixar as artes (PULL_FROM_URL). */
export const tiktokVerifyRouter = Router();
tiktokVerifyRouter.get('/:file', (req, res, next) =>
  process.env.TIKTOK_VERIFY_FILENAME && req.params.file === process.env.TIKTOK_VERIFY_FILENAME
    ? res.type('text/plain').send(process.env.TIKTOK_VERIFY_CONTENT ?? '') : next());
