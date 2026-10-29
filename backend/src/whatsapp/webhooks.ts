import crypto from 'node:crypto';
import express, { Router, type Request } from 'express';
import { servicePool, withTenant } from '../db.js';
import { audit } from '../audit/audit.js';
import { handleInbound } from './inbound.js';
import { publish } from './realtime.js';
import { RATE_BY_QUALITY } from './cadence.js';
import { forgetProvider } from './registry.js';

const safeEq = (a: string, b: string) =>
  a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

async function resolve(phoneNumberId: string | null, e164: string | null) {
  const { rows } = await servicePool.query('SELECT * FROM wa_resolve_number($1, $2)', [phoneNumberId, e164]);
  return rows[0] as { number_id: string; tenant_id: string; status: string } | undefined;
}

/** Atualiza ritmo e status do número conforme a qualidade informada pela Meta. */
export async function applyQuality(tenantId: string, numberId: string, quality: string, limit?: string) {
  const status = quality === 'RED' ? 'throttled' : quality === 'YELLOW' ? 'throttled' : 'active';
  await withTenant(tenantId, c => c.query(
    `UPDATE wa_numbers SET quality_rating = $2, rate_per_min = $3, status = CASE WHEN status IN ('paused','disabled')
       THEN status ELSE $4 END, messaging_limit = coalesce($5, messaging_limit) WHERE id = $1`,
    [numberId, quality, RATE_BY_QUALITY[quality] ?? 20, status, limit ?? null]), servicePool);
  await publish(tenantId, { type: 'number_health', numberId, quality });
}

export const waWebhookRouter = Router();

// ---------- Meta Cloud API (um único app da agência recebe os eventos de todos os WABAs) ----------
waWebhookRouter.get('/meta', (req, res) =>
  req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === process.env.WHATSAPP_VERIFY_TOKEN
    ? res.send(req.query['hub.challenge']) : res.sendStatus(403));

waWebhookRouter.post('/meta', async (req: Request & { rawBody?: Buffer }, res) => {
  const expected = 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET!)
                                     .update(req.rawBody ?? Buffer.alloc(0)).digest('hex');
  if (!safeEq(req.get('x-hub-signature-256') ?? '', expected)) return res.sendStatus(401);
  res.sendStatus(200);                                       // a Meta exige resposta rápida

  for (const entry of req.body.entry ?? []) for (const ch of entry.changes ?? []) {
    try {
      const v = ch.value ?? {};
      if (ch.field === 'messages') {
        const n = await resolve(v.metadata?.phone_number_id, null);
        if (!n) continue;
        const names = Object.fromEntries((v.contacts ?? []).map((k: any) => [k.wa_id, k.profile?.name]));
        for (const m of v.messages ?? []) {
          await handleInbound({ tenantId: n.tenant_id, numberId: n.number_id, fromWaId: m.from, name: names[m.from],
                                wamid: m.id, type: m.type,
                                text: m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title });
        }
        for (const s of v.statuses ?? []) {
          await withTenant(n.tenant_id, c => c.query(
            `UPDATE wa_messages SET status = $2, error = $3 WHERE wamid = $1 AND status <> 'read'`,
            [s.id, s.status, s.errors?.[0]?.title ?? null]), servicePool);
          await publish(n.tenant_id, { type: 'status', wamid: s.id, status: s.status });
        }
      }
      if (ch.field === 'phone_number_quality_update') {
        const n = await resolve(null, `+${String(v.display_phone_number).replace(/\D/g, '')}`);
        if (!n) continue;
        const quality = v.event === 'FLAGGED' ? 'YELLOW' : v.event === 'DOWNGRADE' ? 'RED' : 'GREEN';
        await applyQuality(n.tenant_id, n.number_id, quality, v.current_limit);
        await audit({ tenantId: n.tenant_id, action: 'wa.quality_update', meta: v });
      }
      if (ch.field === 'account_update' && /DISABLED|VIOLATION|BANNED|RESTRICT/i.test(String(v.event))) {
        await audit({ action: 'wa.account_alert', meta: { waba: entry.id, ...v } });
        // pausa todos os números do WABA afetado; o admin decide o próximo passo
        const { rows } = await servicePool.query('SELECT * FROM wa_pause_waba($1)', [entry.id]);
        for (const r of rows) { forgetProvider(r.number_id); await publish(r.tenant_id, { type: 'number_health', numberId: r.number_id, quality: 'PAUSED' }); }
      }
    } catch (err) { console.error('[wa-webhook]', err); }
  }
});

// ---------- Twilio (números alocados como remetentes WhatsApp na Twilio) ----------
function validTwilio(req: Request) {
  const url = `${process.env.PUBLIC_URL}${req.originalUrl}`;
  const data = Object.keys(req.body ?? {}).sort().reduce((acc, k) => acc + k + req.body[k], url);
  const expected = crypto.createHmac('sha1', process.env.TWILIO_AUTH_TOKEN!).update(data, 'utf8').digest('base64');
  return safeEq(req.get('x-twilio-signature') ?? '', expected);
}

waWebhookRouter.use('/twilio', express.urlencoded({ extended: false }));

waWebhookRouter.post('/twilio/inbound', async (req, res) => {
  if (!validTwilio(req)) return res.sendStatus(401);
  res.type('text/xml').send('<Response/>');
  const n = await resolve(null, String(req.body.To).replace('whatsapp:', ''));
  if (!n) return;
  await handleInbound({ tenantId: n.tenant_id, numberId: n.number_id,
    fromWaId: String(req.body.From).replace('whatsapp:+', ''), name: req.body.ProfileName,
    wamid: req.body.MessageSid, type: Number(req.body.NumMedia) > 0 ? 'media' : 'text', text: req.body.Body });
});

waWebhookRouter.post('/twilio/status', async (req, res) => {
  if (!validTwilio(req)) return res.sendStatus(401);
  res.sendStatus(204);
  const n = await resolve(null, String(req.body.From).replace('whatsapp:', ''));
  if (!n) return;
  await withTenant(n.tenant_id, c => c.query(`UPDATE wa_messages SET status = $2, error = $3 WHERE wamid = $1`,
    [req.body.MessageSid, req.body.MessageStatus === 'undelivered' ? 'failed' : req.body.MessageStatus,
     req.body.ErrorCode ?? null]), servicePool);
});

// Ligação da Meta com o código de verificação cai no número virtual: gravamos para o operador ouvir.
waWebhookRouter.post('/twilio/voz', (req, res) => {
  if (!validTwilio(req)) return res.sendStatus(401);
  const cb = `${process.env.PUBLIC_URL}/webhooks/whatsapp/twilio/gravacao?to=${encodeURIComponent(req.body.To)}`;
  res.type('text/xml').send(
    `<Response><Record maxLength="60" playBeep="false" recordingStatusCallback="${cb.replace(/&/g, '&amp;')}"/></Response>`);
});

waWebhookRouter.post('/twilio/gravacao', async (req, res) => {
  if (!validTwilio(req)) return res.sendStatus(401);
  res.sendStatus(204);
  const n = await resolve(null, String(req.query.to));
  if (!n) return;
  await withTenant(n.tenant_id, c => c.query(`UPDATE wa_numbers SET verification_rec_url = $2 WHERE id = $1`,
    [n.number_id, `${req.body.RecordingUrl}.mp3`]), servicePool);
  forgetProvider(n.number_id);
  await publish(n.tenant_id, { type: 'verification_call', numberId: n.number_id });
});
