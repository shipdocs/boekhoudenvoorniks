import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { XMLParser } from 'fast-xml-parser';
import { setup } from './helpers';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import { parseMt940 } from '../src/import/mt940';
import { parseCamt053 } from '../src/import/camt053';
import { migrations } from '../src/db/migrations';
import { migrate } from '../src/db/database';
import { SettingsService } from '../src/settings/settings';
import { pendingSteps } from '../src/shared/onboarding';
import { defaultBookValue, startDateConsequences } from '../src/shared/switchover';
import { guessInvoiceNumber } from '../src/onboarding/switchover';

const MAIN = 'NL91ABNA0417164300';

function overstapper(date = '2026-01-01', opts: { vatPeriod?: 'kwartaal' | 'maand'; kor?: boolean } = {}) {
  const ctx = setup();
  const { s } = ctx;
  s.settings.update({ onboardingDone: true, vatPeriod: opts.vatPeriod ?? 'kwartaal', kor: !!opts.kor });
  const bank = s.bank.ensureDefaultAccount();
  s.bank.updateAccount(bank.id, { iban: MAIN });
  s.switchover.setMode('overstapper', date);
  const tx = (d: string, amount: number, description: string, counterName = 'Iemand', counterIban: string | null = null) =>
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: d, amount, description, counterName, counterIban }] }, { bankAccountId: bank.id });
  const profit = (from: string, to: string) => 0 - s.ledger.balances({ from, to }).filter((b) => b.category === 'omzet' || b.category === 'kosten').reduce((x, b) => x + b.balance, 0) || 0;
  return { ...ctx, bank, tx, profit };
}

describe('overstappen met een lopende administratie', () => {
  it('startbalans op 1 januari: alles tegen eigen vermogen, eigen vermogen is het sluitstuk', () => {
    const { s, bank } = overstapper();
    s.switchover.setBankOpening(bank.id, 1_250_000);
    s.switchover.save({ kind: 'klant', relationName: 'Familie Jansen', number: '2025-0099', invoiceDate: '2025-12-15', amount: 121_000 });
    s.switchover.save({ kind: 'leverancier', relationName: 'Gamma', reference: 'F-77', invoiceDate: '2025-12-20', amount: 30_250 });
    s.switchover.save({ kind: 'bezit', name: 'Bus Ford Transit', type: 'vervoer', acquiredOn: '2023-03-10', cost: 3_000_000, bookValue: 1_700_000, remainingYears: 3 });
    s.switchover.save({ kind: 'btw', direction: 'betalen', amount: 84_000 });
    s.switchover.save({ kind: 'lening', description: 'Lening bus', amount: 500_000 });
    s.switchover.save({ kind: 'vordering', description: 'Borg bedrijfsruimte', amount: 100_000 });

    const p = s.switchover.position()!;
    const had = 1_250_000 + 121_000 + 1_700_000 + 100_000;
    const owed = 30_250 + 84_000 + 500_000;
    expect(p.bezittingen.reduce((x, l) => x + l.amount, 0)).toBe(had);
    expect(p.schulden.reduce((x, l) => x + l.amount, 0)).toBe(owed);
    expect(p.eigenVermogen).toBe(had - owed);
    expect(p.winstTotNu).toBeNull();
    // eigen vermogen in het grootboek = het sluitstuk (credit)
    expect(-s.ledger.balance(ACCOUNTS.eigenVermogen)).toBe(had - owed);
    expect(s.ledger.checkIntegrity().balanced).toBe(true);
    // geen omzet, geen kosten, geen btw in de aangifte
    expect(s.ledger.balances().filter((b) => b.category === 'omzet' || b.category === 'kosten').every((b) => b.balance === 0)).toBe(true);
    expect(s.vat.calculate('2026-Q1').summary.teBetalen).toBe(0);
    expect(s.vat.calculate('2026-Q1').summary.omzet).toBe(0);
  });

  it('aanpassen vervangt de boeking; weghalen draait alles terug', () => {
    const { s } = overstapper();
    const item = s.switchover.save({ kind: 'klant', relationName: 'Familie Jansen', number: '2025-0099', invoiceDate: '2025-12-15', amount: 121_000 });
    s.switchover.save({ kind: 'klant', relationName: 'Familie Jansen', number: '2025-0099', invoiceDate: '2025-12-15', amount: 100_000 }, item.id);
    expect(s.ledger.balance(ACCOUNTS.debiteuren)).toBe(100_000);
    expect(s.invoices.get(item.invoice_id!).open_amount).toBe(100_000);
    s.switchover.remove(item.id);
    expect(s.ledger.balance(ACCOUNTS.debiteuren)).toBe(0);
    expect(s.ledger.balance(ACCOUNTS.eigenVermogen)).toBe(0);
    expect(s.invoices.list()).toEqual([]);
    expect(s.switchover.list()).toEqual([]);
  });

  it('betaling na de overstap koppelt aan de oude factuur: geen omzet, geen btw, niet meer aan te passen', () => {
    const { s, tx, profit } = overstapper();
    const item = s.switchover.save({ kind: 'klant', relationName: 'Familie Jansen', number: '2025-0099', invoiceDate: '2025-12-15', amount: 121_000 });
    tx('2026-01-10', 121_000, 'Betaling factuur 2025-0099', 'Familie Jansen');
    s.inbox.autoProcess('2026-01-12');
    const inv = s.invoices.get(item.invoice_id!);
    expect(inv.status).toBe('betaald');
    expect(profit('2026-01-01', '2026-12-31')).toBe(0);
    expect(s.vat.calculate('2026-Q1').summary.btwOverOmzet).toBe(0);
    expect(s.switchover.list()[0]!.locked).toBe(true);
    expect(() => s.switchover.remove(item.id)).toThrow(/al \(deels\) betaald/);
  });

  it('factuur uit de vorige administratie: geen automatische herinnering, niet opnieuw versturen, herinnering zonder PDF', async () => {
    const { s, sent } = overstapper();
    s.switchover.save({ kind: 'klant', relationName: 'Familie Jansen', number: '2025-0099', invoiceDate: '2025-11-01', dueDate: '2025-11-15', amount: 121_000 });
    const inv = s.invoices.list()[0]!;
    expect(s.sender.dueReminders('2026-03-01')).toEqual([]);
    await expect(s.sender.sendInvoice(inv.id)).rejects.toThrow(/vorige administratie/);
    await s.sender.sendReminder(inv.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.attachments).toEqual([]);
  });

  it('openstaande rekening van de leverancier: betaling haalt de schuld weg zonder kosten', () => {
    const { s, tx, profit } = overstapper();
    const item = s.switchover.save({ kind: 'leverancier', relationName: 'Gamma', reference: 'F-77', invoiceDate: '2025-12-20', amount: 30_250 });
    tx('2026-01-05', -30_250, 'Factuur F-77', 'Gamma');
    const t = s.bank.list()[0]!;
    s.bank.matchPurchase(t.id, item.purchase_invoice_id!);
    expect(s.ledger.balance(ACCOUNTS.crediteuren)).toBe(0);
    expect(profit('2026-01-01', '2026-12-31')).toBe(0);
  });

  it('bus van vóór de overstap: afschrijven vanaf de boekwaarde, geen investeringsaftrek', () => {
    const { s } = overstapper('2025-01-01');
    const item = s.switchover.save({ kind: 'bezit', name: 'Bus', type: 'vervoer', acquiredOn: '2023-01-15', cost: 3_000_000, bookValue: 1_800_000, remainingYears: 3 });
    const asset = s.assets.get(item.asset_id!);
    expect(asset.cost).toBe(1_800_000);
    expect(asset.acquired_on).toBe('2025-01-01');
    expect(asset.kia_excluded).toBe(1);
    expect(asset.lifetime_months).toBe(36);
    // niet dubbel in het register als "nieuwe investering"
    expect(s.assets.list({}, '2025-06-01').filter((a) => a.status === 'actief')).toHaveLength(1);
    const booked = s.assets.bookYear(2025, '2026-01-10');
    expect(booked.amount).toBe(600_000);
    expect(s.taxOverview.adjustments(2025, '2026-01-10').investments).toBe(0);
    expect(() => s.switchover.remove(item.id)).toThrow(/al afgeschreven/);
  });

  it('dit jaar gekocht (vóór de instapdatum): gewone investering van dit jaar', () => {
    const { s } = overstapper('2026-07-01');
    const item = s.switchover.save({ kind: 'bezit', name: 'Steigers', type: 'inventaris', acquiredOn: '2026-03-01', cost: 800_000, bookValue: 800_000, remainingYears: 5 });
    const asset = s.assets.get(item.asset_id!);
    expect(asset.acquired_on).toBe('2026-03-01');
    expect(asset.kia_excluded).toBe(0);
    expect(asset.lifetime_months).toBe(60);
  });

  it('boekwaarde uitrekenen als de boekhouder die niet gaf', () => {
    expect(defaultBookValue(3_000_000, '2023-01-15', '2026-01-01')).toEqual({ bookValue: 1_200_000, remainingYears: 2 });
    expect(defaultBookValue(3_000_000, '2026-02-01', '2026-07-01')).toEqual({ bookValue: 3_000_000, remainingYears: 5 });
    expect(defaultBookValue(100_000, '2015-01-01', '2026-01-01').bookValue).toBe(0);
  });

  it('instappen midden in het jaar: omzet en kosten tot dan tellen mee in het jaar, niet in de btw', () => {
    const { s, profit } = overstapper('2026-07-01');
    // Q1 en Q2 deed je in je vorige administratie
    expect(s.vat.listPeriods(2026).map((p) => p.status)).toEqual(['ingediend', 'ingediend', 'open', 'open']);
    expect(s.switchover.checks().some((c) => c.key === 'resultaat' && c.level === 'probleem')).toBe(true);
    s.switchover.save({ kind: 'resultaat', omzet: 4_000_000, materiaal: 1_000_000, auto: 300_000, overig: 200_000 });
    expect(profit('2026-01-01', '2026-12-31')).toBe(2_500_000);
    expect(s.switchover.position()!.winstTotNu).toBe(2_500_000);
    expect(s.vat.calculate('2026-Q2').summary.omzet).toBe(0);
    expect(s.vat.calculate('2026-Q3').summary.omzet).toBe(0);
    expect(s.switchover.checks().some((c) => c.key === 'resultaat')).toBe(false);
    // de afschrijving loopt het hele jaar in de app: een bus van vóór 2026 krijgt 12 maanden
    s.switchover.save({ kind: 'bezit', name: 'Bus', type: 'vervoer', acquiredOn: '2024-01-01', cost: 3_000_000, bookValue: 1_800_000, remainingYears: 3 });
    expect(s.assets.projected(2026)).toBe(600_000);
  });

  it('instappen midden in een btw-kwartaal: het stuk vóór de instapdatum telt mee in de aangifte', () => {
    const { s, profit } = overstapper('2026-08-15');
    expect(s.switchover.state().splitPeriod?.key).toBe('2026-Q3');
    s.switchover.save({ kind: 'resultaat', omzet: 5_000_000, materiaal: 1_000_000, auto: 0, overig: 0 });
    s.switchover.save({ kind: 'btw-periode', omzetHoog: 1_000_000, btwHoog: 210_000, omzetLaag: 0, btwLaag: 0, omzetNul: 0, voorbelasting: 50_000 });
    const q3 = s.vat.calculate('2026-Q3');
    expect(q3.summary.omzet).toBe(1_000_000);
    expect(q3.summary.btwOverOmzet).toBe(210_000);
    expect(q3.summary.voorbelasting).toBe(50_000);
    expect(q3.summary.teBetalen).toBe(160_000);
    // de omzet van het jaar telt maar één keer
    expect(profit('2026-01-01', '2026-12-31')).toBe(4_000_000);
    expect(s.switchover.position()!.winstTotNu).toBe(4_000_000);
    // omzet kleiner dan in de btw-periode kan niet
    expect(() => s.switchover.save({ kind: 'resultaat', omzet: 500_000, materiaal: 0, auto: 0, overig: 0 })).toThrow(/lager dan de omzet in de btw-periode/);
    expect(s.ledger.checkIntegrity().balanced).toBe(true);
  });

  it('een andere instapdatum: alles wordt opnieuw geboekt, wat niet meer past verdwijnt', () => {
    const { s, bank } = overstapper('2026-07-01');
    s.switchover.setBankOpening(bank.id, 500_000);
    s.switchover.save({ kind: 'resultaat', omzet: 100_000, materiaal: 0, auto: 0, overig: 0 });
    s.switchover.save({ kind: 'lening', description: 'Lening', amount: 200_000 });
    s.switchover.setMode('overstapper', '2026-01-01');
    expect(s.bank.openingBalance(bank.id)).toEqual({ amount: 500_000, date: '2026-01-01' });
    expect(s.switchover.list().map((i) => i.kind)).toEqual(['lening']);
    expect(s.vat.listPeriods(2026).every((p) => p.status === 'open')).toBe(true);
    expect(s.switchover.position()!.eigenVermogen).toBe(300_000);
    expect(s.ledger.checkIntegrity().balanced).toBe(true);
  });

  it('bank: beginsaldo uit het eindsaldo van het afschrift, en controle of er iets ontbreekt', async () => {
    const { s, bank } = overstapper('2026-09-01');
    const parsed = await parseMt940(readFileSync(join(__dirname, 'fixtures', 'statement.sta')));
    expect(parsed.balances).toEqual([{ ownIban: MAIN, date: '2026-09-02', amount: 109_075 }]);
    s.bank.import(parsed, { filename: 'statement.sta' });
    let b = s.switchover.state().banks.find((x) => x.bankAccountId === bank.id)!;
    // 1090,75 − (121,00 − 30,25) = 1000,00
    expect(b.suggestedOpening?.amount).toBe(100_000);
    expect(b.opening).toBeNull();
    s.switchover.setBankOpening(bank.id, 90_000);
    b = s.switchover.state().banks.find((x) => x.bankAccountId === bank.id)!;
    expect(b.balanceCheck).toMatchObject({ bank: 109_075, computed: 99_075, source: 'afschrift' });
    expect(s.switchover.checks().find((c) => c.key === `bank-controle-${bank.id}`)?.level).toBe('probleem');
    s.switchover.setBankOpening(bank.id, 100_000);
    expect(s.switchover.checks().find((c) => c.key === `bank-controle-${bank.id}`)).toBeUndefined();
  });

  it('bank: saldo € 0 telt als ingevuld; betalingen van vóór de instapdatum overslaan', () => {
    const { s, bank, tx } = overstapper('2026-03-01');
    expect(s.switchover.checks().some((c) => c.key === `bank-saldo-${bank.id}`)).toBe(true);
    s.switchover.setBankOpening(bank.id, 0);
    expect(s.switchover.checks().some((c) => c.key === `bank-saldo-${bank.id}`)).toBe(false);
    tx('2026-02-20', -5000, 'Tanken');
    tx('2026-03-02', -6000, 'Tanken');
    expect(s.switchover.state().banks[0]!.beforeDate).toBe(1);
    expect(s.switchover.ignoreBeforeDate()).toBe(1);
    expect(s.bank.list({ status: 'nieuw' })).toHaveLength(1);
    // saldo volgens de gebruiker (CSV heeft geen saldo)
    s.switchover.setBankCheck(bank.id, '2026-03-31', -11_000);
    expect(s.switchover.state().banks[0]!.balanceCheck).toMatchObject({ bank: -11_000, computed: -6000 });
  });

  it('al verwerkte betalingen van vóór de instapdatum worden teruggedraaid en overgeslagen', () => {
    const { s, bank, tx, profit } = overstapper('2026-03-01');
    tx('2026-02-10', -12_100, 'Tanken', 'Shell');
    const t = s.bank.list()[0]!;
    s.bank.bookToAccount(t.id, { account: 'WBedAutBra', vatCode: 'hoog' });
    expect(profit('2026-01-01', '2026-12-31')).toBe(-10_000);
    expect(s.switchover.checks().find((c) => c.key === `bank-voor-${bank.id}`)?.level).toBe('probleem');
    s.switchover.ignoreBeforeDate();
    expect(s.bank.get(t.id).status).toBe('genegeerd');
    expect(profit('2026-01-01', '2026-12-31')).toBe(0);
    expect(s.switchover.checks().some((c) => c.key === `bank-voor-${bank.id}`)).toBe(false);
  });

  it('afschrift met alleen een saldo (geen betalingen) wordt toch bewaard; controle-datum binnen de grenzen', () => {
    const { s, bank } = overstapper('2026-09-01');
    s.bank.import({ source: 'camt', warnings: [], transactions: [], balances: [{ ownIban: MAIN, date: '2026-09-10', amount: 50_000 }] });
    expect(s.switchover.state().banks.find((b) => b.bankAccountId === bank.id)?.suggestedOpening?.amount).toBe(50_000);
    expect(() => s.switchover.setBankCheck(bank.id, '2026-08-01', 1)).toThrow(/Kies een datum/);
    expect(() => s.switchover.save({ kind: 'klant', relationName: 'X', number: '1', invoiceDate: '2026-08-01', amount: -100 })).toThrow(/bedrag/);
  });

  it('camt: eindsaldo wordt gelezen', () => {
    const xml = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt>
      <Acct><Id><IBAN>${MAIN}</IBAN></Id></Acct>
      <Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">100.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-09-01</Dt></Dt></Bal>
      <Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">50.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><Dt><Dt>2026-09-02</Dt></Dt></Bal>
      <Ntry><Amt Ccy="EUR">150.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>2026-09-02</Dt></BookgDt></Ntry>
    </Stmt></BkToCstmrStmt></Document>`;
    expect(parseCamt053(xml).balances).toEqual([{ ownIban: MAIN, date: '2026-09-02', amount: -5000 }]);
  });

  it('voorstellen uit de bank: oude factuur, oude rekening en btw van de vorige aangifte', () => {
    const { s, bank, tx } = overstapper('2026-01-01');
    tx('2026-01-08', 60_500, 'Factuur 2025-0042 stucwerk', 'Fam. De Boer', 'NL02ABNA0123456789');
    tx('2026-01-09', -12_100, 'Nota 5531', 'Bouwmaat');
    tx('2026-01-20', -84_000, 'Omzetbelasting 4e kwartaal 2025', 'Belastingdienst');
    tx('2026-01-21', -2_500, 'Koffie', 'Bakker');
    const sug = s.switchover.suggestions();
    expect(sug.map((x) => [x.kind, x.number])).toEqual([
      ['klant', '2025-0042'],
      ['leverancier', '5531'],
      ['btw', null],
    ]);
    s.switchover.acceptSuggestion(sug[0]!.txId, { invoiceDate: '2025-12-10' });
    s.switchover.acceptSuggestion(sug[1]!.txId);
    s.switchover.acceptSuggestion(sug[2]!.txId);
    const items = s.switchover.list();
    expect(items.map((i) => i.kind).sort()).toEqual(['btw', 'klant', 'leverancier']);
    expect(s.ledger.balance(ACCOUNTS.debiteuren)).toBe(0);
    expect(s.ledger.balance(ACCOUNTS.crediteuren)).toBe(0);
    expect(s.ledger.balance(ACCOUNTS.btwAfrekening)).toBe(0);
    expect(s.invoices.list().find((i) => i.number === '2025-0042')?.status).toBe('betaald');
    expect(s.switchover.suggestions()).toEqual([]);
    // nee zeggen: komt niet terug
    tx('2026-01-25', 10_000, 'Voorschot', 'Klant X');
    const [x] = s.switchover.suggestions();
    s.switchover.dismissSuggestion(x!.txId);
    expect(s.switchover.suggestions()).toEqual([]);
    expect(bank.id).toBeGreaterThan(0);
  });

  it('factuurnummer herkennen in een betalingsomschrijving', () => {
    expect(guessInvoiceNumber('Betaling factuur 2025-0099 dank')).toBe('2025-0099');
    expect(guessInvoiceNumber('fact. nr: F12345')).toBe('F12345');
    expect(guessInvoiceNumber('ref 2025/113')).toBe('2025/113');
    expect(guessInvoiceNumber('Boodschappen')).toBeNull();
  });

  it('klaarzetten kan pas als de rode punten zijn opgelost', () => {
    const { s, bank } = overstapper('2026-07-01');
    expect(() => s.switchover.confirm()).toThrow(/Nog op te lossen/);
    s.switchover.setBankOpening(bank.id, 0);
    s.switchover.save({ kind: 'resultaat', omzet: 0, materiaal: 0, auto: 0, overig: 0 });
    // afschriften ontbreken al meer dan twee weken na de instapdatum
    expect(() => s.switchover.confirm()).toThrow(/afschriften/);
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-07-03', amount: -1000, description: 'Bankkosten' }] }, { bankAccountId: bank.id });
    const st = s.switchover.confirm({ provisional: true });
    expect(st.settings.status).toBe('klaar');
    expect(st.settings.provisional).toBe(true);
    expect(s.checklist.items().find((i) => i.key === 'overstap')?.done).toBe(true);
  });

  it('eigen vermogen vergelijken met de balans van de boekhouder', () => {
    const { s, bank } = overstapper('2026-01-01');
    s.switchover.setBankOpening(bank.id, 1_000_000);
    s.switchover.setAccountantEquity(1_050_000);
    expect(s.switchover.checks().find((c) => c.key === 'eigen-vermogen')?.title).toMatch(/500,00/);
    s.switchover.setAccountantEquity(1_000_000);
    expect(s.switchover.checks().find((c) => c.key === 'eigen-vermogen')).toBeUndefined();
  });

  it('auditfile: de startbalans staat in <openingBalance>, niet bij de mutaties', () => {
    const { s, bank } = overstapper('2026-01-01');
    s.switchover.setBankOpening(bank.id, 1_000_000);
    s.switchover.save({ kind: 'klant', relationName: 'Familie Jansen', number: '2025-0099', invoiceDate: '2025-12-15', amount: 121_000 });
    const xml = s.exports.auditfile('2026-01-01', '2026-12-31', s.settings.get().company, '0.1.0');
    const doc = new XMLParser({ isArray: (n) => ['obLine', 'journal'].includes(n) }).parse(xml);
    const ob = doc.auditfile.company.openingBalance;
    expect(ob.opBalDate).toBe('2026-01-01');
    expect(String(ob.totalDebit)).toBe(String(ob.totalCredit));
    expect(ob.obLine).toHaveLength(3);
    expect(doc.auditfile.company.transactions.linesCount).toBe(0);
  });

  it('"had ik niet": een leeg hoofdstuk afvinken, en weer openzetten', () => {
    const { s } = overstapper();
    const done = (key: string) => s.switchover.state().sections.find((x) => x.key === key)?.done;
    expect(done('papieren')).toBe(false);
    expect(done('leveranciers')).toBe(false);
    s.switchover.skipSection('leveranciers');
    expect(done('leveranciers')).toBe(true);
    s.switchover.skipSection('leveranciers', false);
    expect(done('leveranciers')).toBe(false);
    // "ik vul het zelf in": geen programma, en daarmee is ook de route gekozen
    s.switchover.skipSection('import');
    expect(done('import')).toBe(true);
    expect(done('papieren')).toBe(true);
    // bank en btw laten zich niet overslaan
    expect(() => s.switchover.skipSection('bank')).toThrow(/niet overslaan/);
    // een hoofdstuk waar al iets in staat, kun je niet als "had ik niet" afvinken
    s.switchover.save({ kind: 'bezit', name: 'Bus', type: 'vervoer', acquiredOn: '2023-03-10', cost: 3_000_000, bookValue: 1_700_000, remainingYears: 3 });
    expect(() => s.switchover.skipSection('bezit')).toThrow(/al iets in/);
  });

  it('een rekening die je niet meer gebruikt: beginsaldo 0 en geen afschriften nodig', () => {
    const { s, bank, tx } = overstapper('2026-01-01');
    expect(s.switchover.checks().map((c) => c.key)).toEqual(expect.arrayContaining([`bank-saldo-${bank.id}`]));
    const st = s.switchover.setBankUnused(bank.id);
    const b = st.banks.find((x) => x.bankAccountId === bank.id)!;
    expect(b).toMatchObject({ unused: true, opening: 0 });
    expect(st.checks.filter((c) => c.key.endsWith(`-${bank.id}`))).toEqual([]);
    // weer in gebruik: dan wil de app weer een beginsaldo en afschriften zien
    s.switchover.setBankUnused(bank.id, false);
    expect(s.switchover.state().banks.find((x) => x.bankAccountId === bank.id)?.opening).toBeNull();
    expect(s.switchover.checks().some((c) => c.key === `bank-afschrift-${bank.id}`)).toBe(true);
    // met betalingen vanaf de instapdatum kan het niet
    tx('2026-02-01', -1000, 'Shell');
    expect(() => s.switchover.setBankUnused(bank.id)).toThrow(/gebruik je dus nog/);
  });

  it('KOR: geen btw-vragen', () => {
    const { s } = overstapper('2026-08-15', { kor: true });
    const st = s.switchover.state();
    expect(st.splitPeriod).toBeNull();
    expect(st.sections.find((x) => x.key === 'btw')?.needed).toBe(false);
    expect(st.requirements.some((r) => r.key === 'btw' || r.key === 'btw-periode')).toBe(false);
    expect(s.vat.listPeriods(2026).every((p) => p.status === 'open')).toBe(true);
  });

  it('gevolgen van een instapdatum in gewone taal', () => {
    expect(startDateConsequences('2026-01-01', 'kwartaal', false)).toHaveLength(2);
    expect(startDateConsequences('2026-07-01', 'kwartaal', false).join(' ')).toMatch(/omzet en kosten van 1 januari/);
    expect(startDateConsequences('2026-08-15', 'kwartaal', false).join(' ')).toMatch(/midden in 3e kwartaal 2026/);
  });

  it('onboarding: nieuwe vraag alleen voor wie nog niet gekozen heeft; bestaande administraties niet lastigvallen', () => {
    const fresh = setup().s;
    expect(pendingSteps(fresh.settings.get()).some((st) => st.id === 'start')).toBe(true);
    fresh.settings.update({ onboardingDone: true, company: { ...fresh.settings.get().company, iban: MAIN } });
    fresh.switchover.setMode('nieuw');
    expect(pendingSteps(fresh.settings.get()).some((st) => st.id === 'start')).toBe(false);

    // een bestaande administratie (met boekingen) van vóór deze versie
    const db = new Database(':memory:');
    const upTo = (n: number) => {
      for (let i = db.pragma('user_version', { simple: true }) as number; i < n; i++) {
        db.exec(migrations[i]!);
        db.pragma(`user_version = ${i + 1}`);
      }
    };
    upTo(16);
    db.exec(`INSERT INTO journal_entries (entry_date, description, source) VALUES ('2025-01-01', 'x', 'handmatig')`);
    migrate(db);
    expect(new SettingsService(db).get().switchover.mode).toBe('nieuw');
  });
});
