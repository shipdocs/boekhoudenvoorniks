import { describe, expect, it } from 'vitest';
import { BETAALTERMIJN_GRENZEN, KLANT_VELDEN, WIJZIGING_LIMIETEN, leesKlantVelden } from '@gratis-boekhouden/kern';

// Het klantveldschema van de sync (packages/core/src/sync/velden.ts): zuiver, zonder Node of database.

function goed(velden: Record<string, unknown>) {
  const r = leesKlantVelden(velden);
  if (!r.ok) throw new Error(`verwacht goed, kreeg: ${r.veld}: ${r.melding}`);
  return r.velden;
}

function fout(velden: unknown) {
  const r = leesKlantVelden(velden);
  if (r.ok) throw new Error('verwacht een fout');
  return r;
}

describe('klantveldschema in de kern', () => {
  it('weigert type, paid_with, id, uuid en revisie met de veldnaam in de melding', () => {
    for (const veld of ['type', 'paid_with', 'id', 'uuid', 'revisie', 'sync_seq', 'created_at']) {
      const r = fout({ [veld]: 'x' });
      expect(r.veld).toBe(veld);
      expect(r.melding).toContain(veld);
    }
  });

  it('weigert __proto__, constructor en prototype als veld, ook als eigen sleutel uit JSON', () => {
    const uitJson = JSON.parse('{"__proto__":{"naam":"x"}}') as Record<string, unknown>;
    const r = fout(uitJson);
    expect(r.veld).toBe('__proto__');
    expect(r.melding).toContain('__proto__');
    for (const veld of ['constructor', 'prototype', 'toString', 'hasOwnProperty']) expect(fout({ [veld]: 'x' }).veld).toBe(veld);
  });

  it('weigert een onbekend veld, ook naast een geldig veld, en noemt dat veld', () => {
    const r = fout({ naam: 'Jansen', bedrijfsnaam: 'x' });
    expect(r.veld).toBe('bedrijfsnaam');
    expect(r.melding).toContain('bedrijfsnaam');
  });

  it('laat alle toegestane velden door en past de mapping toe naar de juiste kolom', () => {
    const invoer: Record<string, unknown> = {
      naam: 'Jansen BV',
      contactpersoon: 'Piet',
      email: 'piet@example.nl',
      telefoon: '0612345678',
      adres: 'Dorpsstraat 5',
      postcode: '3511 AA',
      plaats: 'Utrecht',
      land: 'NL',
      btw_nummer: 'NL123456789B01',
      kvk_nummer: '12345678',
      iban: 'NL91ABNA0417164300',
      betaaltermijn_dagen: 30,
      notities: 'Betaalt op tijd',
      gearchiveerd: 0,
    };
    const velden = goed(invoer);
    expect(velden).toEqual({
      name: 'Jansen BV',
      contact_name: 'Piet',
      email: 'piet@example.nl',
      phone: '0612345678',
      address: 'Dorpsstraat 5',
      postcode: '3511 AA',
      city: 'Utrecht',
      country: 'NL',
      vat_number: 'NL123456789B01',
      kvk_number: '12345678',
      iban: 'NL91ABNA0417164300',
      payment_term_days: 30,
      notes: 'Betaalt op tijd',
      archived: 0,
    });
    expect(Object.keys(KLANT_VELDEN).sort()).toEqual(Object.keys(invoer).sort());
  });

  it('heeft als mapping een tabel van Nederlandse veldnamen naar kolommen', () => {
    expect(KLANT_VELDEN.naam.kolom).toBe('name');
    expect(KLANT_VELDEN.kvk_nummer.kolom).toBe('kvk_number');
    expect(KLANT_VELDEN.gearchiveerd.kolom).toBe('archived');
    expect(KLANT_VELDEN.betaaltermijn_dagen.kolom).toBe('payment_term_days');
    // de kolommen zijn uniek
    const kolommen = Object.values(KLANT_VELDEN).map((d) => d.kolom);
    expect(new Set(kolommen).size).toBe(kolommen.length);
  });

  it('geeft een resultaat zonder prototype', () => {
    const velden = goed({ naam: 'Jansen', email: null });
    expect(Object.getPrototypeOf(velden)).toBeNull();
    expect(Object.hasOwn(velden, 'name')).toBe(true);
    expect(Object.hasOwn(velden, 'toString')).toBe(false);
    expect(velden.email).toBeNull();
    expect(velden.name).toBe('Jansen');
    expect(Object.hasOwn(velden, 'phone')).toBe(false);
  });

  it('bewaakt de grenzen van betaaltermijn: 0 tot en met 365, geheel, of null', () => {
    expect(goed({ betaaltermijn_dagen: 0 }).payment_term_days).toBe(0);
    expect(goed({ betaaltermijn_dagen: 365 }).payment_term_days).toBe(365);
    expect(goed({ betaaltermijn_dagen: null }).payment_term_days).toBeNull();
    for (const waarde of [-1, 366, 1.5, '30', Number.NaN, true]) {
      const r = fout({ betaaltermijn_dagen: waarde });
      expect(r.veld).toBe('betaaltermijn_dagen');
      expect(r.melding).toContain('betaaltermijn_dagen');
    }
    expect(BETAALTERMIJN_GRENZEN).toEqual({ min: 0, max: 365 });
  });

  it('bewaakt gearchiveerd: alleen 0 of 1, en nooit null', () => {
    expect(goed({ gearchiveerd: 0 }).archived).toBe(0);
    expect(goed({ gearchiveerd: 1 }).archived).toBe(1);
    for (const waarde of [2, -1, true, false, '1', null, 0.5]) {
      const r = fout({ gearchiveerd: waarde });
      expect(r.veld).toBe('gearchiveerd');
    }
  });

  it('weigert een lege of ontbrekende naam, maar laat optionele velden null zijn', () => {
    for (const waarde of ['', '   ', null, 5]) expect(fout({ naam: waarde }).veld).toBe('naam');
    const velden = goed({ contactpersoon: null, email: null, telefoon: null, adres: null, notities: null, land: null });
    expect(Object.keys(velden).sort()).toEqual(['address', 'contact_name', 'country', 'email', 'notes', 'phone']);
    expect(Object.values(velden).every((w) => w === null)).toBe(true);
  });

  it('bewaakt de tekstgrenzen: 200 tekens, adres 500, notities 4000, nooit boven maxTekens', () => {
    expect(goed({ naam: 'x'.repeat(200) }).name).toHaveLength(200);
    expect(fout({ naam: 'x'.repeat(201) }).veld).toBe('naam');
    expect(goed({ adres: 'x'.repeat(500) }).address).toHaveLength(500);
    expect(fout({ adres: 'x'.repeat(501) }).veld).toBe('adres');
    expect(goed({ notities: 'x'.repeat(4000) }).notes).toHaveLength(4000);
    expect(fout({ notities: 'x'.repeat(4001) }).veld).toBe('notities');
    for (const def of Object.values(KLANT_VELDEN)) if ('max' in def) expect(def.max).toBeLessThanOrEqual(WIJZIGING_LIMIETEN.maxTekens);
  });

  it('weigert een verkeerd type waarde en een verkeerd type velden zonder te gooien', () => {
    expect(fout({ email: 5 }).veld).toBe('email');
    expect(fout({ naam: { x: 1 } }).veld).toBe('naam');
    expect(fout({ betaaltermijn_dagen: [30] }).veld).toBe('betaaltermijn_dagen');
    for (const velden of [null, undefined, 'tekst', 5, ['naam']]) {
      expect(() => leesKlantVelden(velden)).not.toThrow();
      expect(fout(velden).veld).toBe('velden');
    }
  });

  it('accepteert een leeg object en geeft dan een leeg resultaat zonder prototype', () => {
    const velden = goed({});
    expect(Object.keys(velden)).toEqual([]);
    expect(Object.getPrototypeOf(velden)).toBeNull();
  });

  it('wijzigt de invoer niet en geeft dezelfde uitkomst bij een tweede aanroep', () => {
    const invoer = { naam: 'Jansen', email: 'a@b.nl' };
    const kopie = JSON.parse(JSON.stringify(invoer)) as Record<string, unknown>;
    const een = goed(invoer);
    const twee = goed(invoer);
    expect(invoer).toEqual(kopie);
    expect(een).toEqual(twee);
  });
});
