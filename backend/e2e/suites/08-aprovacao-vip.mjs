// Cadastro com plano pago (PIX/cartão) e liberação automática; antifraude no pagamento; VIP oculto; login unificado.
import { totpAt } from '../../dist/auth/totp.js';
import pg from 'pg';
const B = 'http://localhost:3997', F = 'http://localhost:4555';
const code = s => totpAt(s, Math.floor(Date.now() / 30000));
function client() { let cookie = '';
  return async (path, body, method) => { const r = await fetch(B + '/api' + path, { method: method ?? (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { s: r.status, j: await r.json().catch(() => ({})) }; }; }
const ok = (c, l, x) => { console.log(c ? 'OK  ' : 'FAIL', l, c ? '' : JSON.stringify(x)?.slice(0, 400)); if (!c) process.exitCode = 1; };
const db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
const asaas = async () => (await fetch(`${F}/__asaas`)).json();
const webhook = (id, event, payment, token = 'whk-e2e') => fetch(`${B}/webhooks/pagamentos/asaas`, { method: 'POST',
  headers: { 'Content-Type': 'application/json', 'asaas-access-token': token }, body: JSON.stringify({ id, event, payment: { id: payment } }) });

// ---------- login unificado: o administrador entra pela mesma tela dos clientes ----------
const adm = client();
let r = await adm('/auth/login', { email: 'dono@agencia.com', password: 'SenhaForte123' });
ok(r.j.method === 'totp_setup', 'administrador entra pela tela principal (sem endereço secreto)', r.j);
await adm('/auth/login/verify', { ticket: r.j.ticket, code: code(r.j.secret) });
r = await adm('/auth/me'); ok(r.j.role === 'platform_admin' && r.j.tenant_id && r.j.is_platform, 'administrador ganha conta de investimentos própria (acesso total)', r.j);
r = await adm('/bots/plan'); ok(r.j.maxBots === 50 && r.j.liveTrading && r.j.copyTrade && r.j.priceAlerts === -1, 'administrador com todos os recursos liberados', r.j);
r = await adm('/auth/plans'); ok(r.j.map(p => p.id).join() === 'basico,medio,top' && r.j[1].price_cents === 8990, 'planos à venda', r.j);

// ---------- cadastro com plano ----------
const pub = client();
const form = { name: 'Thiago Campos', email: 'Thiago@Cliente.com', document: '529.982.247-25', phone: '19999998888', password: 'SenhaDoCliente1', plan: 'medio', billingType: 'PIX' };
r = await pub('/auth/signup', { ...form, document: '111.111.111-11' }); ok(r.s === 400 && /CPF inválido/.test(r.j.error), 'CPF inválido recusado', r.j);
r = await pub('/auth/signup', { ...form, password: 'Senha123456' }); ok(r.s === 400 && /vazamentos/.test(r.j.error), 'senha vazada na internet recusada', r.j);
r = await pub('/auth/signup', { ...form, email: 'robo@spam.com', website: 'http://spam' });
ok(r.s === 201 && !(await db.query(`SELECT 1 FROM users WHERE email = 'robo@spam.com'`)).rowCount, 'robô que preenche o campo invisível não cria conta');
r = await pub('/auth/signup', form);
ok(r.s === 201 && /^https:\/\/pagar\.fake\//.test(r.j.payUrl), 'cadastro cria a assinatura e devolve o link de pagamento (PIX)', r.j);
let A = await asaas();
const sub = A.subs.at(-1);
ok(sub.billingType === 'PIX' && sub.value === 89.9 && sub.cycle === 'MONTHLY', 'assinatura mensal de R$ 89,90 no PIX', sub);
r = await pub('/auth/signup', form); ok(r.s === 409, 'e-mail repetido recusado');
r = await pub('/auth/signup', { ...form, email: 'outro@cliente.com' }); ok(r.s === 409 && /CPF/.test(r.j.error), 'um cadastro por CPF (antifraude)', r.j);
r = await pub('/auth/login', { email: 'thiago@cliente.com', password: 'SenhaDoCliente1' });
ok(r.s === 402 && /pagar\.fake/.test(r.j.payUrl), 'sem pagamento não entra: recebe o link para pagar', r.j);
r = await adm('/admin/tenants'); let t = r.j.find(x => x.owner_email === 'thiago@cliente.com');
ok(t.status === 'awaiting_payment' && t.billing_type === 'PIX', 'administrador vê "aguardando pagamento"', t);
r = await adm('/admin/dashboard'); ok(r.j.clientes.aguardando_pagamento === 1, 'Visão geral conta os pagamentos pendentes', r.j.clientes);

// ---------- antifraude no pagamento ----------
const pay = A.pays.find(p => p.subscription === sub.id);
r = await webhook('ev-falso', 'PAYMENT_RECEIVED', pay.id, 'token-errado'); ok(r.status === 401, 'webhook sem o token secreto é recusado (pagamento falso)');
r = await webhook('ev-1', 'PAYMENT_RECEIVED', pay.id);                      // o Asaas ainda diz PENDING: não libera
ok((await adm('/admin/tenants')).j.find(x => x.id === t.id).status === 'awaiting_payment', 'aviso de pagamento que o Asaas não confirma NÃO libera (reconsulta no gateway)');
await fetch(`${F}/asaas/__pay?id=${pay.id}&status=RECEIVED&value=1`);
await webhook('ev-2', 'PAYMENT_RECEIVED', pay.id);
ok((await adm('/admin/tenants')).j.find(x => x.id === t.id).status === 'awaiting_payment', 'pagamento com valor diferente do plano NÃO libera');
r = await adm('/admin/audit?security=1'); ok(r.j.some(a => a.action === 'payment.amount_mismatch') && r.j.some(a => a.action === 'webhook.rejected'), 'tentativas registradas na central de segurança');

// novo cadastro, pago corretamente: libera sozinho
const form2 = { ...form, name: 'Ana Souza', email: 'ana@cliente.com', document: '153.509.460-56', plan: 'top', billingType: 'CREDIT_CARD' };
r = await pub('/auth/signup', form2); ok(r.s === 201, 'cadastro no cartão (Top)', r.j);
A = await asaas(); const sub2 = A.subs.at(-1), pay2 = A.pays.find(p => p.subscription === sub2.id);
ok(sub2.billingType === 'CREDIT_CARD' && sub2.value === 129.9, 'assinatura Top de R$ 129,90 no cartão', sub2);
await fetch(`${F}/asaas/__pay?id=${pay2.id}&status=CONFIRMED`);
r = await webhook('ev-3', 'PAYMENT_CONFIRMED', pay2.id); ok(r.status === 200, 'webhook do pagamento confirmado');
await webhook('ev-3', 'PAYMENT_CONFIRMED', pay2.id);                         // repetido: idempotente
const ana = client();
r = await ana('/auth/login', { email: 'ana@cliente.com', password: 'SenhaDoCliente1' });
ok(r.j.method === 'totp_setup', 'pagamento confirmado: acesso liberado na hora', r.j);
await ana('/auth/login/verify', { ticket: r.j.ticket, code: code(r.j.secret) });
r = await ana('/bots/plan'); ok(r.j.name === 'Top' && r.j.copyTrade && r.j.priceAlerts === -1, 'recursos do plano Top', r.j);
r = await ana('/account'); ok(r.j.planName === 'Top' && r.j.billingType === 'CREDIT_CARD' && r.j.payments.some(p => p.status === 'confirmed'), 'Minha assinatura mostra o pagamento', r.j);
r = await ana('/account/plan', { plan: 'basico' }); ok(r.j.ok && (await asaas()).subs.find(s => s.id === sub2.id).value === 59.9, 'troca de plano atualiza o valor no Asaas', r.j);
r = await ana('/bots/plan'); ok(r.j.maxBots === 1 && !r.j.copyTrade, 'limites do plano novo valem na hora', r.j);
await ana('/account/billing-type', { billingType: 'PIX' });
ok((await asaas()).subs.find(s => s.id === sub2.id).billingType === 'PIX', 'troca da forma de pagamento (cartão → PIX)');

// inadimplência: mensalidade vencida suspende; pagou, volta
await fetch(`${F}/asaas/__pay?id=${pay2.id}&status=OVERDUE`);
await webhook('ev-4', 'PAYMENT_OVERDUE', pay2.id);
r = await ana('/bots/plan'); ok(r.s === 423, 'mensalidade vencida suspende o acesso', r.s);

// o administrador também pode liberar manualmente quem pagou por fora
r = await adm(`/admin/tenants/${t.id}/approve`, {}); ok(r.j.ok, 'administrador libera manualmente um cadastro aguardando pagamento');
const cli = client();
r = await cli('/auth/login', { email: 'thiago@cliente.com', password: 'SenhaDoCliente1' });
await cli('/auth/login/verify', { ticket: r.j.ticket, code: code(r.j.secret) });
r = await cli('/auth/me'); ok(r.j.tenant_status === 'active', 'cliente liberado entra', r.j);

// ---------- VIP oculto ----------
r = await adm(`/admin/tenants/${t.id}`, { vip: true, vipNote: 'parceiro de longa data' }, 'PATCH'); ok(r.j.ok, 'administrador marca o cliente como VIP');
for (const p of ['/auth/me', '/bots/plan', '/bots', '/market/watchlist', '/market/alerts']) {
  r = await cli(p); ok(r.s === 200 && !/vip|parceiro de longa/i.test(JSON.stringify(r.j)), `cliente NÃO vê o VIP (${p})`, r.j);
}
r = await cli('/bots/plan'); ok(r.j.maxBots === 50 && r.j.liveTrading && r.j.copyTrade, 'VIP: recursos do maior plano', r.j);
await adm(`/admin/tenants/${t.id}`, { vip: false }, 'PATCH');
r = await cli('/bots/plan'); ok(r.j.maxBots === 5 && r.j.liveTrading && !r.j.copyTrade, 'sem VIP: volta ao plano Médio', r.j);

// ---------- atividade ----------
await cli('/bots', { name: 'Robô BTC', market: 'crypto', symbol: 'BTCUSDT', interval: '1h', strategy: 'score', amount: 50 });
r = await adm(`/admin/audit?tenantId=${t.id}`);
const acts = r.j.map(a => a.action);
ok(['tenant.signup', 'tenant.approved', 'auth.login_ok', 'auth.totp_enabled', 'bot.created'].every(a => acts.includes(a)), 'administrador vê tudo o que aconteceu na conta', acts);
r = await cli(`/admin/audit?tenantId=${t.id}`); ok(r.s === 403, 'cliente não vê a auditoria');
const me = (await adm('/auth/me')).j;
r = await adm(`/admin/tenants/${me.tenant_id}/kill`, { reason: 'teste da própria conta' }); ok(r.s === 403, 'a conta do próprio administrador não pode ser bloqueada');

// administrador não recupera senha por e-mail
const fs = await import('node:fs');
const before = fs.existsSync(process.env.MAIL_OUTBOX_FILE) ? fs.readFileSync(process.env.MAIL_OUTBOX_FILE, 'utf8') : '';
r = await client()('/auth/forgot', { email: 'dono@agencia.com' });
await new Promise(res => setTimeout(res, 500));
const after = fs.existsSync(process.env.MAIL_OUTBOX_FILE) ? fs.readFileSync(process.env.MAIL_OUTBOX_FILE, 'utf8') : '';
ok(r.s === 200 && before === after, '"Esqueci minha senha" não envia link para o administrador');
await db.end(); process.exit();
