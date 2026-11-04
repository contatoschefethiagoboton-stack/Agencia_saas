import { useEffect, useState } from 'react';
import { api } from '../api';
import { useLoad } from '../ui/useLoad';
import { ago, chartLink, type Market } from './format';
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
