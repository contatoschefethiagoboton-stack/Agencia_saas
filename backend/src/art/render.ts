import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import jpeg from 'jpeg-js';

/*
 * ARTES EM LOTE — modelos desenhados em SVG, preenchidos com o texto do post e a identidade
 * do negócio (cores, logo, fotos), renderizados no servidor em JPG (o Instagram só aceita JPG).
 * Sem API paga: funciona com zero configuração. Fonte Inter (SIL OFL) embutida em assets/fonts.
 */
export type Template = 'destaque' | 'oferta' | 'bastidores' | 'dica' | 'depoimento' | 'carrossel';
export const TEMPLATES: Template[] = ['destaque', 'oferta', 'bastidores', 'dica', 'depoimento', 'carrossel'];

export interface Img { mime: string; bytes: Buffer }
export interface ArtInput {
  template: Template; format: 'feed' | 'story';
  brand: { name: string; primary: string; secondary: string; logo?: Img | null };
  headline: string; subline?: string; cta?: string; tag?: string;
  photo?: Img | null; slide?: { index: number; total: number };
}

const FONT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../assets/fonts');
const FONTS = ['Inter-Regular.ttf', 'Inter-Medium.ttf', 'Inter-Bold.ttf', 'Inter-ExtraBold.ttf'].map(f => path.join(FONT_DIR, f));

/** Nome livre que a IA sugere ("oferta-do-dia", "bastidores"...) -> modelo existente. */
export function pickTemplate(hint: string | undefined, kind: string): Template {
  const h = (hint ?? '').toLowerCase();
  if (kind === 'carousel') return 'carrossel';
  if (/oferta|promo|pre[cç]o|desconto|combo|lan[cç]amento/.test(h)) return 'oferta';
  if (/bastidor|making|processo|equipe|cozinha/.test(h)) return 'bastidores';
  if (/dica|como|passo|tutorial|sabia|curiosidade/.test(h)) return 'dica';
  if (/depoimento|cliente|avalia|review|feedback/.test(h)) return 'depoimento';
  return 'destaque';
}

// ---------- cores ----------
const hex = (c: string) => /^#[0-9a-f]{6}$/i.test(c) ? c : '#1F6FEB';
const rgb = (c: string) => [1, 3, 5].map(i => parseInt(hex(c).slice(i, i + 2), 16));
const lum = (c: string) => { const [r, g, b] = rgb(c).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const onColor = (bg: string) => lum(bg) > 0.4 ? '#14171F' : '#FFFFFF';
const mix = (a: string, b: string, t: number) => '#' + rgb(a).map((v, i) => Math.round(v + (rgb(b)[i] - v) * t).toString(16).padStart(2, '0')).join('');

// ---------- texto ----------
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Quebra em linhas que cabem na largura (estimativa por largura média do Inter) e diminui a fonte se precisar. */
function fit(text: string, maxW: number, size: number, maxLines: number, minSize = 34, wf = 0.58) {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  for (let s = size; s >= minSize; s -= 4) {
    const per = Math.max(4, Math.floor(maxW / (s * wf)));
    const lines: string[] = [];
    let cur = '';
    for (const w of words) {
      if ((cur + ' ' + w).trim().length <= per) cur = (cur + ' ' + w).trim();
      else { if (cur) lines.push(cur); cur = w.length > per ? w.slice(0, per - 1) + '…' : w; }
    }
    if (cur) lines.push(cur);
    if (lines.length <= maxLines) return { lines, size: s };
  }
  const per = Math.floor(maxW / (minSize * wf));
  const lines: string[] = []; let cur = '';
  for (const w of words) { if ((cur + ' ' + w).trim().length <= per) cur = (cur + ' ' + w).trim(); else { lines.push(cur); cur = w; } }
  lines.push(cur);
  const cut = lines.slice(0, maxLines); cut[maxLines - 1] = cut[maxLines - 1].replace(/.{0,2}$/, '…');
  return { lines: cut, size: minSize };
}
const tspans = (lines: string[], x: number, size: number, lh = 1.12) =>
  lines.map((l, i) => `<tspan x="${x}" dy="${i ? size * lh : 0}">${esc(l)}</tspan>`).join('');
const dataUri = (i: Img) => `data:${i.mime};base64,${i.bytes.toString('base64')}`;

// ---------- modelos ----------
function svgFor(a: ArtInput) {
  const W = 1080, H = a.format === 'story' ? 1920 : 1350, M = 88;
  const P = hex(a.brand.primary), S = hex(a.brand.secondary);
  const onP = onColor(P), dark = '#14171F';
  const top = a.format === 'story' ? 220 : 0;                                   // área segura do story
  const logo = a.brand.logo
    ? `<image href="${dataUri(a.brand.logo)}" x="${M}" y="${H - M - 96 - top / 2}" width="96" height="96" preserveAspectRatio="xMidYMid meet"/>`
    : `<text x="${M}" y="${H - M - top / 2}" font-size="34" font-weight="700" fill="CLR">${esc(a.brand.name.slice(0, 40))}</text>`;
  const photo = (x: number, y: number, w: number, h: number) => a.photo
    ? `<image href="${dataUri(a.photo)}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice"/>`
    : `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#g)"/><circle cx="${x + w - 40}" cy="${y + 140}" r="${Math.min(w, h) * 0.32}" fill="${S}" fill-opacity="0.22"/>`;
  const defs = `<defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${P}"/><stop offset="1" stop-color="${mix(P, S, 0.55)}"/></linearGradient>
    <linearGradient id="shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0.35" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.82"/></linearGradient>
    </defs>`;
  const cta = (y: number, bg: string, fg: string) => a.cta
    ? (() => { const t = a.cta!.slice(0, 32); const w = Math.min(W - 2 * M, 80 + t.length * 24);
        return `<rect x="${M}" y="${y}" width="${w}" height="88" rx="44" fill="${bg}"/><text x="${M + w / 2}" y="${y + 58}" font-size="38" font-weight="700" fill="${fg}" text-anchor="middle">${esc(t)}</text>`; })()
    : '';
  let body = '';

  switch (a.template) {
    case 'oferta': {
      const ph = Math.round(H * (a.format === 'story' ? 0.42 : 0.40));
      const limit = H - M - 150 - top / 2;                  // acima da marca
      // empilha título, subtítulo e botão; diminui a fonte até tudo caber acima da marca
      let size = 100, t = fit(a.headline, W - 2 * M, size, 3), sub = a.subline ? fit(a.subline, W - 2 * M, 44, 2, 30, 0.52) : null;
      const height = () => 150 + t.size * 1.12 * t.lines.length + (sub ? 30 + sub.size * 1.25 * sub.lines.length : 0) + (a.cta ? 140 : 0);
      while (ph + height() > limit && size > 56) { size -= 8; t = fit(a.headline, W - 2 * M, size, 3, 48); if (sub) sub = fit(a.subline!, W - 2 * M, Math.min(44, size * 0.5), 2, 28, 0.52); }
      const yT = ph + 110 + t.size * 0.85;
      const yS = yT + t.size * 1.12 * (t.lines.length - 1) + 30 + (sub?.size ?? 0) * 1.1;
      const yC = (sub ? yS + sub.size * 1.25 * (sub.lines.length - 1) : yT + t.size * 1.12 * (t.lines.length - 1)) + 60;
      body = `<rect width="${W}" height="${H}" fill="${P}"/>${photo(0, 0, W, ph)}
        <rect x="${M}" y="${ph - 46}" width="300" height="92" rx="18" fill="${S}"/>
        <text x="${M + 150}" y="${ph + 16}" font-size="44" font-weight="800" fill="${onColor(S)}" text-anchor="middle">${esc((a.tag ?? 'OFERTA').toUpperCase().slice(0, 12))}</text>
        <text y="${yT}" font-size="${t.size}" font-weight="800" fill="${onP}">${tspans(t.lines, M, t.size)}</text>
        ${sub ? `<text y="${yS}" font-size="${sub.size}" font-weight="500" fill="${onP}" fill-opacity="0.9">${tspans(sub.lines, M, sub.size, 1.25)}</text>` : ''}
        ${cta(yC, S, onColor(S))}${logo.replace('CLR', onP)}`;
      break;
    }
    case 'bastidores': {
      const t = fit(a.headline, W - 2 * M, 96, 4);
      const y0 = H - M - 150 - top / 2 - t.size * 1.12 * (t.lines.length - 1);
      body = `${photo(0, 0, W, H)}<rect width="${W}" height="${H}" fill="url(#shade)"/>
        <rect x="${M}" y="${M + top}" width="330" height="70" rx="35" fill="${P}"/>
        <text x="${M + 165}" y="${M + top + 48}" font-size="34" font-weight="800" fill="${onP}" text-anchor="middle" letter-spacing="3">${esc((a.tag ?? 'BASTIDORES').toUpperCase().slice(0, 14))}</text>
        <text y="${y0}" font-size="${t.size}" font-weight="800" fill="#FFFFFF">${tspans(t.lines, M, t.size)}</text>
        ${logo.replace('CLR', '#FFFFFF')}`;
      break;
    }
    case 'dica': {
      const bg = mix(S, '#FFFFFF', 0.86);
      const t = fit(a.headline, W - 2 * M, 92, 5);
      const sub = a.subline ? fit(a.subline, W - 2 * M, 44, 4, 32, 0.52) : null;
      body = `<rect width="${W}" height="${H}" fill="${bg}"/><rect width="${W}" height="24" fill="${P}"/>
        <text x="${M}" y="${M + top + 150}" font-size="150" font-weight="800" fill="${P}">${esc((a.tag ?? 'DICA').toUpperCase().slice(0, 8))}</text>
        <rect x="${M}" y="${M + top + 200}" width="140" height="14" rx="7" fill="${S}"/>
        <text y="${M + top + 320}" font-size="${t.size}" font-weight="800" fill="${dark}">${tspans(t.lines, M, t.size)}</text>
        ${sub ? `<text y="${M + top + 360 + t.size * 1.12 * t.lines.length}" font-size="${sub.size}" font-weight="500" fill="#3A4150">${tspans(sub.lines, M, sub.size, 1.3)}</text>` : ''}
        ${logo.replace('CLR', P)}`;
      break;
    }
    case 'depoimento': {
      const t = fit(`“${a.headline.replace(/^["“]|["”]$/g, '')}”`, W - 2 * M, 72, 7, 34, 0.55);
      const y0 = H / 2 - (t.size * 1.25 * t.lines.length) / 2 + t.size;
      body = `<rect width="${W}" height="${H}" fill="url(#g)"/>
        <text x="${M}" y="${M + top + 200}" font-size="300" font-weight="800" fill="${onP}" fill-opacity="0.18">“</text>
        <text y="${y0}" font-size="${t.size}" font-weight="700" fill="${onP}">${tspans(t.lines, M, t.size, 1.25)}</text>
        ${a.subline ? `<text x="${M}" y="${y0 + t.size * 1.25 * t.lines.length + 40}" font-size="40" font-weight="500" fill="${onP}" fill-opacity="0.85">— ${esc(a.subline.slice(0, 50))}</text>` : ''}
        ${logo.replace('CLR', onP)}`;
      break;
    }
    case 'carrossel': {
      const s = a.slide ?? { index: 1, total: 1 };
      const cover = s.index === 1;
      const t = fit(a.headline, W - 2 * M, cover ? 104 : 80, cover ? 4 : 7);
      const bg = cover ? 'url(#g)' : mix(S, '#FFFFFF', 0.88);
      const fg = cover ? onP : dark;
      const y0 = cover ? H / 2 - (t.size * 1.12 * (t.lines.length - 1)) / 2 : M + top + 260;
      body = `<rect width="${W}" height="${H}" fill="${bg}"/>
        ${!cover ? `<text x="${M}" y="${M + top + 140}" font-size="120" font-weight="800" fill="${P}">${String(s.index - 1).padStart(2, '0')}</text>` : ''}
        <text y="${y0}" font-size="${t.size}" font-weight="800" fill="${fg}">${tspans(t.lines, M, t.size)}</text>
        <text x="${W - M}" y="${H - M - top / 2}" font-size="34" font-weight="700" fill="${fg}" fill-opacity="0.7" text-anchor="end">${s.index}/${s.total}${s.index < s.total ? '  arraste →' : ''}</text>
        ${logo.replace('CLR', cover ? onP : P)}`;
      break;
    }
    default: {   // destaque
      const t = fit(a.headline, W - 2 * M, 110, 4);
      const sub = a.subline ? fit(a.subline, W - 2 * M, 46, 3, 32, 0.52) : null;
      const blockH = t.size * 1.12 * t.lines.length + (sub ? sub.size * 1.3 * sub.lines.length + 40 : 0);
      const y0 = a.photo ? H * 0.58 : H / 2 - blockH / 2 + t.size;
      body = a.photo
        ? `${photo(0, 0, W, H)}<rect width="${W}" height="${H}" fill="url(#shade)"/>`
        : `<rect width="${W}" height="${H}" fill="url(#g)"/><circle cx="${W - 60}" cy="${top + 120}" r="260" fill="${S}" fill-opacity="0.25"/>`;
      const fg = a.photo ? '#FFFFFF' : onP;
      body += `<text y="${y0}" font-size="${t.size}" font-weight="800" fill="${fg}">${tspans(t.lines, M, t.size)}</text>
        ${sub ? `<text y="${y0 + t.size * 1.12 * (t.lines.length - 1) + 50 + sub.size * 1.1}" font-size="${sub.size}" font-weight="500" fill="${fg}" fill-opacity="0.9">${tspans(sub.lines, M, sub.size, 1.3)}</text>` : ''}
        ${cta(H - M - 88 - 130 - top / 2, S, onColor(S))}${logo.replace('CLR', fg)}`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Inter">${defs}${body}</svg>`;
}

/** Renderiza a arte e devolve JPG (qualidade 88) pronto para Instagram/Facebook. */
export function renderArt(a: ArtInput): { jpg: Buffer; width: number; height: number } {
  const r = new Resvg(svgFor(a), { font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Inter' } }).render();
  const jpg = jpeg.encode({ data: r.pixels, width: r.width, height: r.height }, 88).data;
  return { jpg: Buffer.from(jpg), width: r.width, height: r.height };
}

/** Lê largura/altura de JPG ou PNG enviados pelo cliente (valida o formato pelo conteúdo, não pelo nome). */
export function imageInfo(b: Buffer): { mime: 'image/jpeg' | 'image/png'; width: number; height: number } | null {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { mime: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i < b.length - 9;) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1], len = b.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { mime: 'image/jpeg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      i += 2 + len;
    }
  }
  return null;
}
