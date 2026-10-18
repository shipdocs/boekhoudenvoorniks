import { describe, expect, it } from 'vitest';
import { friendlySmtpError, verifySmtp } from '../src/documents/smtp-mailer';

const smtp = { host: 'mail.example.nl', port: 465, secure: true, user: 'info@example.nl', fromName: 'Test', fromEmail: 'info@example.nl', bcc: '', replyTo: '' };

describe('e-mail: begrijpelijke foutmeldingen', () => {
  it('zonder opgeslagen wachtwoord: zeg dat het wachtwoord ontbreekt (geen "Missing credentials for PLAIN")', async () => {
    await expect(verifySmtp(smtp, null)).rejects.toThrow(/wachtwoord van je e-mail ontbreekt/);
  });

  it('technische meldingen worden gewone taal', () => {
    expect(friendlySmtpError(new Error('Missing credentials for "PLAIN"')).message).toMatch(/Wachtwoord opslaan/);
    expect(friendlySmtpError(Object.assign(new Error('Invalid login: 535 5.7.8'), { code: 'EAUTH', responseCode: 535 })).message).toMatch(/gebruikersnaam en wachtwoord/);
    expect(friendlySmtpError(new Error('getaddrinfo ENOTFOUND mail.voorbeeld.nl')).message).toMatch(/niet gevonden/);
    expect(friendlySmtpError(new Error('140244:error:1408F10B:SSL routines:ssl3_get_record:wrong version number')).message).toMatch(/465.*587/);
    expect(friendlySmtpError(Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT' })).message).toMatch(/reageert niet/);
  });
});
