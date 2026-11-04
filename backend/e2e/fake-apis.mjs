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
// ---- Asaas falso: assinaturas, cobranças, subcontas, PIX e transferências
const A = { n: 0, subs: new Map(), pays: new Map(), accounts: new Map() /* apiKey -> conta */, transfers: [] };
const nid = p => `${p}_${++A.n}`;
const PWNED = ['Senha123456', 'qwerty123456'];
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
    if (p === '/__asaas') return J(res, 200, { subs: [...A.subs.values()], pays: [...A.pays.values()], accounts: [...A.accounts.values()], transfers: A.transfers });

    // ---------------- Have I Been Pwned (k-anonimato)
    const mh = p.match(/^\/hibp\/range\/([0-9A-F]{5})$/);
    if (mh) {
      const lines = PWNED.map(pw => crypto.createHash('sha1').update(pw).digest('hex').toUpperCase()).filter(h => h.startsWith(mh[1])).map(h => `${h.slice(5)}:42`);
      res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end([...lines, '0000000000000000000000000000000000A:0'].join('\r\n'));
    }

    // ---------------- Asaas
    if (p.startsWith('/asaas/')) {
      const key = req.headers['access_token'];
      const b = (() => { try { return JSON.parse(body || '{}'); } catch { return {}; } })();
      const ap = p.slice(6);
      const E = (code, d) => J(res, code, { errors: [{ description: d }] });
      // controles da bateria
      if (ap === '/__pay') { const pay = A.pays.get(q.id); pay.status = q.status ?? 'RECEIVED'; if (q.value) pay.value = Number(q.value); return J(res, 200, pay); }
      if (ap === '/__approve') { const a = [...A.accounts.values()].find(x => x.email === q.email); a.status = 'APPROVED'; return J(res, 200, a); }
      if (ap === '/__credit') { const a = [...A.accounts.values()].find(x => x.email === q.email); a.balance += Number(q.value); return J(res, 200, a); }
      const master = key === 'asaas-master', acc = A.accounts.get(key);
      if (!master && !acc) return E(401, 'chave inválida');
      if (ap === '/customers' && req.method === 'POST') return J(res, 200, { id: nid('cus') });
      if (ap === '/subscriptions' && req.method === 'POST') {
        const sub = { id: nid('sub'), ...b, status: 'ACTIVE' }; A.subs.set(sub.id, sub);
        const pay = { id: nid('pay'), subscription: sub.id, value: b.value, status: 'PENDING', billingType: b.billingType, invoiceUrl: `https://pagar.fake/${A.n}` };
        A.pays.set(pay.id, pay); return J(res, 200, sub);
      }
      let m = ap.match(/^\/subscriptions\/([^/]+)\/payments$/);
      if (m) return J(res, 200, { data: [...A.pays.values()].filter(x => x.subscription === m[1] && (!q.status || x.status === q.status)) });
      m = ap.match(/^\/subscriptions\/([^/]+)$/);
      if (m) {
        const sub = A.subs.get(m[1]); if (!sub) return E(404, 'assinatura não encontrada');
        if (req.method === 'DELETE') { sub.status = 'DELETED'; return J(res, 200, { deleted: true }); }
        Object.assign(sub, b);
        if (b.updatePendingPayments) for (const x of A.pays.values()) if (x.subscription === sub.id && x.status === 'PENDING') { if (b.value) x.value = b.value; if (b.billingType) x.billingType = b.billingType; }
        return J(res, 200, sub);
      }
      m = ap.match(/^\/payments\/([^/]+)$/);
      if (m) { const x = A.pays.get(m[1]); return x ? J(res, 200, x) : E(404, 'cobrança não encontrada'); }
      if (ap === '/accounts' && master) {
        if (!b.cpfCnpj || !b.birthDate || !b.postalCode) return E(400, 'dados obrigatórios');
        const a = { id: nid('acc'), walletId: nid('wal'), apiKey: nid('subkey'), email: b.email, balance: 0, status: 'PENDING', keys: [] };
        A.accounts.set(a.apiKey, a); return J(res, 200, { id: a.id, walletId: a.walletId, apiKey: a.apiKey });
      }
      if (!acc) return E(403, 'só subconta');
      if (ap === '/myAccount/status') return J(res, 200, { general: acc.status });
      if (ap === '/myAccount/documents') return J(res, 200, { data: [{ title: 'Documento com foto', status: acc.status === 'APPROVED' ? 'APPROVED' : 'NOT_SENT', onboardingUrl: 'https://docs.fake/1' }] });
      if (ap === '/pix/addressKeys' && req.method === 'GET') return J(res, 200, { data: acc.keys.map(k => ({ key: k, status: 'ACTIVE' })) });
      if (ap === '/pix/addressKeys') { const k = `evp-${A.n++}`; acc.keys.push(k); return J(res, 200, { key: k, status: 'ACTIVE' }); }
      if (ap === '/pix/qrCodes/static') return J(res, 200, { encodedImage: 'iVBORw0KGgo=', payload: `00020126PIX${b.addressKey}` });
      if (ap === '/finance/balance') return J(res, 200, { balance: acc.balance });
      if (ap.startsWith('/financialTransactions')) return J(res, 200, { data: [] });
      if (ap === '/transfers') {
        if (acc.status !== 'APPROVED') return E(400, 'conta não aprovada');
        if (b.value > acc.balance) return E(400, 'Saldo insuficiente para a transferência');
        const dest = b.walletId ? [...A.accounts.values()].find(x => x.walletId === b.walletId) : null;
        if (b.walletId && !dest) return E(400, 'carteira de destino inexistente');
        acc.balance -= b.value; if (dest) dest.balance += b.value;
        const t = { id: nid('tra'), from: acc.walletId, ...b, status: 'DONE' }; A.transfers.push(t); return J(res, 200, t);
      }
      return E(404, `rota falsa inexistente: ${ap}`);
    }

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
