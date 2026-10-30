/** Endereço público do site (retorno do login da Meta, links das artes). No Render, RENDER_EXTERNAL_URL vem automático. */
export const publicUrl = () => (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000').replace(/\/$/, '');

/** Endereço secreto do login da agência (ex.: ADMIN_PATH=/acesso-7f3k). Só nele aparece a tela do Painel Master. */
export const adminPath = () => {
  const p = '/' + (process.env.ADMIN_PATH ?? '/admin').trim().replace(/^\/+|\/+$/g, '');
  return /^\/[A-Za-z0-9._~-]{3,80}$/.test(p) && !/^\/(api|webhooks|oauth|media|healthz)$/.test(p) ? p : '/admin';
};
