// Carteira (subcontas Asaas) com 2 etapas e antifraude, alertas de preço, robô inteligente com stop móvel,
// rastreamento, exclusão de cliente e bloqueio de IP por tentativas de senha.
import { totpAt } from '../../dist/auth/totp.js';
import { strategySignal } from '../../dist/market/strategies.js';
import pg from 'pg';
const B = 'http://localhost:3997', F = 'http://localhost:4555';
const sleep = ms => new Promise(r => setTimeout(r, ms));
function client() { let cookie = '';
  return async (path, body, method) => { const r = await fetch(B + '/api' + path, { method: method ?? (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { s: r.status, j: await r.json().catch(() => ({})) }; }; }
const ok = (c, l, x) => { console.log(c ? 'OK  ' : 'FAIL', l, c ? '' : JSON.stringify(x)?.slice(0, 500)); if (!c) process.exitCode = 1; };
async function until(fn, ms = 15000) { for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(300)) { const v = await fn(); if (v) return v; } return null; }
const db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
await db.query("SELECT set_config('app.bypass_rls', 'on', false)");   // o teste ajusta dados de vários clientes

// códigos do autenticador: cada passo de 30 s vale uma vez; o vizinho (±1) também é aceito
const used = new Map();
async function fresh(secret) {
  for (;;) {
    const now = Math.floor(Date.now() / 30000);
    const set = used.get(secret) ?? used.set(secret, new Set()).get(secret);
    for (const s of [now - 1, now, now + 1]) if (!set.has(s)) { set.add(s); return totpAt(secret, s); }
    await sleep(2000);
  }
}
async function login(email, password) {
  const c = client();
  let r = await c('/auth/login', { email, password });
  c.secret = r.j.secret;
  await c('/auth/login/verify', { ticket: r.j.ticket, code: await fresh(r.j.secret) });
  return c;
}
const adm = await login('dono@agencia.com', 'SenhaForte123');
const mk = async (name, email, document, plan) => (await adm('/admin/tenants', { name, plan, document, ownerName: name, ownerEmail: email })).j;
const tA = await mk('Alice Ramos', 'alice@x.com', '52998224725', 'top'), tB = await mk('Bruno Silva', 'bruno@x.com', '15350946056', 'top');
const tC = await mk('Carlos Lima', 'carlos@x.com', '11144477735', 'basico');
const alice = await login('alice@x.com', tA.tempPassword), bruno = await login('bruno@x.com', tB.tempPassword), carlos = await login('carlos@x.com', tC.tempPassword);
for (const [c, t] of [[alice, tA], [bruno, tB], [carlos, tC]]) await c('/auth/password', { current: t.tempPassword, next: 'SenhaNova!12345' });

// ---------------- carteira
let r = await alice('/wallet'); ok(r.j.open === false && r.j.ready === true, 'carteira fechada, pronta para abrir', r.j);
const dados = { birthDate: '1990-05-10', mobilePhone: '19999998888', postalCode: '13010000', address: 'Rua A', addressNumber: '10', province: 'Centro', incomeValue: 5000 };
r = await alice('/wallet/open', dados); ok(r.s === 201, 'abre a subconta no Asaas', r.j);
r = await alice('/wallet/open', dados); ok(r.s === 409, 'não abre duas vezes');
await bruno('/wallet/open', dados);
r = await alice('/wallet/refresh', {}); ok(r.j.general === 'PENDING' && r.j.documents[0].onboardingUrl, 'documentos pedidos pelo Asaas (exigência do Banco Central)', r.j);
r = await alice('/wallet/send', { email: 'bruno@x.com', amountCents: 1000, code: await fresh(alice.secret), idempotencyKey: crypto.randomUUID() });
ok(r.s === 403 && /aprovada/.test(r.j.error), 'carteira em análise não movimenta', r.j);
for (const e of ['alice@x.com', 'bruno@x.com']) await fetch(`${F}/asaas/__approve?email=${e}`);
await alice('/wallet/refresh', {}); await bruno('/wallet/refresh', {});
r = await alice('/wallet'); ok(r.j.status === 'active' && /^evp-/.test(r.j.pixKey) && r.j.balanceCents === 0, 'aprovada: chave PIX para depósito criada', r.j);
r = await alice('/wallet/deposit', {}); ok(r.j.qr?.startsWith('data:image/png') && r.j.copiaECola.includes('evp-'), 'depósito: QR Code PIX da própria subconta', r.j);
await fetch(`${F}/asaas/__credit?email=alice@x.com&value=1000`);
r = await alice('/wallet'); ok(r.j.balanceCents === 100000, 'saldo vem do Asaas', r.j.balanceCents);

r = await alice('/wallet/recipient?email=bruno@x.com'); ok(r.j.name === 'Bruno S.', 'confere o destinatário com nome parcial', r.j);
r = await alice('/wallet/recipient?email=carlos@x.com'); ok(r.s === 404, 'cliente sem carteira ativa não recebe');
const send = (c, amountCents, code, key = crypto.randomUUID()) => c('/wallet/send', { email: 'bruno@x.com', amountCents, code, idempotencyKey: key, description: 'Teste' });
r = await send(alice, 25000, '000000'); ok(r.s === 401 && /autenticador/.test(r.j.error), 'sem o código do autenticador NÃO transfere');
r = await send(alice, 25000, await fresh(alice.secret));
ok(r.s === 403 && /24 horas/.test(r.j.error), 'logo depois de entrar por aparelho novo: saídas bloqueadas (conta invadida)', r.j);
await sleep(6500);                                                   // carência do teste: 6 s (produção: 24 h)
r = await send(alice, 600000, await fresh(alice.secret)); ok(r.s === 400 && /Limite por operação/.test(r.j.error), 'limite por operação', r.j);
const key = crypto.randomUUID();
r = await send(alice, 25000, await fresh(alice.secret), key); ok(r.j.ok, 'transferência entre clientes concluída', r.j);
r = await send(alice, 25000, await fresh(alice.secret), key); ok(r.s === 409, 'mesmo pedido repetido NÃO sai duas vezes (idempotência)', r.j);
r = await alice('/wallet'); ok(r.j.balanceCents === 75000 && r.j.txs[0].kind === 'envio' && r.j.txs[0].status === 'done', 'saldo e extrato de quem enviou', r.j);
r = await bruno('/wallet'); ok(r.j.balanceCents === 25000 && r.j.txs.some(t => t.kind === 'recebimento' && t.contraparte === 'Alice Ramos'), 'quem recebeu vê o crédito', r.j);
r = await carlos('/wallet'); ok(r.j.open === false, 'RLS: carteira de um cliente invisível para outro');
r = await bruno('/market/alerts'); ok(r.j.items.some(a => /recebeu R\$\s?250,00/.test(a.title)), 'aviso de recebimento', r.j.items.map(a => a.title));

r = await alice('/wallet/payout-keys', { keyType: 'CPF', keyValue: '52998224725', code: await fresh(alice.secret) }); ok(r.s === 201, 'cadastra chave de saque', r.j);
const pk = r.j.id;
r = await alice('/wallet/withdraw', { payoutKeyId: pk, amountCents: 10000, code: await fresh(alice.secret), idempotencyKey: crypto.randomUUID() });
ok(r.s === 400 && /24 horas/.test(r.j.error), 'chave nova só vale depois de 24 horas', r.j);
await db.query(`UPDATE wallet_payout_keys SET active_from = now() - interval '1 minute' WHERE id = $1`, [pk]);
r = await alice('/wallet/withdraw', { payoutKeyId: pk, amountCents: 10000, code: await fresh(alice.secret), idempotencyKey: crypto.randomUUID() });
ok(r.j.ok, 'saque para o banco via PIX', r.j);
const A = await (await fetch(`${F}/__asaas`)).json();
ok(A.transfers.some(t => t.pixAddressKey === '52998224725' && t.value === 100) && A.transfers.some(t => t.walletId && t.value === 250), 'Asaas recebeu a transferência e o saque', A.transfers);
const fs = await import('node:fs');
await sleep(400);
const mails = fs.readFileSync(process.env.MAIL_OUTBOX_FILE, 'utf8');
ok(/Saque de R\$\s?100,00 enviado/.test(mails) && /Nova chave de saque/.test(mails), 'e-mail a cada saque e a cada chave nova');
r = await adm('/admin/wallets'); ok(r.j.length === 2 && r.j.find(w => w.name === 'Alice Ramos').saidas_24h === 35000, 'administrador acompanha as carteiras', r.j);
r = await adm(`/admin/wallets/${tA.id}/block`, { block: true, reason: 'análise de fraude' }); ok(r.j.ok, 'administrador bloqueia uma carteira');
r = await send(alice, 1000, await fresh(alice.secret)); ok(r.s === 403 && /bloqueada/.test(r.j.error), 'carteira bloqueada não movimenta', r.j);

// ---------------- alertas de preço
await fetch(`${F}/binance/__series?symbol=ALERTUSDT&closes=${Array.from({ length: 100 }, () => 100).join(',')}`);
r = await alice('/market/price-alerts', { market: 'crypto', symbol: 'ALERTUSDT', kind: 'above', value: 105, note: 'vender metade' });
ok(r.s === 201 && r.j.basePrice === 100, 'cria alerta "subir acima de"', r.j);
await alice('/market/price-alerts', { market: 'crypto', symbol: 'ALERTUSDT', kind: 'down_pct', value: 5 });
for (let i = 0; i < 3; i++) await carlos('/market/price-alerts', { market: 'crypto', symbol: 'BTCUSDT', kind: 'above', value: 999999 + i });
r = await carlos('/market/price-alerts', { market: 'crypto', symbol: 'BTCUSDT', kind: 'above', value: 1e7 });
ok(r.s === 403 && /3 alerta/.test(r.j.error), 'plano Básico: até 3 alertas de preço', r.j);
await fetch(`${F}/binance/__series?symbol=ALERTUSDT&closes=${[...Array.from({ length: 99 }, () => 100), 106].join(',')}`);
r = await until(async () => { const x = await alice('/market/price-alerts'); return x.j.find(a => a.kind === 'above' && !a.active) ? x : null; });
ok(r && r.j.find(a => a.kind === 'down_pct').active === true, 'alerta dispara uma vez no preço certo (o de queda continua esperando)', r?.j);
r = await alice('/market/alerts'); ok(r.j.items.some(a => /Alerta de preço: ALERTUSDT subiu acima de 105/.test(a.title) && /vender metade/.test(a.body)), 'aviso do alerta de preço', r.j.items.map(a => a.title));

// ---------------- robô inteligente com stop móvel
const pat = [...Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 6) * 2), ...Array.from({ length: 60 }, (_, i) => 100 + i * 0.6 + Math.sin(i) * 0.4)];
const toC = cl => cl.map((c, i) => { const o = i ? cl[i - 1] : c; return { time: i * 3600, open: o, high: Math.max(o, c) * 1.002, low: Math.min(o, c) * 0.998, close: c, volume: 1000 + (i % 7) * 100 }; });
let n0 = 0; for (let n = 60; n < pat.length; n++) if (strategySignal('inteligente', toC(pat.slice(0, n + 1))).action === 'buy') { n0 = n + 1; break; }
const set = cl => fetch(`${F}/binance/__series?symbol=SMARTUSDT&closes=${cl.join(',')}`);
await set(pat.slice(0, n0 - 1));
r = await bruno('/bots', { name: 'Inteligente', market: 'crypto', symbol: 'SMARTUSDT', interval: '1h', strategy: 'inteligente', amount: 100, trailingStopPct: 3 });
ok(r.s === 201, 'cria robô inteligente com stop móvel de 3%', r.j); const sid = r.j.id;
await bruno(`/bots/${sid}`, { status: 'active' }, 'PATCH');
await set(pat.slice(0, n0));
let bot = await until(async () => (await bruno('/bots')).j.find(b => b.id === sid && b.open_trade));
const entry = pat[n0 - 1];
ok(bot && Math.abs(bot.open_trade.stop_price - entry * 0.97) < 1e-6, 'identificou alta e COMPROU; stop inicial 3% abaixo', bot?.open_trade);
await set([...pat.slice(0, n0), entry * 1.10]);
bot = await until(async () => { const b = (await bruno('/bots')).j.find(x => x.id === sid); return b?.open_trade && b.open_trade.stop_price > entry * 1.06 ? b : null; });
ok(bot && Math.abs(bot.open_trade.stop_price - entry * 1.10 * 0.97) < 1e-6, 'preço subiu 10%: o stop subiu junto (protege o lucro)', bot?.open_trade);
await set([...pat.slice(0, n0), entry * 1.10, entry * 1.05]);
bot = await until(async () => (await bruno('/bots')).j.find(b => b.id === sid && !b.open_trade && b.trades === 1));
r = await bruno(`/bots/${sid}/trades`);
ok(bot && r.j[0].exit_reason === 'stop' && r.j[0].pnl > 0, 'identificou a queda e VENDEU com lucro', r.j[0]);

// ---------------- rastreamento
r = await adm('/admin/access-log?path=wallet/send');
ok(r.j.length >= 4 && r.j.every(x => x.email === 'alice@x.com' && x.ip) && r.j.some(x => x.status === 401) && r.j.some(x => x.status === 200), 'rastreamento registra cada ação com usuário, IP e resultado', r.j.slice(0, 3));
r = await adm('/admin/access-summary'); ok(r.j.online >= 3 && r.j.chamadas24h > 20, 'resumo de acessos', r.j);

// ---------------- excluir cliente
r = await adm(`/admin/tenants/${tC.id}/delete`, { confirmName: 'outro nome' }); ok(r.s === 400, 'excluir exige digitar o nome do cliente');
r = await adm(`/admin/tenants/${tB.id}/delete`, { confirmName: 'Bruno Silva' }); ok(r.s === 409 && /carteira/.test(r.j.error), 'cliente com carteira aberta não é excluído sem antes sacar o saldo', r.j);
r = await adm(`/admin/tenants/${tC.id}/delete`, { confirmName: 'carlos lima' }); ok(r.j.ok, 'administrador exclui o login do cliente', r.j);
r = await carlos('/bots/plan'); ok(r.s === 401, 'sessão do cliente excluído cai na hora', r.s);
r = await client()('/auth/login', { email: 'carlos@x.com', password: 'SenhaNova!12345' }); ok(r.s === 401, 'login excluído não entra mais');
r = await adm('/admin/tenants'); ok(!r.j.some(t => t.id === tC.id), 'excluído some da lista');
r = await adm('/admin/tenants?excluidos=1'); ok(r.j.find(t => t.id === tC.id)?.status === 'deleted', 'e aparece no filtro de excluídos');
r = await adm('/admin/audit?security=1'); ok(r.j.some(a => a.action === 'tenant.deleted'), 'exclusão registrada na auditoria');

// ---------------- tentativas de roubar senha: IP bloqueado
const pub = client();
for (let i = 0; i < 8; i++) await pub('/auth/login', { email: `alvo${i}@x.com`, password: 'chute-qualquer' });
r = await pub('/auth/login', { email: 'bruno@x.com', password: 'SenhaNova!12345' });
ok(r.s === 429 && /bloqueado/.test(r.j.error), 'IP que testa senhas em várias contas é bloqueado (até com a senha certa)', r.j);
r = await bruno('/bots/plan'); ok(r.s === 429, 'bloqueio vale para todo o site naquele IP', r.s);
ok((await db.query(`SELECT count(*)::int n FROM audit_log WHERE action = 'security.ip_blocked'`)).rows[0].n === 1, 'bloqueio registrado na auditoria');
await db.end(); process.exit();
