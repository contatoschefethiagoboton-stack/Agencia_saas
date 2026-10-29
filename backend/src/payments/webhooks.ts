import { Router } from 'express';
import { withService } from '../db.js';
import { verifyAsaas, verifyMercadoPago } from './verify.js';
import { confirmPayment, ensurePayment, reversePayment } from './confirm.js';
import { audit } from '../audit/audit.js';

export const webhookRouter = Router();

/*
 * REGRA DE OURO ANTIFRAUDE
 * 1) Webhook só é aceito com assinatura/token válido (HMAC no Mercado Pago, token no Asaas).
 * 2) Mesmo assinado, o conteúdo NÃO é confiado: o pagamento é consultado na API do gateway.
 * 3) Comprovante enviado por cliente (imagem/PDF) nunca libera nada. Não existe rota para isso.
 * 4) Idempotência: cada evento é processado uma única vez.
 * 5) Chargeback trava a conta do cliente na hora.
 */
const PAID = ['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED'];
const CHARGEBACK = ['PAYMENT_CHARGEBACK_REQUESTED', 'PAYMENT_CHARGEBACK_DISPUTE', 'PAYMENT_AWAITING_CHARGEBACK_REVERSAL'];
const REFUND = ['PAYMENT_REFUNDED'];

webhookRouter.post('/asaas', async (req, res) => {
  if (!verifyAsaas(req)) { await audit({ ip: req.ip, action: 'webhook.rejected', target: 'asaas' }); return res.status(401).end(); }
  const { id: eventId, event, payment } = req.body ?? {};
  if (!eventId || !payment?.id) return res.status(400).end();
  if (![...PAID, ...CHARGEBACK, ...REFUND].includes(event)) return res.sendStatus(200);

  const r = await fetch(`${process.env.ASAAS_API_URL}/payments/${encodeURIComponent(payment.id)}`,
                        { headers: { access_token: process.env.ASAAS_API_KEY! } });
  if (!r.ok) return res.status(502).end();                        // gateway reenvia depois
  const real = await r.json();
  const cents = BigInt(Math.round(Number(real.value) * 100));

  if (CHARGEBACK.includes(event) && (real.chargeback || String(real.status).includes('CHARGEBACK'))) {
    await withService(c => reversePayment(c, 'asaas', String(eventId), real.id, 'chargeback', req.ip));
  } else if (REFUND.includes(event) && real.status === 'REFUNDED') {
    await withService(c => reversePayment(c, 'asaas', String(eventId), real.id, 'refunded', req.ip));
  } else if (PAID.includes(event) && ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'].includes(real.status)) {
    await withService(async c => {
      await ensurePayment(c, 'asaas', real.id, real.externalReference, cents);
      await confirmPayment(c, 'asaas', String(eventId), real.id, cents, req.ip);
    });
  }
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
  const cents = BigInt(Math.round(Number(real.transaction_amount) * 100));

  if (real.status === 'charged_back') {
    await withService(c => reversePayment(c, 'mercadopago', eventId, String(real.id), 'chargeback', req.ip));
  } else if (real.status === 'refunded') {
    await withService(c => reversePayment(c, 'mercadopago', eventId, String(real.id), 'refunded', req.ip));
  } else if (real.status === 'approved') {
    await withService(async c => {
      await ensurePayment(c, 'mercadopago', String(real.id), real.external_reference, cents);
      await confirmPayment(c, 'mercadopago', eventId, String(real.id), cents, req.ip);
    });
  }
  res.sendStatus(200);
});
