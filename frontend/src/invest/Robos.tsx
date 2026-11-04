import { useEffect, useState } from 'react';
import { api } from '../api';
import { useStepUp } from '../auth/StepUp';
import { useLoad } from '../ui/useLoad';
import { ago, chartLink, INTERVAL_LABEL, INTERVALS, MARKET_LABEL, money, pct, price, signed, symbolLabel, tone, type Interval, type Market } from './format';
import { Spinner, useStrategies } from './parts';

export interface Bot {
  id: string; name: string; market: Market; symbol: string; interval: Interval; strategy: string; mode: 'paper' | 'live'; amount: number;
  stop_loss_pct: number | null; take_profit_pct: number | null; max_daily_loss: number | null; trailing_stop_pct: number | null; status: 'active' | 'paused' | 'error'; status_reason: string | null;
  copy_of: string | null; copy_name: string | null; last_tick_at: string | null; pnl_total: number; pnl_today: number; trades: number; wins: number;
  open_trade: { qty: number; entry_price: number; entry_at: string; stop_price: number | null; target_price: number | null } | null;
}
interface Trade { id: string; mode: string; qty: number; entry_price: number; entry_at: string; exit_price: number | null; exit_at: string | null;
                  exit_reason: string | null; pnl: number | null; status: string }
interface Conn { id: string; broker: 'binance' | 'alpaca'; label: string; status: string; paper: boolean }
interface Plan { name: string; maxBots: number; liveTrading: boolean; copyTrade: boolean }

const STATUS: Record<Bot['status'], [string, string]> = { active: ['Ligado', 'good'], paused: ['Pausado', ''], error: ['Erro', 'bad'] };

export default function Robos({ query }: { query: URLSearchParams }) {
  const { data: bots, error, reload } = useLoad<Bot[]>('/bots');
  const { data: plan } = useLoad<Plan>('/bots/plan');
  const [creating, setCreating] = useState(query.get('novo') === '1' || Boolean(query.get('copy')));
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  const guard = useStepUp();
  const strategies = useStrategies();

  useEffect(() => { const t = setInterval(reload, 20_000); return () => clearInterval(t); }, [reload]);   // acompanha o motor (20 s)

  async function act(fn: () => Promise<unknown>, ok: string) {
    setMsg({});
    try { await guard(fn); setMsg({ ok }); reload(); } catch (e) { setMsg({ err: (e as Error).message }); }
  }
  const total = bots?.reduce((a, b) => a + b.pnl_total, 0) ?? 0;
  const today = bots?.reduce((a, b) => a + b.pnl_today, 0) ?? 0;
  const active = bots?.filter(b => b.status === 'active').length ?? 0;
  const trades = bots?.reduce((a, b) => a + b.trades, 0) ?? 0, wins = bots?.reduce((a, b) => a + b.wins, 0) ?? 0;

  return (
    <>
      <div className="page-head">
        <div><span className="eyebrow">Operação automática</span><h1>Robôs</h1></div>
        <button className="btn btn-primary" onClick={() => setCreating(c => !c)}>{creating ? 'Fechar' : 'Novo robô'}</button>
      </div>
      <div className="grid-kpi">
        <div className="card kpi"><span className="kpi-label">Robôs ligados</span><div className="kpi-value"><b>{active}</b><span className="card-sub">de {plan?.maxBots ?? '—'} no plano {plan?.name ?? ''}</span></div></div>
        <div className="card kpi"><span className="kpi-label">Resultado hoje</span><div className="kpi-value"><b className={tone(today)}>{signed(today)}</b></div></div>
        <div className="card kpi"><span className="kpi-label">Resultado acumulado</span><div className="kpi-value"><b className={tone(total)}>{signed(total)}</b></div></div>
        <div className="card kpi"><span className="kpi-label">Taxa de acerto</span><div className="kpi-value"><b>{trades ? `${((wins / trades) * 100).toFixed(0)}%` : '—'}</b><span className="card-sub">{trades} operações</span></div></div>
      </div>
      {msg.err && <p className="msg err" role="alert">{msg.err}</p>}
      {msg.ok && <p className="msg ok" role="status">{msg.ok}</p>}
      {creating && plan && <NovoRobo query={query} plan={plan} onDone={() => { setCreating(false); location.hash = '#robos'; reload(); }} />}

      {error ? <p className="msg err">{error}</p> : !bots ? <Spinner /> : !bots.length ? (
        <div className="card"><h2>Nenhum robô ainda</h2>
          <p className="card-sub" style={{ margin: 0 }}>Comece no <b>modo simulado</b>: o robô opera com dinheiro de mentira, no preço real, para você ver como a estratégia se sai
            antes de arriscar. Abra um <a href="#grafico">gráfico</a>, rode o backtest e clique em "Criar robô com esta estratégia", ou copie uma estratégia em <a href="#copy">Copy trade</a>.</p></div>
      ) : (
        <div className="bot-grid">{bots.map(b => {
          const ot = b.open_trade;
          const strat = b.copy_of ? `Copiando: ${b.copy_name ?? 'estratégia encerrada'}` : strategies.find(s => s.id === b.strategy)?.name ?? b.strategy;
          return (
            <div key={b.id} className={`card bot-card ${b.status}`}>
              <div className="card-head">
                <div style={{ minWidth: 0 }}>
                  <h2>{b.name}</h2>
                  <div className="card-sub"><a href={chartLink(b.market, b.symbol, `&interval=${b.interval}&strategy=${b.strategy}`)}>{symbolLabel(b.symbol, b.market)}</a>
                    {' · '}{MARKET_LABEL[b.market]} · {INTERVAL_LABEL[b.interval]} · {strat}</div>
                </div>
                <div className="actions">
                  <span className={`badge ${b.mode === 'live' ? 'warn' : ''}`}>{b.mode === 'live' ? 'DINHEIRO REAL' : 'Simulado'}</span>
                  <span className={`badge ${STATUS[b.status][1]}`}>{STATUS[b.status][0]}</span>
                </div>
              </div>
              {b.status_reason && <p className={`msg ${b.status === 'error' ? 'err' : 'warn'}`} style={{ margin: 0 }}>{b.status_reason}</p>}
              <div className="tiles tiles-3">
                <div className="tile"><span>Por operação</span><b>{money(b.amount, b.market)}</b></div>
                <div className="tile"><span>Resultado</span><b className={tone(b.pnl_total)}>{signed(b.pnl_total)}</b></div>
                <div className="tile"><span>Acerto</span><b>{b.trades ? `${((b.wins / b.trades) * 100).toFixed(0)}%` : '—'}</b><small className="card-sub">{b.trades} operações</small></div>
              </div>
              <div className="position">
                {ot ? <>
                  <b className="up">Comprado</b> desde {ago(ot.entry_at)} a {price(ot.entry_price, b.market)}
                  {ot.stop_price && <> · stop {price(ot.stop_price, b.market)}</>}{ot.target_price && <> · alvo {price(ot.target_price, b.market)}</>}
                </> : <span className="card-sub">Sem posição: {b.status === 'active' ? 'esperando o próximo sinal de compra' : 'robô parado'}.</span>}
              </div>
              <div className="card-sub">Proteções: {b.trailing_stop_pct ? `stop móvel ${b.trailing_stop_pct}% · ` : ''}stop {b.stop_loss_pct ? `${b.stop_loss_pct}%` : b.trailing_stop_pct ? 'móvel' : 'pela volatilidade'} · alvo {b.take_profit_pct ? `${b.take_profit_pct}%` : 'pelo sinal de venda'}
                {' · '}perda máx./dia {b.max_daily_loss ? money(b.max_daily_loss, b.market) : 'sem limite'}{b.last_tick_at ? ` · conferido ${ago(b.last_tick_at)}` : ''}</div>
              <div className="actions">
                {b.status === 'active'
                  ? <button className="btn" onClick={() => act(() => api(`/bots/${b.id}`, { method: 'PATCH', body: { status: 'paused' } }), `${b.name} pausado.`)}>Pausar</button>
                  : <button className="btn btn-good" onClick={() => act(() => api(`/bots/${b.id}`, { method: 'PATCH', body: { status: 'active' } }), `${b.name} ligado.`)}>Ligar</button>}
                {ot && <button className="btn btn-danger" onClick={() => confirm(`Vender agora a posição de ${b.symbol}${b.mode === 'live' ? ' na corretora (dinheiro real)' : ''}?`) &&
                  act(() => api(`/bots/${b.id}/close`, { body: {} }), 'Posição fechada.')}>Vender agora</button>}
                <button className="btn" onClick={() => setOpen(open === b.id ? null : b.id)}>{open === b.id ? 'Esconder operações' : 'Operações'}</button>
                {!ot && <button className="link-btn" onClick={() => confirm(`Apagar o robô ${b.name}?`) && act(() => api(`/bots/${b.id}`, { method: 'DELETE' }), 'Robô apagado.')}>Apagar</button>}
              </div>
              {open === b.id && <Trades bot={b} />}
            </div>);
        })}</div>
      )}
    </>
  );
}

function Trades({ bot }: { bot: Bot }) {
  const { data } = useLoad<Trade[]>(`/bots/${bot.id}/trades`);
  const reason: Record<string, string> = { sinal: 'sinal', stop: 'stop', alvo: 'alvo', copia: 'cópia', manual: 'manual', perda_diaria: 'perda diária' };
  if (!data) return <Spinner />;
  if (!data.length) return <p className="card-sub">Nenhuma operação ainda.</p>;
  return (
    <div className="table-wrap"><table className="tbl">
      <thead><tr><th>Entrada</th><th className="n">Preço</th><th>Saída</th><th className="n">Preço</th><th className="n">Variação</th><th className="n">Resultado</th><th>Motivo</th></tr></thead>
      <tbody>{data.map(t => {
        const v = t.exit_price ? (t.exit_price / t.entry_price - 1) * 100 : null;
        return (
          <tr key={t.id}>
            <td>{new Date(t.entry_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</td>
            <td className="n">{price(t.entry_price, bot.market)}</td>
            <td>{t.exit_at ? new Date(t.exit_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : <span className="badge good">aberta</span>}</td>
            <td className="n">{price(t.exit_price, bot.market)}</td>
            <td className={`n ${tone(v)}`}>{pct(v)}</td>
            <td className={`n ${tone(t.pnl)}`}>{signed(t.pnl)}</td>
            <td>{t.exit_reason ? reason[t.exit_reason] : ''}</td>
          </tr>);
      })}</tbody>
    </table></div>
  );
}

function NovoRobo({ query, plan, onDone }: { query: URLSearchParams; plan: Plan; onDone: () => void }) {
  const strategies = useStrategies();
  const { data: conns } = useLoad<Conn[]>('/bots/connections');
  const copyOf = query.get('copy');
  const [f, setF] = useState({
    name: query.get('name') ?? (query.get('symbol') ? `Robô ${query.get('symbol')}` : ''),
    market: (query.get('market') as Market) || 'crypto', symbol: query.get('symbol') ?? 'BTCUSDT',
    interval: (query.get('interval') as Interval) || '1h', strategy: query.get('strategy') ?? 'inteligente', trail: query.get('strategy') && query.get('strategy') !== 'inteligente' ? '' : '3',
    mode: 'paper' as 'paper' | 'live', connectionId: '', amount: '100', stop: query.get('stop') ?? '3', take: query.get('take') ?? '', maxLoss: '',
  });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const guard = useStepUp();
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const n = (s: string) => (s.trim() ? Number(s.replace(',', '.')) : null);
  const brokerFor: Record<Market, string | null> = { crypto: 'binance', us: 'alpaca', b3: null };
  const usable = (conns ?? []).filter(c => c.broker === brokerFor[f.market] && c.status === 'ok');

  async function save(e: React.FormEvent) {
    e.preventDefault(); setErr('');
    if (f.mode === 'live' && !confirm(`Este robô vai operar com DINHEIRO REAL na sua corretora, ${f.amount} por operação. Resultados passados não garantem lucro e você pode perder dinheiro. Confirmar?`)) return;
    setBusy(true);
    try {
      const body = { name: f.name, mode: f.mode, amount: n(f.amount), connectionId: f.mode === 'live' ? f.connectionId || null : null,
                     stopLossPct: n(f.stop), takeProfitPct: n(f.take), maxDailyLoss: n(f.maxLoss), trailingStopPct: n(f.trail),
                     ...(copyOf ? { copyOf } : { market: f.market, symbol: f.symbol, interval: f.interval, strategy: f.strategy }) };
      const r = await guard(() => api<{ id: string }>('/bots', { body }));
      await guard(() => api(`/bots/${r.id}`, { method: 'PATCH', body: { status: 'active' } }));
      onDone();
    } catch (e2) { setErr((e2 as Error).message); }
    setBusy(false);
  }

  return (
    <form className="card" onSubmit={save}>
      <h2>{copyOf ? `Copiar estratégia: ${query.get('name') ?? ''}` : 'Novo robô'}</h2>
      <div className="form-grid">
        <label className="field">Nome<input required minLength={2} value={f.name} onChange={set('name')} placeholder="Robô BTC 1h" /></label>
        {!copyOf && <>
          <label className="field">Mercado<select value={f.market} onChange={set('market')}><option value="crypto">Cripto</option><option value="b3">B3 (só simulado)</option><option value="us">EUA</option></select></label>
          <label className="field">Ativo<input required value={f.symbol} onChange={set('symbol')} /></label>
          <label className="field">Tempo gráfico<select value={f.interval} onChange={set('interval')}>{INTERVALS.map(i => <option key={i} value={i}>{INTERVAL_LABEL[i]}</option>)}</select></label>
          <label className="field">Estratégia<select value={f.strategy} onChange={set('strategy')}>{strategies.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        </>}
        <label className="field">Modo<select value={f.mode} onChange={set('mode')}>
          <option value="paper">Simulado (dinheiro de mentira)</option>
          <option value="live" disabled={!plan.liveTrading || f.market === 'b3'}>Dinheiro real{!plan.liveTrading ? ' (não incluso no plano)' : ''}</option></select></label>
        {f.mode === 'live' && <label className="field">Corretora<select required value={f.connectionId} onChange={set('connectionId')}>
          <option value="">Escolha…</option>{usable.map(c => <option key={c.id} value={c.id}>{c.label}{c.paper ? ' (papel)' : ''}</option>)}</select>
          {!usable.length && <small>Nenhuma corretora deste mercado conectada. <a href="#corretoras">Conectar</a></small>}</label>}
        <label className="field">Valor por operação<input required inputMode="decimal" value={f.amount} onChange={set('amount')} /><small>{f.market === 'crypto' ? 'em USDT' : f.market === 'us' ? 'em US$' : 'em R$'}</small></label>
        <label className="field">Stop (% de perda)<input inputMode="decimal" value={f.stop} onChange={set('stop')} placeholder="vazio = pela volatilidade" /></label>
        <label className="field">Alvo (% de ganho)<input inputMode="decimal" value={f.take} onChange={set('take')} placeholder="vazio = sai no sinal" /></label>
        <label className="field">Stop móvel (%)<input inputMode="decimal" value={f.trail} onChange={set('trail')} placeholder="ex.: 3" /><small>Sobe junto com o preço; vende quando cair essa % do topo</small></label>
        <label className="field">Perda máxima por dia<input inputMode="decimal" value={f.maxLoss} onChange={set('maxLoss')} placeholder="ex.: 50" /><small>Atingiu: o robô pausa sozinho</small></label>
      </div>
      {f.mode === 'live' && <p className="msg warn" style={{ margin: 0 }}>Dinheiro real: a ordem é enviada à sua corretora com a sua chave. Ligar o robô pede o código do autenticador.</p>}
      {err && <p className="msg err" role="alert">{err}</p>}
      <div className="actions"><button className="btn btn-primary" disabled={busy}>{busy ? 'Criando…' : 'Criar e ligar robô'}</button></div>
    </form>
  );
}
