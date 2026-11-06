import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import type { FetchLike } from '../src/integrations/types';

/**
 * Een factuur uit Mollie Facturen is een bestaand document: de app neemt nummer, datum en vervaldatum over, ook als
 * hij nog niet betaald is, en geeft hem geen nummer uit de eigen reeks. Betaald is hij in de app alleen als het geld
 * via Mollie ging, of als de betaling op de bank staat; "op betaald gezet" in Mollie is geen geld.
 */

const eur = (value: string) => ({ value, currency: 'EUR' });
const factuur = (over: Record<string, unknown> = {}) => ({
  id: 'invoice_1',
  status: 'issued',
  invoiceNumber: 'I-MOL-2026-00010',
  currency: 'EUR',
  vatMode: 'exclusive',
  recipient: { type: 'business', organizationName: 'Rederij Voorbeeld', vatNumber: 'NL004455667B01', email: 'info@rederij.example', streetAndNumber: 'Kade 3', postalCode: '3000 AB', city: 'Rotterdam', country: 'NL' },
  lines: [{ description: 'Abonnement oktober', quantity: 1, vatRate: '21.00', unitPrice: eur('100.00') }],
  totalAmount: eur('121.00'),
  issuedAt: '2026-10-21T00:00:00Z',
  dueAt: '2026-11-20T00:00:00Z',
  paidAt: null,
  createdAt: '2026-10-21T00:00:00Z',
  ...over,
});

function withMollie(invoices: unknown[]) {
  const page = { _embedded: { invoices }, _links: { next: null } };
  const fetch: FetchLike = async (url) =>
    url.includes('api.mollie.com/v2/sales-invoices') ? { ok: true, status: 200, json: async () => page, text: async () => JSON.stringify(page) } : { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' };
  const ctx = setup({ fetch });
  ctx.s.integrations.configure('mollie-facturen', { apiKey: 'access_x' }, true);
  const row = () => ctx.db.prepare(`SELECT number, invoice_date, due_date, status, total, amount_paid, paid_at FROM invoices WHERE external_id = 'invoice_1'`).get() as Record<string, unknown> | undefined;
  return { ...ctx, page, row, sync: () => ctx.s.integrations.sync('mollie-facturen') };
}

describe('Mollie Facturen: de factuur zoals hij in Mollie staat', () => {
  it('een verstuurde factuur komt erin als open factuur, met het nummer, de datum en de vervaldatum uit Mollie', async () => {
    const { s, row, sync } = withMollie([factuur()]);
    const before = s.invoices.nextNumber('2026-10-21').number;
    expect(await sync()).toMatchObject({ created: 1 });
    expect(row()).toEqual({ number: 'I-MOL-2026-00010', invoice_date: '2026-10-21', due_date: '2026-11-20', status: 'verzonden', total: 12100, amount_paid: 0, paid_at: null });
    // de nummerreeks van de app blijft onaangeroerd
    expect(s.invoices.nextNumber('2026-10-21').number).toBe(before);
    expect(s.ledger.balance(ACCOUNTS.debiteuren)).toBe(12100);
    expect(s.ledger.balance(ACCOUNTS.tussenrekeningPsp)).toBe(0);
    expect(s.ledger.checkIntegrity().balanced).toBe(true);
  });

  it.each(['draft', 'cancelled', 'issuing', 'failed'])('een factuur met status %s komt er niet in', async (status) => {
    const { row, sync } = withMollie([factuur({ status })]);
    expect(await sync()).toMatchObject({ created: 0 });
    expect(row()).toBeUndefined();
  });

  it('via Mollie betaald (betaallink): betaald via de tussenrekening, op de dag van betalen', async () => {
    const { s, row, sync } = withMollie([factuur({ status: 'paid', paidAt: '2026-11-05T10:00:00Z', paymentDetails: { source: 'payment-link' } })]);
    await sync();
    expect(row()).toMatchObject({ invoice_date: '2026-10-21', status: 'betaald', paid_at: '2026-11-05' });
    expect(s.ledger.balance(ACCOUNTS.tussenrekeningPsp)).toBe(12100);
  });

  it.each([
    ['in Mollie op betaald gezet', { source: 'manual' }],
    ['zonder opgave hoe er betaald is', undefined],
  ])('%s, zonder betaling op de bank: open, niets op de tussenrekening', async (_, paymentDetails) => {
    const { s, row, sync } = withMollie([factuur({ status: 'paid', paidAt: '2026-11-05T10:00:00Z', ...(paymentDetails ? { paymentDetails } : {}) })]);
    expect(await sync()).toMatchObject({ created: 1 });
    expect(row()).toMatchObject({ status: 'verzonden', amount_paid: 0 });
    expect(s.ledger.balance(ACCOUNTS.tussenrekeningPsp)).toBe(0);
  });

  it('in Mollie op betaald gezet en de overboeking staat al op de bank: verrekend met die bankregel', async () => {
    const { s, row, sync } = withMollie([factuur({ status: 'paid', paidAt: '2026-11-05T10:00:00Z', paymentDetails: { source: 'manual' } })]);
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-11-04', amount: 12100, description: 'I-MOL-2026-00010', counterName: 'Rederij Voorbeeld' }] });
    await sync();
    expect(row()).toMatchObject({ status: 'betaald', paid_at: '2026-11-04' });
    expect(s.ledger.balance(ACCOUNTS.tussenrekeningPsp)).toBe(0);
  });

  it('een open factuur die later via Mollie betaald wordt: bij het volgende bijwerken betaald via de tussenrekening', async () => {
    const { s, page, row, sync } = withMollie([factuur()]);
    await sync();
    expect(row()).toMatchObject({ status: 'verzonden' });
    // intussen nieuwere facturen erbij: de app leest door tot hij de open factuur weer heeft gezien
    page._embedded.invoices = [factuur({ id: 'invoice_2', invoiceNumber: 'I-MOL-2026-00011' }), factuur({ status: 'paid', paidAt: '2026-11-05T10:00:00Z', paymentDetails: { source: 'payment-link' } })];
    const r = await sync();
    expect(r).toMatchObject({ created: 1 });
    expect(r.messages.join(' ')).toContain('I-MOL-2026-00010');
    expect(row()).toMatchObject({ status: 'betaald', paid_at: '2026-11-05' });
    expect(s.ledger.balance(ACCOUNTS.tussenrekeningPsp)).toBe(12100);
    // daarna verandert er niets meer
    await sync();
    expect(s.ledger.balance(ACCOUNTS.tussenrekeningPsp)).toBe(12100);
  });

  it('een open factuur die in Mollie op betaald gezet is: blijft open tot de betaling op de bank staat', async () => {
    const { s, page, row, sync } = withMollie([factuur()]);
    await sync();
    page._embedded.invoices = [factuur({ status: 'paid', paidAt: '2026-11-05T10:00:00Z', paymentDetails: { source: 'manual' } })];
    await sync();
    expect(row()).toMatchObject({ status: 'verzonden', amount_paid: 0 });
    expect(s.ledger.balance(ACCOUNTS.tussenrekeningPsp)).toBe(0);
  });

  it('een nummer dat al in de app staat: niet een tweede keer, maar een melding', async () => {
    const { s, db, sync } = withMollie([factuur()]);
    await sync();
    const id = (db.prepare(`SELECT id FROM invoices WHERE external_id = 'invoice_1'`).get() as { id: number }).id;
    expect(() => s.invoices.finalize(s.invoices.createDraft({ relationId: 1, invoiceDate: '2026-10-21', lines: [{ description: 'x', quantity: 1, unitPrice: 100, vatCode: 'hoog' }] }).id, { number: 'I-MOL-2026-00010' })).toThrow(/staat al in de app/);
    expect(s.invoices.get(id).number).toBe('I-MOL-2026-00010');
  });

  it('een nog niet betaalde factuur aan je eigen bedrijf: niets geboekt, je boekt hem zelf', async () => {
    const { s, row, sync } = withMollie([factuur({ recipient: { type: 'business', organizationName: 'Eigen Bedrijf', vatNumber: 'NL123456789B01', email: 'eigen@example.nl', country: 'NL' } })]);
    s.integrations.setOwnCompany(() => ({ name: 'Eigen Bedrijf', vatNumber: 'NL123456789B01', kvkNumber: '12345678', ibans: [], email: 'eigen@example.nl' }), s.bank);
    await sync();
    expect(row()).toBeUndefined();
    expect(s.integrations.questions().map((q) => q.reason)).toEqual(['zelf']);
  });
});
