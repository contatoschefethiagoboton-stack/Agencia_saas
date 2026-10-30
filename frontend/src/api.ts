/** Cliente da API: cookie de sessão httpOnly, erros com a mensagem do servidor. */
export class ApiError extends Error {
  constructor(message: string, public status: number, public stepUp = false) { super(message); }
}

export async function api<T = any>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const r = await fetch(`/api${path}`, {
    method: init?.method ?? (init?.body !== undefined ? 'POST' : 'GET'),
    credentials: 'include',
    headers: init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(data.error ?? `Erro ${r.status}`, r.status, Boolean(data.stepUp));
  return data as T;
}

export const brl = (cents: string | number | bigint | null | undefined) =>
  (Number(cents ?? 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export const dataHora = (iso: string) =>
  new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

export interface Me {
  id: string; email: string; name: string | null; role: 'owner' | 'member' | 'platform_admin';
  totp_enabled: boolean; must_change_password: boolean;
  tenant_id: string | null; tenant_name: string | null; city: string | null; niche: string | null; plan: string | null;
  panic?: { on: boolean; reason?: string; at?: string };
  impersonating?: boolean;   // administrador da agência operando o painel deste cliente
  adminPath?: string;        // endereço secreto do login da agência (só vem para o administrador)
}
