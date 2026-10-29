import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { redis } from '../redis.js';

const store = (prefix: string) =>
  new RedisStore({ prefix, sendCommand: (...args: string[]) => redis.sendCommand(args) });

/** Geral: 300 req / 15 min por IP */
export const apiLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 300, standardHeaders: 'draft-7',
                                      legacyHeaders: false, store: store('rl:api:') });

/** Login/OTP: 10 tentativas / 15 min por IP + e-mail */
export const loginLimiter = rateLimit({
  windowMs: 15 * 60_000, limit: 10, store: store('rl:login:'),
  keyGenerator: req => `${req.ip}|${String(req.body?.email ?? req.body?.userId ?? '')}`,
  message: { error: 'Muitas tentativas. Aguarde 15 minutos.' },
});
