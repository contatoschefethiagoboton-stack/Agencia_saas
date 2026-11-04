import { useCallback, useEffect, useState } from 'react';
import { api, type Me } from './api';
import { Shell, type NavItem } from './ui/Shell';
import Login, { ChangePassword, ResetPassword } from './auth/Login';
import { StepUpProvider } from './auth/StepUp';
import Visao from './admin/Visao';
import Clientes from './admin/Clientes';
import Seguranca from './admin/Seguranca';
import Masters from './admin/Masters';
import Rastreamento from './admin/Rastreamento';
import Carteiras from './admin/Carteiras';
import Assinatura from './invest/Assinatura';
import Carteira from './invest/Carteira';
import Mercado from './invest/Mercado';
import Grafico from './invest/Grafico';
import Sinais from './invest/Sinais';
import Radar from './invest/Radar';
import Fiis from './invest/Fiis';
import Robos from './invest/Robos';
import Copy from './invest/Copy';
import Corretoras from './invest/Corretoras';
import Avisos from './invest/Avisos';
import { Disclaimer } from './invest/parts';
import './ui/forms.css';
import './invest/invest.css';

const useHash = (fallback: string) => {
  const [h, setH] = useState(location.hash || fallback);
  useEffect(() => { const f = () => setH(location.hash || fallback); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, [fallback]);
  return h;
};

const navAdmin: NavItem[] = [
  { href: '#master', label: 'Visão geral', icon: 'shield', group: 'Administração' }, { href: '#master-clientes', label: 'Clientes', icon: 'users', group: 'Administração' },
  { href: '#master-copy', label: 'Estratégias copy', icon: 'copy', group: 'Administração' }, { href: '#master-carteiras', label: 'Carteiras', icon: 'wallet', group: 'Administração' },
  { href: '#master-rastreamento', label: 'Rastreamento', icon: 'radar', group: 'Administração' }, { href: '#master-seguranca', label: 'Segurança e auditoria', icon: 'lock', group: 'Administração' },
];
const navCliente = (unread: number, admin: boolean): NavItem[] => [
  ...(admin ? navAdmin : []),
  { href: '#mercado', label: 'Mercado', icon: 'home', group: admin ? 'Investimentos' : undefined }, { href: '#grafico', label: 'Gráficos', icon: 'candles', group: admin ? 'Investimentos' : undefined },
  { href: '#sinais', label: 'Sinais', icon: 'bolt', group: admin ? 'Investimentos' : undefined }, { href: '#radar', label: 'Lançamentos', icon: 'radar', group: admin ? 'Investimentos' : undefined },
  { href: '#fiis', label: 'Fundos imobiliários', icon: 'building', group: admin ? 'Investimentos' : undefined },
  { href: '#robos', label: 'Robôs', icon: 'bot', group: 'Automático' }, { href: '#copy', label: 'Copy trade', icon: 'copy', group: 'Automático' },
  { href: '#carteira', label: 'Carteira', icon: 'wallet', group: 'Conta' }, { href: '#corretoras', label: 'Corretoras', icon: 'bank', group: 'Conta' },
  { href: '#avisos', label: 'Avisos', icon: 'bell', group: 'Conta', count: unread },
  ...(admin ? [] : [{ href: '#assinatura', label: 'Assinatura', icon: 'check', group: 'Conta' }]),
];

/** Uma tela de login para todos: o administrador vê a plataforma inteira mais a área de administração. */
export default function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [mustChange, setMustChange] = useState(false);
  const loadMe = useCallback(() => api<Me>('/auth/me').then(m => { setMe(m); setMustChange(m.must_change_password); })
    .catch(() => setMe(null)), []);   // 401 (sem sessão) ou 423 (conta suspensa): volta ao login
  useEffect(() => { loadMe(); }, [loadMe]);

  // link do e-mail "Esqueci minha senha": vale com ou sem sessão aberta
  if (location.hash.startsWith('#redefinir')) {
    const token = new URLSearchParams(location.hash.split('?')[1] ?? '').get('token') ?? '';
    return <ResetPassword token={token} onDone={() => { location.hash = ''; setMe(null); }} />;
  }
  // ACESSO UNIFICADO: administrador e clientes usam a mesma tela; o administrador vê tudo
  if (me === undefined) return <div className="center-page"><div className="wait"><span className="spinner" /><span className="card-sub">Carregando…</span></div></div>;
  if (me === null) return <Login onDone={change => { setMustChange(change); loadMe(); }} />;
  if (mustChange) return <ChangePassword onDone={() => { setMustChange(false); loadMe(); }} />;

  const logout = async () => { await api('/auth/logout', { body: {} }).catch(() => {}); location.hash = ''; setMe(null); };
  return <StepUpProvider><Area me={me} logout={logout} /></StepUpProvider>;
}

function Area({ me, logout }: { me: Me; logout: () => void }) {
  const admin = me.role === 'platform_admin';
  const [hash, qs] = useHash(admin ? '#master' : '#mercado').split('?');            // ex.: #grafico?market=crypto&symbol=BTCUSDT
  const query = new URLSearchParams(qs ?? '');
  const [unread, setUnread] = useState(0);
  const loadUnread = useCallback(() => { api<{ unread: number }>('/market/alerts').then(r => setUnread(r.unread)).catch(() => {}); }, []);
  useEffect(() => { loadUnread(); const t = setInterval(loadUnread, 60_000); return () => clearInterval(t); }, [loadUnread]);
  const stopImpersonating = async () => { await api('/auth/impersonate/stop', { body: {} }); location.hash = '#master-clientes'; location.reload(); };
  const initials = (me.tenant_name ?? me.name ?? '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  const tenantId = query.get('tenant') ?? undefined;
  const adminPage = !admin ? null : hash === '#master' ? <Visao /> : hash === '#master-clientes' ? <Clientes /> : hash === '#master-copy' ? <Masters />
    : hash === '#master-carteiras' ? <Carteiras /> : hash === '#master-rastreamento' ? <Rastreamento />
    : hash === '#master-seguranca' ? <Seguranca key={tenantId ?? 'all'} tenantId={tenantId} /> : null;
  const page = adminPage ?? (hash === '#grafico' ? <Grafico key={qs ?? ''} query={query} /> : hash === '#sinais' ? <Sinais /> : hash === '#radar' ? <Radar />
    : hash === '#fiis' ? <Fiis /> : hash === '#robos' ? <Robos key={qs ?? ''} query={query} /> : hash === '#copy' ? <Copy />
    : hash === '#corretoras' ? <Corretoras /> : hash === '#avisos' ? <Avisos onRead={() => setUnread(0)} /> : hash === '#carteira' ? <Carteira />
    : hash === '#assinatura' ? <Assinatura /> : <Mercado />);
  return (
    <Shell brand={admin ? 'Radar Invest' : me.tenant_name ?? 'Minha conta'} sub={admin ? 'Administrador · acesso total' : me.impersonating ? 'Painel do cliente (suporte)' : me.email}
           logo={admin ? 'R' : initials} logoColor={admin ? 'var(--grad)' : 'var(--teal)'}
           nav={navCliente(unread, admin)} current={hash} user={me.email}
           onLogout={me.impersonating ? stopImpersonating : logout} logoutLabel={me.impersonating ? 'Voltar ao Painel Master' : 'Sair'}>
      {me.impersonating && (
        <div className="banner" role="status" style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', justifyContent: 'space-between',
             borderStyle: 'solid', borderColor: 'var(--accent)' }}>
          <span>Você está no painel de <b>{me.tenant_name}</b> como administrador ({me.email}). Tudo fica registrado na auditoria.</span>
          <button className="btn btn-primary" onClick={stopImpersonating}>Voltar ao Painel Master</button>
        </div>)}
      {admin && me.panic?.on && <p className="banner panic" role="alert">MODO PÂNICO ATIVO: todos os robôs estão congelados. <a href="#master-seguranca">Ver</a></p>}
      {page}
      <Disclaimer />
    </Shell>
  );
}
