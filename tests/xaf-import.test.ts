import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import { parseXaf, XafError } from '../src/import/xaf';
import { classify } from '../src/onboarding/xaf-import';
import { OTHER_PACKAGE, IBAN } from './fixtures/xaf-ander-pakket';
import { kolommenbalans, makeXlsx } from './fixtures/xlsx';
import { readXlsx } from '../src/import/xlsx';

/**
 * Overstappen met een auditfile: een eigen export (met RGS-codes) terug inlezen, en een auditfile
 * zoals een ander pakket die maakt (zonder RGS, met openstaande posten en btw per regel).
 */


function overstapper(date: string) {
  const ctx = setup();
  ctx.s.settings.update({ onboardingDone: true, vatPeriod: 'kwartaal' });
  ctx.s.switchover.setMode('overstapper', date);
  return ctx;
}

const allKeys = (plan: { proposals: { key: string }[] }) => plan.proposals.map((p) => p.key);

describe('auditfile (XAF) inlezen bij overstappen', () => {
  it('eigen export van vorig jaar terug inlezen: de startbalans sluit precies aan', () => {
    // administratie A: 2025
    const a = setup();
    const bankA = a.s.bank.ensureDefaultAccount();
    a.s.bank.setOpeningBalance(bankA.id, 5_000_000, '2025-01-01');
    const inv = a.s.invoices.createDraft({ relationId: a.klant.id, invoiceDate: '2025-12-10', lines: [{ description: 'Stucwerk', quantity: 1, unitPrice: 100_000, vatCode: 'hoog' }] });
    a.s.invoices.finalize(inv.id);
    const gamma = a.s.relations.findOrCreateSupplier('Gamma');
    a.s.purchases.create({ relationId: gamma.id, invoiceDate: '2025-12-20', description: 'Gips', supplierReference: 'G-1', lines: [{ account: ACCOUNTS.inkoopMaterialen, netAmount: 10_000, vatCode: 'hoog' }] });
    a.s.ledger.post({ date: '2025-03-01', description: 'Bus', source: 'handmatig', lines: [{ account: ACCOUNTS.vervoermiddelen, debit: 3_000_000 }, { account: ACCOUNTS.bank, credit: 3_000_000 }] });
    a.s.assets.bookDue('2026-01-10');
    const xml = a.s.exports.auditfile('2025-01-01', '2025-12-31', a.s.settings.get().company, '0.1.0');

    // administratie B: stapt over op 1 januari 2026
    const { s } = overstapper('2026-01-01');
    const plan = s.xafImport.analyze(xml);
    expect(plan.meta).toMatchObject({ startDate: '2025-01-01', endDate: '2025-12-31' });
    expect(plan.suggestedDate).toBe('2026-01-01');
    expect(plan.banks).toHaveLength(1);
    expect(plan.banks[0]!.amount).toBe(2_000_000);
    const byKind = (k: string) => plan.proposals.filter((p) => p.input.kind === k);
    expect(byKind('klant').map((p) => p.amount)).toEqual([121_000]);
    expect(byKind('leverancier').map((p) => p.amount)).toEqual([-12_100]);
    expect(byKind('bezit')[0]!.input).toMatchObject({ type: 'vervoer', cost: 3_000_000, bookValue: 2_500_000 });
    expect(byKind('btw')[0]!.input).toMatchObject({ direction: 'betalen', amount: 18_900 });
    expect(byKind('resultaat')).toEqual([]);
    expect(plan.equity).toBe(2_000_000 + 121_000 + 2_500_000 - 12_100 - 18_900);

    const bankB = s.bank.ensureDefaultAccount();
    const state = s.xafImport.apply(xml, { include: allKeys(plan), banks: { [plan.banks[0]!.accountId]: bankB.id }, relations: true });
    expect(state.position!.eigenVermogen).toBe(plan.equity);
    expect(state.checks.find((c) => c.key === 'eigen-vermogen')).toBeUndefined();
    expect(state.checks.some((c) => c.key === `bank-saldo-${bankB.id}`)).toBe(false);
    expect(s.relations.list().some((r) => r.name === 'Gamma')).toBe(true);
    expect(s.ledger.checkIntegrity().balanced).toBe(true);

    // opnieuw inlezen dubbelt niets
    const again = s.xafImport.apply(xml, { include: allKeys(plan), banks: { [plan.banks[0]!.accountId]: bankB.id }, relations: true });
    expect(again.position!.eigenVermogen).toBe(plan.equity);
    expect(again.items.filter((i) => i.kind === 'klant')).toHaveLength(1);
  });

  it('auditfile van een ander pakket, instappen midden in het jaar en midden in een kwartaal', () => {
    const { s } = overstapper('2026-08-15');
    const plan = s.xafImport.analyze(OTHER_PACKAGE);
    expect(plan.meta.software).toMatch(/SnelBoek/);
    expect(plan.warnings).toEqual([]);

    const find = (key: string) => plan.proposals.find((p) => p.key.startsWith(key));
    expect(plan.banks).toEqual([{ accountId: '1100', name: 'Rabobank zakelijk', iban: IBAN, amount: 795_900, bankAccountId: expect.any(Number) }]);
    expect(find('kas:')?.input).toMatchObject({ kind: 'vordering', account: 'kas', amount: 20_000 });
    // per factuur: 2025-050 en 2026-001 zijn betaald, 2026-002 staat open
    expect(plan.proposals.filter((p) => p.input.kind === 'klant').map((p) => [p.input.kind === 'klant' && p.input.number, p.amount])).toEqual([['2026-002', 121_000]]);
    expect(find('leverancier:')?.input).toMatchObject({ relationName: 'Gamma Utrecht', reference: 'G-9', amount: 36_300 });
    expect(find('bezit:')?.input).toMatchObject({ type: 'vervoer', cost: 2_000_000, bookValue: 1_000_000 });
    expect(find('lening:')?.input).toMatchObject({ kind: 'lening', amount: 500_000 });
    expect(find('btw-periode')?.input).toMatchObject({ omzetHoog: 100_000, btwHoog: 21_000, voorbelasting: 6_300, omzetLaag: 0 });
    expect(plan.proposals.find((p) => p.key === 'btw')?.input).toMatchObject({ direction: 'betalen', amount: 39_900 });
    expect(find('resultaat')?.input).toMatchObject({ omzet: 300_000, materiaal: 30_000, auto: 10_000, overig: 5_000 });
    const unknown = find('onbekend:')!;
    expect(unknown).toMatchObject({ include: false, amount: 10_000 });

    const state = s.xafImport.apply(OTHER_PACKAGE, { include: allKeys(plan), banks: { '1100': plan.banks[0]!.bankAccountId }, relations: true });
    expect(state.position!.eigenVermogen).toBe(plan.equity);
    expect(plan.equity).toBe(1_356_000);
    expect(state.position!.winstTotNu).toBe(255_000);
    expect(state.checks.find((c) => c.key === 'eigen-vermogen')).toBeUndefined();
    const q3 = s.vat.calculate('2026-Q3').summary;
    expect([q3.omzet, q3.btwOverOmzet, q3.voorbelasting]).toEqual([100_000, 21_000, 6_300]);
    expect(s.ledger.balance(ACCOUNTS.kas)).toBe(20_000);
    expect(s.relations.list().find((r) => r.name === 'Bakker Bouw')?.kvk_number).toBe('87654321');
    expect(s.ledger.checkIntegrity().balanced).toBe(true);

    // zonder het onbekende onderdeel: verschil met de vorige administratie wordt gemeld
    const partial = s.xafImport.apply(OTHER_PACKAGE, { include: allKeys(plan).filter((k) => !k.startsWith('onbekend:')), banks: { '1100': plan.banks[0]!.bankAccountId }, relations: false });
    expect(partial.checks.find((c) => c.key === 'eigen-vermogen')?.title).toMatch(/100,00/);
  });

  it('openstaande facturen als e-factuur (UBL) uit het vorige programma', () => {
    const a = setup();
    const inv = a.s.invoices.createDraft({ relationId: a.klant.id, invoiceDate: '2025-12-10', dueDate: '2025-12-24', lines: [{ description: 'Stucwerk', quantity: 1, unitPrice: 100_000, vatCode: 'hoog' }] });
    const fin = a.s.invoices.finalize(inv.id);
    const xml = a.s.invoices.ublXml(inv.id);

    const { s } = overstapper('2026-01-01');
    const r = s.switchover.saveFromUbl([{ name: 'f.xml', xml }, { name: 'kapot.xml', xml: '<x/>' }]);
    expect(r.added).toBe(1);
    expect(r.skipped).toEqual([expect.stringMatching(/^kapot\.xml: /)]);
    const item = s.switchover.list()[0]!;
    expect(item.data).toMatchObject({ kind: 'klant', number: fin.number, invoiceDate: '2025-12-10', dueDate: '2025-12-24', amount: 121_000, relationName: 'Familie Jansen' });
    // een factuur in een andere munt niet als euro's overnemen
    const usd = xml.replace(/<cbc:DocumentCurrencyCode>EUR</, '<cbc:DocumentCurrencyCode>USD<');
    expect(s.switchover.saveFromUbl([{ name: 'usd.xml', xml: usd.replace(fin.number!, 'X-1') }]).skipped[0]).toMatch(/USD/);
    // tweede keer: staat er al in
    expect(s.switchover.saveFromUbl([{ name: 'f.xml', xml }]).skipped[0]).toMatch(/staat er al in/);
  });

  it('kolommenbalans als Excel (DigiBoox): instappen op 1 januari met de beginbalans', () => {
    const { s } = overstapper('2026-01-01');
    const data = kolommenbalans();
    expect(readXlsx(data).sheets.map((x) => x.name)).toEqual(['Winst- en verliesrekening', 'Kolommenbalans']);
    const plan = s.xafImport.analyze(data);
    expect(plan.meta).toMatchObject({ startDate: '2026-01-01', endDate: '2026-09-27', company: 'Klusbedrijf Test' });
    expect(plan.banks.map((b) => [b.name, b.amount])).toEqual([['Bank Knab', 150_000]]);
    // de ongebruikte standaardrekening in de app wordt voorgesteld
    expect(plan.banks[0]!.bankAccountId).toBe(s.bank.ensureDefaultAccount().id);
    const byKey = Object.fromEntries(plan.proposals.map((p) => [p.key, p]));
    expect(byKey['bezit:bestelbus']!.input).toMatchObject({ cost: 500_000, bookValue: 300_000, type: 'vervoer' });
    expect(byKey['leverancier::SALDO-onbekend']!.amount).toBe(-100_000);
    expect(byKey['btw']!.input).toMatchObject({ direction: 'betalen', amount: 10_000 });
    expect(byKey['vordering:2000']).toMatchObject({ include: false, amount: -90_000 });
    expect(plan.proposals.some((p) => p.input.kind === 'resultaat')).toBe(false);
    expect(plan.equity).toBe(250_000);
    expect(plan.warnings.join(' ')).toMatch(/geen losse facturen/);

    const state = s.xafImport.apply(data, { include: plan.proposals.map((p) => p.key), banks: { '1002': plan.banks[0]!.bankAccountId }, relations: false });
    expect(state.position!.eigenVermogen).toBe(250_000);
    expect(state.checks.find((c) => c.key === 'eigen-vermogen')).toBeUndefined();
  });

  it('kolommenbalans: na de exportdatum met de eindbalans en de omzet en kosten tot dan; ertussenin kan niet', () => {
    const { s } = overstapper('2026-01-01');
    const plan = s.xafImport.analyze(kolommenbalans(), '2026-09-28');
    expect(plan.banks.map((b) => b.amount)).toEqual([120_000]);
    const byKey = Object.fromEntries(plan.proposals.map((p) => [p.key, p]));
    // afschrijving en de overboekingsrekening winst tellen niet mee
    expect(byKey['resultaat']!.input).toMatchObject({ omzet: 150_000, materiaal: 25_000, auto: 0, overig: 45_000 });
    expect(byKey['bezit:bestelbus']!.input).toMatchObject({ bookValue: 290_000 });
    expect(byKey['vordering:2010']).toMatchObject({ include: false, amount: 25_000 });
    expect(plan.equity).toBe(340_000);
    expect(() => s.xafImport.analyze(kolommenbalans(), '2026-06-01')).toThrow(/alleen totalen/);
  });

  it('Excel zonder kolommenbalans: duidelijke melding', () => {
    const { s } = overstapper('2026-01-01');
    expect(() => s.xafImport.analyze(makeXlsx([{ name: 'Blad1', rows: [['a', 'b']] }]))).toThrow(/geen kolommenbalans/);
    expect(() => s.xafImport.analyze(new Uint8Array([1, 2, 3]))).toThrow(/niet lezen/);
  });

  it('opnieuw inlezen: andere bankrekening kiezen zet de vorige terug; al betaalde factuur blijft en dubbelt niet', () => {
    const { s, tx } = (() => {
      const c = overstapper('2026-01-01');
      const bank = c.s.bank.ensureDefaultAccount();
      const tx = (d: string, amount: number, description: string) => c.s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: d, amount, description }] }, { bankAccountId: bank.id });
      return { ...c, tx };
    })();
    const data = kolommenbalans();
    const plan = s.xafImport.analyze(data);
    const keys = plan.proposals.map((p) => p.key);
    const first = s.bank.ensureDefaultAccount();
    s.xafImport.apply(data, { include: keys, banks: { '1002': first.id }, relations: false });
    expect(s.bank.openingBalance(first.id).amount).toBe(150_000);
    // de rekening van de leverancier wordt betaald
    tx('2026-01-10', -100_000, 'Betaling');
    const purchase = s.purchases.list().find((p) => p.is_opening)!;
    s.bank.matchPurchase(s.bank.list()[0]!.id, purchase.id);
    // opnieuw, nu met een nieuwe rekening
    const state = s.xafImport.apply(data, { include: keys, banks: { '1002': 'nieuw' }, relations: false });
    expect(s.bank.openingBalance(first.id).amount).toBe(0);
    expect(state.items.filter((i) => i.kind === 'leverancier')).toHaveLength(1);
    expect(state.position!.eigenVermogen).toBe(250_000);
  });

  it('btw-periode: niet elke omzetregel heeft btw-gegevens → uit de btw-rekeningen', () => {
    const { s } = overstapper('2026-08-15');
    const partial = OTHER_PACKAGE.replace('<vat><vatID>1</vatID><vatPerc>21</vatPerc><vatAmnt>210.00</vatAmnt><vatAmntTp>C</vatAmntTp></vat>', '');
    const p = s.xafImport.analyze(partial).proposals.find((x) => x.key === 'btw-periode')!;
    expect(p.input).toMatchObject({ omzetHoog: 100_000, btwHoog: 21_000, voorbelasting: 6_300, omzetNul: 0 });
    expect(p.note).toMatch(/btw-rekeningen/);
  });

  it('te vroeg of te laat: duidelijke meldingen', () => {
    const { s } = overstapper('2025-06-01');
    expect(() => s.xafImport.analyze(OTHER_PACKAGE)).toThrow(/begint op 1 januari 2026, na je instapdatum/);
    const later = overstapper('2026-09-15').s.xafImport.analyze(OTHER_PACKAGE);
    expect(later.warnings.join(' ')).toMatch(/loopt tot 31 augustus 2026/);
  });

  it('geen auditfile, of een te oude versie', () => {
    expect(() => parseXaf('<html></html>')).toThrow(XafError);
    expect(() => parseXaf('<auditfile xmlns="http://www.auditfiles.nl/XAF/2.0"><header/><company/></auditfile>')).toThrow(/versie 2.0/);
    // onmogelijke datum en ongeldig IBAN worden niet overgenomen
    const x = parseXaf(OTHER_PACKAGE.replace('<trDt>2026-01-20</trDt>', '<trDt>2026-02-31</trDt>').replace(IBAN, 'NL00RABO0123456789'));
    expect(x.lines.some((l) => l.date === '2026-02-31')).toBe(false);
    expect(x.lines.every((l) => l.journalIban === null)).toBe(true);
  });

  it('rekeningen herkennen op RGS-code of naam', () => {
    const c = (id: string, name: string, type = 'B', rgs: string | null = null) => classify({ id, name, type, rgs });
    expect(c('1', 'Wat dan ook', 'B', 'BLimBanRba')).toBe('bank');
    expect(c('1', 'x', 'B', 'BMvaTevCae')).toBe('afschrijving-cum');
    expect(c('1', 'x', 'B', 'BSchBepBtwOla')).toBe('btw');
    expect(c('1', 'x', 'P', 'WAfsAmvTev')).toBe('afschrijving');
    expect(c('1100', 'ING zakelijk')).toBe('bank');
    expect(c('1300', 'Debiteuren')).toBe('debiteuren');
    expect(c('1510', 'Af te dragen omzetbelasting')).toBe('btw');
    expect(c('0510', 'Privé-opnamen')).toBe('eigen-vermogen');
    expect(c('8000', 'Omzet werkzaamheden', 'P')).toBe('omzet');
    expect(c('4100', 'Brandstof bus', 'P')).toBe('auto');
    expect(c('1998', 'Diversen')).toBe('onbekend');
  });
});
