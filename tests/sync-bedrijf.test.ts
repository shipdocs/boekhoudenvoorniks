import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup } from './helpers';
import {
  BEDRIJF_GEGEVENS_SLEUTELS,
  BEDRIJF_LIMIETEN,
  leesBedrijf,
  type Bedrijf,
} from '@gratis-boekhouden/kern';
import { DEFAULT_SETTINGS } from '../src/settings/settings';
import { leesStamgegevens, STAMGEGEVENS_PAGINA, leesCursor, type Cursor, type StamgegevensAntwoord } from '../src/sync/stamgegevens';
import { bedrijfVersie, bouwBedrijf } from '../src/sync/bedrijf';
import { LIMITS } from '../src/scanner/protocol';
import { DEFAULT_COLORS } from '../src/documents/templates';

// Het blok bedrijf op de eerste pagina van het stamgegevens-antwoord (s20): de bedrijfsgegevens van de
// administratie en het standaard factuursjabloon. Alles tegen een echte databank en de echte services;
// er is geen netwerk nodig. Er staan geen datums van vandaag in.

function start() {
  return setup();
}
type T = ReturnType<typeof start>;

const eerste = (t: T, sinds = 0): StamgegevensAntwoord => leesStamgegevens(t.db, { sinds, na: null });
const blok = (t: T, sinds = 0): Bedrijf => {
  const b = eerste(t, sinds).bedrijf;
  if (!b) throw new Error('geen blok bedrijf');
  return b;
};
const teller = (t: T) => (t.db.prepare(`SELECT waarde FROM sync_teller WHERE naam = 'wijziging'`).get() as { waarde: number }).waarde;
const standaard = (t: T) => t.s.templates.getDefault('factuur');

/** Een geldig blok (met een echte versie) om de lezer mee te toetsen; een kopie, zodat elke test het mag aanpassen. */
function geldig(): Bedrijf {
  return structuredClone(bouwBedrijf(start().db));
}
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

describe('blok bedrijf: inhoud en privacy', () => {
  it('het blok heeft precies de afgesproken sleutels', () => {
    const b = blok(start());
    expect(Object.keys(b)).toEqual(['versie', 'gegevens', 'kor', 'betaaltermijn_dagen', 'factuur']);
    expect(Object.keys(b.gegevens)).toEqual(['naam', 'adres', 'postcode', 'plaats', 'land', 'email', 'telefoon', 'website', 'kvk_nummer', 'btw_nummer', 'iban', 'bic']);
    expect(Object.keys(b.factuur)).toEqual(['kleuren', 'lettertype', 'logo', 'tekstblokken', 'html_template']);
    expect(Object.keys(b.factuur.kleuren)).toEqual(['primary', 'text', 'muted', 'accentBg']);
    expect(b.versie).toMatch(/^[0-9a-f]{16}$/);
  });

  it('de gegevens komen uit de instellingen van de administratie, leeg is een lege tekst', () => {
    const t = start();
    expect(blok(t).gegevens).toEqual({
      naam: 'Stukadoorsbedrijf Piet',
      adres: 'Kalkweg 1',
      postcode: '1234 AB',
      plaats: 'Utrecht',
      land: 'NL',
      email: 'piet@example.nl',
      telefoon: '',
      website: '',
      kvk_nummer: '12345678',
      btw_nummer: 'NL123456789B01',
      iban: 'NL91ABNA0417164300',
      bic: '',
    });
  });

  it('het omzetbelastingnummer gaat niet mee: niet als sleutel en niet als waarde', () => {
    const t = start();
    const geplant = 'OMZETBELASTING-9876543B21';
    t.s.settings.update({ company: { ...t.s.settings.get().company, omzetbelastingNumber: geplant } });
    const tekst = JSON.stringify(eerste(t));
    expect(tekst).not.toContain(geplant);
    expect(tekst.toLowerCase()).not.toContain('omzetbelasting');
    expect(Object.keys(blok(t).gegevens)).not.toContain('omzetbelastingNumber');
  });

  it('geen geheimen of instellingen: van alle instellingssleutels gaat alleen de witte lijst uit', () => {
    const t = start();
    // elke tekst in elke instelling wordt een herkenbare markering; de databank neemt het zonder controle aan
    const markeer = (x: unknown, pad: string): unknown => {
      if (typeof x === 'string') return `GEHEIM<${pad}>`;
      if (Array.isArray(x)) return x.map((v, i) => markeer(v, `${pad}[${i}]`));
      if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, markeer(v, `${pad}.${k}`)]));
      return x;
    };
    // sleutels met een lege tekst in de standaard krijgen ook een markering; en een paar extra sleutels die geen instelling zijn
    const upsert = t.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    const sleutels = Object.keys(DEFAULT_SETTINGS);
    expect(sleutels.length).toBeGreaterThan(20);
    for (const sleutel of sleutels) {
      const basis = sleutel === 'company' ? { ...DEFAULT_SETTINGS.company } : (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[sleutel];
      upsert.run(sleutel, JSON.stringify(markeer(basis, sleutel)));
    }
    for (const extra of ['administrationId', 'licentie', 'smtpWachtwoord', 'apiSleutel']) upsert.run(extra, JSON.stringify(`GEHEIM<${extra}>`));
    t.secrets.set('smtp-wachtwoord', 'GEHEIM<geheimenopslag>');
    const tekst = JSON.stringify(eerste(t));
    const gezien = new Set([...tekst.matchAll(/GEHEIM<([^>]*)>/g)].map((m) => m[1]));
    // precies de twaalf gegevens van het bedrijf, geen enkele andere instelling
    const verwacht = ['name', 'address', 'postcode', 'city', 'country', 'email', 'phone', 'website', 'kvkNumber', 'vatNumber', 'iban', 'bic'].map((k) => `company.${k}`);
    expect([...gezien].sort()).toEqual(verwacht.sort());
    expect(tekst).not.toContain('company.omzetbelastingNumber');
    // en de betaaltermijn en KOR zijn getallen/vlaggen uit de instellingen, geen markering
    expect(typeof blok(t).betaaltermijn_dagen).toBe('number');
  });

  it('het IBAN van de administratie staat alleen in het blok bedrijf', () => {
    const t = start();
    const a = eerste(t);
    const { bedrijf, ...rest } = a;
    expect(JSON.stringify(bedrijf)).toContain('NL91ABNA0417164300');
    expect(JSON.stringify(rest)).not.toContain('NL91ABNA0417164300');
  });
});

describe('blok bedrijf: eerste pagina, delta en vervolgpagina', () => {
  it('staat op de eerste pagina bij sinds 0', () => {
    expect(eerste(start(), 0).bedrijf).toBeDefined();
  });

  it('staat er ook als de delta leeg is', () => {
    const t = start();
    const sinds = teller(t);
    const a = eerste(t, sinds);
    expect(a.klanten).toEqual([]);
    expect(a.projecten).toEqual([]);
    expect(a.bedrijf).toEqual(blok(t));
  });

  it('staat er ook bij sinds groter dan nul met een gevulde delta', () => {
    const t = start();
    const sinds = teller(t);
    t.s.relations.create({ name: 'Nieuwe klant', type: 'klant' });
    const a = eerste(t, sinds);
    expect(a.klanten.length).toBe(1);
    expect(a.bedrijf?.gegevens.naam).toBe('Stukadoorsbedrijf Piet');
  });

  it('staat er niet op een vervolgpagina', () => {
    const t = start();
    for (let i = 0; i < STAMGEGEVENS_PAGINA + 20; i++) t.s.relations.create({ name: `Klant ${i}`, type: 'klant' });
    const p1 = eerste(t);
    expect(p1.bedrijf).toBeDefined();
    expect(p1.volgende).not.toBeNull();
    const cursor = leesCursor(p1.volgende) as Cursor;
    const p2 = leesStamgegevens(t.db, { sinds: 0, na: cursor });
    expect('bedrijf' in p2).toBe(false);
    expect('regeltabel' in p2).toBe(false);
  });

  it('is het antwoord van een leesbare lezer: de pc leest zijn eigen blok terug', () => {
    const t = start();
    const b = blok(t);
    const r = leesBedrijf(JSON.parse(JSON.stringify(b)));
    expect(r).toEqual({ ok: true, bedrijf: b });
  });
});

describe('blok bedrijf: versie, kor, betaaltermijn en sjabloon', () => {
  it('dezelfde inhoud geeft dezelfde versie, ook na een schrijfactie die niets verandert', () => {
    const t = start();
    const v = blok(t).versie;
    expect(blok(t).versie).toBe(v);
    t.s.settings.update({ company: { ...t.s.settings.get().company } });
    expect(blok(t).versie).toBe(v);
    // naar iets anders en terug: weer dezelfde versie
    t.s.settings.update({ kor: true });
    expect(blok(t).versie).not.toBe(v);
    t.s.settings.update({ kor: false });
    expect(blok(t).versie).toBe(v);
  });

  it('de versie verandert bij elke wijziging van een gegeven', () => {
    const t = start();
    const zonder = blok(t).versie;
    const instellingen = { naam: 'name', adres: 'address', postcode: 'postcode', plaats: 'city', land: 'country', email: 'email', telefoon: 'phone', website: 'website', kvk_nummer: 'kvkNumber', btw_nummer: 'vatNumber', iban: 'iban', bic: 'bic' } as const;
    const waarden = { name: 'Andere Naam', address: 'Andere weg 2', postcode: '9999 ZZ', city: 'Zwolle', country: 'BE', email: 'ander@example.nl', phone: '06-99999999', website: 'https://example.nl', kvkNumber: '87654321', vatNumber: 'NL999999999B99', iban: 'NL02ABNA0123456789', bic: 'ABNANL2A' } as const;
    const versies = new Set<string>([zonder]);
    for (const sleutel of BEDRIJF_GEGEVENS_SLEUTELS) {
      const veld = instellingen[sleutel];
      const oud = t.s.settings.get().company;
      t.s.settings.update({ company: { ...oud, [veld]: waarden[veld] } });
      const b = blok(t);
      expect(b.gegevens[sleutel]).toBe(waarden[veld]);
      expect(versies.has(b.versie), `${sleutel} verandert de versie`).toBe(false);
      versies.add(b.versie);
    }
    expect(versies.size).toBe(BEDRIJF_GEGEVENS_SLEUTELS.length + 1);
  });

  it('de versie verandert bij kor, betaaltermijn en elk deel van het sjabloon', () => {
    const t = start();
    const gezien = new Set<string>([blok(t).versie]);
    const nu = (label: string) => {
      const v = blok(t).versie;
      expect(gezien.has(v), label).toBe(false);
      gezien.add(v);
    };
    t.s.settings.update({ kor: true });
    nu('kor');
    t.s.settings.update({ paymentTermDays: 30 });
    nu('betaaltermijn');
    const id = standaard(t).id;
    const kleuren = standaard(t).colors;
    for (const naam of ['primary', 'text', 'muted', 'accentBg'] as const) {
      t.s.templates.update(id, { colors: { ...standaard(t).colors, [naam]: '#123456' } });
      nu(`kleur ${naam}`);
    }
    expect(standaard(t).colors).not.toEqual(kleuren);
    t.s.templates.update(id, { font: 'Georgia, serif' });
    nu('lettertype');
    t.s.templates.update(id, { logo: PNG });
    nu('logo');
    t.s.templates.update(id, { text_blocks: [{ title: 'Betaling', text: 'Binnen 14 dagen.' }] });
    nu('tekstblok');
    t.s.templates.update(id, { html_template: '<html><body>{{doc.number}}</body></html>' });
    nu('html');
  });

  it('de versie is de eerste 16 hexcijfers van de sha256 over de canonieke JSON van de inhoud', () => {
    const b = blok(start());
    const { versie, ...inhoud } = b;
    expect(bedrijfVersie(inhoud)).toBe(versie);
    // de volgorde van de sleutels maakt niet uit
    const omgekeerd = { factuur: inhoud.factuur, betaaltermijn_dagen: inhoud.betaaltermijn_dagen, kor: inhoud.kor, gegevens: inhoud.gegevens };
    expect(bedrijfVersie(omgekeerd)).toBe(versie);
  });

  it('de KOR-vlag volgt de instelling die de factuuropmaak gebruikt', () => {
    const t = start();
    expect(blok(t).kor).toBe(false);
    t.s.settings.update({ kor: true });
    expect(blok(t).kor).toBe(true);
    t.s.settings.update({ kor: false });
    expect(blok(t).kor).toBe(false);
  });

  it('de betaaltermijn is de standaardtermijn van de administratie', () => {
    const t = start();
    expect(blok(t).betaaltermijn_dagen).toBe(14);
    t.s.settings.update({ paymentTermDays: 0 });
    expect(blok(t).betaaltermijn_dagen).toBe(0);
    t.s.settings.update({ paymentTermDays: 365 });
    expect(blok(t).betaaltermijn_dagen).toBe(365);
  });

  it('het standaard factuursjabloon gaat mee, een ander sjabloon en de offerte niet', () => {
    const t = start();
    const ander = t.s.templates.create({ name: 'Andere factuur', type: 'factuur', colors: { primary: '#aa0000', text: '#000000', muted: '#888888', accentBg: '#ffeeee' }, font: 'Georgia, serif', text_blocks: [{ title: 'Ander', text: 'Anders' }] });
    t.s.templates.update(t.s.templates.getDefault('offerte').id, { colors: { ...DEFAULT_COLORS, primary: '#00aa00' } });
    const b = blok(t);
    expect(b.factuur.kleuren.primary).toBe('#1f4e79');
    expect(b.factuur.lettertype).toBe('Helvetica, Arial, sans-serif');
    expect(b.factuur.tekstblokken).toEqual([{ titel: 'Voorwaarden', tekst: 'Op al onze werkzaamheden zijn onze algemene voorwaarden van toepassing.' }]);
    const tekst = JSON.stringify(eerste(t));
    expect(tekst).not.toContain('#aa0000');
    expect(tekst).not.toContain('#00aa00');
    expect(tekst).not.toContain('Andere factuur');
    // wordt het andere sjabloon de standaard, dan gaat dat mee
    t.s.templates.setDefault(ander.id);
    const na = blok(t);
    expect(na.factuur.kleuren.primary).toBe('#aa0000');
    expect(na.factuur.lettertype).toBe('Georgia, serif');
    expect(na.factuur.tekstblokken).toEqual([{ titel: 'Ander', tekst: 'Anders' }]);
    expect(na.versie).not.toBe(b.versie);
  });

  it('het logo is null zonder logo en een data-URL met logo', () => {
    const t = start();
    expect(blok(t).factuur.logo).toBeNull();
    t.s.templates.update(standaard(t).id, { logo: PNG });
    expect(blok(t).factuur.logo).toBe(PNG);
    t.s.templates.update(standaard(t).id, { logo: null });
    expect(blok(t).factuur.logo).toBeNull();
  });

  it('een eigen html-sjabloon gaat mee, zonder eigen sjabloon is het null', () => {
    const t = start();
    expect(blok(t).factuur.html_template).toBeNull();
    const html = '<!doctype html><p>{{company.name}}</p>';
    t.s.templates.update(standaard(t).id, { html_template: html });
    expect(blok(t).factuur.html_template).toBe(html);
  });
});

describe('blok bedrijf: de strikte lezer leesBedrijf', () => {
  const fout = (invoer: unknown) => {
    const r = leesBedrijf(invoer);
    if (r.ok) throw new Error('had geweigerd moeten worden');
    return r;
  };

  it('neemt een geldig blok aan en geeft een kopie terug', () => {
    const b = geldig();
    const r = leesBedrijf(b);
    expect(r).toEqual({ ok: true, bedrijf: b });
    if (r.ok) {
      expect(r.bedrijf).not.toBe(b);
      expect(r.bedrijf.gegevens).not.toBe(b.gegevens);
      expect(r.bedrijf.factuur.kleuren).not.toBe(b.factuur.kleuren);
    }
  });

  it('weigert iets wat geen object is', () => {
    for (const x of [null, undefined, 'tekst', 5, [], [geldig()]]) expect(fout(x).veld).toBe('bedrijf');
  });

  it('weigert een onbekende sleutel, op elk niveau', () => {
    const b = geldig();
    expect(fout({ ...b, extra: 1 })).toMatchObject({ veld: 'extra' });
    expect(fout({ ...b, gegevens: { ...b.gegevens, omzetbelastingNumber: '1' } })).toMatchObject({ veld: 'gegevens.omzetbelastingNumber' });
    expect(fout({ ...b, factuur: { ...b.factuur, offerte: null } })).toMatchObject({ veld: 'factuur.offerte' });
    expect(fout({ ...b, factuur: { ...b.factuur, kleuren: { ...b.factuur.kleuren, rood: '#f00' } } })).toMatchObject({ veld: 'factuur.kleuren.rood' });
    expect(fout({ ...b, factuur: { ...b.factuur, tekstblokken: [{ titel: 'a', tekst: 'b', extra: 'c' }] } })).toMatchObject({ veld: 'factuur.tekstblokken[0].extra' });
    // ook een __proto__-sleutel uit JSON is gewoon een onbekende sleutel
    expect(fout(JSON.parse(`{"__proto__":{"x":1},"versie":"${b.versie}"}`))).toMatchObject({ veld: '__proto__' });
  });

  it('weigert een ontbrekende sleutel, op elk niveau', () => {
    const b = geldig();
    for (const k of ['versie', 'gegevens', 'kor', 'betaaltermijn_dagen', 'factuur'] as const) {
      const { [k]: _weg, ...rest } = b;
      expect(fout(rest)).toMatchObject({ veld: k, melding: `${k} ontbreekt` });
    }
    const { bic: _bic, ...zonderBic } = b.gegevens;
    expect(fout({ ...b, gegevens: zonderBic })).toMatchObject({ veld: 'gegevens.bic' });
    const { logo: _logo, ...zonderLogo } = b.factuur;
    expect(fout({ ...b, factuur: zonderLogo })).toMatchObject({ veld: 'factuur.logo' });
    const { html_template: _html, ...zonderHtml } = b.factuur;
    expect(fout({ ...b, factuur: zonderHtml })).toMatchObject({ veld: 'factuur.html_template' });
  });

  it('weigert een ongeldige versie', () => {
    const b = geldig();
    for (const v of ['', 'ABCDEF0123456789', '0123456789abcde', '0123456789abcdef0', 'zzzzzzzzzzzzzzzz', 16, null]) expect(fout({ ...b, versie: v }).veld).toBe('versie');
  });

  it('weigert een gegeven dat geen tekst is of te lang is, met een gewone melding', () => {
    const b = geldig();
    expect(fout({ ...b, gegevens: { ...b.gegevens, iban: 5 } })).toMatchObject({ veld: 'gegevens.iban', melding: 'gegevens.iban moet een tekst zijn' });
    expect(fout({ ...b, gegevens: { ...b.gegevens, iban: null } }).veld).toBe('gegevens.iban');
    expect(fout({ ...b, gegevens: { ...b.gegevens, naam: 'x'.repeat(201) } }).melding).toMatch(/te lang \(hoogstens 200 tekens\)/);
    expect(leesBedrijf({ ...b, gegevens: { ...b.gegevens, naam: 'x'.repeat(200) } }).ok).toBe(true);
    // het adres mag langer
    expect(leesBedrijf({ ...b, gegevens: { ...b.gegevens, adres: 'x'.repeat(500) } }).ok).toBe(true);
    expect(fout({ ...b, gegevens: { ...b.gegevens, adres: 'x'.repeat(501) } }).veld).toBe('gegevens.adres');
  });

  it('weigert een kor die geen boolean is en een betaaltermijn buiten 0 tot 365', () => {
    const b = geldig();
    for (const kor of [0, 1, 'true', null]) expect(fout({ ...b, kor }).veld).toBe('kor');
    for (const dagen of [-1, 366, 1.5, '14', null, NaN, Infinity]) expect(fout({ ...b, betaaltermijn_dagen: dagen }).veld).toBe('betaaltermijn_dagen');
    expect(leesBedrijf({ ...b, betaaltermijn_dagen: 0 }).ok).toBe(true);
    expect(leesBedrijf({ ...b, betaaltermijn_dagen: 365 }).ok).toBe(true);
  });

  it('weigert een ongeldige kleur en neemt de geldige schrijfwijzen aan', () => {
    const b = geldig();
    const metKleur = (primary: unknown) => ({ ...b, factuur: { ...b.factuur, kleuren: { ...b.factuur.kleuren, primary } } });
    for (const k of ['rood', '#12', '#12345', '#1234567', '#123456789', '123456', '#gggggg', '#12 456', '', 5, null]) expect(fout(metKleur(k)).veld, String(k)).toBe('factuur.kleuren.primary');
    for (const k of ['#abc', '#ABCD', '#1f4e79', '#1f4e79ff']) expect(leesBedrijf(metKleur(k)).ok, k).toBe(true);
  });

  it('weigert een logo met een verkeerde vorm en een te groot logo', () => {
    const b = geldig();
    const metLogo = (logo: unknown) => ({ ...b, factuur: { ...b.factuur, logo } });
    for (const l of ['https://example.nl/logo.png', 'data:image/gif;base64,AAAA', 'data:image/png;base64,', 'data:image/png;base64,@@@@', 'data:text/html;base64,AAAA', 'AAAA', '', 5]) expect(fout(metLogo(l)).veld, String(l)).toBe('factuur.logo');
    for (const mime of ['png', 'jpeg', 'svg+xml', 'webp']) expect(leesBedrijf(metLogo(`data:image/${mime};base64,AAAA`)).ok, mime).toBe(true);
    const kop = 'data:image/png;base64,';
    expect(leesBedrijf(metLogo(kop + 'A'.repeat(BEDRIJF_LIMIETEN.maxLogoBytes - kop.length))).ok).toBe(true);
    expect(fout(metLogo(kop + 'A'.repeat(BEDRIJF_LIMIETEN.maxLogoBytes - kop.length + 1)))).toMatchObject({ veld: 'factuur.logo', melding: 'factuur.logo is te groot' });
  });

  it('de logogrens is dezelfde als waarmee de pc een logo opslaat', () => {
    const t = start();
    const kop = 'data:image/png;base64,';
    expect(() => t.s.templates.update(standaard(t).id, { logo: kop + 'A'.repeat(BEDRIJF_LIMIETEN.maxLogoBytes - kop.length + 1) })).toThrow(/te groot/);
    t.s.templates.update(standaard(t).id, { logo: kop + 'A'.repeat(BEDRIJF_LIMIETEN.maxLogoBytes - kop.length) });
    expect(blok(t).factuur.logo?.length).toBe(BEDRIJF_LIMIETEN.maxLogoBytes);
  });

  it('weigert slechte tekstblokken: te veel, te lang, geen lijst, geen object', () => {
    const b = geldig();
    const metBlokken = (tekstblokken: unknown) => ({ ...b, factuur: { ...b.factuur, tekstblokken } });
    const blokje = { titel: 'Titel', tekst: 'Tekst' };
    expect(leesBedrijf(metBlokken(Array.from({ length: BEDRIJF_LIMIETEN.maxTekstblokken }, () => blokje))).ok).toBe(true);
    expect(fout(metBlokken(Array.from({ length: BEDRIJF_LIMIETEN.maxTekstblokken + 1 }, () => blokje))).veld).toBe('factuur.tekstblokken');
    expect(fout(metBlokken('Voorwaarden')).veld).toBe('factuur.tekstblokken');
    expect(fout(metBlokken([blokje, 'tekst'])).veld).toBe('factuur.tekstblokken[1]');
    expect(fout(metBlokken([{ titel: 't'.repeat(201), tekst: 'x' }])).veld).toBe('factuur.tekstblokken[0].titel');
    expect(fout(metBlokken([{ titel: 't', tekst: 'x'.repeat(4001) }])).veld).toBe('factuur.tekstblokken[0].tekst');
    expect(fout(metBlokken([{ titel: 't' }])).veld).toBe('factuur.tekstblokken[0].tekst');
    expect(leesBedrijf(metBlokken([{ titel: 't'.repeat(200), tekst: 'x'.repeat(4000) }])).ok).toBe(true);
  });

  it('weigert een te groot of leeg html-sjabloon en een slecht lettertype', () => {
    const b = geldig();
    const metFactuur = (extra: Record<string, unknown>) => ({ ...b, factuur: { ...b.factuur, ...extra } });
    expect(leesBedrijf(metFactuur({ html_template: 'x'.repeat(BEDRIJF_LIMIETEN.maxHtmlTekens) })).ok).toBe(true);
    expect(fout(metFactuur({ html_template: 'x'.repeat(BEDRIJF_LIMIETEN.maxHtmlTekens + 1) })).veld).toBe('factuur.html_template');
    expect(fout(metFactuur({ html_template: '   ' })).veld).toBe('factuur.html_template');
    expect(fout(metFactuur({ html_template: 5 })).veld).toBe('factuur.html_template');
    expect(fout(metFactuur({ lettertype: 'Arial; } body { display:none' })).veld).toBe('factuur.lettertype');
    expect(fout(metFactuur({ lettertype: 5 })).veld).toBe('factuur.lettertype');
  });

  it('de lezer in de kern gebruikt geen Node', () => {
    const bron = readFileSync(join(__dirname, '..', 'packages', 'core', 'src', 'sync', 'bedrijf.ts'), 'utf8');
    const code = bron.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    expect(code).not.toMatch(/from 'node:|\bBuffer\b|\bprocess\.|require\(/);
  });
});

describe('blok bedrijf: grootte', () => {
  it('een eerste pagina met het grootste blok past ruim binnen maxBodyBytes', () => {
    const kop = 'data:image/svg+xml;base64,';
    const max: Bedrijf = {
      versie: '0123456789abcdef',
      gegevens: Object.fromEntries(BEDRIJF_GEGEVENS_SLEUTELS.map((k) => [k, '\u{1F600}'.repeat((k === 'adres' ? BEDRIJF_LIMIETEN.maxAdresTekens : BEDRIJF_LIMIETEN.maxTekens) / 2)])) as Bedrijf['gegevens'],
      kor: true,
      betaaltermijn_dagen: 365,
      factuur: {
        kleuren: { primary: '#12345678', text: '#12345678', muted: '#12345678', accentBg: '#12345678' },
        lettertype: 'x'.repeat(BEDRIJF_LIMIETEN.maxLettertypeTekens),
        logo: kop + 'A'.repeat(BEDRIJF_LIMIETEN.maxLogoBytes - kop.length),
        tekstblokken: Array.from({ length: BEDRIJF_LIMIETEN.maxTekstblokken }, () => ({ titel: '\u{1F600}'.repeat(BEDRIJF_LIMIETEN.maxTitelTekens / 2), tekst: '\u{1F600}'.repeat(BEDRIJF_LIMIETEN.maxBlokTekens / 2) })),
        html_template: '\u{1F600}'.repeat(BEDRIJF_LIMIETEN.maxHtmlTekens / 2),
      },
    };
    expect(leesBedrijf(JSON.parse(JSON.stringify(max))).ok).toBe(true);
    // een eerste pagina met 100 klanten en projecten blijft hooguit zo'n 1,5 MiB (zie het protocoldocument); reken ruim 3 MiB
    const bytes = Buffer.byteLength(JSON.stringify({ bedrijf: max }), 'utf8');
    expect(bytes).toBeLessThan(LIMITS.maxBodyBytes - 3 * 1024 * 1024);
    expect(bytes).toBeLessThan(3 * 1024 * 1024);
  });
});

describe('blok bedrijf: het uitgewerkte voorbeeld in het protocoldocument', () => {
  const doc = readFileSync(join(__dirname, '..', 'docs', 'bonnenscanner-protocol.md'), 'utf8').replace(/\r\n/g, '\n');
  const uitgewerkt = JSON.parse(/```jsonc\n(\{\n {2}"versie"[\s\S]*?\n\})\n```/.exec(doc)![1]!) as unknown;
  const inAntwoord = (() => {
    const blokken = [...doc.matchAll(/```text\n([\s\S]*?)```/g)].map((m) => m[1]!.trim()).filter((b) => b.startsWith('{"ok":true,"soort":"stamgegevens"'));
    return (JSON.parse(blokken[0]!) as { bedrijf: unknown }).bedrijf;
  })();

  it('het voorbeeld is een geldig blok voor de strikte lezer', () => {
    const r = leesBedrijf(uitgewerkt);
    expect(r.ok).toBe(true);
  });

  it('het voorbeeld in het volledige antwoord is hetzelfde blok', () => {
    expect(inAntwoord).toEqual(uitgewerkt);
  });

  it('de versie in het voorbeeld klopt met de inhoud', () => {
    const { versie, ...inhoud } = uitgewerkt as Bedrijf;
    expect(bedrijfVersie(inhoud)).toBe(versie);
  });

  it('een administratie met deze gegevens geeft precies dit blok', () => {
    const t = start();
    t.s.settings.update({ company: { ...t.s.settings.get().company, phone: '06-12345678' } });
    expect(blok(t)).toEqual(uitgewerkt);
  });

  it('het document noemt het blok bedrijf, de grenzen en de aangepaste privacygrens', () => {
    expect(doc).toContain('**Het blok bedrijf (`bedrijf`).**');
    expect(doc).toContain('leesBedrijf');
    expect(doc).toContain('BEDRIJF_LIMIETEN');
    expect(doc).toMatch(/Privacygrens\.\*\*[^]*?blok `bedrijf`[^]*?op de enige plek na/);
    expect(doc).not.toContain('het IBAN van de administratie zelf niet');
  });
});

describe('blok bedrijf: veerkracht bij bestaande waarden die de strengere lezer afwijst', () => {
  // De instellingen en sjablonen van de pc zijn ruimer dan de lezer; deze waarden komen dus rechtstreeks in
  // de databank (zoals een oudere versie ze kan hebben opgeslagen). Het antwoord moet er nooit door falen.
  const schrijfBedrijf = (t: T, patch: Record<string, unknown>) => {
    const huidig = t.s.settings.get().company;
    t.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('company', JSON.stringify({ ...huidig, ...patch }));
  };
  const schrijfSjabloon = (t: T, kolommen: Record<string, string | null>) => {
    for (const [kolom, waarde] of Object.entries(kolommen)) t.db.prepare(`UPDATE templates SET ${kolom} = ? WHERE type = 'factuur' AND is_default = 1`).run(waarde);
  };
  const metLog = (t: T) => {
    const regels: string[] = [];
    const a = leesStamgegevens(t.db, { sinds: 0, na: null }, (m) => regels.push(m));
    return { a, b: a.bedrijf!, regels };
  };

  it('een te lange bedrijfsnaam wordt afgekapt op de grens, het adres op zijn eigen grens', () => {
    const t = start();
    schrijfBedrijf(t, { name: 'n'.repeat(5000), address: 'a'.repeat(5000), iban: 'i'.repeat(300) });
    const { b, regels } = metLog(t);
    expect(b.gegevens.naam).toBe('n'.repeat(BEDRIJF_LIMIETEN.maxTekens));
    expect(b.gegevens.adres).toBe('a'.repeat(BEDRIJF_LIMIETEN.maxAdresTekens));
    expect(b.gegevens.iban.length).toBe(BEDRIJF_LIMIETEN.maxTekens);
    expect(leesBedrijf(b).ok).toBe(true);
    // het logboek noemt de aanpassing, nooit de inhoud
    expect(regels).toHaveLength(1);
    expect(regels[0]).toContain('gegeven-afgekapt');
    expect(regels[0]).not.toContain('nnnn');
  });

  it('afkappen knipt geen emoji doormidden', () => {
    const t = start();
    schrijfBedrijf(t, { name: 'x'.repeat(BEDRIJF_LIMIETEN.maxTekens - 1) + '\u{1F600}' });
    const naam = blok(t).gegevens.naam;
    expect(naam).toBe('x'.repeat(BEDRIJF_LIMIETEN.maxTekens - 1));
  });

  it('een ongeldige kleur wordt de standaardkleur, de andere kleuren blijven', () => {
    const t = start();
    schrijfSjabloon(t, { colors: JSON.stringify({ primary: '#12345', text: 'rood', muted: '#abcdef', accentBg: '#1234567' }) });
    const { b, regels } = metLog(t);
    expect(b.factuur.kleuren).toEqual({ primary: DEFAULT_COLORS.primary, text: DEFAULT_COLORS.text, muted: '#abcdef', accentBg: DEFAULT_COLORS.accentBg });
    expect(regels[0]).toContain('kleur-vervangen');
  });

  it('een ongeldig lettertype wordt het standaardlettertype', () => {
    const t = start();
    schrijfSjabloon(t, { font: 'Arial; } body { display:none' });
    expect(blok(t).factuur.lettertype).toBe('Helvetica, Arial, sans-serif');
  });

  it('een logo met een verkeerde vorm of te groot wordt null', () => {
    const t = start();
    schrijfSjabloon(t, { logo: 'https://example.nl/logo.png' });
    const { b, regels } = metLog(t);
    expect(b.factuur.logo).toBeNull();
    expect(regels[0]).toContain('logo-genegeerd');
    const kop = 'data:image/png;base64,';
    schrijfSjabloon(t, { logo: kop + 'A'.repeat(BEDRIJF_LIMIETEN.maxLogoBytes) });
    expect(blok(t).factuur.logo).toBeNull();
    // een geldig logo blijft
    schrijfSjabloon(t, { logo: PNG });
    expect(blok(t).factuur.logo).toBe(PNG);
  });

  it('een html-sjabloon boven de grens wordt null, een sjabloon op de grens blijft', () => {
    const t = start();
    schrijfSjabloon(t, { html_template: 'x'.repeat(BEDRIJF_LIMIETEN.maxHtmlTekens + 1) });
    const { b, regels } = metLog(t);
    expect(b.factuur.html_template).toBeNull();
    expect(regels[0]).toContain('sjabloon-genegeerd');
    schrijfSjabloon(t, { html_template: 'x'.repeat(BEDRIJF_LIMIETEN.maxHtmlTekens) });
    expect(blok(t).factuur.html_template?.length).toBe(BEDRIJF_LIMIETEN.maxHtmlTekens);
  });

  it('te veel of te lange tekstblokken worden afgekapt op de grens', () => {
    const t = start();
    const veel = Array.from({ length: BEDRIJF_LIMIETEN.maxTekstblokken + 5 }, (_, i) => ({ title: `Blok ${i}`, text: 'tekst' }));
    veel[0] = { title: 't'.repeat(500), text: 'x'.repeat(9000) };
    schrijfSjabloon(t, { text_blocks: JSON.stringify(veel) });
    const { b, regels } = metLog(t);
    expect(b.factuur.tekstblokken).toHaveLength(BEDRIJF_LIMIETEN.maxTekstblokken);
    expect(b.factuur.tekstblokken[0]).toEqual({ titel: 't'.repeat(BEDRIJF_LIMIETEN.maxTitelTekens), tekst: 'x'.repeat(BEDRIJF_LIMIETEN.maxBlokTekens) });
    expect(b.factuur.tekstblokken[1]!.titel).toBe('Blok 1');
    expect(regels[0]).toContain('tekstblokken-afgekapt');
    expect(regels[0]).toContain('tekstblok-afgekapt');
  });

  it('een betaaltermijn buiten 0 tot 365 wordt 14', () => {
    const t = start();
    for (const waarde of [-5, 366, 1.5, 'veertien']) {
      t.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('paymentTermDays', JSON.stringify(waarde));
      expect(blok(t).betaaltermijn_dagen, String(waarde)).toBe(14);
    }
  });

  it('een onleesbaar sjabloon (kapotte JSON) geeft de standaardopmaak en het antwoord blijft compleet', () => {
    const t = start();
    t.s.relations.create({ name: 'Klant', type: 'klant' });
    schrijfSjabloon(t, { colors: '{kapot', text_blocks: 'ook kapot' });
    const { a, b } = metLog(t);
    expect(a.klanten.length).toBeGreaterThan(0);
    expect(b.factuur).toEqual({ kleuren: DEFAULT_COLORS, lettertype: 'Helvetica, Arial, sans-serif', logo: null, tekstblokken: [], html_template: null });
  });

  it('alles tegelijk te streng: leesStamgegevens gooit niet, levert klanten en een geldig blok, en de versie hoort bij de herstelde inhoud', () => {
    const t = start();
    const klant = t.s.relations.create({ name: 'Blijft geleverd', type: 'klant' });
    schrijfBedrijf(t, { name: 'n'.repeat(9000), email: 'e'.repeat(9000) });
    schrijfSjabloon(t, { colors: JSON.stringify({ primary: '#1' }), logo: 'geen-logo', html_template: 'h'.repeat(BEDRIJF_LIMIETEN.maxHtmlTekens * 2), font: '<>' });
    t.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('paymentTermDays', '9999');
    let a!: StamgegevensAntwoord;
    expect(() => (a = leesStamgegevens(t.db, { sinds: 0, na: null }))).not.toThrow();
    expect(a.klanten.map((k) => k.velden.naam!.waarde)).toContain('Blijft geleverd');
    const b = a.bedrijf!;
    expect(leesBedrijf(JSON.parse(JSON.stringify(b)))).toEqual({ ok: true, bedrijf: b });
    const { versie, ...inhoud } = b;
    expect(bedrijfVersie(inhoud)).toBe(versie);
    expect(klant.id).toBeGreaterThan(0);
  });

  it('een geldige administratie meldt niets in het logboek', () => {
    expect(metLog(start()).regels).toEqual([]);
  });

  it('de telefoon merkt het niet: het blok heeft dezelfde sleutels als zonder aanpassing', () => {
    const t = start();
    const normaal = Object.keys(blok(t).factuur);
    schrijfSjabloon(t, { logo: 'kapot', html_template: 'h'.repeat(BEDRIJF_LIMIETEN.maxHtmlTekens + 1) });
    expect(Object.keys(blok(t))).toEqual(['versie', 'gegevens', 'kor', 'betaaltermijn_dagen', 'factuur']);
    expect(Object.keys(blok(t).factuur)).toEqual(normaal);
  });
});
