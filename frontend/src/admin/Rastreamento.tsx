import { useState } from 'react';
import { api, dataHora } from '../api';
import { useLoad } from '../ui/useLoad';

interface Row { id: number; at: string; method: string; path: string; status: number; ms: number; ip: string; ua: string; impersonating: boolean; email: string | null; cliente: string | null }
interface Sum { online: number; chamadas24h: number; erros24h: number; ipsPorUsuario: { email: string; ips: number }[] }
interface Blocked { ip: string; at?: string; fails?: number; ttl: number }

/** Rastreamento: tudo o que cada usuário fez na plataforma (página, ação, IP, aparelho) + IPs bloqueados. */
export default function Rastreamento() {
  const [filtro, setFiltro] = useState({ ip: '', path: '' });
  const [q, setQ] = useState('');
  const { data, error } = useLoad<Row[]>(`/admin/access-log${q}`);
  const { data: sum } = useLoad<Sum>('/admin/access-summary');
  const { data: blocked, reload } = useLoad<Blocked[]>('/admin/security/blocked-ips');
  const buscar = (e: React.FormEvent) => {
    e.preventDefault();
    const p = new URLSearchParams(Object.entries(filtro).filter(([, v]) => v.trim()) as [string, string][]);
    setQ(p.toString() ? `?${p}` : '');
  };
  return (
    <>
      <header className="page-head"><div><span className="eyebrow">Administração</span><h1>Rastreamento</h1></div></header>
      <section className="grid-kpi">
        <article className="card kpi"><span className="kpi-label">Usuários online (15 min)</span><div className="kpi-value"><b>{sum?.online ?? '—'}</b></div></article>
        <article className="card kpi"><span className="kpi-label">Ações nas últimas 24h</span><div className="kpi-value"><b>{sum?.chamadas24h ?? '—'}</b></div></article>
        <article className="card kpi"><span className="kpi-label">Erros/recusas 24h</span><div className="kpi-value"><b>{sum?.erros24h ?? '—'}</b></div></article>
        <article className="card kpi"><span className="kpi-label">IPs bloqueados agora</span><div className="kpi-value"><b>{blocked?.length ?? '—'}</b></div></article>
      </section>
      <section className="row">
        <article className="card half">
          <h2>IPs bloqueados (tentativas de senha)</h2>
          {!blocked?.length ? <p className="card-sub">Nenhum IP bloqueado.</p> : blocked.map(b => (
            <div key={b.ip} className="net-item"><span><b className="mono">{b.ip}</b><br /><small className="card-sub">{b.fails} tentativas · libera em {Math.ceil(b.ttl / 60)} min</small></span>
              <button className="btn" onClick={async () => { await api(`/admin/security/blocked-ips/${encodeURIComponent(b.ip)}`, { method: 'DELETE' }); reload(); }}>Desbloquear</button></div>))}
        </article>
        <article className="card half">
          <h2>Contas usadas de muitos lugares (24h)</h2>
          <span className="card-sub">Mais de 2 IPs no mesmo dia pode indicar senha compartilhada ou roubada.</span>
          {!sum?.ipsPorUsuario.length ? <p className="card-sub">Nada suspeito.</p> : sum.ipsPorUsuario.map(u => <div key={u.email} className="net-item"><span>{u.email}</span><span className="badge warn">{u.ips} IPs</span></div>)}
        </article>
      </section>
      <section className="card">
        <form className="actions" onSubmit={buscar}>
          <input className="select" placeholder="Filtrar por IP" value={filtro.ip} onChange={e => setFiltro({ ...filtro, ip: e.target.value })} />
          <input className="select" placeholder="Filtrar por caminho (ex.: wallet)" value={filtro.path} onChange={e => setFiltro({ ...filtro, path: e.target.value })} />
          <button className="btn">Filtrar</button>
        </form>
        {error ? <p className="msg err">{error}</p> : !data ? <p className="card-sub">Carregando…</p> : (
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>Quando</th><th>Usuário</th><th>Ação</th><th className="n">Resultado</th><th>IP</th><th>Aparelho</th></tr></thead>
            <tbody>{data.map(r => (
              <tr key={r.id}>
                <td style={{ whiteSpace: 'nowrap' }}>{dataHora(r.at)}</td>
                <td>{r.email}{r.impersonating && <span className="badge warn" style={{ marginLeft: 6 }}>suporte</span>}<div className="card-sub">{r.cliente}</div></td>
                <td className="mono">{r.method} {r.path}</td>
                <td className="n"><span className={`badge ${r.status < 400 ? 'good' : r.status < 500 ? 'warn' : 'bad'}`}>{r.status}</span> <span className="card-sub">{r.ms} ms</span></td>
                <td className="mono"><button className="link-btn" onClick={() => { setFiltro({ ...filtro, ip: r.ip }); setQ(`?ip=${r.ip}`); }}>{r.ip}</button></td>
                <td className="card-sub" title={r.ua}>{r.ua.slice(0, 40)}</td>
              </tr>))}</tbody></table></div>)}
      </section>
    </>
  );
}
