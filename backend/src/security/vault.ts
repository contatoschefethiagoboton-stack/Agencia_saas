import crypto from 'node:crypto';

/*
 * AES-256-GCM para tokens OAuth/WABA e segredos do 2FA guardados no banco. A chave fica fora do banco.
 * TOKEN_ENC_KEY aceita: base64 de 32 bytes (openssl rand -base64 32) OU qualquer segredo aleatório
 * com 16+ caracteres (botão "Generate" do Render), que vira 32 bytes por SHA-256.
 * Sem TOKEN_ENC_KEY, usa uma chave derivada do JWT_SECRET e avisa no log: funciona, mas trocar o
 * JWT_SECRET depois deixaria ilegíveis os segredos já guardados — por isso o ideal é definir TOKEN_ENC_KEY.
 * NUNCA troque a TOKEN_ENC_KEY depois de em uso: conexões e 2FA salvos deixam de abrir.
 */
let cached: Buffer | null = null;
export function encryptionKeyStatus(): { ok: boolean; source: 'token_enc_key' | 'jwt_secret' | 'none'; detail?: string } {
  const raw = process.env.TOKEN_ENC_KEY?.trim();
  if (raw) return raw.length >= 16 ? { ok: true, source: 'token_enc_key' }
    : { ok: false, source: 'none', detail: 'TOKEN_ENC_KEY curta demais (mínimo 16 caracteres)' };
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 16) return { ok: true, source: 'jwt_secret' };
  return { ok: false, source: 'none', detail: 'defina TOKEN_ENC_KEY (ou ao menos JWT_SECRET) com 16+ caracteres' };
}

const key = () => {
  if (cached) return cached;
  const st = encryptionKeyStatus();
  if (!st.ok) throw Object.assign(new Error(`Chave de criptografia ausente: ${st.detail}`), { status: 503 });
  const raw = st.source === 'token_enc_key' ? process.env.TOKEN_ENC_KEY!.trim() : `token-enc:${process.env.JWT_SECRET}`;
  const b64 = /^[A-Za-z0-9+/]{43}=$/.test(raw) ? Buffer.from(raw, 'base64') : null;    // formato openssl rand -base64 32
  cached = b64?.length === 32 ? b64 : crypto.createHash('sha256').update(raw).digest();
  return cached;
};

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
