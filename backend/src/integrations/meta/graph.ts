import { assertNotPanicking } from '../../security/panic.js';

/** Cliente único da Graph API da Meta. META_GRAPH_URL só muda em testes (servidor falso local). */
export const graphBase = () => `${process.env.META_GRAPH_URL ?? 'https://graph.facebook.com'}/${process.env.META_API_VERSION ?? 'v25.0'}`;
export const metaReady = () => Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET);

export class MetaError extends Error {
  constructor(message: string, public code?: number, public status = 502) { super(message); }
}

export async function graphGet(path: string, token: string, params: Record<string, string> = {}) {
  const u = new URL(`${graphBase()}/${path}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set('access_token', token);
  return parse(await fetch(u, { signal: AbortSignal.timeout(20_000) }));
}

export async function graphPost(path: string, token: string, body: Record<string, unknown>, opts: { allowInPanic?: boolean } = {}) {
  if (!opts.allowInPanic) await assertNotPanicking();
  return parse(await fetch(`${graphBase()}/${path}`, {
    method: 'POST', signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
}

async function parse(r: Response) {
  const json: any = await r.json().catch(() => ({}));
  if (!r.ok || json?.error) throw new MetaError(`Meta: ${json?.error?.error_user_msg ?? json?.error?.message ?? r.status}`, json?.error?.code);
  return json;
}
