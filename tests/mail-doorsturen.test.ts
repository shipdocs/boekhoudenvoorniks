import { describe, expect, it } from 'vitest';
import { simpleParser } from 'mailparser';
import { attachmentsOf } from '../src/mail/imap-source';

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
});
