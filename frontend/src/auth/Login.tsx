import { useState } from 'react';
import { api } from '../api';

type Step =
  | { kind: 'password' }
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
      } else {
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
      <form className="card auth-card" onSubmit={e => { e.preventDefault(); submit(); }}>
        <div>
          <span className="eyebrow card-sub">Agência Hub</span>
          <h1>{step.kind === 'password' ? 'Entrar' : step.method === 'totp_setup' ? 'Proteja sua conta' : 'Verificação em duas etapas'}</h1>
        </div>

        {step.kind === 'password' ? (
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

        {err && <p className="msg err" role="alert">{err}</p>}
        <button className="btn btn-primary" disabled={busy || (step.kind === 'code' && code.length !== 6)}>
          {busy ? 'Aguarde…' : step.kind === 'password' ? 'Continuar' : 'Entrar'}
        </button>
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
