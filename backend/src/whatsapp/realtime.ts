import type { Request, Response } from 'express';
import { redis } from '../redis.js';

const sub = redis.duplicate();
await sub.connect();

/** Evento para o painel do negócio (nova mensagem, status, transferência para humano). */
export const publish = (tenantId: string, event: Record<string, unknown>) =>
  redis.publish(`wa:t:${tenantId}`, JSON.stringify(event));

/** Server-Sent Events: cada aba do painel recebe só os eventos do próprio tenant. */
export async function stream(req: Request, res: Response) {
  const channel = `wa:t:${req.user!.tid}`;
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const listener = (msg: string) => res.write(`data: ${msg}\n\n`);
  await sub.subscribe(channel, listener);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => { clearInterval(ping); sub.unsubscribe(channel, listener).catch(() => {}); });
}
