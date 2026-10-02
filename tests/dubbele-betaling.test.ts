import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import type { Db } from '../src/db/database';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import { parseCsv, previewCsv } from '../src/import/csv';
import { paymentText, sameCounterparty } from '../src/import/same-payment';
import type { NormalizedTransaction, ParseResult } from '../src/import/types';

/**
 * Dezelfde betaling uit verschillende exportindelingen (#225): de ene export zet "Card Payment: " voor de
 * winkel, de andere niet. Bij het inlezen komt hij er niet dubbel in; wat er al dubbel in stond, meldt de
 * app op Vandaag, en een regel die je zelf als dubbel negeert telt niet meer mee in het saldo.
 */
const OWN = 'NL91ABNA0417164300';
type S = ReturnType<typeof setup>['s'];

const tx = (date: string, amount: number, extra: Partial<NormalizedTransaction> = {}): NormalizedTransaction => ({ date, amount, description: 'betaling', ownIban: OWN, ...extra });
const result = (source: ParseResult['source'], transactions: NormalizedTransaction[], extra: Partial<ParseResult> = {}): ParseResult => ({ source, warnings: [], transactions, ...extra });

/** Een export zoals van een kaartrekening zonder eigen rekeningnummer: alleen een omschrijving en een bedrag. */
function kaartCsv(rows: { date: string; text: string; amount: number }[]): ParseResult {
  const lines = ['Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance'];
  for (const r of rows) lines.push(['CARD_PAYMENT', 'Current', `${r.date} 10:00:00`, `${r.date} 12:00:00`, r.text, (r.amount / 100).toFixed(2), '0.00', 'EUR', 'COMPLETED', ''].join(','));
  const text = lines.join('\n');
  return parseCsv(text, previewCsv(text).suggestedMapping!);
}

/** Een regel die er met een eerdere versie al in kwam, uit een ander afschrift: zo staat de betaling er twee keer in. */
function oudeImport(db: Db, accountId: number, source: 'csv' | 'camt' | 'mt940', t: { date: string; amount: number; name: string | null; text: string; iban?: string }): number {
  const batch = Number(db.prepare('INSERT INTO import_batches (filename, source, kind) VALUES (?, ?, ?)').run(`oud.${source}`, source, source).lastInsertRowid);
  db.prepare('INSERT INTO import_batch_accounts (batch_id, bank_account_id, period_from, period_to, transactions, imported, duplicates) VALUES (?, ?, ?, ?, 1, 1, 0)').run(batch, accountId, t.date, t.date);
  return Number(
    db
      .prepare('INSERT INTO bank_transactions (bank_account_id, transaction_date, amount, counter_iban, counter_name, description, source, import_batch_id, dedup_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(accountId, t.date, t.amount, t.iban ?? null, t.name, t.text, source, batch, `oud-${batch}`).lastInsertRowid,
  );
}

const count = (db: Db) => (db.prepare('SELECT COUNT(*) AS n FROM bank_transactions').get() as { n: number }).n;
const sameTasks = (s: S) => s.inbox.tasks('2026-09-12').filter((t) => t.kind === 'bank-same');

describe('de omschrijving van dezelfde betaling verschilt per indeling', () => {
  it('een voorvoegsel als "Card Payment:" telt niet mee; een andere winkel blijft een andere tegenpartij', () => {
    expect(paymentText('Card Payment: Printhuis')).toBe(paymentText('PRINTHUIS'));
    expect(paymentText('Payment to Printhuis B.V.')).toBe(paymentText('Printhuis BV'));
    expect(paymentText('Kaartbetaling - Printhuis')).toBe('printhuis');
    expect(paymentText('Printhuis')).not.toBe(paymentText('Kantoorhal'));
    // "to" midden in een naam is geen voorvoegsel
    expect(paymentText('Toko Pasar')).toBe('tokopasar');
    const p = (name: string | null, description: string, iban: string | null = null) => ({ counter_name: name, description, counter_iban: iban });
    expect(sameCounterparty(p('Card Payment: Printhuis', 'Card Payment: Printhuis'), p('Printhuis', 'Printhuis'))).toBe(true);
    // de ene indeling heeft een naam, de andere alles in één omschrijving
    expect(sameCounterparty(p('Printhuis', 'Bon 4411'), p(null, 'PRINTHUIS UTRECHT Bon 4411'))).toBe(true);
    expect(sameCounterparty(p('Printhuis', 'Bon 4411'), p('Kantoorhal', 'Bon 4411'))).toBe(false);
    // allebei een tegenrekening: die beslist
    expect(sameCounterparty(p('Printhuis', 'x', 'NL20INGB0001234567'), p('Printhuis BV', 'y', 'NL20 INGB 0001 2345 67'))).toBe(true);
    expect(sameCounterparty(p('Printhuis', 'x', 'NL20INGB0001234567'), p('Printhuis', 'x', 'NL86INGB0002445588'))).toBe(false);
  });
});

describe('bij het inlezen: dezelfde betaling uit twee indelingen komt er één keer in', () => {
  it('hetzelfde soort afschrift, de ene keer met "Card Payment:" en de andere keer zonder: overgeslagen, met Toch toevoegen alsnog erin', () => {
    const { s, db } = setup();
    const eerste = kaartCsv([{ date: '2026-09-01', text: 'Card Payment: Kantoorhal', amount: -450 }, { date: '2026-09-08', text: 'Card Payment: Printhuis', amount: -1299 }]);
    const tweede = kaartCsv([{ date: '2026-09-08', text: 'Printhuis', amount: -1299 }, { date: '2026-09-08', text: 'Wolkendienst', amount: -1299 }, { date: '2026-09-09', text: 'Kantoorhal', amount: -600 }]);
    expect(eerste.layout).toBe(tweede.layout);
    expect(s.bank.import(eerste)).toMatchObject({ imported: 2, skipped: 0 });
    // Printhuis stond er al; Wolkendienst is een andere winkel met toevallig hetzelfde bedrag op dezelfde dag
    expect(s.bank.import(tweede)).toMatchObject({ imported: 2, duplicates: 1, skipped: 1 });
    expect(count(db)).toBe(4);
    expect(s.bank.statementBalance()).toBe(-450 - 1299 - 1299 - 600);
    const [row] = s.bank.skippedRows();
    expect(row).toMatchObject({ amount: -1299, description: 'Printhuis', existing: { description: 'Card Payment: Printhuis' } });
    // opnieuw inlezen verandert niets
    expect(s.bank.import(tweede)).toMatchObject({ imported: 0, duplicates: 3 });
    expect(count(db)).toBe(4);
    // het waren toch twee betalingen: de gebruiker voegt hem toe, en de app meldt dat paar dan niet als dubbel
    s.bank.addSkipped(row!.id);
    expect(count(db)).toBe(5);
    expect(s.bank.paymentDoubles()).toEqual([]);
  });

  it('twee echte gelijke betalingen met precies dezelfde omschrijving blijven er allebei in, zoals altijd', () => {
    const { s, db } = setup();
    const lunch = { date: '2026-09-08', text: 'Card Payment: Broodjeszaak', amount: -750 };
    s.bank.import(kaartCsv([lunch]));
    // het tweede bestand heeft die dag twee keer dezelfde lunch: de tweede is nieuw
    expect(s.bank.import(kaartCsv([lunch, lunch]))).toMatchObject({ imported: 1, duplicates: 1, skipped: 0 });
    expect(count(db)).toBe(2);
    expect(s.bank.paymentDoubles()).toEqual([]);
  });

  it('een ander soort afschrift: het voorvoegsel maakt geen verschil, en bij twee kandidaten gaat de regel naast dezelfde winkel', () => {
    const { s, db } = setup();
    s.bank.import(result('csv', [tx('2026-09-08', -1299, { counterName: 'Card Payment: Wolkendienst', description: 'Card Payment: Wolkendienst' }), tx('2026-09-08', -1299, { counterName: 'Card Payment: Printhuis', description: 'Card Payment: Printhuis' })]));
    expect(s.bank.import(result('camt', [tx('2026-09-08', -1299, { counterName: 'Printhuis', description: 'Bon 4411', bankId: 'A' })]))).toMatchObject({ imported: 0, skipped: 1 });
    expect(count(db)).toBe(2);
    expect(s.bank.skippedRows()[0]).toMatchObject({ counterName: 'Printhuis', existing: { counterName: 'Card Payment: Printhuis' } });
  });
});

describe('handmatig negeren als dubbel', () => {
  const OPENING = 100000;
  function start() {
    const ctx = setup();
    const account = ctx.s.bank.ensureDefaultAccount(OWN);
    ctx.s.bank.setOpeningBalance(account.id, OPENING, '2026-09-01');
    // het afschrift met het eindsaldo: één betaling van € 12,99
    ctx.s.bank.import(result('camt', [tx('2026-09-08', -1299, { counterName: 'Printhuis', description: 'Bon 4411', bankId: 'A' })], { balances: [{ ownIban: OWN, date: '2026-09-11', amount: OPENING - 1299 }] }));
    const echt = ctx.s.bank.list()[0]!;
    // dezelfde betaling kwam er eerder al in uit een ander afschrift, een dag eerder gedateerd
    const dubbel = oudeImport(ctx.db, account.id, 'mt940', { date: '2026-09-07', amount: -1299, name: 'PRINTHUIS UTRECHT', text: 'Betaalautomaat' });
    return { ...ctx, account, echt, dubbel };
  }

  it('de regel wordt aan de andere betaling gekoppeld en telt dan niet meer mee in de saldocontrole', () => {
    const { s, account, echt, dubbel } = start();
    expect(s.bank.balanceCheck(account.id)).toMatchObject({ difference: 1299 });
    // de app stelt de betaling voor waar hij een dubbel van kan zijn: zelfde rekening en bedrag, een paar werkdagen ertussen
    expect(s.bank.duplicateCandidates(dubbel).map((c) => c.id)).toEqual([echt.id]);

    s.bank.ignore(dubbel, echt.id);
    expect(s.bank.get(dubbel)).toMatchObject({ status: 'genegeerd', duplicate_of: echt.id });
    expect(s.bank.balanceCheck(account.id)).toMatchObject({ difference: 0, app: OPENING - 1299 });
    expect(s.inbox.tasks('2026-09-12').filter((t) => t.kind === 'bank-balance')).toEqual([]);
    expect(s.bank.statementBalance(account.id)).toBe(-1299);
    expect(s.bank.removedDuplicates(account.id)).toMatchObject([{ id: dubbel, kept: { id: echt.id } }]);

    // terugzetten: het waren toch twee betalingen; hij telt weer mee en moet weer verwerkt worden
    s.bank.restoreDuplicate(dubbel);
    expect(s.bank.get(dubbel)).toMatchObject({ status: 'nieuw', duplicate_of: null });
    expect(s.bank.balanceCheck(account.id)).toMatchObject({ difference: 1299 });
  });

  it('gewoon negeren (niet als dubbel) telt nog steeds mee: het geld ging wel van de rekening af', () => {
    const { s, account, dubbel } = start();
    s.bank.ignore(dubbel);
    expect(s.bank.get(dubbel)).toMatchObject({ status: 'genegeerd', duplicate_of: null });
    expect(s.bank.balanceCheck(account.id)).toMatchObject({ difference: 1299 });
  });

  it('een regel die al genegeerd was zonder koppeling: alsnog als dubbel koppelen maakt het saldo kloppend', () => {
    const { s, account, echt, dubbel } = start();
    s.bank.ignore(dubbel);
    expect(s.bank.duplicateCandidates(dubbel).map((c) => c.id)).toEqual([echt.id]);
    s.bank.markDuplicate(dubbel, echt.id);
    expect(s.bank.get(dubbel)).toMatchObject({ status: 'genegeerd', duplicate_of: echt.id });
    expect(s.bank.balanceCheck(account.id)).toMatchObject({ difference: 0 });
  });

  it('alleen een betaling van hetzelfde bedrag op dezelfde rekening, en nooit een regel die al verwerkt is', () => {
    const { s, db, account, echt, dubbel } = start();
    const ander = oudeImport(db, account.id, 'mt940', { date: '2026-09-08', amount: -1300, name: 'Printhuis', text: 'x' });
    const ver = oudeImport(db, account.id, 'mt940', { date: '2026-09-21', amount: -1299, name: 'Printhuis', text: 'x' });
    const spaar = s.bank.addAccount('Spaarrekening', 'NL18RABO0123459876');
    const elders = oudeImport(db, spaar.id, 'mt940', { date: '2026-09-08', amount: -1299, name: 'Printhuis', text: 'x' });
    expect(s.bank.duplicateCandidates(dubbel).map((c) => c.id)).toEqual([echt.id]);
    for (const id of [ander, ver, elders, dubbel]) expect(() => s.bank.ignore(dubbel, id), String(id)).toThrow(/dezelfde betaling|zelf/);
    // al verwerkt: eerst die verwerking ongedaan maken
    s.bank.bookToAccount(dubbel, { account: 'WBedKanKan', vatCode: 'hoog' });
    expect(() => s.bank.markDuplicate(dubbel, echt.id)).toThrow(/al verwerkt.*Ongedaan maken/);
    expect(s.bank.get(dubbel).duplicate_of).toBeNull();
    // en een regel die zelf al als dubbel is weggehaald, is geen betaling om naar te verwijzen
    s.bank.unmatch(dubbel, '2026-09-12');
    s.bank.ignore(dubbel, echt.id);
    expect(() => s.bank.ignore(ver, dubbel)).toThrow();
  });
});

describe('melding op Vandaag: twee regels die dezelfde betaling lijken', () => {
  function start() {
    const ctx = setup();
    const account = ctx.s.bank.ensureDefaultAccount(OWN);
    const a = oudeImport(ctx.db, account.id, 'csv', { date: '2026-09-08', amount: -1299, name: 'Card Payment: Printhuis', text: 'Card Payment: Printhuis' });
    const b = oudeImport(ctx.db, account.id, 'camt', { date: '2026-09-08', amount: -1299, name: 'Printhuis', text: 'Bon 4411' });
    return { ...ctx, account, a, b };
  }

  it('beide al verwerkt: de melding met beide regels; één verwerking ongedaan maken en die regel als dubbel weghalen', () => {
    const { s, account, a, b } = start();
    s.bank.bookToAccount(a, { account: 'WBedKanKan', vatCode: 'geen' });
    s.bank.bookToAccount(b, { account: 'WBedKanKan', vatCode: 'geen' });
    expect(s.ledger.balance('WBedKanKan')).toBe(2598);
    expect(s.bank.paymentDoubles()).toMatchObject([{ firstId: a, secondId: b, bankAccountId: account.id, amount: -1299, first: { status: 'gematcht' }, second: { status: 'gematcht' } }]);
    const [task] = sameTasks(s);
    expect(task).toMatchObject({ key: `bank-same-${a}-${b}`, amount: 1299, actions: [{ id: 'bekijken', primary: true }], ref: { bankAccountId: account.id, sameFirstId: a, sameSecondId: b } });
    expect(task!.title).toMatch(/staat er waarschijnlijk twee keer in/);
    expect(task!.question).toMatch(/8 september 2026.*Card Payment: Printhuis.*Printhuis/);
    expect(s.inbox.home('2026-09-12').checklist.find((c) => c.label === 'Bankgegevens bijgewerkt')).toMatchObject({ ok: false });

    // wat al verwerkt is, haalt de app er niet zelf uit
    expect(() => s.bank.resolvePaymentDouble(a, b)).toThrow(/al verwerkt.*Ongedaan maken/);
    s.bank.unmatch(b, '2026-09-12');
    // de vrijgekomen regel boekt de app niet vanzelf opnieuw, ook niet bij een leverancier die vanzelf mag
    for (let i = 0; i < 3; i++) s.memory.learn('Printhuis', { categoryKey: 'kantoor', vatCode: 'geen', business: true });
    s.memory.setAutomatic('printhuis', true);
    s.settings.update({ onboardingDone: true });
    expect(s.inbox.autoProcess('2026-09-12')).toMatchObject({ booked: 0 });
    expect(s.bank.get(b).status).toBe('nieuw');

    s.bank.resolvePaymentDouble(a, b);
    expect(s.bank.get(b)).toMatchObject({ status: 'genegeerd', duplicate_of: a });
    expect(s.bank.get(a)).toMatchObject({ status: 'gematcht', duplicate_of: null });
    expect(s.ledger.balance('WBedKanKan')).toBe(1299);
    expect(s.ledger.balance(ACCOUNTS.bank)).toBe(-1299);
    expect(sameTasks(s)).toEqual([]);
    // terugzetten: twee betalingen; de app meldt dit paar daarna niet opnieuw
    s.bank.restoreDuplicate(b);
    expect(s.bank.get(b)).toMatchObject({ status: 'nieuw', duplicate_of: null });
    expect(sameTasks(s)).toEqual([]);
  });

  it('"het zijn twee verschillende betalingen": de melding komt niet terug en er verandert niets', () => {
    const { s, db, a, b } = start();
    const before = db.prepare('SELECT * FROM bank_transactions ORDER BY id').all();
    expect(sameTasks(s)).toHaveLength(1);
    s.bank.dismissPaymentDouble(a, b);
    expect(sameTasks(s)).toEqual([]);
    expect(s.bank.paymentDoubles()).toEqual([]);
    expect(db.prepare('SELECT * FROM bank_transactions ORDER BY id').all()).toEqual(before);
    expect(() => s.bank.resolvePaymentDouble(a, b)).toThrow(/niet \(meer\) dubbel/);
  });

  it('een regel die al genegeerd was: de melding blijft tot hij als dubbel gekoppeld is', () => {
    const { s, a, b } = start();
    s.bank.bookToAccount(a, { account: 'WBedKanKan', vatCode: 'geen' });
    s.bank.ignore(b);
    expect(sameTasks(s)).toHaveLength(1);
    s.bank.resolvePaymentDouble(a, b);
    expect(s.bank.get(b)).toMatchObject({ status: 'genegeerd', duplicate_of: a });
    expect(sameTasks(s)).toEqual([]);
  });

  it('wat geen dubbel is, wordt niet gemeld: andere winkel, andere dag, ander bedrag, zelfde afschrift, of twee id\'s uit dezelfde bron', () => {
    const { s, db } = setup();
    const account = s.bank.ensureDefaultAccount(OWN);
    oudeImport(db, account.id, 'csv', { date: '2026-09-08', amount: -1299, name: 'Card Payment: Printhuis', text: 'Card Payment: Printhuis' });
    oudeImport(db, account.id, 'camt', { date: '2026-09-08', amount: -1299, name: 'Kantoorhal', text: 'Bon 12' });
    oudeImport(db, account.id, 'camt', { date: '2026-09-09', amount: -1299, name: 'Printhuis', text: 'Bon 13' });
    oudeImport(db, account.id, 'camt', { date: '2026-09-08', amount: -1300, name: 'Printhuis', text: 'Bon 14' });
    // twee keer koffie op dezelfde dag in hetzelfde afschrift
    s.bank.import(result('csv', [tx('2026-09-10', -350, { counterName: 'Koffiehoek', description: 'Koffiehoek 1' }), tx('2026-09-10', -350, { counterName: 'Koffiehoek', description: 'Koffiehoek 2' })]));
    // rechtstreeks van de bank, in twee rondes: twee id's zijn twee betalingen
    s.bank.import(result('openbanking', [tx('2026-09-11', -350, { counterName: 'Koffiehoek', description: 'Koffiehoek', bankId: 'K1' })]));
    s.bank.import(result('openbanking', [tx('2026-09-11', -350, { counterName: 'Koffiehoek', description: 'Koffiehoek', bankId: 'K2' })]));
    expect(s.bank.paymentDoubles()).toEqual([]);
    expect(sameTasks(s)).toEqual([]);
  });
});
