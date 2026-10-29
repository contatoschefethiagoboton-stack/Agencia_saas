import crypto from 'node:crypto';
import { Router, type Request } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { withTenant } from '../../db.js';
import { redis } from '../../redis.js';
import { audit } from '../../audit/audit.js';
import { encryptToken, decryptToken } from '../../security/vault.js';
import { assertNotPanicking } from '../../security/panic.js';
import { graphBase, graphGet, metaReady } from './graph.js';
import { publicUrl } from '../../config.js';

/*
 * CONEXÃO COM A META (Facebook Login para Empresas)
 * 1) /start devolve a URL oficial de login da Meta, com "state" assinado (tenant + usuário + nonce).
 * 2) A Meta redireciona para /oauth/meta/callback. O cookie de sessão é SameSite=Strict e não chega
 *    nesse redirecionamento, por isso a identidade vem do state assinado, nunca do navegador.
 * 3) Troca o code por token de longa duração, lista Páginas (+ Instagram profissional) e contas de anúncio,
 *    guarda tudo cifrado no Redis por 15 min e manda o usuário escolher qual página usar.
 * 4) /select grava as conexões cifradas (AES-256-GCM) em channel_connections.
 */
const SCOPES = () => process.env.META_OAUTH_SCOPES ?? [
  'pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'business_management',
  'instagram_basic', 'instagram_content_publish', 'instagram_manage_insights', 'read_insights',
  'ads_read', 'ads_management',
].join(',');
const redirectUri = () => `${publicUrl()}/oauth/meta/callback`;
type State = { tid: string; sub: string; n: string; purpose: 'meta_oauth' };

interface Pending {
  tid: string; sub: string; userToken: string; expiresAt: string | null;
  pages: { id: string; name: string; token: string; ig?: { id: string; username: string } }[];
  adAccounts: { id: string; name: string; currency: string; status: number }[];
}
const PENDING = (n: string) => `meta:pending:${n}`;

async function oauthToken(params: Record<string, string>) {
  const u = new URL(`${graphBase()}/oauth/access_token`);
  for (const [k, v] of Object.entries({ client_id: process.env.META_APP_ID!, client_secret: process.env.META_APP_SECRET!, ...params }))
    u.searchParams.set(k, v);
  const r = await fetch(u, { signal: AbortSignal.timeout(20_000) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(j?.error?.message ?? 'A Meta recusou a conexão');
  return j as { access_token: string; expires_in?: number };
}

async function listAll(path: string, token: string, fields: string) {
  const out: any[] = [];
  let j = await graphGet(path, token, { fields, limit: '100' });
  for (let i = 0; i < 10; i++) {
    out.push(...(j.data ?? []));
    if (!j.paging?.next) break;
    const r = await fetch(j.paging.next, { signal: AbortSignal.timeout(20_000) });
    j = await r.json();
  }
  return out;
}

// ---------- rotas autenticadas (painel do cliente) ----------
export const metaConnectRouter = Router();
const tid = (req: Request) => req.user!.tid!;

metaConnectRouter.post('/start', async (req, res) => {
  if (req.user!.role !== 'owner') return res.status(403).json({ error: 'Só o responsável pela conta pode conectar redes' });
  if (!metaReady()) return res.status(503).json({ error: 'A integração com a Meta ainda não foi configurada pela agência (META_APP_ID/META_APP_SECRET)' });
  await assertNotPanicking();
  const state = jwt.sign({ tid: tid(req), sub: req.user!.sub, n: crypto.randomBytes(12).toString('hex'), purpose: 'meta_oauth' } satisfies State,
                         process.env.JWT_SECRET!, { expiresIn: '10m', algorithm: 'HS256' });
  const u = new URL(`https://www.facebook.com/${process.env.META_API_VERSION ?? 'v25.0'}/dialog/oauth`);
  u.search = new URLSearchParams({ client_id: process.env.META_APP_ID!, redirect_uri: redirectUri(), state,
                                   scope: SCOPES(), response_type: 'code' }).toString();
  if (process.env.META_LOGIN_CONFIG_ID) u.searchParams.set('config_id', process.env.META_LOGIN_CONFIG_ID);
  res.json({ url: u.toString() });
});

metaConnectRouter.get('/pending/:n', async (req, res) => {
  const raw = await redis.get(PENDING(z.string().regex(/^[0-9a-f]{24}$/).parse(req.params.n)));
  const p: Pending | null = raw ? JSON.parse(raw) : null;
  if (!p || p.tid !== tid(req)) return res.status(404).json({ error: 'Conexão expirada. Clique em conectar de novo.' });
  res.json({ pages: p.pages.map(({ id, name, ig }) => ({ id, name, instagram: ig?.username ?? null })), adAccounts: p.adAccounts });
});

metaConnectRouter.post('/select', async (req, res) => {
  const b = z.object({ n: z.string().regex(/^[0-9a-f]{24}$/), pageId: z.string().min(1), adAccountId: z.string().optional() }).parse(req.body);
  const raw = await redis.get(PENDING(b.n));
  const p: Pending | null = raw ? JSON.parse(raw) : null;
  if (!p || p.tid !== tid(req) || p.sub !== req.user!.sub) return res.status(404).json({ error: 'Conexão expirada. Clique em conectar de novo.' });
  const page = p.pages.find(x => x.id === b.pageId);
  if (!page) return res.status(400).json({ error: 'Página inválida' });
  const ad = b.adAccountId ? p.adAccounts.find(a => a.id === b.adAccountId) : undefined;
  if (b.adAccountId && !ad) return res.status(400).json({ error: 'Conta de anúncios inválida' });

  const saved = await withTenant(tid(req), async c => {
    const put = async (provider: string, externalId: string, name: string, token: string, meta: object, expiresAt: string | null = null) => {
      await c.query(`DELETE FROM channel_connections WHERE provider = $1`, [provider]);   // uma conta por rede
      await c.query(`INSERT INTO channel_connections (tenant_id, provider, external_id, name, token_cipher, expires_at, meta, connected_by)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                    [tid(req), provider, externalId, name, encryptToken(token), expiresAt, meta, req.user!.sub]);
      return provider;
    };
    const pageToken = decryptToken(Buffer.from(page.token, 'base64'));
    const out = [await put('facebook', page.id, page.name, pageToken, {})];
    if (page.ig) out.push(await put('instagram', page.ig.id, `@${page.ig.username}`, pageToken, { pageId: page.id }));
    else await c.query(`DELETE FROM channel_connections WHERE provider = 'instagram'`);
    if (ad) out.push(await put('meta_ads', ad.id.replace(/^act_/, ''), ad.name,
                               decryptToken(Buffer.from(p.userToken, 'base64')), { currency: ad.currency }, p.expiresAt));
    await audit({ actorId: req.user!.sub, tenantId: tid(req), ip: req.ip, action: 'channels.connected',
                  meta: { providers: out, page: page.name } }, c);
    return out;
  });
  await redis.del(PENDING(b.n));
  await redis.del([`metrics:${tid(req)}:7`, `metrics:${tid(req)}:30`]);
  res.json({ ok: true, conectados: saved, avisoInstagram: page.ig ? undefined :
    'Esta página não tem um Instagram profissional vinculado. No app do Instagram: Configurações → Conta → mudar para conta profissional e vincular à página.' });
});

// ---------- callback público (a Meta redireciona o navegador para cá) ----------
export const metaCallbackRouter = Router();

metaCallbackRouter.get('/callback', async (req, res) => {
  const back = (q: string) => res.redirect(`/#conexoes?${q}`);
  let st: State;
  try { st = jwt.verify(String(req.query.state ?? ''), process.env.JWT_SECRET!, { algorithms: ['HS256'] }) as State; }
  catch { return back('erro=' + encodeURIComponent('A conexão expirou. Tente de novo.')); }
  if (st.purpose !== 'meta_oauth') return back('erro=estado');
  if (req.query.error) return back('erro=' + encodeURIComponent(String(req.query.error_description ?? 'Conexão cancelada')));
  if (await redis.get(`meta:used:${st.n}`)) return back('erro=' + encodeURIComponent('Este link de conexão já foi usado'));
  await redis.set(`meta:used:${st.n}`, '1', { EX: 900 });

  try {
    const short = await oauthToken({ redirect_uri: redirectUri(), code: String(req.query.code ?? '') });
    const long = await oauthToken({ grant_type: 'fb_exchange_token', fb_exchange_token: short.access_token });
    const pages = await listAll('me/accounts', long.access_token, 'id,name,access_token,instagram_business_account{id,username}');
    const adAccounts = await listAll('me/adaccounts', long.access_token, 'id,name,currency,account_status').catch(() => []);
    if (!pages.length) return back('erro=' + encodeURIComponent('Nenhuma Página do Facebook encontrada. Crie uma página e vincule o Instagram profissional a ela.'));

    const pending: Pending = {
      tid: st.tid, sub: st.sub, userToken: encryptToken(long.access_token).toString('base64'),
      expiresAt: long.expires_in ? new Date(Date.now() + long.expires_in * 1000).toISOString() : null,
      pages: pages.map(p => ({ id: p.id, name: p.name, token: encryptToken(p.access_token).toString('base64'),
                               ig: p.instagram_business_account ? { id: p.instagram_business_account.id,
                                                                    username: p.instagram_business_account.username } : undefined })),
      adAccounts: adAccounts.map(a => ({ id: a.id, name: a.name, currency: a.currency, status: a.account_status })),
    };
    await redis.set(PENDING(st.n), JSON.stringify(pending), { EX: 900 });
    await audit({ actorId: st.sub, tenantId: st.tid, ip: req.ip, action: 'channels.oauth_ok', meta: { pages: pages.length } });
    back(`meta=${st.n}`);
  } catch (e) {
    await audit({ actorId: st.sub, tenantId: st.tid, ip: req.ip, action: 'channels.oauth_failed', meta: { error: (e as Error).message } });
    back('erro=' + encodeURIComponent((e as Error).message));
  }
});
