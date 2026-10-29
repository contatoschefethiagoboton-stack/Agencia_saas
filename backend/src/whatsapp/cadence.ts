import { redis } from '../redis.js';

/*
 * BLINDAGEM DO NÚMERO
 * Na API oficial, o que derruba número não é "velocidade bonita": é qualidade.
 * Bloqueios e denúncias de usuários baixam o quality rating -> limites caem -> número pausado.
 * Por isso a cadência aqui combina:
 *  1) token bucket por número (ritmo ajustado pela qualidade atual);
 *  2) teto de destinatários únicos em 24h por PORTFÓLIO (o limite da Meta é por portfólio);
 *  3) frequência por contato (no máx. 1 mensagem de marketing a cada 24h);
 *  4) consentimento: marketing só para quem deu opt-in e não pediu para sair;
 *  5) qualidade RED pausa tudo que é iniciado pela empresa (respostas a clientes continuam).
 */

const BUCKET = `
local t = tonumber(redis.call('HGET', KEYS[1], 't') or ARGV[3])
local ts = tonumber(redis.call('HGET', KEYS[1], 'ts') or ARGV[2])
local now, rate, cap = tonumber(ARGV[2]), tonumber(ARGV[1]), tonumber(ARGV[3])
t = math.min(cap, t + (now - ts) * rate / 60000)
local ok = 0
if t >= 1 then t = t - 1; ok = 1 end
redis.call('HSET', KEYS[1], 't', t, 'ts', now)
redis.call('PEXPIRE', KEYS[1], 300000)
return ok`;

export const LIMIT_BY_TIER: Record<string, number> = {
  TIER_250: 250, TIER_2K: 2000, TIER_10K: 10_000, TIER_100K: 100_000, TIER_UNLIMITED: Number.MAX_SAFE_INTEGER,
};

/** Ritmo por qualidade: o número "esfria" sozinho quando a Meta sinaliza problema. */
export const RATE_BY_QUALITY: Record<string, number> = { GREEN: 60, UNKNOWN: 20, YELLOW: 10, RED: 0 };

export interface CadenceInput {
  numberId: string; portfolioId: string | null; messagingLimit: string; ratePerMin: number;
  quality: string; kind: 'session' | 'utility' | 'marketing' | 'authentication'; toWaId: string;
}

export type CadenceDecision = { ok: true } | { ok: false; retryInMs: number; reason: string; permanent?: boolean };

export async function checkCadence(i: CadenceInput): Promise<CadenceDecision> {
  const businessInitiated = i.kind !== 'session';
  if (businessInitiated && i.quality === 'RED')
    return { ok: false, retryInMs: 6 * 3600_000, reason: 'Qualidade vermelha: envios ativos pausados' };

  // 1) ritmo do número (respostas a clientes têm ritmo próprio, bem mais alto)
  const rate = businessInitiated ? i.ratePerMin : Math.max(i.ratePerMin, 600);
  const allowed = await redis.eval(BUCKET, { keys: [`wa:bucket:${i.numberId}:${businessInitiated ? 'bi' : 'ss'}`],
                                             arguments: [String(rate), String(Date.now()), String(Math.max(rate / 6, 1))] });
  if (allowed !== 1) return { ok: false, retryInMs: 3_000 + Math.random() * 4_000, reason: 'ritmo' };
  if (!businessInitiated) return { ok: true };

  // 2) destinatários únicos em 24h no portfólio — margem de 10% abaixo do limite da Meta
  const pkey = `wa:uniq:${i.portfolioId ?? i.numberId}`;
  const now = Date.now();
  await redis.zRemRangeByScore(pkey, 0, now - 24 * 3600_000);
  const already = await redis.zScore(pkey, i.toWaId);
  if (already === null) {
    const used = await redis.zCard(pkey);
    if (used >= Math.floor((LIMIT_BY_TIER[i.messagingLimit] ?? 250) * 0.9))
      return { ok: false, retryInMs: 3600_000, reason: 'Limite diário do portfólio quase no fim' };
  }

  // 3) frequência por contato (marketing)
  if (i.kind === 'marketing') {
    const fresh = await redis.set(`wa:freq:${i.numberId}:${i.toWaId}`, '1', { NX: true, EX: 24 * 3600 });
    if (fresh !== 'OK') return { ok: false, retryInMs: 24 * 3600_000, reason: 'Contato já recebeu marketing hoje', permanent: true };
  }

  await redis.zAdd(pkey, { score: now, value: i.toWaId });
  await redis.expire(pkey, 25 * 3600);
  return { ok: true };
}
