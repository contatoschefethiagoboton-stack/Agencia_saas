import { withTenant } from '../db.js';
import { decryptToken } from '../security/vault.js';
import { MetaCloudProvider } from './providers/metaCloud.js';
import { TwilioProvider } from './providers/twilio.js';
import type { WhatsAppProvider } from './providers/types.js';

/** Instância lógica por número: cada negócio fala só pelo próprio número, com o próprio token. */
const cache = new Map<string, { p: WhatsAppProvider; at: number }>();

export async function providerFor(tenantId: string, numberId: string): Promise<WhatsAppProvider> {
  const hit = cache.get(numberId);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.p;

  const p = await withTenant(tenantId, async c => {
    const n = (await c.query(`SELECT provider, phone_e164, phone_number_id, waba_id FROM wa_numbers
                              WHERE id = $1 AND status IN ('active','throttled')`, [numberId])).rows[0];
    if (!n) throw Object.assign(new Error('Número indisponível'), { status: 409 });
    if (n.provider === 'twilio') return new TwilioProvider(n.phone_e164);
    const conn = (await c.query(`SELECT token_cipher FROM channel_connections
                                 WHERE provider = 'whatsapp' AND external_id = $1`, [n.waba_id])).rows[0];
    if (!conn) throw Object.assign(new Error('WhatsApp do cliente não conectado'), { status: 409 });
    return new MetaCloudProvider(n.phone_number_id, decryptToken(conn.token_cipher));
  });
  cache.set(numberId, { p, at: Date.now() });
  return p;
}

export const forgetProvider = (numberId: string) => cache.delete(numberId);
