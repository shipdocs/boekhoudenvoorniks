import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isPathInside } from './path-security';

/** Waar de app naar kijkt om een map van een synchronisatiedienst te herkennen (tests geven een eigen computer mee). */
export interface SyncContext {
  platform: NodeJS.Platform;
  home: string;
  env: Record<string, string | undefined>;
  exists: (file: string) => boolean;
  readFile: (file: string) => string;
}

export function defaultSyncContext(home: string): SyncContext {
  return { platform: process.platform, home, env: process.env, exists: existsSync, readFile: (file) => readFileSync(file, 'utf8') };
}

/** Mapnamen waaraan een synchronisatiedienst te herkennen is (één deel van het pad). */
const NAMES: [RegExp, string][] = [
  [/^onedrive( - .+|-.+)?$/i, 'OneDrive'],
  [/^dropbox( \(.+\))?$/i, 'Dropbox'],
  [/^(icloud ?drive|icloud~.+|com~apple~clouddocs|mobile documents)$/i, 'iCloud'],
  [/^(google ?drive|googledrive-.+|my drive|mijn drive)$/i, 'Google Drive'],
  [/^nextcloud$/i, 'Nextcloud'],
  [/^owncloud$/i, 'ownCloud'],
  [/^pcloud ?drive$/i, 'pCloud'],
  [/^mega(sync)?$/i, 'MEGA'],
  [/^synology ?drive$/i, 'Synology Drive'],
  [/^proton ?drive$/i, 'Proton Drive'],
  [/^box sync$/i, 'Box'],
];

/** Bestanden en mappen die een dienst in de map zet die hij bijhoudt. */
const TRACES: [string, string][] = [
  ['.dropbox', 'Dropbox'],
  ['.dropbox.cache', 'Dropbox'],
  ['.tmp.driveupload', 'Google Drive'],
  ['.tmp.drivedownload', 'Google Drive'],
  ['.nextcloudsync.log', 'Nextcloud'],
  ['.owncloudsync.log', 'ownCloud'],
  ['.stfolder', 'Syncthing'],
  ['.SynologyWorkingDirectory', 'Synology Drive'],
];

/** De mappen die Dropbox zelf opgeeft (`info.json`). */
function dropboxRoots(ctx: SyncContext, p: path.PlatformPath): string[] {
  const files =
    ctx.platform === 'win32'
      ? [ctx.env.APPDATA, ctx.env.LOCALAPPDATA].filter((dir): dir is string => !!dir).map((dir) => p.join(dir, 'Dropbox', 'info.json'))
      : [p.join(ctx.home, '.dropbox', 'info.json')];
  const roots: string[] = [];
  for (const file of files) {
    try {
      const info = JSON.parse(ctx.readFile(file)) as Record<string, { path?: unknown } | undefined>;
      for (const account of Object.values(info)) if (typeof account?.path === 'string') roots.push(account.path);
    } catch {
      /* geen Dropbox, of een onleesbaar bestand */
    }
  }
  return roots;
}

/**
 * De synchronisatiedienst die deze map bijhoudt (OneDrive, Dropbox, iCloud, …), of null. Zo'n dienst
 * kopieert bestanden terwijl de app ermee werkt, en daar kan een SQLite-database van beschadigen.
 * Herkend aan de mappen die de dienst zelf opgeeft, aan de mapnaam en aan wat de dienst in de map
 * achterlaat. Niet herkend is geen garantie: het blijft een waarschuwing, geen slot.
 */
export function detectSyncService(dir: string, ctx: SyncContext): string | null {
  const p = ctx.platform === 'win32' ? path.win32 : path.posix;
  const within = (root: string): boolean => p.resolve(root) === p.resolve(dir) || isPathInside(root, dir, ctx.platform) || (ctx.platform === 'win32' && p.resolve(root).toLowerCase() === p.resolve(dir).toLowerCase());
  // Windows: OneDrive zet zijn map in de omgeving, ook als Documenten of Bureaublad erheen verhuisd zijn
  for (const name of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
    const root = ctx.env[name];
    if (root && within(root)) return 'OneDrive';
  }
  if (dropboxRoots(ctx, p).some(within)) return 'Dropbox';
  const parts = p.resolve(dir).split(/[\\/]+/).filter(Boolean);
  for (const part of parts) {
    const hit = NAMES.find(([pattern]) => pattern.test(part));
    if (hit) return hit[1];
  }
  // van de map omhoog tot de wortel: sporen van een dienst
  for (let probe = p.resolve(dir); ; probe = p.dirname(probe)) {
    const hit = TRACES.find(([name]) => ctx.exists(p.join(probe, name)));
    if (hit) return hit[1];
    if (p.dirname(probe) === probe) return null;
  }
}
