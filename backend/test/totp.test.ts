import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newTotpSecret, totpAt, totpStep, verifyTotp } from '../src/auth/totp.js';

// Vetor da RFC 6238 (SHA1, segredo "12345678901234567890"): T=59s -> 94287082 (6 dígitos: 287082)
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

test('TOTP bate com o vetor oficial da RFC 6238', () => {
  assert.equal(totpAt(RFC_SECRET, 1), '287082');
  assert.equal(totpAt(RFC_SECRET, Math.floor(1111111109 / 30)), '081804');
});

test('aceita o passo vizinho (relógio do celular fora por até 30s) e recusa o resto', () => {
  const s = newTotpSecret();
  const now = 1_700_000_000_000;
  const step = Math.floor(now / 30_000);
  assert.ok(verifyTotp(s, totpAt(s, step), now));
  assert.ok(verifyTotp(s, totpAt(s, step - 1), now));
  assert.ok(!verifyTotp(s, totpAt(s, step - 3), now));
  assert.ok(!verifyTotp(s, 'abc123', now));
});

test('totpStep devolve o passo exato (base do anti-reuso)', () => {
  const s = newTotpSecret(), now = 1_700_000_000_000, step = Math.floor(now / 30_000);
  assert.equal(totpStep(s, totpAt(s, step), now), step);
  assert.equal(totpStep(s, totpAt(s, step - 1), now), step - 1);
  assert.equal(totpStep(s, '123'), null);
});
