import type { WhatsAppProvider, SendResult } from './types.js';
import { graphBase } from '../../integrations/meta/graph.js';

export const graphUrl = (path: string) => `${graphBase()}/${path}`;

export async function graph(path: string, token: string, body?: Record<string, unknown>, method?: string) {
  const r = await fetch(graphUrl(path), {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json: any = await r.json();
  if (!r.ok) throw Object.assign(new Error(json?.error?.message ?? `Meta ${r.status}`),
                                 { metaCode: json?.error?.code, status: 502 });
  return json;
}

export class MetaCloudProvider implements WhatsAppProvider {
  constructor(private phoneNumberId: string, private token: string) {}

  private async send(payload: Record<string, unknown>): Promise<SendResult> {
    const out = await graph(`${this.phoneNumberId}/messages`, this.token,
                            { messaging_product: 'whatsapp', recipient_type: 'individual', ...payload });
    return { wamid: out.messages[0].id };
  }
  sendText(to: string, body: string) { return this.send({ to, type: 'text', text: { body, preview_url: false } }); }
  sendTemplate(to: string, name: string, lang: string, params: string[]) {
    return this.send({ to, type: 'template', template: { name, language: { code: lang },
      components: params.length ? [{ type: 'body', parameters: params.map(text => ({ type: 'text', text })) }] : [] } });
  }
  async markRead(wamid: string) {
    await graph(`${this.phoneNumberId}/messages`, this.token,
                { messaging_product: 'whatsapp', status: 'read', message_id: wamid });
  }
}

/** OTP de login da plataforma: número próprio da agência + template de categoria "authentication". */
export const sendAuthTemplate = (to: string, code: string) =>
  graph(`${process.env.PLATFORM_WA_PHONE_ID}/messages`, process.env.WHATSAPP_SYSTEM_TOKEN!, {
    messaging_product: 'whatsapp', to, type: 'template', template: {
      name: 'codigo_acesso', language: { code: 'pt_BR' },
      components: [{ type: 'body', parameters: [{ type: 'text', text: code }] },
                   { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] }] } });
