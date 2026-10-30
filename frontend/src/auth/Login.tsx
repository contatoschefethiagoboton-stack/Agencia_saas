import { useState } from 'react';
import { api } from '../api';

type Step =
  | { kind: 'password' }
  | { kind: 'forgot' }
  | { kind: 'signup' }
  | { kind: 'code'; ticket: string; method: 'totp' | 'whatsapp' | 'totp_setup'; qr?: string; secret?: string };

/** Login com 2FA obrigatório. No primeiro acesso, o usuário cadastra o app autenticador pelo QR Code. */
export default function Login({ onDone }: { onDone: (mustChangePassword: boolean) => void }) {
  const [step, setStep] = useState<Step>({ kind: 'password' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setErr(''); setBusy(true);
    try {
      if (step.kind === 'password') {
        const r = await api('/auth/login', { body: { email, password } });
        setCode(''); setStep({ kind: 'code', ticket: r.ticket, method: r.method, qr: r.qr, secret: r.secret });
      } else if (step.kind === 'code') {
        const r = await api('/auth/login/verify', { body: { ticket: step.ticket, code } });
        onDone(Boolean(r.mustChangePassword));
      }
    } catch (e) {
      setErr((e as Error).message);
      if ((e as Error).message.startsWith('Tempo esgotado')) setStep({ kind: 'password' });
    } finally { setBusy(false); }
  }

  return (
    <div className="center-page">
      <form className="card auth-card" onSubmit={e => { e.preventDefault(); if (step.kind !== 'forgot' && step.kind !== 'signup') submit(); }}>
        <div>
          <span className="eyebrow card-sub">Agência Hub</span>
          <h1>{step.kind === 'password' ? 'Entrar' : step.kind === 'forgot' ? 'Esqueci minha senha' : step.kind === 'signup' ? 'Criar conta' : step.method === 'totp_setup' ? 'Proteja sua conta' : 'Verificação em duas etapas'}</h1>
        </div>

        {step.kind === 'signup' ? (
          <Signup onBack={() => setStep({ kind: 'password' })} />
        ) : step.kind === 'forgot' ? (
          <Forgot email={email} onBack={() => setStep({ kind: 'password' })} />
        ) : step.kind === 'password' ? (
          <>
            <label className="field">E-mail
              <input type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} />
            </label>
            <label className="field">Senha
              <input type="password" autoComplete="current-password" required minLength={8}
                     value={password} onChange={e => setPassword(e.target.value)} />
            </label>
          </>
        ) : (
          <>
            {step.method === 'totp_setup' && (
              <>
                <p style={{ margin: 0 }}>
                  Instale um aplicativo autenticador (Google Authenticator, Microsoft Authenticator ou Authy),
                  toque em <b>adicionar</b> e leia o QR Code. Depois digite o código de 6 dígitos que aparecer.
                </p>
                {step.qr && <img className="qr" src={step.qr} alt="QR Code para o aplicativo autenticador" />}
                <details><summary className="card-sub">Não consegue ler? Digite a chave</summary>
                  <p className="mono">{step.secret}</p></details>
              </>
            )}
            {step.method === 'totp' && <p style={{ margin: 0 }}>Abra seu aplicativo autenticador e digite o código.</p>}
            {step.method === 'whatsapp' && <p style={{ margin: 0 }}>Enviamos um código para o seu WhatsApp.</p>}
            <label className="field">Código de 6 dígitos
              <input className="code-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus
                     value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} />
            </label>
          </>
        )}

        {step.kind !== 'forgot' && step.kind !== 'signup' && <>
          {err && <p className="msg err" role="alert">{err}</p>}
          <button className="btn btn-primary" disabled={busy || (step.kind === 'code' && code.length !== 6)}>
            {busy ? 'Aguarde…' : step.kind === 'password' ? 'Continuar' : 'Entrar'}
          </button>
        </>}
        {step.kind === 'password' && (
          <>
            <button type="button" className="btn" onClick={() => { setErr(''); setStep({ kind: 'forgot' }); }}>Esqueci minha senha</button>
            <p className="card-sub" style={{ margin: 0, textAlign: 'center' }}>Ainda não tem conta?{' '}
              <button type="button" className="btn" style={{ minHeight: 36, padding: '0 12px' }} onClick={() => { setErr(''); setStep({ kind: 'signup' }); }}>Criar conta</button></p>
          </>
        )}
        {step.kind === 'code' && (
          <button type="button" className="btn" onClick={() => { setStep({ kind: 'password' }); setErr(''); }}>Voltar</button>
        )}
      </form>
    </div>
  );
}

/** Primeiro acesso com senha provisória: troca obrigatória. */
export function ChangePassword({ onDone }: { onDone: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [err, setErr] = useState('');
  async function submit() {
    if (next !== again) return setErr('As senhas novas não são iguais');
    try { await api('/auth/password', { body: { current, next } }); onDone(); }
    catch (e) { setErr((e as Error).message); }
  }
  return (
    <div className="center-page">
      <form className="card auth-card" onSubmit={e => { e.preventDefault(); submit(); }}>
        <h1>Crie sua senha</h1>
        <p style={{ margin: 0 }} className="card-sub">Você entrou com uma senha provisória. Escolha uma nova com pelo menos 10 caracteres.</p>
        <label className="field">Senha provisória
          <input type="password" autoComplete="current-password" required value={current} onChange={e => setCurrent(e.target.value)} />
        </label>
        <label className="field">Nova senha
          <input type="password" autoComplete="new-password" required minLength={10} value={next} onChange={e => setNext(e.target.value)} />
        </label>
        <label className="field">Repita a nova senha
          <input type="password" autoComplete="new-password" required minLength={10} value={again} onChange={e => setAgain(e.target.value)} />
        </label>
        {err && <p className="msg err" role="alert">{err}</p>}
        <button className="btn btn-primary">Salvar e entrar</button>
      </form>
    </div>
  );
}

/** Pede o link de redefinição. A mensagem é a mesma para qualquer e-mail (não revela quem tem cadastro). */
function Forgot({ email: initial, onBack }: { email: string; onBack: () => void }) {
  const [email, setEmail] = useState(initial);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function send() {
    setBusy(true); setMsg(null);
    try { const r = await api('/auth/forgot', { body: { email } }); setMsg({ kind: 'ok', text: r.message }); }
    catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); }
    finally { setBusy(false); }
  }
  return (
    <>
      <p style={{ margin: 0 }} className="card-sub">Digite o e-mail da sua conta. Enviamos um link para você criar uma senha nova.</p>
      <label className="field">E-mail
        <input type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)}
               onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); send(); } }} />
      </label>
      {msg && <p className={`msg ${msg.kind}`} role="status">{msg.text}</p>}
      <button type="button" className="btn btn-primary" disabled={busy || !email.includes('@')} onClick={send}>{busy ? 'Enviando…' : 'Enviar link'}</button>
      <button type="button" className="btn" onClick={onBack}>Voltar para o login</button>
    </>
  );
}

/** Página aberta pelo link do e-mail (#redefinir?token=...). Funciona sem estar logado. */
export function ResetPassword({ token, onDone }: { token: string; onDone: () => void }) {
  const [pw, setPw] = useState('');
  const [again, setAgain] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [done, setDone] = useState(false);
  async function submit() {
    if (pw !== again) return setMsg({ kind: 'err', text: 'As senhas não são iguais' });
    try { await api('/auth/reset', { body: { token, password: pw } }); setDone(true); setMsg({ kind: 'ok', text: 'Senha alterada! Entre com a senha nova.' }); }
    catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); }
  }
  return (
    <div className="center-page">
      <form className="card auth-card" onSubmit={e => { e.preventDefault(); done ? onDone() : submit(); }}>
        <div><span className="eyebrow card-sub">Agência Hub</span><h1>Criar senha nova</h1></div>
        {!done && <>
          <label className="field">Senha nova (mínimo 10 caracteres)
            <input type="password" autoComplete="new-password" required minLength={10} value={pw} onChange={e => setPw(e.target.value)} /></label>
          <label className="field">Repita a senha nova
            <input type="password" autoComplete="new-password" required minLength={10} value={again} onChange={e => setAgain(e.target.value)} /></label>
        </>}
        {msg && <p className={`msg ${msg.kind}`} role="status">{msg.text}</p>}
        <button className="btn btn-primary">{done ? 'Ir para o login' : 'Salvar senha nova'}</button>
      </form>
    </div>
  );
}

/** Cadastro do próprio cliente. O acesso só é liberado depois que a agência aprova. */
function Signup({ onBack }: { onBack: () => void }) {
  const [f, setF] = useState({ business: '', niche: '', city: '', name: '', email: '', phone: '', password: '', again: '' });
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.value });
  async function send() {
    if (f.password !== f.again) return setMsg({ kind: 'err', text: 'As senhas não são iguais' });
    setBusy(true); setMsg(null);
    try {
      const r = await api('/auth/signup', { body: { business: f.business, niche: f.niche || undefined, city: f.city || undefined, name: f.name,
        email: f.email, phone: f.phone.replace(/\D/g, '') || undefined, password: f.password } });
      setDone(true); setMsg({ kind: 'ok', text: r.message });
    } catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); }
    finally { setBusy(false); }
  }
  if (done) return <><p className="msg ok" role="status">{msg?.text}</p><button type="button" className="btn btn-primary" onClick={onBack}>Voltar para o login</button></>;
  const field = (k: keyof typeof f, label: string, props: Record<string, unknown> = {}) =>
    <label className="field">{label}<input value={f[k]} onChange={set(k)} {...props} /></label>;
  return (
    <>
      <p style={{ margin: 0 }} className="card-sub">Preencha os dados. A agência confere e libera o seu acesso.</p>
      {field('business', 'Nome do negócio', { required: true })}
      {field('niche', 'Ramo', { placeholder: 'padaria, clínica, barbearia, consultoria…' })}
      {field('city', 'Cidade / bairro')}
      {field('name', 'Seu nome', { required: true, autoComplete: 'name' })}
      {field('email', 'E-mail', { type: 'email', required: true, autoComplete: 'email' })}
      {field('phone', 'WhatsApp (com DDD)', { inputMode: 'tel', placeholder: '19 99999-9999' })}
      {field('password', 'Senha (mínimo 10 caracteres)', { type: 'password', minLength: 10, required: true, autoComplete: 'new-password' })}
      {field('again', 'Repita a senha', { type: 'password', minLength: 10, required: true, autoComplete: 'new-password' })}
      {msg && <p className={`msg ${msg.kind}`} role="alert">{msg.text}</p>}
      <button type="button" className="btn btn-primary" disabled={busy || !f.business || !f.name || !f.email.includes('@') || f.password.length < 10}
              onClick={send}>{busy ? 'Enviando…' : 'Cadastrar'}</button>
      <button type="button" className="btn" onClick={onBack}>Já tenho conta</button>
    </>
  );
}
