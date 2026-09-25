import type { Db } from '../db/database';

/** Wat de app zelf heeft gedaan, zodat de gebruiker het kan nalezen (#22). */
export interface AutomationEntry {
  id: number;
  created_at: string;
  kind: 'bank-auto' | 'document-auto' | 'bank-match';
  ref_id: number | null;
  summary: string;
  reason: string;
}

export function logAutomation(db: Db, entry: Omit<AutomationEntry, 'id' | 'created_at'>): void {
  db.prepare('INSERT INTO automation_log (kind, ref_id, summary, reason) VALUES (?, ?, ?, ?)').run(entry.kind, entry.ref_id, entry.summary, entry.reason);
}

export function recentAutomation(db: Db, days = 7, limit = 20): AutomationEntry[] {
  return db
    .prepare(`SELECT * FROM automation_log WHERE created_at >= datetime('now', ?) ORDER BY id DESC LIMIT ?`)
    .all(`-${days} days`, limit) as AutomationEntry[];
}
