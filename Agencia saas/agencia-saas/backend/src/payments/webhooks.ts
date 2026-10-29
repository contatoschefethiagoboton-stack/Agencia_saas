import { Router } from 'express';
import { withService } from '../db.js';
import { verifyAsaas, verifyMercadoPago } from './verify.js';
import { confirmPayment } from './confirm.js';
import { audit } from '../audit/audit.js';

export const webhookRouter = Router();

/*
 * REGRA DE OURO ANTIFRAUDE
 * 1) Webhook só é aceito com assinatura/token válido.
 * 2) Mesmo assinado, o conteúdo NÃO é confiado: o pagamento é consultado na API do gateway.
 * 3) Comprovante enviado por cliente (imagem/PDF) nunca libera nada. Não existe rota para isso.
 * 4) Idempotência: cada evento é processado uma única vez.
 */

webhookRouter.post('/asaas', async (req, res) => {
  if (!verifyAsaas(req)) { await audit({ ip: req.ip, action: 'webhook.rejected', target: 'asaas' }); return res.status(401).end(); }
  const { id: eventId, event, payment } = req.body ?? {};
  if (!eventId || !payment?.id) return res.status(400).end();
  if (!['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED'].includes(event)) return res.sendStatus(200);

  const r = await fetch(`${process.env.ASAAS_API_URL}/payments/${encodeURIComponent(payment.id)}`,
                        { headers: { access_token: process.env.ASAAS_API_KEY! } });
  if (!r.ok) return res.status(502).end();                        // gateway reenvia depois
  const real = await r.json();
  if (!['RECEIVED', 'CONFIRMED'].includes(real.status)) return res.sendStatus(200);

  await withService(c => confirmPayment(c, 'asaas', String(eventId), real.id,
                                        BigInt(Math.round(Number(real.value) * 100)), req.ip));
  res.sendStatus(200);
});

webhookRouter.post('/mercadopago', async (req, res) => {
  if (!verifyMercadoPago(req)) { await audit({ ip: req.ip, action: 'webhook.rejected', target: 'mercadopago' }); return res.status(401).end(); }
  const paymentId = String(req.query['data.id']);
  const eventId = `${req.get('x-request-id')}:${paymentId}`;

  const r = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`,
                        { headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` } });
  if (!r.ok) return res.status(502).end();
  const real = await r.json();
  if (real.status !== 'approved') return res.sendStatus(200);

  await withService(c => confirmPayment(c, 'mercadopago', eventId, String(real.id),
                                        BigInt(Math.round(Number(real.transaction_amount) * 100)), req.ip));
  res.sendStatus(200);
});
