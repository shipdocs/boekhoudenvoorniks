import { describe, expect, it } from 'vitest';
import { setup, financialSnapshot } from './helpers';
import { arbeidskorting, estimateIncomeTax, rulesFor } from '../src/tax/income-tax';
import { buildVatXbrl } from '../src/btw/xbrl';
import { parseUbl } from '../src/intake/ubl';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { vatFromDocument } from '../src/intake/classify';
import { supplierKey } from '../src/intake/supplier-memory';
import type { ExternalOrder, FetchLike } from '../src/integrations/types';

describe('fiscale review #44: voorwaarden en gepubliceerde tabellen', () => {
  it.each([
    [2025, 20000, 980 + (20000 - 12169) * 0.3003],
    [2025, 30000, 5220 + (30000 - 26288) * 0.02258],
    [2026, 20000, 996 + (20000 - 11965) * 0.31009],
    [2026, 30000, 5300 + (30000 - 25845) * 0.0195],
    [2026, 50000, 5685 - (50000 - 45592) * 0.0651],
  ])('arbeidskorting %i bij %i volgt de officiële vaste beginbedragen', (year, income, expected) => {
    expect(arbeidskorting(income, rulesFor(year).rules.arbeidskorting)).toBeCloseTo(expected, 6);
  });

  it('€ 50.000 winst in 2026: circa € 9.674 IB/premies en Zvw', () => {
    expect(estimateIncomeTax(50000, rulesFor(2026).rules, { urencriterium: true })).toMatchObject({
      zelfstandigenaftrek: 1200, mkbWinstvrijstelling: 6198, taxableIncome: 42602,
      box1: 15298, heffingskortingen: 7690, zvw: 2066, total: 9674,
    });
  });

  it('ondernemerschap staat los van beide voorwaarden van het urencriterium', () => {
    const { s } = setup();
    s.quick.recordCashSale({ date: '2026-03-01', description: 'Werk', grossAmount: 6050000, vatCode: 'hoog', receivedWith: 'kas' });
    s.quick.recordExpense({ date: '2026-03-02', description: 'Steiger', categoryKey: 'investering', grossAmount: 605000, vatCode: 'hoog', paidWith: 'kas' });
    const actual = () => s.taxOverview.year(2026, '2027-01-01');
    const forecast = () => s.incomeTax.estimate('2026-12-31')!.breakdown;
    s.settings.update({ urencriterium: true });
    expect(actual().breakdown).toMatchObject({ zelfstandigenaftrek: 0, mkbWinstvrijstelling: 0, kia: 0 });
    expect(Math.abs(actual().items.find((i) => i.key === 'kia')!.amount!)).toBe(0);
    expect(forecast()).toMatchObject({ zelfstandigenaftrek: 0, mkbWinstvrijstelling: 0, kia: 0 });
    s.settings.update({ ibConfirmed: true });
    expect(actual().breakdown.zelfstandigenaftrek).toBe(0);
    expect(actual().breakdown.mkbWinstvrijstelling).toBeGreaterThan(0);
    expect(forecast().kia).toBe(1400);
    for (const ibHoursCondition of ['starter', 'meerderheid'] as const) {
      s.settings.update({ ibHoursCondition });
      expect(actual().breakdown.zelfstandigenaftrek).toBe(1200);
      expect(forecast().zelfstandigenaftrek).toBe(1200);
    }
    s.settings.update({ urencriterium: false });
    expect(forecast().zelfstandigenaftrek).toBe(0);
    expect(forecast().mkbWinstvrijstelling).toBeGreaterThan(0);
  });
});

describe('fiscale review #44: bronbewijs en buitenlandse btw', () => {
  const stripeFetch: FetchLike = async (url) => ({ ok: true, status: 200, text: async () => '', json: async () => ({ data: url.includes('balance_transactions')
    ? [{ id: 'txn', type: 'charge', amount: 100000, fee: 3000, net: 97000 }]
    : [{ id: 'po', amount: 97000, arrival_date: 1783209600, currency: 'eur', status: 'paid', statement_descriptor: 'STRIPE' }] }) });

  it('Stripe zonder bevestigde kostenbehandeling boekt niets en blijft opnieuw te proberen', async () => {
    const ctx = setup({ fetch: stripeFetch });
    ctx.s.integrations.configure('stripe', { apiKey: 'test' }, true);
    const before = financialSnapshot(ctx);
    await expect(ctx.s.integrations.sync('stripe')).rejects.toThrow(/Controleer eerst de btw/);
    expect(financialSnapshot(ctx)).toEqual(before);
    expect(ctx.s.integrations.state('stripe')).toMatchObject({ lastSyncAt: null, lastError: expect.stringContaining('niets automatisch geboekt') });
    ctx.s.integrations.configure('stripe', { feesTax: 'eu' }, true);
    expect((await ctx.s.integrations.sync('stripe')).created).toBe(1);
    expect(ctx.s.vat.calculate('2026-Q3').rubrieken.find((r) => r.code === '4b')).toMatchObject({ omzet: 3000, btw: 630 });
    expect((await ctx.s.integrations.sync('stripe')).created).toBe(0);
    expect(ctx.s.ledger.checkIntegrity().balanced).toBe(true);
  });

  it('bevestigd vrijgestelde Stripe-kosten krijgen geen fictieve verlegde btw', async () => {
    const { s } = setup({ fetch: stripeFetch });
    s.integrations.configure('stripe', { apiKey: 'test', feesTax: 'vrijgesteld' }, true);
    expect((await s.integrations.sync('stripe')).created).toBe(1);
    expect(s.vat.calculate('2026-Q3').rubrieken.find((r) => r.code === '4b')).toMatchObject({ omzet: 0, btw: 0 });
    expect(() => s.integrations.configure('stripe', { feesTax: 'geen-bewijs' }, true)).toThrow(/Ongeldige keuze/);
  });

  it.each([0, 21])('een buitenlandse order met %i%% wacht op beoordeling zonder boeking', (vatPercentage) => {
    const ctx = setup();
    const order: ExternalOrder = { externalId: 'de', number: 'DE-1', date: '2026-07-01', customer: { name: 'DE klant', email: null, address: null, postcode: null, city: null, country: 'DE', vatNumber: null }, lines: [{ description: 'Verkoop', quantity: 1, unitPriceExVat: 10000, vatPercentage }], paid: true, currency: 'EUR' };
    const before = financialSnapshot(ctx);
    expect(ctx.s.integrations.importOrders('shopify', [order]).created).toBe(0);
    expect(financialSnapshot(ctx)).toEqual(before);
    expect(ctx.s.inbox.tasks().map((t) => t.question).join(' ')).toMatch(/buiten Nederland|Buitenlandse btw|btw-tarief/);
  });

  it('geen btw op een buitenlandse factuur bewijst geen verlegging, ook niet met automatisch leveranciersgeheugen', async () => {
    const { s } = setup();
    const doc = parseUbl(readFileSync(join(__dirname, 'fixtures/ubl-invoice.xml'), 'utf8'));
    doc.supplierCountry = { ...doc.supplier!, value: 'IE' };
    doc.supplier = { ...doc.supplier!, value: 'Kostenleverancier' };
    doc.vat.value = [];
    doc.reverseCharge = false;
    for (let i = 0; i < 4; i++) s.memory.learn('Kostenleverancier', { categoryKey: 'bankkosten', vatCode: 'eu', business: true });
    s.memory.setAutomatic(supplierKey('Kostenleverancier'), true);
    expect(vatFromDocument(doc)).toBeNull();
    expect(await s.classifier.classify(doc)).toMatchObject({ automatic: false, reasons: expect.arrayContaining([expect.stringContaining('Controleer de btw')]) });
    doc.vat.value = [{ rate: 21, base: 10000, amount: 2100 }];
    expect((await s.classifier.classify(doc)).automatic).toBe(false);
    doc.supplierCountry = null;
    doc.supplierVatNumber = { ...doc.supplier!, value: 'IE1234567A' };
    expect((await s.classifier.classify(doc)).automatic).toBe(false);
  });
});

describe('fiscale review #44: ICP en XBRL', () => {
  it('EU-diensten volgen het einde van de dienst, goederen de factuurdatum; hercompileren bewaart het fiscale tijdstip', () => {
    const { s } = setup();
    const de = s.relations.create({ name: 'Bau GmbH', country: 'DE', address: 'Straat 1', postcode: '12345', city: 'Berlijn', vat_number: 'DE123456789' });
    const inv = s.invoices.finalize(s.invoices.createDraft({ relationId: de.id, invoiceDate: '2026-10-05', deliveryDate: '2026-09-01', deliveryDateTo: '2026-09-30', lines: [{ description: 'Dienst', quantity: 1, unitPrice: 10000, vatCode: 'icp-dienst' }] }).id);
    const entry = s.ledger.getEntry(inv.journal_entry_id!);
    expect(entry).toMatchObject({ entry_date: '2026-10-05', vat_date: '2026-09-30' });
    expect(s.events.recompile(entry.event_id!)).toMatchObject({ date: '2026-10-05', vatDate: '2026-09-30' });
    expect(s.vat.icp('2026-Q3')).toMatchObject({ total: 10000, lines: [{ kind: 'diensten' }] });
    expect(s.vat.calculate('2026-Q3').rubrieken.find((r) => r.code === '3b')!.omzet).toBe(10000);
    expect(s.vat.icp('2026-Q4').total).toBe(0);
    s.ledger.reverse(entry.id, '2026-10-06');
    expect(s.vat.icp('2026-Q3').total).toBe(0);
    s.invoices.finalize(s.invoices.createDraft({ relationId: de.id, invoiceDate: '2026-10-07', deliveryDate: '2026-09-30', lines: [{ description: 'Goederen', quantity: 1, unitPrice: 20000, vatCode: 'icp' }] }).id);
    expect(s.vat.icp('2026-Q4')).toMatchObject({ total: 20000, lines: [{ kind: 'goederen' }] });
    expect(s.ledger.checkIntegrity().balanced).toBe(true);
  });

  it('een late EU-dienst corrigeert het tijdvak van de dienst en gemengde tijdvakken worden expliciet geweigerd', () => {
    const ctx = setup();
    const { s } = ctx;
    const de = s.relations.create({ name: 'Bau GmbH', country: 'DE', address: 'Straat 1', postcode: '12345', city: 'Berlijn', vat_number: 'DE123456789' });
    s.vat.markSubmitted('2026-Q3');
    s.invoices.finalize(s.invoices.createDraft({ relationId: de.id, invoiceDate: '2026-10-05', deliveryDate: '2026-09-30', lines: [{ description: 'Dienst', quantity: 1, unitPrice: 10000, vatCode: 'icp-dienst' }] }).id);
    expect(s.vat.icp('2026-Q4')).toMatchObject({ total: 0, corrections: [{ periodKey: '2026-Q3', amount: 10000 }] });
    const mixed = s.invoices.createDraft({ relationId: de.id, invoiceDate: '2026-10-06', deliveryDate: '2026-09-30', lines: [{ description: 'Dienst', quantity: 1, unitPrice: 10000, vatCode: 'icp-dienst' }, { description: 'Goederen', quantity: 1, unitPrice: 20000, vatCode: 'icp' }] });
    const before = financialSnapshot(ctx);
    expect(() => s.invoices.finalize(mixed.id)).toThrow(/aparte facturen/);
    expect(financialSnapshot(ctx)).toEqual(before);
  });

  it('een creditnota is een vermindering in het huidige tijdvak, geen herstel van een oude ICP-fout', () => {
    const { s } = setup();
    const de = s.relations.create({ name: 'Bau GmbH', country: 'DE', address: 'Straat 1', postcode: '12345', city: 'Berlijn', vat_number: 'DE123456789' });
    const inv = s.invoices.finalize(s.invoices.createDraft({ relationId: de.id, invoiceDate: '2026-07-01', lines: [{ description: 'Levering', quantity: 1, unitPrice: 10000, vatCode: 'icp' }] }).id);
    s.vat.markSubmitted('2026-Q3');
    const credit = s.invoices.createCreditNote(inv.id);
    s.invoices.updateDraft(credit.id, { invoiceDate: '2026-09-30' });
    s.invoices.finalize(credit.id);
    expect(s.vat.icp('2026-Q4')).toMatchObject({ total: -10000, corrections: [], lines: [{ amount: -10000 }] });
  });

  it('de OSS-controle kijkt ook naar het voorafgaande kalenderjaar', () => {
    const { s } = setup();
    const de = s.relations.create({ name: 'Particulier', country: 'DE', address: 'Straat 1', postcode: '12345', city: 'Berlijn' });
    for (const [date, amount] of [['2025-07-01', 1000001], ['2026-07-01', 10000]] as const) {
      s.invoices.finalize(s.invoices.createDraft({ relationId: de.id, invoiceDate: date, lines: [{ description: 'Verkoop', quantity: 1, unitPrice: amount, vatCode: 'hoog' }] }).id);
    }
    expect(s.vat.checks('2026-Q3').find((c) => c.key === 'oss-drempel')!.detail).toContain('vorige kalenderjaar');
  });

  it('XBRL gebruikt het aparte OB-nummer en een concrete jaartaxonomie; ontbrekende gegevens worden geweigerd', () => {
    const { s } = setup();
    const company = { ...s.settings.get().company, vatNumber: 'NL999999999B01', omzetbelastingNumber: '123456789B02' };
    const report = s.vat.calculate('2026-Q3');
    const xml = buildVatXbrl(report, company);
    expect(xml).toContain('nt20/bd/20251210/entrypoints/bd-rpt-ob-aangifte-2026.xsd');
    expect(xml).toContain('www.belastingdienst.nl/omzetbelastingnummer">123456789B02');
    expect(xml).not.toContain('NL999999999B01');
    for (const name of ['SuppliesToCountriesOutsideTheEC', 'SuppliesToCountriesWithinTheEC', 'TurnoverFromTaxedSuppliesFromCountriesOutsideTheEC', 'TurnoverFromTaxedSuppliesFromCountriesWithinTheEC']) expect(xml).toContain(`<bd-i:${name} `);
    expect(() => buildVatXbrl(report, { ...company, omzetbelastingNumber: '' })).toThrow(/omzetbelastingnummer/);
    expect(() => buildVatXbrl(s.vat.calculate('2025-Q3'), company)).toThrow(/alleen.*2026/);
  });
});
