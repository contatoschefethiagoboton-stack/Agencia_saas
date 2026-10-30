import fs from 'node:fs';
import nodemailer from 'nodemailer';

/*
 * E-mail transacional (redefinição de senha). Qualquer SMTP serve: Gmail/Google Workspace (senha de app),
 * Zoho, Resend, SendGrid, Amazon SES. MAIL_OUTBOX_FILE grava em arquivo em vez de enviar (só testes/dev).
 */
export const mailReady = () => Boolean(process.env.MAIL_OUTBOX_FILE || (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS));

let transport: nodemailer.Transporter | null = null;
const smtp = () => transport ??= nodemailer.createTransport({
  host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT ?? 587),
  secure: Number(process.env.SMTP_PORT ?? 587) === 465,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

export async function sendMail(to: string, subject: string, text: string, html: string) {
  const from = process.env.MAIL_FROM ?? process.env.SMTP_USER ?? 'nao-responda@localhost';
  if (process.env.MAIL_OUTBOX_FILE) {
    fs.appendFileSync(process.env.MAIL_OUTBOX_FILE, JSON.stringify({ from, to, subject, text, at: new Date().toISOString() }) + '\n');
    return;
  }
  await smtp().sendMail({ from, to, subject, text, html });
}
