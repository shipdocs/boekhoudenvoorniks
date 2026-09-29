import type { Db } from '../db/database';
import { ACCOUNTS } from '../core-ledger/accounts';
import type { Cents } from '../shared/money';
import type { IsoDate } from '../shared/dates';

export interface OpeningLine {
  accountId: number;
  code: string;
  /** debet positief */
  amount: Cents;
}

/** Een beginbalansboeking op de eerste dag (overstap) telt als beginbalans, niet als mutatie. */
export const OPENING_ON_FROM = `(e.source = 'opening' AND e.entry_date = ?)`;

/**
 * Beginbalans op `from`, voor de rapporten in de app én het pakket voor de boekhouder (XAF,
 * kolommenbalans), zodat ze nooit uiteenlopen: de balansrekeningen uit alles vóór die dag plus een
 * beginbalansboeking op die dag zelf. Het resultaat en de privé-opnamen en -stortingen van daarvóór
 * tellen bij het eigen vermogen; resultaat- en privérekeningen beginnen bij nul. Er is geen echte
 * afsluitboeking: de afsluiting wordt hier uitgerekend.
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
  const equity = db.prepare('SELECT id AS accountId, code FROM chart_of_accounts WHERE rgs_code = ?').get(ACCOUNTS.eigenVermogen) as { accountId: number; code: string };
  const toEquity = (r: { rgs_code: string; category: string }) => r.category === 'omzet' || r.category === 'kosten' || r.rgs_code === ACCOUNTS.priveOpnamen || r.rgs_code === ACCOUNTS.priveStortingen;
  const closed = rows.filter(toEquity).reduce((s, r) => s + r.amount, 0);
  const balance = rows.filter((r) => !toEquity(r)).map((r) => ({ accountId: r.accountId, code: r.code, amount: r.amount }));
  const ev = balance.find((b) => b.accountId === equity.accountId);
  if (ev) ev.amount += closed;
  else if (closed !== 0) balance.push({ ...equity, amount: closed });
  return balance.filter((b) => b.amount !== 0).sort((a, b) => a.code.localeCompare(b.code));
}
