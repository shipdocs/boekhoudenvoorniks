import Database from 'better-sqlite3';
import { migrations } from './migrations';

export type Db = Database.Database;

export function openDatabase(filename: string): Db {
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
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
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let i = current; i < migrations.length; i++) {
    const sql = migrations[i]!;
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${i + 1}`);
    })();
  }
}

/** Voert fn uit in een transactie, of direct als er al een transactie loopt (nesting-veilig). */
export function tx<T>(db: Db, fn: () => T): T {
  if (db.inTransaction) return fn();
  return db.transaction(fn)();
}
