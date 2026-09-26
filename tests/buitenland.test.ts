import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import { BUITENLAND_DISCLAIMER } from '../src/btw/btw';
import { reverseChargeOrigin } from '../src/intake/classify';
import { estimateIncomeTax, rulesFor } from '../src/tax/income-tax';

const rubrieken = (s: ReturnType<typeof setup>['s'], key: string) => Object.fromEntries(s.vat.calculate(key).rubrieken.map((x) => [x.code, x]));

describe('Buitenland (#16)', () => {
  it('verkoop aan een EU-bedrijf: 3b, geen btw, ICP-overzicht en disclaimer', () => {
    const { s } = setup();
    const de = s.relations.create({ name: 'Bau GmbH', address: 'Hauptstraße 1', postcode: '47533', city: 'Kleve', country: 'de', vat_number: 'DE 123456789', email: 'info@bau.example' });
    const inv = s.invoices.createDraft({ relationId: de.id, invoiceDate: '2026-07-10', lines: [{ description: 'Stucwerk Kleve', quantity: 1, unitPrice: 250000, vatCode: 'icp' }] });
    s.invoices.finalize(inv.id);
    const r = s.vat.calculate('2026-Q3');
    const rub = Object.fromEntries(r.rubrieken.map((x) => [x.code, x]));
    expect(rub['3b']).toMatchObject({ omzet: 250000, omzetEuro: 2500, btw: null });
    expect(rub['1e']!.omzet).toBe(0);
    expect(r.summary.teBetalen).toBe(0);
    expect(r.summary.omzet).toBe(250000);
    expect(r.warnings).toContain(BUITENLAND_DISCLAIMER);

    const icp = s.vat.icp('2026-Q3');
    expect(icp.lines).toEqual([expect.objectContaining({ name: 'Bau GmbH', country: 'DE', vatNumber: 'DE123456789', amount: 250000, amountEuro: 2500, problems: [] })]);
    expect(s.vat.icpCsv('2026-Q3')).toContain('DE;DE123456789;"Bau GmbH";2500.00;2500');

    // e-factuur: categorie K met leveringsland
    const xml = s.invoices.ublXml(inv.id);
    expect(xml).toContain('<cbc:ID>K</cbc:ID>');
    expect(xml).toContain('VATEX-EU-IC');
    expect(xml).toMatch(/<cac:Delivery>.*<cbc:IdentificationCode>DE<\/cbc:IdentificationCode>/);
  });

  it('ICP naar een Nederlandse klant of zonder btw-nummer wordt geweigerd', () => {
    const { s, klant } = setup();
    const nl = s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-07-10', lines: [{ description: 'x', quantity: 1, unitPrice: 10000, vatCode: 'icp' }] });
    expect(() => s.invoices.finalize(nl.id)).toThrow(/btw-nummer|Nederland/);
    const be = s.relations.create({ name: 'Klant BE', address: 'Rue 1', postcode: '1000', city: 'Brussel', country: 'BE' });
    const d = s.invoices.createDraft({ relationId: be.id, invoiceDate: '2026-07-10', lines: [{ description: 'x', quantity: 1, unitPrice: 10000, vatCode: 'icp' }] });
    expect(() => s.invoices.finalize(d.id)).toThrow(/btw-nummer/);
  });

  it('uitvoer buiten de EU in 3a', () => {
    const { s } = setup();
    const ch = s.relations.create({ name: 'Bau AG', address: 'Bahnhofstrasse 1', postcode: '8001', city: 'Zürich', country: 'CH', email: 'x@bau.example' });
    s.invoices.finalize(s.invoices.createDraft({ relationId: ch.id, invoiceDate: '2026-02-10', lines: [{ description: 'Levering', quantity: 1, unitPrice: 80000, vatCode: 'export' }] }).id);
    expect(rubrieken(s, '2026-Q1')['3a']).toMatchObject({ omzet: 80000, btw: null });
  });

  it('diensten uit de EU (4b) en van buiten de EU (4a): verlegd, per saldo nul', () => {
    const { s } = setup();
    s.quick.recordExpense({ date: '2026-07-01', supplierName: 'Meta Platforms Ireland', description: 'Advertenties', categoryKey: 'reclame', grossAmount: 10000, vatCode: 'eu', paidWith: 'bank' });
    s.quick.recordExpense({ date: '2026-07-02', supplierName: 'Hosting Inc', description: 'Server', categoryKey: 'software', grossAmount: 5000, vatCode: 'buiten-eu', paidWith: 'bank' });
    const rub = rubrieken(s, '2026-Q3');
    expect(rub['4b']).toMatchObject({ omzet: 10000, btw: 2100, omzetEuro: 100, btwEuro: 21 });
    expect(rub['4a']).toMatchObject({ omzet: 5000, btw: 1050 });
    expect(rub['2a']!.omzet).toBe(0);
    expect(rub['5a']!.btw).toBe(3150);
    expect(rub['5b']!.btw).toBe(3150);
    expect(s.vat.calculate('2026-Q3').summary.teBetalen).toBe(0);
    // alleen netto betaald
    expect(s.purchases.list().map((p) => p.total).sort((a, b) => a - b)).toEqual([5000, 10000]);

    for (const c of s.vat.checks('2026-Q3')) s.vat.skipCheck('2026-Q3', c.key, 'test');
    s.vat.markSubmitted('2026-Q3');
    expect(s.ledger.balance(ACCOUNTS.btwAfdragenEu) + 0).toBe(0);
    expect(s.ledger.balance(ACCOUNTS.btwAfdragenBuitenEu) + 0).toBe(0);
    expect(s.ledger.balance(ACCOUNTS.btwVoorbelasting) + 0).toBe(0);
  });

  it('Stripe-kosten (Ierland) komen in 4b', () => {
    const { s } = setup();
    s.integrations.importPayouts('stripe', [{ externalId: 'po_1', date: '2026-07-05', amount: 97000, gross: 100000, feesNet: 3000, feesVat: 0, feesReverseCharge: 'eu', currency: 'EUR', reference: 'STRIPE' }]);
    const rub = rubrieken(s, '2026-Q3');
    expect(rub['4b']).toMatchObject({ omzet: 3000, btw: 630 });
    expect(s.vat.calculate('2026-Q3').summary.teBetalen).toBe(0);
    expect(s.ledger.balance(ACCOUNTS.bankkosten)).toBe(3000);
  });

  it('herkomst van verlegde btw uit het btw-nummer van de leverancier', () => {
    expect(reverseChargeOrigin('NL123456789B01')).toBe('verlegd');
    expect(reverseChargeOrigin(null)).toBe('verlegd');
    expect(reverseChargeOrigin('IE 6388047V')).toBe('eu');
    expect(reverseChargeOrigin('EL123456789')).toBe('eu');
    expect(reverseChargeOrigin('GB123456789')).toBe('buiten-eu');
    expect(reverseChargeOrigin('CHE-123.456.789')).toBe('buiten-eu');
  });
});

describe('review-bevindingen #45', () => {
  it('verlegd zonder btw-nummer: land van het IBAN als aanwijzing', () => {
    expect(reverseChargeOrigin(null, 'IE29 AIBK 9311 5212 3456 78')).toBe('eu');
    expect(reverseChargeOrigin(null, 'GB33BUKB20201555555555')).toBe('buiten-eu');
    expect(reverseChargeOrigin(null, 'NL91ABNA0417164300')).toBe('verlegd');
  });

  it('uitvoer alleen naar buiten de EU, ICP alleen met een geldig EU-land', () => {
    const { s, klant } = setup();
    const nl = s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-07-10', lines: [{ description: 'x', quantity: 1, unitPrice: 10000, vatCode: 'export' }] });
    expect(() => s.invoices.finalize(nl.id)).toThrow(/buiten de EU/);
    const leeg = s.relations.create({ name: 'Zonder land', address: 'Straat 1', postcode: '1000', city: 'X', country: ' ', vat_number: 'DE123456789' });
    const d = s.invoices.createDraft({ relationId: leeg.id, invoiceDate: '2026-07-10', lines: [{ description: 'x', quantity: 1, unitPrice: 10000, vatCode: 'icp' }] });
    expect(() => s.invoices.finalize(d.id)).toThrow(/ander EU-land/);
  });

  it('verlegde inkoop telt niet als "btw die je hebt ontvangen"', () => {
    const { s } = setup();
    s.quick.recordExpense({ date: '2026-07-01', supplierName: 'Meta', description: 'Advertenties', categoryKey: 'reclame', grossAmount: 10000, vatCode: 'eu', paidWith: 'bank' });
    expect(s.vat.calculate('2026-Q3').summary).toMatchObject({ btwOverOmzet: 0, btwVerlegd: 2100, voorbelasting: 2100, teBetalen: 0 });
  });
});

describe('Schatting inkomstenbelasting (#33 fase 2)', () => {
  it('rekent met zelfstandigenaftrek, mkb-winstvrijstelling, kortingen en Zvw', () => {
    const { rules } = rulesFor(2026);
    const b = estimateIncomeTax(50000, rules, { urencriterium: true });
    expect(b.zelfstandigenaftrek).toBe(1200);
    expect(b.mkbWinstvrijstelling).toBe(Math.round(48800 * 0.127));
    expect(b.taxableIncome).toBe(Math.round(48800 * 0.873));
    expect(b.total).toBe(b.box1 - b.heffingskortingen + b.zvw);
    expect(b.total).toBeGreaterThan(5000);
    expect(b.total).toBeLessThan(15000);
    // zonder urencriterium geen zelfstandigenaftrek, dus meer belasting
    const zonder = estimateIncomeTax(50000, rules, { urencriterium: false });
    expect(zonder.zelfstandigenaftrek).toBe(0);
    expect(zonder.total).toBeGreaterThan(b.total);
    // verlies of nul: niets
    expect(estimateIncomeTax(-1000, rules, { urencriterium: true }).total).toBe(0);
    // meer winst = nooit minder belasting
    let prev = 0;
    for (let p = 0; p <= 200000; p += 5000) {
      const t = estimateIncomeTax(p, rules, { urencriterium: true }).total;
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
  });

  it('onbekend jaar valt terug op het laatst bekende', () => {
    expect(rulesFor(2031)).toMatchObject({ fallback: true, rules: { year: 2026 } });
  });

  it('schat op basis van de winst tot nu, doorgetrokken naar het jaar; uit te zetten', () => {
    const { s, klant } = setup();
    s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-02-01', lines: [{ description: 'Werk', quantity: 1, unitPrice: 2500000, vatCode: 'hoog' }] }).id);
    s.quick.recordExpense({ date: '2026-03-01', description: 'Materiaal', categoryKey: 'materiaal', grossAmount: 121000, vatCode: 'hoog', paidWith: 'bank' });
    const e = s.incomeTax.estimate('2026-07-02')!;
    expect(e.profitToDate).toBe(2500000 - 100000);
    // 2 juli = dag 183 van 365
    expect(e.profitYear).toBe(Math.round((2400000 * 365) / 183));
    expect(e.reserveToDate).toBe(Math.round((e.taxYear * 183) / 365));
    expect(e.disclaimer).toMatch(/schatting/);
    expect(e.rulesChecked).toBe(false);
    s.settings.update({ incomeTaxEstimate: false });
    expect(s.incomeTax.estimate('2026-07-02')).toBeNull();
  });
});
