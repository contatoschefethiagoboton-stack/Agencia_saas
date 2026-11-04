import { Router } from 'express';
import { z } from 'zod';
import { withTenant } from '../db.js';
import { redis } from '../redis.js';
import { sendTelegram } from '../notify.js';
import { computeAll } from './indicators.js';
import { analyze, backtest, STRATEGIES } from './strategies.js';
import { fiiRanking, getCandles, getQuotes, INTERVALS, isDemo, normalizeSymbol, topAssets, type Market } from './data.js';
import { scan } from './radar.js';
import { planOf } from '../bots/routes.js';

export const marketRouter = Router();
const tid = (req: any) => req.user!.tid as string;
const zMarket = z.enum(['crypto', 'b3', 'us']);
const zInterval = z.enum(INTERVALS);
const num = (a: number[]) => a.map(x => (Number.isFinite(x) ? +x.toPrecision(8) : null));

/** O que está ligado: o painel avisa o que falta configurar em vez de quebrar. */
marketRouter.get('/status', (_req, res) => {
  res.json({ demo: isDemo(), crypto: true, b3: true, b3Full: Boolean(process.env.BRAPI_TOKEN),
             us: Boolean(process.env.ALPACA_DATA_KEY && process.env.ALPACA_DATA_SECRET), telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN),
             telegramBot: process.env.TELEGRAM_BOT_NAME ?? null });
});

marketRouter.get('/strategies', (_req, res) => {
  res.json(Object.entries(STRATEGIES).map(([id, s]) => ({ id, name: s.name, description: s.description })));
});

marketRouter.get('/overview', async (req, res) => {
  const market = zMarket.parse(req.query.market ?? 'crypto');
  res.json(await topAssets(market, Math.min(Number(req.query.n ?? 30) || 30, 60)));
});

/** Candles + indicadores + análise do último candle fechado + marcações de compra/venda da estratégia escolhida. */
marketRouter.get('/chart', async (req, res) => {
  const q = z.object({ market: zMarket, symbol: z.string().max(20), interval: zInterval.default('1h'),
                       strategy: z.string().max(30).default('score') }).parse(req.query);
  const symbol = normalizeSymbol(q.market, q.symbol);
  const candles = await getCandles(q.market, symbol, q.interval, 500);
  const ind = computeAll(candles);
  const bt = STRATEGIES[q.strategy] ? backtest(candles, { strategy: q.strategy, stopLossPct: null, takeProfitPct: null }) : null;
  res.json({
    symbol, market: q.market, interval: q.interval, candles,
    ind: { ema9: num(ind.ema9), ema21: num(ind.ema21), ema200: num(ind.ema200), bbUpper: num(ind.bb.upper), bbLower: num(ind.bb.lower),
           rsi: num(ind.rsi), macd: num(ind.macd.line), macdSignal: num(ind.macd.signal), macdHist: num(ind.macd.hist) },
    analysis: analyze(candles),
    markers: bt ? bt.trades.flatMap(t => [{ time: t.entryTime, side: 'buy' }, ...(t.reason === 'aberta' ? [] : [{ time: t.exitTime, side: 'sell' }])]) : [],
  });
});

marketRouter.get('/scanner', async (req, res) => {
  const q = z.object({ market: zMarket.default('crypto'), interval: zInterval.optional() }).parse(req.query);
  res.json(await scan(q.market, q.interval));
});

marketRouter.post('/backtest', async (req, res) => {
  const b = z.object({ market: zMarket, symbol: z.string().max(20), interval: zInterval, strategy: z.string().max(30),
                       stopLossPct: z.number().min(0.1).max(50).nullable().optional(), takeProfitPct: z.number().min(0.1).max(500).nullable().optional() }).parse(req.body);
  const candles = await getCandles(b.market, normalizeSymbol(b.market, b.symbol), b.interval, 1000);
  res.json({ from: candles[0]?.time, to: candles[candles.length - 1]?.time, ...backtest(candles, b) });
});

marketRouter.get('/fiis', async (_req, res) => {
  const list = await fiiRanking(40);
  // nota simples e transparente: DY alto, P/VP perto ou abaixo de 1 e boa liquidez
  const scored = list.map(f => {
    let nota = 0;
    if (f.dy12m !== null) nota += Math.min(f.dy12m, 16) * 4;                  // até 64 pontos
    if (f.pvp !== null) nota += f.pvp <= 0.95 ? 20 : f.pvp <= 1.05 ? 12 : f.pvp <= 1.2 ? 4 : -10;
    if ((f.volume ?? 0) > 1_000_000) nota += 10;
    if (f.dy12m !== null && f.dy12m > 18) nota -= 20;                           // DY alto demais costuma ser evento pontual ou risco
    return { ...f, nota: Math.round(Math.max(0, Math.min(100, nota))) };
  }).sort((a, b) => b.nota - a.nota);
  res.json(scored);
});

/** Lançamentos detectados pelo radar (moedas e ativos novos). */
marketRouter.get('/listings', async (req, res) => {
  res.json(await withTenant(tid(req), async c => (await c.query(
    `SELECT id, title, body, market, symbol, created_at FROM alerts WHERE kind = 'lancamento' AND tenant_id IS NULL
      ORDER BY id DESC LIMIT 100`)).rows));
});

// ---------- Lista de acompanhamento ----------
marketRouter.get('/watchlist', async (req, res) => {
  const rows = await withTenant(tid(req), async c => (await c.query(`SELECT market, symbol FROM watchlist ORDER BY added_at`)).rows);
  const out = [];
  for (const m of ['crypto', 'b3', 'us'] as Market[]) {
    const syms = rows.filter(r => r.market === m).map(r => r.symbol);
    const quotes = syms.length ? await getQuotes(m, syms).catch(() => []) : [];
    for (const s of syms) {
      const sig = await redis.get(`sig:${m}:${s}:${m === 'crypto' ? '1h' : '1d'}`);
      out.push({ market: m, symbol: s, ...(quotes.find(q => q.symbol === s) ?? {}), signal: sig });
    }
  }
  res.json(out);
});

marketRouter.post('/watchlist', async (req, res) => {
  const b = z.object({ market: zMarket, symbol: z.string().max(20) }).parse(req.body);
  const symbol = normalizeSymbol(b.market, b.symbol);
  await withTenant(tid(req), async c => {
    if ((await c.query(`SELECT count(*)::int AS n FROM watchlist`)).rows[0].n >= 50)
      throw Object.assign(new Error('Limite de 50 ativos na lista'), { status: 400 });
    await c.query(`INSERT INTO watchlist (tenant_id, market, symbol) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [tid(req), b.market, symbol]);
  });
  res.status(201).json({ ok: true, symbol });
});

marketRouter.delete('/watchlist/:market/:symbol', async (req, res) => {
  const market = zMarket.parse(req.params.market);
  await withTenant(tid(req), c => c.query(`DELETE FROM watchlist WHERE market = $1 AND symbol = $2`, [market, req.params.symbol]));
  res.json({ ok: true });
});

// ---------- Central de avisos ----------
marketRouter.get('/alerts', async (req, res) => {
  res.json(await withTenant(tid(req), async c => {
    const last = (await c.query(`SELECT last_read FROM alert_reads`)).rows[0]?.last_read ?? 0;
    const rows = (await c.query(`SELECT id::int, kind, title, body, market, symbol, created_at FROM alerts ORDER BY id DESC LIMIT 80`)).rows;
    return { unread: rows.filter(r => r.id > Number(last)).length, items: rows.map(r => ({ ...r, unread: r.id > Number(last) })) };
  }));
});

marketRouter.post('/alerts/read', async (req, res) => {
  await withTenant(tid(req), c => c.query(
    `INSERT INTO alert_reads (tenant_id, last_read) VALUES ($1, (SELECT coalesce(max(id), 0) FROM alerts))
     ON CONFLICT (tenant_id) DO UPDATE SET last_read = EXCLUDED.last_read`, [tid(req)]));
  res.json({ ok: true });
});

// ---------- Avisos no Telegram ----------
marketRouter.get('/notify', async (req, res) => {
  const r = await withTenant(tid(req), async c => (await c.query(`SELECT telegram_chat_id, on_signals, on_bots, on_listings FROM notify_settings`)).rows[0]);
  res.json(r ?? { telegram_chat_id: null, on_signals: true, on_bots: true, on_listings: true });
});

marketRouter.put('/notify', async (req, res) => {
  const b = z.object({ telegramChatId: z.string().regex(/^-?\d{4,20}$/).nullable(), onSignals: z.boolean(), onBots: z.boolean(), onListings: z.boolean() }).parse(req.body);
  await withTenant(tid(req), c => c.query(
    `INSERT INTO notify_settings (tenant_id, telegram_chat_id, on_signals, on_bots, on_listings) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id) DO UPDATE SET telegram_chat_id = $2, on_signals = $3, on_bots = $4, on_listings = $5`,
    [tid(req), b.telegramChatId, b.onSignals, b.onBots, b.onListings]));
  res.json({ ok: true });
});

marketRouter.post('/notify/test', async (req, res) => {
  const chat = await withTenant(tid(req), async c => (await c.query(`SELECT telegram_chat_id FROM notify_settings`)).rows[0]?.telegram_chat_id);
  if (!chat) return res.status(400).json({ error: 'Salve o código do chat do Telegram antes de testar' });
  await sendTelegram(chat, '<b>Tudo certo!</b>\nVocê vai receber aqui os avisos de sinais, robôs e lançamentos.');
  res.json({ ok: true });
});

// ---------- Alertas de preço ("me avise quando BTC passar de 70 mil" / "quando cair 5%") ----------
marketRouter.get('/price-alerts', async (req, res) => {
  res.json(await withTenant(tid(req), async c => (await c.query(
    `SELECT id, market, symbol, kind, value::float, base_price::float, note, active, triggered_at, triggered_price::float, created_at
       FROM price_alerts ORDER BY active DESC, created_at DESC LIMIT 200`)).rows));
});

marketRouter.post('/price-alerts', async (req, res) => {
  const b = z.object({ market: zMarket, symbol: z.string().max(20), kind: z.enum(['above', 'below', 'up_pct', 'down_pct']),
                       value: z.number().positive().max(1e12), note: z.string().trim().max(120).optional() }).parse(req.body);
  const symbol = normalizeSymbol(b.market, b.symbol);
  if (b.kind.endsWith('pct') && b.value > 500) return res.status(400).json({ error: 'Percentual muito alto' });
  const q = (await getQuotes(b.market, [symbol]))[0] ?? { price: (await getCandles(b.market, symbol, '1h', 50)).at(-1)!.close };
  const id = await withTenant(tid(req), async c => {
    const plan = await planOf(c, tid(req));
    const n = (await c.query(`SELECT count(*)::int AS n FROM price_alerts WHERE active`)).rows[0].n;
    if (plan.price_alerts >= 0 && n >= plan.price_alerts)
      throw Object.assign(new Error(`Seu plano permite ${plan.price_alerts} alerta(s) de preço ativos. Apague um ou mude de plano.`), { status: 403 });
    return (await c.query(`INSERT INTO price_alerts (tenant_id, market, symbol, kind, value, base_price, note) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
                          [tid(req), b.market, symbol, b.kind, b.value, q.price, b.note ?? null])).rows[0].id;
  });
  res.status(201).json({ id, basePrice: q.price });
});

marketRouter.delete('/price-alerts/:id', async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  await withTenant(tid(req), c => c.query(`DELETE FROM price_alerts WHERE id = $1`, [id]));
  res.json({ ok: true });
});
