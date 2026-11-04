import { redis } from '../redis.js';
import { appPool } from '../db.js';
import { totpStep } from './totp.js';
import { decryptToken } from '../security/vault.js';

/** Código do autenticador vale UMA vez: reusar o mesmo código (ex.: capturado por phishing) é recusado. */
export async function totpOnce(userId: string, secret: string, code: string) {
  const step = totpStep(secret, code);
  if (step === null) return false;
  return (await redis.set(`totp:used:${userId}:${step}`, '1', { NX: true, EX: 120 })) === 'OK';
}

/** Confirmação em duas etapas de UMA transação: código atual do autenticador, conferido na hora. */
export async function verifyUserCode(userId: string, code: unknown) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return false;
  const u = (await appPool.query(`SELECT totp_enabled, totp_secret_cipher FROM users WHERE id = $1`, [userId])).rows[0];
  if (!u?.totp_enabled || !u.totp_secret_cipher) return false;
  const k = `mfafail:${userId}`;
  if (Number(await redis.get(k)) >= 5) return false;            // 5 códigos errados: 15 min sem transações
  const ok = await totpOnce(userId, decryptToken(u.totp_secret_cipher), code);
  if (!ok) { await redis.incr(k); await redis.expire(k, 900); }
  return ok;
}
