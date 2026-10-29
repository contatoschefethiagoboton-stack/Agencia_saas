/**
 * Divisão da verba de mídia, sempre em centavos inteiros (nunca float para dinheiro).
 * Ex.: verba R$ 1.000,00, taxa 15%, lucro 60% da taxa:
 *   taxa = 150,00 -> lucro admin 90,00 | fundo de mídia da agência 60,00 | mídia do cliente 850,00
 */
export interface MediaSplit { grossCents: bigint; feeCents: bigint; profitCents: bigint;
                              agencyFundCents: bigint; clientMediaCents: bigint; }

const roundDiv = (n: bigint, d: bigint) => (n * 2n + d) / (2n * d);   // arredondamento half-up

export function splitMediaBudget(grossCents: bigint, feeBps: number, profitShareBps: number): MediaSplit {
  if (grossCents <= 0n) throw new Error('Valor inválido');
  if (feeBps < 0 || feeBps > 5000 || profitShareBps < 0 || profitShareBps > 10000) throw new Error('Taxa fora do limite');
  const feeCents = roundDiv(grossCents * BigInt(feeBps), 10_000n);
  const profitCents = roundDiv(feeCents * BigInt(profitShareBps), 10_000n);
  const agencyFundCents = feeCents - profitCents;            // sobra exata, sem centavo perdido
  const clientMediaCents = grossCents - feeCents;
  return { grossCents, feeCents, profitCents, agencyFundCents, clientMediaCents };
}
