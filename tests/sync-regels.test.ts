import { describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup } from './helpers';
import { EU_B2C_THRESHOLD, EU_COUNTRIES, ICP_SERVICE_TEXT, ICP_TEXT, OUTSIDE_EU_SERVICE_TEXT, REGELTABEL, REGELTABEL_VERSIE, SALES_VAT_RATES, VERLEGD_TEXT, saleVatText, type SalesVatCode } from '@gratis-boekhouden/kern';
import { leesStamgegevens, STAMGEGEVENS_PAGINA, type Cursor, type StamgegevensAntwoord } from '../src/sync/stamgegevens';
import { leesCursor } from '../src/sync/stamgegevens';
import { maakJobAan } from '../src/jobs/revisie';
import { volgendeSyncSeq } from '../src/sync/teller';

// De btw-regeltabel en de VIES-controledatum in het stamgegevens-antwoord (s14a). Alles tegen een echte
// databank, de echte RelationsService en de echte ViesService; alleen het netwerk van VIES is nagebootst.
// Datums zijn relatief aan nu; er staat nergens een letterlijke datum van vandaag in.

type Fetch = NonNullable<Parameters<typeof setup>[0]>['fetch'];

/** VIES-antwoorden per landcode: DE geldig (met geplante naam en adres), FR ongeldig, ES geen uitslag. */
const vliesFetch: Fetch = async (url) => {
  const land = /\/ms\/([A-Z]{2})\//.exec(url)?.[1];
  if (land === 'ES') throw new Error('netwerk');
  const geldig = land !== 'FR';
  const body = { isValid: geldig, name: 'GEHEIMENAAM-VIES BV', address: 'GEHEIMSTRAAT-VIES 99' };
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};

function start() {
  const t = setup({ fetch: vliesFetch });
  return { ...t, nu: Date.now() };
}
type T = ReturnType<typeof start>;

const pagina = (t: T, sinds = 0, na: Cursor | null = null): StamgegevensAntwoord => leesStamgegevens(t.db, { sinds, na });
const teller = (t: T) => (t.db.prepare(`SELECT waarde FROM sync_teller WHERE naam = 'wijziging'`).get() as { waarde: number }).waarde;
const rij = <R>(t: T, sql: string, ...p: unknown[]) => t.db.prepare(sql).get(...p) as R;

function maakKlant(t: T, naam: string, btw?: string) {
  const r = t.s.relations.create({ name: naam, type: 'klant', ...(btw ? { vat_number: btw, country: btw.slice(0, 2) } : {}) });
  return { id: r.id, uuid: rij<{ uuid: string }>(t, 'SELECT uuid FROM relations WHERE id = ?', r.id).uuid };
}

/** de hele ronde: pagina's volgen tot volgende null */
function ronde(t: T, sinds = 0) {
  const paginas: StamgegevensAntwoord[] = [];
  let na: Cursor | null = null;
  for (let i = 0; i < 50; i++) {
    const p = pagina(t, sinds, na);
    paginas.push(p);
    if (p.volgende === null) break;
    na = leesCursor(p.volgende);
  }
  return { paginas, klanten: paginas.flatMap((p) => p.klanten), projecten: paginas.flatMap((p) => p.projecten), verborgen: paginas.flatMap((p) => p.verborgen) };
}

/** canonieke JSON: sleutels gesorteerd, zodat de volgorde van opschrijven niet uitmaakt */
function canoniek(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canoniek).join(',')}]`;
  if (x && typeof x === 'object') return `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${canoniek((x as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(x);
}

/** de vingerafdruk van de inhoud van REGELTABEL_VERSIE '2026-1': hoger de versie op en werk deze waarde bij als de tabel bewust verandert */
const VINGERAFDRUK_2026_1 = '01d8a7327f2268b6a39aec46e7cc66fa496692294819436765de6a5b62f352ae';

describe('btw-regeltabel en VIES in de stamgegevens', () => {
  it('REGEL-01 kern: de regeltabel bevat alle verkoop-btw-soorten uit SALES_VAT_RATES (code, label, percentage, rubriek), de EU-landen en de drempels, en is zuiver (geen Node-afhankelijkheden).', () => {
    const codes = Object.keys(SALES_VAT_RATES) as SalesVatCode[];
    expect(REGELTABEL.btw.map((b) => b.code)).toEqual(codes);
    for (const b of REGELTABEL.btw) {
      const bron = SALES_VAT_RATES[b.code];
      expect(b).toMatchObject({ code: b.code, label: bron.label, percentage: bron.percentage, rubriek: bron.rubriek, tekst: saleVatText(b.code) });
      expect(b.pickLabel).toBe(bron.pickLabel);
    }
    expect(REGELTABEL.eu_landen).toEqual([...EU_COUNTRIES].sort());
    expect(REGELTABEL.eu_b2c_drempel).toBe(EU_B2C_THRESHOLD);
    expect(REGELTABEL.teksten).toEqual({ icp: ICP_TEXT, icp_dienst: ICP_SERVICE_TEXT, buiten_eu_dienst: OUTSIDE_EU_SERVICE_TEXT, verlegd: VERLEGD_TEXT });
    // zuivere data: wat door JSON heen gaat komt er gelijk uit, en het bronbestand haalt niets van Node of de database binnen
    expect(JSON.parse(JSON.stringify(REGELTABEL))).toEqual(REGELTABEL);
    const bron = readFileSync(join(__dirname, '..', 'packages', 'core', 'src', 'shared', 'regeltabel.ts'), 'utf8');
    const code = bron.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    expect(code).not.toMatch(/node:|from ['"](fs|path|crypto|electron|better-sqlite3)|\bBuffer\b|\bprocess\.|\brequire\(/);
    expect(Array.from(code.matchAll(/from '([^']+)'/g), (m) => m[1])).toEqual(['./vat']);
  });

  it('REGEL-02 versie en bewaker: de versie heeft de vorm JJJJ-n, geldig_vanaf is een geldige datum, en een vaste vingerafdruk van de inhoud klopt.', () => {
    expect(REGELTABEL_VERSIE).toMatch(/^\d{4}-[1-9]\d*$/);
    expect(REGELTABEL.versie).toBe(REGELTABEL_VERSIE);
    expect(REGELTABEL.geldig_vanaf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(`${REGELTABEL.geldig_vanaf}T00:00:00Z`).toISOString().slice(0, 10)).toBe(REGELTABEL.geldig_vanaf);
    // De bewaker: alleen de tabel zelf, geen datum van vandaag en niets uit de omgeving. Verandert de inhoud
    // (ook doordat een constante in vat.ts verandert), dan faalt dit tot de versie omhoog is en de afdruk bijgewerkt.
    const afdruk = createHash('sha256').update(canoniek(REGELTABEL)).digest('hex');
    expect({ versie: REGELTABEL.versie, afdruk }).toEqual({ versie: '2026-1', afdruk: VINGERAFDRUK_2026_1 });
  });

  it('REGEL-03 stamgegevens: de eerste pagina (zonder cursor) bevat regels, gelijk aan de kerntabel; een vervolgpagina bevat ze niet.', () => {
    const t = start();
    for (let i = 0; i < STAMGEGEVENS_PAGINA + 20; i++) maakKlant(t, `Klant ${i}`);
    const eerste = pagina(t);
    expect(eerste.regeltabel).toEqual(REGELTABEL);
    expect(eerste.volgende).not.toBeNull();
    const tweede = pagina(t, 0, leesCursor(eerste.volgende));
    expect(Object.hasOwn(tweede, 'regels')).toBe(false);
    expect(tweede.klanten.length).toBeGreaterThan(0);
    // het antwoord deelt geen object met de kern: knoeien met het antwoord verandert de tabel niet
    (eerste.regeltabel as { btw: unknown[] }).btw.length = 0;
    expect(REGELTABEL.btw.length).toBe(Object.keys(SALES_VAT_RATES).length);
  });

  it('REGEL-04 delta: ook bij sinds groter dan 0 staat regels op de eerste pagina, onafhankelijk van sinds en van de inhoud van de delta.', () => {
    const t = start();
    maakKlant(t, 'Eerste');
    const tot = teller(t);
    // een lege delta
    const leeg = pagina(t, tot);
    expect(leeg.klanten).toEqual([]);
    expect(leeg.regeltabel).toEqual(REGELTABEL);
    // een delta met een klant
    const nieuw = maakKlant(t, 'Tweede');
    const delta = pagina(t, tot);
    expect(delta.klanten.map((k) => k.uuid)).toEqual([nieuw.uuid]);
    expect(delta.regeltabel).toEqual(REGELTABEL);
    // een sinds boven de teller (teruggezette back-up) heeft de tabel ook
    expect(pagina(t, teller(t) + 1000).regeltabel).toEqual(REGELTABEL);
    expect(rij<{ n: number }>(t, 'SELECT COUNT(*) AS n FROM relations WHERE uuid IS NOT NULL').n).toBeGreaterThan(1);
  });

  it('REGEL-05 vies zonder nummer: een klant zonder btw-nummer heeft vies null.', async () => {
    const t = start();
    const k = maakKlant(t, 'Zonder nummer');
    // een controle van een ander nummer raakt deze klant niet
    await t.s.vies.check('DE111111111');
    const item = pagina(t).klanten.find((x) => x.uuid === k.uuid)!;
    expect(item.vies).toBeNull();
    expect(item.velden.btw_nummer!.waarde).toBeNull();
    expect(rij<{ n: number }>(t, 'SELECT COUNT(*) AS n FROM vies_checks').n).toBe(1);
  });

  it('REGEL-06 vies zonder controle: een klant met btw-nummer maar zonder controle in vies_checks heeft vies null.', () => {
    const t = start();
    const k = maakKlant(t, 'Met nummer', 'DE222222222');
    expect(rij<{ n: number }>(t, 'SELECT COUNT(*) AS n FROM vies_checks').n).toBe(0);
    const item = pagina(t).klanten.find((x) => x.uuid === k.uuid)!;
    expect(item.velden.btw_nummer!.waarde).toBe('DE222222222');
    expect(item.vies).toBeNull();
  });

  it('REGEL-07 vies met controle: geldig geeft {gecontroleerd_op, geldig: true}, ongeldig geeft geldig false en geen uitslag geeft geldig null; gecontroleerd_op is het tijdstip van de controle in ISO-vorm.', async () => {
    const t = start();
    const de = maakKlant(t, 'Duitse klant', 'DE333333333');
    const fr = maakKlant(t, 'Franse klant', 'FR444444444');
    const es = maakKlant(t, 'Spaanse klant', 'ES555555555');
    // een nummer dat in de administratie niet genormaliseerd staat (oudere gegevens) telt toch mee
    const ruw = maakKlant(t, 'Ruw nummer');
    t.db.prepare('UPDATE relations SET vat_number = ? WHERE id = ?').run('de 666.666-666', ruw.id);
    for (const nr of ['DE333333333', 'FR444444444', 'ES555555555', 'DE666666666']) await t.s.vies.check(nr);
    const per = new Map(pagina(t).klanten.map((k) => [k.uuid, k.vies]));
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    expect(per.get(de.uuid)).toEqual({ gecontroleerd_op: expect.stringMatching(iso), geldig: true });
    expect(per.get(fr.uuid)!.geldig).toBe(false);
    expect(per.get(es.uuid)!.geldig).toBeNull();
    expect(per.get(ruw.uuid)!.geldig).toBe(true);
    const bewaard = rij<{ checked_at: string }>(t, `SELECT checked_at FROM vies_checks WHERE vat_number = 'DE333333333'`).checked_at;
    expect(per.get(de.uuid)!.gecontroleerd_op).toBe(new Date(`${bewaard.replace(' ', 'T')}Z`).toISOString());
    // de controle is van dit moment: binnen een minuut van nu, in UTC
    expect(Math.abs(Date.parse(per.get(de.uuid)!.gecontroleerd_op) - t.nu)).toBeLessThan(60_000);
  });

  it('REGEL-08 privacy: de naam, het adres en het bericht uit vies_checks staan nergens in het antwoord (test op sleutels en ruwe bytes met geplante waarden); alleen de twee velden van vies verlaten de pc.', async () => {
    const t = start();
    const de = maakKlant(t, 'Privacyklant', 'DE777777777');
    const fr = maakKlant(t, 'Ongeldige klant', 'FR888888888');
    const es = maakKlant(t, 'Zonder uitslag', 'ES999999999');
    for (const nr of ['DE777777777', 'FR888888888', 'ES999999999']) await t.s.vies.check(nr);
    // en een geplant bericht rechtstreeks in de tabel
    t.db.prepare(`UPDATE vies_checks SET message = 'GEHEIMBERICHT-VIES', name = 'GEHEIMENAAM-VIES BV', address = 'GEHEIMSTRAAT-VIES 99'`).run();
    const ronden = ronde(t);
    const ruw = Buffer.from(JSON.stringify(ronden.paginas), 'utf8');
    for (const geheim of ['GEHEIMENAAM-VIES', 'GEHEIMSTRAAT-VIES', 'GEHEIMBERICHT-VIES', 'VIES kent dit', 'Geen uitslag van VIES', 'niet bereikbaar']) expect(ruw.includes(geheim)).toBe(false);
    const sleutels = new Set<string>();
    const loop = (x: unknown) => {
      if (Array.isArray(x)) x.forEach(loop);
      else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) (sleutels.add(k), loop(v));
    };
    loop(ronden.paginas);
    for (const verboden of ['name', 'address', 'message', 'valid', 'checked_at', 'vat_number', 'relation_id']) expect(sleutels.has(verboden)).toBe(false);
    for (const uuid of [de.uuid, fr.uuid, es.uuid]) {
      const vies = ronden.klanten.find((k) => k.uuid === uuid)!.vies!;
      expect(Object.keys(vies).sort()).toEqual(['gecontroleerd_op', 'geldig']);
    }
    // leveranciers komen er ook met een controle nooit in
    const lev = t.s.relations.create({ name: 'GEHEIMLEVERANCIER', type: 'leverancier', vat_number: 'DE121212121', country: 'DE' });
    await t.s.vies.check('DE121212121');
    expect(JSON.stringify(ronde(t).paginas)).not.toContain('GEHEIMLEVERANCIER');
    expect(rij<{ n: number }>(t, 'SELECT COUNT(*) AS n FROM relations WHERE id = ? AND type = ?', lev.id, 'leverancier').n).toBe(1);
  });

  it('REGEL-09 delta met een controle: een nieuwe VIES-controle zet de klant in de volgende delta (hoger effectief nummer, ook zijn projecten via de bestaande regel) zonder dat klantvelden, revisie, changelog of veldtijden veranderen; een controle van een klant zonder uuid breekt niets.', async () => {
    const t = start();
    const k = maakKlant(t, 'Controleklant', 'DE131313131');
    const ander = maakKlant(t, 'Andere klant', 'DE141414141');
    maakJobAan(t.db, { relationId: k.id, title: 'Project van de klant' }, () => t.nu);
    // een klant zonder uuid en een met sync_seq 0 (oudere administratie) met hetzelfde nummer
    const oud = t.db.prepare(`INSERT INTO relations (type, name, vat_number) VALUES ('klant', 'Oude klant', 'DE131313131')`).run().lastInsertRowid as number;
    const oud2 = t.db.prepare(`INSERT INTO relations (type, name, vat_number, uuid, sync_seq) VALUES ('klant', 'Oude klant met uuid', 'DE131313131', ?, 0)`).run(randomUUID()).lastInsertRowid as number;
    const vooraf = pagina(t);
    const tot = vooraf.nieuwe_sinds;
    const voor = vooraf.klanten.find((x) => x.uuid === k.uuid)!;
    const rijVoor = rij<Record<string, unknown>>(t, 'SELECT * FROM relations WHERE id = ?', k.id);
    const logboek = () => canoniek([t.db.prepare('SELECT * FROM relation_changelog ORDER BY id').all(), t.db.prepare('SELECT * FROM relation_field_rev ORDER BY relation_id, veld').all()]);
    const logVoor = logboek();
    const oudVoor = [rij(t, 'SELECT * FROM relations WHERE id = ?', oud), rij(t, 'SELECT * FROM relations WHERE id = ?', oud2)];
    const alleenTellerVoor = teller(t);

    await t.s.vies.check('DE131313131');

    const na = rij<Record<string, unknown>>(t, 'SELECT * FROM relations WHERE id = ?', k.id);
    expect(na.sync_seq as number).toBeGreaterThan(tot);
    expect(na.sync_seq).toBe(alleenTellerVoor + 1);
    // alleen sync_seq is anders
    expect({ ...na, sync_seq: 0 }).toEqual({ ...rijVoor, sync_seq: 0 });
    expect(logboek()).toBe(logVoor);
    // de relaties zonder uuid of zonder nummer zijn niet aangeraakt en gaven geen fout
    expect([rij(t, 'SELECT * FROM relations WHERE id = ?', oud), rij(t, 'SELECT * FROM relations WHERE id = ?', oud2)]).toEqual(oudVoor);
    expect(rij<{ sync_seq: number }>(t, 'SELECT sync_seq FROM relations WHERE id = ?', ander.id).sync_seq).toBeLessThanOrEqual(tot);
    expect(teller(t)).toBe(alleenTellerVoor + 1);
    // de volgende delta: de klant en zijn project, de andere klant niet; velden en revisie ongewijzigd
    const delta = pagina(t, tot);
    expect(delta.klanten.map((x) => x.uuid)).toEqual([k.uuid]);
    expect(delta.klanten[0]!.seq).toBe(na.sync_seq);
    expect(delta.klanten[0]!.velden).toEqual(voor.velden);
    expect(delta.klanten[0]!.pc_revisie).toBe(voor.pc_revisie);
    expect(delta.klanten[0]!.vies).toMatchObject({ geldig: true });
    expect(delta.projecten.map((p) => [p.velden.titel!.waarde, p.seq])).toEqual([['Project van de klant', na.sync_seq]]);
    expect(delta.nieuwe_sinds).toBe(teller(t));
    // een controle van een nummer dat alleen bij een klant zonder uuid hoort: geen fout, teller blijft staan
    t.db.prepare(`INSERT INTO relations (type, name, vat_number) VALUES ('klant', 'Alleen oud', 'DE151515151')`).run();
    const tellerNu = teller(t);
    await expect(t.s.vies.check('DE151515151')).resolves.toMatchObject({ valid: true });
    expect(teller(t)).toBe(tellerNu);
    expect(rij<{ n: number }>(t, `SELECT COUNT(*) AS n FROM vies_checks WHERE vat_number = 'DE151515151'`).n).toBe(1);
  });

  it('REGEL-10 laatste telt en nummerwijziging: de laatste controle van het huidige btw-nummer telt; een controle van een eerder btw-nummer van de klant telt niet voor het nieuwe nummer (vies null tot er een nieuwe controle is).', async () => {
    const t = start();
    const k = maakKlant(t, 'Wisselklant', 'DE161616161');
    const vies = () => pagina(t).klanten.find((x) => x.uuid === k.uuid)!.vies;
    await t.s.vies.check('DE161616161');
    expect(vies()).toMatchObject({ geldig: true });
    // een latere controle van hetzelfde nummer met een andere uitslag telt
    t.db.prepare(`UPDATE vies_checks SET valid = 0, checked_at = datetime('now', '-3 days') WHERE vat_number = 'DE161616161'`).run();
    await t.s.vies.check('DE161616161');
    const dubbel = vies()!;
    expect(dubbel.geldig).toBe(true);
    expect(rij<{ n: number }>(t, `SELECT COUNT(*) AS n FROM vies_checks WHERE vat_number = 'DE161616161'`).n).toBe(2);
    // het btw-nummer verandert: de controle van het oude nummer telt niet meer
    t.s.relations.update(k.id, { vat_number: 'FR171717171', country: 'FR' });
    expect(vies()).toBeNull();
    await t.s.vies.check('FR171717171');
    expect(vies()).toMatchObject({ geldig: false });
    // terug naar het eerste nummer: weer zijn eigen laatste controle
    t.s.relations.update(k.id, { vat_number: 'DE161616161', country: 'DE' });
    expect(vies()).toEqual(dubbel);
    // de laatste controle (hoogste id) wint, ook als zijn tijdstip eerder lijkt
    t.db.prepare(`UPDATE vies_checks SET valid = 0, checked_at = datetime('now', '-9 days') WHERE id = (SELECT MAX(id) FROM vies_checks WHERE vat_number = 'DE161616161')`).run();
    expect(vies()).toMatchObject({ geldig: false });
  });

  it('REGEL-11 ronde: paginering, cursor, tot en nieuwe_sinds en de verbergmeldingen gedragen zich ongewijzigd met de nieuwe velden (bestaande tests blijven groen met alleen aangepaste sleutellijsten).', async () => {
    const t = start();
    const klanten = Array.from({ length: STAMGEGEVENS_PAGINA + 30 }, (_, i) => maakKlant(t, `Klant ${i}`, i % 2 === 0 ? `DE${String(100000000 + i)}` : undefined));
    await t.s.vies.check('DE100000000');
    const wisselaar = maakKlant(t, 'Wisselaar');
    t.s.relations.update(wisselaar.id, { name: 'Wisselaar nu leverancier' });
    // een gewone ronde: twee pagina's, niemand dubbel, overal dezelfde bovengrens
    const r1 = ronde(t, 0);
    expect(r1.paginas.length).toBe(2);
    expect(r1.paginas.every((p) => p.klanten.length + p.projecten.length + p.verborgen.length <= STAMGEGEVENS_PAGINA)).toBe(true);
    expect(new Set(r1.paginas.map((p) => p.nieuwe_sinds)).size).toBe(1);
    expect(r1.paginas[0]!.nieuwe_sinds).toBe(teller(t));
    expect(Object.hasOwn(r1.paginas[1]!, 'regels')).toBe(false);
    expect(new Set(r1.klanten.map((k) => k.uuid)).size).toBe(r1.klanten.length);
    // opnieuw, nu met een controle tussen de eerste en de tweede pagina op een klant die nog niet is afgeleverd
    // (een even index heeft een btw-nummer): hij krijgt een nummer boven `tot` en komt zeker in de volgende ronde
    const doelIndex = klanten.length - 2;
    const doel = klanten[doelIndex]!;
    const eerste = pagina(t);
    const tot = eerste.nieuwe_sinds;
    expect(eerste.klanten.map((k) => k.uuid)).not.toContain(doel.uuid);
    await t.s.vies.check(`DE${String(100000000 + doelIndex)}`);
    const tweede = pagina(t, 0, leesCursor(eerste.volgende));
    expect(tweede.nieuwe_sinds).toBe(tot);
    expect([...eerste.klanten, ...tweede.klanten].every((k) => k.seq <= tot)).toBe(true);
    expect(tweede.klanten.map((k) => k.uuid)).not.toContain(doel.uuid);
    const volgendeRonde = ronde(t, tot);
    expect(volgendeRonde.klanten.map((k) => k.uuid)).toEqual([doel.uuid]);
    expect(volgendeRonde.paginas[0]!.nieuwe_sinds).toBe(teller(t));
    // een verbergmelding blijft werken
    const tot2 = teller(t);
    t.s.relations.update(wisselaar.id, { type: 'leverancier' });
    const delta = ronde(t, tot2);
    expect(delta.verborgen).toEqual([{ uuid: wisselaar.uuid, seq: teller(t), soort: 'klant' }]);
    expect(delta.klanten).toEqual([]);
    expect(delta.paginas[0]!.regeltabel).toEqual(REGELTABEL);
    // het wijzigingsnummer blijft strikt oplopend, ook na een controle
    expect(volgendeSyncSeq(t.db)).toBe(teller(t));
  });

  it('REGEL-12 gedragsneutraal: ViesService.check en latest werken voor de gebruiker ongewijzigd; het bewaren van een controle schrijft niets in relation_changelog of relation_field_rev.', async () => {
    const t = start();
    const k = maakKlant(t, 'Gewone controle', 'DE181818181');
    const tellen = () => ['relation_changelog', 'relation_field_rev', 'job_changelog', 'job_field_rev'].map((n) => rij<{ n: number }>(t, `SELECT COUNT(*) AS n FROM ${n}`).n);
    const voor = tellen();
    const rijVoor = rij<{ revisie: number; gewijzigd_op: number; name: string }>(t, 'SELECT revisie, gewijzigd_op, name FROM relations WHERE id = ?', k.id);
    expect(t.s.vies.latest('DE181818181')).toBeNull();
    const r = await t.s.vies.check(' de 181.818-181 ', k.id);
    expect(r).toEqual({ vatNumber: 'DE181818181', valid: true, name: 'GEHEIMENAAM-VIES BV', address: 'GEHEIMSTRAAT-VIES 99', message: null, checkedAt: expect.any(String) });
    expect(t.s.vies.latest('de181818181')).toEqual(r);
    expect(rij(t, 'SELECT vat_number, relation_id, valid, name, address FROM vies_checks')).toEqual({ vat_number: 'DE181818181', relation_id: k.id, valid: 1, name: 'GEHEIMENAAM-VIES BV', address: 'GEHEIMSTRAAT-VIES 99' });
    expect(tellen()).toEqual(voor);
    expect(rij(t, 'SELECT revisie, gewijzigd_op, name FROM relations WHERE id = ?', k.id)).toEqual(rijVoor);
    // een ongeldig nummer wordt nog steeds geweigerd zonder iets te bewaren, ook zonder nummer
    await expect(t.s.vies.check('123')).rejects.toThrow(/landcode/);
    await expect(t.s.vies.check('CHE123456789')).rejects.toThrow(/EU/);
    expect(rij<{ n: number }>(t, 'SELECT COUNT(*) AS n FROM vies_checks').n).toBe(1);
    expect(tellen()).toEqual(voor);
  });
});
