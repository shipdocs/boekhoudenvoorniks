import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Administrations, readAdministrationFile, renameAdministrationFile } from '../src/main/administrations';

function registry() {
  const root = mkdtempSync(join(tmpdir(), 'gb-admins-'));
  const admins = new Administrations(root);
  const names = new Map<string, string>();
  const read = (file: string) => {
    const name = names.get(file);
    return name === undefined ? null : { name, officeCopy: name.startsWith('Klant') ? { office: 'Kantoor X', exchange: 1, endDate: '2026-09-30' } : null };
  };
  /** maakt de database aan zoals de app dat bij openen doet */
  const open = (key: string, name: string) => {
    const file = join(admins.dirFor(key), 'boekhouding.sqlite');
    writeFileSync(file, '');
    names.set(file, name);
  };
  return { root, admins, read, open };
}

describe('meerdere administraties', () => {
  it('zonder keuze is de eerste administratie (in de gegevensmap zelf) open', () => {
    const { root, admins, read } = registry();
    expect(admins.current()).toBe('');
    expect(admins.dirFor('')).toBe(root);
    expect(admins.list(read)).toEqual([{ key: '', name: 'Mijn administratie', officeCopy: null, id: null, current: true }]);
  });

  it('een nieuwe administratie krijgt een eigen map met een unieke sleutel uit de naam', () => {
    const { root, admins, read, open } = registry();
    open('', 'Stukadoorsbedrijf Piet');
    const a = admins.create('Bakker & Zonen B.V.');
    expect(a).toBe('bakker-zonen-b-v');
    expect(admins.dirFor(a)).toBe(join(root, 'administraties', 'bakker-zonen-b-v'));
    open(a, 'Bakker & Zonen B.V.');
    const b = admins.create('Bakker & Zonen B.V.');
    expect(b).toBe('bakker-zonen-b-v-2');
    expect(admins.create('Café Één')).toBe('cafe-een');
    expect(admins.create('***')).toBe('administratie');
    // alleen mappen met een database tellen mee
    open(b, 'Klant Bakker (kopie)');
    expect(admins.list(read).map((x) => [x.key, x.name, x.officeCopy?.office ?? null])).toEqual([
      ['', 'Stukadoorsbedrijf Piet', null],
      ['bakker-zonen-b-v', 'Bakker & Zonen B.V.', null],
      ['bakker-zonen-b-v-2', 'Klant Bakker (kopie)', 'Kantoor X'],
    ]);
  });

  it('kiezen wordt onthouden; een verdwenen of onbekende administratie valt terug op de eerste', () => {
    const { admins, read, open } = registry();
    const a = admins.create('Tweede zaak');
    expect(() => admins.select(a)).toThrow(/bestaat niet/);
    open(a, 'Tweede zaak');
    admins.select(a);
    expect(admins.current()).toBe(a);
    expect(admins.list(read).find((x) => x.current)!.key).toBe(a);
    admins.select('');
    expect(admins.current()).toBe('');
    expect(() => admins.dirFor('../buiten')).toThrow(/Onbekende administratie/);
    expect(() => admins.select('../buiten')).toThrow();
  });

  it('weghalen (#444): niet de eerste, niet de open administratie, en alleen een bestaande', () => {
    const { admins, open } = registry();
    open('', 'Stukadoorsbedrijf Piet');
    expect(() => admins.dirToRemove('')).toThrow(/gegevensmap zelf/);
    const a = admins.create('Tweede zaak');
    expect(() => admins.dirToRemove(a)).toThrow(/bestaat niet/);
    open(a, 'Tweede zaak');
    admins.select(a);
    expect(() => admins.dirToRemove(a)).toThrow(/staat open/);
    admins.select('');
    expect(admins.dirToRemove(a)).toBe(admins.dirFor(a));
    expect(() => admins.dirToRemove('../buiten')).toThrow(/Onbekende/);
  });

  it('naam wijzigen (#444): de bedrijfsnaam in de database van een administratie die niet open is', () => {
    const { admins } = registry();
    const a = admins.create('Tweede zaak');
    const file = join(admins.dirFor(a), 'boekhouding.sqlite');
    const conn = new Database(file);
    conn.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    conn.close();
    // nog geen bedrijfsgegevens: de naam komt er alleen in
    renameAdministrationFile(file, '  Bakker Bouw  ');
    expect(readAdministrationFile(file)).toMatchObject({ name: 'Bakker Bouw' });
    // andere bedrijfsgegevens blijven staan
    const c2 = new Database(file);
    c2.prepare('UPDATE settings SET value = ? WHERE key = ?').run(JSON.stringify({ name: 'Bakker Bouw', kvk: '12345678' }), 'company');
    c2.close();
    renameAdministrationFile(file, 'Bakker Bouw B.V.');
    expect(readAdministrationFile(file)).toMatchObject({ name: 'Bakker Bouw B.V.' });
    const c3 = new Database(file, { readonly: true });
    expect(JSON.parse((c3.prepare('SELECT value FROM settings WHERE key = ?').get('company') as { value: string }).value)).toEqual({ name: 'Bakker Bouw B.V.', kvk: '12345678' });
    c3.close();
    expect(() => renameAdministrationFile(file, '   ')).toThrow(/Geef de administratie een naam/);
    expect(admins.list(readAdministrationFile).map((x) => x.name)).toEqual(['Mijn administratie', 'Bakker Bouw B.V.']);
  });
});
