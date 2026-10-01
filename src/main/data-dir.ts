import { cpSync, existsSync, readdirSync, renameSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { rebaseAttachmentPaths } from './backup';

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

/**
 * Bijlagepaden staan als absoluut pad in de database. Na het verplaatsen van de map (ook die van de
 * naamswijziging) wijzen ze nog naar de oude plek; zet ze om voor de hoofdadministratie en alle
 * `administraties/*`. Herhalen is veilig, dus dit mag bij elke start. Een database die niet te openen is,
 * wordt overgeslagen; de namen van de mislukte administraties komen terug.
 */
export function rebaseDataDirAttachments(dataDir: string): string[] {
  const failed: string[] = [];
  const targets: { name: string; dir: string }[] = [{ name: '(hoofdadministratie)', dir: dataDir }];
  const sub = join(dataDir, 'administraties');
  if (existsSync(sub)) {
    for (const entry of readdirSync(sub, { withFileTypes: true })) {
      if (entry.isDirectory()) targets.push({ name: entry.name, dir: join(sub, entry.name) });
    }
  }
  for (const { name, dir } of targets) {
    const database = join(dir, 'boekhouding.sqlite');
    if (!existsSync(database)) continue;
    try {
      rebaseAttachmentPaths(database, join(dir, 'bijlagen'));
    } catch {
      failed.push(name);
    }
  }
  return failed;
}
