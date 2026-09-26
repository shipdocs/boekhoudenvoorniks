import type { Db } from '../db/database';
import type { Explanation } from '../automation/explain';

/**
 * Logboek van wat er verwerkt is: door de app zelf (groen, #29) of door de gebruiker vanuit
 * een taak. Met de "Waarom?"-uitleg erbij (#28).
 */
export type AutomationKind = 'bank-auto' | 'bank-own' | 'document-auto' | 'bank-match' | 'gebruiker';
export type AutomationStatus = 'auto' | 'done_by_user' | 'klopt_niet';

export interface AutomationEntry {
  id: number;
  created_at: string;
  kind: AutomationKind;
  ref_id: number | null;
  summary: string;
  /** de uitleg in gewone taal */
  reason: string;
  actor: 'systeem' | 'gebruiker';
  status: AutomationStatus;
  details: Explanation | null;
  corrected_at: string | null;
}

type Row = Omit<AutomationEntry, 'details'> & { details: string | null };
const parse = (r: Row): AutomationEntry => ({ ...r, details: r.details ? (JSON.parse(r.details) as Explanation) : null });

export function logAutomation(
  db: Db,
  entry: { kind: AutomationKind; ref_id: number | null; summary: string; reason: string; details?: Explanation | null; actor?: 'systeem' | 'gebruiker' },
): number {
  const actor = entry.actor ?? (entry.kind === 'gebruiker' ? 'gebruiker' : 'systeem');
  return Number(
    db
      .prepare('INSERT INTO automation_log (kind, ref_id, summary, reason, details, actor, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(entry.kind, entry.ref_id, entry.summary, entry.reason, entry.details ? JSON.stringify(entry.details) : null, actor, actor === 'gebruiker' ? 'done_by_user' : 'auto').lastInsertRowid,
  );
}

export function getAutomation(db: Db, id: number): AutomationEntry | null {
  const r = db.prepare('SELECT * FROM automation_log WHERE id = ?').get(id) as Row | undefined;
  return r ? parse(r) : null;
}

export function recentAutomation(db: Db, days = 7, limit = 20): AutomationEntry[] {
  return (db
    .prepare(`SELECT * FROM automation_log WHERE actor = 'systeem' AND created_at >= datetime('now', ?) ORDER BY id DESC LIMIT ?`)
    .all(`-${days} days`, limit) as Row[]).map(parse);
}

/** Alles van een maand (JJJJ-MM), nieuwste eerst. */
export function automationForMonth(db: Db, month: string, actor?: 'systeem' | 'gebruiker'): AutomationEntry[] {
  return (db
    .prepare(`SELECT * FROM automation_log WHERE substr(created_at, 1, 7) = ? ${actor ? 'AND actor = ?' : ''} ORDER BY id DESC`)
    .all(...(actor ? [month, actor] : [month])) as Row[]).map(parse);
}

export function markCorrected(db: Db, id: number): void {
  db.prepare(`UPDATE automation_log SET status = 'klopt_niet', corrected_at = datetime('now') WHERE id = ?`).run(id);
}

/** Tellers per beslissingssoort: hoe vaak automatisch, hoe vaak door de gebruiker gecorrigeerd (#21). */
export function countDecision(db: Db, kind: string, field: 'automatic' | 'corrected'): void {
  db.prepare(`INSERT INTO decision_stats (kind, ${field}) VALUES (?, 1) ON CONFLICT(kind) DO UPDATE SET ${field} = ${field} + 1`).run(kind);
}

export function decisionStats(db: Db): { kind: string; automatic: number; corrected: number }[] {
  return db.prepare('SELECT kind, automatic, corrected FROM decision_stats ORDER BY kind').all() as { kind: string; automatic: number; corrected: number }[];
}
