import { areaPath, linePath, spark, ticks } from './charts';

export function Sparkline({ vals, color, fill = true, width = '100%', height = 40 }:
  { vals: number[]; color: string; fill?: boolean; width?: string | number; height?: number }) {
  const s = spark(vals);
  return (
    <svg viewBox="0 0 100 32" preserveAspectRatio="none" style={{ width, height }} aria-hidden="true">
      {fill && <path d={s.area} fill={color} fillOpacity={0.16} />}
      <path d={s.line} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

export interface Series { name: string; vals: number[]; color: string; area?: boolean }

/** Gráfico de linhas com eixo Y em "mil" e rótulos no eixo X. */
export function LineChart({ series, labels, max, label, height = 240, unit }:
  { series: Series[]; labels: string[]; max: number; label: string; height?: number; unit?: string }) {
  const every = Math.ceil(labels.length / 8);                 // no máximo ~8 rótulos no eixo X
  const shown = labels.filter((_, i) => i % every === 0);
  return (
    <div className="chart">
      <div className="chart-y" style={{ height }}>{ticks(max, unit).map(t => <span key={t}>{t}</span>)}</div>
      <div className="chart-body">
        <svg viewBox={`0 0 800 ${height}`} preserveAspectRatio="none" style={{ height }} role="img" aria-label={label}>
          <path d={`M0,0.5 H800 M0,${height / 4} H800 M0,${height / 2} H800 M0,${(height * 3) / 4} H800 M0,${height - 0.5} H800`}
                stroke="#26314A" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          {series.map(s => s.area && <path key={s.name + 'a'} d={areaPath(s.vals, 800, height, max)} fill={s.color} fillOpacity={0.18} />)}
          {series.map(s => (
            <path key={s.name} d={linePath(s.vals, 800, height, max)} fill="none" stroke={s.color} strokeWidth={3}
                  vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
          ))}
        </svg>
        <div className="chart-x">{shown.map(l => <span key={l}>{l}</span>)}</div>
      </div>
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return <div className="legend">{items.map(i => <span key={i.label}><i style={{ background: i.color }} />{i.label}</span>)}</div>;
}

export function ProgressBar({ pct, color }: { pct: number; color?: string }) {
  return <div className="bar"><div style={{ width: `${pct}%`, background: color }} /></div>;
}
