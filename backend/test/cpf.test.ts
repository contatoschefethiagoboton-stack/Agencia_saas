import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCpf } from '../src/security/cpf.js';

test('CPF: aceita válidos (com ou sem pontuação) e recusa inválidos', () => {
  for (const v of ['529.982.247-25', '52998224725', '153.509.460-56', '111.444.777-35']) assert.ok(isCpf(v), v);
  for (const v of ['529.982.247-24', '111.111.111-11', '000.000.000-00', '123', '5299822472a']) assert.ok(!isCpf(v), v);
});
