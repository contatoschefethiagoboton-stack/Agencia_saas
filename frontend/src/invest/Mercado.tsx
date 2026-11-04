import { useEffect, useState } from 'react';
import { api } from '../api';
import { Segmented } from '../ui/Shell';
import { chartLink, compact, MARKET_LABEL, pct, price, symbolLabel, tone, type Market } from './format';
import { SignalBadge, Spinner } from './parts';

interface Quote { symbol: string; name?: string; price: number; changePct: number; volume?: number; logo?: string; signal?: string | null; market?: Market }

/** Visão do mercado: mapa de calor dos mais negociados + lista pessoal com sinal atual. Atualiza a cada 15 s. */
export default function Mercado() {
  const [market, setMarket] = useState<Market>('crypto');
  const [top, setTop] = useState<Quote[] | null>(null);
  const [watch, setWatch] = useState<Quote[] | null>(null);
  const [err, setErr] = useState('');
  const [updated, setUpdated] = useState<Date | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      api<Quote[]>(`/market/overview?market=${market}&n=30`).then(r => { if (alive) { setTop(r); setErr(''); setUpdated(new Date()); } })
        .catch(e => alive && setErr(e.message));
      api<Quote[]>('/market/watchlist').then(r => alive && setWatch(r)).catch(() => {});
    };
    setTop(null); load();
    const t = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(t); };
  }, [market]);

  const up = top?.filter(q => q.changePct > 0).length ?? 0;
  const best = top?.slice().sort((a, b) => b.changePct - a.changePct)[0];
  const worst = top?.slice().sort((a, b) => a.changePct - b.changePct)[0];
  async function remove(q: Quote) { await api(`/market/watchlist/${q.market}/${q.symbol}`, { method: 'DELETE' }); setWatch(w => w?.filter(x => x !== q) ?? null); }

  return (
    <>
      <div className="page-head">
        <div><span className="eyebrow">Mercado ao vivo</span><h1>Visão geral</h1></div>
        <Segmented label="Mercado" value={market} onChange={setMarket} options={[['crypto', 'Cripto'], ['b3', 'B3'], ['us', 'EUA']]} />
      </div>
      {err && <p className="msg err">{err}</p>}
      <div className="grid-kpi">
        <div className="card kpi"><span className="kpi-label">Subindo hoje</span><div className="kpi-value"><b>{top ? `${up}/${top.length}` : '—'}</b>
          {top && <span className={`delta ${up >= top.length / 2 ? '' : 'neg'}`}>{up >= top.length / 2 ? 'mercado positivo' : 'mercado negativo'}</span>}</div></div>
        <div className="card kpi"><span className="kpi-label">Maior alta</span><div className="kpi-value"><b>{best ? symbolLabel(best.symbol, market) : '—'}</b>
          {best && <span className="delta">{pct(best.changePct)}</span>}</div></div>
        <div className="card kpi"><span className="kpi-label">{worst && worst.changePct >= 0 ? 'Menor alta' : 'Maior queda'}</span><div className="kpi-value"><b>{worst ? symbolLabel(worst.symbol, market) : '—'}</b>
          {worst && <span className={`delta${worst.changePct < 0 ? ' neg' : ''}`}>{pct(worst.changePct)}</span>}</div></div>
      </div>

      <div className="card">
        <div className="card-head"><h2>Mapa de calor · {MARKET_LABEL[market]}</h2>
          <span className="card-sub">{updated ? `Atualizado às ${updated.toLocaleTimeString('pt-BR')}` : ''} · os mais negociados</span></div>
        {!top ? <Spinner /> : (
          <div className="heatmap">
            {top.map(q => (
              <a key={q.symbol} href={chartLink(market, q.symbol)} className="heat" style={{ background: heat(q.changePct) }}
                 title={`${q.name ?? q.symbol}: ${pct(q.changePct)}`}>
                <b>{symbolLabel(q.symbol, market).replace('/USDT', '')}</b>
                <span>{pct(q.changePct)}</span>
                <small>{price(q.price, market)}</small>
              </a>))}
          </div>)}
      </div>

      <div className="card">
        <div className="card-head"><h2>Minha lista</h2><span className="card-sub">Abra um gráfico e clique em "Acompanhar" para receber avisos de sinal</span></div>
        {!watch ? <Spinner /> : !watch.length ? <p className="card-sub">Sua lista está vazia.</p> : (
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>Ativo</th><th>Mercado</th><th className="n">Preço</th><th className="n">Dia</th><th className="n">Volume</th><th>Sinal</th><th /></tr></thead>
            <tbody>{watch.map(q => (
              <tr key={q.market + q.symbol}>
                <td><a href={chartLink(q.market!, q.symbol)}><b>{symbolLabel(q.symbol, q.market!)}</b></a></td>
                <td>{MARKET_LABEL[q.market!]}</td>
                <td className="n">{price(q.price, q.market)}</td>
                <td className={`n ${tone(q.changePct)}`}>{pct(q.changePct)}</td>
                <td className="n">{compact(q.volume)}</td>
                <td><SignalBadge signal={q.signal ?? 'AGUARDAR'} /></td>
                <td className="n"><button className="link-btn" onClick={() => remove(q)}>Remover</button></td>
              </tr>))}</tbody>
          </table></div>)}
      </div>
    </>
  );
}

function heat(ch: number) {
  const a = Math.min(Math.abs(ch) / 8, 1) * 0.75 + 0.12;
  return ch >= 0 ? `rgba(46,189,133,${a})` : `rgba(246,70,93,${a})`;
}
