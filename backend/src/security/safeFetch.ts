import dns from 'node:dns/promises';
import net from 'node:net';

/*
 * Busca de URL informada pelo cliente SEM abrir brecha de SSRF:
 * só http(s), nada de IP interno/privado/loopback/metadados de nuvem, redirecionamentos rechecados,
 * tempo e tamanho limitados.
 */
const isPrivate = (ip: string) => {
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) return isPrivate(v.slice(7));
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
};

async function assertPublic(u: URL) {
  if (!['http:', 'https:'].includes(u.protocol)) throw Object.assign(new Error('Endereço não permitido'), { status: 400 });
  const addrs = net.isIP(u.hostname) ? [u.hostname] : (await dns.lookup(u.hostname, { all: true })).map(a => a.address);
  if (!addrs.length || addrs.some(isPrivate)) throw Object.assign(new Error('Endereço não permitido'), { status: 400 });
}

export async function safeFetchText(url: string, maxBytes = 1_500_000): Promise<string> {
  let u = new URL(url);
  for (let hop = 0; hop < 4; hop++) {
    await assertPublic(u);
    const r = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(8_000),
                               headers: { 'User-Agent': 'AgenciaHubBot/1.0 (+onboarding)' } });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { u = new URL(r.headers.get('location')!, u); continue; }
    if (!r.ok) throw Object.assign(new Error(`O site respondeu ${r.status}`), { status: 400 });
    const reader = r.body!.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length; if (size > maxBytes) { await reader.cancel(); break; }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  throw Object.assign(new Error('Redirecionamentos demais'), { status: 400 });
}

/** HTML -> texto legível (sem scripts/estilos), para a IA ler o site do cliente. */
export const htmlToText = (html: string) => html
  .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, '\n')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim().slice(0, 40_000);
