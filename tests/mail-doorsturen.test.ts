import { describe, expect, it } from 'vitest';
import { simpleParser } from 'mailparser';
import { attachmentsOf, mailText, unpack } from '../src/mail/imap-source';
import { receiptHtml } from '../src/mail/mail-intake';

const pdf = Buffer.from('%PDF-1.4\nfactuur\n%%EOF').toString('base64');

/** Een mail die "als bijlage" is doorgestuurd: de factuur zit in de binnenste mail. */
const raw = [
  'From: Piet <info@piet.nl>',
  'To: administratie@piet.nl',
  'Subject: Fwd: factuur Knab',
  'Message-ID: <buiten@piet.nl>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="B1"',
  '',
  '--B1',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Zie bijlage.',
  '--B1',
  'Content-Type: message/rfc822; name="factuur.eml"',
  'Content-Disposition: attachment; filename="factuur.eml"',
  '',
  'From: Knab <facturen@knab.example>',
  'Subject: Uw factuur',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="B2"',
  '',
  '--B2',
  'Content-Type: text/plain',
  '',
  'Bijgaand de factuur.',
  '--B2',
  'Content-Type: application/pdf; name="factuur-202609.pdf"',
  'Content-Disposition: attachment; filename="factuur-202609.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  pdf,
  '--B2--',
  '--B1--',
  '',
].join('\r\n');

describe('doorgestuurde mail', () => {
  it('"als bijlage" doorgestuurd: de factuur uit de binnenste mail komt mee', async () => {
    const parsed = await simpleParser(raw);
    const list = await attachmentsOf(parsed.attachments as never);
    expect(list.map((a) => a.filename)).toEqual(['factuur-202609.pdf']);
    expect(Buffer.from(list[0]!.content).toString().startsWith('%PDF')).toBe(true);
  });

  it('"als bijlage" doorgestuurd: de tekst van de binnenste mail komt mee', async () => {
    const parsed = await simpleParser(raw);
    const { forwardedText } = await unpack(parsed.attachments as never);
    const text = mailText(parsed.text, forwardedText);
    expect(text).toContain('Zie bijlage.');
    expect(text).toMatch(/Van: .*facturen@knab.example/);
    expect(text).toContain('Bijgaand de factuur.');
  });

  it('een lange eigen tekst knipt de doorgestuurde mail niet weg', () => {
    const text = mailText('handtekening '.repeat(3000), 'Totaal € 12,50', 20_000);
    expect(text.length).toBeLessThanOrEqual(20_000);
    expect(text).toContain('Totaal € 12,50');
  });

  it('verborgen preheader vol onzichtbare tekens (Google, Apple) duwt de bon niet naar een volgende pagina', async () => {
    const pad = '&#847;&zwnj;&nbsp;'.repeat(400);
    const html = `<div style="display:none">Your receipt ${pad}</div><table><tr><td>Google Play</td></tr><tr><td>Total: € 1,99</td></tr></table>`;
    const mail = ['From: Martin <info@x.nl>', 'Subject: Fwd: Your Google Play Order Receipt', 'MIME-Version: 1.0', 'Content-Type: text/html; charset=utf-8', '', html, ''].join('\r\n');
    const parsed = await simpleParser(mail, { skipHtmlToText: false, skipTextToHtml: true });
    const text = mailText(parsed.text, '');
    expect(text).not.toMatch(/[\u034f\u200c\u00a0]/);
    expect(text.indexOf('Total: € 1,99')).toBeLessThan(80);
    // ook als de tekst ongeschoond binnenkomt
    expect(receiptHtml({ fromName: '', fromAddress: 'a@b.nl', subject: 'x', date: '2026-09-27', text: parsed.text! })).not.toContain('\u200c');
  });
});
