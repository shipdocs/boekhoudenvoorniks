import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { migrateDataDir, rebaseDataDirAttachments } from '../src/main/data-dir';

function dirs() {
  const root = mkdtempSync(join(tmpdir(), 'gb-datadir-'));
  const oldDir = join(root, 'gratis-boekhouden');
  const newDir = join(root, 'boekhoudenvoorniks');
  const fillOld = () => {
    mkdirSync(join(oldDir, 'bijlagen'), { recursive: true });
    writeFileSync(join(oldDir, 'boekhouding.sqlite'), 'db');
    writeFileSync(join(oldDir, 'bijlagen', 'bon.pdf'), 'bon');
  };
  return { oldDir, newDir, fillOld };
}

describe('gegevensmap na de naamswijziging', () => {
  it('verplaatst de oude map als er nog geen nieuwe is', () => {
    const { oldDir, newDir, fillOld } = dirs();
    fillOld();
    expect(migrateDataDir(oldDir, newDir)).toBe('verplaatst');
    expect(readFileSync(join(newDir, 'boekhouding.sqlite'), 'utf8')).toBe('db');
    expect(readFileSync(join(newDir, 'bijlagen', 'bon.pdf'), 'utf8')).toBe('bon');
    expect(existsSync(oldDir)).toBe(false);
  });

  it('vult een nieuwe map zonder administratie aan en laat wat er al stond staan', () => {
    const { oldDir, newDir, fillOld } = dirs();
    fillOld();
    writeFileSync(join(oldDir, 'Cookies'), 'oud');
    mkdirSync(newDir);
    writeFileSync(join(newDir, 'Cookies'), 'nieuw');
    expect(migrateDataDir(oldDir, newDir)).toBe('verplaatst');
    expect(readFileSync(join(newDir, 'boekhouding.sqlite'), 'utf8')).toBe('db');
    expect(readFileSync(join(newDir, 'bijlagen', 'bon.pdf'), 'utf8')).toBe('bon');
    expect(readFileSync(join(newDir, 'Cookies'), 'utf8')).toBe('nieuw');
    // wat in beide stond blijft in de oude map; die wordt dus niet weggegooid
    expect(readFileSync(join(oldDir, 'Cookies'), 'utf8')).toBe('oud');
  });

  it('raakt niets aan als de nieuwe map al een administratie heeft', () => {
    const { oldDir, newDir, fillOld } = dirs();
    fillOld();
    mkdirSync(newDir);
    writeFileSync(join(newDir, 'boekhouding.sqlite'), 'nieuw');
    expect(migrateDataDir(oldDir, newDir)).toBe('overgeslagen');
    expect(readFileSync(join(newDir, 'boekhouding.sqlite'), 'utf8')).toBe('nieuw');
    expect(readFileSync(join(oldDir, 'boekhouding.sqlite'), 'utf8')).toBe('db');
  });

  it('doet niets zonder oude administratie', () => {
    const { oldDir, newDir } = dirs();
    expect(migrateDataDir(oldDir, newDir)).toBe('geen');
    mkdirSync(oldDir);
    expect(migrateDataDir(oldDir, newDir)).toBe('geen');
    expect(existsSync(newDir)).toBe(false);
  });
});

describe('bijlagepaden na het verplaatsen van de map', () => {
  function admin(dir: string, paths: { doc: string; purchase: string }) {
    mkdirSync(dir, { recursive: true });
    const db = new Database(join(dir, 'boekhouding.sqlite'));
    db.exec('CREATE TABLE documents (id INTEGER PRIMARY KEY, file_path TEXT NOT NULL); CREATE TABLE purchase_invoices (id INTEGER PRIMARY KEY, attachment_path TEXT)');
    db.prepare('INSERT INTO documents (file_path) VALUES (?)').run(paths.doc);
    db.prepare('INSERT INTO purchase_invoices (attachment_path) VALUES (?)').run(paths.purchase);
    db.prepare('INSERT INTO purchase_invoices (attachment_path) VALUES (NULL)').run();
    db.close();
  }
  function read(dir: string) {
    const db = new Database(join(dir, 'boekhouding.sqlite'), { readonly: true });
    const doc = (db.prepare('SELECT file_path AS p FROM documents').get() as { p: string }).p;
    const purchase = (db.prepare('SELECT attachment_path AS p FROM purchase_invoices WHERE id = 1').get() as { p: string }).p;
    db.close();
    return { doc, purchase };
  }

  it('zet paden van de oude map (ook met backslashes) om voor hoofd- en extra administraties', () => {
    const root = mkdtempSync(join(tmpdir(), 'gb-rebase-'));
    admin(root, { doc: '/home/x/.config/gratis-boekhouden/bijlagen/2025/bon.pdf', purchase: 'C:\\Users\\x\\AppData\\Roaming\\gratis-boekhouden\\bijlagen\\2025\\f.pdf' });
    const sub = join(root, 'administraties', 'bv');
    admin(sub, { doc: '/oud/administraties/bv/bijlagen/2024/a.pdf', purchase: '/oud/administraties/bv/bijlagen/2024/b.pdf' });
    expect(rebaseDataDirAttachments(root)).toEqual([]);
    expect(read(root)).toEqual({ doc: join(root, 'bijlagen', '2025', 'bon.pdf'), purchase: join(root, 'bijlagen', '2025', 'f.pdf') });
    expect(read(sub)).toEqual({ doc: join(sub, 'bijlagen', '2024', 'a.pdf'), purchase: join(sub, 'bijlagen', '2024', 'b.pdf') });
  });

  it('is idempotent en laat paden zonder bijlagenmap met rust', () => {
    const root = mkdtempSync(join(tmpdir(), 'gb-rebase-'));
    admin(root, { doc: '/ergens/anders/bon.pdf', purchase: '/oud/bijlagen/2025/x.pdf' });
    rebaseDataDirAttachments(root);
    const first = read(root);
    rebaseDataDirAttachments(root);
    expect(read(root)).toEqual(first);
    expect(first.doc).toBe('/ergens/anders/bon.pdf');
  });

  it('slaat een kapotte database over en meldt hem, zonder de rest te blokkeren', () => {
    const root = mkdtempSync(join(tmpdir(), 'gb-rebase-'));
    admin(root, { doc: '/oud/bijlagen/1/a.pdf', purchase: '/oud/bijlagen/1/b.pdf' });
    mkdirSync(join(root, 'administraties', 'kapot'), { recursive: true });
    writeFileSync(join(root, 'administraties', 'kapot', 'boekhouding.sqlite'), 'geen database');
    expect(rebaseDataDirAttachments(root)).toEqual(['kapot']);
    expect(read(root).doc).toBe(join(root, 'bijlagen', '1', 'a.pdf'));
  });

  it('doet niets zonder administratie', () => {
    expect(rebaseDataDirAttachments(mkdtempSync(join(tmpdir(), 'gb-rebase-')))).toEqual([]);
  });
});
