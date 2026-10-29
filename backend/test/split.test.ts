import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitMediaBudget } from '../src/finance/split.js';

test('verba de R$ 1.000 com taxa 15% e lucro 60% da taxa', () => {
  const s = splitMediaBudget(100_000n, 1500, 6000);
  assert.equal(s.feeCents, 15_000n);
  assert.equal(s.profitCents, 9_000n);
  assert.equal(s.agencyFundCents, 6_000n);
  assert.equal(s.clientMediaCents, 85_000n);
});

test('nenhum centavo some no arredondamento', () => {
  for (const gross of [1n, 7n, 333n, 99_999n, 123_457n]) {
    const s = splitMediaBudget(gross, 1337, 6123);
    assert.equal(s.clientMediaCents + s.profitCents + s.agencyFundCents, gross);
  }
});

test('recusa valores e taxas fora do limite', () => {
  assert.throws(() => splitMediaBudget(0n, 1500, 6000));
  assert.throws(() => splitMediaBudget(100n, 9000, 6000));
});
