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
import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { mailReady, sendMail } from '../mail.js';
import { publicUrl } from '../config.js';

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

    // cadastro feito pelo próprio cliente só entra depois que a agência aprova
    if (u.tenant_id) {
      const st = (await c.query(`SELECT status FROM tenants WHERE id = $1`, [u.tenant_id])).rows[0]?.status;
      if (st === 'pending') return res.status(403).json({ error: 'Seu cadastro está aguardando a aprovação da agência. Você recebe um aviso quando for liberado.' });
      if (st === 'rejected') return res.status(403).json({ error: 'Seu cadastro não foi aprovado. Fale com a agência.' });
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
  const s = req.user!;
  const { rows } = await adminPool.query(
    `SELECT u.id, u.email, u.name, u.role, u.totp_enabled, u.must_change_password,
            t.id AS tenant_id, t.name AS tenant_name, t.city, t.niche, t.plan, t.status AS tenant_status
       FROM users u LEFT JOIN tenants t ON t.id = coalesce($2::uuid, u.tenant_id) WHERE u.id = $1`,
    [s.sub, s.imp ? s.tid : null]);
  res.json({ ...rows[0], ...(s.imp ? { role: 'owner', impersonating: true } : {}),
             panic: s.role === 'platform_admin' ? await panicInfo() : undefined });
});

/** Sai do painel do cliente e volta ao Painel Master. */
authRouter.post('/impersonate/stop', requireAuth, async (req, res) => {
  const s = req.user!;
  if (!s.imp) return res.status(400).json({ error: 'Você não está no painel de um cliente' });
  const u = (await adminPool.query(`SELECT role FROM users WHERE id = $1`, [s.sub])).rows[0];
  if (u?.role !== 'platform_admin') return res.status(403).end();
  await audit({ actorId: s.sub, tenantId: s.tid, ip: req.ip, action: 'support.panel_closed' });
  setSession(res, { sub: s.sub, tid: null, role: 'platform_admin', tv: s.tv, mfaAt: s.mfaAt });
  res.json({ ok: true });
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

// ---------- Esqueci minha senha ----------
const sha = (t: string) => crypto.createHash('sha256').update(t).digest('hex');
const GENERIC = 'Se este e-mail estiver cadastrado, você vai receber um link para criar uma senha nova. Confira também o spam.';

/*
 * 1) Pede o link: a resposta é SEMPRE a mesma (não revela quem tem cadastro) e o pedido é limitado por IP+e-mail.
 * 2) Link por e-mail, de uso único, válido por 30 min; só o hash fica no banco.
 * 3) Senha nova derruba todas as sessões. O 2FA continua valendo: quem perdeu o celular fala com o administrador.
 */
authRouter.post('/forgot', loginLimiter, async (req, res) => {
  const email = z.string().email().max(200).parse(req.body?.email).toLowerCase();
  if (!mailReady()) return res.status(503).json({ error: 'A recuperação por e-mail ainda não foi ativada. Fale com o administrador da plataforma.' });
  const u = (await appPool.query(`SELECT id, tenant_id, name FROM users WHERE email = $1`, [email])).rows[0];
  if (u) {
    // no máximo 3 links por hora por usuário (evita usar a plataforma para inundar a caixa de alguém)
    const recent = (await appPool.query(`SELECT count(*)::int AS n FROM password_resets WHERE user_id = $1 AND created_at > now() - interval '1 hour'`, [u.id])).rows[0].n;
    if (recent < 3) {
      const token = crypto.randomBytes(32).toString('base64url');
      await appPool.query(`UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [u.id]);   // só o último link vale
      await appPool.query(`INSERT INTO password_resets (user_id, token_hash, expires_at, ip) VALUES ($1, $2, now() + interval '30 minutes', $3::inet)`,
                          [u.id, sha(token), req.ip ?? null]);
      const link = `${publicUrl()}/#redefinir?token=${token}`;
      const app = process.env.APP_NAME ?? 'Agência Hub';
      // envio em segundo plano: a resposta leva o mesmo tempo para e-mail cadastrado ou não (sem pista por tempo)
      void sendMail(email, `${app}: redefinir sua senha`,
          `Olá${u.name ? `, ${u.name.split(' ')[0]}` : ''}!\n\nRecebemos um pedido para redefinir a senha da sua conta.\n` +
          `Crie uma senha nova por este link (vale por 30 minutos e funciona uma única vez):\n\n${link}\n\n` +
          `Se não foi você, ignore este e-mail: sua senha continua a mesma.`,
          `<p>Olá${u.name ? `, ${u.name.split(' ')[0]}` : ''}!</p><p>Recebemos um pedido para redefinir a senha da sua conta.</p>` +
          `<p><a href="${link}" style="display:inline-block;padding:12px 20px;background:#5B8DEF;color:#0B1220;border-radius:10px;text-decoration:none;font-weight:700">Criar senha nova</a></p>` +
          `<p style="color:#666">O link vale por 30 minutos e funciona uma única vez. Se não foi você, ignore este e-mail: sua senha continua a mesma.</p>`)
        .catch(e => console.error('[e-mail]', (e as Error).message));
    }
    await audit({ actorId: u.id, tenantId: u.tenant_id, ip: req.ip, action: 'auth.password_reset_requested', meta: { limited: recent >= 3 } });
  }
  res.json({ ok: true, message: GENERIC });
});

authRouter.post('/reset', loginLimiter, async (req, res) => {
  const b = z.object({ token: z.string().min(20).max(100), password: z.string().min(10).max(200) }).safeParse(req.body);
  if (!b.success) return res.status(400).json({ error: 'A senha precisa ter pelo menos 10 caracteres' });
  const c = await appPool.connect();
  try {
    await c.query('BEGIN');
    const r = (await c.query(`SELECT pr.id, pr.user_id, u.tenant_id FROM password_resets pr JOIN users u ON u.id = pr.user_id
                              WHERE pr.token_hash = $1 AND pr.used_at IS NULL AND pr.expires_at > now() FOR UPDATE OF pr`,
                             [sha(b.data.token)])).rows[0];
    if (!r) { await c.query('ROLLBACK'); return res.status(400).json({ error: 'Link inválido ou vencido. Peça um novo em "Esqueci minha senha".' }); }
    await c.query(`UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [r.user_id]);
    await c.query(`UPDATE users SET password_hash = $2, must_change_password = false, failed_logins = 0, locked_until = NULL,
                     token_version = token_version + 1 WHERE id = $1`, [r.user_id, await argon2.hash(b.data.password, { type: argon2.argon2id })]);
    await audit({ actorId: r.user_id, tenantId: r.tenant_id, ip: req.ip, action: 'auth.password_reset' }, c);
    await c.query('COMMIT');
    await redis.del(`authstate:${r.user_id}`);
    res.json({ ok: true });
  } catch (e) { await c.query('ROLLBACK'); throw e; }
  finally { c.release(); }
});

// ---------- Criar conta (o cliente se cadastra; a agência aprova) ----------
const signupLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false,
                                  message: { error: 'Muitos cadastros deste endereço. Tente mais tarde.' } });

authRouter.post('/signup', signupLimiter, async (req, res) => {
  const b = z.object({
    business: z.string().trim().min(2).max(120), niche: z.string().trim().max(60).optional(), city: z.string().trim().max(80).optional(),
    name: z.string().trim().min(2).max(120), email: z.string().email().max(200), phone: z.string().regex(/^\+?\d{10,15}$/).optional(),
    password: z.string().min(10).max(200),
  }).safeParse(req.body);
  if (!b.success) return res.status(400).json({ error: 'Confira os dados: e-mail válido e senha com pelo menos 10 caracteres' });
  const d = b.data, email = d.email.toLowerCase();
  const hash = await argon2.hash(d.password, { type: argon2.argon2id });
  const c = await appPool.connect();
  try {
    await c.query('BEGIN');
    if ((await c.query(`SELECT 1 FROM users WHERE email = $1`, [email])).rowCount) {
      await c.query('ROLLBACK');
      return res.status(409).json({ error: 'Este e-mail já tem cadastro. Use "Entrar" ou "Esqueci minha senha".' });
    }
    const slug = `${d.business.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'cliente'}-${crypto.randomBytes(2).toString('hex')}`;
    const t = (await c.query(`INSERT INTO tenants (name, slug, niche, city, status, signup) VALUES ($1, $2, $3, $4, 'pending', 'self') RETURNING id`,
                             [d.business, slug, d.niche ?? null, d.city ?? null])).rows[0];
    const phone = d.phone ? (d.phone.startsWith('+') ? d.phone : `+${d.phone.length <= 11 ? '55' : ''}${d.phone}`) : null;
    await c.query(`INSERT INTO users (tenant_id, email, password_hash, phone_e164, role, name) VALUES ($1, $2, $3, $4, 'owner', $5)`,
                  [t.id, email, hash, phone, d.name]);
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [t.id]);   // RLS: o dossiê é do tenant recém-criado
    await c.query(`INSERT INTO business_dossier (tenant_id, data) VALUES ($1, $2)`, [t.id, { nome: d.business, nicho: d.niche, cidade: d.city }]);
    await audit({ tenantId: t.id, ip: req.ip, action: 'tenant.signup', meta: { email } }, c);
    await c.query('COMMIT');
    // avisa a agência por e-mail (se configurado)
    if (mailReady()) {
      const admins = (await adminPool.query(`SELECT email FROM users WHERE role = 'platform_admin'`)).rows;
      for (const a of admins) void sendMail(a.email, `Novo cadastro aguardando aprovação: ${d.business}`,
        `${d.name} (${email}) cadastrou "${d.business}". Aprove ou recuse em ${publicUrl()}/#master-clientes`,
        `<p><b>${d.name}</b> (${email}) cadastrou <b>${d.business}</b>.</p><p><a href="${publicUrl()}/#master-clientes">Aprovar ou recusar no Painel Master</a></p>`)
        .catch(e => console.error('[e-mail]', (e as Error).message));
    }
    res.status(201).json({ ok: true, message: 'Cadastro recebido! Você vai poder entrar assim que a agência aprovar.' });
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  finally { c.release(); }
});
