import type { PoolClient } from 'pg';
import { servicePool, withTenant } from '../db.js';
import { providerFor } from './registry.js';
import { checkCadence } from './cadence.js';
import { publish } from './realtime.js';
import { isPanicking } from '../security/panic.js';

// Códigos de erro da Cloud API que indicam risco ao número (conferir a lista vigente na doc da Meta)
const SPAM_LIMIT = new Set([131048, 131056, 130429]);   // limite de spam / par / throughput
const OUT_OF_WINDOW = 131047;                            // mais de 24h sem resposta do cliente

async function processItem(item: any) {
  const svc = <T>(fn: (c: PoolClient) => Promise<T>) => withTenant(item.tenant_id, fn, servicePool);

  const ctx: any = await svc(async c => (await c.query(`
    SELECT n.status, n.quality_rating, n.messaging_limit, n.rate_per_min, n.portfolio_id,
           k.opted_in_at, k.opted_out_at, cv.last_inbound_at > now() - interval '24 hours' AS in_window
      FROM wa_numbers n
      JOIN wa_contacts k ON k.tenant_id = n.tenant_id AND k.wa_id = $2
      LEFT JOIN wa_conversations cv ON cv.number_id = n.id AND cv.contact_id = k.id
     WHERE n.id = $1`, [item.number_id, item.to_wa_id])).rows[0]);

  const block = async (reason: string) => svc(async c => {
    await c.query(`UPDATE wa_outbox SET status = 'blocked' WHERE id = $1`, [item.id]);
    if (item.message_id) await c.query(`UPDATE wa_messages SET status = 'failed', error = $2 WHERE id = $1`, [item.message_id, reason]);
  });

  if (!ctx || !['active', 'throttled'].includes(ctx.status)) return block('Número pausado ou desativado');
  if (item.kind === 'session' && !ctx.in_window) return block('Fora da janela de 24h: use um modelo aprovado');
  if (ctx.opted_out_at && item.kind !== 'session') return block('Contato pediu para não receber mensagens');
  if (item.kind === 'marketing' && !ctx.opted_in_at) return block('Contato sem consentimento para marketing');

  const decision = await checkCadence({ numberId: item.number_id, portfolioId: ctx.portfolio_id,
    messagingLimit: ctx.messaging_limit, ratePerMin: ctx.rate_per_min, quality: ctx.quality_rating,
    kind: item.kind, toWaId: item.to_wa_id });
  if (!decision.ok) {
    if (decision.permanent) return block(decision.reason);
    return svc(c => c.query(`UPDATE wa_outbox SET status = 'pending', attempts = attempts - 1,
                              not_before = now() + make_interval(secs => $2) WHERE id = $1`,
                            [item.id, decision.retryInMs / 1000]));
  }

  try {
    const p = await providerFor(item.tenant_id, item.number_id);
    const res = item.payload.template
      ? await p.sendTemplate(item.to_wa_id, item.payload.template, item.payload.lang ?? 'pt_BR', item.payload.params ?? [])
      : await p.sendText(item.to_wa_id, item.payload.text);
    await svc(async c => {
      await c.query(`UPDATE wa_outbox SET status = 'sent' WHERE id = $1`, [item.id]);
      if (item.message_id) await c.query(`UPDATE wa_messages SET status = 'sent', wamid = $2 WHERE id = $1`, [item.message_id, res.wamid]);
    });
    await publish(item.tenant_id, { type: 'status', messageId: item.message_id, status: 'sent' });
  } catch (e: any) {
    if (e.metaCode === OUT_OF_WINDOW) return block('Fora da janela de 24h: use um modelo aprovado');
    const backoff = SPAM_LIMIT.has(e.metaCode) ? 15 * 60 : 30 * 2 ** item.attempts;
    if (SPAM_LIMIT.has(e.metaCode)) {          // a Meta avisou: esfria o número na hora
      await svc(c => c.query(`UPDATE wa_numbers SET status = 'throttled',
                               rate_per_min = GREATEST(rate_per_min / 2, 2) WHERE id = $1`, [item.number_id]));
    }
    await svc(c => c.query(
      `UPDATE wa_outbox SET status = CASE WHEN attempts >= 5 THEN 'failed' ELSE 'pending' END,
              not_before = now() + make_interval(secs => $2) WHERE id = $1`, [item.id, backoff]));
  }
}

export async function runOutboxWorker() {
  for (;;) {
    if (await isPanicking()) { await new Promise(r => setTimeout(r, 5000)); continue; }   // fila fica parada
    const { rows } = await servicePool.query('SELECT * FROM wa_claim_outbox(25)');
    await Promise.allSettled(rows.map(processItem));
    if (!rows.length) await new Promise(r => setTimeout(r, 1000));
  }
}
