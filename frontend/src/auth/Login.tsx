import { useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from '../api';
import { Icon } from '../ui/Icon';

/** Tela de entrada moderna: painel da marca à esquerda e o formulário à direita (no celular, só o formulário). */
export function AuthLayout({ admin, children }: { admin?: boolean; children: ReactNode }) {
  return (
    <div className="auth">
      <aside className={`auth-brand${admin ? ' admin' : ''}`}>
        <div className="auth-logo"><i>R</i>Radar Invest</div>
        {admin ? <>
          <h2>Painel Master da plataforma</h2>
          <ul>
            <li><Icon name="users" />Clientes, planos, aprovações e contas VIP</li>
            <li><Icon name="copy" />Estratégias de copy trade</li>
            <li><Icon name="shield" />Auditoria, modo pânico e 2FA obrigatório</li>
          </ul>
        </> : <>
          <h2>Cripto, ações e FIIs com sinais em tempo real</h2>
          <ul>
            <li><Icon name="chart" />Gráficos profissionais com médias, RSI, MACD e Bollinger</li>
            <li><Icon name="bolt" />Sinais de compra e venda com acerto histórico e backtest</li>
            <li><Icon name="bot" />Robôs e copy trade na sua própria corretora</li>
          </ul>
        </>}
        <small className="card-sub">Acesso protegido com verificação em duas etapas.</small>
      </aside>
      <div className="auth-form">{children}</div>
    </div>
  );
}


type Step =
  | { kind: 'password' }
  | { kind: 'forgot' }
  | { kind: 'signup' }
  | { kind: 'code'; ticket: string; method: 'totp' | 'whatsapp' | 'totp_setup'; qr?: string; secret?: string };

/** Login com 2FA obrigatório. area="admin" é o acesso separado do administrador (ADMIN_PATH); "cliente" é a tela principal. */
export default function Login({ onDone, area = 'cliente' }: { onDone: (mustChangePassword: boolean) => void; area?: 'cliente' | 'admin' }) {
  const isAdmin = area === 'admin';
  const [step, setStep] = useState<Step>({ kind: 'password' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [payUrl, setPayUrl] = useState<string | null>(null);

  async function submit() {
    setErr(''); setBusy(true); setPayUrl(null);
    try {
      if (step.kind === 'password') {
        const r = await api('/auth/login', { body: { email, password, area } });
        setCode(''); setStep({ kind: 'code', ticket: r.ticket, method: r.method, qr: r.qr, secret: r.secret });
      } else if (step.kind === 'code') {
        const r = await api('/auth/login/verify', { body: { ticket: step.ticket, code } });
        onDone(Boolean(r.mustChangePassword));
      }
    } catch (e) {
      setErr((e as Error).message);
      if (e instanceof ApiError && e.status === 402) setPayUrl(e.data.payUrl ?? null);
      if ((e as Error).message.startsWith('Tempo esgotado')) setStep({ kind: 'password' });
    } finally { setBusy(false); }
  }

  return (
    <AuthLayout admin={isAdmin}>
      <form className="card auth-card" onSubmit={e => { e.preventDefault(); if (step.kind !== 'forgot' && step.kind !== 'signup') submit(); }}>
        <div className="auth-logo auth-mobile-logo"><i>R</i>Radar Invest</div>
        <div>
          <span className="eyebrow card-sub">{isAdmin ? 'Painel Master · acesso restrito' : step.kind === 'password' ? 'Bem-vindo de volta' : 'Radar Invest'}</span>
          <h1>{step.kind === 'password' ? (isAdmin ? 'Acesso do administrador' : 'Entrar') : step.kind === 'forgot' ? 'Esqueci minha senha' : step.kind === 'signup' ? 'Criar conta' : step.method === 'totp_setup' ? 'Proteja sua conta' : 'Verificação em duas etapas'}</h1>
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
                        <label className="field">Código de 6 dígitos
              <input className="code-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus
                     value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} />
            </label>
          </>
        )}

        {step.kind !== 'forgot' && step.kind !== 'signup' && <>
          {err && <p className={`msg ${payUrl !== null ? 'warn' : 'err'}`} role="alert">{err}</p>}
          {payUrl && <a className="btn btn-good" href={payUrl} target="_blank" rel="noreferrer">Pagar agora (PIX ou cartão)</a>}
          <button className="btn btn-primary" disabled={busy || (step.kind === 'code' && code.length !== 6)}>
            {busy ? 'Aguarde…' : step.kind === 'password' ? 'Continuar' : 'Entrar'}
          </button>
        </>}
        {step.kind === 'password' && (
          <>
            <button type="button" className="link-btn" onClick={() => { setErr(''); setStep({ kind: 'forgot' }); }}>Esqueci minha senha</button>
            <div className="auth-divider">Ainda não tem conta?</div>
            <button type="button" className="btn" onClick={() => { setErr(''); setStep({ kind: 'signup' }); }}>Criar conta e escolher plano</button>
          </>
        )}
        {step.kind === 'code' && (
          <button type="button" className="btn" onClick={() => { setStep({ kind: 'password' }); setErr(''); }}>Voltar</button>
        )}
      </form>
    </AuthLayout>
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
    <AuthLayout>
      <form className="card auth-card" onSubmit={e => { e.preventDefault(); submit(); }}>
        <div className="auth-logo auth-mobile-logo"><i>R</i>Radar Invest</div>
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
    </AuthLayout>
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
    <AuthLayout>
      <form className="card auth-card" onSubmit={e => { e.preventDefault(); done ? onDone() : submit(); }}>
        <div className="auth-logo auth-mobile-logo"><i>R</i>Radar Invest</div>
        <div><span className="eyebrow card-sub">Radar Invest</span><h1>Criar senha nova</h1></div>
        {!done && <>
          <label className="field">Senha nova (mínimo 10 caracteres)
            <input type="password" autoComplete="new-password" required minLength={10} value={pw} onChange={e => setPw(e.target.value)} /></label>
          <label className="field">Repita a senha nova
            <input type="password" autoComplete="new-password" required minLength={10} value={again} onChange={e => setAgain(e.target.value)} /></label>
        </>}
        {msg && <p className={`msg ${msg.kind}`} role="status">{msg.text}</p>}
        <button className="btn btn-primary">{done ? 'Ir para o login' : 'Salvar senha nova'}</button>
      </form>
    </AuthLayout>
  );
}

interface PlanoPub { id: string; name: string; price_cents: number; description: string }

/** Cadastro: escolhe o plano, paga por PIX ou cartão na página segura do Asaas e o acesso libera sozinho. */
function Signup({ onBack }: { onBack: () => void }) {
  const [plans, setPlans] = useState<PlanoPub[]>([]);
  const [f, setF] = useState({ name: '', email: '', document: '', phone: '', password: '', again: '', plan: 'medio', billingType: 'PIX', website: '' });
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ payUrl?: string } | null>(null);
  useEffect(() => { api<PlanoPub[]>('/auth/plans').then(setPlans).catch(() => {}); }, []);
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.value });
  async function send() {
    if (f.password !== f.again) return setMsg({ kind: 'err', text: 'As senhas não são iguais' });
    setBusy(true); setMsg(null);
    try {
      const r = await api('/auth/signup', { body: { name: f.name, email: f.email, document: f.document, phone: f.phone.replace(/\D/g, '') || undefined,
        password: f.password, plan: f.plan, billingType: f.billingType, website: f.website || undefined } });
      setDone({ payUrl: r.payUrl }); setMsg({ kind: 'ok', text: r.message });
    } catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); }
    finally { setBusy(false); }
  }
  if (done) return <>
    <p className="msg ok" role="status">{msg?.text}</p>
    {done.payUrl && <a className="btn btn-good" href={done.payUrl} target="_blank" rel="noreferrer">Ir para o pagamento ({f.billingType === 'PIX' ? 'PIX' : 'cartão'})</a>}
    <p className="card-sub" style={{ margin: 0 }}>O pagamento é feito na página segura do Asaas: os dados do cartão não passam pela plataforma. Depois, entre com seu e-mail e senha.</p>
    <button type="button" className="btn btn-primary" onClick={onBack}>Voltar para o login</button></>;
  const field = (k: keyof typeof f, label: string, props: Record<string, unknown> = {}) =>
    <label className="field">{label}<input value={f[k]} onChange={set(k)} {...props} /></label>;
  return (
    <>
      <div className="plan-pick" role="radiogroup" aria-label="Plano">
        {plans.map(p => (
          <button type="button" key={p.id} role="radio" aria-checked={f.plan === p.id} className="plan-opt" onClick={() => setF({ ...f, plan: p.id })}>
            <b>{p.name}</b><span className="plan-price">{(p.price_cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}<small>/mês</small></span>
            <small>{p.description}</small>
          </button>))}
      </div>
      {field('name', 'Nome completo', { required: true, autoComplete: 'name' })}
      {field('email', 'E-mail', { type: 'email', required: true, autoComplete: 'email' })}
      {field('document', 'CPF', { inputMode: 'numeric', required: true, placeholder: '000.000.000-00' })}
      {field('phone', 'Celular (com DDD)', { inputMode: 'tel', placeholder: '19 99999-9999' })}
      {field('password', 'Senha (mínimo 10 caracteres)', { type: 'password', minLength: 10, required: true, autoComplete: 'new-password' })}
      {field('again', 'Repita a senha', { type: 'password', minLength: 10, required: true, autoComplete: 'new-password' })}
      <input className="hp" tabIndex={-1} autoComplete="off" aria-hidden="true" value={f.website} onChange={set('website')} name="website" />
      <div className="seg" role="group" aria-label="Forma de pagamento">
        <button type="button" aria-pressed={f.billingType === 'PIX'} onClick={() => setF({ ...f, billingType: 'PIX' })}>PIX</button>
        <button type="button" aria-pressed={f.billingType === 'CREDIT_CARD'} onClick={() => setF({ ...f, billingType: 'CREDIT_CARD' })}>Cartão de crédito</button>
      </div>
      {msg && <p className={`msg ${msg.kind}`} role="alert">{msg.text}</p>}
      <button type="button" className="btn btn-primary" disabled={busy || f.name.trim().length < 5 || !f.email.includes('@') || f.document.replace(/\D/g, '').length !== 11 || f.password.length < 10}
              onClick={send}>{busy ? 'Enviando…' : 'Criar conta e pagar'}</button>
      <button type="button" className="btn" onClick={onBack}>Já tenho conta</button>
    </>
  );
}
