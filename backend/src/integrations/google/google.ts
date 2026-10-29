import crypto from 'node:crypto';
import { Router, type Request } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { withTenant } from '../../db.js';
import { redis } from '../../redis.js';
import { audit } from '../../audit/audit.js';
import { encryptToken, decryptToken } from '../../security/vault.js';
import { assertNotPanicking } from '../../security/panic.js';
import { publicUrl } from '../../config.js';

/*
 * GOOGLE MEU NEGÓCIO (Business Profile)
 * Login do Google (OAuth com acesso offline) -> o cliente escolhe o local -> guardamos o refresh token cifrado.
 * Publicação: posts "novidade" (localPosts) com a arte gerada.
 * Pré-requisito da agência: projeto no Google Cloud com acesso às APIs do Business Profile (pedido ao Google).
 * GOOGLE_API_OVERRIDE só existe para testes (servidor falso local).
 */
export const googleReady = () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const SCOPE = 'https://www.googleapis.com/auth/business.manage';
const AUTH_URL = () => process.env.GOOGLE_AUTH_URL ?? 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = () => process.env.GOOGLE_API_OVERRIDE ? `${process.env.GOOGLE_API_OVERRIDE}/oauth2.googleapis.com/token` : 'https://oauth2.googleapis.com/token';
const api = (host: string, path: string) => process.env.GOOGLE_API_OVERRIDE ? `${process.env.GOOGLE_API_OVERRIDE}/${host}${path}` : `https://${host}${path}`;
const redirectUri = () => `${publicUrl()}/oauth/google/callback`;

async function gfetch(url: string, token: string, body?: unknown) {
  const r = await fetch(url, { method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(20_000),
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`Google: ${j?.error?.message ?? r.status}`), { status: 502 });
  return j;
}

async function tokenRequest(params: Record<string, string>) {
  const r = await fetch(TOKEN_URL(), { method: 'POST', signal: AbortSignal.timeout(20_000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID!, client_secret: process.env.GOOGLE_CLIENT_SECRET!, ...params }) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(j?.error_description ?? j?.error ?? 'O Google recusou a conexão');
  return j as { access_token: string; refresh_token?: string; expires_in: number };
}

/** Token de acesso de 1h, renovado com o refresh token e guardado no Redis até perto de expirar. */
export async function googleAccessToken(tenantId: string, refreshCipher: Buffer) {
  const key = `gtoken:${tenantId}`;
  const hit = await redis.get(key);
  if (hit) return hit;
  let t;
  try { t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: decryptToken(refreshCipher) }); }
  catch (e) { throw Object.assign(new Error(`invalid_grant: ${(e as Error).message}`), { status: 502 }); }   // acesso removido pelo cliente
  await redis.set(key, t.access_token, { EX: Math.max(60, t.expires_in - 120) });
  return t.access_token;
}

/** Publica um post no perfil do Google. Retorna o nome do post e o link de busca. */
export async function publishGbp(tenantId: string, conn: { external_id: string; token_cipher: Buffer },
                                 p: { caption: string; images?: string[]; image_url?: string; cta?: string }, phone?: string) {
  await assertNotPanicking();
  const token = await googleAccessToken(tenantId, conn.token_cipher);
  const img = p.images?.[0] ?? p.image_url;
  const body: any = { languageCode: 'pt-BR', topicType: 'STANDARD',
    summary: p.caption.replace(/#[\p{L}\p{N}_]+/gu, '').trim().slice(0, 1500) };
  if (img) body.media = [{ mediaFormat: 'PHOTO', sourceUrl: img }];
  if (phone) body.callToAction = { actionType: 'CALL' };
  const out = await gfetch(api('mybusiness.googleapis.com', `/v4/${conn.external_id}/localPosts`), token, body);
  return { id: out.name as string, permalink: out.searchUrl as string | undefined };
}

// ---------- conexão ----------
type State = { tid: string; sub: string; n: string; purpose: 'google_oauth' };
interface Pending { tid: string; sub: string; refresh: string; locations: { id: string; title: string; address: string }[] }
const PENDING = (n: string) => `google:pending:${n}`;

export const googleConnectRouter = Router();
const tid = (req: Request) => req.user!.tid!;

googleConnectRouter.post('/start', async (req, res) => {
  if (req.user!.role !== 'owner') return res.status(403).json({ error: 'Só o responsável pela conta pode conectar' });
  if (!googleReady()) return res.status(503).json({ error: 'A integração com o Google ainda não foi configurada pela agência (GOOGLE_CLIENT_ID/SECRET)' });
  await assertNotPanicking();
  const state = jwt.sign({ tid: tid(req), sub: req.user!.sub, n: crypto.randomBytes(12).toString('hex'), purpose: 'google_oauth' } satisfies State,
                         process.env.JWT_SECRET!, { expiresIn: '10m', algorithm: 'HS256' });
  const u = new URL(AUTH_URL());
  u.search = new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID!, redirect_uri: redirectUri(), response_type: 'code',
                                   scope: SCOPE, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state }).toString();
  res.json({ url: u.toString() });
});

googleConnectRouter.get('/pending/:n', async (req, res) => {
  const raw = await redis.get(PENDING(z.string().regex(/^[0-9a-f]{24}$/).parse(req.params.n)));
  const p: Pending | null = raw ? JSON.parse(raw) : null;
  if (!p || p.tid !== tid(req)) return res.status(404).json({ error: 'Conexão expirada. Clique em conectar de novo.' });
  res.json({ locations: p.locations });
});

googleConnectRouter.post('/select', async (req, res) => {
  const b = z.object({ n: z.string().regex(/^[0-9a-f]{24}$/), locationId: z.string().regex(/^accounts\/\d+\/locations\/\d+$/) }).parse(req.body);
  const raw = await redis.get(PENDING(b.n));
  const p: Pending | null = raw ? JSON.parse(raw) : null;
  if (!p || p.tid !== tid(req) || p.sub !== req.user!.sub) return res.status(404).json({ error: 'Conexão expirada. Clique em conectar de novo.' });
  const loc = p.locations.find(l => l.id === b.locationId);
  if (!loc) return res.status(400).json({ error: 'Local inválido' });
  await withTenant(tid(req), async c => {
    await c.query(`DELETE FROM channel_connections WHERE provider = 'google_business'`);
    await c.query(`INSERT INTO channel_connections (tenant_id, provider, external_id, name, token_cipher, meta, connected_by)
                   VALUES ($1, 'google_business', $2, $3, $4, $5, $6)`,
                  [tid(req), loc.id, loc.title, Buffer.from(p.refresh, 'base64'), { address: loc.address }, req.user!.sub]);
    await audit({ actorId: req.user!.sub, tenantId: tid(req), ip: req.ip, action: 'channels.connected', meta: { providers: ['google_business'], local: loc.title } }, c);
  });
  await redis.del([PENDING(b.n), `gtoken:${tid(req)}`]);
  res.json({ ok: true });
});

export const googleCallbackRouter = Router();
googleCallbackRouter.get('/callback', async (req, res) => {
  const back = (q: string) => res.redirect(`/#conexoes?${q}`);
  let st: State;
  try { st = jwt.verify(String(req.query.state ?? ''), process.env.JWT_SECRET!, { algorithms: ['HS256'] }) as State; }
  catch { return back('erro=' + encodeURIComponent('A conexão expirou. Tente de novo.')); }
  if (st.purpose !== 'google_oauth') return back('erro=estado');
  if (req.query.error) return back('erro=' + encodeURIComponent('Conexão com o Google cancelada'));
  if (await redis.get(`google:used:${st.n}`)) return back('erro=' + encodeURIComponent('Este link de conexão já foi usado'));
  await redis.set(`google:used:${st.n}`, '1', { EX: 900 });
  try {
    const t = await tokenRequest({ grant_type: 'authorization_code', code: String(req.query.code ?? ''), redirect_uri: redirectUri() });
    if (!t.refresh_token) throw new Error('O Google não liberou acesso contínuo. Remova o acesso do app na sua Conta Google e conecte de novo.');
    const accounts = (await gfetch(api('mybusinessaccountmanagement.googleapis.com', '/v1/accounts'), t.access_token)).accounts ?? [];
    const locations: Pending['locations'] = [];
    for (const a of accounts.slice(0, 20)) {
      const ls = (await gfetch(api('mybusinessbusinessinformation.googleapis.com',
        `/v1/${a.name}/locations?readMask=name,title,storefrontAddress&pageSize=100`), t.access_token)).locations ?? [];
      for (const l of ls) locations.push({ id: `${a.name}/${l.name}`, title: l.title,
        address: [l.storefrontAddress?.addressLines?.join(', '), l.storefrontAddress?.locality].filter(Boolean).join(' — ') });
    }
    if (!locations.length) return back('erro=' + encodeURIComponent('Nenhum perfil de empresa encontrado nesta Conta Google'));
    await redis.set(PENDING(st.n), JSON.stringify({ tid: st.tid, sub: st.sub, refresh: encryptToken(t.refresh_token).toString('base64'), locations } satisfies Pending), { EX: 900 });
    await audit({ actorId: st.sub, tenantId: st.tid, ip: req.ip, action: 'channels.oauth_ok', meta: { provider: 'google', locations: locations.length } });
    back(`google=${st.n}`);
  } catch (e) {
    await audit({ actorId: st.sub, tenantId: st.tid, ip: req.ip, action: 'channels.oauth_failed', meta: { provider: 'google', error: (e as Error).message } });
    back('erro=' + encodeURIComponent((e as Error).message));
  }
});
