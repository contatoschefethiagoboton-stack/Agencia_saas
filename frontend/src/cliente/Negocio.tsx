import { useEffect, useState } from 'react';
import { api } from '../api';

type Dossier = Record<string, any>;
const CAMPOS: [string, string, string?][] = [
  ['nome', 'Nome do negócio'], ['nicho', 'Ramo', 'padaria, clínica, barbearia, influenciador…'], ['cidade', 'Cidade'],
  ['bairro', 'Bairro'], ['endereco', 'Endereço'], ['horarios', 'Horários', 'seg a sex 7h–19h, sáb 7h–13h'],
  ['telefone', 'WhatsApp de contato'], ['publico', 'Quem são seus clientes'], ['tomDeVoz', 'Jeito de falar', 'acolhedor, divertido, técnico…'],
];

const toBase64 = (f: File) => new Promise<string>((ok, fail) => {
  const r = new FileReader();
  r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = fail; r.readAsDataURL(f);
});

/** Onboarding: memória do comércio (dossiê) + leitura automática de site/PDF + geração do calendário. */
export default function Negocio() {
  const [d, setD] = useState<Dossier | null>(null);
  const [extra, setExtra] = useState({ diferenciais: '', observacoes: '' });
  const [src, setSrc] = useState<{ site: string; notes: string; pdf: File | null }>({ site: '', notes: '', pdf: null });
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err' | 'warn'; text: string } | null>(null);
  const month = new Date().toISOString().slice(0, 7);

  const load = (data: Dossier) => {
    setD(data);
    setExtra({ diferenciais: (data.diferenciais ?? []).join('\n'), observacoes: data.observacoes ?? '' });
  };
  useEffect(() => { api('/client/dossier').then(r => load(r.data ?? {})).catch(e => setMsg({ kind: 'err', text: e.message })); }, []);

  async function run(label: string, fn: () => Promise<string>) {
    setBusy(label); setMsg(null);
    try { setMsg({ kind: 'ok', text: await fn() }); }
    catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); }
    finally { setBusy(''); }
  }

  const save = () => run('save', async () => {
    const data = { ...d, diferenciais: extra.diferenciais.split('\n').map(s => s.trim()).filter(Boolean), observacoes: extra.observacoes };
    await api('/client/dossier', { method: 'PUT', body: { data } });
    return 'Dados salvos.';
  });

  const ingest = () => run('ingest', async () => {
    if (src.pdf && src.pdf.size > 10_000_000) throw new Error('O PDF precisa ter até 10 MB');
    const r = await api('/client/dossier/ingest', { body: {
      websiteUrl: src.site || undefined, notes: src.notes || undefined, pdfBase64: src.pdf ? await toBase64(src.pdf) : undefined } });
    load(r.data);
    return 'Pronto! A IA leu as fontes e atualizou os dados abaixo. Confira e corrija o que precisar.';
  });

  const generate = () => run('gen', async () => {
    const r = await api('/client/content/generate', { body: { month } });
    return `${r.criados} conteúdos criados para este mês${r.artes ? `, com ${r.artes} artes prontas` : ''}. Eles estão em Aprovações esperando o seu OK.`;
  });

  if (!d) return msg ? <p className={`msg ${msg.kind}`}>{msg.text}</p> : <p className="card-sub">Carregando…</p>;
  const set = (k: string) => (e: any) => setD({ ...d, [k]: e.target.value });

  return (
    <>
      <header className="page-head"><div><span className="eyebrow">Memória do negócio</span><h1>Meu negócio</h1></div></header>
      {msg && <p className={`msg ${msg.kind}`} role="status">{msg.text}</p>}

      <section className="card">
        <h2>1. Deixe a IA ler sobre você</h2>
        <span className="card-sub">Ela lê o seu site e o cardápio/catálogo em PDF e organiza tudo. Nada é publicado sem a sua aprovação.</span>
        <div className="form-grid">
          <label className="field">Site ou link da página<input type="url" placeholder="https://…" value={src.site} onChange={e => setSrc({ ...src, site: e.target.value })} /></label>
          <label className="field">Cardápio, catálogo ou tabela de preços (PDF)
            <input type="file" accept="application/pdf" onChange={e => setSrc({ ...src, pdf: e.target.files?.[0] ?? null })} /></label>
        </div>
        <label className="field">Conte com suas palavras (Instagram, Google, o que vende, promoções que existem de verdade)
          <textarea value={src.notes} onChange={e => setSrc({ ...src, notes: e.target.value })}
                    placeholder="@meuinsta · No Google aparecemos como… · Mais vendidos: …" /></label>
        <div className="actions"><button className="btn btn-primary" disabled={Boolean(busy)} onClick={ingest}>
          {busy === 'ingest' ? 'Lendo… (até 1 minuto)' : 'Ler e organizar'}</button></div>
      </section>

      <form className="card" onSubmit={e => { e.preventDefault(); save(); }}>
        <h2>2. Confira os dados</h2>
        <div className="form-grid">
          {CAMPOS.map(([k, label, ph]) => (
            <label key={k} className="field">{label}<input placeholder={ph} value={d[k] ?? ''} onChange={set(k)} /></label>))}
        </div>
        <label className="field">Diferenciais (um por linha)<textarea value={extra.diferenciais} onChange={e => setExtra({ ...extra, diferenciais: e.target.value })} /></label>
        {Array.isArray(d.produtos) && d.produtos.length > 0 && (
          <details><summary>Produtos e serviços encontrados ({d.produtos.length})</summary>
            <ul>{d.produtos.map((p: any, i: number) => <li key={i}>{p.nome}{p.preco ? ` — ${p.preco}` : ''}{p.descricao ? ` · ${p.descricao}` : ''}</li>)}</ul></details>)}
        <label className="field">Observações (o que a IA nunca deve dizer, datas especiais…)
          <textarea value={extra.observacoes} onChange={e => setExtra({ ...extra, observacoes: e.target.value })} /></label>
        <div className="actions"><button className="btn" disabled={Boolean(busy)}>{busy === 'save' ? 'Salvando…' : 'Salvar'}</button></div>
      </form>

      <section className="card">
        <h2>3. Gerar o calendário do mês</h2>
        <span className="card-sub">Posts, carrosséis, roteiros de vídeo e posts do Google para os próximos 30 dias, no tom do seu negócio.</span>
        <div className="actions"><button className="btn btn-orange" disabled={Boolean(busy)} onClick={generate}>
          {busy === 'gen' ? 'Criando… (pode levar 1–2 minutos)' : 'Gerar calendário'}</button></div>
      </section>
    </>
  );
}
