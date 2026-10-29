import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { api, ApiError } from '../api';

/*
 * Ações críticas (saque, kill switch, modo pânico, chave PIX) exigem o 2FA de novo.
 * `guard(fn)` executa a ação; se o servidor pedir step-up, abre o diálogo do código e repete.
 */
type Guard = <T>(fn: () => Promise<T>) => Promise<T>;
const Ctx = createContext<Guard>(fn => fn());
export const useStepUp = () => useContext(Ctx);

export function StepUpProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<{ challengeId?: string; method: string } | null>(null);
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const pending = useRef<{ ok: () => void; fail: (e: unknown) => void } | null>(null);

  const ask = () => new Promise<void>(async (ok, fail) => {
    try {
      const r = await api<{ method: string; challengeId?: string }>('/auth/step-up', { body: {} });
      pending.current = { ok, fail };
      setCode(''); setErr(''); setOpen(r);
    } catch (e) { fail(e); }
  });

  const guard: Guard = useCallback(async fn => {
    try { return await fn(); }
    catch (e) {
      if (!(e instanceof ApiError && e.stepUp)) throw e;
      await ask();
      return fn();
    }
  }, []);

  async function confirm() {
    try {
      await api('/auth/step-up/verify', { body: { code, challengeId: open?.challengeId } });
      setOpen(null); pending.current?.ok();
    } catch (e) { setErr((e as Error).message); }
  }
  const cancel = () => { setOpen(null); pending.current?.fail(new Error('Ação cancelada')); };

  return (
    <Ctx.Provider value={guard}>
      {children}
      {open && (
        <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-labelledby="su-t">
          <form className="dialog" onSubmit={e => { e.preventDefault(); confirm(); }}>
            <h2 id="su-t">Confirme que é você</h2>
            <p className="card-sub" style={{ margin: 0 }}>
              {open.method === 'totp' ? 'Digite o código do seu aplicativo autenticador.' : 'Digite o código enviado ao seu WhatsApp.'}
            </p>
            <label className="field">Código de 6 dígitos
              <input className="code-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus
                     value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} />
            </label>
            {err && <p className="msg err" role="alert">{err}</p>}
            <div className="actions" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn" onClick={cancel}>Cancelar</button>
              <button className="btn btn-solid" disabled={code.length !== 6}>Confirmar</button>
            </div>
          </form>
        </div>
      )}
    </Ctx.Provider>
  );
}
