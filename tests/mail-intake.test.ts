import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup } from './helpers';
import { onlineInvoiceDomain, usableAttachments, type MailAttachment, type MailMessage, type MailSource } from '../src/mail/mail-intake';

const UBL = new Uint8Array(readFileSync(join(__dirname, 'fixtures/ubl-invoice.xml')));
const pdf = (text = 'factuur') => new TextEncoder().encode(`%PDF-1.4\n${text}\n%%EOF`);
const jpg = (seed: number) => { const d = new Uint8Array(20_000); d.set([0xff, 0xd8, 0xff, seed]); return d; };
const png = (size: number) => { const d = new Uint8Array(size); d.set([0x89, 0x50, 0x4e, 0x47]); return d; };
const att = (filename: string, content: Uint8Array, contentType = '', inline = false): MailAttachment => ({ filename, content, contentType, inline });

/** Nep-mailbox: berichten per map; houdt bij wat verplaatst is. */
class FakeMailbox implements MailSource {
  folders = new Map<string, { uidValidity: string; messages: MailMessage[] }>();
  moved: { uid: number; from: string; to: string }[] = [];
  private current = '';
  add(folder: string, m: Partial<MailMessage> & { uid: number }, uidValidity = '1') {
    if (!this.folders.has(folder)) this.folders.set(folder, { uidValidity, messages: [] });
    this.folders.get(folder)!.messages.push({ messageId: `<${folder}-${m.uid}@x>`, fromAddress: 'facturen@leverancier.example', fromName: 'Leverancier', subject: 'Factuur', date: '2026-09-01', text: '', attachments: [], ...m });
  }
  async open(folder: string) {
    const f = this.folders.get(folder);
    this.current = folder;
    return f ? { uidValidity: f.uidValidity } : null;
  }
  async list(afterUid: number) {
    return this.folders.get(this.current)!.messages.map((m) => m.uid).filter((u) => u > afterUid).sort((a, b) => a - b);
  }
  async fetch(uid: number) {
    return this.folders.get(this.current)!.messages.find((m) => m.uid === uid) ?? null;
  }
  async move(uid: number, target: string) {
    const f = this.folders.get(this.current)!;
    f.messages = f.messages.filter((m) => m.uid !== uid);
    this.moved.push({ uid, from: this.current, to: target });
  }
}

function withMail() {
  const ctx = setup();
  ctx.s.settings.update({ onboardingDone: true, mailIn: { enabled: true, host: 'imap.example.nl', port: 993, secure: true, user: 'administratie@piet.nl', folder: 'INBOX', extraFolders: [], processedFolder: 'Verwerkt', since: '' } });
  return { ...ctx, box: new FakeMailbox() };
}

describe('bijlagen uit de mail', () => {
  it('alleen echte PDF, JPG, PNG en e-facturen; geen logo\'s, geen vermomde bestanden', () => {
    const files = usableAttachments([
      att('factuur.pdf', pdf()),
      att('virus.pdf', new TextEncoder().encode('MZ....')),
      att('logo.png', png(2000)),
      att('foto.png', png(40_000), 'image/png', true),
      att('bon.png', png(40_000)),
      att('script.js', pdf()),
      att('../../geheim map/fac tuur', pdf()),
    ]);
    expect(files.map((f) => f.name)).toEqual(['factuur.pdf', 'bon.png', 'fac tuur.pdf']);
  });

  it('e-factuur erbij: alleen die (de PDF is dezelfde factuur)', () => {
    expect(usableAttachments([att('factuur.pdf', pdf()), att('factuur.xml', UBL)]).map((f) => f.name)).toEqual(['factuur.xml']);
  });

  it('"factuur staat online": alleen de websitenaam, geen link', () => {
    expect(onlineInvoiceDomain({ subject: 'Je factuur van september staat klaar', text: 'Bekijk hem op https://www.kpn.com/mijn/facturen?id=1' })).toBe('kpn.com');
    expect(onlineInvoiceDomain({ subject: 'Nieuwsbrief', text: 'https://example.com' })).toBeNull();
    expect(onlineInvoiceDomain({ subject: 'Factuur', text: 'http://onveilig.example' })).toBeNull();
  });
});

describe('inkomende post', () => {
  it('bijlage wordt een document dat wacht op controle, en de mail gaat naar Verwerkt', async () => {
    const { s, box } = withMail();
    box.add('INBOX', { uid: 1, attachments: [att('factuur.xml', UBL)] });
    const r = await s.mail.poll(box, '2026-09-02');
    expect(r).toMatchObject({ documents: 1, errors: 0 });
    const docs = s.intake.list();
    expect(docs).toHaveLength(1);
    // nooit vanzelf geboekt vanuit de mail, ook niet een e-factuur
    expect(docs[0]!.status).toBe('controle');
    expect(box.moved).toEqual([{ uid: 1, from: 'INBOX', to: 'Verwerkt' }]);
  });

  it('gelezen, gearchiveerd of opnieuw binnengekomen: nooit dubbel', async () => {
    const { s, box } = withMail();
    s.settings.update({ mailIn: { ...s.settings.get().mailIn, extraFolders: ['Archief'], processedFolder: '' } });
    box.add('INBOX', { uid: 1, messageId: '<a@x>', attachments: [att('bon.jpg', jpg(1))] });
    // dezelfde mail staat ook in het archief (bv. gekopieerd), en een oudere mail alleen in het archief
    box.add('Archief', { uid: 7, messageId: '<a@x>', attachments: [att('bon.jpg', jpg(1))] });
    box.add('Archief', { uid: 8, messageId: '<b@x>', attachments: [att('oud.jpg', jpg(2))] });
    expect((await s.mail.poll(box)).documents).toBe(2);
    // tweede keer ophalen: niets nieuws
    expect((await s.mail.poll(box)).documents).toBe(0);
    // uit het archief wordt nooit iets verplaatst
    expect(box.moved).toEqual([]);
    // map opnieuw aangemaakt (andere UIDVALIDITY, andere nummers): herkend aan de Message-ID
    box.folders.set('INBOX', { uidValidity: '2', messages: [] });
    box.add('INBOX', { uid: 1, messageId: '<a@x>', attachments: [att('bon.jpg', jpg(1))] }, '2');
    expect((await s.mail.poll(box)).documents).toBe(0);
    expect(s.intake.list()).toHaveLength(2);
  });

  it('mail van een klant: niet aanraken, geen bonnetje, wel een seintje op Vandaag', async () => {
    const { s, box, klant } = withMail();
    box.add('INBOX', { uid: 3, fromAddress: 'Jansen@Example.nl', fromName: 'Jan', subject: 'Vraag over factuur', attachments: [att('getekend.pdf', pdf())] });
    const r = await s.mail.poll(box, '2026-09-02');
    expect(r).toMatchObject({ fromCustomers: 1, documents: 0 });
    expect(box.moved).toEqual([]);
    expect(s.intake.list()).toHaveLength(0);
    const task = s.inbox.tasks('2026-09-02').find((t) => t.kind === 'mail-customer')!;
    expect(task.title).toBe(`Mail van ${klant.name}`);
    expect(task.ref.relationId).toBe(klant.id);
    s.inbox.skipTask(task.key);
    expect(s.inbox.tasks('2026-09-02').some((t) => t.kind === 'mail-customer')).toBe(false);
  });

  it('factuur staat online: taak op Vandaag met de websitenaam; andere mail alleen geteld', async () => {
    const { s, box } = withMail();
    box.add('INBOX', { uid: 1, fromName: 'KPN', subject: 'Uw factuur staat klaar', text: 'Zie https://mijn.kpn.com/facturen' });
    box.add('INBOX', { uid: 2, fromName: 'Nieuwsbrief', subject: 'Aanbieding', text: 'https://shop.example' });
    const r = await s.mail.poll(box);
    expect(r).toMatchObject({ onlineInvoices: 1, other: 1 });
    const task = s.inbox.tasks().find((t) => t.kind === 'mail-online')!;
    expect(task.title).toBe('KPN: factuur staat online');
    expect(task.question).toMatch(/mijn\.kpn\.com/);
    expect(box.moved).toEqual([]);
  });

  it('kopie van je eigen factuur (bcc) wordt geen inkoop', async () => {
    const { s, box } = withMail();
    s.settings.update({ smtp: { ...s.settings.get().smtp, fromEmail: 'piet@example.nl' } });
    box.add('INBOX', { uid: 1, fromAddress: 'piet@example.nl', attachments: [att('2026-0001.pdf', pdf())] });
    expect(await s.mail.poll(box)).toMatchObject({ documents: 0, other: 1 });
  });

  it('een bericht dat niet te lezen is, houdt de rest niet tegen; een ontbrekende map wordt gemeld', async () => {
    const { s, box } = withMail();
    s.settings.update({ mailIn: { ...s.settings.get().mailIn, extraFolders: ['Bestaat niet'] } });
    box.add('INBOX', { uid: 1, attachments: [att('a.jpg', jpg(1))] });
    box.add('INBOX', { uid: 2, attachments: [att('b.jpg', jpg(2))] });
    const orig = box.fetch.bind(box);
    box.fetch = async (uid) => { if (uid === 1) throw new Error('kapot'); return orig(uid); };
    const r = await s.mail.poll(box);
    expect(r).toMatchObject({ documents: 1, errors: 1, missingFolders: ['Bestaat niet'] });
  });
});
