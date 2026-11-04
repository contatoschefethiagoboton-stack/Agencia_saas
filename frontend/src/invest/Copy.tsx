import { useLoad } from '../ui/useLoad';
import { chartLink, INTERVAL_LABEL, MARKET_LABEL, pct, symbolLabel, tone, type Interval, type Market } from './format';
import { Spinner, useStrategies } from './parts';

interface Master { id: string; name: string; market: Market; symbol: string; interval: Interval; strategy: string; public_description: string;
                   trades: number; wins: number; ret_30d: number; ret_total: number; posicionado: boolean; sigo: number; created_at: string }

/** Copy trade: estratégias operadas pela plataforma; o cliente replica as entradas e saídas na própria conta. */
export default function Copy() {
  const { data, error } = useLoad<Master[]>('/bots/copy/catalog');
  const { data: plan } = useLoad<{ copyTrade: boolean }>('/bots/plan');
  const strategies = useStrategies();
  return (
    <>
      <div className="page-head"><div><span className="eyebrow">Copie as jogadas</span><h1>Copy trade</h1></div></div>
      <p className="banner" style={{ margin: 0 }}>Cada estratégia abaixo é operada pela plataforma 24 horas. Ao copiar, um robô seu entra e sai junto com ela,
        com o <b>seu</b> valor por operação, o <b>seu</b> stop e na <b>sua</b> corretora (ou no simulado). Os números são do histórico real da estratégia, sem garantia de repetição.</p>
      {plan && !plan.copyTrade && <p className="msg warn">Copy trade não está incluído no seu plano atual.</p>}
      {error ? <p className="msg err">{error}</p> : !data ? <Spinner /> : !data.length
        ? <div className="card"><p className="card-sub" style={{ margin: 0 }}>Nenhuma estratégia publicada ainda. Volte em breve.</p></div>
        : <div className="bot-grid">{data.map(m => (
            <div key={m.id} className="card">
              <div className="card-head">
                <div><h2>{m.name}</h2><div className="card-sub"><a href={chartLink(m.market, m.symbol, `&interval=${m.interval}&strategy=${m.strategy}`)}>{symbolLabel(m.symbol, m.market)}</a>
                  {' · '}{MARKET_LABEL[m.market]} · {INTERVAL_LABEL[m.interval]} · {strategies.find(s => s.id === m.strategy)?.name ?? m.strategy}</div></div>
                {m.posicionado ? <span className="badge good">Posicionada agora</span> : <span className="badge">Aguardando sinal</span>}
              </div>
              <p style={{ margin: 0 }}>{m.public_description}</p>
              <div className="tiles tiles-3">
                <div className="tile"><span>Últimos 30 dias</span><b className={tone(m.ret_30d)}>{pct(m.ret_30d, 1)}</b></div>
                <div className="tile"><span>Desde o início</span><b className={tone(m.ret_total)}>{pct(m.ret_total, 1)}</b></div>
                <div className="tile"><span>Acerto</span><b>{m.trades ? `${((m.wins / m.trades) * 100).toFixed(0)}%` : '—'}</b><small className="card-sub">{m.trades} operações</small></div>
              </div>
              <div className="actions">
                {m.sigo ? <a className="btn" href="#robos">Você já copia ({m.sigo})</a> : null}
                <a className={`btn ${m.sigo ? '' : 'btn-primary'}`} aria-disabled={plan && !plan.copyTrade ? true : undefined}
                   href={`#robos?copy=${m.id}&name=${encodeURIComponent(m.name)}&market=${m.market}`}>Copiar esta estratégia</a>
              </div>
            </div>))}</div>}
    </>
  );
}
