import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { redis } from '../redis.js';
import { appPool } from '../db.js';
import { readSession } from '../auth/session.js';

/*
 * ANTIFRAUDE DE ACESSO
 *  - IP que erra senha em muitas contas (ataque de lista de senhas) fica bloqueado por 1 hora.
 *  - Senha que já vazou na internet (base Have I Been Pwned, consulta anônima por k-anonimato) é recusada.
 *  - CPF com dígito verificador inválido é recusado; um cadastro por CPF.
 *  - Toda chamada autenticada é registrada (rastreamento completo do site).
 */
const IP_FAIL_LIMIT = Number(process.env.IP_FAIL_LIMIT ?? 20);

export async function ipBlocked(ip: string | undefined) {
  return Boolean(ip && (await redis.get(`ipblock:${ip}`)));
}

/** Conta erros de senha por IP (todas as contas). Devolve true se o IP acabou de ser bloqueado. */
export async function registerLoginFailure(ip: string | undefined) {
  if (!ip) return false;
  const n = await redis.incr(`ipfail:${ip}`);
  if (n === 1) await redis.expire(`ipfail:${ip}`, 3600);
  if (n >= IP_FAIL_LIMIT) {
    await redis.set(`ipblock:${ip}`, JSON.stringify({ at: new Date().toISOString(), fails: n }), { EX: 3600 });
    return true;
  }
  return false;
}

export async function blockedIps() {
  const keys: string[] = [];
  for await (const k of redis.scanIterator({ MATCH: 'ipblock:*', COUNT: 200 })) keys.push(...(Array.isArray(k) ? k : [k]));
  return Promise.all(keys.slice(0, 200).map(async k => ({ ip: k.slice(8), ...JSON.parse((await redis.get(k)) ?? '{}'), ttl: await redis.ttl(k) })));
}
export const unblockIp = (ip: string) => Promise.all([redis.del(`ipblock:${ip}`), redis.del(`ipfail:${ip}`)]);

/** true = senha conhecida de vazamentos. Falha aberta (sem resposta da base em 3 s, deixa passar). */
export async function pwnedPassword(password: string): Promise<boolean> {
  if (process.env.HIBP_DISABLED === '1') return false;
  const h = crypto.createHash('sha1').update(password).digest('hex').toUpperCase();
  try {
    const r = await fetch(`${(process.env.HIBP_URL ?? 'https://api.pwnedpasswords.com').replace(/\/$/, '')}/range/${h.slice(0, 5)}`,
                          { signal: AbortSignal.timeout(3000), headers: { 'Add-Padding': 'true' } });
    if (!r.ok) return false;
    const suffix = h.slice(5);
    return (await r.text()).split('\n').some(l => l.split(':')[0].trim() === suffix && Number(l.split(':')[1]) > 0);
  } catch { return false; }
}

export const PWNED_MSG = 'Esta senha já apareceu em vazamentos de dados na internet. Escolha outra (use frase longa, sem dados pessoais).';

export { isCpf } from './cpf.js';

/** Rastreamento: grava toda chamada da API feita com sessão (quem, de onde, o quê, resultado e tempo). */
export function accessLog(req: Request, res: Response, next: NextFunction) {
  const t0 = Date.now();
  res.on('finish', () => {
    const s = req.user ?? readSession(req);
    if (!s) return;
    const path = (req.originalUrl.split('?')[0] ?? '').slice(0, 200);
    appPool.query(`INSERT INTO access_log (user_id, tenant_id, impersonating, ip, method, path, status, ms, ua) VALUES ($1, $2, $3, $4::inet, $5, $6, $7, $8, $9)`,
      [s.sub, s.tid, Boolean(s.imp), req.ip ?? null, req.method, path, res.statusCode, Date.now() - t0, (req.get('user-agent') ?? '').slice(0, 300)])
      .catch(() => {});
  });
  next();
}

/** Bloqueia o IP marcado antes de qualquer rota de API. */
export async function ipGuard(req: Request, res: Response, next: NextFunction) {
  if (await ipBlocked(req.ip)) return res.status(429).json({ error: 'Acesso bloqueado temporariamente por excesso de tentativas. Tente em 1 hora.' });
  next();
}
