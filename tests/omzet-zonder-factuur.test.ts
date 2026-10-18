import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { ACCOUNTS } from '../src/core-ledger/accounts';

describe('omzet zonder factuur in de app (Mollie, webshop, contant)', () => {
  function received(s: ReturnType<typeof setup>['s'], counterName: string, counterIban: string | undefined, amount = 50000) {
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-08-12', amount, description: 'I-MOL-2026-00344', counterIban, counterName }] });
    return s.bank.list({ status: 'nieuw' }).find((t) => t.counter_name === counterName)!;
  }

  it('Zwitserse klant op naam herkend: voorstel dienst buiten de EU, niet in de aangifte en zonder btw', () => {
    const { s } = setup();
    const ch = s.relations.create({ name: 'Burando Shipping', country: 'CH', vat_number: 'CHE253742182' });
    const t = received(s, 'BURANDO SHIPPING AG', 'CH9300762011623852957');
    const hint = s.bank.salesVatSuggestion(t.id);
    expect(hint).toMatchObject({ vatCode: 'dienst-buiten-eu', relationId: ch.id });
    expect(hint.reason).toMatch(/Burando Shipping/);
    s.bank.bookToAccount(t.id, { account: ACCOUNTS.omzetHoog, vatCode: hint.vatCode, relationId: hint.relationId });
    const r = s.vat.calculate('2026-Q3');
    // fiscale review: een dienst aan een bedrijf buiten de EU hoort niet in de Nederlandse aangifte
    expect(r.rubrieken.find((x) => x.code === '3a')!.omzet).toBe(0);
    expect(r.rubrieken.find((x) => x.code === '1a')!.omzet).toBe(0);
    expect(r.summary.omzet).toBe(50000);
    expect(r.rubrieken.find((x) => x.code === '5a')!.btw).toBe(0);
  });

  it('onbekende betaler: land van de IBAN, anders gewoon 21%', () => {
    const { s } = setup();
    expect(s.bank.salesVatSuggestion(received(s, 'Onbekend AG', 'CH9300762011623852957').id)).toMatchObject({ vatCode: 'dienst-buiten-eu', relationId: null });
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
  // elk een eigen bedrag: twee losse afschriften met hetzelfde bedrag op dezelfde dag zonder rekeningnummer
  // telt de app als dezelfde betaling (#184)
  let n = 0;
  function tx(s: ReturnType<typeof setup>['s'], counterName: string, counterIban?: string) {
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-08-12', amount: 50000 + n++, description: `betaling ${counterName}`, counterIban, counterName }] });
    return s.bank.list({ status: 'nieuw' }).find((t) => t.counter_name === counterName)!;
  }

  it('een leverancier met dit IBAN telt niet als klant', () => {
    const { s } = setup();
    s.relations.create({ name: 'Zwitserse Leverancier', type: 'leverancier', country: 'CH', iban: 'CH9300762011623852957' });
    expect(s.bank.salesVatSuggestion(tx(s, 'Iemand', 'NL91ABNA0417164300').id).relationId).toBeNull();
    expect(s.bank.salesVatSuggestion(tx(s, 'Iemand anders', 'CH9300762011623852957').id)).toMatchObject({ relationId: null, vatCode: 'dienst-buiten-eu' });
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
    expect(s.bank.salesVatSuggestion(tx(s, 'Schmidt Handel GmbH').id).vatCode).toBe('icp-dienst');
  });
});

describe('verkoop via een ander systeem: de app onthoudt het', () => {
  const IBAN = 'CH9300762011623852957';
  function pay(s: ReturnType<typeof setup>['s'], date: string, ref: string, counterIban: string | undefined = IBAN, counterName = 'BURANDO SHIPPING AG') {
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date, amount: 50000, description: ref, counterIban, counterName }] });
    return s.bank.list({ status: 'nieuw' }).find((t) => t.description === ref)!;
  }

  it('eerste keer kiezen, daarna "net als vorige keer" met één klik', () => {
    const { s } = setup();
    const ch = s.relations.create({ name: 'Burando Shipping', country: 'CH' });
    const first = pay(s, '2026-08-12', 'I-MOL-2026-00343');
    expect(s.bank.previousSale(first.id)).toBeNull();
    s.bank.bookSale(first.id, { vatCode: 'export', relationId: ch.id, channel: ' Mollie ', reference: 'I-MOL-2026-00343' });
    expect(s.bank.saleChannels()).toEqual(['Mollie']);

    const second = pay(s, '2026-09-22', 'I-MOL-2026-00344');
    expect(s.bank.previousSale(second.id)).toMatchObject({ vatCode: 'export', channel: 'Mollie', relationId: ch.id, date: '2026-08-12' });
    const task = s.inbox.tasks('2026-09-23').find((t) => t.ref.bankTransactionId === second.id)!;
    expect(task.kind).toBe('bank-sale');
    expect(task.question).toBe('Weer een verkoop via Mollie, net als vorige keer (goederen naar buiten de EU, 0% btw)?');

    s.bank.repeatSale(second.id);
    const lines = s.db.prepare(`SELECT e.description FROM journal_entries e JOIN bank_transactions b ON b.matched_journal_entry_id = e.id WHERE b.id = ?`).get(second.id) as { description: string };
    expect(lines.description).toBe('Verkoop via Mollie · factuur/bon I-MOL-2026-00344 · BURANDO SHIPPING AG');
    const r = s.vat.calculate('2026-Q3');
    expect(r.rubrieken.find((x) => x.code === '3a')!.omzet).toBe(100000);
    expect(r.rubrieken.find((x) => x.code === '5a')!.btw).toBe(0);
  });

  it('geen voorstel als de vorige keer iets anders was of is teruggedraaid', () => {
    const { s } = setup();
    const a = pay(s, '2026-08-01', 'eerste');
    s.bank.bookToAccount(a.id, { account: ACCOUNTS.priveStortingen });
    expect(s.bank.previousSale(pay(s, '2026-08-02', 'tweede').id)).toBeNull();

    const other = pay(s, '2026-08-03', 'derde', 'NL91ABNA0417164300', 'Jan Jansen');
    s.bank.bookSale(other.id, { vatCode: 'hoog' });
    const next = pay(s, '2026-08-04', 'vierde', 'NL91ABNA0417164300', 'Jan Jansen');
    expect(s.bank.previousSale(next.id)).toMatchObject({ vatCode: 'hoog', channel: null });
    s.bank.unmatch(other.id);
    expect(s.bank.previousSale(next.id)).toBeNull();
    expect(() => s.bank.repeatSale(next.id)).toThrow(/geen eerdere verkoop/);
  });

  it('een verkoop is geld dat binnenkomt', () => {
    const { s } = setup();
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-08-01', amount: -500, description: 'uit', counterName: 'X' }] });
    const t = s.bank.list({ status: 'nieuw' })[0]!;
    expect(() => s.bank.bookSale(t.id, { vatCode: 'hoog' })).toThrow(/binnenkomt/);
  });
});
