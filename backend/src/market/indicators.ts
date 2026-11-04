/**
 * Indicadores técnicos clássicos. Funções puras: recebem a série e devolvem um array do mesmo tamanho,
 * com NaN onde ainda não há dados suficientes (assim o índice i sempre corresponde ao candle i).
 */
export interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }

export function sma(v: number[], n: number): number[] {
  const out = new Array(v.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    sum += v[i];
    if (i >= n) sum -= v[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

export function ema(v: number[], n: number): number[] {
  const out = new Array(v.length).fill(NaN);
  if (v.length < n) return out;
  const k = 2 / (n + 1);
  let prev = v.slice(0, n).reduce((a, b) => a + b, 0) / n;   // semente: média simples dos n primeiros
  out[n - 1] = prev;
  for (let i = n; i < v.length; i++) { prev = v[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}

/** RSI de Wilder (0–100). */
export function rsi(close: number[], n = 14): number[] {
  const out = new Array(close.length).fill(NaN);
  if (close.length <= n) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = close[i] - close[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= n; loss /= n;
  out[n] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = n + 1; i < close.length; i++) {
    const d = close[i] - close[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

export function macd(close: number[], fast = 12, slow = 26, signal = 9) {
  const f = ema(close, fast), s = ema(close, slow);
  const line = close.map((_, i) => f[i] - s[i]);
  const start = line.findIndex(x => !Number.isNaN(x));
  const sig = new Array(close.length).fill(NaN);
  if (start >= 0) {
    const e = ema(line.slice(start), signal);
    for (let i = 0; i < e.length; i++) sig[start + i] = e[i];
  }
  return { line, signal: sig, hist: line.map((x, i) => x - sig[i]) };
}

export function bollinger(close: number[], n = 20, mult = 2) {
  const mid = sma(close, n);
  const upper = new Array(close.length).fill(NaN), lower = new Array(close.length).fill(NaN);
  for (let i = n - 1; i < close.length; i++) {
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += (close[j] - mid[i]) ** 2;
    const sd = Math.sqrt(s / n);
    upper[i] = mid[i] + mult * sd; lower[i] = mid[i] - mult * sd;
  }
  return { mid, upper, lower };
}

/** Average True Range (Wilder): volatilidade média, usada para stop e alvo. */
export function atr(c: Candle[], n = 14): number[] {
  const out = new Array(c.length).fill(NaN);
  if (c.length <= n) return out;
  const tr = c.map((k, i) => i === 0 ? k.high - k.low
    : Math.max(k.high - k.low, Math.abs(k.high - c[i - 1].close), Math.abs(k.low - c[i - 1].close)));
  let prev = tr.slice(1, n + 1).reduce((a, b) => a + b, 0) / n;
  out[n] = prev;
  for (let i = n + 1; i < c.length; i++) { prev = (prev * (n - 1) + tr[i]) / n; out[i] = prev; }
  return out;
}

/** Máxima e mínima dos n candles ANTERIORES (canal de Donchian, sem incluir o atual). */
export function donchian(c: Candle[], n = 20) {
  const hi = new Array(c.length).fill(NaN), lo = new Array(c.length).fill(NaN);
  for (let i = n; i < c.length; i++) {
    let h = -Infinity, l = Infinity;
    for (let j = i - n; j < i; j++) { h = Math.max(h, c[j].high); l = Math.min(l, c[j].low); }
    hi[i] = h; lo[i] = l;
  }
  return { hi, lo };
}

/** Pacote com tudo o que as estratégias usam, calculado uma vez por série. */
export function computeAll(c: Candle[]) {
  const close = c.map(k => k.close);
  return {
    close, volume: c.map(k => k.volume),
    ema9: ema(close, 9), ema21: ema(close, 21), ema50: ema(close, 50), ema200: ema(close, 200),
    rsi: rsi(close, 14), macd: macd(close), bb: bollinger(close, 20, 2), atr: atr(c, 14),
    volSma: sma(c.map(k => k.volume), 20), don: donchian(c, 20),
  };
}
export type Indicators = ReturnType<typeof computeAll>;
