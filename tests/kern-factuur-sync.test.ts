import { describe, expect, it } from 'vitest';
import { FACTUUR_LIMIETEN, SALES_VAT_RATES, computeTotals, leesFactuurNummer, leesFactuurVelden, leesWijziging, type LineInput } from '@gratis-boekhouden/kern';
import { LIMITS } from '../src/scanner/protocol';

// Het factuurschema van de sync (packages/core/src/sync/factuur.ts): zuiver, zonder Node of database.

const KLANT_UUID = '3f2b8c1e-9a4d-4e7b-8c3a-1d2e3f4a5b6c';
const PROJECT_UUID = '7a1c2d3e-4b5f-4a6b-9c7d-8e9f0a1b2c3d';
const ORIGINEEL_UUID = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';

type Regel = { omschrijving: string; hoeveelheid: number; prijs: number; btw_soort: string; btw_percentage?: number; eenheid?: string | null };

const KLANT_NL = {
  name: 'Bakkerij De Korst',
  address: 'Dorpsstraat 1',
  city: 'Utrecht',
  country: 'NL',
  vat_number: 'NL123456789B01',
  kvk_number: '12345678',
  email: 'info@korst.example',
};
const KLANT_DE = { ...KLANT_NL, name: 'Brot GmbH', city: 'Berlin', country: 'DE', vat_number: 'DE123456789' };
const BEDRIJF = { name: 'Jansen Klus', address: 'Werfstraat 2', city: 'Zwolle', kvkNumber: '87654321', vatNumber: 'NL987654321B01', kor: false };

function totalen(regels: Regel[]) {
  // een onbekende btw-soort kan de kern niet doorrekenen: dan zijn de totalen voor die test niet van belang
  if (regels.some((r) => !(r.btw_soort in SALES_VAT_RATES))) return { subtotaal: 0, btw: 0, totaal: 0 };
  const t = computeTotals(
    regels.map((r): LineInput => ({ description: r.omschrijving, quantity: r.hoeveelheid, unitPrice: r.prijs, vatCode: r.btw_soort as LineInput['vatCode'], vatPercentage: r.btw_percentage })),
  );
  return { subtotaal: t.subtotal, btw: t.vatTotal, totaal: t.total };
}

/** Een geldige basisfactuur; `over` overschrijft of voegt velden toe, `regels` bepaalt ook de totalen. */
function maak(regels: Regel[], over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    nummer: 'M1-2026-0001',
    datum: '2026-03-15',
    vervaldatum: '2026-04-14',
    klant_uuid: KLANT_UUID,
    klant_momentopname: { ...KLANT_NL },
    bedrijf_momentopname: { ...BEDRIJF },
    regels,
    totalen: totalen(regels),
    verzonden_op: '2026-03-15 10:30:00',
    regeltabel_versie: '2026-1',
    ...over,
  };
}

const HOOG: Regel = { omschrijving: 'Montage', hoeveelheid: 2, prijs: 4550, btw_soort: 'hoog', eenheid: 'uur' };

function goed(velden: unknown) {
  const r = leesFactuurVelden(velden);
  if (!r.ok) throw new Error(`verwacht goed, kreeg: ${r.veld}: ${r.melding}`);
  return r.factuur;
}

function fout(velden: unknown) {
  const r = leesFactuurVelden(velden);
  if (r.ok) throw new Error('verwacht een fout');
  return r;
}

describe('leesFactuurNummer', () => {
  it('haalt apparaatcode, reeksjaar en volgnummer uit het nummer', () => {
    expect(leesFactuurNummer('M1-2026-0001')).toEqual({ ok: true, apparaat_code: 'M1', reeks_jaar: 2026, reeks_volgnr: 1 });
    expect(leesFactuurNummer('M12-2031-12345')).toEqual({ ok: true, apparaat_code: 'M12', reeks_jaar: 2031, reeks_volgnr: 12345 });
  });

  it('geeft een nette fout, nooit een gooi, voor een ongeldig nummer', () => {
    for (const nummer of ['M0-2026-0001', 'M1-2026-001', 'M1-2026-00001', 'M1-2026-0000', 'm1-2026-0001', 'M1-26-0001', '2026-0001', 'M1-2026-0001 ', 42, null, undefined, {}]) {
      const r = leesFactuurNummer(nummer);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.melding).toContain('volgnummer');
    }
  });
});

describe('factuurschema in de kern: geldige facturen', () => {
  it('geldig: 21% hoog tarief, met alle velden netjes overgenomen', () => {
    const f = goed(maak([HOOG], { leverdatum: '2026-03-10', leverdatum_tot: '2026-03-12', referentie: 'Order 7', intro: 'Beste klant', opmerking: 'Bedankt' }));
    expect(f.nummer).toBe('M1-2026-0001');
    expect([f.apparaat_code, f.reeks_jaar, f.reeks_volgnr]).toEqual(['M1', 2026, 1]);
    expect(f.totalen).toEqual({ subtotaal: 9100, btw: 1911, totaal: 11011 });
    expect(f.regels[0]).toMatchObject({ omschrijving: 'Montage', hoeveelheid: 2, prijs: 4550, btw_soort: 'hoog', btw_percentage: 21, eenheid: 'uur' });
    expect([f.leverdatum, f.leverdatum_tot, f.referentie, f.intro, f.opmerking]).toEqual(['2026-03-10', '2026-03-12', 'Order 7', 'Beste klant', 'Bedankt']);
    expect([f.creditnota_van, f.project_uuid]).toEqual([null, null]);
    expect(f.klant_momentopname.name).toBe('Bakkerij De Korst');
    expect(f.bedrijf_momentopname.kor).toBe(false);
    expect(Object.getPrototypeOf(f)).toBeNull();
    expect(Object.getPrototypeOf(f.klant_momentopname)).toBeNull();
  });

  it('geldig: 9% laag tarief, ook met een afwijkend percentage voor hoog of laag', () => {
    const laag: Regel = { omschrijving: 'Boeken', hoeveelheid: 3, prijs: 1000, btw_soort: 'laag' };
    expect(goed(maak([laag])).regels[0]?.btw_percentage).toBe(9);
    const oud: Regel = { ...laag, btw_percentage: 6 };
    const f = goed(maak([oud]));
    expect(f.regels[0]?.btw_percentage).toBe(6);
    expect(f.totalen.btw).toBe(180);
  });

  it('geldig: 0% nul tarief en vrijgesteld', () => {
    const regels: Regel[] = [
      { omschrijving: 'Export binnenland nul', hoeveelheid: 1, prijs: 5000, btw_soort: 'nul' },
      { omschrijving: 'Vrijgesteld', hoeveelheid: 1, prijs: 2500, btw_soort: 'vrijgesteld' },
    ];
    const f = goed(maak(regels));
    expect(f.totalen).toEqual({ subtotaal: 7500, btw: 0, totaal: 7500 });
  });

  it('geldig: btw verlegd binnen Nederland met het btw-nummer van de klant', () => {
    const f = goed(maak([{ omschrijving: 'Onderaanneming', hoeveelheid: 1, prijs: 100000, btw_soort: 'verlegd' }]));
    expect(f.totalen).toEqual({ subtotaal: 100000, btw: 0, totaal: 100000 });
  });

  it('geldig: KOR met alleen geen btw en zonder eigen btw-nummer', () => {
    const f = goed(
      maak([{ omschrijving: 'Klus', hoeveelheid: 1, prijs: 30000, btw_soort: 'vrijgesteld' }], {
        bedrijf_momentopname: { ...BEDRIJF, vatNumber: '', kor: true },
      }),
    );
    expect(f.bedrijf_momentopname.kor).toBe(true);
    expect(f.totalen.btw).toBe(0);
  });

  it('geldig: EU met ICP, een dienst en goederen aan een klant in een ander EU-land', () => {
    const dienst: Regel = { omschrijving: 'Advies', hoeveelheid: 1, prijs: 80000, btw_soort: 'icp-dienst' };
    const goederen: Regel = { omschrijving: 'Machine', hoeveelheid: 1, prijs: 250000, btw_soort: 'icp' };
    expect(goed(maak([dienst], { klant_momentopname: { ...KLANT_DE }, leverdatum: '2026-02-20' })).regels[0]?.btw_soort).toBe('icp-dienst');
    expect(goed(maak([goederen], { klant_momentopname: { ...KLANT_DE } })).totalen.btw).toBe(0);
  });

  it('geldig: korting als negatieve prijs en een afronding per btw-groep', () => {
    const regels: Regel[] = [
      { omschrijving: 'Werk', hoeveelheid: 1, prijs: 10001, btw_soort: 'hoog' },
      { omschrijving: 'Korting', hoeveelheid: 1, prijs: -2501, btw_soort: 'hoog' },
      { omschrijving: 'Halve uren', hoeveelheid: 1.5, prijs: 3333, btw_soort: 'laag' },
    ];
    const f = goed(maak(regels));
    expect(f.totalen).toEqual(totalen(regels));
    expect(f.regels[1]?.prijs).toBe(-2501);
  });

  it('geldig: creditnota met negatieve hoeveelheden en een verwijzing naar het origineel', () => {
    const regels: Regel[] = [{ omschrijving: 'Montage', hoeveelheid: -2, prijs: 4550, btw_soort: 'hoog' }];
    const f = goed(maak(regels, { nummer: 'M1-2026-0002', creditnota_van: ORIGINEEL_UUID }));
    expect(f.creditnota_van).toBe(ORIGINEEL_UUID);
    expect(f.totalen.totaal).toBe(-11011);
  });

  it('geldig: met project_uuid, en project_uuid null telt als geen project', () => {
    expect(goed(maak([HOOG], { project_uuid: PROJECT_UUID })).project_uuid).toBe(PROJECT_UUID);
    expect(goed(maak([HOOG], { project_uuid: null })).project_uuid).toBeNull();
  });

  it('geldig: maximale factuur van 200 regels met twee-byte-tekens past door leesWijziging in maxWijzigingJsonBytes', () => {
    const lang = 'é'.repeat(FACTUUR_LIMIETEN.maxTekst);
    const regels: Regel[] = Array.from({ length: FACTUUR_LIMIETEN.maxRegels }, (_, i) => ({ omschrijving: lang, hoeveelheid: i + 1, prijs: 1000 + i, btw_soort: i % 2 ? 'laag' : 'hoog', eenheid: 'é'.repeat(FACTUUR_LIMIETEN.maxEenheid) }));
    const klant = Object.fromEntries(Object.keys({ ...KLANT_NL, contact_name: 0, phone: 0, postcode: 0, iban: 0 }).map((k) => [k, lang]));
    klant.country = 'NL';
    const bedrijf = {
      ...Object.fromEntries(['name', 'address', 'city', 'kvkNumber', 'vatNumber', 'postcode', 'country', 'email', 'phone', 'website', 'omzetbelastingNumber', 'iban', 'bic'].map((k) => [k, lang])),
      kor: false,
    };
    const velden = maak(regels, {
      nummer: 'M99-2026-123456',
      klant_momentopname: klant,
      bedrijf_momentopname: bedrijf,
      leverdatum: '2026-03-01',
      leverdatum_tot: '2026-03-14',
      referentie: lang,
      intro: 'é'.repeat(FACTUUR_LIMIETEN.maxLangeTekst),
      opmerking: 'é'.repeat(FACTUUR_LIMIETEN.maxLangeTekst),
      creditnota_van: ORIGINEEL_UUID,
      project_uuid: PROJECT_UUID,
    });
    const wijziging = { entiteit: 'factuur', uuid: 'c3d4e5f6-a7b8-4c9d-8e0f-2a3b4c5d6e7f', revisie: 1, tijd: 1_800_000_000_000, velden };
    expect(Buffer.byteLength(JSON.stringify(wijziging), 'utf8')).toBeLessThan(LIMITS.maxWijzigingJsonBytes);
    const gelezen = leesWijziging(JSON.parse(JSON.stringify(wijziging)));
    expect(gelezen.ok).toBe(true);
    if (!gelezen.ok) return;
    const f = goed(gelezen.wijziging.velden);
    expect(f.regels).toHaveLength(200);
    expect(f.regels[0]?.omschrijving).toHaveLength(200);
    expect(f.intro).toHaveLength(2000);
  });

  it('geldig: precies 1 regel en precies 200 regels', () => {
    expect(goed(maak([HOOG])).regels).toHaveLength(1);
    const tweehonderd = Array.from({ length: 200 }, () => ({ ...HOOG }));
    expect(goed(maak(tweehonderd)).regels).toHaveLength(200);
  });
});

describe('factuurschema in de kern: ongeldige facturen', () => {
  it('ongeldig: nummerformaat', () => {
    for (const nummer of ['2026-0001', 'M0-2026-0001', 'M1-2026-001', 'X1-2026-0001', 'M1-2026-0001-1']) {
      const r = fout(maak([HOOG], { nummer }));
      expect(r.veld).toBe('nummer');
      expect(r.melding).toContain('apparaatcode-jaar-volgnummer');
    }
    expect(fout(maak([HOOG], { nummer: 'M1-2026-0000' })).veld).toBe('nummer');
  });

  it('ongeldig: jaar in het nummer wijkt af van het jaar van de factuurdatum', () => {
    const r = fout(maak([HOOG], { nummer: 'M1-2025-0001' }));
    expect(r).toEqual({ ok: false, veld: 'nummer', melding: 'Het jaar in het factuurnummer moet gelijk zijn aan het jaar van de factuurdatum' });
  });

  it('ongeldig: volgnummer niet canoniek met voorloopnul', () => {
    const r = fout(maak([HOOG], { nummer: 'M1-2026-00001' }));
    expect(r.veld).toBe('nummer');
    expect(r.melding).toContain('voorloopnullen');
  });

  it('ongeldig: totalen die niet kloppen met de regels', () => {
    const base = maak([HOOG]);
    for (const t of [{ subtotaal: 9100, btw: 1910, totaal: 11011 }, { subtotaal: 9101, btw: 1911, totaal: 11012 }, { subtotaal: 9100, btw: 1911, totaal: 11000 }]) {
      expect(fout({ ...base, totalen: t })).toEqual({ ok: false, veld: 'totalen', melding: 'De totalen kloppen niet met de regels van de factuur' });
    }
  });

  it('ongeldig: centen die geen geheel getal zijn in prijs of totalen', () => {
    expect(fout(maak([{ ...HOOG, prijs: 45.5 }])).veld).toBe('regels[0].prijs');
    expect(fout({ ...maak([HOOG]), totalen: { subtotaal: 9100.5, btw: 1911, totaal: 11011 } }).veld).toBe('totalen.subtotaal');
  });

  it('ongeldig: ontbrekend btw-nummer klant bij ICP met de woordelijke melding uit de kern', () => {
    const r = fout(maak([{ omschrijving: 'Advies', hoeveelheid: 1, prijs: 80000, btw_soort: 'icp-dienst' }], { klant_momentopname: { ...KLANT_DE, vat_number: null } }));
    expect(r).toEqual({ ok: false, veld: 'factuur', melding: 'Bij btw verlegd moet het btw-nummer van Brot GmbH op de factuur staan. Vul het in bij de klant.' });
  });

  it('ongeldig: wettelijke controles gebruiken de KOR en het bedrijf uit de payload, woordelijk uit de kern', () => {
    const kor = { ...BEDRIJF, kor: true };
    expect(fout(maak([HOOG], { bedrijf_momentopname: kor })).melding).toBe('Je gebruikt de kleineondernemersregeling (KOR): je rekent geen btw. Kies bij elke regel "Geen btw".');
    expect(fout(maak([HOOG], { bedrijf_momentopname: { ...BEDRIJF, kvkNumber: '' } })).melding).toBe('Vul eerst je bedrijfsgegevens aan bij Instellingen: KvK-nummer');
    expect(fout(maak([HOOG], { klant_momentopname: { ...KLANT_NL, address: null } })).melding).toBe('Adres van Bakkerij De Korst ontbreekt (verplicht op een factuur)');
    const icpNL = maak([{ omschrijving: 'x', hoeveelheid: 1, prijs: 100, btw_soort: 'icp' }]);
    expect(fout(icpNL).melding).toContain('alleen voor klanten in een ander EU-land');
  });

  it('ongeldig: onbekend veld op het hoogste niveau, in een momentopname en in een regel', () => {
    expect(fout({ ...maak([HOOG]), betaald: true })).toMatchObject({ veld: 'betaald', melding: 'Het veld betaald bestaat niet voor een factuur en wordt niet bewaard' });
    expect(fout(maak([HOOG], { klant_momentopname: { ...KLANT_NL, id: 5 } })).veld).toBe('klant_momentopname.id');
    expect(fout(maak([HOOG], { bedrijf_momentopname: { ...BEDRIJF, extra: 'x' } })).veld).toBe('bedrijf_momentopname.extra');
    expect(fout(maak([{ ...HOOG, korting: 5 } as Regel])).veld).toBe('regels[0].korting');
    expect(fout({ ...maak([HOOG]), totalen: { ...totalen([HOOG]), extra: 1 } }).veld).toBe('totalen.extra');
  });

  it('ongeldig: __proto__ op top-niveau, in klant_momentopname en in een regel (ook constructor en prototype)', () => {
    const top = JSON.parse(`${JSON.stringify(maak([HOOG])).slice(0, -1)},"__proto__":{"x":1}}`);
    expect(fout(top).veld).toBe('__proto__');
    const klant = JSON.parse(JSON.stringify(maak([HOOG])));
    klant.klant_momentopname = JSON.parse(`${JSON.stringify(KLANT_NL).slice(0, -1)},"__proto__":{"x":1}}`);
    expect(fout(klant).veld).toBe('klant_momentopname.__proto__');
    const regel = JSON.parse(JSON.stringify(maak([HOOG])));
    regel.regels = [JSON.parse(`${JSON.stringify(HOOG).slice(0, -1)},"__proto__":{"x":1}}`)];
    expect(fout(regel).veld).toBe('regels[0].__proto__');
    for (const sleutel of ['constructor', 'prototype']) {
      expect(fout({ ...maak([HOOG]), [sleutel]: 1 }).veld).toBe(sleutel);
    }
  });

  it('ongeldig: nul regels', () => {
    expect(fout(maak([]))).toEqual({ ok: false, veld: 'regels', melding: 'Een factuur heeft minstens één regel' });
  });

  it('ongeldig: 201 regels', () => {
    const r = fout(maak(Array.from({ length: 201 }, () => ({ ...HOOG }))));
    expect(r).toEqual({ ok: false, veld: 'regels', melding: 'Een factuur heeft hoogstens 200 regels' });
  });

  it('ongeldig: omschrijving van 201 tekens, en lege omschrijving', () => {
    expect(fout(maak([{ ...HOOG, omschrijving: 'x'.repeat(201) }]))).toEqual({ ok: false, veld: 'regels[0].omschrijving', melding: 'Het veld regels[0].omschrijving is te lang (hoogstens 200 tekens)' });
    expect(fout(maak([{ ...HOOG, omschrijving: '  ' }])).veld).toBe('regels[0].omschrijving');
  });

  it('ongeldig: te lange tekst in intro, opmerking en momentopnamen', () => {
    expect(fout(maak([HOOG], { intro: 'x'.repeat(2001) })).veld).toBe('intro');
    expect(fout(maak([HOOG], { opmerking: 'x'.repeat(2001) })).veld).toBe('opmerking');
    expect(fout(maak([HOOG], { klant_momentopname: { ...KLANT_NL, name: 'x'.repeat(201) } })).veld).toBe('klant_momentopname.name');
    expect(fout(maak([HOOG], { bedrijf_momentopname: { ...BEDRIJF, city: 'x'.repeat(201) } })).veld).toBe('bedrijf_momentopname.city');
  });

  it('ongeldig: project_uuid geen uuid v4, en ook klant_uuid en creditnota_van niet', () => {
    for (const waarde of ['geen-uuid', '7A1C2D3E-4B5F-4A6B-9C7D-8E9F0A1B2C3D', '7a1c2d3e-4b5f-1a6b-9c7d-8e9f0a1b2c3d', 12, '']) {
      expect(fout(maak([HOOG], { project_uuid: waarde })).veld).toBe('project_uuid');
    }
    expect(fout(maak([HOOG], { klant_uuid: 'x' })).veld).toBe('klant_uuid');
    expect(fout(maak([HOOG], { creditnota_van: 'x' })).veld).toBe('creditnota_van');
  });

  it('ongeldig: datums die niet bestaan, vervaldatum voor de factuurdatum en leverdatum_tot voor leverdatum', () => {
    expect(fout(maak([HOOG], { datum: '2026-02-30' })).veld).toBe('datum');
    expect(fout(maak([HOOG], { vervaldatum: '15-04-2026' })).veld).toBe('vervaldatum');
    expect(fout(maak([HOOG], { vervaldatum: '2026-03-14' })).veld).toBe('vervaldatum');
    expect(fout(maak([HOOG], { leverdatum: '2026-03-10', leverdatum_tot: '2026-03-09' })).veld).toBe('leverdatum_tot');
    expect(fout(maak([HOOG], { leverdatum: 'gisteren' })).veld).toBe('leverdatum');
  });

  it('ongeldig: btw-soort onbekend, percentage dat er niet bij past en een hoeveelheid van nul', () => {
    expect(fout(maak([{ ...HOOG, btw_soort: 'toString' }])).veld).toBe('regels[0].btw_soort');
    expect(fout(maak([{ ...HOOG, btw_soort: 'inkoop-eu' }])).veld).toBe('regels[0].btw_soort');
    expect(fout(maak([{ ...HOOG, btw_soort: 'verlegd', btw_percentage: 21 }])).veld).toBe('regels[0].btw_percentage');
    expect(fout(maak([{ ...HOOG, btw_percentage: 101 }])).veld).toBe('regels[0].btw_percentage');
    expect(fout(maak([{ ...HOOG, hoeveelheid: 0 }])).veld).toBe('regels[0].hoeveelheid');
    expect(fout(maak([{ ...HOOG, hoeveelheid: Number.NaN }])).veld).toBe('regels[0].hoeveelheid');
  });

  it('ongeldig: verplichte velden ontbreken of hebben het verkeerde type', () => {
    for (const veld of ['nummer', 'datum', 'vervaldatum', 'klant_uuid', 'klant_momentopname', 'bedrijf_momentopname', 'regels', 'totalen', 'verzonden_op', 'regeltabel_versie']) {
      const { [veld]: _weg, ...rest } = maak([HOOG]);
      expect(fout(rest)).toEqual({ ok: false, veld, melding: `Het veld ${veld} ontbreekt` });
    }
    expect(fout(maak([HOOG], { bedrijf_momentopname: { ...BEDRIJF, kor: 'ja' } })).veld).toBe('bedrijf_momentopname.kor');
    expect(fout(maak([HOOG], { verzonden_op: 'vandaag' })).veld).toBe('verzonden_op');
    expect(fout(maak([HOOG], { regels: 'geen lijst' })).veld).toBe('regels');
    for (const raw of [null, 'tekst', 5, [], undefined]) expect(fout(raw).veld).toBe('velden');
  });

  it('ongeldig: een momentopname waarin verplichte velden ontbreken', () => {
    const { vat_number: _v, ...zonderBtw } = KLANT_NL;
    expect(fout(maak([HOOG], { klant_momentopname: zonderBtw })).veld).toBe('klant_momentopname.vat_number');
    const { kvkNumber: _k, ...zonderKvk } = BEDRIJF;
    expect(fout(maak([HOOG], { bedrijf_momentopname: zonderKvk })).veld).toBe('bedrijf_momentopname.kvkNumber');
  });

  it('ongeldig: verplichte gegevens met alleen spaties tellen als leeg (bedrijf en klant)', () => {
    const leeg = '   ';
    const bedrijf = leesFactuurVelden(maak([HOOG], { bedrijf_momentopname: { ...BEDRIJF, name: leeg, address: leeg, city: leeg, kvkNumber: leeg, vatNumber: leeg } }));
    expect(bedrijf.ok).toBe(false);
    if (!bedrijf.ok) expect(bedrijf.melding).toContain('Vul eerst je bedrijfsgegevens aan bij Instellingen');
    const klantAdres = leesFactuurVelden(maak([HOOG], { klant_momentopname: { ...KLANT_NL, address: leeg, city: leeg } }));
    expect(klantAdres.ok).toBe(false);
    if (!klantAdres.ok) expect(klantAdres.melding).toContain('ontbreekt (verplicht op een factuur)');
    // elk veld apart, zodat geen enkel veld door de mazen glipt
    for (const veld of ['name', 'address', 'city', 'kvkNumber', 'vatNumber'] as const) {
      expect(leesFactuurVelden(maak([HOOG], { bedrijf_momentopname: { ...BEDRIJF, [veld]: leeg } })).ok).toBe(false);
    }
    for (const veld of ['address', 'city'] as const) {
      expect(leesFactuurVelden(maak([HOOG], { klant_momentopname: { ...KLANT_NL, [veld]: leeg } })).ok).toBe(false);
    }
    // btw-nummer van de klant bij verlegging
    expect(leesFactuurVelden(maak([{ omschrijving: 'Onderaanneming', hoeveelheid: 1, prijs: 100000, btw_soort: 'verlegd' }], { klant_momentopname: { ...KLANT_NL, vat_number: leeg } })).ok).toBe(false);
  });

  it('ongeldig: bedragen zo groot dat de som niet meer exact is', () => {
    const r = fout(maak([{ ...HOOG, hoeveelheid: 1e10, prijs: 9_000_000_000_000 }]));
    expect(['regels[0].prijs', 'totalen']).toContain(r.veld);
  });
});
