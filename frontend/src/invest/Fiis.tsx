import { useMemo, useState } from 'react';
import { useLoad } from '../ui/useLoad';
import { chartLink, compact, pct, price, tone } from './format';
import { Spinner } from './parts';

interface Fii { symbol: string; name?: string; price: number; changePct: number; volume?: number; dy12m: number | null; lastDividend: number | null;
                lastDividendDate: string | null; pvp: number | null; nota: number }

/** FIIs: ranking por dividend yield, P/VP e liquidez + simulador de renda mensal. */
export default function Fiis() {
  const { data, error } = useLoad<Fii[]>('/market/fiis');
  const [renda, setRenda] = useState('1000');
  const top5 = useMemo(() => (data ?? []).filter(f => f.dy12m).slice(0, 5), [data]);
  const dyMedio = top5.length ? top5.reduce((a, f) => a + (f.dy12m ?? 0), 0) / top5.length : null;
  const alvo = Number(renda.replace(/\./g, '').replace(',', '.')) || 0;
  const precisa = dyMedio ? (alvo * 12) / (dyMedio / 100) : null;

  return (
    <>
      <div className="page-head"><div><span className="eyebrow">Renda mensal</span><h1>Fundos imobiliários</h1></div></div>
      <div className="row">
        <div className="card wide">
          <div className="card-head"><h2>Ranking dos FIIs mais negociados</h2><span className="card-sub">Atualizado a cada 6 horas</span></div>
          {error ? <p className="msg err">{error}</p> : !data ? <Spinner label="Buscando rendimentos dos fundos…" /> : (
            <div className="table-wrap"><table className="tbl">
              <thead><tr><th>Fundo</th><th className="n">Cota</th><th className="n">Dia</th><th className="n">DY 12m</th><th className="n">Último rend.</th>
                <th className="n">P/VP</th><th className="n">Liquidez</th><th className="n">Nota</th></tr></thead>
              <tbody>{data.map(f => (
                <tr key={f.symbol}>
                  <td><a href={chartLink('b3', f.symbol, '&interval=1d')}><b>{f.symbol}</b></a>{f.name && <div className="card-sub">{f.name}</div>}</td>
                  <td className="n">{price(f.price, 'b3')}</td>
                  <td className={`n ${tone(f.changePct)}`}>{pct(f.changePct)}</td>
                  <td className="n"><b>{f.dy12m !== null ? `${f.dy12m.toFixed(1).replace('.', ',')}%` : '—'}</b></td>
                  <td className="n">{f.lastDividend !== null ? price(f.lastDividend, 'b3') : '—'}</td>
                  <td className={`n ${f.pvp !== null && f.pvp < 1 ? 'up' : ''}`}>{f.pvp?.toFixed(2).replace('.', ',') ?? '—'}</td>
                  <td className="n">{compact(f.volume)}</td>
                  <td className="n"><span className="nota" style={{ ['--n' as string]: f.nota }}>{f.nota}</span></td>
                </tr>))}</tbody>
            </table></div>)}
          <p className="card-sub" style={{ margin: 0 }}>Nota de 0 a 100: soma o dividend yield dos últimos 12 meses, P/VP (abaixo de 1 = cota mais barata que o patrimônio)
            e liquidez, e desconta DY acima de 18% (normalmente evento pontual ou risco). Rendimento passado não garante rendimento futuro.</p>
        </div>
        <div className="card narrow">
          <h2>Quanto investir para ter renda?</h2>
          <label className="field">Renda mensal desejada (R$)<input inputMode="decimal" value={renda} onChange={e => setRenda(e.target.value)} /></label>
          <div className="tile"><span>Patrimônio necessário (média dos 5 melhores, DY {dyMedio ? `${dyMedio.toFixed(1)}%` : '—'})</span>
            <b>{precisa ? precisa.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }) : '—'}</b></div>
          <p className="card-sub" style={{ margin: 0 }}>Os rendimentos de FIIs para pessoa física hoje são isentos de IR (confira a regra vigente). Diversifique entre
            fundos de tijolo (galpões, shoppings, lajes) e de papel (CRIs) para reduzir o risco.</p>
        </div>
      </div>
    </>
  );
}
