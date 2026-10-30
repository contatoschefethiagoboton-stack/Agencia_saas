/**
 * Cria o primeiro administrador da plataforma.
 *   - Automático no deploy: defina ADMIN_EMAIL e ADMIN_PASSWORD (só age se ainda não existir admin).
 *   - Manual: node dist/bootstrap.js email@dominio.com 'SenhaForte123'
 *   - ESQUECEU A SENHA OU PERDEU O CELULAR DO 2FA: defina também ADMIN_RESET=1 e faça o deploy.
 *     A senha do ADMIN_EMAIL passa a ser ADMIN_PASSWORD, o 2FA é zerado (novo QR Code no próximo login)
 *     e todas as sessões caem. Depois APAGUE ADMIN_RESET, senão a senha é redefinida a cada deploy.
 * O 2FA (aplicativo autenticador) é configurado no primeiro login.
 */
import argon2 from 'argon2';
import pg from 'pg';

const [argEmail, argPass] = process.argv.slice(2);
const email = (argEmail ?? process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
const password = argPass ?? process.env.ADMIN_PASSWORD ?? '';
const url = process.env.DATABASE_URL ?? process.env.DATABASE_URL_ADMIN;
const reset = ['1', 'true', 'sim'].includes(String(process.env.ADMIN_RESET ?? '').toLowerCase());

if (!url || !email) process.exit(0);          // nada a fazer
if (password.length < 10) {
  console.error('[bootstrap] ADMIN_PASSWORD precisa ter pelo menos 10 caracteres');
  process.exit(argEmail ? 1 : 0);
}

const c = new pg.Client({ connectionString: url });
await c.connect();
try {
  const exists = (await c.query(`SELECT 1 FROM users WHERE role = 'platform_admin' LIMIT 1`)).rowCount;
  if (reset) {
    const other = (await c.query(`SELECT role FROM users WHERE email = $1`, [email])).rows[0];
    if (other && other.role !== 'platform_admin') {
      console.error(`[bootstrap] ${email} é usuário de cliente, não administrador: nada foi alterado`);
    } else {
      await c.query(`INSERT INTO users (email, password_hash, role, name) VALUES ($1, $2, 'platform_admin', 'Administrador')
                     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, failed_logins = 0, locked_until = NULL,
                       totp_enabled = false, totp_secret_cipher = NULL, must_change_password = false,
                       token_version = users.token_version + 1`,
                    [email, await argon2.hash(password, { type: argon2.argon2id })]);
      await c.query(`INSERT INTO audit_log (action, target) VALUES ('admin.reset_by_env', $1)`, [email]);
      // derruba na hora as sessões abertas (o servidor guarda o estado da sessão por 30s no Redis)
      if (process.env.REDIS_URL) {
        const { createClient } = await import('redis');
        const r = createClient({ url: process.env.REDIS_URL });
        try {
          await r.connect();
          const id = (await c.query(`SELECT id FROM users WHERE email = $1`, [email])).rows[0].id;
          await r.del(`authstate:${id}`);
        } catch { /* sem Redis acessível: a sessão antiga cai em até 30s */ } finally { await r.quit().catch(() => {}); }
      }
      console.log(`[bootstrap] SENHA E 2FA DO ADMINISTRADOR ${email} REDEFINIDOS. Entre com a senha nova e leia o QR Code.`);
      console.log('[bootstrap] >>> APAGUE a variável ADMIN_RESET no Render agora, senão a senha é redefinida a cada deploy. <<<');
    }
  } else if (exists && !argEmail) {
    console.log('[bootstrap] administrador já existe (para redefinir a senha, use ADMIN_RESET=1)');
  } else {
    await c.query(`INSERT INTO users (email, password_hash, role, name) VALUES ($1, $2, 'platform_admin', 'Administrador')
                   ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'platform_admin',
                     failed_logins = 0, locked_until = NULL`,
                  [email, await argon2.hash(password, { type: argon2.argon2id })]);
    await c.query(`INSERT INTO audit_log (action, target) VALUES ('admin.bootstrap', $1)`, [email]);
    console.log(`[bootstrap] administrador ${email} pronto. Entre no site e configure o 2FA.`);
  }
} finally { await c.end(); }
