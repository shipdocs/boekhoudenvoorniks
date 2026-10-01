import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { rebaseAttachmentPaths } from './backup';

/** Mapnaam van de gegevens vóór de naamswijziging naar BoekhoudenVoorNiks. */
export const OLD_DATA_DIR_NAME = 'gratis-boekhouden';
export const DATA_DIR_NAME = 'boekhoudenvoorniks';
/** De gedeelde map in de thuismap: buiten AppData, zodat verwijderen van de app de administratie nooit wist. */
export const SHARED_DIR_NAME = 'BoekhoudenVoorNiks';
/** Staat er pas als de map compleet is; wordt bij een migratie als allerlaatste geschreven. */
export const MARKER = 'migratie-klaar';
export const STAGING = '.staging-migratie';
export const MIGRATION_LOCK = '.migratie-bezig';
/** Gekozen bron als er twee oude mappen met een administratie zijn. */
export const CHOICE_FILE = '.migratie-keuze';
/** Tijdelijke Chromium-map voor de sessie waarin alleen de keuzevraag gesteld wordt. */
export const CHOICE_SESSION = '.keuze-sessie';
export const POINTER_NAME = '.boekhoudenvoorniks.json';
const POINTER_VERSION = 1;
const DB_FILE = 'boekhouding.sqlite';
const LOCAL_STATE = 'Local State';
export const MCP_CHOICE_PENDING = 'Open de app eerst om je gegevens over te zetten';

/** Een fout die de gebruiker te zien krijgt; nooit stil doorgaan met een lege administratie. */
export class DataDirError extends Error {}

export interface DataDirEnv {
  /** BOEKHOUDENVOORNIKS_DATA (tests, rooktest) */
  env?: string | null;
  home: string;
  appData: string;
}

export interface OldFolderInfo {
  dir: string;
  name: string;
  /** laatste wijziging van een van de administraties (ms sinds 1970) */
  lastModified: number;
  /** grootte van de gegevens in bytes (zonder de tussenopslag van Chromium) */
  size: number;
  administrationCount: number;
}

export type DataDirResolution =
  | { kind: 'env' | 'pointer' | 'gedeeld'; dir: string }
  /** nog niets: de gedeelde map wordt de administratie */
  | { kind: 'nieuw'; dir: string }
  /** nog niet overgezet: werken vanuit de oude map; de app zet hem over naar `target` */
  | { kind: 'oud'; dir: string; target: string }
  /** twee oude mappen met een administratie: de gebruiker kiest (alleen in de app) */
  | { kind: 'keuze'; target: string; candidates: OldFolderInfo[] };

export function sharedDataDir(home: string): string {
  return join(home, SHARED_DIR_NAME);
}

export function pointerFile(home: string): string {
  return join(home, POINTER_NAME);
}

function hasData(dir: string): boolean {
  return existsSync(join(dir, DB_FILE));
}

function hasMarker(dir: string): boolean {
  return existsSync(join(dir, MARKER));
}

/**
 * Onderdelen van Chromium in de oude map: gaan niet mee (de nieuwe map heeft zijn eigen), behalve
 * `Local State`, dat vóór de start apart wordt overgenomen omdat de sleutel van de geheimen erin staat.
 */
const CHROMIUM = new Set([
  'blob_storage', 'Cache', 'Code Cache', 'Cookies', 'Cookies-journal', 'Crashpad', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
  'Dictionaries', 'DIPS', 'DIPS-wal', 'DIPS-shm', 'GPUCache', 'GPUPersistentCache', LOCAL_STATE, 'Local Storage', 'Network', 'Network Persistent State',
  'Partitions', 'Preferences', 'Service Worker', 'Session Storage', 'Shared Dictionary', 'SharedStorage', 'SharedStorage-wal', 'shared_proto_db',
  'Trust Tokens', 'Trust Tokens-journal', 'TransportSecurity', 'VideoDecodeStats', 'WebStorage', 'lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket',
]);
/** Wat van ons is: staat dit al in het doel zonder marker, dan gaat het opzij (nooit weg). */
const OWN = (name: string): boolean => name.startsWith(DB_FILE) || ['administraties', 'administratie.json', 'bijlagen', 'backups', 'ocr', 'kantoor.json', 'versie.txt'].includes(name);

/** Een administratie zelf (kan open zijn): gaat via de back-up-API; de WAL-bestanden ernaast gaan niet los mee. */
function isLiveDatabase(name: string): boolean {
  return name === DB_FILE;
}

function isLiveSidecar(name: string): boolean {
  return name === `${DB_FILE}-wal` || name === `${DB_FILE}-shm`;
}

/** Alle gewone bestanden die meegaan, relatief aan de bron (met `/`). */
function dataFiles(source: string): { rel: string; size: number }[] {
  const out: { rel: string; size: number }[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (prefix === '' && (CHROMIUM.has(item.name) || item.name.startsWith('.org.chromium.') || item.name === STAGING)) continue;
      const rel = prefix ? `${prefix}/${item.name}` : item.name;
      const file = join(dir, item.name);
      if (item.isDirectory()) walk(file, rel);
      else if (item.isFile() && !isLiveSidecar(item.name)) out.push({ rel, size: statSync(file).size });
    }
  };
  walk(source, '');
  return out;
}

/** De databases van een gegevensmap: de eerste administratie en `administraties/<sleutel>`. */
function administrationDirs(root: string): string[] {
  const out = hasData(root) ? [''] : [];
  const sub = join(root, 'administraties');
  if (existsSync(sub)) {
    for (const item of readdirSync(sub, { withFileTypes: true })) {
      if (item.isDirectory() && hasData(join(sub, item.name))) out.push(`administraties/${item.name}`);
    }
  }
  return out;
}

export function describeOldFolder(dir: string): OldFolderInfo {
  const admins = administrationDirs(dir);
  const lastModified = Math.max(0, ...admins.map((a) => statSync(join(dir, ...a.split('/').filter(Boolean), DB_FILE)).mtimeMs));
  return { dir, name: dir.split(/[\\/]/).pop() ?? dir, lastModified, size: dataFiles(dir).reduce((sum, f) => sum + f.size, 0), administrationCount: admins.length };
}

/** De oude mappen in AppData met een administratie, de nieuwste naam eerst. */
export function oldFolders(appData: string): OldFolderInfo[] {
  return [DATA_DIR_NAME, OLD_DATA_DIR_NAME].map((name) => join(appData, name)).filter(hasData).map(describeOldFolder);
}

// ---------------------------------------------------------------------------------------------
// Pointer: een zelf gekozen gegevensmap

/** De zelf gekozen map, of null als er geen pointer is. Een ongeldige pointer is een fout, geen lege administratie. */
export function readPointer(home: string): string | null {
  const file = pointerFile(home);
  if (!existsSync(file)) return null;
  const refuse = (why: string): never => {
    throw new DataDirError(`De verwijzing naar je gegevensmap (${file}) klopt niet: ${why}. De app opent daarom niets. Herstel of verwijder dat bestand en start opnieuw.`);
  };
  let parsed: { version?: unknown; dataDir?: unknown };
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as typeof parsed;
  } catch {
    return refuse('het bestand is niet leesbaar');
  }
  if (parsed === null || typeof parsed !== 'object') return refuse('het bestand is niet leesbaar');
  if (parsed.version !== POINTER_VERSION) return refuse(`onbekende versie (${String(parsed.version)})`);
  if (typeof parsed.dataDir !== 'string' || !isAbsolute(parsed.dataDir)) return refuse('er staat geen volledige map in');
  let real: string;
  try {
    real = realpathSync(parsed.dataDir);
  } catch {
    return refuse(`de map ${parsed.dataDir} is niet bereikbaar`);
  }
  if (!hasData(real) || !hasMarker(real)) return refuse(`in ${real} staat geen complete administratie`);
  return real;
}

/** Legt een zelf gekozen gegevensmap vast (de mapkiezer in de app komt later, #185). */
export function writePointer(home: string, dataDir: string): string {
  if (!isAbsolute(dataDir)) throw new DataDirError('Kies een volledige map');
  let real: string;
  try {
    real = realpathSync(dataDir);
  } catch {
    throw new DataDirError(`De map ${dataDir} is niet bereikbaar`);
  }
  if (!hasData(real) || !hasMarker(real)) throw new DataDirError(`In ${real} staat geen complete administratie`);
  const file = pointerFile(home);
  const temp = `${file}.nieuw`;
  writeFileSync(temp, `${JSON.stringify({ version: POINTER_VERSION, dataDir: real }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
  return real;
}

// ---------------------------------------------------------------------------------------------
// Welke map

/** De bron die de gebruiker koos toen er twee oude mappen waren, als die er nog is. */
function readChoice(target: string, candidates: OldFolderInfo[]): OldFolderInfo | null {
  try {
    const chosen = readFileSync(join(target, CHOICE_FILE), 'utf8').trim();
    return candidates.find((c) => c.dir === chosen) ?? null;
  } catch {
    return null;
  }
}

export function writeChoice(target: string, source: string): void {
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, CHOICE_FILE), source);
}

/**
 * Eén regel voor de app én de koppeling (`--mcp`): eigen map uit de omgeving → zelf gekozen map
 * (pointer) → de gedeelde map als die compleet is → de oude map in AppData. Verandert niets op schijf.
 */
export function resolveDataDir(env: DataDirEnv): DataDirResolution {
  if (env.env) return { kind: 'env', dir: env.env };
  const pointed = readPointer(env.home);
  if (pointed) return { kind: 'pointer', dir: pointed };
  const target = sharedDataDir(env.home);
  if (hasMarker(target)) return { kind: 'gedeeld', dir: target };
  const candidates = oldFolders(env.appData);
  if (candidates.length === 0) return { kind: 'nieuw', dir: target };
  if (candidates.length === 1) return { kind: 'oud', dir: candidates[0]!.dir, target };
  const chosen = readChoice(target, candidates);
  return chosen ? { kind: 'oud', dir: chosen.dir, target } : { kind: 'keuze', target, candidates };
}

/** De map voor de koppeling: die zet nooit iets over en raadt niet tussen twee oude mappen. */
export function resolveForMcp(env: DataDirEnv): string {
  const r = resolveDataDir(env);
  if (r.kind === 'keuze') throw new DataDirError(MCP_CHOICE_PENDING);
  if (r.kind === 'nieuw') throw new DataDirError('Er is nog geen administratie. Open BoekhoudenVoorNiks eerst één keer.');
  return r.dir;
}

/** Een nieuwe installatie: de gedeelde map is meteen de complete administratie. */
export function markComplete(dir: string, note = 'nieuw'): void {
  mkdirSync(dir, { recursive: true });
  if (!hasMarker(dir)) writeFileSync(join(dir, MARKER), `${JSON.stringify({ sinds: new Date().toISOString(), herkomst: note })}\n`);
}

/**
 * De sleutel van de opgeslagen wachtwoorden (Chromiums `Local State`) overnemen vóór Chromium start.
 * Alleen als het doel nog niet compleet is en nog geen eigen sleutel heeft; een bestaande wordt
 * nooit overschreven.
 */
export function handOverLocalState(source: string, target: string): boolean {
  const from = join(source, LOCAL_STATE);
  const to = join(target, LOCAL_STATE);
  if (hasMarker(target) || existsSync(to) || !existsSync(from)) return false;
  mkdirSync(target, { recursive: true });
  copyFileSync(from, to);
  return true;
}

// ---------------------------------------------------------------------------------------------
// Overzetten

export type MigrationStep = 'ruimte' | 'slot' | 'kopie' | 'controle' | 'paden' | 'plaatsen' | 'marker' | 'hernoemen';
export const MIGRATION_STEPS: MigrationStep[] = ['ruimte', 'slot', 'kopie', 'controle', 'paden', 'plaatsen', 'marker', 'hernoemen'];

export interface DatabaseReport {
  /** '' = de eerste administratie, anders `administraties/<sleutel>` */
  administration: string;
  rebased: number;
  /** bijlagen waarvan het bestand ontbreekt (alleen gemeld) */
  missing: number;
}

export interface MigrationOptions {
  source: string;
  target: string;
  onProgress?: (done: number, total: number) => void;
  /** de gebruiker drukte op Stoppen */
  shouldStop?: () => boolean;
  now?: () => Date;
  /** vrije ruimte in bytes op de schijf van het doel (tests) */
  freeSpace?: (dir: string) => number;
  /** tests: wordt ná elke stap aangeroepen en mag gooien om een crash op dat punt na te bootsen */
  afterStep?: (step: MigrationStep) => void;
  log?: (message: string) => void;
}

export type MigrationOutcome =
  | { status: 'gemigreerd'; databases: DatabaseReport[]; renamedSource: string | null; movedAside: string | null; warning: string | null }
  | { status: 'gestopt' | 'geen-ruimte' | 'mislukt'; reason: string };

class Stopped extends Error {}

function stamp(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/** Een vrije naam: `base`, anders `base-2`, `base-3`, … */
function freeName(base: string): string {
  if (!existsSync(base)) return base;
  for (let n = 2; ; n++) if (!existsSync(`${base}-${n}`)) return `${base}-${n}`;
}

function defaultFreeSpace(dir: string): number {
  let probe = dir;
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  const s = statfsSync(probe);
  return s.bavail * s.bsize;
}

/** Resten van een afgebroken poging: altijd van een crash, want alleen de app zelf (één instantie) zet over. */
export function cleanMigrationLeftovers(target: string): void {
  rmSync(join(target, STAGING), { recursive: true, force: true });
  rmSync(join(target, MIGRATION_LOCK), { force: true });
}

function integrity(file: string): string {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return String(db.pragma('integrity_check', { simple: true }));
  } finally {
    db.close();
  }
}

/** Consistente kopie van een database die mogelijk nog open is (bv. door de koppeling, alleen-lezen). */
async function copyDatabase(from: string, to: string): Promise<void> {
  const db = new Database(from, { fileMustExist: true });
  try {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      /* een lezer houdt de WAL vast: de back-up-API neemt hem dan zelf mee */
    }
    await db.backup(to);
  } finally {
    db.close();
  }
}

/**
 * Zet de gegevens over van de oude map naar de gedeelde map, altijd door te kopiëren: de bron blijft
 * onaangeroerd tot de marker er staat. Volgorde: ruimte controleren → kopie in `.staging-migratie`
 * (databases via de back-up-API) → `integrity_check` → bijlagepaden herschrijven → op hun plek zetten
 * → marker → pas dan de bron hernoemen. Gaat er iets mis, dan is er niets veranderd en probeert de
 * volgende start het opnieuw.
 */
export async function migrateToSharedDir(options: MigrationOptions): Promise<MigrationOutcome> {
  const { source, target } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => undefined);
  const staging = join(target, STAGING);
  const step = (name: MigrationStep): void => {
    options.afterStep?.(name);
    if (options.shouldStop?.()) throw new Stopped();
  };
  let markerWritten = false;
  try {
    cleanMigrationLeftovers(target);
    const files = dataFiles(source);
    const total = files.reduce((sum, f) => sum + f.size, 0);
    const free = (options.freeSpace ?? defaultFreeSpace)(target);
    if (free < total * 1.2) {
      return { status: 'geen-ruimte', reason: `Er is ${Math.ceil((total * 1.2) / 1e6)} MB vrije ruimte nodig om je gegevens over te zetten en er is ${Math.floor(free / 1e6)} MB vrij.` };
    }
    step('ruimte');

    mkdirSync(staging, { recursive: true });
    writeFileSync(join(target, MIGRATION_LOCK), now().toISOString());
    step('slot');

    let done = 0;
    for (const file of files) {
      if (options.shouldStop?.()) throw new Stopped();
      const from = join(source, ...file.rel.split('/'));
      const to = join(staging, ...file.rel.split('/'));
      await mkdir(dirname(to), { recursive: true });
      if (isLiveDatabase(file.rel.split('/').pop()!)) await copyDatabase(from, to);
      else await copyFile(from, to);
      done += file.size;
      options.onProgress?.(done, total);
    }
    step('kopie');

    const admins = administrationDirs(staging);
    if (!admins.includes('')) throw new Error('de kopie bevat geen administratie');
    for (const admin of admins) {
      const result = integrity(join(staging, ...admin.split('/').filter(Boolean), DB_FILE));
      if (result !== 'ok') throw new Error(`de kopie van de administratie is beschadigd (${result})`);
    }
    step('controle');

    const databases: DatabaseReport[] = admins.map((admin) => {
      const parts = admin.split('/').filter(Boolean);
      // de paden wijzen naar waar de bijlagen straks staan; het bestaan controleren we in de kopie
      const report = rebaseAttachmentPaths(join(staging, ...parts, DB_FILE), join(target, ...parts, 'bijlagen'), join(staging, ...parts, 'bijlagen'));
      if (report.missing > 0) log(`${report.missing} bijlage(n) van ${admin || 'de eerste administratie'} ontbreken op schijf`);
      return { administration: admin, ...report };
    });
    step('paden');

    let movedAside: string | null = null;
    for (const name of readdirSync(staging)) {
      const destination = join(target, name);
      if (existsSync(destination)) {
        if (!OWN(name)) continue; // van Chromium of onbekend: wat er al staat, blijft
        movedAside ??= freeName(join(target, `.onbekend-${stamp(now())}`));
        mkdirSync(movedAside, { recursive: true });
        renameSync(destination, join(movedAside, name));
      }
      renameSync(join(staging, name), destination);
    }
    step('plaatsen');

    writeFileSync(join(target, MARKER), `${JSON.stringify({ sinds: now().toISOString(), herkomst: source })}\n`);
    markerWritten = true;
    cleanMigrationLeftovers(target);
    rmSync(join(target, CHOICE_FILE), { force: true });
    options.afterStep?.('marker'); // stoppen kan nu niet meer: de migratie is klaar

    let renamedSource: string | null = null;
    let warning: string | null = null;
    try {
      options.afterStep?.('hernoemen');
      renamedSource = freeName(`${source}.gemigreerd-${stamp(now())}`);
      renameSync(source, renamedSource);
    } catch (e) {
      renamedSource = null;
      warning = `De oude map ${source} kon niet hernoemd worden en blijft staan. Je gegevens staan nu in ${target}.`;
      log(`${warning} (${(e as Error).message})`);
    }
    return { status: 'gemigreerd', databases, renamedSource, movedAside, warning };
  } catch (e) {
    if (markerWritten) throw e;
    try {
      cleanMigrationLeftovers(target);
    } catch {
      /* de volgende start ruimt op */
    }
    if (e instanceof Stopped) return { status: 'gestopt', reason: 'Het overzetten is gestopt. Je werkt verder vanuit de oude map; bij de volgende start probeert de app het opnieuw.' };
    return { status: 'mislukt', reason: (e as Error).message };
  }
}
