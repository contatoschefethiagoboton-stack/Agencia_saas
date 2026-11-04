import crypto from 'node:crypto';
import type { Market } from '../market/data.js';

/*
 * CORRETORAS. Cada cliente conecta a PRÓPRIA conta com chaves de API; o dinheiro nunca passa pela plataforma.
 *   binance -> cripto (spot). A chave PRECISA estar sem permissão de saque: a conexão é recusada se tiver.
 *   alpaca  -> ações dos EUA (conta real ou de papel da própria Alpaca).
 * B3: as corretoras brasileiras não oferecem API de ordens aberta para pessoa física; robôs de B3 rodam no simulado.
 */
export type BrokerId = 'binance' | 'alpaca';
export const BROKER_MARKET: Record<BrokerId, Market> = { binance: 'crypto', alpaca: 'us' };

export interface Fill { orderId: string; qty: number; price: number; fee: number }
export interface Creds { key: string; secret: string; paper?: boolean }
export interface Broker {
  check(): Promise<{ balances: { asset: string; free: number }[]; note?: string }>;
  marketBuy(symbol: string, quoteAmount: number): Promise<Fill>;
  marketSell(symbol: string, qty: number): Promise<Fill>;
  isMarketOpen(): Promise<boolean>;
}

const err = (msg: string, status = 400) => Object.assign(new Error(msg), { status });

export function broker(id: BrokerId, c: Creds): Broker {
  return id === 'binance' ? binance(c) : alpaca(c);
}

// ------------------------------------------------------------------ Binance (spot)
function binance(c: Creds): Broker {
  const base = (process.env.BINANCE_API_URL ?? 'https://api.binance.com').replace(/\/$/, '');
  async function call(method: string, path: string, params: Record<string, string | number> = {}, signed = true) {
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    if (signed) {
      qs.set('timestamp', String(Date.now())); qs.set('recvWindow', '10000');
      qs.set('signature', crypto.createHmac('sha256', c.secret).update(qs.toString()).digest('hex'));
    }
    let r: Response;
    try { r = await fetch(`${base}${path}?${qs}`, { method, headers: { 'X-MBX-APIKEY': c.key }, signal: AbortSignal.timeout(15_000) }); }
    catch { throw err('Binance fora do ar ou inacessível deste servidor', 502); }
    const j: any = await r.json().catch(() => ({}));
    if (r.status === 451 || (r.status === 403 && !j.code))
      throw err('A Binance bloqueia o servidor desta região. Hospede a plataforma em uma região permitida (ex.: Frankfurt ou Singapura no Render).', 502);
    if (!r.ok) throw err(`Binance: ${j.msg ?? `erro ${r.status}`}`, r.status >= 500 ? 502 : 400);
    return j;
  }
  const filters = new Map<string, { step: number; minQty: number; minNotional: number }>();
  async function symbolFilters(symbol: string) {
    if (filters.has(symbol)) return filters.get(symbol)!;
    const j = await call('GET', '/api/v3/exchangeInfo', { symbol }, false);
    const f: any[] = j.symbols?.[0]?.filters ?? [];
    const lot = f.find(x => x.filterType === 'LOT_SIZE'), mn = f.find(x => x.filterType === 'NOTIONAL' || x.filterType === 'MIN_NOTIONAL');
    const out = { step: +(lot?.stepSize ?? 0.00000001), minQty: +(lot?.minQty ?? 0), minNotional: +(mn?.minNotional ?? 5) };
    filters.set(symbol, out);
    return out;
  }
  const fillOf = (j: any): Fill => {
    const qty = +j.executedQty, quote = +j.cummulativeQuoteQty;
    if (!(qty > 0)) throw err('Binance não executou a ordem', 502);
    const price = quote / qty;
    const fee = (j.fills ?? []).reduce((a: number, f: any) => a + (f.commissionAsset === 'USDT' ? +f.commission : +f.commission * +f.price), 0);
    return { orderId: String(j.orderId), qty, price, fee };
  };
  return {
    async check() {
      const acc = await call('GET', '/api/v3/account', { omitZeroBalances: 'true' });
      if (acc.canTrade === false) throw err('Esta chave não tem permissão para negociar (ative "Spot Trading" na Binance)');
      const rest = await call('GET', '/sapi/v1/account/apiRestrictions').catch(() => null);
      if (rest?.enableWithdrawals) throw err('Por segurança, use uma chave SEM permissão de saque. Desmarque "Enable Withdrawals" na Binance e conecte de novo.');
      if (rest && !rest.enableSpotAndMarginTrading) throw err('Ative "Enable Spot & Margin Trading" nesta chave da Binance');
      return { balances: (acc.balances ?? []).map((b: any) => ({ asset: b.asset, free: +b.free })).filter((b: any) => b.free > 0).slice(0, 30),
               note: rest?.ipRestrict ? undefined : 'Dica: restrinja a chave ao IP do servidor na Binance para mais segurança.' };
    },
    async marketBuy(symbol, quoteAmount) {
      const f = await symbolFilters(symbol);
      if (quoteAmount < f.minNotional) throw err(`Valor abaixo do mínimo da Binance para ${symbol} (${f.minNotional} USDT)`);
      return fillOf(await call('POST', '/api/v3/order', { symbol, side: 'BUY', type: 'MARKET', quoteOrderQty: quoteAmount.toFixed(2), newOrderRespType: 'FULL' }));
    },
    async marketSell(symbol, qty) {
      const f = await symbolFilters(symbol);
      // a taxa da compra pode ter saído da própria moeda: vende o que realmente está livre
      const acc = await call('GET', '/api/v3/account', { omitZeroBalances: 'true' });
      const baseAsset = symbol.replace(/USDT$/, '');
      const free = +((acc.balances ?? []).find((b: any) => b.asset === baseAsset)?.free ?? 0);
      const decimals = Math.max(0, Math.round(-Math.log10(f.step)));
      const q = Math.floor(Math.min(qty, free) / f.step) * f.step;
      if (q < f.minQty || q <= 0) throw err(`Saldo de ${baseAsset} insuficiente para vender`);
      return fillOf(await call('POST', '/api/v3/order', { symbol, side: 'SELL', type: 'MARKET', quantity: q.toFixed(decimals), newOrderRespType: 'FULL' }));
    },
    async isMarketOpen() { return true; },   // cripto: 24 horas
  };
}

// ------------------------------------------------------------------ Alpaca (EUA)
function alpaca(c: Creds): Broker {
  const base = (process.env.ALPACA_API_URL ?? (c.paper ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets')).replace(/\/$/, '');
  async function call(method: string, path: string, body?: unknown) {
    let r: Response;
    try {
      r = await fetch(`${base}${path}`, { method, signal: AbortSignal.timeout(15_000),
        headers: { 'APCA-API-KEY-ID': c.key, 'APCA-API-SECRET-KEY': c.secret, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined });
    } catch { throw err('Alpaca fora do ar ou inacessível', 502); }
    const j: any = await r.json().catch(() => ({}));
    if (r.status === 401 || r.status === 403) throw err('Alpaca recusou a chave (confira se é da conta certa: real ou papel)');
    if (!r.ok) throw err(`Alpaca: ${j.message ?? `erro ${r.status}`}`, r.status >= 500 ? 502 : 400);
    return j;
  }
  async function waitFill(id: string): Promise<Fill> {
    for (let i = 0; i < 20; i++) {
      const o = await call('GET', `/v2/orders/${id}`);
      if (o.status === 'filled') return { orderId: id, qty: +o.filled_qty, price: +o.filled_avg_price, fee: 0 };
      if (['canceled', 'expired', 'rejected'].includes(o.status)) throw err(`Alpaca: ordem ${o.status}`, 502);
      await new Promise(r => setTimeout(r, 500));
    }
    throw err('Alpaca: a ordem não executou em 10 segundos (confira na corretora)', 502);
  }
  return {
    async check() {
      const a = await call('GET', '/v2/account');
      if (a.trading_blocked || a.account_blocked) throw err('Conta da Alpaca bloqueada para negociação');
      return { balances: [{ asset: a.currency ?? 'USD', free: +a.buying_power }], note: c.paper ? 'Conta de papel (simulada pela Alpaca).' : undefined };
    },
    async marketBuy(symbol, quoteAmount) {
      const o = await call('POST', '/v2/orders', { symbol, notional: quoteAmount.toFixed(2), side: 'buy', type: 'market', time_in_force: 'day' });
      return waitFill(o.id);
    },
    async marketSell(symbol, qty) {
      const o = await call('POST', '/v2/orders', { symbol, qty: String(+qty.toFixed(9)), side: 'sell', type: 'market', time_in_force: 'day' });
      return waitFill(o.id);
    },
    async isMarketOpen() { return Boolean((await call('GET', '/v2/clock')).is_open); },
  };
}
