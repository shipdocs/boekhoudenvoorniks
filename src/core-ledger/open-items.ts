import type { Db } from '../db/database';
import type { IsoDate } from '../shared/dates';

/** Afzonderlijke posten op een rekening; een latere tegenboeking wijzigt een eerdere peildatum niet. */
export function accountOpenItems(db: Db, rgs: string, to: IsoDate = '9999-12-31') {
  return db.prepare(`
    SELECT e.id, e.entry_date, e.description, e.source, e.source_ref,
           SUM(l.debit - l.credit) AS net
    FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
    JOIN chart_of_accounts a ON a.id = l.account_id
    WHERE a.rgs_code = ? AND e.entry_date <= ?
      AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id = e.id AND r.entry_date <= ?)
      AND NOT (e.reverses_entry_id IS NOT NULL AND EXISTS (SELECT 1 FROM journal_entries o WHERE o.id = e.reverses_entry_id AND o.entry_date <= ?))
    GROUP BY e.id HAVING net <> 0 ORDER BY e.entry_date, e.id
  `).all(rgs, to, to, to) as { id: number; entry_date: IsoDate; description: string; source: string; source_ref: string | null; net: number }[];
}
