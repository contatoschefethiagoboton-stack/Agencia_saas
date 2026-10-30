// "Esqueci minha senha" (link por e-mail) e redefinição do administrador pelo Render (ADMIN_RESET).
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { totpAt } from '../../dist/auth/totp.js';
const B = 'http://localhost:3997';
const code = s => totpAt(s, Math.floor(Date.now() / 30000));
function client() { let cookie = '';
  return async (path, body, method) => { const r = await fetch(B + '/api' + path, { method: method ?? (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { s: r.status, j: await r.json().catch(() => ({})) }; }; }
const ok = (c, l, x) => { console.log(c ? 'OK  ' : 'FAIL', l, c ? '' : JSON.stringify(x)?.slice(0, 400)); if (!c) process.exitCode = 1; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mails = () => fs.existsSync(process.env.MAIL_OUTBOX_FILE) ? fs.readFileSync(process.env.MAIL_OUTBOX_FILE, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const tokenOf = m => m.text.match(/#redefinir\?token=([A-Za-z0-9_-]+)/)[1];
const waitMails = async n => { for (let i = 0; i < 20 && mails().length < n; i++) await sleep(150); return mails(); };
const nextWindow = () => sleep(31000 - (Date.now() % 30000));

const adm = client();
let r = await adm('/auth/login', { email: 'dono@agencia.com', password: 'SenhaForte123' });
const admSecret = r.j.secret;
await adm('/auth/login/verify', { ticket: r.j.ticket, code: code(admSecret) });
const t = (await adm('/admin/tenants', { name: 'Padaria Bom Grão', plan: 'starter', ownerName: 'Maria Silva', ownerEmail: 'maria@bomgrao.com' })).j;
const cli = client();
r = await cli('/auth/login', { email: 'maria@bomgrao.com', password: t.tempPassword });
const mSecret = r.j.secret;
await cli('/auth/login/verify', { ticket: r.j.ticket, code: code(mSecret) });
await cli('/auth/password', { current: t.tempPassword, next: 'SenhaAntiga!123' });
ok((await cli('/client/summary')).s === 200, 'cliente logado');

// ---------- Esqueci minha senha ----------
const pub = client();
r = await pub('/auth/forgot', { email: 'ninguem@naoexiste.com' });
const generic = r.j.message;
ok(r.s === 200 && /Se este e-mail estiver cadastrado/.test(generic), 'e-mail inexistente: resposta genérica', r.j);
await sleep(500); ok(mails().length === 0, 'nenhum e-mail enviado para quem não tem cadastro');
r = await pub('/auth/forgot', { email: 'Maria@BomGrao.com' });
ok(r.s === 200 && r.j.message === generic, 'e-mail cadastrado: MESMA resposta (não revela quem tem conta)', r.j);
let m = await waitMails(1);
ok(m.length === 1 && m[0].to === 'maria@bomgrao.com' && /Olá, Maria/.test(m[0].text) && /30 minutos/.test(m[0].text), 'e-mail com o link enviado', m);
const linkA = tokenOf(m[0]);
ok(m[0].text.includes(`${B}/#redefinir?token=`), 'link aponta para o site');
r = await pub('/auth/forgot', { email: 'maria@bomgrao.com' }); m = await waitMails(2); const linkB = tokenOf(m[1]);
r = await pub('/auth/reset', { token: linkA, password: 'OutraSenha!123' }); ok(r.s === 400, 'link antigo deixa de valer quando um novo é pedido', r.j);
r = await pub('/auth/reset', { token: 'x'.repeat(43), password: 'OutraSenha!123' }); ok(r.s === 400, 'link inventado recusado');
r = await pub('/auth/reset', { token: linkB, password: 'curta' }); ok(r.s === 400 && /10 caracteres/.test(r.j.error), 'senha curta recusada');
r = await pub('/auth/reset', { token: linkB, password: 'SenhaNova!12345' }); ok(r.j.ok, 'senha redefinida pelo link');
r = await pub('/auth/reset', { token: linkB, password: 'MaisUma!12345' }); ok(r.s === 400, 'link funciona uma única vez');
ok((await cli('/client/summary')).s === 401, 'sessões abertas caíram com a senha nova');
r = await client()('/auth/login', { email: 'maria@bomgrao.com', password: 'SenhaAntiga!123' }); ok(r.s === 401, 'senha antiga não entra mais');
const c2 = client();
r = await c2('/auth/login', { email: 'maria@bomgrao.com', password: 'SenhaNova!12345' });
ok(r.j.method === 'totp', 'senha nova entra, e o 2FA continua exigido', r.j);
await nextWindow();
r = await c2('/auth/login/verify', { ticket: r.j.ticket, code: code(mSecret) }); ok(r.j.ok, 'login completo com senha nova + 2FA', r.j);
r = await pub('/auth/forgot', { email: 'maria@bomgrao.com' }); m = await waitMails(3);
r = await pub('/auth/forgot', { email: 'maria@bomgrao.com' }); await sleep(600);
ok(mails().length === 3 && r.j.message === generic, 'no máximo 3 links por hora (resposta continua igual)', mails().length);
// link vencido
const { default: pg } = await import('pg');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
await db.query(`UPDATE password_resets SET expires_at = now() - interval '1 minute' WHERE used_at IS NULL`);
r = await pub('/auth/reset', { token: tokenOf(mails()[2]), password: 'SenhaNova!99999' }); ok(r.s === 400, 'link vencido (30 min) recusado');
const audits = (await db.query(`SELECT action FROM audit_log WHERE action LIKE 'auth.password_reset%'`)).rows.map(x => x.action);
ok(audits.includes('auth.password_reset_requested') && audits.includes('auth.password_reset'), 'pedidos e redefinições ficam na auditoria');

// ---------- Administrador: ADMIN_RESET pelo Render ----------
const boot = (extra) => spawnSync('node', ['dist/bootstrap.js'], { env: { ...process.env, ...extra }, encoding: 'utf8' });
let out = boot({ ADMIN_RESET: '1', ADMIN_EMAIL: 'maria@bomgrao.com', ADMIN_PASSWORD: 'Invasao!12345' });
ok(/não administrador: nada foi alterado/.test(out.stderr + out.stdout), 'ADMIN_RESET não mexe em usuário de cliente', out.stdout + out.stderr);
out = boot({});
ok(/já existe \(para redefinir a senha, use ADMIN_RESET=1\)/.test(out.stdout), 'sem ADMIN_RESET o deploy não muda a senha do admin', out.stdout);
ok((await adm('/admin/dashboard')).s === 200, 'admin logado antes da redefinição');
out = boot({ ADMIN_RESET: '1', ADMIN_PASSWORD: 'AdminNovo!12345' });
ok(/REDEFINIDOS/.test(out.stdout) && /não se repete/.test(out.stdout), 'ADMIN_RESET redefine (uma vez por senha)', out.stdout);
ok((await adm('/admin/dashboard')).s === 401, 'sessão antiga do admin caiu na hora');
r = await client()('/auth/login', { email: 'dono@agencia.com', password: 'SenhaForte123' }); ok(r.s === 401, 'senha antiga do admin não entra');
const a2 = client();
r = await a2('/auth/login', { email: 'dono@agencia.com', password: 'AdminNovo!12345' });
ok(r.j.method === 'totp_setup' && r.j.qr, 'senha nova entra e pede novo QR Code (2FA zerado, para quem perdeu o celular)', r.j);
r = await a2('/auth/login/verify', { ticket: r.j.ticket, code: code(r.j.secret) }); ok(r.j.ok, 'admin entra de novo com 2FA novo');
ok((await db.query(`SELECT count(*)::int n FROM audit_log WHERE action = 'admin.reset_by_env'`)).rows[0].n === 1, 'redefinição do admin registrada na auditoria');
// deixar ADMIN_RESET=1 no Render é inofensivo: o próximo deploy não redefine de novo
out = boot({ ADMIN_RESET: '1', ADMIN_PASSWORD: 'AdminNovo!12345' });
ok(/já aplicado/.test(out.stdout), 'novo deploy com a mesma senha não redefine de novo', out.stdout);
ok((await a2('/admin/dashboard')).s === 200, 'sessão do admin continua válida (nada foi zerado)');
r = await client()('/auth/login', { email: 'dono@agencia.com', password: 'AdminNovo!12345' });
ok(r.j.method === 'totp', '2FA do admin foi mantido (não pede QR Code de novo)', r.j);
ok((await db.query(`SELECT count(*)::int n FROM audit_log WHERE action = 'admin.reset_by_env'`)).rows[0].n === 1, 'nenhuma redefinição extra na auditoria');
// trocar a senha na variável volta a valer
out = boot({ ADMIN_RESET: '1', ADMIN_PASSWORD: 'OutraSenhaAdmin!9' });
ok(/REDEFINIDOS/.test(out.stdout), 'trocar ADMIN_PASSWORD aplica uma nova redefinição', out.stdout);
await db.end(); process.exit();
