import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { migrate, type Db } from '../src/db/database';
import { migrations } from '../src/db/migrations';
import { Ledger } from '../src/core-ledger/ledger';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import { BankService } from '../src/import/bank';
import { parseCsv, previewCsv } from '../src/import/csv';
import { parseCamt053 } from '../src/import/camt053';
import { parseMt940 } from '../src/import/mt940';
import type { NormalizedTransaction, ParseResult } from '../src/import/types';
import { workdaysBetween } from '../src/shared/dates';
import { formatEuro } from '../src/shared/money';

/**
 * Betrouwbaar inlezen (#184, deel 1): dezelfde betalingen in vier soorten afschrift. De datums en de
 * gegevens verschillen per soort, zoals bij echte banken: de CSV van Knab heeft de transactiedatum, CAMT
 * de boekdatum en een id van de bank, MT940 de valutadatum zonder id, de CSV van ABN AMRO geen tegenrekening.
 */
const OWN = 'NL91ABNA0417164300';

interface Payment {
  key: string;
  /** dag van de betaling zelf (CSV van Knab, MT940) */
  tx: string;
  /** dag waarop de bank hem boekte (CAMT, CSV van ABN AMRO) */
  book: string;
  amount: number;
  name: string;
  iban: string | null;
  text: string;
}

// september 2026: 1 september is een dinsdag
const WEEKS: Payment[] = [
  { key: 'jansen', tx: '2026-09-01', book: '2026-09-01', amount: 93643, name: 'Familie Jansen', iban: 'NL44RABO0123456789', text: 'factuur 2026-0001' },
  { key: 'kpn', tx: '2026-09-03', book: '2026-09-03', amount: -1500, name: 'KPN', iban: 'NL20INGB0001234567', text: 'Mobiel abonnement' },
  // kaartbetaling van vrijdag, geboekt op maandag: drie dagen verschil
  { key: 'shell', tx: '2026-09-04', book: '2026-09-07', amount: -6500, name: 'SHELL STATION', iban: null, text: 'Betaalautomaat pas 001' },
  // twee echte gelijke betalingen op dezelfde dag
  { key: 'lunch1', tx: '2026-09-08', book: '2026-09-08', amount: -2500, name: 'Bakker Bart', iban: null, text: 'Betaalautomaat pas 001' },
  { key: 'lunch2', tx: '2026-09-08', book: '2026-09-08', amount: -2500, name: 'Bakker Bart', iban: null, text: 'Betaalautomaat pas 001' },
  { key: 'gamma', tx: '2026-09-10', book: '2026-09-10', amount: -3025, name: 'Gamma Utrecht', iban: 'NL86INGB0002445588', text: 'Bon 4411 verf' },
  { key: 'devries', tx: '2026-09-11', book: '2026-09-11', amount: 12100, name: 'Bouwbedrijf De Vries BV', iban: 'NL18RABO0123459876', text: 'factuur 2026-0002' },
];
const SUM = WEEKS.reduce((n, p) => n + p.amount, 0);

const nl = (cents: number) => (Math.abs(cents) / 100).toFixed(2).replace('.', ',');

/** CSV zoals Knab: transactiedatum, met tegenrekening en naam */
function knabCsv(payments: Payment[]): ParseResult {
  const lines = ['Rekeningnummer;Transactiedatum;Valutacode;CreditDebet;Bedrag;Tegenrekeningnummer;Tegenrekeninghouder;Omschrijving;Betalingskenmerk'];
  for (const p of payments) {
    const [y, m, d] = p.tx.split('-');
    lines.push([OWN, `${d}-${m}-${y}`, 'EUR', p.amount < 0 ? 'D' : 'C', nl(p.amount), p.iban ?? '', p.name, p.text, ''].join(';'));
  }
  const text = lines.join('\n');
  const preview = previewCsv(text);
  expect(preview.detectedBank).toBe('Knab');
  return parseCsv(text, preview.suggestedMapping!);
}

/** CSV zoals ABN AMRO: boekdatum, geen tegenrekening, alles in één omschrijving */
function abnCsv(payments: Payment[]): ParseResult {
  const lines = ['accountNumber\tmutationcode\ttransactiondate\tamount\tdescription'];
  for (const p of payments) lines.push([OWN, 'EUR', p.book.replaceAll('-', ''), (p.amount / 100).toFixed(2), `${p.name} ${p.text}`].join('\t'));
  const text = lines.join('\n');
  const preview = previewCsv(text);
  expect(preview.detectedBank).toBe('ABN AMRO');
  return parseCsv(text, preview.suggestedMapping!);
}

/** CAMT.053: boekdatum, id van de bank per boeking, en een eindsaldo */
function camt(payments: Payment[], opts: { closing?: { date: string; amount: number; currency?: string } } = {}): ParseResult {
  const entries = payments.map((p) => {
    const debit = p.amount < 0;
    const party = debit
      ? `<Cdtr><Nm>${p.name}</Nm></Cdtr>${p.iban ? `<CdtrAcct><Id><IBAN>${p.iban}</IBAN></Id></CdtrAcct>` : ''}`
      : `<Dbtr><Nm>${p.name}</Nm></Dbtr>${p.iban ? `<DbtrAcct><Id><IBAN>${p.iban}</IBAN></Id></DbtrAcct>` : ''}`;
    return `<Ntry><Amt Ccy="EUR">${(Math.abs(p.amount) / 100).toFixed(2)}</Amt><CdtDbtInd>${debit ? 'DBIT' : 'CRDT'}</CdtDbtInd><Sts>BOOK</Sts>
      <BookgDt><Dt>${p.book}</Dt></BookgDt><AcctSvcrRef>REF-${p.key}</AcctSvcrRef>
      <NtryDtls><TxDtls><RltdPties>${party}</RltdPties><RmtInf><Ustrd>${p.text}</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>`;
  });
  const c = opts.closing;
  const bal = c
    ? `<Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="${c.currency ?? 'EUR'}">${(Math.abs(c.amount) / 100).toFixed(2)}</Amt><CdtDbtInd>${c.amount < 0 ? 'DBIT' : 'CRDT'}</CdtDbtInd><Dt><Dt>${c.date}</Dt></Dt></Bal>`
    : '';
  return parseCamt053(`<?xml version="1.0" encoding="UTF-8"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt>
    <Stmt><Id>1</Id><Acct><Id><IBAN>${OWN}</IBAN></Id></Acct>${bal}${entries.join('\n')}</Stmt></BkToCstmrStmt></Document>`);
}

/** MT940: valutadatum (de dag van de betaling), geen id van de bank */
async function mt940(payments: Payment[]): Promise<ParseResult> {
  const lines = [':20:STARTUMS', `:25:${OWN}`, ':28C:00000', ':60F:C260901EUR1000,00'];
  for (const p of payments) {
    const value = p.tx.slice(2).replaceAll('-', '');
    lines.push(`:61:${value}${p.book.slice(5).replace('-', '')}${p.amount < 0 ? 'D' : 'C'}${nl(p.amount)}NTRFNONREF`);
    lines.push(`:86:/CNTP/${p.iban ?? ''}//${p.name}///REMI/USTD//${p.text}/`);
  }
  const end = 100000 + payments.reduce((n, p) => n + p.amount, 0);
  lines.push(`:62F:${end < 0 ? 'D' : 'C'}260911EUR${nl(end)}`, '-', '');
  return parseMt940(Buffer.from(lines.join('\r\n'), 'utf8'));
}

const FORMATS: Record<string, (payments: Payment[]) => ParseResult | Promise<ParseResult>> = { 'CSV (Knab)': knabCsv, 'CSV (ABN AMRO)': abnCsv, CAMT: camt, MT940: mt940 };

type S = ReturnType<typeof setup>['s'];

/** Alles wat nog open staat verwerken, zoals een gebruiker zou doen: zo staat het ook in het grootboek. */
function processAll(s: S): void {
  for (const t of s.bank.list({ status: 'nieuw' })) {
    if (t.amount > 0) s.bank.bookToAccount(t.id, { account: ACCOUNTS.omzetHoog, vatCode: 'hoog' });
    else s.bank.bookToAccount(t.id, { account: 'WBedAutBra', vatCode: 'geen' });
  }
}

/** De stand van de boeken: aantal betalingen, hun som, het banksaldo in het grootboek en alle regels zelf. */
function books(s: S, db: Db) {
  return {
    count: (db.prepare('SELECT COUNT(*) AS n FROM bank_transactions').get() as { n: number }).n,
    sum: s.bank.statementBalance(),
    ledger: s.ledger.balance(ACCOUNTS.bank),
    open: s.bank.countUnprocessed(),
    // bank_id mag bij een oude regel worden aangevuld; verder verandert er niets aan een bestaande betaling
    rows: db.prepare('SELECT id, bank_account_id, transaction_date, amount, counter_iban, counter_name, description, reference, source, import_batch_id, dedup_hash, status, matched_journal_entry_id, matched_invoice_id, matched_purchase_invoice_id FROM bank_transactions ORDER BY id').all(),
    entries: (db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get() as { n: number }).n,
  };
}

const tx = (date: string, amount: number, extra: Partial<NormalizedTransaction> = {}): NormalizedTransaction => ({ date, amount, description: 'betaling', ownIban: OWN, ...extra });
const result = (source: ParseResult['source'], transactions: NormalizedTransaction[], extra: Partial<ParseResult> = {}): ParseResult => ({ source, warnings: [], transactions, ...extra });

describe('werkdagen', () => {
  it('telt maandag t/m vrijdag, in beide richtingen', () => {
    expect(workdaysBetween('2026-09-04', '2026-09-07')).toBe(1); // vrijdag → maandag
    expect(workdaysBetween('2026-09-07', '2026-09-04')).toBe(1);
    expect(workdaysBetween('2026-09-04', '2026-09-09')).toBe(3); // vrijdag → woensdag
    expect(workdaysBetween('2026-09-04', '2026-09-10')).toBe(4);
    expect(workdaysBetween('2026-09-05', '2026-09-06')).toBe(0); // zaterdag → zondag
    expect(workdaysBetween('2026-09-08', '2026-09-08')).toBe(0);
  });
});

describe('een betaling die er al staat, komt er niet nog een keer in', () => {
  it('de vier soorten afschrift lezen dezelfde betalingen, met per soort andere datums en gegevens', async () => {
    const [knab, abn, xml, sta] = [knabCsv(WEEKS), abnCsv(WEEKS), camt(WEEKS), await mt940(WEEKS)];
    for (const r of [knab, abn, xml, sta]) {
      expect(r.warnings).toEqual([]);
      expect(r.transactions).toHaveLength(WEEKS.length);
      expect(r.transactions.reduce((n, t) => n + t.amount, 0)).toBe(SUM);
    }
    const shell = (r: ParseResult) => r.transactions.find((t) => t.amount === -6500)!;
    expect([shell(knab).date, shell(abn).date, shell(xml).date, shell(sta).date]).toEqual(['2026-09-04', '2026-09-07', '2026-09-07', '2026-09-04']);
    expect(shell(abn).counterIban ?? null).toBeNull();
    expect(xml.transactions.every((t) => t.bankId)).toBe(true);
    expect(sta.transactions.every((t) => !t.bankId)).toBe(true);
  });

  const names = Object.keys(FORMATS);
  for (const first of names) {
    for (const second of names) {
      if (first === second) continue;
      it(`${first} en daarna ${second} over dezelfde weken: niets dubbel, niets kwijt, niets veranderd`, async () => {
        const { s, db } = setup();
        expect(s.bank.import(await FORMATS[first]!(WEEKS))).toMatchObject({ imported: WEEKS.length, duplicates: 0 });
        processAll(s);
        const before = books(s, db);
        expect(before).toMatchObject({ count: WEEKS.length, sum: SUM, ledger: SUM, open: 0 });

        const again = s.bank.import(await FORMATS[second]!(WEEKS));
        expect(again).toMatchObject({ imported: 0, duplicates: WEEKS.length, addedInKnownPeriod: 0 });
        // "uit je afschrift van 1 t/m 11 september": de periode van het eerste afschrift
        expect(again.knownFrom).toHaveLength(1);
        expect(books(s, db)).toEqual(before);
        // en nog een keer hetzelfde bestand: weer niets
        expect(s.bank.import(await FORMATS[second]!(WEEKS))).toMatchObject({ imported: 0, duplicates: WEEKS.length });
        expect(s.bank.import(await FORMATS[first]!(WEEKS))).toMatchObject({ imported: 0, duplicates: WEEKS.length });
        expect(books(s, db)).toEqual(before);
        expect(s.ledger.checkIntegrity().balanced).toBe(true);
      });
    }
  }

  it('alle vier de soorten na elkaar, in elke volgorde: steeds dezelfde boeken', async () => {
    const orders = (list: string[]): string[][] => (list.length <= 1 ? [list] : list.flatMap((x, i) => orders([...list.slice(0, i), ...list.slice(i + 1)]).map((rest) => [x, ...rest])));
    for (const order of orders(names)) {
      const { s, db } = setup();
      for (const name of order) {
        s.bank.import(await FORMATS[name]!(WEEKS));
        processAll(s);
      }
      expect(books(s, db), order.join(' → ')).toMatchObject({ count: WEEKS.length, sum: SUM, ledger: SUM, open: 0 });
    }
  });

  it('een CAMT die een gat tussen twee CSV-afschriften vult', () => {
    const { s, db } = setup();
    s.bank.import(knabCsv(WEEKS.slice(0, 3))); // 1 t/m 4 september
    s.bank.import(knabCsv(WEEKS.slice(5))); // 10 en 11 september
    processAll(s);
    const r = s.bank.import(camt(WEEKS));
    // de twee lunches van 8 september stonden in geen van beide; de rest stond er al (ook de kaartbetaling
    // van vrijdag 4 september, die in de CAMT op maandag 7 september staat: net buiten het eerste afschrift)
    expect(r).toMatchObject({ imported: 2, duplicates: 5, skipped: 5, addedInKnownPeriod: 0 });
    expect(r.knownFrom).toEqual([{ from: '2026-09-01', to: '2026-09-04' }, { from: '2026-09-10', to: '2026-09-11' }]);
    expect(books(s, db)).toMatchObject({ count: WEEKS.length, sum: SUM, open: 2 });
  });

  it('twee echte gelijke betalingen blijven er allebei in', () => {
    const { s, db } = setup();
    // de CSV had er maar één: de tweede lunch ontbrak
    s.bank.import(knabCsv(WEEKS.filter((p) => p.key !== 'lunch2')));
    const r = s.bank.import(camt(WEEKS));
    expect(r).toMatchObject({ imported: 1, duplicates: 6, skipped: 6, addedInKnownPeriod: 1 });
    expect(books(s, db)).toMatchObject({ count: WEEKS.length, sum: SUM });
    // elke betaling die er al stond is per soort afschrift van hooguit één overgeslagen regel de tegenhanger
    expect(db.prepare('SELECT matched_transaction_id FROM import_skipped GROUP BY matched_transaction_id HAVING COUNT(*) > 1').all()).toEqual([]);
  });

  it('een betaling die in het eerdere afschrift ontbrak, wordt toegevoegd', () => {
    const { s, db } = setup();
    s.bank.import(camt(WEEKS.filter((p) => p.key !== 'kpn')));
    const r = s.bank.import(knabCsv(WEEKS));
    expect(r).toMatchObject({ imported: 1, duplicates: 6, addedInKnownPeriod: 1 });
    expect(s.bank.addedInKnownPeriod(r.batchId).map((t) => t.counter_name)).toEqual(['KPN']);
    expect(books(s, db)).toMatchObject({ count: WEEKS.length, sum: SUM });
  });

  it('een kaartbetaling met drie dagen tussen transactie- en boekdatum is dezelfde betaling; vier werkdagen niet', () => {
    const { s } = setup();
    s.bank.import(result('csv', [tx('2026-09-01', -100), tx('2026-09-04', -6500, { counterName: 'SHELL' }), tx('2026-09-18', -100)]));
    // vrijdag 4 → maandag 7 september: drie dagen, één werkdag
    expect(s.bank.import(result('camt', [tx('2026-09-07', -6500, { bankId: 'A' })]))).toMatchObject({ imported: 0, skipped: 1 });
    // een derde soort afschrift herkent dezelfde betaling ook (vrijdag 4 → woensdag 9 september: drie werkdagen)
    expect(s.bank.import(result('mt940', [tx('2026-09-09', -6500)]))).toMatchObject({ imported: 0, skipped: 1 });
    // maar een ander CAMT-afschrift met een andere id is een andere betaling: de tegenhanger is voor CAMT al bezet
    expect(s.bank.import(result('camt', [tx('2026-09-08', -6500, { bankId: 'B' })]))).toMatchObject({ imported: 1, skipped: 0, addedInKnownPeriod: 1 });
    const { s: s2 } = setup();
    s2.bank.import(result('csv', [tx('2026-09-01', -100), tx('2026-09-04', -6500), tx('2026-09-18', -100)]));
    expect(s2.bank.import(result('camt', [tx('2026-09-09', -6500, { bankId: 'A' })])), 'drie werkdagen').toMatchObject({ imported: 0, skipped: 1 });
    const { s: s3 } = setup();
    s3.bank.import(result('csv', [tx('2026-09-01', -100), tx('2026-09-04', -6500), tx('2026-09-18', -100)]));
    expect(s3.bank.import(result('camt', [tx('2026-09-10', -6500, { bankId: 'A' })])), 'vier werkdagen').toMatchObject({ imported: 1, skipped: 0, addedInKnownPeriod: 1 });
  });

  it('een andere tegenrekening is een andere betaling; zonder tegenrekening aan één kant telt alleen het bedrag', () => {
    const { s } = setup();
    s.bank.import(result('csv', [tx('2026-09-01', -100), tx('2026-09-08', -5000, { counterIban: 'NL20INGB0001234567' }), tx('2026-09-18', -100)]));
    expect(s.bank.import(result('camt', [tx('2026-09-08', -5000, { counterIban: 'NL86INGB0002445588', bankId: 'A' })]))).toMatchObject({ imported: 1, skipped: 0 });
    expect(s.bank.import(result('mt940', [tx('2026-09-08', -5000, { description: 'zonder rekeningnummer' })]))).toMatchObject({ imported: 0, skipped: 1 });
  });

  it('bij meer kandidaten eerst de dichtstbijzijnde datum, ook als de regels in een andere volgorde staan', () => {
    const { s, db } = setup();
    s.bank.import(result('csv', [tx('2026-09-01', -100), tx('2026-09-08', -5000, { description: 'dinsdag' }), tx('2026-09-18', -100)]));
    const [, tuesday] = db.prepare('SELECT id FROM bank_transactions ORDER BY id').all() as { id: number }[];
    // woensdag staat vóór dinsdag in het bestand: dinsdag hoort bij dinsdag, woensdag is nieuw
    const r = s.bank.import(result('camt', [tx('2026-09-09', -5000, { bankId: 'WO' }), tx('2026-09-08', -5000, { bankId: 'DI' })]));
    expect(r).toMatchObject({ imported: 1, skipped: 1 });
    expect(db.prepare('SELECT transaction_date, matched_transaction_id FROM import_skipped').all()).toEqual([{ transaction_date: '2026-09-08', matched_transaction_id: tuesday!.id }]);
  });

  it('net buiten een eerder afschrift van een ander soort: de kaartbetaling van de laatste dag komt er niet dubbel in', () => {
    const { s, db } = setup();
    // de CSV loopt t/m vrijdag 4 september (transactiedatum); de CAMT boekt die betaling op maandag 7 september
    s.bank.import(result('csv', [tx('2026-09-01', -100), tx('2026-09-04', -6500, { counterName: 'SHELL' })]));
    expect(s.bank.import(result('camt', [tx('2026-09-07', -6500, { bankId: 'A' }), tx('2026-09-07', -900, { bankId: 'B' })]))).toMatchObject({ imported: 1, skipped: 1, addedInKnownPeriod: 0 });
    expect(books(s, db)).toMatchObject({ count: 3, sum: -7500 });
  });

  it('hetzelfde soort afschrift met een dag overlap werkt zoals altijd: een nieuwe betaling van hetzelfde bedrag komt erin', () => {
    const { s, db } = setup();
    // elke dag dezelfde lunch; het eerste afschrift is van maandagochtend, het tweede begint op maandag
    const lunch = (date: string, n: number) => tx(date, -750, { counterName: 'Bakker Bart', description: `Betaalautomaat ${n}` });
    s.bank.import(result('csv', [lunch('2026-09-03', 1), lunch('2026-09-04', 2), tx('2026-09-07', -1500, { counterName: 'KPN' })]));
    const r = s.bank.import(result('csv', [tx('2026-09-07', -1500, { counterName: 'KPN' }), lunch('2026-09-07', 3), lunch('2026-09-08', 4)]));
    expect(r).toMatchObject({ imported: 2, duplicates: 1, skipped: 0 });
    expect(books(s, db)).toMatchObject({ count: 5, sum: -4500 });
    // net zo bij CAMT waarvan de oude regels nog geen bank-id hebben (ingelezen vóór #184)
    const { s: s2, db: db2 } = setup();
    s2.bank.import(result('camt', [tx('2026-09-04', -750, { bankId: 'L1' }), tx('2026-09-07', -1500, { bankId: 'K' })]));
    db2.exec('UPDATE bank_transactions SET bank_id = NULL');
    expect(s2.bank.import(result('camt', [tx('2026-09-07', -1500, { bankId: 'K' }), tx('2026-09-07', -750, { bankId: 'L2' })]))).toMatchObject({ imported: 1, duplicates: 1, skipped: 0 });
    // de hash bewees dat de oude regel deze id had: die is nu vastgelegd
    expect(db2.prepare('SELECT bank_id FROM bank_transactions ORDER BY id').all()).toEqual([{ bank_id: null }, { bank_id: 'K' }, { bank_id: 'L2' }]);
  });

  it('het soort afschrift: de bron, en bij CSV ook de indeling', () => {
    const { s, db } = setup();
    expect(knabCsv(WEEKS).layout).toBe(knabCsv(WEEKS.slice(0, 2)).layout);
    expect(knabCsv(WEEKS).layout).not.toBe(abnCsv(WEEKS).layout);
    expect(camt(WEEKS).layout).toBeUndefined();
    // twee afschriften van Knab met een dag overlap: de lunch van 8 september uit het tweede bestand is nieuw,
    // ook al stond er die dag al een lunch van hetzelfde bedrag (de hash beslist, zoals altijd)
    s.bank.import(knabCsv(WEEKS.filter((p) => p.key !== 'lunch2' && p.tx <= '2026-09-08')));
    const r = s.bank.import(knabCsv(WEEKS.filter((p) => p.tx >= '2026-09-08')));
    expect(r).toMatchObject({ imported: 3, duplicates: 1, skipped: 0 });
    expect(db.prepare('SELECT DISTINCT kind FROM import_batches').all()).toEqual([{ kind: `csv:${knabCsv(WEEKS).layout}` }]);
    expect(books(s, db)).toMatchObject({ count: WEEKS.length, sum: SUM });
  });

  it('dezelfde id van de bank twee keer in één bestand: zelfde inhoud is één betaling, andere inhoud zijn er twee', () => {
    const { s, db } = setup();
    const r = s.bank.import(result('mt940', [tx('2026-09-01', -100, { bankId: 'X' }), tx('2026-09-01', -100, { bankId: 'X' }), tx('2026-09-02', -250, { bankId: 'X' })]));
    expect(r).toMatchObject({ imported: 2, duplicates: 1 });
    expect(db.prepare('SELECT amount, bank_id FROM bank_transactions ORDER BY id').all()).toEqual([{ amount: -100, bank_id: 'X' }, { amount: -250, bank_id: 'X#3' }]);
    expect(s.bank.import(result('mt940', [tx('2026-09-01', -100, { bankId: 'X' }), tx('2026-09-01', -100, { bankId: 'X' }), tx('2026-09-02', -250, { bankId: 'X' })]))).toMatchObject({ imported: 0, duplicates: 3 });
  });
});

describe('rechtstreeks van de bank (bron openbanking) naast afschriften', () => {
  const IBAN = 'NL20INGB0001234567';

  it('twee keer € 50 aan dezelfde rekening, twee dagen na elkaar, in overlappende rondes: allebei erin', () => {
    const { s, db } = setup();
    s.bank.import(result('openbanking', [tx('2026-09-07', -900, { bankId: 'u0' }), tx('2026-09-08', -5000, { counterIban: IBAN, bankId: 'u1' }), tx('2026-09-11', -1200, { bankId: 'u3' })]));
    // de volgende ronde overlapt: u1 komt terug, u2 is nieuw (twee dagen later, zelfde bedrag en rekening)
    const r = s.bank.import(result('openbanking', [tx('2026-09-08', -5000, { counterIban: IBAN, bankId: 'u1' }), tx('2026-09-10', -5000, { counterIban: IBAN, bankId: 'u2' }), tx('2026-09-11', -1200, { bankId: 'u3' })]));
    expect(r).toMatchObject({ imported: 1, duplicates: 2, skipped: 0 });
    expect(books(s, db)).toMatchObject({ count: 4, sum: -12100 });
    // ook als de eerste niet terugkomt: twee verschillende id's uit dezelfde bron zijn twee betalingen
    const { s: s2 } = setup();
    s2.bank.import(result('openbanking', [tx('2026-09-07', -900, { bankId: 'u0' }), tx('2026-09-08', -5000, { counterIban: IBAN, bankId: 'u1' }), tx('2026-09-11', -1200, { bankId: 'u3' })]));
    expect(s2.bank.import(result('openbanking', [tx('2026-09-10', -5000, { counterIban: IBAN, bankId: 'u2' })]))).toMatchObject({ imported: 1, skipped: 0, addedInKnownPeriod: 1 });
  });

  it('een kopie van een CAMT-regel wordt overgeslagen; een ronde later komt een andere betaling van hetzelfde bedrag er wel in', () => {
    const { s, db } = setup();
    s.bank.import(result('camt', [tx('2026-09-01', -100, { bankId: 'C0' }), tx('2026-09-10', -5000, { counterIban: IBAN, bankId: 'C1' }), tx('2026-09-14', -100, { bankId: 'C2' })]));
    const camtRow = (db.prepare(`SELECT id FROM bank_transactions WHERE bank_id = 'C1'`).get() as { id: number }).id;
    expect(s.bank.import(result('openbanking', [tx('2026-09-10', -5000, { counterIban: IBAN, bankId: 'u1' })]))).toMatchObject({ imported: 0, skipped: 1 });
    // een ronde later: u1 nog een keer, en een andere betaling van € 50 een dag later
    const r = s.bank.import(result('openbanking', [tx('2026-09-10', -5000, { counterIban: IBAN, bankId: 'u1' }), tx('2026-09-11', -5000, { counterIban: IBAN, bankId: 'u2' })]));
    expect(r).toMatchObject({ imported: 1, duplicates: 1, skipped: 0, addedInKnownPeriod: 1 });
    // de CAMT-regel blijft bezet door u1
    expect(db.prepare('SELECT bank_id, matched_transaction_id FROM import_skipped').all()).toEqual([{ bank_id: 'u1', matched_transaction_id: camtRow }]);
    expect(books(s, db)).toMatchObject({ count: 4, sum: -10200 });
  });
});

describe('overgeslagen regels: niets verdwijnt stil', () => {
  it('de overgeslagen regel staat naast de betaling die er al stond, en komt er met Toch toevoegen alsnog in', () => {
    const { s, db } = setup();
    // de CSV miste de tweede lunch; de CAMT heeft er maar één, en dat is juist die tweede
    s.bank.import(result('csv', [tx('2026-09-01', -100), tx('2026-09-08', -2500, { counterName: 'Bakker Bart', description: 'lunch 1' }), tx('2026-09-18', -100)]), { filename: 'eerste.csv' });
    const r = s.bank.import(result('camt', [tx('2026-09-08', -2500, { counterName: 'Bakker Bart', description: 'lunch 2', bankId: 'L2' })]), { filename: 'tweede.xml' });
    expect(r).toMatchObject({ imported: 0, duplicates: 1, skipped: 1, knownFrom: [{ from: '2026-09-01', to: '2026-09-18' }] });
    const [row] = s.bank.skippedRows({ batchId: r.batchId });
    expect(row).toMatchObject({ date: '2026-09-08', amount: -2500, description: 'lunch 2', added: false, existing: { description: 'lunch 1', filename: 'eerste.csv', source: 'csv' } });
    expect(s.bank.importStatus()[0]).toMatchObject({ skipped: 1 });

    const id = s.bank.addSkipped(row!.id);
    expect(s.bank.get(id)).toMatchObject({ transaction_date: '2026-09-08', amount: -2500, description: 'lunch 2', source: 'camt', bank_id: 'L2', status: 'nieuw', import_batch_id: r.batchId });
    expect(books(s, db)).toMatchObject({ count: 4, sum: -5200 });
    expect(s.bank.skippedRows({ batchId: r.batchId })[0]).toMatchObject({ added: true });
    expect(s.bank.importStatus()[0]).toMatchObject({ skipped: 0, lastImport: { imported: 1, duplicates: 0 } });
    expect(() => s.bank.addSkipped(row!.id)).toThrow('al toegevoegd');
    expect(() => s.bank.addSkipped(9999)).toThrow('bestaat niet');
    // hetzelfde afschrift nog een keer: hij staat er nu, dus niet dubbel
    expect(s.bank.import(result('camt', [tx('2026-09-08', -2500, { counterName: 'Bakker Bart', description: 'lunch 2', bankId: 'L2' })]))).toMatchObject({ imported: 0, duplicates: 1, skipped: 0 });
    // de eerste lunch is weer vrij als tegenhanger: een derde soort afschrift met beide lunches vindt ze allebei
    expect(s.bank.import(result('mt940', [tx('2026-09-08', -2500, { description: 'LUNCH A' }), tx('2026-09-08', -2500, { description: 'LUNCH B' })]))).toMatchObject({ imported: 0, skipped: 2 });
    expect(books(s, db)).toMatchObject({ count: 4, sum: -5200 });
  });

  it('een eerder overgeslagen regel wordt bij opnieuw inlezen weer overgeslagen, tegen dezelfde tegenhanger', () => {
    const { s, db } = setup();
    s.bank.import(knabCsv(WEEKS));
    s.bank.import(camt(WEEKS));
    const skipped = db.prepare('SELECT dedup_hash, matched_transaction_id FROM import_skipped ORDER BY id').all();
    expect(skipped).toHaveLength(WEEKS.length);
    const r = s.bank.import(camt(WEEKS));
    expect(r).toMatchObject({ imported: 0, duplicates: WEEKS.length, skipped: 0, knownFrom: [{ from: '2026-09-01', to: '2026-09-11' }] });
    expect(db.prepare('SELECT dedup_hash, matched_transaction_id FROM import_skipped ORDER BY id').all()).toEqual(skipped);
  });
});

describe('deelposten van een CAMT-batchboeking', () => {
  const batch = (subs: string[], entryRef = '<AcctSvcrRef>BATCH-1</AcctSvcrRef>') => `<?xml version="1.0" encoding="UTF-8"?>
    <Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt><Id>1</Id><Acct><Id><IBAN>${OWN}</IBAN></Id></Acct>
      <Ntry><Amt Ccy="EUR">600.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>2026-09-15</Dt></BookgDt>${entryRef}
        <NtryDtls>${subs.join('')}</NtryDtls></Ntry>
    </Stmt></BkToCstmrStmt></Document>`;
  const sub = (amount: string, name: string, ref = '') =>
    `<TxDtls>${ref ? `<Refs><AcctSvcrRef>${ref}</AcctSvcrRef></Refs>` : ''}<Amt Ccy="EUR">${amount}</Amt><RltdPties><Cdtr><Nm>${name}</Nm></Cdtr></RltdPties><RmtInf><Ustrd>loon ${name}</Ustrd></RmtInf></TxDtls>`;
  const ids = (xml: string) => parseCamt053(xml).transactions.map((t) => t.bankId);

  it('zonder eigen id: de eerste houdt de id van de boeking, de rest krijgt een volgnummer', () => {
    expect(ids(batch([sub('100.00', 'Jan'), sub('200.00', 'Piet'), sub('300.00', 'Klaas')]))).toEqual(['BATCH-1', 'BATCH-1#2', 'BATCH-1#3']);
  });

  it('met een eigen id die verschilt van die van de boeking: vanaf de tweede de eigen id', () => {
    expect(ids(batch([sub('100.00', 'Jan', 'S-1'), sub('200.00', 'Piet', 'S-2'), sub('300.00', 'Klaas', 'S-3')]))).toEqual(['BATCH-1', 'S-2', 'S-3']);
  });

  it('met een eigen id die gelijk is aan die van de boeking (of aan een eerdere deelpost): een volgnummer', () => {
    expect(ids(batch([sub('100.00', 'Jan', 'BATCH-1'), sub('200.00', 'Piet', 'BATCH-1'), sub('300.00', 'Klaas', 'BATCH-1')]))).toEqual(['BATCH-1', 'BATCH-1#2', 'BATCH-1#3']);
    expect(ids(batch([sub('100.00', 'Jan', 'S-1'), sub('200.00', 'Piet', 'S-2'), sub('300.00', 'Klaas', 'S-2')]))).toEqual(['BATCH-1', 'S-2', 'BATCH-1#3']);
    // een boeking zonder eigen id: zoals het was (eigen id's van de deelposten), en zonder enige id geen id
    expect(ids(batch([sub('100.00', 'Jan', 'S-1'), sub('200.00', 'Piet', 'S-2'), sub('300.00', 'Klaas', 'S-1')], ''))).toEqual(['S-1', 'S-2', 'S-1#3']);
    expect(ids(batch([sub('100.00', 'Jan'), sub('200.00', 'Piet')], ''))).toEqual([null, null]);
  });

  it('een boeking met één deelpost, of deelposten zonder eigen bedrag, blijft één betaling met de id van de boeking', () => {
    expect(ids(batch([sub('600.00', 'Jan', 'S-1')]))).toEqual(['BATCH-1']);
    const noAmounts = batch(['<TxDtls><RmtInf><Ustrd>a</Ustrd></RmtInf></TxDtls>', '<TxDtls><RmtInf><Ustrd>b</Ustrd></RmtInf></TxDtls>']);
    expect(parseCamt053(noAmounts).transactions.map((t) => [t.amount, t.bankId])).toEqual([[-60000, 'BATCH-1']]);
  });

  it('alle deelposten komen erin, ook drie gelijke bedragen; opnieuw inlezen geeft niets dubbel', () => {
    const { s, db } = setup();
    const xml = batch([sub('200.00', 'Jan'), sub('200.00', 'Piet'), sub('200.00', 'Klaas')]);
    expect(s.bank.import(parseCamt053(xml))).toMatchObject({ imported: 3, duplicates: 0 });
    expect(s.bank.import(parseCamt053(xml))).toMatchObject({ imported: 0, duplicates: 3 });
    expect(books(s, db)).toMatchObject({ count: 3, sum: -60000 });
  });

  it('een oud afschrift (alleen de eerste deelpost kwam erin) wordt niet dubbel: de ontbrekende deelposten komen erbij', () => {
    const { s, db } = setup();
    const xml = batch([sub('200.00', 'Jan'), sub('200.00', 'Piet'), sub('200.00', 'Klaas')]);
    // zoals vóór #184: alle deelposten met de id van de boeking, dus alleen de eerste bleef over
    const old = parseCamt053(xml);
    for (const t of old.transactions) t.bankId = 'BATCH-1';
    expect(s.bank.import(old)).toMatchObject({ imported: 1, duplicates: 2 });
    db.exec('UPDATE bank_transactions SET bank_id = NULL');
    processAll(s);
    const first = db.prepare('SELECT id, dedup_hash, status, matched_journal_entry_id FROM bank_transactions').all();
    expect(s.bank.import(parseCamt053(xml))).toMatchObject({ imported: 2, duplicates: 1, skipped: 0 });
    expect(db.prepare('SELECT id, dedup_hash, status, matched_journal_entry_id FROM bank_transactions WHERE id = ?').all((first[0] as { id: number }).id)).toEqual(first);
    expect(books(s, db)).toMatchObject({ count: 3, sum: -60000, ledger: -20000 });
    expect(db.prepare('SELECT counter_name FROM bank_transactions ORDER BY id').all()).toEqual([{ counter_name: 'Jan' }, { counter_name: 'Piet' }, { counter_name: 'Klaas' }]);
  });
});

describe('administratie van vóór #184 (zonder bank-id en zonder overgeslagen regels)', () => {
  /** Inlezen zoals de app het deed vóór deze migratie: zelfde hash, geen bank_id. */
  function oldImport(db: Db, accountId: number, iban: string, r: ParseResult, filename: string): void {
    const batchId = Number(db.prepare('INSERT INTO import_batches (filename, source) VALUES (?, ?)').run(filename, r.source).lastInsertRowid);
    const insert = db.prepare(
      `INSERT OR IGNORE INTO bank_transactions (bank_account_id, transaction_date, amount, counter_iban, counter_name, description, reference, source, import_batch_id, dedup_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const seen = new Map<string, number>();
    let imported = 0;
    for (const t of r.transactions) {
      const key = [accountId, t.date, t.amount, t.counterIban, t.description].join('|');
      const occurrence = (seen.get(key) ?? 0) + 1;
      seen.set(key, occurrence);
      imported += insert.run(accountId, t.date, t.amount, t.counterIban ?? null, t.counterName ?? null, t.description ?? '', t.reference ?? null, r.source, batchId, BankService.hash(t, iban, occurrence)).changes;
    }
    const dates = r.transactions.map((t) => t.date).sort();
    db.prepare('INSERT INTO import_batch_accounts (batch_id, bank_account_id, period_from, period_to, transactions, imported, duplicates) VALUES (?, ?, ?, ?, ?, ?, ?)').run(batchId, accountId, dates[0], dates.at(-1), r.transactions.length, imported, r.transactions.length - imported);
  }

  function oldDatabase(): { db: Db; accountId: number } {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    // de migratie van #184 opzoeken op wat hij doet, niet op zijn nummer
    const index = migrations.findIndex((m) => m.includes('CREATE TABLE import_skipped'));
    expect(index).toBeGreaterThan(0);
    for (const m of migrations.slice(0, index)) db.exec(m);
    db.pragma(`user_version = ${index}`);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('bank_transactions') WHERE name = 'bank_id'`).get()).toEqual({ n: 0 });
    new Ledger(db).seedDefaultAccounts();
    const ledgerAccount = db.prepare('SELECT id FROM chart_of_accounts WHERE rgs_code = ?').get(ACCOUNTS.bank) as { id: number };
    const accountId = Number(db.prepare('INSERT INTO bank_accounts (name, iban, account_id) VALUES (?, ?, ?)').run('Zakelijke rekening', OWN, ledgerAccount.id).lastInsertRowid);
    return { db, accountId };
  }

  for (const [oldName, newName] of [['CSV (Knab)', 'CAMT'], ['CAMT', 'CSV (Knab)'], ['CAMT', 'MT940'], ['MT940', 'CAMT'], ['CSV (ABN AMRO)', 'CSV (Knab)']] as const) {
    it(`${oldName} ingelezen met de oude versie, daarna ${newName} over dezelfde weken: dezelfde betalingen`, async () => {
      const { db, accountId } = oldDatabase();
      oldImport(db, accountId, OWN, await FORMATS[oldName]!(WEEKS), 'oud');
      const hashes = db.prepare('SELECT id, dedup_hash FROM bank_transactions ORDER BY id').all();
      expect(hashes).toHaveLength(WEEKS.length);

      migrate(db);
      expect(db.pragma('user_version', { simple: true })).toBe(migrations.length);
      // de migratie laat de betalingen zoals ze waren: zelfde hash, nog geen bank-id
      expect(db.prepare('SELECT id, dedup_hash FROM bank_transactions ORDER BY id').all()).toEqual(hashes);
      expect(db.prepare('SELECT COUNT(*) AS n FROM bank_transactions WHERE bank_id IS NOT NULL').get()).toEqual({ n: 0 });

      const { s } = setup({ db });
      processAll(s);
      const before = books(s, db);
      expect(before).toMatchObject({ count: WEEKS.length, sum: SUM, ledger: SUM, open: 0 });
      // een ander soort afschrift over dezelfde weken
      expect(s.bank.import(await FORMATS[newName]!(WEEKS))).toMatchObject({ imported: 0, duplicates: WEEKS.length });
      expect(books(s, db)).toEqual(before);
      // en hetzelfde oude afschrift nog een keer: de hash is dezelfde gebleven
      expect(s.bank.import(await FORMATS[oldName]!(WEEKS))).toMatchObject({ imported: 0, duplicates: WEEKS.length, skipped: 0 });
      expect(books(s, db)).toEqual(before);
    });
  }

  it('een import zonder periode (zou niet mogen bestaan) krijgt die bij de migratie alsnog uit zijn betalingen', async () => {
    const { db, accountId } = oldDatabase();
    oldImport(db, accountId, OWN, knabCsv(WEEKS), 'oud');
    db.exec('DELETE FROM import_batch_accounts');
    migrate(db);
    expect(db.prepare('SELECT period_from, period_to, transactions FROM import_batch_accounts').all()).toEqual([{ period_from: '2026-09-01', period_to: '2026-09-11', transactions: WEEKS.length }]);
    const { s } = setup({ db });
    expect(s.bank.import(camt(WEEKS))).toMatchObject({ imported: 0, duplicates: WEEKS.length });
  });
});

describe('controle: klopt het saldo?', () => {
  const OPENING = 100000;
  const balanceTasks = (s: S) => s.inbox.tasks('2026-09-12').filter((t) => t.kind === 'bank-balance');
  function start(openingDate = '2026-09-01') {
    const ctx = setup();
    const account = ctx.s.bank.ensureDefaultAccount(OWN);
    ctx.s.bank.setOpeningBalance(account.id, OPENING, openingDate);
    return { ...ctx, account };
  }

  it('saldo klopt: geen taak', () => {
    const { s, account } = start();
    s.bank.import(camt(WEEKS, { closing: { date: '2026-09-11', amount: OPENING + SUM } }));
    expect(s.bank.balanceCheck(account.id)).toMatchObject({ date: '2026-09-11', bank: OPENING + SUM, app: OPENING + SUM, difference: 0 });
    expect(balanceTasks(s)).toEqual([]);
  });

  it('saldo klopt niet: een taak per rekening met beide bedragen en het verschil', () => {
    const { s, account } = start();
    // de app mist de betaling van € 25,00 die binnenkwam
    s.bank.import(camt(WEEKS, { closing: { date: '2026-09-11', amount: OPENING + SUM + 2500 } }));
    const [task] = balanceTasks(s);
    expect(task).toMatchObject({ key: `bank-balance-${account.id}-2026-09-11`, title: 'Zakelijke rekening: het saldo klopt niet', amount: 2500, ref: { bankAccountId: account.id } });
    expect(task!.question).toBe(`Volgens je bank stond er op 11 september 2026 ${formatEuro(192218)}, volgens de app ${formatEuro(189718)}. Er mist waarschijnlijk een betaling van ${formatEuro(2500)}.`);
    expect(task!.actions.map((a) => a.label)).toEqual(['Afschrift inlezen', 'Dit klopt, negeren']);
    expect(balanceTasks(s), 'per saldodatum één taak').toHaveLength(1);
    expect(s.inbox.home('2026-09-12').checklist.find((c) => c.label === 'Bankgegevens bijgewerkt')).toMatchObject({ ok: false });
  });

  it('de app heeft meer dan de bank: er mist een afschrijving, of er staat iets dubbel in', () => {
    const { s } = start();
    s.bank.import(camt(WEEKS, { closing: { date: '2026-09-11', amount: OPENING + SUM - 1500 } }));
    expect(balanceTasks(s)[0]!.question).toContain(`Er mist waarschijnlijk een afschrijving van ${formatEuro(1500)}, of er staat een betaling dubbel in.`);
  });

  it('een genegeerde betaling telt mee: hij ging wel van de rekening af', () => {
    const { s } = start();
    s.bank.import(camt(WEEKS, { closing: { date: '2026-09-11', amount: OPENING + SUM } }));
    s.bank.ignore(s.bank.list().find((t) => t.counter_name === 'KPN')!.id);
    processAll(s);
    expect(balanceTasks(s)).toEqual([]);
  });

  it('beginsaldo midden in de periode: alleen wat vanaf die dag gebeurde telt', () => {
    const { s, account } = start('2026-09-08');
    const from8 = WEEKS.filter((p) => p.book >= '2026-09-08').reduce((n, p) => n + p.amount, 0);
    s.bank.import(camt(WEEKS, { closing: { date: '2026-09-11', amount: OPENING + from8 } }));
    expect(s.bank.balanceCheck(account.id)).toMatchObject({ app: OPENING + from8, difference: 0 });
    expect(balanceTasks(s)).toEqual([]);
  });

  it('zonder beginsaldo, zonder eindsaldo of met een saldo in een andere valuta valt er niets te controleren', () => {
    const none = setup();
    none.s.bank.import(camt(WEEKS, { closing: { date: '2026-09-11', amount: 1 } }));
    expect(none.s.bank.balanceCheck(none.s.bank.listAccounts()[0]!.id)).toBeNull();
    expect(balanceTasks(none.s)).toEqual([]);

    const csv = start();
    csv.s.bank.import(knabCsv(WEEKS));
    expect(csv.s.bank.balanceCheck(csv.account.id)).toBeNull();

    const usd = start();
    const parsed = camt(WEEKS, { closing: { date: '2026-09-11', amount: 1, currency: 'USD' } });
    expect(parsed.balances).toEqual([{ ownIban: OWN, date: '2026-09-11', amount: 1, currency: 'USD' }]);
    usd.s.bank.import(parsed);
    expect(usd.db.prepare('SELECT closing_balance FROM import_batch_accounts').all()).toEqual([{ closing_balance: null }]);
    expect(balanceTasks(usd.s)).toEqual([]);
  });

  it('bij het overstappen bevestigd dat de rekening met € 0 begon: dat telt als beginsaldo', () => {
    const { s } = setup();
    const account = s.bank.ensureDefaultAccount(OWN);
    s.bank.import(camt(WEEKS, { closing: { date: '2026-09-11', amount: SUM + 2500 } }));
    expect(balanceTasks(s)).toEqual([]);
    s.settings.update({ switchover: { ...s.settings.get().switchover, mode: 'overstapper', date: '2026-09-01', status: 'klaar', bankConfirmed: [account.id] } });
    expect(balanceTasks(s)).toHaveLength(1);
    // zolang de overstap nog loopt, controleert de overstap-hulp het saldo zelf
    s.settings.update({ switchover: { ...s.settings.get().switchover, status: 'concept' } });
    expect(balanceTasks(s)).toEqual([]);
  });

  it('een overgeslagen regel van precies het verschil is de eerste kandidaat; toevoegen lost het op', () => {
    const { s, account } = start();
    // de CSV miste een lunch; de CAMT heeft er twee en een eindsaldo
    s.bank.import(knabCsv(WEEKS.filter((p) => p.key !== 'lunch2')));
    // de CAMT kent alleen de tweede lunch: die wordt overgeslagen tegen de eerste
    s.bank.import(result('camt', [tx('2026-09-08', -2500, { counterName: 'Bakker Bart', bankId: 'L2' })], { balances: [{ ownIban: OWN, date: '2026-09-11', amount: OPENING + SUM }] }));
    const [task] = balanceTasks(s);
    expect(task!.question).toBe(`Volgens je bank stond er op 11 september 2026 ${formatEuro(189718)}, volgens de app ${formatEuro(192218)}. Bij het inlezen is een betaling van ${formatEuro(2500)} op 8 september 2026 overgeslagen, omdat hij er al leek te staan. Bekijk of dat klopt.`);
    expect(task!.actions.map((a) => a.id)).toEqual(['bekijken', 'open', 'negeren']);
    const check = s.bank.balanceCheck(account.id)!;
    s.bank.addSkipped(check.candidate!.skippedId);
    expect(balanceTasks(s)).toEqual([]);
  });

  it('Dit klopt, negeren: de taak verdwijnt, ook bij een later afschrift met hetzelfde verschil, en komt terug als het verschil verandert', () => {
    const { s, account } = start();
    s.bank.import(camt(WEEKS, { closing: { date: '2026-09-11', amount: OPENING + SUM + 2500 } }));
    expect(balanceTasks(s)).toHaveLength(1);
    s.inbox.ignoreBalance(account.id);
    expect(balanceTasks(s)).toEqual([]);
    const later: Payment = { key: 'later', tx: '2026-09-14', book: '2026-09-14', amount: -1000, name: 'Praxis', iban: null, text: 'schroeven' };
    s.bank.import(camt([later], { closing: { date: '2026-09-14', amount: OPENING + SUM + 2500 - 1000 } }));
    expect(balanceTasks(s), 'zelfde verschil').toEqual([]);
    const more: Payment = { key: 'more', tx: '2026-09-15', book: '2026-09-15', amount: -2000, name: 'Praxis', iban: null, text: 'verf' };
    s.bank.import(camt([more], { closing: { date: '2026-09-15', amount: OPENING + SUM + 2500 - 1000 - 2000 - 700 } }));
    expect(balanceTasks(s).map((t) => t.amount), 'ander verschil').toEqual([1800]);
  });
});
