import { useEffect, useRef } from 'react';
import { createChart, createSeriesMarkers, CandlestickSeries, HistogramSeries, LineSeries, CrosshairMode, LineStyle,
         type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';

export interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }
export interface ChartData {
  candles: Candle[];
  ind: Record<'ema9' | 'ema21' | 'ema200' | 'bbUpper' | 'bbLower' | 'rsi' | 'macd' | 'macdSignal' | 'macdHist', (number | null)[]>;
  markers: { time: number; side: 'buy' | 'sell' }[];
}
export interface Overlays { emas: boolean; bb: boolean; rsi: boolean; macd: boolean; markers: boolean }

const C = { up: '#2EBD85', down: '#F6465D', grid: 'rgba(42,54,84,.45)', text: '#95A2BC', ema9: '#F2C14E', ema21: '#6C8CFF', ema200: '#C4B5FD',
            bb: 'rgba(155,123,255,.55)', rsi: '#34C6B4', macd: '#6C8CFF', signal: '#F2994A' };
const t = (x: number) => x as UTCTimestamp;
const line = (times: number[], vals: (number | null)[]) =>
  vals.map((v, i) => (v === null ? { time: t(times[i]) } : { time: t(times[i]), value: v }));

/**
 * Gráfico de velas profissional: médias, Bollinger, volume, RSI e MACD em painéis, marcações de compra/venda.
 * `live` recebe o candle em formação (WebSocket) e atualiza sem redesenhar tudo.
 */
export function CandleChart({ data, overlays, live, height = 560, digits = 2 }:
  { data: ChartData; overlays: Overlays; live?: Candle | null; height?: number; digits?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candleSeries = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volSeries = useRef<ISeriesApi<'Histogram'> | null>(null);

  useEffect(() => {
    if (!box.current) return;
    const ch = createChart(box.current, {
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor: C.text, fontFamily: 'Manrope, system-ui, sans-serif', fontSize: 12,
                panes: { separatorColor: '#212B47', separatorHoverColor: '#2D3A5C', enableResize: true } },
      grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#212B47' },
      timeScale: { borderColor: '#212B47', timeVisible: true, secondsVisible: false, rightOffset: 6 },
      localization: { locale: 'pt-BR' },
    });
    chart.current = ch;
    const times = data.candles.map(c => c.time);

    const cs = ch.addSeries(CandlestickSeries, { upColor: C.up, downColor: C.down, borderVisible: false, wickUpColor: C.up, wickDownColor: C.down,
                                                 priceFormat: { type: 'price', precision: digits, minMove: 1 / 10 ** digits } });
    cs.setData(data.candles.map(c => ({ ...c, time: t(c.time) })));
    candleSeries.current = cs;

    const vs = ch.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
    ch.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    vs.setData(data.candles.map(c => ({ time: t(c.time), value: c.volume, color: c.close >= c.open ? 'rgba(46,189,133,.35)' : 'rgba(246,70,93,.35)' })));
    volSeries.current = vs;

    const thin = { lineWidth: 1 as const, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false };
    if (overlays.emas) {
      ch.addSeries(LineSeries, { ...thin, color: C.ema9, lineWidth: 2 }).setData(line(times, data.ind.ema9));
      ch.addSeries(LineSeries, { ...thin, color: C.ema21, lineWidth: 2 }).setData(line(times, data.ind.ema21));
      ch.addSeries(LineSeries, { ...thin, color: C.ema200, lineWidth: 2, lineStyle: LineStyle.Dashed }).setData(line(times, data.ind.ema200));
    }
    if (overlays.bb) {
      ch.addSeries(LineSeries, { ...thin, color: C.bb }).setData(line(times, data.ind.bbUpper));
      ch.addSeries(LineSeries, { ...thin, color: C.bb }).setData(line(times, data.ind.bbLower));
    }
    if (overlays.markers && data.markers.length) {
      createSeriesMarkers(cs, data.markers.map(m => m.side === 'buy'
        ? { time: t(m.time), position: 'belowBar' as const, color: C.up, shape: 'arrowUp' as const, text: 'C' }
        : { time: t(m.time), position: 'aboveBar' as const, color: C.down, shape: 'arrowDown' as const, text: 'V' }));
    }
    let pane = 1;
    if (overlays.rsi) {
      const r = ch.addSeries(LineSeries, { color: C.rsi, lineWidth: 2, priceLineVisible: false, priceFormat: { type: 'price', precision: 1, minMove: 0.1 }, autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) }, pane);
      r.setData(line(times, data.ind.rsi));
      r.createPriceLine({ price: 70, color: 'rgba(246,70,93,.6)', lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false, title: '' });
      r.createPriceLine({ price: 30, color: 'rgba(46,189,133,.6)', lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false, title: '' });
      pane++;
    }
    if (overlays.macd) {
      ch.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, pane)
        .setData(data.ind.macdHist.map((v, i) => (v === null ? { time: t(times[i]) } : { time: t(times[i]), value: v, color: v >= 0 ? 'rgba(46,189,133,.6)' : 'rgba(246,70,93,.6)' })));
      ch.addSeries(LineSeries, { ...thin, color: C.macd, lineWidth: 2 }, pane).setData(line(times, data.ind.macd));
      ch.addSeries(LineSeries, { ...thin, color: C.signal, lineWidth: 2 }, pane).setData(line(times, data.ind.macdSignal));
      pane++;
    }
    const panes = ch.panes();
    for (let i = 1; i < panes.length; i++) panes[i].setHeight(110);
    ch.timeScale().setVisibleLogicalRange({ from: Math.max(0, data.candles.length - 160), to: data.candles.length + 4 });
    return () => { ch.remove(); chart.current = null; candleSeries.current = null; volSeries.current = null; };
  }, [data, overlays, digits]);

  useEffect(() => {
    if (!live || !candleSeries.current) return;
    const last = data.candles[data.candles.length - 1];
    if (last && live.time < last.time) return;
    try {
      candleSeries.current.update({ ...live, time: t(live.time) });
      volSeries.current?.update({ time: t(live.time), value: live.volume, color: live.close >= live.open ? 'rgba(46,189,133,.35)' : 'rgba(246,70,93,.35)' });
    } catch { /* candle antigo fora de ordem: ignora */ }
  }, [live, data]);

  return <div ref={box} className="candle-chart" style={{ height }} role="img" aria-label="Gráfico de velas com indicadores" />;
}

/** Curva de patrimônio do backtest (linha simples). */
export function EquityChart({ points, height = 200 }: { points: { time: number; value: number }[]; height?: number }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!box.current || !points.length) return;
    const ch = createChart(box.current, {
      autoSize: true, layout: { background: { color: 'transparent' }, textColor: C.text, fontFamily: 'Manrope, system-ui, sans-serif' },
      grid: { vertLines: { visible: false }, horzLines: { color: C.grid } }, rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false },
      handleScroll: false, handleScale: false,
    });
    const up = points[points.length - 1].value >= 1;
    const s = ch.addSeries(LineSeries, { color: up ? C.up : C.down, lineWidth: 2, priceLineVisible: false,
                                         priceFormat: { type: 'custom', formatter: (v: number) => `${((v - 1) * 100).toFixed(1)}%` } });
    s.setData(points.map(p => ({ time: t(p.time), value: p.value })));
    s.createPriceLine({ price: 1, color: '#2D3A5C', lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false, title: '' });
    ch.timeScale().fitContent();
    return () => ch.remove();
  }, [points]);
  return <div ref={box} style={{ height }} role="img" aria-label="Curva de resultado da estratégia" />;
}
