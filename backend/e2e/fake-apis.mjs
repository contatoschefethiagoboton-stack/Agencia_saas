/*
 * Servidor FALSO das APIs externas (Meta Graph, Google Business Profile, TikTok e gerador de imagens)
 * para os testes de ponta a ponta. Responde como as APIs reais e registra tudo em /v1/__log.
 * Uso: node e2e/fake-apis.mjs  (porta 4555)
 */
import http from 'node:http';
import { Resvg } from '@resvg/resvg-js';
const fakePng = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1536"><rect width="1024" height="1536" fill="#C08040"/><circle cx="512" cy="700" r="300" fill="#F0D090"/></svg>').render().asPng();
let spend = '0';
const log = [];
const J = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    const u = new URL(req.url, 'http://x'); const p = u.pathname.replace(/^\/v[\d.]+\//, '');
    const tok = u.searchParams.get('access_token') ?? (req.headers.authorization ?? '').replace('Bearer ', '');
    let b = {}; try { b = body ? JSON.parse(body) : {}; } catch { b = Object.fromEntries(new URLSearchParams(body)); }
    log.push({ m: req.method, p, tok, b, q: Object.fromEntries(u.searchParams) });
    if (p === '__log') return J(res, 200, log);
    if (p === '__spend') { spend = u.searchParams.get('v'); return J(res, 200, { spend }); }
    // ---- Meta Ads ----
    if (p === 'act_777/adimages') return J(res, 200, b.bytes ? { images: { arte: { hash: 'HASH1' } } } : { error: { message: 'sem bytes' } });
    if (p === 'act_777/campaigns') return J(res, 200, { id: 'CAMP1' });
    if (p === 'act_777/adsets') return J(res, 200, b.targeting?.geo_locations ? { id: 'ADSET1' } : { error: { message: 'sem raio' } });
    if (p === 'act_777/adcreatives') return J(res, 200, b.object_story_spec?.page_id === 'PAGE1' ? { id: 'CR1' } : { error: { message: 'página errada' } });
    if (p === 'act_777/ads') return J(res, 200, { id: 'AD1' });
    if (p === 'CAMP1' || p === 'ADSET1') return J(res, 200, { success: true });
    if (p === 'CAMP1/insights') return J(res, 200, { data: [{ spend }] });
    if (p === 'act_777/delivery_estimate') return J(res, 200, { data: [{ estimate_mau_lower_bound: 12000, estimate_mau_upper_bound: 15000 }] });
    // ---- Google ----
    if (req.url.startsWith('/oauth2.googleapis.com/token')) return J(res, 200, b.grant_type === 'refresh_token'
      ? { access_token: 'GACCESS2', expires_in: 3599 } : { access_token: 'GACCESS', refresh_token: 'GREFRESH', expires_in: 3599 });
    if (req.url.startsWith('/mybusinessaccountmanagement.googleapis.com/v1/accounts')) return J(res, 200, { accounts: [{ name: 'accounts/111' }] });
    if (req.url.startsWith('/mybusinessbusinessinformation.googleapis.com/v1/accounts/111/locations')) return J(res, 200, { locations: [
      { name: 'locations/222', title: 'Padaria Bom Grão — Cambuí', storefrontAddress: { addressLines: ['Rua Coronel Quirino, 10'], locality: 'Campinas' } }] });
    if (req.url.startsWith('/mybusiness.googleapis.com/v4/accounts/111/locations/222/localPosts'))
      return tok === 'GACCESS' || tok === 'GACCESS2' ? J(res, 200, { name: 'accounts/111/locations/222/localPosts/9', searchUrl: 'https://g.co/kgs/x' }) : J(res, 401, { error: { message: 'token' } });
    // ---- TikTok ----
    const ok = data => J(res, 200, { data, error: { code: 'ok', message: '' } });
    if (req.url === '/v2/oauth/token/') return J(res, 200, { access_token: 'TTACCESS', refresh_token: 'TTREFRESH', expires_in: 86400,
                                                              refresh_expires_in: 31536000, open_id: 'OPEN1', scope: 'user.info.basic,video.publish' });
    if (req.url.startsWith('/v2/user/info/')) return ok({ user: { open_id: 'OPEN1', display_name: 'padariabomgrao' } });
    if (req.url === '/v2/post/publish/creator_info/query/') return ok({ privacy_level_options: ['SELF_ONLY'] });
    if (req.url === '/v2/post/publish/content/init/') return tok === 'TTACCESS' ? ok({ publish_id: 'PUB1' }) : J(res, 401, { error: { code: 'access_token_invalid' } });
    if (req.url === '/v2/post/publish/status/fetch/') {
      const n = log.filter(x => x.p === 'post/publish/status/fetch/').length;
      return ok(n < 2 ? { status: 'PROCESSING_DOWNLOAD' } : { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: ['7300000000000000001'] });
    }
    // ---- imagens ----
    if (p === 'images/generations' || req.url === '/v1/images/generations')
      return /proibido/.test(b.prompt) ? J(res, 400, { error: { message: 'Your request was rejected by the safety system' } }) : J(res, 200, { data: [{ b64_json: fakePng.toString('base64') }] });
    if (p === 'oauth/access_token') {
      if (u.searchParams.get('client_secret') !== 'segredo-app') return J(res, 400, { error: { message: 'bad secret' } });
      if (u.searchParams.get('code') === 'ruim') return J(res, 400, { error: { message: 'Código inválido' } });
      return J(res, 200, u.searchParams.get('grant_type') === 'fb_exchange_token' ? { access_token: 'LONG', expires_in: 5184000 } : { access_token: 'SHORT' });
    }
    if (p === 'me/accounts') return J(res, 200, { data: [
      { id: 'PAGE1', name: 'Padaria Bom Grão', access_token: 'PAGETOK', instagram_business_account: { id: 'IG1', username: 'padariabomgrao' } },
      { id: 'PAGE2', name: 'Página Pessoal', access_token: 'PAGETOK2' }] });
    if (p === 'me/adaccounts') return J(res, 200, { data: [{ id: 'act_777', name: 'Anúncios Padaria', currency: 'BRL', account_status: 1 }] });
    if (p === 'IG1/media' && req.method === 'POST')
      return /TOKEN_REVOGADO/.test(b.caption ?? '') ? J(res, 400, { error: { code: 190, message: 'Error validating access token: the user has changed the password' } })
        : J(res, 200, { id: 'CONT' + log.length });
    if (/^CONT\d+$/.test(p)) return J(res, 200, { status_code: 'FINISHED' });
    if (p === 'IG1/media_publish') return J(res, 200, { id: 'IGPOST1' });
    if (p === 'IGPOST1') return J(res, 200, { permalink: 'https://instagram.com/p/abc' });
    if (p === 'PAGE1/feed') return J(res, 200, { id: 'PAGE1_999' });
    if (p === 'PAGE1/photos') return J(res, 200, { id: 'PH1', post_id: 'PAGE1_888' });
    if (p === 'IG1') return J(res, 200, { followers_count: 1234, media_count: 50, username: 'padariabomgrao' });
    if (p === 'IG1/insights') return J(res, 200, u.searchParams.get('metric_type') === 'total_value'
      ? { data: [{ name: 'reach', total_value: { value: 4800 } }, { name: 'views', total_value: { value: 9100 } },
                 { name: 'accounts_engaged', total_value: { value: 310 } }, { name: 'total_interactions', total_value: { value: 720 } }] }
      : { data: [{ name: 'reach', values: Array.from({ length: 30 }, (_, i) => ({ value: 100 + i * 7, end_time: new Date(Date.now() - (29 - i) * 864e5).toISOString() })) }] });
    if (p === 'IG1/media' && req.method === 'GET') return J(res, 200, { data: [
      { id: 'a', caption: 'Pão de queijo saindo às 15h\nvem!', media_type: 'IMAGE', timestamp: new Date().toISOString(), like_count: 80, comments_count: 12, permalink: 'https://instagram.com/p/a' },
      { id: 'b', caption: 'Bastidores da fornada', media_type: 'VIDEO', timestamp: new Date().toISOString(), like_count: 140, comments_count: 3, permalink: 'https://instagram.com/p/b' }] });
    if (p === 'act_777/insights') return J(res, 200, { data: [{ spend: '412.50', reach: '15200', impressions: '30100', clicks: '502', cpc: '0.82',
      actions: [{ action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '41' }] }] });
    J(res, 404, { error: { message: 'rota falsa não existe: ' + p } });
  });
}).listen(4555, () => console.log('fake graph on 4555'));
