import type { PoolClient } from 'pg';
import { assertNotPanicking } from '../security/panic.js';

/*
 * Cobrança no Asaas. Toda cobrança leva externalReference = "<tenantId>|<tipo>":
 * é assim que o webhook descobre de quem é um pagamento recorrente que nasceu no gateway.
 *
 * SPLIT NATIVO (recomendado): defina ASAAS_SPLIT_JSON com as carteiras que recebem direto no ato
 * do pagamento, ex.: [{"walletId":"...","percentualValue":20,"description":"Fundo de expansão"}].
 * Assim a plataforma não custodia dinheiro de terceiros. O restante cai na conta principal.
 */
export const billingReady = () => Boolean(process.env.ASAAS_API_KEY && process.env.ASAAS_API_URL);

async function asaas(path: string, body?: unknown) {
  await assertNotPanicking();
  if (!billingReady()) throw Object.assign(new Error('Gateway de pagamento não configurado (ASAAS_API_KEY)'), { status: 503 });
  const r = await fetch(`${process.env.ASAAS_API_URL}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { access_token: process.env.ASAAS_API_KEY!, 'Content-Type': 'application/json', 'User-Agent': 'agencia-hub' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json: any = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`Asaas: ${json?.errors?.[0]?.description ?? r.status}`), { status: 502 });
  return json;
}

const split = () => {
  try { const s = JSON.parse(process.env.ASAAS_SPLIT_JSON ?? '[]'); return Array.isArray(s) && s.length ? s : undefined; }
  catch { return undefined; }
};
const today = (plusDays = 0) => new Date(Date.now() + plusDays * 86_400_000).toISOString().slice(0, 10);

export async function ensureCustomer(c: PoolClient, tenantId: string, ownerEmail?: string): Promise<string> {
  const t = (await c.query(`SELECT name, document, asaas_customer_id FROM tenants WHERE id = $1`, [tenantId])).rows[0];
  if (t.asaas_customer_id) return t.asaas_customer_id;
  if (!t.document) throw Object.assign(new Error('Informe o CPF/CNPJ do cliente para cobrar'), { status: 400 });
  const cust = await asaas('/customers', { name: t.name, cpfCnpj: t.document.replace(/\D/g, ''), email: ownerEmail,
                                           externalReference: tenantId, notificationDisabled: false });
  await c.query(`UPDATE tenants SET asaas_customer_id = $2 WHERE id = $1`, [tenantId, cust.id]);
  return cust.id;
}

/** Assinatura mensal do plano. As cobranças mensais chegam pelo webhook. */
export async function createSubscription(c: PoolClient, tenantId: string, ownerEmail?: string) {
  const customer = await ensureCustomer(c, tenantId, ownerEmail);
  const p = (await c.query(`SELECT p.id, p.name, p.price_cents, t.asaas_subscription_id FROM tenants t
                            JOIN plans p ON p.id = t.plan WHERE t.id = $1`, [tenantId])).rows[0];
  if (p.asaas_subscription_id) return p.asaas_subscription_id as string;
  const sub = await asaas('/subscriptions', {
    customer, billingType: 'UNDEFINED', cycle: 'MONTHLY', nextDueDate: today(1),
    value: Number(p.price_cents) / 100, description: `Plano ${p.name}`,
    externalReference: `${tenantId}|subscription`, split: split(),
  });
  await c.query(`UPDATE tenants SET asaas_subscription_id = $2 WHERE id = $1`, [tenantId, sub.id]);
  return sub.id as string;
}

/** Cobrança avulsa (setup, verba de mídia, serviço avulso). Já registra o pagamento pendente. */
export async function createCharge(c: PoolClient, tenantId: string, kind: 'setup' | 'media_budget' | 'a_la_carte',
                                   cents: bigint, description: string, ownerEmail?: string) {
  const customer = await ensureCustomer(c, tenantId, ownerEmail);
  const pay = await asaas('/payments', {
    customer, billingType: 'UNDEFINED', value: Number(cents) / 100, dueDate: today(2), description,
    externalReference: `${tenantId}|${kind}`,
    split: kind === 'media_budget' ? undefined : split(),   // verba de mídia: o split é feito no ledger
  });
  await c.query(`INSERT INTO payments (tenant_id, gateway, gateway_payment_id, kind, amount_cents)
                 VALUES ($1, 'asaas', $2, $3, $4)`, [tenantId, pay.id, kind, cents.toString()]);
  return { id: pay.id as string, invoiceUrl: pay.invoiceUrl as string };
}
