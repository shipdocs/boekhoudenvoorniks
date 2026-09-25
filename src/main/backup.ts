import { copyFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Db } from '../db/database';

/** Maakt een consistente kopie van de database (werkt ook terwijl de app draait). */
export async function backupTo(db: Db, target: string): Promise<void> {
  await db.backup(target);
}

/** Dagelijkse automatische back-up; bewaart de laatste `keep` bestanden. */
export async function dailyBackup(db: Db, dir: string, keep = 14): Promise<string | null> {
  mkdirSync(dir, { recursive: true });
  const name = `boekhouding-${new Date().toISOString().slice(0, 10)}.sqlite`;
  const target = join(dir, name);
  if (existsSync(target)) return null;
  await backupTo(db, target);
  const files = readdirSync(dir).filter((f) => /^boekhouding-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f)).sort();
  for (const old of files.slice(0, Math.max(0, files.length - keep))) unlinkSync(join(dir, old));
  return target;
}

/** Controleert of een bestand een geldige administratie is voordat we hem terugzetten. */
export function validateBackup(file: string): void {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const ok = db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('journal_entries','journal_lines','chart_of_accounts','invoices')`).get() as { n: number };
    if (ok.n !== 4) throw new Error('Dit bestand is geen back-up van Gratis Boekhouden');
    const integrity = db.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new Error(`Back-up is beschadigd: ${String(integrity)}`);
  } finally {
    db.close();
  }
}

export function restoreFrom(file: string, target: string): void {
  validateBackup(file);
  copyFileSync(target, `${target}.voor-herstel`);
  copyFileSync(file, target);
  for (const suffix of ['-wal', '-shm']) if (existsSync(target + suffix)) unlinkSync(target + suffix);
}
