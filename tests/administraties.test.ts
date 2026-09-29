import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Administrations } from '../src/main/administrations';

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
    expect(admins.list(read)).toEqual([{ key: '', name: 'Mijn administratie', officeCopy: null, current: true }]);
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
});
