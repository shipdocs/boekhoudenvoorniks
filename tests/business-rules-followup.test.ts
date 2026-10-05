import { parseDocumentText } from '../src/intake/text-parser';
import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import { createApi, type HostContext } from '../src/main/api';
import { compile as legacyCompile } from '../src/core-ledger/rules-2026-2';
import { selectedBusinessPct } from '../src/shared/business-share';
import { migrate } from '../src/db/database';
import { purchaseVat } from '../src/core-ledger/rules';
import { accountOpenItems } from '../src/core-ledger/open-items';

type S = ReturnType<typeof setup>['s'];
function purchase(s: S, date: string, net: number, account: string = ACCOUNTS.inventaris) {
  return s.purchases.create({ invoiceDate: date, description: 'Reviewfixture', lines: [{ account, netAmount: net, vatCode: 'geen' }] });
}
function bank(s: S, amount: number, date = '2026-02-01') {
  s.bank.import({ source: 'csv', warnings: [], transactions: [{ date, amount, counterName: 'KPN', description: 'Reviewfixture' }] });
  return s.bank.list().find(t => t.amount === amount && t.transaction_date === date)!;
}
function legacyPurchase(ctx: ReturnType<typeof setup>) {
  const { s, db } = ctx;
  const rel = s.relations.findOrCreateSupplier('Oude leverancier');
  const id = Number(db.prepare('INSERT INTO purchase_invoices (relation_id, invoice_date, description, subtotal, vat_total, total) VALUES (?, ?, ?, ?, ?, ?)').run(rel.id, '2025-02-01', 'Oude OCR-bon', 10000, 600, 10600).lastInsertRowid);
  const payload = { purchaseId: id, date: '2025-02-01', description: 'Oude OCR-bon', relationId: rel.id, lines: [{ account: 'WBedKanSof', netAmount: 10000, vatCode: 'nul', vatAmount: 600 }] };
  const compiled = legacyCompile({ type: 'inkoop', payload } as never);
  const eventId = Number(db.prepare("INSERT INTO events (type, event_date, payload, rules_version) VALUES ('inkoop', ?, ?, '2026.2')").run(payload.date, JSON.stringify(payload)).lastInsertRowid);
  const entryId = s.ledger.post({ ...compiled, eventId });
  db.prepare('INSERT INTO purchase_invoice_lines (purchase_invoice_id, account_id, net_amount, vat_code, vat_amount) VALUES (?, ?, ?, ?, ?)').run(id, s.ledger.getAccount('WBedKanSof').id, 10000, 'nul', 600);
  db.prepare('UPDATE purchase_invoices SET journal_entry_id = ? WHERE id = ?').run(entryId, id);
  expect(s.ledger.checkIntegrity().balanced).toBe(true);
  return id;
}

describe('Vervolgcontrole business rules: Claude-fixes en vijf resterende fouten', () => {
  it('fix: credit verlaagt de opgeslagen restwaarde niet, eerdere peildatum blijft correct', () => {
    const { s, db } = setup();
    purchase(s, '2026-02-01', 100000);
    const a = s.assets.list({}, '2026-02-02')[0]!;
    s.assets.update(a.id, { residual: 80000 });
    purchase(s, '2026-03-01', -50000);
    s.assets.sync();
    expect(s.assets.get(a.id, '2026-03-02')).toMatchObject({ cost: 50000, residual: 50000, perYear: 0 });
    expect(db.prepare('SELECT residual FROM assets WHERE id = ?').get(a.id)).toEqual({ residual: 80000 });
    expect(s.assets.list({}, '2026-02-02')[0]).toMatchObject({ cost: 100000, residual: 80000, perYear: 4000 });
  });
  it('fix/cache: historisch get gebruikt costAt, niet de all-time kostprijscache', () => {
    const { s, db } = setup();
    purchase(s, '2026-02-01', 100000);
    const a = s.assets.list()[0]!;
    purchase(s, '2026-03-01', -20000);
    s.assets.list();
    expect(db.prepare('SELECT cost FROM assets WHERE id = ?').get(a.id)).toEqual({ cost: 80000 });
    expect(s.assets.get(a.id, '2026-02-02').cost).toBe(100000);
  });
  it('F01: ongewijzigde 100-default van de bank-UI mag algemene 70%-telefoonkeuze niet wissen', () => {
    const { s } = setup();
    s.settings.update({ phoneInternetBusinessPct: 70 });
    // Gebruik dezelfde selectie als de echte CategoryPicker; ongewijzigde 100 is niet expliciet.
    s.bank.bookToAccount(bank(s, -12100).id, { account: 'WBedKanTel', vatCode: 'hoog', businessPct: selectedBusinessPct(null, 100) });
    expect(s.taxOverview.adjustments(2026, '2026-02-28').phonePrivate).toMatchObject({ bijtelling: 3000, vat: 630 });
  });
  it('F01 controle: zonder expliciet percentage geldt de algemene telefoonkeuze wel', () => {
    const { s } = setup();
    s.settings.update({ phoneInternetBusinessPct: 70 });
    s.bank.bookToAccount(bank(s, -12100).id, { account: 'WBedKanTel', vatCode: 'hoog' });
    expect(s.taxOverview.adjustments(2026, '2026-02-28').phonePrivate).toMatchObject({ bijtelling: 3000, vat: 630 });
  });
  it('F02: geldige legacy-bewaring nul-code met expliciete btw mag aankooplijst niet laten crashen', () => {
    const ctx = setup();
    legacyPurchase(ctx);
    const { s } = ctx;
    const api = createApi(s, {} as HostContext);
    expect(api.purchases.list()[0]).toMatchObject({ vat_total: 600, vat_deductible: 600, vat_warning: expect.stringContaining('Controleer') });
    expect(() => purchaseVat({ account: 'WBedKanSof', netAmount: 10000, vatCode: 'nul', vatAmount: 600 })).toThrow();
  });
  it('F02 tweede leespunt: leveranciersverdeling moet oude data kunnen tonen', () => {
    const ctx = setup();
    legacyPurchase(ctx);
    const { s } = ctx;
    const line = s.businessShare.lines('Oude leverancier')[0]!;
    expect(line).toMatchObject({ parts: [{ net: 10000, vat: 600 }], now: { kosten: 10000, btw: 600 }, vatWarning: expect.stringContaining('Controleer') });
    expect(s.businessShare.preview(line, 70)).toEqual({ kosten: 7000, btw: 420 });
  });
  it('Beoordeelde nuance: oude onkoppelbare credit verschijnt later, maar kan bewust worden overgeslagen', () => {
    const { s } = setup();
    purchase(s, '2024-02-01', -20000);
    expect(s.assets.unassignedCredits()[0]!.candidates).toHaveLength(0);
    expect(s.vat.checks('2026-Q3').find(c => c.key === 'investering-credit')).toMatchObject({ blocking: true, skipped: false });
    s.vat.skipCheck('2026-Q3', 'investering-credit', 'Historische credit buiten het huidige register beoordeeld');
    expect(s.vat.checks('2026-Q3').find(c => c.key === 'investering-credit')).toMatchObject({ skipped: true });
  });
  it('F03: expliciete memoriaalherindeling maakt de oorspronkelijke vraagpost af', () => {
    const { s, db } = setup();
    const questionEntryId = s.bank.bookToAccount(bank(s, -10000).id, { account: ACCOUNTS.vraagposten });
    createApi(s, {} as HostContext).ledger.manualEntry({ questionEntryId, date: '2026-02-02', description: 'Boekhouder: telefoon herindelen', lines: [{ account: ACCOUNTS.vraagposten, credit: 10000 }, { account: 'WBedKanTel', debit: 10000 }] });
    expect(s.ledger.balance(ACCOUNTS.vraagposten)).toBe(0);
    expect(accountOpenItems(db, ACCOUNTS.vraagposten, '2026-02-28')).toHaveLength(0);
  });
  it('F04: terug naar afleiden uit de aankoop mag een oud handbedrag niet gebruiken', () => {
    const { s } = setup();
    s.settings.update({ carUse: 'zakelijk', carPrivateUse: true, carVatDeducted: true, carVatMethod: 'forfait', carCatalogValue: 7500000, carInUseSince: 2025, carInUseMonth: 1, carPurchaseVatDeducted: true, carPurchaseVatAmount: 650000 });
    s.purchases.create({ invoiceDate: '2025-01-01', description: 'Auto', lines: [{ account: ACCOUNTS.vervoermiddelen, netAmount: 1500000, vatCode: 'hoog' }] });
    s.purchases.create({ invoiceDate: '2026-02-01', description: 'Autokosten', lines: [{ account: 'WBedAutBra', netAmount: 350000, vatCode: 'hoog' }] });
    // Settings-select verandert alleen dit veld naar null en verbergt het bedrag.
    s.settings.update({ carPurchaseVatDeducted: null });
    expect(s.vat.carPrivateUse('2026-Q4').due).toMatchObject({ amount: 136500 });
  });
  it('F05: latere geboekte jaarafschrijving telt niet op een eerdere peildatum', () => {
    const { s } = setup();
    purchase(s, '2025-01-01', 100000);
    const a = s.assets.list({}, '2025-06-30')[0]!;
    expect(a.bookValue).toBe(100000);
    s.assets.bookDue('2026-02-01');
    // Boeking €200 is op 31-12-2025; het grootboek op 30-06 bevat nog geen afschrijving.
    expect(s.assets.get(a.id, '2025-06-30')).toMatchObject({ booked: 0, bookValue: 100000 });
  });
  it('vatOn: aankoopcredit en tegenboeking salderen de werkelijk afgetrokken kosten-btw', () => {
    const { s } = setup();
    s.settings.update({ carUse: 'zakelijk', carPrivateUse: true, carVatDeducted: true, carVatMethod: 'forfait', carCatalogValue: 4000000, carInUseSince: 2025, carPurchaseVatDeducted: false });
    const p = s.purchases.create({ invoiceDate: '2026-02-01', description: 'Autokosten', lines: [{ account: 'WBedAutBra', netAmount: 100000, vatCode: 'hoog' }] });
    expect(s.vat.carPrivateUse('2026-Q4').due).toMatchObject({ amount: 21000 });
    s.purchases.cancel(p.id, '2026-02-02');
    expect(s.vat.carPrivateUse('2026-Q4').due).toMatchObject({ amount: 0 });
  });
});

describe('Vervolgregressies: expliciete keuzes, vraagposten en historische activa', () => {
  it('F01: een expliciete 100 of onthouden 70 blijft een eigen keuze', () => {
    expect(selectedBusinessPct(100, 70)).toBe(100);
    expect(selectedBusinessPct(null, 70)).toBe(70);
    const { s } = setup();
    s.settings.update({ phoneInternetBusinessPct: 70 });
    s.bank.bookToAccount(bank(s, -12100).id, { account: 'WBedKanTel', vatCode: 'hoog', businessPct: selectedBusinessPct(100, 100) });
    expect(s.taxOverview.adjustments(2026, '2026-02-28').phonePrivate).toMatchObject({ bijtelling: 0, vat: 0 });
  });
  it('F03: gelijk bedrag zonder expliciete koppeling blijft twee open posten', () => {
    const { s, db } = setup();
    s.bank.bookToAccount(bank(s, -10000).id, { account: ACCOUNTS.vraagposten });
    s.ledger.post({ date: '2026-02-02', description: 'Andere onbekende ontvangst', source: 'handmatig', lines: [{ account: ACCOUNTS.vraagposten, credit: 10000 }, { account: ACCOUNTS.bank, debit: 10000 }] });
    expect(accountOpenItems(db, ACCOUNTS.vraagposten)).toHaveLength(2);
  });
  it('F03: deelafboeking, latere peildatum en tegenboeking blijven afzonderlijk correct', () => {
    const { s, db } = setup();
    const questionEntryId = s.bank.bookToAccount(bank(s, -10000).id, { account: ACCOUNTS.vraagposten });
    const correction = s.ledger.post({ questionEntryId, date: '2026-03-01', description: 'Deel herindelen', source: 'handmatig', lines: [{ account: ACCOUNTS.vraagposten, credit: 4000 }, { account: 'WBedKanTel', debit: 4000 }] });
    expect(accountOpenItems(db, ACCOUNTS.vraagposten, '2026-02-28')).toMatchObject([{ id: questionEntryId, net: 10000 }]);
    expect(accountOpenItems(db, ACCOUNTS.vraagposten, '2026-03-01')).toMatchObject([{ id: questionEntryId, net: 6000 }]);
    expect(() => s.bank.reclassify(bank(s, -10000).id, { account: 'WBedKanTel' })).toThrow(/correctie eerst terug/);
    s.ledger.reverse(correction, '2026-04-01');
    expect(accountOpenItems(db, ACCOUNTS.vraagposten, '2026-03-31')).toMatchObject([{ net: 6000 }]);
    expect(accountOpenItems(db, ACCOUNTS.vraagposten, '2026-04-01')).toMatchObject([{ net: 10000 }]);
  });
  it('F03: ongeldige koppeling boekt niets en laat geen gebeurtenis achter', () => {
    const { s, db } = setup();
    const questionEntryId = s.bank.bookToAccount(bank(s, -10000).id, { account: ACCOUNTS.vraagposten });
    const count = () => db.prepare('SELECT (SELECT COUNT(*) FROM journal_entries) AS entries, (SELECT COUNT(*) FROM events) AS events').get();
    const before = count();
    expect(() => s.ledger.post({ questionEntryId, date: '2026-02-02', description: 'Verkeerde richting', source: 'handmatig', lines: [{ account: ACCOUNTS.vraagposten, debit: 10000 }, { account: 'WBedKanTel', credit: 10000 }] })).toThrow(/tegengesteld/);
    expect(count()).toEqual(before);
  });
  it('F03: een volledig afgeboekte aankoop verliest het label nog uitzoeken en de btw-blokkade', () => {
    const { s } = setup();
    const p = purchase(s, '2026-02-01', 10000, ACCOUNTS.vraagposten);
    expect(s.purchases.isQuestion(p.id)).toBe(true);
    s.ledger.post({ questionEntryId: p.journal_entry_id!, date: '2026-02-02', description: 'Herindeling door boekhouder', source: 'handmatig', lines: [{ account: ACCOUNTS.vraagposten, credit: 10000 }, { account: 'WBedKanTel', debit: 10000 }] });
    expect(s.purchases.isQuestion(p.id)).toBe(false);
    expect(s.vat.checks('2026-Q1').find(c => c.key === 'vraagposten')).toBeUndefined();
    expect(() => s.purchases.reclassify(p.id, [{ account: 'WBedKanTel', netAmount: 10000, vatCode: 'geen' }])).toThrow(/correctie eerst terug/);
  });
  it('F05: toekomstig verkochte activa blijven op eerdere peildata in gebruik', () => {
    const { s } = setup();
    purchase(s, '2025-01-01', 100000);
    const a = s.assets.list({}, '2025-06-30')[0]!;
    s.assets.dispose(a.id, '2026-07-01', 50000);
    expect(s.assets.get(a.id, '2025-06-30')).toMatchObject({ status: 'actief', booked: 0, bookValue: 100000 });
    expect(s.assets.get(a.id, '2026-06-30')).toMatchObject({ status: 'actief', booked: 20000, bookValue: 80000 });
    expect(s.assets.get(a.id, '2026-07-01')).toMatchObject({ status: 'verkocht', booked: 30000, bookValue: 0 });
  });
  it('F05: een toekomstige tegenboeking van afschrijving verandert de eerdere peildatum niet', () => {
    const { s } = setup();
    purchase(s, '2025-01-01', 100000);
    const a = s.assets.list()[0]!;
    const dep = s.assets.bookYear(2025, '2026-02-01');
    s.ledger.reverse(dep.entryId!, '2026-04-01');
    expect(s.assets.get(a.id, '2026-03-31')).toMatchObject({ booked: 20000, bookValue: 80000 });
    expect(s.assets.get(a.id, '2026-04-01')).toMatchObject({ booked: 0, bookValue: 100000 });
  });
  it('F05: verkoopcorrectie is append-only, de originele jaarcache blijft intact', () => {
    const { s, db } = setup();
    purchase(s, '2025-01-01', 100000);
    const a = s.assets.list()[0]!;
    s.assets.bookYear(2025, '2026-02-01');
    const before = db.prepare('SELECT * FROM asset_depreciation').all();
    s.assets.dispose(a.id, '2025-07-01', 50000);
    expect(db.prepare('SELECT * FROM asset_depreciation').all()).toEqual(before);
    expect(db.prepare('SELECT amount FROM asset_depreciation_history WHERE asset_id = ? ORDER BY journal_entry_id').all(a.id)).toEqual([{ amount: 20000 }, { amount: -20000 }, { amount: 10000 }]);
    expect(s.assets.get(a.id, '2025-06-30')).toMatchObject({ status: 'actief', booked: 0, bookValue: 100000 });
    expect(s.assets.get(a.id, '2025-07-01')).toMatchObject({ booked: 10000, bookValue: 0 });
    expect(s.ledger.balance(ACCOUNTS.cumAfschrijvingInventaris, { to: '2025-07-01' })).toBe(0);
    expect(s.ledger.balance(ACCOUNTS.cumAfschrijvingInventaris, { to: '2025-12-31' })).toBe(0);
    expect(() => db.prepare('UPDATE asset_depreciation_history SET amount = 0').run()).toThrow(/onveranderlijk/);
    expect(() => db.prepare('DELETE FROM asset_depreciation_history').run()).toThrow(/onveranderlijk/);
  });
  it('F05: migratie herstelt oude overschreven bedragen uit het journaal, ook bij gelijke of gewijzigde namen', () => {
    const { s, db } = setup();
    purchase(s, '2025-01-01', 100000);
    purchase(s, '2025-01-01', 200000);
    const assets = s.assets.list().sort((a, b) => a.id - b.id);
    s.assets.bookYear(2025, '2026-02-01');
    s.assets.update(assets[0]!.id, { name: 'Later gewijzigd' });
    s.ledger.post({ date: '2025-07-01', source: 'handmatig', sourceRef: `afschrijving-correctie:${assets[0]!.id}:2025`, description: 'Oude verkoopcorrectie', lines: [{ account: ACCOUNTS.cumAfschrijvingInventaris, debit: 10000 }, { account: ACCOUNTS.afschrijvingInventaris, credit: 10000 }] });
    // Bouw exact de oude cachesituatie: de oude app overschreef 20000 met 10000.
    db.exec('DROP TRIGGER asset_depreciation_history_no_update; DROP TRIGGER asset_depreciation_history_no_delete; DROP TABLE asset_depreciation_history');
    db.prepare('UPDATE asset_depreciation SET amount = 10000 WHERE asset_id = ?').run(assets[0]!.id);
    // latere migraties (leverdatum op facturen) horen bij de simulatie van een oudere database niet meer aanwezig te zijn
    db.exec('ALTER TABLE invoices DROP COLUMN delivery_date; ALTER TABLE invoices DROP COLUMN delivery_date_to; DROP TABLE invoice_writeoffs; DROP TABLE year_end_items; DROP TABLE vies_checks; DROP TABLE purchase_vat_repayments; ALTER TABLE time_entries DROP COLUMN period_end');
    db.pragma('user_version = 35');
    const journalBefore = db.prepare('SELECT * FROM journal_lines ORDER BY id').all();
    migrate(db);
    expect(db.prepare('SELECT * FROM journal_lines ORDER BY id').all()).toEqual(journalBefore);
    expect(db.prepare('SELECT asset_id, amount FROM asset_depreciation_history ORDER BY journal_entry_id, asset_id').all()).toEqual([{ asset_id: assets[0]!.id, amount: 20000 }, { asset_id: assets[1]!.id, amount: 40000 }, { asset_id: assets[0]!.id, amount: -10000 }]);
    expect(s.assets.get(assets[1]!.id, '2026-02-01')).toMatchObject({ booked: 40000, bookValue: 160000 });
    expect(s.assets.get(assets[0]!.id, '2025-06-30')).toMatchObject({ booked: 0, bookValue: 100000 });
  });
});

describe('Historische tegenboekingen', () => {
  it('F05: een toekomstige aankoopcorrectie verplaatst afschrijving niet naar een eerdere peildatum', () => {
    const { s } = setup();
    const p = purchase(s, '2025-01-01', 100000);
    const a = s.assets.list()[0]!;
    s.assets.bookDue('2026-01-01');
    s.purchases.cancel(p.id, '2026-05-01');
    expect(s.assets.list({}, '2026-01-31').find(x => x.id === a.id)).toMatchObject({ status: 'actief', booked: 20000, bookValue: 80000 });
    expect(s.assets.get(a.id, '2026-05-01')).toMatchObject({ status: 'vervallen', bookValue: 0 });
  });
});


describe('F02: OCR met een niet-ondersteund gemengd btw-tarief', () => {
  it('vraagt een gecontroleerd btw-bedrag en schrijft nooit 6% weg als nul-code met btw', async () => {
    const { s, db } = setup();
    const doc = await s.intake.add('oude-tarieven.jpg', new Uint8Array([123, 45, 6]), '2026-09-15');
    const result = parseDocumentText(['LEVERANCIER', 'Datum 15-09-2026', 'Totaal 227,00'].map((text, i) => ({ text, page: 1, bbox: [0, i * 10, 100, i * 10 + 10] as [number, number, number, number], confidence: 1 })), 'ocr:test');
    result.vat.value = [{ rate: 6, base: 10000, amount: 600 }, { rate: 21, base: 10000, amount: 2100 }];
    db.prepare('UPDATE documents SET result = ? WHERE id = ?').run(JSON.stringify(result), doc.id);
    const confirmation = { supplier: 'Leverancier', date: '2026-09-15', total: 22700, categoryKey: 'materiaal', vatCode: 'hoog' as const, business: true, paidWith: 'kas' as const };
    expect(() => s.intake.confirm(doc.id, confirmation)).toThrow(/niet-ondersteund/);
    expect(s.purchases.list()).toEqual([]);
    s.intake.confirm(doc.id, { ...confirmation, vatAmount: 2100 });
    expect(s.purchases.list()[0]).toMatchObject({ total: 22700, vat_total: 2100 });
    expect(s.ledger.checkIntegrity().balanced).toBe(true);
  });
});

describe('Vraagposten: afboeking achteraf', () => {
  it('F03: een eerdere correctiedatum kan een later al afgeboekt bedrag niet nogmaals verbruiken', () => {
    const { s, db } = setup();
    const questionEntryId = s.bank.bookToAccount(bank(s, -10000).id, { account: ACCOUNTS.vraagposten });
    const correction = { questionEntryId, description: 'Vraagpost afboeken', source: 'handmatig' as const, lines: [{ account: ACCOUNTS.vraagposten, credit: 10000 }, { account: 'WBedKanTel', debit: 10000 }] };
    s.ledger.post({ ...correction, date: '2026-03-01' });
    const journalBefore = s.ledger.listEntries();
    expect(() => s.ledger.post({ ...correction, date: '2026-02-15' })).toThrow(/latere datum al afgeboekt/);
    expect(s.ledger.listEntries()).toEqual(journalBefore);
    expect(accountOpenItems(db, ACCOUNTS.vraagposten, '2026-02-28')).toMatchObject([{ id: questionEntryId, net: 10000 }]);
    expect(accountOpenItems(db, ACCOUNTS.vraagposten)).toEqual([]);
    expect(s.ledger.balance(ACCOUNTS.vraagposten)).toBe(0);
  });
});

describe('Controles schrijven niets weg', () => {
  const snapshot = (db: ReturnType<typeof setup>['db']) => ({
    entries: db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get(),
    allocations: db.prepare('SELECT COUNT(*) AS n FROM asset_credit_allocations').get(),
    costs: db.prepare('SELECT id, cost FROM assets ORDER BY id').all(),
  });
  const period = { start: '2026-01-01', end: '2026-03-31' } as never;

  it('btw-controle meldt een credit met twee kandidaten zonder te koppelen of te boeken', async () => {
    const { runVatChecks } = await import('../src/btw/checks');
    const { s, db } = setup();
    purchase(s, '2026-02-01', 100000);
    purchase(s, '2026-02-02', 100000);
    s.assets.list({}, '2026-02-03');
    purchase(s, '2026-03-01', -20000);
    const before = snapshot(db);
    const checks = runVatChecks(db, s.ledger, period, { current: 0, previous: null });
    expect(checks.find(c => c.key === 'investering-credit')?.count).toBe(1);
    expect(snapshot(db)).toEqual(before);
  });

  it('btw-controle toont geen credit die sync zelf zou koppelen (één kandidaat) en schrijft niets', async () => {
    const { runVatChecks } = await import('../src/btw/checks');
    const { s, db } = setup();
    purchase(s, '2026-02-01', 100000);
    s.assets.list({}, '2026-02-03');
    purchase(s, '2026-03-01', -20000);
    const before = snapshot(db);
    const checks = runVatChecks(db, s.ledger, period, { current: 0, previous: null });
    expect(checks.find(c => c.key === 'investering-credit')).toBeUndefined();
    expect(snapshot(db)).toEqual(before);
  });
});
