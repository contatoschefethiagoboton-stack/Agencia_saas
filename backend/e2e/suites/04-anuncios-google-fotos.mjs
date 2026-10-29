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
await adm('/auth/login/verify', { ticket: r.j.ticket, code: code(r.j.secret) });
const mk = async (name, email) => { const t = (await adm('/admin/tenants', { name, niche: 'padaria', plan: 'starter', ownerName: 'Responsável', ownerEmail: email })).j;
  const c = client(); let x = await c('/auth/login', { email, password: t.tempPassword });
  await c('/auth/login/verify', { ticket: x.j.ticket, code: code(x.j.secret) }); await c('/auth/password', { current: t.tempPassword, next: 'MinhaSenhaNova!1' });
  return [t.id, c]; };
const [tid, cli] = await mk('Padaria Bom Grão', 'maria@bomgrao.com');
const [, outro] = await mk('Outra Loja', 'outro@loja.com');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
const asT = async (sql, a = []) => { await db.query('BEGIN'); await db.query("SELECT set_config('app.tenant_id', $1, true)", [tid]); const x = await db.query(sql, a); await db.query('COMMIT'); return x; };

r = await cli('/client/features'); ok(r.j.meta && r.j.google && r.j.fotosIA, 'features ligadas', r.j);

// ================= FOTOS POR IA =================
r = await cli('/client/media/ai', { prompt: 'Pães artesanais em cesto de vime sobre balcão de madeira' });
ok(r.s === 201, 'cria foto por IA', r.j); const aiPhoto = r.j.id;
const ph = (await asT(`SELECT mime, width, height, source, length(bytes) AS n FROM media WHERE id = $1`, [aiPhoto])).rows[0];
ok(ph.mime === 'image/jpeg' && ph.width === 1024 && ph.height === 1536 && ph.source === 'ai' && ph.n < 600_000, 'foto de IA guardada em JPG leve na biblioteca', ph);
const gen = (await log()).find(x => x.p === 'images/generations');
ok(gen.tok === 'img-key' && /Sem nenhum texto/.test(gen.b.prompt) && /padaria/.test(gen.b.prompt), 'pedido leva regras de segurança e contexto do negócio', gen?.b?.prompt);
r = await cli('/client/media/ai', { prompt: 'algo proibido pelo filtro' }); ok(r.s === 502 && /filtro de segurança/.test(r.j.error), 'recusa do filtro vira mensagem clara', r.j);
const usage = (await asT(`SELECT cost_cents::int FROM api_usage WHERE provider = 'images'`)).rows[0];
ok(usage.cost_cents === 40, 'uso de imagens contado no teto (falha devolve a reserva)', usage);
await asT(`UPDATE api_usage SET quota_cents = 60 WHERE provider = 'images'`);
r = await cli('/client/media/ai', { prompt: 'Café coado em xícara branca' }); ok(r.s === 429, 'teto mensal de IA bloqueia antes de gastar', r.j);
await asT(`UPDATE api_usage SET quota_cents = 5000 WHERE provider = 'images'`);
const post = (await asT(`INSERT INTO content_items (tenant_id, channel, kind, payload, scheduled_for) VALUES ($1,'instagram','post',$2, now() + interval '1 hour') RETURNING id`,
  [tid, { caption: 'Croissant saindo', imagePrompt: 'Croissants dourados em bandeja', template: 'dica' }])).rows[0].id;
r = await cli(`/approvals/${post}/photo-ai`, {}); ok(r.s === 200 && r.j.template === 'destaque' && r.j.images.length === 1, 'foto por IA no post: troca para modelo com foto e refaz a arte', r.j);
ok(((await log()).filter(x => x.p === 'images/generations').pop().b.prompt).startsWith('Croissants dourados'), 'usa a sugestão de imagem da própria IA');

// ================= GOOGLE MEU NEGÓCIO =================
r = await cli('/client/connect/google/start', {}); const gu = new URL(r.j.url);
ok(gu.searchParams.get('access_type') === 'offline' && gu.searchParams.get('scope').includes('business.manage') &&
   gu.searchParams.get('redirect_uri') === 'http://localhost:3997/oauth/google/callback', 'URL de login do Google com acesso offline', r.j.url);
const gstate = gu.searchParams.get('state');
let cb = await fetch(`${B}/oauth/google/callback?code=abc&state=${encodeURIComponent(gstate)}`, { redirect: 'manual' });
const gloc = cb.headers.get('location'); ok(/^\/#conexoes\?google=[0-9a-f]{24}$/.test(gloc), 'callback do Google redireciona para escolher o local', gloc);
cb = await fetch(`${B}/oauth/google/callback?code=abc&state=${encodeURIComponent(gstate)}`, { redirect: 'manual' });
ok(cb.headers.get('location').includes('erro='), 'state do Google não pode ser reutilizado');
const gn = gloc.split('google=')[1];
r = await outro(`/client/connect/google/pending/${gn}`); ok(r.s === 404, 'outro cliente não vê a conexão pendente');
r = await cli(`/client/connect/google/pending/${gn}`); ok(r.j.locations?.[0]?.id === 'accounts/111/locations/222' && !JSON.stringify(r.j).includes('GREFRESH'), 'lista locais sem expor token', r.j);
r = await cli('/client/connect/google/select', { n: gn, locationId: 'accounts/111/locations/222' }); ok(r.j.ok, 'conecta Google Meu Negócio', r.j);
const gc = (await asT(`SELECT token_cipher FROM channel_connections WHERE provider = 'google_business'`)).rows[0];
ok(gc && !gc.token_cipher.toString('latin1').includes('GREFRESH'), 'refresh token guardado cifrado');
await asT(`UPDATE business_dossier SET data = data || '{"telefone":"+5519999999999"}' WHERE tenant_id = $1`, [tid]);
const gbp = (await asT(`INSERT INTO content_items (tenant_id, channel, kind, payload, scheduled_for) VALUES ($1,'google_business','gbp_post',$2, now() + interval '2 seconds') RETURNING id`,
  [tid, { caption: 'Pão de queijo quentinho às 15h todos os dias. #padaria', headline: 'Pão de queijo às 15h' }])).rows[0].id;
r = await cli('/client/content/arts', {}); ok(r.j.geradas >= 1, 'gera arte para o post do Google', r.j);
const gimg = (await asT(`SELECT payload FROM content_items WHERE id = $1`, [gbp])).rows[0].payload.images[0];
const ginfo = imageInfo(Buffer.from(await (await fetch(gimg)).arrayBuffer())); ok(ginfo.width === 1080 && ginfo.height === 1080, 'arte do Google é quadrada 1080x1080', ginfo);
await cli(`/approvals/${gbp}`, { decision: 'approve' });
console.log('     aguardando o publicador…');
for (let i = 0; i < 20 && (await asT(`SELECT status FROM content_items WHERE id = $1`, [gbp])).rows[0].status !== 'published'; i++) await sleep(2500);
const gst = (await asT(`SELECT status, external_id, permalink, error FROM content_items WHERE id = $1`, [gbp])).rows[0];
ok(gst.status === 'published' && gst.external_id.endsWith('/localPosts/9') && gst.permalink === 'https://g.co/kgs/x', 'post publicado no Google', gst);
const gpost = (await log()).find(x => x.p.includes('localPosts'));
ok(gpost.b.media?.[0]?.sourceUrl === gimg && !gpost.b.summary.includes('#padaria') && gpost.b.callToAction?.actionType === 'CALL' && gpost.b.languageCode === 'pt-BR',
   'post do Google com a arte, sem hashtag e botão Ligar', gpost.b);
ok((await log()).some(x => x.p.startsWith('/oauth2') || x.b?.grant_type === 'refresh_token'), 'token de acesso renovado pelo refresh token');

// ================= META ADS =================
r = await cli('/client/connect/meta/start', {}); const st = new URL(r.j.url).searchParams.get('state');
const ml = (await fetch(`${B}/oauth/meta/callback?code=ok&state=${encodeURIComponent(st)}`, { redirect: 'manual' })).headers.get('location');
await cli('/client/connect/meta/select', { n: ml.split('meta=')[1], pageId: 'PAGE1', adAccountId: 'act_777' });
r = await cli('/client/ads'); ok(r.j.conectado === true && r.j.campanhas.length === 0, 'tela de anúncios: conta conectada', r.j);
const art = (await asT(`SELECT id FROM media WHERE kind = 'art' LIMIT 1`)).rows[0].id;
const draft = { name: 'Clientes no Cambuí', objective: 'trafego', monthlyBudgetCents: 30000, radiusKm: 3, lat: -22.8955, lng: -47.0606,
  link: 'https://wa.me/5519999999999', headline: 'Pão quentinho às 7h', message: 'Peça pelo WhatsApp e retire sem fila.', mediaId: art };
r = await cli('/client/ads/projection', draft); ok(r.j.fonte === 'meta' && r.j.publicoMax === 15000 && r.j.cliquesMax > r.j.cliquesMin, 'projeção com público medido pela Meta', r.j);
r = await cli('/client/ads', { ...draft, monthlyBudgetCents: 5000 }); ok(r.s === 400, 'verba abaixo do mínimo recusada');
r = await cli('/client/ads', { ...draft, lat: 40.7, lng: -74 }); ok(r.s === 400, 'localização fora do Brasil recusada');
const outroArt = (await outro('/client/media?kind=art')).j;
r = await outro('/client/ads', { ...draft }); ok(r.s === 400, 'outro cliente não usa a arte da padaria (RLS)', r.j);
r = await cli('/client/ads', draft); ok(r.s === 201 && r.j.status === 'pending_approval', 'campanha montada na Meta, PAUSADA, esperando aprovação', r.j); const cid = r.j.id;
const L = await log();
const camp = L.find(x => x.p === 'act_777/campaigns'), adset = L.find(x => x.p === 'act_777/adsets'), cr = L.find(x => x.p === 'act_777/adcreatives');
ok(camp.b.status === 'PAUSED' && camp.b.objective === 'OUTCOME_TRAFFIC', 'campanha nasce PAUSADA', camp.b);
ok(adset.b.daily_budget === Math.floor(30000 / 30.4) && adset.b.targeting.geo_locations.custom_locations[0].radius === 3 && adset.b.targeting.targeting_automation.advantage_audience === 0,
   'conjunto no raio de 3 km com verba diária = mensal/30,4', adset.b);
ok(cr.b.object_story_spec.link_data.image_hash === 'HASH1' && cr.b.object_story_spec.link_data.call_to_action.type === 'CONTACT_US', 'criativo com a arte e botão de contato (WhatsApp)', cr.b);
r = await outro(`/client/ads/${cid}/approve`, {}); ok(r.s === 409 || r.s === 404, 'outro cliente não aprova a campanha', r);
r = await cli(`/client/ads/${cid}/approve`, {}); ok(r.j.ok, 'aprovar liga a campanha', r.j);
ok((await log()).some(x => x.p === 'CAMP1' && x.b.status === 'ACTIVE'), 'Meta recebeu ACTIVE na campanha');
// vigia de verba
await fetch(F + '/v1/__spend?v=120.50'); await sleep(4000);
let c1 = (await asT(`SELECT status, spend_cents_month::int FROM ad_campaigns WHERE id = $1`, [cid])).rows[0];
ok(c1.status === 'active' && c1.spend_cents_month === 12050, 'vigia atualiza o gasto do mês', c1);
await fetch(F + '/v1/__spend?v=301.00'); await sleep(4500);
c1 = (await asT(`SELECT status, error FROM ad_campaigns WHERE id = $1`, [cid])).rows[0];
ok(c1.status === 'paused' && /Verba do mês atingida/.test(c1.error), 'vigia PAUSA ao atingir a verba do mês', c1);
r = await cli(`/client/ads/${cid}/approve`, {}); ok(r.s === 409 && /verba do mês já foi usada/i.test(r.j.error), 'não reativa sem aumentar a verba', r.j);
r = await cli(`/client/ads/${cid}`, { monthlyBudgetCents: 50000 }, 'PATCH'); ok(r.j.ok && (await log()).some(x => x.p === 'ADSET1' && x.b.daily_budget === Math.floor(50000 / 30.4)), 'aumenta verba (atualiza o conjunto na Meta)');
r = await cli(`/client/ads/${cid}/approve`, {}); ok(r.j.ok, 'reativa com verba nova');
// kill switch pausa
await fetch(F + '/v1/__spend?v=10');
r = await adm(`/admin/tenants/${tid}/kill`, { reason: 'teste de bloqueio' }); ok(r.j.ok, 'kill switch');
c1 = (await asT(`SELECT status FROM ad_campaigns WHERE id = $1`, [cid])).rows[0]; ok(c1.status === 'paused', 'kill switch pausou a campanha', c1);
await adm(`/admin/tenants/${tid}/reactivate`, {});
r = await cli('/client/ads'); ok(r.s === 401, 'kill switch derrubou a sessão do cliente', r.s);
// entra de novo (2FA pelo segredo guardado)
const key = Buffer.from(process.env.TOKEN_ENC_KEY, 'base64');
const bb = (await db.query(`SELECT totp_secret_cipher FROM users WHERE email = 'maria@bomgrao.com'`)).rows[0].totp_secret_cipher;
const { createDecipheriv } = await import('node:crypto');
const dd = createDecipheriv('aes-256-gcm', key, bb.subarray(0, 12)); dd.setAuthTag(bb.subarray(12, 28));
const sec = Buffer.concat([dd.update(bb.subarray(28)), dd.final()]).toString();
let lg = await cli('/auth/login', { email: 'maria@bomgrao.com', password: 'MinhaSenhaNova!1' });
await sleep(31000 - (Date.now() % 30000));   // código novo (o anterior já foi usado nesta janela de 30s)
lg = await cli('/auth/login/verify', { ticket: lg.j.ticket, code: code(sec) }); ok(lg.j.ok, 'cliente entra de novo após reativação', lg.j);
r = await cli(`/client/ads/${cid}`, undefined, 'DELETE'); ok(r.j.ok, 'encerra campanha');
// modo pânico bloqueia criar e ativar
await adm('/admin/security/panic', { on: true, reason: 'teste de pânico' });
r = await cli('/client/ads', draft); ok(r.j.status === 'failed' && /pânico/i.test(r.j.error), 'modo pânico impede montar campanha', r.j);
r = await cli('/client/media/ai', { prompt: 'Pão francês na cesta' }); ok(r.s === 503, 'modo pânico impede foto por IA');
await adm('/admin/security/panic', { on: false });
r = await cli('/client/ads'); ok(r.j.campanhas.find(c => c.status === 'failed'), 'campanha com erro aparece com o motivo');
await db.end(); process.exit();
