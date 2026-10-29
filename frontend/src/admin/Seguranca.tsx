import { useState } from 'react';
import { api, dataHora } from '../api';
import { useLoad } from '../ui/useLoad';
import { useStepUp } from '../auth/StepUp';

interface Summary { ultimas24h: Record<string, number>; ipsSuspeitos: { ip: string; tentativas: number }[];
                    cadeiaIntegra: boolean; panic: { on: boolean; reason?: string; at?: string } }
interface Log { id: number; at: string; action: string; target: string | null; meta: any; ip: string | null; tenant: string | null; actor: string | null }

const nomes: Record<string, string> = {
  logins_falhos: 'Logins com senha errada', codigos_errados: 'Códigos 2FA errados', novos_dispositivos: 'Novos dispositivos',
  webhooks_rejeitados: 'Webhooks com assinatura inválida', fraudes: 'Chargebacks / valores divergentes',
};
const gravidade = (a: string) => /chargeback|mismatch|killed|panic_on|rejected/.test(a) ? 'bad'
  : /failed|new_device/.test(a) ? 'warn' : '';

export default function Seguranca() {
  const sum = useLoad<Summary>('/admin/security/summary');
  const [onlySec, setOnlySec] = useState(true);
  const logs = useLoad<Log[]>(`/admin/audit${onlySec ? '?security=1' : ''}`);
  const guard = useStepUp();
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const panic = sum.data?.panic;

  async function togglePanic() {
    setMsg(null);
    let reason: string | null = null;
    if (!panic?.on) {
      reason = prompt('MODO PÂNICO: desliga IA, anúncios e envios de WhatsApp de TODOS os clientes e pausa as campanhas.\nDescreva o motivo:');
      if (!reason || reason.trim().length < 5) return;
    } else if (!confirm('Religar as integrações externas?')) return;
    try {
      await guard(() => api('/admin/security/panic', { body: { on: !panic?.on, reason: reason ?? undefined } }));
      setMsg({ kind: 'ok', text: panic?.on ? 'Integrações religadas.' : 'Modo pânico ATIVO. Integrações externas desligadas.' });
      sum.reload(); logs.reload();
    } catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); }
  }

  return (
    <>
      <header className="page-head"><div><span className="eyebrow">Painel Master</span><h1>Central de Segurança</h1></div></header>
      {msg && <p className={`msg ${msg.kind}`} role="status">{msg.text}</p>}

      <section className={`card ${panic?.on ? 'banner panic' : ''}`}>
        <div className="card-head" style={{ alignItems: 'center' }}>
          <div>
            <h2>Modo pânico</h2>
            <span className="card-sub">{panic?.on ? `ATIVO desde ${panic.at ? dataHora(panic.at) : ''} — ${panic.reason ?? ''}` :
              'Desligado. Use se suspeitar de invasão ou vazamento de chave: corta IA, anúncios e WhatsApp na hora.'}</span>
          </div>
          <button className={`btn ${panic?.on ? 'btn-good' : 'btn-danger'}`} onClick={togglePanic}>{panic?.on ? 'Religar integrações' : 'Ativar modo pânico'}</button>
        </div>
      </section>

      {sum.data && (
        <section className="grid-kpi" aria-label="Últimas 24 horas">
          {Object.entries(sum.data.ultimas24h).map(([k, v]) => (
            <article key={k} className="card kpi"><span className="kpi-label">{nomes[k] ?? k}</span>
              <div className="kpi-value"><b style={{ color: v ? 'var(--warn)' : undefined }}>{v}</b></div><span className="card-sub">últimas 24h</span></article>))}
          <article className="card kpi"><span className="kpi-label">Cadeia de auditoria</span>
            <div className="kpi-value"><b style={{ color: sum.data.cadeiaIntegra ? 'var(--good)' : 'var(--bad)' }}>{sum.data.cadeiaIntegra ? 'Íntegra' : 'ALTERADA'}</b></div>
            <span className="card-sub">hash encadeado dos últimos 500 registros</span></article>
        </section>
      )}

      {!!sum.data?.ipsSuspeitos.length && (
        <section className="card"><h2>IPs com mais tentativas de login</h2>
          <ul>{sum.data.ipsSuspeitos.map(i => <li key={i.ip}><span className="mono">{i.ip}</span> — {i.tentativas} tentativas</li>)}</ul></section>
      )}

      <section className="card">
        <div className="card-head"><h2>Logs de auditoria</h2>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
            <input type="checkbox" checked={onlySec} onChange={e => setOnlySec(e.target.checked)} /> Só eventos de segurança</label></div>
        {logs.error && <p className="msg err">{logs.error}</p>}
        <div className="table-wrap"><table className="tbl">
          <thead><tr><th>Quando</th><th>Evento</th><th>Cliente</th><th>Quem</th><th>IP</th><th>Detalhes</th></tr></thead>
          <tbody>{logs.data?.map(l => (
            <tr key={l.id}><td style={{ whiteSpace: 'nowrap' }}>{dataHora(l.at)}</td>
              <td><span className={`badge ${gravidade(l.action)}`}>{l.action}</span></td>
              <td>{l.tenant ?? '—'}</td><td className="mono">{l.actor ?? '—'}</td><td className="mono">{l.ip ?? '—'}</td>
              <td className="mono" style={{ maxWidth: 280 }}>{[l.target, Object.keys(l.meta ?? {}).length ? JSON.stringify(l.meta) : ''].filter(Boolean).join(' ')}</td></tr>))}
          </tbody></table></div>
        {logs.data?.length === 0 && <p className="card-sub">Nada registrado.</p>}
      </section>
    </>
  );
}
