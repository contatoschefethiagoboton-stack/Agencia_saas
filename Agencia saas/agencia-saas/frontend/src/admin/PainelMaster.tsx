import { useState } from 'react';
import { master, type Periodo } from '../data/demo';
import { donut } from '../ui/charts';
import { Legend, LineChart, ProgressBar, Sparkline } from '../ui/Charts';
import { Segmented } from '../ui/Shell';

const corSaude: Record<string, string> = { Boa: 'var(--good)', Atenção: 'var(--warn)', Crítica: 'var(--bad)' };
const tagAlerta: Record<string, [string, string]> = {
  Crítico: ['var(--bad-bg)', '#F59AA0'], Atenção: ['var(--warn-bg)', 'var(--warn)'], Info: ['var(--track)', '#8FB3F5'],
};

/** Painel Master — visão do dono. Ligar a GET /api/admin/dashboard substituindo `master`. */
export default function PainelMaster({ onSacar, onInvestir }: { onSacar?: () => void; onInvestir?: () => void }) {
  const [periodo, setPeriodo] = useState<Periodo>('12m');
  const S = master.series[periodo];
  const fatias = donut(master.receita.map(r => r.pct), 60);
  const kpis = [
    { label: 'Receita', vals: S.rev, cor: 'var(--accent)' },
    { label: 'Lucro líquido', vals: S.prof, cor: 'var(--orange)' },
    { label: 'Clientes ativos', vals: S.cli, cor: 'var(--teal)' },
    { label: 'Verba de mídia gerida', vals: S.rev.map(v => v * 1.6), cor: 'var(--lilac)' },
  ];

  return (
    <>
      <header className="page-head">
        <div>
          <span className="eyebrow">{new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span>
          <h1>Visão geral</h1>
        </div>
        <div className="row" style={{ alignItems: 'center' }}>
          <Segmented label="Período" value={periodo} onChange={setPeriodo}
                     options={[['7d', '7 dias'], ['30d', '30 dias'], ['12m', '12 meses']]} />
          <button className="btn">Exportar relatório</button>
        </div>
      </header>

      <section className="grid-kpi" aria-label="Indicadores principais">
        {kpis.map((k, i) => (
          <article key={k.label} className="card kpi">
            <span className="kpi-label">{k.label}</span>
            <div className="kpi-value"><b>{S.kpi[i][0]}</b><span className="delta">{S.kpi[i][1]}</span></div>
            <Sparkline vals={k.vals} color={k.cor} />
            <span className="card-sub">vs. período anterior</span>
          </article>
        ))}
      </section>

      <section className="row" id="financeiro">
        <article className="card wide">
          <div className="card-head">
            <div><h2>Receita e lucro</h2><span className="card-sub">{S.title} · em reais</span></div>
            <Legend items={[{ label: 'Receita', color: 'var(--accent)' }, { label: 'Lucro líquido', color: 'var(--orange)' }]} />
          </div>
          <LineChart label="Receita e lucro líquido no período" labels={S.labels} max={S.max}
                     series={[{ name: 'Receita', vals: S.rev, color: 'var(--accent)', area: true },
                              { name: 'Lucro', vals: S.prof, color: 'var(--orange)' }]} />
        </article>

        <article className="card narrow">
          <div><h2>De onde vem a receita</h2><span className="card-sub">Mês atual</span></div>
          <div style={{ position: 'relative', display: 'grid', placeItems: 'center' }}>
            <svg viewBox="0 0 160 160" width={180} height={180} role="img"
                 aria-label={master.receita.map(r => `${r.label} ${Math.round(r.pct * 100)}%`).join(', ')}>
              <g transform="rotate(-90 80 80)" fill="none" strokeWidth={20}>
                <circle cx={80} cy={80} r={60} stroke="var(--track)" />
                {master.receita.map((r, i) => (
                  <circle key={r.label} cx={80} cy={80} r={60} stroke={r.color}
                          strokeDasharray={fatias[i].dash} strokeDashoffset={fatias[i].offset} />
                ))}
              </g>
            </svg>
            <div style={{ position: 'absolute', textAlign: 'center' }}>
              <b style={{ fontSize: 22 }}>{master.receitaMes}</b><div className="card-sub">no mês</div>
            </div>
          </div>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10, fontSize: 14 }}>
            {master.receita.map(r => (
              <li key={r.label} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <i style={{ width: 10, height: 10, borderRadius: 3, background: r.color }} />
                <span style={{ flex: 1 }}>{r.label}</span><b>{Math.round(r.pct * 100)}%</b>
              </li>
            ))}
          </ul>
        </article>
      </section>

      <section className="grid-3" id="captacao">
        <article className="card" style={{ background: 'var(--accent)', color: 'var(--bg)', border: 0, gap: 14 }}>
          <b style={{ fontSize: 14 }}>Sua carteira</b>
          <span style={{ fontSize: 36, fontWeight: 800, letterSpacing: '-0.02em' }}>{master.carteira.saldo}</span>
          <span style={{ fontSize: 13, fontWeight: 500 }}>Disponível para saque imediato</span>
          <button className="btn btn-solid" onClick={onSacar}>Sacar via PIX</button>
          <div style={{ display: 'grid', gap: 6, fontSize: 13, fontWeight: 500 }}>
            {master.carteira.saques.map(([d, v]) => (
              <div key={d} style={{ display: 'flex', justifyContent: 'space-between' }}><span>Saque · {d}</span><span>{v}</span></div>
            ))}
          </div>
        </article>

        <article className="card" style={{ gap: 14 }}>
          <h2>Fundo de mídia da agência</h2>
          <div className="kpi-value"><b>{master.fundo.saldo}</b><span className="card-sub">em caixa</span></div>
          <div style={{ display: 'grid', gap: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--muted-2)' }}>
              <span>Investido no mês</span><span>{master.fundo.investido} de {master.fundo.planejado}</span>
            </div>
            <ProgressBar pct={master.fundo.pct} color="var(--orange)" />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, paddingTop: 6, borderTop: '1px solid var(--border)' }}>
            <span className="card-sub" style={{ fontSize: 14 }}>Custo por cliente captado</span><b>{master.fundo.custoCliente}</b>
          </div>
          <button className="btn" onClick={onInvestir}>Investir na campanha</button>
        </article>

        <article className="card" style={{ gap: 14 }}>
          <div><h2>Funil de captação</h2><span className="card-sub">Últimos 90 dias</span></div>
          {master.funil.map(([label, valor, pct]) => (
            <div key={label} style={{ display: 'grid', gap: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                <span style={{ color: 'var(--muted-2)' }}>{label}</span><b>{valor}</b>
              </div>
              <ProgressBar pct={pct} />
            </div>
          ))}
        </article>
      </section>

      <section className="card" id="clientes">
        <div className="card-head">
          <div><h2>Resultado por cliente</h2><span className="card-sub">Mês atual</span></div>
          <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--muted)' }}>Buscar cliente
            <input type="search" placeholder="Nome do negócio" style={{ minHeight: 40, minWidth: 220, padding: '0 12px', borderRadius: 10,
                   border: '1px solid var(--border-strong)', background: 'var(--bg)', fontSize: 14 }} />
          </label>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr>
              <th>Cliente</th><th>Plano</th><th className="num">Assinatura</th><th className="num">Verba de mídia</th>
              <th className="num">Lucro</th><th>WhatsApp</th><th>6 meses</th><th><span className="sr">Ações</span></th>
            </tr></thead>
            <tbody>
              {master.clientes.map(c => (
                <tr key={c.nome}>
                  <td><b>{c.nome}</b></td>
                  <td style={{ color: 'var(--muted-2)' }}>{c.plano}</td>
                  <td className="num">{c.assinatura}</td>
                  <td className="num">{c.midia}</td>
                  <td className="num" style={{ color: 'var(--good)', fontWeight: 700 }}>{c.lucro}</td>
                  <td><span className="dot" style={{ background: corSaude[c.wa] }} />{c.wa}</td>
                  <td><Sparkline vals={c.tend} color="var(--accent)" fill={false} width={96} height={28} /></td>
                  <td className="num"><a href="#cliente" style={{ fontWeight: 600, textDecoration: 'none' }}>Abrir</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="row" id="alertas">
        <article className="card half">
          <div><h2>Uso de IA por cliente</h2><span className="card-sub">Percentual do teto mensal consumido</span></div>
          {master.usoIA.map(([nome, pct]) => (
            <div key={nome} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,150px) 1fr 44px', gap: 12, alignItems: 'center', fontSize: 13 }}>
              <span style={{ color: 'var(--muted-2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{nome}</span>
              <ProgressBar pct={pct} color={pct >= 85 ? 'var(--orange)' : undefined} />
              <b style={{ textAlign: 'right' }}>{pct}%</b>
            </div>
          ))}
        </article>

        <article className="card half" style={{ gap: 12 }}>
          <h2>Alertas</h2>
          {master.alertas.map(a => (
            <div key={a.cliente} style={{ display: 'flex', gap: 12, padding: 12, borderRadius: 12, background: 'var(--card-2)' }}>
              <span style={{ flex: 'none', alignSelf: 'flex-start', fontSize: 12, fontWeight: 700, padding: '4px 8px', borderRadius: 6,
                             background: tagAlerta[a.nivel][0], color: tagAlerta[a.nivel][1] }}>{a.nivel}</span>
              <div style={{ display: 'grid', gap: 2 }}>
                <b style={{ fontSize: 14 }}>{a.cliente}</b>
                <span className="card-sub" style={{ lineHeight: 1.45 }}>{a.texto}</span>
              </div>
            </div>
          ))}
        </article>
      </section>
    </>
  );
}
