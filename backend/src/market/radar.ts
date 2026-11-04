import { withSystem } from '../db.js';
import { redis } from '../redis.js';
import { notify } from '../notify.js';
import { isPanicking } from '../security/panic.js';
import { analyze, type Analysis } from './strategies.js';
import { getCandles, listAllSymbols, topAssets, type Interval, type Market } from './data.js';

/*
 * RADAR (a cada RADAR_INTERVAL_MS, padrão 5 min)
 *   - Lançamentos: compara a lista de ativos da Binance e da B3 com a última vista; o que for novo vira aviso.
 *     Na primeira execução só memoriza a lista (não avisa centenas de "novidades").
 *   - Scanner: recalcula o placar dos ativos mais negociados e avisa quem tem o ativo na lista quando o sinal muda.
 */
export interface ScanRow extends Analysis { symbol: string; name?: string; logo?: string; error?: string }

const DEFAULT_IV: Record<Market, Interval> = { crypto: '1h', b3: '1d', us: '1d' };

/** Placar dos ativos mais negociados de um mercado (cache 4 min). */
export async function scan(market: Market, interval: Interval = DEFAULT_IV[market], n = 30): Promise<ScanRow[]> {
  const key = `scan:${market}:${interval}:${n}`;
  const hit = await redis.get(key);
  if (hit) return JSON.parse(hit);
  const assets = await topAssets(market, n);
  const rows: ScanRow[] = [];
  for (let i = 0; i < assets.length; i += 5) {
    rows.push(...(await Promise.all(assets.slice(i, i + 5).map(async a => {
      try {
        const an = analyze(await getCandles(market, a.symbol, interval, 400));
        return an ? { ...an, symbol: a.symbol, name: a.name, logo: a.logo, changePct: a.changePct, price: a.price } : null;
      } catch { return null; }
    }))).filter(Boolean) as ScanRow[]);
  }
  rows.sort((x, y) => y.score - x.score);
  await redis.set(key, JSON.stringify(rows), { EX: 240 });
  return rows;
}

export async function runRadar() {
  const every = Number(process.env.RADAR_INTERVAL_MS ?? 300_000);
  for (;;) {
    if (!(await isPanicking()) && (await redis.set('radar:lock', '1', { NX: true, EX: Math.max(1, Math.ceil(every / 1000) - 5) })) === 'OK') {
      for (const m of ['crypto', 'b3'] as Market[]) await listings(m).catch(e => console.error(`[radar ${m}]`, (e as Error).message));
      await watchSignals().catch(e => console.error('[radar sinais]', (e as Error).message));
    }
    await new Promise(r => setTimeout(r, every));
  }
}

async function listings(market: Market) {
  const all = await listAllSymbols(market);
  if (all.length < 5) return;                                  // resposta estranha da API: não arrisca falso "lançamento"
  const fresh = await withSystem(async c => {
    const seeded = (await c.query(`SELECT count(*)::int AS n FROM known_symbols WHERE market = $1`, [market])).rows[0].n > 0;
    const ins = await c.query(`INSERT INTO known_symbols (market, symbol) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING RETURNING symbol`,
                              [market, all]);
    return seeded ? ins.rows.map(r => r.symbol as string) : [];
  });
  for (const s of fresh.slice(0, 20)) {
    await notify(null, 'lancamento', market === 'crypto' ? `Nova moeda listada na Binance: ${s}` : `Novo ativo na B3: ${s}`,
      'Ativos recém-listados costumam ter volatilidade muito alta. Analise o gráfico antes de qualquer decisão.', market, s);
  }
}

/** Avisa quando o sinal de um ativo da lista de acompanhamento muda para COMPRA ou VENDA. */
async function watchSignals() {
  const watched = await withSystem(async c => (await c.query(
    `SELECT market, symbol, array_agg(tenant_id) AS tenants FROM watchlist GROUP BY market, symbol LIMIT 200`)).rows);
  for (const w of watched) {
    const iv = DEFAULT_IV[w.market as Market];
    try {
      const an = analyze(await getCandles(w.market, w.symbol, iv, 400));
      if (!an) continue;
      const key = `sig:${w.market}:${w.symbol}:${iv}`;
      const prev = await redis.get(key);
      await redis.set(key, an.signal, { EX: 7 * 86400 });
      if (prev && prev !== an.signal && an.signal !== 'AGUARDAR') {
        const hr = an.history.hitRate !== null ? ` Acerto histórico deste sinal: ${(an.history.hitRate * 100).toFixed(0)}% (${an.history.samples} casos).` : '';
        for (const t of w.tenants as string[])
          await notify(t, 'sinal', `${an.signal === 'COMPRA' ? 'Sinal de COMPRA' : 'Sinal de VENDA'}: ${w.symbol}`,
            `Placar ${an.score} · preço ${an.price}.${hr} Sinal técnico, não é garantia de resultado.`, w.market, w.symbol);
      }
    } catch { /* ativo sem dados agora: tenta na próxima volta */ }
  }
}
