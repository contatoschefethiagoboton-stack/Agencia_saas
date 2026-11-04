// Acesso unificado: administrador e clientes pela mesma tela; o endereço secreto antigo continua funcionando.
const B = 'http://localhost:3997';
const ok = (c, l, x) => { console.log(c ? 'OK  ' : 'FAIL', l, c ? '' : JSON.stringify(x)?.slice(0, 400)); if (!c) process.exitCode = 1; };
const page = async p => { const r = await fetch(B + p); return { s: r.status, h: r.headers, t: await r.text() }; };

let r = await page('/acesso-secreto-e2e');
ok(r.s === 200 && r.t.includes('<div id="root">') && r.t.includes('noindex'), 'endereço secreto antigo continua abrindo (sem indexar no Google)');
ok(/no-store/.test(r.h.get('cache-control') ?? ''), 'página não fica em cache');
for (const p of ['/', '/qualquer/coisa', '/index.html']) { r = await page(p); ok(r.s === 200 && r.t.includes('<div id="root">'), `${p} abre o site`); }
r = await page('/api/nao-existe'); ok(r.s === 404, 'API continua respondendo 404 em JSON');
r = await fetch(B + '/'); ok(r.headers.get('cross-origin-opener-policy') === 'same-origin' && /wss:\/\/data-stream\.binance\.vision/.test(r.headers.get('content-security-policy')), 'COOP restrito e CSP libera só o preço ao vivo da Binance');

const login = body => fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
r = await login({ email: 'dono@agencia.com', password: 'SenhaForte123' });
ok(r.status === 200 && (await r.json()).ticket, 'administrador entra pela tela principal');
r = await login({ area: 'admin', email: 'dono@agencia.com', password: 'SenhaForte123' });
ok(r.status === 200, 'e também pelo endereço antigo');
r = await login({ email: 'dono@agencia.com', password: 'errada12345' });
const j = await r.json(); ok(r.status === 401 && j.error === 'E-mail ou senha incorretos', 'senha errada: resposta genérica', j);
