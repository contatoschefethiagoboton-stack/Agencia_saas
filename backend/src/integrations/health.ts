import { servicePool, withTenant } from '../db.js';
import { audit } from '../audit/audit.js';

/*
 * SAÚDE DAS CONEXÕES: quando a rede recusa o token (senha trocada, acesso removido, prazo vencido),
 * a conexão é marcada "precisa reconectar" e o cliente vê o aviso no painel. Reconectar limpa a marca.
 */
const META_AUTH_CODES = new Set([190, 102, 463, 467]);   // OAuthException / sessão inválida ou expirada

export const isAuthError = (e: any) =>
  META_AUTH_CODES.has(e?.code) || /invalid_grant|unauthorized|token.*(expired|invalid)|access token/i.test(String(e?.message ?? ''));

export async function markReconnect(tenantId: string, provider: string, error: unknown) {
  const msg = String((error as Error)?.message ?? error).slice(0, 300);
  await withTenant(tenantId, async c => {
    const r = await c.query(`UPDATE channel_connections SET needs_reconnect = true, last_error = $2
                             WHERE provider = $1 AND NOT needs_reconnect RETURNING 1`, [provider, msg]);
    if (r.rowCount) await audit({ tenantId, action: 'channels.needs_reconnect', target: provider, meta: { error: msg } }, c);
  }, servicePool).catch(() => {});
}

/** Avisos para o painel do cliente: acesso revogado ou vencendo em até 10 dias. */
export async function connectionAlerts(tenantId: string) {
  return withTenant(tenantId, async c => (await c.query(
    `SELECT provider, name, needs_reconnect, last_error, expires_at,
            expires_at IS NOT NULL AND expires_at < now() + interval '10 days' AS expiring
       FROM channel_connections
      WHERE needs_reconnect OR (expires_at IS NOT NULL AND expires_at < now() + interval '10 days')`)).rows);
}
