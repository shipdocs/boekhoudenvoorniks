import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { ACCOUNTS } from '../src/core-ledger/accounts';

describe('omzet zonder factuur in de app (Mollie, webshop, contant)', () => {
  function received(s: ReturnType<typeof setup>['s'], counterName: string, counterIban: string | undefined, amount = 50000) {
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-08-12', amount, description: 'I-MOL-2026-00344', counterIban, counterName }] });
    return s.bank.list({ status: 'nieuw' }).find((t) => t.counter_name === counterName)!;
  }

  it('Zwitserse klant op naam herkend: voorstel 0% buiten de EU, in rubriek 3a en zonder btw', () => {
    const { s } = setup();
    const ch = s.relations.create({ name: 'Burando Shipping', country: 'CH', vat_number: 'CHE253742182' });
    const t = received(s, 'BURANDO SHIPPING AG', 'CH9300762011623852957');
    const hint = s.bank.salesVatSuggestion(t.id);
    expect(hint).toMatchObject({ vatCode: 'export', relationId: ch.id });
    expect(hint.reason).toMatch(/Burando Shipping/);
    s.bank.bookToAccount(t.id, { account: ACCOUNTS.omzetHoog, vatCode: hint.vatCode, relationId: hint.relationId });
    const r = s.vat.calculate('2026-Q3');
    expect(r.rubrieken.find((x) => x.code === '3a')!.omzet).toBe(50000);
    expect(r.rubrieken.find((x) => x.code === '1a')!.omzet).toBe(0);
    expect(r.rubrieken.find((x) => x.code === '5a')!.btw).toBe(0);
  });

  it('onbekende betaler: land van de IBAN, anders gewoon 21%', () => {
    const { s } = setup();
    expect(s.bank.salesVatSuggestion(received(s, 'Onbekend AG', 'CH9300762011623852957').id)).toMatchObject({ vatCode: 'export', relationId: null });
    expect(s.bank.salesVatSuggestion(received(s, 'Jan Jansen', 'NL91ABNA0417164300').id)).toMatchObject({ vatCode: 'hoog', reason: '' });
    // een particulier in een ander EU-land: gewoon Nederlandse btw (tot de OSS-drempel)
    expect(s.bank.salesVatSuggestion(received(s, 'Hans Müller', 'DE89370400440532013000').id).vatCode).toBe('hoog');
  });

  it('21% blijft werken zoals voorheen: omzet en btw in rubriek 1a', () => {
    const { s } = setup();
    const t = received(s, 'Jan Jansen', 'NL91ABNA0417164300', 12100);
    s.bank.bookToAccount(t.id, { account: ACCOUNTS.omzetHoog, vatCode: 'hoog' });
    const r1a = s.vat.calculate('2026-Q3').rubrieken.find((x) => x.code === '1a')!;
    expect(r1a).toMatchObject({ omzet: 10000, btw: 2100 });
  });
});

describe('voorstel: welke klant hoort bij de betaler', () => {
  function tx(s: ReturnType<typeof setup>['s'], counterName: string, counterIban?: string) {
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-08-12', amount: 50000, description: `betaling ${counterName}`, counterIban, counterName }] });
    return s.bank.list({ status: 'nieuw' }).find((t) => t.counter_name === counterName)!;
  }

  it('een leverancier met dit IBAN telt niet als klant', () => {
    const { s } = setup();
    s.relations.create({ name: 'Zwitserse Leverancier', type: 'leverancier', country: 'CH', iban: 'CH9300762011623852957' });
    expect(s.bank.salesVatSuggestion(tx(s, 'Iemand', 'NL91ABNA0417164300').id).relationId).toBeNull();
    expect(s.bank.salesVatSuggestion(tx(s, 'Iemand anders', 'CH9300762011623852957').id)).toMatchObject({ relationId: null, vatCode: 'export' });
  });

  it('naam: alleen hele woorden, de langste naam wint', () => {
    const { s } = setup();
    s.relations.create({ name: 'Shipping', country: 'NL' });
    const burando = s.relations.create({ name: 'Burando Shipping', country: 'CH' });
    s.relations.create({ name: 'Ando', country: 'US' });
    expect(s.bank.salesVatSuggestion(tx(s, 'BURANDO SHIPPING AG').id).relationId).toBe(burando.id);
    // "Ando" zit wel in "Burando", maar niet als woord
    expect(s.bank.salesVatSuggestion(tx(s, 'Burandos BV').id).relationId).toBeNull();
  });

  it('EU-klant met een btw-nummer van een ander land: gewoon 21%, geen ICP', () => {
    const { s } = setup();
    s.relations.create({ name: 'Müller Handel', country: 'DE', vat_number: 'FR12345678901' });
    expect(s.bank.salesVatSuggestion(tx(s, 'Müller Handel GmbH').id).vatCode).toBe('hoog');
    s.relations.create({ name: 'Schmidt Handel', country: 'DE', vat_number: 'DE123456789' });
    expect(s.bank.salesVatSuggestion(tx(s, 'Schmidt Handel GmbH').id).vatCode).toBe('icp');
  });
});
