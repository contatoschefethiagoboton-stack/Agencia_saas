import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, dataHora } from '../api';
import { useLoad } from '../ui/useLoad';
import { BrandMark, Icon } from '../ui/Icon';
import { openLoginWindow, goToLogin, cancelLogin } from '../ui/oauthPopup';

type Net = 'meta' | 'google' | 'tiktok';
const REDE: Record<Net, string> = { meta: 'Meta (Facebook e Instagram)', google: 'Google', tiktok: 'TikTok' };

interface Conn { provider: string; external_id: string; name: string | null; expires_at: string | null; connected_at: string;
                 needs_reconnect: boolean; last_error: string | null; expiring: boolean }
const saude = (c: Conn) => c.needs_reconnect ? <span className="badge bad" title={c.last_error ?? ''}>Reconectar</span>
  : c.expiring ? <span className="badge warn">Vence em breve</span> : <span className="badge good">Ok</span>;
interface Pending { pages: { id: string; name: string; instagram: string | null }[]; adAccounts: { id: string; name: string; currency: string; status: number }[] }

const NOMES: Record<string, string> = { facebook: 'Página do Facebook', instagram: 'Instagram profissional', meta_ads: 'Conta de anúncios (Meta Ads)',
                                        google_business: 'Google Meu Negócio', tiktok: 'TikTok' };

/** Conecta Facebook, Instagram e Meta Ads pelo login oficial da Meta. */
export default function Conexoes({ query, isOwner }: { query: URLSearchParams; isOwner: boolean }) {
  const conns = useLoad<Conn[]>('/client/connections');
  const features = useLoad<{ meta: boolean; google: boolean; tiktok: boolean }>('/client/features');
  const nonce = query.get('meta');
  const gNonce = query.get('google');
  const [gPending, setGPending] = useState<{ id: string; title: string; address: string }[] | null>(null);
  const [gPick, setGPick] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [pick, setPick] = useState({ pageId: '', adAccountId: '' });
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err' | 'warn'; text: string } | null>(
    query.get('erro') ? { kind: 'err', text: query.get('erro')! }
      : query.get('tiktok') === 'ok' ? { kind: 'ok', text: 'TikTok conectado! Os carrosséis aprovados para o TikTok passam a ser publicados no horário.' } : null);
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

  // abre o login oficial da rede numa janela separada; a escolha da página/perfil aparece aqui quando ela fechar
  const win = useRef<Window | null>(null);
  const [waiting, setWaiting] = useState<Net | null>(null);
  async function connect(net: Net) {
    setMsg(null); setBusy(true);
    const w = openLoginWindow();                       // precisa ser no clique, antes de esperar a API
    try {
      const { url } = await api<{ url: string }>(`/client/connect/${net}/start`, { body: {} });
      win.current = w; goToLogin(w, url);
      if (w) setWaiting(net);
    } catch (e) { cancelLogin(w); setMsg({ kind: 'err', text: (e as Error).message }); }
    finally { setBusy(false); }
  }
  function stopWaiting() { cancelLogin(win.current); win.current = null; setWaiting(null); }

  async function confirmGoogle() {
    setBusy(true);
    try {
      await api('/client/connect/google/select', { body: { n: gNonce, locationId: gPick } });
      setMsg({ kind: 'ok', text: 'Google Meu Negócio conectado! Os posts do Google aprovados passam a ser publicados no horário.' });
      setGPending(null); location.hash = '#conexoes'; conns.reload();
    } catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); }
    finally { setBusy(false); }
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

  const of = (ps: string[]) => conns.data?.filter(c => ps.includes(c.provider)) ?? [];
  const metaConns = of(['facebook', 'instagram', 'meta_ads']), gConns = of(['google_business']), tConns = of(['tiktok']);
  const item = (c: Conn) => (
    <div className="net-item" key={c.provider}>
      <span><b>{NOMES[c.provider] ?? c.provider}</b><br /><span className="card-sub">{c.name ?? c.external_id} · desde {dataHora(c.connected_at)}
        {c.expires_at ? ` · renovar até ${dataHora(c.expires_at)}` : ''}</span></span>
      {saude(c)}
      {isOwner && <button className="btn" style={{ minHeight: 36 }} onClick={() => disconnect(c.provider)}>Desconectar</button>}
    </div>);

  return (
    <>
      <header className="page-head"><div><span className="eyebrow">Redes sociais e anúncios</span><h1>Conexões</h1>
        <p className="card-sub" style={{ margin: '6px 0 0' }}>Clique em conectar: o login oficial da rede abre numa janela separada e esta tela continua aberta.</p></div></header>
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

      {waiting && (
        <section className="card" style={{ borderColor: 'var(--accent)' }} role="status">
          <div className="wait"><span className="spinner" />
            <div><b>Termine o login do {REDE[waiting]} na janela que abriu.</b>
              <div className="card-sub">Quando terminar, ela fecha sozinha e você escolhe aqui o que conectar.</div></div></div>
          <div className="actions">
            <button className="btn" onClick={() => connect(waiting)}><Icon name="external" size={18} />Abrir a janela de novo</button>
            <button className="btn" onClick={stopWaiting}>Cancelar</button>
          </div>
        </section>)}

      <div className="net-grid">
        <NetCard net="meta" title="Facebook, Instagram e Meta Ads" status={metaConns.length ? status(metaConns) : undefined}
                 text="Publica posts e carrosséis no Facebook e no Instagram, e liga os anúncios da Meta. Login oficial: a plataforma nunca vê sua senha."
                 action={isOwner && <button className="btn btn-primary" disabled={busy} onClick={() => connect('meta')}>
                   <Icon name="external" size={18} />{metaConns.length ? 'Reconectar' : 'Conectar com Facebook'}</button>}>
          {metaConns.length > 0 && metaConns.map(item)}
        </NetCard>
        <NetCard net="google" title="Google Meu Negócio" status={gConns.length ? status(gConns) : undefined}
                 text="Publica as novidades do calendário no seu perfil do Google (aparece na busca e no Maps)."
                 off={features.data && !features.data.google}
                 action={isOwner && features.data?.google && <button className="btn btn-primary" disabled={busy} onClick={() => connect('google')}>
                   <Icon name="external" size={18} />{gConns.length ? 'Reconectar' : 'Conectar com Google'}</button>}>
          {gConns.length > 0 && gConns.map(item)}
        </NetCard>
        <NetCard net="tiktok" title="TikTok" status={tConns.length ? status(tConns) : undefined}
                 text="Publica os carrosséis do calendário como posts de fotos com música. Os roteiros de vídeo ficam em Aprovações."
                 off={features.data && !features.data.tiktok}
                 action={isOwner && features.data?.tiktok && <button className="btn btn-primary" disabled={busy} onClick={() => connect('tiktok')}>
                   <Icon name="external" size={18} />{tConns.length ? 'Reconectar' : 'Conectar com TikTok'}</button>}>
          {tConns.length > 0 && tConns.map(item)}
        </NetCard>
      </div>
      {!isOwner && <p className="card-sub">Só o responsável pela conta pode conectar ou desconectar.</p>}

      <section className="banner">
        <b>Antes de conectar:</b> o Instagram precisa ser <b>profissional</b> (empresa ou criador) e estar <b>vinculado a uma Página do Facebook</b>.
        No app do Instagram: Configurações → Tipo de conta → Mudar para conta profissional → Conectar Página.
      </section>
    </>
  );
}

const status = (cs: Conn[]) => cs.some(c => c.needs_reconnect) ? 'bad' : cs.some(c => c.expiring) ? 'warn' : 'good';

function NetCard({ net, title, text, status, off, action, children }:
  { net: Net; title: string; text: string; status?: 'good' | 'warn' | 'bad'; off?: boolean | null; action?: ReactNode; children?: ReactNode }) {
  return (
    <section className="card net-card">
      <div className="net-head"><BrandMark net={net} size={44} /><h2>{title}</h2>
        {status ? <span className={`badge ${status}`}>{status === 'good' ? 'Conectado' : status === 'warn' ? 'Vence em breve' : 'Reconectar'}</span>
          : <span className="badge">Não conectado</span>}</div>
      <p className="card-sub" style={{ margin: 0 }}>{text}</p>
      {children && <div className="net-items">{children}</div>}
      {off ? <p className="card-sub" style={{ margin: 0 }}>A agência ainda está ativando esta integração.</p> : action ? <div className="actions">{action}</div> : null}
    </section>
  );
}
