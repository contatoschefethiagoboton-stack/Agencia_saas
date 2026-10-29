import type { PoolClient } from 'pg';
import { appPool } from '../db.js';

export interface AuditEvent {
  actorId?: string | null; tenantId?: string | null; ip?: string | null;
  action: string; target?: string; meta?: Record<string, unknown>;
}

/** Grava no audit_log (somente-inserção, encadeado por hash no próprio banco). */
export async function audit(ev: AuditEvent, client?: PoolClient) {
  const q = client ?? appPool;
  await q.query(
    `INSERT INTO audit_log (actor_id, tenant_id, ip, action, target, meta)
     VALUES ($1, $2, $3::inet, $4, $5, $6)`,
    [ev.actorId ?? null, ev.tenantId ?? null, ev.ip ?? null, ev.action, ev.target ?? null, ev.meta ?? {}],
  );
}
