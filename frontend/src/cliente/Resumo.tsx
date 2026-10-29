import { brl, type Me } from '../api';
import { useLoad } from '../ui/useLoad';
import { ProgressBar } from '../ui/Charts';
import PainelCliente from './PainelCliente';

interface Summary {
  negocio: { name: string; city: string | null; plan_name: string | null; posts_per_month: number | null };
  conteudo: Record<string, number>;
  ia: { cost_cents: string; quota_cents: string } | null;
  whatsapp: { ativos: number; total: number; aguardando_humano: number; recebidas_30d: number; respondidas_ia_30d: number };
  dossie: { completo: boolean; campos: number };
  canais: string[];
}

/** Painel do negócio: o que é real hoje (conteúdo, WhatsApp, IA) + prévia dos relatórios. */
export default function Resumo({ me }: { me: Me }) {
  const { data: s, error } = useLoad<Summary>('/client/summary');
  if (error) return <p className="msg err" role="alert">{error}</p>;
  if (!s) return <p className="card-sub">Carregando…</p>;
  const pend = s.conteudo.pending_approval ?? 0;
  const iaPct = s.ia ? Math.min(100, Math.round(Number(s.ia.cost_cents) / Math.max(1, Number(s.ia.quota_cents)) * 100)) : 0;

  return (
    <>
      <header className="page-head">
        <div><span className="eyebrow">{[me.tenant_name, s.negocio.city].filter(Boolean).join(' · ')}</span><h1>Olá{me.name ? `, ${me.name.split(' ')[0]}` : ''}</h1></div>
      </header>

      {!s.dossie.completo && (
        <section className="card" style={{ borderColor: 'var(--accent)' }}>
          <h2>Primeiro passo: conte sobre o seu negócio</h2>
          <p className="card-sub">Com o site, o cardápio/catálogo em PDF e algumas respostas, a IA monta a memória do seu negócio e o calendário do mês.</p>
          <div className="actions"><a className="btn btn-primary" href="#negocio">Preencher agora</a></div>
        </section>
      )}

      {pend > 0 && (
        <section className="row" style={{ alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px',
                 borderRadius: 16, background: '#2A2216', border: '1px solid #4A3A1E' }}>
          <div style={{ display: 'grid', gap: 4 }}>
            <b style={{ fontSize: 17 }}>{pend} {pend === 1 ? 'conteúdo espera' : 'conteúdos esperam'} sua aprovação</b>
            <span style={{ fontSize: 14, color: '#E2C9A3' }}>Revise antes do horário agendado para não atrasar as publicações.</span>
          </div>
          <a className="btn btn-orange" href="#aprovacoes">Revisar agora</a>
        </section>
      )}

      <section className="grid-kpi">
        <article className="card kpi"><span className="kpi-label">Conteúdos do mês</span>
          <div className="kpi-value"><b>{Object.values(s.conteudo).reduce((a, b) => a + b, 0)}</b></div>
          <span className="card-sub">{s.conteudo.approved ?? 0} aprovados · plano {s.negocio.plan_name} ({s.negocio.posts_per_month}/mês)</span></article>
        <article className="card kpi"><span className="kpi-label">Mensagens no WhatsApp (30 dias)</span>
          <div className="kpi-value"><b>{s.whatsapp.recebidas_30d}</b></div>
          <span className="card-sub">{s.whatsapp.respondidas_ia_30d} respostas da IA · {s.whatsapp.aguardando_humano} esperando você</span></article>
        <article className="card kpi"><span className="kpi-label">Números de WhatsApp</span>
          <div className="kpi-value"><b>{s.whatsapp.ativos}/{s.whatsapp.total}</b></div><span className="card-sub">ativos</span></article>
        <article className="card kpi"><span className="kpi-label">Uso de IA no mês</span>
          <div className="kpi-value"><b>{iaPct}%</b></div><ProgressBar pct={iaPct} color={iaPct > 85 ? 'var(--bad)' : 'var(--teal)'} />
          <span className="card-sub">{s.ia ? `${brl(s.ia.cost_cents)} de ${brl(s.ia.quota_cents)}` : 'sem uso ainda'}</span></article>
      </section>

      <PainelCliente />
    </>
  );
}
