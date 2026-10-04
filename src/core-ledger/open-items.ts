import type { Db } from '../db/database';
import type { IsoDate } from '../shared/dates';
import { ACCOUNTS } from './accounts';
import { ValidationError } from '../shared/validation';

/** Afzonderlijke posten op een rekening; een latere tegenboeking wijzigt een eerdere peildatum niet. */
export function accountOpenItems(db: Db, rgs: string, to: IsoDate = '9999-12-31') {
  const items = db.prepare(`
    SELECT e.id, e.entry_date, e.description, e.source, e.source_ref,
           SUM(l.debit - l.credit) AS net
    FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
    JOIN chart_of_accounts a ON a.id = l.account_id
    WHERE a.rgs_code = ? AND e.entry_date <= ?
      AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id = e.id AND r.entry_date <= ?)
      AND NOT (e.reverses_entry_id IS NOT NULL AND EXISTS (SELECT 1 FROM journal_entries o WHERE o.id = e.reverses_entry_id AND o.entry_date <= ?))
    GROUP BY e.id HAVING net <> 0 ORDER BY e.entry_date, e.id
  `).all(rgs, to, to, to) as { id: number; entry_date: IsoDate; description: string; source: string; source_ref: string | null; net: number }[];
  if (rgs !== ACCOUNTS.vraagposten || (db.pragma('user_version', { simple: true }) as number) < 35) return items;
  const byId = new Map(items.map(item => [item.id, item]));
  const signs = new Map(items.map(item => [item.id, Math.sign(item.net)]));
  const links = db.prepare('SELECT original_entry_id, settlement_entry_id, amount FROM question_item_settlements').all() as { original_entry_id: number; settlement_entry_id: number; amount: number }[];
  for (const link of links) {
    const original = byId.get(link.original_entry_id);
    const settlement = byId.get(link.settlement_entry_id);
    // Beide posten moeten op de peildatum bestaan en niet teruggedraaid zijn.
    if (!original || !settlement) continue;
    original.net -= signs.get(original.id)! * link.amount;
    settlement.net -= signs.get(settlement.id)! * link.amount;
  }
  return items.filter(item => item.net !== 0);
}

/** Alleen een expliciet gekozen memoriaal koppelen; gelijke tegengestelde vraagposten blijven afzonderlijk. */
export function settleQuestionItem(db: Db, originalId: number, settlementId: number): void {
  const entry = db.prepare('SELECT entry_date FROM journal_entries WHERE id = ?').get(settlementId) as { entry_date: IsoDate } | undefined;
  if (!entry || originalId === settlementId) throw new ValidationError('Kies een andere, bestaande vraagpost');
  const items = accountOpenItems(db, ACCOUNTS.vraagposten, entry.entry_date);
  const original = items.find(item => item.id === originalId);
  const settlement = items.find(item => item.id === settlementId);
  if (!original || !settlement || settlement.source !== 'handmatig' || Math.sign(original.net) === Math.sign(settlement.net)) {
    throw new ValidationError('Deze correctie moet op Vraagposten tegengesteld boeken aan de gekozen open post');
  }
  // Een achteraf gedateerde correctie mag niet nogmaals een later afgeboekt bedrag gebruiken.
  const available = accountOpenItems(db, ACCOUNTS.vraagposten).find(item => item.id === originalId);
  const amount = Math.min(Math.abs(original.net), Math.abs(settlement.net));
  if (!available || Math.sign(available.net) !== Math.sign(original.net) || Math.abs(available.net) < amount) {
    throw new ValidationError('Deze vraagpost is op een latere datum al afgeboekt. Draai die correctie eerst terug.');
  }
  db.prepare('INSERT INTO question_item_settlements (original_entry_id, settlement_entry_id, amount) VALUES (?, ?, ?)')
    .run(originalId, settlementId, amount);
}

export function hasQuestionSettlement(db: Db, entryId: number): boolean {
  if ((db.pragma('user_version', { simple: true }) as number) < 35) return false;
  return Boolean(db.prepare(`SELECT 1 FROM question_item_settlements k
    JOIN journal_entries o ON o.id = k.original_entry_id JOIN journal_entries s ON s.id = k.settlement_entry_id
    WHERE k.original_entry_id = ? AND o.status = 'definitief' AND s.status = 'definitief'`).get(entryId));
}

/** Een tweede herindeling naast een memoriaal zou de kosten dubbel boeken. */
export function assertQuestionNotSettled(db: Db, entryId: number): void {
  if (hasQuestionSettlement(db, entryId)) throw new ValidationError('Je boekhouder heeft deze vraagpost al met een correctieboeking afgeboekt. Draai die correctie eerst terug voordat je de oorspronkelijke boeking aanpast.');
}
