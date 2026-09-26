import type { Db } from '../db/database';
import { tx } from '../db/database';
import { assertCents, type Cents } from '../shared/money';
import { addDays, assertIsoDate, type IsoDate } from '../shared/dates';
import { DEFAULT_ACCOUNTS, type AccountCategory } from './accounts';
import { RULES_VERSION } from './rules-version';
import rgsTaxonomy from './rgs-codes.json';

/** Officiële RGS-codes (taxonomie-release in rgs-codes.json). */
export const RGS_VERSION: string = rgsTaxonomy.version;
export function rgsLabel(code: string): string | undefined {
  return (rgsTaxonomy.codes as Record<string, string>)[code];
}

export type EntrySource = 'factuur' | 'inkoop' | 'bank' | 'handmatig' | 'btw' | 'opening' | 'integratie';

export interface PostLine {
  /** RGS-code van de grootboekrekening */
  account: string;
  debit?: Cents;
  credit?: Cents;
  relationId?: number | null;
  vatCode?: string | null;
  description?: string | null;
}

export interface PostEntry {
  date: IsoDate;
  description: string;
  source: EntrySource;
  sourceRef?: string | null;
  lines: PostLine[];
  /** Alleen intern gebruikt door reverse(). */
  reversesEntryId?: number | null;
  /** De gebeurtenis waar deze post uit volgt (#19). Zonder: er wordt een gebeurtenis "boeking" vastgelegd. */
  eventId?: number | null;
}

export interface Account {
  id: number;
  /** interne sleutel */
  rgs_code: string;
  /** officiële RGS-referentiecode */
  rgs_ref: string | null;
  code: string;
  name: string;
  category: AccountCategory;
  vat_code: string | null;
  is_system: number;
  archived: number;
}

export interface JournalLine {
  id: number;
  journal_entry_id: number;
  account_id: number;
  rgs_code: string;
  account_code: string;
  account_name: string;
  debit: Cents;
  credit: Cents;
  relation_id: number | null;
  vat_code: string | null;
  description: string | null;
}

export interface JournalEntry {
  id: number;
  entry_date: IsoDate;
  description: string;
  source: EntrySource;
  source_ref: string | null;
  status: 'definitief' | 'teruggedraaid';
  reverses_entry_id: number | null;
  vat_date: IsoDate | null;
  vat_correction_of: string | null;
  event_id: number | null;
  rules_version: string | null;
  created_at: string;
  lines: JournalLine[];
}

export interface AccountBalance {
  account_id: number;
  rgs_code: string;
  rgs_ref: string | null;
  code: string;
  name: string;
  category: AccountCategory;
  vat_code: string | null;
  debit: Cents;
  credit: Cents;
  /** debet − credit */
  balance: Cents;
}

export interface DateRange {
  from?: IsoDate;
  to?: IsoDate;
}

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerError';
  }
}

/**
 * core-ledger: de dubbele boekhouding. Alles wat geld raakt gaat via post().
 * Invarianten (afgedwongen hier én deels in de database):
 *  - elke journaalpost heeft ≥ 2 regels en debet = credit
 *  - bedragen zijn positieve gehele centen; een regel is óf debet óf credit
 *  - journaalposten zijn onveranderlijk; corrigeren = reverse()
 *  - een post in een al aangegeven BTW-periode krijgt een btw-datum in de eerstvolgende open periode
 */
export class Ledger {
  constructor(private readonly db: Db) {}

  seedDefaultAccounts(): void {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO chart_of_accounts (rgs_code, rgs_ref, code, name, category, vat_code, is_system)
       VALUES (@rgs, @ref, @code, @name, @category, @vatCode, @system)`,
    );
    const fillRef = this.db.prepare('UPDATE chart_of_accounts SET rgs_ref = ? WHERE rgs_code = ? AND rgs_ref IS NULL');
    tx(this.db, () => {
      for (const a of DEFAULT_ACCOUNTS) {
        insert.run({ rgs: a.rgs, ref: a.ref, code: a.code, name: a.name, category: a.category, vatCode: a.vatCode ?? null, system: a.system ? 1 : 0 });
        fillRef.run(a.ref, a.rgs);
      }
    });
  }

  listAccounts(includeArchived = false): Account[] {
    return this.db
      .prepare(`SELECT * FROM chart_of_accounts ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY code`)
      .all() as Account[];
  }

  getAccount(rgsCode: string): Account {
    const account = this.db.prepare('SELECT * FROM chart_of_accounts WHERE rgs_code = ?').get(rgsCode) as Account | undefined;
    if (!account) throw new LedgerError(`Onbekende grootboekrekening: ${rgsCode}`);
    return account;
  }

  getAccountById(id: number): Account {
    const account = this.db.prepare('SELECT * FROM chart_of_accounts WHERE id = ?').get(id) as Account | undefined;
    if (!account) throw new LedgerError(`Onbekende grootboekrekening id: ${id}`);
    return account;
  }

  createAccount(input: { code: string; rgs: string; rgsRef?: string | null; name: string; category: AccountCategory; vatCode?: string | null }): Account {
    if (!/^\d{3,6}$/.test(input.code)) throw new LedgerError('Rekeningnummer moet 3 tot 6 cijfers zijn');
    if (!input.name.trim()) throw new LedgerError('Naam is verplicht');
    if (input.rgsRef && !rgsLabel(input.rgsRef)) throw new LedgerError(`${input.rgsRef} is geen officiële RGS-code (release ${RGS_VERSION})`);
    this.db
      .prepare('INSERT INTO chart_of_accounts (rgs_code, rgs_ref, code, name, category, vat_code) VALUES (?, ?, ?, ?, ?, ?)')
      .run(input.rgs, input.rgsRef ?? null, input.code, input.name.trim(), input.category, input.vatCode ?? null);
    return this.getAccount(input.rgs);
  }

  setRgsRef(id: number, rgsRef: string | null): void {
    if (rgsRef && !rgsLabel(rgsRef)) throw new LedgerError(`${rgsRef} is geen officiële RGS-code (release ${RGS_VERSION})`);
    this.db.prepare('UPDATE chart_of_accounts SET rgs_ref = ? WHERE id = ?').run(rgsRef, id);
  }

  renameAccount(id: number, name: string): void {
    if (!name.trim()) throw new LedgerError('Naam is verplicht');
    this.db.prepare('UPDATE chart_of_accounts SET name = ? WHERE id = ?').run(name.trim(), id);
  }

  archiveAccount(id: number): void {
    const account = this.getAccountById(id);
    if (account.is_system) throw new LedgerError('Systeemrekeningen kunnen niet gearchiveerd worden');
    this.db.prepare('UPDATE chart_of_accounts SET archived = 1 WHERE id = ?').run(id);
  }

  /** De ingediende btw-periode waar deze datum in valt, of null. */
  lockedPeriodFor(date: IsoDate): { period_key: string; end_date: string } | null {
    return (this.db
      .prepare(`SELECT period_key, end_date FROM vat_periods WHERE status = 'ingediend' AND ? BETWEEN start_date AND end_date LIMIT 1`)
      .get(date) as { period_key: string; end_date: string } | undefined) ?? null;
  }

  /**
   * Btw-datum van een post: de eigen datum, of — als die periode al is aangegeven — de eerste dag
   * van de eerstvolgende open periode. Het document behoudt zijn echte datum (#27).
   */
  vatDateFor(date: IsoDate): { vatDate: IsoDate; correctionOf: string | null } {
    const first = this.lockedPeriodFor(date);
    if (!first) return { vatDate: date, correctionOf: null };
    let d = date;
    let locked: { end_date: string } | null = first;
    while (locked) {
      d = addDays(locked.end_date, 1);
      locked = this.lockedPeriodFor(d);
    }
    return { vatDate: d, correctionOf: first.period_key };
  }

  isDateLocked(date: IsoDate): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM vat_periods WHERE status = 'ingediend' AND ? BETWEEN start_date AND end_date LIMIT 1`)
      .get(date);
    return row !== undefined;
  }

  /** Valideert een journaalpost zonder hem op te slaan. Gooit LedgerError bij fouten. */
  validate(entry: PostEntry): void {
    assertIsoDate(entry.date);
    if (!entry.description?.trim()) throw new LedgerError('Omschrijving is verplicht');
    if (entry.lines.length < 2) throw new LedgerError('Een journaalpost heeft minimaal twee regels');
    let debit = 0;
    let credit = 0;
    for (const [i, line] of entry.lines.entries()) {
      const d = line.debit ?? 0;
      const c = line.credit ?? 0;
      assertCents(d, `debet regel ${i + 1}`);
      assertCents(c, `credit regel ${i + 1}`);
      if (d < 0 || c < 0) throw new LedgerError(`Regel ${i + 1}: bedragen mogen niet negatief zijn`);
      if (d > 0 && c > 0) throw new LedgerError(`Regel ${i + 1}: een regel is óf debet óf credit`);
      if (d === 0 && c === 0) throw new LedgerError(`Regel ${i + 1}: bedrag is nul`);
      debit += d;
      credit += c;
    }
    if (debit !== credit) {
      throw new LedgerError(`Journaalpost is niet in balans: debet ${debit} ≠ credit ${credit}`);
    }
  }

  post(entry: PostEntry): number {
    this.validate(entry);
    return tx(this.db, () => {
      // Een al aangegeven btw-periode verandert nooit: het btw-effect gaat naar de volgende open periode.
      let { vatDate, correctionOf } = entry.source === 'btw' ? { vatDate: entry.date, correctionOf: null as string | null } : this.vatDateFor(entry.date);
      if (entry.reversesEntryId && entry.source !== 'btw') {
        // Een tegenboeking hoort bij dezelfde correctie als het origineel, anders blijft die correctie openstaan.
        const original = this.db.prepare('SELECT vat_correction_of FROM journal_entries WHERE id = ?').get(entry.reversesEntryId) as { vat_correction_of: string | null } | undefined;
        if (original?.vat_correction_of) correctionOf = original.vat_correction_of;
      }
      const accountIds = entry.lines.map((l) => {
        const account = this.getAccount(l.account);
        if (account.archived) throw new LedgerError(`Rekening ${account.code} ${account.name} is gearchiveerd`);
        return account.id;
      });
      // Elke post volgt uit precies één gebeurtenis (#19); een tegenboeking hoort bij die van het origineel.
      let eventId = entry.eventId ?? null;
      let rulesVersion = RULES_VERSION;
      if (!eventId && entry.reversesEntryId) {
        // een tegenboeking is geen nieuwe compilatie: zelfde gebeurtenis én zelfde regelversie als het origineel
        const original = this.db.prepare('SELECT event_id, rules_version FROM journal_entries WHERE id = ?').get(entry.reversesEntryId) as { event_id: number | null; rules_version: string | null } | undefined;
        eventId = original?.event_id ?? null;
        rulesVersion = original?.rules_version ?? RULES_VERSION;
      }
      if (!eventId) {
        const { reversesEntryId: _r, eventId: _e, ...payload } = entry;
        eventId = Number(
          this.db
            .prepare(`INSERT INTO events (type, event_date, payload, rules_version) VALUES ('boeking', ?, ?, ?)`)
            .run(entry.date, JSON.stringify(payload), RULES_VERSION).lastInsertRowid,
        );
        if (entry.sourceRef) {
          const [kind, ref] = entry.sourceRef.split(':');
          const known: Record<string, string> = { invoice: 'factuur', purchase: 'inkoop', bank: 'bank' };
          this.db
            .prepare('INSERT INTO event_evidence (event_id, kind, ref_id, note) VALUES (?, ?, ?, ?)')
            .run(eventId, known[kind ?? ''] ?? 'bron', known[kind ?? ''] ? Number(ref) : null, entry.sourceRef);
        }
      }
      const result = this.db
        .prepare('INSERT INTO journal_entries (entry_date, description, source, source_ref, reverses_entry_id, vat_date, vat_correction_of, event_id, rules_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(entry.date, entry.description.trim(), entry.source, entry.sourceRef ?? null, entry.reversesEntryId ?? null, vatDate, correctionOf, eventId, rulesVersion);
      const entryId = Number(result.lastInsertRowid);
      const insertLine = this.db.prepare(
        `INSERT INTO journal_lines (journal_entry_id, account_id, debit, credit, relation_id, vat_code, description)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      entry.lines.forEach((line, i) => {
        insertLine.run(entryId, accountIds[i], line.debit ?? 0, line.credit ?? 0, line.relationId ?? null, line.vatCode ?? null, line.description ?? null);
      });
      return entryId;
    });
  }

  /**
   * Draait een journaalpost terug met een spiegelboeking (debet ↔ credit).
   * De oorspronkelijke post blijft bestaan (audit trail) maar krijgt status 'teruggedraaid'.
   */
  reverse(entryId: number, date: IsoDate, description?: string): number {
    return tx(this.db, () => {
      const original = this.getEntry(entryId);
      if (original.status === 'teruggedraaid') throw new LedgerError('Deze journaalpost is al teruggedraaid');
      if (original.reverses_entry_id) throw new LedgerError('Een tegenboeking kan niet zelf teruggedraaid worden');
      const reversalId = this.post({
        date,
        description: description ?? `Tegenboeking: ${original.description}`,
        source: original.source,
        sourceRef: original.source_ref,
        lines: original.lines.map((l) => ({
          account: l.rgs_code,
          debit: l.credit,
          credit: l.debit,
          relationId: l.relation_id,
          vatCode: l.vat_code,
          description: l.description,
        })),
        reversesEntryId: entryId,
      });
      this.db.prepare(`UPDATE journal_entries SET status = 'teruggedraaid' WHERE id = ?`).run(entryId);
      return reversalId;
    });
  }

  getEntry(id: number): JournalEntry {
    const entry = this.db.prepare('SELECT * FROM journal_entries WHERE id = ?').get(id) as Omit<JournalEntry, 'lines'> | undefined;
    if (!entry) throw new LedgerError(`Journaalpost ${id} bestaat niet`);
    return { ...entry, lines: this.linesFor([id]).get(id) ?? [] };
  }

  listEntries(filter: DateRange & { source?: EntrySource; accountRgs?: string; limit?: number; offset?: number } = {}): JournalEntry[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.from) (where.push('e.entry_date >= ?'), params.push(filter.from));
    if (filter.to) (where.push('e.entry_date <= ?'), params.push(filter.to));
    if (filter.source) (where.push('e.source = ?'), params.push(filter.source));
    if (filter.accountRgs) {
      where.push('EXISTS (SELECT 1 FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id WHERE l.journal_entry_id = e.id AND a.rgs_code = ?)');
      params.push(filter.accountRgs);
    }
    const sql = `SELECT e.* FROM journal_entries e ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY e.entry_date DESC, e.id DESC LIMIT ? OFFSET ?`;
    params.push(filter.limit ?? 200, filter.offset ?? 0);
    const entries = this.db.prepare(sql).all(...params) as Omit<JournalEntry, 'lines'>[];
    const lines = this.linesFor(entries.map((e) => e.id));
    return entries.map((e) => ({ ...e, lines: lines.get(e.id) ?? [] }));
  }

  private linesFor(entryIds: number[]): Map<number, JournalLine[]> {
    const map = new Map<number, JournalLine[]>();
    if (entryIds.length === 0) return map;
    const rows = this.db
      .prepare(
        `SELECT l.*, a.rgs_code, a.code AS account_code, a.name AS account_name
         FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id
         WHERE l.journal_entry_id IN (${entryIds.map(() => '?').join(',')}) ORDER BY l.id`,
      )
      .all(...entryIds) as JournalLine[];
    for (const row of rows) {
      const list = map.get(row.journal_entry_id) ?? [];
      list.push(row);
      map.set(row.journal_entry_id, list);
    }
    return map;
  }

  /** Saldo (debet − credit) van één rekening binnen een periode. */
  balance(rgsCode: string, range: DateRange = {}): Cents {
    const account = this.getAccount(rgsCode);
    const { where, params } = rangeClause(range);
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(l.debit), 0) - COALESCE(SUM(l.credit), 0) AS balance
         FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
         WHERE l.account_id = ? ${where}`,
      )
      .get(account.id, ...params) as { balance: number };
    return row.balance;
  }

  /** Saldi van alle rekeningen (proef- en saldibalans). */
  balances(range: DateRange = {}): AccountBalance[] {
    const { where, params } = rangeClause(range);
    return this.db
      .prepare(
        `SELECT a.id AS account_id, a.rgs_code, a.rgs_ref, a.code, a.name, a.category, a.vat_code,
                COALESCE(SUM(x.debit), 0) AS debit, COALESCE(SUM(x.credit), 0) AS credit,
                COALESCE(SUM(x.debit), 0) - COALESCE(SUM(x.credit), 0) AS balance
         FROM chart_of_accounts a
         LEFT JOIN (
           SELECT l.account_id, l.debit, l.credit FROM journal_lines l
           JOIN journal_entries e ON e.id = l.journal_entry_id WHERE 1 = 1 ${where}
         ) x ON x.account_id = a.id
         GROUP BY a.id ORDER BY a.code`,
      )
      .all(...params) as AccountBalance[];
  }

  /** Controle: alle boekingen samen moeten op nul uitkomen. */
  checkIntegrity(): { balanced: boolean; totalDebit: Cents; totalCredit: Cents; unbalancedEntries: number[] } {
    const totals = this.db.prepare('SELECT COALESCE(SUM(debit),0) AS d, COALESCE(SUM(credit),0) AS c FROM journal_lines').get() as { d: number; c: number };
    const unbalanced = this.db
      .prepare('SELECT journal_entry_id AS id FROM journal_lines GROUP BY journal_entry_id HAVING SUM(debit) <> SUM(credit)')
      .all() as { id: number }[];
    return {
      balanced: totals.d === totals.c && unbalanced.length === 0,
      totalDebit: totals.d,
      totalCredit: totals.c,
      unbalancedEntries: unbalanced.map((r) => r.id),
    };
  }
}

function rangeClause(range: DateRange): { where: string; params: string[] } {
  const parts: string[] = [];
  const params: string[] = [];
  if (range.from) (parts.push('e.entry_date >= ?'), params.push(range.from));
  if (range.to) (parts.push('e.entry_date <= ?'), params.push(range.to));
  return { where: parts.length ? 'AND ' + parts.join(' AND ') : '', params };
}

/** Hulpfunctie: zet een getekend bedrag om naar een debet- of creditregel. */
export function signedLine(account: string, amount: Cents, extra: Omit<PostLine, 'account' | 'debit' | 'credit'> = {}): PostLine | null {
  if (amount === 0) return null;
  return amount > 0 ? { account, debit: amount, ...extra } : { account, credit: -amount, ...extra };
}
