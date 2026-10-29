/**
 * Cria o primeiro administrador da plataforma.
 *   - Automático no deploy: defina ADMIN_EMAIL e ADMIN_PASSWORD (só age se ainda não existir admin).
 *   - Manual: node dist/bootstrap.js email@dominio.com 'SenhaForte123'
 * O 2FA (aplicativo autenticador) é configurado no primeiro login.
 */
import argon2 from 'argon2';
import pg from 'pg';

const [argEmail, argPass] = process.argv.slice(2);
const email = (argEmail ?? process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
const password = argPass ?? process.env.ADMIN_PASSWORD ?? '';
const url = process.env.DATABASE_URL ?? process.env.DATABASE_URL_ADMIN;

if (!url || !email) process.exit(0);          // nada a fazer
if (password.length < 10) {
  console.error('[bootstrap] ADMIN_PASSWORD precisa ter pelo menos 10 caracteres');
  process.exit(argEmail ? 1 : 0);
}

const c = new pg.Client({ connectionString: url });
await c.connect();
try {
  const exists = (await c.query(`SELECT 1 FROM users WHERE role = 'platform_admin' LIMIT 1`)).rowCount;
  if (exists && !argEmail) { console.log('[bootstrap] administrador já existe'); }
  else {
    await c.query(`INSERT INTO users (email, password_hash, role, name) VALUES ($1, $2, 'platform_admin', 'Administrador')
                   ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'platform_admin',
                     failed_logins = 0, locked_until = NULL`,
                  [email, await argon2.hash(password, { type: argon2.argon2id })]);
    await c.query(`INSERT INTO audit_log (action, target) VALUES ('admin.bootstrap', $1)`, [email]);
    console.log(`[bootstrap] administrador ${email} pronto. Entre no site e configure o 2FA.`);
  }
} finally { await c.end(); }
