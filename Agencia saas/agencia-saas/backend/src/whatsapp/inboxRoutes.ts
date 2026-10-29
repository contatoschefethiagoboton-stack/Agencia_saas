import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { withTenant } from '../db.js';
import { audit } from '../audit/audit.js';
import { enqueueReply } from './inbound.js';
import { publish, stream } from './realtime.js';
import { addNumberToWaba, buyVirtualNumber, connectEmbeddedSignup, submitVerificationCode } from './provisioning.js';

export const inboxRouter = Router();
const tid = (req: Request) => req.user!.tid!;
const ownerOnly = (req: Request, res: Response, next: NextFunction) =>
  req.user?.role === 'owner' ? next() : res.status(403).json({ error: 'Só o responsável pela conta pode fazer isso' });

// ---------- Tempo real ----------
inboxRouter.get('/stream', stream);

// ---------- Painel de atendimento ----------
inboxRouter.get('/numbers', async (req, res) => {
  res.json(await withTenant(tid(req), async c => (await c.query(
    `SELECT id, phone_e164, verified_name, name_status, quality_rating, messaging_limit, status,
            verification_rec_url IS NOT NULL AS has_recording FROM wa_numbers ORDER BY created_at`)).rows));
});

inboxRouter.get('/conversations', async (req, res) => {
  const numberId = z.string().uuid().optional().parse(req.query.numberId);
  res.json(await withTenant(tid(req), async c => (await c.query(`
    SELECT cv.id, cv.number_id, cv.mode, cv.unread, cv.updated_at, cv.handoff_reason,
           cv.last_inbound_at > now() - interval '24 hours' AS in_window,
           k.name, k.wa_id,
           (SELECT body FROM wa_messages m WHERE m.conversation_id = cv.id ORDER BY id DESC LIMIT 1) AS preview
      FROM wa_conversations cv JOIN wa_contacts k ON k.id = cv.contact_id
     WHERE ($1::uuid IS NULL OR cv.number_id = $1) AND cv.mode <> 'closed'
     ORDER BY (cv.mode = 'human') DESC, cv.updated_at DESC LIMIT 100`, [numberId ?? null])).rows));
});

inboxRouter.get('/conversations/:id/messages', async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  res.json(await withTenant(tid(req), async c => {
    await c.query(`UPDATE wa_conversations SET unread = 0 WHERE id = $1`, [id]);
    return (await c.query(`SELECT id, direction, author, body, status, error, created_at FROM wa_messages
                           WHERE conversation_id = $1 ORDER BY id DESC LIMIT 200`, [id])).rows.reverse();
  }));
});

// Atendente responde pela web: assume a conversa (a IA para de responder nela)
inboxRouter.post('/conversations/:id/messages', async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const body = z.string().trim().min(1).max(4000).parse(req.body?.body);
  const msgId = await withTenant(tid(req), async c => {
    const cv = (await c.query(`SELECT cv.number_id, k.wa_id, cv.last_inbound_at > now() - interval '24 hours' AS in_window
                               FROM wa_conversations cv JOIN wa_contacts k ON k.id = cv.contact_id WHERE cv.id = $1`, [id])).rows[0];
    if (!cv) throw Object.assign(new Error('Conversa não encontrada'), { status: 404 });
    if (!cv.in_window) throw Object.assign(new Error('Passaram 24h desde a última mensagem do cliente. Envie um modelo aprovado.'), { status: 409 });
    const mid = await enqueueReply(c, { tenantId: tid(req), numberId: cv.number_id, fromWaId: cv.wa_id }, id, body, 'agent', req.user!.sub);
    await c.query(`UPDATE wa_conversations SET mode = 'human', assigned_to = coalesce(assigned_to, $2), updated_at = now()
                   WHERE id = $1`, [id, req.user!.sub]);
    await audit({ actorId: req.user!.sub, tenantId: tid(req), ip: req.ip, action: 'wa.agent_reply', target: id }, c);
    return mid;
  });
  await publish(tid(req), { type: 'message', conversationId: id, messageId: msgId });
  res.json({ ok: true, messageId: msgId });
});

// Devolver para a IA, assumir manualmente ou encerrar
inboxRouter.post('/conversations/:id/mode', async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const mode = z.enum(['bot', 'human', 'closed']).parse(req.body?.mode);
  await withTenant(tid(req), async c => {
    await c.query(`UPDATE wa_conversations SET mode = $2, handoff_reason = NULL,
                     assigned_to = CASE WHEN $2 = 'human' THEN $3::uuid ELSE NULL END, updated_at = now() WHERE id = $1`,
                  [id, mode, req.user!.sub]);
    await audit({ actorId: req.user!.sub, tenantId: tid(req), ip: req.ip, action: `wa.mode_${mode}`, target: id }, c);
  });
  await publish(tid(req), { type: 'mode', conversationId: id, mode });
  res.json({ ok: true });
});

// ---------- Números (responsável pela conta) ----------
inboxRouter.post('/numbers/embedded-signup', ownerOnly, async (req, res) => {
  const b = z.object({ code: z.string().min(10), wabaId: z.string(), phoneNumberId: z.string().optional() }).parse(req.body);
  await connectEmbeddedSignup(tid(req), req.user!.sub, b);
  res.json({ ok: true });
});

inboxRouter.post('/numbers/virtual', ownerOnly, async (req, res) => {
  const b = z.object({ areaCode: z.string().regex(/^\d{2}$/).optional(), wabaId: z.string(),
                       displayName: z.string().min(3).max(60) }).parse(req.body);
  const n = await buyVirtualNumber(tid(req), req.user!.sub, b.areaCode);
  await addNumberToWaba(tid(req), n.numberId, b.wabaId, b.displayName);
  res.json({ ok: true, ...n, next: 'Aguarde a ligação da Meta; a gravação aparece no painel em instantes.' });
});

inboxRouter.get('/numbers/:id/recording', ownerOnly, async (req, res) => {
  const url = await withTenant(tid(req), async c => (await c.query(
    `SELECT verification_rec_url FROM wa_numbers WHERE id = $1`, [req.params.id])).rows[0]?.verification_rec_url);
  if (!url) return res.status(404).json({ error: 'A ligação ainda não chegou' });
  const r = await fetch(url, { headers: { Authorization: 'Basic ' +
    Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64') } });
  res.type('audio/mpeg').send(Buffer.from(await r.arrayBuffer()));   // proxy: credenciais nunca vão ao navegador
});

inboxRouter.post('/numbers/:id/verify', ownerOnly, async (req, res) => {
  const code = z.string().regex(/^\d{6}$/).parse(req.body?.code);
  await submitVerificationCode(tid(req), req.user!.sub, z.string().uuid().parse(req.params.id), code);
  res.json({ ok: true });
});
