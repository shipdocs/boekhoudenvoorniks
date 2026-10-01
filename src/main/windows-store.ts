import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import path, { join } from 'node:path';
import { SHARED_DIR_NAME, type MigrationOutcome } from './data-dir';
import { isPathInside } from './path-security';

/**
 * De versie uit de Microsoft Store (MSIX). Electron zet `process.windowsStore` alleen in zo'n pakket;
 * in de gewone Windows-versie (Setup.exe van GitHub) en op Linux bestaat het niet en verandert er niets.
 * Alles wat voor de Store anders is, krijgt deze vlag als parameter mee.
 */
export function isWindowsStore(proc: { windowsStore?: boolean } = process): boolean {
  return proc.windowsStore === true;
}

/** Waar de gewone Windows-versie te downloaden is, voor wat in de Store-versie niet lukt. */
export const DOWNLOAD_URL = 'https://github.com/shipdocs/boekhoudenvoorniks/releases/latest';

/** Eén zin achter een foutmelding in de Store-versie: het kan wel met de gewone Windows-versie. */
export function storeFallbackHint(what: string): string {
  return `Lukt ${what} niet in de versie uit de Microsoft Store? Download dan de gewone Windows-versie op ${DOWNLOAD_URL}. Je administratie blijft dezelfde.`;
}

export const STORE_UPDATE_TEXT = 'Je hebt de versie uit de Microsoft Store. Nieuwe versies komen vanzelf via de Store; je hoeft hier niets voor te doen.';

// ---------------------------------------------------------------------------------------------
// Koppeling met Claude Code/Codex

/** De naam uit build/appx-extensions.xml (App Execution Alias). */
export const STORE_ALIAS = 'boekhoudenvoorniks.exe';

/**
 * Het vaste pad van de alias. `process.execPath` ligt in de Store-versie in een map met het
 * versienummer erin (WindowsApps) en verandert dus bij elke update; de alias blijft hetzelfde.
 */
export function storeAliasPath(localAppData: string | null | undefined): string {
  return localAppData ? path.win32.join(localAppData, 'Microsoft', 'WindowsApps', STORE_ALIAS) : STORE_ALIAS;
}

export interface McpCommandContext {
  store: boolean;
  /** %LOCALAPPDATA% */
  localAppData?: string | null;
  /** het AppImage-bestand zelf (Linux) */
  appImage?: string | null;
  isPackaged: boolean;
  execPath: string;
  appPath: string;
}

/**
 * Hoe Claude Code/Codex de koppeling start. Een AppImage draait steeds vanaf een andere tijdelijke
 * plek; dan het AppImage-bestand zelf. Uit de Microsoft Store: de alias. Tijdens ontwikkelen: electron
 * met de app-map.
 */
export function mcpCommand(ctx: McpCommandContext): { command: string; args: string[] } {
  if (ctx.store) return { command: storeAliasPath(ctx.localAppData), args: ['--mcp'] };
  if (ctx.appImage) return { command: ctx.appImage, args: ['--mcp'] };
  if (!ctx.isPackaged) return { command: ctx.execPath, args: [ctx.appPath, '--mcp'] };
  return { command: ctx.execPath, args: ['--mcp'] };
}

// ---------------------------------------------------------------------------------------------
// Eerste start

/** Staat in de gegevensmap zodra de melding bij de eerste start getoond is. */
export const FIRST_START_FLAG = '.store-eerste-start';

export interface StartNotice {
  type: 'info' | 'warning';
  message: string;
  detail: string;
}

/**
 * Eén keer, bij de eerste start van de Store-versie: een oude installatie van de website moet weg of
 * bijgewerkt worden, anders werkt die verder in de oude map. Null = al getoond.
 */
export function storeFirstStartNotice(dir: string): StartNotice | null {
  const flag = join(dir, FIRST_START_FLAG);
  if (existsSync(flag)) return null;
  try {
    writeFileSync(flag, `${new Date().toISOString()}\n`);
  } catch {
    /* niet te onthouden: dan komt de melding de volgende keer nog eens */
  }
  return {
    type: 'info',
    message: 'Had je BoekhoudenVoorNiks al op deze computer staan?',
    detail:
      'Dit is de versie uit de Microsoft Store. Heb je de app eerder geïnstalleerd met het installatieprogramma van de website (Setup.exe)? ' +
      'Verwijder die oude versie dan via de instellingen van Windows (Apps), of werk hem bij naar versie 0.7.6 of nieuwer. Je administratie blijft daarbij gewoon staan.\n\n' +
      'Een versie ouder dan 0.7.6 werkt met een andere map: wat je daar nog in boekt, komt niet in deze versie terecht.\n\n' +
      'Gebruik je de koppeling met Claude Code of Codex? Voeg die dan opnieuw toe bij Instellingen → Automatisch & herkenning, zodat hij deze versie start.',
  };
}

// ---------------------------------------------------------------------------------------------
// Zelf een map kiezen

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const fold = (value: string): string => (platform === 'win32' ? p.resolve(value).toLowerCase() : p.resolve(value));
  return fold(a) === fold(b);
}

function sameOrInside(root: string, candidate: string, platform: NodeJS.Platform): boolean {
  return samePath(root, candidate, platform) || isPathInside(root, candidate, platform);
}

const SYNC_NAMES: [RegExp, string][] = [
  [/^OneDrive( - .+)?$/i, 'OneDrive'],
  [/^Dropbox( \(.+\))?$/i, 'Dropbox'],
  [/^(Google ?Drive|Mijn Drive|My Drive)$/i, 'Google Drive'],
  [/^iCloud ?Drive$/i, 'iCloud Drive'],
];

/**
 * Ligt deze map in een map die met de cloud gesynchroniseerd wordt? Geeft de naam van de dienst, of
 * null. Zo'n dienst kan de database kopiëren terwijl de app erin schrijft; dan raakt hij beschadigd.
 */
export function syncFolder(dir: string, env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): string | null {
  for (const key of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
    const root = env[key];
    if (root && sameOrInside(root, dir, platform)) return 'OneDrive';
  }
  for (const part of dir.split(/[\\/]+/)) {
    const hit = SYNC_NAMES.find(([pattern]) => pattern.test(part));
    if (hit) return hit[1];
  }
  return null;
}

export function syncFolderWarning(dir: string, service: string): string {
  return (
    `De map ${dir} wordt gesynchroniseerd met ${service}. Zo'n dienst kan je administratie kopiëren terwijl de app erin schrijft, en dan kan hij beschadigd raken.\n\n` +
    'Kies liever een map die niet gesynchroniseerd wordt. Een back-up in je cloudmap zetten kan wel: Instellingen → Back-up.'
  );
}

export type FolderCheck = { ok: true; target: string } | { ok: false; reason: string };

export interface FolderCheckContext {
  /** de oude map waar de gegevens nu staan */
  source: string;
  /** %APPDATA% (Roaming); alles onder de map AppData is in de Store-versie geen vaste plek */
  appData: string;
  platform?: NodeJS.Platform;
}

/**
 * De map die de gebruiker zelf koos als nieuwe plek voor de gegevens. Een lege map wordt zelf de
 * gegevensmap; staat er al iets in, dan komt er een map `BoekhoudenVoorNiks` in.
 */
export function checkChosenFolder(chosen: string, ctx: FolderCheckContext): FolderCheck {
  const platform = ctx.platform ?? process.platform;
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (!p.isAbsolute(chosen)) return { ok: false, reason: 'Kies een volledige map.' };
  if (sameOrInside(ctx.source, chosen, platform)) return { ok: false, reason: 'Dit is de oude map zelf. Kies een andere map.' };
  if (platform === 'win32' && sameOrInside(p.dirname(ctx.appData), chosen, platform)) {
    return { ok: false, reason: 'Kies een map buiten AppData. Wat de versie uit de Microsoft Store daar neerzet, verdwijnt als je de app verwijdert.' };
  }
  const entries = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir) : []);
  const target = entries(chosen).length === 0 ? chosen : p.join(chosen, SHARED_DIR_NAME);
  const taken = [chosen, target].find((dir) => entries(dir).includes('boekhouding.sqlite'));
  if (taken) return { ok: false, reason: `In ${taken} staat al een administratie. Kies een lege map.` };
  return { ok: true, target };
}

// ---------------------------------------------------------------------------------------------
// Overzetten in de Store-versie

export type StoreMigrationChoice = 'opnieuw' | 'kiezen' | 'bekijken' | 'afsluiten';

export interface StoreMigrationFailure {
  status: 'gestopt' | 'geen-ruimte' | 'mislukt';
  reason: string;
  source: string;
  target: string;
  /** waarom alleen bekijken niet kan, of null als dat wel kan */
  viewProblem: string | null;
}

export interface StoreMigrationDeps {
  source: string;
  /** de gedeelde map in de thuismap */
  target: string;
  appData: string;
  migrate(source: string, target: string): Promise<MigrationOutcome>;
  /** waarom de oude map niet alleen-lezen te openen is (bv. van een oudere versie), of null */
  viewProblem(): string | null;
  choose(failure: StoreMigrationFailure): Promise<StoreMigrationChoice>;
  /** de mapkiezer; null = geannuleerd */
  pickFolder(): Promise<string | null>;
  /** de gekozen map kan niet; uitleggen waarom */
  refuse(reason: string): Promise<void>;
  /** waar = toch gebruiken */
  confirmSyncFolder(dir: string, service: string): Promise<boolean>;
  /** de zelf gekozen map vastleggen (pointer) */
  remember(dir: string): string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
}

export type StoreMigrationResult =
  | { kind: 'gemigreerd'; dir: string; outcome: Extract<MigrationOutcome, { status: 'gemigreerd' }> }
  /** niets overgezet: de oude map gaat alleen-lezen open */
  | { kind: 'alleen-lezen'; dir: string; reason: string }
  | { kind: 'afsluiten' };

/**
 * Overzetten in de versie uit de Microsoft Store. De gewone versie werkt na een mislukte poging door in
 * de oude map; hier kan dat niet, want wat een Store-app in AppData schrijft komt in een eigen kopie
 * terecht die bij verwijderen van de app gewist wordt. Daarom: opnieuw proberen, zelf een map kiezen,
 * of de oude map alleen bekijken.
 */
export async function migrateForStore(deps: StoreMigrationDeps): Promise<StoreMigrationResult> {
  const platform = deps.platform ?? process.platform;
  let target = deps.target;
  for (;;) {
    let outcome = await deps.migrate(deps.source, target);
    if (outcome.status === 'gemigreerd') {
      if (target === deps.target) return { kind: 'gemigreerd', dir: target, outcome };
      try {
        return { kind: 'gemigreerd', dir: deps.remember(target), outcome };
      } catch (e) {
        outcome = { status: 'mislukt', reason: `de gekozen map kon niet worden vastgelegd: ${(e as Error).message}` };
        target = deps.target;
      }
    }
    for (;;) {
      const viewProblem = deps.viewProblem();
      const choice = await deps.choose({ status: outcome.status, reason: outcome.reason, source: deps.source, target, viewProblem });
      if (choice === 'afsluiten') return { kind: 'afsluiten' };
      if (choice === 'opnieuw') break;
      if (choice === 'bekijken') {
        if (viewProblem === null) return { kind: 'alleen-lezen', dir: deps.source, reason: outcome.reason };
        continue;
      }
      const picked = await deps.pickFolder();
      if (!picked) continue;
      // de gewone gedeelde map aanwijzen is hetzelfde als opnieuw proberen
      const check: FolderCheck = samePath(picked, deps.target, platform) ? { ok: true, target: deps.target } : checkChosenFolder(picked, { source: deps.source, appData: deps.appData, platform });
      if (!check.ok) {
        await deps.refuse(check.reason);
        continue;
      }
      const service = check.target === deps.target ? null : syncFolder(check.target, deps.env ?? process.env, platform);
      if (service && !(await deps.confirmSyncFolder(check.target, service))) continue;
      target = check.target;
      break;
    }
  }
}

export const READ_ONLY_MESSAGE =
  'Je administratie is nu alleen te bekijken, omdat je gegevens nog niet zijn overgezet naar de nieuwe map. Klik bovenaan op "Opnieuw proberen" om dat nog eens te doen.';

/** Een schrijfpoging in de alleen-lezen geopende oude map: uitleg in gewone taal in plaats van de fout van SQLite. */
export function readOnlyError(e: unknown): Error | null {
  const err = e as { code?: unknown; message?: unknown } | null;
  return err?.code === 'SQLITE_READONLY' || /readonly database/i.test(String(err?.message ?? '')) ? new Error(READ_ONLY_MESSAGE) : null;
}
