import { cpSync, existsSync, readdirSync, renameSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';

/** Mapnaam van de gegevens vóór de naamswijziging naar BoekhoudenVoorNiks. */
export const OLD_DATA_DIR_NAME = 'gratis-boekhouden';
export const DATA_DIR_NAME = 'boekhoudenvoorniks';

export type DataDirMigration = 'geen' | 'verplaatst' | 'gekopieerd' | 'overgeslagen';

/**
 * Zet de gegevens van de oude map (`gratis-boekhouden`) over naar de nieuwe, één keer, vóór de app
 * iets opent. Staat er in de nieuwe map al een administratie, dan blijft alles zoals het is.
 * Liever verplaatsen (zelfde schijf, in één keer); lukt dat niet, dan kopiëren en de oude map laten staan.
 */
export function migrateDataDir(oldDir: string, newDir: string): DataDirMigration {
  if (!existsSync(oldDir) || !existsSync(join(oldDir, 'boekhouding.sqlite'))) return 'geen';
  if (existsSync(join(newDir, 'boekhouding.sqlite'))) return 'overgeslagen';
  if (!existsSync(newDir)) {
    try {
      renameSync(oldDir, newDir);
      return 'verplaatst';
    } catch {
      cpSync(oldDir, newDir, { recursive: true, errorOnExist: false, force: false });
      return 'gekopieerd';
    }
  }
  // de nieuwe map bestaat al (bv. aangemaakt door Chromium) maar zonder administratie: per onderdeel
  let copied = false;
  for (const name of readdirSync(oldDir)) {
    const target = join(newDir, name);
    if (existsSync(target)) continue;
    try {
      renameSync(join(oldDir, name), target);
    } catch {
      cpSync(join(oldDir, name), target, { recursive: true });
      copied = true;
    }
  }
  if (copied) return 'gekopieerd';
  try {
    rmdirSync(oldDir); // alleen als hij leeg is
  } catch {
    /* wat in beide mappen stond, blijft in de oude staan */
  }
  return 'verplaatst';
}
