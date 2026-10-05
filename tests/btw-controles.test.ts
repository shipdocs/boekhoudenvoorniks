import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import { ICP_MONTHLY_GOODS_LIMIT } from '../src/btw/checks';
import { suppletieTermijn } from '../src/btw/btw';

type S = ReturnType<typeof setup>['s'];
const keys = (s: S, period: string) => s.vat.checks(period).map((c) => c.key);
function euCustomer(s: S) {
  return s.relations.create({ name: 'Bau GmbH', address: 'Hauptstraße 1', postcode: '47533', city: 'Kleve', country: 'de', vat_number: 'DE 123456789', email: 'info@bau.example' });
}
const customers = new WeakMap<S, ReturnType<typeof euCustomer>>();
function icpSale(s: S, date: string, amount: number, vatCode: 'icp' | 'icp-dienst' = 'icp') {
  const de = customers.get(s) ?? euCustomer(s);
  customers.set(s, de);
  s.invoices.finalize(s.invoices.createDraft({ relationId: de.id, invoiceDate: date, lines: [{ description: 'EU', quantity: 1, unitPrice: amount, vatCode }] }).id);
}

describe('ICP: maandopgaaf voor goederen boven € 50.000 per kwartaal', () => {
  it('precies de grens is nog geen overschrijding', () => {
    const { s } = setup();
    icpSale(s, '2026-07-10', ICP_MONTHLY_GOODS_LIMIT);
    expect(keys(s, '2026-Q3')).not.toContain('icp-maandelijks');
  });
  it('één cent erboven: waarschuwing met bedragen per maand', () => {
    const { s } = setup();
    icpSale(s, '2026-07-10', ICP_MONTHLY_GOODS_LIMIT);
    icpSale(s, '2026-08-10', 1);
    const check = s.vat.checks('2026-Q3').find((c) => c.key === 'icp-maandelijks')!;
    expect(check).toMatchObject({ blocking: false });
    expect(check.detail).toContain('juli 2026');
    expect(check.detail).toContain('per maand');
  });
  it('diensten tellen niet mee voor de grens', () => {
    const { s } = setup();
    icpSale(s, '2026-07-10', ICP_MONTHLY_GOODS_LIMIT * 2, 'icp-dienst');
    expect(keys(s, '2026-Q3')).not.toContain('icp-maandelijks');
  });
  it('een overschrijding in een van de vier vorige kwartalen blijft gelden zolang er goederen geleverd worden', () => {
    const { s } = setup();
    icpSale(s, '2026-01-10', ICP_MONTHLY_GOODS_LIMIT + 100);
    icpSale(s, '2026-07-10', 1000);
    expect(keys(s, '2026-Q3')).toContain('icp-maandelijks');
    // zonder levering in het huidige kwartaal is er niets op te geven
    expect(keys(s, '2026-Q4')).not.toContain('icp-maandelijks');
    // en na vijf kwartalen onder de grens is het kwartaal weer genoeg
    icpSale(s, '2027-10-10', 1000);
    expect(keys(s, '2027-Q4')).not.toContain('icp-maandelijks');
  });
});

describe('ICP-grens: wanneer geleverd is telt, niet wanneer het in een aangifte staat', () => {
  it('een late correctie telt mee in het kwartaal van de factuurdatum', () => {
    const { s } = setup();
    icpSale(s, '2026-07-10', ICP_MONTHLY_GOODS_LIMIT);
    s.vat.markSubmitted('2026-Q3');
    icpSale(s, '2026-08-01', 1000); // te laat geboekt: komt in de aangifte van Q4 terecht
    expect(keys(s, '2026-Q3')).toContain('icp-maandelijks');
  });
  it('bij een maandaangifte telt het lopende kwartaal alleen tot het einde van die maand', () => {
    const { s } = setup();
    icpSale(s, '2026-07-10', 3000000);
    icpSale(s, '2026-09-10', 3000000);
    expect(keys(s, '2026-07')).not.toContain('icp-maandelijks');
    expect(keys(s, '2026-09')).toContain('icp-maandelijks');
  });
});

describe('Tarief-plausibiliteit', () => {
  const post = (s: S, btw: number) =>
    s.ledger.post({
      date: '2026-07-10',
      description: 'Handmatige verkoop',
      source: 'handmatig',
      lines: [
        { account: ACCOUNTS.kas, debit: 10000 + btw },
        { account: ACCOUNTS.omzetHoog, credit: 10000 },
        { account: ACCOUNTS.btwAfdragenHoog, credit: btw },
      ],
    });
  it('een gewone factuur geeft geen melding', () => {
    const { s, klant } = setup();
    s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-07-10', lines: [{ description: 'x', quantity: 1, unitPrice: 99999, vatCode: 'hoog' }] }).id);
    expect(keys(s, '2026-Q3')).not.toContain('tarief-plausibel');
  });
  it('btw die niet 21% van de omzet is, wordt gemeld', () => {
    const { s } = setup();
    post(s, 1500);
    const check = s.vat.checks('2026-Q3').find((c) => c.key === 'tarief-plausibel')!;
    expect(check.count).toBe(1);
    expect(check.detail).toContain('Handmatige verkoop');
  });
  it('een foute verkoop die is teruggedraaid, geeft geen melding meer', () => {
    const { s } = setup();
    const id = post(s, 1500);
    expect(keys(s, '2026-Q3')).toContain('tarief-plausibel');
    s.ledger.reverse(id, '2026-07-11');
    expect(keys(s, '2026-Q3')).not.toContain('tarief-plausibel');
  });
  it('afronding binnen € 1 telt niet', () => {
    const { s } = setup();
    post(s, 2100 + 99);
    expect(keys(s, '2026-Q3')).not.toContain('tarief-plausibel');
  });
});

describe('Rekening met de Belastingdienst', () => {
  function q3Submitted() {
    const ctx = setup();
    const { s, klant } = ctx;
    s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-07-10', lines: [{ description: 'x', quantity: 1, unitPrice: 100000, vatCode: 'hoog' }] }).id);
    s.vat.markSubmitted('2026-Q3');
    return ctx;
  }
  const pay = (s: S, amount: number) =>
    s.ledger.post({ date: '2026-10-20', description: 'Betaling Belastingdienst', source: 'handmatig', lines: [{ account: ACCOUNTS.btwAfrekening, debit: amount }, { account: ACCOUNTS.kas, credit: amount }] });
  it('nog niet betaald: staat gelijk aan de vorige aangifte, geen melding', () => {
    const { s } = q3Submitted();
    expect(keys(s, '2026-Q4')).not.toContain('btw-afrekening');
  });
  it('volledig betaald: geen melding', () => {
    const { s } = q3Submitted();
    pay(s, 21000);
    expect(keys(s, '2026-Q4')).not.toContain('btw-afrekening');
  });
  it('een afwijkend bedrag betaald: melding met de boekingen erachter', () => {
    const { s } = q3Submitted();
    pay(s, 15000);
    const check = s.vat.checks('2026-Q4').find((c) => c.key === 'btw-afrekening')!;
    expect(check).toMatchObject({ blocking: false, account: { rgs: ACCOUNTS.btwAfrekening } });
    expect(check.title).toContain('60,00');
  });
});

describe('Omzet in aangiftes tegenover het grootboek (laatste aangifte)', () => {
  it('geen verschil: geen melding', () => {
    const { s, klant } = setup();
    s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-02-10', lines: [{ description: 'x', quantity: 1, unitPrice: 100000, vatCode: 'hoog' }] }).id);
    expect(keys(s, '2026-Q4')).not.toContain('omzet-afstemming');
  });
  it('een correctie die via een suppletie loopt, geeft een verschil van de omzet in de melding', () => {
    const { s, klant } = setup();
    s.vat.markSubmitted('2026-Q3');
    s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-08-01', lines: [{ description: 'groot', quantity: 1, unitPrice: 1000000, vatCode: 'hoog' }] }).id);
    const check = s.vat.checks('2026-Q4').find((c) => c.key === 'omzet-afstemming')!;
    expect(check.title).toContain('10.000,00');
    expect(s.vat.turnoverReconciliation(2026)).toMatchObject({ aangifte: 0, grootboek: 1000000 });
  });
  it('een factuur die door de jaarovergang in het volgende jaar in de aangifte staat, wordt als zodanig verklaard', () => {
    const { s, klant } = setup();
    s.vat.markSubmitted('2026-Q4');
    s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-12-30', lines: [{ description: 'laat', quantity: 1, unitPrice: 100000, vatCode: 'hoog' }] }).id);
    const r = s.vat.turnoverReconciliation(2026);
    expect(r).toMatchObject({ aangifte: 0, grootboek: 100000, jaarovergang: 100000, correcties: 0 });
    const check = s.vat.checks('2026-Q4').find((c) => c.key === 'omzet-afstemming')!;
    expect(check.detail).toMatch(/volledig verklaard/);
  });
  it('alleen in de laatste aangifte van het jaar', () => {
    const { s, klant } = setup();
    s.vat.markSubmitted('2026-Q3');
    s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-08-01', lines: [{ description: 'groot', quantity: 1, unitPrice: 1000000, vatCode: 'hoog' }] }).id);
    expect(keys(s, '2026-Q2')).not.toContain('omzet-afstemming');
  });
});

describe('Suppletie: termijn van acht weken', () => {
  it('te weinig aangegeven: termijn en gevolgen staan in de tekst', () => {
    expect(suppletieTermijn(210000)).toMatch(/acht weken.*belastingrente/);
    expect(suppletieTermijn(-210000)).toMatch(/acht weken/);
  });
  it('waarschuwing in de aangifte en taak in de inbox noemen de termijn', () => {
    const { s, klant } = setup();
    s.vat.markSubmitted('2026-Q3');
    s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-08-01', lines: [{ description: 'groot', quantity: 1, unitPrice: 1000000, vatCode: 'hoog' }] }).id);
    expect(s.vat.calculate('2026-Q4').warnings.join(' ')).toMatch(/acht weken/);
    expect(s.inbox.tasks().find((t) => t.kind === 'vat-suppletie')!.question).toMatch(/acht weken/);
  });
  it('exact € 1.000 btw is nog geen suppletie', () => {
    const { s, klant } = setup();
    s.vat.markSubmitted('2026-Q3');
    // € 1.000 btw over € 4.761,90 + 21% = 1.000,00 (afgerond op de cent)
    s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-08-01', lines: [{ description: 'grens', quantity: 1, unitPrice: 476190, vatCode: 'hoog' }] }).id);
    expect(s.vat.calculate('2026-Q4').corrections).toMatchObject([{ btw: 100000, suppletie: false }]);
  });
});

describe('Investeringsaftrek en personenauto', () => {
  it('een nieuwe auto telt standaard niet mee voor de KIA', async () => {
    const { s } = setup();
    s.purchases.create({ invoiceDate: '2026-03-01', description: 'Auto', lines: [{ account: ACCOUNTS.vervoermiddelen, netAmount: 1000000, vatCode: 'hoog' }] });
    s.purchases.create({ invoiceDate: '2026-03-02', description: 'Laptop', lines: [{ account: ACCOUNTS.inventaris, netAmount: 300000, vatCode: 'hoog' }] });
    const assets = s.assets.list({}, '2026-12-31');
    expect(assets.find((a) => a.name.includes('Auto'))!.kia_excluded).toBe(1);
    expect(assets.find((a) => a.name.includes('Laptop'))!.kia_excluded).toBe(0);
    expect(s.taxOverview.adjustments(2026, '2026-12-31')).toMatchObject({ investments: 300000 });
  });
  it('een vervoermiddel dat wel meetelt (bestelauto), geeft een controlevraag', () => {
    const { s } = setup();
    s.purchases.create({ invoiceDate: '2026-03-01', description: 'Bestelbus', lines: [{ account: ACCOUNTS.vervoermiddelen, netAmount: 1000000, vatCode: 'hoog' }] });
    const bus = s.assets.list({}, '2026-12-31')[0]!;
    s.assets.update(bus.id, { kiaExcluded: false });
    expect(s.taxOverview.adjustments(2026, '2026-12-31')).toMatchObject({ investments: 1000000 });
    expect(s.taxOverview.year(2026, '2026-12-31').items.some((i) => i.key === 'kia-auto')).toBe(true);
    s.assets.update(bus.id, { kiaExcluded: true });
    expect(s.taxOverview.year(2026, '2026-12-31').items.some((i) => i.key === 'kia-auto')).toBe(false);
  });
});
