import { totpAt } from '../../dist/auth/totp.js';
import { strategySignal } from '../../dist/market/strategies.js';
const B = 'http://localhost:3997/api', F = 'http://localhost:4555';
const code = s => totpAt(s, Math.floor(Date.now() / 30000));
const sleep = ms => new Promise(r => setTimeout(r, ms));
function client() {
  let cookie = '';
  return async (path, body, method) => {
    const r = await fetch(B + path, { method: method ?? (body ? 'POST' : 'GET'),
      headers: { 'Content-Type': 'application/json', Cookie: cookie, 'User-Agent': 'e2e' }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { s: r.status, j: await r.json().catch(() => ({})) };
  };
}
const ok = (cond, label, extra) => { console.log(cond ? 'OK  ' : 'FAIL', label, cond ? '' : JSON.stringify(extra)?.slice(0, 600)); if (!cond) process.exitCode = 1; };
async function until(fn, ms = 15000) { for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(300)) { const v = await fn(); if (v) return v; } return null; }
const setSeries = (symbol, closes) => fetch(`${F}/binance/__series?symbol=${symbol}&closes=${closes.join(',')}`);

// série que gera UM cruzamento de médias (9 sobre 21) em um candle conhecido
const base = [...Array.from({ length: 60 }, (_, i) => 200 - i), ...Array.from({ length: 40 }, (_, i) => 141 + i * 3)];
const toCandles = cl => cl.map((c, i) => { const o = i ? cl[i - 1] : c; return { time: i * 3600, open: o, high: Math.max(o, c) * 1.002, low: Math.min(o, c) * 0.998, close: c, volume: 1000 + (i % 7) * 100 }; });
let crossLen = 0;
for (let n = 30; n < base.length; n++) if (strategySignal('ema_cross', toCandles(base.slice(0, n + 1))).action === 'buy') { crossLen = n + 1; break; }
ok(crossLen > 60, 'série de teste tem um cruzamento conhecido', crossLen);
const preCross = base.slice(0, crossLen - 1), atCross = base.slice(0, crossLen);
const crash = cl => [...cl, cl.at(-1) * 0.9];

// ---------------- admin e clientes
const adm = client();
let r = await adm('/auth/login', { area: 'admin', email: 'dono@agencia.com', password: 'SenhaForte123' });
r = await adm('/auth/login/verify', { ticket: r.j.ticket, code: code(r.j.secret) });
ok(r.s === 200, 'login admin com 2FA');
r = await adm('/admin/plans'); ok(r.j.length === 3 && r.j.find(p => p.id === 'pro').live_trading === true, 'planos com limites de robôs', r.j);
r = await adm('/admin/tenants', { name: 'Maria Investidora', plan: 'pro', ownerName: 'Maria', ownerEmail: 'maria@invest.com' });
ok(r.s === 201, 'admin cadastra cliente Pro', r.j); const tMaria = r.j.id, tempMaria = r.j.tempPassword;
r = await adm('/admin/tenants', { name: 'João Iniciante', plan: 'starter', ownerName: 'João', ownerEmail: 'joao@invest.com' });
const tempJoao = r.j.tempPassword;

async function loginCliente(email, temp) {
  const c = client();
  let x = await c('/auth/login', { email, password: temp });
  x = await c('/auth/login/verify', { ticket: x.j.ticket, code: code(x.j.secret) });
  await c('/auth/password', { current: temp, next: 'SenhaNova!12345' });
  return c;
}
const cli = await loginCliente('maria@invest.com', tempMaria);
const joao = await loginCliente('joao@invest.com', tempJoao);
r = await cli('/auth/me'); ok(r.j.tenant_name === 'Maria Investidora', 'cliente logado');
r = await adm('/market/overview'); ok(r.s === 403, 'administrador fora do painel de cliente não usa rotas de cliente');

// ---------------- mercado
r = await cli('/market/status'); ok(r.j.b3Full && r.j.telegram && !r.j.demo, 'status das fontes de dados', r.j);
r = await cli('/market/strategies'); ok(r.j.length === 5 && r.j.every(s => s.name && s.description), '5 estratégias com descrição', r.j);
r = await cli('/market/overview?market=crypto'); ok(r.j.some(q => q.symbol === 'BTCUSDT' && q.price > 0), 'mais negociados de cripto', r.j);
r = await cli('/market/chart?market=crypto&symbol=btc/usdt&interval=1h');
ok(r.s === 200 && r.j.symbol === 'BTCUSDT' && r.j.candles.length === 300 && r.j.ind.rsi.length === 300 && r.j.analysis?.signal, 'gráfico com indicadores e análise', r.j.analysis);
ok(['COMPRA', 'VENDA', 'AGUARDAR'].includes(r.j.analysis.signal) && r.j.analysis.reasons.length > 0, 'análise explica os motivos');
r = await cli('/market/chart?market=crypto&symbol=BTC;DROP&interval=1h'); ok(r.s === 400, 'código de ativo malicioso recusado');
r = await cli('/market/chart?market=crypto&symbol=NAOEXISTEUSDT&interval=1h'); ok(r.s === 404, 'ativo inexistente: 404 com mensagem', r.j);
r = await cli('/market/scanner?market=crypto&interval=1h'); ok(Array.isArray(r.j) && r.j.length >= 3 && r.j[0].score >= r.j.at(-1).score, 'scanner ordenado pelo placar', r.j.length);
r = await cli('/market/backtest', { market: 'crypto', symbol: 'BTCUSDT', interval: '1h', strategy: 'score', stopLossPct: 3 });
ok(r.s === 200 && typeof r.j.stats.totalReturnPct === 'number' && r.j.equity.length > 10, 'backtest', r.j.stats);
r = await cli('/market/chart?market=b3&symbol=PETR4&interval=1d'); ok(r.s === 200 && r.j.candles.length >= 200, 'gráfico da B3 (brapi)', r.j.error);
r = await cli('/market/fiis');
const mxrf = r.j.find?.(f => f.symbol === 'MXRF11');
ok(mxrf && Math.abs(mxrf.dy12m - 10.8) < 0.01 && mxrf.pvp === 1.02 && mxrf.nota > 0, 'FIIs: DY 12m, P/VP e nota', r.j);

// ---------------- lista e isolamento
r = await cli('/market/watchlist', { market: 'crypto', symbol: 'ethusdt' }); ok(r.s === 201 && r.j.symbol === 'ETHUSDT', 'acompanha ativo');
r = await cli('/market/watchlist'); ok(r.j.length === 1 && r.j[0].price > 0, 'lista com cotação', r.j);
r = await joao('/market/watchlist'); ok(r.j.length === 0, 'RLS: outro cliente não vê a lista');

// ---------------- corretora
r = await cli('/bots/connections', { broker: 'binance', label: 'Binance', key: 'KEYSAQUE1234567', secret: 'SECRETSAQUE1234567' });
ok(r.s === 400 && /SEM permissão de saque/.test(r.j.error), 'recusa chave com permissão de SAQUE', r.j);
r = await cli('/bots/connections', { broker: 'binance', label: 'Binance', key: 'KEYerrada12345', secret: 'outrosegredo12345' });
ok(r.s === 400 && /Binance/.test(r.j.error), 'recusa chave inválida antes de salvar', r.j);
r = await cli('/bots/connections', { broker: 'binance', label: 'Minha Binance', key: 'KEYmaria1234567', secret: 'SECRETmaria1234567' });
ok(r.s === 201 && r.j.balances.some(b => b.asset === 'USDT'), 'conecta Binance (testada, cifrada)', r.j); const connId = r.j.id;
r = await cli('/bots/connections'); ok(r.j[0].key_hint === '4567' && !JSON.stringify(r.j).includes('SECRETmaria'), 'segredo nunca volta para a tela', r.j);
r = await joao('/bots/connections'); ok(r.j.length === 0, 'RLS: corretora de um cliente invisível para outro');

// ---------------- robô simulado: entra no cruzamento e sai no stop
await setSeries('CROSSUSDT', preCross);
r = await cli('/bots', { name: 'Robô Cross', market: 'crypto', symbol: 'CROSSUSDT', interval: '1h', strategy: 'ema_cross', mode: 'paper', amount: 100, stopLossPct: 3 });
ok(r.s === 201, 'cria robô simulado', r.j); const paperId = r.j.id;
r = await cli(`/bots/${paperId}`, { status: 'active' }, 'PATCH'); ok(r.j.ok, 'liga o robô');
await sleep(2000);
ok(!(await cli('/bots')).j.find(b => b.id === paperId).open_trade, 'sem sinal: não compra');
await setSeries('CROSSUSDT', atCross);
let bot = await until(async () => (await cli('/bots')).j.find(b => b.id === paperId && b.open_trade));
ok(bot && Math.abs(bot.open_trade.entry_price - atCross.at(-1)) < 1e-6 && Math.abs(bot.open_trade.stop_price - atCross.at(-1) * 0.97) < 1e-6,
   'cruzamento: robô COMPRA no preço atual com stop de 3%', bot?.open_trade);
await sleep(1500);
r = await cli(`/bots/${paperId}/trades`); ok(r.j.length === 1, 'não entra duas vezes no mesmo sinal', r.j.length);
await setSeries('CROSSUSDT', crash(atCross));
bot = await until(async () => (await cli('/bots')).j.find(b => b.id === paperId && !b.open_trade && b.trades === 1));
r = await cli(`/bots/${paperId}/trades`);
ok(bot && r.j[0].exit_reason === 'stop' && r.j[0].pnl < 0 && Math.abs(r.j[0].pnl - (-10 - 0.1 - 0.09)) < 0.01, 'queda: robô VENDE no stop com prejuízo e taxas', r.j[0]);
r = await cli(`/bots/${paperId}`, undefined, 'DELETE'); ok(r.j.ok, 'apaga robô sem posição');

// ---------------- limites de plano
r = await joao('/bots', { name: 'Real', market: 'crypto', symbol: 'BTCUSDT', interval: '1h', strategy: 'score', mode: 'live', amount: 50 });
ok(r.s === 403 && /simulados/.test(r.j.error), 'plano Essencial não libera dinheiro real', r.j);
await joao('/bots', { name: 'Um', market: 'crypto', symbol: 'BTCUSDT', interval: '1h', strategy: 'score', amount: 50 });
r = await joao('/bots', { name: 'Dois', market: 'crypto', symbol: 'ETHUSDT', interval: '1h', strategy: 'score', amount: 50 });
ok(r.s === 403 && /1 robô/.test(r.j.error), 'limite de robôs do plano', r.j);
r = await cli('/bots', { name: 'B3 real', market: 'b3', symbol: 'PETR4', interval: '1d', strategy: 'score', mode: 'live', amount: 100, connectionId: connId });
ok(r.s === 400 && /B3/.test(r.j.error), 'B3 com dinheiro real recusado com explicação', r.j);

// ---------------- robô com dinheiro real (corretora falsa)
await setSeries('LIVEUSDT', preCross);
r = await cli('/bots', { name: 'Robô Real', market: 'crypto', symbol: 'LIVEUSDT', interval: '1h', strategy: 'ema_cross', mode: 'live', connectionId: connId, amount: 200, stopLossPct: 5 });
ok(r.s === 201, 'cria robô real (2FA recente do login)', r.j); const liveId = r.j.id;
await cli(`/bots/${liveId}`, { status: 'active' }, 'PATCH');
await setSeries('LIVEUSDT', atCross);
bot = await until(async () => (await cli('/bots')).j.find(b => b.id === liveId && b.open_trade));
ok(bot?.mode === 'live', 'robô real comprou', bot);
let flog = await (await fetch(`${F}/__log`)).json();
const buy = flog.find(l => l.p === '/binance/api/v3/order' && l.q.side === 'BUY' && l.q.symbol === 'LIVEUSDT');
ok(buy && buy.q.quoteOrderQty === '200.00' && buy.q.signature && buy.key === 'KEYmaria1234567', 'ordem de compra assinada enviada à corretora', buy);
r = await joao(`/bots/${liveId}/close`, {}); ok(r.s === 404, 'outro cliente não fecha posição alheia');
r = await cli(`/bots/${liveId}/close`, {}); ok(r.s === 200 && typeof r.j.pnl === 'number', 'vender agora (manual)', r.j);
flog = await (await fetch(`${F}/__log`)).json();
const sell = flog.find(l => l.p === '/binance/api/v3/order' && l.q.side === 'SELL' && l.q.symbol === 'LIVEUSDT');
ok(sell && Number(sell.q.quantity) > 0 && Number(sell.q.quantity) <= (200 / atCross.at(-1)) * 0.999 + 1e-9, 'venda usa o saldo livre (desconta a taxa em moeda)', sell?.q);
r = await cli(`/bots/${liveId}/trades`); ok(r.j[0].exit_reason === 'manual' && r.j[0].mode === 'live', 'operação real registrada', r.j[0]);
r = await cli(`/bots/connections/${connId}`, undefined, 'DELETE'); ok(r.j.ok, 'desconecta corretora');
r = await cli('/bots'); ok(r.j.find(b => b.id === liveId).status === 'paused', 'robôs da corretora desconectada são pausados', r.j);

// ---------------- copy trade
await setSeries('COPYUSDT', preCross);
r = await adm('/admin/masters', { name: 'Tendência COPY 1h', market: 'crypto', symbol: 'COPYUSDT', interval: '1h', strategy: 'ema_cross', stopLossPct: 3,
                                  description: 'Segue a tendência com cruzamento de médias e stop de 3%.' });
ok(r.s === 201, 'admin publica estratégia master', r.j); const masterId = r.j.id;
r = await joao('/bots/copy/catalog'); ok(r.j.length === 1 && r.j[0].name === 'Tendência COPY 1h', 'cliente vê o catálogo de copy trade');
r = await joao(`/bots/${(await joao('/bots')).j[0].id}`, undefined, 'DELETE');
r = await joao('/bots', { name: 'Copiar', amount: 50, copyOf: masterId }); ok(r.s === 403 && /Copy trade/.test(r.j.error), 'copy trade fora do plano Essencial', r.j);
r = await cli('/bots', { name: 'Copiando COPY', amount: 50, copyOf: masterId, stopLossPct: 3 }); ok(r.s === 201, 'cliente Pro copia a estratégia', r.j);
const follower = r.j.id;
await cli(`/bots/${follower}`, { status: 'active' }, 'PATCH');
await sleep(800);
await setSeries('COPYUSDT', atCross);
bot = await until(async () => (await cli('/bots')).j.find(b => b.id === follower && b.open_trade));
ok(bot && bot.symbol === 'COPYUSDT' && bot.copy_name === 'Tendência COPY 1h', 'seguidor entrou junto com a estratégia master', bot);
r = await cli('/bots/copy/catalog'); ok(r.j[0].posicionado === true && r.j[0].sigo === 1, 'catálogo mostra a estratégia posicionada');
await setSeries('COPYUSDT', crash(atCross));
bot = await until(async () => (await cli('/bots')).j.find(b => b.id === follower && !b.open_trade && b.trades === 1));
ok(bot, 'seguidor saiu na queda', bot);
r = await adm('/admin/masters'); ok(r.j[0].seguidores === 1 && r.j[0].trades === 1, 'admin vê seguidores e resultado da estratégia', r.j);

// ---------------- avisos e Telegram
r = await cli('/market/alerts');
ok(r.j.unread >= 4 && r.j.items.some(a => /COMPROU LIVEUSDT/.test(a.title)) && r.j.items.some(a => /\[Simulado\].*VENDEU CROSSUSDT \(stop\)/.test(a.title)), 'central de avisos com compras e vendas', r.j.items.map(a => a.title));
r = await joao('/market/alerts'); ok(!r.j.items.some(a => /LIVEUSDT|CROSSUSDT/.test(a.title)), 'RLS: avisos de robô só para o dono');
await cli('/market/alerts/read', {}); r = await cli('/market/alerts'); ok(r.j.unread === 0, 'marcar avisos como lidos');
r = await cli('/market/notify/test', {}); ok(r.s === 400, 'teste sem chat cadastrado: mensagem clara');
r = await cli('/market/notify', { telegramChatId: '12345', onSignals: true, onBots: true, onListings: true }, 'PUT'); ok(r.j.ok, 'salva Telegram');
r = await cli('/market/notify/test', {}); ok(r.j.ok, 'mensagem de teste no Telegram');
r = await cli('/market/notify', { telegramChatId: '99999', onSignals: true, onBots: true, onListings: true }, 'PUT');
r = await cli('/market/notify/test', {}); ok(r.s === 400 && /Telegram recusou/.test(r.j.error), 'chat errado: erro claro', r.j);
await cli('/market/notify', { telegramChatId: '12345', onSignals: true, onBots: true, onListings: true }, 'PUT');

// ---------------- radar de lançamentos
await sleep(2500);                                                 // 1ª volta só memoriza a lista
await fetch(`${F}/binance/__list?symbol=NOVAMOEDAUSDT`);
r = await until(async () => { const x = await cli('/market/listings'); return x.j.find?.(i => i.symbol === 'NOVAMOEDAUSDT') ? x : null; }, 12000);
ok(r && r.j.length === 1, 'radar avisa SÓ a moeda nova (não as já existentes)', r?.j);
const tg = await until(async () => (await (await fetch(`${F}/__log`)).json()).find(l => l.m === 'TELEGRAM' && /NOVAMOEDAUSDT/.test(l.b.text)), 5000);
ok(tg?.b.chat_id === '12345', 'lançamento chega no Telegram', tg);

// ---------------- modo pânico e kill switch
r = await adm('/admin/security/panic', { on: true, reason: 'teste de pânico' }); ok(r.j.panic?.on, 'modo pânico liga');
r = await cli(`/bots/${follower}`, { status: 'active' }, 'PATCH'); ok(r.s === 503, 'com pânico ninguém liga robô', r.j);
r = await cli('/bots/connections', { broker: 'binance', label: 'Outra', key: 'KEYmaria1234567', secret: 'SECRETmaria1234567' }); ok(r.s === 503, 'com pânico ninguém conecta corretora', r.j);
r = await adm('/admin/security/panic', { on: false }); ok(r.j.panic?.on === false, 'modo pânico desliga');
r = await adm(`/admin/tenants/${tMaria}/kill`, { reason: 'teste de bloqueio' }); ok(r.s === 200, 'kill switch');
r = await cli('/bots'); ok(r.s === 401 || r.s === 423, 'cliente bloqueado na hora', r.s);
r = await adm('/admin/dashboard'); ok(r.j.clientes.bloqueados === 1 && r.j.robos.masters === 1 && r.j.ops.ops_24h >= 3, 'painel master com robôs e operações', r.j);
r = await adm('/admin/tenants'); ok(r.j.find(t => t.id === tMaria).robos_ativos === 0, 'bloqueio pausa os robôs do cliente', r.j);
r = await adm('/admin/security/summary'); ok(r.j.cadeiaIntegra, 'cadeia de auditoria íntegra após tudo');
r = await adm(`/admin/audit?tenantId=${tMaria}`);
const acts = r.j.map(a => a.action);
ok(['broker.connected', 'bot.created', 'bot.position_closed', 'broker.disconnected', 'tenant.killed'].every(a => acts.includes(a)), 'auditoria de corretoras e robôs', acts);
process.exit();
