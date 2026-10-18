import type Database from 'better-sqlite3';

/** De map met bijlagen van één administratie, naast de database. */
export const ATTACHMENTS_DIR = 'bijlagen';

/** De kolommen waarin een bijlagepad staat. */
const COLUMNS = [
  { table: 'documents', column: 'file_path' },
  { table: 'purchase_invoices', column: 'attachment_path' },
  // foto's van de telefoon bij een project (bijlagen/telefoon/<wijziging>/<volgnr>.jpg)
  { table: 'job_photos', column: 'file_path' },
] as const;

/**
 * Zo staat een bijlagepad in de database: relatief aan de map van de administratie en altijd met `/`,
 * ook op Windows. Bijvoorbeeld `bijlagen/2026/bon.pdf`. Verhuist de administratie (een andere map, een
 * andere computer, een teruggezette back-up), dan klopt het pad nog steeds.
 */
export function isStoredAttachmentPath(value: string): boolean {
  return value.startsWith(`${ATTACHMENTS_DIR}/`) && !value.includes('\\') && !value.includes('\0') && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/**
 * Het relatieve pad voor een pad uit een oudere versie: een absoluut pad naar de huidige map, naar de map
 * van vóór de naamswijziging of naar een andere computer, ook een Windows-pad met backslashes of andere
 * hoofdletters (`\Bijlagen\` is op Windows dezelfde map). Alles na de laatste `/bijlagen/` blijft. Een pad
 * dat al relatief is, blijft zoals het is. null = het pad ligt niet in een bijlagenmap, of het vervolg is
 * onveilig (`..`): zo'n pad zetten we niet om.
 */
export function relativeAttachmentPath(value: string): string | null {
  if (isStoredAttachmentPath(value)) return value;
  // Zoeken in het pad zelf, niet in een kopie in kleine letters: die kan bij sommige tekens langer zijn
  // dan het origineel. De `/` vooraan vangt een pad dat met `bijlagen\` begint.
  const normalized = `/${value.replace(/\\/g, '/')}`;
  const last = [...normalized.matchAll(/\/bijlagen\//gi)].at(-1);
  if (!last) return null;
  const relative = `${ATTACHMENTS_DIR}/${normalized.slice(last.index + last[0].length)}`;
  return isStoredAttachmentPath(relative) ? relative : null;
}

export interface KeptAttachmentPath {
  table: string;
  id: number;
  path: string;
}

export interface RelativizeReport {
  /** rijen waarvan het pad is omgezet naar een relatief pad */
  converted: number;
  /** paden buiten een bijlagenmap: die blijven staan zoals ze zijn */
  kept: KeptAttachmentPath[];
}

/** De opgeslagen bijlagepaden van een database, per kolom; een tabel die er nog niet is, slaat hij over. */
export function storedAttachmentPaths(db: Database.Database): (KeptAttachmentPath & { column: string })[] {
  const out: (KeptAttachmentPath & { column: string })[] = [];
  for (const { table, column } of COLUMNS) {
    // oudere databases hebben nog niet alle tabellen (die komen met een latere migratie)
    if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table)) continue;
    const rows = db.prepare(`SELECT id, ${column} AS path FROM ${table} WHERE typeof(${column}) = 'text'`).all() as { id: number; path: string }[];
    for (const row of rows) out.push({ table, column, id: row.id, path: row.path });
  }
  return out;
}

/**
 * Zet de bijlagepaden uit een oudere versie om naar relatieve paden. Alleen de tekst in de database
 * verandert; de bestanden blijven waar ze staan. Wat al relatief is, blijft onaangeroerd: nog een keer
 * draaien verandert niets. Een pad buiten een bijlagenmap blijft staan en komt terug in `kept`.
 */
export function relativizeAttachmentPaths(db: Database.Database): RelativizeReport {
  const report: RelativizeReport = { converted: 0, kept: [] };
  const todo = storedAttachmentPaths(db).filter((row) => !isStoredAttachmentPath(row.path));
  if (todo.length === 0) return report;
  const run = (): void => {
    for (const { table, column, id, path } of todo) {
      const relative = relativeAttachmentPath(path);
      if (relative === null) {
        report.kept.push({ table, id, path });
        continue;
      }
      db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`).run(relative, id);
      report.converted++;
    }
  };
  if (db.inTransaction) run();
  else db.transaction(run)();
  return report;
}
