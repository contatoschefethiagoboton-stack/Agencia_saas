import { brl } from '../api';
import { useLoad } from '../ui/useLoad';

interface Dashboard {
  mrrCents: string;
  clientes: { ativos: number; bloqueados: number; aguardando: number; aguardando_pagamento: number; vip: number };
  planos: { name: string; clientes: number; receita_cents: string }[];
  seguranca: { senhas_erradas: number; ips_bloqueados: number; pagamentos_suspeitos: number; carteira_alertas: number };
  robos: { ativos: number; reais: number; com_erro: number; seguidores: number; masters: number };
  ops: { ops_24h: number; abertas: number; abertas_reais: number };
  conexoes: { total: number; com_erro: number };
  erros: { name: string; symbol: string; status_reason: string | null; cliente: string | null }[];
}

/** Painel Master: clientes, robôs e operações da plataforma. */
export default function Visao() {
  const { data: d, error } = useLoad<Dashboard>('/admin/dashboard');
  if (error) return <p className="msg err" role="alert">{error}</p>;
  if (!d) return <p className="card-sub">Carregando…</p>;
  const kpis: [string, string][] = [
    ['Receita recorrente (mês)', brl(d.mrrCents)], ['Clientes ativos', String(d.clientes.ativos)],
    ['Robôs ligados', String(d.robos.ativos)], ['Robôs com dinheiro real', String(d.robos.reais)],
    ['Operações nas últimas 24h', String(d.ops.ops_24h)], ['Posições abertas', `${d.ops.abertas} (${d.ops.abertas_reais} reais)`],
    ['Seguidores de copy trade', String(d.robos.seguidores)], ['Corretoras conectadas', String(d.conexoes.total)],
  ];
  return (
    <>
      <header className="page-head"><div>
        <span className="eyebrow">{new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span>
        <h1>Visão geral</h1></div></header>
      {d.clientes.aguardando > 0 && (
        <section className="row" role="status" style={{ alignItems: 'center', justifyContent: 'space-between', padding: '18px 22px', borderRadius: 16, background: 'var(--warn-bg)', border: '1px solid var(--warn)' }}>
          <b style={{ color: 'var(--warn)' }}>{d.clientes.aguardando} {d.clientes.aguardando === 1 ? 'cadastro aguardando' : 'cadastros aguardando'} sua aprovação</b>
          <a className="btn btn-primary" href="#master-clientes">Revisar</a>
        </section>)}
      <section className="grid-kpi" aria-label="Indicadores principais">
        {kpis.map(([label, value]) => <article key={label} className="card kpi"><span className="kpi-label">{label}</span><div className="kpi-value"><b>{value}</b></div></article>)}
      </section>
      <section className="row">
        <article className="card half">
          <h2>Planos</h2>
          <div className="table-wrap"><table className="tbl"><thead><tr><th>Plano</th><th className="n">Clientes</th><th className="n">Receita/mês</th></tr></thead>
            <tbody>{d.planos.map(p => <tr key={p.name}><td>{p.name}</td><td className="n">{p.clientes}</td><td className="n">{brl(p.receita_cents)}</td></tr>)}</tbody></table></div>
          <span className="card-sub">{d.clientes.aguardando_pagamento} cadastro(s) aguardando pagamento · {d.clientes.vip} VIP</span>
        </article>
        <article className="card half">
          <h2>Segurança nas últimas 24h</h2>
          <div className="tiles">
            <div className="tile"><span>Senhas erradas</span><b>{d.seguranca.senhas_erradas}</b></div>
            <div className="tile"><span>IPs bloqueados</span><b className={d.seguranca.ips_bloqueados ? 'down' : ''}>{d.seguranca.ips_bloqueados}</b></div>
            <div className="tile"><span>Pagamentos suspeitos</span><b className={d.seguranca.pagamentos_suspeitos ? 'down' : ''}>{d.seguranca.pagamentos_suspeitos}</b></div>
            <div className="tile"><span>Alertas de carteira</span><b className={d.seguranca.carteira_alertas ? 'down' : ''}>{d.seguranca.carteira_alertas}</b></div>
          </div>
          <a className="btn" href="#master-rastreamento">Ver rastreamento</a>
        </article>
      </section>
      <section className="row">
        <article className="card half">
          <h2>Robôs com erro</h2>
          {d.erros.length ? <div className="net-items">{d.erros.map((e, i) => (
            <div key={i} className="net-item"><span><b>{e.name}</b> · {e.symbol} · {e.cliente ?? 'estratégia master'}<br /><small className="down">{e.status_reason}</small></span></div>))}</div>
            : <p className="card-sub">Nenhum robô com erro.</p>}
        </article>
        <article className="card half">
          <h2>Copy trade</h2>
          <p style={{ fontSize: 32, fontWeight: 800, margin: '4px 0' }}>{d.robos.masters}</p>
          <span className="card-sub">estratégias publicadas · {d.robos.seguidores} robôs de clientes copiando</span>
          <a className="btn" href="#master-copy">Gerenciar estratégias</a>
        </article>
      </section>
    </>
  );
}
