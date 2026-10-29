import { servicePool, withTenant } from '../db.js';
import { redis } from '../redis.js';
import { publish } from './realtime.js';

const OPT_OUT = /^\s*(sair|parar|pare|cancelar|stop|descadastrar)\s*$/i;
const OPT_IN = /^\s*(voltar|quero receber|sim, quero)\s*$/i;

export interface Inbound {
  tenantId: string; numberId: string; fromWaId: string; name?: string;
  wamid: string; type: string; text?: string;
}

/** Toda mensagem recebida cai na aba do negócio dono do número. Idempotente por wamid. */
export async function handleInbound(m: Inbound) {
  const result = await withTenant(m.tenantId, async c => {
    const contact = (await c.query(`
      INSERT INTO wa_contacts (tenant_id, wa_id, name) VALUES ($1, $2, $3)
      ON CONFLICT (tenant_id, wa_id) DO UPDATE SET name = coalesce(EXCLUDED.name, wa_contacts.name)
      RETURNING id`, [m.tenantId, m.fromWaId, m.name ?? null])).rows[0];

    const conv = (await c.query(`
      INSERT INTO wa_conversations (tenant_id, number_id, contact_id, last_inbound_at, unread)
      VALUES ($1, $2, $3, now(), 1)
      ON CONFLICT (number_id, contact_id) DO UPDATE SET last_inbound_at = now(), unread = wa_conversations.unread + 1,
        updated_at = now(), mode = CASE WHEN wa_conversations.mode = 'closed' THEN 'bot' ELSE wa_conversations.mode END
      RETURNING id, mode`, [m.tenantId, m.numberId, contact.id])).rows[0];

    const msg = await c.query(`
      INSERT INTO wa_messages (tenant_id, conversation_id, direction, author, msg_type, body, wamid, status)
      VALUES ($1, $2, 'in', 'contact', $3, $4, $5, 'received') ON CONFLICT (wamid) DO NOTHING RETURNING id`,
      [m.tenantId, conv.id, m.type, m.text ?? `[${m.type}]`, m.wamid]);
    if (!msg.rowCount) return null;                     // evento repetido pelo webhook

    if (m.text && OPT_OUT.test(m.text)) {
      await c.query(`UPDATE wa_contacts SET opted_out_at = now() WHERE id = $1`, [contact.id]);
      await enqueueReply(c, m, conv.id, 'Pronto, você não vai mais receber mensagens promocionais. Se precisar, é só escrever aqui.', 'system');
      return { convId: conv.id, msgId: msg.rows[0].id, mode: 'skip' };
    }
    if (m.text && OPT_IN.test(m.text))
      await c.query(`UPDATE wa_contacts SET opted_in_at = now(), opted_out_at = NULL WHERE id = $1`, [contact.id]);

    return { convId: conv.id, msgId: msg.rows[0].id, mode: conv.mode };
  }, servicePool);

  if (!result) return;
  await publish(m.tenantId, { type: 'message', conversationId: result.convId, messageId: result.msgId });
  if (result.mode === 'bot')
    await redis.lPush('wa:ai:jobs', JSON.stringify({ tenantId: m.tenantId, conversationId: result.convId }));
}

/** Coloca uma resposta na fila de saída (nunca envia direto). */
export async function enqueueReply(c: any, m: { tenantId: string; numberId: string; fromWaId: string },
                                   convId: string, text: string, author: 'ai' | 'agent' | 'system', agentId?: string) {
  const msg = (await c.query(`INSERT INTO wa_messages (tenant_id, conversation_id, direction, author, agent_id, body)
                              VALUES ($1, $2, 'out', $3, $4, $5) RETURNING id`,
                             [m.tenantId, convId, author, agentId ?? null, text])).rows[0];
  await c.query(`INSERT INTO wa_outbox (tenant_id, number_id, message_id, to_wa_id, kind, payload, priority)
                 VALUES ($1, $2, $3, $4, 'session', $5, 1)`,
                [m.tenantId, m.numberId, msg.id, m.fromWaId, { text }]);
  return msg.id as number;
}
