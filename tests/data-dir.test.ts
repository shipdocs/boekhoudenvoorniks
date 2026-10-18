import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/database';
import { migrations } from '../src/db/migrations';
import { createServices, MemorySecretStore } from '../src/services';
import { isStoredAttachmentPath } from '../src/db/attachment-paths';
import { resolveAttachmentPath } from '../src/main/attachments';
import { rebaseAttachmentPaths } from '../src/main/backup';
import { administrationOnDisk } from './helpers';
import {
  CHOICE_FILE,
  DataDirError,
  handOverLocalState,
  MARKER,
  markComplete,
  MCP_CHOICE_PENDING,
  MIGRATION_LOCK,
  MIGRATION_STEPS,
  migrateToSharedDir,
  pointerFile,
  readPointer,
  resolveDataDir,
  resolveForMcp,
  sharedDataDir,
  STAGING,
  writeChoice,
  writePointer,
  type MigrationStep,
} from '../src/main/data-dir';

const NOW = () => new Date(2026, 9, 1, 12, 34, 56);
const STAMP = '20261001-123456';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Een nagebootste computer: thuismap en AppData. */
function machine() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gb-datadir-')));
  roots.push(root);
  const home = join(root, 'home');
  const appData = join(root, 'appdata');
  mkdirSync(home, { recursive: true });
  mkdirSync(appData, { recursive: true });
  return { root, home, appData, env: { home, appData }, shared: sharedDataDir(home), oldNew: join(appData, 'boekhoudenvoorniks'), oldOld: join(appData, 'gratis-boekhouden') };
}

/**
 * Een echte administratie met een aankoop (bijlage) en een ingelezen document, in `dir`. De bijlagepaden
 * staan er absoluut in, zoals een versie t/m 0.7.6 ze opsloeg.
 */
async function administration(dir: string, label: string): Promise<void> {
  mkdirSync(join(dir, 'bijlagen', '2026'), { recursive: true });
  const s = createServices(openDatabase(join(dir, 'boekhouding.sqlite')), {
    pdf: async () => Buffer.from('PDF'),
    mailerFactory: async () => ({ send: async () => ({ messageId: '<x@local>' }) }),
    secrets: new MemorySecretStore(),
    fetch: async () => {
      throw new Error('geen netwerk');
    },
    storeFile: async (name, data) => {
      const file = join(dir, 'bijlagen', '2026', name);
      writeFileSync(file, Buffer.from(data));
      return file;
    },
  });
  const attachment = join(dir, 'bijlagen', '2026', `bon-${label}.pdf`);
  writeFileSync(attachment, `bewijs ${label}`);
  s.purchases.create({ invoiceDate: '2026-09-20', description: `bon ${label}`, attachmentPath: attachment, lines: [{ account: 'WBedAlkOvr', netAmount: 1000, vatCode: 'geen', vatAmount: 0 }] });
  await s.intake.add(`scan-${label}.jpg`, new Uint8Array([1, 2, 3]), '2026-09-21');
  s.db.close();
}

/** Een oude gegevensmap zoals Electron hem achterlaat: twee administraties, back-ups, OCR-model en Chromium-resten. */
async function oldFolder(dir: string, label = 'a'): Promise<void> {
  await administration(dir, label);
  await administration(join(dir, 'administraties', 'klant'), `${label}-klant`);
  writeFileSync(join(dir, 'administratie.json'), JSON.stringify({ current: 'klant' }));
  mkdirSync(join(dir, 'backups'), { recursive: true });
  writeFileSync(join(dir, 'backups', 'boekhouding-2026-09-30.gbbackup'), 'backup');
  mkdirSync(join(dir, 'ocr'), { recursive: true });
  writeFileSync(join(dir, 'ocr', 'model.bin'), 'model');
  writeFileSync(join(dir, 'kantoor.json'), '{"k":1}');
  writeFileSync(join(dir, 'versie.txt'), '0.7.5');
  writeFileSync(join(dir, 'Local State'), `sleutel-${label}`);
  mkdirSync(join(dir, 'Cache'), { recursive: true });
  writeFileSync(join(dir, 'Cache', 'data_0'), 'cache');
  writeFileSync(join(dir, 'Preferences'), '{}');
}

/** Inhoud van een map als pad → hash (zonder de WAL-bestanden van SQLite). */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const item of readdirSync(d, { withFileTypes: true })) {
      const file = join(d, item.name);
      if (item.isDirectory()) walk(file);
      else if (!/-(wal|shm)$/.test(item.name)) out[relative(dir, file).split(sep).join('/')] = createHash('sha256').update(readFileSync(file)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

function attachmentPaths(dbFile: string): string[] {
  const db = new Database(dbFile, { readonly: true });
  try {
    return [
      ...(db.prepare('SELECT attachment_path AS p FROM purchase_invoices WHERE attachment_path IS NOT NULL').all() as { p: string }[]),
      ...(db.prepare('SELECT file_path AS p FROM documents WHERE file_path IS NOT NULL').all() as { p: string }[]),
    ].map((r) => r.p);
  } finally {
    db.close();
  }
}

/**
 * De bestanden van alle bijlagen van de administratie in `adminDir`, zoals de app ze vindt: de
 * administratie openen (paden uit een oudere versie worden dan relatief) en elk opgeslagen pad opzoeken.
 */
function openedAttachments(adminDir: string): string[] {
  const dbFile = join(adminDir, 'boekhouding.sqlite');
  openDatabase(dbFile, () => undefined).close();
  return attachmentPaths(dbFile).map((stored) => {
    expect(isStoredAttachmentPath(stored)).toBe(true);
    return resolveAttachmentPath(adminDir, stored);
  });
}

/** Alle tekstwaarden in alle tabellen die met `prefix` beginnen. */
function textValuesStartingWith(dbFile: string, prefix: string): string[] {
  const db = new Database(dbFile, { readonly: true });
  try {
    const hits: string[] = [];
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[];
    for (const { name } of tables) {
      for (const column of db.prepare(`SELECT name FROM pragma_table_info(?)`).all(name) as { name: string }[]) {
        const rows = db.prepare(`SELECT "${column.name}" AS v FROM "${name}" WHERE typeof("${column.name}") = 'text' AND "${column.name}" LIKE ? ESCAPE '~'`).all(`${prefix.replace(/[~%_]/g, '~$&')}%`) as { v: string }[];
        hits.push(...rows.map((r) => `${name}.${column.name}: ${r.v}`));
      }
    }
    return hits;
  } finally {
    db.close();
  }
}

function expectNothingMigrated(m: ReturnType<typeof machine>, source: string, before: Record<string, string>): void {
  expect(snapshot(source)).toEqual(before);
  expect(existsSync(join(m.shared, MARKER))).toBe(false);
  expect(existsSync(join(m.shared, STAGING))).toBe(false);
  expect(existsSync(join(m.shared, MIGRATION_LOCK))).toBe(false);
  // de app (en de koppeling) werken verder vanuit de oude map
  expect(resolveDataDir(m.env)).toEqual({ kind: 'oud', dir: source, target: m.shared });
}

describe('welke gegevensmap (app en koppeling)', () => {
  it('nieuwe installatie: de gedeelde map in de thuismap', () => {
    const m = machine();
    expect(resolveDataDir(m.env)).toEqual({ kind: 'nieuw', dir: m.shared });
    expect(existsSync(m.shared)).toBe(false); // kijken verandert niets
  });

  it('een eigen map uit de omgeving gaat voor alles', async () => {
    const m = machine();
    await administration(m.oldNew, 'a');
    expect(resolveDataDir({ ...m.env, env: '/ergens/anders' })).toEqual({ kind: 'env', dir: '/ergens/anders' });
  });

  it.each(['boekhoudenvoorniks', 'gratis-boekhouden'])('één oude map (%s): daaruit werken tot er is overgezet', async (name) => {
    const m = machine();
    await administration(join(m.appData, name), 'a');
    expect(resolveDataDir(m.env)).toEqual({ kind: 'oud', dir: join(m.appData, name), target: m.shared });
    expect(resolveForMcp(m.env)).toBe(join(m.appData, name));
  });

  it('twee oude mappen: geen stille keuze, de gebruiker kiest; de koppeling weigert tot die tijd', async () => {
    const m = machine();
    await oldFolder(m.oldNew, 'nieuw');
    await administration(m.oldOld, 'oud');
    const r = resolveDataDir(m.env);
    expect(r.kind).toBe('keuze');
    if (r.kind !== 'keuze') return;
    expect(r.candidates.map((c) => [c.name, c.administrationCount])).toEqual([['boekhoudenvoorniks', 2], ['gratis-boekhouden', 1]]);
    for (const c of r.candidates) {
      expect(c.size).toBeGreaterThan(0);
      expect(c.lastModified).toBe(Math.max(...[c.dir, join(c.dir, 'administraties', 'klant')].filter((d) => existsSync(join(d, 'boekhouding.sqlite'))).map((d) => statSync(join(d, 'boekhouding.sqlite')).mtimeMs)));
    }
    expect(() => resolveForMcp(m.env)).toThrow(MCP_CHOICE_PENDING);
    expect(existsSync(m.shared)).toBe(false);

    // de keuze van de gebruiker geldt daarna voor app en koppeling
    writeChoice(m.shared, m.oldOld);
    expect(resolveDataDir(m.env)).toEqual({ kind: 'oud', dir: m.oldOld, target: m.shared });
    expect(resolveForMcp(m.env)).toBe(m.oldOld);
    // een keuze voor een map die er niet (meer) is, telt niet
    writeFileSync(join(m.shared, CHOICE_FILE), join(m.appData, 'weg'));
    expect(resolveDataDir(m.env).kind).toBe('keuze');
  });

  it('de gedeelde map met marker wint van oude mappen', async () => {
    const m = machine();
    await administration(m.oldNew, 'a');
    await administration(m.shared, 'gedeeld');
    expect(resolveDataDir(m.env).kind).toBe('oud'); // zonder marker is de gedeelde map niet compleet
    markComplete(m.shared);
    expect(resolveDataDir(m.env)).toEqual({ kind: 'gedeeld', dir: m.shared });
    expect(resolveForMcp(m.env)).toBe(m.shared);
  });

  it('de koppeling opent nooit een lege administratie en maakt niets aan', () => {
    const m = machine();
    expect(() => resolveForMcp(m.env)).toThrow(DataDirError);
    expect(existsSync(m.shared)).toBe(false);
  });
});

describe('pointer naar een zelf gekozen map', () => {
  it('schrijven en lezen: app en koppeling openen de gekozen map', async () => {
    const m = machine();
    const own = join(m.root, 'eigen');
    await administration(own, 'eigen');
    markComplete(own);
    await administration(m.oldNew, 'a');
    expect(writePointer(m.home, own)).toBe(own);
    expect(readPointer(m.home)).toBe(own);
    expect(resolveDataDir(m.env)).toEqual({ kind: 'pointer', dir: own });
    expect(resolveForMcp(m.env)).toBe(own);
  });

  it('weigert een map zonder complete administratie', async () => {
    const m = machine();
    const own = join(m.root, 'eigen');
    await administration(own, 'eigen'); // geen marker
    expect(() => writePointer(m.home, own)).toThrow(DataDirError);
    expect(() => writePointer(m.home, 'relatief')).toThrow(DataDirError);
    expect(existsSync(pointerFile(m.home))).toBe(false);
  });

  it.each([
    ['onleesbaar', 'geen json'],
    ['onbekende versie', JSON.stringify({ version: 99, dataDir: '/x' })],
    ['geen map', JSON.stringify({ version: 1 })],
    ['relatieve map', JSON.stringify({ version: 1, dataDir: 'eigen' })],
    ['onbereikbare map', JSON.stringify({ version: 1, dataDir: '/bestaat/niet' })],
  ])('ongeldige pointer (%s): een duidelijke fout, nooit stil een lege administratie', async (_label, content) => {
    const m = machine();
    await administration(m.oldNew, 'a');
    writeFileSync(pointerFile(m.home), content);
    expect(() => resolveDataDir(m.env)).toThrow(DataDirError);
    expect(() => resolveForMcp(m.env)).toThrow(DataDirError);
  });

  it('een pointer naar een map zonder marker of database wordt geweigerd', async () => {
    const m = machine();
    const own = join(m.root, 'eigen');
    mkdirSync(own);
    writeFileSync(pointerFile(m.home), JSON.stringify({ version: 1, dataDir: own }));
    expect(() => resolveDataDir(m.env)).toThrow(/geen complete administratie/);
    await administration(own, 'eigen');
    expect(() => resolveDataDir(m.env)).toThrow(/geen complete administratie/);
    markComplete(own);
    expect(resolveDataDir(m.env)).toEqual({ kind: 'pointer', dir: own });
  });
});

describe('overzetten naar de gedeelde map', () => {
  it('kopieert ook een administratie van een nieuwere app zonder de brondatabase te wijzigen (#236)', async () => {
    const m = machine();
    const source = join(m.appData, 'boekhoudenvoorniks');
    mkdirSync(source, { recursive: true });
    const file = join(source, 'boekhouding.sqlite');
    const db = openDatabase(file);
    db.pragma(`user_version = ${migrations.length + 1}`);
    db.close();
    const before = readFileSync(file);

    const outcome = await migrateToSharedDir({ source, target: m.shared, now: NOW, keepSource: true });

    expect(outcome.status).toBe('gemigreerd');
    expect(readFileSync(file)).toEqual(before);
    const copied = new Database(join(m.shared, 'boekhouding.sqlite'), { readonly: true });
    expect(copied.pragma('user_version', { simple: true })).toBe(migrations.length + 1);
    copied.close();
  });

  it('keepSource: de oude map blijft onder zijn eigen naam staan (de Store-versie mag hem niet hernoemen)', async () => {
    const m = machine();
    const source = join(m.appData, 'boekhoudenvoorniks');
    await oldFolder(source);
    const before = snapshot(source);
    const outcome = await migrateToSharedDir({ source, target: m.shared, now: NOW, keepSource: true });
    expect(outcome.status).toBe('gemigreerd');
    if (outcome.status !== 'gemigreerd') return;
    expect(outcome.renamedSource).toBeNull();
    expect(outcome.warning).toBeNull();
    // de bron is onaangeroerd, en de kopie is compleet met marker
    expect(snapshot(source)).toEqual(before);
    expect(existsSync(join(m.shared, MARKER))).toBe(true);
    expect(existsSync(join(m.shared, 'boekhouding.sqlite'))).toBe(true);
    // een volgende start zet niet nog een keer over
    expect(resolveDataDir(m.env)).toEqual({ kind: 'gedeeld', dir: m.shared });
  });

  it.each(['boekhoudenvoorniks', 'gratis-boekhouden'])('zet alles over uit %s; de oude map blijft bewaard', async (name) => {
    const m = machine();
    const source = join(m.appData, name);
    await oldFolder(source);
    const before = snapshot(source);
    const progress: number[] = [];
    const outcome = await migrateToSharedDir({ source, target: m.shared, now: NOW, onProgress: (done, total) => progress.push(done / total) });

    expect(outcome.status).toBe('gemigreerd');
    if (outcome.status !== 'gemigreerd') return;
    expect(outcome.renamedSource).toBe(`${source}.gemigreerd-${STAMP}`);
    expect(outcome.movedAside).toBeNull();
    expect(outcome.databases).toEqual([
      { administration: '', missing: 0 },
      { administration: 'administraties/klant', missing: 0 },
    ]);
    expect(progress.at(-1)).toBe(1);

    // de bron is niet gewist: hij staat er nog, onder een andere naam en ongewijzigd
    expect(existsSync(source)).toBe(false);
    expect(snapshot(outcome.renamedSource!)).toEqual(before);

    // alles van ons is mee; de resten van Chromium niet
    for (const file of ['administratie.json', 'backups/boekhouding-2026-09-30.gbbackup', 'ocr/model.bin', 'kantoor.json', 'versie.txt', 'bijlagen/2026/bon-a.pdf', 'administraties/klant/bijlagen/2026/bon-a-klant.pdf']) {
      expect(readFileSync(join(m.shared, file))).toEqual(readFileSync(join(outcome.renamedSource!, file)));
    }
    for (const file of ['Cache', 'Preferences', 'Local State', STAGING, MIGRATION_LOCK]) expect(existsSync(join(m.shared, file))).toBe(false);

    // databases heel, en elke bijlage opent vanuit de nieuwe map
    for (const admin of [m.shared, join(m.shared, 'administraties', 'klant')]) {
      const db = new Database(join(admin, 'boekhouding.sqlite'), { readonly: true });
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      db.close();
      // het overzetten zelf herschrijft geen paden: in de kopie staat wat er in de bron stond
      expect(attachmentPaths(join(admin, 'boekhouding.sqlite'))).toEqual(attachmentPaths(join(admin.replace(m.shared, outcome.renamedSource!), 'boekhouding.sqlite')));
      const files = openedAttachments(admin);
      expect(files).toHaveLength(2);
      for (const file of files) {
        expect(file.startsWith(join(admin, 'bijlagen') + sep)).toBe(true);
        expect(existsSync(file)).toBe(true);
      }
      // guard: nergens in de database staat nog een pad naar de oude map
      expect(textValuesStartingWith(join(admin, 'boekhouding.sqlite'), m.appData)).toEqual([]);
    }

    // volgende starts gaan meteen naar de gedeelde map
    expect(existsSync(join(m.shared, MARKER))).toBe(true);
    expect(resolveDataDir(m.env)).toEqual({ kind: 'gedeeld', dir: m.shared });
    expect(resolveForMcp(m.env)).toBe(m.shared);
  });

  it('paden die al relatief zijn gaan ongewijzigd mee, en ook bij het openen daarna wordt er niets herschreven', async () => {
    const m = machine();
    const admins = [
      { rel: '', stored: await administrationOnDisk(m.oldNew, 'a'), label: 'a' },
      { rel: join('administraties', 'klant'), stored: await administrationOnDisk(join(m.oldNew, 'administraties', 'klant'), 'klant'), label: 'klant' },
    ];
    const outcome = await migrateToSharedDir({ source: m.oldNew, target: m.shared, now: NOW });
    expect(outcome.status).toBe('gemigreerd');

    for (const { rel, stored, label } of admins) {
      const admin = join(m.shared, rel);
      const dbFile = join(admin, 'boekhouding.sqlite');
      expect(attachmentPaths(dbFile).sort()).toEqual([stored.bon, stored.scan].sort());
      const log: string[] = [];
      openDatabase(dbFile, (message) => log.push(message)).close();
      expect(log).toEqual([]);
      expect(attachmentPaths(dbFile).sort()).toEqual([stored.bon, stored.scan].sort());
      // elke bijlage opent vanuit de nieuwe map
      expect(readFileSync(resolveAttachmentPath(admin, stored.bon), 'utf8')).toBe(`bewijs ${label}`);
      expect(readFileSync(resolveAttachmentPath(admin, stored.scan), 'utf8')).toBe(`scan ${label}`);
      expect(resolveAttachmentPath(admin, stored.bon).startsWith(join(admin, 'bijlagen') + sep)).toBe(true);
    }
  });

  it('neemt een database mee die nog open is (wijzigingen in de WAL)', async () => {
    const m = machine();
    await oldFolder(m.oldNew);
    const open = openDatabase(join(m.oldNew, 'boekhouding.sqlite'));
    open.prepare(`UPDATE purchase_invoices SET description = 'nog in de wal'`).run();
    const outcome = await migrateToSharedDir({ source: m.oldNew, target: m.shared, now: NOW });
    open.close();
    expect(outcome.status).toBe('gemigreerd');
    const db = new Database(join(m.shared, 'boekhouding.sqlite'), { readonly: true });
    expect(db.prepare('SELECT description FROM purchase_invoices').pluck().get()).toBe('nog in de wal');
    db.close();
  });

  it.each(MIGRATION_STEPS.filter((s) => s !== 'marker' && s !== 'hernoemen'))('afgebroken na stap "%s": er is niets veranderd en de volgende start lukt alsnog', async (failAt) => {
    const m = machine();
    await oldFolder(m.oldNew);
    const before = snapshot(m.oldNew);
    const outcome = await migrateToSharedDir({
      source: m.oldNew,
      target: m.shared,
      now: NOW,
      afterStep: (step: MigrationStep) => {
        if (step === failAt) throw new Error(`crash na ${step}`);
      },
    });
    expect(outcome).toEqual({ status: 'mislukt', reason: `crash na ${failAt}` });
    expectNothingMigrated(m, m.oldNew, before);

    const retry = await migrateToSharedDir({ source: m.oldNew, target: m.shared, now: NOW });
    expect(retry.status).toBe('gemigreerd');
    if (retry.status !== 'gemigreerd') return;
    expect(snapshot(retry.renamedSource!)).toEqual(before);
    for (const file of openedAttachments(m.shared)) expect(existsSync(file)).toBe(true);
    // wat een halve poging al had neergezet, is opzij gezet en niet weggegooid
    if (failAt === 'plaatsen') expect(existsSync(join(retry.movedAside!, 'boekhouding.sqlite'))).toBe(true);
    else expect(retry.movedAside).toBeNull();
  });

  it('resten van een gecrashte poging (staging en slot) worden opgeruimd; er is geen wachttijd of pid-regel', async () => {
    const m = machine();
    await oldFolder(m.oldNew);
    mkdirSync(join(m.shared, STAGING, 'bijlagen'), { recursive: true });
    writeFileSync(join(m.shared, STAGING, 'boekhouding.sqlite'), 'half');
    writeFileSync(join(m.shared, MIGRATION_LOCK), '1999-01-01T00:00:00Z');
    const outcome = await migrateToSharedDir({ source: m.oldNew, target: m.shared, now: NOW });
    expect(outcome.status).toBe('gemigreerd');
    expect(existsSync(join(m.shared, STAGING))).toBe(false);
    expect(existsSync(join(m.shared, MIGRATION_LOCK))).toBe(false);
    const db = new Database(join(m.shared, 'boekhouding.sqlite'), { readonly: true });
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    db.close();
  });

  it('een beschadigde kopie wordt niet in gebruik genomen', async () => {
    const m = machine();
    await oldFolder(m.oldNew);
    const before = snapshot(m.oldNew);
    const outcome = await migrateToSharedDir({
      source: m.oldNew,
      target: m.shared,
      now: NOW,
      afterStep: (step) => {
        if (step !== 'kopie') return;
        const staged = join(m.shared, STAGING, 'administraties', 'klant', 'boekhouding.sqlite');
        const bytes = readFileSync(staged);
        bytes.fill(0xff, 4096, bytes.length); // alles na de eerste pagina kapot
        writeFileSync(staged, bytes);
      },
    });
    expect(outcome.status).toBe('mislukt');
    expectNothingMigrated(m, m.oldNew, before);
  });

  it('te weinig vrije ruimte: niet beginnen', async () => {
    const m = machine();
    await oldFolder(m.oldNew);
    const before = snapshot(m.oldNew);
    const size = Object.keys(before).reduce((sum, f) => sum + statSync(join(m.oldNew, f)).size, 0);
    const outcome = await migrateToSharedDir({ source: m.oldNew, target: m.shared, now: NOW, freeSpace: () => Math.floor(size * 0.9) });
    expect(outcome.status).toBe('geen-ruimte');
    expect(existsSync(m.shared)).toBe(false);
    expectNothingMigrated(m, m.oldNew, before);
    // net genoeg (1,2× de gegevens) is wel genoeg
    expect((await migrateToSharedDir({ source: m.oldNew, target: m.shared, now: NOW, freeSpace: () => Math.ceil(size * 1.2) })).status).toBe('gemigreerd');
  });

  it('Stoppen tijdens het kopiëren: staging weg, bron intact, volgende keer opnieuw', async () => {
    const m = machine();
    await oldFolder(m.oldNew);
    const before = snapshot(m.oldNew);
    let copied = 0;
    const outcome = await migrateToSharedDir({ source: m.oldNew, target: m.shared, now: NOW, onProgress: () => copied++, shouldStop: () => copied >= 2 });
    expect(outcome.status).toBe('gestopt');
    expect(copied).toBe(2);
    expectNothingMigrated(m, m.oldNew, before);
    expect((await migrateToSharedDir({ source: m.oldNew, target: m.shared, now: NOW })).status).toBe('gemigreerd');
  });

  it('crash vlak na de marker: de gedeelde map is compleet en de bron staat er nog', async () => {
    const m = machine();
    await oldFolder(m.oldNew);
    const before = snapshot(m.oldNew);
    await expect(
      migrateToSharedDir({
        source: m.oldNew,
        target: m.shared,
        now: NOW,
        afterStep: (step) => {
          if (step === 'marker') throw new Error('crash na marker');
        },
      }),
    ).rejects.toThrow('crash na marker');
    expect(snapshot(m.oldNew)).toEqual(before);
    expect(resolveDataDir(m.env)).toEqual({ kind: 'gedeeld', dir: m.shared });
    for (const file of openedAttachments(m.shared)) expect(existsSync(file)).toBe(true);
  });

  it('de bron hernoemen lukt niet: de migratie is toch klaar, met een waarschuwing', async () => {
    const m = machine();
    await oldFolder(m.oldNew);
    const before = snapshot(m.oldNew);
    const outcome = await migrateToSharedDir({
      source: m.oldNew,
      target: m.shared,
      now: NOW,
      afterStep: (step) => {
        if (step === 'hernoemen') throw new Error('EBUSY');
      },
    });
    expect(outcome.status).toBe('gemigreerd');
    if (outcome.status !== 'gemigreerd') return;
    expect(outcome.renamedSource).toBeNull();
    expect(outcome.warning).toContain(m.oldNew);
    expect(snapshot(m.oldNew)).toEqual(before);
    expect(resolveDataDir(m.env)).toEqual({ kind: 'gedeeld', dir: m.shared });
  });

  it('bestaat de naam .gemigreerd-… al, dan komt er -2 achter', async () => {
    const m = machine();
    await oldFolder(m.oldNew);
    mkdirSync(`${m.oldNew}.gemigreerd-${STAMP}`);
    const outcome = await migrateToSharedDir({ source: m.oldNew, target: m.shared, now: NOW });
    expect(outcome.status === 'gemigreerd' && outcome.renamedSource).toBe(`${m.oldNew}.gemigreerd-${STAMP}-2`);
  });

  it('een onbekende administratie in het doel (zonder marker) gaat opzij en wordt nooit gewist', async () => {
    const m = machine();
    await oldFolder(m.oldNew);
    await administration(m.shared, 'onbekend');
    writeFileSync(join(m.shared, 'Local State'), 'sleutel-doel');
    const unknown = snapshot(m.shared);
    const outcome = await migrateToSharedDir({ source: m.oldNew, target: m.shared, now: NOW });
    expect(outcome.status).toBe('gemigreerd');
    if (outcome.status !== 'gemigreerd') return;
    expect(outcome.movedAside).toBe(join(m.shared, `.onbekend-${STAMP}`));
    const aside = snapshot(outcome.movedAside!);
    for (const file of Object.keys(unknown).filter((f) => f !== 'Local State')) expect(aside[file]).toBe(unknown[file]);
    // de sleutel van Chromium in het doel blijft van het doel
    expect(readFileSync(join(m.shared, 'Local State'), 'utf8')).toBe('sleutel-doel');
    const db = new Database(join(m.shared, 'boekhouding.sqlite'), { readonly: true });
    expect(db.prepare('SELECT description FROM purchase_invoices').pluck().get()).toBe('bon a');
    db.close();
  });

  it('twee oude mappen: alleen de gekozen map gaat over, de andere blijft onaangeroerd onder zijn eigen naam', async () => {
    const m = machine();
    await oldFolder(m.oldNew, 'nieuw');
    await oldFolder(m.oldOld, 'oud');
    const untouched = snapshot(m.oldNew);
    // annuleren = er gebeurt niets: geen keuze vastgelegd, de vraag komt de volgende keer weer
    expect(resolveDataDir(m.env).kind).toBe('keuze');
    expect(existsSync(m.shared)).toBe(false);

    writeChoice(m.shared, m.oldOld);
    const r = resolveDataDir(m.env);
    expect(r).toEqual({ kind: 'oud', dir: m.oldOld, target: m.shared });
    const outcome = await migrateToSharedDir({ source: m.oldOld, target: m.shared, now: NOW });
    expect(outcome.status).toBe('gemigreerd');
    expect(snapshot(m.oldNew)).toEqual(untouched);
    expect(existsSync(join(m.shared, CHOICE_FILE))).toBe(false);
    expect(resolveDataDir(m.env)).toEqual({ kind: 'gedeeld', dir: m.shared });
    const db = new Database(join(m.shared, 'boekhouding.sqlite'), { readonly: true });
    expect(db.prepare('SELECT description FROM purchase_invoices').pluck().get()).toBe('bon oud');
    db.close();
  });
});

describe('sleutel van de opgeslagen wachtwoorden (Local State)', () => {
  it('gaat vóór de start mee naar het doel, en overschrijft nooit een bestaande', async () => {
    const m = machine();
    await oldFolder(m.oldNew, 'bron');
    expect(handOverLocalState(m.oldNew, m.shared)).toBe(true);
    expect(readFileSync(join(m.shared, 'Local State'), 'utf8')).toBe('sleutel-bron');
    writeFileSync(join(m.shared, 'Local State'), 'eigen sleutel');
    expect(handOverLocalState(m.oldNew, m.shared)).toBe(false);
    expect(readFileSync(join(m.shared, 'Local State'), 'utf8')).toBe('eigen sleutel');
  });

  it('niet meer als het doel compleet is, en niet als de bron er geen heeft', async () => {
    const m = machine();
    await oldFolder(m.oldNew, 'bron');
    markComplete(m.shared);
    expect(handOverLocalState(m.oldNew, m.shared)).toBe(false);
    expect(existsSync(join(m.shared, 'Local State'))).toBe(false);
    const empty = machine();
    expect(handOverLocalState(empty.oldNew, empty.shared)).toBe(false);
    expect(existsSync(empty.shared)).toBe(false);
  });

  it('blijft leesbaar als het overzetten mislukt: de sleutel staat al in het doel en de bron is intact', async () => {
    const m = machine();
    await oldFolder(m.oldNew, 'bron');
    handOverLocalState(m.oldNew, m.shared);
    const outcome = await migrateToSharedDir({
      source: m.oldNew,
      target: m.shared,
      now: NOW,
      afterStep: (step) => {
        if (step === 'kopie') throw new Error('crash');
      },
    });
    expect(outcome.status).toBe('mislukt');
    expect(readFileSync(join(m.shared, 'Local State'), 'utf8')).toBe('sleutel-bron');
    expect(readFileSync(join(m.oldNew, 'Local State'), 'utf8')).toBe('sleutel-bron');
  });
});

describe('bijlagepaden uit een oudere versie relatief maken (oude back-ups)', () => {
  it('Windows-paden, paden van vóór de naamswijziging en ander hoofdlettergebruik; nog een keer draaien verandert niets', async () => {
    const m = machine();
    await administration(m.oldNew, 'a');
    const dbFile = join(m.oldNew, 'boekhouding.sqlite');
    const db = new Database(dbFile);
    const insert = db.prepare(`INSERT INTO documents (file_path, original_name, mime_type, sha256) VALUES (?, 'bon.pdf', 'application/pdf', ?)`);
    const variants = [
      'C:\\Users\\Piet\\AppData\\Roaming\\gratis-boekhouden\\bijlagen\\2026\\bon-a.pdf',
      'C:\\USERS\\PIET\\APPDATA\\ROAMING\\BOEKHOUDENVOORNIKS\\Bijlagen\\2026\\bon-a.pdf',
      '/home/piet/.config/gratis-boekhouden/bijlagen/2026/bon-a.pdf',
      '/home/piet/.config/gratis-boekhouden/bijlagen/2026/weg.pdf',
    ];
    variants.forEach((path, i) => insert.run(path, `hash-${i}`));
    db.close();

    const root = join(m.oldNew, 'bijlagen');
    const first = rebaseAttachmentPaths(dbFile, m.oldNew);
    // ook de aankoop en de scan van de administratie zelf stonden er absoluut in
    expect(first).toEqual({ rebased: 6, missing: 1 });
    const paths = attachmentPaths(dbFile);
    expect(paths.filter((p) => p === 'bijlagen/2026/bon-a.pdf')).toHaveLength(4); // de aankoop en drie varianten
    expect(paths).toContain('bijlagen/2026/weg.pdf');
    for (const p of paths) {
      expect(isStoredAttachmentPath(p)).toBe(true);
      expect(resolveAttachmentPath(m.oldNew, p).startsWith(root + sep)).toBe(true);
    }

    expect(rebaseAttachmentPaths(dbFile, m.oldNew)).toEqual({ rebased: 0, missing: 1 });
    expect(attachmentPaths(dbFile)).toEqual(paths);
  });

  it('een pad zonder bijlagenmap of met een onveilig vervolg blijft zoals het is', async () => {
    const m = machine();
    await administration(m.oldNew, 'a');
    const dbFile = join(m.oldNew, 'boekhouding.sqlite');
    const db = new Database(dbFile);
    db.prepare(`UPDATE purchase_invoices SET attachment_path = '/elders/bon.pdf'`).run();
    db.prepare(`UPDATE documents SET file_path = '/x/bijlagen/../../geheim.txt'`).run();
    db.close();
    expect(rebaseAttachmentPaths(dbFile, m.oldNew)).toEqual({ rebased: 0, missing: 0 });
    expect(attachmentPaths(dbFile).sort()).toEqual(['/elders/bon.pdf', '/x/bijlagen/../../geheim.txt']);
  });

  it('een oudere database zonder documententabel: de aankopen worden omgezet, er gaat niets mis', () => {
    const m = machine();
    mkdirSync(m.oldNew, { recursive: true });
    const dbFile = join(m.oldNew, 'oud.sqlite');
    const db = new Database(dbFile);
    db.exec(`CREATE TABLE purchase_invoices (id INTEGER PRIMARY KEY, attachment_path TEXT)`);
    db.prepare(`INSERT INTO purchase_invoices (attachment_path) VALUES (?)`).run('/home/piet/.config/gratis-boekhouden/bijlagen/2026/bon.pdf');
    db.close();
    expect(rebaseAttachmentPaths(dbFile, m.oldNew)).toEqual({ rebased: 1, missing: 1 });
    const check = new Database(dbFile, { readonly: true });
    expect(check.prepare(`SELECT attachment_path AS p FROM purchase_invoices`).pluck().get()).toBe('bijlagen/2026/bon.pdf');
    check.close();
  });

  it('een teken dat in kleine letters langer wordt (İ) vóór de bijlagenmap verschuift het pad niet', () => {
    const m = machine();
    mkdirSync(m.oldNew, { recursive: true });
    const dbFile = join(m.oldNew, 'oud.sqlite');
    const db = new Database(dbFile);
    db.exec(`CREATE TABLE purchase_invoices (id INTEGER PRIMARY KEY, attachment_path TEXT)`);
    db.prepare(`INSERT INTO purchase_invoices (attachment_path) VALUES (?)`).run('C:\\Users\\İpek\\AppData\\Roaming\\boekhoudenvoorniks\\Bijlagen\\2026\\bon.pdf');
    db.close();
    rebaseAttachmentPaths(dbFile, m.oldNew);
    const check = new Database(dbFile, { readonly: true });
    expect(check.prepare(`SELECT attachment_path AS p FROM purchase_invoices`).pluck().get()).toBe('bijlagen/2026/bon.pdf');
    check.close();
  });
});
