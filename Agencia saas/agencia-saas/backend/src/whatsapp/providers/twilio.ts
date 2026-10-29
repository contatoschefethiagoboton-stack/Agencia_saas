import type { WhatsAppProvider, SendResult } from './types.js';

const auth = () => 'Basic ' + Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
export const twilioApi = (path: string) =>
  `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/${path}`;

export async function twilioPost(url: string, form: Record<string, string>) {
  const r = await fetch(url, { method: 'POST', headers: { Authorization: auth(),
    'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) });
  const json: any = await r.json();
  if (!r.ok) throw Object.assign(new Error(json?.message ?? `Twilio ${r.status}`), { status: 502 });
  return json;
}
export async function twilioGet(url: string) {
  const r = await fetch(url, { headers: { Authorization: auth() } });
  if (!r.ok) throw Object.assign(new Error(`Twilio ${r.status}`), { status: 502 });
  return r.json() as Promise<any>;
}

/** Twilio como BSP: o número é registrado como remetente WhatsApp na própria Twilio. */
export class TwilioProvider implements WhatsAppProvider {
  constructor(private fromE164: string) {}

  private send(form: Record<string, string>): Promise<SendResult> {
    return twilioPost(twilioApi('Messages.json'), {
      From: `whatsapp:${this.fromE164}`, StatusCallback: `${process.env.PUBLIC_URL}/webhooks/twilio/status`, ...form,
    }).then(m => ({ wamid: m.sid as string }));
  }
  sendText(to: string, body: string) { return this.send({ To: `whatsapp:+${to}`, Body: body }); }
  /** Na Twilio, templates aprovados viram "Content Templates" (ContentSid). `name` = ContentSid. */
  sendTemplate(to: string, contentSid: string, _lang: string, params: string[]) {
    const vars = Object.fromEntries(params.map((p, i) => [String(i + 1), p]));
    return this.send({ To: `whatsapp:+${to}`, ContentSid: contentSid, ContentVariables: JSON.stringify(vars) });
  }
}
