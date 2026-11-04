/*
 * Testes de ponta a ponta: para cada bateria em e2e/suites, recria o banco (usuário SEM superusuário, como no
 * Render), limpa o Redis, sobe o servidor falso das APIs externas e a API de verdade (migrações + 1º admin),
 * roda a bateria e derruba tudo. Requer Postgres 16 e Redis acessíveis e o backend compilado (npm run build).
 *   E2E_PG_ADMIN_URL=postgres://postgres:postgres@localhost:5432/postgres  E2E_REDIS_URL=redis://localhost:6379  node e2e/run.mjs [filtro]
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import pg from 'pg';
import { createClient } from 'redis';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(DIR, '..');
const ADMIN_URL = process.env.E2E_PG_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
const REDIS_URL = process.env.E2E_REDIS_URL ?? 'redis://localhost:6379';
const host = new URL(ADMIN_URL);
const DATABASE_URL = `postgres://agencia:x@${host.host}/agencia_e2e`;
const env = {
  ...process.env, NODE_ENV: 'production', PORT: '3997', DATABASE_URL, REDIS_URL,
  JWT_SECRET: 'e2e-jwt-secret-bem-grande-1234567890', OTP_PEPPER: 'pepper', TOKEN_ENC_KEY: Buffer.alloc(32, 'k').toString('base64'),
  ADMIN_EMAIL: 'dono@agencia.com', ADMIN_PASSWORD: 'SenhaForte123', PUBLIC_URL: 'http://localhost:3997',
  BINANCE_DATA_URL: 'http://localhost:4555/binance', BINANCE_API_URL: 'http://localhost:4555/binance',
  BRAPI_URL: 'http://localhost:4555/brapi', BRAPI_TOKEN: 'brapi-e2e', TELEGRAM_BOT_TOKEN: 'tg-e2e', TELEGRAM_API_URL: 'http://localhost:4555/telegram',
  BOT_TICK_MS: '700', MARKET_CACHE_SEC: '1', PRICE_ALERT_MS: '700', WALLET_COOLDOWN_SEC: '6', SIGNUP_RATE_LIMIT: '50', IP_FAIL_LIMIT: '8',
  ASAAS_API_URL: 'http://localhost:4555/asaas', ASAAS_API_KEY: 'asaas-master', ASAAS_WEBHOOK_TOKEN: 'whk-e2e', HIBP_URL: 'http://localhost:4555/hibp', RADAR_INTERVAL_MS: '2000', MIGRATIONS_DIR: path.resolve(BACKEND, '../db/migrations'),
  MAIL_OUTBOX_FILE: path.join(os.tmpdir(), 'agencia-e2e-emails.jsonl'),
  ADMIN_PATH: '/acesso-secreto-e2e', WEB_DIR: path.join(os.tmpdir(), 'agencia-e2e-web'),
};
// painel "construído" mínimo, para testar qual endereço recebe a tela da agência
fs.mkdirSync(env.WEB_DIR, { recursive: true });
fs.writeFileSync(path.join(env.WEB_DIR, 'index.html'), '<!doctype html><html><head><title>t</title></head><body><div id="root"></div></body></html>');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const filter = process.argv[2];
const suites = fs.readdirSync(path.join(DIR, 'suites')).filter(f => f.endsWith('.mjs') && (!filter || f.includes(filter))).sort();

async function resetDb() {
  const c = new pg.Client({ connectionString: ADMIN_URL }); await c.connect();
  await c.query(`DO $$ BEGIN CREATE ROLE agencia LOGIN PASSWORD 'x' CREATEROLE; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  await c.query('DROP DATABASE IF EXISTS agencia_e2e WITH (FORCE)');
  await c.query('CREATE DATABASE agencia_e2e OWNER agencia');
  await c.end();
  const r = createClient({ url: REDIS_URL }); await r.connect(); await r.flushAll(); await r.quit();
  fs.rmSync(env.MAIL_OUTBOX_FILE, { force: true });
}

async function waitUp(url, ms = 20_000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(300)) { try { if ((await fetch(url)).ok) return; } catch {} }
  throw new Error(`não subiu: ${url}`);
}

let totalOk = 0, totalFail = 0;
for (const suite of suites) {
  await resetDb();
  for (const step of ['dist/migrate.js', 'dist/bootstrap.js']) {
    const r = spawnSync('node', [step], { cwd: BACKEND, env, encoding: 'utf8' });
    if (r.status !== 0) { console.error(r.stdout, r.stderr); process.exit(1); }
  }
  const fake = spawn('node', [path.join(DIR, 'fake-apis.mjs')], { cwd: BACKEND, env, stdio: 'ignore' });
  const api = spawn('node', ['dist/server.js'], { cwd: BACKEND, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let apiErr = ''; api.stderr.on('data', d => { apiErr += d; });
  try {
    await waitUp('http://localhost:4555/__log'); await waitUp('http://localhost:3997/healthz');
    const t0 = Date.now();
    const r = spawnSync('node', [path.join(DIR, 'suites', suite)], { cwd: BACKEND, env, encoding: 'utf8', timeout: 300_000 });
    const out = r.stdout + r.stderr;
    const okN = (out.match(/^OK /gm) ?? []).length, failN = (out.match(/^FAIL/gm) ?? []).length + (r.status !== 0 && !/^FAIL/m.test(out) ? 1 : 0);
    totalOk += okN; totalFail += failN;
    console.log(`\n== ${suite}: ${okN} ok, ${failN} falha(s) em ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    if (failN) { console.log(out.split('\n').filter(l => !l.startsWith('OK ')).join('\n')); if (apiErr) console.log('--- stderr da API ---\n' + apiErr.slice(-3000)); }
  } finally { api.kill('SIGTERM'); fake.kill('SIGTERM'); await sleep(500); }
}
console.log(`\nTOTAL: ${totalOk} ok, ${totalFail} falha(s)`);
process.exit(totalFail ? 1 : 0);
