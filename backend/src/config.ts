/** Endereço público do site (retorno do login da Meta, links das artes). No Render, RENDER_EXTERNAL_URL vem automático. */
export const publicUrl = () => (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000').replace(/\/$/, '');
