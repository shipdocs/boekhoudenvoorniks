import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { missingAttachments } from './backup';
import { isPathInside } from './path-security';
import { defaultSyncContext, detectSyncService, type SyncContext } from './sync-folders';

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
/** Verzoek uit Instellingen om van gegevensmap te wisselen; de volgende start voert het uit. */
export const SWITCH_REQUEST = '.map-wissel';
/**
 * Staat in de standaardmap zolang de gegevens in een zelf gekozen map staan: waarheen en sinds wanneer.
 * Raakt de verwijzing (pointer) weg, dan weet de app hierdoor dat wat er nog in de standaardmap staat
 * een oudere kopie is, en opent hij die niet stil.
 */
export const MOVED_NOTE = 'verhuisd-naar.json';
export const POINTER_NAME = '.boekhoudenvoorniks.json';
const POINTER_VERSION = 1;
const DB_FILE = 'boekhouding.sqlite';
const LOCAL_STATE = 'Local State';
export const MCP_CHOICE_PENDING = 'Open de app eerst om je gegevens over te zetten';
export const MCP_MOVED_PENDING = 'Je administratie is verplaatst naar een andere map en de verwijzing daarnaar is weg. Open de app eerst en kies daar welke map je wilt gebruiken';

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

/** Wat er zonder verwijzing geopend wordt. */
export type StandardResolution =
  | { kind: 'gedeeld'; dir: string }
  /** nog niets: de gedeelde map wordt de administratie */
  | { kind: 'nieuw'; dir: string }
  /** nog niet overgezet: werken vanuit de oude map; de app zet hem over naar `target` */
  | { kind: 'oud'; dir: string; target: string }
  /** twee oude mappen met een administratie: de gebruiker kiest (alleen in de app) */
  | { kind: 'keuze'; target: string; candidates: OldFolderInfo[] };

/** Waar de gegevens heen zijn gegaan (`MOVED_NOTE`). */
export interface MovedNote {
  to: string;
  /** ISO-tijdstip */
  since: string;
}

export type DataDirResolution =
  | { kind: 'env' | 'pointer'; dir: string }
  | StandardResolution
  /**
   * De gegevens zijn verplaatst naar een eigen map, maar de verwijzing daarnaar is weg: de gebruiker
   * kiest (alleen in de app). `fallback` is wat er zonder die map geopend zou worden: een oudere kopie.
   */
  | { kind: 'verhuisd'; moved: MovedNote; fallback: StandardResolution };

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
const OWN = (name: string): boolean => name.startsWith(DB_FILE) || ['administraties', 'administratie.json', 'bijlagen', 'backups', 'bonnenscanner', 'ocr', 'kantoor.json', 'versie.txt'].includes(name);

/** Een administratie zelf (kan open zijn): gaat via de back-up-API; de WAL-bestanden ernaast gaan niet los mee. */
function isLiveDatabase(name: string): boolean {
  return name === DB_FILE;
}

function isLiveSidecar(name: string): boolean {
  return name === `${DB_FILE}-wal` || name === `${DB_FILE}-shm`;
}

/**
 * Wat bij het wisselen van gegevensmap in de bron blijft: de boekhouding van de map zelf (marker, slot,
 * keuze, verzoek), wat eerder opzij is gezet, en wat Chromium in de standaardmap bijhoudt.
 */
const STAYS = (name: string): boolean =>
  [MARKER, MIGRATION_LOCK, CHOICE_FILE, CHOICE_SESSION, SWITCH_REQUEST, MOVED_NOTE, 'declarative_performance_observer.db', 'declarative_performance_observer.db-journal'].includes(name) || name.startsWith('.onbekend-');

/** Alle gewone bestanden die meegaan, relatief aan de bron (met `/`). */
function dataFiles(source: string, stays: (name: string) => boolean = () => false): { rel: string; size: number }[] {
  const out: { rel: string; size: number }[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (prefix === '' && (CHROMIUM.has(item.name) || item.name.startsWith('.org.chromium.') || item.name === STAGING || stays(item.name))) continue;
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

/** Legt een zelf gekozen gegevensmap vast; alleen een map met een complete administratie. */
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

/** Terug naar de standaardmap: zonder verwijzing geldt die weer (zie `resolveDataDir`). */
export function clearPointer(home: string): void {
  rmSync(pointerFile(home), { force: true });
}

// ---------------------------------------------------------------------------------------------
// Verhuisd: het spoor in de standaardmap

function movedNoteFile(home: string): string {
  return join(sharedDataDir(home), MOVED_NOTE);
}

/** Waar de gegevens heen zijn gegaan, of null als ze (voor zover de standaardmap weet) niet verplaatst zijn. */
export function readMovedNote(home: string): MovedNote | null {
  try {
    const parsed = JSON.parse(readFileSync(movedNoteFile(home), 'utf8')) as { version?: unknown; naar?: unknown; sinds?: unknown };
    if (parsed.version !== 1 || typeof parsed.naar !== 'string' || !isAbsolute(parsed.naar) || typeof parsed.sinds !== 'string') return null;
    return { to: parsed.naar, since: parsed.sinds };
  } catch {
    return null;
  }
}

/**
 * Legt in de standaardmap vast dat de gegevens in `dir` staan. Staat dat er al, dan verandert er niets.
 * De datum is die waarop `dir` vanuit de standaardmap gevuld is (zijn marker), anders nu: zo krijgt ook
 * wie vóór deze versie al wisselde de goede datum. Raakt alleen dit ene eigen bestand aan.
 */
export function noteMoved(home: string, dir: string, now: () => Date = () => new Date()): void {
  const standard = sharedDataDir(home);
  if (sameDir(dir, standard)) return;
  const existing = readMovedNote(home);
  if (existing && sameDir(existing.to, dir)) return;
  let since = now().toISOString();
  try {
    const marker = JSON.parse(readFileSync(join(dir, MARKER), 'utf8')) as { sinds?: unknown; herkomst?: unknown };
    if (typeof marker.herkomst === 'string' && sameDir(marker.herkomst, standard) && typeof marker.sinds === 'string' && !Number.isNaN(Date.parse(marker.sinds))) since = marker.sinds;
  } catch {
    /* een marker zonder herkomst (nieuwe installatie, oudere versie): nu */
  }
  mkdirSync(standard, { recursive: true });
  const file = movedNoteFile(home);
  writeFileSync(`${file}.nieuw`, `${JSON.stringify({ version: 1, naar: dir, sinds: since }, null, 2)}\n`);
  renameSync(`${file}.nieuw`, file);
}

/** De standaardmap is weer de gegevensmap (terug, of bewust gekozen voor de oudere kopie). */
export function forgetMoved(home: string): void {
  rmSync(movedNoteFile(home), { force: true });
}

/** Hoe de verplaatste map erbij staat: te openen, niet te bereiken, of zonder complete administratie. */
export type MovedState = { state: 'compleet'; dir: string; info: OldFolderInfo } | { state: 'onbereikbaar' } | { state: 'onvolledig' };

export function inspectMoved(moved: MovedNote): MovedState {
  let dir: string;
  try {
    dir = realpathSync(moved.to);
  } catch {
    return { state: 'onbereikbaar' };
  }
  if (!hasData(dir) || !hasMarker(dir)) return { state: 'onvolledig' };
  return { state: 'compleet', dir, info: describeOldFolder(dir) };
}

export type MovedAnswer = 'verplaatst' | 'ouder' | 'opnieuw' | 'stoppen';

export interface MovedQuestion {
  message: string;
  detail: string;
  /** in de volgorde van de knoppen; de laatste (stoppen) is ook wat sluiten van het venster betekent */
  buttons: { label: string; answer: MovedAnswer }[];
}

function when(time: number | string, withTime = false): string {
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return 'een eerdere datum';
  return date.toLocaleString('nl-NL', withTime ? { dateStyle: 'long', timeStyle: 'short' } : { dateStyle: 'long' });
}

/**
 * De vraag bij `verhuisd`: de teksten en de knoppen. De verplaatste map is alleen te kiezen als er een
 * complete administratie in staat; anders kan de gebruiker het opnieuw proberen (schijf aansluiten).
 * Verdergaan zonder die map is altijd een uitdrukkelijke keuze, nooit de standaard.
 */
export function movedQuestion(resolution: Extract<DataDirResolution, { kind: 'verhuisd' }>, state: MovedState, home: string): MovedQuestion {
  const { moved, fallback } = resolution;
  const standard = sharedDataDir(home);
  const buttons: MovedQuestion['buttons'] = [];
  let detail = `Op ${when(moved.since)} heb je je administratie verplaatst naar:\n${moved.to}\n\nDe app is kwijt dat je gegevens daar staan (het bestand ${pointerFile(home)} is weg). `;
  if (state.state === 'compleet') {
    const count = state.info.administrationCount === 1 ? '1 administratie' : `${state.info.administrationCount} administraties`;
    detail += `In die map staat nog steeds een complete administratie (laatst gewijzigd ${when(state.info.lastModified, true)}, ${count}).`;
    buttons.push({ label: 'De verplaatste map gebruiken', answer: 'verplaatst' });
  } else {
    detail +=
      state.state === 'onbereikbaar'
        ? 'De app kan die map nu niet bereiken. Staat hij op een usb-schijf of een netwerkschijf? Sluit die aan en kies dan Opnieuw proberen.'
        : 'In die map staat nu geen complete administratie. Heb je hem verplaatst of hernoemd? Zet hem terug en kies dan Opnieuw proberen.';
    buttons.push({ label: 'Opnieuw proberen', answer: 'opnieuw' });
  }
  if (fallback.kind === 'gedeeld') {
    detail += `\n\nIn de standaardmap ${standard} staat een oudere kopie, van vóór het verplaatsen (laatst gewijzigd ${when(describeOldFolder(standard).lastModified, true)}). Wat je na het verplaatsen hebt ingevoerd, staat daar niet in.`;
    buttons.push({ label: 'De oudere kopie gebruiken', answer: 'ouder' });
  } else if (fallback.kind === 'nieuw') {
    detail += '\n\nEr staat op deze computer geen andere administratie. Ga je zonder de verplaatste map verder, dan begint de app met een lege administratie; daarin kun je een back-up terugzetten.';
    buttons.push({ label: 'Leeg beginnen', answer: 'ouder' });
  } else {
    const where = fallback.kind === 'oud' ? fallback.dir : fallback.candidates.map((c) => c.dir).join(' en ');
    detail += `\n\nOp deze computer staan nog oudere gegevens, van vóór het verplaatsen, in ${where}. Wat je na het verplaatsen hebt ingevoerd, staat daar niet in.`;
    buttons.push({ label: 'De oudere gegevens gebruiken', answer: 'ouder' });
  }
  detail += '\n\nDe app opent niets tot je gekozen hebt, en er wordt niets gewist.';
  buttons.push({ label: 'Afsluiten', answer: 'stoppen' });
  return { message: 'Waar staat je administratie?', detail, buttons };
}

/**
 * Het antwoord "de verplaatste map gebruiken": de verwijzing komt terug. Alleen als er (nog) een complete
 * administratie staat; anders een fout en verandert er niets.
 */
export function resumeMoved(home: string, moved: MovedNote): string {
  return writePointer(home, moved.to);
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
 * (pointer) → de gedeelde map als die compleet is → de oude map in AppData. Zegt de standaardmap dat
 * de gegevens verplaatst zijn terwijl de verwijzing ontbreekt, dan wordt er niets stil geopend
 * (`verhuisd`). Verandert niets op schijf.
 */
export function resolveDataDir(env: DataDirEnv): DataDirResolution {
  if (env.env) return { kind: 'env', dir: env.env };
  const pointed = readPointer(env.home);
  if (pointed) return { kind: 'pointer', dir: pointed };
  const fallback = resolveStandard(env);
  const moved = readMovedNote(env.home);
  return moved ? { kind: 'verhuisd', moved, fallback } : fallback;
}

function resolveStandard(env: DataDirEnv): StandardResolution {
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
  if (r.kind === 'verhuisd') throw new DataDirError(MCP_MOVED_PENDING);
  if (r.kind === 'nieuw') throw new DataDirError('Er is nog geen administratie. Open BoekhoudenVoorNiks eerst één keer.');
  return r.dir;
}

/** Een nieuwe installatie: de gedeelde map is meteen de complete administratie. */
export function markComplete(dir: string, note = 'nieuw'): void {
  mkdirSync(dir, { recursive: true });
  if (!hasMarker(dir)) writeFileSync(join(dir, MARKER), `${JSON.stringify({ sinds: new Date().toISOString(), herkomst: note })}\n`);
}

/**
 * De map van Chromium (`userData`): altijd de standaardmap, ook als de gegevens in een zelf gekozen map
 * staan. Daar staat `Local State` met de sleutel van de opgeslagen wachtwoorden; omdat die map bij het
 * wisselen van gegevensmap dezelfde blijft, blijven de wachtwoorden leesbaar. Alleen voor de keuzevraag
 * tussen twee oude mappen krijgt Chromium een wegwerpmap.
 */
export function chromiumDir(resolution: DataDirResolution, home: string): string {
  return resolution.kind === 'keuze' ? join(sharedDataDir(home), CHOICE_SESSION) : sharedDataDir(home);
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

/** `paden`: nagaan of de bijlagen er staan (zie `attachmentReports`); de paden zelf veranderen niet. */
export type MigrationStep = 'ruimte' | 'slot' | 'kopie' | 'controle' | 'paden' | 'plaatsen' | 'marker' | 'hernoemen';
export const MIGRATION_STEPS: MigrationStep[] = ['ruimte', 'slot', 'kopie', 'controle', 'paden', 'plaatsen', 'marker', 'hernoemen'];

export interface DatabaseReport {
  /** '' = de eerste administratie, anders `administraties/<sleutel>` */
  administration: string;
  /** bijlagen waarvan het bestand ontbreekt (alleen gemeld) */
  missing: number;
}

/**
 * Bijlagepaden zijn relatief aan de map van de administratie en gaan dus vanzelf mee: er wordt niets
 * herschreven. (Paden uit een oudere versie zet de app om zodra hij de administratie opent.) Hier
 * alleen melden welke bijlagen in `root` ontbreken.
 */
function attachmentReports(root: string, admins: string[], log: (message: string) => void): DatabaseReport[] {
  return admins.map((admin) => {
    const dir = join(root, ...admin.split('/').filter(Boolean));
    const missing = missingAttachments(join(dir, DB_FILE), dir);
    if (missing > 0) log(`${missing} bijlage(n) van ${admin || 'de eerste administratie'} ontbreken op schijf`);
    return { administration: admin, missing };
  });
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
  /** wisselen van gegevensmap: de bron is zelf een gegevensmap en blijft onder zijn eigen naam staan */
  keepSource?: boolean;
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
 * (databases via de back-up-API) → `integrity_check` → bijlagen controleren → op hun plek zetten
 * → marker → pas dan de bron hernoemen. Gaat er iets mis, dan is er niets veranderd en probeert de
 * volgende start het opnieuw. Dezelfde route kopieert bij het wisselen van gegevensmap (`keepSource`,
 * zie `switchDataDir`); de bron wordt dan niet hernoemd.
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
    const files = dataFiles(source, options.keepSource ? STAYS : undefined);
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

    const databases = attachmentReports(staging, admins, log);
    step('paden');

    let movedAside: string | null = null;
    const aside = (name: string): void => {
      movedAside ??= freeName(join(target, `.onbekend-${stamp(now())}`));
      mkdirSync(movedAside, { recursive: true });
      renameSync(join(target, name), join(movedAside, name));
    };
    // Staat er in het doel al een complete administratie (terug naar de standaardmap), dan gaat die in
    // zijn geheel opzij, de marker eerst: valt het hierna stil, dan geldt het doel niet als compleet.
    if (hasMarker(target)) for (const name of [MARKER, ...readdirSync(target).filter(OWN)]) aside(name);
    for (const name of readdirSync(staging)) {
      if (existsSync(join(target, name))) {
        if (!OWN(name)) continue; // van Chromium of onbekend: wat er al staat, blijft
        aside(name);
      }
      renameSync(join(staging, name), join(target, name));
    }
    step('plaatsen');

    writeFileSync(join(target, MARKER), `${JSON.stringify({ sinds: now().toISOString(), herkomst: source })}\n`);
    markerWritten = true;
    cleanMigrationLeftovers(target);
    rmSync(join(target, CHOICE_FILE), { force: true });
    options.afterStep?.('marker'); // stoppen kan nu niet meer: de migratie is klaar

    let renamedSource: string | null = null;
    let warning: string | null = null;
    if (options.keepSource) return { status: 'gemigreerd', databases, renamedSource, movedAside, warning };
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
    if (e instanceof Stopped) return { status: 'gestopt', reason: 'Het overzetten is gestopt.' };
    return { status: 'mislukt', reason: (e as Error).message };
  }
}

// ---------------------------------------------------------------------------------------------
// Wisselen van gegevensmap (Instellingen)

export type SwitchAction = 'kopieren' | 'openen';

/** Wat er met een gekozen map zou gebeuren; `problem` = deze map kan niet, en waarom. */
export interface SwitchPlan {
  /** de gekozen map (het echte pad) */
  dir: string;
  /** `kopieren`: de huidige gegevens gaan erheen; `openen`: er staat al een complete administratie */
  action: SwitchAction;
  problem: string | null;
  /** de synchronisatiedienst die deze map bijhoudt (alleen een waarschuwing), of null */
  sync: string | null;
  /** de complete administratie die er al staat: wordt geopend, of gaat in de standaardmap opzij */
  existing: { lastModified: number; size: number; administrationCount: number } | null;
  /** de gekozen map is de standaardmap */
  standard: boolean;
}

export interface SwitchPlanInput {
  home: string;
  /** de map waaruit de app nu werkt */
  current: string;
  chosen: string;
  /** "Terug naar de standaardmap": de huidige gegevens gaan mee, ook als daar al een administratie staat */
  copyToStandard?: boolean;
  freeSpace?: (dir: string) => number;
  /** tests: een eigen computer voor het herkennen van synchronisatiediensten */
  sync?: SyncContext;
}

/** Resten van een eigen afgebroken poging, en wat het besturingssysteem zelf in een map zet. */
const IGNORED_IN_EMPTY = [STAGING, MIGRATION_LOCK, '.DS_Store', 'Thumbs.db', 'desktop.ini'];

/** Dezelfde map, ook via een omweg (snelkoppeling) of op Windows met andere hoofdletters. */
export function sameDir(a: string, b: string): boolean {
  const real = (dir: string): string => {
    try {
      return realpathSync(dir);
    } catch {
      return dir;
    }
  };
  return process.platform === 'win32' ? real(a).toLowerCase() === real(b).toLowerCase() : real(a) === real(b);
}

function canWrite(dir: string): boolean {
  const probe = join(dir, `.schrijfproef-${process.pid}`);
  try {
    writeFileSync(probe, '');
    rmSync(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * Beoordeelt een gekozen map: er staat een complete administratie (openen), hij is leeg (de huidige
 * gegevens gaan erheen), of hij kan niet. De standaardmap kan altijd: wat er nog staat, gaat opzij.
 * Laat niets achter op schijf.
 */
export function planSwitch(input: SwitchPlanInput): SwitchPlan {
  const plan: SwitchPlan = { dir: input.chosen, action: 'kopieren', problem: null, sync: null, existing: null, standard: false };
  const refuse = (problem: string): SwitchPlan => ({ ...plan, problem });
  if (!isAbsolute(input.chosen)) return refuse('Kies een volledige map.');
  try {
    plan.dir = realpathSync(input.chosen);
    if (!statSync(plan.dir).isDirectory()) return refuse(`${plan.dir} is geen map.`);
  } catch {
    // de standaardmap mag nog ontbreken: het kopiëren maakt hem aan
    if (!sameDir(input.chosen, sharedDataDir(input.home)) || existsSync(input.chosen)) return refuse(`De map ${input.chosen} is niet bereikbaar.`);
  }
  plan.standard = sameDir(plan.dir, sharedDataDir(input.home));
  if (sameDir(plan.dir, input.current)) return refuse('Dit is de map die je nu al gebruikt.');
  plan.sync = detectSyncService(plan.dir, input.sync ?? defaultSyncContext(input.home));
  const complete = hasData(plan.dir) && hasMarker(plan.dir);
  if (complete) {
    const { lastModified, size, administrationCount } = describeOldFolder(plan.dir);
    plan.existing = { lastModified, size, administrationCount };
  }
  if (complete && !(plan.standard && input.copyToStandard)) plan.action = 'openen';
  else if (isPathInside(input.current, plan.dir)) return refuse('Deze map staat in je huidige gegevensmap. Kies een map daarbuiten.');
  else if (!plan.standard) {
    if (hasData(plan.dir)) return refuse(`In ${plan.dir} staat een administratie die niet compleet is (het bestand ${MARKER} ontbreekt). De app opent hem daarom niet. Kies een lege map; dan zet de app je huidige gegevens erin.`);
    if (readdirSync(plan.dir).some((name) => !IGNORED_IN_EMPTY.includes(name))) {
      return refuse(`In ${plan.dir} staan al andere bestanden. Kies een lege map (je kunt in het keuzevenster een nieuwe map maken) of een map waarin al een administratie van BoekhoudenVoorNiks staat.`);
    }
  }
  if (existsSync(plan.dir) && !canWrite(plan.dir)) return refuse(`De app mag niet schrijven in ${plan.dir}. Kies een andere map.`);
  if (plan.action === 'kopieren') {
    const needed = dataFiles(input.current, STAYS).reduce((sum, f) => sum + f.size, 0) * 1.2;
    const free = (input.freeSpace ?? defaultFreeSpace)(plan.dir);
    if (free < needed) return refuse(`Op de schijf van ${plan.dir} is te weinig ruimte: er is ${Math.ceil(needed / 1e6)} MB nodig en er is ${Math.floor(free / 1e6)} MB vrij.`);
  }
  return plan;
}

/** Legt het verzoek vast; de app start daarna opnieuw en voert het uit vóór er een database open is. */
export function writeSwitchRequest(home: string, target: string, action: SwitchAction): void {
  const dir = sharedDataDir(home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, SWITCH_REQUEST), `${JSON.stringify({ version: 1, target, action })}\n`);
}

/**
 * Het verzoek om te wisselen, als dat er ligt. Het bestand gaat meteen weg: een poging die halverwege
 * crasht wordt niet bij elke start herhaald, de gebruiker kiest dan opnieuw.
 */
export function takeSwitchRequest(home: string): { target: string; action: SwitchAction } | null {
  const file = join(sharedDataDir(home), SWITCH_REQUEST);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown; target?: unknown; action?: unknown };
    if (parsed.version !== 1 || typeof parsed.target !== 'string' || (parsed.action !== 'kopieren' && parsed.action !== 'openen')) return null;
    return { target: parsed.target, action: parsed.action };
  } catch {
    return null;
  } finally {
    rmSync(file, { force: true });
  }
}

export type SwitchStep = Exclude<MigrationStep, 'hernoemen'> | 'pointer';
/** De stappen bij kopiëren naar een lege map; bij openen alleen `controle`, `paden` en `pointer`. */
export const SWITCH_STEPS: SwitchStep[] = ['ruimte', 'slot', 'kopie', 'controle', 'paden', 'plaatsen', 'marker', 'pointer'];

export interface SwitchOptions {
  home: string;
  /** de map waaruit de app nu werkt; die blijft staan zoals hij is */
  source: string;
  target: string;
  /** wat de gebruiker bevestigde; is de map intussen veranderd, dan gebeurt er niets */
  action: SwitchAction;
  onProgress?: (done: number, total: number) => void;
  shouldStop?: () => boolean;
  now?: () => Date;
  freeSpace?: (dir: string) => number;
  /** tests: wordt ná elke stap aangeroepen en mag gooien om een crash op dat punt na te bootsen */
  afterStep?: (step: SwitchStep) => void;
  log?: (message: string) => void;
}

export type SwitchOutcome =
  | { status: 'gewisseld'; dir: string; action: SwitchAction; databases: DatabaseReport[]; movedAside: string | null }
  | { status: 'geweigerd' | 'gestopt' | 'geen-ruimte' | 'mislukt'; reason: string };

/**
 * Wisselt van gegevensmap. Naar een lege map: de huidige gegevens gaan erheen langs de route van het
 * overzetten (kopie in staging → `integrity_check` → bijlagen controleren → op hun plek → marker). Naar
 * een map met een complete administratie: de database en de bijlagen controleren. De
 * verwijzing (pointer) wordt als allerlaatste geschreven, pas als de nieuwe map compleet is; tot dan
 * werken de app en de koppeling vanuit de huidige map, en die wordt nooit gewist of hernoemd.
 */
export async function switchDataDir(options: SwitchOptions): Promise<SwitchOutcome> {
  const { home, source } = options;
  const log = options.log ?? (() => undefined);
  const plan = planSwitch({ home, current: source, chosen: options.target, copyToStandard: options.action === 'kopieren', freeSpace: options.freeSpace });
  if (plan.problem) return { status: 'geweigerd', reason: plan.problem };
  if (plan.action !== options.action) return { status: 'geweigerd', reason: `De map ${plan.dir} is veranderd sinds je hem koos. Kies hem opnieuw in Instellingen.` };

  let databases: DatabaseReport[];
  let movedAside: string | null = null;
  if (plan.action === 'openen') {
    try {
      const admins = administrationDirs(plan.dir);
      for (const admin of admins) {
        const result = integrity(join(plan.dir, ...admin.split('/').filter(Boolean), DB_FILE));
        if (result !== 'ok') return { status: 'mislukt', reason: `De administratie in ${plan.dir} is beschadigd (${result}). De app opent hem daarom niet.` };
      }
      options.afterStep?.('controle');
      // de map kan van een andere plek komen (een andere computer, met de hand gekopieerd)
      databases = attachmentReports(plan.dir, admins, log);
      options.afterStep?.('paden');
    } catch (e) {
      return { status: 'mislukt', reason: (e as Error).message };
    }
  } else {
    const outcome = await migrateToSharedDir({
      source,
      target: plan.dir,
      keepSource: true,
      onProgress: options.onProgress,
      shouldStop: options.shouldStop,
      now: options.now,
      freeSpace: options.freeSpace,
      log,
      afterStep: (step) => {
        if (step !== 'hernoemen') options.afterStep?.(step);
      },
    });
    if (outcome.status !== 'gemigreerd') return outcome;
    ({ databases, movedAside } = outcome);
  }

  try {
    // terug naar de standaardmap: eerst het spoor weg, dan de verwijzing. Valt het daartussen stil, dan
    // geldt de verwijzing nog en zet de volgende start het spoor terug.
    if (plan.standard) forgetMoved(home);
    if (plan.standard) clearPointer(home);
    else writePointer(home, plan.dir);
  } catch (e) {
    return { status: 'mislukt', reason: `De keuze voor ${plan.dir} kon niet vastgelegd worden (${(e as Error).message}).` };
  }
  if (!plan.standard) {
    try {
      noteMoved(home, plan.dir, options.now);
    } catch (e) {
      // de verwijzing staat er; de volgende start legt het spoor alsnog vast
      log(`Vastleggen in de standaardmap dat de gegevens in ${plan.dir} staan lukte niet (${(e as Error).message})`);
    }
  }
  options.afterStep?.('pointer');
  return { status: 'gewisseld', dir: plan.dir, action: plan.action, databases, movedAside };
}
