import { useState } from 'react';
import { api } from '../api';
import { useLoad } from '../ui/useLoad';
import { useStrategies } from '../invest/parts';
import { INTERVAL_LABEL, INTERVALS, MARKET_LABEL, pct, tone, type Interval, type Market } from '../invest/format';

interface M { id: string; name: string; market: Market; symbol: string; interval: Interval; strategy: string; status: string; status_reason: string | null;
              public_description: string; seguidores: number; seguidores_reais: number; trades: number; wins: number; ret_total: number }

/** Estratégias master: a plataforma opera no simulado e os clientes copiam com a própria conta. */
export default function Masters() {
  const { data, error, reload } = useLoad<M[]>('/admin/masters');
  const strategies = useStrategies();
  const [f, setF] = useState({ name: '', market: 'crypto' as Market, symbol: 'BTCUSDT', interval: '1h' as Interval, strategy: 'score', stop: '3', take: '', description: '' });
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const n = (s: string) => (s.trim() ? Number(s.replace(',', '.')) : null);
  async function act(fn: () => Promise<unknown>, ok: string) {
    setMsg({});
    try { await fn(); setMsg({ ok }); reload(); } catch (e) { setMsg({ err: (e as Error).message }); }
  }
  return (
    <>
      <header className="page-head"><div><span className="eyebrow">Painel Master</span><h1>Estratégias de copy trade</h1></div></header>
      {msg.err && <p className="msg err">{msg.err}</p>}{msg.ok && <p className="msg ok">{msg.ok}</p>}
      <section className="card">
        <h2>Publicadas</h2>
        {error ? <p className="msg err">{error}</p> : !data ? <p className="card-sub">Carregando…</p> : !data.length ? <p className="card-sub">Nenhuma estratégia publicada.</p> : (
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>Estratégia</th><th>Ativo</th><th className="n">Operações</th><th className="n">Acerto</th><th className="n">Resultado</th><th className="n">Seguidores</th><th>Situação</th><th /></tr></thead>
            <tbody>{data.map(m => (
              <tr key={m.id}>
                <td><b>{m.name}</b><div className="card-sub">{strategies.find(s => s.id === m.strategy)?.name ?? m.strategy}</div></td>
                <td>{m.symbol}<div className="card-sub">{MARKET_LABEL[m.market]} · {INTERVAL_LABEL[m.interval]}</div></td>
                <td className="n">{m.trades}</td>
                <td className="n">{m.trades ? `${((m.wins / m.trades) * 100).toFixed(0)}%` : '—'}</td>
                <td className={`n ${tone(m.ret_total)}`}>{pct(m.ret_total, 1)}</td>
                <td className="n">{m.seguidores} ({m.seguidores_reais} reais)</td>
                <td><span className={`badge ${m.status === 'active' ? 'good' : m.status === 'error' ? 'bad' : ''}`}>{m.status === 'active' ? 'Publicada' : m.status === 'error' ? 'Erro' : 'Pausada'}</span>
                  {m.status_reason && <div className="card-sub down">{m.status_reason}</div>}</td>
                <td><div className="actions">
                  <button className="btn" onClick={() => act(() => api(`/admin/masters/${m.id}`, { method: 'PATCH', body: { status: m.status === 'active' ? 'paused' : 'active' } }), 'Atualizada.')}>
                    {m.status === 'active' ? 'Pausar' : 'Publicar'}</button>
                  <button className="link-btn" onClick={() => confirm(`Encerrar "${m.name}"? Os ${m.seguidores} robôs que copiam serão pausados.`) &&
                    act(() => api(`/admin/masters/${m.id}`, { method: 'DELETE' }), 'Estratégia encerrada.')}>Encerrar</button>
                </div></td>
              </tr>))}</tbody>
          </table></div>)}
      </section>
      <form className="card" onSubmit={e => { e.preventDefault(); act(() => api('/admin/masters', { body: { name: f.name, market: f.market, symbol: f.symbol, interval: f.interval,
          strategy: f.strategy, stopLossPct: n(f.stop), takeProfitPct: n(f.take), description: f.description } }), 'Estratégia publicada. Ela já aparece para os clientes em Copy trade.'); }}>
        <h2>Publicar nova estratégia</h2>
        <p className="card-sub" style={{ margin: 0 }}>Ela opera sempre no simulado (a plataforma não usa dinheiro). Cada cliente que copiar replica as entradas e saídas na própria conta.
          Rode o backtest no gráfico antes de publicar.</p>
        <div className="form-grid">
          <label className="field">Nome público<input required value={f.name} onChange={set('name')} placeholder="Tendência BTC 1h" /></label>
          <label className="field">Mercado<select value={f.market} onChange={set('market')}><option value="crypto">Cripto</option><option value="b3">B3</option><option value="us">EUA</option></select></label>
          <label className="field">Ativo<input required value={f.symbol} onChange={set('symbol')} /></label>
          <label className="field">Tempo gráfico<select value={f.interval} onChange={set('interval')}>{INTERVALS.map(i => <option key={i} value={i}>{INTERVAL_LABEL[i]}</option>)}</select></label>
          <label className="field">Estratégia<select value={f.strategy} onChange={set('strategy')}>{strategies.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <label className="field">Stop (%)<input inputMode="decimal" value={f.stop} onChange={set('stop')} /></label>
          <label className="field">Alvo (%)<input inputMode="decimal" value={f.take} onChange={set('take')} placeholder="vazio = sai no sinal" /></label>
        </div>
        <label className="field">Descrição para os clientes<textarea required minLength={10} value={f.description} onChange={set('description')}
          placeholder="Segue a tendência do Bitcoin no gráfico de 1 hora. Entra em rompimentos com volume e sai no stop de 3% ou no sinal de venda." /></label>
        <div className="actions"><button className="btn btn-primary">Publicar</button></div>
      </form>
    </>
  );
}
