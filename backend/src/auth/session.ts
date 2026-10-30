import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Request, Response } from 'express';

export interface Claims {
  sub: string; tid: string | null; role: 'owner' | 'member' | 'platform_admin';
  tv: number;          // token_version — compara com o banco para revogação instantânea
  mfaAt: number;       // epoch s do último 2FA (step-up para ações críticas)
  imp?: boolean;       // administrador da agência operando o painel de um cliente (tid = cliente)
}

export const deviceHash = (req: Request) => {
  const ip = (req.ip ?? '').split('.').slice(0, 3).join('.');   // faixa /24 (IPv4)
  return crypto.createHash('sha256').update(`${req.get('user-agent') ?? ''}|${ip}`).digest('hex');
};

export function setSession(res: Response, claims: Claims) {
  const { sub, tid, role, tv, mfaAt, imp } = claims;     // nunca copia exp/iat de um token antigo
  const token = jwt.sign({ sub, tid, role, tv, mfaAt, ...(imp ? { imp: true } : {}) }, process.env.JWT_SECRET!, { expiresIn: '30m', algorithm: 'HS256' });
  res.cookie('sid', token, { httpOnly: true, secure: true, sameSite: 'strict', maxAge: 30 * 60_000 });
}

export const clearSession = (res: Response) =>
  res.clearCookie('sid', { httpOnly: true, secure: true, sameSite: 'strict' });

export function readSession(req: Request): Claims | null {
  try { return jwt.verify(req.cookies?.sid ?? '', process.env.JWT_SECRET!, { algorithms: ['HS256'] }) as Claims; }
  catch { return null; }
}
