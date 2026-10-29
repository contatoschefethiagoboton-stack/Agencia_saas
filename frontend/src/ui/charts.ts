/** Geradores de caminhos SVG — sem biblioteca de gráficos, leves e fáceis de estilizar. */
export function linePath(vals: number[], w: number, h: number, max: number, min = 0) {
  const step = w / Math.max(vals.length - 1, 1);
  return vals.map((v, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)},${(h - ((v - min) / (max - min)) * h).toFixed(1)}`).join(' ');
}
export const areaPath = (vals: number[], w: number, h: number, max: number, min = 0) =>
  `${linePath(vals, w, h, max, min)} L${w},${h} L0,${h} Z`;

export function spark(vals: number[]) {
  const mx = Math.max(...vals), mn = Math.min(...vals), pad = (mx - mn) * 0.15 || 1;
  return { line: linePath(vals, 100, 32, mx + pad, mn - pad), area: areaPath(vals, 100, 32, mx + pad, mn - pad) };
}

/** Barras empilhadas: `base` embaixo, `top` em cima. */
export function stackedBars(base: number[], top: number[], max: number, W = 800, H = 220) {
  const slot = W / base.length, w = Math.min(slot * 0.56, 90);
  let lower = '', upper = '';
  base.forEach((b, i) => {
    const x = (i * slot + (slot - w) / 2).toFixed(1), hb = (b / max) * H, ht = (top[i] / max) * H;
    lower += `M${x},${(H - hb).toFixed(1)} h${w.toFixed(1)} V${H} h${(-w).toFixed(1)} Z `;
    upper += `M${x},${(H - hb - ht - 2).toFixed(1)} h${w.toFixed(1)} v${ht.toFixed(1)} h${(-w).toFixed(1)} Z `;
  });
  return { lower, upper };
}

/** Fatias de rosca (stroke-dasharray) para um círculo de raio r. */
export function donut(parts: number[], r: number) {
  const C = 2 * Math.PI * r;
  let acc = 0;
  return parts.map(p => { const s = { dash: `${(p * C - 2).toFixed(1)} ${C.toFixed(1)}`, offset: (-acc * C).toFixed(1) }; acc += p; return s; });
}

export const ticks = (max: number, unit = ' mil') =>
  [1, 0.75, 0.5, 0.25, 0].map(f => (f === 0 ? '0' : `${(max * f).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}${unit}`));
