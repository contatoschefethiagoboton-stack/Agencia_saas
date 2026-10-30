/**
 * Login das redes sociais (Meta, Google, TikTok) numa janela separada.
 * A janela volta para /#conexoes?…, entrega o resultado à tela principal e se fecha.
 * O aviso vai por BroadcastChannel (mesmo site), que funciona mesmo quando a rede corta o window.opener.
 * Se o navegador bloquear a janela, o login segue na mesma aba, como antes.
 */
const PENDING = 'oauth-popup-pending';
const RESULT = 'oauth-result';
const isResult = (hash: string) => /^#conexoes\?(meta|google|tiktok|erro)=/.test(hash) && hash.length < 2000;

/** Abre a janela já no clique (antes de qualquer espera), senão o navegador bloqueia. */
export function openLoginWindow(): Window | null {
  const w = 520, h = 720;
  const left = Math.max(0, screenX + (outerWidth - w) / 2), top = Math.max(0, screenY + (outerHeight - h) / 2);
  const win = window.open('', 'ah-oauth', `popup=yes,width=${w},height=${h},left=${left},top=${top}`);
  if (!win) return null;
  try {
    win.document.title = 'Conectando…';
    win.document.body.style.cssText = 'margin:0;display:grid;place-items:center;height:100vh;background:#0B1020;color:#EEF2FA;font:16px system-ui';
    win.document.body.textContent = 'Abrindo o login com segurança…';
    win.opener = null;                       // a rede social não consegue mexer nesta aba
  } catch { /* janela reaproveitada de outro endereço: segue mesmo assim */ }
  try { localStorage.setItem(PENDING, String(Date.now())); } catch { /* modo privado */ }
  return win;
}

/** Leva a janela (ou, se bloqueada, a própria aba) para o login da rede. */
export function goToLogin(win: Window | null, url: string) {
  if (win && !win.closed) { win.location.href = url; return; }
  try { localStorage.removeItem(PENDING); } catch { /* */ }
  location.href = url;
}

export function cancelLogin(win: Window | null) {
  try { localStorage.removeItem(PENDING); } catch { /* */ }
  try { win?.close(); } catch { /* */ }
}

/** Chamado no início do app: se esta aba é a janela de login voltando, entrega o resultado e fecha. */
export function handOffFromLoginWindow(): boolean {
  if (!isResult(location.hash)) return false;
  let started = 0;
  try { started = Number(localStorage.getItem(PENDING) || 0); localStorage.removeItem(PENDING); } catch { /* */ }
  if (!started || Date.now() - started > 20 * 60_000) return false;    // login feito na mesma aba: segue normal
  const hash = location.hash;
  if ('BroadcastChannel' in window) { const ch = new BroadcastChannel(RESULT); ch.postMessage(hash); ch.close(); }
  try { localStorage.setItem(RESULT, `${Date.now()}|${hash}`); localStorage.removeItem(RESULT); } catch { /* */ }   // aviso reserva (evento storage)
  window.close();
  return true;
}

/** A tela de Conexões escuta o resultado vindo da janela de login. */
export function onLoginResult(cb: (hash: string) => void): () => void {
  const got = (hash: unknown) => { if (typeof hash === 'string' && isResult(hash)) cb(hash); };
  const ch = 'BroadcastChannel' in window ? new BroadcastChannel(RESULT) : null;
  if (ch) ch.onmessage = e => got(e.data);
  const st = (e: StorageEvent) => { if (!ch && e.key === RESULT && e.newValue) got(e.newValue.slice(e.newValue.indexOf('|') + 1)); };
  addEventListener('storage', st);
  return () => { ch?.close(); removeEventListener('storage', st); };
}
