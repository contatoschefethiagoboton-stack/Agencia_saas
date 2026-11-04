import { redis } from '../redis.js';
import type { Candle } from './indicators.js';
import { aggregate, INTERVAL_SEC, type Interval, type Market } from './util.js';
export { aggregate, normalizeSymbol, MARKETS, INTERVALS, INTERVAL_SEC, type Interval, type Market } from './util.js';

/*
 * DADOS DE MERCADO
 *   crypto -> Binance (público, sem chave). BINANCE_DATA_URL padrão: data-api.binance.vision (só dados de mercado).
 *   b3     -> brapi.dev (ações, FIIs, BDRs). BRAPI_TOKEN libera todos os ativos; sem ele só os de teste da brapi.
 *   us     -> Alpaca Market Data (feed IEX gratuito). ALPACA_DATA_KEY / ALPACA_DATA_SECRET.
 * Tudo passa por cache no Redis para não estourar o limite das APIs, mesmo com muitos clientes olhando o mesmo ativo.
 * MARKET_DATA=demo gera séries sintéticas (só para testes automatizados; a tela mostra "DADOS SIMULADOS").
 */
export interface Quote { symbol: string; name?: string; price: number; changePct: number; volume?: number; logo?: string }

export const isDemo = () => process.env.MARKET_DATA === 'demo';
const binance = () => (process.env.BINANCE_DATA_URL ?? 'https://data-api.binance.vision').replace(/\/$/, '');
const brapi = () => (process.env.BRAPI_URL ?? 'https://brapi.dev').replace(/\/$/, '');
const alpacaData = () => (process.env.ALPACA_DATA_URL ?? 'https://data.alpaca.markets').replace(/\/$/, '');

const fail = (msg: string, status = 502) => Object.assign(new Error(msg), { status });

async function getJson(url: string, headers?: Record<string, string>, label = 'API de mercado') {
  let r: Response;
  try { r = await fetch(url, { headers, signal: AbortSignal.timeout(12_000) }); }
  catch { throw fail(`${label} fora do ar ou inacessível. Tente de novo em instantes.`); }
  if (r.status === 451 || r.status === 403) throw fail(`${label} recusou o acesso deste servidor (região bloqueada ou chave sem permissão).`);
  if (r.status === 429) throw fail(`${label}: limite de consultas atingido. Aguarde um minuto.`, 429);
  const j: any = await r.json().catch(() => null);
  if (!r.ok) throw fail(`${label}: ${j?.message ?? j?.msg ?? `erro ${r.status}`}`, r.status === 404 || r.status === 400 ? 404 : 502);
  return j;
}

async function cached<T>(key: string, ttlSec: number, fn: () => Promise<T>): Promise<T> {
  const hit = await redis.get(key).catch(() => null);
  if (hit) return JSON.parse(hit) as T;
  const v = await fn();
  await redis.set(key, JSON.stringify(v), { EX: ttlSec }).catch(() => {});
  return v;
}

const ttlFor = (iv: Interval) => Number(process.env.MARKET_CACHE_SEC) || (iv === '1d' ? 300 : iv === '4h' ? 120 : 20);

// ---------------------------------------------------------------- candles
export async function getCandles(market: Market, symbol: string, interval: Interval, limit = 500): Promise<Candle[]> {
  limit = Math.max(50, Math.min(limit, 1000));
  return cached(`candles:${market}:${symbol}:${interval}:${limit}`, ttlFor(interval), async () => {
    if (isDemo()) return demoCandles(symbol, interval, limit);
    if (market === 'crypto') return cryptoCandles(symbol, interval, limit);
    if (market === 'b3') return b3Candles(symbol, interval, limit);
    return usCandles(symbol, interval, limit);
  });
}

async function cryptoCandles(symbol: string, interval: Interval, limit: number): Promise<Candle[]> {
  const rows = await getJson(`${binance()}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`, undefined, 'Binance');
  return (rows as any[]).map(k => ({ time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[7] }));
}

const brapiQs = () => (process.env.BRAPI_TOKEN ? `token=${encodeURIComponent(process.env.BRAPI_TOKEN)}` : '');

async function b3Candles(symbol: string, interval: Interval, limit: number): Promise<Candle[]> {
  // brapi trabalha com intervalo + janela; 4h é montado a partir de candles de 1h
  const map: Record<Interval, [string, string]> = { '5m': ['5m', '5d'], '15m': ['15m', '1mo'], '1h': ['1h', '3mo'], '4h': ['1h', '3mo'], '1d': ['1d', '2y'] };
  const [iv, range] = map[interval];
  const j = await getJson(`${brapi()}/api/quote/${symbol}?range=${range}&interval=${iv}&${brapiQs()}`, undefined, 'brapi (B3)');
  const hist: any[] = j?.results?.[0]?.historicalDataPrice ?? [];
  let c: Candle[] = hist.filter(h => h && Number.isFinite(h.close) && h.close > 0)
    .map(h => ({ time: h.date, open: h.open ?? h.close, high: h.high ?? h.close, low: h.low ?? h.close, close: h.close, volume: h.volume ?? 0 }))
    .sort((a, b) => a.time - b.time);
  if (interval === '4h') c = aggregate(c, 4 * 3600);
  if (!c.length) throw fail('Sem histórico para este ativo. Confira o código ou se o BRAPI_TOKEN libera este ativo.', 404);
  return c.slice(-limit);
}

function alpacaHeaders() {
  if (!process.env.ALPACA_DATA_KEY || !process.env.ALPACA_DATA_SECRET)
    throw fail('Ações dos EUA ainda não foram ativadas pelo administrador (ALPACA_DATA_KEY/ALPACA_DATA_SECRET).', 503);
  return { 'APCA-API-KEY-ID': process.env.ALPACA_DATA_KEY, 'APCA-API-SECRET-KEY': process.env.ALPACA_DATA_SECRET };
}

async function usCandles(symbol: string, interval: Interval, limit: number): Promise<Candle[]> {
  const tf: Record<Interval, string> = { '5m': '5Min', '15m': '15Min', '1h': '1Hour', '4h': '4Hour', '1d': '1Day' };
  // pregão tem ~6,5h por dia: pede uma janela folgada para chegar ao número de candles
  const daysBack = interval === '1d' ? limit * 1.6 : Math.ceil((limit * INTERVAL_SEC[interval]) / (6.5 * 3600) * 1.6) + 5;
  const start = new Date(Date.now() - daysBack * 86400_000).toISOString();
  const j = await getJson(`${alpacaData()}/v2/stocks/${symbol}/bars?timeframe=${tf[interval]}&start=${start}&limit=10000&adjustment=split&feed=iex`,
                          alpacaHeaders(), 'Alpaca (EUA)');
  const bars: any[] = j?.bars ?? [];
  if (!bars.length) throw fail('Sem histórico para este ativo nos EUA.', 404);
  return bars.map(b => ({ time: Math.floor(Date.parse(b.t) / 1000), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v })).slice(-limit);
}

// ---------------------------------------------------------------- cotações e maiores do dia
export async function getQuotes(market: Market, symbols: string[]): Promise<Quote[]> {
  if (!symbols.length) return [];
  if (isDemo()) return symbols.map(s => demoQuote(s));
  if (market === 'crypto') {
    const all = await cryptoTickers();
    const set = new Set(symbols);
    return all.filter(q => set.has(q.symbol));
  }
  if (market === 'b3') {
    return (await Promise.all(symbols.map(s => cached(`quote:b3:${s}`, 30, async () => {
      const j = await getJson(`${brapi()}/api/quote/${s}?${brapiQs()}`, undefined, 'brapi (B3)').catch(() => null);
      const r = j?.results?.[0];
      return r ? { symbol: s, name: r.longName ?? r.shortName, price: r.regularMarketPrice, changePct: r.regularMarketChangePercent ?? 0,
                   volume: r.regularMarketVolume, logo: r.logourl } as Quote : null;
    })))).filter(Boolean) as Quote[];
  }
  return cached(`quote:us:${symbols.join(',')}`, 20, async () => {
    const j = await getJson(`${alpacaData()}/v2/stocks/snapshots?symbols=${symbols.join(',')}&feed=iex`, alpacaHeaders(), 'Alpaca (EUA)');
    return Object.entries(j ?? {}).map(([s, v]: [string, any]) => {
      const price = v?.latestTrade?.p ?? v?.dailyBar?.c, prev = v?.prevDailyBar?.c;
      return { symbol: s, price, changePct: prev ? (price / prev - 1) * 100 : 0, volume: v?.dailyBar?.v } as Quote;
    }).filter(q => Number.isFinite(q.price));
  });
}

/** Todas as moedas em USDT da Binance com preço e variação de 24h (cache 20s, chamada pesada). */
async function cryptoTickers(): Promise<Quote[]> {
  return cached('tickers:crypto', 20, async () => {
    const rows = await getJson(`${binance()}/api/v3/ticker/24hr?type=MINI`, undefined, 'Binance');
    return (rows as any[]).filter(t => t.symbol.endsWith('USDT') && +t.quoteVolume > 0)
      .map(t => ({ symbol: t.symbol, price: +t.lastPrice, changePct: +t.openPrice ? (+t.lastPrice / +t.openPrice - 1) * 100 : 0, volume: +t.quoteVolume }));
  });
}

const US_POPULAR = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AVGO', 'AMD', 'NFLX', 'JPM', 'V', 'COST', 'PLTR', 'COIN', 'MSTR', 'INTC', 'DIS', 'BA', 'UBER'];

/** Os mais negociados do mercado (base do scanner de sinais e da tela de mercado). */
export async function topAssets(market: Market, n = 30): Promise<Quote[]> {
  if (isDemo()) return demoUniverse(market).slice(0, n).map(s => demoQuote(s));
  if (market === 'crypto') {
    const stable = /^(USDC|FDUSD|TUSD|BUSD|DAI|USDP|EUR|AEUR|USDE|XUSD|BFUSD|PAXG|WBTC|WBETH)USDT$/;
    return (await cryptoTickers()).filter(q => !stable.test(q.symbol)).sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0)).slice(0, n);
  }
  if (market === 'b3') {
    return cached(`top:b3:${n}`, 60, async () => {
      const j = await getJson(`${brapi()}/api/quote/list?type=stock&sortBy=volume&sortOrder=desc&limit=${n}&${brapiQs()}`, undefined, 'brapi (B3)');
      return (j?.stocks ?? []).map((s: any) => ({ symbol: s.stock, name: s.name, price: s.close, changePct: s.change ?? 0, volume: s.volume, logo: s.logo }));
    });
  }
  return getQuotes('us', US_POPULAR.slice(0, n));
}

/** Lista completa de ativos negociáveis (para o radar de lançamentos). */
export async function listAllSymbols(market: Market): Promise<string[]> {
  if (isDemo()) return demoUniverse(market);
  if (market === 'crypto') {
    const j = await getJson(`${binance()}/api/v3/exchangeInfo?permissions=SPOT&symbolStatus=TRADING`, undefined, 'Binance');
    return (j?.symbols ?? []).filter((s: any) => s.quoteAsset === 'USDT').map((s: any) => s.symbol);
  }
  if (market === 'b3') {
    const j = await getJson(`${brapi()}/api/available?${brapiQs()}`, undefined, 'brapi (B3)');
    return (j?.stocks ?? []).filter((s: string) => /^[A-Z]{4}\d{1,2}$/.test(s));
  }
  return [];
}

// ---------------------------------------------------------------- FIIs
export interface Fii { symbol: string; name?: string; price: number; changePct: number; volume?: number; dy12m: number | null;
                       lastDividend: number | null; lastDividendDate: string | null; pvp: number | null; logo?: string }

/** Ranking de FIIs: dividend yield dos últimos 12 meses, P/VP (quando a brapi informa) e liquidez. */
export async function fiiRanking(limit = 40): Promise<Fii[]> {
  if (isDemo()) return demoUniverse('b3').filter(s => s.endsWith('11')).map((s, i) => ({ ...demoQuote(s), dy12m: 8 + (i % 7), lastDividend: 0.9, lastDividendDate: new Date().toISOString(), pvp: 0.85 + (i % 5) / 20 }));
  return cached(`fii:ranking:${limit}`, 6 * 3600, async () => {
    const j = await getJson(`${brapi()}/api/quote/list?type=fund&sortBy=volume&sortOrder=desc&limit=${limit}&${brapiQs()}`, undefined, 'brapi (FIIs)');
    const list: any[] = (j?.stocks ?? []).filter((s: any) => /11$/.test(s.stock));
    const out: Fii[] = [];
    for (let i = 0; i < list.length; i += 4) {          // 4 por vez: respeita o limite da brapi
      out.push(...await Promise.all(list.slice(i, i + 4).map(async s => {
        const d = await getJson(`${brapi()}/api/quote/${s.stock}?dividends=true&modules=defaultKeyStatistics&${brapiQs()}`, undefined, 'brapi (FIIs)').catch(() => null);
        const r = d?.results?.[0];
        const cash: any[] = r?.dividendsData?.cashDividends ?? [];
        const yearAgo = Date.now() - 365 * 86400_000;
        const last12 = cash.filter(c => Date.parse(c.paymentDate ?? c.lastDatePrior) >= yearAgo);
        const sum = last12.reduce((a, c) => a + (+c.rate || 0), 0);
        const latest = cash.slice().sort((a, b) => Date.parse(b.paymentDate) - Date.parse(a.paymentDate))[0];
        const price = r?.regularMarketPrice ?? s.close;
        const ks = r?.defaultKeyStatistics;
        const pvp = ks?.priceToBook ?? (ks?.bookValue ? price / ks.bookValue : null);
        return { symbol: s.stock, name: s.name, price, changePct: s.change ?? 0, volume: s.volume, logo: s.logo,
                 dy12m: price && last12.length ? (sum / price) * 100 : null,
                 lastDividend: latest ? +latest.rate : null, lastDividendDate: latest?.paymentDate ?? null,
                 pvp: Number.isFinite(pvp) ? pvp : null } as Fii;
      })));
    }
    return out;
  });
}

// ---------------------------------------------------------------- dados sintéticos (só MARKET_DATA=demo)
function demoUniverse(market: Market) {
  return market === 'crypto' ? ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT']
    : market === 'b3' ? ['PETR4', 'VALE3', 'ITUB4', 'BBAS3', 'WEGE3', 'MXRF11', 'HGLG11', 'KNRI11', 'XPML11', 'VISC11']
    : ['AAPL', 'MSFT', 'NVDA', 'TSLA'];
}
function seeded(seed: string) {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 1_000_000) / 1_000_000; };
}
function demoCandles(symbol: string, interval: Interval, limit: number): Candle[] {
  const step = INTERVAL_SEC[interval];
  const end = Math.floor(Date.now() / 1000 / step) * step;
  const rnd = seeded(symbol + interval);
  let p = 50 + rnd() * 500;
  const out: Candle[] = [];
  for (let i = limit - 1; i >= 0; i--) {
    const drift = Math.sin((limit - i) / 40) * 0.004;
    const o = p, c = Math.max(0.01, o * (1 + drift + (rnd() - 0.5) * 0.03));
    out.push({ time: end - i * step, open: o, high: Math.max(o, c) * (1 + rnd() * 0.01), low: Math.min(o, c) * (1 - rnd() * 0.01), close: c, volume: 1000 + rnd() * 5000 });
    p = c;
  }
  return out;
}
function demoQuote(symbol: string): Quote {
  const c = demoCandles(symbol, '1d', 60);
  const last = c[c.length - 1];
  return { symbol, price: last.close, changePct: (last.close / last.open - 1) * 100, volume: last.volume };
}
