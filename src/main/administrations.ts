import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OfficeCopy } from '../settings/settings';

/**
 * Meerdere administraties op één computer (een ondernemer met een bv en een eenmanszaak, of een
 * boekhouder met de kopieën van zijn klanten). De eerste administratie staat waar hij altijd stond: in
 * de gegevensmap zelf (sleutel ''). Extra administraties staan in `administraties/<sleutel>/`, elk met
 * een eigen database, bijlagen en back-ups. Welke open is, staat in `administratie.json`.
 */
export interface AdministrationInfo {
  /** '' = de eerste (hoofd)administratie */
  key: string;
  name: string;
  /** kopie van een klant bij de boekhouder (kantoormodus) */
  officeCopy: OfficeCopy | null;
  /** vaste identiteit (migratie 21); bij een kopie dezelfde als die van de klant */
  id: string | null;
  current: boolean;
}

/** Wat er uit een database te lezen is zonder hem te openen voor gebruik; null als dat niet lukt. */
export type AdministrationReader = (dbFile: string) => { name: string; officeCopy: OfficeCopy | null; id?: string | null } | null;

const KEY = /^[a-z0-9][a-z0-9-]{0,62}$/;
const DB_FILE = 'boekhouding.sqlite';
export const DEFAULT_NAME = 'Mijn administratie';

export class Administrations {
  constructor(private readonly root: string) {}

  private get stateFile(): string {
    return join(this.root, 'administratie.json');
  }

  private get subRoot(): string {
    return join(this.root, 'administraties');
  }

  dirFor(key: string): string {
    if (key === '') return this.root;
    if (!KEY.test(key)) throw new Error('Onbekende administratie');
    return join(this.subRoot, key);
  }

  /** De open administratie; een verdwenen map valt terug op de eerste. */
  current(): string {
    try {
      const key = (JSON.parse(readFileSync(this.stateFile, 'utf8')) as { current?: unknown }).current;
      if (typeof key === 'string' && key !== '' && KEY.test(key) && existsSync(join(this.dirFor(key), DB_FILE))) return key;
    } catch {
      /* nog geen keuze gemaakt */
    }
    return '';
  }

  select(key: string): void {
    if (key !== '' && !existsSync(join(this.dirFor(key), DB_FILE))) throw new Error('Deze administratie bestaat niet (meer)');
    mkdirSync(this.root, { recursive: true });
    writeFileSync(this.stateFile, JSON.stringify({ current: key }));
  }

  private keys(): string[] {
    if (!existsSync(this.subRoot)) return [];
    return readdirSync(this.subRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && KEY.test(d.name) && existsSync(join(this.subRoot, d.name, DB_FILE)))
      .map((d) => d.name)
      .sort();
  }

  list(read: AdministrationReader): AdministrationInfo[] {
    const current = this.current();
    return ['', ...this.keys()].map((key) => {
      const info = existsSync(join(this.dirFor(key), DB_FILE)) ? read(join(this.dirFor(key), DB_FILE)) : null;
      return { key, name: info?.name || (key === '' ? DEFAULT_NAME : key), officeCopy: info?.officeCopy ?? null, id: info?.id ?? null, current: key === current };
    });
  }

  /**
   * Een nieuwe, lege map voor een administratie met deze naam; de database maakt de aanroeper aan.
   * De sleutel komt uit de naam en is uniek ("bakker-bouw", "bakker-bouw-2").
   */
  create(name: string): string {
    const base = slug(name);
    let key = base;
    for (let i = 2; existsSync(this.dirFor(key)); i++) key = `${base.slice(0, 58)}-${i}`;
    mkdirSync(this.dirFor(key), { recursive: true });
    return key;
  }
}

/** Naam en kantoormodus uit een database, alleen lezend: zonder migreren of wijzigen. */
export const readAdministrationFile: AdministrationReader = (file) => {
  let conn: Database.Database | null = null;
  try {
    conn = new Database(file, { readonly: true, fileMustExist: true });
    const get = (key: string) => (conn!.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
    const company = get('company');
    const copy = get('officeCopy');
    const id = get('administrationId');
    return { name: company ? String((JSON.parse(company) as { name?: string }).name ?? '') : '', officeCopy: copy ? (JSON.parse(copy) as OfficeCopy) : null, id: id ? (JSON.parse(id) as string) : null };
  } catch {
    return null;
  } finally {
    conn?.close();
  }
};

function slug(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || 'administratie';
}
