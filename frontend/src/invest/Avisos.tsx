import { useEffect, useState } from 'react';
import { api } from '../api';
import { useLoad } from '../ui/useLoad';
import { ago, chartLink, MARKET_LABEL, price, symbolLabel, type Market } from './format';
import { Spinner } from './parts';

interface Alert { id: number; kind: 'sinal' | 'robo' | 'lancamento' | 'sistema'; title: string; body: string | null; market: Market | null; symbol: string | null; created_at: string; unread: boolean }
interface Settings { telegram_chat_id: string | null; on_signals: boolean; on_bots: boolean; on_listings: boolean }
const KIND: Record<Alert['kind'], string> = { sinal: 'Sinal', robo: 'Robô', lancamento: 'Lançamento', sistema: 'Sistema' };

export default function Avisos({ onRead }: { onRead: () => void }) {
  const { data, error } = useLoad<{ items: Alert[] }>('/market/alerts');
  const { data: st } = useLoad<{ telegram: boolean; telegramBot: string | null }>('/market/status');
  const { data: cfg } = useLoad<Settings>('/market/notify');
  const [s, setS] = useState<Settings | null>(null);
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  useEffect(() => { if (cfg) setS(cfg); }, [cfg]);
  useEffect(() => { if (data) api('/market/alerts/read', { body: {} }).then(onRead).catch(() => {}); }, [data, onRead]);

  async function save(test = false) {
    setMsg({});
    try {
      await api('/market/notify', { method: 'PUT', body: { telegramChatId: s!.telegram_chat_id || null, onSignals: s!.on_signals, onBots: s!.on_bots, onListings: s!.on_listings } });
      if (test) await api('/market/notify/test', { body: {} });
      setMsg({ ok: test ? 'Mensagem de teste enviada. Confira o Telegram.' : 'Preferências salvas.' });
    } catch (e) { setMsg({ err: (e as Error).message }); }
  }

  return (
    <>
      <div className="page-head"><div><span className="eyebrow">Não perca a hora</span><h1>Avisos</h1></div></div>
      <AlertasPreco />
      <div className="row">
        <div className="card wide">
          <h2>Últimos avisos</h2>
          {error ? <p className="msg err">{error}</p> : !data ? <Spinner /> : !data.items.length ? <p className="card-sub">Nenhum aviso ainda.</p> : (
            <div className="feed">{data.items.map(a => (
              <a key={a.id} className={`feed-item${a.unread ? ' unread' : ''}`} href={a.market && a.symbol ? chartLink(a.market, a.symbol) : undefined}>
                <span className={`feed-tag ${a.kind}`}>{KIND[a.kind]}</span>
                <div><b>{a.title}</b>{a.body && <div className="card-sub">{a.body}</div>}</div>
                <span className="card-sub">{ago(a.created_at)}</span>
              </a>))}</div>)}
        </div>
        <div className="card narrow">
          <h2>Receber no Telegram</h2>
          {!st?.telegram ? <p className="card-sub" style={{ margin: 0 }}>O administrador ainda não ativou os avisos por Telegram.</p> : !s ? <Spinner /> : <>
            <ol className="steps">
              <li>No Telegram, abra {st.telegramBot ? <a href={`https://t.me/${st.telegramBot}`} target="_blank" rel="noreferrer">@{st.telegramBot}</a> : 'o bot da plataforma'} e envie <b>/start</b>.</li>
              <li>Descubra o código do seu chat com o <a href="https://t.me/userinfobot" target="_blank" rel="noreferrer">@userinfobot</a> (o número "Id").</li>
              <li>Cole o número abaixo e clique em testar.</li>
            </ol>
            <label className="field">Código do chat<input inputMode="numeric" value={s.telegram_chat_id ?? ''} onChange={e => setS({ ...s, telegram_chat_id: e.target.value.trim() })} placeholder="123456789" /></label>
            <label className="check"><input type="checkbox" checked={s.on_signals} onChange={e => setS({ ...s, on_signals: e.target.checked })} /> Sinais de compra e venda da minha lista</label>
            <label className="check"><input type="checkbox" checked={s.on_bots} onChange={e => setS({ ...s, on_bots: e.target.checked })} /> Compras, vendas e erros dos meus robôs</label>
            <label className="check"><input type="checkbox" checked={s.on_listings} onChange={e => setS({ ...s, on_listings: e.target.checked })} /> Lançamentos de novas moedas e ativos</label>
            <div className="actions"><button className="btn" onClick={() => save(false)}>Salvar</button><button className="btn btn-primary" onClick={() => save(true)}>Salvar e testar</button></div>
            {msg.err && <p className="msg err">{msg.err}</p>}{msg.ok && <p className="msg ok">{msg.ok}</p>}
          </>}
        </div>
      </div>
    </>
  );
}

interface PA { id: string; market: Market; symbol: string; kind: 'above' | 'below' | 'up_pct' | 'down_pct'; value: number; base_price: number; note: string | null;
               active: boolean; triggered_at: string | null; triggered_price: number | null }
const KINDS: Record<PA['kind'], string> = { above: 'Subir acima de', below: 'Cair abaixo de', up_pct: 'Subir (%)', down_pct: 'Cair (%)' };

/** Alertas de preço: avisam uma vez quando o preço chega no valor escolhido. Conferidos a cada 20 segundos. */
export function AlertasPreco({ preset }: { preset?: { market: Market; symbol: string } }) {
  const { data, reload } = useLoad<PA[]>('/market/price-alerts');
  const { data: plan } = useLoad<{ priceAlerts: number }>('/bots/plan');
  const [f, setF] = useState({ market: preset?.market ?? 'crypto' as Market, symbol: preset?.symbol ?? 'BTCUSDT', kind: 'above' as PA['kind'], value: '', note: '' });
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  const ativos = data?.filter(a => a.active).length ?? 0;
  async function criar(e: React.FormEvent) {
    e.preventDefault(); setMsg({});
    try {
      const r = await api('/market/price-alerts', { body: { ...f, value: Number(f.value.replace(/\./g, '').replace(',', '.')), note: f.note || undefined } });
      setMsg({ ok: `Alerta criado. Preço agora: ${price(r.basePrice, f.market)}.` }); setF({ ...f, value: '', note: '' }); reload();
    } catch (x) { setMsg({ err: (x as Error).message }); }
  }
  return (
    <div className="card">
      <div className="card-head"><h2>Alertas de preço</h2>
        <span className="card-sub">{ativos} ativo(s){plan ? ` · seu plano: ${plan.priceAlerts < 0 ? 'ilimitados' : plan.priceAlerts}` : ''}</span></div>
      <form className="form-grid" onSubmit={criar}>
        {!preset && <>
          <label className="field">Mercado<select value={f.market} onChange={e => setF({ ...f, market: e.target.value as Market })}><option value="crypto">Cripto</option><option value="b3">B3</option><option value="us">EUA</option></select></label>
          <label className="field">Ativo<input required value={f.symbol} onChange={e => setF({ ...f, symbol: e.target.value.toUpperCase() })} /></label>
        </>}
        <label className="field">Avisar quando<select value={f.kind} onChange={e => setF({ ...f, kind: e.target.value as PA['kind'] })}>
          {Object.entries(KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label className="field">{f.kind.endsWith('pct') ? 'Percentual' : 'Preço'}<input required inputMode="decimal" value={f.value} onChange={e => setF({ ...f, value: e.target.value })} /></label>
        <label className="field">Anotação (opcional)<input maxLength={120} value={f.note} onChange={e => setF({ ...f, note: e.target.value })} placeholder="ex.: hora de vender metade" /></label>
        <div className="actions" style={{ alignSelf: 'end' }}><button className="btn btn-primary">Criar alerta</button></div>
      </form>
      {msg.err && <p className="msg err">{msg.err}</p>}{msg.ok && <p className="msg ok">{msg.ok}</p>}
      {!!data?.length && !preset && (
        <div className="table-wrap"><table className="tbl">
          <thead><tr><th>Ativo</th><th>Condição</th><th className="n">Preço na criação</th><th>Situação</th><th /></tr></thead>
          <tbody>{data.map(a => (
            <tr key={a.id}>
              <td><a href={chartLink(a.market, a.symbol)}>{symbolLabel(a.symbol, a.market)}</a> <span className="card-sub">{MARKET_LABEL[a.market]}</span>{a.note && <div className="card-sub">{a.note}</div>}</td>
              <td>{KINDS[a.kind]} {a.kind.endsWith('pct') ? `${a.value}%` : price(a.value, a.market)}</td>
              <td className="n">{price(a.base_price, a.market)}</td>
              <td>{a.active ? <span className="badge warn">Aguardando</span> : <span className="badge good">Disparou {a.triggered_at ? ago(a.triggered_at) : ''} a {price(a.triggered_price, a.market)}</span>}</td>
              <td className="n"><button className="link-btn" onClick={async () => { await api(`/market/price-alerts/${a.id}`, { method: 'DELETE' }); reload(); }}>Apagar</button></td>
            </tr>))}</tbody></table></div>)}
    </div>
  );
}
