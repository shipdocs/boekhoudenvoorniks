import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import { computeTotals } from '../src/documents/totals';
import { formatDocumentNumber } from '../src/documents/numbering';
import { renderTemplate } from '../src/documents/render';

const stucwerk = { description: 'Stucwerk woonkamer', quantity: 42.5, unit: 'm²', unitPrice: 1850, vatCode: 'hoog' as const };

describe('totalen', () => {
  it('berekent BTW per tarief over de som', () => {
    const t = computeTotals([
      { description: 'a', quantity: 3, unitPrice: 333, vatCode: 'hoog' },
      { description: 'b', quantity: 1, unitPrice: 1001, vatCode: 'hoog' },
      { description: 'c', quantity: 2, unitPrice: 500, vatCode: 'laag' },
    ]);
    expect(t.subtotal).toBe(999 + 1001 + 1000);
    expect(t.groups.map((g) => [g.vatCode, g.net, g.vat])).toEqual([
      ['hoog', 2000, 420],
      ['laag', 1000, 90],
    ]);
    expect(t.total).toBe(3000 + 510);
  });

  it('nummerformaat', () => {
    expect(formatDocumentNumber('{JJJJ}-{NNNN}', '2026-09-25', 7)).toBe('2026-0007');
    expect(formatDocumentNumber('F{JJ}{MM}{NNN}', '2026-09-25', 12)).toBe('F2609012');
    expect(() => formatDocumentNumber('{JJJJ}', '2026-01-01', 1)).toThrow();
  });

  it('template escaping en secties', () => {
    expect(renderTemplate('{{a}} {{{a}}}', { a: '<b>' })).toBe('&lt;b&gt; <b>');
    expect(renderTemplate('{{#xs}}[{{n}}]{{/xs}}{{^ys}}leeg{{/ys}}', { xs: [{ n: 1 }, { n: 2 }], ys: [] })).toBe('[1][2]leeg');
    expect(renderTemplate('{{#o.p}}{{o.p}}!{{/o.p}}', { o: { p: 'ja' } })).toBe('ja!');
  });
});

describe('facturen', () => {
  it('concept → definitief boekt automatisch de juiste journaalpost', () => {
    const { s, klant } = setup();
    const draft = s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-09-01', lines: [{ description: 'Schilderwerk', quantity: 1, unitPrice: 100000, vatCode: 'hoog' }] });
    expect(draft.number).toBeNull();
    expect(draft.due_date).toBe('2026-09-15');
    const inv = s.invoices.finalize(draft.id);
    expect(inv.number).toBe('2026-0001');
    expect(inv.total).toBe(121000);
    expect(s.ledger.balance(ACCOUNTS.debiteuren)).toBe(121000);
    expect(s.ledger.balance(ACCOUNTS.omzetHoog)).toBe(-100000);
    expect(s.ledger.balance(ACCOUNTS.btwAfdragenHoog)).toBe(-21000);
    expect(() => s.invoices.updateDraft(inv.id, { notes: 'x' })).toThrow(/niet meer aanpassen/);
    expect(() => s.invoices.deleteDraft(inv.id)).toThrow(/7 jaar bewaren/);
  });

  it('nummering is doorlopend zonder gaten, ook als concepten verwijderd worden', () => {
    const { s, klant } = setup();
    const mk = () => s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-03-01', lines: [stucwerk] });
    const a = mk();
    const b = mk();
    const c = mk();
    s.invoices.deleteDraft(b.id);
    expect(s.invoices.finalize(c.id).number).toBe('2026-0001');
    expect(s.invoices.finalize(a.id).number).toBe('2026-0002');
    const next = s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2027-01-02', lines: [stucwerk] });
    expect(s.invoices.finalize(next.id).number).toBe('2027-0001');
  });

  it('controleert wettelijke factuurvereisten', () => {
    const { s, klant, aannemer } = setup();
    const noAddress = s.relations.create({ name: 'Zonder adres' });
    const d1 = s.invoices.createDraft({ relationId: noAddress.id, lines: [stucwerk] });
    expect(() => s.invoices.finalize(d1.id)).toThrow(/Adres/);
    const d2 = s.invoices.createDraft({ relationId: klant.id, lines: [{ ...stucwerk, vatCode: 'verlegd' }] });
    expect(() => s.invoices.finalize(d2.id)).toThrow(/btw-nummer/);
    const d3 = s.invoices.createDraft({ relationId: aannemer.id, lines: [{ ...stucwerk, vatCode: 'verlegd' }] });
    const inv = s.invoices.finalize(d3.id);
    expect(inv.total).toBe(inv.totals.subtotal);
    expect(s.ledger.balance(ACCOUNTS.omzetVerlegd)).toBe(-inv.total!);
    expect(s.invoices.renderHtml(inv.id)).toContain('BTW verlegd');
  });

  it('creditfactuur verrekent met het origineel', () => {
    const { s, klant } = setup();
    const inv = s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-05-01', lines: [stucwerk] }).id);
    const credit = s.invoices.createCreditNote(inv.id);
    expect(credit.totals.total).toBe(-inv.total!);
    const final = s.invoices.finalize(credit.id);
    expect(final.status).toBe('betaald');
    expect(s.invoices.get(inv.id).status).toBe('betaald');
    expect(s.ledger.balance(ACCOUNTS.debiteuren)).toBe(0);
    expect(s.ledger.balance(ACCOUNTS.omzetHoog)).toBe(0);
    expect(s.invoices.renderHtml(final.id)).toContain('Creditfactuur');
  });

  it('deelbetalingen en afboeken van een klein verschil', () => {
    const { s, klant } = setup();
    const inv = s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-05-01', lines: [{ description: 'x', quantity: 1, unitPrice: 10000, vatCode: 'hoog' }] }).id);
    s.invoices.registerPayment(inv.id, { amount: 6000, date: '2026-05-10' });
    expect(s.invoices.get(inv.id).open_amount).toBe(6100);
    s.invoices.registerPayment(inv.id, { amount: 6098, date: '2026-05-20' });
    expect(s.invoices.get(inv.id).status).toBe('verzonden');
    const settled = s.invoices.writeOffRemainder(inv.id, '2026-05-21');
    expect(settled.status).toBe('betaald');
    expect(s.ledger.balance(ACCOUNTS.betalingsverschillen)).toBe(2);
    expect(s.ledger.balance(ACCOUNTS.debiteuren)).toBe(0);
  });

  it('vervallen status', () => {
    const { s, klant } = setup();
    const inv = s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-01-01', lines: [stucwerk] }).id);
    expect(s.invoices.get(inv.id, '2026-01-10').display_status).toBe('openstaand');
    expect(s.invoices.get(inv.id, '2026-02-01').display_status).toBe('vervallen');
    expect(s.invoices.list({ status: 'vervallen' }, '2026-02-01')).toHaveLength(1);
  });

  it('KOR: geen BTW toegestaan', () => {
    const { s, klant } = setup();
    s.settings.update({ kor: true });
    const d = s.invoices.createDraft({ relationId: klant.id, lines: [stucwerk] });
    expect(() => s.invoices.finalize(d.id)).toThrow(/KOR/);
    const ok = s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, lines: [{ ...stucwerk, vatCode: 'vrijgesteld' }] }).id);
    expect(ok.totals.vatTotal).toBe(0);
    expect(s.invoices.renderHtml(ok.id)).toContain('kleineondernemersregeling');
  });
});

describe('offertes', () => {
  it('offerte → factuur in één klik', () => {
    const { s, klant } = setup();
    const q = s.quotes.create({ relationId: klant.id, quoteDate: '2026-04-01', lines: [stucwerk, { description: 'Hoekprofielen', quantity: 12, unitPrice: 395, vatCode: 'hoog' }] });
    expect(q.number).toBe('OFF-2026-0001');
    expect(q.valid_until).toBe('2026-05-01');
    const inv = s.quotes.convertToInvoice(q.id);
    expect(inv.lines).toHaveLength(2);
    expect(inv.quote_id).toBe(q.id);
    expect(s.quotes.get(q.id).status).toBe('gefactureerd');
    expect(() => s.quotes.convertToInvoice(q.id)).toThrow(/al omgezet/);
    expect(s.quotes.renderHtml(q.id)).toContain('Offerte');
  });
});

describe('verzenden', () => {
  it('verstuurt factuur met PDF en maakt hem definitief', async () => {
    const { s, klant, sent } = setup();
    s.settings.update({ smtp: { host: 'smtp.example.nl', port: 587, secure: false, user: 'u', fromName: 'Piet', fromEmail: 'piet@example.nl', bcc: '', replyTo: '' } });
    const d = s.invoices.createDraft({ relationId: klant.id, lines: [stucwerk] });
    const inv = await s.sender.sendInvoice(d.id);
    expect(inv.status).toBe('verzonden');
    expect(inv.sent_at).not.toBeNull();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('jansen@example.nl');
    expect(sent[0]!.subject).toContain(inv.number!);
    expect(sent[0]!.text).toContain('NL91 ABNA 0417 1643 00');
    expect(sent[0]!.attachments[0]!.filename).toMatch(/\.pdf$/);
    expect(s.sender.emailLog('factuur', inv.id)).toHaveLength(1);
  });

  it('automatische herinneringen volgens schema', async () => {
    const { s, klant, sent } = setup();
    s.settings.update({ remindersEnabled: true, reminderDays: [7, 21] });
    const inv = s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-01-01', lines: [stucwerk] }).id);
    expect(s.sender.dueReminders('2026-01-20')).toHaveLength(0); // vervalt 15-01, +7 = 22-01
    expect(s.sender.dueReminders('2026-01-22').map((i) => i.id)).toEqual([inv.id]);
    const r = await s.sender.runAutomaticReminders('2026-01-22');
    expect(r.sent).toBe(1);
    expect(sent[0]!.subject).toMatch(/Herinnering/);
    expect(s.sender.dueReminders('2026-01-30')).toHaveLength(0);
    s.db.prepare(`UPDATE invoices SET last_reminder_at = '2026-01-22 10:00:00' WHERE id = ?`).run(inv.id);
    expect(s.sender.dueReminders('2026-02-05')).toHaveLength(1);
    s.invoices.registerPayment(inv.id, { amount: inv.open_amount, date: '2026-02-01' });
    expect(s.sender.dueReminders('2026-02-05')).toHaveLength(0);
  });
});
