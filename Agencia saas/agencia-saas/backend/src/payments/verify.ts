import crypto from 'node:crypto';
import type { Request } from 'express';

const safeEq = (a: string, b: string) => {
  const A = Buffer.from(a), B = Buffer.from(b);
  return A.length === B.length && crypto.timingSafeEqual(A, B);
};

/**
 * Mercado Pago: header x-signature = "ts=...,v1=<hmac>"; manifest oficial:
 *   id:<data.id>;request-id:<x-request-id>;ts:<ts>;
 * HMAC-SHA256 com a "assinatura secreta" do painel de webhooks.
 */
export function verifyMercadoPago(req: Request): boolean {
  const sig = req.get('x-signature') ?? '';
  const parts = Object.fromEntries(sig.split(',').map(p => p.trim().split('=') as [string, string]));
  const dataId = String(req.query['data.id'] ?? '').toLowerCase();
  const requestId = req.get('x-request-id') ?? '';
  if (!parts.ts || !parts.v1 || !dataId) return false;
  if (Math.abs(Date.now() - Number(parts.ts)) > 5 * 60_000) return false;   // anti-replay (ts em ms)
  const manifest = `id:${dataId};request-id:${requestId};ts:${parts.ts};`;
  const expected = crypto.createHmac('sha256', process.env.MP_WEBHOOK_SECRET!).update(manifest).digest('hex');
  return safeEq(expected, parts.v1);
}

/** Asaas: token configurado no webhook chega no header asaas-access-token. */
export const verifyAsaas = (req: Request) =>
  safeEq(req.get('asaas-access-token') ?? '', process.env.ASAAS_WEBHOOK_TOKEN!);
