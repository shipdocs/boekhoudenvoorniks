import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join, relative, sep } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/database';
import { createServices, MemorySecretStore } from '../src/services';
import {
  chromiumDir,
  CHOICE_SESSION,
  MARKER,
  markComplete,
  MIGRATION_LOCK,
  planSwitch,
  pointerFile,
  resolveDataDir,
  resolveForMcp,
  sharedDataDir,
  STAGING,
  SWITCH_REQUEST,
  SWITCH_STEPS,
  switchDataDir,
  takeSwitchRequest,
  writePointer,
  writeSwitchRequest,
  type SwitchStep,
} from '../src/main/data-dir';
import { detectSyncService, type SyncContext } from '../src/main/sync-folders';
import { isStoredAttachmentPath } from '../src/db/attachment-paths';
import { resolveAttachmentPath } from '../src/main/attachments';
import { administrationOnDisk } from './helpers';

const NOW = () => new Date(2026, 9, 1, 12, 34, 56);
const STAMP = '20261001-123456';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      chmodSync(join(root, 'op-slot'), 0o755);
    } catch {
      /* deze test had geen map op slot */
    }
    rmSync(root, { recursive: true, force: true });
  }
});

/** Een nagebootste computer: thuismap, AppData en een andere schijf voor een eigen map. */
function machine() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gb-wissel-')));
  roots.push(root);
  const home = join(root, 'home');
  const appData = join(root, 'appdata');
  mkdirSync(home, { recursive: true });
  mkdirSync(appData, { recursive: true });
  const folder = (name: string): string => {
    mkdirSync(join(root, name), { recursive: true });
    return join(root, name);
  };
  return { root, home, appData, env: { home, appData }, shared: sharedDataDir(home), oldNew: join(appData, 'boekhoudenvoorniks'), folder };
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

/** Een gegevensmap in gebruik: twee administraties, back-ups, OCR-model en het kantoor. */
async function dataFolder(dir: string, label = 'a'): Promise<void> {
  await administration(dir, label);
  await administration(join(dir, 'administraties', 'klant'), `${label}-klant`);
  writeFileSync(join(dir, 'administratie.json'), JSON.stringify({ current: 'klant' }));
  mkdirSync(join(dir, 'backups'), { recursive: true });
  writeFileSync(join(dir, 'backups', 'boekhouding-2026-09-30.gbbackup'), 'backup');
  mkdirSync(join(dir, 'ocr'), { recursive: true });
  writeFileSync(join(dir, 'ocr', 'model.bin'), 'model');
  writeFileSync(join(dir, 'kantoor.json'), '{"k":1}');
  writeFileSync(join(dir, 'versie.txt'), '0.7.6');
}

/** Wat alleen in de standaardmap staat: Chromium (met de sleutel) en de eigen boekhouding van de map. */
const ONLY_IN_STANDARD = ['Local State', 'Cache', 'Preferences', 'declarative_performance_observer.db', MARKER, CHOICE_SESSION, '.onbekend-20260101-000000'];

/** De standaardmap zoals hij er na 0.7.6 uitziet: compleet, met Chromium erin. */
async function standardFolder(m: ReturnType<typeof machine>, label = 'a'): Promise<void> {
  await dataFolder(m.shared, label);
  writeFileSync(join(m.shared, 'Local State'), `sleutel-${label}`);
  mkdirSync(join(m.shared, 'Cache'), { recursive: true });
  writeFileSync(join(m.shared, 'Cache', 'data_0'), 'cache');
  writeFileSync(join(m.shared, 'Preferences'), '{}');
  writeFileSync(join(m.shared, 'declarative_performance_observer.db'), 'chromium');
  mkdirSync(join(m.shared, CHOICE_SESSION), { recursive: true });
  writeFileSync(join(m.shared, CHOICE_SESSION, 'Local State'), 'wegwerp');
  mkdirSync(join(m.shared, '.onbekend-20260101-000000'), { recursive: true });
  writeFileSync(join(m.shared, '.onbekend-20260101-000000', 'boekhouding.sqlite'), 'eerder opzij gezet');
  markComplete(m.shared);
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

function description(dir: string): unknown {
  const db = new Database(join(dir, 'boekhouding.sqlite'), { readonly: true });
  try {
    return db.prepare('SELECT description FROM purchase_invoices').pluck().get();
  } finally {
    db.close();
  }
}

function setDescription(dir: string, text: string): void {
  const db = new Database(join(dir, 'boekhouding.sqlite'));
  db.prepare('UPDATE purchase_invoices SET description = ?').run(text);
  db.close();
}

/**
 * Elke bijlage van elke administratie in `dir` opent vanuit die map zelf, zoals in de app: de
 * administratie openen (paden uit een oudere versie worden dan relatief) en elk opgeslagen pad opzoeken.
 */
function expectAttachmentsOpen(dir: string, elsewhere: string): void {
  for (const admin of [dir, join(dir, 'administraties', 'klant')]) {
    const db = new Database(join(admin, 'boekhouding.sqlite'), { readonly: true });
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    db.close();
    openDatabase(join(admin, 'boekhouding.sqlite'), () => undefined).close();
    const paths = attachmentPaths(join(admin, 'boekhouding.sqlite'));
    expect(paths).toHaveLength(2);
    for (const p of paths) {
      expect(isStoredAttachmentPath(p)).toBe(true);
      const file = resolveAttachmentPath(admin, p);
      expect(file.startsWith(join(admin, 'bijlagen') + sep)).toBe(true);
      expect(existsSync(file)).toBe(true);
    }
    // guard: nergens in de database staat nog een pad naar de map waar hij vandaan komt
    expect(textValuesStartingWith(join(admin, 'boekhouding.sqlite'), elsewhere + sep)).toEqual([]);
  }
}

/** De map die de app opent. */
function openDir(m: ReturnType<typeof machine>): string {
  const resolution = resolveDataDir(m.env);
  if (resolution.kind === 'keuze') throw new Error('er is nog geen map gekozen');
  return resolution.dir;
}

/** De app en de koppeling openen allebei `dir`. */
function expectBothOpen(m: ReturnType<typeof machine>, dir: string): void {
  expect(openDir(m)).toBe(dir);
  expect(resolveForMcp(m.env)).toBe(dir);
}

/** Er is niet gewisseld: de huidige map is ongewijzigd en app en koppeling werken er nog uit. */
function expectNotSwitched(m: ReturnType<typeof machine>, current: string, before: Record<string, string>, pointerBefore: string | null = null): void {
  expect(snapshot(current)).toEqual(before);
  expect(existsSync(pointerFile(m.home)) ? readFileSync(pointerFile(m.home), 'utf8') : null).toBe(pointerBefore);
  expectBothOpen(m, current);
}

describe('een map kiezen: wat kan en wat niet', () => {
  it('een lege map: de huidige gegevens gaan erheen; kijken laat niets achter', async () => {
    const m = machine();
    await standardFolder(m);
    const target = m.folder('eigen');
    expect(planSwitch({ home: m.home, current: m.shared, chosen: target })).toEqual({ dir: target, action: 'kopieren', problem: null, sync: null, existing: null, standard: false });
    expect(readdirSync(target)).toEqual([]);
  });

  it('resten van een eigen afgebroken poging en bestanden van het besturingssysteem tellen niet als inhoud', async () => {
    const m = machine();
    await standardFolder(m);
    const target = m.folder('eigen');
    mkdirSync(join(target, STAGING));
    writeFileSync(join(target, STAGING, 'boekhouding.sqlite'), 'half');
    writeFileSync(join(target, MIGRATION_LOCK), '1999-01-01T00:00:00Z');
    for (const name of ['.DS_Store', 'Thumbs.db', 'desktop.ini']) writeFileSync(join(target, name), '');
    expect(planSwitch({ home: m.home, current: m.shared, chosen: target })).toMatchObject({ action: 'kopieren', problem: null });
    const outcome = await switchDataDir({ home: m.home, source: m.shared, target, action: 'kopieren', now: NOW });
    expect(outcome.status).toBe('gewisseld');
    expect(existsSync(join(target, STAGING))).toBe(false);
    expect(existsSync(join(target, MIGRATION_LOCK))).toBe(false);
    expectBothOpen(m, target);
  });

  it('een map met een complete administratie: die wordt geopend, met wat erin staat erbij', async () => {
    const m = machine();
    await standardFolder(m);
    const target = m.folder('eigen');
    await dataFolder(target, 'eigen');
    markComplete(target);
    const plan = planSwitch({ home: m.home, current: m.shared, chosen: target });
    expect(plan).toMatchObject({ dir: target, action: 'openen', problem: null, standard: false });
    expect(plan.existing?.administrationCount).toBe(2);
    expect(plan.existing?.size).toBeGreaterThan(0);
    expect(plan.existing?.lastModified).toBeGreaterThan(0);
  });

  it.skipIf(process.platform === 'win32')('een snelkoppeling naar een map: het echte pad telt', async () => {
    const m = machine();
    await standardFolder(m);
    const target = m.folder('eigen');
    symlinkSync(target, join(m.root, 'link'));
    expect(planSwitch({ home: m.home, current: m.shared, chosen: join(m.root, 'link') })).toMatchObject({ dir: target, problem: null });
    // ook een omweg naar de huidige map is de huidige map
    symlinkSync(m.shared, join(m.root, 'omweg'));
    expect(planSwitch({ home: m.home, current: m.shared, chosen: join(m.root, 'omweg') }).problem).toMatch(/nu al gebruikt/);
  });

  const invalid: [string, (m: ReturnType<typeof machine>) => Promise<string> | string, RegExp][] = [
    ['geen volledig pad', () => 'eigen', /volledige map/],
    ['een map die niet bestaat', (m) => join(m.root, 'bestaat-niet'), /niet bereikbaar/],
    ['een bestand in plaats van een map', (m) => (writeFileSync(join(m.root, 'bestand.txt'), 'x'), join(m.root, 'bestand.txt')), /is geen map/],
    ['de map die je al gebruikt', (m) => m.shared, /nu al gebruikt/],
    ['een map in de huidige gegevensmap', (m) => m.folder(join('home', 'BoekhoudenVoorNiks', 'nieuw')), /in je huidige gegevensmap/],
    ['een map met andere bestanden', (m) => (writeFileSync(join(m.folder('vol'), 'vakantie.jpg'), 'foto'), join(m.root, 'vol')), /staan al andere bestanden/],
    ['een map met een lege submap', (m) => (m.folder(join('vol', 'leeg')), join(m.root, 'vol')), /staan al andere bestanden/],
    ['een administratie zonder marker', async (m) => (await administration(m.folder('half'), 'half'), join(m.root, 'half')), /niet compleet/],
    ['alleen een marker, geen administratie', (m) => (markComplete(m.folder('kaal')), join(m.root, 'kaal')), /staan al andere bestanden/],
  ];
  it.each(invalid)('ongeldige keuze (%s): een duidelijke melding, en er verandert niets', async (_label, make, message) => {
    const m = machine();
    await standardFolder(m);
    const before = snapshot(m.shared);
    const chosen = await make(m);
    const there = existsSync(chosen) && !chosen.endsWith('.txt') && chosen !== m.shared ? snapshot(chosen) : null;
    const plan = planSwitch({ home: m.home, current: m.shared, chosen });
    expect(plan.problem).toMatch(message);
    // ook als het verzoek toch wordt uitgevoerd: geweigerd, geen verwijzing, nooit een lege administratie
    for (const action of ['kopieren', 'openen'] as const) {
      const outcome = await switchDataDir({ home: m.home, source: m.shared, target: chosen, action, now: NOW });
      expect(outcome.status).toBe('geweigerd');
      expect(outcome.status === 'geweigerd' && outcome.reason).toMatch(message);
    }
    expectNotSwitched(m, m.shared, before);
    if (there) expect(snapshot(chosen)).toEqual(there);
  });

  it('te weinig vrije ruimte: een duidelijke melding vóór er iets gebeurt', async () => {
    const m = machine();
    await standardFolder(m);
    const before = snapshot(m.shared);
    const target = m.folder('eigen');
    expect(planSwitch({ home: m.home, current: m.shared, chosen: target, freeSpace: () => 1000 }).problem).toMatch(/te weinig ruimte/);
    const outcome = await switchDataDir({ home: m.home, source: m.shared, target, action: 'kopieren', now: NOW, freeSpace: () => 1000 });
    expect(outcome).toMatchObject({ status: 'geweigerd' });
    expect(readdirSync(target)).toEqual([]);
    expectNotSwitched(m, m.shared, before);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('een map waarin de app niet mag schrijven', async () => {
    const m = machine();
    await standardFolder(m);
    const before = snapshot(m.shared);
    const target = m.folder('op-slot');
    chmodSync(target, 0o555);
    expect(planSwitch({ home: m.home, current: m.shared, chosen: target }).problem).toMatch(/mag niet schrijven/);
    expect((await switchDataDir({ home: m.home, source: m.shared, target, action: 'kopieren', now: NOW })).status).toBe('geweigerd');
    expectNotSwitched(m, m.shared, before);
  });

  it('de map is veranderd tussen kiezen en uitvoeren: er gebeurt niets', async () => {
    const m = machine();
    await standardFolder(m);
    const before = snapshot(m.shared);
    // gekozen als complete administratie, maar de marker is intussen weg
    const complete = m.folder('compleet');
    await dataFolder(complete, 'eigen');
    expect((await switchDataDir({ home: m.home, source: m.shared, target: complete, action: 'openen', now: NOW })).status).toBe('geweigerd');
    // gekozen als lege map, maar er staat intussen een complete administratie
    markComplete(complete);
    const there = snapshot(complete);
    const outcome = await switchDataDir({ home: m.home, source: m.shared, target: complete, action: 'kopieren', now: NOW });
    expect(outcome.status === 'geweigerd' && outcome.reason).toMatch(/veranderd sinds je hem koos/);
    expect(snapshot(complete)).toEqual(there);
    expectNotSwitched(m, m.shared, before);
  });
});

describe('wisselen naar een lege map', () => {
  it('kopieert alles, de huidige map blijft staan zoals hij is, en app en koppeling openen de nieuwe map', async () => {
    const m = machine();
    await standardFolder(m);
    const before = snapshot(m.shared);
    const target = m.folder('eigen');
    const progress: number[] = [];
    const outcome = await switchDataDir({ home: m.home, source: m.shared, target, action: 'kopieren', now: NOW, onProgress: (done, total) => progress.push(done / total) });

    expect(outcome).toEqual({
      status: 'gewisseld',
      dir: target,
      action: 'kopieren',
      movedAside: null,
      databases: [
        { administration: '', missing: 0 },
        { administration: 'administraties/klant', missing: 0 },
      ],
    });
    expect(progress.at(-1)).toBe(1);

    // de huidige map is niet gewist, niet hernoemd en niet veranderd
    expect(snapshot(m.shared)).toEqual(before);
    expect(readdirSync(join(m.shared, '..')).filter((name) => name.includes('gemigreerd'))).toEqual([]);

    // alles van de administratie is mee; Chromium en de boekhouding van de standaardmap niet
    for (const file of ['administratie.json', 'backups/boekhouding-2026-09-30.gbbackup', 'ocr/model.bin', 'kantoor.json', 'versie.txt', 'bijlagen/2026/bon-a.pdf', 'administraties/klant/bijlagen/2026/bon-a-klant.pdf']) {
      expect(readFileSync(join(target, file))).toEqual(readFileSync(join(m.shared, file)));
    }
    for (const name of [...ONLY_IN_STANDARD.filter((n) => n !== MARKER), STAGING, MIGRATION_LOCK, SWITCH_REQUEST]) expect(existsSync(join(target, name))).toBe(false);
    expect(existsSync(join(target, MARKER))).toBe(true);

    // bijlagen openen vanuit de nieuwe map, voor elke administratie
    expectAttachmentsOpen(target, m.shared);

    // één regel voor app en koppeling: allebei de gekozen map, met dezelfde administratie
    expect(resolveDataDir(m.env)).toEqual({ kind: 'pointer', dir: target });
    expect(resolveForMcp(m.env)).toBe(target);
    expect(description(resolveForMcp(m.env))).toBe('bon a');
  });

  it('een database die nog open is gaat compleet mee (wijzigingen in de WAL)', async () => {
    const m = machine();
    await standardFolder(m);
    const target = m.folder('eigen');
    const open = openDatabase(join(m.shared, 'boekhouding.sqlite'));
    open.prepare(`UPDATE purchase_invoices SET description = 'nog in de wal'`).run();
    const outcome = await switchDataDir({ home: m.home, source: m.shared, target, action: 'kopieren', now: NOW });
    open.close();
    expect(outcome.status).toBe('gewisseld');
    expect(description(target)).toBe('nog in de wal');
  });

  it.each(SWITCH_STEPS.filter((s) => s !== 'marker' && s !== 'pointer'))('afgebroken na stap "%s": de verwijzing is niet geschreven en je werkt verder vanuit de huidige map', async (failAt) => {
    const m = machine();
    await standardFolder(m);
    const before = snapshot(m.shared);
    const target = m.folder('eigen');
    const outcome = await switchDataDir({
      home: m.home,
      source: m.shared,
      target,
      action: 'kopieren',
      now: NOW,
      afterStep: (step: SwitchStep) => {
        if (step === failAt) throw new Error(`crash na ${step}`);
      },
    });
    expect(outcome).toEqual({ status: 'mislukt', reason: `crash na ${failAt}` });
    expectNotSwitched(m, m.shared, before);
    expect(existsSync(join(target, MARKER))).toBe(false);
    expect(existsSync(join(target, STAGING))).toBe(false);
    expect(existsSync(join(target, MIGRATION_LOCK))).toBe(false);

    if (failAt === 'plaatsen') {
      // de kopie stond er al, maar zonder marker: die map wordt niet stil in gebruik genomen en niet gewist
      const half = snapshot(target);
      const retry = await switchDataDir({ home: m.home, source: m.shared, target, action: 'kopieren', now: NOW });
      expect(retry.status === 'geweigerd' && retry.reason).toMatch(/niet compleet/);
      expect(snapshot(target)).toEqual(half);
      expectNotSwitched(m, m.shared, before);
      const other = m.folder('eigen-2');
      expect((await switchDataDir({ home: m.home, source: m.shared, target: other, action: 'kopieren', now: NOW })).status).toBe('gewisseld');
      expectBothOpen(m, other);
      return;
    }
    // dezelfde map opnieuw kiezen lukt alsnog
    expect(readdirSync(target)).toEqual([]);
    const retry = await switchDataDir({ home: m.home, source: m.shared, target, action: 'kopieren', now: NOW });
    expect(retry.status).toBe('gewisseld');
    expect(snapshot(m.shared)).toEqual(before);
    expectAttachmentsOpen(target, m.shared);
    expectBothOpen(m, target);
  });

  it('crash vlak na de marker: de nieuwe map is compleet, maar zonder verwijzing werk je verder vanuit de huidige', async () => {
    const m = machine();
    await standardFolder(m);
    const before = snapshot(m.shared);
    const target = m.folder('eigen');
    await expect(
      switchDataDir({
        home: m.home,
        source: m.shared,
        target,
        action: 'kopieren',
        now: NOW,
        afterStep: (step) => {
          if (step === 'marker') throw new Error('crash na marker');
        },
      }),
    ).rejects.toThrow('crash na marker');
    expectNotSwitched(m, m.shared, before);
    // de kopie is een complete administratie: opnieuw kiezen opent hem
    expect(planSwitch({ home: m.home, current: m.shared, chosen: target })).toMatchObject({ action: 'openen', problem: null });
    expect((await switchDataDir({ home: m.home, source: m.shared, target, action: 'openen', now: NOW })).status).toBe('gewisseld');
    expectAttachmentsOpen(target, m.shared);
    expectBothOpen(m, target);
  });

  it('crash vlak na het schrijven van de verwijzing: het wisselen is klaar', async () => {
    const m = machine();
    await standardFolder(m);
    const before = snapshot(m.shared);
    const target = m.folder('eigen');
    await expect(
      switchDataDir({
        home: m.home,
        source: m.shared,
        target,
        action: 'kopieren',
        now: NOW,
        afterStep: (step) => {
          if (step === 'pointer') throw new Error('crash na pointer');
        },
      }),
    ).rejects.toThrow('crash na pointer');
    expect(snapshot(m.shared)).toEqual(before);
    expectAttachmentsOpen(target, m.shared);
    expectBothOpen(m, target);
  });

  it('de verwijzing staat er pas als de marker er staat', async () => {
    const m = machine();
    await standardFolder(m);
    const target = m.folder('eigen');
    const seen: [SwitchStep, boolean, boolean][] = [];
    await switchDataDir({ home: m.home, source: m.shared, target, action: 'kopieren', now: NOW, afterStep: (step) => seen.push([step, existsSync(join(target, MARKER)), existsSync(pointerFile(m.home))]) });
    expect(seen).toEqual([
      ['ruimte', false, false],
      ['slot', false, false],
      ['kopie', false, false],
      ['controle', false, false],
      ['paden', false, false],
      ['plaatsen', false, false],
      ['marker', true, false],
      ['pointer', true, true],
    ]);
  });

  it('Stoppen tijdens het kopiëren: de gekozen map is weer leeg en er is niets veranderd', async () => {
    const m = machine();
    await standardFolder(m);
    const before = snapshot(m.shared);
    const target = m.folder('eigen');
    let copied = 0;
    const outcome = await switchDataDir({ home: m.home, source: m.shared, target, action: 'kopieren', now: NOW, onProgress: () => copied++, shouldStop: () => copied >= 2 });
    expect(outcome.status).toBe('gestopt');
    expect(readdirSync(target)).toEqual([]);
    expectNotSwitched(m, m.shared, before);
  });

  it('de schijf raakt vol tijdens het kopiëren: niets veranderd', async () => {
    const m = machine();
    await standardFolder(m);
    const before = snapshot(m.shared);
    const target = m.folder('eigen');
    let copied = 0;
    const outcome = await switchDataDir({
      home: m.home,
      source: m.shared,
      target,
      action: 'kopieren',
      now: NOW,
      onProgress: () => {
        if (++copied === 3) throw new Error('ENOSPC: no space left on device, copyfile');
      },
    });
    expect(outcome).toEqual({ status: 'mislukt', reason: 'ENOSPC: no space left on device, copyfile' });
    expect(readdirSync(target)).toEqual([]);
    expectNotSwitched(m, m.shared, before);
  });

  it('een beschadigde kopie wordt niet in gebruik genomen', async () => {
    const m = machine();
    await standardFolder(m);
    const before = snapshot(m.shared);
    const target = m.folder('eigen');
    const outcome = await switchDataDir({
      home: m.home,
      source: m.shared,
      target,
      action: 'kopieren',
      now: NOW,
      afterStep: (step) => {
        if (step !== 'kopie') return;
        const staged = join(target, STAGING, 'administraties', 'klant', 'boekhouding.sqlite');
        const bytes = readFileSync(staged);
        bytes.fill(0xff, 4096, bytes.length); // alles na de eerste pagina kapot
        writeFileSync(staged, bytes);
      },
    });
    expect(outcome.status).toBe('mislukt');
    expect(readdirSync(target)).toEqual([]);
    expectNotSwitched(m, m.shared, before);
  });

  it('van de ene eigen map naar de andere: de verwijzing blijft naar de oude wijzen tot de nieuwe compleet is', async () => {
    const m = machine();
    await standardFolder(m);
    const first = m.folder('eerste');
    expect((await switchDataDir({ home: m.home, source: m.shared, target: first, action: 'kopieren', now: NOW })).status).toBe('gewisseld');
    setDescription(first, 'verder gewerkt in de eerste map');
    const before = snapshot(first);
    const pointer = readFileSync(pointerFile(m.home), 'utf8');
    const second = m.folder('tweede');

    const failed = await switchDataDir({ home: m.home, source: first, target: second, action: 'kopieren', now: NOW, afterStep: (step) => { if (step === 'paden') throw new Error('crash'); } });
    expect(failed.status).toBe('mislukt');
    expectNotSwitched(m, first, before, pointer);

    expect((await switchDataDir({ home: m.home, source: first, target: second, action: 'kopieren', now: NOW })).status).toBe('gewisseld');
    expect(snapshot(first)).toEqual(before);
    expectBothOpen(m, second);
    expect(description(second)).toBe('verder gewerkt in de eerste map');
    expectAttachmentsOpen(second, first);
  });

  it('vanuit de oude map in AppData (nog niet overgezet): die blijft staan onder zijn eigen naam', async () => {
    const m = machine();
    await dataFolder(m.oldNew, 'oud');
    writeFileSync(join(m.oldNew, 'Local State'), 'sleutel-oud');
    const before = snapshot(m.oldNew);
    expect(resolveDataDir(m.env)).toEqual({ kind: 'oud', dir: m.oldNew, target: m.shared });
    const target = m.folder('eigen');
    expect((await switchDataDir({ home: m.home, source: m.oldNew, target, action: 'kopieren', now: NOW })).status).toBe('gewisseld');
    expect(snapshot(m.oldNew)).toEqual(before);
    expect(existsSync(join(target, 'Local State'))).toBe(false);
    expectBothOpen(m, target);
    expectAttachmentsOpen(target, m.oldNew);
  });
});

describe('wisselen naar een map waarin al een complete administratie staat', () => {
  /** Een complete administratie die op een andere plek gemaakt is en met de hand hierheen verplaatst. */
  async function movedFolder(m: ReturnType<typeof machine>): Promise<string> {
    await dataFolder(join(m.root, 'elders'), 'eigen');
    markComplete(join(m.root, 'elders'));
    renameSync(join(m.root, 'elders'), join(m.root, 'eigen'));
    return join(m.root, 'eigen');
  }

  it('opent die administratie; de bijlagen openen ook als de map van een andere plek komt', async () => {
    const m = machine();
    await standardFolder(m);
    const before = snapshot(m.shared);
    const target = await movedFolder(m);
    for (const p of attachmentPaths(join(target, 'boekhouding.sqlite'))) expect(existsSync(p)).toBe(false); // de paden wijzen nog naar "elders"

    const moved = snapshot(target);
    const outcome = await switchDataDir({ home: m.home, source: m.shared, target, action: 'openen', now: NOW });
    // het wisselen zelf schrijft niets in de gekozen map: er worden geen paden herschreven
    expect(snapshot(target)).toEqual(moved);
    expect(outcome).toEqual({
      status: 'gewisseld',
      dir: target,
      action: 'openen',
      movedAside: null,
      databases: [
        { administration: '', missing: 0 },
        { administration: 'administraties/klant', missing: 0 },
      ],
    });
    expectAttachmentsOpen(target, join(m.root, 'elders'));
    expect(resolveDataDir(m.env)).toEqual({ kind: 'pointer', dir: target });
    expect(resolveForMcp(m.env)).toBe(target);
    expect(description(target)).toBe('bon eigen');
    // de huidige gegevens gaan niet mee en blijven staan
    expect(snapshot(m.shared)).toEqual(before);
  });

  it('een map met relatieve paden (deze versie), met de hand verplaatst: de bijlagen openen zonder dat er iets herschreven wordt', async () => {
    const m = machine();
    await standardFolder(m);
    const elsewhere = join(m.root, 'elders');
    const admins = [
      { rel: '', stored: await administrationOnDisk(elsewhere, 'eigen'), label: 'eigen' },
      { rel: join('administraties', 'klant'), stored: await administrationOnDisk(join(elsewhere, 'administraties', 'klant'), 'klant'), label: 'klant' },
    ];
    markComplete(elsewhere);
    const target = join(m.root, 'eigen');
    renameSync(elsewhere, target);
    const moved = snapshot(target);

    const outcome = await switchDataDir({ home: m.home, source: m.shared, target, action: 'openen', now: NOW });
    expect(outcome.status).toBe('gewisseld');
    expect(snapshot(target)).toEqual(moved);
    for (const { rel, stored, label } of admins) {
      const admin = join(target, rel);
      const log: string[] = [];
      openDatabase(join(admin, 'boekhouding.sqlite'), (message) => log.push(message)).close();
      expect(log).toEqual([]);
      expect(attachmentPaths(join(admin, 'boekhouding.sqlite')).sort()).toEqual([stored.bon, stored.scan].sort());
      expect(readFileSync(resolveAttachmentPath(admin, stored.bon), 'utf8')).toBe(`bewijs ${label}`);
      expect(readFileSync(resolveAttachmentPath(admin, stored.scan), 'utf8')).toBe(`scan ${label}`);
    }
  });

  it('een beschadigde administratie wordt niet geopend', async () => {
    const m = machine();
    await standardFolder(m);
    const before = snapshot(m.shared);
    const target = await movedFolder(m);
    const file = join(target, 'administraties', 'klant', 'boekhouding.sqlite');
    const bytes = readFileSync(file);
    bytes.fill(0xff, 4096, bytes.length);
    writeFileSync(file, bytes);
    const outcome = await switchDataDir({ home: m.home, source: m.shared, target, action: 'openen', now: NOW });
    expect(outcome.status).toBe('mislukt');
    expectNotSwitched(m, m.shared, before);
  });

  it.each(['controle', 'paden'] as const)('afgebroken na stap "%s": geen verwijzing, je werkt verder vanuit de huidige map', async (failAt) => {
    const m = machine();
    await standardFolder(m);
    const before = snapshot(m.shared);
    const target = await movedFolder(m);
    const outcome = await switchDataDir({ home: m.home, source: m.shared, target, action: 'openen', now: NOW, afterStep: (step) => { if (step === failAt) throw new Error(`crash na ${step}`); } });
    expect(outcome).toEqual({ status: 'mislukt', reason: `crash na ${failAt}` });
    expectNotSwitched(m, m.shared, before);
    expect((await switchDataDir({ home: m.home, source: m.shared, target, action: 'openen', now: NOW })).status).toBe('gewisseld');
    expectAttachmentsOpen(target, join(m.root, 'elders'));
    expectBothOpen(m, target);
  });
});

describe('terug naar de standaardmap', () => {
  /** Overgestapt naar een eigen map en daar verder gewerkt; in de standaardmap staat nog de stand van toen. */
  async function switchedAway(m: ReturnType<typeof machine>): Promise<string> {
    await standardFolder(m);
    // een administratie en een kantoor die alleen in de oude stand bestonden, mogen later niet in de nieuwe opduiken
    await administration(join(m.shared, 'administraties', 'gestopt'), 'gestopt');
    const own = m.folder('eigen');
    expect((await switchDataDir({ home: m.home, source: m.shared, target: own, action: 'kopieren', now: NOW })).status).toBe('gewisseld');
    rmSync(join(own, 'administraties', 'gestopt'), { recursive: true });
    rmSync(join(own, 'kantoor.json'));
    setDescription(own, 'verder gewerkt in de eigen map');
    return own;
  }

  const OLD_OWN = (file: string): boolean => !ONLY_IN_STANDARD.some((name) => name !== MARKER && (file === name || file.startsWith(`${name}/`)));

  it('de huidige gegevens gaan mee; wat er nog stond wordt bewaard, de eigen map blijft staan', async () => {
    const m = machine();
    const own = await switchedAway(m);
    const before = snapshot(own);
    const oldState = snapshot(m.shared);
    const plan = planSwitch({ home: m.home, current: own, chosen: m.shared, copyToStandard: true });
    expect(plan).toMatchObject({ dir: m.shared, action: 'kopieren', problem: null, standard: true });
    expect(plan.existing?.administrationCount).toBe(3);

    const outcome = await switchDataDir({ home: m.home, source: own, target: m.shared, action: 'kopieren', now: NOW });
    expect(outcome.status).toBe('gewisseld');
    if (outcome.status !== 'gewisseld') return;

    // geen verwijzing meer: de standaardmap geldt weer, voor app en koppeling
    expect(existsSync(pointerFile(m.home))).toBe(false);
    expect(resolveDataDir(m.env)).toEqual({ kind: 'gedeeld', dir: m.shared });
    expect(resolveForMcp(m.env)).toBe(m.shared);
    expect(description(m.shared)).toBe('verder gewerkt in de eigen map');
    expectAttachmentsOpen(m.shared, own);
    expect(existsSync(join(m.shared, 'administraties', 'gestopt'))).toBe(false);
    expect(existsSync(join(m.shared, 'kantoor.json'))).toBe(false);

    // de eigen map is niet gewist of veranderd
    expect(snapshot(own)).toEqual(before);

    // de oude stand van de standaardmap staat compleet opzij (met marker, dus later nog te openen)
    expect(outcome.movedAside).toBe(join(m.shared, `.onbekend-${STAMP}`));
    const aside = snapshot(outcome.movedAside!);
    const expected = Object.fromEntries(Object.entries(oldState).filter(([file]) => OLD_OWN(file)));
    expect(aside).toEqual(expected);
    expect(planSwitch({ home: m.home, current: m.shared, chosen: outcome.movedAside! })).toMatchObject({ action: 'openen', problem: null });

    // Chromium in de standaardmap is ongemoeid gelaten
    for (const name of ['Local State', 'Preferences', 'Cache/data_0']) expect(snapshot(m.shared)[name]).toBe(oldState[name]);
  });

  it.each(SWITCH_STEPS.filter((s) => s !== 'marker' && s !== 'pointer'))('afgebroken na stap "%s": je werkt verder vanuit de eigen map en de oude stand is niet weg', async (failAt) => {
    const m = machine();
    const own = await switchedAway(m);
    const before = snapshot(own);
    const pointer = readFileSync(pointerFile(m.home), 'utf8');
    const oldState = Object.fromEntries(Object.entries(snapshot(m.shared)).filter(([file]) => OLD_OWN(file)));
    const outcome = await switchDataDir({ home: m.home, source: own, target: m.shared, action: 'kopieren', now: NOW, afterStep: (step) => { if (step === failAt) throw new Error(`crash na ${step}`); } });
    expect(outcome).toEqual({ status: 'mislukt', reason: `crash na ${failAt}` });
    expectNotSwitched(m, own, before, pointer);
    expect(readFileSync(join(m.shared, 'Local State'), 'utf8')).toBe('sleutel-a');
    // de oude stand staat nog waar hij stond, of (na het plaatsen) compleet opzij
    const kept = failAt === 'plaatsen' ? snapshot(join(m.shared, `.onbekend-${STAMP}`)) : Object.fromEntries(Object.entries(snapshot(m.shared)).filter(([file]) => OLD_OWN(file)));
    expect(kept).toEqual(oldState);
    // de standaardmap telt na een half geplaatste kopie niet als compleet
    if (failAt === 'plaatsen') expect(existsSync(join(m.shared, MARKER))).toBe(false);

    const retry = await switchDataDir({ home: m.home, source: own, target: m.shared, action: 'kopieren', now: NOW });
    expect(retry.status).toBe('gewisseld');
    expect(snapshot(own)).toEqual(before);
    expect(snapshot(join(m.shared, `.onbekend-${STAMP}`))).toEqual(oldState);
    expectBothOpen(m, m.shared);
    expect(description(m.shared)).toBe('verder gewerkt in de eigen map');
    expectAttachmentsOpen(m.shared, own);
  });

  it('crash vlak na de marker: de verwijzing staat er nog, je werkt verder vanuit de eigen map', async () => {
    const m = machine();
    const own = await switchedAway(m);
    const before = snapshot(own);
    const pointer = readFileSync(pointerFile(m.home), 'utf8');
    await expect(switchDataDir({ home: m.home, source: own, target: m.shared, action: 'kopieren', now: NOW, afterStep: (step) => { if (step === 'marker') throw new Error('crash na marker'); } })).rejects.toThrow('crash na marker');
    expectNotSwitched(m, own, before, pointer);
  });

  it('de standaardmap aanwijzen in het keuzevenster: opent wat daar staat, de eigen map blijft staan', async () => {
    const m = machine();
    const own = await switchedAway(m);
    const before = snapshot(own);
    expect(planSwitch({ home: m.home, current: own, chosen: m.shared })).toMatchObject({ action: 'openen', standard: true, problem: null });
    const outcome = await switchDataDir({ home: m.home, source: own, target: m.shared, action: 'openen', now: NOW });
    expect(outcome).toMatchObject({ status: 'gewisseld', dir: m.shared, movedAside: null });
    expect(existsSync(pointerFile(m.home))).toBe(false);
    expectBothOpen(m, m.shared);
    expect(description(m.shared)).toBe('bon a');
    expect(snapshot(own)).toEqual(before);
  });

  it('de standaardmap bestaat niet meer: hij wordt opnieuw gemaakt', async () => {
    const m = machine();
    const own = await switchedAway(m);
    rmSync(m.shared, { recursive: true });
    expect(planSwitch({ home: m.home, current: own, chosen: m.shared, copyToStandard: true })).toMatchObject({ action: 'kopieren', standard: true, problem: null, existing: null });
    expect((await switchDataDir({ home: m.home, source: own, target: m.shared, action: 'kopieren', now: NOW })).status).toBe('gewisseld');
    expectBothOpen(m, m.shared);
    expectAttachmentsOpen(m.shared, own);
  });
});

describe('het verzoek uit Instellingen', () => {
  it('wordt één keer uitgevoerd en verandert zelf niets aan welke map geopend wordt', async () => {
    const m = machine();
    await standardFolder(m);
    const target = m.folder('eigen');
    writeSwitchRequest(m.home, target, 'kopieren');
    expect(existsSync(join(m.shared, SWITCH_REQUEST))).toBe(true);
    // tot het uitgevoerd is, werken app en koppeling gewoon vanuit de huidige map
    expectBothOpen(m, m.shared);
    expect(takeSwitchRequest(m.home)).toEqual({ target, action: 'kopieren' });
    // een poging die halverwege crasht wordt niet bij elke start herhaald
    expect(existsSync(join(m.shared, SWITCH_REQUEST))).toBe(false);
    expect(takeSwitchRequest(m.home)).toBeNull();
  });

  it.each([
    ['onleesbaar', 'geen json'],
    ['onbekende versie', JSON.stringify({ version: 2, target: '/x', action: 'kopieren' })],
    ['geen map', JSON.stringify({ version: 1, action: 'kopieren' })],
    ['onbekende actie', JSON.stringify({ version: 1, target: '/x', action: 'wissen' })],
  ])('een ongeldig verzoek (%s) wordt genegeerd en opgeruimd', async (_label, content) => {
    const m = machine();
    await standardFolder(m);
    writeFileSync(join(m.shared, SWITCH_REQUEST), content);
    expect(takeSwitchRequest(m.home)).toBeNull();
    expect(existsSync(join(m.shared, SWITCH_REQUEST))).toBe(false);
    expectBothOpen(m, m.shared);
  });
});

describe('opgeslagen wachtwoorden na het wisselen', () => {
  /**
   * safeStorage zoals op Windows: de sleutel staat in `Local State` in de map van Chromium. Wie een
   * andere `Local State` heeft, kan niets ontsleutelen.
   */
  function safeStorage(m: ReturnType<typeof machine>) {
    const key = (): Buffer => createHash('sha256').update(readFileSync(join(chromiumDir(resolveDataDir(m.env), m.home), 'Local State'))).digest();
    return {
      encrypt(text: string): Buffer {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key(), iv);
        const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), body]);
      },
      decrypt(value: Buffer): string {
        const decipher = createDecipheriv('aes-256-gcm', key(), value.subarray(0, 12));
        decipher.setAuthTag(value.subarray(12, 28));
        return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
      },
    };
  }

  const ADMINS = ['', join('administraties', 'klant')];

  /** De geheimen zoals de app ze leest: uit de database van de map die `resolveDataDir` aanwijst. */
  function readSecrets(m: ReturnType<typeof machine>): string[] {
    const store = safeStorage(m);
    const dir = openDir(m);
    const out = ADMINS.map((admin) => {
      const db = new Database(join(dir, admin, 'boekhouding.sqlite'), { readonly: true });
      try {
        return store.decrypt((db.prepare(`SELECT value FROM secrets WHERE key = 'smtp:password'`).get() as { value: Buffer }).value);
      } finally {
        db.close();
      }
    });
    out.push(store.decrypt(Buffer.from((JSON.parse(readFileSync(join(dir, 'kantoor.json'), 'utf8')) as { privateKey: string }).privateKey, 'base64')));
    return out;
  }

  it('blijven leesbaar: de sleutel staat in de standaardmap en die blijft de map van Chromium, heen en terug', async () => {
    const m = machine();
    await standardFolder(m);
    const store = safeStorage(m);
    for (const admin of ADMINS) {
      const db = new Database(join(m.shared, admin, 'boekhouding.sqlite'));
      db.prepare('INSERT INTO secrets (key, value) VALUES (?, ?)').run('smtp:password', store.encrypt(`wachtwoord ${admin || 'eerste'}`));
      db.close();
    }
    writeFileSync(join(m.shared, 'kantoor.json'), JSON.stringify({ office: 'Kantoor', privateKey: store.encrypt('kantoorsleutel').toString('base64') }));
    const expected = ['wachtwoord eerste', `wachtwoord ${ADMINS[1]}`, 'kantoorsleutel'];
    expect(readSecrets(m)).toEqual(expected);
    const key = readFileSync(join(m.shared, 'Local State'));

    // naar een eigen map: Chromium blijft in de standaardmap, de sleutel verhuist niet en wordt niet overschreven
    const own = m.folder('eigen');
    expect((await switchDataDir({ home: m.home, source: m.shared, target: own, action: 'kopieren', now: NOW })).status).toBe('gewisseld');
    expect(openDir(m)).toBe(own);
    expect(chromiumDir(resolveDataDir(m.env), m.home)).toBe(m.shared);
    expect(existsSync(join(own, 'Local State'))).toBe(false);
    expect(readFileSync(join(m.shared, 'Local State'))).toEqual(key);
    expect(readSecrets(m)).toEqual(expected);

    // en terug naar de standaardmap
    expect((await switchDataDir({ home: m.home, source: own, target: m.shared, action: 'kopieren', now: NOW })).status).toBe('gewisseld');
    expect(openDir(m)).toBe(m.shared);
    expect(chromiumDir(resolveDataDir(m.env), m.home)).toBe(m.shared);
    expect(readFileSync(join(m.shared, 'Local State'))).toEqual(key);
    expect(readSecrets(m)).toEqual(expected);
  });

  it('ook als het wisselen halverwege misgaat', async () => {
    const m = machine();
    await standardFolder(m);
    const store = safeStorage(m);
    const db = new Database(join(m.shared, 'boekhouding.sqlite'));
    db.prepare('INSERT INTO secrets (key, value) VALUES (?, ?)').run('smtp:password', store.encrypt('wachtwoord'));
    db.close();
    const outcome = await switchDataDir({ home: m.home, source: m.shared, target: m.folder('eigen'), action: 'kopieren', now: NOW, afterStep: (step) => { if (step === 'plaatsen') throw new Error('crash'); } });
    expect(outcome.status).toBe('mislukt');
    const check = new Database(join(openDir(m), 'boekhouding.sqlite'), { readonly: true });
    expect(store.decrypt((check.prepare(`SELECT value FROM secrets WHERE key = 'smtp:password'`).get() as { value: Buffer }).value)).toBe('wachtwoord');
    check.close();
  });

  it('een administratie uit een map van een andere computer heeft een andere sleutel: dat is te zien, niet stil', async () => {
    const m = machine();
    await standardFolder(m);
    const other = machine();
    await standardFolder(other, 'ander');
    const db = new Database(join(other.shared, 'boekhouding.sqlite'));
    db.prepare('INSERT INTO secrets (key, value) VALUES (?, ?)').run('smtp:password', safeStorage(other).encrypt('van de andere computer'));
    db.close();
    const carried = m.folder('meegenomen');
    expect((await switchDataDir({ home: other.home, source: other.shared, target: carried, action: 'kopieren', now: NOW })).status).toBe('gewisseld');
    expect((await switchDataDir({ home: m.home, source: m.shared, target: carried, action: 'openen', now: NOW })).status).toBe('gewisseld');
    const check = new Database(join(openDir(m), 'boekhouding.sqlite'), { readonly: true });
    const value = (check.prepare(`SELECT value FROM secrets WHERE key = 'smtp:password'`).get() as { value: Buffer }).value;
    check.close();
    // de app vraagt het wachtwoord dan opnieuw (SafeStorageSecretStore.get geeft null bij een fout)
    expect(() => safeStorage(m).decrypt(value)).toThrow();
  });
});

describe('mappen van een synchronisatiedienst herkennen', () => {
  const computer = (platform: NodeJS.Platform, home: string, extra: Partial<SyncContext> = {}): SyncContext => ({ platform, home, env: {}, exists: () => false, readFile: () => { throw new Error('bestaat niet'); }, ...extra });
  const windows = (extra: Partial<SyncContext> = {}): SyncContext => computer('win32', 'C:\\Users\\Piet', extra);
  const linux = (extra: Partial<SyncContext> = {}): SyncContext => computer('linux', '/home/piet', extra);

  it.each([
    ['C:\\Users\\Piet\\OneDrive\\Boekhouding', 'OneDrive'],
    ['C:\\Users\\Piet\\OneDrive - Bakker Bouw B.V\\Administratie', 'OneDrive'],
    ['C:\\Users\\Piet\\onedrive\\Documenten\\Boekhouding', 'OneDrive'],
    ['C:\\Users\\Piet\\Dropbox\\Boekhouding', 'Dropbox'],
    ['C:\\Users\\Piet\\Dropbox (Bakker Bouw)\\Boekhouding', 'Dropbox'],
    ['C:\\Users\\Piet\\iCloudDrive\\Boekhouding', 'iCloud'],
    ['G:\\Mijn Drive\\Boekhouding', 'Google Drive'],
    ['G:\\My Drive', 'Google Drive'],
    ['C:\\Users\\Piet\\Nextcloud\\Boekhouding', 'Nextcloud'],
    ['C:\\Users\\Piet\\pCloudDrive\\Boekhouding', 'pCloud'],
    ['C:\\Users\\Piet\\Proton Drive\\piet\\Boekhouding', 'Proton Drive'],
  ])('Windows: %s → %s (aan de mapnaam)', (dir, service) => {
    expect(detectSyncService(dir, windows())).toBe(service);
  });

  it.each([
    ['/home/piet/Dropbox/boekhouding', 'Dropbox'],
    ['/home/piet/Nextcloud/boekhouding', 'Nextcloud'],
    ['/Users/piet/Library/Mobile Documents/com~apple~CloudDocs/Boekhouding', 'iCloud'],
    ['/Users/piet/Library/CloudStorage/OneDrive-Persoonlijk/Boekhouding', 'OneDrive'],
    ['/Users/piet/Library/CloudStorage/GoogleDrive-piet@example.nl/Mijn Drive', 'Google Drive'],
    ['/home/piet/MEGAsync/boekhouding', 'MEGA'],
  ])('Linux en macOS: %s → %s (aan de mapnaam)', (dir, service) => {
    expect(detectSyncService(dir, linux())).toBe(service);
  });

  it('Windows: de map die OneDrive zelf opgeeft, ook met een eigen naam en ander hoofdlettergebruik', () => {
    const ctx = windows({ env: { OneDriveCommercial: 'D:\\Werk\\Wolk' } });
    expect(detectSyncService('D:\\Werk\\Wolk', ctx)).toBe('OneDrive');
    expect(detectSyncService('d:\\werk\\wolk\\Boekhouding', ctx)).toBe('OneDrive');
    expect(detectSyncService('D:\\Werk\\Wolken', ctx)).toBeNull();
    expect(detectSyncService('D:\\Werk', ctx)).toBeNull();
  });

  it('Dropbox: de map uit info.json, ook als die een eigen naam heeft', () => {
    const info = JSON.stringify({ personal: { path: 'D:\\Wolk' }, business: { path: 'E:\\Zaak' } });
    const ctx = windows({ env: { LOCALAPPDATA: 'C:\\Users\\Piet\\AppData\\Local' }, readFile: (file) => { if (file === 'C:\\Users\\Piet\\AppData\\Local\\Dropbox\\info.json') return info; throw new Error('bestaat niet'); } });
    expect(detectSyncService('D:\\Wolk\\Boekhouding', ctx)).toBe('Dropbox');
    expect(detectSyncService('E:\\Zaak', ctx)).toBe('Dropbox');
    expect(detectSyncService('D:\\Boekhouding', ctx)).toBeNull();
    const posix = linux({ readFile: (file) => { if (file === '/home/piet/.dropbox/info.json') return JSON.stringify({ personal: { path: '/data/wolk' } }); throw new Error('bestaat niet'); } });
    expect(detectSyncService('/data/wolk/boekhouding', posix)).toBe('Dropbox');
    // een onleesbaar info.json is geen fout
    expect(detectSyncService('/data/wolk', linux({ readFile: () => 'geen json' }))).toBeNull();
  });

  it('sporen van een dienst in de map of een map erboven', () => {
    const traces = (file: string) => linux({ exists: (f) => f === file });
    expect(detectSyncService('/data/gedeeld/boekhouding', traces('/data/gedeeld/.stfolder'))).toBe('Syncthing');
    expect(detectSyncService('/data/gedeeld/boekhouding', traces('/data/gedeeld/boekhouding/.dropbox'))).toBe('Dropbox');
    expect(detectSyncService('/data/gedeeld/boekhouding', traces('/data/.nextcloudsync.log'))).toBe('Nextcloud');
    expect(detectSyncService('/data/gedeeld/boekhouding', traces('/elders/.stfolder'))).toBeNull();
    expect(detectSyncService('D:\\Gedeeld\\Boekhouding', windows({ exists: (f) => f === 'D:\\Gedeeld\\.tmp.driveupload' }))).toBe('Google Drive');
  });

  it.each(['C:\\Users\\Piet\\BoekhoudenVoorNiks', 'D:\\Boekhouding', 'C:\\Users\\Piet\\Documents\\Dropbox-oud', 'C:\\Users\\Piet\\OneDriveBackup'])('Windows: %s is een gewone map', (dir) => {
    expect(detectSyncService(dir, windows())).toBeNull();
  });

  it('de waarschuwing komt mee met de beoordeling van de gekozen map, maar houdt het wisselen niet tegen', async () => {
    const m = machine();
    await standardFolder(m);
    const target = m.folder(path.join('Dropbox', 'Boekhouding'));
    expect(planSwitch({ home: m.home, current: m.shared, chosen: target })).toMatchObject({ action: 'kopieren', problem: null, sync: 'Dropbox' });
    expect(planSwitch({ home: m.home, current: m.shared, chosen: m.folder('gewoon') }).sync).toBeNull();
    expect((await switchDataDir({ home: m.home, source: m.shared, target, action: 'kopieren', now: NOW })).status).toBe('gewisseld');
  });

  it('een verwijzing uit de vorige versie blijft werken', async () => {
    const m = machine();
    const own = m.folder('eigen');
    await dataFolder(own, 'eigen');
    markComplete(own);
    writePointer(m.home, own);
    expect(resolveDataDir(m.env)).toEqual({ kind: 'pointer', dir: own });
    expect(chromiumDir(resolveDataDir(m.env), m.home)).toBe(m.shared);
  });
});
