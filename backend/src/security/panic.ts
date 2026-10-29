import { redis } from '../redis.js';

/*
 * MODO PÂNICO (Kill Switch global): corta na hora toda chamada a APIs externas
 * (IA, Meta Ads, envio de WhatsApp). Webhooks continuam sendo recebidos e gravados.
 * Ligado/desligado pelo Painel Master com 2FA recente; vale para todas as instâncias via Redis.
 */
const KEY = 'panic:global';
let cache = { on: false, at: 0 };

export async function isPanicking(): Promise<boolean> {
  if (Date.now() - cache.at < 2_000) return cache.on;
  cache = { on: (await redis.get(KEY)) !== null, at: Date.now() };
  return cache.on;
}

export async function assertNotPanicking() {
  if (await isPanicking())
    throw Object.assign(new Error('Modo pânico ativo: integrações externas desligadas pelo administrador'), { status: 503 });
}

export async function setPanic(on: boolean, reason?: string) {
  if (on) await redis.set(KEY, JSON.stringify({ reason, at: new Date().toISOString() }));
  else await redis.del(KEY);
  cache = { on, at: Date.now() };
}

export async function panicInfo(): Promise<{ on: boolean; reason?: string; at?: string }> {
  const v = await redis.get(KEY);
  return v ? { on: true, ...JSON.parse(v) } : { on: false };
}
