import { useState } from 'react';
import { cliente, type PeriodoCliente } from '../data/demo';
import { stackedBars, ticks } from '../ui/charts';
import { Legend, ProgressBar } from '../ui/Charts';
import { Segmented } from '../ui/Shell';

const horas = ['6h', '8h', '10h', '12h', '14h', '16h', '18h', '20h'];
const dicas = ['Pessoas diferentes que viram seus posts e anúncios', 'Conversas iniciadas por clientes',
               'Pedidos e encomendas fechados no WhatsApp', 'Quanto cada novo contato custou em anúncios'];
const rotulos = ['Pessoas alcançadas', 'Mensagens recebidas', 'Encomendas pelo WhatsApp', 'Custo por contato'];

/** Prévia dos relatórios de alcance, anúncios e WhatsApp (dados de exemplo até as integrações estarem conectadas). */
export default function PainelCliente() {
  const [periodo, setPeriodo] = useState<PeriodoCliente>('mes');
  const D = cliente.series[periodo];
  const barras = stackedBars(D.pago, D.org, D.max);
  const C = 2 * Math.PI * 46;
  const maxPost = Math.max(...cliente.posts.map(p => p[2]));

  return (
    <>
      <header className="page-head" style={{ marginTop: 16 }}>
        <div><span className="eyebrow">Prévia dos relatórios</span><h2 style={{ margin: 0, fontSize: 24 }}>Como foi seu {D.nome}</h2></div>
        <Segmented label="Período" value={periodo} onChange={setPeriodo} options={[['semana', 'Semana'], ['mes', 'Mês']]} />
      </header>
      <p className="banner">Números de exemplo. Os seus aparecem aqui assim que o Instagram ou o Meta Ads forem conectados.</p>

      <section className="grid-kpi" aria-label="Indicadores">
        {rotulos.map((label, i) => (
          <article key={label} className="card kpi">
            <span className="kpi-label">{label}</span>
            <div className="kpi-value"><b>{D.kpi[i][0]}</b><span className="delta">{D.kpi[i][1]}</span></div>
            <span className="card-sub" style={{ fontSize: 12 }}>{dicas[i]}</span>
          </article>
        ))}
      </section>

      <section className="row">
        <article className="card wide">
          <div className="card-head">
            <div><h2>Pessoas alcançadas</h2><span className="card-sub">Instagram, Facebook, TikTok e Google somados</span></div>
            <Legend items={[{ label: 'Orgânico', color: 'var(--teal)' }, { label: 'Anúncios', color: 'var(--accent)' }]} />
          </div>
          <div className="chart">
            <div className="chart-y" style={{ height: 220 }}>{ticks(D.max).map(t => <span key={t}>{t}</span>)}</div>
            <div className="chart-body">
              <svg viewBox="0 0 800 220" preserveAspectRatio="none" style={{ height: 220 }} role="img"
                   aria-label="Barras empilhadas de alcance orgânico e por anúncios">
                <path d="M0,0.5 H800 M0,55 H800 M0,110 H800 M0,165 H800 M0,219.5 H800" stroke="#26314A" strokeWidth={1} vectorEffect="non-scaling-stroke" />
                <path d={barras.lower} fill="var(--accent)" />
                <path d={barras.upper} fill="var(--teal)" />
              </svg>
              <div className="chart-x around">{D.labels.map(l => <span key={l}>{l}</span>)}</div>
            </div>
          </div>
        </article>

        <article className="card narrow" id="whatsapp">
          <div><h2>Atendimento no WhatsApp</h2><span className="card-sub">Qualidade do número: {cliente.whatsapp.qualidade}</span></div>
          <div className="row" style={{ alignItems: 'center', gap: 20 }}>
            <svg viewBox="0 0 120 120" width={120} height={120} role="img"
                 aria-label={`${Math.round(cliente.whatsapp.ia * 100)}% das conversas resolvidas pela IA`}>
              <g transform="rotate(-90 60 60)" fill="none" strokeWidth={14}>
                <circle cx={60} cy={60} r={46} stroke="var(--track)" />
                <circle cx={60} cy={60} r={46} stroke="var(--accent)" strokeLinecap="round"
                        strokeDasharray={`${(cliente.whatsapp.ia * C).toFixed(1)} ${C.toFixed(1)}`} />
              </g>
              <text x={60} y={66} textAnchor="middle" fill="var(--text)" fontSize={22} fontWeight={800}>{Math.round(cliente.whatsapp.ia * 100)}%</text>
            </svg>
            <div style={{ display: 'grid', gap: 6, fontSize: 14, flex: 1, minWidth: 140 }}>
              <span><b>{Math.round(cliente.whatsapp.ia * 100)}%</b> <span className="card-sub" style={{ fontSize: 14 }}>resolvidas pela IA</span></span>
              <span><b>{100 - Math.round(cliente.whatsapp.ia * 100)}%</b> <span className="card-sub" style={{ fontSize: 14 }}>passadas para a equipe</span></span>
            </div>
          </div>
          <div className="tiles">
            <div className="tile"><span>Tempo de resposta</span><b>{cliente.whatsapp.resposta}</b></div>
            <div className="tile"><span>Fora do horário</span><b>{cliente.whatsapp.foraHorario}</b></div>
          </div>
        </article>
      </section>

      <section className="row">
        <article className="card half">
          <div><h2>Quando seus clientes chamam</h2><span className="card-sub">Mensagens no WhatsApp por dia e horário</span></div>
          <div className="table-wrap">
            <div style={{ display: 'grid', gap: 6, minWidth: 420 }} aria-hidden="true">
              <div style={{ display: 'grid', gridTemplateColumns: '40px repeat(8, minmax(0,1fr))', gap: 6, fontSize: 11, color: 'var(--muted)', textAlign: 'center' }}>
                <span />{horas.map(h => <span key={h}>{h}</span>)}
              </div>
              {cliente.calor.map(([dia, vals]) => (
                <div key={dia} style={{ display: 'grid', gridTemplateColumns: '40px repeat(8, minmax(0,1fr))', gap: 6, alignItems: 'center' }}>
                  <span style={{ fontSize: 12, color: 'var(--muted-2)' }}>{dia}</span>
                  {vals.map((v, i) => (
                    <div key={i} style={{ height: 28, borderRadius: 6,
                         background: v === 0 ? 'var(--card-2)' : `rgba(91,141,239,${(0.12 + v * 0.88).toFixed(2)})` }} />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </article>

        <article className="card narrow" id="anuncios">
          <div><h2>Anúncios do mês</h2><span className="card-sub">Raio de alcance ao redor do negócio</span></div>
          <div style={{ display: 'grid', gap: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
              <span style={{ color: 'var(--muted-2)' }}>Verba usada</span><b>{cliente.anuncios.usado} de {cliente.anuncios.verba}</b>
            </div>
            <ProgressBar pct={cliente.anuncios.pct} />
          </div>
          <div className="tiles">
            <div className="tile"><span>Cliques para o WhatsApp</span><b>{cliente.anuncios.cliques}</b></div>
            <div className="tile"><span>Custo por clique</span><b>{cliente.anuncios.cpc}</b></div>
            <div className="tile"><span>Encomendas atribuídas</span><b>{cliente.anuncios.encomendas}</b></div>
            <div className="tile"><span>Retorno estimado</span><b style={{ color: 'var(--good)' }}>{cliente.anuncios.retorno}</b></div>
          </div>
          <a className="btn" href="#anuncios">Ajustar verba do próximo mês</a>
        </article>
      </section>

      <section className="card" id="posts" style={{ gap: 14 }}>
        <div><h2>Conteúdos que mais funcionaram</h2><span className="card-sub">A IA usa estes resultados para planejar o próximo mês</span></div>
        {cliente.posts.map(([titulo, meta, alcance]) => (
          <div key={titulo} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(120px,220px) 90px', gap: 16,
                                     alignItems: 'center', padding: '12px 0', borderTop: '1px solid var(--track)' }}>
            <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
              <b style={{ fontSize: 15, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{titulo}</b>
              <span className="card-sub">{meta}</span>
            </div>
            <ProgressBar pct={Math.round((alcance / maxPost) * 100)} />
            <b style={{ textAlign: 'right', fontSize: 15 }}>{alcance.toLocaleString('pt-BR')}</b>
          </div>
        ))}
      </section>
    </>
  );
}
