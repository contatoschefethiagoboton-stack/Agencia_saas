import { useCallback, useEffect, useState } from 'react';
import { api, type Me } from './api';
import { Shell, type NavItem } from './ui/Shell';
import Login, { ChangePassword, ResetPassword } from './auth/Login';
import { StepUpProvider } from './auth/StepUp';
import Visao from './admin/Visao';
import Clientes from './admin/Clientes';
import Seguranca from './admin/Seguranca';
import Masters from './admin/Masters';
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

const navDono: NavItem[] = [
  { href: '#master', label: 'Visão geral', icon: 'home' }, { href: '#master-clientes', label: 'Clientes', icon: 'users' },
  { href: '#master-copy', label: 'Copy trade', icon: 'copy' }, { href: '#master-seguranca', label: 'Segurança e auditoria', icon: 'shield' },
];
const navCliente = (unread: number): NavItem[] => [
  { href: '#mercado', label: 'Mercado', icon: 'home' }, { href: '#grafico', label: 'Gráficos', icon: 'candles' },
  { href: '#sinais', label: 'Sinais', icon: 'bolt' }, { href: '#radar', label: 'Lançamentos', icon: 'radar' },
  { href: '#fiis', label: 'Fundos imobiliários', icon: 'building' },
  { href: '#robos', label: 'Robôs', icon: 'bot', group: 'Automático' }, { href: '#copy', label: 'Copy trade', icon: 'copy', group: 'Automático' },
  { href: '#corretoras', label: 'Corretoras', icon: 'bank', group: 'Conta' }, { href: '#avisos', label: 'Avisos', icon: 'bell', group: 'Conta', count: unread },
];

/** O servidor marca a página só no endereço secreto da agência (ADMIN_PATH). Em qualquer outro endereço, só existe o login de cliente. */
const isAdminArea = () => document.querySelector('meta[name="app-area"]')?.getAttribute('content') === 'admin'
  || (import.meta.env.DEV && location.pathname.replace(/\/+$/, '') === '/admin');

/** Sessão decide a área: platform_admin vê o Painel Master; owner/member veem o painel do negócio. */
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
  // LOGINS SEPARADOS: o endereço secreto é o acesso da agência; a tela principal é só dos clientes
  const adminArea = isAdminArea();
  if (me === undefined) return <div className="center-page"><div className="wait"><span className="spinner" /><span className="card-sub">Carregando…</span></div></div>;
  if (me === null) return <Login area={adminArea ? 'admin' : 'cliente'} onDone={change => { setMustChange(change); loadMe(); }} />;
  if (me.role === 'platform_admin' && !adminArea && me.adminPath) { location.replace(me.adminPath + location.hash); return null; }   // admin sempre no endereço dele
  if (me.role !== 'platform_admin' && !me.impersonating && adminArea) {
    // sessão de cliente aberta na porta da agência: mostra o login da agência (sem misturar as contas)
    return <Login area="admin" onDone={change => { setMustChange(change); loadMe(); }} />;
  }
  if (mustChange) return <ChangePassword onDone={() => { setMustChange(false); loadMe(); }} />;

  const logout = async () => { await api('/auth/logout', { body: {} }).catch(() => {}); location.hash = ''; setMe(null); };
  return <StepUpProvider>{me.role === 'platform_admin' ? <AreaMaster me={me} logout={logout} /> : <AreaCliente me={me} logout={logout} />}</StepUpProvider>;
}

function AreaMaster({ me, logout }: { me: Me; logout: () => void }) {
  const [hash, qs] = useHash('#master').split('?');
  const tenantId = new URLSearchParams(qs ?? '').get('tenant') ?? undefined;
  const page = hash === '#master-clientes' ? <Clientes /> : hash === '#master-copy' ? <Masters />
    : hash === '#master-seguranca' ? <Seguranca key={tenantId ?? 'all'} tenantId={tenantId} /> : <Visao />;
  return (
    <Shell brand="Radar Invest" sub="Painel Master" logo="R" logoColor="var(--grad)" nav={navDono} current={hash} user={me.email} onLogout={logout}>
      {me.panic?.on && <p className="banner panic" role="alert">MODO PÂNICO ATIVO: todos os robôs estão congelados. <a href="#master-seguranca">Ver</a></p>}
      {page}
    </Shell>
  );
}

function AreaCliente({ me, logout }: { me: Me; logout: () => void }) {
  const [hash, qs] = useHash('#mercado').split('?');            // ex.: #grafico?market=crypto&symbol=BTCUSDT
  const query = new URLSearchParams(qs ?? '');
  const [unread, setUnread] = useState(0);
  const loadUnread = useCallback(() => { api<{ unread: number }>('/market/alerts').then(r => setUnread(r.unread)).catch(() => {}); }, []);
  useEffect(() => { loadUnread(); const t = setInterval(loadUnread, 60_000); return () => clearInterval(t); }, [loadUnread]);
  const stopImpersonating = async () => { await api('/auth/impersonate/stop', { body: {} }); location.hash = '#master-clientes'; location.reload(); };
  const initials = (me.tenant_name ?? me.name ?? '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  const page = hash === '#grafico' ? <Grafico key={qs ?? ''} query={query} /> : hash === '#sinais' ? <Sinais /> : hash === '#radar' ? <Radar />
    : hash === '#fiis' ? <Fiis /> : hash === '#robos' ? <Robos key={qs ?? ''} query={query} /> : hash === '#copy' ? <Copy />
    : hash === '#corretoras' ? <Corretoras /> : hash === '#avisos' ? <Avisos onRead={() => setUnread(0)} /> : <Mercado />;
  return (
    <Shell brand={me.tenant_name ?? 'Minha conta'} sub={me.impersonating ? 'Painel do cliente (suporte)' : me.email} logo={initials} logoColor="var(--teal)"
           nav={navCliente(unread)} current={hash} user={me.email}
           onLogout={me.impersonating ? stopImpersonating : logout} logoutLabel={me.impersonating ? 'Voltar ao Painel Master' : 'Sair'}>
      {me.impersonating && (
        <div className="banner" role="status" style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', justifyContent: 'space-between',
             borderStyle: 'solid', borderColor: 'var(--accent)' }}>
          <span>Você está no painel de <b>{me.tenant_name}</b> como administrador ({me.email}). Tudo fica registrado na auditoria.</span>
          <button className="btn btn-primary" onClick={stopImpersonating}>Voltar ao Painel Master</button>
        </div>)}
      {page}
      <Disclaimer />
    </Shell>
  );
}
