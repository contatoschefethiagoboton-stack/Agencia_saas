import { useEffect, useState } from 'react';
import { api, brl } from '../api';
import { useLoad } from '../ui/useLoad';
import { Spinner } from './parts';

interface Conta { plan: string; planName: string; priceCents: number; status: string; billingType: 'PIX' | 'CREDIT_CARD' | null; semCobranca: boolean;
                  payUrl: string | null; payments: { kind: string; amount_cents: number; status: string; confirmed_at: string | null }[] }
interface Plano { id: string; name: string; price_cents: number; description: string }

export default function Assinatura() {
  const { data, error, reload } = useLoad<Conta>('/account');
  const [plans, setPlans] = useState<Plano[]>([]);
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  useEffect(() => { api<Plano[]>('/auth/plans').then(setPlans).catch(() => {}); }, []);
  async function act(fn: () => Promise<unknown>, ok: string) {
    setMsg({});
    try { await fn(); setMsg({ ok }); reload(); } catch (e) { setMsg({ err: (e as Error).message }); }
  }
  if (error) return <p className="msg err">{error}</p>;
  if (!data) return <Spinner />;
  const STATUS: Record<string, string> = { confirmed: 'Pago', pending: 'Em aberto', refunded: 'Reembolsado', chargeback: 'Contestado', failed: 'Falhou' };
  return (
    <>
      <div className="page-head"><div><span className="eyebrow">Sua conta</span><h1>Assinatura</h1></div></div>
      {msg.err && <p className="msg err">{msg.err}</p>}{msg.ok && <p className="msg ok">{msg.ok}</p>}
      <div className="row">
        <div className="card half">
          <h2>Plano {data.planName}</h2>
          <p className="kpi-value" style={{ margin: 0 }}><b>{data.semCobranca ? 'Sem cobrança' : `${brl(data.priceCents)}/mês`}</b></p>
          {!data.semCobranca && <>
            <div className="seg" role="group" aria-label="Forma de pagamento">
              {(['PIX', 'CREDIT_CARD'] as const).map(bt => (
                <button key={bt} aria-pressed={data.billingType === bt}
                        onClick={() => act(() => api('/account/billing-type', { body: { billingType: bt } }), 'Forma de pagamento atualizada.')}>
                  {bt === 'PIX' ? 'PIX' : 'Cartão de crédito'}</button>))}
            </div>
            {data.payUrl && <a className="btn btn-good" href={data.payUrl} target="_blank" rel="noreferrer">Pagar mensalidade em aberto</a>}
          </>}
          <p className="card-sub" style={{ margin: 0 }}>O pagamento é feito na página segura do Asaas. A plataforma nunca vê os dados do seu cartão.</p>
        </div>
        <div className="card half">
          <h2>Trocar de plano</h2>
          <div className="plan-pick">{plans.map(p => (
            <button key={p.id} className="plan-opt" aria-checked={p.id === data.plan} role="radio" disabled={p.id === data.plan}
                    onClick={() => confirm(`Mudar para o plano ${p.name} (${brl(p.price_cents)}/mês)?`) &&
                      act(() => api('/account/plan', { body: { plan: p.id } }), `Plano alterado para ${p.name}. O novo valor vale a partir da próxima cobrança.`)}>
              <b>{p.name}</b><span className="plan-price">{brl(p.price_cents)}<small>/mês</small></span><small>{p.description}</small>
            </button>))}</div>
        </div>
      </div>
      <div className="card">
        <h2>Pagamentos</h2>
        {!data.payments.length ? <p className="card-sub">Nenhum pagamento registrado ainda.</p> : (
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>Data</th><th>Tipo</th><th className="n">Valor</th><th>Situação</th></tr></thead>
            <tbody>{data.payments.map((p, i) => (
              <tr key={i}><td>{p.confirmed_at ? new Date(p.confirmed_at).toLocaleDateString('pt-BR') : '—'}</td><td>{p.kind === 'subscription' ? 'Mensalidade' : p.kind}</td>
                <td className="n">{brl(p.amount_cents)}</td><td><span className={`badge ${p.status === 'confirmed' ? 'good' : p.status === 'pending' ? 'warn' : 'bad'}`}>{STATUS[p.status] ?? p.status}</span></td></tr>))}
            </tbody></table></div>)}
      </div>
    </>
  );
}
