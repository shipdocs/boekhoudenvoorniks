import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import { BankPurchaseMatcher } from '../src/documents/bank-purchase-match';
import { expenseLines } from '../src/core-ledger/rules';

// Onafhankelijke verwachtingen voor de review van main@4ae07b7.
// Bewaken de herstelde berekeningen en controles.
type Services = ReturnType<typeof setup>['s'];
function bank(s: Services, date: string, amount: number, name: string) {
  s.bank.import({ source: 'csv', warnings: [], transactions: [{ date, amount, description: name, counterName: name }] });
  return s.bank.list().find(t => t.transaction_date === date && t.amount === amount && t.counter_name === name)!;
}
function invoice(s: Services, relationId: number, date: string, net = 10000) {
  return s.invoices.finalize(s.invoices.createDraft({ relationId, invoiceDate: date, lines: [{ description: 'Werk', quantity: 1, unitPrice: net, vatCode: 'hoog' }] }).id);
}
function buy(s: Services, date: string, amount: number, account = 'WBedKanSof', extra = {}) {
  return s.purchases.create({ invoiceDate: date, description: 'Aankoop', lines: [{ account, netAmount: amount, vatCode: 'geen' }], ...extra });
}

describe('business-rules-review: onafhankelijke randgevallen', () => {
  it('R01: btw-tarief wijzigen verplaatst omzet naar de juiste rubriek', () => {
    const { s } = setup();
    const t = bank(s, '2026-08-01', 10900, 'Verkoop A');
    s.bank.bookSale(t.id, { vatCode: 'hoog' });
    s.bank.reclassify(t.id, { account: ACCOUNTS.omzetHoog, vatCode: 'laag' });
    expect(s.vat.calculate('2026-Q3').rubrieken.find(r => r.code === '1b')).toMatchObject({ omzet: 10000, btw: 900 });
  });
  it('R02: aankoop en volledige terugbetaling neutraliseren hetzelfde zakelijke deel', () => {
    const { s } = setup();
    const out = bank(s, '2026-08-01', -12100, 'Telefoonshop');
    s.bank.bookToAccount(out.id, { account: 'WBedKanTel', vatCode: 'hoog', businessPct: 50 });
    const back = bank(s, '2026-08-02', 12100, 'Telefoonshop');
    s.bank.bookToAccount(back.id, { account: 'WBedKanTel', vatCode: 'hoog', businessPct: 50 });
    expect(s.ledger.balance('WBedKanTel')).toBe(0);
  });
  it('R03: KOR blokkeert gewone binnenlandse bankverkoop met btw', () => {
    const { s } = setup();
    s.settings.update({ kor: true });
    const t = bank(s, '2026-08-01', 12100, 'Klant A');
    expect(() => s.bank.bookSale(t.id, { vatCode: 'hoog' })).toThrow();
  });
  it('R04: KOR en gemengd gebruik geven dezelfde kostprijs in register en grootboek', () => {
    const { s } = setup();
    s.settings.update({ kor: true });
    s.purchases.create({ invoiceDate: '2026-02-01', description: 'Machine', businessPct: 50, lines: [{ account: ACCOUNTS.inventaris, netAmount: 100000, vatCode: 'hoog' }] });
    expect(s.ledger.balance(ACCOUNTS.inventaris)).toBe(60500);
    expect(s.assets.list({}, '2026-02-02')[0]!.cost).toBe(60500);
  });
  it('R05: tegengestelde onduidelijke posten blijven zichtbaar bij saldo nul', () => {
    const { s } = setup();
    s.bank.bookToAccount(bank(s, '2026-08-01', -10000, 'Onbekende uitgave').id, { account: ACCOUNTS.vraagposten });
    s.bank.bookToAccount(bank(s, '2026-08-02', 10000, 'Onbekende ontvangst').id, { account: ACCOUNTS.vraagposten });
    expect(s.vat.accountLines(ACCOUNTS.vraagposten).lines).toHaveLength(2);
    expect(s.vat.checks('2026-Q3').some(c => c.key === 'vraagposten')).toBe(true);
  });
  it('R06: een andere onduidelijke post met hetzelfde saldo maakt overslaan ongeldig', () => {
    const { s } = setup();
    const first = bank(s, '2026-08-01', -10000, 'Onbekend A');
    s.bank.bookToAccount(first.id, { account: ACCOUNTS.vraagposten });
    s.vat.skipCheck('2026-Q3', 'vraagposten', 'Eerste post gezien');
    s.bank.reclassify(first.id, { account: ACCOUNTS.priveOpnamen, vatCode: 'geen' });
    s.bank.bookToAccount(bank(s, '2026-08-03', -10000, 'Onbekend B').id, { account: ACCOUNTS.vraagposten });
    expect(s.vat.checks('2026-Q3').find(c => c.key === 'vraagposten')!.skipped).toBe(false);
  });
  it('R07: historische openstaande facturen sluiten aan bij de debiteurenkaart', () => {
    const { s, klant } = setup();
    const inv = invoice(s, klant.id, '2026-02-01');
    s.invoices.registerPayment(inv.id, { amount: 12100, date: '2026-03-01' });
    expect(s.ledgerReports.relations('2026-02-28')[0]!.receivable).toBe(12100);
    expect(s.dashboard.get('2026-02-28').openInvoices.amount).toBe(12100);
  });
  it('R08: maandomzet op peildatum bevat geen latere facturen uit die maand', () => {
    const { s, klant } = setup();
    invoice(s, klant.id, '2026-02-01');
    invoice(s, klant.id, '2026-02-20');
    const d = s.dashboard.get('2026-02-10');
    expect(d.revenueThisYear).toBe(10000);
    expect(d.revenueThisMonth).toBe(10000);
  });
  it('R09: dubbele aankoop rond kwartaalgrens hangt niet af van invoervolgorde', () => {
    const { s } = setup();
    const rel = s.relations.findOrCreateSupplier('Duplicaat BV');
    // Laat eerst Q3, daarna de oudere factuur uit Q2 binnenkomen.
    buy(s, '2026-07-01', 10000, 'WBedKanSof', { relationId: rel.id });
    buy(s, '2026-06-30', 10000, 'WBedKanSof', { relationId: rel.id });
    expect(new BankPurchaseMatcher(s.db).doubles('2026-07-01', '2026-09-30').purchases).toHaveLength(1);
  });
  it('R10: telefoonprivédeel wordt niet twee keer uit dezelfde boeking gehaald', () => {
    const { s } = setup();
    s.settings.update({ phoneInternetBusinessPct: 50 });
    s.purchases.create({ invoiceDate: '2026-02-01', description: 'Telefoon', businessPct: 50, lines: [{ account: 'WBedKanTel', netAmount: 10000, vatCode: 'hoog' }] });
    expect(s.ledger.balance('WBedKanTel')).toBe(5000);
    expect(s.taxOverview.adjustments(2026, '2026-02-28').phonePrivate.bijtelling).toBe(0);
  });
  it('R11: inkoop kan geen 0%-code met een positieve voorbelasting combineren', () => {
    const { s } = setup();
    expect(() => s.purchases.create({ invoiceDate: '2026-02-01', description: 'Foutieve btw', lines: [{ account: 'WBedKanSof', netAmount: 10000, vatCode: 'geen', vatAmount: 2100 }] })).toThrow();
  });
  it('R12: verlegde btw over gemengde dienst houdt volledige schuld en beperkt alleen aftrek', () => {
    const b = expenseLines([{ account: 'WBedKanSof', netAmount: 10000, vatCode: 'eu' }], ACCOUNTS.crediteuren, null, 'Gemengd', { businessPct: 50 });
    const due = b.lines.filter(l => l.account === ACCOUNTS.btwAfdragenEu).reduce((n, l) => n + (l.credit ?? 0) - (l.debit ?? 0), 0);
    const deduction = b.lines.filter(l => l.account === ACCOUNTS.btwVoorbelasting).reduce((n, l) => n + (l.debit ?? 0) - (l.credit ?? 0), 0);
    expect(deduction).toBe(1050);
    expect(due).toBe(2100);
  });
  it('R13: periodeafsluiting signaleert een nog onduidelijke aankoop', () => {
    const { s } = setup();
    buy(s, '2026-08-01', 10000, ACCOUNTS.vraagposten);
    expect(s.periods.checks('2026-09-30').some(c => c.title.includes('weet ik nog niet') || c.key.includes('vraag'))).toBe(true);
  });
  it('R14: gedeeltelijke leverancierscredit verlaagt de kostprijs van het bedrijfsmiddel', () => {
    const { s } = setup();
    buy(s, '2026-02-01', 100000, ACCOUNTS.inventaris);
    s.assets.list({}, '2026-02-02');
    buy(s, '2026-02-03', -20000, ACCOUNTS.inventaris);
    expect(s.ledger.balance(ACCOUNTS.inventaris)).toBe(80000);
    expect(s.assets.list({}, '2026-02-04').filter(a => a.status === 'actief').reduce((n, a) => n + a.cost, 0)).toBe(80000);
  });
  it('R15: forfait privégebruik auto respecteert het maximum aan afgetrokken btw', () => {
    const { s } = setup();
    s.settings.update({ carUse: 'zakelijk', carPrivateUse: true, carVatDeducted: true, carVatMethod: 'forfait', carCatalogValue: 7500000, carInUseSince: 2025, carInUseMonth: 1 });
    s.purchases.create({ invoiceDate: '2025-01-01', description: 'Gebruikte auto', lines: [{ account: ACCOUNTS.vervoermiddelen, netAmount: 1500000, vatCode: 'hoog' }] });
    s.purchases.create({ invoiceDate: '2026-02-01', description: 'Autokosten', lines: [{ account: 'WBedAutOnd', netAmount: 100000, vatCode: 'hoog' }, { account: 'WBedAutBra', netAmount: 250000, vatCode: 'hoog' }] });
    // Belastingdienstvoorbeeld: 2,7% x 75.000 = 2.025, maar maximum 735 + 3.150/5 = 1.365.
    expect(s.vat.carPrivateUse('2026-Q4').due).toMatchObject({ state: 'bekend', amount: 136500 });
  });
  it('R16: leverancierscredit met expliciet negatief btw-bedrag kan worden bevestigd', async () => {
    const { s } = setup();
    const doc = await s.intake.add('credit.jpg', Buffer.from('creditnota test'));
    expect(() => s.intake.confirm(doc.id, { supplier: 'Creditwinkel', date: '2026-08-01', total: -12100, vatAmount: -2100, categoryKey: 'software', vatCode: 'hoog', business: true, paidWith: 'later' })).not.toThrow();
  });
});
