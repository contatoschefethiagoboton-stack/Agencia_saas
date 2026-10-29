import { totpAt } from '../../dist/auth/totp.js';
import { renderArt, imageInfo } from '../../dist/art/render.js';
import { Resvg } from '@resvg/resvg-js';
import pg from 'pg';
const B = 'http://localhost:3997';
const code = s => totpAt(s, Math.floor(Date.now() / 30000));
function client() { let cookie = '';
  return async (path, body, method) => { const r = await fetch(B + '/api' + path, { method: method ?? (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') ?? '';
    return { s: r.status, ct, j: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) }; }; }
const ok = (c, l, x) => { console.log(c ? 'OK  ' : 'FAIL', l, c ? '' : JSON.stringify(x)?.slice(0, 300)); if (!c) process.exitCode = 1; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const adm = client();
let r = await adm('/auth/login', { email: 'dono@agencia.com', password: 'SenhaForte123' });
await adm('/auth/login/verify', { ticket: r.j.ticket, code: code(r.j.secret) });
const mk = async (name, email) => { const t = (await adm('/admin/tenants', { name, niche: 'padaria', plan: 'pro', ownerName: 'Responsável', ownerEmail: email })).j;
  const c = client(); let x = await c('/auth/login', { email, password: t.tempPassword });
  await c('/auth/login/verify', { ticket: x.j.ticket, code: code(x.j.secret) }); await c('/auth/password', { current: t.tempPassword, next: 'MinhaSenhaNova!1' });
  return [t.id, c]; };
const [tid, cli] = await mk('Padaria Bom Grão', 'maria@bomgrao.com');
const [, outro] = await mk('Outra Loja', 'outro@loja.com');

// uploads
const photoJpg = renderArt({ template: 'destaque', format: 'feed', brand: { name: '', primary: '#8B5A2B', secondary: '#E8C07D' }, headline: ' ' }).jpg;
const logoPng = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><circle cx="150" cy="150" r="140" fill="#F2B33D"/></svg>').render().asPng();
r = await cli('/client/media', { kind: 'photo', dataBase64: Buffer.from('não sou imagem').toString('base64') }); ok(r.s === 400, 'recusa arquivo que não é imagem');
r = await cli('/client/media', { kind: 'photo', dataBase64: photoJpg.toString('base64') }); ok(r.s === 201, 'envia foto JPG', r.j); const photoId = r.j.id;
r = await cli('/client/media', { kind: 'logo', dataBase64: Buffer.from(logoPng).toString('base64') }); ok(r.s === 201, 'envia logo PNG', r.j);
r = await cli('/client/brand', { primaria: '#7A3E12', secundaria: '#F2B33D' }, 'PUT'); ok(r.s === 200, 'salva cores');
r = await cli('/client/brand', { primaria: 'red', secundaria: '#F2B33D' }, 'PUT'); ok(r.s === 400, 'cor inválida recusada');
r = await cli('/client/art/preview?template=oferta'); ok(r.s === 200 && r.ct === 'image/jpeg' && imageInfo(r.j)?.width === 1080, 'exemplo do modelo com a identidade', r.ct);
r = await outro(`/client/media/${photoId}/raw`); ok(r.s === 404, 'outro cliente não acessa a foto (RLS)');
r = await fetch(`${B}/media/${photoId}.jpg`); ok(r.status === 404, 'foto enviada NÃO é pública');

// conteúdos
const db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
const asT = async (sql, a = []) => { await db.query('BEGIN'); await db.query("SELECT set_config('app.tenant_id', $1, true)", [tid]); const x = await db.query(sql, a); await db.query('COMMIT'); return x; };
const add = async (channel, kind, payload) => (await asT(`INSERT INTO content_items (tenant_id, channel, kind, payload, scheduled_for)
  VALUES ($1,$2,$3,$4, now() + interval '3 seconds') RETURNING id`, [tid, channel, kind, payload])).rows[0].id;
const igPost = await add('instagram', 'post', { caption: '🥐 Croissant de manteiga saindo do forno! Venha provar hoje. #padaria', template: 'oferta-do-dia', cta: 'Peça no WhatsApp 📲' });
const igCar = await add('instagram', 'carousel', { caption: 'Dicas', headline: '3 jeitos de usar pão de ontem', slides: ['Torrada de alho', 'Pudim de pão', 'Farinha de rosca caseira'] });
const igStory = await add('instagram', 'story', { caption: 'Hoje tem broa quentinha', template: 'destaque' });
const fbPost = await add('facebook', 'post', { caption: 'Funcionamos no feriado das 7h às 13h.', template: 'dica' });
const reel = await add('tiktok', 'reel_script', { caption: 'roteiro', script: 'cena' });
const month = (await asT(`SELECT to_char(scheduled_for AT TIME ZONE 'America/Sao_Paulo','YYYY-MM') m FROM content_items LIMIT 1`)).rows[0].m;
let t0 = Date.now();
r = await cli('/client/content/arts', { month }); ok(r.j.geradas === 4, `artes em lote: 4 conteúdos (${Date.now() - t0} ms)`, r.j);
r = await cli('/client/content/arts', { month }); ok(r.j.geradas === 0, 'lote não refaz o que já tem arte', r.j);
const item = async id => (await asT(`SELECT payload, status FROM content_items WHERE id = $1`, [id])).rows[0];
let p = (await item(igPost)).payload;
ok(p.images.length === 1 && p.art.template === 'oferta' && p.art.photoId === photoId && p.art.generated, 'post: modelo "oferta" escolhido pela dica da IA, com a foto', p.art);
r = await fetch(p.images[0]); const buf = Buffer.from(await r.arrayBuffer()); const info = imageInfo(buf);
ok(r.status === 200 && r.headers.get('content-type') === 'image/jpeg' && info.width === 1080 && info.height === 1350, 'arte pública em JPG 1080x1350 (sem login)', info);
p = (await item(igCar)).payload; ok(p.images.length === 4, 'carrossel: capa + 3 slides = 4 imagens', p.images?.length);
p = (await item(igStory)).payload; r = await fetch(p.images[0]); ok(imageInfo(Buffer.from(await r.arrayBuffer())).height === 1920, 'story em 1080x1920');
p = (await item(reel)).payload; ok(!p.images, 'roteiro de vídeo não ganha arte');

// trocar modelo e foto
const before = (await item(igPost)).payload.images[0];
r = await cli(`/approvals/${igPost}/art`, { template: 'bastidores' }); ok(r.j.template === 'bastidores', 'troca de modelo', r.j);
r = await fetch(before); ok(r.status === 404, 'arte antiga apagada ao refazer');
r = await cli(`/approvals/${igPost}/art`, { photoId: null }); p = (await item(igPost)).payload; ok(p.art.photoId === null, 'arte sem foto');
r = await outro(`/approvals/${igPost}/art`, {}); ok(r.s === 404, 'outro cliente não mexe na arte (RLS)', r);
// link próprio substitui a arte gerada
r = await cli(`/approvals/${fbPost}/media`, { images: ['https://cdn.exemplo.com/minha.jpg'] }, 'PUT');
p = (await item(fbPost)).payload; ok(p.images[0] === 'https://cdn.exemplo.com/minha.jpg' && !p.art, 'link próprio substitui a arte gerada');
r = await asT(`SELECT count(*)::int n FROM media WHERE kind = 'art'`); ok(r.rows[0].n === 1 + 4 + 1, 'sem arte órfã no banco', r.rows);

// conecta Meta e publica com a arte gerada
r = await cli('/client/connect/meta/start', {}); const state = new URL(r.j.url).searchParams.get('state');
const loc = (await fetch(`${B}/oauth/meta/callback?code=ok&state=${encodeURIComponent(state)}`, { redirect: 'manual' })).headers.get('location');
await cli('/client/connect/meta/select', { n: loc.split('meta=')[1], pageId: 'PAGE1' });
r = await cli('/approvals/approve-all', {}); ok(r.j.aprovados === 5, 'aprova tudo', r.j);
console.log('     aguardando o publicador…');
for (let i = 0; i < 20 && (await item(igCar)).status !== 'published'; i++) await sleep(2500);
for (const [id, n] of [[igPost, 'post'], [igCar, 'carrossel'], [igStory, 'story'], [fbPost, 'facebook']]) ok((await item(id)).status === 'published', `${n} publicado com a arte`, await item(id));
const log = await (await fetch('http://localhost:4555/v1/__log')).json();
const urls = log.filter(x => x.p === 'IG1/media' && x.m === 'POST' && x.b.image_url).map(x => x.b.image_url);
ok(urls.length === 1 + 4 + 1 && urls.every(u => u.startsWith('http://localhost:3997/media/')), 'Instagram recebeu os links das artes geradas', urls);
ok(log.some(x => x.b?.media_type === 'CAROUSEL' && x.b.children.split(',').length === 4), 'carrossel montado com 4 imagens');
await db.end(); process.exit();
