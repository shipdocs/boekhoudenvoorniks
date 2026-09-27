import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../src/db/database';
import { createServices, MemorySecretStore } from '../src/services';
import { createBackupBundle, readBackupBundle, restoreCompleteBackup, validateCompleteBackup } from '../src/main/backup';

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
