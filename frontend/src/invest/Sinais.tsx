import { useEffect, useState } from 'react';
import { api } from '../api';
import { Segmented } from '../ui/Shell';
import { chartLink, INTERVAL_LABEL, MARKET_LABEL, pct, price, symbolLabel, tone, type Interval, type Market } from './format';
import { SignalBadge, Spinner } from './parts';

interface Row { symbol: string; name?: string; price: number; changePct: number; score: number; signal: string; trend: string; rsi: number | null;
                stop: number | null; target: number | null; history: { hitRate: number | null; samples: number }; reasons: string[] }

/** Scanner: placar técnico dos ativos mais negociados, recalculado a cada 4 minutos. */
export default function Sinais() {
  const [market, setMarket] = useState<Market>('crypto');
  const [iv, setIv] = useState<Interval>('1h');
  const [filter, setFilter] = useState<'todos' | 'COMPRA' | 'VENDA'>('todos');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    setRows(null); setErr('');
    api<Row[]>(`/market/scanner?market=${market}&interval=${iv}`).then(setRows).catch(e => setErr(e.message));
  }, [market, iv]);
  const shown = rows?.filter(r => filter === 'todos' || r.signal === filter) ?? [];
  const changeMarket = (m: Market) => { setMarket(m); setIv(m === 'crypto' ? '1h' : '1d'); };

  return (
    <>
      <div className="page-head">
        <div><span className="eyebrow">Hora de comprar e de vender</span><h1>Sinais</h1></div>
        <Segmented label="Mercado" value={market} onChange={changeMarket} options={[['crypto', 'Cripto'], ['b3', 'B3'], ['us', 'EUA']]} />
      </div>
      <div className="card">
        <div className="card-head">
          <div className="actions">
            <Segmented label="Filtro" value={filter} onChange={setFilter} options={[['todos', 'Todos'], ['COMPRA', 'Compra'], ['VENDA', 'Venda']]} />
            <select className="select" aria-label="Tempo gráfico" value={iv} onChange={e => setIv(e.target.value as Interval)}>
              {(['15m', '1h', '4h', '1d'] as Interval[]).map(i => <option key={i} value={i}>{INTERVAL_LABEL[i]}</option>)}
            </select>
          </div>
          <span className="card-sub">{MARKET_LABEL[market]} · {rows?.length ?? 0} ativos analisados · placar de −100 a +100</span>
        </div>
        {err ? <p className="msg err">{err}</p> : !rows ? <Spinner label="Analisando o mercado… (pode levar alguns segundos)" /> : !shown.length ? <p className="card-sub">Nenhum ativo com esse sinal agora.</p> : (
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>Ativo</th><th className="n">Preço</th><th className="n">Dia</th><th>Sinal</th><th className="n">Placar</th><th>Tendência</th>
              <th className="n">RSI</th><th className="n">Stop</th><th className="n">Alvo</th><th className="n">Acerto hist.</th></tr></thead>
            <tbody>{shown.map(r => (
              <tr key={r.symbol}>
                <td><a href={chartLink(market, r.symbol, `&interval=${iv}`)}><b>{symbolLabel(r.symbol, market)}</b></a>
                  {r.name && <div className="card-sub">{r.name}</div>}</td>
                <td className="n">{price(r.price, market)}</td>
                <td className={`n ${tone(r.changePct)}`}>{pct(r.changePct)}</td>
                <td><SignalBadge signal={r.signal} /></td>
                <td className="n"><span className={`score ${tone(r.score)}`}>{r.score > 0 ? '+' : ''}{r.score}</span></td>
                <td className={r.trend === 'alta' ? 'up' : r.trend === 'baixa' ? 'down' : ''}>{r.trend}</td>
                <td className="n">{r.rsi?.toFixed(0) ?? '—'}</td>
                <td className="n">{r.signal === 'AGUARDAR' ? '—' : price(r.stop, market)}</td>
                <td className="n">{r.signal === 'AGUARDAR' ? '—' : price(r.target, market)}</td>
                <td className="n" title={`${r.history.samples} casos no histórico`}>{r.history.hitRate !== null ? `${(r.history.hitRate * 100).toFixed(0)}%` : '—'}</td>
              </tr>))}</tbody>
          </table></div>)}
        <p className="card-sub" style={{ margin: 0 }}>Como ler: COMPRA com placar ≥ 40 e VENDA com placar ≤ −40. "Acerto hist." mostra em quantos % das vezes um sinal parecido
          neste mesmo ativo foi seguido de movimento a favor 10 candles depois. Stop e alvo usam a volatilidade (ATR).</p>
      </div>
    </>
  );
}
