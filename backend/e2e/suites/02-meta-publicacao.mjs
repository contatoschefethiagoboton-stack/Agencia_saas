import { totpAt } from '../../dist/auth/totp.js';
import pg from 'pg';
const B = 'http://localhost:3997';
const code = s => totpAt(s, Math.floor(Date.now() / 30000));
function client() {
  let cookie = '';
  return async (path, body, method) => {
    const r = await fetch(B + '/api' + path, { method: method ?? (body ? 'POST' : 'GET'),
      headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { s: r.status, j: await r.json().catch(() => ({})) };
  };
}
const ok = (c, l, x) => { console.log(c ? 'OK  ' : 'FAIL', l, c ? '' : JSON.stringify(x)?.slice(0, 400)); if (!c) process.exitCode = 1; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const adm = client();
let r = await adm('/auth/login', { email: 'dono@agencia.com', password: 'SenhaForte123' });
r = await adm('/auth/login/verify', { ticket: r.j.ticket, code: code(r.j.secret) });
r = await adm('/admin/tenants', { name: 'Padaria Bom Grão', niche: 'padaria', plan: 'pro', ownerName: 'Maria', ownerEmail: 'maria@bomgrao.com' });
const tid = r.j.id, temp = r.j.tempPassword;
const cli = client();
r = await cli('/auth/login', { email: 'maria@bomgrao.com', password: temp });
r = await cli('/auth/login/verify', { ticket: r.j.ticket, code: code(r.j.secret) });
await cli('/auth/password', { current: temp, next: 'MinhaSenhaNova!1' });

// --- OAuth ---
r = await cli('/client/connect/meta/start', {});
ok(r.s === 200 && r.j.url.startsWith('https://www.facebook.com/'), 'start devolve URL oficial da Meta', r.j);
const u = new URL(r.j.url);
ok(u.searchParams.get('redirect_uri') === 'http://localhost:3997/oauth/meta/callback' && u.searchParams.get('scope').includes('instagram_content_publish'), 'redirect_uri e escopos');
const state = u.searchParams.get('state');
let cb = await fetch(`${B}/oauth/meta/callback?code=ok&state=${encodeURIComponent(state)}`, { redirect: 'manual' });
const loc = cb.headers.get('location');
ok(cb.status === 302 && /^\/#conexoes\?meta=[0-9a-f]{24}$/.test(loc), 'callback (sem cookie) redireciona para escolher a página', loc);
const n = loc.split('meta=')[1];
cb = await fetch(`${B}/oauth/meta/callback?code=ok&state=${encodeURIComponent(state)}`, { redirect: 'manual' });
ok(cb.headers.get('location').includes('erro='), 'mesmo state não pode ser reutilizado');
cb = await fetch(`${B}/oauth/meta/callback?code=ok&state=forjado`, { redirect: 'manual' });
ok(cb.headers.get('location').includes('erro='), 'state forjado é recusado');
r = await cli(`/client/connect/meta/pending/${n}`);
ok(r.j.pages?.length === 2 && r.j.pages[0].instagram === 'padariabomgrao' && !JSON.stringify(r.j).includes('PAGETOK'), 'lista páginas sem expor tokens', r.j);
const other = client(); // admin não é dono do tenant: não pode usar o nonce de outro tenant
r = await adm(`/client/connect/meta/pending/${n}`); ok(r.s === 403 || r.s === 404, 'outro usuário não acessa a conexão pendente', r);
r = await cli('/client/connect/meta/select', { n, pageId: 'PAGE1', adAccountId: 'act_777' });
ok(r.j.ok && r.j.conectados.length === 3, 'conecta Facebook + Instagram + Meta Ads', r.j);
r = await cli('/client/connections'); ok(r.j.map(c => c.provider).join() === 'facebook,instagram,meta_ads' && !JSON.stringify(r.j).includes('token'), 'conexões listadas sem token', r.j);

const db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
const asTenant = async (sql, args = []) => { await db.query('BEGIN'); await db.query("SELECT set_config('app.tenant_id', $1, true)", [tid]);
  const r = await db.query(sql, args); await db.query('COMMIT'); return r; };
ok((await db.query(`SELECT count(*)::int n FROM channel_connections`)).rows[0].n === 0, 'RLS: sem tenant na transação, nem o dono do banco vê conexões');
const enc = (await asTenant(`SELECT token_cipher FROM channel_connections WHERE provider = 'facebook'`)).rows[0].token_cipher;
ok(!enc.toString('latin1').includes('PAGETOK'), 'token gravado cifrado no banco');

// --- métricas reais ---
r = await cli('/client/metrics?days=30');
ok(r.j.instagram?.reach === 4800 && r.j.instagram.seguidores === 1234 && r.j.instagram.alcanceDiario.length === 30 && r.j.instagram.melhores[0].legenda === 'Bastidores da fornada', 'métricas do Instagram', r.j);
ok(r.j.anuncios?.gasto === 412.5 && r.j.anuncios.conversas === 41, 'métricas do Meta Ads', r.j.anuncios);

// --- publicação ---
const add = async (channel, kind, payload) => {
  await db.query('BEGIN'); await db.query("SELECT set_config('app.tenant_id', $1, true)", [tid]);
  const id = (await db.query(`INSERT INTO content_items (tenant_id, channel, kind, payload, status, scheduled_for)
     VALUES ($1,$2,$3,$4,'pending_approval', now() + interval '2 seconds') RETURNING id`, [tid, channel, kind, payload])).rows[0].id;
  await db.query('COMMIT'); return id;
};
const igOk = await add('instagram', 'post', { caption: 'Fornada das 15h', hashtags: ['#padaria'] });
const igNoImg = await add('instagram', 'post', { caption: 'Sem arte' });
const fb = await add('facebook', 'post', { caption: 'Hoje tem pão de queijo', hashtags: [] });
const reel = await add('tiktok', 'reel_script', { caption: 'roteiro', script: 'cena 1' });
r = await cli(`/approvals/${igOk}/media`, { images: ['http://inseguro.com/a.jpg'] }, 'PUT'); ok(r.s === 400, 'arte precisa ser https');
r = await cli(`/approvals/${igOk}/media`, { images: ['https://cdn.exemplo.com/arte.jpg'] }, 'PUT'); ok(r.s === 200, 'salva arte');
r = await cli('/approvals/approve-all', {}); ok(r.j.aprovados === 4, 'aprova tudo');
console.log('     aguardando o publicador (até 40s)…');
const st = async id => (await asTenant(`SELECT status, error, external_id, permalink FROM content_items WHERE id = $1`, [id])).rows[0];
for (let i = 0; i < 20 && (await st(fb)).status !== 'published'; i++) await sleep(2500);
let a = await st(igOk); ok(a.status === 'published' && a.external_id === 'IGPOST1' && a.permalink === 'https://instagram.com/p/abc', 'Instagram publicado', a);
a = await st(fb); ok(a.status === 'published' && a.external_id === 'PAGE1_999', 'Facebook publicado', a);
a = await st(igNoImg); ok(a.status === 'failed' && /exige imagem/.test(a.error), 'Instagram sem arte falha com explicação', a);
a = await st(reel); ok(a.status === 'approved', 'roteiro de vídeo não é publicado automaticamente', a);
const log = await (await fetch('http://localhost:4555/v1/__log')).json();
const pub = log.find(x => x.p === 'IG1/media' && x.m === 'POST' && x.b.image_url);
ok(pub?.tok === 'PAGETOK' && pub.b.caption === 'Fornada das 15h\n\n#padaria', 'usa o token da página do cliente e legenda + hashtags', pub);
r = await cli(`/approvals/${igNoImg}/retry`, {}); ok(r.s === 200 && (await st(igNoImg)).status === 'approved', 'tentar de novo reagenda');

// --- modo pânico bloqueia nova conexão ---
await adm('/admin/security/panic', { on: true, reason: 'teste de pânico' });
r = await cli('/client/connect/meta/start', {}); ok(r.s === 503, 'modo pânico bloqueia conexões', r);
await adm('/admin/security/panic', { on: false });

// --- correção do WhatsApp: funções enxergam o número mesmo como dono das tabelas (como no Render) ---
await db.query('BEGIN'); await db.query("SELECT set_config('app.tenant_id', $1, true)", [tid]);
await db.query(`INSERT INTO wa_numbers (tenant_id, provider, phone_e164, phone_number_id, status) VALUES ($1,'meta_cloud','+5519990000000','PNID1','active')`, [tid]);
await db.query('COMMIT');
r = await db.query(`SELECT * FROM wa_resolve_number('PNID1', NULL)`);
ok(r.rows[0]?.tenant_id === tid, 'webhook do WhatsApp acha o número (antes voltava vazio)', r.rows);
r = await db.query(`SELECT current_setting('app.bypass_rls', true) AS v`);
ok(!r.rows[0].v || r.rows[0].v === '', 'bypass não vaza depois da função', r.rows);
await db.query('BEGIN'); await db.query("SELECT set_config('app.tenant_id', $1, true)", [tid]);
await db.query(`SELECT * FROM wa_resolve_number('PNID1', NULL)`);
r = await db.query(`SELECT current_setting('app.bypass_rls', true) AS v, (SELECT count(*) FROM content_items WHERE tenant_id <> $1)::int AS outros`, [tid]);
await db.query('COMMIT');
ok(r.rows[0].v === '' && r.rows[0].outros === 0, 'dentro de uma transação, bypass é desligado no fim da função', r.rows);

// desconectar
r = await cli('/client/connections/instagram', undefined, 'DELETE'); ok(r.s === 200, 'desconecta Instagram');
r = await cli('/client/metrics?days=7'); ok(r.j.instagram === null && r.j.anuncios, 'sem Instagram, métricas mostram só anúncios', r.j);
await db.end();
process.exit();
