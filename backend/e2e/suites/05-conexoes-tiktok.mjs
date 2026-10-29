// Saúde das conexões (acesso revogado/vencendo) e publicação no TikTok.
import { totpAt } from '../../dist/auth/totp.js';
import { imageInfo } from '../../dist/art/render.js';
import pg from 'pg';
const B = 'http://localhost:3997', F = 'http://localhost:4555';
const code = s => totpAt(s, Math.floor(Date.now() / 30000));
function client() { let cookie = '';
  return async (path, body, method) => { const r = await fetch(B + '/api' + path, { method: method ?? (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { s: r.status, j: await r.json().catch(() => ({})) }; }; }
const ok = (c, l, x) => { console.log(c ? 'OK  ' : 'FAIL', l, c ? '' : JSON.stringify(x)?.slice(0, 400)); if (!c) process.exitCode = 1; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = async () => (await fetch(F + '/v1/__log')).json();

const adm = client();
let r = await adm('/auth/login', { email: 'dono@agencia.com', password: 'SenhaForte123' });
const admSecret = r.j.secret, admCode = code(admSecret);
ok((await adm('/auth/login/verify', { ticket: r.j.ticket, code: admCode })).j.ok, 'admin entra com o código do autenticador');
const t = (await adm('/admin/tenants', { name: 'Padaria Bom Grão', niche: 'padaria', plan: 'pro', ownerName: 'Maria', ownerEmail: 'maria@bomgrao.com' })).j;
const cli = client();
r = await cli('/auth/login', { email: 'maria@bomgrao.com', password: t.tempPassword });
await cli('/auth/login/verify', { ticket: r.j.ticket, code: code(r.j.secret) });
await cli('/auth/password', { current: t.tempPassword, next: 'MinhaSenhaNova!1' });
const tid = t.id;
// o MESMO código do autenticador não entra duas vezes (ex.: capturado por phishing e reusado)
{ const c2 = client(); const x = await c2('/auth/login', { email: 'dono@agencia.com', password: 'SenhaForte123' });
  const again = await c2('/auth/login/verify', { ticket: x.j.ticket, code: admCode });
  ok(again.s === 401, 'código do autenticador já usado é recusado (anti-reuso)', again); }
const db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
const asT = async (sql, a = []) => { await db.query('BEGIN'); await db.query("SELECT set_config('app.tenant_id', $1, true)", [tid]); const x = await db.query(sql, a); await db.query('COMMIT'); return x; };
const add = async (channel, kind, payload) => (await asT(`INSERT INTO content_items (tenant_id, channel, kind, payload, scheduled_for)
  VALUES ($1,$2,$3,$4, now() + interval '2 seconds') RETURNING id`, [tid, channel, kind, payload])).rows[0].id;
const st = async id => (await asT(`SELECT status, error, external_id FROM content_items WHERE id = $1`, [id])).rows[0];
const waitDone = async ids => { for (let i = 0; i < 30; i++) { const s = await Promise.all(ids.map(st)); if (s.every(x => ['published', 'failed'].includes(x.status))) return; await sleep(1000); } };

// ================= TikTok =================
r = await fetch(`${B}/tiktok-verificacao.txt`); ok(r.status === 200 && (await r.text()) === 'tiktok-developers-site-verification=ABC123', 'arquivo de verificação de domínio do TikTok');
r = await cli('/client/connect/tiktok/start', {}); const tu = new URL(r.j.url);
ok(tu.searchParams.get('scope') === 'user.info.basic,video.publish' && tu.searchParams.get('redirect_uri') === `${B}/oauth/tiktok/callback`, 'URL de login do TikTok', r.j);
const tstate = tu.searchParams.get('state');
let cb = await fetch(`${B}/oauth/tiktok/callback?code=abc&state=${encodeURIComponent(tstate)}`, { redirect: 'manual' });
ok(cb.headers.get('location') === '/#conexoes?tiktok=ok', 'callback do TikTok conecta', cb.headers.get('location'));
cb = await fetch(`${B}/oauth/tiktok/callback?code=abc&state=${encodeURIComponent(tstate)}`, { redirect: 'manual' });
ok(cb.headers.get('location').includes('erro='), 'state do TikTok não pode ser reutilizado');
r = await cli('/client/connections'); const tk = r.j.find(c => c.provider === 'tiktok');
ok(tk?.name === '@padariabomgrao' && Date.parse(tk.expires_at) > Date.now() + 300 * 864e5 && !JSON.stringify(r.j).includes('TTREFRESH'), 'conexão TikTok guardada (sem expor token)', tk);
const car = await add('tiktok', 'carousel', { caption: 'Dicas da padaria #padaria', headline: '3 jeitos de usar pão de ontem', hashtags: ['#padaria'],
                                              slides: ['Torrada de alho', 'Pudim de pão', 'Farinha de rosca'] });
const reel = await add('tiktok', 'reel_script', { caption: 'roteiro', script: 'cena 1' });
r = await cli('/client/content/arts', {}); ok(r.j.geradas === 1, 'arte do carrossel do TikTok gerada (roteiro não)', r.j);
await cli('/approvals/approve-all', {});
await waitDone([car]);
let s1 = await st(car); ok(s1.status === 'published' && s1.external_id === '7300000000000000001', 'carrossel publicado no TikTok', s1);
ok((await st(reel)).status === 'approved', 'roteiro de vídeo não é publicado automaticamente');
const init = (await log()).find(x => x.p === 'post/publish/content/init/');
ok(init.b.media_type === 'PHOTO' && init.b.post_mode === 'DIRECT_POST' && init.b.post_info.privacy_level === 'SELF_ONLY' &&
   init.b.source_info.photo_images.length === 4 && init.b.source_info.photo_images.every(u => u.startsWith(`${B}/media/`)) &&
   !init.b.post_info.title.includes('#') && init.b.post_info.auto_add_music === true,
   'TikTok recebeu 4 fotos das artes, "Somente eu" antes da auditoria, música automática', init.b);
const img = Buffer.from(await (await fetch(init.b.source_info.photo_images[0])).arrayBuffer());
ok(imageInfo(img)?.mime === 'image/jpeg', 'fotos do TikTok são JPG públicos');

// ================= Saúde das conexões =================
r = await cli('/client/connect/meta/start', {}); const ms = new URL(r.j.url).searchParams.get('state');
let ml = (await fetch(`${B}/oauth/meta/callback?code=ok&state=${encodeURIComponent(ms)}`, { redirect: 'manual' })).headers.get('location');
await cli('/client/connect/meta/select', { n: ml.split('meta=')[1], pageId: 'PAGE1', adAccountId: 'act_777' });
r = await cli('/client/summary'); ok(r.j.alertas.length === 0, 'sem alertas com tudo em dia', r.j.alertas);
const bad = await add('instagram', 'post', { caption: 'TOKEN_REVOGADO teste', images: ['https://cdn.exemplo.com/a.jpg'] });
await cli('/approvals/approve-all', {}); await waitDone([bad]);
s1 = await st(bad); ok(s1.status === 'failed' && /access token/i.test(s1.error), 'Meta recusou o token: post falha com o motivo', s1);
r = await cli('/client/summary'); const al = r.j.alertas.find(a => a.provider === 'instagram');
ok(al?.needs_reconnect === true, 'painel avisa: reconectar Instagram', r.j.alertas);
r = await cli('/client/connections'); ok(r.j.find(c => c.provider === 'instagram').needs_reconnect, 'Conexões marca o Instagram para reconectar');
const before = (await log()).filter(x => x.p === 'IG1/media').length;
const next = await add('instagram', 'post', { caption: 'Post seguinte', images: ['https://cdn.exemplo.com/b.jpg'] });
await cli('/approvals/approve-all', {}); await waitDone([next]);
s1 = await st(next); ok(s1.status === 'failed' && /Reconecte/.test(s1.error), 'próximos posts param com aviso, sem insistir na Meta', s1);
ok((await log()).filter(x => x.p === 'IG1/media').length === before, 'nenhuma chamada nova à Meta com token revogado');
r = await adm('/admin/tenants'); ok(r.j.find(x => x.id === tid).conexoes_atencao >= 1, 'Painel Master mostra o cliente com conexão para reconectar');
r = await cli('/client/connect/meta/start', {}); const ms2 = new URL(r.j.url).searchParams.get('state');
ml = (await fetch(`${B}/oauth/meta/callback?code=ok&state=${encodeURIComponent(ms2)}`, { redirect: 'manual' })).headers.get('location');
await cli('/client/connect/meta/select', { n: ml.split('meta=')[1], pageId: 'PAGE1', adAccountId: 'act_777' });
r = await cli('/client/summary'); ok(!r.j.alertas.some(a => a.provider === 'instagram'), 'reconectar limpa o aviso', r.j.alertas);
await asT(`UPDATE channel_connections SET expires_at = now() + interval '5 days' WHERE provider = 'meta_ads'`);
r = await cli('/client/summary'); const ex = r.j.alertas.find(a => a.provider === 'meta_ads');
ok(ex?.expiring === true && !ex.needs_reconnect, 'aviso de acesso aos anúncios vencendo em 5 dias', r.j.alertas);
await db.end(); process.exit();
