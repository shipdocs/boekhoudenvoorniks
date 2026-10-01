import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { financialSnapshot, setup } from './helpers';
import { looksLikeReceipt, onlineInvoiceDomain, receiptHtml, usableAttachments, type MailAttachment, type MailMessage, type MailSource } from '../src/mail/mail-intake';
import { makePdf } from './pdf';

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
    const { s, box, klant } = withMail();
    s.settings.update({ smtp: { ...s.settings.get().smtp, fromEmail: 'piet@example.nl' } });
    const inv = s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-09-01', lines: [{ description: 'Werk', quantity: 1, unitPrice: 10000, vatCode: 'hoog' }] }).id);
    box.add('INBOX', { uid: 1, fromAddress: 'piet@example.nl', subject: `Factuur ${inv.number} van Stukadoorsbedrijf Piet`, attachments: [att('bon.jpg', jpg(1))] });
    expect(await s.mail.poll(box)).toMatchObject({ documents: 0, other: 1 });
  });

  it('een factuur die je zelf doorstuurt vanaf je eigen adres wordt wel verwerkt', async () => {
    const { s, box } = withMail();
    s.settings.update({ company: { ...s.settings.get().company, email: 'info@piet.nl' } });
    box.add('INBOX', { uid: 1, fromAddress: 'Info@Piet.nl', subject: 'Fwd: Knab Boekhoudpakket factuur 202609-018752', attachments: [att('factuur.jpg', jpg(3))] });
    expect(await s.mail.poll(box)).toMatchObject({ documents: 1, other: 0 });
    expect(s.intake.list()[0]!.status).toBe('controle');
  });

  it('even niet te lezen: de volgende keer opnieuw; blijft het mislukken, dan na 3 keer overslaan', async () => {
    const { s, box } = withMail();
    s.settings.update({ mailIn: { ...s.settings.get().mailIn, extraFolders: ['Bestaat niet'] } });
    box.add('INBOX', { uid: 1, attachments: [att('a.jpg', jpg(1))] });
    box.add('INBOX', { uid: 2, attachments: [att('b.jpg', jpg(2))] });
    const orig = box.fetch.bind(box);
    let broken = true;
    box.fetch = async (uid) => { if (uid === 1 && broken) throw new Error('verbinding weg'); return orig(uid); };
    expect(await s.mail.poll(box)).toMatchObject({ documents: 0, errors: 1, missingFolders: ['Bestaat niet'] });
    // verbinding weer goed: bericht 1 komt alsnog binnen
    broken = false;
    expect(await s.mail.poll(box)).toMatchObject({ documents: 2, errors: 0 });
  });

  it('een bericht dat nooit te lezen is, houdt de rest niet voor altijd tegen', async () => {
    const { s, box } = withMail();
    box.add('INBOX', { uid: 1, attachments: [att('a.jpg', jpg(1))] });
    box.add('INBOX', { uid: 2, attachments: [att('b.jpg', jpg(2))] });
    const orig = box.fetch.bind(box);
    box.fetch = async (uid) => { if (uid === 1) throw new Error('kapot'); return orig(uid); };
    expect((await s.mail.poll(box)).documents).toBe(0);
    expect((await s.mail.poll(box)).documents).toBe(0);
    expect(await s.mail.poll(box)).toMatchObject({ documents: 1, errors: 1 });
    expect(s.mail.summary().counts.fout).toBe(1);
  });
});

describe('dubbele bonnen en bewijs uit de mail (#179)', () => {
  const BOUWMAAT = ['Bouwmaat Nederland B.V.', 'Factuurnummer: 2026018472', 'Factuurdatum 23-09-2026', 'Knauf Goldband 100,00', 'BTW 21% 100,00 21,00', 'Totaal 121,00'];

  it('de mail gaat pas naar Verwerkt als elke bijlage bewaard en beoordeeld is', async () => {
    const { s, box } = withMail();
    box.add('INBOX', { uid: 1, attachments: [att('a.pdf', makePdf(['Gamma', 'Datum 01-09-2026', 'Totaal 10,00'])), att('b.pdf', makePdf(['Praxis', 'Datum 02-09-2026', 'Totaal 20,00']))] });
    // bij elke verplaatsing: staan alle bijlagen er al in, en zijn ze beoordeeld?
    const seen: string[][] = [];
    const move = box.move.bind(box);
    box.move = async (uid, target) => { seen.push(s.intake.list().map((d) => `${d.original_name}:${d.status}`).sort()); return move(uid, target); };
    expect(await s.mail.poll(box, '2026-09-05')).toMatchObject({ documents: 2, errors: 0 });
    expect(seen).toEqual([['a.pdf:controle', 'b.pdf:controle']]);
    expect(box.moved).toEqual([{ uid: 1, from: 'INBOX', to: 'Verwerkt' }]);
  });

  it('mislukt een bijlage, dan blijft de mail staan; de volgende keer telt wat al binnen was niet als dubbel', async () => {
    const ctx = withMail();
    const { s, box, db } = ctx;
    box.add('INBOX', { uid: 1, attachments: [att('a.pdf', makePdf(['Gamma', 'Datum 01-09-2026', 'Totaal 10,00'])), att('b.pdf', makePdf(['Praxis', 'Datum 02-09-2026', 'Totaal 20,00']))] });
    const add = s.intake.add.bind(s.intake);
    let broken = true;
    s.intake.add = async (name, ...rest) => { if (broken && name === 'b.pdf') throw new Error('schijf vol'); return add(name, ...rest); };
    expect(await s.mail.poll(box, '2026-09-05')).toMatchObject({ documents: 0, errors: 1 });
    expect(box.moved).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM mail_messages').get()).toEqual({ n: 0 });
    expect(s.intake.list().map((d) => d.original_name)).toEqual(['a.pdf']);
    broken = false;
    expect(await s.mail.poll(box, '2026-09-05')).toMatchObject({ documents: 2, errors: 0 });
    expect(box.moved).toEqual([{ uid: 1, from: 'INBOX', to: 'Verwerkt' }]);
    expect(s.intake.list()).toHaveLength(2);
    expect(ctx.stored).toHaveLength(2);
    // a.pdf kwam bij de eerste poging al binnen: geen melding "stond er al in"
    expect(s.intake.notices()).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM mail_attachment_progress').get()).toEqual({ n: 0 });
  });

  it('exact hetzelfde bestand opnieuw per mail: melding op Vandaag met "Bestaand document bekijken", niets geboekt of veranderd', async () => {
    const ctx = withMail();
    const { s, box } = ctx;
    const pdf = makePdf(BOUWMAAT);
    const eerste = await s.intake.add('factuur.pdf', pdf, '2026-09-25', { autoConfirm: false });
    s.intake.confirm(eerste.id, { supplier: 'Bouwmaat', date: '2026-09-23', total: 12100, invoiceNumber: '2026018472', categoryKey: 'materiaal', vatCode: 'hoog', business: true, paidWith: 'kas' });
    const before = financialSnapshot(ctx, { evidence: true });
    box.add('INBOX', { uid: 1, fromName: 'Bouwmaat', attachments: [att('Factuur 2026018472.pdf', pdf), att('nog-een-keer.pdf', pdf)] });
    expect(await s.mail.poll(box, '2026-09-26')).toMatchObject({ documents: 1, errors: 0 });
    expect(financialSnapshot(ctx, { evidence: true })).toEqual(before);
    expect(ctx.stored).toHaveLength(1);
    // de mail is afgehandeld; twee keer hetzelfde bestand in één mail geeft één melding
    expect(box.moved).toEqual([{ uid: 1, from: 'INBOX', to: 'Verwerkt' }]);
    const tasks = s.inbox.tasks('2026-09-26').filter((t) => t.kind === 'document-notice');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: 'Dit document stond er al in.', ref: { documentId: eerste.id }, actions: [{ id: 'open', label: 'Bestaand document bekijken', primary: true }, { id: 'klaar', label: 'Gezien' }] });
    expect(tasks[0]!.question).toMatch(/Factuur 2026018472\.pdf.*van Bouwmaat.*niets opnieuw geboekt/);
    s.intake.dismissNotice(tasks[0]!.ref.noticeId!);
    expect(s.inbox.tasks('2026-09-26').some((t) => t.kind === 'document-notice')).toBe(false);
  });

  it('zeker dezelfde factuur als ander bestand per mail: beide bewaard, melding op Vandaag, niets opnieuw geboekt', async () => {
    const ctx = withMail();
    const { s, box } = ctx;
    const eerste = await s.intake.add('factuur.pdf', makePdf(BOUWMAAT), '2026-09-25', { autoConfirm: false });
    s.intake.confirm(eerste.id, { supplier: 'Bouwmaat', date: '2026-09-23', total: 12100, invoiceNumber: '2026018472', categoryKey: 'materiaal', vatCode: 'hoog', business: true, paidWith: 'kas' });
    const before = financialSnapshot(ctx);
    box.add('INBOX', { uid: 1, attachments: [att('factuur.xml', UBL)] });
    expect(await s.mail.poll(box, '2026-09-26')).toMatchObject({ documents: 1, errors: 0 });
    expect(financialSnapshot(ctx)).toEqual(before);
    const [xml] = s.intake.list();
    // de losse e-factuur is bewaard als kopie; de leesbare PDF blijft het hoofdbewijsstuk
    expect(xml).toMatchObject({ original_name: 'factuur.xml', outcome: 'dubbel', link: { is_primary: false } });
    expect(s.purchases.list()[0]!.document_id).toBe(eerste.id);
    expect(s.inbox.tasks('2026-09-26').filter((t) => t.kind === 'document-notice')).toEqual([expect.objectContaining({ title: 'Dit document stond er al in.', ref: expect.objectContaining({ documentId: eerste.id }) })]);
  });

  it('mogelijk dubbel of een bon bij een al geboekte betaling per mail: wacht als vraag op Vandaag, niets gekoppeld of geboekt', async () => {
    const ctx = withMail();
    const { s, box } = ctx;
    // een betaling die rechtstreeks als kosten geboekt is, en een geboekte aankoop zonder nummer
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-09-23', amount: -12100, description: 'Pin', counterName: 'BOUWMAAT UTRECHT' }] });
    const payment = s.bank.list()[0]!;
    s.bank.bookToAccount(payment.id, { account: 'WKprInkMat', vatCode: 'hoog' });
    s.quick.recordExpense({ date: '2026-09-02', supplierName: 'Praxis', description: 'Verf', categoryKey: 'materiaal', grossAmount: 2000, vatCode: 'hoog', paidWith: 'kas' });
    const before = financialSnapshot(ctx, { evidence: true });
    box.add('INBOX', { uid: 1, attachments: [att('bouwmaat.pdf', makePdf(BOUWMAAT)), att('praxis.pdf', makePdf(['Praxis', 'Datum 02-09-2026', 'Totaal 20,00']))] });
    expect(await s.mail.poll(box, '2026-09-26')).toMatchObject({ documents: 2, errors: 0 });
    const after = financialSnapshot(ctx, { evidence: true });
    expect({ ...after, documents: [] }).toEqual({ ...before, documents: [] });
    const tasks = s.inbox.tasks('2026-09-26').filter((t) => t.kind === 'document-review');
    expect(tasks.map((t) => t.actions[0]!.id).sort()).toEqual(['bewijs', 'dubbel']);
    expect(s.intake.list().map((d) => [d.status, d.link])).toEqual([['controle', null], ['controle', null]]);
    expect(s.intake.notices()).toEqual([]);
    expect(box.moved).toHaveLength(1);
  });
});

describe('bon in de mailtekst (geen bijlage)', () => {
  // HTML → een echte (minimale) PDF met de tekstregels, zoals de app dat in Electron doet
  const toPdf = async (html: string) => makePdf(html.replace(/<br>/g, '\n').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').split('\n').map((l) => l.trim()).filter(Boolean));
  const bonText = 'Bedankt voor je bestelling bij Bol\n1x Kitpistool € 12,99\n1x Afplaktape € 4,99\nTotaal € 17,98\nBetaald met iDEAL op 20-09-2026';

  it('herkennen: een woord als bestelling/factuur én een bedrag', () => {
    expect(looksLikeReceipt({ subject: 'Je bestelling 1234', text: bonText })).toBe(true);
    expect(looksLikeReceipt({ subject: 'Nieuwsbrief', text: 'Nu 20% korting op alles! Kijk snel op de site voor de aanbiedingen van deze week.' })).toBe(false);
    expect(looksLikeReceipt({ subject: 'Uw factuur staat klaar', text: 'Bekijk hem op https://mijn.kpn.com/facturen – inloggen met je account.' })).toBe(false);
    expect(looksLikeReceipt({ subject: 'Receipt', text: 'Thanks for your order with Uber\nTotal: 23.40\nPaid with Visa ending 1234' })).toBe(true);
  });

  it('alleen de platte tekst: geen plaatjes, links of scripts uit de mail', () => {
    const html = receiptHtml({ fromName: 'Shop', fromAddress: 'noreply@shop.example', subject: '<script>x</script>Bestelling', date: '2026-09-20', text: 'Totaal € 5,00 <img src="https://track.example/p.gif">' });
    expect(html).not.toMatch(/<script>|<img/);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img');
  });

  it('bij het ophalen: de mail wordt een PDF-bon die op controle wacht, en gaat naar Verwerkt', async () => {
    const { s, box } = withMail();
    s.mail.setPdfRenderer(toPdf);
    box.add('INBOX', { uid: 5, fromAddress: 'noreply@bol.example', fromName: 'Bol', subject: 'Je bestelling 1234', text: bonText });
    expect(await s.mail.poll(box, '2026-09-21')).toMatchObject({ documents: 1, other: 0 });
    const doc = s.intake.list()[0]!;
    expect(doc.status).toBe('controle');
    expect(doc.original_name).toMatch(/^mail 2026-09-01 Je bestelling 1234\.pdf$/);
    expect(doc.result?.total?.value).toBe(1798);
    expect(box.moved).toEqual([{ uid: 5, from: 'INBOX', to: 'Verwerkt' }]);
    expect(s.mail.summary().recent[0]!.note).toBe('mailtekst als bon bewaard');
  });

  it('"Toch als bon bewaren" voor een mail die bleef liggen', async () => {
    const { s, box } = withMail();
    s.mail.setPdfRenderer(toPdf);
    box.add('INBOX', { uid: 7, fromAddress: 'info@parkeren.example', subject: 'Parkeersessie', text: 'Je parkeersessie in Utrecht is beëindigd. Kosten 6,40 euro, afgeschreven van je creditcard.' });
    expect(await s.mail.poll(box)).toMatchObject({ other: 1, documents: 0 });
    const rec = s.mail.summary().recent[0]!;
    expect(rec.outcome).toBe('overig');
    const after = await s.mail.saveAsReceipt(box, rec.id);
    expect(after).toMatchObject({ outcome: 'bijlage', note: 'mailtekst als bon bewaard', moved_to: 'Verwerkt' });
    expect(s.intake.list()).toHaveLength(1);
    await expect(s.mail.saveAsReceipt(box, rec.id)).rejects.toThrow(/al verwerkt/);
  });

  it('staat de mail niet meer op dezelfde plek, dan een duidelijke melding', async () => {
    const { s, box } = withMail();
    s.mail.setPdfRenderer(toPdf);
    box.add('INBOX', { uid: 8, messageId: '<a@x>', subject: 'Hallo', text: 'Gewoon een bericht zonder bedrag erin, niets bijzonders hier.' });
    await s.mail.poll(box);
    const rec = s.mail.summary().recent[0]!;
    box.folders.get('INBOX')!.messages[0]!.messageId = '<ander@x>';
    await expect(s.mail.saveAsReceipt(box, rec.id)).rejects.toThrow(/niet meer op dezelfde plek/);
  });
});
