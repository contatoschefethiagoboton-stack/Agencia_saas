import { useEffect, useState } from 'react';
import { api } from '../api';

export function SignalBadge({ signal, big }: { signal: string | null | undefined; big?: boolean }) {
  if (!signal) return <span className="badge">—</span>;
  const cls = signal === 'COMPRA' ? 'buy' : signal === 'VENDA' ? 'sell' : 'hold';
  return <span className={`signal ${cls}${big ? ' big' : ''}`}>{signal}</span>;
}

/** Placar de −100 a +100 em barra com ponteiro. */
export function ScoreGauge({ score }: { score: number }) {
  const pos = (score + 100) / 2;
  return (
    <div className="gauge" role="meter" aria-valuemin={-100} aria-valuemax={100} aria-valuenow={score} aria-label="Placar técnico">
      <div className="gauge-track"><span className="gauge-needle" style={{ left: `${pos}%` }} /></div>
      <div className="gauge-labels"><span>Venda forte</span><b className={score > 0 ? 'up' : score < 0 ? 'down' : ''}>{score > 0 ? '+' : ''}{score}</b><span>Compra forte</span></div>
    </div>
  );
}

let cache: { id: string; name: string; description: string }[] | null = null;
export function useStrategies() {
  const [s, setS] = useState(cache ?? []);
  useEffect(() => { if (!cache) api<typeof s>('/market/strategies').then(r => { cache = r; setS(r); }).catch(() => {}); }, []);
  return s;
}

export function Spinner({ label = 'Carregando…' }: { label?: string }) {
  return <div className="wait"><span className="spinner" /><span className="card-sub">{label}</span></div>;
}

export function Disclaimer() {
  return (
    <p className="disclaimer">
      Sinais, placares e previsões são cálculos técnicos sobre o histórico de preços. Não são recomendação de investimento nem garantia de lucro.
      Investimentos em renda variável e criptomoedas podem gerar perdas, inclusive de todo o valor aplicado. Decida com base no seu perfil.
    </p>
  );
}
