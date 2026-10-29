export interface SendResult { wamid: string }

/** Contrato único: o resto do sistema não sabe se o número é da Meta direta ou da Twilio. */
export interface WhatsAppProvider {
  sendText(to: string, body: string): Promise<SendResult>;
  sendTemplate(to: string, name: string, lang: string, params: string[]): Promise<SendResult>;
  markRead?(wamid: string): Promise<void>;
}
