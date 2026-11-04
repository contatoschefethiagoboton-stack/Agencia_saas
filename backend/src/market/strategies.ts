import { computeAll, type Candle, type Indicators } from './indicators.js';

/*
 * SINAIS: nenhuma estratégia acerta sempre. Cada sinal vem com o acerto histórico (backtest) no mesmo ativo,
 * para o investidor ver quanto aquele tipo de sinal funcionou no passado — e não uma promessa de lucro.
 */
export type Action = 'buy' | 'sell' | null;
type Rule = (ind: Indicators, i: number) => Action;
const ok = (...xs: number[]) => xs.every(x => Number.isFinite(x));

export const STRATEGIES: Record<string, { name: string; description: string; rule: Rule }> = {
  inteligente: {
    name: 'Inteligente (alta e queda)',
    description: 'Compra quando identifica alta confirmada (preço acima das médias 21 e 50, MACD subindo, RSI entre 50 e 70 e volume). Vende quando identifica queda (fecha abaixo da média de 21 com MACD negativo, ou abaixo da média de 50). Use com stop móvel.',
    rule: (ind, i) => {
      const { close, ema21, ema50, macd, rsi, volume, volSma } = ind;
      if (i < 2 || !ok(ema21[i], ema50[i], macd.hist[i], macd.hist[i - 1], rsi[i])) return null;
      const up = (k: number) => close[k] > ema21[k] && ema21[k] > ema50[k] && macd.hist[k] > 0 && macd.hist[k] > macd.hist[k - 1]
        && rsi[k] >= 50 && rsi[k] <= 70 && (!ok(volSma[k]) || volume[k] >= volSma[k] * 0.8);
      if (up(i) && !up(i - 1)) return 'buy';
      if ((close[i] < ema21[i] && macd.hist[i] < 0) || close[i] < ema50[i]) return 'sell';
      return null;
    },
  },
  score: {
    name: 'Placar combinado',
    description: 'Soma tendência, momento, RSI, Bandas de Bollinger e volume. Compra com placar ≥ 40 e vende com ≤ −20.',
    rule: (ind, i) => {
      const s = scoreAt(ind, i).score;
      return s >= 40 ? 'buy' : s <= -20 ? 'sell' : null;
    },
  },
  ema_cross: {
    name: 'Cruzamento de médias 9/21',
    description: 'Compra quando a média de 9 cruza para cima a de 21 com o preço acima da média de 200; vende no cruzamento para baixo.',
    rule: (ind, i) => {
      const { ema9: f, ema21: s, ema200: t, close } = ind;
      if (i < 1 || !ok(f[i], s[i], f[i - 1], s[i - 1])) return null;
      if (f[i - 1] <= s[i - 1] && f[i] > s[i] && (!ok(t[i]) || close[i] > t[i])) return 'buy';
      if (f[i - 1] >= s[i - 1] && f[i] < s[i]) return 'sell';
      return null;
    },
  },
  rsi_reversion: {
    name: 'Reversão do RSI',
    description: 'Compra quando o RSI volta para cima de 30 (saindo de sobrevenda); vende quando passa de 70.',
    rule: (ind, i) => {
      const r = ind.rsi;
      if (i < 1 || !ok(r[i], r[i - 1])) return null;
      if (r[i - 1] < 30 && r[i] >= 30) return 'buy';
      if (r[i] > 70) return 'sell';
      return null;
    },
  },
  macd: {
    name: 'MACD',
    description: 'Compra quando o MACD cruza a linha de sinal para cima; vende no cruzamento para baixo.',
    rule: (ind, i) => {
      const h = ind.macd.hist;
      if (i < 1 || !ok(h[i], h[i - 1])) return null;
      if (h[i - 1] <= 0 && h[i] > 0) return 'buy';
      if (h[i - 1] >= 0 && h[i] < 0) return 'sell';
      return null;
    },
  },
  breakout: {
    name: 'Rompimento de 20 períodos',
    description: 'Compra quando o preço fecha acima da máxima dos últimos 20 candles com volume acima da média; vende abaixo da mínima.',
    rule: (ind, i) => {
      const { close, don, volSma } = ind;
      if (!ok(don.hi[i], don.lo[i])) return null;
      if (close[i] > don.hi[i] && (!ok(volSma[i]) || volSmaOk(ind, i))) return 'buy';
      if (close[i] < don.lo[i]) return 'sell';
      return null;
    },
  },
};
const volSmaOk = (ind: Indicators, i: number) => ind.volume[i] >= ind.volSma[i];

export const strategyIds = Object.keys(STRATEGIES);

/** Placar de −100 (forte viés de baixa) a +100 (forte viés de alta), com os motivos em português. */
export function scoreAt(ind: Indicators, i: number) {
  const { close, ema9, ema21, ema50, ema200, rsi, macd, bb } = ind;
  const reasons: string[] = [];
  let s = 0;
  const p = close[i];
  if (ok(ema200[i])) {
    if (p > ema200[i]) { s += 20; reasons.push('Preço acima da média de 200 (tendência de alta de longo prazo)'); }
    else { s -= 20; reasons.push('Preço abaixo da média de 200 (tendência de baixa de longo prazo)'); }
  }
  if (ok(ema50[i], ema50[i - 5])) {
    if (ema50[i] > ema50[i - 5]) { s += 10; reasons.push('Média de 50 subindo'); } else { s -= 10; reasons.push('Média de 50 caindo'); }
  }
  if (ok(ema9[i], ema21[i])) {
    if (ema9[i] > ema21[i]) { s += 15; reasons.push('Média curta (9) acima da média de 21'); }
    else { s -= 15; reasons.push('Média curta (9) abaixo da média de 21'); }
  }
  const h = macd.hist;
  if (ok(h[i], h[i - 1])) {
    if (h[i] > 0 && h[i] > h[i - 1]) { s += 20; reasons.push('MACD positivo e ganhando força'); }
    else if (h[i] < 0 && h[i] < h[i - 1]) { s -= 20; reasons.push('MACD negativo e ganhando força'); }
    else if (h[i] > 0) s += 5; else s -= 5;
  }
  if (ok(rsi[i])) {
    if (rsi[i] < 30) { s += 15; reasons.push(`RSI ${rsi[i].toFixed(0)}: sobrevendido (pode repicar)`); }
    else if (rsi[i] > 70) { s -= 15; reasons.push(`RSI ${rsi[i].toFixed(0)}: sobrecomprado (pode corrigir)`); }
    else if (rsi[i] >= 50) s += 5; else s -= 5;
  }
  if (ok(bb.upper[i], bb.lower[i])) {
    if (p < bb.lower[i]) { s += 10; reasons.push('Abaixo da banda inferior de Bollinger'); }
    else if (p > bb.upper[i]) { s -= 5; reasons.push('Acima da banda superior de Bollinger (esticado)'); }
  }
  if (ok(ind.volSma[i]) && ind.volSma[i] > 0 && ind.volume[i] > 1.5 * ind.volSma[i]) {
    const up = p >= (close[i - 1] ?? p);
    s += up ? 10 : -10;
    reasons.push(up ? 'Volume forte na alta' : 'Volume forte na queda');
  }
  return { score: Math.max(-100, Math.min(100, s)), reasons };
}

export interface Analysis {
  price: number; changePct: number; score: number; signal: 'COMPRA' | 'VENDA' | 'AGUARDAR'; reasons: string[];
  rsi: number | null; atr: number | null; stop: number | null; target: number | null;
  trend: 'alta' | 'baixa' | 'lateral';
  /** % de vezes, no histórico deste ativo, em que um placar igual ou mais forte foi seguido de preço maior/menor. */
  history: { horizon: number; samples: number; hitRate: number | null; avgMovePct: number | null };
  lastBar: number;
}

/** Análise do último candle FECHADO (o candle em formação muda até fechar e geraria sinal falso). */
export function analyze(candles: Candle[], closedOnly = true): Analysis | null {
  const c = closedOnly && candles.length > 1 ? candles.slice(0, -1) : candles;
  if (c.length < 60) return null;
  const ind = computeAll(c);
  const i = c.length - 1;
  const { score, reasons } = scoreAt(ind, i);
  const signal = score >= 40 ? 'COMPRA' : score <= -40 ? 'VENDA' : 'AGUARDAR';
  const a = ind.atr[i], p = c[i].close;
  const trend = ok(ind.ema50[i], ind.ema200[i])
    ? (p > ind.ema50[i] && ind.ema50[i] > ind.ema200[i] ? 'alta' : p < ind.ema50[i] && ind.ema50[i] < ind.ema200[i] ? 'baixa' : 'lateral')
    : (ok(ind.ema21[i]) ? (p > ind.ema21[i] ? 'alta' : 'baixa') : 'lateral');

  // acerto histórico: em quantos candles do passado com placar no mesmo sentido o preço andou a favor em `horizon` candles
  const horizon = 10;
  let samples = 0, hits = 0, move = 0;
  if (signal !== 'AGUARDAR') {
    for (let j = 200; j < i - horizon; j++) {
      const sj = scoreAt(ind, j).score;
      if (signal === 'COMPRA' ? sj < 40 : sj > -40) continue;
      const m = (c[j + horizon].close - c[j].close) / c[j].close;
      samples++; move += m;
      if (signal === 'COMPRA' ? m > 0 : m < 0) hits++;
    }
  }
  const res: Analysis = {
    price: candles[candles.length - 1].close,
    changePct: c.length > 1 ? (candles[candles.length - 1].close / c[i - 1 >= 0 ? i - 1 : 0].close - 1) * 100 : 0,
    score, signal, reasons,
    rsi: ok(ind.rsi[i]) ? ind.rsi[i] : null, atr: ok(a) ? a : null,
    stop: ok(a) ? (signal === 'VENDA' ? p + 1.5 * a : p - 1.5 * a) : null,
    target: ok(a) ? (signal === 'VENDA' ? p - 3 * a : p + 3 * a) : null,
    trend,
    history: { horizon, samples, hitRate: samples >= 5 ? hits / samples : null, avgMovePct: samples ? (move / samples) * 100 : null },
    lastBar: c[i].time,
  };
  return res;
}

/** Sinal da estratégia do robô no último candle fechado. */
export function strategySignal(strategy: string, candles: Candle[]): { action: Action; bar: number; atr: number | null } {
  const s = STRATEGIES[strategy];
  const c = candles.length > 1 ? candles.slice(0, -1) : candles;
  if (!s || c.length < 30) return { action: null, bar: 0, atr: null };
  const ind = computeAll(c);
  const i = c.length - 1;
  const action = s.rule(ind, i);
  return { action, bar: c[i].time, atr: Number.isFinite(ind.atr[i]) ? ind.atr[i] : null };
}

// ---------------------------------------------------------------------------------------------
// BACKTEST: simula a estratégia no histórico. Só compra (mercado à vista), entra na abertura do candle
// seguinte ao sinal, sai no sinal de venda, no stop ou no alvo. Cobra taxa em cada ponta.
// ---------------------------------------------------------------------------------------------
export interface BacktestOptions { strategy: string; stopLossPct?: number | null; takeProfitPct?: number | null; feePct?: number }
export interface BacktestTrade { entryTime: number; entryPrice: number; exitTime: number; exitPrice: number; returnPct: number; reason: string }

export function backtest(candles: Candle[], o: BacktestOptions) {
  const s = STRATEGIES[o.strategy];
  if (!s) throw Object.assign(new Error('Estratégia desconhecida'), { status: 400 });
  const fee = (o.feePct ?? 0.1) / 100;
  const ind = computeAll(candles);
  const trades: BacktestTrade[] = [];
  const equity: { time: number; value: number }[] = [];
  let cash = 1, qty = 0, entry = 0, entryTime = 0, pending: Action = null;

  for (let i = 0; i < candles.length; i++) {
    const k = candles[i];
    // ordem do candle anterior executa na abertura deste
    if (pending === 'buy' && qty === 0) { entry = k.open; entryTime = k.time; qty = (cash * (1 - fee)) / entry; cash = 0; }
    else if (pending === 'sell' && qty > 0) close(k.open, k.time, 'sinal');
    pending = null;
    if (qty > 0) {
      const stop = o.stopLossPct ? entry * (1 - o.stopLossPct / 100) : null;
      const tp = o.takeProfitPct ? entry * (1 + o.takeProfitPct / 100) : null;
      if (stop && k.low <= stop) close(Math.min(stop, k.open), k.time, 'stop');      // gap abaixo do stop: sai na abertura
      else if (tp && k.high >= tp) close(Math.max(tp, k.open), k.time, 'alvo');
    }
    const a = s.rule(ind, i);
    if (a === 'buy' && qty === 0) pending = 'buy';
    else if (a === 'sell' && qty > 0) pending = 'sell';
    equity.push({ time: k.time, value: cash + qty * k.close });
  }
  if (qty > 0) close(candles[candles.length - 1].close, candles[candles.length - 1].time, 'aberta');

  function close(price: number, time: number, reason: string) {
    cash = qty * price * (1 - fee);
    trades.push({ entryTime, entryPrice: entry, exitTime: time, exitPrice: price,
                  returnPct: (price * (1 - fee) * (1 - fee) / entry - 1) * 100, reason });
    qty = 0;
  }

  let peak = -Infinity, maxDd = 0;
  for (const e of equity) { peak = Math.max(peak, e.value); maxDd = Math.max(maxDd, (peak - e.value) / peak); }
  const wins = trades.filter(t => t.returnPct > 0);
  const grossWin = wins.reduce((a, t) => a + t.returnPct, 0);
  const grossLoss = -trades.filter(t => t.returnPct <= 0).reduce((a, t) => a + t.returnPct, 0);
  const finalValue = equity.length ? equity[equity.length - 1].value : 1;
  return {
    trades,
    equity: equity.filter((_, i) => i % Math.max(1, Math.floor(equity.length / 300)) === 0 || i === equity.length - 1),
    stats: {
      trades: trades.length,
      winRate: trades.length ? wins.length / trades.length : null,
      totalReturnPct: (finalValue - 1) * 100,
      buyHoldPct: candles.length ? (candles[candles.length - 1].close / candles[0].open - 1) * 100 : 0,
      maxDrawdownPct: maxDd * 100,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
      avgTradePct: trades.length ? trades.reduce((a, t) => a + t.returnPct, 0) / trades.length : null,
    },
  };
}
