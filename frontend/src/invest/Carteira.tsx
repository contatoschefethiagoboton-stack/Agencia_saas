import { useState } from 'react';
import { api, brl } from '../api';
import { useLoad } from '../ui/useLoad';
import { useStepUp } from '../auth/StepUp';
import { Spinner } from './parts';

interface Wallet {
  open: boolean; ready?: boolean; status?: 'pending' | 'active' | 'blocked'; blockedReason?: string | null; pixKey?: string | null; balanceCents?: number | null;
  statement?: { date: string; valueCents: number; description: string }[];
  payoutKeys?: { id: string; key_type: string; key_masked: string; active_from: string; ativa: boolean }[];
  txs?: { id: string; kind: string; amount_cents: number; status: string; description: string | null; error: string | null; created_at: string; contraparte: string | null }[];
  limits: { txMax: number; dayMax: number };
}
const uuid = () => crypto.randomUUID();
const toCents = (s: string) => Math.round(Number(s.replace(/\./g, '').replace(',', '.')) * 100);

/** Carteira: subconta no Asaas (instituição autorizada pelo Banco Central). Depósito por PIX, envio entre clientes e saque. */
export default function Carteira() {
  const { data: w, error, reload } = useLoad<Wallet>('/wallet');
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  const [docs, setDocs] = useState<{ general: string; documents: { title: string; status: string; onboardingUrl?: string }[] } | null>(null);
  const [qr, setQr] = useState<{ qr: string | null; copiaECola: string } | null>(null);
  const guard = useStepUp();
  async function act<T>(fn: () => Promise<T>, ok?: string) {
    setMsg({});
    try { const r = await fn(); if (ok) setMsg({ ok }); reload(); return r; } catch (e) { setMsg({ err: (e as Error).message }); }
  }
  if (error) return <p className="msg err">{error}</p>;
  if (!w) return <Spinner />;
  return (
    <>
      <div className="page-head"><div><span className="eyebrow">Dinheiro protegido no Asaas</span><h1>Carteira</h1></div></div>
      {msg.err && <p className="msg err" role="alert">{msg.err}</p>}{msg.ok && <p className="msg ok" role="status">{msg.ok}</p>}
      {!w.open ? <Abrir ready={Boolean(w.ready)} onDone={() => { setMsg({ ok: 'Carteira criada! Agora envie os documentos pedidos.' }); reload(); }} guard={guard} />
      : <>
        {w.status === 'blocked' && <p className="msg err">Carteira bloqueada: {w.blockedReason}</p>}
        {w.status === 'pending' && (
          <div className="card">
            <h2>Aprovação da conta</h2>
            <p className="card-sub" style={{ margin: 0 }}>Para movimentar dinheiro, o Asaas (exigência do Banco Central) confere seus documentos. Envie pelos links abaixo e depois clique em atualizar.</p>
            <button className="btn btn-primary" onClick={() => act(async () => setDocs(await api('/wallet/refresh', { body: {} })))}>Ver documentos e atualizar situação</button>
            {docs && <><p>Situação: <b>{docs.general === 'APPROVED' ? 'Aprovada' : docs.general === 'REJECTED' ? 'Recusada' : 'Em análise'}</b></p>
              <ul className="steps">{docs.documents.map(d => <li key={d.title}>{d.title}: {d.status}{d.onboardingUrl && <> · <a href={d.onboardingUrl} target="_blank" rel="noreferrer">enviar</a></>}</li>)}</ul></>}
          </div>)}
        {w.status === 'active' && <>
          <div className="grid-kpi">
            <div className="card kpi"><span className="kpi-label">Saldo disponível</span><div className="kpi-value"><b>{w.balanceCents !== null && w.balanceCents !== undefined ? brl(w.balanceCents) : '—'}</b></div></div>
            <div className="card kpi"><span className="kpi-label">Limite por operação</span><div className="kpi-value"><b>{brl(w.limits.txMax)}</b></div></div>
            <div className="card kpi"><span className="kpi-label">Limite por dia</span><div className="kpi-value"><b>{brl(w.limits.dayMax)}</b></div></div>
          </div>
          <div className="row">
            <div className="card narrow">
              <h2>Depositar (PIX)</h2>
              <p className="card-sub" style={{ margin: 0 }}>O dinheiro cai na sua carteira em segundos.</p>
              <button className="btn btn-primary" onClick={() => act(async () => setQr(await api('/wallet/deposit', { body: {} })))}>Gerar QR Code</button>
              {qr && <>{qr.qr && <img className="qr" src={qr.qr} alt="QR Code PIX para depósito" />}
                <label className="field">PIX copia e cola<input readOnly value={qr.copiaECola} onFocus={e => e.target.select()} /></label></>}
            </div>
            <Enviar onSent={() => { setMsg({ ok: 'Transferência enviada.' }); reload(); }} onErr={e => setMsg({ err: e })} />
            <Sacar w={w} onDone={t => { setMsg({ ok: t }); reload(); }} onErr={e => setMsg({ err: e })} />
          </div>
        </>}
        <div className="card">
          <h2>Movimentações</h2>
          {!(w.txs?.length || w.statement?.length) ? <p className="card-sub">Nenhuma movimentação ainda.</p> : (
            <div className="table-wrap"><table className="tbl">
              <thead><tr><th>Data</th><th>Descrição</th><th className="n">Valor</th><th>Situação</th></tr></thead>
              <tbody>
                {w.txs?.map(t => (
                  <tr key={t.id}><td>{new Date(t.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</td>
                    <td>{t.kind === 'envio' ? `Enviado para ${t.contraparte}` : t.kind === 'recebimento' ? `Recebido de ${t.contraparte}` : 'Saque PIX'}{t.description ? ` · ${t.description}` : ''}
                      {t.error && <div className="card-sub down">{t.error}</div>}</td>
                    <td className={`n ${t.kind === 'recebimento' ? 'up' : 'down'}`}>{t.kind === 'recebimento' ? '+' : '−'}{brl(t.amount_cents)}</td>
                    <td><span className={`badge ${t.status === 'done' ? 'good' : t.status === 'pending' ? 'warn' : 'bad'}`}>{{ done: 'Concluída', pending: 'Processando', failed: 'Falhou', blocked: 'Bloqueada' }[t.status]}</span></td></tr>))}
              </tbody></table></div>)}
          {!!w.statement?.length && <details><summary className="card-sub">Extrato completo do Asaas</summary>
            <table className="tbl"><tbody>{w.statement.map((s, i) => <tr key={i}><td>{new Date(s.date).toLocaleDateString('pt-BR')}</td><td>{s.description}</td>
              <td className={`n ${s.valueCents >= 0 ? 'up' : 'down'}`}>{brl(s.valueCents)}</td></tr>)}</tbody></table></details>}
        </div>
      </>}
      <p className="card-sub" style={{ margin: 0 }}>Segurança: cada envio e saque pede o código do autenticador na hora; saídas ficam bloqueadas por 24 h depois de entrar por um aparelho novo
        ou trocar a senha; chave de saque nova só vale depois de 24 h; você recebe e-mail a cada saque.</p>
    </>
  );
}

function Abrir({ ready, onDone, guard }: { ready: boolean; onDone: () => void; guard: ReturnType<typeof useStepUp> }) {
  const [f, setF] = useState({ birthDate: '', mobilePhone: '', postalCode: '', address: '', addressNumber: '', province: '', incomeValue: '' });
  const [err, setErr] = useState('');
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  if (!ready) return <div className="card"><p className="card-sub" style={{ margin: 0 }}>A carteira ainda não foi ativada pelo administrador (Asaas não configurado).</p></div>;
  return (
    <form className="card" onSubmit={async e => { e.preventDefault(); setErr('');
      try { await guard(() => api('/wallet/open', { body: { ...f, mobilePhone: f.mobilePhone.replace(/\D/g, ''), postalCode: f.postalCode.replace(/\D/g, ''),
        incomeValue: Number(f.incomeValue.replace(/\./g, '').replace(',', '.')) } })); onDone(); } catch (x) { setErr((x as Error).message); } }}>
      <h2>Abrir minha carteira</h2>
      <p className="card-sub" style={{ margin: 0 }}>A conta é aberta no Asaas, instituição de pagamento autorizada pelo Banco Central. Seus dados vão direto para eles.</p>
      <div className="form-grid">
        <label className="field">Data de nascimento<input type="date" required value={f.birthDate} onChange={set('birthDate')} /></label>
        <label className="field">Celular<input required inputMode="tel" value={f.mobilePhone} onChange={set('mobilePhone')} placeholder="19999998888" /></label>
        <label className="field">CEP<input required inputMode="numeric" value={f.postalCode} onChange={set('postalCode')} /></label>
        <label className="field">Endereço<input required value={f.address} onChange={set('address')} /></label>
        <label className="field">Número<input required value={f.addressNumber} onChange={set('addressNumber')} /></label>
        <label className="field">Bairro<input required value={f.province} onChange={set('province')} /></label>
        <label className="field">Renda mensal (R$)<input required inputMode="decimal" value={f.incomeValue} onChange={set('incomeValue')} /></label>
      </div>
      {err && <p className="msg err">{err}</p>}
      <div className="actions"><button className="btn btn-primary">Abrir carteira</button></div>
    </form>
  );
}

function Enviar({ onSent, onErr }: { onSent: () => void; onErr: (e: string) => void }) {
  const [f, setF] = useState({ email: '', valor: '', description: '', code: '' });
  const [quem, setQuem] = useState<string | null>(null);
  const [key, setKey] = useState(uuid());
  const [busy, setBusy] = useState(false);
  async function conferir() {
    setQuem(null);
    try { setQuem((await api(`/wallet/recipient?email=${encodeURIComponent(f.email)}`)).name); } catch (e) { onErr((e as Error).message); }
  }
  async function enviar(e: React.FormEvent) {
    e.preventDefault(); setBusy(true);
    try { await api('/wallet/send', { body: { email: f.email, amountCents: toCents(f.valor), description: f.description || undefined, code: f.code, idempotencyKey: key } });
          setF({ email: '', valor: '', description: '', code: '' }); setQuem(null); setKey(uuid()); onSent(); }
    catch (x) { onErr((x as Error).message); setF(v => ({ ...v, code: '' })); }
    setBusy(false);
  }
  return (
    <form className="card narrow" onSubmit={enviar}>
      <h2>Enviar para outro cliente</h2>
      <label className="field">E-mail do cliente<input type="email" required value={f.email} onChange={e => { setF({ ...f, email: e.target.value }); setQuem(null); }} onBlur={() => f.email.includes('@') && conferir()} /></label>
      {quem && <p className="msg ok" style={{ margin: 0 }}>Destinatário: <b>{quem}</b></p>}
      <label className="field">Valor (R$)<input required inputMode="decimal" value={f.valor} onChange={e => setF({ ...f, valor: e.target.value })} /></label>
      <label className="field">Descrição (opcional)<input maxLength={140} value={f.description} onChange={e => setF({ ...f, description: e.target.value })} /></label>
      <label className="field">Código do autenticador<input className="code-input" inputMode="numeric" maxLength={6} required value={f.code} onChange={e => setF({ ...f, code: e.target.value.replace(/\D/g, '') })} /></label>
      <button className="btn btn-primary" disabled={busy || !quem || f.code.length !== 6}>{busy ? 'Enviando…' : 'Confirmar envio'}</button>
    </form>
  );
}

function Sacar({ w, onDone, onErr }: { w: Wallet; onDone: (t: string) => void; onErr: (e: string) => void }) {
  const [f, setF] = useState({ keyId: '', valor: '', code: '' });
  const [nova, setNova] = useState({ keyType: 'CPF', keyValue: '', code: '' });
  const [key, setKey] = useState(uuid());
  const ativas = w.payoutKeys?.filter(k => k.ativa) ?? [];
  return (
    <div className="card narrow">
      <h2>Sacar para o banco</h2>
      <form className="form-grid" onSubmit={async e => { e.preventDefault();
        try { await api('/wallet/withdraw', { body: { payoutKeyId: f.keyId, amountCents: toCents(f.valor), code: f.code, idempotencyKey: key } });
              setF({ keyId: '', valor: '', code: '' }); setKey(uuid()); onDone('Saque enviado. Você recebe um e-mail de confirmação.'); }
        catch (x) { onErr((x as Error).message); setF(v => ({ ...v, code: '' })); } }}>
        <label className="field">Chave PIX<select required value={f.keyId} onChange={e => setF({ ...f, keyId: e.target.value })}>
          <option value="">Escolha…</option>{ativas.map(k => <option key={k.id} value={k.id}>{k.key_type} {k.key_masked}</option>)}</select></label>
        <label className="field">Valor (R$)<input required inputMode="decimal" value={f.valor} onChange={e => setF({ ...f, valor: e.target.value })} /></label>
        <label className="field">Código do autenticador<input className="code-input" inputMode="numeric" maxLength={6} required value={f.code} onChange={e => setF({ ...f, code: e.target.value.replace(/\D/g, '') })} /></label>
        <button className="btn btn-primary" disabled={!f.keyId || f.code.length !== 6}>Sacar</button>
      </form>
      <details>
        <summary className="card-sub">Chaves de saque ({w.payoutKeys?.length ?? 0})</summary>
        {w.payoutKeys?.map(k => <div key={k.id} className="net-item"><span>{k.key_type} {k.key_masked}<br /><small className="card-sub">{k.ativa ? 'liberada' : `liberada em ${new Date(k.active_from).toLocaleString('pt-BR')}`}</small></span>
          <button className="link-btn" onClick={async () => { try { await api(`/wallet/payout-keys/${k.id}`, { method: 'DELETE' }); onDone('Chave removida.'); } catch (x) { onErr((x as Error).message); } }}>Remover</button></div>)}
        <form className="form-grid" onSubmit={async e => { e.preventDefault();
          try { await api('/wallet/payout-keys', { body: nova }); setNova({ keyType: 'CPF', keyValue: '', code: '' }); onDone('Chave cadastrada. Por segurança, ela só pode ser usada daqui a 24 horas.'); }
          catch (x) { onErr((x as Error).message); } }}>
          <label className="field">Tipo<select value={nova.keyType} onChange={e => setNova({ ...nova, keyType: e.target.value })}>
            {['CPF', 'CNPJ', 'EMAIL', 'PHONE', 'EVP'].map(t => <option key={t}>{t}</option>)}</select></label>
          <label className="field">Chave<input required value={nova.keyValue} onChange={e => setNova({ ...nova, keyValue: e.target.value })} /></label>
          <label className="field">Código do autenticador<input inputMode="numeric" maxLength={6} required value={nova.code} onChange={e => setNova({ ...nova, code: e.target.value.replace(/\D/g, '') })} /></label>
          <button className="btn">Cadastrar chave</button>
        </form>
      </details>
    </div>
  );
}
