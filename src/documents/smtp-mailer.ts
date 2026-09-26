import nodemailer from 'nodemailer';
import type { SmtpSettings } from '../settings/settings';
import type { Mailer, MailMessage } from './sending';

export function createSmtpMailer(smtp: SmtpSettings, password: string | null): Mailer {
  if (!smtp.host || !smtp.fromEmail) throw new Error('Stel eerst je e-mail in bij Instellingen → E-mail');
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: password ?? '' } : undefined,
  });
  return {
    async send(message: MailMessage) {
      const info = await transport.sendMail({
        from: smtp.fromName ? { name: smtp.fromName, address: smtp.fromEmail } : smtp.fromEmail,
        to: message.to,
        bcc: message.bcc,
        subject: message.subject,
        text: message.text,
        attachments: message.attachments,
      });
      return { messageId: String(info.messageId ?? '') };
    },
  };
}

export async function verifySmtp(smtp: SmtpSettings, password: string | null): Promise<void> {
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: password ?? '' } : undefined,
  });
  await transport.verify();
}
