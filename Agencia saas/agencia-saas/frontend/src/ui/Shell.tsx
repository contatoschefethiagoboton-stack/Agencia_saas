import type { ReactNode } from 'react';

export interface NavItem { href: string; label: string; count?: number }

export function Shell({ brand, sub, logo, logoColor, nav, current, footer, children, flush }:
  { brand: string; sub: string; logo: string; logoColor: string; nav: NavItem[]; current: string;
    footer?: NavItem[]; children: ReactNode; flush?: boolean }) {
  const link = (n: NavItem) => (
    <a key={n.href} href={n.href} aria-current={current === n.href ? 'page' : undefined}>
      {n.label}{n.count ? <span className="pill-count">{n.count}</span> : null}
    </a>
  );
  return (
    <div className="shell">
      <nav className="side" aria-label="Menu principal">
        <div className="side-brand">
          <div className="side-logo" style={{ background: logoColor }}>{logo}</div>
          <div><b>{brand}</b><small>{sub}</small></div>
        </div>
        {nav.map(link)}
        {footer && <><hr />{footer.map(link)}</>}
      </nav>
      <main className={`content${flush ? ' flush' : ''}`}>{children}</main>
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
