/** Tipos e funções puras de mercado (sem rede nem Redis: dá para testar isoladamente). */
import type { Candle } from './indicators.js';

export type Market = 'crypto' | 'b3' | 'us';
export const MARKETS: Market[] = ['crypto', 'b3', 'us'];
export const INTERVALS = ['5m', '15m', '1h', '4h', '1d'] as const;
export type Interval = typeof INTERVALS[number];
export const INTERVAL_SEC: Record<Interval, number> = { '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };


export function normalizeSymbol(market: Market, raw: string): string {
  const s = raw.trim().toUpperCase().replace(/[\s/-]/g, '');
  const re = market === 'crypto' ? /^[A-Z0-9]{2,20}$/ : market === 'b3' ? /^[A-Z]{4}\d{1,2}F?$/ : /^[A-Z.]{1,6}$/;
  if (!re.test(s)) throw Object.assign(new Error('Código de ativo inválido'), { status: 400 });
  return market === 'b3' ? s.replace(/F$/, '') : s;
}

export function aggregate(c: Candle[], sec: number): Candle[] {
  const out: Candle[] = [];
  for (const k of c) {
    const t = Math.floor(k.time / sec) * sec;
    const last = out[out.length - 1];
    if (last && last.time === t) {
      last.high = Math.max(last.high, k.high); last.low = Math.min(last.low, k.low); last.close = k.close; last.volume += k.volume;
    } else out.push({ ...k, time: t });
  }
  return out;
}

