import { describe, expect, it } from 'vitest';
// De grenzen van het wijzigingsformaat, direct tegen de gebouwde kern (@gratis-boekhouden/kern):
// net binnen een limiet is goed, net erover geeft fout 'velden'. Elke grens komt uit
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
  it(`${L.maxSleutels} sleutels in velden is goed`, () => {
    expect(foutVan(metVelden(objectMet(L.maxSleutels)))).toBeNull();
  });

  it(`${L.maxSleutels + 1} sleutels in velden geeft fout velden`, () => {
    expect(foutVan(metVelden(objectMet(L.maxSleutels + 1)))).toBe('velden');
  });

  it(`${L.maxSleutels} sleutels in een genest object is goed`, () => {
    expect(foutVan(metVelden({ binnen: objectMet(L.maxSleutels) }))).toBeNull();
  });

  it(`${L.maxSleutels + 1} sleutels in een genest object geeft fout velden`, () => {
    expect(foutVan(metVelden({ binnen: objectMet(L.maxSleutels + 1) }))).toBe('velden');
  });
});

describe('diepte van velden', () => {
  it(`een object of array op niveau ${L.maxDiepte} mag nog`, () => {
    expect(foutVan(metVelden(genest(L.maxDiepte)))).toBeNull();
    expect(foutVan(metVelden(genestArray(L.maxDiepte)))).toBeNull();
  });

  it(`een object of array op niveau ${L.maxDiepte + 1} geeft fout velden`, () => {
    expect(foutVan(metVelden(genest(L.maxDiepte + 1)))).toBe('velden');
    expect(foutVan(metVelden(genestArray(L.maxDiepte + 1)))).toBe('velden');
  });
});

describe('totaal aantal knopen', () => {
  it(`${L.maxKnopen} knopen is goed`, () => {
    const velden = veldenMetKnopen(L.maxKnopen);
    expect(knopen(velden)).toBe(L.maxKnopen);
    expect(foutVan(metVelden(velden))).toBeNull();
  });

  it(`${L.maxKnopen + 1} knopen geeft fout velden`, () => {
    const velden = veldenMetKnopen(L.maxKnopen + 1);
    expect(knopen(velden)).toBe(L.maxKnopen + 1);
    expect(foutVan(metVelden(velden))).toBe('velden');
  });
});

describe('elementen per array', () => {
  it(`${L.maxArray} elementen is goed`, () => {
    expect(foutVan(metVelden({ lijst: Array.from({ length: L.maxArray }, (_, i) => i) }))).toBeNull();
  });

  it(`${L.maxArray + 1} elementen geeft fout velden`, () => {
    expect(foutVan(metVelden({ lijst: Array.from({ length: L.maxArray + 1 }, (_, i) => i) }))).toBe('velden');
  });

  it('een onbegrensd grote array wordt meteen geweigerd, zonder haar door te lopen', () => {
    expect(foutVan(metVelden({ lijst: Array.from({ length: L.maxArray * 1000 }, (_, i) => i) }))).toBe('velden');
  });
});

describe('tekens per string', () => {
  it(`${L.maxTekens} tekens is goed`, () => {
    expect(foutVan(metVelden({ tekst: 'x'.repeat(L.maxTekens) }))).toBeNull();
  });

  it(`${L.maxTekens + 1} tekens geeft fout velden`, () => {
    expect(foutVan(metVelden({ tekst: 'x'.repeat(L.maxTekens + 1) }))).toBe('velden');
  });

  it('een onbegrensd grote string wordt meteen geweigerd, en ook genest telt de grens', () => {
    expect(foutVan(metVelden({ tekst: 'x'.repeat(L.maxTekens * 1000) }))).toBe('velden');
    expect(foutVan(metVelden({ binnen: { tekst: 'x'.repeat(L.maxTekens + 1) } }))).toBe('velden');
  });
});

describe('het sleutelpatroon', () => {
  it('een goede sleutel van 40 tekens is ok', () => {
    expect(foutVan(metVelden({ ['A'.repeat(40)]: 1 }))).toBeNull();
    expect(foutVan(metVelden({ a: 1, A2_: 'x' }))).toBeNull();
  });

  it('slechte sleutels worden op niveau 1 geweigerd', () => {
    for (const sleutel of ['1abc', 'a-b', 'A'.repeat(41), '']) {
      expect(foutVan(metVelden({ [sleutel]: 1 })), sleutel).toBe('velden');
    }
  });

  it('slechte sleutels worden ook genest geweigerd', () => {
    expect(foutVan(metVelden({ binnen: { '1abc': 1 } }))).toBe('velden');
    expect(foutVan(metVelden({ binnen: { 'a-b': 1 } }))).toBe('velden');
    expect(foutVan(metVelden({ binnen: { ['A'.repeat(41)]: 1 } }))).toBe('velden');
  });
});

describe('verboden sleutels', () => {
  it('__proto__ wordt geweigerd: op niveau 1, genest, en in een array van objecten', () => {
    expect(foutVan(viaJson('{"__proto__": {"gevaar": true}}'))).toBe('velden');
    expect(foutVan(viaJson('{"binnen": {"__proto__": 1}}'))).toBe('velden');
    expect(foutVan(viaJson('{"lijst": [{"gewoon": 1}, {"__proto__": 1}]}'))).toBe('velden');
  });

  it('__proto__ als eigen sleutel via defineProperty wordt ook geweigerd', () => {
    const velden: Record<string, unknown> = { gewoon: 1 };
    Object.defineProperty(velden, '__proto__', { value: { gevaar: true }, enumerable: true, writable: true, configurable: true });
    expect(Object.prototype.hasOwnProperty.call(velden, '__proto__')).toBe(true);
    expect(foutVan(metVelden(velden))).toBe('velden');
  });

  it('constructor wordt geweigerd: op niveau 1, genest, en in een array van objecten', () => {
    expect(foutVan(metVelden({ constructor: 'x' }))).toBe('velden');
    expect(foutVan(metVelden({ binnen: { constructor: 'x' } }))).toBe('velden');
    expect(foutVan(metVelden({ lijst: [{ gewoon: 1 }, { constructor: 'x' }] }))).toBe('velden');
  });

  it('prototype wordt geweigerd: op niveau 1, genest, en in een array van objecten', () => {
    expect(foutVan(metVelden({ prototype: 'x' }))).toBe('velden');
    expect(foutVan(metVelden({ binnen: { prototype: 'x' } }))).toBe('velden');
    expect(foutVan(metVelden({ lijst: [{ prototype: 'x' }] }))).toBe('velden');
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
