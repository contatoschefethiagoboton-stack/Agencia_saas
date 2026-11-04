import { useLoad } from '../ui/useLoad';
import { ago, chartLink, MARKET_LABEL, type Market } from './format';
import { Spinner } from './parts';

interface Item { id: number; title: string; body: string; market: Market; symbol: string; created_at: string }

/** Lançamentos: moedas novas na Binance e ativos novos na B3, detectados pelo radar a cada 5 minutos. */
export default function Radar() {
  const { data, error } = useLoad<Item[]>('/market/listings');
  return (
    <>
      <div className="page-head"><div><span className="eyebrow">Radar 24h</span><h1>Lançamentos</h1></div></div>
      <div className="card">
        <p className="card-sub" style={{ margin: 0 }}>A plataforma confere a lista completa da Binance e da B3 a cada 5 minutos. Quando aparece uma moeda ou ativo novo,
          ele entra aqui e você recebe um aviso (ative em <a href="#avisos">Avisos</a>). Atenção: lançamentos costumam ter alta volatilidade e pouca liquidez nos primeiros dias.</p>
        {error ? <p className="msg err">{error}</p> : !data ? <Spinner /> : !data.length
          ? <p className="banner">Nenhum lançamento detectado ainda. Na primeira volta o radar só memoriza a lista atual; a partir daí, tudo que for listado aparece aqui.</p>
          : <div className="feed">{data.map(i => (
              <a key={i.id} className="feed-item" href={chartLink(i.market, i.symbol, i.market === 'crypto' ? '&interval=15m' : '')}>
                <span className={`feed-tag ${i.market}`}>{MARKET_LABEL[i.market]}</span>
                <div><b>{i.title}</b><div className="card-sub">{i.body}</div></div>
                <span className="card-sub">{ago(i.created_at)}</span>
              </a>))}</div>}
      </div>
    </>
  );
}
