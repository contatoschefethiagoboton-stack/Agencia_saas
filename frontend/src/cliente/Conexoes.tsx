import { useEffect, useState } from 'react';
import { api, dataHora } from '../api';
import { useLoad } from '../ui/useLoad';

interface Conn { provider: string; external_id: string; name: string | null; expires_at: string | null; connected_at: string }
interface Pending { pages: { id: string; name: string; instagram: string | null }[]; adAccounts: { id: string; name: string; currency: string; status: number }[] }

const NOMES: Record<string, string> = { facebook: 'Página do Facebook', instagram: 'Instagram profissional', meta_ads: 'Conta de anúncios (Meta Ads)',
                                        google_business: 'Google Meu Negócio' };

/** Conecta Facebook, Instagram e Meta Ads pelo login oficial da Meta. */
export default function Conexoes({ query, isOwner }: { query: URLSearchParams; isOwner: boolean }) {
  const conns = useLoad<Conn[]>('/client/connections');
  const features = useLoad<{ meta: boolean; google: boolean }>('/client/features');
  const nonce = query.get('meta');
  const gNonce = query.get('google');
  const [gPending, setGPending] = useState<{ id: string; title: string; address: string }[] | null>(null);
  const [gPick, setGPick] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [pick, setPick] = useState({ pageId: '', adAccountId: '' });
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err' | 'warn'; text: string } | null>(
    query.get('erro') ? { kind: 'err', text: query.get('erro')! } : null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!nonce) return;
    api<Pending>(`/client/connect/meta/pending/${nonce}`).then(p => {
      setPending(p);
      setPick({ pageId: p.pages.length === 1 ? p.pages[0].id : '', adAccountId: p.adAccounts.length === 1 ? p.adAccounts[0].id : '' });
    }).catch(e => setMsg({ kind: 'err', text: e.message }));
  }, [nonce]);

  useEffect(() => {
    if (!gNonce) return;
    api<{ locations: { id: string; title: string; address: string }[] }>(`/client/connect/google/pending/${gNonce}`)
      .then(r => { setGPending(r.locations); if (r.locations.length === 1) setGPick(r.locations[0].id); })
      .catch(e => setMsg({ kind: 'err', text: e.message }));
  }, [gNonce]);

  async function startGoogle() {
    setBusy(true); setMsg(null);
    try { location.href = (await api<{ url: string }>('/client/connect/google/start', { body: {} })).url; }
    catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); setBusy(false); }
  }

  async function confirmGoogle() {
    setBusy(true);
    try {
      await api('/client/connect/google/select', { body: { n: gNonce, locationId: gPick } });
      setMsg({ kind: 'ok', text: 'Google Meu Negócio conectado! Os posts do Google aprovados passam a ser publicados no horário.' });
      setGPending(null); location.hash = '#conexoes'; conns.reload();
    } catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); }
    finally { setBusy(false); }
  }

  async function start() {
    setBusy(true); setMsg(null);
    try { location.href = (await api<{ url: string }>('/client/connect/meta/start', { body: {} })).url; }
    catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); setBusy(false); }
  }

  async function confirmSelection() {
    setBusy(true);
    try {
      const r = await api('/client/connect/meta/select', { body: { n: nonce, pageId: pick.pageId, adAccountId: pick.adAccountId || undefined } });
      setMsg(r.avisoInstagram ? { kind: 'warn', text: `Facebook conectado. ${r.avisoInstagram}` } : { kind: 'ok', text: 'Tudo conectado! Os conteúdos aprovados passam a ser publicados no horário e os números reais aparecem no Painel.' });
      setPending(null); location.hash = '#conexoes'; conns.reload();
    } catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); }
    finally { setBusy(false); }
  }

  async function disconnect(provider: string) {
    if (!window.confirm(`Desconectar ${NOMES[provider] ?? provider}? As publicações automáticas nesse canal param.`)) return;
    try { await api(`/client/connections/${provider}`, { method: 'DELETE' }); conns.reload(); }
    catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); }
  }

  return (
    <>
      <header className="page-head"><div><span className="eyebrow">Redes sociais e anúncios</span><h1>Conexões</h1></div></header>
      {msg && <p className={`msg ${msg.kind}`} role="status">{msg.text}</p>}

      {pending && (
        <section className="card" style={{ borderColor: 'var(--accent)' }}>
          <h2>Escolha o que conectar</h2>
          <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 10 }}>
            <legend className="card-sub" style={{ marginBottom: 8 }}>Página do Facebook (o Instagram vinculado a ela vem junto)</legend>
            {pending.pages.map(p => (
              <label key={p.id} className="tile" style={{ flexDirection: 'row', alignItems: 'center', gap: 12, cursor: 'pointer' }}>
                <input type="radio" name="page" checked={pick.pageId === p.id} onChange={() => setPick({ ...pick, pageId: p.id })} />
                <span style={{ fontSize: 15, color: 'var(--text)' }}><b>{p.name}</b> · {p.instagram ? `Instagram @${p.instagram}` : 'sem Instagram vinculado'}</span>
              </label>))}
          </fieldset>
          {pending.adAccounts.length > 0 && (
            <label className="field">Conta de anúncios (opcional)
              <select value={pick.adAccountId} onChange={e => setPick({ ...pick, adAccountId: e.target.value })}>
                <option value="">Não conectar anúncios agora</option>
                {pending.adAccounts.map(a => <option key={a.id} value={a.id}>{a.name} ({a.currency}){a.status !== 1 ? ' — inativa' : ''}</option>)}
              </select></label>)}
          <div className="actions"><button className="btn btn-primary" disabled={!pick.pageId || busy} onClick={confirmSelection}>{busy ? 'Conectando…' : 'Confirmar'}</button></div>
        </section>
      )}

      {gPending && (
        <section className="card" style={{ borderColor: 'var(--accent)' }}>
          <h2>Qual perfil do Google?</h2>
          <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 10 }}>
            <legend className="sr">Perfis de empresa encontrados</legend>
            {gPending.map(l => (
              <label key={l.id} className="tile" style={{ flexDirection: 'row', alignItems: 'center', gap: 12, cursor: 'pointer' }}>
                <input type="radio" name="gloc" checked={gPick === l.id} onChange={() => setGPick(l.id)} />
                <span style={{ fontSize: 15, color: 'var(--text)' }}><b>{l.title}</b>{l.address ? ` · ${l.address}` : ''}</span>
              </label>))}
          </fieldset>
          <div className="actions"><button className="btn btn-primary" disabled={!gPick || busy} onClick={confirmGoogle}>{busy ? 'Conectando…' : 'Confirmar'}</button></div>
        </section>
      )}

      <section className="card">
        <div className="card-head" style={{ alignItems: 'center' }}>
          <div><h2>Google Meu Negócio</h2>
            <span className="card-sub">Publica as novidades do calendário no seu perfil do Google (aparece na busca e no Maps).</span></div>
          {isOwner && features.data?.google && <button className="btn btn-primary" disabled={busy} onClick={startGoogle}>
            {conns.data?.some(c => c.provider === 'google_business') ? 'Reconectar' : 'Conectar com Google'}</button>}
        </div>
        {features.data && !features.data.google && <p className="card-sub">A agência ainda está ativando esta integração.</p>}
        {conns.data?.filter(c => c.provider === 'google_business').map(c => (
          <div key={c.provider} className="actions" style={{ justifyContent: 'space-between' }}>
            <span><b>{c.name}</b> <span className="card-sub">· desde {dataHora(c.connected_at)}</span></span>
            {isOwner && <button className="btn" onClick={() => disconnect(c.provider)}>Desconectar</button>}
          </div>))}
      </section>

      <section className="card">
        <div className="card-head" style={{ alignItems: 'center' }}>
          <div><h2>Facebook, Instagram e Meta Ads</h2>
            <span className="card-sub">Login oficial da Meta. A plataforma nunca vê sua senha; você pode remover o acesso quando quiser.</span></div>
          {isOwner && <button className="btn btn-primary" disabled={busy} onClick={start}>{conns.data?.some(c => c.provider !== 'google_business') ? 'Reconectar' : 'Conectar com Facebook'}</button>}
        </div>
        {conns.data?.some(c => c.provider !== 'google_business') ? (
          <div className="table-wrap"><table className="tbl">
            <tbody>{conns.data.filter(c => c.provider !== 'google_business').map(c => (
              <tr key={c.provider}><td><b>{NOMES[c.provider] ?? c.provider}</b></td><td>{c.name ?? c.external_id}</td>
                <td className="card-sub">desde {dataHora(c.connected_at)}{c.expires_at ? ` · renovar até ${dataHora(c.expires_at)}` : ''}</td>
                <td>{isOwner && <button className="btn" onClick={() => disconnect(c.provider)}>Desconectar</button>}</td></tr>))}
            </tbody></table></div>
        ) : <p className="card-sub">Nada conectado ainda.</p>}
        {!isOwner && <p className="card-sub">Só o responsável pela conta pode conectar ou desconectar.</p>}
      </section>

      <section className="banner">
        <b>Antes de conectar:</b> o Instagram precisa ser <b>profissional</b> (empresa ou criador) e estar <b>vinculado a uma Página do Facebook</b>.
        No app do Instagram: Configurações → Tipo de conta → Mudar para conta profissional → Conectar Página.
      </section>
    </>
  );
}
