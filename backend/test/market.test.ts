import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ema, rsi, sma, macd, atr, donchian, type Candle } from '../src/market/indicators.js';
import { analyze, backtest, strategySignal, STRATEGIES } from '../src/market/strategies.js';
import { aggregate, normalizeSymbol } from '../src/market/util.js';

const close = (xs: number[], t0 = 0): Candle[] => xs.map((c, i) => ({ time: t0 + i * 3600, open: i ? xs[i - 1] : c, high: Math.max(c, i ? xs[i - 1] : c) + 0.5,
                                                                     low: Math.min(c, i ? xs[i - 1] : c) - 0.5, close: c, volume: 100 }));

test('SMA e EMA', () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3).slice(2), [2, 3, 4]);
  const e = ema([1, 2, 3, 4, 5], 3);
  assert.ok(Number.isNaN(e[1]));
  assert.equal(e[2], 2);                       // semente = média simples
  assert.equal(e[3], 4 * 0.5 + 2 * 0.5);       // k = 2/(3+1)
});

test('RSI: só alta = 100, só queda = 0, valor de referência', () => {
  assert.equal(rsi(Array.from({ length: 30 }, (_, i) => i + 1)).at(-1), 100);
  assert.equal(rsi(Array.from({ length: 30 }, (_, i) => 100 - i)).at(-1), 0);
  // série clássica do livro de Wilder (14 períodos): RSI ≈ 70,46 no primeiro valor
  const w = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28];
  assert.ok(Math.abs(rsi(w)[14] - 70.46) < 0.1, String(rsi(w)[14]));
});

test('MACD: histograma positivo em tendência de alta acelerando', () => {
  const up = Array.from({ length: 80 }, (_, i) => 100 + i * i * 0.05);
  const m = macd(up);
  assert.ok(m.line.at(-1)! > 0 && m.hist.at(-1)! > 0);
});

test('ATR e Donchian', () => {
  const c = close(Array.from({ length: 40 }, (_, i) => 100 + (i % 2)));
  assert.ok(atr(c).at(-1)! > 0);
  const d = donchian(c, 20);
  assert.ok(Number.isNaN(d.hi[19]) && d.hi[20] >= d.lo[20]);
});

test('placar: tendência de alta forte dá COMPRA, de baixa dá VENDA', () => {
  const up = close(Array.from({ length: 300 }, (_, i) => 100 * Math.exp(i * 0.004) + Math.sin(i) * 0.3));
  const a = analyze(up)!;
  assert.equal(a.trend, 'alta');
  assert.ok(a.score > 0, String(a.score));
  const down = close(Array.from({ length: 300 }, (_, i) => 500 * Math.exp(-i * 0.004) + Math.sin(i) * 0.3));
  const b = analyze(down)!;
  assert.equal(b.trend, 'baixa');
  assert.ok(b.score < 0 && b.stop! > b.price * 0.9);
});

test('análise ignora o candle em formação', () => {
  const xs = Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 5) * 5);
  const a = analyze(close(xs))!;
  assert.equal(a.lastBar, (xs.length - 2) * 3600);
});

test('cruzamento de médias gera compra no candle do cruzamento', () => {
  const xs = [...Array.from({ length: 60 }, (_, i) => 200 - i), ...Array.from({ length: 40 }, (_, i) => 141 + i * 3)];
  const c = close(xs);
  let found = -1;
  for (let n = 30; n <= c.length; n++) if (strategySignal('ema_cross', c.slice(0, n + 1)).action === 'buy') { found = n; break; }
  assert.ok(found > 60, `cruzou em ${found}`);
});

test('backtest: entra no candle seguinte, respeita stop e cobra taxa', () => {
  const xs = [...Array.from({ length: 60 }, (_, i) => 200 - i), ...Array.from({ length: 30 }, (_, i) => 141 + i * 3), ...Array.from({ length: 30 }, (_, i) => 228 - i * 5)];
  const r = backtest(close(xs), { strategy: 'ema_cross', stopLossPct: 5, feePct: 0.1 });
  assert.ok(r.stats.trades >= 1);
  const t = r.trades[0];
  assert.ok(t.entryTime > 60 * 3600);
  assert.ok(t.returnPct > -5.5, `perda ${t.returnPct}`);         // stop de 5% + taxas (e eventual gap)
  assert.ok(r.stats.maxDrawdownPct >= 0 && r.equity.length > 0);
  for (const id of Object.keys(STRATEGIES)) backtest(close(xs), { strategy: id });   // nenhuma estratégia quebra
});

test('agregação de 1h em 4h e validação de códigos', () => {
  const c = close([1, 2, 3, 4, 5, 6, 7, 8]);
  const a = aggregate(c, 4 * 3600);
  assert.equal(a.length, 2);
  assert.equal(a[0].close, 4); assert.equal(a[0].volume, 400);
  assert.equal(normalizeSymbol('crypto', 'btc/usdt'), 'BTCUSDT');
  assert.equal(normalizeSymbol('b3', 'petr4f'), 'PETR4');
  assert.equal(normalizeSymbol('b3', 'mxrf11'), 'MXRF11');
  assert.throws(() => normalizeSymbol('b3', 'PETR'));
  assert.throws(() => normalizeSymbol('crypto', 'BTC;DROP'));
});
