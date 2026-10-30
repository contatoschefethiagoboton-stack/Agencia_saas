// Cadastro pelo próprio cliente com aprovação da agência; cliente VIP oculto; atividade por cliente.
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
const db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await db.connect();

const adm = client();
let r = await adm('/auth/login', { area: 'admin', email: 'dono@agencia.com', password: 'SenhaForte123' });
await adm('/auth/login/verify', { ticket: r.j.ticket, code: code(r.j.secret) });

// ---------- cadastro pelo site ----------
const pub = client();
const form = { business: 'Controladoria Campos', niche: 'consultoria', city: 'Campinas', name: 'Thiago', email: 'Thiago@Cliente.com', phone: '19999998888', password: 'SenhaDoCliente1' };
r = await pub('/auth/signup', { ...form, password: 'curta' }); ok(r.s === 400, 'senha curta recusada no cadastro');
r = await pub('/auth/signup', form); ok(r.s === 201 && /aprovar/.test(r.j.message), 'cadastro recebido, aguardando aprovação', r.j);
r = await pub('/auth/signup', form); ok(r.s === 409, 'e-mail repetido recusado');
r = await pub('/auth/login', { email: 'thiago@cliente.com', password: 'SenhaDoCliente1' });
ok(r.s === 403 && /aguardando a aprovação/.test(r.j.error), 'cliente NÃO entra antes da aprovação', r.j);
r = await pub('/auth/login', { email: 'thiago@cliente.com', password: 'errada12345' }); ok(r.s === 401, 'senha errada continua genérica (não revela o cadastro pendente)');
r = await adm('/admin/dashboard'); ok(r.j.clientes.aguardando === 1, 'Visão geral avisa: 1 cadastro aguardando', r.j.clientes);
r = await adm('/admin/tenants'); let t = r.j[0];
ok(t.status === 'pending' && t.signup === 'self' && t.owner_email === 'thiago@cliente.com', 'Clientes mostra o cadastro pendente primeiro', t);
const u = (await db.query(`SELECT phone_e164 FROM users WHERE email = 'thiago@cliente.com'`)).rows[0];
ok(u.phone_e164 === '+5519999998888', 'WhatsApp salvo no formato internacional', u);
r = await pub(`/admin/tenants/${t.id}/approve`, {}); ok(r.s === 401, 'aprovar exige ser o administrador');
r = await adm(`/admin/tenants/${t.id}/approve`, {}); ok(r.j.ok, 'agência aprova o acesso');
r = await adm(`/admin/tenants/${t.id}/approve`, {}); ok(r.s === 409, 'aprovar de novo não faz nada');
const cli = client();
r = await cli('/auth/login', { email: 'thiago@cliente.com', password: 'SenhaDoCliente1' });
ok(r.j.method === 'totp_setup', 'depois de aprovado, o cliente entra e configura o 2FA', r.j);
r = await cli('/auth/login/verify', { ticket: r.j.ticket, code: code(r.j.secret) }); ok(r.j.ok, 'cliente dentro');
// recusa
await pub('/auth/signup', { ...form, business: 'Spam Ltda', email: 'spam@x.com' });
const spam = (await adm('/admin/tenants')).j.find(x => x.name === 'Spam Ltda');
r = await adm(`/admin/tenants/${spam.id}/reject`, { reason: 'cadastro falso' }); ok(r.j.ok, 'agência recusa um cadastro');
r = await pub('/auth/login', { email: 'spam@x.com', password: 'SenhaDoCliente1' }); ok(r.s === 403 && /não foi aprovado/.test(r.j.error), 'recusado não entra', r.j);

// ---------- VIP oculto ----------
r = await adm(`/admin/tenants/${t.id}`, { vip: true, vipNote: 'parceiro de longa data' }, 'PATCH'); ok(r.j.ok, 'agência marca o cliente como VIP');
t = (await adm('/admin/tenants')).j.find(x => x.id === t.id);
ok(t.vip === true && t.vip_note === 'parceiro de longa data', 'Painel Master mostra o VIP e a anotação', t);
for (const p of ['/auth/me', '/client/summary', '/client/dossier', '/client/features', '/client/ads']) {
  r = await cli(p); ok(r.s === 200 && !/vip|parceiro de longa/i.test(JSON.stringify(r.j)), `cliente NÃO vê o VIP (${p})`, r.j);
}
r = await adm(`/admin/tenants/${t.id}/billing`, {}); ok(r.s === 409 && /VIP/.test(r.j.error), 'VIP é isento de cobrança', r.j);
await db.query('BEGIN'); await db.query("SELECT set_config('app.tenant_id', $1, true)", [t.id]);
await db.query(`INSERT INTO api_usage (tenant_id, provider, period, cost_cents, quota_cents) VALUES ($1, 'anthropic', date_trunc('month', now())::date, 0, 5000)`, [t.id]);
await db.query('COMMIT');
await adm(`/admin/tenants/${t.id}`, { vip: true }, 'PATCH');
const quota = async () => { await db.query('BEGIN'); await db.query("SELECT set_config('app.tenant_id', $1, true)", [t.id]);
  const x = (await db.query(`SELECT quota_cents::bigint AS q FROM api_usage WHERE tenant_id = $1`, [t.id])).rows[0].q; await db.query('COMMIT'); return x; };
let q = await quota();
ok(Number(q) >= 100000000, 'VIP sem teto de IA no mês', q);
await adm(`/admin/tenants/${t.id}`, { vip: false }, 'PATCH');
q = await quota();
ok(Number(q) === 5000, 'tirar o VIP volta ao teto do plano', q);

// ---------- atividade do cliente ----------
await cli('/client/dossier', { data: { nome: 'Controladoria Campos', cidade: 'Campinas', nicho: 'consultoria' } }, 'PUT');
r = await adm(`/admin/audit?tenantId=${t.id}`);
const acts = r.j.map(a => a.action);
ok(['tenant.signup', 'tenant.approved', 'auth.login_ok', 'auth.totp_enabled', 'dossier.saved'].every(a => acts.includes(a)),
   'agência vê tudo o que aconteceu na conta do cliente (cadastro, aprovação, login, 2FA, ações)', acts);
r = await cli(`/admin/audit?tenantId=${t.id}`); ok(r.s === 403, 'cliente não vê a auditoria');

// ---------- logins separados: agência em /admin, clientes na tela principal ----------
r = await client()('/auth/login', { email: 'dono@agencia.com', password: 'SenhaForte123' });
ok(r.s === 401 && r.j.error === 'E-mail ou senha incorretos', 'administrador NÃO entra pela tela dos clientes (resposta genérica)', r.j);
r = await client()('/auth/login', { area: 'admin', email: 'thiago@cliente.com', password: 'SenhaDoCliente1' });
ok(r.s === 401 && r.j.error === 'E-mail ou senha incorretos', 'cliente NÃO entra pelo acesso da agência', r.j);
r = await client()('/auth/login', { area: 'admin', email: 'dono@agencia.com', password: 'SenhaForte123' });
ok(r.j.method === 'totp', 'administrador entra pelo acesso da agência', r.j);
r = await client()('/auth/login', { area: 'cliente', email: 'thiago@cliente.com', password: 'SenhaDoCliente1' });
ok(r.j.method === 'totp', 'cliente entra pela tela principal', r.j);
const wrong = (await db.query(`SELECT count(*)::int n FROM audit_log WHERE action = 'auth.wrong_area'`)).rows[0].n;
ok(wrong === 2, 'tentativas na porta errada ficam na auditoria', wrong);
const fails = (await db.query(`SELECT failed_logins FROM users WHERE email = 'dono@agencia.com'`)).rows[0].failed_logins;
ok(fails === 0, 'porta errada com senha certa não trava a conta do admin', fails);
// administrador não recupera senha por e-mail
const fs = await import('node:fs');
const before = fs.existsSync(process.env.MAIL_OUTBOX_FILE) ? fs.readFileSync(process.env.MAIL_OUTBOX_FILE, 'utf8') : '';
r = await client()('/auth/forgot', { email: 'dono@agencia.com' });
await new Promise(res => setTimeout(res, 500));
const after = fs.existsSync(process.env.MAIL_OUTBOX_FILE) ? fs.readFileSync(process.env.MAIL_OUTBOX_FILE, 'utf8') : '';
ok(r.s === 200 && /Se este e-mail/.test(r.j.message) && before === after, '"Esqueci minha senha" não envia link para o administrador (resposta igual)', r.j);
ok((await db.query(`SELECT count(*)::int n FROM password_resets pr JOIN users u ON u.id = pr.user_id WHERE u.role = 'platform_admin'`)).rows[0].n === 0,
   'nenhum link de redefinição criado para o administrador');
await db.end(); process.exit();
