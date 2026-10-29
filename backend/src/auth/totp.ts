import crypto from 'node:crypto';

/** TOTP (RFC 6238) compatível com Google Authenticator, Authy, 1Password etc. Sem dependências. */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function newTotpSecret(): string {
  const bytes = crypto.randomBytes(20);
  let bits = '', out = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function base32Decode(s: string): Buffer {
  let bits = '';
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error('Segredo TOTP inválido');
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function totpAt(secret: string, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return (n % 1_000_000).toString().padStart(6, '0');
}

/** Passo de tempo em que o código bate (atual ou um vizinho: relógio do celular até 30s fora), ou null. */
export function totpStep(secret: string, code: string, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const step = Math.floor(now / 30_000);
  for (const d of [-1, 0, 1]) if (crypto.timingSafeEqual(Buffer.from(totpAt(secret, step + d)), Buffer.from(code))) return step + d;
  return null;
}

export const verifyTotp = (secret: string, code: string, now = Date.now()) => totpStep(secret, code, now) !== null;

export const otpauthUrl = (secret: string, email: string, issuer = process.env.APP_NAME ?? 'Agencia Hub') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?` +
  new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
