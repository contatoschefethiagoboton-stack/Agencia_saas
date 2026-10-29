import { withTenant } from '../db.js';
import { guardedAiCall } from './budgetGuard.js';
import { imageInfo, toJpeg } from '../art/render.js';

/*
 * FOTOS POR IA — para quem ainda não tem fotos do negócio. A foto entra na biblioteca do cliente
 * e vira fundo das artes (oferta, bastidores, destaque). Conta no teto mensal de IA do plano.
 * Provedor compatível com a API de imagens da OpenAI (IMAGE_API_URL/IMAGE_MODEL configuráveis).
 */
export const imagesReady = () => Boolean(process.env.IMAGE_API_KEY || process.env.OPENAI_API_KEY);
const COST_CENTS = Number(process.env.IMAGE_COST_CENTS ?? 40);   // estimativa por foto (ajuste à tabela vigente)

/** Regras que vão em toda foto: nada de texto na imagem (a arte coloca), marcas de terceiros ou pessoas reais. */
const SAFETY = 'Fotografia realista, luz natural, enquadramento vertical para rede social. Sem nenhum texto, letra, número, ' +
  'logotipo, marca registrada ou marca d\'água. Sem pessoas reconhecíveis ou celebridades. Nada de conteúdo adulto, violento ou enganoso.';

export async function generatePhoto(tenantId: string, prompt: string): Promise<string> {
  const ctx = await withTenant(tenantId, async c => (await c.query(
    `SELECT t.niche, t.city, d.data->>'nome' AS nome FROM tenants t LEFT JOIN business_dossier d ON d.tenant_id = t.id WHERE t.id = $1`,
    [tenantId])).rows[0]);
  const full = `${prompt.trim()}. Contexto: ${ctx?.niche ?? 'pequeno negócio'} local${ctx?.city ? ` em ${ctx.city}` : ''}, Brasil. ${SAFETY}`;

  const jpg = await guardedAiCall(tenantId, COST_CENTS, async () => {
    const r = await fetch(`${process.env.IMAGE_API_URL ?? 'https://api.openai.com/v1'}/images/generations`, {
      method: 'POST', signal: AbortSignal.timeout(120_000),
      headers: { Authorization: `Bearer ${process.env.IMAGE_API_KEY || process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: process.env.IMAGE_MODEL ?? 'gpt-image-1', prompt: full, size: '1024x1536', n: 1,
                             quality: process.env.IMAGE_QUALITY ?? 'medium' }),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(r.status === 400 && /safety|policy/i.test(j?.error?.message ?? '')
      ? 'O pedido foi recusado pelo filtro de segurança. Descreva a foto de outro jeito.'
      : `Gerador de imagens: ${j?.error?.message ?? r.status}`), { status: 502 });
    const b64 = j.data?.[0]?.b64_json;
    if (!b64) throw Object.assign(new Error('O gerador de imagens não devolveu a foto'), { status: 502 });
    const bytes = Buffer.from(b64, 'base64');
    const info = imageInfo(bytes);
    if (!info) throw Object.assign(new Error('Formato de imagem inesperado'), { status: 502 });
    return { result: { bytes: toJpeg({ mime: info.mime, bytes }, info.width, info.height), width: info.width, height: info.height },
             costCents: COST_CENTS };
  }, 'images');

  return withTenant(tenantId, async c => {
    if ((await c.query(`SELECT count(*)::int AS n FROM media WHERE kind = 'photo'`)).rows[0].n >= 80)
      throw Object.assign(new Error('Limite de 80 fotos. Apague algumas antes de criar mais.'), { status: 409 });
    return (await c.query(`INSERT INTO media (tenant_id, kind, mime, bytes, width, height, source, prompt)
                           VALUES ($1, 'photo', 'image/jpeg', $2, $3, $4, 'ai', $5) RETURNING id`,
                          [tenantId, jpg.bytes, jpg.width, jpg.height, prompt.slice(0, 500)])).rows[0].id as string;
  });
}
