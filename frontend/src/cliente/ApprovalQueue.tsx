import { useState } from 'react';
import { api } from '../api';
import { useLoad } from '../ui/useLoad';
import './approval.css';

interface Item {
  id: string; channel: string; kind: string; scheduled_for: string; status: string; feedback: string | null; revision: number;
  payload: { caption: string; hashtags?: string[]; slides?: string[]; script?: string; trigger?: string; template?: string };
}

const channelName: Record<string, string> = { instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok', google_business: 'Google' };
const kindName: Record<string, string> = { post: 'Post', carousel: 'Carrossel', reel_script: 'Vídeo curto', story: 'Story', gbp_post: 'Post do Google' };
const COLS: [string, string][] = [['pending_approval', 'Para aprovar'], ['changes_requested', 'Ajuste pedido'], ['approved', 'Aprovados']];

/** Filtro humano: o cliente só olha, aprova tudo de uma vez ou pede ajuste em texto. */
export default function ApprovalQueue() {
  const month = new Date().toISOString().slice(0, 7);
  const { data: items, error, reload } = useLoad<Item[]>(`/client/content?month=${month}`);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState('');

  async function decide(id: string, decision: 'approve' | 'reject' | 'changes', feedback?: string) {
    setBusy(id); setMsg(null);
    try {
      const r = await api(`/approvals/${id}`, { body: { decision, feedback } });
      if (decision === 'changes') setMsg(r.revisado ? { kind: 'ok', text: 'Ajustado! A nova versão voltou para "Para aprovar".' }
                                                    : { kind: 'err', text: `Pedido registrado, mas a IA não conseguiu ajustar agora: ${r.aviso}` });
      reload();
    } catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); }
    finally { setBusy(''); }
  }

  async function retry(id: string) {
    setBusy(id); setMsg(null);
    try { await api(`/approvals/${id}/revise`, { body: {} }); setMsg({ kind: 'ok', text: 'Ajustado! A nova versão voltou para "Para aprovar".' }); reload(); }
    catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); }
    finally { setBusy(''); }
  }

  async function approveAll() {
    setBusy('all');
    try { const r = await api('/approvals/approve-all', { body: {} }); setMsg({ kind: 'ok', text: `${r.aprovados} conteúdos aprovados.` }); reload(); }
    catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); }
    finally { setBusy(''); }
  }

  if (error) return <p className="msg err" role="alert">{error}</p>;
  if (!items) return <p className="aq-msg">Carregando…</p>;
  const pend = items.filter(i => i.status === 'pending_approval').length;

  return (
    <>
      <header className="page-head">
        <div><span className="eyebrow">{new Date().toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })}</span><h1>Aprovações</h1></div>
        {pend > 0 && <button className="btn btn-primary" disabled={Boolean(busy)} onClick={approveAll}>
          {busy === 'all' ? 'Aprovando…' : `Aprovar tudo (${pend})`}</button>}
      </header>
      {msg && <p className={`msg ${msg.kind}`} role="status">{msg.text}</p>}
      {!items.length && <p className="banner">Nenhum conteúdo neste mês ainda. Em <a href="#negocio">Meu negócio</a>, clique em "Gerar calendário".</p>}

      <div className="kanban">
        {COLS.map(([status, title]) => {
          const col = items.filter(i => i.status === status);
          return (
            <section key={status} className="kanban-col" aria-label={title}>
              <h2>{title} <span className="badge">{col.length}</span></h2>
              {col.map(it => <Card key={it.id} it={it} busy={busy === it.id} onDecide={decide} onRetry={retry} />)}
            </section>
          );
        })}
      </div>
    </>
  );
}

function Card({ it, busy, onDecide, onRetry }: { it: Item; busy: boolean; onRetry: (id: string) => void;
                                                onDecide: (id: string, d: 'approve' | 'reject' | 'changes', f?: string) => void }) {
  const [asking, setAsking] = useState(false);
  const [fb, setFb] = useState('');
  const p = it.payload;
  return (
    <article className="aq-card" style={{ margin: 0 }}>
      <header className="aq-when">
        <strong>{channelName[it.channel] ?? it.channel} · {kindName[it.kind] ?? it.kind}</strong>
        <time dateTime={it.scheduled_for}>{new Date(it.scheduled_for).toLocaleString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</time>
      </header>
      <p className="aq-caption">{p.caption}</p>
      {p.slides && <ol className="aq-slides">{p.slides.map((s, i) => <li key={i}>{s}</li>)}</ol>}
      {p.script && <details><summary>Ver roteiro do vídeo</summary><p style={{ whiteSpace: 'pre-line' }}>{p.script}</p></details>}
      {p.hashtags?.length ? <p className="aq-tags">{p.hashtags.join(' ')}</p> : null}
      {it.status === 'changes_requested' && <>
        <p className="msg warn">Seu pedido: {it.feedback}</p>
        <div className="aq-actions"><button className="btn" disabled={busy} onClick={() => onRetry(it.id)}>{busy ? 'Ajustando…' : 'Tentar ajustar de novo'}</button></div>
      </>}
      {it.revision > 0 && it.status !== 'changes_requested' && <span className="badge">versão {it.revision + 1}</span>}

      {it.status === 'pending_approval' && (asking ? (
        <form onSubmit={e => { e.preventDefault(); onDecide(it.id, 'changes', fb); }} style={{ display: 'grid', gap: 8, marginTop: 12 }}>
          <label className="field">O que quer mudar?<textarea autoFocus minLength={3} required value={fb} onChange={e => setFb(e.target.value)}
                 placeholder="Ex.: troque a foto por pão de queijo e cite o horário das 15h" /></label>
          <div className="aq-actions" style={{ marginTop: 0 }}>
            <button type="button" className="aq-reject" onClick={() => setAsking(false)}>Cancelar</button>
            <button className="aq-approve" disabled={busy}>{busy ? 'Ajustando…' : 'Enviar ajuste'}</button>
          </div>
        </form>
      ) : (
        <div className="aq-actions">
          <button className="aq-reject" disabled={busy} onClick={() => onDecide(it.id, 'reject')}>Descartar</button>
          <button className="btn" disabled={busy} onClick={() => setAsking(true)}>Pedir ajuste</button>
          <button className="aq-approve" disabled={busy} onClick={() => onDecide(it.id, 'approve')}>Aprovar</button>
        </div>
      ))}
    </article>
  );
}
