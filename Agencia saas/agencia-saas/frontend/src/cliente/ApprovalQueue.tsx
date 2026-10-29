import { useEffect, useState } from 'react';
import './approval.css';

interface Item {
  id: string; channel: string; kind: string; scheduled_for: string;
  payload: { caption: string; hashtags: string[]; slides?: string[]; script?: string };
}

const channelName: Record<string, string> = {
  instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok', google_business: 'Google',
};

export default function ApprovalQueue() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/approvals', { credentials: 'include' })
      .then(r => (r.ok ? r.json() : Promise.reject(r)))
      .then(setItems)
      .catch(() => setError('Não foi possível carregar os conteúdos. Atualize a página.'));
  }, []);

  async function decide(id: string, decision: 'approve' | 'reject') {
    const r = await fetch(`/api/approvals/${id}`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision }),
    });
    if (r.ok) setItems(list => list?.filter(i => i.id !== id) ?? null);
    else setError('A decisão não foi salva. Tente de novo.');
  }

  if (error) return <p className="aq-msg" role="alert">{error}</p>;
  if (!items) return <p className="aq-msg">Carregando…</p>;
  if (!items.length) return <p className="aq-msg">Tudo aprovado. Os próximos conteúdos aparecem aqui assim que forem criados.</p>;

  return (
    <section className="aq" aria-label="Conteúdos aguardando sua aprovação">
      <h1 className="aq-title">{items.length} {items.length === 1 ? 'conteúdo espera' : 'conteúdos esperam'} por você</h1>
      {items.map(it => (
        <article key={it.id} className="aq-card">
          <header className="aq-when">
            <strong>{channelName[it.channel] ?? it.channel}</strong>
            <time dateTime={it.scheduled_for}>
              {new Date(it.scheduled_for).toLocaleString('pt-BR', { weekday: 'long', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
            </time>
          </header>
          <p className="aq-caption">{it.payload.caption}</p>
          {it.payload.slides && <ol className="aq-slides">{it.payload.slides.map((s, i) => <li key={i}>{s}</li>)}</ol>}
          {it.payload.script && <details><summary>Ver roteiro do vídeo</summary><p>{it.payload.script}</p></details>}
          <p className="aq-tags">{it.payload.hashtags.join(' ')}</p>
          <div className="aq-actions">
            <button className="aq-reject" onClick={() => decide(it.id, 'reject')}>Recusar</button>
            <button className="aq-approve" onClick={() => decide(it.id, 'approve')}>Aprovar e agendar</button>
          </div>
        </article>
      ))}
    </section>
  );
}
