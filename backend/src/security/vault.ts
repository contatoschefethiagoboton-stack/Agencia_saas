import crypto from 'node:crypto';

/** AES-256-GCM para tokens OAuth/WABA guardados no banco. Chave fica fora do banco (.env/KMS). */
const key = () => Buffer.from(process.env.TOKEN_ENC_KEY!, 'base64');

export function encryptToken(plain: string): Buffer {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]);           // [12 iv][16 tag][dados]
}

export function decryptToken(blob: Buffer): string {
  const d = crypto.createDecipheriv('aes-256-gcm', key(), blob.subarray(0, 12));
  d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]).toString('utf8');
}
