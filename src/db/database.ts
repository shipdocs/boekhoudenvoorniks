import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { migrations } from './migrations';
import { relativizeAttachmentPaths } from './attachment-paths';

export type Db = Database.Database;

export const NEWER_DATABASE_MESSAGE = 'Deze administratie is gemaakt met een nieuwere versie. Werk het programma eerst bij.';

/** Herkenbaar voor het hoofdproces: deze fout vraagt om bijwerken of een andere administratie. */
export class NewerDatabaseError extends Error {
  constructor(
    readonly databaseVersion: number,
    readonly appVersion: number = migrations.length,
  ) {
    super(NEWER_DATABASE_MESSAGE);
    this.name = 'NewerDatabaseError';
  }
}

/** Alleen lezen; nodig om vóór iedere migratie of andere schrijfactie veilig te kunnen stoppen. */
export function assertDatabaseNotNewer(db: Db): void {
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version > migrations.length) throw new NewerDatabaseError(version);
}

/** Controleert een bestaand databasebestand zonder journal, migratie of andere schrijfactie. */
export function assertDatabaseFileNotNewer(filename: string): void {
  const db = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    assertDatabaseNotNewer(db);
  } finally {
    db.close();
  }
}

export function openDatabase(filename: string, log: (message: string) => void = console.warn): Db {
  // Een bestaande database eerst via een read-only verbinding beoordelen. Zo kan zelfs het openen
  // van een database in WAL-modus geen sidecar of checkpoint veroorzaken als hij te nieuw is.
  if (filename !== ':memory:' && existsSync(filename)) assertDatabaseFileNotNewer(filename);
  const db = new Database(filename);
  try {
    // Eerst de schema-versie: WAL, migraties en bijlagecorrecties kunnen allemaal schrijven.
    assertDatabaseNotNewer(db);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    migrate(db);
    relativizeAttachments(db, log);
    return db;
  } catch (e) {
    db.close();
    throw e;
  }
}

/**
 * Bijlagepaden uit een oudere versie (absoluut) omzetten naar relatieve paden. Dat gebeurt bij elke
 * keer openen en niet in een migratie: een migratie draait één keer, terwijl een oudere versie van de
 * app die deze administratie daarna nog opent, weer absolute paden schrijft. Is er niets om te zetten,
 * dan wordt er niets geschreven. Lukt het niet, dan gaat de administratie toch open: de oude paden
 * werken nog zolang de map niet verhuist, en de volgende keer openen probeert het opnieuw.
 */
function relativizeAttachments(db: Db, log: (message: string) => void): void {
  try {
    const report = relativizeAttachmentPaths(db);
    if (report.converted > 0) log(`${report.converted} bijlagepad(en) omgezet naar een pad binnen de map van de administratie`);
    // niet omzetten en niet weggooien: het pad blijft in de database staan, zodat het bestand terug te vinden is
    for (const kept of report.kept) log(`Bijlagepad buiten de map bijlagen blijft staan zoals het is (${kept.table} ${kept.id}): ${kept.path}`);
  } catch (e) {
    log(`Bijlagepaden omzetten is niet gelukt: ${(e as Error).message}`);
  }
}

/**
 * Alleen lezen (voor de koppeling met Claude Code/Codex): nooit migreren of schrijven. Hoort de
 * database bij een andere versie, dan eerst de app openen.
 */
export function openReadonly(filename: string): Db {
  const db = new Database(filename, { readonly: true, fileMustExist: true });
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version !== migrations.length) {
    db.close();
    throw new Error('De administratie hoort bij een andere versie van de app. Open BoekhoudenVoorNiks eerst één keer, dan werkt deze koppeling weer.');
  }
  return db;
}

export function migrate(db: Db): void {
  assertDatabaseNotNewer(db);
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let i = current; i < migrations.length; i++) {
    const sql = migrations[i]!;
    db.transaction(() => {
      // een migratie mag altijd boeken of corrigeren, ook in een afgesloten periode (migratie 22)
      const lockable = Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ledger_lock_bypass'`).get());
      if (lockable) db.exec('INSERT OR IGNORE INTO ledger_lock_bypass (id) VALUES (1)');
      db.exec(sql);
      if (lockable) db.exec('DELETE FROM ledger_lock_bypass');
      db.pragma(`user_version = ${i + 1}`);
    })();
  }
}

/** Voert fn uit in een transactie, of direct als er al een transactie loopt (nesting-veilig). */
export function tx<T>(db: Db, fn: () => T): T {
  if (db.inTransaction) return fn();
  return db.transaction(fn)();
}
