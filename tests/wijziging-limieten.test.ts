import { describe, expect, it } from 'vitest';
// De grenzen van het wijzigingsformaat, direct tegen de gebouwde kern (@gratis-boekhouden/kern):
// elke limiet wordt in dezelfde test aan beide kanten bewezen — het geval net erbinnen is ok, het
// geval net erbuiten geeft fout 'velden' en overschrijdt alleen die ene limiet. Elke grens komt uit
// WIJZIGING_LIMIETEN en nooit uit een hard getal, zodat limiet en test niet uit elkaar kunnen lopen.
import { leesWijziging, WIJZIGING_LIMIETEN as L, type WijzigingsFout } from '@gratis-boekhouden/kern';

const uuid = '3f2b8c1e-5d4a-4e6f-9a7b-0c1d2e3f4a5b';
const TIJD = 1790848800000;

/** Een verder geldige change-set met deze `velden`. */
const metVelden = (velden: unknown): unknown => ({ entiteit: 'klant', uuid, revisie: 1, tijd: TIJD, velden });

/** De fout van leesWijziging, of null als de invoer werd geaccepteerd. */
function foutVan(raw: unknown): WijzigingsFout | null {
  const r = leesWijziging(raw);
  return r.ok ? null : r.fout;
}

/** Een object met precies `aantal` sleutels die aan het patroon voldoen (veld0, veld1, …). */
function objectMet(aantal: number): Record<string, unknown> {
  return Object.fromEntries(Array.from({ length: aantal }, (_, i) => [`veld${i}`, i]));
}

/** Genest object waarvan het diepste object op niveau `diepte` zit (velden zelf is niveau 1). */
function genest(diepte: number): Record<string, unknown> {
  let onderin: unknown = 'diep';
  for (let i = 0; i < diepte; i++) onderin = { laag: onderin };
  return onderin as Record<string, unknown>;
}

/** Zo, maar met arrays: velden > lijst (niveau 2) > geneste arrays tot en met niveau `diepte`. */
function genestArray(diepte: number): Record<string, unknown> {
  let onderin: unknown = 'diep';
  for (let i = 1; i < diepte; i++) onderin = [onderin];
  return { lijst: onderin as unknown[] };
}

/**
 * `velden` met precies `doel` knopen: een lijst van objecten met elk L.maxSleutels scalars, plus een
 * losse lijst met de rest. Zo blijven alle andere limieten net binnen hun eigen grens.
 */
function veldenMetKnopen(doel: number): Record<string, unknown> {
  const objecten = Math.floor((doel - 2) / (L.maxSleutels + 1));
  const rest = doel - 2 - objecten * (L.maxSleutels + 1);
  return {
    lijst: Array.from({ length: objecten }, () => objectMet(L.maxSleutels)),
    rest: Array.from({ length: rest }, (_, i) => i),
  };
}

/** Een factuur: 200 regels met elk 12 velden, plus een momentopname van de klantgegevens. */
function factuurVelden(): Record<string, unknown> {
  return {
    regels: Array.from({ length: 200 }, () => objectMet(12)),
    momentopname: { naam: 'Klant BV', adres: 'Dorpsstraat 1', plaats: 'Amsterdam', land: 'NL', btwNummer: 'NL123456789B01' },
  };
}

/** Telt de knopen binnen velden zoals de kern ze telt: elke waarde, velden zelf niet meegeteld. */
function knopen(velden: Record<string, unknown>): number {
  let n = 0;
  const bezoek = (waarde: unknown): void => {
    n += 1;
    if (waarde !== null && typeof waarde === 'object') {
      for (const sleutel of Object.keys(waarde as Record<string, unknown>)) bezoek((waarde as Record<string, unknown>)[sleutel]);
    }
  };
  for (const sleutel of Object.keys(velden)) bezoek(velden[sleutel]);
  return n;
}

/** Een change-set zoals JSON.parse haar aanmaakt: '__proto__' wordt dan een eigen sleutel. */
const viaJson = (veldenTekst: string): unknown =>
  JSON.parse(`{"entiteit":"klant","uuid":"${uuid}","revisie":1,"tijd":${TIJD},"velden":${veldenTekst}}`);

describe('WIJZIGING_LIMIETEN zelf', () => {
  it('staat precies de afgesproken grenzen in de kern', () => {
    expect(L.maxSleutels).toBe(64);
    expect(L.maxDiepte).toBe(6);
    expect(L.maxKnopen).toBe(4000);
    expect(L.maxArray).toBe(500);
    expect(L.maxTekens).toBe(4000);
  });

  it('noemt het sleutelpatroon en de verbodslijst', () => {
    expect(L.sleutelpatroon.source).toBe('^[A-Za-z][A-Za-z0-9_]{0,39}$');
    expect([...L.verboden]).toEqual(['__proto__', 'constructor', 'prototype']);
  });
});

describe('aantal sleutels per object', () => {
  it(`${L.maxSleutels} sleutels in velden is ok, ${L.maxSleutels + 1} geeft fout velden`, () => {
    expect(foutVan(metVelden(objectMet(L.maxSleutels)))).toBeNull();
    expect(foutVan(metVelden(objectMet(L.maxSleutels + 1)))).toBe('velden');
  });

  it(`${L.maxSleutels} sleutels in een genest object is ok, ${L.maxSleutels + 1} geeft fout velden`, () => {
    expect(foutVan(metVelden({ binnen: objectMet(L.maxSleutels) }))).toBeNull();
    expect(foutVan(metVelden({ binnen: objectMet(L.maxSleutels + 1) }))).toBe('velden');
  });
});

describe('diepte van velden', () => {
  it(`geneste objecten tot en met niveau ${L.maxDiepte} zijn ok, niveau ${L.maxDiepte + 1} geeft fout velden`, () => {
    // velden zelf is niveau 1: zes containers samen (velden meegeteld) mag nog, zeven niet
    expect(foutVan(metVelden(genest(L.maxDiepte)))).toBeNull();
    expect(foutVan(metVelden(genest(L.maxDiepte + 1)))).toBe('velden');
  });

  it(`geneste arrays tot en met niveau ${L.maxDiepte} zijn ok, niveau ${L.maxDiepte + 1} geeft fout velden`, () => {
    expect(foutVan(metVelden(genestArray(L.maxDiepte)))).toBeNull();
    expect(foutVan(metVelden(genestArray(L.maxDiepte + 1)))).toBe('velden');
  });
});

describe('totaal aantal knopen', () => {
  it(`${L.maxKnopen} knopen is ok, ${L.maxKnopen + 1} geeft fout velden`, () => {
    // acht sleutels met elk een array van L.maxArray - 1 scalars: per sleutel precies L.maxArray
    // knopen (de array zelf en zijn elementen), samen L.maxKnopen; sleutels, arrays en diepte
    // blijven ruim binnen hun eigen grens, dus alleen de knopenlimiet wordt op de korrel genomen
    const binnen = Object.fromEntries(
      Array.from({ length: L.maxKnopen / L.maxArray }, (_, i) => [`veld${i}`, Array.from({ length: L.maxArray - 1 }, (_, j) => j)]),
    ) as Record<string, unknown>;
    expect(Object.keys(binnen).length).toBeLessThan(L.maxSleutels);
    expect(knopen(binnen)).toBe(L.maxKnopen);
    expect(foutVan(metVelden(binnen))).toBeNull();
    binnen.extra = 1; // één scalar-sleutel erbij: alleen het aantal knopen komt erboven
    expect(knopen(binnen)).toBe(L.maxKnopen + 1);
    expect(foutVan(metVelden(binnen))).toBe('velden');
  });

  it(`een dichtere opbouw met ${L.maxKnopen} knopen is ok, ${L.maxKnopen + 1} geeft fout velden`, () => {
    const velden = veldenMetKnopen(L.maxKnopen);
    expect(knopen(velden)).toBe(L.maxKnopen);
    expect(foutVan(metVelden(velden))).toBeNull();
    const teVeel = veldenMetKnopen(L.maxKnopen + 1);
    expect(knopen(teVeel)).toBe(L.maxKnopen + 1);
    expect(foutVan(metVelden(teVeel))).toBe('velden');
  });
});

describe('elementen per array', () => {
  it(`${L.maxArray} elementen is ok, ${L.maxArray + 1} geeft fout velden`, () => {
    expect(foutVan(metVelden({ lijst: Array.from({ length: L.maxArray }, (_, i) => i) }))).toBeNull();
    expect(foutVan(metVelden({ lijst: Array.from({ length: L.maxArray + 1 }, (_, i) => i) }))).toBe('velden');
  });

  it('een onbegrensd grote array wordt meteen geweigerd, zonder haar door te lopen', () => {
    expect(foutVan(metVelden({ lijst: Array.from({ length: L.maxArray * 1000 }, (_, i) => i) }))).toBe('velden');
  });
});

describe('tekens per string', () => {
  it(`${L.maxTekens} tekens is ok, ${L.maxTekens + 1} geeft fout velden, ook genest`, () => {
    expect(foutVan(metVelden({ tekst: 'x'.repeat(L.maxTekens) }))).toBeNull();
    expect(foutVan(metVelden({ tekst: 'x'.repeat(L.maxTekens + 1) }))).toBe('velden');
    expect(foutVan(metVelden({ binnen: { tekst: 'x'.repeat(L.maxTekens + 1) } }))).toBe('velden');
  });

  it('een onbegrensd grote string wordt meteen geweigerd', () => {
    expect(foutVan(metVelden({ tekst: 'x'.repeat(L.maxTekens * 1000) }))).toBe('velden');
  });
});

describe('het sleutelpatroon', () => {
  it('een goede sleutel van 40 tekens is ok, slechte sleutels op niveau 1 geven fout velden', () => {
    // het patroon staat een eerste letter plus 39 tekens toe; 41 tekens is net erbuiten
    expect(foutVan(metVelden({ ['A'.repeat(40)]: 1 }))).toBeNull();
    expect(foutVan(metVelden({ a: 1, A2_: 'x' }))).toBeNull();
    for (const sleutel of ['1abc', 'a-b', 'A'.repeat(41), '']) {
      expect(foutVan(metVelden({ [sleutel]: 1 })), sleutel).toBe('velden');
    }
  });

  it('een goede geneste sleutel is ok, slechte sleutels worden ook genest geweigerd', () => {
    expect(foutVan(metVelden({ binnen: { goede_sleutel: 1 } }))).toBeNull();
    expect(foutVan(metVelden({ binnen: { '1abc': 1 } }))).toBe('velden');
    expect(foutVan(metVelden({ binnen: { 'a-b': 1 } }))).toBe('velden');
    expect(foutVan(metVelden({ binnen: { ['A'.repeat(41)]: 1 } }))).toBe('velden');
  });
});

describe('verboden sleutels', () => {
  it('__proto__ wordt geweigerd op niveau 1, genest en in een array van objecten', () => {
    // JSON.parse maakt '__proto__' als eigen sleutel aan; ook dat geval weigert de kern
    expect(foutVan(viaJson('{"__proto__": {"gevaar": true}}'))).toBe('velden');
    expect(foutVan(viaJson('{"binnen": {"__proto__": 1}}'))).toBe('velden');
    expect(foutVan(viaJson('{"lijst": [{"gewoon": 1}, {"__proto__": 1}]}'))).toBe('velden');
    expect(foutVan(viaJson('{"lijst": [{"gewoon": 1}]}'))).toBeNull();
  });

  it('__proto__ als eigen sleutel via defineProperty wordt ook geweigerd', () => {
    const velden: Record<string, unknown> = { gewoon: 1 };
    Object.defineProperty(velden, '__proto__', { value: { gevaar: true }, enumerable: true, writable: true, configurable: true });
    expect(Object.prototype.hasOwnProperty.call(velden, '__proto__')).toBe(true);
    expect(foutVan(metVelden(velden))).toBe('velden');
  });

  it('constructor wordt geweigerd op niveau 1, genest en in een array van objecten', () => {
    expect(foutVan(metVelden({ constructor: 'x' }))).toBe('velden');
    expect(foutVan(metVelden({ binnen: { constructor: 'x' } }))).toBe('velden');
    expect(foutVan(metVelden({ lijst: [{ gewoon: 1 }, { constructor: 'x' }] }))).toBe('velden');
    expect(foutVan(metVelden({ lijst: [{ gewoon: 1 }] }))).toBeNull();
  });

  it('prototype wordt geweigerd op niveau 1, genest en in een array van objecten', () => {
    expect(foutVan(metVelden({ prototype: 'x' }))).toBe('velden');
    expect(foutVan(metVelden({ binnen: { prototype: 'x' } }))).toBe('velden');
    expect(foutVan(metVelden({ lijst: [{ prototype: 'x' }] }))).toBe('velden');
    expect(foutVan(metVelden({ lijst: [{ gewoon: 1 }] }))).toBeNull();
  });
});

describe('veilig overnemen', () => {
  it('een geslaagde velden heeft geen eigen __proto__ en geen prototype', () => {
    const r = leesWijziging(viaJson('{"naam": "Familie Jansen"}'));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.prototype.hasOwnProperty.call(r.wijziging.velden, '__proto__')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(r.wijziging.velden, 'constructor')).toBe(false);
      expect(Object.getPrototypeOf(r.wijziging.velden)).toBeNull();
      expect(r.wijziging.velden['naam']).toBe('Familie Jansen');
    }
  });

  it('Object.prototype blijft onaangetast, ook na alle pogingen hierboven', () => {
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).gevaar).toBeUndefined();
    expect((JSON.parse('{}') as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('een gewone wijziging blijft gewoon werken', () => {
    const r = leesWijziging(metVelden({ naam: 'Familie Jansen', adres: { straat: 'Dorpsstraat 5', huisnummer: 5 } }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.wijziging.entiteit).toBe('klant');
      expect(r.wijziging.velden['naam']).toBe('Familie Jansen');
      expect((r.wijziging.velden['adres'] as Record<string, unknown>)['straat']).toBe('Dorpsstraat 5');
    }
  });

  it('waarden die niet in JSON passen blijven fout velden', () => {
    expect(foutVan(metVelden({ saldo: NaN }))).toBe('velden');
    expect(foutVan(metVelden({ saldo: Infinity }))).toBe('velden');
    expect(foutVan(metVelden({ naam: () => 'geen JSON' }))).toBe('velden');
    expect(foutVan(metVelden({ saldo: undefined }))).toBe('velden');
  });

  it('een factuur van 200 regels met 12 velden per regel plus een momentopname past erin', () => {
    const velden = factuurVelden();
    expect(knopen(velden)).toBeLessThan(L.maxKnopen);
    expect(foutVan(metVelden(velden))).toBeNull();
  });
});
