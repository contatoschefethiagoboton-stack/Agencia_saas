/**
 * Cria o primeiro administrador da plataforma.
 *   - Automático no deploy: defina ADMIN_EMAIL e ADMIN_PASSWORD (só age se ainda não existir admin).
 *   - Manual: node dist/bootstrap.js email@dominio.com 'SenhaForte123'
 *   - ESQUECEU A SENHA OU PERDEU O CELULAR DO 2FA: defina também ADMIN_RESET=1 e faça o deploy.
 *     A senha do ADMIN_EMAIL passa a ser ADMIN_PASSWORD, o 2FA é zerado (novo QR Code no próximo login)
 *     e todas as sessões caem. A redefinição vale UMA vez por senha: deixar ADMIN_RESET=1 não refaz nada
 *     nos próximos deploys; só age de novo se ADMIN_PASSWORD (ou ADMIN_EMAIL) mudar.
 * O 2FA (aplicativo autenticador) é configurado no primeiro login.
 */
import argon2 from 'argon2';
import pg from 'pg';

/** Lê a variável tolerando erros comuns no painel do Render: minúsculas, espaços no nome e no valor. */
const envVar = (name: string) => {
  const key = Object.keys(process.env).find(k => k.trim().toUpperCase() === name);
  const v = key ? process.env[key]?.trim() : undefined;
  return v ? v.replace(/^["']|["']$/g, '') : undefined;          // aspas coladas junto do valor
};

const [argEmail, argPass] = process.argv.slice(2);
const email = (argEmail ?? envVar('ADMIN_EMAIL') ?? '').trim().toLowerCase();
const password = argPass ?? envVar('ADMIN_PASSWORD') ?? '';
const url = process.env.DATABASE_URL ?? process.env.DATABASE_URL_ADMIN;
const reset = ['1', 'true', 'sim', 'yes'].includes(String(envVar('ADMIN_RESET') ?? '').toLowerCase());

if (!url) { console.log('[bootstrap] DATABASE_URL não definida: administrador não criado'); process.exit(0); }
if (!email || !password) {
  // diz exatamente o que chegou ao servidor (só nomes, nunca valores)
  const seen = ['ADMIN_EMAIL', 'ADMIN_PASSWORD', 'ADMIN_RESET'].map(n => `${n}: ${envVar(n) ? 'definida' : 'NÃO ENCONTRADA'}`).join(' | ');
  console.log(`[bootstrap] administrador não criado/alterado. ${seen}`);
  console.log('[bootstrap] Para criar ou redefinir o acesso: Render → seu serviço Web → Environment → ADMIN_EMAIL, ADMIN_PASSWORD (e ADMIN_RESET=1 se já existir) → Save, rebuild, and deploy.');
  process.exit(0);
}
if (password.length < 10) {
  console.error('[bootstrap] ADMIN_PASSWORD precisa ter pelo menos 10 caracteres: administrador não criado/alterado');
  process.exit(argEmail ? 1 : 0);
}

const c = new pg.Client({ connectionString: url });
await c.connect();
try {
  const exists = (await c.query(`SELECT 1 FROM users WHERE role = 'platform_admin' LIMIT 1`)).rowCount;
  // impressão digital da última redefinição (argon2 de email+senha): o mesmo ADMIN_RESET não é reaplicado
  const last = reset ? (await c.query(`SELECT value FROM system_settings WHERE key = 'admin_reset'`).catch(() => ({ rows: [] as any[] }))).rows[0]?.value : null;
  const alreadyApplied = Boolean(last) && await argon2.verify(last, `${email}:${password}`).catch(() => false);
  if (reset && alreadyApplied) {
    console.log(`[bootstrap] ADMIN_RESET já aplicado para ${email} com esta senha: nada a fazer. (Pode apagar a variável; para redefinir de novo, troque ADMIN_PASSWORD.)`);
  } else if (reset) {
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
      await c.query(`INSERT INTO system_settings (key, value) VALUES ('admin_reset', $1)
                     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
                    [await argon2.hash(`${email}:${password}`, { type: argon2.argon2id })]);
      console.log(`[bootstrap] SENHA E 2FA DO ADMINISTRADOR ${email} REDEFINIDOS. Entre com a senha nova e leia o QR Code.`);
      console.log('[bootstrap] Esta redefinição não se repete nos próximos deploys. Pode apagar ADMIN_RESET quando quiser.');
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
