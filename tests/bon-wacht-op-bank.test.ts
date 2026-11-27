import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { makePdf } from './pdf';
import { BANK_WAIT_DAYS, waitsForBank } from '../src/inbox/inbox';
import { addDays, today } from '../src/shared/dates';

/**
 * De bank loopt een dag achter: een bon van vandaag heeft zijn betaling pas morgen. Zo'n bon staat pas op Vandaag
 * als de bank bij is (of na een paar dagen), zodat bon en betaling samen op één kaart komen. Alle namen en bedragen
 * zijn verzonnen.
 */

const nl = (iso: string) => iso.split('-').reverse().join('-');
const receipt = (date: string, extra: string[] = []) => ['Bouwmarkt Voorbeeld', `Datum ${nl(date)}`, 'Schroeven 1 €12,10', ...extra, 'Totaal €12,10', 'BTW 21% €2,10'];

const world = async (opts: { bank?: boolean; date?: string; extra?: string[] } = {}) => {
  const ctx = setup();
  ctx.s.settings.update({ onboardingDone: true });
  const now = today();
  // een afschrift dat gisteren ophoudt: de bank is bij t/m gisteren
  if (opts.bank !== false) ctx.s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: addDays(now, -1), amount: -4500, description: 'ANDERE WINKEL', counterName: 'ANDERE WINKEL' }] });
  const doc = await ctx.s.intake.add('bon.pdf', makePdf(receipt(opts.date ?? now, opts.extra)), now, { autoConfirm: false });
  return { ...ctx, doc, now };
};

describe('bon wacht op de bank', () => {
  it('een bon van vandaag zonder betaling staat nog niet op Vandaag; wel een regel dat hij wacht', async () => {
    const { s, doc, now } = await world();
    expect(s.intake.get(doc.id)).toMatchObject({ status: 'controle', bank_match: null, result: { invoiceDate: { value: now }, total: { value: 1210 } } });
    const home = s.inbox.home(now);
    expect(home.tasks.find((t) => t.ref.documentId === doc.id)).toBeUndefined();
    expect(home.waitingForBank).toBe(1);
  });

  it(`na ${BANK_WAIT_DAYS} dagen zonder nieuw afschrift staat hij er toch`, async () => {
    const { s, doc, now } = await world();
    expect(s.inbox.tasks(addDays(now, BANK_WAIT_DAYS)).find((t) => t.ref.documentId === doc.id)).toBeUndefined();
    const home = s.inbox.home(addDays(now, BANK_WAIT_DAYS + 1));
    expect(home.tasks.find((t) => t.ref.documentId === doc.id)).toMatchObject({ kind: 'document-review' });
    expect(home.waitingForBank).toBe(0);
  });

  it('een bon van gisteren: de bank is al bij en vond niets, dus meteen op Vandaag', async () => {
    const { s, doc, now } = await world({ date: addDays(today(), -1) });
    expect(s.inbox.tasks(now).find((t) => t.ref.documentId === doc.id)).toMatchObject({ kind: 'document-review' });
  });

  it('staat de betaling er al, dan meteen op Vandaag met de betaling op de kaart', async () => {
    const ctx = setup();
    ctx.s.settings.update({ onboardingDone: true });
    const now = today();
    ctx.s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: now, amount: -1210, description: 'BOUWMARKT VOORBEELD', counterName: 'BOUWMARKT VOORBEELD' }] });
    const doc = await ctx.s.intake.add('bon.pdf', makePdf(receipt(now)), now, { autoConfirm: false });
    const card = ctx.s.inbox.tasks(now).find((t) => t.ref.documentId === doc.id)!;
    expect(card.payment).toMatchObject({ date: now, amount: -1210 });
  });

  it('nog nooit een afschrift ingelezen: niet wachten', async () => {
    const { s, doc, now } = await world({ bank: false });
    expect(s.inbox.tasks(now).find((t) => t.ref.documentId === doc.id)).toMatchObject({ kind: 'document-review' });
  });

  it('contant, privé of later betaald, of een rekening met een latere vervaldatum: niet wachten', () => {
    const now = today();
    const result = { invoiceDate: { value: now }, dueDate: null } as never;
    const bon = { bank_match: null, proposed_paid_with: null, result };
    expect(waitsForBank(bon, now, addDays(now, -1))).toBe(true);
    expect(waitsForBank({ ...bon, proposed_paid_with: 'bank' }, now, addDays(now, -1))).toBe(true);
    for (const via of ['kas', 'prive', 'later'] as const) expect(waitsForBank({ ...bon, proposed_paid_with: via }, now, addDays(now, -1))).toBe(false);
    const bill = { ...bon, result: { invoiceDate: { value: now }, dueDate: { value: addDays(now, 14) } } as never };
    expect(waitsForBank(bill, now, addDays(now, -1))).toBe(false);
    expect(waitsForBank(bon, now, now)).toBe(false);
    expect(waitsForBank(bon, now, null)).toBe(false);
  });
});
