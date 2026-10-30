import { useCallback, useEffect, useState } from 'react';
import { api, type Me } from './api';
import { Shell, type NavItem } from './ui/Shell';
import Login, { ChangePassword, ResetPassword } from './auth/Login';
import { StepUpProvider } from './auth/StepUp';
import Visao from './admin/Visao';
import Clientes from './admin/Clientes';
import Financeiro from './admin/Financeiro';
import Seguranca from './admin/Seguranca';
import Resumo from './cliente/Resumo';
import Negocio from './cliente/Negocio';
import ApprovalQueue from './cliente/ApprovalQueue';
import Inbox from './cliente/Inbox';
import Conexoes from './cliente/Conexoes';
import Marca from './cliente/Marca';
import Anuncios from './cliente/Anuncios';
import { onLoginResult } from './ui/oauthPopup';
import './ui/forms.css';

const useHash = (fallback: string) => {
  const [h, setH] = useState(location.hash || fallback);
  useEffect(() => { const f = () => setH(location.hash || fallback); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, [fallback]);
  return h;
};

const navDono: NavItem[] = [
  { href: '#master', label: 'Visão geral', icon: 'home' }, { href: '#master-clientes', label: 'Clientes', icon: 'users' },
  { href: '#master-financeiro', label: 'Tesouraria', icon: 'wallet' }, { href: '#master-seguranca', label: 'Segurança e auditoria', icon: 'shield' },
];
const navCliente: NavItem[] = [
  { href: '#cliente', label: 'Painel', icon: 'home' },
  { href: '#aprovacoes', label: 'Aprovações', icon: 'check', group: 'Conteúdo' }, { href: '#anuncios', label: 'Anúncios', icon: 'megaphone', group: 'Conteúdo' },
  { href: '#atendimento', label: 'Atendimento WhatsApp', icon: 'chat', group: 'Conteúdo' },
  { href: '#negocio', label: 'Meu negócio', icon: 'store', group: 'Configurar' }, { href: '#marca', label: 'Identidade visual', icon: 'palette', group: 'Configurar' },
  { href: '#conexoes', label: 'Conexões', icon: 'link', group: 'Configurar' },
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
  const page = hash === '#master-clientes' ? <Clientes /> : hash === '#master-financeiro' ? <Financeiro />
    : hash === '#master-seguranca' ? <Seguranca key={tenantId ?? 'all'} tenantId={tenantId} /> : <Visao />;
  return (
    <Shell brand="Agência Hub" sub="Painel Master" logo="A" logoColor="var(--grad)" nav={navDono} current={hash} user={me.email} onLogout={logout}>
      {me.panic?.on && <p className="banner panic" role="alert">MODO PÂNICO ATIVO: IA, anúncios e envios de WhatsApp estão desligados. <a href="#master-seguranca">Ver</a></p>}
      {page}
    </Shell>
  );
}

function AreaCliente({ me, logout }: { me: Me; logout: () => void }) {
  const [hash, qs] = useHash('#cliente').split('?');            // ex.: #conexoes?meta=… (volta do login da Meta)
  const query = new URLSearchParams(qs ?? '');
  // resultado do login das redes (janela separada): abre Conexões com a escolha da página/perfil
  useEffect(() => onLoginResult(h => { location.hash = h; window.focus(); }), []);
  const stopImpersonating = async () => { await api('/auth/impersonate/stop', { body: {} }); location.hash = '#master-clientes'; location.reload(); };
  const initials = (me.tenant_name ?? '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  return (
    <Shell brand={me.tenant_name ?? 'Meu negócio'} sub={me.impersonating ? 'Painel do cliente (agência)' : me.city ?? me.email} logo={initials} logoColor="var(--teal)"
           nav={navCliente} current={hash} flush={hash === '#atendimento'} user={me.email}
           onLogout={me.impersonating ? stopImpersonating : logout} logoutLabel={me.impersonating ? 'Voltar ao Painel Master' : 'Sair'}>
      {me.impersonating && (
        <div className="banner" role="status" style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', justifyContent: 'space-between',
             borderStyle: 'solid', borderColor: 'var(--accent)', margin: hash === '#atendimento' ? 16 : 0 }}>
          <span>Você está no painel de <b>{me.tenant_name}</b> como agência ({me.email}). Tudo fica registrado na auditoria.</span>
          <button className="btn btn-primary" onClick={stopImpersonating}>Voltar ao Painel Master</button>
        </div>)}
      {hash === '#aprovacoes' ? <ApprovalQueue /> : hash === '#atendimento' ? <Inbox /> : hash === '#negocio' ? <Negocio />
        : hash === '#marca' ? <Marca />
        : hash === '#anuncios' ? <Anuncios isOwner={me.role === 'owner'} />
        : hash === '#conexoes' ? <Conexoes key={qs ?? ''} query={query} isOwner={me.role === 'owner'} /> : <Resumo me={me} />}
    </Shell>
  );
}
