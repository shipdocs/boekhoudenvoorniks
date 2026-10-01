import { existsSync, writeFileSync } from 'node:fs';
import path, { join } from 'node:path';
import { sameDir, type MigrationOutcome, type SwitchOutcome, type SwitchPlan } from './data-dir';
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
// Overzetten in de Store-versie

/**
 * Waarom een zelf gekozen map in de Store-versie niet kan, bovenop wat `planSwitch` al weigert: alles
 * onder AppData. Wat een Store-app daar neerzet, komt in een eigen kopie die bij verwijderen van de app
 * gewist wordt. Null = geen bezwaar.
 */
export function storeFolderProblem(chosen: string, appData: string, platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== 'win32') return null;
  const root = path.win32.dirname(appData);
  const fold = (value: string): string => path.win32.resolve(value).toLowerCase();
  if (fold(root) !== fold(chosen) && !isPathInside(root, chosen, platform)) return null;
  return 'Kies een map buiten AppData. Wat de versie uit de Microsoft Store daar neerzet, verdwijnt als je de app verwijdert.';
}

/**
 * De gegevensmap waaruit de Store-versie werkt ligt onder AppData. Dat kan alleen een map zijn die eerder
 * (in de gewone versie) zelf gekozen is: via de verwijzing, of teruggevonden na de vraag "Waar staat je
 * administratie?". De app opent hem, maar waarschuwt bij elke start tot de gegevens ergens anders staan.
 */
export function storeAppDataNotice(dir: string, appData: string, platform: NodeJS.Platform = process.platform): StartNotice | null {
  if (storeFolderProblem(dir, appData, platform) === null) return null;
  return {
    type: 'warning',
    message: 'Je gegevens staan op een plek die niet veilig is voor deze versie',
    detail:
      `Je administratie staat in ${dir}. Wat de versie uit de Microsoft Store in een map onder AppData opslaat, komt in een eigen kopie terecht, en die verdwijnt als je de app verwijdert.\n\n` +
      'Zet je gegevens daarom in een andere map: Instellingen → Administraties → Waar je gegevens staan. Maak eerst een back-up (Instellingen → Back-up).',
  };
}

export type StoreMigrationChoice = 'opnieuw' | 'kiezen' | 'bekijken' | 'afsluiten';

export interface StoreMigrationFailure {
  status: 'geweigerd' | 'gestopt' | 'geen-ruimte' | 'mislukt';
  reason: string;
  source: string;
  /** de map waar de laatste poging heen ging */
  target: string;
  /** waarom alleen bekijken niet kan, of null als dat wel kan */
  viewProblem: string | null;
}

export interface StoreMigrationDeps {
  source: string;
  /** de gedeelde map in de thuismap */
  target: string;
  appData: string;
  /** het gewone overzetten naar de gedeelde map (`migrateToSharedDir`) */
  migrate(source: string, target: string): Promise<MigrationOutcome>;
  /** een zelf gekozen map beoordelen, zoals Instellingen dat doet (`planSwitch`) */
  plan(chosen: string): SwitchPlan;
  /** naar de gekozen map kopiëren en als laatste de verwijzing schrijven (`switchDataDir`) */
  switchTo(target: string): Promise<SwitchOutcome>;
  /** waarom de oude map niet alleen-lezen te openen is (bv. van een oudere versie), of null */
  viewProblem(): string | null;
  choose(failure: StoreMigrationFailure): Promise<StoreMigrationChoice>;
  /** de mapkiezer; null = geannuleerd */
  pickFolder(): Promise<string | null>;
  /** de gekozen map kan niet; uitleggen waarom */
  refuse(reason: string): Promise<void>;
  /** waar = toch gebruiken */
  confirmSyncFolder(dir: string, service: string): Promise<boolean>;
  platform?: NodeJS.Platform;
}

export type StoreMigrationResult =
  | { kind: 'gemigreerd'; dir: string; outcome: Extract<MigrationOutcome, { status: 'gemigreerd' }> }
  /** naar een zelf gekozen map gekopieerd; de oude map blijft onder zijn eigen naam staan */
  | { kind: 'gekozen'; dir: string; outcome: Extract<SwitchOutcome, { status: 'gewisseld' }> }
  /** niets overgezet: de oude map gaat alleen-lezen open */
  | { kind: 'alleen-lezen'; dir: string; reason: string }
  | { kind: 'afsluiten' };

/**
 * Overzetten in de versie uit de Microsoft Store. De gewone versie werkt na een mislukte poging door in
 * de oude map; hier kan dat niet, want wat een Store-app in AppData schrijft komt in een eigen kopie
 * terecht die bij verwijderen van de app gewist wordt. Daarom: opnieuw proberen, zelf een map kiezen,
 * of de oude map alleen bekijken. Een zelf gekozen map gaat langs dezelfde weg als in Instellingen
 * (beoordelen met `planSwitch`, kopiëren met `switchDataDir`); hier komt alleen kopiëren in aanmerking.
 */
export async function migrateForStore(deps: StoreMigrationDeps): Promise<StoreMigrationResult> {
  const platform = deps.platform ?? process.platform;
  let failure: Omit<StoreMigrationFailure, 'source' | 'viewProblem'> | null = null;
  for (;;) {
    if (!failure) {
      const outcome = await deps.migrate(deps.source, deps.target);
      if (outcome.status === 'gemigreerd') return { kind: 'gemigreerd', dir: deps.target, outcome };
      failure = { status: outcome.status, reason: outcome.reason, target: deps.target };
    }
    const viewProblem = deps.viewProblem();
    const choice = await deps.choose({ ...failure, source: deps.source, viewProblem });
    if (choice === 'afsluiten') return { kind: 'afsluiten' };
    if (choice === 'opnieuw') {
      failure = null;
      continue;
    }
    if (choice === 'bekijken') {
      if (viewProblem === null) return { kind: 'alleen-lezen', dir: deps.source, reason: failure.reason };
      continue;
    }
    const picked = await deps.pickFolder();
    if (!picked) continue;
    // de gewone gedeelde map aanwijzen is hetzelfde als opnieuw proberen
    if (sameDir(picked, deps.target)) {
      failure = null;
      continue;
    }
    const blocked = storeFolderProblem(picked, deps.appData, platform);
    if (blocked) {
      await deps.refuse(blocked);
      continue;
    }
    const plan = deps.plan(picked);
    // hier alleen kopiëren: een map waar al een administratie staat openen zou de oude gegevens achterlaten
    const problem = plan.problem ?? (plan.action === 'kopieren' ? null : `In ${plan.dir} staat al een administratie. Kies een lege map; dan zet de app je gegevens erin.`);
    if (problem) {
      await deps.refuse(problem);
      continue;
    }
    if (plan.sync && !(await deps.confirmSyncFolder(plan.dir, plan.sync))) continue;
    const switched = await deps.switchTo(plan.dir);
    if (switched.status === 'gewisseld') return { kind: 'gekozen', dir: switched.dir, outcome: switched };
    failure = { status: switched.status, reason: switched.reason, target: plan.dir };
  }
}

export const READ_ONLY_MESSAGE =
  'Je administratie is nu alleen te bekijken, omdat je gegevens nog niet zijn overgezet naar de nieuwe map. Klik bovenaan op "Opnieuw proberen" om dat nog eens te doen.';

/** Een schrijfpoging in de alleen-lezen geopende oude map: uitleg in gewone taal in plaats van de fout van SQLite. */
export function readOnlyError(e: unknown): Error | null {
  const err = e as { code?: unknown; message?: unknown } | null;
  return err?.code === 'SQLITE_READONLY' || /readonly database/i.test(String(err?.message ?? '')) ? new Error(READ_ONLY_MESSAGE) : null;
}
