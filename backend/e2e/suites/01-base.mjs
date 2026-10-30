import { totpAt } from '../../dist/auth/totp.js';
const B = 'http://localhost:3997/api';
const code = s => totpAt(s, Math.floor(Date.now() / 30000));
function client() {
  let cookie = '';
  return async (path, body, method) => {
    const r = await fetch(B + path, { method: method ?? (body ? 'POST' : 'GET'),
      headers: { 'Content-Type': 'application/json', Cookie: cookie, 'User-Agent': 'e2e' }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const j = await r.json().catch(() => ({}));
    return { s: r.status, j };
  };
}
const ok = (cond, label, extra) => { console.log(cond ? 'OK  ' : 'FAIL', label, cond ? '' : JSON.stringify(extra)); if (!cond) process.exitCode = 1; };

const adm = client();
let r = await adm('/auth/login', { area: 'admin', email: 'dono@agencia.com', password: 'errada123' });
ok(r.s === 401, 'senha errada -> 401');
r = await adm('/auth/login', { area: 'admin', email: 'dono@agencia.com', password: 'SenhaForte123' });
ok(r.j.method === 'totp_setup' && r.j.qr?.startsWith('data:image/png'), '1º login pede cadastro do 2FA com QR');
const secret = r.j.secret;
r = await adm('/auth/login/verify', { ticket: r.j.ticket, code: '000000' });
ok(r.s === 401, 'código 2FA errado -> 401');
r = await adm('/auth/login', { area: 'admin', email: 'dono@agencia.com', password: 'SenhaForte123' });
const sec2 = r.j.secret;
r = await adm('/auth/login/verify', { ticket: r.j.ticket, code: code(sec2) });
ok(r.s === 200, 'login admin com TOTP', r.j);
r = await adm('/auth/me'); ok(r.j.role === 'platform_admin', '/me admin');
r = await adm('/admin/dashboard'); ok(r.s === 200 && r.j.mrrCents === '0', 'dashboard', r.j);
r = await adm('/admin/plans'); ok(r.j.length === 3, 'planos semeados');
r = await adm('/admin/tenants', { name: 'Padaria Bom Grão', niche: 'padaria', city: 'Campinas', plan: 'pro',
  ownerName: 'Maria Silva', ownerEmail: 'maria@bomgrao.com' });
ok(r.s === 201 && r.j.tempPassword, 'cria cliente', r.j); const tenantId = r.j.id, temp = r.j.tempPassword;
r = await adm('/admin/tenants', { name: 'Barbearia Navalha', plan: 'starter', ownerName: 'João', ownerEmail: 'joao@navalha.com' });
const t2 = r.j.id, temp2 = r.j.tempPassword;
r = await adm('/admin/tenants'); ok(r.j.length === 2, 'lista clientes');
r = await adm('/admin/pix-keys', { keyType: 'EMAIL', keyValue: 'dono@agencia.com' });
ok(r.s === 201, 'cadastra chave PIX (2FA recente do login vale 5 min)', r.j);
r = await adm('/admin/security/summary'); ok(r.j.cadeiaIntegra === true && r.j.ultimas24h.logins_falhos >= 1, 'central de segurança', r.j);
r = await adm('/admin/audit?security=1'); ok(r.j.some(l => l.action === 'auth.mfa_failed'), 'auditoria registra 2FA errado');

// cliente
const cli = client();
r = await cli('/auth/login', { email: 'maria@bomgrao.com', password: temp });
r = await cli('/auth/login/verify', { ticket: r.j.ticket, code: code(r.j.secret) });
ok(r.j.mustChangePassword === true, 'cliente: 1º login exige trocar senha');
r = await cli('/auth/password', { current: temp, next: 'MinhaSenhaNova!1' }); ok(r.s === 200, 'troca senha');
r = await cli('/auth/me'); ok(r.j.tenant_name === 'Padaria Bom Grão' && !r.j.must_change_password, '/me cliente', r.j);
r = await cli('/admin/dashboard'); ok(r.s === 403, 'cliente NÃO acessa Painel Master');
r = await cli('/client/summary'); ok(r.s === 200 && r.j.negocio.plan_name === 'Pro', 'resumo do cliente', r.j);
r = await cli('/client/dossier', { data: { nome: 'Padaria Bom Grão', nicho: 'padaria', cidade: 'Campinas', bairro: 'Cambuí',
  horarios: '7h-19h', telefone: '+5519999999999', tomDeVoz: 'acolhedor' } }, 'PUT'); ok(r.s === 200, 'salva dossiê');
r = await cli('/client/dossier/ingest', { websiteUrl: 'http://169.254.169.254/latest/meta-data' });
ok(r.s === 400 && /não permitido/.test(r.j.error), 'bloqueia SSRF (metadados da nuvem)', r.j);
r = await cli('/client/dossier/ingest', { websiteUrl: 'http://localhost:3997/healthz' });
ok(r.s === 400, 'bloqueia SSRF (localhost)', r.j);
r = await cli('/client/content/generate', { month: '2026-11' });
ok(r.s === 503 && /ANTHROPIC/.test(r.j.error), 'sem chave de IA: erro claro', r.j);

// isolamento: insere conteúdo para cada tenant direto no banco e confere que um não vê o do outro
const { default: pg } = await import('pg');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
for (const [t, cap] of [[tenantId, 'Pão quentinho às 7h'], [tenantId, 'Café da manhã completo'], [t2, 'SEGREDO da barbearia']]) {
  await db.query('BEGIN'); await db.query("SELECT set_config('app.tenant_id', $1, true)", [t]);
  await db.query(`INSERT INTO content_items (tenant_id, channel, kind, payload, scheduled_for) VALUES ($1,'instagram','post',$2, now() + interval '1 day')`, [t, { caption: cap, hashtags: ['#x'] }]);
  await db.query('COMMIT');
}
r = await cli('/approvals'); ok(r.j.length === 2 && !JSON.stringify(r.j).includes('SEGREDO'), 'RLS: cliente só vê o próprio conteúdo', r.j);
const [a1] = r.j;
r = await cli(`/approvals/${a1.id}`, { decision: 'changes', feedback: 'cite o pão de queijo' });
ok(r.s === 200 && r.j.revisado === false, 'pedir ajuste registra (IA sem chave)', r.j);
r = await cli('/approvals/approve-all', {}); ok(r.j.aprovados === 1, 'aprovar tudo', r.j);
r = await cli('/client/content?month=' + new Date(Date.now() + 86400000).toISOString().slice(0, 7));
ok(r.j.filter(i => i.status === 'approved').length === 1 && r.j.filter(i => i.status === 'changes_requested').length === 1, 'kanban por status', r.j);

// kill switch + reativação
r = await adm(`/admin/tenants/${tenantId}/kill`, { reason: 'teste de bloqueio' }); ok(r.s === 200, 'kill switch', r.j);
r = await cli('/client/summary'); ok(r.s === 401 || r.s === 423, 'cliente bloqueado na hora', r.s);
r = await adm(`/admin/tenants/${tenantId}/reactivate`, {}); ok(r.s === 200, 'reativa');
// modo pânico
r = await adm('/admin/security/panic', { on: true, reason: 'teste de pânico' }); ok(r.j.panic?.on === true, 'modo pânico liga', r.j);
r = await adm('/auth/me'); ok(r.j.panic.on === true, '/me mostra pânico');
r = await adm('/admin/security/panic', { on: false }); ok(r.j.panic?.on === false, 'modo pânico desliga');
// chargeback via ledger direto (simula o que o webhook faz após reconsultar o gateway)
const { confirmPayment, reversePayment } = await import('../../dist/payments/confirm.js');
await db.query(`INSERT INTO payments (tenant_id, gateway, gateway_payment_id, kind, amount_cents) VALUES ($1,'asaas','pay_1','media_budget',100000)`, [t2]);
await db.query('BEGIN'); await confirmPayment(db, 'asaas', 'ev1', 'pay_1', 100000n); await db.query('COMMIT');
r = await adm('/admin/dashboard'); ok(r.j.carteiraPessoalCents === '9000' && r.j.fundoMidiaCents === '6000', 'split no ledger: lucro 90, fundo 60', r.j);
await db.query('BEGIN'); await reversePayment(db, 'asaas', 'ev2', 'pay_1', 'chargeback'); await db.query('COMMIT');
r = await adm('/admin/dashboard'); ok(r.j.carteiraPessoalCents === '0' && r.j.clientes.bloqueados === 1, 'chargeback estorna e trava a conta', r.j);
r = await adm('/admin/security/summary'); ok(r.j.cadeiaIntegra, 'cadeia de auditoria íntegra após tudo');
await db.end(); process.exit();
