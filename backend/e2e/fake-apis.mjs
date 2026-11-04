/*
 * Servidor FALSO das APIs externas (Binance mercado + ordens, brapi e Telegram) para os testes de ponta a ponta.
 * Responde no formato das APIs reais e registra tudo em /__log. A bateria controla os preços por /binance/__series.
 * Uso: node e2e/fake-apis.mjs  (porta 4555)
 */
import http from 'node:http';
import crypto from 'node:crypto';

const log = [];
const series = new Map();            // símbolo -> fechamentos (o último é o candle em formação)
const listing = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT'];
const balances = new Map([['USDT', 10000]]);
const b3list = ['PETR4', 'VALE3', 'ITUB4', 'MXRF11', 'HGLG11', 'BBAS3'];
const J = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

const defaultCloses = sym => Array.from({ length: 300 }, (_, i) => (sym.startsWith('ETH') ? 3000 : 60000) * (1 + Math.sin(i / 15) * 0.03 + i * 0.0004));
const closesOf = sym => series.get(sym) ?? defaultCloses(sym);
function candles(sym, stepSec = 3600) {
  const cl = closesOf(sym);
  const last = Math.floor(Date.now() / 1000 / stepSec) * stepSec;
  return cl.map((c, i) => {
    const o = i ? cl[i - 1] : c;
    return { t: (last - (cl.length - 1 - i) * stepSec) * 1000, o, h: Math.max(o, c) * 1.002, l: Math.min(o, c) * 0.998, c, v: 1000 + (i % 7) * 100 };
  });
}
const lastPrice = sym => closesOf(sym).at(-1);
const STEP = { '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };

http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    const u = new URL(req.url, 'http://x'); const p = u.pathname; const q = Object.fromEntries(u.searchParams);
    log.push({ m: req.method, p, q, key: req.headers['x-mbx-apikey'] });
    if (p === '/__log') return J(res, 200, log);

    // ---------------- controle da bateria
    if (p === '/binance/__series') { series.set(q.symbol, q.closes.split(',').map(Number)); return J(res, 200, { ok: true }); }
    if (p === '/binance/__list') { listing.push(q.symbol); return J(res, 200, { ok: true }); }
    if (p === '/brapi/__list') { b3list.push(q.symbol); return J(res, 200, { ok: true }); }

    // ---------------- Binance: dados de mercado
    if (p === '/binance/api/v3/klines') {
      if (!/^[A-Z0-9]+$/.test(q.symbol) || q.symbol === 'NAOEXISTEUSDT') return J(res, 400, { code: -1121, msg: 'Invalid symbol.' });
      return J(res, 200, candles(q.symbol, STEP[q.interval] ?? 3600).slice(-Number(q.limit ?? 500))
        .map(k => [k.t, String(k.o), String(k.h), String(k.l), String(k.c), String(k.v), k.t + 3599999, String(k.v * k.c), 10, '0', '0', '0']));
    }
    if (p === '/binance/api/v3/ticker/24hr') {
      return J(res, 200, [...new Set([...listing, ...series.keys()])].map(s => {
        const cl = closesOf(s);
        return { symbol: s, openPrice: String(cl.at(-25) ?? cl[0]), lastPrice: String(cl.at(-1)), quoteVolume: String(1e6 + s.length) };
      }));
    }
    if (p === '/binance/api/v3/exchangeInfo') {
      if (q.symbol) return J(res, 200, { symbols: [{ symbol: q.symbol, filters: [{ filterType: 'LOT_SIZE', stepSize: '0.00001000', minQty: '0.00001000' }, { filterType: 'NOTIONAL', minNotional: '5' }] }] });
      return J(res, 200, { symbols: listing.map(s => ({ symbol: s, quoteAsset: 'USDT', status: 'TRADING' })) });
    }

    // ---------------- Binance: conta e ordens (assinadas)
    if (p.startsWith('/binance/api/v3/account') || p.startsWith('/binance/sapi/') || (p === '/binance/api/v3/order')) {
      const qs = new URLSearchParams(u.search.slice(1)); const sig = qs.get('signature'); qs.delete('signature');
      const key = req.headers['x-mbx-apikey'] ?? '';
      const secret = key.replace(/^KEY/, 'SECRET');
      if (!sig || crypto.createHmac('sha256', secret).update(qs.toString()).digest('hex') !== sig) return J(res, 401, { code: -1022, msg: 'Signature for this request is not valid.' });
      if (p === '/binance/sapi/v1/account/apiRestrictions')
        return J(res, 200, { enableWithdrawals: key.includes('SAQUE'), enableSpotAndMarginTrading: true, ipRestrict: false, enableReading: true });
      if (p === '/binance/api/v3/account')
        return J(res, 200, { canTrade: true, balances: [...balances].map(([asset, free]) => ({ asset, free: String(free), locked: '0' })) });
      const price = lastPrice(q.symbol); const base = q.symbol.replace(/USDT$/, '');
      if (q.side === 'BUY') {
        const quote = Number(q.quoteOrderQty), qty = quote / price;
        balances.set('USDT', balances.get('USDT') - quote); balances.set(base, (balances.get(base) ?? 0) + qty * 0.999);
        return J(res, 200, { orderId: 1000 + log.length, status: 'FILLED', executedQty: String(qty), cummulativeQuoteQty: String(quote),
                             fills: [{ price: String(price), qty: String(qty), commission: String(qty * 0.001), commissionAsset: base }] });
      }
      const qty = Number(q.quantity);
      if (qty > (balances.get(base) ?? 0) + 1e-12) return J(res, 400, { code: -2010, msg: 'Account has insufficient balance for requested action.' });
      balances.set(base, (balances.get(base) ?? 0) - qty); balances.set('USDT', balances.get('USDT') + qty * price);
      return J(res, 200, { orderId: 2000 + log.length, status: 'FILLED', executedQty: String(qty), cummulativeQuoteQty: String(qty * price),
                           fills: [{ price: String(price), qty: String(qty), commission: String(qty * price * 0.001), commissionAsset: 'USDT' }] });
    }

    // ---------------- brapi (B3 e FIIs)
    if (p === '/brapi/api/available') return J(res, 200, { indexes: [], stocks: b3list });
    if (p === '/brapi/api/quote/list') {
      const fund = q.type === 'fund';
      return J(res, 200, { stocks: (fund ? ['MXRF11', 'HGLG11'] : ['PETR4', 'VALE3']).map((s, i) => ({ stock: s, name: `${s} Fundo`, close: fund ? [10, 160][i] : [38, 60][i], change: 0.5, volume: 5e6 })) });
    }
    const mq = p.match(/^\/brapi\/api\/quote\/([A-Z0-9]+)$/);
    if (mq) {
      const s = mq[1]; const px = s === 'HGLG11' ? 160 : s === 'MXRF11' ? 10 : 38;
      const now = Date.now();
      const hist = Array.from({ length: 300 }, (_, i) => ({ date: Math.floor(now / 1000) - (299 - i) * 86400, open: px, high: px * 1.01, low: px * 0.99, close: px * (1 + Math.sin(i / 10) * 0.05), volume: 1e6 }));
      return J(res, 200, { results: [{ symbol: s, regularMarketPrice: px, regularMarketChangePercent: 0.4, longName: `${s} SA`,
        historicalDataPrice: q.range ? hist : undefined,
        dividendsData: q.dividends ? { cashDividends: Array.from({ length: 12 }, (_, i) => ({ rate: s === 'MXRF11' ? 0.09 : 1.1, paymentDate: new Date(now - i * 30 * 86400_000).toISOString() })) } : undefined,
        defaultKeyStatistics: q.modules ? { priceToBook: s === 'MXRF11' ? 1.02 : 0.93 } : undefined }] });
    }

    // ---------------- Telegram
    if (/^\/telegram\/bot[^/]+\/sendMessage$/.test(p)) {
      const b = JSON.parse(body || '{}');
      log.push({ m: 'TELEGRAM', p, b });
      return J(res, b.chat_id === '99999' ? 400 : 200, { ok: b.chat_id !== '99999' });
    }
    J(res, 404, { msg: `rota falsa inexistente: ${p}` });
  });
}).listen(4555);
