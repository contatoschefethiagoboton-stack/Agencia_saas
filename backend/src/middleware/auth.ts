import type { Request, Response, NextFunction } from 'express';
import { readSession, setSession, type Claims } from '../auth/session.js';
import { adminPool } from '../db.js';
import { redis } from '../redis.js';

declare global { namespace Express { interface Request { user?: Claims } } }

/** Valida sessão, revogação (token_version) e Kill Switch do tenant. Cache de 30s no Redis. */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const s = readSession(req);
  if (!s) return res.status(401).json({ error: 'Sessão expirada' });

  const key = `authstate:${s.sub}`;
  let state = await redis.get(key);
  if (!state) {
    const { rows } = await adminPool.query(
      `SELECT u.token_version, coalesce(t.status, 'active') AS tenant_status
         FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1`, [s.sub]);
    if (!rows[0]) return res.status(401).end();
    state = JSON.stringify(rows[0]);
    await redis.set(key, state, { EX: 30 });
  }
  const { token_version, tenant_status } = JSON.parse(state);
  if (token_version !== s.tv) return res.status(401).json({ error: 'Sessão revogada' });
  if (tenant_status !== 'active') return res.status(423).json({ error: 'Conta suspensa. Fale com o suporte.' });
  if (s.role !== 'platform_admin' && !s.tid) return res.status(403).end();

  req.user = s;
  // sessão deslizante: quem está usando não cai a cada 30 min (o 2FA de step-up continua valendo 5 min)
  const iat = (s as Claims & { iat?: number }).iat ?? 0;
  if (Date.now() / 1000 - iat > 15 * 60) setSession(res, s);
  next();
}

export const requireAdmin = (req: Request, res: Response, next: NextFunction) =>
  req.user?.role === 'platform_admin' ? next() : res.status(403).end();

/** Ações críticas (saque, kill switch, troca de PIX) exigem 2FA nos últimos 5 minutos. */
export const requireRecentMfa = (req: Request, res: Response, next: NextFunction) =>
  req.user && Date.now() / 1000 - req.user.mfaAt < 300
    ? next() : res.status(401).json({ error: 'Confirme com o código enviado ao seu WhatsApp', stepUp: true });
