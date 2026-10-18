import { existsSync, mkdirSync, rmSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Db } from '../db/database';
import { resolveAttachmentPath } from './attachments';
import { writeCompleteBackup } from './backup';

/** Het bestand van een opgeslagen bijlagepad, of null als het niet in de bijlagenmap ligt (dan blijven we eraf). */
function insideAttachments(attachmentsDir: string, stored: string): string | null {
  try {
    return resolveAttachmentPath(dirname(resolve(attachmentsDir)), stored);
  } catch {
    return null;
  }
}

/**
 * Staat er iets in deze administratie dat de moeite van bewaren waard is? Een demo niet;
 * een lege administratie ook niet.
 */
export function hasRealData(db: Db): boolean {
  const demo = db.prepare(`SELECT value FROM settings WHERE key = 'demoMode'`).get() as { value: string } | undefined;
  if (demo && JSON.parse(demo.value) === true) return false;
  const n = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM journal_entries) + (SELECT COUNT(*) FROM invoices) + (SELECT COUNT(*) FROM quotes)
            + (SELECT COUNT(*) FROM relations) + (SELECT COUNT(*) FROM bank_transactions) + (SELECT COUNT(*) FROM documents) AS n`,
    )
    .get() as { n: number };
  return n.n > 0;
}

/**
 * Wist de administratie: eerst een veiligheidskopie (alleen bij echte gegevens), dan de database
 * sluiten en de bestanden verwijderen. Het journaal is onveranderlijk (triggers), dus leegmaken
 * met DELETE kan niet — een nieuwe, lege database wel. De aanroeper opent daarna een nieuwe.
 *
 * Bij echte gegevens bevat de veiligheidskopie ook alle bijlagen. Daarna wordt de administratie,
 * inclusief de lokale bijlagenmap, gewist.
 * Geeft het pad van de veiligheidskopie terug, of null als die niet nodig was.
 */
export async function wipeDatabase(db: Db, file: string, backupDir: string, attachmentsDir?: string): Promise<string | null> {
  let backup: string | null = null;
  if (hasRealData(db)) {
    mkdirSync(backupDir, { recursive: true });
    backup = join(backupDir, `voor-wissen-${new Date().toISOString().replace(/[:.]/g, '-')}.gbbackup`);
    await writeCompleteBackup(db, resolve(attachmentsDir ? join(attachmentsDir, '..') : join(file, '..')), backup);
  } else if (attachmentsDir) {
    const rows = db.prepare('SELECT file_path AS p FROM documents UNION SELECT attachment_path FROM purchase_invoices WHERE attachment_path IS NOT NULL').all() as { p: string }[];
    for (const { p } of rows) {
      const file = insideAttachments(attachmentsDir, p);
      if (file && existsSync(file)) unlinkSync(file);
    }
  }
  db.close();
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(file + suffix)) unlinkSync(file + suffix);
  if (attachmentsDir && existsSync(attachmentsDir)) rmSync(attachmentsDir, { recursive: true, force: true });
  return backup;
}
