import { useState } from 'react';
import { useLoad } from '../ui/useLoad';
import { Segmented } from '../ui/Shell';
import { LineChart } from '../ui/Charts';

interface M {
  instagram: null | { conta: string; seguidores?: number; reach?: number; views?: number; accounts_engaged?: number; total_interactions?: number;
    alcanceDiario?: { dia: string; valor: number }[]; melhores?: { legenda: string; tipo: string; data: string; curtidas: number; comentarios: number; link: string }[] };
  anuncios: null | { conta: string; gasto: number; alcance: number; cliques: number; cpc: number | null; conversas: number };
  erros: string[];
}
const n = (v?: number | null) => v == null ? '—' : v.toLocaleString('pt-BR');
const real = (v?: number | null) => v == null ? '—' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** Números reais do Instagram e do Meta Ads do cliente. */
export default function Metricas() {
  const [dias, setDias] = useState<'7' | '30'>('30');
  const { data: m, error } = useLoad<M>(`/client/metrics?days=${dias}`);

  const serie = m?.instagram?.alcanceDiario ?? [];
  const top = Math.max(10, ...serie.map(s => s.valor));
  const mag = 10 ** Math.floor(Math.log10(top));
  const max = Math.ceil(top / mag) * mag;                     // teto "redondo" para o eixo Y
  return (
    <>
      <header className="page-head" style={{ marginTop: 16 }}>
        <div><span className="eyebrow">Números reais das suas redes</span><h2 style={{ margin: 0, fontSize: 24 }}>Resultados</h2></div>
        <Segmented label="Período" value={dias} onChange={setDias} options={[['7', '7 dias'], ['30', '30 dias']]} />
      </header>
      {error && <p className="msg err">{error}</p>}
      {!m && !error && <p className="card-sub">Buscando na Meta…</p>}
      {m?.erros.map(e => <p key={e} className="msg warn">{e}. Se persistir, reconecte em <a href="#conexoes">Conexões</a>.</p>)}

      {m?.instagram && (
        <>
          <section className="grid-kpi" aria-label={`Instagram ${m.instagram.conta}`}>
            {([['Pessoas alcançadas', m.instagram.reach], ['Visualizações', m.instagram.views],
               ['Contas que interagiram', m.instagram.accounts_engaged], ['Curtidas, comentários e salvos', m.instagram.total_interactions]] as const)
              .map(([l, v]) => <article key={l} className="card kpi"><span className="kpi-label">{l}</span>
                <div className="kpi-value"><b>{n(v)}</b></div><span className="card-sub">Instagram {m.instagram!.conta}</span></article>)}
          </section>
          {serie.length > 1 && (
            <section className="card">
              <div className="card-head"><div><h2>Alcance por dia</h2><span className="card-sub">{n(m.instagram.seguidores)} seguidores</span></div></div>
              <LineChart label="Alcance diário no Instagram" unit="" labels={serie.map(s => s.dia.slice(8, 10) + '/' + s.dia.slice(5, 7))} max={max}
                         series={[{ name: 'Alcance', vals: serie.map(s => s.valor), color: 'var(--teal)', area: true }]} />
            </section>)}
          {!!m.instagram.melhores?.length && (
            <section className="card"><h2>Posts que mais engajaram</h2>
              <ol style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 8 }}>
                {m.instagram.melhores.map(p => <li key={p.link}><a href={p.link} target="_blank" rel="noreferrer">{p.legenda || p.tipo}</a>
                  <span className="card-sub"> · {p.curtidas} curtidas · {p.comentarios} comentários</span></li>)}
              </ol></section>)}
        </>
      )}

      {m?.anuncios && (
        <section className="card">
          <h2>Anúncios · {m.anuncios.conta}</h2>
          <div className="grid-kpi" style={{ marginTop: 12 }}>
            {([['Investido', real(m.anuncios.gasto)], ['Pessoas alcançadas', n(m.anuncios.alcance)], ['Cliques', n(m.anuncios.cliques)],
               ['Custo por clique', real(m.anuncios.cpc)], ['Conversas iniciadas', n(m.anuncios.conversas)]] as const)
              .map(([l, v]) => <div key={l} className="tile"><span>{l}</span><b>{v}</b></div>)}
          </div>
        </section>
      )}
    </>
  );
}
