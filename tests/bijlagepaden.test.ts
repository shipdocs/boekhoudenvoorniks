import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, openReadonly } from '../src/db/database';
import { isStoredAttachmentPath, relativeAttachmentPath, relativizeAttachmentPaths } from '../src/db/attachment-paths';
import { createServices, MemorySecretStore } from '../src/services';
import { createApi, type HostContext } from '../src/main/api';
import { deleteAttachment, resolveAttachmentPath, saveAttachment } from '../src/main/attachments';
import { wipeDatabase } from '../src/main/reset';
import { seedDemo } from '../src/demo/demo';
import { administrationOnDisk } from './helpers';

const REFUSED = /Alleen bijlagen van de administratie/;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gb-bijlagepaden-')));
  roots.push(root);
  return root;
}

function servicesAt(dir: string, log: (message: string) => void = () => undefined) {
  mkdirSync(dir, { recursive: true });
  return createServices(openDatabase(join(dir, 'boekhouding.sqlite'), log), {
    pdf: async () => Buffer.from('%PDF'),
    mailerFactory: async () => ({ send: async () => ({ messageId: '<x@local>' }) }),
    secrets: new MemorySecretStore(),
    fetch: async () => { throw new Error('geen netwerk in tests'); },
    storeFile: async (name, data) => saveAttachment(dir, name, data),
    removeFile: (path) => deleteAttachment(dir, path),
    licensePublicKey: '',
  });
}

/** De api met een host zoals de app: bijlagen bewaren, lezen en openen in de map van de administratie. */
function apiAt(dir: string, s: ReturnType<typeof servicesAt>) {
  const opened: string[] = [];
  const saved: { name: string; content: Buffer }[] = [];
  const host = {
    appVersion: () => '9.9.9',
    storeAttachment: async (name: string, data: Uint8Array) => saveAttachment(dir, name, data),
    readAttachment: (path: string) => readFileSync(resolveAttachmentPath(dir, path)),
    openPath: async (path: string) => {
      opened.push(readFileSync(resolveAttachmentPath(dir, path), 'utf8'));
    },
    saveFile: async (name: string, content: Buffer | string) => {
      saved.push({ name, content: Buffer.from(content) });
      return join(dir, name);
    },
  } as unknown as HostContext;
  return { api: createApi(s, host), opened, saved };
}

function storedPaths(dbFile: string): { source: string; path: string }[] {
  const db = new Database(dbFile, { readonly: true });
  try {
    return [
      ...(db.prepare(`SELECT 'documents ' || id AS source, file_path AS path FROM documents ORDER BY id`).all() as { source: string; path: string }[]),
      ...(db.prepare(`SELECT 'purchase_invoices ' || id AS source, attachment_path AS path FROM purchase_invoices WHERE attachment_path IS NOT NULL ORDER BY id`).all() as { source: string; path: string }[]),
    ];
  } finally {
    db.close();
  }
}

/** Leest een ZIP terug via de centrale directory (onafhankelijk van de schrijver). */
function unzip(buf: Buffer): Map<string, Buffer> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const body = buf.subarray(dataStart, dataStart + size);
    out.set(name, method === 8 ? inflateRawSync(body) : Buffer.from(body));
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return out;
}

describe('opgeslagen bijlagepad: relatief aan de map van de administratie', () => {
  it.each([
    ['absoluut in de huidige map', '/home/piet/BoekhoudenVoorNiks/bijlagen/2026/bon.pdf', 'bijlagen/2026/bon.pdf'],
    ['absoluut in de map van vóór de naamswijziging', '/home/piet/.config/gratis-boekhouden/bijlagen/2026/bon.pdf', 'bijlagen/2026/bon.pdf'],
    ['een extra administratie', '/home/piet/BoekhoudenVoorNiks/administraties/klant/bijlagen/2025/bon.pdf', 'bijlagen/2025/bon.pdf'],
    ['Windows met backslashes', 'C:\\Users\\Piet\\AppData\\Roaming\\boekhoudenvoorniks\\bijlagen\\2026\\bon.pdf', 'bijlagen/2026/bon.pdf'],
    ['Windows met andere hoofdletters', 'c:\\USERS\\piet\\APPDATA\\Roaming\\BoekhoudenVoorNiks\\BIJLAGEN\\2026\\Bon Gamma.PDF', 'bijlagen/2026/Bon Gamma.PDF'],
    ['Windows, map van vóór de naamswijziging', 'C:\\Users\\Piet\\AppData\\Roaming\\gratis-boekhouden\\Bijlagen\\2026\\bon.pdf', 'bijlagen/2026/bon.pdf'],
    ['een teken dat in kleine letters langer wordt', 'C:\\Users\\İpek\\BoekhoudenVoorNiks\\Bijlagen\\2026\\bon.pdf', 'bijlagen/2026/bon.pdf'],
    ['een bijlagenmap in een bijlagenmap: de laatste telt', '/oud/bijlagen/kopie/bijlagen/2026/bon.pdf', 'bijlagen/2026/bon.pdf'],
    ['relatief met backslashes', 'Bijlagen\\2026\\bon.pdf', 'bijlagen/2026/bon.pdf'],
    ['al relatief', 'bijlagen/2026/bon.pdf', 'bijlagen/2026/bon.pdf'],
    ['al relatief, met een map die ook bijlagen heet', 'bijlagen/2026/bijlagen/bon.pdf', 'bijlagen/2026/bijlagen/bon.pdf'],
  ])('%s', (_label, stored, expected) => {
    expect(relativeAttachmentPath(stored)).toBe(expected);
    expect(isStoredAttachmentPath(expected)).toBe(true);
    // nog een keer omzetten verandert niets
    expect(relativeAttachmentPath(expected)).toBe(expected);
  });

  it.each([
    ['buiten een bijlagenmap', '/home/piet/Documenten/scan.pdf'],
    ['buiten een bijlagenmap (Windows)', 'C:\\Scans\\bon.pdf'],
    ['een map die er alleen op lijkt', '/home/piet/BoekhoudenVoorNiks/bijlagen-oud/bon.pdf'],
    ['een map die er alleen op lijkt (voor)', '/home/piet/BoekhoudenVoorNiks/oude-bijlagen/bon.pdf'],
    ['een onveilig vervolg', '/x/bijlagen/../../geheim.txt'],
    ['een onveilig vervolg met backslashes', 'C:\\x\\bijlagen\\..\\..\\geheim.txt'],
    ['een lege naam', '/x/bijlagen/'],
    ['dubbele schuine streep', '/x/bijlagen//bon.pdf'],
    ['alleen de map', 'bijlagen'],
    ['leeg', ''],
  ])('niet om te zetten: %s', (_label, stored) => {
    expect(relativeAttachmentPath(stored)).toBeNull();
    expect(isStoredAttachmentPath(stored)).toBe(false);
  });
});

describe('opgeslagen pad → bestand: één plek, alleen binnen bijlagen/ van de administratie', () => {
  const admin = '/home/piet/BoekhoudenVoorNiks';
  const winAdmin = 'C:\\Users\\Piet\\BoekhoudenVoorNiks';

  it('een relatief pad wijst naar de map van de administratie die open is', () => {
    expect(resolveAttachmentPath(admin, 'bijlagen/2026/bon.pdf', 'linux')).toBe('/home/piet/BoekhoudenVoorNiks/bijlagen/2026/bon.pdf');
    expect(resolveAttachmentPath(`${admin}/administraties/klant`, 'bijlagen/2026/bon.pdf', 'linux')).toBe('/home/piet/BoekhoudenVoorNiks/administraties/klant/bijlagen/2026/bon.pdf');
    // opgeslagen met `/`, op Windows opgezocht met `\`
    expect(resolveAttachmentPath(winAdmin, 'bijlagen/2026/bon.pdf', 'win32')).toBe('C:\\Users\\Piet\\BoekhoudenVoorNiks\\bijlagen\\2026\\bon.pdf');
    expect(resolveAttachmentPath(`${winAdmin}\\administraties\\klant`, 'bijlagen/2026/bon.pdf', 'win32')).toBe('C:\\Users\\Piet\\BoekhoudenVoorNiks\\administraties\\klant\\bijlagen\\2026\\bon.pdf');
  });

  it('een absoluut pad uit een oudere versie telt alleen als het in dezelfde bijlagenmap ligt', () => {
    expect(resolveAttachmentPath(admin, '/home/piet/BoekhoudenVoorNiks/bijlagen/2026/bon.pdf', 'linux')).toBe('/home/piet/BoekhoudenVoorNiks/bijlagen/2026/bon.pdf');
    expect(resolveAttachmentPath(winAdmin, 'c:\\users\\piet\\boekhoudenvoorniks\\Bijlagen\\2026\\bon.pdf', 'win32')).toBe('c:\\users\\piet\\boekhoudenvoorniks\\Bijlagen\\2026\\bon.pdf');
    for (const elsewhere of [
      '/home/piet/.config/gratis-boekhouden/bijlagen/2026/bon.pdf',
      '/home/piet/BoekhoudenVoorNiks/administraties/klant/bijlagen/2026/bon.pdf',
      '/home/piet/boekhoudenvoorniks/bijlagen/2026/bon.pdf',
      '/home/piet/BoekhoudenVoorNiks/bijlagen-oud/bon.pdf',
      '/home/piet/BoekhoudenVoorNiks/bijlagen/../boekhouding.sqlite',
      '/home/piet/BoekhoudenVoorNiks/boekhouding.sqlite',
      '/home/piet/BoekhoudenVoorNiks/bijlagen',
      '/etc/passwd',
      // een Windows-pad is op Linux geen bestand van deze computer
      'C:\\Users\\Piet\\BoekhoudenVoorNiks\\bijlagen\\2026\\bon.pdf',
    ]) {
      expect(() => resolveAttachmentPath(admin, elsewhere, 'linux'), elsewhere).toThrow(REFUSED);
    }
    for (const elsewhere of [
      'D:\\Users\\Piet\\BoekhoudenVoorNiks\\bijlagen\\2026\\bon.pdf',
      'C:\\Users\\Piet\\AppData\\Roaming\\boekhoudenvoorniks\\bijlagen\\2026\\bon.pdf',
      'C:\\Users\\Piet\\BoekhoudenVoorNiks\\bijlagen-oud\\bon.pdf',
      'C:\\Users\\Piet\\BoekhoudenVoorNiks\\bijlagen\\..\\boekhouding.sqlite',
      'C:\\Users\\Piet\\BoekhoudenVoorNiks\\administraties\\klant\\bijlagen\\bon.pdf',
      'C:\\Windows\\System32\\drivers\\etc\\hosts',
      '\\\\server\\deelmap\\bijlagen\\bon.pdf',
      'C:bijlagen\\bon.pdf',
      '/bijlagen/2026/bon.pdf',
    ]) {
      expect(() => resolveAttachmentPath(winAdmin, elsewhere, 'win32'), elsewhere).toThrow(REFUSED);
    }
  });

  it.each([
    'bijlagen/../boekhouding.sqlite',
    'bijlagen/2026/../../boekhouding.sqlite',
    'bijlagen/2026/../../../../../etc/passwd',
    '../bijlagen/2026/bon.pdf',
    '../../etc/passwd',
    'bijlagen/./bon.pdf',
    'bijlagen//bon.pdf',
    'bijlagen/',
    'bijlagen',
    'bijlagen-oud/bon.pdf',
    'Bijlagen/2026/bon.pdf',
    'backups/boekhouding-2026-09-30.gbbackup',
    'boekhouding.sqlite',
    'administraties/klant/bijlagen/2026/bon.pdf',
    'bijlagen\\2026\\bon.pdf',
    'bijlagen/..\\..\\boekhouding.sqlite',
    'bijlagen/2026/bon.pdf\0.jpg',
    './bijlagen/2026/bon.pdf',
    '',
  ])('weigert "%s" in de kolom, op Linux en op Windows', (smuggled) => {
    expect(() => resolveAttachmentPath(admin, smuggled, 'linux')).toThrow(REFUSED);
    expect(() => resolveAttachmentPath(winAdmin, smuggled, 'win32')).toThrow(REFUSED);
  });

  it('een pad dat niet in de opgeslagen vorm staat, telt nooit ten opzichte van de map waarin de app toevallig draait', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'bijlagen', '2026'), { recursive: true });
    writeFileSync(join(dir, 'bijlagen', '2026', 'bon.pdf'), 'bewijs');
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      for (const stored of ['./bijlagen/2026/bon.pdf', 'bijlagen/2026/../2026/bon.pdf', 'bijlagen//2026/bon.pdf', 'Bijlagen/../bijlagen/2026/bon.pdf']) {
        expect(() => resolveAttachmentPath(dir, stored), stored).toThrow(REFUSED);
      }
      expect(resolveAttachmentPath(dir, 'bijlagen/2026/bon.pdf')).toBe(join(dir, 'bijlagen', '2026', 'bon.pdf'));
    } finally {
      process.chdir(cwd);
    }
  });

  it('weigert iets anders dan tekst (de renderer geeft het pad door)', () => {
    for (const value of [null, undefined, 12, { path: 'bijlagen/x.pdf' }, ['bijlagen/x.pdf']]) {
      expect(() => resolveAttachmentPath(admin, value as unknown as string, 'linux')).toThrow(REFUSED);
    }
  });
});

describe('nieuwe bijlagen worden relatief opgeslagen', () => {
  it('bewaren: het bestand staat in bijlagen/<jaar>/ van de administratie, het pad dat terugkomt is relatief', () => {
    const dir = tempDir();
    const stored = saveAttachment(dir, '../../Bon Gamma (1).pdf', Buffer.from('bewijs'), new Date(2026, 9, 1, 12));
    expect(stored).toMatch(/^bijlagen\/2026\/2026-10-01-[0-9a-f]{8}-Bon_Gamma_1_\.pdf$/);
    expect(isStoredAttachmentPath(stored)).toBe(true);
    expect(readFileSync(resolveAttachmentPath(dir, stored), 'utf8')).toBe('bewijs');
    expect(resolveAttachmentPath(dir, stored)).toBe(join(dir, ...stored.split('/')));
    expect(() => saveAttachment(dir, 'virus.exe', Buffer.from('x'))).toThrow(/Alleen PDF/);
    expect(() => saveAttachment(dir, 'groot.pdf', new Uint8Array(20 * 1024 * 1024 + 1))).toThrow(/te groot/);
  });

  it('een net bewaarde bijlage weer weghalen: alleen het bestand in de bijlagenmap, nooit iets daarbuiten', () => {
    const dir = tempDir();
    const stored = saveAttachment(dir, 'bon.pdf', Buffer.from('bewijs'));
    const file = resolveAttachmentPath(dir, stored);
    writeFileSync(join(dir, 'boekhouding.sqlite'), 'de administratie');
    for (const outside of ['bijlagen/../boekhouding.sqlite', join(dir, 'boekhouding.sqlite'), '../' + stored, 'boekhouding.sqlite']) deleteAttachment(dir, outside);
    expect(readFileSync(join(dir, 'boekhouding.sqlite'), 'utf8')).toBe('de administratie');
    expect(existsSync(file)).toBe(true);
    deleteAttachment(dir, stored);
    expect(existsSync(file)).toBe(false);
    // nog een keer: het bestand is er niet meer, dat is geen fout
    expect(() => deleteAttachment(dir, stored)).not.toThrow();
  });

  it('een document dat niet vastgelegd kon worden laat geen los bestand achter', async () => {
    const dir = tempDir();
    const s = servicesAt(dir);
    // de database weigert het document (hier nagebootst): het net bewaarde bestand gaat weer weg
    s.db.exec(`CREATE TRIGGER test_weigeren BEFORE INSERT ON documents BEGIN SELECT RAISE(ABORT, 'niet vastgelegd'); END`);
    await expect(s.intake.add('scan.jpg', Buffer.from('scan'), '2026-09-21')).rejects.toThrow(/niet vastgelegd/);
    const year = join(dir, 'bijlagen', String(new Date().getFullYear()));
    expect(existsSync(year) ? readdirSync(year) : []).toEqual([]);
    s.db.close();
  });

  it('een ingelezen document, een bon bij een aankoop en een bon achteraf: overal het relatieve pad', async () => {
    const dir = tempDir();
    const s = servicesAt(dir);
    const { api, opened } = apiAt(dir, s);

    const doc = await api.documents.add('scan.jpg', Buffer.from('scan'));
    // zoals het scherm Aankopen: eerst de bon bewaren, dan de aankoop met het pad dat terugkwam
    const attached = await api.purchases.attach('bon.pdf', Buffer.from('bon bij aankoop'));
    const withBon = api.purchases.create({ invoiceDate: '2026-09-20', description: 'met bon', attachmentPath: attached, lines: [{ account: 'WBedAlkOvr', netAmount: 1000, vatCode: 'geen', vatAmount: 0 }] });
    const without = api.purchases.create({ invoiceDate: '2026-09-21', description: 'zonder bon', lines: [{ account: 'WBedAlkOvr', netAmount: 2000, vatCode: 'geen', vatAmount: 0 }] });
    const later = await api.documents.addPurchaseEvidence('later.jpg', Buffer.from('bon achteraf'), without.id);

    const paths = storedPaths(join(dir, 'boekhouding.sqlite'));
    expect(paths).toHaveLength(4);
    for (const { path } of paths) {
      expect(isStoredAttachmentPath(path)).toBe(true);
      expect(path.startsWith('bijlagen/')).toBe(true);
      expect(path).not.toContain(dir);
    }
    expect(s.purchases.get(withBon.id).attachment_path).toBe(attached);
    expect(s.purchases.get(without.id).attachment_path).toBe(later.file_path);

    // lezen (controleweergave) en openen gaan langs het opgeslagen pad
    expect(Buffer.from(api.documents.file(doc.id).base64, 'base64').toString()).toBe('scan');
    await api.app.openAttachment(s.purchases.get(withBon.id).attachment_path!);
    await api.app.openAttachment(s.purchases.get(without.id).attachment_path!);
    expect(opened).toEqual(['bon bij aankoop', 'bon achteraf']);
    await expect(api.app.openAttachment('bijlagen/../boekhouding.sqlite')).rejects.toThrow(REFUSED);
    await expect(api.app.openAttachment(join(dir, 'boekhouding.sqlite'))).rejects.toThrow(REFUSED);
    s.db.close();
  });
});

/**
 * Een gegevensmap uit een oudere versie: de eerste administratie en `administraties/klant`, elk met
 * bijlagepaden in alle vormen die in het wild voorkomen. Geeft per administratie de inhoud per bestand.
 */
function oldDataFolder(root: string): { dir: string; inside: { stored: string; file: string; content: string }[]; outside: string[] }[] {
  return ['', join('administraties', 'klant')].map((rel) => {
    const dir = join(root, rel);
    mkdirSync(join(dir, 'bijlagen', '2026'), { recursive: true });
    const db = openDatabase(join(dir, 'boekhouding.sqlite'), () => undefined);
    const sub = rel ? '\\administraties\\klant' : '';
    const inside = [
      { stored: join(dir, 'bijlagen', '2026', 'huidig.pdf'), file: 'huidig.pdf' },
      { stored: `/home/piet/.config/gratis-boekhouden${rel ? '/administraties/klant' : ''}/bijlagen/2026/oud-linux.pdf`, file: 'oud-linux.pdf' },
      { stored: `C:\\Users\\Piet\\AppData\\Roaming\\boekhoudenvoorniks${sub}\\bijlagen\\2026\\oud-windows.pdf`, file: 'oud-windows.pdf' },
      { stored: `c:\\USERS\\piet\\APPDATA\\Roaming\\BoekhoudenVoorNiks${sub.toUpperCase()}\\BIJLAGEN\\2026\\hoofdletters.pdf`, file: 'hoofdletters.pdf' },
      { stored: `C:\\Users\\Piet\\AppData\\Roaming\\gratis-boekhouden${sub}\\bijlagen\\2026\\oud-oud.pdf`, file: 'oud-oud.pdf' },
      { stored: 'bijlagen/2026/al-relatief.pdf', file: 'al-relatief.pdf' },
    ].map((a) => ({ ...a, content: `bewijs ${a.file} ${rel || 'eerste'}` }));
    const outside = ['/home/piet/Documenten/scan.pdf', 'C:\\Scans\\bon.pdf', '/x/bijlagen/../../geheim.txt'];
    const insert = db.prepare(`INSERT INTO documents (file_path, original_name, mime_type, sha256) VALUES (?, ?, 'application/pdf', ?)`);
    for (const a of inside) {
      writeFileSync(join(dir, 'bijlagen', '2026', a.file), a.content);
      insert.run(a.stored, a.file, `hash-${a.file}`);
    }
    outside.forEach((path, i) => insert.run(path, `buiten-${i}.pdf`, `hash-buiten-${i}`));
    // dezelfde paden bij aankopen (de andere kolom)
    const purchase = db.prepare(`INSERT INTO purchase_invoices (invoice_date, description, subtotal, vat_total, total, attachment_path) VALUES ('2026-09-20', ?, 1000, 0, 1000, ?)`);
    for (const a of inside) purchase.run(a.file, a.stored);
    purchase.run('buiten', outside[0]);
    purchase.run('zonder bon', null);
    db.close();
    return { dir, inside, outside };
  });
}

describe('bestaande administraties: bij het openen worden oude paden relatief', () => {
  it('na het openen opent elke bestaande bijlage, in de eerste administratie en in administraties/*', () => {
    for (const admin of oldDataFolder(tempDir())) {
      const dbFile = join(admin.dir, 'boekhouding.sqlite');
      const before = storedPaths(dbFile);
      const log: string[] = [];
      const db = openDatabase(dbFile, (message) => log.push(message));

      const read = (stored: string): string => readFileSync(resolveAttachmentPath(admin.dir, stored), 'utf8');
      const documents = db.prepare('SELECT original_name AS name, file_path AS path FROM documents').all() as { name: string; path: string }[];
      const purchases = db.prepare('SELECT description AS name, attachment_path AS path FROM purchase_invoices WHERE attachment_path IS NOT NULL').all() as { name: string; path: string }[];
      for (const a of admin.inside) {
        for (const row of [documents.find((d) => d.name === a.file)!, purchases.find((p) => p.name === a.file)!]) {
          expect(row.path).toBe(`bijlagen/2026/${a.file}`);
          expect(read(row.path)).toBe(a.content);
          expect(resolveAttachmentPath(admin.dir, row.path).startsWith(join(admin.dir, 'bijlagen') + sep)).toBe(true);
        }
      }
      // paden buiten bijlagen/: niet omgezet, niet weggegooid, wel gemeld
      const kept = [...documents, ...purchases].filter((row) => !isStoredAttachmentPath(row.path)).map((row) => row.path);
      expect(kept.sort()).toEqual([...admin.outside, admin.outside[0]!].sort());
      for (const path of admin.outside) {
        expect(log.some((line) => line.includes('blijft staan') && line.includes(path)), path).toBe(true);
        // zoals vóór de omzetting: de app opent alleen wat in de bijlagenmap ligt
        expect(() => resolveAttachmentPath(admin.dir, path)).toThrow(REFUSED);
      }
      // huidig.pdf, vier oude vormen: 5 documenten + 5 aankopen
      expect(log.filter((line) => line.includes('omgezet'))).toEqual(['10 bijlagepad(en) omgezet naar een pad binnen de map van de administratie']);
      expect(log).toHaveLength(1 + admin.outside.length + 1);
      // er is geen rij verdwenen en geen rij zonder pad bijgekomen
      expect(storedPaths(dbFile).map((row) => row.source)).toEqual(before.map((row) => row.source));
      db.close();
    }
  });

  it('nog een keer openen of omzetten verandert niets', () => {
    for (const admin of oldDataFolder(tempDir())) {
      const dbFile = join(admin.dir, 'boekhouding.sqlite');
      openDatabase(dbFile, () => undefined).close();
      const after = storedPaths(dbFile);

      const log: string[] = [];
      const db = openDatabase(dbFile, (message) => log.push(message));
      // deze verbinding heeft niets geschreven; alleen de paden buiten bijlagen/ zijn opnieuw gemeld
      expect(db.prepare('SELECT total_changes() AS n').get()).toEqual({ n: 0 });
      expect(log.filter((line) => line.includes('omgezet'))).toEqual([]);
      expect(log).toHaveLength(admin.outside.length + 1);
      const again = relativizeAttachmentPaths(db);
      expect(again.converted).toBe(0);
      expect(again.kept.map((k) => k.path).sort()).toEqual([...admin.outside, admin.outside[0]!].sort());
      expect(db.prepare('SELECT total_changes() AS n').get()).toEqual({ n: 0 });
      db.close();
      expect(storedPaths(dbFile)).toEqual(after);
    }
  });

  it('de koppeling (alleen lezen) verandert niets aan de paden', () => {
    const [admin] = oldDataFolder(tempDir());
    const dbFile = join(admin!.dir, 'boekhouding.sqlite');
    const before = storedPaths(dbFile);
    openReadonly(dbFile).close();
    expect(storedPaths(dbFile)).toEqual(before);
  });

  it('een oudere versie schreef na een downgrade weer een absoluut pad: de volgende keer openen zet het om', async () => {
    const dir = tempDir();
    const stored = await administrationOnDisk(dir, 'a');
    const old = new Database(join(dir, 'boekhouding.sqlite'));
    writeFileSync(join(dir, 'bijlagen', '2026', 'van-0.7.6.pdf'), 'bon uit de oudere versie');
    old.prepare(`INSERT INTO documents (file_path, original_name, mime_type, sha256) VALUES (?, 'van-0.7.6.pdf', 'application/pdf', 'hash-oud')`).run(join(dir, 'bijlagen', '2026', 'van-0.7.6.pdf'));
    old.close();

    const log: string[] = [];
    const db = openDatabase(join(dir, 'boekhouding.sqlite'), (message) => log.push(message));
    expect(log).toEqual(['1 bijlagepad(en) omgezet naar een pad binnen de map van de administratie']);
    const paths = (db.prepare('SELECT file_path AS p FROM documents ORDER BY id').all() as { p: string }[]).map((r) => r.p);
    db.close();
    expect(paths).toEqual([stored.scan, 'bijlagen/2026/van-0.7.6.pdf']);
    expect(readFileSync(resolveAttachmentPath(dir, paths[1]!), 'utf8')).toBe('bon uit de oudere versie');
  });

  it('lukt het omzetten niet, dan gaat de administratie toch open en opent de bijlage in de huidige map nog', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'bijlagen', '2026'), { recursive: true });
    const absolute = join(dir, 'bijlagen', '2026', 'bon.pdf');
    writeFileSync(absolute, 'bewijs');
    const setup = openDatabase(join(dir, 'boekhouding.sqlite'), () => undefined);
    setup.prepare(`INSERT INTO documents (file_path, original_name, mime_type, sha256) VALUES (?, 'bon.pdf', 'application/pdf', 'hash')`).run(absolute);
    setup.exec(`CREATE TRIGGER test_blokkade BEFORE UPDATE ON documents BEGIN SELECT RAISE(ABORT, 'schijf vol'); END`);
    setup.close();

    const log: string[] = [];
    const db = openDatabase(join(dir, 'boekhouding.sqlite'), (message) => log.push(message));
    expect(log).toEqual(['Bijlagepaden omzetten is niet gelukt: schijf vol']);
    const path = db.prepare('SELECT file_path FROM documents').pluck().get() as string;
    db.close();
    expect(path).toBe(absolute);
    expect(readFileSync(resolveAttachmentPath(dir, path), 'utf8')).toBe('bewijs');
  });
});

describe('verhuizen vraagt geen herschrijving', () => {
  it('de hele gegevensmap verplaatsen (hernoemen, andere schijf, andere computer): de bijlagen openen, er wordt niets geschreven', async () => {
    const root = tempDir();
    const from = join(root, 'BoekhoudenVoorNiks');
    const admins = [
      { rel: '', stored: await administrationOnDisk(from, 'a'), label: 'a' },
      { rel: join('administraties', 'klant'), stored: await administrationOnDisk(join(from, 'administraties', 'klant'), 'klant'), label: 'klant' },
    ];
    const to = join(root, 'een andere schijf', 'Mijn administratie');
    mkdirSync(join(root, 'een andere schijf'));
    renameSync(from, to);

    for (const { rel, stored, label } of admins) {
      const dir = join(to, rel);
      const log: string[] = [];
      const db = openDatabase(join(dir, 'boekhouding.sqlite'), (message) => log.push(message));
      expect(log).toEqual([]);
      expect(db.prepare('SELECT total_changes() AS n').get()).toEqual({ n: 0 });
      db.close();
      expect(storedPaths(join(dir, 'boekhouding.sqlite')).map((row) => row.path).sort()).toEqual([stored.bon, stored.scan].sort());
      expect(readFileSync(resolveAttachmentPath(dir, stored.bon), 'utf8')).toBe(`bewijs ${label}`);
      expect(readFileSync(resolveAttachmentPath(dir, stored.scan), 'utf8')).toBe(`scan ${label}`);
      expect(existsSync(join(from, rel))).toBe(false);
    }
  });
});

describe('pakket voor de boekhouder en wissen gebruiken de juiste bestanden', () => {
  it('pakket: bonnen met een relatief pad en met een pad uit een oudere versie komen erin; een ontbrekend bestand wordt gemeld', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'bijlagen', '2025'), { recursive: true });
    let s = servicesAt(dir);
    const { api: first } = apiAt(dir, s);
    const line = (netAmount: number) => [{ account: 'WBedAlkOvr', netAmount, vatCode: 'geen' as const, vatAmount: 0 }];
    // nieuw: relatief opgeslagen
    first.purchases.create({ invoiceDate: '2026-03-01', description: 'Nieuwe bon', attachmentPath: await first.purchases.attach('nieuw.pdf', Buffer.from('%PDF nieuw')), lines: line(1000) });
    // uit een oudere versie: absoluut, naar de map van vóór de naamswijziging
    writeFileSync(join(dir, 'bijlagen', '2025', 'oud.pdf'), '%PDF oud');
    first.purchases.create({ invoiceDate: '2026-03-02', description: 'Oude bon', attachmentPath: 'C:\\Users\\Piet\\AppData\\Roaming\\gratis-boekhouden\\bijlagen\\2025\\oud.pdf', lines: line(2000) });
    // het bestand is er niet meer
    first.purchases.create({ invoiceDate: '2026-03-03', description: 'Bon kwijt', attachmentPath: 'bijlagen/2026/kwijt.pdf', lines: line(3000) });
    // een pad buiten bijlagen/: wordt niet gelezen
    writeFileSync(join(dir, 'buiten.pdf'), 'hoort niet in het pakket');
    first.purchases.create({ invoiceDate: '2026-03-04', description: 'Bon buiten', attachmentPath: join(dir, 'buiten.pdf'), lines: line(4000) });
    s.db.close();

    // de app start opnieuw
    s = servicesAt(dir);
    const { api, saved } = apiAt(dir, s);
    const result = await api.exports.accountantPackage(2026);
    const files = unzip(saved[0]!.content);
    const inkoop = [...files.keys()].filter((f) => f.startsWith('documenten/inkoop/'));
    expect(inkoop.map((f) => files.get(f)!.toString()).sort()).toEqual(['%PDF nieuw', '%PDF oud']);
    expect(inkoop.every((f) => f.endsWith('.pdf'))).toBe(true);
    expect(result.summary.missingDocuments.map((m) => [m.description, m.reason]).sort()).toEqual([
      ['Bon buiten', 'bestand niet meer gevonden'],
      ['Bon kwijt', 'bestand niet meer gevonden'],
    ]);
    s.db.close();
  });

  it('wissen (demo): een bijlage met een relatief pad gaat weg; een pad naar buiten de bijlagenmap wordt niet aangeraakt', async () => {
    const dir = tempDir();
    const s = servicesAt(dir);
    seedDemo(s, '2026-09-26');
    const stored = saveAttachment(dir, 'demo.pdf', Buffer.from('x'));
    const line = [{ account: 'WBedAlkOvr', netAmount: 1000, vatCode: 'geen' as const, vatAmount: 0 }];
    s.purchases.create({ invoiceDate: '2026-09-20', description: 'bon', attachmentPath: stored, lines: line });
    const outside = join(dir, 'niet-van-de-app.txt');
    writeFileSync(outside, 'blijft');
    s.purchases.create({ invoiceDate: '2026-09-20', description: 'buiten', attachmentPath: outside, lines: line });
    s.purchases.create({ invoiceDate: '2026-09-20', description: 'omhoog', attachmentPath: 'bijlagen/../niet-van-de-app.txt', lines: line });

    expect(await wipeDatabase(s.db, join(dir, 'boekhouding.sqlite'), join(dir, 'backups'), join(dir, 'bijlagen'))).toBeNull();
    expect(existsSync(join(dir, ...stored.split('/')))).toBe(false);
    expect(readFileSync(outside, 'utf8')).toBe('blijft');
  });
});
