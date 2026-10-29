import { useEffect, useState } from 'react';
import { api, brl, dataHora } from '../api';
import { useLoad } from '../ui/useLoad';
import { ProgressBar } from '../ui/Charts';

interface Camp { id: string; name: string; objective: 'trafego' | 'alcance'; status: string; monthly_budget_cents: string;
  spend_cents_month: string; radius_km: number; link: string; headline: string; media_id: string | null; error: string | null;
  created_at: string; approved_at: string | null }
interface Data { conectado: boolean; contaAnuncios: boolean; pagina: boolean; campanhas: Camp[]; carteiraMidiaCents: string | null }
interface Proj { alcanceMin: number; alcanceMax: number; cliquesMin: number; cliquesMax: number; publicoMin?: number; publicoMax?: number; fonte: string }

const STATUS: Record<string, [string, string]> = {
  pending_approval: ['Esperando sua aprovação', 'warn'], active: ['No ar', 'good'], paused: ['Pausada', ''],
  failed: ['Erro ao criar', 'bad'], draft: ['Rascunho', ''], ended: ['Encerrada', ''],
};
const n = (v?: number) => v == null ? '—' : v.toLocaleString('pt-BR');
const reais = (v: string) => Math.round(Number(v.replace(/\./g, '').replace(',', '.')) * 100);

/** Tráfego local: cria, projeta, aprova e acompanha anúncios no raio do negócio — sem Gerenciador de Anúncios. */
export default function Anuncios({ isOwner }: { isOwner: boolean }) {
  const { data, error, reload } = useLoad<Data>('/client/ads');
  const [novo, setNovo] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err' | 'warn'; text: string } | null>(null);
  const [busy, setBusy] = useState('');

  async function act(id: string, fn: () => Promise<any>, ok: string) {
    setBusy(id); setMsg(null);
    try { const r = await fn(); setMsg(r?.status === 'failed' ? { kind: 'err', text: r.error } : { kind: 'ok', text: ok }); reload(); }
    catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); }
    finally { setBusy(''); }
  }

  if (error) return <p className="msg err">{error}</p>;
  if (!data) return <p className="card-sub">Carregando…</p>;
  const ativas = data.campanhas.filter(c => c.status !== 'ended');

  return (
    <>
      <header className="page-head">
        <div><span className="eyebrow">Tráfego local no Facebook e Instagram</span><h1>Anúncios</h1></div>
        {isOwner && data.conectado && !novo && <button className="btn btn-primary" onClick={() => setNovo(true)}>Nova campanha</button>}
      </header>
      {msg && <p className={`msg ${msg.kind}`} role="status">{msg.text}</p>}

      {!data.conectado && (
        <section className="card" style={{ borderColor: 'var(--accent)' }}>
          <h2>Conecte sua conta de anúncios</h2>
          <p className="card-sub">{!data.pagina ? 'Falta conectar a Página do Facebook. ' : ''}{!data.contaAnuncios ? 'Falta escolher a conta de anúncios. ' : ''}
            Os anúncios saem em nome da sua página e são cobrados na sua conta de anúncios da Meta.</p>
          <div className="actions"><a className="btn btn-primary" href="#conexoes">Ir para Conexões</a></div>
        </section>
      )}

      {novo && <NovaCampanha onDone={r => { setNovo(false); reload();
        setMsg(r.status === 'failed' ? { kind: 'err', text: `A campanha foi salva, mas a Meta recusou: ${r.error}` }
                                     : { kind: 'ok', text: 'Campanha montada na Meta e PAUSADA. Revise e clique em "Aprovar e ativar" para começar.' }); }}
                             onCancel={() => setNovo(false)} />}

      {ativas.map(c => {
        const gasto = Number(c.spend_cents_month), verba = Number(c.monthly_budget_cents);
        const pct = Math.min(100, Math.round(gasto / Math.max(1, verba) * 100));
        const [label, tone] = STATUS[c.status] ?? [c.status, ''];
        return (
          <article key={c.id} className="card">
            <div className="card-head" style={{ alignItems: 'flex-start' }}>
              <div><h2>{c.name}</h2>
                <span className="card-sub">{c.objective === 'trafego' ? 'Mais cliques (site/WhatsApp)' : 'Ser visto no bairro'} · raio de {c.radius_km} km · criada em {dataHora(c.created_at)}</span></div>
              <span className={`badge ${tone}`}>{label}</span>
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}><span>Gasto no mês</span><span>{brl(gasto)} de {brl(verba)}</span></div>
              <ProgressBar pct={pct} color={pct >= 90 ? 'var(--bad)' : 'var(--teal)'} />
            </div>
            {c.error && <p className={`msg ${c.status === 'failed' ? 'err' : 'warn'}`}>{c.error}</p>}
            {isOwner && (
              <div className="actions">
                {['pending_approval', 'paused'].includes(c.status) && (
                  <button className="btn btn-good" disabled={!!busy} onClick={() => window.confirm(`Ativar "${c.name}" com verba de até ${brl(verba)} neste mês? O valor é cobrado na sua conta de anúncios da Meta.`) &&
                    act(c.id, () => api(`/client/ads/${c.id}/approve`, { body: {} }), 'Campanha no ar! O vigia pausa sozinho se a verba do mês acabar.')}>
                    {c.status === 'paused' ? 'Reativar' : 'Aprovar e ativar'}</button>)}
                {c.status === 'active' && <button className="btn" disabled={!!busy} onClick={() => act(c.id, () => api(`/client/ads/${c.id}/pause`, { body: {} }), 'Campanha pausada.')}>Pausar</button>}
                {c.status === 'failed' && <button className="btn" disabled={!!busy} onClick={() => act(c.id, () => api(`/client/ads/${c.id}/retry`, { body: {} }), 'Campanha montada e pausada, esperando sua aprovação.')}>Tentar de novo</button>}
                {!['failed', 'draft'].includes(c.status) && <button className="btn" disabled={!!busy} onClick={() => {
                  const v = window.prompt('Nova verba mensal em reais (mínimo 150):', (verba / 100).toFixed(2).replace('.', ','));
                  if (v) act(c.id, () => api(`/client/ads/${c.id}`, { method: 'PATCH', body: { monthlyBudgetCents: reais(v) } }), 'Verba atualizada.');
                }}>Alterar verba</button>}
                <button className="btn" disabled={!!busy} onClick={() => window.confirm(`Encerrar "${c.name}"?`) &&
                  act(c.id, () => api(`/client/ads/${c.id}`, { method: 'DELETE' }), 'Campanha encerrada.')}>Encerrar</button>
              </div>)}
          </article>
        );
      })}
      {data.conectado && !ativas.length && !novo && <p className="banner">Nenhuma campanha ainda. Comece com uma verba pequena (a partir de R$ 150/mês) num raio de 2 a 5 km.</p>}
    </>
  );
}

function NovaCampanha({ onDone, onCancel }: { onDone: (r: any) => void; onCancel: () => void }) {
  const arts = useLoad<{ id: string }[]>('/client/media?kind=art');
  const photos = useLoad<{ id: string }[]>('/client/media?kind=photo');
  const [f, setF] = useState({ name: 'Clientes no bairro', objective: 'trafego' as 'trafego' | 'alcance', verba: '300,00', radiusKm: 3,
    lat: '', lng: '', link: '', headline: '', message: '', mediaId: '' });
  const [proj, setProj] = useState<Proj | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.type === 'range' ? Number(e.target.value) : e.target.value });

  useEffect(() => { api('/client/dossier').then(r => {
    const tel = String(r.data?.telefone ?? '').replace(/\D/g, '');
    setF(x => ({ ...x, link: x.link || (tel.length >= 10 ? `https://wa.me/${tel.startsWith('55') ? tel : '55' + tel}` : ''),
                 headline: x.headline || String(r.data?.nome ?? '').slice(0, 40) }));
  }).catch(() => {}); }, []);

  const geo = () => navigator.geolocation?.getCurrentPosition(p => setF(x => ({ ...x, lat: p.coords.latitude.toFixed(6), lng: p.coords.longitude.toFixed(6) })),
                                                              () => setErr('Não deu para pegar a localização. Digite a latitude e a longitude.'));
  const body = () => ({ name: f.name, objective: f.objective, monthlyBudgetCents: reais(f.verba), radiusKm: f.radiusKm,
    lat: Number(f.lat), lng: Number(f.lng), link: f.link, headline: f.headline, message: f.message, mediaId: f.mediaId });
  const projetar = async () => { setErr(''); try { setProj(await api('/client/ads/projection', { body: body() })); } catch (e) { setErr((e as Error).message); } };
  const criar = async () => { setErr(''); setBusy(true); try { onDone(await api('/client/ads', { body: body() })); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  const imgs = [...(arts.data ?? []).slice(0, 24), ...(photos.data ?? [])];

  return (
    <form className="card" style={{ borderColor: 'var(--accent)' }} onSubmit={e => { e.preventDefault(); criar(); }}>
      <h2>Nova campanha</h2>
      <div className="form-grid">
        <label className="field">Nome<input required value={f.name} onChange={set('name')} /></label>
        <label className="field">Objetivo<select value={f.objective} onChange={set('objective')}>
          <option value="trafego">Mais clientes no WhatsApp ou site</option><option value="alcance">Ser visto pelo bairro</option></select></label>
        <label className="field">Verba por mês (R$)<input inputMode="decimal" required value={f.verba} onChange={set('verba')} /><small>Mínimo R$ 150. Nunca passa disso: o vigia pausa sozinho.</small></label>
        <label className="field">Raio: {f.radiusKm} km<input type="range" min={1} max={30} value={f.radiusKm} onChange={set('radiusKm')} /></label>
      </div>
      <div className="form-grid">
        <label className="field">Latitude<input required inputMode="decimal" value={f.lat} onChange={set('lat')} placeholder="-22.900000" /></label>
        <label className="field">Longitude<input required inputMode="decimal" value={f.lng} onChange={set('lng')} placeholder="-47.060000" /></label>
        <div className="actions" style={{ alignSelf: 'end' }}><button type="button" className="btn" onClick={geo}>Usar minha localização</button></div>
      </div>
      <div className="form-grid">
        <label className="field">Para onde o anúncio leva<input type="url" required value={f.link} onChange={set('link')} placeholder="https://wa.me/5519999999999" /></label>
        <label className="field">Título (até 40 letras)<input required maxLength={40} value={f.headline} onChange={set('headline')} /></label>
      </div>
      <label className="field">Texto do anúncio<textarea required minLength={10} maxLength={600} value={f.message} onChange={set('message')}
             placeholder="Pão de fermentação natural saindo às 7h e às 15h. Peça pelo WhatsApp e retire sem fila." /></label>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="field" style={{ marginBottom: 8 }}>Imagem (artes do calendário ou fotos do negócio)</legend>
        {imgs.length ? <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(90px, 1fr))', gap: 8 }}>
          {imgs.map((m, i) => (
            <label key={m.id} style={{ cursor: 'pointer', outline: f.mediaId === m.id ? '3px solid var(--accent)' : 'none', borderRadius: 10 }}>
              <input type="radio" name="img" className="sr" checked={f.mediaId === m.id} onChange={() => setF({ ...f, mediaId: m.id })} />
              <img src={`/api/client/media/${m.id}/raw`} alt={`Imagem ${i + 1}`} style={{ width: '100%', aspectRatio: '4 / 5', objectFit: 'cover', borderRadius: 10, display: 'block' }} />
            </label>))}
        </div> : <p className="card-sub">Sem imagens ainda: gere as artes em Aprovações ou envie fotos em Identidade visual.</p>}
      </fieldset>

      {proj && (
        <div className="tiles" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
          <div className="tile"><span>Pessoas alcançadas no mês</span><b>{n(proj.alcanceMin)} a {n(proj.alcanceMax)}</b></div>
          {f.objective === 'trafego' && <div className="tile"><span>Cliques estimados</span><b>{n(proj.cliquesMin)} a {n(proj.cliquesMax)}</b></div>}
          {proj.publicoMax != null && <div className="tile"><span>Pessoas no raio (Meta)</span><b>{n(proj.publicoMin)} a {n(proj.publicoMax)}</b></div>}
          <small className="card-sub" style={{ gridColumn: '1 / -1' }}>{proj.fonte === 'meta' ? 'Público medido pela Meta; resultado é estimativa.' : 'Estimativa com médias de negócios locais; varia com o criativo e a concorrência.'}</small>
        </div>)}
      {err && <p className="msg err" role="alert">{err}</p>}
      <div className="actions">
        <button type="button" className="btn" onClick={projetar}>Ver projeção</button>
        <button className="btn btn-primary" disabled={busy || !f.mediaId}>{busy ? 'Montando na Meta…' : 'Montar campanha (fica pausada)'}</button>
        <button type="button" className="btn" onClick={onCancel}>Cancelar</button>
      </div>
    </form>
  );
}
