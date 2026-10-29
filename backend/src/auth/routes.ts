import { Router } from 'express';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import QRCode from 'qrcode';
import { z } from 'zod';
import { appPool, adminPool } from '../db.js';
import { issueOtp, verifyOtp } from './otp.js';
import { deviceHash, setSession, clearSession, readSession } from './session.js';
import { newTotpSecret, otpauthUrl, totpStep } from './totp.js';
import { encryptToken, decryptToken } from '../security/vault.js';
import { audit } from '../audit/audit.js';
import { loginLimiter } from '../middleware/rateLimit.js';
import { requireAuth } from '../middleware/auth.js';
import { panicInfo } from '../security/panic.js';
import { redis } from '../redis.js';

export const authRouter = Router();
const DUMMY_HASH = await argon2.hash('senha-que-nao-existe');
/** Código do autenticador vale UMA vez: reusar o mesmo código (ex.: capturado por phishing) é recusado. */
async function totpOnce(userId: string, secret: string, code: string) {
  const step = totpStep(secret, code);
  if (step === null) return false;
  return (await redis.set(`totp:used:${userId}:${step}`, '1', { NX: true, EX: 120 })) === 'OK';
}
const whatsappOtpReady = () => Boolean(process.env.WHATSAPP_SYSTEM_TOKEN && process.env.PLATFORM_WA_PHONE_ID);

/*
 * Login em duas etapas, 2FA SEMPRE obrigatório:
 *   1) e-mail + senha  -> devolve um "ticket" de 5 min e o método do segundo fator
 *   2) ticket + código -> sessão
 * Métodos: 'totp' (app autenticador), 'whatsapp' (código no WhatsApp) ou
 *          'totp_setup' (primeiro acesso: lê o QR Code e confirma o primeiro código).
 */
type Ticket = { sub: string; purpose: 'mfa'; method: 'totp' | 'whatsapp' | 'totp_setup'; ch?: string; sec?: string };
const signTicket = (t: Omit<Ticket, 'purpose'>) =>
  jwt.sign({ ...t, purpose: 'mfa' }, process.env.JWT_SECRET!, { expiresIn: '5m', algorithm: 'HS256' });
const readTicket = (s: string): Ticket | null => {
  try { const t = jwt.verify(s, process.env.JWT_SECRET!, { algorithms: ['HS256'] }) as Ticket; return t.purpose === 'mfa' ? t : null; }
  catch { return null; }
};

authRouter.post('/login', loginLimiter, async (req, res) => {
  const body = z.object({ email: z.string().email(), password: z.string().min(8) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'Dados inválidos' });

  const c = await appPool.connect();
  try {
    const { rows } = await c.query(
      `SELECT id, tenant_id, email, password_hash, phone_e164, totp_enabled, locked_until > now() AS locked
         FROM users WHERE email = $1`, [body.data.email.toLowerCase()]);
    const u = rows[0];
    // compara mesmo sem usuário, para não vazar por tempo de resposta
    const valid = await argon2.verify(u?.password_hash ?? DUMMY_HASH, body.data.password);

    if (!u || !valid || u.locked) {
      if (u) await c.query(
        `UPDATE users SET failed_logins = failed_logins + 1,
           locked_until = CASE WHEN failed_logins + 1 >= 5 THEN now() + interval '15 minutes' END
         WHERE id = $1`, [u.id]);
      await audit({ actorId: u?.id, tenantId: u?.tenant_id, ip: req.ip, action: 'auth.login_failed',
                    meta: { email: body.data.email.toLowerCase(), locked: Boolean(u?.locked) } }, c);
      return res.status(401).json({ error: 'E-mail ou senha incorretos' });   // mensagem genérica
    }

    if (u.totp_enabled) return res.json({ ticket: signTicket({ sub: u.id, method: 'totp' }), method: 'totp' });
    if (u.phone_e164 && whatsappOtpReady()) {
      const ch = await issueOtp(c, u.id, u.phone_e164, 'login');
      return res.json({ ticket: signTicket({ sub: u.id, method: 'whatsapp', ch }), method: 'whatsapp' });
    }
    const sec = newTotpSecret();
    const url = otpauthUrl(sec, u.email);
    res.json({ ticket: signTicket({ sub: u.id, method: 'totp_setup', sec }), method: 'totp_setup',
               otpauth: url, secret: sec, qr: await QRCode.toDataURL(url, { margin: 1, width: 220 }) });
  } finally { c.release(); }
});

authRouter.post('/login/verify', loginLimiter, async (req, res) => {
  const body = z.object({ ticket: z.string(), code: z.string().regex(/^\d{6}$/) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'Dados inválidos' });
  const t = readTicket(body.data.ticket);
  if (!t) return res.status(401).json({ error: 'Tempo esgotado. Entre de novo com e-mail e senha.' });

  const c = await appPool.connect();
  try {
    await c.query('BEGIN');
    const u0 = (await c.query(`SELECT totp_secret_cipher FROM users WHERE id = $1 FOR UPDATE`, [t.sub])).rows[0];
    let ok = false;
    if (t.method === 'whatsapp') ok = await verifyOtp(c, t.ch!, t.sub, 'login', body.data.code);
    else if (t.method === 'totp') ok = Boolean(u0?.totp_secret_cipher) && await totpOnce(t.sub, decryptToken(u0.totp_secret_cipher), body.data.code);
    else if (t.method === 'totp_setup') {
      ok = await totpOnce(t.sub, t.sec!, body.data.code);
      if (ok) await c.query(`UPDATE users SET totp_secret_cipher = $2, totp_enabled = true WHERE id = $1`,
                            [t.sub, encryptToken(t.sec!)]);
    }
    if (!ok) {
      await audit({ actorId: t.sub, ip: req.ip, action: 'auth.mfa_failed', meta: { method: t.method } }, c);
      await c.query('COMMIT');
      return res.status(401).json({ error: 'Código inválido ou expirado' });
    }

    const { rows } = await c.query(
      `UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1
       RETURNING id, tenant_id, role, token_version, must_change_password`, [t.sub]);
    const u = rows[0];

    const dh = deviceHash(req);
    const ins = await c.query(
      `INSERT INTO known_devices (user_id, device_hash) VALUES ($1, $2)
       ON CONFLICT DO NOTHING RETURNING device_hash`, [u.id, dh]);
    if (ins.rowCount) await audit({ actorId: u.id, tenantId: u.tenant_id, ip: req.ip,
                                    action: 'auth.new_device', meta: { ua: req.get('user-agent') } }, c);
    if (t.method === 'totp_setup') await audit({ actorId: u.id, tenantId: u.tenant_id, ip: req.ip, action: 'auth.totp_enabled' }, c);
    await audit({ actorId: u.id, tenantId: u.tenant_id, ip: req.ip, action: 'auth.login_ok' }, c);
    await c.query('COMMIT');

    setSession(res, { sub: u.id, tid: u.tenant_id, role: u.role, tv: u.token_version,
                      mfaAt: Math.floor(Date.now() / 1000) });
    res.json({ ok: true, newDevice: Boolean(ins.rowCount), mustChangePassword: u.must_change_password });
  } catch (e) { await c.query('ROLLBACK'); throw e; }
  finally { c.release(); }
});

authRouter.post('/logout', async (req, res) => {
  const s = readSession(req);
  if (s) await audit({ actorId: s.sub, tenantId: s.tid, ip: req.ip, action: 'auth.logout' });
  clearSession(res);
  res.json({ ok: true });
});

/** Quem está logado: o frontend decide entre Painel Master e painel do negócio. */
authRouter.get('/me', requireAuth, async (req, res) => {
  const { rows } = await adminPool.query(
    `SELECT u.id, u.email, u.name, u.role, u.totp_enabled, u.must_change_password,
            t.id AS tenant_id, t.name AS tenant_name, t.city, t.niche, t.plan, t.status AS tenant_status
       FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1`, [req.user!.sub]);
  res.json({ ...rows[0], panic: req.user!.role === 'platform_admin' ? await panicInfo() : undefined });
});

authRouter.post('/password', requireAuth, async (req, res) => {
  const b = z.object({ current: z.string(), next: z.string().min(10).max(200) }).parse(req.body);
  const u = (await appPool.query(`SELECT password_hash FROM users WHERE id = $1`, [req.user!.sub])).rows[0];
  if (!u || !(await argon2.verify(u.password_hash, b.current))) return res.status(401).json({ error: 'Senha atual incorreta' });
  // trocar a senha derruba as outras sessões (token_version + 1) e renova a desta
  const { rows } = await appPool.query(
    `UPDATE users SET password_hash = $2, must_change_password = false, token_version = token_version + 1
      WHERE id = $1 RETURNING token_version`, [req.user!.sub, await argon2.hash(b.next, { type: argon2.argon2id })]);
  await redis.del(`authstate:${req.user!.sub}`);           // invalida o cache da versão antiga do token
  await audit({ actorId: req.user!.sub, tenantId: req.user!.tid, ip: req.ip, action: 'auth.password_changed' });
  setSession(res, { ...req.user!, tv: rows[0].token_version });
  res.json({ ok: true });
});

/** Step-up: confirma o 2FA de novo antes de ação crítica (saque, kill switch, modo pânico). */
authRouter.post('/step-up', requireAuth, async (req, res) => {
  const u = (await adminPool.query(`SELECT phone_e164, totp_enabled FROM users WHERE id = $1`, [req.user!.sub])).rows[0];
  if (u?.totp_enabled) return res.json({ method: 'totp' });
  if (!u?.phone_e164 || !whatsappOtpReady()) return res.status(409).json({ error: 'Configure o 2FA no próximo login' });
  const c = await adminPool.connect();
  try { res.json({ method: 'whatsapp', challengeId: await issueOtp(c, req.user!.sub, u.phone_e164, 'withdrawal') }); }
  finally { c.release(); }
});

authRouter.post('/step-up/verify', requireAuth, async (req, res) => {
  const b = z.object({ code: z.string().regex(/^\d{6}$/), challengeId: z.string().uuid().optional() }).parse(req.body);
  const c = await adminPool.connect();
  let ok = false;
  try {
    const u = (await c.query(`SELECT totp_enabled, totp_secret_cipher FROM users WHERE id = $1`, [req.user!.sub])).rows[0];
    if (u?.totp_enabled) ok = await totpOnce(req.user!.sub, decryptToken(u.totp_secret_cipher), b.code);
    else if (b.challengeId) {
      await c.query('BEGIN');
      ok = await verifyOtp(c, b.challengeId, req.user!.sub, 'withdrawal', b.code);
      await c.query('COMMIT');
    }
  } finally { c.release(); }
  await audit({ actorId: req.user!.sub, tenantId: req.user!.tid, ip: req.ip, action: ok ? 'auth.step_up_ok' : 'auth.step_up_failed' });
  if (!ok) return res.status(401).json({ error: 'Código inválido ou expirado' });
  setSession(res, { ...req.user!, mfaAt: Math.floor(Date.now() / 1000) });
  res.json({ ok: true });
});
