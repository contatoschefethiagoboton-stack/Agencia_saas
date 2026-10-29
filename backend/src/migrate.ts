/**
 * Aplica db/migrations/*.sql que ainda não rodaram (controle em schema_migrations).
 * Roda no início do container, antes da API. Usa DATABASE_URL (dono do banco, ex.: o do Render).
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const url = process.env.DATABASE_URL ?? process.env.DATABASE_URL_ADMIN;
if (!url) {
  console.error('[migrate] DATABASE_URL não definida. Crie um Postgres no Render e ligue a "Internal Database URL" a DATABASE_URL.');
  process.exit(1);
}

const dir = path.resolve(process.env.MIGRATIONS_DIR ?? 'db/migrations');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
const c = new pg.Client({ connectionString: url });
await c.connect();

try {
  await c.query('SELECT pg_advisory_lock(hashtext($1))', ['agencia_migrations']);   // um deploy por vez
  await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await c.query('SELECT name FROM schema_migrations')).rows.map(r => r.name));

  // Postgres gerenciado (Render) não deixa criar papel com BYPASSRLS: cria sem ele antes da 001.
  if (!done.has('001_core.sql')) {
    for (const [role, extra] of [['app_user', ''], ['app_service', ''], ['app_admin', ' BYPASSRLS']]) {
      const exists = (await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount;
      if (exists) continue;
      try { await c.query(`CREATE ROLE ${role} NOLOGIN${extra}`); }
      catch (e: any) {
        if (e.code !== '42501' || !extra) throw e;
        console.warn(`[migrate] sem permissão para ${role} BYPASSRLS; criando sem ele`);
        await c.query(`CREATE ROLE ${role} NOLOGIN`);
      }
    }
  }

  for (const f of files) {
    if (done.has(f)) continue;
    console.log(`[migrate] aplicando ${f}`);
    await c.query('BEGIN');
    try {
      await c.query(fs.readFileSync(path.join(dir, f), 'utf8'));
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    }
  }
  console.log('[migrate] banco em dia');
} finally {
  await c.end();
}
