// Login da agência só no endereço secreto (ADMIN_PATH); o resto do site só conhece o login de cliente.
import fs from 'node:fs';
const B = 'http://localhost:3997';
const ok = (c, l, x) => { console.log(c ? 'OK  ' : 'FAIL', l, c ? '' : JSON.stringify(x)?.slice(0, 400)); if (!c) process.exitCode = 1; };
const page = async p => { const r = await fetch(B + p); return { s: r.status, h: r.headers, t: await r.text() }; };
const ADMIN = 'name="app-area" content="admin"';

let r = await page('/acesso-secreto-e2e');
ok(r.s === 200 && r.t.includes(ADMIN), 'endereço secreto abre a tela da agência');
ok(r.t.includes('noindex'), 'endereço secreto não aparece no Google (noindex)');
ok(/no-store/.test(r.h.get('cache-control') ?? ''), 'página não fica em cache');
r = await page('/acesso-secreto-e2e/'); ok(r.t.includes(ADMIN), 'aceita barra no final');
for (const p of ['/', '/admin', '/admin/', '/Acesso-Secreto-E2E', '/acesso-secreto-e2e-x', '/qualquer/coisa', '/index.html']) {
  r = await page(p); ok(r.s === 200 && !r.t.includes(ADMIN), `${p} mostra só o login de cliente`);
}
r = await page('/api/nao-existe'); ok(r.s === 404, 'API continua respondendo 404 em JSON');
r = await fetch(B + '/'); ok(r.headers.get('cross-origin-opener-policy') === 'same-origin-allow-popups', 'site permite a janela de login das redes (COOP)');

// cliente com a senha certa não entra pela área da agência (e vice-versa)
const login = (body) => fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
r = await login({ area: 'cliente', email: 'dono@agencia.com', password: 'SenhaForte123' });
ok(r.status === 401, 'administrador não entra pela tela de cliente');
r = await login({ area: 'admin', email: 'dono@agencia.com', password: 'SenhaForte123' });
const j = await r.json(); ok(r.status === 200 && j.ticket, 'administrador entra pela área da agência');

// /me do administrador traz o endereço secreto (para o redirecionamento) — e o e-mail de cadastro usa ele
const { totpAt } = await import('../../dist/auth/totp.js');
const v = await fetch(B + '/api/auth/login/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ticket: j.ticket, code: totpAt(j.secret, Math.floor(Date.now() / 30000)) }) });
const cookie = (v.headers.get('set-cookie') ?? '').split(';')[0];
const me = await (await fetch(B + '/api/auth/me', { headers: { Cookie: cookie } })).json();
ok(me.adminPath === '/acesso-secreto-e2e', 'painel sabe o endereço secreto da agência', me);
await fetch(B + '/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ business: 'Loja Nova', name: 'Ana', email: 'ana@lojanova.com', password: 'SenhaDaAna123' }) });
await new Promise(res => setTimeout(res, 800));
const mails = fs.readFileSync(process.env.MAIL_OUTBOX_FILE, 'utf8');
ok(mails.includes('/acesso-secreto-e2e#master-clientes') && !mails.includes('/admin#master-clientes'), 'aviso de cadastro leva ao endereço secreto');
