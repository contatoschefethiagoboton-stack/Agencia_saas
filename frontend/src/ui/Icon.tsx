/** Ícones de traço (24×24), desenhados aqui para não depender de biblioteca externa. */
const P: Record<string, string> = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  wallet: 'M20 7H5a2 2 0 0 1 0-4h13v4M3 5v14a2 2 0 0 0 2 2h15V7M16 14h.01',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4',
  store: 'M3 9l1.5-5h15L21 9M3 9v11h18V9M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0M9 20v-6h6v6',
  palette: 'M12 22a10 10 0 1 1 10-10c0 2.5-2 3.5-4 3.5h-2a2 2 0 0 0-1.5 3.3c.6.7.2 3.2-2.5 3.2zM7.5 11.5h.01M10.5 7.5h.01M15.5 8.5h.01',
  check: 'M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
  megaphone: 'M3 11v3a1 1 0 0 0 1 1h3l5 4V6L7 10H4a1 1 0 0 0-1 1zM16 8a5 5 0 0 1 0 8M19 5a9 9 0 0 1 0 14',
  chat: 'M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12z',
  link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  menu: 'M4 6h16M4 12h16M4 18h16',
  close: 'M18 6 6 18M6 6l12 12',
  back: 'M19 12H5M12 19l-7-7 7-7',
  external: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  spark: 'M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4zM19 17l.8 2.2L22 20l-2.2.8L19 23l-.8-2.2L16 20l2.2-.8z',
};

export function Icon({ name, size = 20 }: { name: keyof typeof P | string; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={P[name] ?? P.spark} />
    </svg>
  );
}

/** Marcas das redes (cores oficiais, formas simplificadas). */
export function BrandMark({ net, size = 40 }: { net: 'meta' | 'google' | 'tiktok'; size?: number }) {
  const box = { width: size, height: size, borderRadius: size * 0.28, display: 'grid', placeItems: 'center', flex: 'none' } as const;
  if (net === 'google') return (
    <span style={{ ...box, background: '#fff' }} aria-hidden="true">
      <svg width={size * 0.55} height={size * 0.55} viewBox="0 0 24 24">
        <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.7z" />
        <path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1A12 12 0 0 0 12 24z" />
        <path fill="#FBBC05" d="M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6h-4a12 12 0 0 0 0 10.8z" />
        <path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.3 6.6l4 3.1c.9-2.8 3.6-4.9 6.7-4.9z" />
      </svg></span>);
  if (net === 'tiktok') return (
    <span style={{ ...box, background: '#000' }} aria-hidden="true">
      <svg width={size * 0.5} height={size * 0.5} viewBox="0 0 24 24">
        <path fill="#25F4EE" d="M9.4 9.6V8.7a6.8 6.8 0 0 0-.9 0 6.6 6.6 0 0 0-3.8 12A6.6 6.6 0 0 1 9.4 9.6z" />
        <path fill="#FE2C55" d="M17.8 5.3a4.9 4.9 0 0 1-2.2-3.2H13v13.2a2.8 2.8 0 1 1-2-2.7V9.6a6.6 6.6 0 0 0-5.3 11.1 6.6 6.6 0 0 0 10.2-5.5V8.5a8.5 8.5 0 0 0 5 1.6V7.5a4.9 4.9 0 0 1-3.1-2.2z" />
        <path fill="#fff" d="M16.9 8.5a8.5 8.5 0 0 0 4.9 1.6V7.5a5 5 0 0 1-4-2.2 4.9 4.9 0 0 1-2.2-3.2H13v13.2a2.8 2.8 0 0 1-5.1 1.6 2.8 2.8 0 0 1 3.1-4.3V9.6a6.6 6.6 0 0 0-5.3 11.1 6.6 6.6 0 0 0 11.2-4.7z" />
      </svg></span>);
  return (
    <span style={{ ...box, background: 'linear-gradient(135deg,#0866FF,#A033FF 55%,#FF5C87)' }} aria-hidden="true">
      <svg width={size * 0.6} height={size * 0.6} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2.2} strokeLinecap="round">
        <path d="M4 15c0-4 2-8 4.5-8 3 0 4.5 10 7.5 10 2 0 4-2 4-5s-1.5-5-3.5-5C13 7 11 17 7.5 17 5.5 17 4 16.5 4 15z" />
      </svg></span>);
}
