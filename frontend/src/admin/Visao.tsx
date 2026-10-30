import { brl } from '../api';
import { useLoad } from '../ui/useLoad';
import { ProgressBar } from '../ui/Charts';

interface Dashboard {
  mrrCents: string; carteiraPessoalCents: string; fundoMidiaCents: string; conteudosPendentes: number;
  clientes: { ativos: number; bloqueados: number; aguardando: number; vip: number };
  usoIA: { name: string; cost_cents: string; quota_cents: string }[];
  dre: { id: string; name: string; assinatura: string; setup_avulsos: string; verba_midia_bruta: string; taxa_gestao: string; custo_api: string }[];
}

/** Painel Master — visão do dono, com os números reais do ledger. */
export default function Visao() {
  const { data: d, error } = useLoad<Dashboard>('/admin/dashboard');
  if (error) return <p className="msg err" role="alert">{error}</p>;
  if (!d) return <p className="card-sub">Carregando…</p>;

  const lucro = (r: Dashboard['dre'][0]) => Number(r.assinatura) + Number(r.setup_avulsos) + Number(r.taxa_gestao) - Number(r.custo_api);
  const totalLucro = d.dre.reduce((s, r) => s + lucro(r), 0);
  const kpis = [
    ['Receita recorrente (mês)', brl(d.mrrCents)], ['Lucro líquido do mês', brl(totalLucro)],
    ['Disponível para saque', brl(d.carteiraPessoalCents)], ['Fundo de mídia da agência', brl(d.fundoMidiaCents)],
    ['Clientes ativos', String(d.clientes.ativos)], ['Contas bloqueadas', String(d.clientes.bloqueados)], ['Clientes VIP (só você vê)', String(d.clientes.vip)],
  ];

  return (
    <>
      <header className="page-head">
        <div>
          <span className="eyebrow">{new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span>
          <h1>Visão geral</h1>
        </div>
      </header>

      {d.clientes.aguardando > 0 && (
        <section className="row" role="status" style={{ alignItems: 'center', justifyContent: 'space-between', padding: '18px 22px', borderRadius: 16, background: 'var(--warn-bg)', border: '1px solid var(--warn)' }}>
          <b style={{ color: 'var(--warn)' }}>{d.clientes.aguardando} {d.clientes.aguardando === 1 ? 'cadastro aguardando' : 'cadastros aguardando'} sua aprovação</b>
          <a className="btn btn-primary" href="#master-clientes">Revisar</a>
        </section>)}

      <section className="grid-kpi" aria-label="Indicadores principais">
        {kpis.map(([label, value]) => (
          <article key={label} className="card kpi">
            <span className="kpi-label">{label}</span>
            <div className="kpi-value"><b>{value}</b></div>
          </article>
        ))}
      </section>

      <section className="card">
        <div className="card-head"><div><h2>DRE por cliente</h2><span className="card-sub">Mês atual · verba de mídia é repasse, não receita</span></div></div>
        {d.dre.length ? (
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Cliente</th><th className="n">Assinatura</th><th className="n">Setup/avulsos</th>
                <th className="n">Verba de mídia</th><th className="n">Taxa de gestão</th><th className="n">Custo de IA</th><th className="n">Lucro</th></tr></thead>
              <tbody>{d.dre.map(r => (
                <tr key={r.id}><td>{r.name}</td><td className="n">{brl(r.assinatura)}</td><td className="n">{brl(r.setup_avulsos)}</td>
                  <td className="n">{brl(r.verba_midia_bruta)}</td><td className="n">{brl(r.taxa_gestao)}</td>
                  <td className="n">{brl(r.custo_api)}</td><td className="n"><b>{brl(lucro(r))}</b></td></tr>))}
              </tbody>
            </table>
          </div>
        ) : <p className="card-sub">Nenhum cliente ainda. Cadastre o primeiro em <a href="#master-clientes">Clientes</a>.</p>}
      </section>

      <section className="row">
        <article className="card half">
          <h2>Uso de IA no mês</h2>
          <span className="card-sub">Teto por plano: ao chegar a 100%, a IA para para aquele cliente</span>
          {d.usoIA.length ? d.usoIA.map(u => {
            const pct = Math.min(100, Math.round(Number(u.cost_cents) / Math.max(1, Number(u.quota_cents)) * 100));
            return <div key={u.name} style={{ display: 'grid', gap: 6, marginTop: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}><span>{u.name}</span><span>{pct}%</span></div>
              <ProgressBar pct={pct} color={pct > 85 ? 'var(--bad)' : pct > 60 ? 'var(--warn)' : 'var(--teal)'} />
            </div>;
          }) : <p className="card-sub">Sem consumo ainda.</p>}
        </article>
        <article className="card half">
          <h2>Fila de aprovação</h2>
          <p style={{ fontSize: 32, fontWeight: 800, margin: '8px 0' }}>{d.conteudosPendentes}</p>
          <span className="card-sub">conteúdos aguardando o OK dos clientes</span>
        </article>
      </section>
    </>
  );
}
