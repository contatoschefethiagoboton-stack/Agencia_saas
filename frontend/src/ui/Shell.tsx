import { useEffect, useState, type ReactNode } from 'react';
import { Icon } from './Icon';

export interface NavItem { href: string; label: string; icon?: string; count?: number; group?: string }

/** Moldura das áreas logadas: menu lateral com ícones (no celular vira gaveta) e bloco do usuário com "Sair". */
export function Shell({ brand, sub, logo, logoColor, nav, current, children, flush, user, onLogout, logoutLabel = 'Sair' }:
  { brand: string; sub: string; logo: string; logoColor: string; nav: NavItem[]; current: string; children: ReactNode;
    flush?: boolean; user?: string; onLogout?: () => void; logoutLabel?: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => { setOpen(false); }, [current]);                          // fecha a gaveta ao trocar de página
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    addEventListener('keydown', esc); return () => removeEventListener('keydown', esc);
  }, [open]);
  const title = nav.find(n => n.href === current)?.label ?? brand;
  let lastGroup: string | undefined;
  return (
    <div className={`shell${open ? ' nav-open' : ''}`}>
      <header className="topbar">
        <button className="icon-btn" aria-label="Abrir menu" aria-expanded={open} onClick={() => setOpen(true)}><Icon name="menu" /></button>
        <b>{title}</b>
        <div className="side-logo sm" style={{ background: logoColor }} aria-hidden="true">{logo}</div>
      </header>
      <div className="side-backdrop" onClick={() => setOpen(false)} aria-hidden="true" />
      <nav className="side" aria-label="Menu principal">
        <div className="side-brand">
          <div className="side-logo" style={{ background: logoColor }}>{logo}</div>
          <div className="side-brand-text"><b>{brand}</b><small>{sub}</small></div>
          <button className="icon-btn side-close" aria-label="Fechar menu" onClick={() => setOpen(false)}><Icon name="close" /></button>
        </div>
        <div className="side-links">
          {nav.map(n => {
            const head = n.group && n.group !== lastGroup ? <span className="side-group" key={'g' + n.group}>{n.group}</span> : null;
            lastGroup = n.group;
            return [head,
              <a key={n.href} href={n.href} aria-current={current === n.href ? 'page' : undefined}>
                {n.icon && <Icon name={n.icon} />}<span className="side-label">{n.label}</span>
                {n.count ? <span className="pill-count">{n.count}</span> : null}
              </a>];
          })}
        </div>
        {onLogout && (
          <div className="side-user">
            <div className="side-user-text"><small>Conectado como</small><span>{user}</span></div>
            <button className="icon-btn" onClick={onLogout} title={logoutLabel} aria-label={logoutLabel}><Icon name="logout" /></button>
          </div>)}
      </nav>
      <main className={`content${flush ? ' flush' : ''}`}><div className="content-inner">{children}</div></main>
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }:
  { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map(([id, text]) => (
        <button key={id} aria-pressed={id === value} onClick={() => onChange(id)}>{text}</button>
      ))}
    </div>
  );
}
