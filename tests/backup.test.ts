import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../src/db/database';
import { createServices, MemorySecretStore } from '../src/services';
import Database from 'better-sqlite3';
import { backupDatabase, createBackupBundle, isBackupBundle, readBackupBundle, restoreCompleteBackup, restoreLegacyDatabase, validateCompleteBackup } from '../src/main/backup';
import { decryptBackup, encryptBackup } from '../src/main/encrypted-backup';

function services(file: string) {
  return createServices(openDatabase(file), {
    pdf: async () => Buffer.from('PDF'),
    mailerFactory: async () => ({ send: async () => ({ messageId: '<x@local>' }) }),
    secrets: new MemorySecretStore(),
    fetch: async () => { throw new Error('geen netwerk'); },
    storeFile: async (name) => name,
  });
}

describe('complete back-up', () => {
  let dir = '';
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it('neemt bijlagen mee, controleert ze en herstelt paden op de nieuwe locatie', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gb-backup-test-'));
    const sourceRoot = join(dir, 'bron');
    const sourceDb = join(sourceRoot, 'boekhouding.sqlite');
    const attachment = join(sourceRoot, 'bijlagen', '2026', 'bon.pdf');
    mkdirSync(join(sourceRoot, 'bijlagen', '2026'), { recursive: true });
    writeFileSync(attachment, 'bewijsstuk');
    const source = services(sourceDb);
    source.purchases.create({ invoiceDate: '2026-09-20', description: 'bon', attachmentPath: attachment, lines: [{ account: 'WBedAlkOvr', netAmount: 1000, vatCode: 'geen', vatAmount: 0 }] });
    const bundle = await createBackupBundle(source.db, sourceRoot);
    source.db.close();

    const entries = readBackupBundle(bundle);
    expect(() => validateCompleteBackup(bundle)).not.toThrow();
    expect(entries.get('bijlagen/2026/bon.pdf')?.toString()).toBe('bewijsstuk');

    const targetRoot = join(dir, 'doel');
    mkdirSync(targetRoot, { recursive: true });
    const targetDb = join(targetRoot, 'boekhouding.sqlite');
    const target = services(targetDb);
    target.relations.create({ name: 'Wordt vervangen' });
    target.db.close();
    restoreCompleteBackup(bundle, targetDb, targetRoot);

    const restored = services(targetDb);
    const purchase = restored.purchases.list()[0]!;
    expect(purchase.attachment_path).toBe(join(targetRoot, 'bijlagen', '2026', 'bon.pdf'));
    expect(readFileSync(purchase.attachment_path!, 'utf8')).toBe('bewijsstuk');
    expect(existsSync(`${targetDb}.voor-herstel`)).toBe(true);
    restored.db.close();
  });

  /** Een administratie op "een andere computer": de paden in de database wijzen naar een map die hier niet bestaat. */
  async function foreignSource(root: string): Promise<ReturnType<typeof services>> {
    mkdirSync(join(root, 'bijlagen', '2026'), { recursive: true });
    writeFileSync(join(root, 'bijlagen', '2026', 'bon.pdf'), 'bewijsstuk');
    const source = services(join(root, 'boekhouding.sqlite'));
    source.purchases.create({ invoiceDate: '2026-09-20', description: 'bon', attachmentPath: 'C:\\Users\\Piet\\AppData\\Roaming\\gratis-boekhouden\\bijlagen\\2026\\bon.pdf', lines: [{ account: 'WBedAlkOvr', netAmount: 1000, vatCode: 'geen', vatAmount: 0 }] });
    return source;
  }

  function emptyTarget(root: string): string {
    mkdirSync(root, { recursive: true });
    const file = join(root, 'boekhouding.sqlite');
    services(file).db.close();
    return file;
  }

  function attachmentPath(file: string): string {
    const db = new Database(file, { readonly: true });
    try {
      return db.prepare('SELECT attachment_path FROM purchase_invoices').pluck().get() as string;
    } finally {
      db.close();
    }
  }

  it('versleutelde back-up: na ontsleutelen en terugzetten openen de bijlagen op de nieuwe plek', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gb-backup-test-'));
    const source = await foreignSource(join(dir, 'bron'));
    const encrypted = encryptBackup(await createBackupBundle(source.db, join(dir, 'bron')), 'een-lang-wachtwoord');
    source.db.close();

    const targetRoot = join(dir, 'doel');
    const targetDb = emptyTarget(targetRoot);
    const bundle = decryptBackup(encrypted, 'een-lang-wachtwoord');
    expect(isBackupBundle(bundle)).toBe(true);
    restoreCompleteBackup(bundle, targetDb, targetRoot);
    expect(attachmentPath(targetDb)).toBe(join(targetRoot, 'bijlagen', '2026', 'bon.pdf'));
    expect(readFileSync(attachmentPath(targetDb), 'utf8')).toBe('bewijsstuk');
  });

  it('oude losse databaseback-up: de paden wijzen na terugzetten naar de bijlagen die er al staan', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gb-backup-test-'));
    const source = await foreignSource(join(dir, 'bron'));
    const legacy = join(dir, 'oud.sqlite');
    await backupDatabase(source.db, legacy);
    source.db.close();

    const targetRoot = join(dir, 'doel');
    const targetDb = emptyTarget(targetRoot);
    mkdirSync(join(targetRoot, 'bijlagen', '2026'), { recursive: true });
    writeFileSync(join(targetRoot, 'bijlagen', '2026', 'bon.pdf'), 'staat er al');
    restoreLegacyDatabase(legacy, targetDb);
    expect(attachmentPath(targetDb)).toBe(join(targetRoot, 'bijlagen', '2026', 'bon.pdf'));
    expect(readFileSync(attachmentPath(targetDb), 'utf8')).toBe('staat er al');
    expect(existsSync(`${targetDb}.voor-herstel`)).toBe(true);
  });

  it('weigert een beschadigd pakket', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gb-backup-test-'));
    const file = join(dir, 'boekhouding.sqlite');
    const s = services(file);
    const bundle = await createBackupBundle(s.db, dir);
    s.db.close();
    bundle[bundle.length - 1] = bundle[bundle.length - 1]! ^ 1;
    expect(() => readBackupBundle(bundle)).toThrow(/beschadigd/);
  });
});
