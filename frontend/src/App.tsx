import { useCallback, useEffect, useState } from 'react';
import { api, type Me } from './api';
import { Shell, type NavItem } from './ui/Shell';
import Login, { ChangePassword } from './auth/Login';
import { StepUpProvider } from './auth/StepUp';
import Visao from './admin/Visao';
import Clientes from './admin/Clientes';
import Financeiro from './admin/Financeiro';
import Seguranca from './admin/Seguranca';
import Resumo from './cliente/Resumo';
import Negocio from './cliente/Negocio';
import ApprovalQueue from './cliente/ApprovalQueue';
import Inbox from './cliente/Inbox';
import './ui/forms.css';

const useHash = (fallback: string) => {
  const [h, setH] = useState(location.hash || fallback);
  useEffect(() => { const f = () => setH(location.hash || fallback); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, [fallback]);
  return h;
};

const navDono: NavItem[] = [
  { href: '#master', label: 'Visão geral' }, { href: '#master-clientes', label: 'Clientes' },
  { href: '#master-financeiro', label: 'Tesouraria' }, { href: '#master-seguranca', label: 'Segurança e auditoria' },
];
const navCliente: NavItem[] = [
  { href: '#cliente', label: 'Painel' }, { href: '#negocio', label: 'Meu negócio' },
  { href: '#aprovacoes', label: 'Aprovações' }, { href: '#atendimento', label: 'Atendimento WhatsApp' },
];

/** Sessão decide a área: platform_admin vê o Painel Master; owner/member veem o painel do negócio. */
export default function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [mustChange, setMustChange] = useState(false);
  const loadMe = useCallback(() => api<Me>('/auth/me').then(m => { setMe(m); setMustChange(m.must_change_password); })
    .catch(() => setMe(null)), []);   // 401 (sem sessão) ou 423 (conta suspensa): volta ao login
  useEffect(() => { loadMe(); }, [loadMe]);

  if (me === undefined) return <div className="center-page"><p className="card-sub">Carregando…</p></div>;
  if (me === null) return <Login onDone={change => { setMustChange(change); loadMe(); }} />;
  if (mustChange) return <ChangePassword onDone={() => { setMustChange(false); loadMe(); }} />;

  const logout = async () => { await api('/auth/logout', { body: {} }).catch(() => {}); location.hash = ''; setMe(null); };
  return <StepUpProvider>{me.role === 'platform_admin' ? <AreaMaster me={me} logout={logout} /> : <AreaCliente me={me} logout={logout} />}</StepUpProvider>;
}

function AreaMaster({ me, logout }: { me: Me; logout: () => void }) {
  const hash = useHash('#master');
  const page = hash === '#master-clientes' ? <Clientes /> : hash === '#master-financeiro' ? <Financeiro />
    : hash === '#master-seguranca' ? <Seguranca /> : <Visao />;
  return (
    <Shell brand="Agência Hub" sub={me.email} logo="A" logoColor="var(--accent)" nav={navDono} current={hash}>
      {me.panic?.on && <p className="banner panic" role="alert">MODO PÂNICO ATIVO: IA, anúncios e envios de WhatsApp estão desligados. <a href="#master-seguranca">Ver</a></p>}
      {page}
      <div className="actions"><button className="btn" onClick={logout}>Sair</button></div>
    </Shell>
  );
}

function AreaCliente({ me, logout }: { me: Me; logout: () => void }) {
  const hash = useHash('#cliente');
  const initials = (me.tenant_name ?? '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  return (
    <Shell brand={me.tenant_name ?? 'Meu negócio'} sub={me.city ?? me.email} logo={initials} logoColor="var(--teal)"
           nav={navCliente} current={hash} flush={hash === '#atendimento'}>
      {hash === '#aprovacoes' ? <ApprovalQueue /> : hash === '#atendimento' ? <Inbox /> : hash === '#negocio' ? <Negocio /> : <Resumo me={me} />}
      {hash !== '#atendimento' && <div className="actions"><button className="btn" onClick={logout}>Sair</button></div>}
    </Shell>
  );
}
