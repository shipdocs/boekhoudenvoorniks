import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../src/db/database';
import { createBackupBundle, extractBundle, restoreCompleteBackup } from '../src/main/backup';
import { isAllowedAttachmentName, resolveOpenableAttachment } from '../src/main/attachments';

/** Bouwt een bundel met de hand (formaat van createBackupBundle), zodat er ook paden in kunnen die die zelf nooit maakt. */
function handBundel(paden: string[], dbBytes: Buffer): Buffer {
  const parts: Buffer[] = [Buffer.from('GBBUNDLE'), Buffer.from([1])];
  const count = Buffer.alloc(4);
  count.writeUInt32BE(paden.length + 1);
  parts.push(count);
  const entries: [string, Buffer][] = [['boekhouding.sqlite', dbBytes], ...paden.map((p): [string, Buffer] => [p, Buffer.from('x')])];
  for (const [pad, data] of entries) {
    const naam = Buffer.from(pad, 'utf8');
    const header = Buffer.alloc(12);
    header.writeUInt32BE(naam.length, 0);
    header.writeBigUInt64BE(BigInt(data.length), 4);
    parts.push(header, createHash('sha256').update(data).digest(), naam, data);
  }
  return Buffer.concat(parts);
}

const KWAAD = ['kwaad.exe', 'kwaad.bat', 'kwaad.desktop', 'kwaad.sh', 'kwaad.lnk', 'kwaad.js', 'dubbel.pdf.exe'];

describe('bijlagen: alleen toegestane extensies', () => {
  let dir = '';
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  async function bundleMetBijlagen() {
    dir = mkdtempSync(join(tmpdir(), 'gb-extensie-'));
    const bron = join(dir, 'bron');
    mkdirSync(join(bron, 'bijlagen', '2026'), { recursive: true });
    mkdirSync(join(bron, 'bijlagen', 'telefoon', 'abc'), { recursive: true });
    for (const naam of KWAAD) writeFileSync(join(bron, 'bijlagen', '2026', naam), 'x');
    writeFileSync(join(bron, 'bijlagen', '2026', 'bon.pdf'), 'pdf');
    writeFileSync(join(bron, 'bijlagen', '2026', 'FOTO.JPG'), 'jpg');
    writeFileSync(join(bron, 'bijlagen', 'telefoon', 'abc', '1.jpg'), 'jpg');
    const db = openDatabase(join(bron, 'boekhouding.sqlite'));
    const bundle = await createBackupBundle(db, bron);
    db.close();
    return bundle;
  }

  it('extractBundle slaat uitvoerbare bestanden over en schrijft de toegestane weg', async () => {
    const bundle = await bundleMetBijlagen();
    const uit = join(dir, 'uit');
    extractBundle(bundle, uit);
    for (const naam of KWAAD) expect(existsSync(join(uit, 'bijlagen', '2026', naam))).toBe(false);
    expect(existsSync(join(uit, 'bijlagen', '2026', 'bon.pdf'))).toBe(true);
    expect(existsSync(join(uit, 'bijlagen', '2026', 'FOTO.JPG'))).toBe(true);
    expect(existsSync(join(uit, 'bijlagen', 'telefoon', 'abc', '1.jpg'))).toBe(true);
    expect(existsSync(join(uit, 'boekhouding.sqlite'))).toBe(true);
  });

  it('een complete back-up terugzetten slaat ze ook over', async () => {
    const bundle = await bundleMetBijlagen();
    const doel = join(dir, 'doel');
    mkdirSync(doel);
    openDatabase(join(doel, 'boekhouding.sqlite')).close();
    restoreCompleteBackup(bundle, join(doel, 'boekhouding.sqlite'), doel);
    expect(existsSync(join(doel, 'bijlagen', '2026', 'kwaad.exe'))).toBe(false);
    expect(existsSync(join(doel, 'bijlagen', '2026', 'bon.pdf'))).toBe(true);
  });

  it('uitpakken en terugzetten accepteren alleen vaste entries en exact bijlagen/ (allowlist)', () => {
    dir = mkdtempSync(join(tmpdir(), 'gb-extensie-'));
    const dbPad = join(dir, 'leeg.sqlite');
    openDatabase(dbPad).close();
    const slecht = ['Bijlagen/kwaad.exe', 'bijlagen./kwaad.exe', 'elders/kwaad.exe', 'bijlagen/2026/kwaad.exe:bon.pdf', 'bijlagen/2026./bon.pdf', 'bijlagen/2026 /bon.pdf', 'bijlagen/2026/bon.pdf '];
    const goed = ['bijlagen/2026/bon.pdf', 'bijlagen/telefoon/abc/1.jpg'];
    const bundle = handBundel([...slecht, ...goed], readFileSync(dbPad));
    const uit = join(dir, 'uit');
    extractBundle(bundle, uit);
    const doel = join(dir, 'doel');
    mkdirSync(doel);
    openDatabase(join(doel, 'boekhouding.sqlite')).close();
    restoreCompleteBackup(bundle, join(doel, 'boekhouding.sqlite'), doel);
    for (const root of [uit, doel]) {
      const alles = readdirSync(root, { recursive: true, encoding: 'utf8' }).map((p) => p.split(sep).join('/'));
      expect(alles.filter((p) => /kwaad|elders/i.test(p))).toEqual([]);
      expect(alles.filter((p) => /^bijlagen\/2026[ .]/i.test(p) || /bon\.pdf $/.test(p))).toEqual([]);
      for (const pad of goed) expect(existsSync(join(root, ...pad.split('/')))).toBe(true);
      expect(existsSync(join(root, 'boekhouding.sqlite'))).toBe(true);
    }
  });

  it('openen weigert ADS-paden en componenten met afsluitende punt of spatie', () => {
    const admin = join(tmpdir(), 'gb-admin');
    for (const pad of ['bijlagen/2026/kwaad.exe:bon.pdf', 'bijlagen/2026./bon.pdf', 'bijlagen/2026/bon.pdf.', 'bijlagen/2026/bon.pdf ']) {
      expect(() => resolveOpenableAttachment(admin, pad)).toThrow(/niet geopend/);
    }
    expect(() => resolveOpenableAttachment('C:\\Admin', 'bijlagen/2026/kwaad.exe:bon.pdf', 'win32')).toThrow(/niet geopend/);
    expect(resolveOpenableAttachment('C:\\Admin', 'bijlagen/2026/bon.pdf', 'win32')).toBe('C:\\Admin\\bijlagen\\2026\\bon.pdf');
  });

  it('openen weigert een uitvoerbare bijlage en accepteert pdf en foto, ook in hoofdletters', () => {
    const admin = join(tmpdir(), 'gb-admin');
    expect(() => resolveOpenableAttachment(admin, 'bijlagen/2026/kwaad.exe')).toThrow(/niet geopend/);
    expect(() => resolveOpenableAttachment(admin, 'bijlagen/2026/kwaad.desktop')).toThrow(/niet geopend/);
    expect(() => resolveOpenableAttachment(admin, 'bijlagen/2026/bon.pdf.bat')).toThrow(/niet geopend/);
    expect(() => resolveOpenableAttachment(admin, '../buiten.pdf')).toThrow(/Alleen bijlagen/);
    for (const naam of ['bon.pdf', 'BON.PDF', 'foto.jpg']) expect(resolveOpenableAttachment(admin, `bijlagen/2026/${naam}`)).toBe(join(admin, 'bijlagen', '2026', naam));
    expect(isAllowedAttachmentName('factuur.xml')).toBe(true);
    expect(isAllowedAttachmentName('x.exe')).toBe(false);
  });
});
