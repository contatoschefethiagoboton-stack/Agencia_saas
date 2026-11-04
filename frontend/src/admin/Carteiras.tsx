import { useState } from 'react';
import { api, brl } from '../api';
import { useLoad } from '../ui/useLoad';
import { useStepUp } from '../auth/StepUp';

interface W { tenant_id: string; name: string; status: string; blocked_reason: string | null; created_at: string; saidas_24h: number; falhas_24h: number }

export default function Carteiras() {
  const { data, error, reload } = useLoad<W[]>('/admin/wallets');
  const guard = useStepUp();
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  async function toggle(w: W) {
    const reason = w.status === 'blocked' ? undefined : prompt(`Motivo do bloqueio da carteira de ${w.name}:`) ?? undefined;
    if (w.status !== 'blocked' && !reason) return;
    setMsg({});
    try { await guard(() => api(`/admin/wallets/${w.tenant_id}/block`, { body: { block: w.status !== 'blocked', reason } })); setMsg({ ok: 'Carteira atualizada.' }); reload(); }
    catch (e) { setMsg({ err: (e as Error).message }); }
  }
  return (
    <>
      <header className="page-head"><div><span className="eyebrow">Administração</span><h1>Carteiras dos clientes</h1></div></header>
      {msg.err && <p className="msg err">{msg.err}</p>}{msg.ok && <p className="msg ok">{msg.ok}</p>}
      <section className="card">
        <p className="card-sub" style={{ margin: 0 }}>O dinheiro fica nas subcontas do Asaas de cada cliente. Aqui você acompanha e pode bloquear uma carteira suspeita na hora.</p>
        {error ? <p className="msg err">{error}</p> : !data ? <p className="card-sub">Carregando…</p> : !data.length ? <p className="card-sub">Nenhuma carteira aberta.</p> : (
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>Cliente</th><th>Situação</th><th className="n">Saídas 24h</th><th className="n">Falhas 24h</th><th /></tr></thead>
            <tbody>{data.map(w => (
              <tr key={w.tenant_id}><td><b>{w.name}</b></td>
                <td><span className={`badge ${w.status === 'active' ? 'good' : w.status === 'blocked' ? 'bad' : 'warn'}`}>{{ active: 'Ativa', blocked: 'Bloqueada', pending: 'Em aprovação' }[w.status]}</span>
                  {w.blocked_reason && <div className="card-sub">{w.blocked_reason}</div>}</td>
                <td className="n">{brl(w.saidas_24h)}</td><td className="n">{w.falhas_24h}</td>
                <td className="n">{w.status !== 'pending' && <button className={`btn ${w.status === 'blocked' ? 'btn-good' : 'btn-danger'}`} onClick={() => toggle(w)}>{w.status === 'blocked' ? 'Desbloquear' : 'Bloquear'}</button>}</td></tr>))}
            </tbody></table></div>)}
      </section>
    </>
  );
}
