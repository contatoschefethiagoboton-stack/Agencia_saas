import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { sendAuthTemplate } from '../whatsapp/providers/metaCloud.js';

const TTL_MIN = 5;
const MAX_ATTEMPTS = 5;
const hashCode = (code: string) =>
  crypto.createHmac('sha256', process.env.OTP_PEPPER!).update(code).digest('hex');

export type OtpPurpose = 'login' | 'withdrawal' | 'pix_key_change';

export async function issueOtp(c: PoolClient, userId: string, phone: string, purpose: OtpPurpose) {
  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
  // invalida desafios anteriores do mesmo propósito
  await c.query(`UPDATE otp_challenges SET used_at = now()
                 WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`, [userId, purpose]);
  const { rows } = await c.query(
    `INSERT INTO otp_challenges (user_id, code_hash, purpose, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(mins => $4)) RETURNING id`,
    [userId, hashCode(code), purpose, TTL_MIN]);
  // WhatsApp exige template da categoria "authentication" para códigos; SMS como fallback.
  await sendAuthTemplate(phone, code);
  return rows[0].id as string;
}

export async function verifyOtp(c: PoolClient, challengeId: string, userId: string,
                                purpose: OtpPurpose, code: string): Promise<boolean> {
  const { rows } = await c.query(
    `SELECT code_hash, attempts, expires_at < now() AS expired, used_at
       FROM otp_challenges WHERE id = $1 AND user_id = $2 AND purpose = $3 FOR UPDATE`,
    [challengeId, userId, purpose]);
  const ch = rows[0];
  if (!ch || ch.used_at || ch.expired || ch.attempts >= MAX_ATTEMPTS) return false;

  const ok = crypto.timingSafeEqual(Buffer.from(ch.code_hash, 'hex'), Buffer.from(hashCode(code), 'hex'));
  await c.query(
    ok ? `UPDATE otp_challenges SET used_at = now() WHERE id = $1`
       : `UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = $1`, [challengeId]);
  return ok;
}
