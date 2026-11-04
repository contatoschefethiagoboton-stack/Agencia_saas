import { Router } from 'express';
import { z } from 'zod';
import { withTenant } from '../db.js';
import { requireRecentMfa } from '../middleware/auth.js';
import { encryptToken } from '../security/vault.js';
import { assertNotPanicking } from '../security/panic.js';
import { audit } from '../audit/audit.js';
import { broker, BROKER_MARKET, type BrokerId } from '../brokers/index.js';
import { getCandles, INTERVALS, normalizeSymbol } from '../market/data.js';
import { strategyIds } from '../market/strategies.js';
import { closePosition, loadBot } from './engine.js';

export const botsRouter = Router();
const tid = (req: any) => req.user!.tid as string;
const notFound = () => Object.assign(new Error('Robô não encontrado'), { status: 404 });

/** Desempenho de cada robô: resultado total, do dia, taxa de acerto e posição aberta. */
const STATS = `
  SELECT b.id, b.name, b.market, b.symbol, b.interval, b.strategy, b.mode, b.amount::float, b.stop_loss_pct::float, b.take_profit_pct::float,
         b.max_daily_loss::float, b.status, b.status_reason, b.copy_of, b.connection_id, b.last_tick_at, b.created_at, b.is_master, b.public_description,
         m.name AS copy_name,
         coalesce(sum(t.pnl) FILTER (WHERE t.status = 'closed'), 0)::float AS pnl_total,
         coalesce(sum(t.pnl) FILTER (WHERE t.status = 'closed' AND t.exit_at >= date_trunc('day', now())), 0)::float AS pnl_today,
         count(t.id) FILTER (WHERE t.status = 'closed')::int AS trades,
         count(t.id) FILTER (WHERE t.status = 'closed' AND t.pnl > 0)::int AS wins,
         (SELECT row_to_json(o) FROM (SELECT id, qty::float, entry_price::float, entry_at, stop_price::float, target_price::float
                                        FROM bot_trades WHERE bot_id = b.id AND status = 'open') o) AS open_trade
    FROM bots b LEFT JOIN bot_trades t ON t.bot_id = b.id LEFT JOIN bots m ON m.id = b.copy_of`;

botsRouter.get('/', async (req, res) => {
  res.json(await withTenant(tid(req), async c => (await c.query(
    `${STATS} WHERE b.tenant_id = $1 GROUP BY b.id, m.name ORDER BY b.created_at DESC`, [tid(req)])).rows));
});

botsRouter.get('/:id/trades', async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  res.json(await withTenant(tid(req), async c => (await c.query(
    `SELECT id, symbol, mode, qty::float, entry_price::float, entry_at, exit_price::float, exit_at, exit_reason, fees::float, pnl::float, status,
            stop_price::float, target_price::float
       FROM bot_trades WHERE bot_id = $1 ORDER BY entry_at DESC LIMIT 200`, [id])).rows));
});

/** Limites do plano do cliente (VIP = recursos do maior plano). */
async function planOf(c: any, tenantId: string) {
  const p = (await c.query(`SELECT t.vip, p.name, p.max_bots, p.live_trading, p.copy_trade FROM tenants t JOIN plans p ON p.id = t.plan WHERE t.id = $1`, [tenantId])).rows[0];
  return p?.vip ? { ...p, max_bots: 50, live_trading: true, copy_trade: true } : p ?? { max_bots: 1, live_trading: false, copy_trade: false };
}

botsRouter.get('/plan', async (req, res) => {
  res.json(await withTenant(tid(req), async c => {
    const p = await planOf(c, tid(req));
    return { name: p.name, maxBots: p.max_bots, liveTrading: p.live_trading, copyTrade: p.copy_trade };
  }));
});

const zBot = z.object({
  name: z.string().trim().min(2).max(60),
  market: z.enum(['crypto', 'b3', 'us']).optional(), symbol: z.string().max(20).optional(),
  interval: z.enum(INTERVALS).optional(), strategy: z.string().optional(),
  mode: z.enum(['paper', 'live']).default('paper'), connectionId: z.string().uuid().nullable().optional(),
  amount: z.number().positive().max(1e9),
  stopLossPct: z.number().min(0.1).max(50).nullable().optional(), takeProfitPct: z.number().min(0.1).max(500).nullable().optional(),
  maxDailyLoss: z.number().positive().nullable().optional(), copyOf: z.string().uuid().nullable().optional(),
});

botsRouter.post('/', async (req, res, next) => {
  const b = zBot.parse(req.body);
  if (b.mode === 'live') return requireRecentMfa(req, res, () => createBot(req, res).catch(next));   // dinheiro real: confirma o 2FA
  await createBot(req, res);
});

async function createBot(req: any, res: any) {
  const b = zBot.parse(req.body);
  const out = await withTenant(tid(req), async c => {
    const plan = await planOf(c, tid(req));
    const count = (await c.query(`SELECT count(*)::int AS n FROM bots WHERE tenant_id = $1`, [tid(req)])).rows[0].n;
    if (count >= plan.max_bots) throw Object.assign(new Error(`Seu plano permite ${plan.max_bots} robô(s). Apague um ou troque de plano.`), { status: 403 });
    let { market, symbol, interval, strategy } = b;
    if (b.copyOf) {
      if (!plan.copy_trade) throw Object.assign(new Error('Copy trade não está incluído no seu plano'), { status: 403 });
      const m = (await c.query(`SELECT market, symbol, interval, strategy FROM bots WHERE id = $1 AND is_master AND status = 'active'`, [b.copyOf])).rows[0];
      if (!m) throw Object.assign(new Error('Estratégia de copy trade indisponível'), { status: 404 });
      ({ market, symbol, interval, strategy } = m);
    }
    if (!market || !symbol || !interval || !strategy) throw Object.assign(new Error('Escolha mercado, ativo, tempo gráfico e estratégia'), { status: 400 });
    if (!b.copyOf && !strategyIds.includes(strategy)) throw Object.assign(new Error('Estratégia desconhecida'), { status: 400 });
    symbol = normalizeSymbol(market, symbol);
    if (b.mode === 'live') {
      if (!plan.live_trading) throw Object.assign(new Error('Seu plano só permite robôs simulados'), { status: 403 });
      if (market === 'b3') throw Object.assign(new Error('Robô com dinheiro real na B3 ainda não é possível: as corretoras brasileiras não liberam API de ordens para pessoa física. Use o simulado.'), { status: 400 });
      const conn = (await c.query(`SELECT broker, status FROM broker_connections WHERE id = $1`, [b.connectionId ?? null])).rows[0];
      if (!conn) throw Object.assign(new Error('Escolha a corretora conectada que o robô vai usar'), { status: 400 });
      if (BROKER_MARKET[conn.broker as BrokerId] !== market) throw Object.assign(new Error('Esta corretora não negocia este mercado'), { status: 400 });
      if (conn.status !== 'ok') throw Object.assign(new Error('Corretora com erro: teste a conexão de novo'), { status: 400 });
    }
    await getCandles(market as any, symbol, interval as any, 100);   // confirma que o ativo existe antes de salvar
    const r = await c.query(
      `INSERT INTO bots (tenant_id, name, market, symbol, interval, strategy, mode, connection_id, amount, stop_loss_pct, take_profit_pct, max_daily_loss, copy_of)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [tid(req), b.name, market, symbol, interval, strategy, b.mode, b.mode === 'live' ? b.connectionId : null, b.amount,
       b.stopLossPct ?? null, b.takeProfitPct ?? null, b.maxDailyLoss ?? null, b.copyOf ?? null]);
    await audit({ actorId: req.user.sub, tenantId: tid(req), ip: req.ip, action: 'bot.created', target: r.rows[0].id, meta: { mode: b.mode, market, symbol } }, c);
    return r.rows[0].id;
  });
  res.status(201).json({ id: out });
}

botsRouter.patch('/:id', async (req, res, next) => {
  const id = z.string().uuid().parse(req.params.id);
  const b = z.object({ status: z.enum(['active', 'paused']).optional(), amount: z.number().positive().max(1e9).optional(),
                       stopLossPct: z.number().min(0.1).max(50).nullable().optional(), takeProfitPct: z.number().min(0.1).max(500).nullable().optional(),
                       maxDailyLoss: z.number().positive().nullable().optional(), name: z.string().trim().min(2).max(60).optional() }).parse(req.body);
  const bot = await withTenant(tid(req), async c => (await c.query(`SELECT mode FROM bots WHERE id = $1 AND tenant_id = $2`, [id, tid(req)])).rows[0]);
  if (!bot) throw notFound();
  const run = async () => {
    if (b.status === 'active') await assertNotPanicking();
    await withTenant(tid(req), async c => {
      await c.query(`UPDATE bots SET status = coalesce($2, status), status_reason = CASE WHEN $2 IS NULL THEN status_reason END,
                       amount = coalesce($3, amount), name = coalesce($4, name),
                       stop_loss_pct = CASE WHEN $5 THEN $6 ELSE stop_loss_pct END,
                       take_profit_pct = CASE WHEN $7 THEN $8 ELSE take_profit_pct END,
                       max_daily_loss = CASE WHEN $9 THEN $10 ELSE max_daily_loss END
                     WHERE id = $1`,
                    [id, b.status ?? null, b.amount ?? null, b.name ?? null, 'stopLossPct' in b, b.stopLossPct ?? null,
                     'takeProfitPct' in b, b.takeProfitPct ?? null, 'maxDailyLoss' in b, b.maxDailyLoss ?? null]);
      await audit({ actorId: req.user!.sub, tenantId: tid(req), ip: req.ip, action: 'bot.updated', target: id, meta: b }, c);
    });
    res.json({ ok: true });
  };
  // ligar robô com dinheiro real exige 2FA recente
  if (bot.mode === 'live' && b.status === 'active') return requireRecentMfa(req, res, () => run().catch(next));
  await run();
});

/** Fecha a posição aberta agora (venda a mercado na corretora, ou no simulado). */
botsRouter.post('/:id/close', async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const own = await withTenant(tid(req), async c => (await c.query(`SELECT 1 FROM bots WHERE id = $1 AND tenant_id = $2`, [id, tid(req)])).rowCount);
  if (!own) throw notFound();
  const bot = (await loadBot(id))!;
  const t = await withTenant(tid(req), async c => (await c.query(`SELECT * FROM bot_trades WHERE bot_id = $1 AND status = 'open'`, [id])).rows[0]);
  if (!t) return res.status(409).json({ error: 'Este robô não tem posição aberta' });
  if (t.mode === 'live') await assertNotPanicking();
  const candles = await getCandles(bot.market, bot.symbol, bot.interval, 50);
  const r = await closePosition(bot, t, candles[candles.length - 1].close, 'manual');
  await audit({ actorId: req.user!.sub, tenantId: tid(req), ip: req.ip, action: 'bot.position_closed', target: id, meta: { pnl: r.pnl } });
  res.json({ ok: true, ...r });
});

botsRouter.delete('/:id', async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  await withTenant(tid(req), async c => {
    if ((await c.query(`SELECT 1 FROM bot_trades WHERE bot_id = $1 AND status = 'open'`, [id])).rowCount)
      throw Object.assign(new Error('Feche a posição aberta antes de apagar o robô'), { status: 409 });
    const r = await c.query(`DELETE FROM bots WHERE id = $1 AND tenant_id = $2`, [id, tid(req)]);
    if (!r.rowCount) throw notFound();
    await audit({ actorId: req.user!.sub, tenantId: tid(req), ip: req.ip, action: 'bot.deleted', target: id }, c);
  });
  res.json({ ok: true });
});

// ---------- Copy trade: catálogo de estratégias da plataforma ----------
botsRouter.get('/copy/catalog', async (req, res) => {
  res.json(await withTenant(tid(req), async c => (await c.query(`
    SELECT b.id, b.name, b.market, b.symbol, b.interval, b.strategy, b.public_description, b.created_at,
           count(t.id) FILTER (WHERE t.status = 'closed')::int AS trades,
           count(t.id) FILTER (WHERE t.status = 'closed' AND t.pnl > 0)::int AS wins,
           coalesce(sum((t.exit_price / t.entry_price - 1) * 100) FILTER (WHERE t.status = 'closed' AND t.exit_at > now() - interval '30 days'), 0)::float AS ret_30d,
           coalesce(sum((t.exit_price / t.entry_price - 1) * 100) FILTER (WHERE t.status = 'closed'), 0)::float AS ret_total,
           bool_or(t.status = 'open') AS posicionado,
           (SELECT count(*)::int FROM bots f WHERE f.copy_of = b.id AND f.tenant_id = $1) AS sigo
      FROM bots b LEFT JOIN bot_trades t ON t.bot_id = b.id
     WHERE b.is_master AND b.status = 'active'
     GROUP BY b.id ORDER BY ret_30d DESC`, [tid(req)])).rows));
});

botsRouter.get('/copy/:id/trades', async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  res.json(await withTenant(tid(req), async c => (await c.query(
    `SELECT t.entry_price::float, t.entry_at, t.exit_price::float, t.exit_at, t.exit_reason, t.status,
            CASE WHEN t.exit_price IS NOT NULL THEN (t.exit_price / t.entry_price - 1) * 100 END::float AS ret_pct
       FROM bot_trades t JOIN bots b ON b.id = t.bot_id WHERE b.id = $1 AND b.is_master ORDER BY t.entry_at DESC LIMIT 100`, [id])).rows));
});

// ---------- Corretoras ----------
botsRouter.get('/connections', async (req, res) => {
  res.json(await withTenant(tid(req), async c => (await c.query(
    `SELECT id, broker, label, key_hint, paper, status, last_error, checked_at, created_at,
            (SELECT count(*)::int FROM bots b WHERE b.connection_id = bc.id) AS robos
       FROM broker_connections bc ORDER BY created_at`)).rows));
});

/** Conecta a corretora: testa a chave ANTES de salvar (e recusa chave com permissão de saque). Exige 2FA recente. */
botsRouter.post('/connections', requireRecentMfa, async (req, res) => {
  const b = z.object({ broker: z.enum(['binance', 'alpaca']), label: z.string().trim().min(2).max(40),
                       key: z.string().trim().min(10).max(200), secret: z.string().trim().min(10).max(200), paper: z.boolean().default(false) }).parse(req.body);
  await assertNotPanicking();
  const info = await broker(b.broker, { key: b.key, secret: b.secret, paper: b.paper }).check();
  const id = await withTenant(tid(req), async c => {
    if ((await c.query(`SELECT count(*)::int AS n FROM broker_connections`)).rows[0].n >= 10)
      throw Object.assign(new Error('Limite de 10 corretoras conectadas'), { status: 400 });
    const r = await c.query(
      `INSERT INTO broker_connections (tenant_id, broker, label, key_cipher, secret_cipher, key_hint, paper, checked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now()) RETURNING id`,
      [tid(req), b.broker, b.label, encryptToken(b.key), encryptToken(b.secret), b.key.slice(-4), b.paper]);
    await audit({ actorId: req.user!.sub, tenantId: tid(req), ip: req.ip, action: 'broker.connected', target: r.rows[0].id, meta: { broker: b.broker } }, c);
    return r.rows[0].id;
  });
  res.status(201).json({ id, ...info });
});

botsRouter.post('/connections/:id/check', async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const { decryptToken } = await import('../security/vault.js');
  const conn = await withTenant(tid(req), async c => (await c.query(`SELECT * FROM broker_connections WHERE id = $1`, [id])).rows[0]);
  if (!conn) return res.status(404).json({ error: 'Conexão não encontrada' });
  try {
    const info = await broker(conn.broker, { key: decryptToken(conn.key_cipher), secret: decryptToken(conn.secret_cipher), paper: conn.paper }).check();
    await withTenant(tid(req), c => c.query(`UPDATE broker_connections SET status = 'ok', last_error = NULL, checked_at = now() WHERE id = $1`, [id]));
    res.json({ ok: true, ...info });
  } catch (e) {
    await withTenant(tid(req), c => c.query(`UPDATE broker_connections SET status = 'error', last_error = $2, checked_at = now() WHERE id = $1`, [id, (e as Error).message.slice(0, 300)]));
    throw e;
  }
});

botsRouter.delete('/connections/:id', async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  await withTenant(tid(req), async c => {
    const live = (await c.query(`SELECT 1 FROM bot_trades t JOIN bots b ON b.id = t.bot_id WHERE b.connection_id = $1 AND t.status = 'open' AND t.mode = 'live'`, [id])).rowCount;
    if (live) throw Object.assign(new Error('Há robôs com posição aberta nesta corretora. Feche as posições antes de desconectar.'), { status: 409 });
    await c.query(`UPDATE bots SET status = 'paused', status_reason = 'Corretora desconectada' WHERE connection_id = $1`, [id]);
    await c.query(`DELETE FROM broker_connections WHERE id = $1`, [id]);
    await audit({ actorId: req.user!.sub, tenantId: tid(req), ip: req.ip, action: 'broker.disconnected', target: id }, c);
  });
  res.json({ ok: true });
});
