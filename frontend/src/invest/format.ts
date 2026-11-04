/** Formatação de preços, variações e rótulos dos mercados. */
export type Market = 'crypto' | 'b3' | 'us';
export const MARKET_LABEL: Record<Market, string> = { crypto: 'Cripto', b3: 'B3', us: 'EUA' };
export const CURRENCY: Record<Market, string> = { crypto: 'USDT', b3: 'R$', us: 'US$' };
export const INTERVALS = ['5m', '15m', '1h', '4h', '1d'] as const;
export type Interval = typeof INTERVALS[number];
export const INTERVAL_LABEL: Record<Interval, string> = { '5m': '5 min', '15m': '15 min', '1h': '1 hora', '4h': '4 horas', '1d': 'Diário' };

export function price(v: number | null | undefined, market?: Market) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  const digits = priceDigits(abs, market);
  const s = v.toLocaleString('pt-BR', { minimumFractionDigits: Math.min(2, digits), maximumFractionDigits: digits });
  return market === 'b3' ? `R$ ${s}` : market === 'us' ? `US$ ${s}` : s;
}
export const money = (v: number | null | undefined, market: Market) =>
  v === null || v === undefined ? '—' : `${market === 'b3' ? 'R$' : market === 'us' ? 'US$' : ''} ${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${market === 'crypto' ? ' USDT' : ''}`.trim();
export const pct = (v: number | null | undefined, digits = 2) =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(digits).replace('.', ',')}%`;
export const tone = (v: number | null | undefined) => (!v ? '' : v > 0 ? 'up' : 'down');
export const compact = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : v.toLocaleString('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });
export const symbolLabel = (s: string, m: Market) => (m === 'crypto' ? s.replace(/USDT$/, '/USDT') : s);
export const chartLink = (m: Market, s: string, extra = '') => `#grafico?market=${m}&symbol=${s}${extra}`;
export const ago = (iso: string) => {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  return s < 60 ? 'agora' : s < 3600 ? `há ${Math.floor(s / 60)} min` : s < 86400 ? `há ${Math.floor(s / 3600)} h` : `há ${Math.floor(s / 86400)} d`;
};
export const priceDigits = (abs: number, market?: Market) => (abs >= 100 ? 2 : abs >= 1 ? (market === 'crypto' ? 4 : 2) : abs >= 0.01 ? 5 : 8);
/** Resultado com sinal e vírgula: +12,34 / -5,00 */
export const signed = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
