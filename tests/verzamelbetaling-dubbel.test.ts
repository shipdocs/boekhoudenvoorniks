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
import type { ParseResult } from '../src/import/types';
import { formatEuro } from '../src/shared/money';

/**
 * Een verzamelbetaling (#184) staat in CAMT als losse deelposten en in CSV of MT940 als één regel met het
 * totaal. Dat is hetzelfde geld: het mag maar één keer in de boeken staan. Waar het zeker is, voorkomt het
 * inlezen de dubbeling; waar niet, meldt de app het en lost de gebruiker het met één keuze op.
 */
const OWN = 'NL91ABNA0417164300';
// september 2026: dinsdag 15 september is de dag van de verzamelbetaling (lonen, samen € 600,00)
const PARTS = [{ name: 'Jan', amount: 100 }, { name: 'Piet', amount: 200 }, { name: 'Klaas', amount: 300 }];
const TOTAL = -60000;

const nl = (cents: number) => (Math.abs(cents) / 100).toFixed(2).replace('.', ',');

/** CAMT: een gewone betaling, en de verzamelboeking als drie deelposten (zonder of met eigen id per deelpost). */
function camt(opts: { batchDate?: string; ownRefs?: boolean; closing?: number; batchRef?: string } = {}): ParseResult {
  const date = opts.batchDate ?? '2026-09-15';
  const ref = opts.batchRef ?? 'BATCH-1';
  const subs = PARTS.map((p, i) => `<TxDtls>${opts.ownRefs ? `<Refs><AcctSvcrRef>SUB-${i + 1}</AcctSvcrRef></Refs>` : ''}<Amt Ccy="EUR">${p.amount.toFixed(2)}</Amt>
    <RltdPties><Cdtr><Nm>${p.name}</Nm></Cdtr></RltdPties><RmtInf><Ustrd>loon ${p.name}</Ustrd></RmtInf></TxDtls>`).join('');
  const bal = opts.closing === undefined ? '' : `<Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">${(opts.closing / 100).toFixed(2)}</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-09-18</Dt></Dt></Bal>`;
  return parseCamt053(`<?xml version="1.0" encoding="UTF-8"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt><Id>1</Id><Acct><Id><IBAN>${OWN}</IBAN></Id></Acct>${bal}
    <Ntry><Amt Ccy="EUR">15.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>2026-09-14</Dt></BookgDt><AcctSvcrRef>KPN-1</AcctSvcrRef>
      <NtryDtls><TxDtls><RltdPties><Cdtr><Nm>KPN</Nm></Cdtr></RltdPties><RmtInf><Ustrd>Mobiel</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
    <Ntry><Amt Ccy="EUR">600.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>${date}</Dt></BookgDt><AcctSvcrRef>${ref}</AcctSvcrRef><NtryDtls>${subs}</NtryDtls></Ntry>
    <Ntry><Amt Ccy="EUR">20.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>2026-09-18</Dt></BookgDt><AcctSvcrRef>GAMMA-1</AcctSvcrRef>
      <NtryDtls><TxDtls><RltdPties><Cdtr><Nm>Gamma</Nm></Cdtr></RltdPties><RmtInf><Ustrd>Verf</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
  </Stmt></BkToCstmrStmt></Document>`);
}

/** CSV zoals Knab: dezelfde dagen, de verzamelbetaling als één regel. */
function csv(batchDate = '2026-09-15'): ParseResult {
  const d = (iso: string) => iso.split('-').reverse().join('-');
  const text = ['Rekeningnummer;Transactiedatum;Valutacode;CreditDebet;Bedrag;Tegenrekeningnummer;Tegenrekeninghouder;Omschrijving;Betalingskenmerk',
    `${OWN};${d('2026-09-14')};EUR;D;15,00;;KPN;Mobiel;`,
    `${OWN};${d(batchDate)};EUR;D;600,00;;;Verzamelbetaling 3 posten;`,
    `${OWN};${d('2026-09-18')};EUR;D;20,00;;Gamma;Verf;`].join('\n');
  return parseCsv(text, previewCsv(text).suggestedMapping!);
}

/** MT940: dezelfde dagen, de verzamelbetaling als één regel. */
function mt940(): Promise<ParseResult> {
  const line = (date: string, cents: number, name: string, text: string) => [`:61:${date.slice(2).replaceAll('-', '')}${date.slice(5).replace('-', '')}D${nl(cents)}NTRFNONREF`, `:86:/CNTP///${name}///REMI/USTD//${text}/`];
  const lines = [':20:STARTUMS', `:25:${OWN}`, ':28C:00000', ':60F:C260901EUR1000,00', ...line('2026-09-14', 1500, 'KPN', 'Mobiel'), ...line('2026-09-15', 60000, 'Verzamelbetaling', 'Batch 3 posten'), ...line('2026-09-18', 2000, 'Gamma', 'Verf'), ':62F:C260918EUR365,00', '-', ''];
  return parseMt940(Buffer.from(lines.join('\r\n'), 'utf8'));
}

type S = ReturnType<typeof setup>['s'];
const SUM = -1500 + TOTAL - 2000;

function processAll(s: S): void {
  for (const t of s.bank.list({ status: 'nieuw' })) s.bank.bookToAccount(t.id, { account: 'WBedAutBra', vatCode: 'geen' });
}

/** De stand van de boeken: wat telt mee, wat staat in het grootboek, en elke regel zoals hij is. */
function books(s: S, db: Db) {
  return {
    inBooks: (db.prepare('SELECT COUNT(*) AS n FROM bank_transactions WHERE duplicate_of IS NULL').get() as { n: number }).n,
    sum: s.bank.statementBalance(),
    ledger: s.ledger.balance(ACCOUNTS.bank),
    open: s.bank.countUnprocessed(),
    rows: db.prepare('SELECT id, bank_account_id, transaction_date, amount, counter_iban, counter_name, description, reference, source, import_batch_id, dedup_hash, status, matched_journal_entry_id, duplicate_of FROM bank_transactions ORDER BY id').all(),
    entries: (db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get() as { n: number }).n,
  };
}
const doubleTasks = (s: S) => s.inbox.tasks('2026-10-01').filter((t) => t.kind === 'bank-double');
const balanceTasks = (s: S) => s.inbox.tasks('2026-10-01').filter((t) => t.kind === 'bank-balance');

describe('de CAMT-parser geeft het totaal van de boeking mee', () => {
  it('elke deelpost kent de boeking en haar totaal; een gewone betaling niet', () => {
    const r = camt();
    expect(r.transactions.map((t) => [t.amount, t.bankId, t.batch ?? null])).toEqual([
      [-1500, 'KPN-1', null],
      [-10000, 'BATCH-1', { ref: 'BATCH-1', total: TOTAL }],
      [-20000, 'BATCH-1#2', { ref: 'BATCH-1', total: TOTAL }],
      [-30000, 'BATCH-1#3', { ref: 'BATCH-1', total: TOTAL }],
      [-2000, 'GAMMA-1', null],
    ]);
    expect(camt({ ownRefs: true }).transactions.slice(1, 4).map((t) => [t.bankId, t.batch?.ref])).toEqual([['BATCH-1', 'BATCH-1'], ['SUB-2', 'BATCH-1'], ['SUB-3', 'BATCH-1']]);
  });
});

describe('voorkomen bij het inlezen: het totaal en de deelposten zijn hetzelfde geld', () => {
  for (const [name, line] of [['CSV', async () => csv()], ['MT940', mt940]] as const) {
    it(`eerst ${name} (één regel), dan CAMT (deelposten): de regel blijft, de deelposten komen er niet naast`, async () => {
      const { s, db } = setup();
      const account = s.bank.ensureDefaultAccount(OWN);
      s.bank.setOpeningBalance(account.id, 100000, '2026-09-01');
      expect(s.bank.import(await line())).toMatchObject({ imported: 3 });
      processAll(s);
      const before = books(s, db);
      expect(before).toMatchObject({ inBooks: 3, sum: SUM, ledger: 100000 + SUM, open: 0 });

      const r = s.bank.import(camt({ closing: 100000 + SUM }));
      expect(r).toMatchObject({ imported: 0, duplicates: 5, skipped: 5 });
      expect(books(s, db)).toEqual(before);
      // de drie deelposten staan bij de overgeslagen regels, tegenover de ene regel
      const parts = s.bank.skippedRows({ batchId: r.batchId }).filter((k) => k.batch);
      expect(parts.map((k) => [k.amount, k.batch, k.existing.amount])).toEqual([-30000, -20000, -10000].map((a) => [a, { kind: 'deelpost', parts: 3, total: TOTAL }, TOTAL]));
      expect(s.bank.batchDoubles()).toEqual([]);
      expect(doubleTasks(s)).toEqual([]);
      // het saldo van de bank klopt met de boeken (de ene regel telt één keer, niet per deelpost)
      expect(s.bank.balanceCheck(account.id)).toMatchObject({ difference: 0 });
      // alles nog een keer inlezen: er verandert niets
      expect(s.bank.import(camt({ closing: 100000 + SUM }))).toMatchObject({ imported: 0, duplicates: 5 });
      expect(s.bank.import(await line())).toMatchObject({ imported: 0, duplicates: 3 });
      expect(books(s, db)).toEqual(before);
    });

    it(`eerst CAMT (deelposten), dan ${name} (één regel): de deelposten blijven, de regel komt er niet naast`, async () => {
      const { s, db } = setup();
      const account = s.bank.ensureDefaultAccount(OWN);
      s.bank.setOpeningBalance(account.id, 100000, '2026-09-01');
      expect(s.bank.import(camt({ closing: 100000 + SUM }))).toMatchObject({ imported: 5 });
      processAll(s);
      const before = books(s, db);
      expect(before).toMatchObject({ inBooks: 5, sum: SUM, ledger: 100000 + SUM, open: 0 });

      const r = s.bank.import(await line());
      expect(r).toMatchObject({ imported: 0, duplicates: 3, skipped: 3 });
      expect(books(s, db)).toEqual(before);
      const total = s.bank.skippedRows({ batchId: r.batchId }).find((k) => k.batch)!;
      expect(total).toMatchObject({ amount: TOTAL, batch: { kind: 'totaal', parts: 3, total: TOTAL }, existing: { amount: -10000, counterName: 'Jan' } });
      expect(s.bank.batchDoubles()).toEqual([]);
      expect(s.bank.balanceCheck(account.id)).toMatchObject({ difference: 0 });
      expect(s.bank.import(await line())).toMatchObject({ imported: 0, duplicates: 3, skipped: 0 });
      expect(s.bank.import(camt({ closing: 100000 + SUM }))).toMatchObject({ imported: 0, duplicates: 5 });
      expect(books(s, db)).toEqual(before);
    });
  }

  it('alle drie de soorten na elkaar, in elke volgorde: het bedrag staat er één keer in', async () => {
    const kinds: Record<string, () => ParseResult | Promise<ParseResult>> = { csv: () => csv(), camt: () => camt(), mt940 };
    const orders = [['csv', 'camt', 'mt940'], ['csv', 'mt940', 'camt'], ['camt', 'csv', 'mt940'], ['camt', 'mt940', 'csv'], ['mt940', 'csv', 'camt'], ['mt940', 'camt', 'csv']];
    for (const order of orders) {
      const { s, db } = setup();
      for (const k of order) {
        s.bank.import(await kinds[k]!());
        processAll(s);
      }
      expect(books(s, db), order.join(' → ')).toMatchObject({ sum: SUM, ledger: SUM, open: 0 });
      expect(s.bank.batchDoubles(), order.join(' → ')).toEqual([]);
    }
  });

  it('deelposten met een eigen id van de bank: net zo', () => {
    const { s, db } = setup();
    s.bank.import(csv());
    expect(s.bank.import(camt({ ownRefs: true }))).toMatchObject({ imported: 0, skipped: 5 });
    expect(books(s, db)).toMatchObject({ inBooks: 3, sum: SUM });
  });

  it('Toch toevoegen bij een overgeslagen deelpost voegt alle deelposten toe; dan staat het er dubbel in en meldt de app dat', () => {
    const { s, db } = setup();
    s.bank.import(csv());
    const r = s.bank.import(camt());
    const part = s.bank.skippedRows({ batchId: r.batchId }).find((k) => k.batch)!;
    s.bank.addSkipped(part.id);
    expect(books(s, db)).toMatchObject({ inBooks: 6, sum: SUM + TOTAL });
    expect(s.bank.skippedRows({ batchId: r.batchId }).filter((k) => k.batch).every((k) => k.added)).toBe(true);
    expect(s.bank.batchDoubles()).toHaveLength(1);
    expect(s.bank.importStatus()[0]).toMatchObject({ lastImport: { imported: 3, duplicates: 2 } });
  });

  it('een andere betaling van hetzelfde bedrag wordt geen tegenhanger van de boeking als de echte regel er ook staat', () => {
    const { s, db } = setup();
    // de CSV heeft de verzamelbetaling én, een dag later, een losse betaling van hetzelfde bedrag
    const text = ['Rekeningnummer;Transactiedatum;Valutacode;CreditDebet;Bedrag;Tegenrekeningnummer;Tegenrekeninghouder;Omschrijving;Betalingskenmerk',
      `${OWN};15-09-2026;EUR;D;600,00;;;Verzamelbetaling 3 posten;`, `${OWN};16-09-2026;EUR;D;600,00;;Aannemer;Factuur 12;`, `${OWN};18-09-2026;EUR;D;20,00;;Gamma;Verf;`].join('\n');
    s.bank.import(parseCsv(text, previewCsv(text).suggestedMapping!));
    const r = s.bank.import(camt());
    // de drie deelposten tegenover de regel van 15 september (dichtstbijzijnde datum); de KPN van 14 september is nieuw
    expect(r).toMatchObject({ imported: 1, skipped: 4 });
    expect(db.prepare(`SELECT DISTINCT t.transaction_date AS d FROM import_skipped k JOIN bank_transactions t ON t.id = k.matched_transaction_id WHERE k.batch_ref IS NOT NULL`).all()).toEqual([{ d: '2026-09-15' }]);
    expect(books(s, db)).toMatchObject({ inBooks: 4, sum: -1500 + TOTAL + TOTAL - 2000 });
  });
});

describe('niet zeker: de app waarschuwt en de gebruiker lost het op', () => {
  /** De ene regel staat vier werkdagen na de deelposten: te ver om het bij het inlezen zeker te weten. */
  function double(opts: { processLine?: boolean; processParts?: boolean } = {}) {
    const ctx = setup();
    const account = ctx.s.bank.ensureDefaultAccount(OWN);
    ctx.s.bank.setOpeningBalance(account.id, 100000, '2026-09-01');
    ctx.s.bank.import(camt({ batchDate: '2026-09-09', closing: 100000 + SUM }));
    if (opts.processParts) processAll(ctx.s);
    const r = ctx.s.bank.import(csv('2026-09-15'));
    expect(r).toMatchObject({ imported: 1, skipped: 2, addedInKnownPeriod: 1 });
    const line = ctx.s.bank.list().find((t) => t.amount === TOTAL)!;
    if (opts.processLine) ctx.s.bank.bookToAccount(line.id, { account: 'WBedAutBra', vatCode: 'geen' });
    return { ...ctx, account, line };
  }

  it('de melding op Vandaag en bij Bank: één regel naast de deelposten, met hun som', () => {
    const { s, db, account, line } = double();
    expect(books(s, db)).toMatchObject({ inBooks: 6, sum: SUM + TOTAL });
    const [d] = s.bank.batchDoubles();
    expect(d).toMatchObject({ lineId: line.id, bankAccountId: account.id, total: TOTAL, canRemoveLine: true, canRemoveParts: true, line: { date: '2026-09-15', amount: TOTAL, status: 'nieuw' } });
    expect(d!.parts.map((p) => [p.date, p.amount, p.counterName])).toEqual([['2026-09-09', -10000, 'Jan'], ['2026-09-09', -20000, 'Piet'], ['2026-09-09', -30000, 'Klaas']]);
    expect(d!.parts.reduce((n, p) => n + p.amount, 0)).toBe(d!.line.amount);
    const [task] = doubleTasks(s);
    expect(task!.title).toBe(`Zakelijke rekening: ${formatEuro(60000)} staat er waarschijnlijk twee keer in`);
    expect(task!.question).toBe(`Op 15 september 2026 staat één regel van ${formatEuro(60000)}, en op 9 september 2026 staan 3 deelposten die samen ook ${formatEuro(60000)} zijn. Dat is waarschijnlijk hetzelfde geld, uit twee soorten afschrift. Bekijk ze naast elkaar en haal één kant eruit.`);
    expect(task!.actions.map((a) => a.label)).toEqual(['Bekijken']);
    // het saldo van de bank klopt nu ook niet
    expect(s.bank.balanceCheck(account.id)).toMatchObject({ difference: -TOTAL });
    expect(balanceTasks(s)).toHaveLength(1);
  });

  it('de ene regel eruit: hij telt niet meer mee, blijft bewaard, en het saldo klopt weer', () => {
    const { s, db, account, line } = double();
    const [d] = s.bank.batchDoubles();
    const before = books(s, db);
    s.bank.resolveDouble(d!.lineId, d!.firstPartId, 'regel');
    expect(books(s, db)).toMatchObject({ inBooks: 5, sum: SUM, entries: before.entries });
    // alleen de ene regel is veranderd: genegeerd, met de betaling die bleef erbij
    expect(books(s, db).rows.filter((r, i) => JSON.stringify(r) !== JSON.stringify(before.rows[i]))).toEqual([expect.objectContaining({ id: line.id, status: 'genegeerd', duplicate_of: d!.firstPartId, amount: TOTAL })]);
    expect(s.bank.batchDoubles()).toEqual([]);
    expect(doubleTasks(s)).toEqual([]);
    expect(s.bank.balanceCheck(account.id)).toMatchObject({ difference: 0 });
    expect(balanceTasks(s)).toEqual([]);
    expect(s.bank.removedDuplicates(account.id)).toMatchObject([{ id: line.id, amount: TOTAL, kept: { id: d!.firstPartId, counterName: 'Jan' } }]);
    expect(s.bank.importStatus()[0]).toMatchObject({ skipped: 3 });
    // niet te verwerken zolang hij eruit is
    expect(() => s.bank.bookToAccount(line.id, { account: 'WBedAutBra' })).toThrow('uit je boekhouding gehaald');
    // opnieuw inlezen van beide afschriften brengt hem niet terug
    expect(s.bank.import(csv('2026-09-15'))).toMatchObject({ imported: 0 });
    expect(s.bank.import(camt({ batchDate: '2026-09-09', closing: 100000 + SUM }))).toMatchObject({ imported: 0 });
    expect(books(s, db)).toMatchObject({ inBooks: 5, sum: SUM });
    expect(s.bank.batchDoubles()).toEqual([]);
  });

  it('de deelposten eruit: de ene regel blijft; terugzetten brengt ze samen terug en de app meldt het niet opnieuw', () => {
    const { s, db, account, line } = double();
    const [d] = s.bank.batchDoubles();
    s.bank.resolveDouble(d!.lineId, d!.firstPartId, 'deelposten');
    expect(books(s, db)).toMatchObject({ inBooks: 3, sum: SUM });
    expect(db.prepare('SELECT status, duplicate_of FROM bank_transactions WHERE batch_ref IS NOT NULL').all()).toEqual(Array(3).fill({ status: 'genegeerd', duplicate_of: line.id }));
    expect(s.bank.balanceCheck(account.id)).toMatchObject({ difference: 0 });
    expect(s.bank.removedDuplicates(account.id)).toHaveLength(3);
    // "Ongedaan maken" op één deelpost zet alle drie terug: het waren dan toch twee betalingen
    s.bank.unmatch(d!.parts[1]!.id);
    expect(books(s, db)).toMatchObject({ inBooks: 6, sum: SUM + TOTAL, open: 6 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM bank_transactions WHERE duplicate_of IS NOT NULL').get()).toEqual({ n: 0 });
    expect(s.bank.batchDoubles()).toEqual([]);
    expect(() => s.bank.restoreDuplicate(line.id)).toThrow('niet als dubbel');
  });

  it('wat al verwerkt is, haalt de app er niet uit: de andere kant kiezen, of eerst ongedaan maken', () => {
    const { s, db, line } = double({ processLine: true });
    const [d] = s.bank.batchDoubles();
    expect(d).toMatchObject({ canRemoveLine: false, canRemoveParts: true, line: { status: 'gematcht' } });
    const before = books(s, db);
    expect(() => s.bank.resolveDouble(d!.lineId, d!.firstPartId, 'regel')).toThrow('De ene regel is al verwerkt. Maak die verwerking eerst ongedaan (open de betaling en kies "Ongedaan maken"), of haal de deelposten eruit.');
    expect(books(s, db)).toEqual(before);
    s.bank.resolveDouble(d!.lineId, d!.firstPartId, 'deelposten');
    // de geboekte regel en het grootboek zijn niet aangeraakt
    expect(books(s, db)).toMatchObject({ inBooks: 3, sum: SUM, ledger: before.ledger, entries: before.entries });
    expect(s.bank.get(line.id)).toMatchObject({ status: 'gematcht', duplicate_of: null });
  });

  it('beide kanten verwerkt: niets gaat eruit tot de gebruiker één verwerking ongedaan maakt', () => {
    const { s, db, line } = double({ processLine: true, processParts: true });
    const [d] = s.bank.batchDoubles();
    expect(d).toMatchObject({ canRemoveLine: false, canRemoveParts: false });
    const before = books(s, db);
    expect(() => s.bank.resolveDouble(d!.lineId, d!.firstPartId, 'regel')).toThrow('al verwerkt');
    expect(() => s.bank.resolveDouble(d!.lineId, d!.firstPartId, 'deelposten')).toThrow('Een of meer deelposten zijn al verwerkt. Maak die verwerking eerst ongedaan (open de betaling en kies "Ongedaan maken"), of haal de ene regel eruit.');
    expect(books(s, db)).toEqual(before);
    expect(doubleTasks(s)).toHaveLength(1);
    // de gebruiker maakt de verwerking van de ene regel ongedaan (tegenboeking), daarna kan hij eruit
    s.bank.unmatch(line.id, '2026-09-20');
    s.bank.resolveDouble(d!.lineId, d!.firstPartId, 'regel');
    expect(books(s, db)).toMatchObject({ inBooks: 5, sum: SUM, ledger: 100000 + SUM });
    expect(s.ledger.checkIntegrity().balanced).toBe(true);
  });

  it('"het zijn twee verschillende betalingen": de melding komt niet terug, er verandert niets', () => {
    const { s, db } = double();
    const [d] = s.bank.batchDoubles();
    const before = books(s, db);
    s.bank.dismissDouble(d!.lineId, d!.firstPartId);
    expect(s.bank.batchDoubles()).toEqual([]);
    expect(doubleTasks(s)).toEqual([]);
    expect(books(s, db)).toEqual(before);
    s.bank.import(csv('2026-09-15'));
    expect(s.bank.batchDoubles()).toEqual([]);
    expect(() => s.bank.resolveDouble(d!.lineId, d!.firstPartId, 'regel')).toThrow('niet (meer) dubbel');
  });

  it('wat geen dubbel is, wordt niet gemeld: te ver uit elkaar, zelfde bron, of geen complete boeking', () => {
    // zes werkdagen ertussen
    const far = setup();
    far.s.bank.import(camt({ batchDate: '2026-09-07' }));
    far.s.bank.import(csv('2026-09-15'));
    expect(far.s.bank.batchDoubles()).toEqual([]);
    // twee CAMT-afschriften: een boeking van € 600 in deelposten en een losse betaling van € 600
    const same = setup();
    same.s.bank.import(camt());
    same.s.bank.import({ source: 'camt', warnings: [], transactions: [{ date: '2026-09-16', amount: TOTAL, description: 'Aannemer', ownIban: OWN, bankId: 'LOS-1' }] });
    expect(same.s.bank.batchDoubles()).toEqual([]);
    expect(same.s.bank.list()).toHaveLength(6);
    // een boeking waarvan niet alle deelposten in de boeken staan
    const part = setup();
    part.s.bank.import(camt({ batchDate: '2026-09-09' }));
    part.db.exec(`DELETE FROM bank_transactions WHERE bank_id = 'BATCH-1#3'`);
    part.s.bank.import(csv('2026-09-15'));
    expect(part.s.bank.batchDoubles()).toEqual([]);
  });
});

describe('administratie waar het bedrag al dubbel in staat (ingelezen vóór deze versie)', () => {
  /** Zoals de vorige versie het wegschreef: geen batch_ref, de deelposten herkenbaar aan REF, REF#2, REF#3. */
  function oldAdministration(opts: { ownRefs?: boolean } = {}): { db: Db; accountId: number } {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    const index = migrations.findIndex((m) => m.includes('ADD COLUMN batch_ref'));
    expect(index).toBeGreaterThan(0);
    for (const m of migrations.slice(0, index)) db.exec(m);
    db.pragma(`user_version = ${index}`);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('bank_transactions') WHERE name IN ('batch_ref', 'duplicate_of')`).get()).toEqual({ n: 0 });
    new Ledger(db).seedDefaultAccounts();
    const ledgerAccount = db.prepare('SELECT id FROM chart_of_accounts WHERE rgs_code = ?').get(ACCOUNTS.bank) as { id: number };
    const accountId = Number(db.prepare('INSERT INTO bank_accounts (name, iban, account_id) VALUES (?, ?, ?)').run('Zakelijke rekening', OWN, ledgerAccount.id).lastInsertRowid);
    const write = (r: ParseResult, filename: string) => {
      const kind = r.layout ? `${r.source}:${r.layout}` : r.source;
      const batchId = Number(db.prepare('INSERT INTO import_batches (filename, source, kind) VALUES (?, ?, ?)').run(filename, r.source, kind).lastInsertRowid);
      const insert = db.prepare(`INSERT INTO bank_transactions (bank_account_id, transaction_date, amount, counter_iban, counter_name, description, reference, source, import_batch_id, dedup_hash, bank_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const t of r.transactions) insert.run(accountId, t.date, t.amount, t.counterIban ?? null, t.counterName ?? null, t.description, t.reference ?? null, r.source, batchId, BankService.hash(t, OWN, 1), t.bankId ?? null);
      const dates = r.transactions.map((t) => t.date).sort();
      db.prepare('INSERT INTO import_batch_accounts (batch_id, bank_account_id, period_from, period_to, transactions, imported, duplicates) VALUES (?, ?, ?, ?, ?, ?, 0)').run(batchId, accountId, dates[0], dates.at(-1), r.transactions.length, r.transactions.length);
    };
    // de vorige versie las allebei in: de CSV met de ene regel, en de CAMT met de drie deelposten ernaast
    write({ ...csv(), transactions: csv().transactions.filter((t) => t.amount === TOTAL) }, 'afschrift.csv');
    write(camt({ ownRefs: opts.ownRefs }), 'afschrift.xml');
    return { db, accountId };
  }

  it('de migratie herkent de deelposten en verandert verder niets; de app meldt het dubbele bedrag', () => {
    const { db, accountId } = oldAdministration();
    const columns = 'id, bank_account_id, transaction_date, amount, counter_iban, counter_name, description, reference, source, import_batch_id, dedup_hash, bank_id, status, matched_journal_entry_id';
    const before = db.prepare(`SELECT ${columns} FROM bank_transactions ORDER BY id`).all();
    expect(before).toHaveLength(6);
    migrate(db);
    expect(db.pragma('user_version', { simple: true })).toBe(migrations.length);
    expect(db.prepare(`SELECT ${columns} FROM bank_transactions ORDER BY id`).all()).toEqual(before);
    expect(db.prepare('SELECT bank_id, batch_ref, batch_total, duplicate_of FROM bank_transactions ORDER BY id').all()).toEqual([
      { bank_id: null, batch_ref: null, batch_total: null, duplicate_of: null },
      { bank_id: 'KPN-1', batch_ref: null, batch_total: null, duplicate_of: null },
      { bank_id: 'BATCH-1', batch_ref: 'BATCH-1', batch_total: TOTAL, duplicate_of: null },
      { bank_id: 'BATCH-1#2', batch_ref: 'BATCH-1', batch_total: TOTAL, duplicate_of: null },
      { bank_id: 'BATCH-1#3', batch_ref: 'BATCH-1', batch_total: TOTAL, duplicate_of: null },
      { bank_id: 'GAMMA-1', batch_ref: null, batch_total: null, duplicate_of: null },
    ]);
    const { s } = setup({ db });
    s.settings.update({ onboardingDone: true });
    expect(s.bank.statementBalance()).toBe(SUM + TOTAL);
    const [d] = s.bank.batchDoubles();
    expect(d).toMatchObject({ bankAccountId: accountId, total: TOTAL, line: { filename: 'afschrift.csv' }, canRemoveLine: true });
    expect(doubleTasks(s)).toHaveLength(1);
    s.bank.resolveDouble(d!.lineId, d!.firstPartId, 'regel');
    expect(s.bank.statementBalance()).toBe(SUM);
    expect(doubleTasks(s)).toEqual([]);
    // en de afschriften nog een keer inlezen geeft niets dubbel
    expect(s.bank.import(camt())).toMatchObject({ imported: 0, duplicates: 5 });
    expect(s.bank.import(csv())).toMatchObject({ imported: 0 });
    expect(s.bank.statementBalance()).toBe(SUM);
  });

  it('deelposten met een eigen id van de bank herkent de app zodra dat afschrift opnieuw wordt ingelezen', () => {
    const { db } = oldAdministration({ ownRefs: true });
    migrate(db);
    const { s } = setup({ db });
    // aan BATCH-1, SUB-2 en SUB-3 is niet te zien dat ze bij elkaar horen
    expect(db.prepare('SELECT COUNT(*) AS n FROM bank_transactions WHERE batch_ref IS NOT NULL').get()).toEqual({ n: 0 });
    expect(s.bank.batchDoubles()).toEqual([]);
    expect(s.bank.import(camt({ ownRefs: true }))).toMatchObject({ imported: 0, duplicates: 5 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM bank_transactions WHERE batch_ref IS NOT NULL').get()).toEqual({ n: 3 });
    expect(s.bank.batchDoubles()).toHaveLength(1);
  });

  it('een id die toevallig op #2 eindigt zonder boeking erbij is geen deelpost', () => {
    const db = new Database(':memory:');
    const index = migrations.findIndex((m) => m.includes('ADD COLUMN batch_ref'));
    for (const m of migrations.slice(0, index)) db.exec(m);
    db.pragma(`user_version = ${index}`);
    new Ledger(db).seedDefaultAccounts();
    const ledgerAccount = db.prepare('SELECT id FROM chart_of_accounts WHERE rgs_code = ?').get(ACCOUNTS.bank) as { id: number };
    db.prepare('INSERT INTO bank_accounts (id, name, iban, account_id) VALUES (1, ?, ?, ?)').run('Zakelijk', OWN, ledgerAccount.id);
    db.exec(`INSERT INTO import_batches (id, source, kind) VALUES (1, 'camt', 'camt');
      INSERT INTO bank_transactions (bank_account_id, transaction_date, amount, source, import_batch_id, dedup_hash, bank_id) VALUES
        (1, '2026-09-15', -100, 'camt', 1, 'a', 'ORDER#2'), (1, '2026-09-15', -200, 'camt', 1, 'b', 'ORDER#7'), (1, '2026-09-15', -300, 'camt', 1, 'c', 'LOS');`);
    migrate(db);
    expect(db.prepare('SELECT COUNT(*) AS n FROM bank_transactions WHERE batch_ref IS NOT NULL').get()).toEqual({ n: 0 });
  });
});
