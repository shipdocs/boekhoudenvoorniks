import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import { customerVatSituation, suggestedSalesVat } from '../src/shared/vat';

const KLANT_IBAN = 'NL44RABO0123456789'; // staat al bij de klant in tests/helpers.ts

describe('land van de klant en btw', () => {
  it('welke btw hoort bij welke klant', () => {
    expect(customerVatSituation('NL', null)).toBe('nl');
    expect(customerVatSituation(null, null)).toBe('nl');
    expect(customerVatSituation('de', 'DE123456789')).toBe('eu-bedrijf');
    expect(customerVatSituation('BE', '')).toBe('eu-particulier');
    expect(customerVatSituation('US', null)).toBe('buiten-eu');
    expect(customerVatSituation('XYZ', null)).toBe('onbekend');
    expect(suggestedSalesVat('eu-bedrijf')).toBe('icp');
    expect(suggestedSalesVat('buiten-eu')).toBe('export');
    expect(suggestedSalesVat('eu-particulier')).toBeNull();
  });

  it('land bij een klant: landcode in hoofdletters, onbekende code geweigerd', () => {
    const { s } = setup();
    expect(s.relations.create({ name: 'Müller GmbH', country: 'de' }).country).toBe('DE');
    expect(() => s.relations.create({ name: 'X', country: 'Duitsland' })).toThrow(/landcode|twee letters/);
  });

  it('signaal bij 21% btw op een factuur aan een bedrijf in een ander EU-land', () => {
    const { s } = setup();
    const de = s.relations.create({ name: 'Müller GmbH', address: 'Hauptstr. 1', postcode: '10115', city: 'Berlin', country: 'DE', vat_number: 'DE123456789' });
    s.invoices.finalize(s.invoices.createDraft({ relationId: de.id, invoiceDate: '2026-07-10', lines: [{ description: 'Stucwerk', quantity: 1, unitPrice: 100000, vatCode: 'hoog' }] }).id);
    const check = s.vat.checks('2026-Q3').find((c) => c.key === 'eu-bedrijf-met-btw')!;
    expect(check.blocking).toBe(false);
    expect(check.detail).toMatch(/Müller GmbH/);
  });

  it('boven € 10.000 aan particulieren in andere EU-landen: signaal over OSS', () => {
    const { s } = setup();
    const fr = s.relations.create({ name: 'Mme Dupont', address: 'Rue 1', postcode: '75001', city: 'Paris', country: 'FR' });
    s.invoices.finalize(s.invoices.createDraft({ relationId: fr.id, invoiceDate: '2026-03-10', lines: [{ description: 'Advies', quantity: 1, unitPrice: 600000, vatCode: 'hoog' }] }).id);
    expect(s.vat.checks('2026-Q1').map((c) => c.key)).not.toContain('oss-drempel');
    s.invoices.finalize(s.invoices.createDraft({ relationId: fr.id, invoiceDate: '2026-05-10', lines: [{ description: 'Advies', quantity: 1, unitPrice: 500000, vatCode: 'hoog' }] }).id);
    expect(s.vat.checks('2026-Q2').find((c) => c.key === 'oss-drempel')?.detail).toMatch(/11\.000,00/);
  });
});

describe('klant heeft te veel betaald', () => {
  function paidTwice() {
    const { s, klant } = setup();
    s.settings.update({ onboardingDone: true, autopilot: 'voorzichtig' });
    const inv = s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-07-01', lines: [{ description: 'Werk', quantity: 1, unitPrice: 10000, vatCode: 'hoog' }] }).id);
    const pay = (date: string, amount: number) => {
      s.bank.import({ source: 'csv', warnings: [], transactions: [{ date, amount, description: `Betaling ${inv.number}`, counterIban: KLANT_IBAN, counterName: klant.name }] });
      return s.bank.list({ status: 'nieuw' })[0]!;
    };
    s.bank.matchInvoice(pay('2026-07-05', 12100).id, inv.id);
    s.bank.matchInvoice(pay('2026-07-06', 12100).id, inv.id);
    return { s, klant, pay };
  }

  it('twee keer betaald: taak op Vandaag met het bedrag', () => {
    const { s, klant } = paidTwice();
    expect(s.invoices.overpaidCustomers()).toEqual([{ relationId: klant.id, name: klant.name, amount: 12100 }]);
    const task = s.inbox.tasks('2026-07-10').find((t) => t.kind === 'customer-overpaid')!;
    expect(task.title).toMatch(/121,00 te veel betaald/);
    s.inbox.skipTask(task.key);
    expect(s.inbox.tasks('2026-07-10').some((t) => t.kind === 'customer-overpaid')).toBe(false);
  });

  it('de terugbetaling wordt herkend en is geen kosten', () => {
    const { s, klant, pay } = paidTwice();
    const refund = pay('2026-07-12', -12100);
    const task = s.inbox.tasks('2026-07-13').find((t) => t.kind === 'bank-refund')!;
    expect(task.ref).toMatchObject({ bankTransactionId: refund.id, relationId: klant.id });
    const profit = () => s.ledger.balances().filter((b) => b.category === 'omzet' || b.category === 'kosten').reduce((x, b) => x + b.balance, 0);
    const before = profit();
    s.bank.bookToAccount(refund.id, { account: ACCOUNTS.debiteuren, relationId: klant.id });
    expect(profit()).toBe(before);
    expect(s.invoices.overpaidCustomers()).toEqual([]);
    expect(s.inbox.tasks('2026-07-13').some((t) => t.kind === 'customer-overpaid' || t.kind === 'bank-refund')).toBe(false);
  });

  it('een grotere uitgaande betaling aan dezelfde klant is geen terugbetaling', () => {
    const { s, pay } = paidTwice();
    pay('2026-07-12', -50000);
    expect(s.inbox.tasks('2026-07-13').some((t) => t.kind === 'bank-refund')).toBe(false);
  });
});
