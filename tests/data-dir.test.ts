import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateDataDir } from '../src/main/data-dir';

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
