import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { Segmented } from '../ui/Shell';
import { CandleChart, EquityChart, type Candle, type ChartData, type Overlays } from './CandleChart';
import { INTERVALS, INTERVAL_LABEL, MARKET_LABEL, price, priceDigits, pct, symbolLabel, tone, type Interval, type Market } from './format';
import { SignalBadge, ScoreGauge, useStrategies } from './parts';
import { AlertasPreco } from './Avisos';

export interface Analysis {
  price: number; changePct: number; score: number; signal: 'COMPRA' | 'VENDA' | 'AGUARDAR'; reasons: string[];
  rsi: number | null; stop: number | null; target: number | null; trend: 'alta' | 'baixa' | 'lateral';
  history: { horizon: number; samples: number; hitRate: number | null; avgMovePct: number | null };
}
interface Resp extends ChartData { symbol: string; analysis: Analysis | null }
interface Bt { stats: { trades: number; winRate: number | null; totalReturnPct: number; buyHoldPct: number; maxDrawdownPct: number; profitFactor: number | null };
               equity: { time: number; value: number }[]; from: number; to: number }

const DEFAULT: Record<Market, string> = { crypto: 'BTCUSDT', b3: 'PETR4', us: 'AAPL' };
const DEF_IV: Record<Market, Interval> = { crypto: '1h', b3: '1d', us: '1d' };

export default function Grafico({ query }: { query: URLSearchParams }) {
  const [market, setMarket] = useState<Market>((query.get('market') as Market) || 'crypto');
  const [symbol, setSymbol] = useState(query.get('symbol') || DEFAULT[market]);
  const [input, setInput] = useState(symbol);
  const [interval, setIv] = useState<Interval>((query.get('interval') as Interval) || DEF_IV[market]);
  const [strategy, setStrategy] = useState(query.get('strategy') || 'score');
  const [ov, setOv] = useState<Overlays>({ emas: true, bb: false, rsi: true, macd: false, markers: true });
  const [data, setData] = useState<Resp | null>(null);
  const [err, setErr] = useState('');
  const [live, setLive] = useState<Candle | null>(null);
  const [bt, setBt] = useState<Bt | null>(null);
  const [btBusy, setBtBusy] = useState(false);
  const [stop, setStop] = useState('');
  const [take, setTake] = useState('');
  const [msg, setMsg] = useState('');
  const strategies = useStrategies();
  const [suggest, setSuggest] = useState<{ symbol: string }[]>([]);
  const loadId = useRef(0);

  useEffect(() => { api<{ symbol: string }[]>(`/market/overview?market=${market}&n=60`).then(setSuggest).catch(() => setSuggest([])); }, [market]);

  // carrega gráfico; fora da cripto (sem WebSocket público) atualiza a cada 30 s
  useEffect(() => {
    const id = ++loadId.current;
    const load = (first: boolean) => {
      if (first) { setErr(''); setData(null); setLive(null); }
      api<Resp>(`/market/chart?market=${market}&symbol=${encodeURIComponent(symbol)}&interval=${interval}&strategy=${strategy}`)
        .then(d => { if (id === loadId.current) setData(d); })
        .catch(e => { if (id === loadId.current && first) setErr(e.message); });
    };
    load(true);
    const timer = setInterval(() => load(false), market === 'crypto' ? 120_000 : 30_000);
    setBt(null);
    return () => clearInterval(timer);
  }, [market, symbol, interval, strategy]);

  // cripto: preço ao vivo direto da Binance (WebSocket público), sem passar pelo servidor
  useEffect(() => {
    if (market !== 'crypto') return;
    let ws: WebSocket | null = null, closed = false, retry: ReturnType<typeof setTimeout>;
    const open = () => {
      ws = new WebSocket(`wss://data-stream.binance.vision/ws/${symbol.toLowerCase()}@kline_${interval}`);
      ws.onmessage = ev => {
        const k = JSON.parse(ev.data).k;
        if (k) setLive({ time: Math.floor(k.t / 1000), open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.q });
      };
      ws.onclose = () => { if (!closed) retry = setTimeout(open, 3000); };
    };
    open();
    return () => { closed = true; clearTimeout(retry); ws?.close(); };
  }, [market, symbol, interval]);

  const last = live?.close ?? data?.candles[data.candles.length - 1]?.close ?? null;
  const prevClose = data && data.candles.length > 1 ? data.candles[data.candles.length - 2].close : null;
  const digits = useMemo(() => {
    return priceDigits(data?.candles[data.candles.length - 1]?.close ?? 1, market);
  }, [data, market]);
  const a = data?.analysis;

  function changeMarket(m: Market) { setMarket(m); setSymbol(DEFAULT[m]); setInput(DEFAULT[m]); setIv(DEF_IV[m]); }
  function go(e?: React.FormEvent) { e?.preventDefault(); const s = input.trim().toUpperCase().replace(/[\s/-]/g, ''); if (s) setSymbol(s); }

  async function runBacktest() {
    setBtBusy(true); setMsg('');
    try {
      setBt(await api<Bt>('/market/backtest', { body: { market, symbol, interval, strategy,
        stopLossPct: stop ? Number(stop.replace(',', '.')) : null, takeProfitPct: take ? Number(take.replace(',', '.')) : null } }));
    } catch (e) { setMsg((e as Error).message); }
    setBtBusy(false);
  }
  async function watch() {
    try { await api('/market/watchlist', { body: { market, symbol } }); setMsg(`${symbol} entrou na sua lista. Você recebe aviso quando o sinal mudar.`); }
    catch (e) { setMsg((e as Error).message); }
  }
  const toggle = (k: keyof Overlays) => setOv(o => ({ ...o, [k]: !o[k] }));
  const robotLink = `#robos?novo=1&market=${market}&symbol=${symbol}&interval=${interval}&strategy=${strategy}${stop ? `&stop=${stop}` : ''}${take ? `&take=${take}` : ''}`;

  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">Gráfico · {MARKET_LABEL[market]}</span>
          <h1 className="ticker-title">
            {symbolLabel(symbol, market)}
            <span className={`ticker-price ${tone(last && prevClose ? last - prevClose : 0)}`}>{price(last, market)}</span>
            {market === 'crypto' && live && <span className="live-dot" title="Preço ao vivo">AO VIVO</span>}
          </h1>
        </div>
        <Segmented label="Mercado" value={market} onChange={changeMarket} options={[['crypto', 'Cripto'], ['b3', 'B3'], ['us', 'EUA']]} />
      </div>

      <div className="card chart-card">
        <div className="chart-toolbar">
          <form className="symbol-search" onSubmit={go}>
            <input aria-label="Código do ativo" list="sym-list" value={input} onChange={e => setInput(e.target.value)}
                   placeholder={market === 'crypto' ? 'BTCUSDT' : market === 'b3' ? 'PETR4, MXRF11' : 'AAPL'} />
            <datalist id="sym-list">{suggest.map(s => <option key={s.symbol} value={s.symbol} />)}</datalist>
            <button className="btn">Abrir</button>
          </form>
          <div className="seg seg-sm" role="group" aria-label="Tempo gráfico">
            {INTERVALS.map(iv => <button key={iv} aria-pressed={iv === interval} onClick={() => setIv(iv)} title={INTERVAL_LABEL[iv]}>{iv}</button>)}
          </div>
          <select className="select" aria-label="Estratégia" value={strategy} onChange={e => setStrategy(e.target.value)}>
            {strategies.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <div className="chips" role="group" aria-label="Indicadores">
            {([['emas', 'Médias'], ['bb', 'Bollinger'], ['rsi', 'RSI'], ['macd', 'MACD'], ['markers', 'Sinais']] as [keyof Overlays, string][])
              .map(([k, l]) => <button key={k} className="chip" aria-pressed={ov[k]} onClick={() => toggle(k)}>{l}</button>)}
          </div>
        </div>
        {err ? <p className="msg err">{err}</p>
          : !data ? <div className="chart-skeleton"><span className="spinner" /> Carregando gráfico…</div>
          : <CandleChart data={data} overlays={ov} live={live} digits={digits} height={ov.rsi || ov.macd ? 620 : 520} />}
        {ov.emas && <div className="legend"><span><i style={{ background: '#F2C14E' }} />Média 9</span><span><i style={{ background: '#6C8CFF' }} />Média 21</span><span><i style={{ background: '#C4B5FD' }} />Média 200</span>
          {ov.markers && <span><b className="up">C</b> compra · <b className="down">V</b> venda (estratégia escolhida)</span>}</div>}
      </div>

      <div className="row">
        <div className="card half">
          <div className="card-head"><h2>Análise agora</h2>{a && <SignalBadge signal={a.signal} big />}</div>
          {!a ? <p className="card-sub">{data ? 'Histórico curto demais para analisar.' : '…'}</p> : <>
            <ScoreGauge score={a.score} />
            <div className="tiles tiles-3">
              <div className="tile"><span>Tendência</span><b className={a.trend === 'alta' ? 'up' : a.trend === 'baixa' ? 'down' : ''}>{a.trend}</b></div>
              <div className="tile"><span>RSI</span><b>{a.rsi?.toFixed(0) ?? '—'}</b></div>
              <div className="tile"><span>Acerto histórico</span><b>{a.history.hitRate !== null ? `${(a.history.hitRate * 100).toFixed(0)}%` : '—'}</b></div>
              <div className="tile"><span>Stop sugerido</span><b>{price(a.stop, market)}</b></div>
              <div className="tile"><span>Alvo sugerido</span><b>{price(a.target, market)}</b></div>
              <div className="tile"><span>Variação do candle</span><b className={tone(a.changePct)}>{pct(a.changePct)}</b></div>
            </div>
            <ul className="reasons">{a.reasons.map(r => <li key={r}>{r}</li>)}</ul>
            <p className="card-sub" style={{ margin: 0 }}>
              {a.history.samples ? `Acerto histórico: das ${a.history.samples} vezes em que este ativo deu sinal parecido, o preço andou a favor em ${(a.history.hitRate! * 100).toFixed(0)}% delas ${a.history.horizon} candles depois (média ${pct(a.history.avgMovePct)}). ` : ''}
              Sinal técnico calculado no último candle fechado. Não é garantia de resultado nem recomendação de investimento.
            </p>
          </>}
          <div className="actions">
            <button className="btn" onClick={watch}>Acompanhar e receber avisos</button>
            <a className="btn btn-primary" href={robotLink}>Criar robô com esta estratégia</a>
          </div>
          <AlertasPreco key={market + symbol} preset={{ market, symbol }} />
          {msg && <p className="msg ok" role="status">{msg}</p>}
        </div>

        <div className="card half">
          <div className="card-head"><h2>Teste no passado (backtest)</h2></div>
          <p className="card-sub" style={{ margin: 0 }}>Simula a estratégia <b>{strategies.find(s => s.id === strategy)?.name ?? strategy}</b> nos últimos 1.000 candles de {symbol},
            com taxa de 0,1% por operação. {strategies.find(s => s.id === strategy)?.description}</p>
          <div className="form-grid">
            <label className="field">Stop (% de perda)<input inputMode="decimal" placeholder="ex.: 3" value={stop} onChange={e => setStop(e.target.value)} /></label>
            <label className="field">Alvo (% de ganho)<input inputMode="decimal" placeholder="ex.: 8" value={take} onChange={e => setTake(e.target.value)} /></label>
          </div>
          <button className="btn btn-primary" onClick={runBacktest} disabled={btBusy}>{btBusy ? 'Simulando…' : 'Rodar backtest'}</button>
          {bt && <>
            <div className="tiles tiles-3">
              <div className="tile"><span>Resultado</span><b className={tone(bt.stats.totalReturnPct)}>{pct(bt.stats.totalReturnPct, 1)}</b></div>
              <div className="tile"><span>Só comprar e segurar</span><b className={tone(bt.stats.buyHoldPct)}>{pct(bt.stats.buyHoldPct, 1)}</b></div>
              <div className="tile"><span>Operações</span><b>{bt.stats.trades}</b></div>
              <div className="tile"><span>Acerto</span><b>{bt.stats.winRate !== null ? `${(bt.stats.winRate * 100).toFixed(0)}%` : '—'}</b></div>
              <div className="tile"><span>Maior queda</span><b className="down">-{bt.stats.maxDrawdownPct.toFixed(1)}%</b></div>
              <div className="tile"><span>Fator de lucro</span><b>{bt.stats.profitFactor?.toFixed(2) ?? '—'}</b></div>
            </div>
            <EquityChart points={bt.equity} />
            <p className="card-sub" style={{ margin: 0 }}>Período: {new Date(bt.from * 1000).toLocaleDateString('pt-BR')} a {new Date(bt.to * 1000).toLocaleDateString('pt-BR')}.
              Resultado passado não garante resultado futuro.</p>
          </>}
        </div>
      </div>
    </>
  );
}
