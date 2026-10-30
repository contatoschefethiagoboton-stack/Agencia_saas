import { test } from 'node:test';
import assert from 'node:assert/strict';

// cada caso importa o módulo de novo (a chave fica em cache no módulo)
const load = async (env: Record<string, string | undefined>) => {
  for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  return import(`../src/security/vault.js?${Math.random()}`);
};

test('base64 de 32 bytes (openssl) continua valendo exatamente como antes', async () => {
  const k = Buffer.alloc(32, 7).toString('base64');
  const v = await load({ TOKEN_ENC_KEY: k, JWT_SECRET: 'x'.repeat(20) });
  assert.equal(v.decryptToken(v.encryptToken('segredo')), 'segredo');
  const crypto = await import('node:crypto');
  const blob = v.encryptToken('abc');
  const d = crypto.createDecipheriv('aes-256-gcm', Buffer.alloc(32, 7), blob.subarray(0, 12));
  d.setAuthTag(blob.subarray(12, 28));
  assert.equal(Buffer.concat([d.update(blob.subarray(28)), d.final()]).toString(), 'abc');
});

test('qualquer segredo aleatório (ex.: "Generate" do Render) funciona', async () => {
  const v = await load({ TOKEN_ENC_KEY: 'k3J9xQ2mZpLr8VtN5wYb', JWT_SECRET: 'x'.repeat(20) });
  assert.equal(v.decryptToken(v.encryptToken('2fa-secret')), '2fa-secret');
});

test('sem TOKEN_ENC_KEY usa o JWT_SECRET; sem nenhum dos dois, erro claro', async () => {
  let v = await load({ TOKEN_ENC_KEY: undefined, JWT_SECRET: 'segredo-jwt-bem-grande' });
  assert.equal(v.encryptionKeyStatus().source, 'jwt_secret');
  assert.equal(v.decryptToken(v.encryptToken('ok')), 'ok');
  v = await load({ TOKEN_ENC_KEY: undefined, JWT_SECRET: undefined });
  assert.throws(() => v.encryptToken('x'), /Chave de criptografia ausente/);
  v = await load({ TOKEN_ENC_KEY: 'curta', JWT_SECRET: 'segredo-jwt-bem-grande' });
  assert.equal(v.encryptionKeyStatus().ok, false);
});
