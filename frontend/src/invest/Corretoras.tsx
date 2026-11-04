import { useState } from 'react';
import { api } from '../api';
import { useStepUp } from '../auth/StepUp';
import { useLoad } from '../ui/useLoad';
import { ago } from './format';
import { Spinner } from './parts';

interface Conn { id: string; broker: 'binance' | 'alpaca'; label: string; key_hint: string; paper: boolean; status: string; last_error: string | null;
                 checked_at: string | null; robos: number }

/** Corretoras: o cliente conecta a própria conta com chave de API (só negociação, nunca saque). */
export default function Corretoras() {
  const { data, error, reload } = useLoad<Conn[]>('/bots/connections');
  const [f, setF] = useState({ broker: 'binance' as 'binance' | 'alpaca', label: '', key: '', secret: '', paper: false });
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  const [busy, setBusy] = useState(false);
  const guard = useStepUp();

  async function connect(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setMsg({});
    try {
      const r = await guard(() => api<{ note?: string }>('/bots/connections', { body: { ...f, label: f.label || (f.broker === 'binance' ? 'Binance' : 'Alpaca') } }));
      setMsg({ ok: `Conectada e testada.${r.note ? ` ${r.note}` : ''}` });
      setF({ ...f, label: '', key: '', secret: '' }); reload();
    } catch (e2) { setMsg({ err: (e2 as Error).message }); }
    setBusy(false);
  }
  async function act(fn: () => Promise<unknown>, ok: string) {
    setMsg({});
    try { await fn(); setMsg({ ok }); } catch (e) { setMsg({ err: (e as Error).message }); }
    reload();
  }

  return (
    <>
      <div className="page-head"><div><span className="eyebrow">Sua conta, suas chaves</span><h1>Corretoras</h1></div></div>
      {msg.err && <p className="msg err" role="alert">{msg.err}</p>}
      {msg.ok && <p className="msg ok" role="status">{msg.ok}</p>}
      <div className="row">
        <div className="card half">
          <h2>Conectadas</h2>
          {error ? <p className="msg err">{error}</p> : !data ? <Spinner /> : !data.length ? <p className="card-sub">Nenhuma corretora conectada. Robôs no modo simulado não precisam de corretora.</p> : (
            <div className="net-items">{data.map(c => (
              <div key={c.id} className="net-item">
                <span><b>{c.label}</b> · {c.broker === 'binance' ? 'Binance (cripto)' : `Alpaca (EUA)${c.paper ? ' · papel' : ''}`} · chave •••{c.key_hint}
                  <br /><small className="card-sub">{c.robos} robô(s){c.checked_at ? ` · testada ${ago(c.checked_at)}` : ''}</small>
                  {c.last_error && <><br /><small className="down">{c.last_error}</small></>}</span>
                <span className={`badge ${c.status === 'ok' ? 'good' : 'bad'}`}>{c.status === 'ok' ? 'OK' : 'Erro'}</span>
                <button className="btn" onClick={() => act(() => api(`/bots/connections/${c.id}/check`, { body: {} }), 'Conexão funcionando.')}>Testar</button>
                <button className="link-btn" onClick={() => confirm(`Desconectar ${c.label}? Os robôs que usam esta corretora serão pausados.`) &&
                  act(() => api(`/bots/connections/${c.id}`, { method: 'DELETE' }), 'Corretora desconectada.')}>Desconectar</button>
              </div>))}</div>)}
        </div>

        <form className="card half" onSubmit={connect}>
          <h2>Conectar corretora</h2>
          <div className="seg" role="group" aria-label="Corretora">
            <button type="button" aria-pressed={f.broker === 'binance'} onClick={() => setF({ ...f, broker: 'binance' })}>Binance · cripto</button>
            <button type="button" aria-pressed={f.broker === 'alpaca'} onClick={() => setF({ ...f, broker: 'alpaca' })}>Alpaca · EUA</button>
          </div>
          {f.broker === 'binance' ? (
            <ol className="steps">
              <li>Na Binance: <b>Perfil → Gerenciamento de API → Criar API</b> (tipo "gerada pelo sistema").</li>
              <li>Marque <b>só</b> "Ativar leitura" e "Ativar negociação spot e margem". <b>Nunca</b> marque "Ativar saques": a plataforma recusa chaves com saque.</li>
              <li>Recomendado: restrinja a chave ao IP do servidor da plataforma.</li>
              <li>Cole a API Key e a Secret Key abaixo.</li>
            </ol>) : (
            <ol className="steps">
              <li>Crie a conta em alpaca.markets (aceita brasileiros) e entre no painel.</li>
              <li>Em <b>API Keys</b>, gere uma chave. Comece pela conta <b>Paper</b> (simulada pela própria corretora).</li>
              <li>Cole a Key ID e a Secret abaixo e marque "conta de papel" se for o caso.</li>
            </ol>)}
          <div className="form-grid">
            <label className="field">Apelido<input value={f.label} onChange={e => setF({ ...f, label: e.target.value })} placeholder={f.broker === 'binance' ? 'Binance principal' : 'Alpaca'} /></label>
            <label className="field">API Key<input required autoComplete="off" spellCheck={false} value={f.key} onChange={e => setF({ ...f, key: e.target.value.trim() })} /></label>
            <label className="field">Secret<input required type="password" autoComplete="new-password" value={f.secret} onChange={e => setF({ ...f, secret: e.target.value.trim() })} /></label>
          </div>
          {f.broker === 'alpaca' && <label className="check"><input type="checkbox" checked={f.paper} onChange={e => setF({ ...f, paper: e.target.checked })} /> Conta de papel (paper trading)</label>}
          <p className="card-sub" style={{ margin: 0 }}>As chaves são testadas antes de salvar e ficam criptografadas (AES-256). Ninguém da plataforma consegue sacar seu dinheiro com elas.
            Conectar pede o código do autenticador.</p>
          <div className="actions"><button className="btn btn-primary" disabled={busy}>{busy ? 'Testando…' : 'Testar e conectar'}</button></div>
          <p className="card-sub" style={{ margin: 0 }}>B3: as corretoras brasileiras não liberam API de ordens para pessoa física. Na B3, os robôs funcionam no modo simulado e os sinais servem para você executar na sua corretora.</p>
        </form>
      </div>
    </>
  );
}
