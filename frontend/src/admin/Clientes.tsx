import { useState } from 'react';
import { api } from '../api';
import { useLoad } from '../ui/useLoad';
import { useStepUp } from '../auth/StepUp';

interface Tenant { id: string; name: string; niche: string | null; city: string | null; plan: string; status: string;
  suspended_reason: string | null; owner_email: string | null; cobranca_ativa: boolean; robos_ativos: number; robos_reais: number;
  corretoras: number; document: string | null; billing_type: string | null; carteira: string | null; deleted_at: string | null; vip: boolean; vip_note: string | null; signup: 'admin' | 'self'; ultimo_acesso: string | null }
interface Plan { id: string; name: string; price_cents: string }

const statusBadge = (t: Tenant) => t.status === 'pending' ? <span className="badge warn">Aguardando sua aprovação</span>
  : t.status === 'awaiting_payment' ? <span className="badge warn">Aguardando pagamento ({t.billing_type === 'CREDIT_CARD' ? 'cartão' : 'PIX'})</span>
  : t.status === 'deleted' ? <span className="badge bad">Excluído</span>
  : t.status === 'rejected' ? <span className="badge bad">Cadastro recusado</span>
  : t.status === 'active' ? <span className="badge good">Ativo</span>
  : <span className="badge bad">{t.status === 'killed' ? 'Kill switch' : `Suspenso${t.suspended_reason ? ` · ${t.suspended_reason}` : ''}`}</span>;

export default function Clientes() {
  const [excluidos, setExcluidos] = useState(false);
  const { data: list, error, reload } = useLoad<Tenant[]>(`/admin/tenants${excluidos ? '?excluidos=1' : ''}`);
  const { data: plans } = useLoad<Plan[]>('/admin/plans');
  const guard = useStepUp();
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string; secret?: string } | null>(null);
  const [f, setF] = useState({ name: '', niche: '', city: '', document: '', plan: 'basico', ownerName: '', ownerEmail: '', ownerPhone: '', startBilling: false });
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  const act = async (fn: () => Promise<any>, ok: (r: any) => { text: string; secret?: string }) => {
    setMsg(null);
    try { const r = await guard(fn); setMsg({ kind: 'ok', ...ok(r) }); reload(); }
    catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); }
  };

  const create = () => act(() => api('/admin/tenants', { body: {
      ...f, niche: f.niche || undefined, city: f.city || undefined, document: f.document || undefined,
      ownerPhone: f.ownerPhone || undefined } }),
    r => ({ text: `Cliente criado. Envie ao responsável (${r.ownerEmail}) o endereço do site e a senha provisória abaixo. ` +
               'Ela aparece só agora; no 1º acesso ele troca a senha e cadastra o 2FA.' +
               (r.billing?.error ? ` Cobrança não iniciada: ${r.billing.error}` : r.billing ? ' Assinatura criada no Asaas.' : ''),
            secret: r.tempPassword }));

  /** Entra no painel do cliente (robôs, corretoras, avisos) para dar suporte, sem a senha dele. */
  const openPanel = async (t: Tenant) => {
    setMsg(null);
    try { await guard(() => api(`/admin/tenants/${t.id}/impersonate`, { body: {} })); location.hash = '#cliente'; location.reload(); }
    catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); }
  };

  const kill = (t: Tenant) => {
    const reason = prompt(`Motivo do bloqueio de "${t.name}" (fica na auditoria):`);
    if (!reason || reason.trim().length < 5) return;
    act(() => api(`/admin/tenants/${t.id}/kill`, { body: { reason } }), () => ({ text: `${t.name} bloqueado (kill switch): sessões derrubadas e robôs pausados.` }));
  };

  return (
    <>
      <header className="page-head"><div><span className="eyebrow">Painel Master</span><h1>Clientes</h1></div></header>
      {msg && <div className={`msg ${msg.kind}`} role="status">{msg.text}{msg.secret && <p className="mono" style={{ fontSize: 18, margin: '8px 0 0' }}>{msg.secret}</p>}</div>}

      <section className="card">
        <div className="card-head"><h2>Clientes</h2>
          <label className="check"><input type="checkbox" checked={excluidos} onChange={e => setExcluidos(e.target.checked)} /> Mostrar excluídos</label></div>
        {error && <p className="msg err">{error}</p>}
        {list && (list.length ? (
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>Cliente</th><th>Plano</th><th>Situação</th><th>Robôs</th><th>Responsável</th><th>Ações</th></tr></thead>
            <tbody>{list.map(t => (
              <tr key={t.id}>
                <td><b>{t.name}</b>{t.vip && <span className="badge" title={`VIP (só você vê)${t.vip_note ? ': ' + t.vip_note : ''}`}
                      style={{ marginLeft: 8, background: '#3A2F10', color: '#F2C14E' }}>★ VIP</span>}
                  <div className="card-sub">{[t.niche, t.city].filter(Boolean).join(' · ')}</div>
                  <div className="card-sub">{t.signup === 'self' ? 'cadastrou-se pelo site · ' : ''}{t.ultimo_acesso ? `último acesso ${new Date(t.ultimo_acesso).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}` : 'nunca entrou'}</div></td>
                <td><select aria-label={`Plano de ${t.name}`} value={t.plan}
                            onChange={e => act(() => api(`/admin/tenants/${t.id}`, { method: 'PATCH', body: { plan: e.target.value } }), () => ({ text: 'Plano atualizado' }))}
                            style={{ background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 8, padding: 6 }}>
                  {plans?.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
                  <div className="card-sub">{t.cobranca_ativa ? 'cobrança ativa' : 'sem cobrança'}</div></td>
                <td>{statusBadge(t)}</td>
                <td>{t.robos_ativos ? <span className={`badge ${t.robos_reais ? 'warn' : 'good'}`}>{t.robos_ativos} ligado(s){t.robos_reais ? ` · ${t.robos_reais} real` : ''}</span> : <span className="card-sub">—</span>}
                  <div className="card-sub">{t.corretoras} corretora(s)</div></td>
                <td className="mono">{t.owner_email}</td>
                <td><div className="actions">
                  {['pending', 'awaiting_payment'].includes(t.status) && <>
                    <button className="btn btn-good" onClick={() => act(() => api(`/admin/tenants/${t.id}/approve`, { body: {} }), () => ({ text: `${t.name} aprovado: o cliente já pode entrar.` }))}>Aprovar acesso</button>
                    <button className="btn btn-danger" onClick={() => { const reason = prompt('Motivo da recusa (opcional, só você vê):') ?? undefined;
                      act(() => api(`/admin/tenants/${t.id}/reject`, { body: { reason } }), () => ({ text: `Cadastro de ${t.name} recusado.` })); }}>Recusar</button>
                  </>}
                  {t.status === 'rejected' && <button className="btn" onClick={() => act(() => api(`/admin/tenants/${t.id}/approve`, { body: {} }), () => ({ text: `${t.name} aprovado.` }))}>Aprovar mesmo assim</button>}
                  <a className="btn" href={`#master-seguranca?tenant=${t.id}`}>Atividade</a>
                  <button className="btn" title="Só você vê. VIP: sem cobrança e com os recursos do maior plano."
                          onClick={() => { const note = t.vip ? undefined : (prompt('Anotação interna do VIP (opcional, só você vê):') ?? undefined);
                            act(() => api(`/admin/tenants/${t.id}`, { method: 'PATCH', body: { vip: !t.vip, vipNote: note } }),
                                () => ({ text: t.vip ? `${t.name} deixou de ser VIP.` : `${t.name} agora é VIP (o cliente não vê isso).` })); }}>
                    {t.vip ? 'Tirar VIP' : '★ Tornar VIP'}</button>
                  {!['pending', 'rejected', 'awaiting_payment', 'deleted'].includes(t.status) && <>
                  {!t.cobranca_ativa && !t.vip && <button className="btn" onClick={() => act(() => api(`/admin/tenants/${t.id}/billing`, { body: {} }), () => ({ text: 'Assinatura criada no Asaas' }))}>Iniciar cobrança</button>}
                    {t.status === 'active' && <button className="btn btn-primary" onClick={() => openPanel(t)}>Abrir painel do cliente</button>}
                    {t.status === 'active'
                      ? <button className="btn btn-danger" onClick={() => kill(t)}>Bloquear conta</button>
                      : ['suspended', 'killed'].includes(t.status) && <button className="btn btn-good" onClick={() => act(() => api(`/admin/tenants/${t.id}/reactivate`, { body: {} }), () => ({ text: `${t.name} reativado` }))}>Reativar</button>}
                    {t.status !== 'deleted' && <button className="btn btn-danger" onClick={() => {
                      const confirmName = prompt(`EXCLUIR "${t.name}": apaga o login, robôs, corretoras e alertas e cancela a assinatura. O histórico fica na auditoria.\nDigite o nome do cliente para confirmar:`);
                      if (confirmName) act(() => api(`/admin/tenants/${t.id}/delete`, { body: { confirmName } }), r => ({ text: `${t.name} excluído. Cobrança: ${r.cobranca}.` }));
                    }}>Excluir</button>}
                    <button className="btn" onClick={() => confirm(`Gerar nova senha provisória e zerar o 2FA do responsável de "${t.name}"?`) &&
                      act(() => api(`/admin/tenants/${t.id}/reset-owner`, { body: {} }), r => ({ text: `Nova senha provisória de ${r.email}:`, secret: r.tempPassword }))}>Resetar acesso</button>
                    </>}
                </div></td>
              </tr>))}
            </tbody></table></div>
        ) : <p className="card-sub">Nenhum cliente cadastrado ainda.</p>)}
      </section>

      <form className="card" onSubmit={e => { e.preventDefault(); create(); }}>
        <h2>Cadastrar cliente</h2>
        <div className="form-grid">
          <label className="field">Nome da conta<input required value={f.name} onChange={set('name')} placeholder="ex.: Maria Silva" /></label>
          <label className="field">Cidade<input value={f.city} onChange={set('city')} /></label>
          <label className="field">CPF/CNPJ<input value={f.document} onChange={set('document')} /><small>Obrigatório para cobrar</small></label>
          <label className="field">Plano<select value={f.plan} onChange={set('plan')}>
            {plans?.map(p => <option key={p.id} value={p.id}>{p.name} · {(Number(p.price_cents) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</option>)}</select></label>
          <label className="field">Nome do responsável<input required value={f.ownerName} onChange={set('ownerName')} /></label>
          <label className="field">E-mail do responsável<input type="email" required value={f.ownerEmail} onChange={set('ownerEmail')} /></label>
          <label className="field">Celular do responsável<input placeholder="+5519999999999" pattern="\+\d{10,15}" value={f.ownerPhone} onChange={set('ownerPhone')} /></label>
        </div>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
          <input type="checkbox" checked={f.startBilling} onChange={set('startBilling')} /> Já criar a assinatura (e o setup) no Asaas
        </label>
        <div className="actions"><button className="btn btn-primary">Cadastrar</button></div>
      </form>
    </>
  );
}
