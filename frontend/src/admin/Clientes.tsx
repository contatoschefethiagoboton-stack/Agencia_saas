import { useState } from 'react';
import { api } from '../api';
import { useLoad } from '../ui/useLoad';
import { useStepUp } from '../auth/StepUp';

interface Tenant { id: string; name: string; niche: string | null; city: string | null; plan: string; status: string;
  suspended_reason: string | null; owner_email: string | null; cobranca_ativa: boolean; wa_ativos: number; wa_qualidade: string | null;
  conexoes_atencao: number; vip: boolean; vip_note: string | null; signup: 'admin' | 'self'; ultimo_acesso: string | null }
interface Plan { id: string; name: string; price_cents: string }

const statusBadge = (t: Tenant) => t.status === 'pending' ? <span className="badge warn">Aguardando sua aprovação</span>
  : t.status === 'rejected' ? <span className="badge bad">Cadastro recusado</span>
  : t.status === 'active' ? <span className="badge good">Ativo</span>
  : <span className="badge bad">{t.status === 'killed' ? 'Kill switch' : `Suspenso${t.suspended_reason ? ` · ${t.suspended_reason}` : ''}`}</span>;

export default function Clientes() {
  const { data: list, error, reload } = useLoad<Tenant[]>('/admin/tenants');
  const { data: plans } = useLoad<Plan[]>('/admin/plans');
  const guard = useStepUp();
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string; secret?: string } | null>(null);
  const [f, setF] = useState({ name: '', niche: '', city: '', document: '', plan: 'starter', ownerName: '', ownerEmail: '', ownerPhone: '', startBilling: false });
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

  /** Entra no painel do negócio (dossiê, calendário, artes, anúncios, conexões) sem a senha do cliente. */
  const openPanel = async (t: Tenant) => {
    setMsg(null);
    try { await guard(() => api(`/admin/tenants/${t.id}/impersonate`, { body: {} })); location.hash = '#cliente'; location.reload(); }
    catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); }
  };

  const kill = (t: Tenant) => {
    const reason = prompt(`Motivo do bloqueio de "${t.name}" (fica na auditoria):`);
    if (!reason || reason.trim().length < 5) return;
    act(() => api(`/admin/tenants/${t.id}/kill`, { body: { reason } }), () => ({ text: `${t.name} bloqueado (kill switch): sessões derrubadas, WhatsApp e anúncios pausados.` }));
  };

  return (
    <>
      <header className="page-head"><div><span className="eyebrow">Painel Master</span><h1>Clientes</h1></div></header>
      {msg && <div className={`msg ${msg.kind}`} role="status">{msg.text}{msg.secret && <p className="mono" style={{ fontSize: 18, margin: '8px 0 0' }}>{msg.secret}</p>}</div>}

      <section className="card">
        <h2>Carteira de clientes</h2>
        {error && <p className="msg err">{error}</p>}
        {list && (list.length ? (
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>Negócio</th><th>Plano</th><th>Situação</th><th>WhatsApp</th><th>Responsável</th><th>Ações</th></tr></thead>
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
                <td>{statusBadge(t)}{t.conexoes_atencao > 0 && <div><span className="badge warn">{t.conexoes_atencao} conexão(ões) para reconectar</span></div>}</td>
                <td>{t.wa_ativos ? <span className={`badge ${t.wa_qualidade === 'RED' ? 'bad' : t.wa_qualidade === 'YELLOW' ? 'warn' : 'good'}`}>{t.wa_ativos} ativo(s)</span> : <span className="card-sub">—</span>}</td>
                <td className="mono">{t.owner_email}</td>
                <td><div className="actions">
                  {t.status === 'pending' && <>
                    <button className="btn btn-good" onClick={() => act(() => api(`/admin/tenants/${t.id}/approve`, { body: {} }), () => ({ text: `${t.name} aprovado: o cliente já pode entrar.` }))}>Aprovar acesso</button>
                    <button className="btn btn-danger" onClick={() => { const reason = prompt('Motivo da recusa (opcional, só você vê):') ?? undefined;
                      act(() => api(`/admin/tenants/${t.id}/reject`, { body: { reason } }), () => ({ text: `Cadastro de ${t.name} recusado.` })); }}>Recusar</button>
                  </>}
                  {t.status === 'rejected' && <button className="btn" onClick={() => act(() => api(`/admin/tenants/${t.id}/approve`, { body: {} }), () => ({ text: `${t.name} aprovado.` }))}>Aprovar mesmo assim</button>}
                  <a className="btn" href={`#master-seguranca?tenant=${t.id}`}>Atividade</a>
                  <button className="btn" title="Só você vê. VIP: sem cobrança, sem teto de IA e com os recursos do maior plano."
                          onClick={() => { const note = t.vip ? undefined : (prompt('Anotação interna do VIP (opcional, só você vê):') ?? undefined);
                            act(() => api(`/admin/tenants/${t.id}`, { method: 'PATCH', body: { vip: !t.vip, vipNote: note } }),
                                () => ({ text: t.vip ? `${t.name} deixou de ser VIP.` : `${t.name} agora é VIP (o cliente não vê isso).` })); }}>
                    {t.vip ? 'Tirar VIP' : '★ Tornar VIP'}</button>
                  {t.status !== 'pending' && t.status !== 'rejected' && <>
                  {!t.cobranca_ativa && !t.vip && <button className="btn" onClick={() => act(() => api(`/admin/tenants/${t.id}/billing`, { body: {} }), () => ({ text: 'Assinatura criada no Asaas' }))}>Iniciar cobrança</button>}
                    {t.status === 'active' && <button className="btn btn-primary" onClick={() => openPanel(t)}>Abrir painel do cliente</button>}
                    {t.status === 'active'
                      ? <button className="btn btn-danger" onClick={() => kill(t)}>Bloquear conta</button>
                      : ['suspended', 'killed'].includes(t.status) && <button className="btn btn-good" onClick={() => act(() => api(`/admin/tenants/${t.id}/reactivate`, { body: {} }), () => ({ text: `${t.name} reativado` }))}>Reativar</button>}
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
          <label className="field">Nome do negócio<input required value={f.name} onChange={set('name')} /></label>
          <label className="field">Nicho<input placeholder="padaria, clínica, barbearia, influenciador…" value={f.niche} onChange={set('niche')} /></label>
          <label className="field">Cidade / bairro<input value={f.city} onChange={set('city')} /></label>
          <label className="field">CPF/CNPJ<input value={f.document} onChange={set('document')} /><small>Obrigatório para cobrar</small></label>
          <label className="field">Plano<select value={f.plan} onChange={set('plan')}>
            {plans?.map(p => <option key={p.id} value={p.id}>{p.name} · {(Number(p.price_cents) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</option>)}</select></label>
          <label className="field">Nome do responsável<input required value={f.ownerName} onChange={set('ownerName')} /></label>
          <label className="field">E-mail do responsável<input type="email" required value={f.ownerEmail} onChange={set('ownerEmail')} /></label>
          <label className="field">WhatsApp do responsável<input placeholder="+5519999999999" pattern="\+\d{10,15}" value={f.ownerPhone} onChange={set('ownerPhone')} /></label>
        </div>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
          <input type="checkbox" checked={f.startBilling} onChange={set('startBilling')} /> Já criar a assinatura (e o setup) no Asaas
        </label>
        <div className="actions"><button className="btn btn-primary">Cadastrar</button></div>
      </form>
    </>
  );
}
