import { withSystem } from './db.js';

/*
 * Alertas: ficam na central de avisos da plataforma e, se o cliente cadastrou, vão também para o Telegram.
 * tenantId NULL = aviso geral (ex.: nova moeda listada), entregue a quem marcou "lançamentos".
 */
export type AlertKind = 'sinal' | 'robo' | 'lancamento' | 'sistema';
const PREF: Record<AlertKind, string> = { sinal: 'on_signals', robo: 'on_bots', lancamento: 'on_listings', sistema: 'on_bots' };

export async function notify(tenantId: string | null, kind: AlertKind, title: string, body?: string, market?: string, symbol?: string) {
  const chats = await withSystem(async c => {
    await c.query(`INSERT INTO alerts (tenant_id, kind, title, body, market, symbol) VALUES ($1, $2, $3, $4, $5, $6)`,
                  [tenantId, kind, title, body ?? null, market ?? null, symbol ?? null]);
    if (!process.env.TELEGRAM_BOT_TOKEN) return [];
    return (await c.query(`SELECT n.telegram_chat_id FROM notify_settings n JOIN tenants t ON t.id = n.tenant_id JOIN plans p ON p.id = t.plan
                            WHERE n.telegram_chat_id IS NOT NULL AND n.${PREF[kind]} AND ($1::uuid IS NULL OR n.tenant_id = $1)
                              AND t.status = 'active' AND (p.telegram OR t.vip)`, [tenantId])).rows
      .map(r => r.telegram_chat_id as string);
  });
  for (const chat of chats) void sendTelegram(chat, `<b>${esc(title)}</b>${body ? `\n${esc(body)}` : ''}`).catch(() => {});
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function sendTelegram(chatId: string, html: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw Object.assign(new Error('Avisos por Telegram ainda não foram ativados pelo administrador (TELEGRAM_BOT_TOKEN)'), { status: 503 });
  const base = (process.env.TELEGRAM_API_URL ?? 'https://api.telegram.org').replace(/\/$/, '');
  const r = await fetch(`${base}/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (!r.ok) throw Object.assign(new Error('O Telegram recusou: confira o código do chat e se você mandou /start para o bot'), { status: 400 });
}
