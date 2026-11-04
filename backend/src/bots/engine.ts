import type { PoolClient } from 'pg';
import { withSystem } from '../db.js';
import { redis } from '../redis.js';
import { isPanicking } from '../security/panic.js';
import { decryptToken } from '../security/vault.js';
import { getCandles, type Interval, type Market } from '../market/data.js';
import { strategySignal } from '../market/strategies.js';
import { broker, type BrokerId, type Fill } from '../brokers/index.js';
import { notify } from '../notify.js';

/*
 * MOTOR DOS ROBÔS (a cada BOT_TICK_MS, padrão 20 s)
 *   1) estratégias master (copy trade, sempre simuladas) -> 2) robôs próprios -> 3) seguidores de copy trade.
 *   - decide só no candle FECHADO e uma vez por candle (last_signal_at): não entra duas vezes no mesmo sinal;
 *   - stop e alvo são conferidos a cada volta com o preço atual;
 *   - perda diária máxima atingida = robô pausa sozinho;
 *   - erro em ordem real = robô vai para "erro" e NÃO tenta de novo sozinho (evita ordem duplicada);
 *   - Modo Pânico do administrador congela todos os robôs.
 */
export const PAPER_FEE = 0.001;   // 0,1% por ponta no simulado (taxa típica de corretora de cripto)

export interface BotRow {
  id: string; tenant_id: string | null; name: string; market: Market; symbol: string; interval: Interval; strategy: string;
  mode: 'paper' | 'live'; amount: string; stop_loss_pct: string | null; take_profit_pct: string | null; max_daily_loss: string | null;
  trailing_stop_pct: string | null;
  status: string; is_master: boolean; copy_of: string | null; last_signal_at: string | null; created_at: string;
  broker: BrokerId | null; key_cipher: Buffer | null; secret_cipher: Buffer | null; paper: boolean | null; live_trading: boolean | null;
}
interface TradeRow { id: string; qty: string; entry_price: string; entry_at: string; stop_price: string | null; target_price: string | null; fees: string; mode: string }

const BOT_SQL = `
  SELECT b.*, bc.broker, bc.key_cipher, bc.secret_cipher, bc.paper, coalesce(p.live_trading, false) OR coalesce(t.vip, false) AS live_trading
    FROM bots b
    LEFT JOIN broker_connections bc ON bc.id = b.connection_id
    LEFT JOIN tenants t ON t.id = b.tenant_id
    LEFT JOIN plans p ON p.id = t.plan`;

export async function runBotEngine() {
  const every = Number(process.env.BOT_TICK_MS ?? 20_000);
  for (;;) {
    try { await tick(); } catch (e) { console.error('[robôs]', (e as Error).message); }
    await new Promise(r => setTimeout(r, every));
  }
}

export async function tick() {
  if (await isPanicking()) return;
  // uma instância por vez (web + worker separado não executam a mesma volta)
  if ((await redis.set('bots:tick', String(process.pid), { NX: true, EX: 55 })) !== 'OK') return;
  try {
    const bots = await withSystem(async c => (await c.query<BotRow>(
      `${BOT_SQL} WHERE b.status = 'active' AND (t.id IS NULL OR t.status = 'active')
       ORDER BY b.is_master DESC, (b.copy_of IS NOT NULL), b.created_at`)).rows);
    for (const b of bots) {
      try { await processBot(b); }
      catch (e) {
        const msg = (e as Error).message.slice(0, 300);
        await withSystem(c => c.query(`UPDATE bots SET status = 'error', status_reason = $2 WHERE id = $1`, [b.id, msg]));
        if (b.tenant_id) await notify(b.tenant_id, 'robo', `Robô "${b.name}" parou por erro`, msg, b.market, b.symbol);
      }
    }
  } finally { await redis.del('bots:tick'); }
}

async function processBot(b: BotRow) {
  const candles = await getCandles(b.market, b.symbol, b.interval, 300);
  const price = candles[candles.length - 1].close;
  const open = await withSystem(async c => (await c.query<TradeRow>(`SELECT * FROM bot_trades WHERE bot_id = $1 AND status = 'open'`, [b.id])).rows[0]);
  await withSystem(c => c.query(`UPDATE bots SET last_tick_at = now() WHERE id = $1`, [b.id]));

  if (b.mode === 'live') {
    if (!b.live_trading) throw new Error('Seu plano não inclui robôs com dinheiro real. Mude para o modo simulado ou troque de plano.');
    if (!b.broker) throw new Error('Corretora desconectada. Conecte de novo em Corretoras.');
    if (!(await liveBroker(b).isMarketOpen())) return;   // fora do pregão: espera
  }

  // ---- seguidor de copy trade: espelha a estratégia master
  if (b.copy_of) {
    const m = await withSystem(async c => (await c.query<TradeRow>(
      `SELECT * FROM bot_trades WHERE bot_id = $1 AND status = 'open'`, [b.copy_of])).rows[0]);
    if (open) {
      if (await checkExits(b, open, price)) return;
      if (!m) await closePosition(b, open, price, 'copia');
    } else if (m && Date.parse(m.entry_at) > Date.parse(b.created_at) && Date.now() - Date.parse(m.entry_at) < 30 * 60_000) {
      // só entra em operações abertas DEPOIS de começar a seguir e há menos de 30 min (não compra "atrasado")
      await openPosition(b, price, null, m);
    }
    return;
  }

  // ---- robô com estratégia própria
  const sig = strategySignal(b.strategy, candles);
  if (open) {
    if (await checkExits(b, open, price)) return;
    if (sig.action === 'sell') await closePosition(b, open, price, 'sinal');
    return;
  }
  const lastBar = b.last_signal_at ? Date.parse(b.last_signal_at) / 1000 : 0;
  if (sig.action === 'buy' && sig.bar > lastBar) {
    await withSystem(c => c.query(`UPDATE bots SET last_signal_at = to_timestamp($2) WHERE id = $1`, [b.id, sig.bar]));
    if (await dailyLossHit(b)) return;
    await openPosition(b, price, sig.atr, null);
  }
}

/** Stop e alvo, conferidos a cada volta. Devolve true se fechou. */
async function checkExits(b: BotRow, t: TradeRow, price: number) {
  // STOP MÓVEL: o stop sobe junto com o preço (nunca desce). Na virada para queda, o robô vende protegendo o ganho.
  if (b.trailing_stop_pct) {
    const trail = price * (1 - +b.trailing_stop_pct / 100);
    if (!t.stop_price || trail > +t.stop_price) {
      await withSystem(c => c.query(`UPDATE bot_trades SET stop_price = $2 WHERE id = $1 AND status = 'open'`, [t.id, trail]));
      t.stop_price = String(trail);
    }
  }
  if (t.stop_price && price <= +t.stop_price) { await closePosition(b, t, price, 'stop'); return true; }
  if (t.target_price && price >= +t.target_price) { await closePosition(b, t, price, 'alvo'); return true; }
  return false;
}

async function dailyLossHit(b: BotRow) {
  if (!b.max_daily_loss) return false;
  const loss = await withSystem(async c => -Number((await c.query(
    `SELECT coalesce(sum(pnl), 0) AS s FROM bot_trades WHERE bot_id = $1 AND status = 'closed' AND exit_at >= date_trunc('day', now())`, [b.id])).rows[0].s));
  if (loss < +b.max_daily_loss) return false;
  await withSystem(c => c.query(`UPDATE bots SET status = 'paused', status_reason = 'Perda máxima do dia atingida: o robô volta amanhã se você reativar.' WHERE id = $1`, [b.id]));
  if (b.tenant_id) await notify(b.tenant_id, 'robo', `Robô "${b.name}" pausado`, `Perda máxima do dia atingida (${loss.toFixed(2)}).`, b.market, b.symbol);
  return true;
}

const liveBroker = (b: BotRow) => broker(b.broker!, { key: decryptToken(b.key_cipher!), secret: decryptToken(b.secret_cipher!), paper: Boolean(b.paper) });

async function openPosition(b: BotRow, price: number, atr: number | null, master: TradeRow | null) {
  const amount = +b.amount;
  let fill: Fill;
  if (b.mode === 'live') fill = await liveBroker(b).marketBuy(b.symbol, amount);
  else fill = { orderId: '', qty: amount / price, price, fee: amount * PAPER_FEE };

  const p = fill.price;
  const stop = b.trailing_stop_pct && !b.stop_loss_pct ? p * (1 - +b.trailing_stop_pct / 100)
    : b.stop_loss_pct ? p * (1 - +b.stop_loss_pct / 100) : master?.stop_price ? +master.stop_price : atr ? p - 2 * atr : null;
  const target = b.take_profit_pct ? p * (1 + +b.take_profit_pct / 100) : master?.target_price ? +master.target_price : null;
  await withSystem(async c => {
    await c.query(`INSERT INTO bot_trades (bot_id, tenant_id, mode, symbol, qty, entry_price, entry_order, stop_price, target_price, fees)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                  [b.id, b.tenant_id, b.mode, b.symbol, fill.qty, p, fill.orderId || null, stop, target, fill.fee]);
  });
  if (b.tenant_id) await notify(b.tenant_id, 'robo', `${b.mode === 'live' ? '' : '[Simulado] '}Robô "${b.name}" COMPROU ${b.symbol}`,
    `Preço ${fmt(p)} · valor ${fmt(amount)}${stop ? ` · stop ${fmt(stop)}` : ''}${target ? ` · alvo ${fmt(target)}` : ''}`, b.market, b.symbol);
}

export async function closePosition(b: BotRow, t: TradeRow, price: number, reason: 'sinal' | 'stop' | 'alvo' | 'copia' | 'manual' | 'perda_diaria',
                                    client?: PoolClient) {
  let fill: Fill;
  if (t.mode === 'live') {
    if (!b.broker) throw new Error('Corretora desconectada: feche a posição direto na corretora.');
    fill = await liveBroker(b).marketSell(b.symbol, +t.qty);
  } else fill = { orderId: '', qty: +t.qty, price, fee: +t.qty * price * PAPER_FEE };
  const fees = +t.fees + fill.fee;
  const pnl = fill.qty * fill.price - +t.qty * +t.entry_price - fees;
  const sql = `UPDATE bot_trades SET status = 'closed', exit_price = $2, exit_at = now(), exit_order = $3, exit_reason = $4, fees = $5, pnl = $6
                WHERE id = $1 AND status = 'open'`;
  const args = [t.id, fill.price, fill.orderId || null, reason, fees, pnl];
  if (client) await client.query(sql, args); else await withSystem(c => c.query(sql, args));
  const label = { sinal: 'sinal de venda', stop: 'stop', alvo: 'alvo atingido', copia: 'estratégia copiada saiu', manual: 'fechada por você', perda_diaria: 'perda diária' }[reason];
  if (b.tenant_id) await notify(b.tenant_id, 'robo', `${t.mode === 'live' ? '' : '[Simulado] '}Robô "${b.name}" VENDEU ${b.symbol} (${label})`,
    `Preço ${fmt(fill.price)} · resultado ${pnl >= 0 ? '+' : ''}${fmt(pnl)} (${((fill.price / +t.entry_price - 1) * 100).toFixed(2)}%)`, b.market, b.symbol);
  if (reason !== 'manual') await dailyLossHit(b);
  return { pnl, price: fill.price };
}

/** Carrega um robô com a conexão (para fechar manualmente pela rota). */
export async function loadBot(id: string): Promise<BotRow | undefined> {
  return withSystem(async c => (await c.query<BotRow>(`${BOT_SQL} WHERE b.id = $1`, [id])).rows[0]);
}

const fmt = (n: number) => (Math.abs(n) >= 1 ? n.toFixed(2) : n.toPrecision(4));
