import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import type { FolderAccess, FolderFile } from '../import/statement-folder';
import { isPathInside } from './path-security';

/**
 * De enige plek waar de app in de map met gedownloade afschriften kijkt (#184). Alleen lezen: de app
 * maakt, verplaatst of verwijdert daar nooit iets. Alleen gewone bestanden direct in de map: geen
 * submappen en geen snelkoppelingen (die kunnen naar buiten de map wijzen).
 */
export const folderAccess: FolderAccess = {
  isDirectory(dir) {
    try {
      return isAbsolute(dir) && statSync(dir).isDirectory();
    } catch {
      return false;
    }
  },

  list(dir) {
    if (!isAbsolute(dir)) throw new Error('Geen geldige map');
    const files: FolderFile[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      try {
        const st = lstatSync(join(dir, entry.name));
        if (!st.isFile()) continue;
        // sommige browsers geven een download de datum van de server mee: de dag dat het bestand hier kwam telt ook
        files.push({ name: entry.name, size: st.size, mtimeMs: Math.round(st.mtimeMs), changedMs: Math.round(Math.max(st.mtimeMs, st.ctimeMs)) });
      } catch {
        /* net verdwenen (bv. een tijdelijk bestand van de browser): overslaan */
      }
    }
    return files;
  },

  read(dir, name, maxBytes) {
    // alleen een bestandsnaam, geen pad: nooit iets buiten de gekozen map
    if (!isAbsolute(dir) || !name || basename(name) !== name) throw new Error('Alleen bestanden uit de gekozen map');
    const path = join(dir, name);
    if (!isPathInside(dir, path)) throw new Error('Alleen bestanden uit de gekozen map');
    const st = lstatSync(path);
    if (!st.isFile()) throw new Error('Alleen gewone bestanden uit de gekozen map');
    if (!isPathInside(realpathSync(dir), realpathSync(path))) throw new Error('Alleen bestanden uit de gekozen map');
    if (st.size > maxBytes) throw new Error('Het bestand is te groot');
    return readFileSync(path);
  },
};
