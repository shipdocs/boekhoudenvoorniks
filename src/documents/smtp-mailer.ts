import nodemailer from 'nodemailer';
import type { SmtpSettings } from '../settings/settings';
import type { Mailer, MailMessage } from './sending';

/**
 * Foutmeldingen van de mailserver in gewone taal. Nodemailer geeft Engelse, technische meldingen
 * (bv. 'Missing credentials for "PLAIN"'); die snapt niemand.
 */
export function friendlySmtpError(e: unknown): Error {
  const err = e as { code?: string; responseCode?: number; message?: string };
  const msg = err?.message ?? String(e);
  if (/Missing credentials/i.test(msg)) return new Error('Het wachtwoord van je e-mail ontbreekt. Vul het in bij Instellingen → E-mail en klik op "Wachtwoord opslaan".');
  if (err?.code === 'EAUTH' || err?.responseCode === 535 || /auth/i.test(msg)) return new Error('Inloggen bij de mailserver lukt niet. Controleer je gebruikersnaam en wachtwoord (soms heb je een apart "app-wachtwoord" nodig).');
  if (/wrong version number|ssl3_get_record|tls/i.test(msg)) return new Error('De beveiliging past niet bij de poort. Probeer SSL/TLS met poort 465, of STARTTLS met poort 587.');
  if (err?.code === 'EDNS' || /ENOTFOUND|getaddrinfo/i.test(msg)) return new Error('De mailserver is niet gevonden. Controleer de servernaam, bijvoorbeeld smtp.jouwprovider.nl.');
  if (['ECONNECTION', 'ETIMEDOUT', 'ESOCKET'].includes(err?.code ?? '') || /ECONNREFUSED|ETIMEDOUT|timeout/i.test(msg)) return new Error('De mailserver reageert niet. Controleer de server en de poort, en of je internet hebt.');
  return new Error(`Versturen via je e-mail lukt niet: ${msg}`);
}

function transportFor(smtp: SmtpSettings, password: string | null) {
  if (smtp.user && !password) throw new Error('Het wachtwoord van je e-mail ontbreekt. Vul het in bij Instellingen → E-mail en klik op "Wachtwoord opslaan".');
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: password ?? '' } : undefined,
  });
}

export function createSmtpMailer(smtp: SmtpSettings, password: string | null): Mailer {
  if (!smtp.host || !smtp.fromEmail) throw new Error('Stel eerst je e-mail in bij Instellingen → E-mail');
  const transport = transportFor(smtp, password);
  return {
    async send(message: MailMessage) {
      const info = await transport.sendMail({
        from: smtp.fromName ? { name: smtp.fromName, address: smtp.fromEmail } : smtp.fromEmail,
        to: message.to,
        bcc: message.bcc,
        // "Antwoorden gaan naar": alleen een geldig adres, anders gewoon het afzenderadres
        replyTo: /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(smtp.replyTo?.trim() ?? '') ? smtp.replyTo.trim() : undefined,
        subject: message.subject,
        text: message.text,
        attachments: message.attachments,
      }).catch((e: unknown) => {
        throw friendlySmtpError(e);
      });
      return { messageId: String(info.messageId ?? '') };
    },
  };
}

export async function verifySmtp(smtp: SmtpSettings, password: string | null): Promise<void> {
  if (!smtp.host || !smtp.fromEmail) throw new Error('Vul eerst de mailserver en je e-mailadres in.');
  const transport = transportFor(smtp, password);
  try {
    await transport.verify();
  } catch (e) {
    throw friendlySmtpError(e);
  }
}
