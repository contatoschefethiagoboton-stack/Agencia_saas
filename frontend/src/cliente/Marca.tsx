import { useEffect, useState } from 'react';
import { api } from '../api';
import { useLoad } from '../ui/useLoad';

interface Media { id: string; width: number; height: number; source?: string; prompt?: string | null }
const MODELOS: [string, string][] = [['destaque', 'Destaque'], ['oferta', 'Oferta'], ['bastidores', 'Bastidores'],
  ['dica', 'Dica'], ['depoimento', 'Depoimento'], ['carrossel', 'Carrossel']];

const toBase64 = (f: File) => new Promise<string>((ok, fail) => {
  const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = fail; r.readAsDataURL(f);
});

/** Identidade visual: cores, logo e fotos que viram as artes dos posts. */
export default function Marca() {
  const photos = useLoad<Media[]>('/client/media?kind=photo');
  const logos = useLoad<Media[]>('/client/media?kind=logo');
  const features = useLoad<{ fotosIA: boolean }>('/client/features');
  const [prompt, setPrompt] = useState('');
  const [cores, setCores] = useState({ primaria: '#1F4FD8', secundaria: '#FFB020' });
  const [v, setV] = useState(Date.now());                       // força recarregar os exemplos
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState('');

  useEffect(() => { api('/client/dossier').then(r => r.data?.marca?.primaria && setCores({ primaria: r.data.marca.primaria, secundaria: r.data.marca.secundaria })).catch(() => {}); }, []);

  async function run(label: string, fn: () => Promise<string>) {
    setBusy(label); setMsg(null);
    try { setMsg({ kind: 'ok', text: await fn() }); setV(Date.now()); }
    catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); }
    finally { setBusy(''); }
  }
  const upload = (kind: 'photo' | 'logo', files: FileList | null) => files?.length && run(kind, async () => {
    for (const f of Array.from(files).slice(0, 20)) {
      if (f.size > 5_000_000) throw new Error(`${f.name}: precisa ter até 5 MB`);
      await api('/client/media', { body: { kind, dataBase64: await toBase64(f) } });
    }
    photos.reload(); logos.reload();
    return kind === 'logo' ? 'Logo salvo.' : `${files.length} foto(s) adicionada(s).`;
  });

  return (
    <>
      <header className="page-head"><div><span className="eyebrow">Como seus posts vão ficar</span><h1>Identidade visual</h1></div></header>
      {msg && <p className={`msg ${msg.kind}`} role="status">{msg.text}</p>}

      <section className="row">
        <form className="card half" onSubmit={e => { e.preventDefault(); run('cores', async () => { await api('/client/brand', { method: 'PUT', body: cores }); return 'Cores salvas. As próximas artes já saem assim.'; }); }}>
          <h2>Cores da marca</h2>
          <div className="form-grid">
            {(['primaria', 'secundaria'] as const).map(k => (
              <label key={k} className="field">{k === 'primaria' ? 'Cor principal' : 'Cor de destaque'}
                <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <input type="color" value={cores[k]} onChange={e => setCores({ ...cores, [k]: e.target.value })} style={{ width: 64, padding: 4 }} />
                  <input value={cores[k]} onChange={e => setCores({ ...cores, [k]: e.target.value })} pattern="#[0-9a-fA-F]{6}" />
                </span></label>))}
          </div>
          <div className="actions"><button className="btn btn-primary" disabled={!!busy}>Salvar cores</button></div>
        </form>

        <section className="card half">
          <h2>Logo</h2>
          <span className="card-sub">PNG com fundo transparente fica melhor. Aparece no canto das artes.</span>
          {logos.data?.[0] && <img src={`/api/client/media/${logos.data[0].id}/raw`} alt="Logo atual" style={{ maxWidth: 160, maxHeight: 100, objectFit: 'contain', background: 'var(--card-2)', borderRadius: 10, padding: 8 }} />}
          <label className="field">Enviar logo<input type="file" accept="image/png,image/jpeg" onChange={e => upload('logo', e.target.files)} /></label>
        </section>
      </section>

      <section className="card">
        <h2>Fotos do negócio</h2>
        <span className="card-sub">Produtos, ambiente, equipe. As artes de oferta, bastidores e destaque usam estas fotos. JPG ou PNG, até 5 MB.</span>
        <label className="field">Adicionar fotos<input type="file" accept="image/png,image/jpeg" multiple onChange={e => upload('photo', e.target.files)} /></label>
        {busy === 'photo' && <p className="card-sub">Enviando…</p>}
        {features.data?.fotosIA && (
          <form style={{ display: 'grid', gap: 8 }} onSubmit={e => { e.preventDefault(); run('ia', async () => {
            await api('/client/media/ai', { body: { prompt } }); setPrompt(''); photos.reload(); return 'Foto criada e adicionada à biblioteca.'; }); }}>
            <label className="field">Ainda sem fotos? Descreva uma e a IA cria
              <textarea minLength={8} maxLength={500} required value={prompt} onChange={e => setPrompt(e.target.value)}
                        placeholder="Pães artesanais em cesto de vime sobre balcão de madeira, luz da manhã" /></label>
            <small className="card-sub">Fotos de IA são ilustrativas: não use para mostrar produto que você não vende. Contam no limite mensal de IA do plano.</small>
            <div className="actions"><button className="btn" disabled={!!busy}>{busy === 'ia' ? 'Criando… (até 1 minuto)' : 'Criar foto com IA'}</button></div>
          </form>)}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 10 }}>
          {photos.data?.map((p, i) => (
            <figure key={p.id} style={{ margin: 0, position: 'relative' }}>
              <img src={`/api/client/media/${p.id}/raw`} alt={`Foto ${i + 1}`} style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: 10 }} />
              <button className="btn" aria-label={`Apagar foto ${i + 1}`} style={{ position: 'absolute', top: 6, right: 6, minHeight: 32, padding: '0 10px', background: 'rgb(0 0 0 / .6)' }}
                      onClick={() => run('del', async () => { await api(`/client/media/${p.id}`, { method: 'DELETE' }); photos.reload(); return 'Foto apagada.'; })}>✕</button>
              <figcaption className="card-sub">Foto {i + 1}{p.source === 'ai' ? ' · IA' : ''}</figcaption>
            </figure>))}
        </div>
        {photos.data?.length === 0 && <p className="card-sub">Sem fotos ainda: as artes usam fundos com as cores da marca.</p>}
      </section>

      <section className="card">
        <h2>Modelos de arte</h2>
        <span className="card-sub">Exemplos com a sua identidade atual. A IA escolhe o modelo de cada post; você pode trocar em Aprovações.</span>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 200px), 1fr))', gap: 12 }}>
          {MODELOS.map(([id, nome]) => (
            <figure key={id} style={{ margin: 0 }}>
              <img src={`/api/client/art/preview?template=${id}&v=${v}`} alt={`Exemplo do modelo ${nome}`} loading="lazy"
                   style={{ width: '100%', aspectRatio: '4 / 5', borderRadius: 10, background: 'var(--card-2)' }} />
              <figcaption className="card-sub">{nome}</figcaption>
            </figure>))}
        </div>
      </section>
    </>
  );
}
