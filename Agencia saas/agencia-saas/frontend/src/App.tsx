import { useEffect, useState } from 'react';
import { Shell, type NavItem } from './ui/Shell';
import PainelMaster from './admin/PainelMaster';
import PainelCliente from './cliente/PainelCliente';
import ApprovalQueue from './cliente/ApprovalQueue';
import Inbox from './cliente/Inbox';

/**
 * Navegação simples por hash. Em produção, o papel vem da sessão (GET /api/me):
 * platform_admin vê o Painel Master; owner/member veem o painel do negócio.
 */
const useHash = () => {
  const [h, setH] = useState(location.hash || '#master');
  useEffect(() => { const f = () => setH(location.hash || '#master'); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  return h;
};

const navDono: NavItem[] = [
  { href: '#master', label: 'Visão geral' }, { href: '#master-clientes', label: 'Clientes' },
  { href: '#master-financeiro', label: 'Financeiro' }, { href: '#master-alertas', label: 'Alertas e auditoria' },
];
const navCliente: NavItem[] = [
  { href: '#cliente', label: 'Painel' }, { href: '#aprovacoes', label: 'Aprovações', count: 4 },
  { href: '#atendimento', label: 'Atendimento WhatsApp' },
];

export default function App() {
  const hash = useHash();
  const isDono = hash.startsWith('#master');
  // "#master-clientes" abre o Painel Master e rola até a seção "clientes"
  useEffect(() => { const sec = hash.split('-')[1]; if (sec) document.getElementById(sec)?.scrollIntoView({ behavior: 'smooth' }); }, [hash]);

  if (isDono) {
    return (
      <Shell brand="Sua Agência" sub="Visão do dono" logo="A" logoColor="var(--accent)" nav={navDono} current={hash}
             footer={[{ href: '#cliente', label: 'Ver painel de um cliente' }]}>
        <PainelMaster />
      </Shell>
    );
  }
  return (
    <Shell brand="Padaria Bom Grão" sub="Cambuí, Campinas" logo="BG" logoColor="var(--teal)" nav={navCliente} current={hash}
           footer={[{ href: '#master', label: 'Voltar ao Painel Master' }]} flush={hash === '#atendimento'}>
      {hash === '#aprovacoes' ? <ApprovalQueue /> : hash === '#atendimento' ? <Inbox /> : <PainelCliente />}
    </Shell>
  );
}
