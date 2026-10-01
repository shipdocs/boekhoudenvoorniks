import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import type { Db } from '../db/database';

const BUNDLE_MAGIC = Buffer.from('GBBUNDLE');
const BUNDLE_VERSION = 1;
const MAX_ENTRIES = 100_000;

interface BundleEntry { path: string; data: Buffer }

function hash(data: Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

function safeBundlePath(path: string): boolean {
  return path.length > 0 && !isAbsolute(path) && !path.includes('\\') && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function attachmentEntries(root: string): BundleEntry[] {
  const attachments = join(root, 'bijlagen');
  if (!existsSync(attachments)) return [];
  const out: BundleEntry[] = [];
  const walk = (dir: string): void => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, item.name);
      if (item.isDirectory()) walk(file);
      else if (item.isFile()) out.push({ path: `bijlagen/${relative(attachments, file).split(sep).join('/')}`, data: readFileSync(file) });
    }
  };
  walk(attachments);
  return out;
}

/** Intern: maakt een consistente losse SQLite-kopie. */
export async function backupDatabase(db: Db, target: string): Promise<void> {
  await db.backup(target);
}

/**
 * Compleet, zelfcontrolerend back-uppakket: database plus alle bijlagen. `prepare` mag de losse kopie
 * van de database aanpassen voordat hij in het pakket gaat (bv. geheimen eruit voor de boekhouder).
 */
export async function createBackupBundle(db: Db, dataRoot: string, prepare?: (databaseCopy: string) => void): Promise<Buffer> {
  const temp = join(tmpdir(), `gb-backup-${randomUUID()}.sqlite`);
  try {
    await backupDatabase(db, temp);
    prepare?.(temp);
    const entries: BundleEntry[] = [{ path: 'boekhouding.sqlite', data: readFileSync(temp) }, ...attachmentEntries(dataRoot)];
    const parts: Buffer[] = [BUNDLE_MAGIC, Buffer.from([BUNDLE_VERSION])];
    const count = Buffer.alloc(4);
    count.writeUInt32BE(entries.length);
    parts.push(count);
    for (const entry of entries) {
      const path = Buffer.from(entry.path, 'utf8');
      const header = Buffer.alloc(12);
      header.writeUInt32BE(path.length, 0);
      header.writeBigUInt64BE(BigInt(entry.data.length), 4);
      parts.push(header, hash(entry.data), path, entry.data);
    }
    return Buffer.concat(parts);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

export function isBackupBundle(data: Buffer): boolean {
  return data.length >= BUNDLE_MAGIC.length + 5 && data.subarray(0, BUNDLE_MAGIC.length).equals(BUNDLE_MAGIC);
}

export function readBackupBundle(data: Buffer): Map<string, Buffer> {
  if (!isBackupBundle(data)) throw new Error('Dit is geen complete back-up van BoekhoudenVoorNiks');
  let offset = BUNDLE_MAGIC.length;
  const version = data[offset++];
  if (version !== BUNDLE_VERSION) throw new Error(`Onbekende versie van het back-upformaat (${version})`);
  if (offset + 4 > data.length) throw new Error('Back-up is beschadigd');
  const count = data.readUInt32BE(offset);
  offset += 4;
  if (count === 0 || count > MAX_ENTRIES) throw new Error('Back-up bevat een ongeldig aantal bestanden');
  const entries = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    if (offset + 44 > data.length) throw new Error('Back-up is afgebroken');
    const pathLength = data.readUInt32BE(offset);
    const size = Number(data.readBigUInt64BE(offset + 4));
    const expectedHash = data.subarray(offset + 12, offset + 44);
    offset += 44;
    if (!Number.isSafeInteger(size) || pathLength > 16_384 || offset + pathLength + size > data.length) throw new Error('Back-up bevat een ongeldig bestand');
    const path = data.subarray(offset, offset + pathLength).toString('utf8');
    offset += pathLength;
    if (!safeBundlePath(path) || entries.has(path)) throw new Error('Back-up bevat een onveilig of dubbel bestandspad');
    const content = data.subarray(offset, offset + size);
    offset += size;
    if (!hash(content).equals(expectedHash)) throw new Error(`Back-upbestand is beschadigd: ${path}`);
    entries.set(path, Buffer.from(content));
  }
  if (offset !== data.length || !entries.has('boekhouding.sqlite')) throw new Error('Back-up is beschadigd of onvolledig');
  return entries;
}

export async function writeCompleteBackup(db: Db, dataRoot: string, target: string): Promise<void> {
  writeFileSync(target, await createBackupBundle(db, dataRoot), { mode: 0o600 });
}

/** Controleert ook de SQLite-inhoud, zonder bestaande gegevens te wijzigen. */
export function validateCompleteBackup(data: Buffer): void {
  const database = readBackupBundle(data).get('boekhouding.sqlite')!;
  const temp = join(tmpdir(), `gb-validate-${randomUUID()}.sqlite`);
  try {
    writeFileSync(temp, database, { mode: 0o600 });
    validateBackup(temp);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

/** Dagelijkse complete back-up; bewaart de laatste `keep` bestanden. */
export async function dailyBackup(db: Db, dir: string, dataRoot: string, keep = 14): Promise<string | null> {
  mkdirSync(dir, { recursive: true });
  const name = `boekhouding-${new Date().toISOString().slice(0, 10)}.gbbackup`;
  const target = join(dir, name);
  if (existsSync(target)) return null;
  await writeCompleteBackup(db, dataRoot, target);
  const files = readdirSync(dir).filter((f) => /^boekhouding-\d{4}-\d{2}-\d{2}\.gbbackup$/.test(f)).sort();
  for (const old of files.slice(0, Math.max(0, files.length - keep))) unlinkSync(join(dir, old));
  return target;
}

export function validateBackup(file: string): void {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const ok = db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('journal_entries','journal_lines','chart_of_accounts','invoices')`).get() as { n: number };
    if (ok.n !== 4) throw new Error('Dit bestand is geen back-up van BoekhoudenVoorNiks');
    const integrity = db.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new Error(`Back-up is beschadigd: ${String(integrity)}`);
  } finally {
    db.close();
  }
}

/** Zet de bijlagepaden in een database om naar `attachmentsRoot`; herhalen verandert niets meer. */
export function rebaseAttachmentPaths(database: string, attachmentsRoot: string): void {
  const db = new Database(database);
  try {
    const update = (table: string, column: string): void => {
      const rows = db.prepare(`SELECT id, ${column} AS path FROM ${table} WHERE ${column} IS NOT NULL`).all() as { id: number; path: string }[];
      const statement = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`);
      for (const row of rows) {
        const normalized = row.path.replace(/\\/g, '/');
        const marker = '/bijlagen/';
        const index = normalized.lastIndexOf(marker);
        if (index < 0) continue;
        const rel = normalized.slice(index + marker.length);
        if (safeBundlePath(rel)) statement.run(join(attachmentsRoot, ...rel.split('/')), row.id);
      }
    };
    db.transaction(() => {
      update('documents', 'file_path');
      update('purchase_invoices', 'attachment_path');
    })();
  } finally {
    db.close();
  }
}

/** Herstelt een complete back-up en bewaart de vervangen database en bijlagen ernaast. */
export function restoreCompleteBackup(data: Buffer, target: string, dataRoot: string): void {
  const entries = readBackupBundle(data);
  const stage = join(dataRoot, `.herstel-${randomUUID()}`);
  const stagedDb = join(stage, 'boekhouding.sqlite');
  const attachments = join(dataRoot, 'bijlagen');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const oldAttachments = `${attachments}.voor-herstel-${stamp}`;
  let oldAttachmentsMoved = false;
  let newAttachmentsInstalled = false;
  mkdirSync(stage, { recursive: true });
  try {
    for (const [path, content] of entries) {
      const destination = join(stage, ...path.split('/'));
      const rel = relative(stage, resolve(destination));
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Back-up bevat een onveilig bestandspad');
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, content, { mode: 0o600 });
    }
    validateBackup(stagedDb);
    copyFileSync(target, `${target}.voor-herstel`);
    if (existsSync(attachments)) {
      renameSync(attachments, oldAttachments);
      oldAttachmentsMoved = true;
    }
    copyFileSync(stagedDb, target);
    for (const suffix of ['-wal', '-shm']) if (existsSync(target + suffix)) unlinkSync(target + suffix);
    const stagedAttachments = join(stage, 'bijlagen');
    if (existsSync(stagedAttachments)) renameSync(stagedAttachments, attachments);
    else mkdirSync(attachments, { recursive: true });
    newAttachmentsInstalled = true;
    rebaseAttachmentPaths(target, attachments);
  } catch (error) {
    if (existsSync(`${target}.voor-herstel`)) copyFileSync(`${target}.voor-herstel`, target);
    if (newAttachmentsInstalled && existsSync(attachments)) rmSync(attachments, { recursive: true, force: true });
    if (oldAttachmentsMoved && existsSync(oldAttachments)) renameSync(oldAttachments, attachments);
    throw error;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/** Pakt een bundel uit in een nieuwe, lege map (bv. de kopie van een klant bij de boekhouder). */
export function extractBundle(data: Buffer, dir: string): void {
  const entries = readBackupBundle(data);
  const target = join(dir, 'boekhouding.sqlite');
  if (existsSync(target)) throw new Error('Hier staat al een administratie');
  mkdirSync(dir, { recursive: true });
  for (const [path, content] of entries) {
    const destination = join(dir, ...path.split('/'));
    const rel = relative(dir, resolve(destination));
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Bundel bevat een onveilig bestandspad');
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content, { mode: 0o600 });
  }
  validateBackup(target);
  mkdirSync(join(dir, 'bijlagen'), { recursive: true });
  rebaseAttachmentPaths(target, join(dir, 'bijlagen'));
}

/** Alleen voor oude .sqlite-back-ups zonder bijlagen. */
export function restoreLegacyDatabase(file: string, target: string): void {
  validateBackup(file);
  copyFileSync(target, `${target}.voor-herstel`);
  copyFileSync(file, target);
  for (const suffix of ['-wal', '-shm']) if (existsSync(target + suffix)) unlinkSync(target + suffix);
}
