import { useCallback, useEffect, useRef, useState } from 'react';
import './inbox.css';

interface Conv { id: string; name: string | null; wa_id: string; mode: 'bot' | 'human'; unread: number;
                 preview: string | null; in_window: boolean; handoff_reason: string | null; updated_at: string }
interface Msg { id: number; direction: 'in' | 'out'; author: 'contact' | 'ai' | 'agent' | 'system';
                body: string; status: string; error: string | null; created_at: string }

const api = (path: string, init?: RequestInit) =>
  fetch(`/api/whatsapp${path}`, { credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...init })
    .then(async r => (r.ok ? r.json() : Promise.reject((await r.json().catch(() => ({}))).error ?? 'Erro')));

const who = { contact: '', ai: 'Atendente IA', agent: 'Você', system: 'Sistema' };
const statusIcon: Record<string, string> = { queued: '🕓', sent: '✓', delivered: '✓✓', read: '✓✓', failed: '!' };

export default function Inbox() {
  const [convs, setConvs] = useState<Conv[]>([]);
  const [open, setOpen] = useState<Conv | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const openRef = useRef<Conv | null>(null);
  openRef.current = open;

  const loadConvs = useCallback(() => api('/conversations').then(setConvs).catch(setError), []);
  const loadMsgs = useCallback((id: string) => api(`/conversations/${id}/messages`).then(setMsgs).catch(setError), []);

  useEffect(() => {
    loadConvs();
    const es = new EventSource('/api/whatsapp/stream', { withCredentials: true });
    es.onmessage = e => {
      const ev = JSON.parse(e.data);
      loadConvs();
      if (openRef.current && (ev.conversationId === openRef.current.id || ev.type === 'status')) loadMsgs(openRef.current.id);
    };
    return () => es.close();
  }, [loadConvs, loadMsgs]);

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [msgs]);

  const select = (c: Conv) => { setOpen(c); setError(''); loadMsgs(c.id); };

  async function send() {
    if (!open || !draft.trim()) return;
    try { await api(`/conversations/${open.id}/messages`, { method: 'POST', body: JSON.stringify({ body: draft }) });
          setDraft(''); setOpen({ ...open, mode: 'human' }); loadMsgs(open.id); }
    catch (e) { setError(String(e)); }
  }
  async function setMode(mode: 'bot' | 'human' | 'closed') {
    if (!open) return;
    await api(`/conversations/${open.id}/mode`, { method: 'POST', body: JSON.stringify({ mode }) }).catch(setError);
    if (mode === 'closed') setOpen(null); else setOpen({ ...open, mode });
    loadConvs();
  }

  return (
    <div className={`ib ${open ? 'ib-thread-open' : ''}`}>
      <aside className="ib-list" aria-label="Conversas">
        <h1 className="ib-h">Atendimento</h1>
        {!convs.length && <p className="ib-empty">Nenhuma conversa aberta. Quando um cliente escrever no seu WhatsApp, ela aparece aqui.</p>}
        <ul>
          {convs.map(c => (
            <li key={c.id}>
              <button className={`ib-conv ${open?.id === c.id ? 'is-open' : ''}`} onClick={() => select(c)}>
                <span className="ib-name">{c.name ?? `+${c.wa_id}`}</span>
                {c.mode === 'human' && <span className="ib-flag">Precisa de você</span>}
                <span className="ib-preview">{c.preview}</span>
                {c.unread > 0 && <span className="ib-unread" aria-label={`${c.unread} não lidas`}>{c.unread}</span>}
              </button>
            </li>
          ))}
        </ul>
      </aside>

      {open && (
        <section className="ib-thread" aria-label={`Conversa com ${open.name ?? open.wa_id}`}>
          <header className="ib-top">
            <button className="ib-back" onClick={() => setOpen(null)} aria-label="Voltar para as conversas">‹</button>
            <div className="ib-who">
              <strong>{open.name ?? `+${open.wa_id}`}</strong>
              <span>{open.mode === 'bot' ? 'A IA está respondendo' : 'Você está no atendimento'}</span>
            </div>
            {open.mode === 'bot'
              ? <button className="ib-btn" onClick={() => setMode('human')}>Assumir</button>
              : <button className="ib-btn" onClick={() => setMode('bot')}>Devolver para a IA</button>}
            <button className="ib-btn ib-quiet" onClick={() => setMode('closed')}>Encerrar</button>
          </header>
          {open.handoff_reason && open.mode === 'human' && <p className="ib-note">Transferido: {open.handoff_reason}</p>}

          <div className="ib-msgs">
            {msgs.map(m => (
              <div key={m.id} className={`ib-msg ib-${m.direction} ib-by-${m.author}`}>
                {m.author !== 'contact' && <span className="ib-by">{who[m.author]}</span>}
                <p>{m.body}</p>
                <span className="ib-meta">
                  {new Date(m.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                  {m.direction === 'out' && <span className={m.status === 'read' ? 'ib-read' : ''}> {statusIcon[m.status]}</span>}
                </span>
                {m.error && <span className="ib-err">{m.error}</span>}
              </div>
            ))}
            <div ref={endRef} />
          </div>

          {error && <p className="ib-err ib-bar" role="alert">{error}</p>}
          {open.in_window ? (
            <div className="ib-compose">
              <textarea value={draft} onChange={e => setDraft(e.target.value)} rows={1} placeholder="Escreva uma resposta"
                        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                        aria-label="Mensagem" />
              <button className="ib-send" onClick={send} disabled={!draft.trim()}>Enviar</button>
            </div>
          ) : (
            <p className="ib-note ib-bar">Passaram 24h desde a última mensagem do cliente. Para retomar, envie um modelo aprovado.</p>
          )}
        </section>
      )}
    </div>
  );
}
