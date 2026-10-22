import type { Db } from '../db/database';
import { ACCOUNTS } from '../core-ledger/accounts';
import type { Cents } from '../shared/money';
import type { IsoDate } from '../shared/dates';
import { allPartnerPrivateKeys, partnerAccounts } from '../shared/partners';
import { allocateResult, sharesForYear, vofSetup, type VofSetup } from '../closing/profit-allocation';

export interface OpeningLine {
  accountId: number;
  code: string;
  /** debet positief */
  amount: Cents;
}

/** Een beginbalansboeking op de eerste dag (overstap) telt als beginbalans, niet als mutatie. */
export const OPENING_ON_FROM = `(e.source = 'opening' AND e.entry_date = ?)`;

/**
 * Het resultaat (omzet en kosten) volgens het grootboek tussen twee datums, winst positief (credit − debet). Dé
 * definitie voor de schatting van de inkomstenbelasting, de winstverdeling en de rapporten. Met
 * `exceptOpeningOn` telt een beginbalansboeking op die dag niet mee (die hoort bij de beginbalans, niet bij de mutaties).
 */
export function resultBetween(db: Db, from: IsoDate, to: IsoDate, exceptOpeningOn?: IsoDate): Cents {
  const sql = `SELECT COALESCE(SUM(l.credit - l.debit), 0) AS s FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
     JOIN chart_of_accounts a ON a.id = l.account_id
     WHERE a.category IN ('omzet', 'kosten') AND e.entry_date BETWEEN ? AND ?${exceptOpeningOn ? ` AND NOT ${OPENING_ON_FROM}` : ''}`;
  const args = exceptOpeningOn ? [from, to, exceptOpeningOn] : [from, to];
  return (db.prepare(sql).get(...args) as { s: number }).s;
}

/**
 * Beginbalans op `from`, voor de rapporten in de app én het pakket voor de boekhouder (XAF,
 * kolommenbalans), zodat ze nooit uiteenlopen: de balansrekeningen uit alles vóór die dag plus een
 * beginbalansboeking op die dag zelf. Het resultaat en de privé-opnamen en -stortingen van daarvóór
 * tellen bij het eigen vermogen; resultaat- en privérekeningen beginnen bij nul. Er is geen echte
 * afsluitboeking: de afsluiting wordt hier uitgerekend.
 *
 * Vof of maatschap met vennoten: de privé-opnamen en -stortingen van elke vennoot gaan naar zijn eigen
 * kapitaalrekening en het resultaat van elk eerder jaar wordt naar winstaandeel over de kapitaalrekeningen verdeeld
 * (zie closing/profit-allocation.ts). Een eenmanszaak of bv gaat precies als hierboven.
 */
export function openingBalance(db: Db, from: IsoDate): OpeningLine[] {
  const rows = db
    .prepare(
      `SELECT a.id AS accountId, a.code, a.rgs_code, a.category, SUM(l.debit - l.credit) AS amount
       FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN chart_of_accounts a ON a.id = l.account_id
       WHERE e.entry_date < ? OR ${OPENING_ON_FROM}
       GROUP BY a.id ORDER BY a.code`,
    )
    .all(from, from) as { accountId: number; code: string; rgs_code: string; category: string; amount: number }[];
  const setup = vofSetup(db);
  if (setup) return openingBalanceVof(db, from, rows, setup);
  const equity = db.prepare('SELECT id AS accountId, code FROM chart_of_accounts WHERE rgs_code = ?').get(ACCOUNTS.eigenVermogen) as { accountId: number; code: string };
  const toEquity = (r: { rgs_code: string; category: string }) => r.category === 'omzet' || r.category === 'kosten' || r.rgs_code === ACCOUNTS.priveOpnamen || r.rgs_code === ACCOUNTS.priveStortingen;
  const closed = rows.filter(toEquity).reduce((s, r) => s + r.amount, 0);
  const balance = rows.filter((r) => !toEquity(r)).map((r) => ({ accountId: r.accountId, code: r.code, amount: r.amount }));
  const ev = balance.find((b) => b.accountId === equity.accountId);
  if (ev) ev.amount += closed;
  else if (closed !== 0) balance.push({ ...equity, amount: closed });
  return balance.filter((b) => b.amount !== 0).sort((a, b) => a.code.localeCompare(b.code));
}

type Row = { accountId: number; code: string; rgs_code: string; category: string; amount: number };

function openingBalanceVof(db: Db, from: IsoDate, rows: Row[], setup: VofSetup): OpeningLine[] {
  const capital = new Map<number, { accountId: number; code: string }>();
  const accountOf = (no: number) => {
    if (!capital.has(no)) {
      const a = db.prepare('SELECT id AS accountId, code FROM chart_of_accounts WHERE rgs_code = ?').get(partnerAccounts(no).capital) as { accountId: number; code: string } | undefined;
      // ontbreekt de rekening (alleen-lezen kopie die nog niet is aangevuld), dan bij vennoot 1: het totaal blijft kloppen
      capital.set(no, a ?? accountOf(1));
    }
    return capital.get(no)!;
  };
  const privateOf = new Map(allPartnerPrivateKeys().map((p) => [p.key, p.no]));
  const isResult = (r: Row) => r.category === 'omzet' || r.category === 'kosten';
  const toEquity = (r: Row) => isResult(r) || privateOf.has(r.rgs_code);
  const add = new Map<number, number>();
  const bump = (no: number, amount: number) => {
    const id = accountOf(no).accountId;
    add.set(id, (add.get(id) ?? 0) + amount);
  };
  for (const r of rows) if (privateOf.has(r.rgs_code)) bump(privateOf.get(r.rgs_code)!, r.amount);
  const perYear = db
    .prepare(
      `SELECT CAST(substr(e.entry_date, 1, 4) AS INTEGER) AS year, SUM(l.debit - l.credit) AS amount
       FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN chart_of_accounts a ON a.id = l.account_id
       WHERE (e.entry_date < ? OR ${OPENING_ON_FROM}) AND a.category IN ('omzet', 'kosten')
       GROUP BY year ORDER BY year`,
    )
    .all(from, from) as { year: number; amount: number }[];
  for (const y of perYear) {
    if (y.amount === 0) continue;
    for (const part of allocateResult(y.amount, sharesForYear(db, setup, y.year))) bump(part.no, part.amount);
  }
  const balance = rows.filter((r) => !toEquity(r)).map((r) => ({ accountId: r.accountId, code: r.code, amount: r.amount }));
  for (const [accountId, amount] of add) {
    const line = balance.find((b) => b.accountId === accountId);
    if (line) line.amount += amount;
    else if (amount !== 0) {
      const a = [...capital.values()].find((c) => c.accountId === accountId)!;
      balance.push({ accountId, code: a.code, amount });
    }
  }
  return balance.filter((b) => b.amount !== 0).sort((a, b) => a.code.localeCompare(b.code));
}
