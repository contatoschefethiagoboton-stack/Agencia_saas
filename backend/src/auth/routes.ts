import { Router } from 'express';
import argon2 from 'argon2';
import { z } from 'zod';
import { appPool } from '../db.js';
import { issueOtp, verifyOtp } from './otp.js';
import { deviceHash, setSession } from './session.js';
import { audit } from '../audit/audit.js';
import { loginLimiter } from '../middleware/rateLimit.js';

export const authRouter = Router();
const DUMMY_HASH = await argon2.hash('senha-que-nao-existe');

// Etapa 1: senha -> sempre exige OTP (2FA obrigatório)
authRouter.post('/login', loginLimiter, async (req, res) => {
  const body = z.object({ email: z.string().email(), password: z.string().min(8) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'Dados inválidos' });

  const c = await appPool.connect();
  try {
    const { rows } = await c.query(
      `SELECT id, tenant_id, password_hash, phone_e164, locked_until > now() AS locked
         FROM users WHERE email = $1`, [body.data.email.toLowerCase()]);
    const u = rows[0];
    // compara mesmo sem usuário, para não vazar por tempo de resposta
    const valid = await argon2.verify(u?.password_hash ?? DUMMY_HASH, body.data.password);

    if (!u || !valid || u.locked) {
      if (u) await c.query(
        `UPDATE users SET failed_logins = failed_logins + 1,
           locked_until = CASE WHEN failed_logins + 1 >= 5 THEN now() + interval '15 minutes' END
         WHERE id = $1`, [u.id]);
      await audit({ actorId: u?.id, tenantId: u?.tenant_id, ip: req.ip, action: 'auth.login_failed' }, c);
      return res.status(401).json({ error: 'E-mail ou senha incorretos' });   // mensagem genérica
    }

    const challengeId = await issueOtp(c, u.id, u.phone_e164, 'login');
    res.json({ challengeId, userId: u.id });
  } finally { c.release(); }
});

// Etapa 2: OTP -> sessão; dispositivo novo gera alerta
authRouter.post('/login/verify', loginLimiter, async (req, res) => {
  const body = z.object({ challengeId: z.string().uuid(), userId: z.string().uuid(),
                          code: z.string().regex(/^\d{6}$/) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'Dados inválidos' });

  const c = await appPool.connect();
  try {
    await c.query('BEGIN');
    const ok = await verifyOtp(c, body.data.challengeId, body.data.userId, 'login', body.data.code);
    if (!ok) { await c.query('COMMIT'); return res.status(401).json({ error: 'Código inválido ou expirado' }); }

    const { rows } = await c.query(
      `UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1
       RETURNING id, tenant_id, role, token_version`, [body.data.userId]);
    const u = rows[0];

    const dh = deviceHash(req);
    const ins = await c.query(
      `INSERT INTO known_devices (user_id, device_hash) VALUES ($1, $2)
       ON CONFLICT DO NOTHING RETURNING device_hash`, [u.id, dh]);
    if (ins.rowCount) await audit({ actorId: u.id, tenantId: u.tenant_id, ip: req.ip,
                                    action: 'auth.new_device', meta: { ua: req.get('user-agent') } }, c);
    await audit({ actorId: u.id, tenantId: u.tenant_id, ip: req.ip, action: 'auth.login_ok' }, c);
    await c.query('COMMIT');

    setSession(res, { sub: u.id, tid: u.tenant_id, role: u.role, tv: u.token_version,
                      mfaAt: Math.floor(Date.now() / 1000) });
    res.json({ ok: true, newDevice: Boolean(ins.rowCount) });
  } catch (e) { await c.query('ROLLBACK'); throw e; }
  finally { c.release(); }
});
