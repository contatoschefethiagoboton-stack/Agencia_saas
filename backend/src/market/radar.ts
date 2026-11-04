import { withSystem } from '../db.js';
import { redis } from '../redis.js';
import { notify } from '../notify.js';
import { isPanicking } from '../security/panic.js';
import { analyze, type Analysis } from './strategies.js';
import { getCandles, getQuotes, listAllSymbols, topAssets, type Interval, type Market } from './data.js';

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
      await withSystem(c => c.query(`DELETE FROM access_log WHERE at < now() - interval '180 days'`)).catch(() => {});   // retenção do rastreamento
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

/** Alertas de preço: confere a cada PRICE_ALERT_MS (padrão 20 s) e dispara uma única vez. */
export async function runPriceAlerts() {
  const every = Number(process.env.PRICE_ALERT_MS ?? 20_000);
  for (;;) {
    if ((await redis.set('pricealerts:lock', '1', { NX: true, EX: Math.max(5, Math.ceil(every / 1000)) })) === 'OK') {
      await checkPriceAlerts().catch(e => console.error('[alertas de preço]', (e as Error).message));
      await redis.del('pricealerts:lock');
    }
    await new Promise(r => setTimeout(r, every));
  }
}

const KIND_TXT: Record<string, string> = { above: 'subiu acima de', below: 'caiu abaixo de', up_pct: 'subiu', down_pct: 'caiu' };

async function checkPriceAlerts() {
  const alerts = await withSystem(async c => (await c.query(
    `SELECT a.id, a.tenant_id, a.market, a.symbol, a.kind, a.value::float, a.base_price::float, a.note
       FROM price_alerts a JOIN tenants t ON t.id = a.tenant_id WHERE a.active AND t.status = 'active' LIMIT 2000`)).rows);
  const byMarket = new Map<Market, Set<string>>();
  for (const a of alerts) (byMarket.get(a.market) ?? byMarket.set(a.market, new Set()).get(a.market)!).add(a.symbol);
  const prices = new Map<string, number>();
  for (const [m, syms] of byMarket) {
    const qs = await getQuotes(m, [...syms]).catch(() => []);
    for (const q of qs) prices.set(`${m}:${q.symbol}`, q.price);
    for (const s of syms) if (!prices.has(`${m}:${s}`))          // fora da lista de cotações: último candle
      try { prices.set(`${m}:${s}`, (await getCandles(m, s, '5m', 50)).at(-1)!.close); } catch { /* sem dado agora */ }
  }
  for (const a of alerts) {
    const p = prices.get(`${a.market}:${a.symbol}`);
    if (!p) continue;
    const move = (p / a.base_price - 1) * 100;
    const hit = a.kind === 'above' ? p >= a.value : a.kind === 'below' ? p <= a.value : a.kind === 'up_pct' ? move >= a.value : -move >= a.value;
    if (!hit) continue;
    const done = await withSystem(async c => (await c.query(
      `UPDATE price_alerts SET active = false, triggered_at = now(), triggered_price = $2 WHERE id = $1 AND active RETURNING id`, [a.id, p])).rowCount);
    if (!done) continue;
    const alvo = a.kind.endsWith('pct') ? `${a.value}%` : String(a.value);
    await notify(a.tenant_id, 'sinal', `Alerta de preço: ${a.symbol} ${KIND_TXT[a.kind]} ${alvo}`,
      `Preço agora: ${p} (${move >= 0 ? '+' : ''}${move.toFixed(2)}% desde a criação do alerta).${a.note ? ` ${a.note}` : ''}`, a.market, a.symbol);
  }
}
