import type { PoolClient } from 'pg';
import { withTenant } from '../db.js';
import { publicUrl } from '../config.js';
import { pickTemplate, renderArt, TEMPLATES, type ArtInput, type Img, type Template } from './render.js';

/** Paleta padrão por nicho, usada até o cliente escolher as cores da marca. */
const NICHE_COLORS: [RegExp, string, string][] = [
  [/padaria|confeitaria|caf[eé]/, '#7A3E12', '#F2B33D'], [/restaurante|lanchonete|pizzaria|hamburg/, '#B3261E', '#FFC857'],
  [/cl[ií]nica|sa[uú]de|odonto|dent/, '#0B6E8A', '#7FD1C7'], [/barbearia/, '#1E1E24', '#C9A227'],
  [/est[eé]tica|beleza|unha|sal[aã]o/, '#8E3B6A', '#F4B6C2'], [/pet/, '#2F6B3F', '#F4A259'],
  [/academia|fitness|personal/, '#111827', '#22C55E'], [/influenc|criador/, '#5B21B6', '#F472B6'],
];
const AUTO_CHANNELS = ['instagram', 'facebook'], AUTO_KINDS = ['post', 'carousel', 'story'];

/** Tira emoji e símbolos que a fonte não tem (viram quadradinhos na arte) e hashtags. */
const clean = (s: string) => s.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu, '').replace(/#[\p{L}\p{N}_]+/gu, '')
  .replace(/\s+/g, ' ').trim();
const firstSentence = (s: string, max = 70) => {
  const c = clean(s.split('\n')[0]); const m = c.match(/^(.{12,}?[.!?])\s/);
  const out = (m ? m[1] : c).replace(/[.]$/, '');
  return out.length > max ? out.slice(0, max).replace(/\s+\S*$/, '') + '…' : out;
};

export async function brandOf(c: PoolClient, tenantId: string) {
  const r = (await c.query(`SELECT t.name, t.niche, d.data FROM tenants t LEFT JOIN business_dossier d ON d.tenant_id = t.id
                            WHERE t.id = $1`, [tenantId])).rows[0];
  const marca = r?.data?.marca ?? {};
  const niche = String(r?.niche ?? r?.data?.nicho ?? '').toLowerCase();
  const [, p, s] = NICHE_COLORS.find(([re]) => re.test(niche)) ?? [null, '#1F4FD8', '#FFB020'];
  let logo: Img | null = null;
  if (marca.logoId) {
    const l = (await c.query(`SELECT mime, bytes FROM media WHERE id = $1 AND kind = 'logo'`, [marca.logoId])).rows[0];
    if (l) logo = { mime: l.mime, bytes: l.bytes };
  }
  return { name: r?.data?.nome ?? r?.name ?? '', primary: marca.primaria ?? p, secondary: marca.secundaria ?? s, logo };
}

async function photoFor(c: PoolClient, photoId: string | undefined | null, seed: string): Promise<{ id: string; img: Img } | null> {
  const row = photoId
    ? (await c.query(`SELECT id, mime, bytes FROM media WHERE id = $1 AND kind = 'photo'`, [photoId])).rows[0]
    : (await c.query(`SELECT id, mime, bytes FROM media WHERE kind = 'photo' ORDER BY md5(id::text || $1) LIMIT 1`, [seed])).rows[0];
  return row ? { id: row.id, img: { mime: row.mime, bytes: row.bytes } } : null;
}

/** Gera (ou refaz) a arte de um conteúdo e grava os JPGs; o post passa a apontar para os links públicos. */
export async function generateArt(c: PoolClient, tenantId: string, itemId: string,
                                  opts: { template?: Template; photoId?: string | null } = {}) {
  const it = (await c.query(`SELECT id, channel, kind, payload, status FROM content_items WHERE id = $1`, [itemId])).rows[0];
  if (!it) throw Object.assign(new Error('Conteúdo não encontrado'), { status: 404 });
  if (['publishing', 'published', 'rejected'].includes(it.status))
    throw Object.assign(new Error('Este conteúdo não pode mais ser alterado'), { status: 409 });
  const p = it.payload;
  const brand = await brandOf(c, tenantId);
  const template: Template = opts.template ?? p.art?.template ?? pickTemplate(p.template, it.kind);
  // fotos: modelos com foto usam a biblioteca do cliente; "sem foto" = photoId null explícito
  const wantsPhoto = ['oferta', 'bastidores', 'destaque'].includes(template) && opts.photoId !== null;
  const photo = wantsPhoto ? await photoFor(c, opts.photoId ?? p.art?.photoId, it.id) : null;

  const headline = clean(p.headline ?? '') || firstSentence(p.caption ?? '');
  const base: Omit<ArtInput, 'headline'> = {
    template, format: it.kind === 'story' ? 'story' : 'feed', brand, photo: photo?.img ?? null,
    subline: clean(p.subline ?? '') || undefined, cta: clean(p.cta ?? '') || undefined,
  };
  const slides = it.kind === 'carousel'
    ? [headline, ...((p.slides ?? []) as string[]).map(clean).filter(Boolean)].slice(0, 10)
    : [headline];
  const rendered = slides.map((text, i) => renderArt({ ...base, headline: text,
    slide: it.kind === 'carousel' ? { index: i + 1, total: slides.length } : undefined }));

  await c.query(`DELETE FROM media WHERE content_item_id = $1 AND kind = 'art'`, [itemId]);
  const ids: string[] = [];
  for (const r of rendered) {
    ids.push((await c.query(`INSERT INTO media (tenant_id, kind, mime, bytes, width, height, content_item_id)
                             VALUES ($1, 'art', 'image/jpeg', $2, $3, $4, $5) RETURNING id`,
                            [tenantId, r.jpg, r.width, r.height, itemId])).rows[0].id);
  }
  const images = ids.map(id => `${publicUrl()}/media/${id}.jpg`);
  await c.query(`UPDATE content_items SET payload = (payload - 'image_url') || jsonb_build_object('images', $2::jsonb, 'art', $3::jsonb)
                 WHERE id = $1`, [itemId, JSON.stringify(images), JSON.stringify({ template, photoId: photo?.id ?? null, generated: true })]);
  return { images, template };
}

/** Lote: gera as artes de todos os conteúdos do mês que vão para Instagram/Facebook e ainda não têm imagem. */
export async function generateArtsForMonth(tenantId: string, month: string) {
  return withTenant(tenantId, async c => {
    const items = (await c.query(
      `SELECT id FROM content_items WHERE to_char(scheduled_for AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM') = $1
         AND channel = ANY($2) AND kind = ANY($3) AND status IN ('pending_approval', 'changes_requested', 'approved', 'failed')
         AND coalesce(jsonb_array_length(payload->'images'), 0) = 0 AND payload->>'image_url' IS NULL
       ORDER BY scheduled_for`, [month, AUTO_CHANNELS, AUTO_KINDS])).rows;
    for (const it of items) await generateArt(c, tenantId, it.id);
    return items.length;
  });
}

/** Exemplo de arte com a identidade atual (tela "Identidade visual"). */
export async function previewArt(tenantId: string, template: Template) {
  return withTenant(tenantId, async c => {
    const brand = await brandOf(c, tenantId);
    const photo = ['oferta', 'bastidores'].includes(template) ? await photoFor(c, undefined, 'preview') : null;
    const sample: Record<Template, Partial<ArtInput>> = {
      destaque: { headline: `Bem-vindo à ${brand.name || 'nossa casa'}`, subline: 'Assim ficam os seus posts', cta: 'Fale no WhatsApp' },
      oferta: { headline: 'Combo da semana', subline: 'Texto do seu post aparece aqui', cta: 'Peça agora' },
      bastidores: { headline: 'Os bastidores do seu dia a dia' },
      dica: { headline: 'Uma dica útil para o seu cliente', subline: 'Conteúdo que ensina gera salvamentos e compartilhamentos.' },
      depoimento: { headline: 'Atendimento excelente, recomendo de olhos fechados!', subline: 'Cliente satisfeito' },
      carrossel: { headline: '5 motivos para escolher a gente', slide: { index: 1, total: 5 } },
    };
    return renderArt({ template, format: 'feed', brand, photo: photo?.img ?? null, headline: '', ...sample[template] } as ArtInput).jpg;
  });
}

export { TEMPLATES };
