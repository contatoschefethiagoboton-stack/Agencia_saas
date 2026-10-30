// Agência abre o painel do cliente pelo Painel Master (sem a senha do cliente), com auditoria.
import { totpAt } from '../../dist/auth/totp.js';
import pg from 'pg';
const B = 'http://localhost:3997';
const code = s => totpAt(s, Math.floor(Date.now() / 30000));
function client() { let cookie = '';
  return async (path, body, method) => { const r = await fetch(B + '/api' + path, { method: method ?? (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { s: r.status, j: await r.json().catch(() => ({})) }; }; }
const ok = (c, l, x) => { console.log(c ? 'OK  ' : 'FAIL', l, c ? '' : JSON.stringify(x)?.slice(0, 400)); if (!c) process.exitCode = 1; };

const adm = client();
let r = await adm('/auth/login', { email: 'dono@agencia.com', password: 'SenhaForte123' });
await adm('/auth/login/verify', { ticket: r.j.ticket, code: code(r.j.secret) });
const t = (await adm('/admin/tenants', { name: 'Controladoria', niche: 'consultoria', plan: 'starter', ownerName: 'Thiago', ownerEmail: 'cliente@controladoria.com' })).j;
const t2 = (await adm('/admin/tenants', { name: 'Outra Empresa', plan: 'starter', ownerName: 'Fulano', ownerEmail: 'outra@empresa.com' })).j;
const cli = client();
r = await cli('/auth/login', { email: 'cliente@controladoria.com', password: t.tempPassword });
await cli('/auth/login/verify', { ticket: r.j.ticket, code: code(r.j.secret) });
await cli('/auth/password', { current: t.tempPassword, next: 'SenhaCliente!123' });

r = await cli(`/admin/tenants/${t2.id}/impersonate`, {}); ok(r.s === 403, 'cliente NÃO consegue abrir painel de outro cliente');
r = await cli('/auth/impersonate/stop', {}); ok(r.s === 400, 'cliente não tem "voltar ao Painel Master"');

r = await adm(`/admin/tenants/${t.id}/impersonate`, {}); ok(r.j.ok && r.j.cliente === 'Controladoria', 'admin abre o painel do cliente (2FA recente)', r.j);
r = await adm('/auth/me');
ok(r.j.impersonating === true && r.j.role === 'owner' && r.j.tenant_name === 'Controladoria' && r.j.email === 'dono@agencia.com', '/me mostra o painel do cliente, com o e-mail da agência', r.j);
r = await adm('/client/summary'); ok(r.s === 200 && r.j.negocio.name === 'Controladoria', 'agência vê o painel do cliente');
r = await adm('/client/dossier', { data: { nome: 'Controladoria', nicho: 'consultoria', cidade: 'Campinas' } }, 'PUT'); ok(r.j.ok, 'agência edita o dossiê do cliente');
r = await adm('/client/features'); ok(r.s === 200, 'agência acessa Conexões/recursos do cliente');
r = await adm('/admin/dashboard'); ok(r.s === 403, 'dentro do painel do cliente, o Painel Master fica fechado');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
const a = (await db.query(`SELECT a.action, u.email FROM audit_log a JOIN users u ON u.id = a.actor_id
                           WHERE a.tenant_id = $1 AND a.action IN ('support.panel_opened', 'dossier.saved') ORDER BY a.id`, [t.id])).rows;
ok(a.length === 2 && a.every(x => x.email === 'dono@agencia.com'), 'auditoria registra a abertura e cada ação com o e-mail da agência', a);
// cliente bloqueado fecha o acesso na hora
const adm2 = client();
r = await adm2('/auth/login', { email: 'dono@agencia.com', password: 'SenhaForte123' });
ok(r.j.method === 'totp', 'segunda sessão do admin');
const secret = (await (async () => { const crypto = await import('node:crypto'); const key = Buffer.from(process.env.TOKEN_ENC_KEY, 'base64');
  const b = (await db.query(`SELECT totp_secret_cipher FROM users WHERE email = 'dono@agencia.com'`)).rows[0].totp_secret_cipher;
  const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString(); })());
await new Promise(res => setTimeout(res, 31000 - (Date.now() % 30000)));
r = await adm2('/auth/login/verify', { ticket: r.j.ticket, code: code(secret) }); ok(r.j.ok, 'admin entra em outra aba');
r = await adm2(`/admin/tenants/${t.id}/kill`, { reason: 'teste de bloqueio' }); ok(r.j.ok, 'bloqueia o cliente');
r = await adm('/client/summary'); ok(r.s === 423, 'painel do cliente aberto pela agência fecha com o bloqueio', r);
r = await adm('/auth/impersonate/stop', {}); ok(r.j.ok, 'volta ao Painel Master');
r = await adm('/auth/me'); ok(r.j.role === 'platform_admin' && !r.j.impersonating, '/me volta a ser o administrador', r.j);
r = await adm('/admin/dashboard'); ok(r.s === 200, 'Painel Master reabre');
r = await adm(`/admin/tenants/${t.id}/impersonate`, {}); ok(r.s === 409, 'cliente bloqueado não pode ser aberto', r.j);
ok((await db.query(`SELECT count(*)::int n FROM audit_log WHERE action = 'support.panel_closed'`)).rows[0].n === 1, 'saída registrada na auditoria');
await db.end(); process.exit();
