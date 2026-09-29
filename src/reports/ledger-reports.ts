import type { Db } from '../db/database';
import { ACCOUNTS } from '../core-ledger/accounts';
import type { Cents } from '../shared/money';
import type { IsoDate } from '../shared/dates';

/** Rapporten uit het grootboek voor de boekhouder: kolommenbalans, kaarten en periodebalans. */

export interface TrialBalanceRow {
  accountId: number;
  code: string;
  rgs: string;
  rgsRef: string | null;
  name: string;
  /** 'balans' (activa, passiva, btw) of 'resultaat' (omzet, kosten) */
  kind: 'balans' | 'resultaat';
  category: string;
  /** stand vóór de periode (debet − credit); alleen balansrekeningen hebben een beginbalans */
  opening: Cents;
  debit: Cents;
  credit: Cents;
  /** stand aan het eind: beginbalans + debet − credit */
  closing: Cents;
}

export interface TrialBalance {
  from: IsoDate;
  to: IsoDate;
  rows: TrialBalanceRow[];
  totals: { opening: Cents; debit: Cents; credit: Cents; closing: Cents };
  /** debet en credit zijn gelijk: de boekhouding klopt */
  balanced: boolean;
}

export interface CardLine {
  entryId: number;
  date: IsoDate;
  description: string;
  source: string;
  status: string;
  reversal: boolean;
  debit: Cents;
  credit: Cents;
  /** saldo na deze regel (debet − credit, oplopend) */
  balance: Cents;
  counterparty: string | null;
  invoiceId: number | null;
  purchaseId: number | null;
  bankTransactionId: number | null;
}

export interface LedgerCard {
  accountId: number;
  code: string;
  name: string;
  kind: 'balans' | 'resultaat';
  opening: Cents;
  lines: CardLine[];
  debit: Cents;
  credit: Cents;
  closing: Cents;
}

export interface RelationSummary {
  relationId: number;
  name: string;
  type: string;
  /** wat de klant nog moet betalen (positief) of wat je de leverancier nog schuldig bent (negatief) */
  receivable: Cents;
  payable: Cents;
  balance: Cents;
  entries: number;
}

export interface RelationCard {
  relation: RelationSummary;
  opening: Cents;
  lines: (CardLine & { account: string })[];
}

export interface PeriodBalance {
  year: number;
  granularity: 'maand' | 'kwartaal';
  labels: string[];
  rows: { accountId: number; code: string; name: string; kind: 'balans' | 'resultaat'; opening: Cents; periods: Cents[]; closing: Cents }[];
}

const kindOf = (category: string): 'balans' | 'resultaat' => (category === 'omzet' || category === 'kosten' ? 'resultaat' : 'balans');

export class LedgerReports {
  constructor(private readonly db: Db) {}

  trialBalance(from: IsoDate, to: IsoDate): TrialBalance {
    const rows = this.db
      .prepare(
        `SELECT a.id AS accountId, a.code, a.rgs_code AS rgs, a.rgs_ref AS rgsRef, a.name, a.category,
                COALESCE(SUM(CASE WHEN e.entry_date < ? THEN l.debit - l.credit END), 0) AS before,
                COALESCE(SUM(CASE WHEN e.entry_date BETWEEN ? AND ? THEN l.debit END), 0) AS debit,
                COALESCE(SUM(CASE WHEN e.entry_date BETWEEN ? AND ? THEN l.credit END), 0) AS credit
         FROM chart_of_accounts a
         LEFT JOIN journal_lines l ON l.account_id = a.id
         LEFT JOIN journal_entries e ON e.id = l.journal_entry_id
         GROUP BY a.id ORDER BY a.code`,
      )
      .all(from, from, to, from, to) as { accountId: number; code: string; rgs: string; rgsRef: string | null; name: string; category: string; before: number; debit: number; credit: number }[];
    const out: TrialBalanceRow[] = rows
      .map((r) => {
        const kind = kindOf(r.category);
        // een resultaatrekening begint elke periode bij nul; de beginbalans hoort bij de balansrekeningen
        const opening = kind === 'balans' ? r.before : 0;
        return { accountId: r.accountId, code: r.code, rgs: r.rgs, rgsRef: r.rgsRef, name: r.name, kind, category: r.category, opening, debit: r.debit, credit: r.credit, closing: opening + r.debit - r.credit };
      })
      .filter((r) => r.opening !== 0 || r.debit !== 0 || r.credit !== 0);
    const sum = (f: (r: TrialBalanceRow) => number) => out.reduce((t, r) => t + f(r), 0);
    const totals = { opening: sum((r) => r.opening), debit: sum((r) => r.debit), credit: sum((r) => r.credit), closing: sum((r) => r.closing) };
    return { from, to, rows: out, totals, balanced: totals.debit === totals.credit };
  }

  /** Alle boekingen op één rekening in een periode, met beginsaldo en oplopend saldo. */
  ledgerCard(accountId: number, from: IsoDate, to: IsoDate): LedgerCard {
    const a = this.db.prepare('SELECT id, code, name, category FROM chart_of_accounts WHERE id = ?').get(accountId) as { id: number; code: string; name: string; category: string } | undefined;
    if (!a) throw new Error('Deze rekening bestaat niet');
    const kind = kindOf(a.category);
    const before = kind === 'balans' ? (this.db.prepare('SELECT COALESCE(SUM(l.debit - l.credit), 0) AS s FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id WHERE l.account_id = ? AND e.entry_date < ?').get(a.id, from) as { s: number }).s : 0;
    const rows = this.db
      .prepare(
        `SELECT e.id AS entryId, e.entry_date AS date, e.description, e.source, e.source_ref AS sourceRef, e.status, e.reverses_entry_id AS reverses,
                SUM(l.debit) AS debit, SUM(l.credit) AS credit
         FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
         WHERE l.account_id = ? AND e.entry_date BETWEEN ? AND ?
         GROUP BY e.id ORDER BY e.entry_date, e.id`,
      )
      .all(a.id, from, to) as { entryId: number; date: string; description: string; source: string; sourceRef: string | null; status: string; reverses: number | null; debit: number; credit: number }[];
    return this.card(a, kind, before, rows);
  }

  private card(a: { id: number; code: string; name: string }, kind: 'balans' | 'resultaat', opening: number, rows: { entryId: number; date: string; description: string; source: string; sourceRef: string | null; status: string; reverses: number | null; debit: number; credit: number }[]): LedgerCard {
    let balance = opening;
    let debit = 0;
    let credit = 0;
    const lines: CardLine[] = rows.map((r) => {
      balance += r.debit - r.credit;
      debit += r.debit;
      credit += r.credit;
      return { entryId: r.entryId, date: r.date, description: r.description, source: r.source, status: r.status, reversal: r.reverses !== null, debit: r.debit, credit: r.credit, balance, ...this.origin(r.entryId, r.sourceRef) };
    });
    return { accountId: a.id, code: a.code, name: a.name, kind, opening, lines, debit, credit, closing: balance };
  }

  /** Waar komt een boeking vandaan (factuur, aankoop, bankregel) en van wie. */
  private origin(entryId: number, sourceRef: string | null): Pick<CardLine, 'counterparty' | 'invoiceId' | 'purchaseId' | 'bankTransactionId'> {
    const invoiceId = sourceRef?.startsWith('invoice:') ? Number(sourceRef.slice(8)) : null;
    const purchaseId = sourceRef?.startsWith('purchase:') ? Number(sourceRef.slice(9)) : null;
    const bank = this.db.prepare('SELECT id, counter_name FROM bank_transactions WHERE matched_journal_entry_id = ? LIMIT 1').get(entryId) as { id: number; counter_name: string | null } | undefined;
    const rel = this.db.prepare('SELECT r.name FROM journal_lines l JOIN relations r ON r.id = l.relation_id WHERE l.journal_entry_id = ? LIMIT 1').get(entryId) as { name: string } | undefined;
    return { counterparty: rel?.name ?? bank?.counter_name ?? null, invoiceId, purchaseId, bankTransactionId: bank?.id ?? null };
  }

  /** Klanten en leveranciers met wat ze open hebben staan (debiteuren en crediteuren) t/m een datum. */
  relations(to: IsoDate): RelationSummary[] {
    const rows = this.db
      .prepare(
        `SELECT r.id AS relationId, r.name, r.type,
                COALESCE(SUM(CASE WHEN a.rgs_code = ? THEN l.debit - l.credit END), 0) AS receivable,
                COALESCE(SUM(CASE WHEN a.rgs_code = ? THEN l.debit - l.credit END), 0) AS payable,
                COUNT(DISTINCT e.id) AS entries
         FROM relations r
         JOIN journal_lines l ON l.relation_id = r.id
         JOIN chart_of_accounts a ON a.id = l.account_id AND a.rgs_code IN (?, ?)
         JOIN journal_entries e ON e.id = l.journal_entry_id AND e.entry_date <= ?
         GROUP BY r.id ORDER BY r.name COLLATE NOCASE`,
      )
      .all(ACCOUNTS.debiteuren, ACCOUNTS.crediteuren, ACCOUNTS.debiteuren, ACCOUNTS.crediteuren, to) as { relationId: number; name: string; type: string; receivable: number; payable: number; entries: number }[];
    return rows.map((r) => ({ ...r, balance: r.receivable + r.payable }));
  }

  relationCard(relationId: number, from: IsoDate, to: IsoDate): RelationCard {
    const summary = this.relations(to).find((r) => r.relationId === relationId);
    if (!summary) {
      const r = this.db.prepare('SELECT id, name, type FROM relations WHERE id = ?').get(relationId) as { id: number; name: string; type: string } | undefined;
      if (!r) throw new Error('Deze klant of leverancier bestaat niet');
      return { relation: { relationId: r.id, name: r.name, type: r.type, receivable: 0, payable: 0, balance: 0, entries: 0 }, opening: 0, lines: [] };
    }
    const opening = (this.db
      .prepare(`SELECT COALESCE(SUM(l.debit - l.credit), 0) AS s FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN chart_of_accounts a ON a.id = l.account_id WHERE l.relation_id = ? AND a.rgs_code IN (?, ?) AND e.entry_date < ?`)
      .get(relationId, ACCOUNTS.debiteuren, ACCOUNTS.crediteuren, from) as { s: number }).s;
    const rows = this.db
      .prepare(
        `SELECT e.id AS entryId, e.entry_date AS date, e.description, e.source, e.source_ref AS sourceRef, e.status, e.reverses_entry_id AS reverses,
                a.name AS account, SUM(l.debit) AS debit, SUM(l.credit) AS credit
         FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN chart_of_accounts a ON a.id = l.account_id
         WHERE l.relation_id = ? AND a.rgs_code IN (?, ?) AND e.entry_date BETWEEN ? AND ?
         GROUP BY e.id, a.id ORDER BY e.entry_date, e.id`,
      )
      .all(relationId, ACCOUNTS.debiteuren, ACCOUNTS.crediteuren, from, to) as { entryId: number; date: string; description: string; source: string; sourceRef: string | null; status: string; reverses: number | null; account: string; debit: number; credit: number }[];
    const card = this.card({ id: 0, code: '', name: summary.name }, 'balans', opening, rows);
    return { relation: summary, opening, lines: card.lines.map((l, i) => ({ ...l, account: rows[i]!.account })) };
  }

  /** Mutaties per maand of kwartaal voor het hele jaar, met beginbalans en eindstand. */
  periodBalance(year: number, granularity: 'maand' | 'kwartaal'): PeriodBalance {
    const n = granularity === 'maand' ? 12 : 4;
    const labels = Array.from({ length: n }, (_, i) => (granularity === 'maand' ? `P${i + 1}` : `Q${i + 1}`));
    const start = `${year}-01-01`;
    const idx = (date: string) => (granularity === 'maand' ? Number(date.slice(5, 7)) - 1 : Math.floor((Number(date.slice(5, 7)) - 1) / 3));
    const accounts = this.db.prepare('SELECT id, code, name, category FROM chart_of_accounts ORDER BY code').all() as { id: number; code: string; name: string; category: string }[];
    const before = new Map((this.db.prepare('SELECT l.account_id AS id, SUM(l.debit - l.credit) AS s FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id WHERE e.entry_date < ? GROUP BY l.account_id').all(start) as { id: number; s: number }[]).map((r) => [r.id, r.s]));
    const moves = this.db.prepare(`SELECT l.account_id AS id, e.entry_date AS date, l.debit - l.credit AS net FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id WHERE e.entry_date BETWEEN ? AND ?`).all(start, `${year}-12-31`) as { id: number; date: string; net: number }[];
    const per = new Map<number, number[]>();
    for (const m of moves) {
      const arr = per.get(m.id) ?? Array<number>(n).fill(0);
      arr[idx(m.date)]! += m.net;
      per.set(m.id, arr);
    }
    const rows = accounts
      .map((a) => {
        const kind = kindOf(a.category);
        const opening = kind === 'balans' ? before.get(a.id) ?? 0 : 0;
        const periods = per.get(a.id) ?? Array<number>(n).fill(0);
        return { accountId: a.id, code: a.code, name: a.name, kind, opening, periods, closing: opening + periods.reduce((t, x) => t + x, 0) };
      })
      .filter((r) => r.opening !== 0 || r.periods.some((x) => x !== 0));
    return { year, granularity, labels, rows };
  }
}
