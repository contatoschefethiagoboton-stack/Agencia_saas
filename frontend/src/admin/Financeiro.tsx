import { useState } from 'react';
import { api, brl, dataHora } from '../api';
import { useLoad } from '../ui/useLoad';
import { useStepUp } from '../auth/StepUp';

interface PixKey { id: string; key_type: string; key_masked: string; ativa: boolean; active_from: string }
interface Withdrawal { id: string; amount_cents: string; status: string; created_at: string; key_type: string }
interface Plan { id: string; name: string; price_cents: string; setup_cents: string; ai_quota_cents: string;
                 wa_numbers_max: number; posts_per_month: number; active: boolean }

const reais = (v: string) => Math.round(Number(v.replace(/\./g, '').replace(',', '.')) * 100);

export default function Financeiro() {
  const dash = useLoad<{ carteiraPessoalCents: string; fundoMidiaCents: string }>('/admin/dashboard');
  const keys = useLoad<PixKey[]>('/admin/pix-keys');
  const ws = useLoad<Withdrawal[]>('/admin/withdrawals');
  const plans = useLoad<Plan[]>('/admin/plans');
  const guard = useStepUp();
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [saque, setSaque] = useState({ valor: '', pixKeyId: '' });
  const [chave, setChave] = useState({ keyType: 'CNPJ', keyValue: '' });

  const act = async (fn: () => Promise<any>, text: string, after?: () => void) => {
    setMsg(null);
    try { await guard(fn); setMsg({ kind: 'ok', text }); after?.(); }
    catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); }
  };

  return (
    <>
      <header className="page-head"><div><span className="eyebrow">Painel Master</span><h1>Tesouraria</h1></div></header>
      {msg && <p className={`msg ${msg.kind}`} role="status">{msg.text}</p>}

      <section className="grid-kpi">
        <article className="card kpi"><span className="kpi-label">Disponível para saque (lucro)</span>
          <div className="kpi-value"><b>{brl(dash.data?.carteiraPessoalCents)}</b></div></article>
        <article className="card kpi"><span className="kpi-label">Fundo de mídia da agência</span>
          <div className="kpi-value"><b>{brl(dash.data?.fundoMidiaCents)}</b></div>
          <span className="card-sub">Para campanhas de captação de novos clientes</span></article>
      </section>

      <section className="row">
        <form className="card half" onSubmit={e => { e.preventDefault();
          act(() => api('/admin/withdrawals', { body: { amountCents: String(reais(saque.valor)), pixKeyId: saque.pixKeyId } }),
              'Saque enviado via PIX', () => { dash.reload(); ws.reload(); }); }}>
          <h2>Sacar via PIX</h2>
          <span className="card-sub">Pede o código do 2FA. Limite diário configurado em WITHDRAWAL_DAILY_CAP_CENTS.</span>
          <label className="field">Valor (R$)<input inputMode="decimal" placeholder="1.000,00" required value={saque.valor} onChange={e => setSaque({ ...saque, valor: e.target.value })} /></label>
          <label className="field">Chave PIX<select required value={saque.pixKeyId} onChange={e => setSaque({ ...saque, pixKeyId: e.target.value })}>
            <option value="">Escolha…</option>
            {keys.data?.filter(k => k.ativa).map(k => <option key={k.id} value={k.id}>{k.key_type} {k.key_masked}</option>)}</select></label>
          <button className="btn btn-primary">Sacar</button>
        </form>

        <form className="card half" onSubmit={e => { e.preventDefault();
          act(() => api('/admin/pix-keys', { body: chave }), 'Chave cadastrada. Por segurança, ela só pode receber saques daqui a 24 horas.',
              () => { keys.reload(); setChave({ ...chave, keyValue: '' }); }); }}>
          <h2>Chaves PIX de saque</h2>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14 }}>
            {keys.data?.map(k => <li key={k.id}>{k.key_type} <span className="mono">{k.key_masked}</span> {k.ativa ? <span className="badge good">ativa</span> : <span className="badge warn">em carência até {dataHora(k.active_from)}</span>}</li>)}
            {keys.data?.length === 0 && <li className="card-sub">Nenhuma chave cadastrada</li>}
          </ul>
          <div className="form-grid">
            <label className="field">Tipo<select value={chave.keyType} onChange={e => setChave({ ...chave, keyType: e.target.value })}>
              {['CPF', 'CNPJ', 'EMAIL', 'PHONE', 'EVP'].map(t => <option key={t}>{t}</option>)}</select></label>
            <label className="field">Chave<input required value={chave.keyValue} onChange={e => setChave({ ...chave, keyValue: e.target.value })} /></label>
          </div>
          <button className="btn">Cadastrar chave</button>
        </form>
      </section>

      <section className="card">
        <h2>Saques</h2>
        {ws.data?.length ? <div className="table-wrap"><table className="tbl"><thead><tr><th>Data</th><th>Chave</th><th className="n">Valor</th><th>Situação</th></tr></thead>
          <tbody>{ws.data.map(w => <tr key={w.id}><td>{dataHora(w.created_at)}</td><td>{w.key_type}</td><td className="n">{brl(w.amount_cents)}</td>
            <td><span className={`badge ${w.status === 'sent' ? 'good' : w.status === 'failed' ? 'bad' : 'warn'}`}>{{ sent: 'Enviado', failed: 'Falhou (estornado)', requested: 'Solicitado' }[w.status] ?? w.status}</span></td></tr>)}</tbody></table></div>
          : <p className="card-sub">Nenhum saque ainda.</p>}
      </section>

      <section className="card">
        <h2>Planos de assinatura</h2>
        <span className="card-sub">Valores em reais. A cota de IA é o teto mensal de custo por cliente.</span>
        {plans.data?.map(p => <PlanRow key={p.id} p={p} onSaved={t => { setMsg({ kind: 'ok', text: t }); plans.reload(); }}
                                         onError={t => setMsg({ kind: 'err', text: t })} />)}
      </section>
    </>
  );
}

function PlanRow({ p, onSaved, onError }: { p: Plan; onSaved: (t: string) => void; onError: (t: string) => void }) {
  const fmt = (c: string) => (Number(c) / 100).toFixed(2).replace('.', ',');
  const [v, setV] = useState({ name: p.name, price: fmt(p.price_cents), setup: fmt(p.setup_cents), ia: fmt(p.ai_quota_cents),
                               wa: String(p.wa_numbers_max), posts: String(p.posts_per_month) });
  const set = (k: keyof typeof v) => (e: any) => setV({ ...v, [k]: e.target.value });
  const save = () => api(`/admin/plans/${p.id}`, { method: 'PUT', body: { name: v.name, priceCents: reais(v.price), setupCents: reais(v.setup),
    aiQuotaCents: reais(v.ia), waNumbersMax: Number(v.wa), postsPerMonth: Number(v.posts), active: p.active } })
    .then(() => onSaved(`Plano ${v.name} salvo`)).catch(e => onError(e.message));
  return (
    <form className="form-grid" style={{ borderTop: '1px solid var(--border)', paddingTop: 14, marginTop: 14 }} onSubmit={e => { e.preventDefault(); save(); }}>
      <label className="field">Nome ({p.id})<input value={v.name} onChange={set('name')} /></label>
      <label className="field">Mensalidade<input value={v.price} onChange={set('price')} /></label>
      <label className="field">Setup<input value={v.setup} onChange={set('setup')} /></label>
      <label className="field">Cota de IA/mês<input value={v.ia} onChange={set('ia')} /></label>
      <label className="field">Números WhatsApp<input type="number" min={0} value={v.wa} onChange={set('wa')} /></label>
      <label className="field">Conteúdos/mês<input type="number" min={0} value={v.posts} onChange={set('posts')} /></label>
      <div className="actions" style={{ alignSelf: 'end' }}><button className="btn">Salvar</button></div>
    </form>
  );
}
