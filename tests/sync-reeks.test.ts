import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeTotals, type LineInput } from '@gratis-boekhouden/kern';
import { setup } from './helpers';
import { migrate } from '../src/db/database';
import { migrations } from '../src/db/migrations';
import { createApi, type HostContext } from '../src/main/api';
import { RelationsService } from '../src/relations/relations';
import { SyncOntvangst } from '../src/sync/ontvangst';
import { SyncWachtrij } from '../src/sync/wachtrij';
import { ReeksBewaking, REDEN_NIET_GEBRUIKT, REDEN_NIET_VERSTUURD } from '../src/sync/reeks';

// Reeksbewaking op de pc (docs/bonnenscanner-protocol.md): gaten in de factuurnummers van een telefoon, vervallen
// markeren met een reden en de melding op Vandaag. Echte databank, echte klassen, relatieve datums.

const DAG = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** de factuurdatum: tien dagen geleden; het jaar van de reeks volgt de datum */
const DATUM = iso(Date.now() - 10 * DAG);
const JAAR = Number(DATUM.slice(0, 4));
/** een datum in een ander jaar (ruim een jaar geleden), voor de aparte reeks van een ander jaar */
const OUD_DATUM = iso(Date.now() - 400 * DAG);
const OUD_JAAR = Number(OUD_DATUM.slice(0, 4));
const verval = (datum: string) => iso(Date.parse(datum) + 30 * DAG);

const KLANT = { name: 'Bakkerij De Korst', address: 'Dorpsstraat 1', city: 'Utrecht', country: 'NL', vat_number: 'NL123456789B01', kvk_number: '12345678', email: 'info@korst.example' };
const BEDRIJF = { name: 'Jansen Klus', address: 'Werfstraat 2', city: 'Zwolle', kvkNumber: '87654321', vatNumber: 'NL987654321B01', kor: false };
const REGEL = { omschrijving: 'Montage', hoeveelheid: 2, prijs: 4550, btw_soort: 'hoog', eenheid: 'uur' };

const nr = (code: string, jaar: number, volgnr: number) => `${code}-${jaar}-${String(volgnr).padStart(4, '0')}`;

/** De velden van een factuurwijziging met dit nummer, doorgerekend met de kern. */
function velden(klantUuid: string, nummer: string, datum: string = DATUM): Record<string, unknown> {
  const t = computeTotals([{ description: REGEL.omschrijving, quantity: REGEL.hoeveelheid, unitPrice: REGEL.prijs, vatCode: 'hoog' } as LineInput]);
  return {
    nummer,
    datum,
    vervaldatum: verval(datum),
    klant_uuid: klantUuid,
    klant_momentopname: { ...KLANT },
    bedrijf_momentopname: { ...BEDRIJF },
    regels: [REGEL],
    totalen: { subtotaal: t.subtotal, btw: t.vatTotal, totaal: t.total },
    verzonden_op: `${datum} 10:30:00`,
    regeltabel_versie: '2026-1',
  };
}

function omgeving() {
  const t = setup();
  const sync = new SyncOntvangst(t.db, new RelationsService(t.db), { now: () => Date.now(), invoices: t.s.invoices });
  const klantUuid = randomUUID();
  const klant = (uuid: string) => sync.verwerk('apparaat-1', 'M1', { entiteit: 'klant', uuid, revisie: 1, tijd: Date.now() - 5 * DAG, velden: { naam: KLANT.name } });
  expect(klant(klantUuid)).toMatchObject({ status: 200, uitkomst: 'toegepast' });
  /** een factuur van de telefoon met dit volgnummer; standaard M1 en het jaar van DATUM */
  const factuur = (volgnr: number, over: { code?: string; datum?: string; klant?: string } = {}) => {
    const code = over.code ?? 'M1';
    const datum = over.datum ?? DATUM;
    return sync.verwerk(`apparaat-${code}`, code, { entiteit: 'factuur', uuid: randomUUID(), revisie: 1, tijd: Date.now() - DAG, velden: velden(over.klant ?? klantUuid, nr(code, Number(datum.slice(0, 4)), volgnr), datum) });
  };
  const reeks = new ReeksBewaking(t.db);
  const gatTaken = () => t.s.inbox.tasks().filter((x) => x.kind === 'invoice-series-gap');
  const api = () => createApi(t.s, { appVersion: () => 'test' } as unknown as HostContext);
  return { ...t, sync, klantUuid, klant, factuur, reeks, gatTaken, api };
}

const n = (db: Database.Database, sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { n: number }).n;
const vervallenAantal = (db: Database.Database) => n(db, 'SELECT COUNT(*) AS n FROM factuur_reeks_vervallen');
const gat = (van: number, tot: number, over: Partial<{ apparaat_code: string; reeks_jaar: number; afgesloten: boolean }> = {}) => ({ apparaat_code: 'M1', reeks_jaar: JAAR, van, tot, afgesloten: false, ...over });

describe('reeksbewaking van telefoonfacturen', () => {
  it('REEKS-01 geen gat: telefoonfacturen M1-2026-0001, 0002 en 0003 geven geen gaten en geen melding', () => {
    const o = omgeving();
    for (const i of [1, 2, 3]) expect(o.factuur(i)).toEqual({ status: 200, uitkomst: 'toegepast' });
    expect(n(o.db, 'SELECT COUNT(*) AS n FROM invoices WHERE apparaat_code = ?', 'M1')).toBe(3);
    expect(o.reeks.gaten()).toEqual([]);
    expect(o.gatTaken()).toEqual([]);
    expect(vervallenAantal(o.db)).toBe(0);
  });

  it('REEKS-02 een gat: 0001 en 0003 geven een gat 0002 en precies een melding; tweemaal de meldingen berekenen geeft dezelfde ene melding (idempotent)', () => {
    const o = omgeving();
    o.factuur(1);
    o.factuur(3);
    expect(o.reeks.gaten()).toEqual([gat(2, 2)]);
    const eerste = o.gatTaken();
    const tweede = o.gatTaken();
    expect(eerste).toHaveLength(1);
    expect(tweede).toEqual(eerste);
    expect(eerste[0]!.key).toBe(`reeks-gat:M1-${JAAR}-2-2`);
    expect(eerste[0]!.title).toContain(nr('M1', JAAR, 2));
    expect(eerste[0]!.title).not.toContain('tot en met');
    // een tweede berekening van de gaten zelf verandert niets aan de databank
    expect(o.reeks.gaten()).toEqual([gat(2, 2)]);
    expect(vervallenAantal(o.db)).toBe(0);
    expect(o.s.inbox.home().tasks.filter((x) => x.kind === 'invoice-series-gap')).toHaveLength(1);
  });

  it('REEKS-03 een bereik: 0001 en 0005 geven een gat 0002 tot en met 0004 en precies een melding voor dat bereik', () => {
    const o = omgeving();
    o.factuur(1);
    o.factuur(5);
    expect(o.reeks.gaten()).toEqual([gat(2, 4)]);
    const taken = o.gatTaken();
    expect(taken).toHaveLength(1);
    expect(taken[0]!.key).toBe(`reeks-gat:M1-${JAAR}-2-4`);
    expect(taken[0]!.title).toContain(nr('M1', JAAR, 2));
    expect(taken[0]!.title).toContain(`tot en met ${nr('M1', JAAR, 4)}`);
    expect(taken[0]!.question).toContain(nr('M1', JAAR, 4));
  });

  it('REEKS-04 begin van de reeks: een eerste ontvangen factuur 0003 geeft een gat 0001 tot en met 0002', () => {
    const o = omgeving();
    o.factuur(3);
    expect(o.reeks.gaten()).toEqual([gat(1, 2)]);
    expect(o.gatTaken().map((x) => x.key)).toEqual([`reeks-gat:M1-${JAAR}-1-2`]);
    // zonder enige telefoonfactuur is er geen reeks en dus geen gat
    expect(omgeving().reeks.gaten()).toEqual([]);
  });

  it('REEKS-05 wachtrij: een nummer dat als onverwerkte rij in sync_wachtrij staat (kolom nummer) telt als bekend; na afhandeling als toegepast is de factuur er, na afhandeling als afgewezen is het nummer weer een gat', () => {
    const o = omgeving();
    const klant2 = randomUUID();
    const klant4 = randomUUID();
    o.factuur(1);
    o.factuur(5);
    expect(o.reeks.gaten()).toEqual([gat(2, 4)]);
    // 0002 en 0004 wachten op een nog onbekende klant: ze staan in de wachtrij en tellen als bekend
    expect(o.factuur(2, { klant: klant2 })).toEqual({ status: 200, uitkomst: 'wacht' });
    expect(o.factuur(4, { klant: klant4 })).toEqual({ status: 200, uitkomst: 'wacht' });
    expect(o.db.prepare('SELECT nummer FROM sync_wachtrij WHERE verwerkt_op IS NULL ORDER BY id').pluck().all()).toEqual([nr('M1', JAAR, 2), nr('M1', JAAR, 4)]);
    expect(o.reeks.gaten()).toEqual([gat(3, 3)]);
    expect(o.gatTaken().map((x) => x.key)).toEqual([`reeks-gat:M1-${JAAR}-3-3`]);
    // de klant van 0002 komt binnen: de factuur wordt overgenomen en het nummer blijft bekend
    expect(o.klant(klant2)).toMatchObject({ uitkomst: 'toegepast' });
    expect(o.db.prepare('SELECT reeks_volgnr FROM invoices WHERE apparaat_code = ? AND reeks_jaar = ? ORDER BY reeks_volgnr').pluck().all('M1', JAAR)).toEqual([1, 2, 5]);
    expect(o.reeks.gaten()).toEqual([gat(3, 3)]);
    // de wachtrijrij van 0004 wordt afgewezen: het nummer is weer een gat, samen met 0003
    const rij = o.db.prepare('SELECT id FROM sync_wachtrij WHERE nummer = ? AND verwerkt_op IS NULL').get(nr('M1', JAAR, 4)) as { id: number };
    expect(new SyncWachtrij(o.db).markeer(rij.id, 'afgewezen', 'test')).toBe(true);
    expect(o.db.prepare('SELECT verwerkt_uitkomst FROM sync_wachtrij WHERE id = ?').pluck().get(rij.id)).toBe('afgewezen');
    expect(o.reeks.gaten()).toEqual([gat(3, 4)]);
    expect(o.gatTaken().map((x) => x.key)).toEqual([`reeks-gat:M1-${JAAR}-3-4`]);
  });

  it('REEKS-06 vervallen: een gat markeren als vervallen met een reden laat het gat en de melding verdwijnen en bewaart een rij met nummer, reden en tijdstip; zonder reden of met alleen spaties wordt niets bewaard', () => {
    const o = omgeving();
    o.factuur(1);
    o.factuur(3);
    expect(o.gatTaken()).toHaveLength(1);
    for (const leeg of ['', '   ', '\t \n', '  ']) {
      expect(() => o.reeks.markeerVervallen('M1', JAAR, 2, 2, leeg)).toThrow(/reden/);
    }
    expect(() => o.reeks.markeerVervallen('M1', JAAR, 2, 2, 'x'.repeat(4001))).toThrow(/reden/);
    expect(vervallenAantal(o.db)).toBe(0);
    expect(o.reeks.gaten()).toEqual([gat(2, 2)]);
    const voor = Date.now();
    expect(o.reeks.markeerVervallen('M1', JAAR, 2, 2, '  Nummer nooit gebruikt  ')).toBe(1);
    const rijen = o.db.prepare('SELECT * FROM factuur_reeks_vervallen').all() as { apparaat_code: string; reeks_jaar: number; reeks_volgnr: number; reden: string; gemarkeerd_op: string }[];
    expect(rijen).toHaveLength(1);
    expect(rijen[0]).toMatchObject({ apparaat_code: 'M1', reeks_jaar: JAAR, reeks_volgnr: 2, reden: 'Nummer nooit gebruikt' });
    const tijd = Date.parse(rijen[0]!.gemarkeerd_op);
    expect(tijd).toBeGreaterThanOrEqual(voor - 1000);
    expect(tijd).toBeLessThanOrEqual(Date.now() + 1000);
    expect(o.reeks.vervallen('M1', JAAR)).toHaveLength(1);
    expect(o.reeks.gaten()).toEqual([]);
    expect(o.gatTaken()).toEqual([]);
    // dezelfde markering nog eens is geen gat meer en wordt geweigerd; de rij blijft zoals ze was
    expect(() => o.reeks.markeerVervallen('M1', JAAR, 2, 2, 'Andere reden')).toThrow(/ontbreekt niet|vervallen/);
    expect(o.db.prepare('SELECT reden FROM factuur_reeks_vervallen').all()).toEqual([{ reden: 'Nummer nooit gebruikt' }]);
  });

  it('REEKS-07 niet markeerbaar: een nummer van een bestaande factuur of een wachtend nummer markeren als vervallen geeft een fout en bewaart niets', () => {
    const o = omgeving();
    o.factuur(1);
    o.factuur(3);
    o.factuur(6);
    expect(o.factuur(5, { klant: randomUUID() })).toEqual({ status: 200, uitkomst: 'wacht' });
    // gaten: 2 en 4
    expect(o.reeks.gaten()).toEqual([gat(2, 2), gat(4, 4)]);
    // een bestaande factuur, alleen of binnen een groter bereik
    expect(() => o.reeks.markeerVervallen('M1', JAAR, 3, 3, 'Reden')).toThrow(/al een factuur/);
    expect(() => o.reeks.markeerVervallen('M1', JAAR, 2, 4, 'Reden')).toThrow(/al een factuur/);
    // een wachtend nummer
    expect(() => o.reeks.markeerVervallen('M1', JAAR, 5, 5, 'Reden')).toThrow(/wachtrij/);
    expect(() => o.reeks.markeerVervallen('M1', JAAR, 4, 5, 'Reden')).toThrow(/wachtrij/);
    // boven de reeks, een onbekende reeks, een omgekeerd of onzinnig bereik, een ongeldige apparaatcode
    expect(() => o.reeks.markeerVervallen('M1', JAAR, 7, 8, 'Reden')).toThrow(/niet binnen de reeks/);
    expect(() => o.reeks.markeerVervallen('M2', JAAR, 1, 1, 'Reden')).toThrow(/niet binnen de reeks/);
    expect(() => o.reeks.markeerVervallen('M1', JAAR, 4, 2, 'Reden')).toThrow(/bereik/);
    expect(() => o.reeks.markeerVervallen('M1', JAAR, 0, 2, 'Reden')).toThrow(/bereik/);
    expect(() => o.reeks.markeerVervallen('M1', JAAR, 1.5, 2, 'Reden')).toThrow(/bereik/);
    expect(() => o.reeks.markeerVervallen('M1', JAAR, 2, Number.NaN, 'Reden')).toThrow(/bereik/);
    expect(() => o.reeks.markeerVervallen('x1', JAAR, 2, 2, 'Reden')).toThrow(/apparaatcode/);
    expect(vervallenAantal(o.db)).toBe(0);
    expect(o.reeks.gaten()).toEqual([gat(2, 2), gat(4, 4)]);
    // het gat zelf blijft markeerbaar
    expect(o.reeks.markeerVervallen('M1', JAAR, 2, 2, 'Reden')).toBe(1);
    expect(o.reeks.gaten()).toEqual([gat(4, 4)]);
  });

  it('REEKS-08 aparte reeksen: M1-2026, M1-2027 en M2-2026 zijn onafhankelijk; een gat in de ene reeks beinvloedt de andere niet', () => {
    const o = omgeving();
    expect(OUD_JAAR).not.toBe(JAAR);
    o.factuur(1);
    o.factuur(3);
    o.factuur(1, { datum: OUD_DATUM });
    o.factuur(2, { datum: OUD_DATUM });
    o.factuur(1, { code: 'M2' });
    o.factuur(4, { code: 'M2' });
    // M1 van het andere jaar heeft geen gat; M1 en M2 hebben ieder een eigen gat
    expect(o.reeks.gaten()).toEqual([gat(2, 2), gat(2, 3, { apparaat_code: 'M2' })]);
    expect(o.gatTaken().map((x) => x.key)).toEqual([`reeks-gat:M1-${JAAR}-2-2`, `reeks-gat:M2-${JAAR}-2-3`]);
    // vervallen markeren in M2 laat het gat van M1 staan
    expect(o.reeks.markeerVervallen('M2', JAAR, 2, 3, 'Reden')).toBe(2);
    expect(o.reeks.gaten()).toEqual([gat(2, 2)]);
    // hetzelfde volgnummer in een andere reeks is geen duplicaat: M1 van het andere jaar heeft volgnummer 2 al, het gat van M1 niet
    expect(() => o.reeks.markeerVervallen('M1', OUD_JAAR, 2, 2, 'Reden')).toThrow(/al een factuur/);
    expect(o.reeks.markeerVervallen('M1', JAAR, 2, 2, 'Reden')).toBe(1);
    expect(o.reeks.gaten()).toEqual([]);
    expect(o.reeks.vervallen('M2', JAAR).map((r) => r.reeks_volgnr)).toEqual([2, 3]);
    expect(o.reeks.vervallen('M1', OUD_JAAR)).toEqual([]);
  });

  it('REEKS-09 later gevuld: komt het ontbrekende nummer alsnog binnen (via FactuurOntvangst), dan verdwijnt het gat en de melding; een eerder vervallen-markering blijft als rij bestaan', () => {
    const o = omgeving();
    // eerst een gat dat gewoon alsnog binnenkomt
    o.factuur(1);
    o.factuur(3);
    expect(o.gatTaken()).toHaveLength(1);
    expect(o.factuur(2)).toEqual({ status: 200, uitkomst: 'toegepast' });
    expect(o.reeks.gaten()).toEqual([]);
    expect(o.gatTaken()).toEqual([]);
    // en een gat dat eerst als vervallen is gemarkeerd en daarna toch binnenkomt
    o.factuur(5);
    expect(o.reeks.gaten()).toEqual([gat(4, 4)]);
    expect(o.reeks.markeerVervallen('M1', JAAR, 4, 4, REDEN_NIET_VERSTUURD)).toBe(1);
    expect(o.gatTaken()).toEqual([]);
    expect(o.factuur(4)).toEqual({ status: 200, uitkomst: 'toegepast' });
    expect(o.db.prepare('SELECT reeks_volgnr FROM invoices WHERE apparaat_code = ? ORDER BY reeks_volgnr').pluck().all('M1')).toEqual([1, 2, 3, 4, 5]);
    expect(o.db.prepare('SELECT reeks_volgnr, reden FROM factuur_reeks_vervallen').all()).toEqual([{ reeks_volgnr: 4, reden: REDEN_NIET_VERSTUURD }]);
    expect(o.reeks.gaten()).toEqual([]);
    expect(o.gatTaken()).toEqual([]);
  });

  it('REEKS-10 ontkoppeld apparaat: bij een apparaatcode met afgesloten_op blijven gaten gemeld, met een tekst die zegt dat de telefoon ontkoppeld is, en markeren als vervallen werkt', () => {
    const o = omgeving();
    o.factuur(1);
    o.factuur(4);
    o.db.prepare(`INSERT INTO scanner_device_codes (code, volgnummer, device_id, toegekend_op) VALUES ('M1', 1, 'apparaat-M1', ?)`).run(new Date(Date.now() - 30 * DAG).toISOString());
    expect(o.reeks.gaten()).toEqual([gat(2, 3, { afgesloten: false })]);
    expect(o.gatTaken()[0]!.question).not.toMatch(/ontkoppeld/);
    // de telefoon wordt ontkoppeld: de apparaatcode krijgt afgesloten_op
    o.db.prepare(`UPDATE scanner_device_codes SET afgesloten_op = ? WHERE code = 'M1'`).run(new Date(Date.now() - DAG).toISOString());
    expect(o.reeks.gaten()).toEqual([gat(2, 3, { afgesloten: true })]);
    const taken = o.gatTaken();
    expect(taken).toHaveLength(1);
    expect(taken[0]!.question).toMatch(/ontkoppeld/);
    expect(taken[0]!.question).toMatch(/niets meer/);
    expect(taken[0]!.key).toBe(`reeks-gat:M1-${JAAR}-2-3`);
    expect(o.reeks.markeerVervallen('M1', JAAR, 2, 3, REDEN_NIET_GEBRUIKT)).toBe(2);
    expect(o.reeks.gaten()).toEqual([]);
    expect(o.gatTaken()).toEqual([]);
  });

  it('REEKS-11 grote sprong: 0001 en 9999 geven een melding voor 0002 tot en met 9998 (geen duizenden meldingen) en het hele bereik in een keer als vervallen markeren werkt in een transactie', async () => {
    const o = omgeving();
    o.factuur(1);
    o.factuur(9999);
    expect(o.reeks.gaten()).toEqual([gat(2, 9998)]);
    const taken = o.gatTaken();
    expect(taken).toHaveLength(1);
    expect(taken[0]!.key).toBe(`reeks-gat:M1-${JAAR}-2-9998`);
    // een fout halverwege laat niets achter: het hele bereik is een transactie
    o.db.exec(`CREATE TRIGGER test_fout_halverwege BEFORE INSERT ON factuur_reeks_vervallen WHEN NEW.reeks_volgnr = 5000 BEGIN SELECT RAISE(ABORT, 'test: fout halverwege'); END`);
    expect(() => o.reeks.markeerVervallen('M1', JAAR, 2, 9998, 'Reden')).toThrow(/halverwege/);
    expect(vervallenAantal(o.db)).toBe(0);
    expect(o.db.inTransaction).toBe(false);
    o.db.exec('DROP TRIGGER test_fout_halverwege');
    expect(o.reeks.gaten()).toEqual([gat(2, 9998)]);
    expect(o.reeks.markeerVervallen('M1', JAAR, 2, 9998, 'Reden')).toBe(9997);
    expect(vervallenAantal(o.db)).toBe(9997);
    expect(o.reeks.gaten()).toEqual([]);
    expect(o.gatTaken()).toEqual([]);

    // een veel grotere sprong geeft ook maar een gat en een melding, kost geen geheugen of tijd en is niet in een keer te markeren
    const groot = omgeving();
    groot.factuur(1);
    groot.factuur(99999999);
    const begin = Date.now();
    expect(groot.reeks.gaten()).toEqual([gat(2, 99999998)]);
    expect(groot.gatTaken()).toHaveLength(1);
    expect(Date.now() - begin).toBeLessThan(5000);
    expect(() => groot.reeks.markeerVervallen('M1', JAAR, 2, 99999998, 'Reden')).toThrow(/10000/);
    expect(() => groot.reeks.markeerVervallen('M1', JAAR, 2, 10002, 'Reden')).toThrow(/10000/);
    expect(vervallenAantal(groot.db)).toBe(0);
    // precies 10000 nummers kan wel, en laat de rest van het gat staan
    expect(groot.reeks.markeerVervallen('M1', JAAR, 2, 10001, 'Reden')).toBe(10000);
    expect(groot.reeks.gaten()).toEqual([gat(10002, 99999998)]);
    // de knop op Vandaag markeert een enorm gat in delen van hoogstens 10000: het restant blijft als nieuwe melding staan
    const kleiner = omgeving();
    kleiner.factuur(1);
    kleiner.factuur(25001);
    const [eerste] = kleiner.gatTaken();
    await kleiner.api().home.act(eerste!, 'vervallen-niet-gebruikt');
    expect(vervallenAantal(kleiner.db)).toBe(10000);
    expect(kleiner.gatTaken().map((x) => x.key)).toEqual([`reeks-gat:M1-${JAAR}-10002-25000`]);
  });

  it('REEKS-12 migratie en nooit verwijderen: de migratie is relatief getest (oude toestand uit migrations.slice, bestaande rijen overleven, user_version gelijk aan migrations.length) en er staat geen DELETE in de nieuwe code', () => {
    const i = migrations.findIndex((m) => /CREATE TABLE IF NOT EXISTS factuur_reeks_vervallen\b/.test(m));
    expect(i).toBeGreaterThan(0);
    const db = new Database(':memory:');
    for (const m of migrations.slice(0, i)) db.exec(m);
    db.pragma(`user_version = ${i}`);
    const tabel = (naam: string) => db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(naam);
    expect(tabel('factuur_reeks_vervallen')).toBeUndefined();
    // rijen van voor de migratie overleven
    db.prepare(`INSERT INTO relations (type, name) VALUES ('klant', 'Oud')`).run();
    migrate(db);
    expect(tabel('factuur_reeks_vervallen')).toBeDefined();
    expect(db.pragma('user_version', { simple: true })).toBe(migrations.length);
    expect(db.prepare('SELECT name FROM relations').all()).toEqual([{ name: 'Oud' }]);
    const kolommen = db.prepare('PRAGMA table_info(factuur_reeks_vervallen)').all() as { name: string; type: string; notnull: number; pk: number }[];
    expect(kolommen.map((k) => k.name)).toEqual(['apparaat_code', 'reeks_jaar', 'reeks_volgnr', 'reden', 'gemarkeerd_op']);
    expect(kolommen.filter((k) => k.pk > 0).sort((a, b) => a.pk - b.pk).map((k) => k.name)).toEqual(['apparaat_code', 'reeks_jaar', 'reeks_volgnr']);
    expect(kolommen.every((k) => k.notnull === 1)).toBe(true);
    // een rij kan er niet twee keer in en een lege reden wordt door de tabel zelf geweigerd
    const voeg = (volgnr: number, reden: string) => db.prepare(`INSERT INTO factuur_reeks_vervallen (apparaat_code, reeks_jaar, reeks_volgnr, reden, gemarkeerd_op) VALUES ('M1', ?, ?, ?, ?)`).run(JAAR, volgnr, reden, new Date().toISOString());
    voeg(2, 'Reden');
    expect(() => voeg(2, 'Andere')).toThrow(/UNIQUE|PRIMARY/);
    expect(() => voeg(3, '   ')).toThrow(/CHECK/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM factuur_reeks_vervallen').get()).toEqual({ n: 1 });
    // nog een keer migreren verandert niets; de markering blijft
    migrate(db);
    expect(db.pragma('user_version', { simple: true })).toBe(migrations.length);
    expect(db.prepare('SELECT reden FROM factuur_reeks_vervallen').all()).toEqual([{ reden: 'Reden' }]);
    // de migratie op een al gevulde database opnieuw draaien laat de rij staan
    db.exec(migrations[i]!);
    expect(db.prepare('SELECT reden FROM factuur_reeks_vervallen').all()).toEqual([{ reden: 'Reden' }]);
    db.close();
    // nooit verwijderen: niet in de migratie, niet in de service
    const bron = readFileSync(join(__dirname, '..', 'src', 'sync', 'reeks.ts'), 'utf8');
    const verboden = (...delen: string[]) => new RegExp(delen.join(''), 'i');
    expect(bron).not.toMatch(verboden('DEL', 'ETE'));
    expect(bron).not.toMatch(verboden('INSERT OR ', 'REPLACE'));
    expect(bron).not.toMatch(verboden('REPLACE ', 'INTO'));
    expect(migrations[i]).not.toMatch(verboden('DEL', 'ETE'));
    expect(migrations[i]).not.toMatch(verboden('DR', 'OP'));
    // de service wijzigt of verwijdert geen markering: de tabel kent in de service alleen een INSERT
    expect(bron.match(/\b(UPDATE|INSERT)\b[^`]*factuur_reeks_vervallen/g)?.every((x) => x.startsWith('INSERT'))).toBe(true);
  });

  it('REEKS-13 Vandaag: de melding op Vandaag heeft kind invoice-series-gap, een stabiele key per gat, prioriteit 2 en de acties vervallen-niet-gebruikt, vervallen-niet-verstuurd en later; een van de vervallen-acties markeert het gat en de melding verdwijnt, later laat alles staan', async () => {
    const o = omgeving();
    o.factuur(1);
    o.factuur(3);
    o.factuur(6);
    const taken = o.gatTaken();
    expect(taken.map((x) => x.key)).toEqual([`reeks-gat:M1-${JAAR}-2-2`, `reeks-gat:M1-${JAAR}-4-5`]);
    for (const t of taken) {
      expect(t).toMatchObject({ kind: 'invoice-series-gap', priority: 2 });
      expect(t.actions.map((a) => a.id)).toEqual(['vervallen-niet-gebruikt', 'vervallen-niet-verstuurd', 'later']);
      expect(t.actions.every((a) => typeof a.hint === 'string' && a.hint.length > 10)).toBe(true);
    }
    expect(taken[0]!.title).toContain(nr('M1', JAAR, 2));
    expect(taken[1]!.question).toContain(`${nr('M1', JAAR, 4)} tot en met ${nr('M1', JAAR, 5)}`);
    const home = o.api().home;
    // later: niets doen
    await home.act(taken[0]!, 'later');
    expect(o.gatTaken().map((x) => x.key)).toEqual(taken.map((x) => x.key));
    expect(vervallenAantal(o.db)).toBe(0);
    // een taak met een verzonnen bereik dat een bestaande factuur bevat, wordt geweigerd en laat niets achter
    const vals = { ...taken[1]!, ref: { reeks: { apparaat_code: 'M1', jaar: JAAR, van: 3, tot: 5 } } };
    await expect(home.act(vals, 'vervallen-niet-gebruikt')).rejects.toThrow(/al een factuur/);
    await expect(home.act({ ...taken[1]!, ref: {} }, 'vervallen-niet-gebruikt')).rejects.toThrow(/intussen veranderd/);
    expect(vervallenAantal(o.db)).toBe(0);
    // de eerste knop: reden Nummer nooit gebruikt, het gat en de melding verdwijnen
    await home.act(taken[0]!, 'vervallen-niet-gebruikt');
    expect(o.db.prepare('SELECT reeks_volgnr, reden FROM factuur_reeks_vervallen').all()).toEqual([{ reeks_volgnr: 2, reden: 'Nummer nooit gebruikt' }]);
    expect(o.gatTaken().map((x) => x.key)).toEqual([`reeks-gat:M1-${JAAR}-4-5`]);
    // de tweede knop: reden Factuur niet verstuurd of concept vervallen
    await home.act(taken[1]!, 'vervallen-niet-verstuurd');
    expect(o.db.prepare('SELECT reeks_volgnr, reden FROM factuur_reeks_vervallen ORDER BY reeks_volgnr').all()).toEqual([
      { reeks_volgnr: 2, reden: 'Nummer nooit gebruikt' },
      { reeks_volgnr: 4, reden: 'Factuur niet verstuurd of concept vervallen' },
      { reeks_volgnr: 5, reden: 'Factuur niet verstuurd of concept vervallen' },
    ]);
    expect(o.gatTaken()).toEqual([]);
    expect(o.reeks.gaten()).toEqual([]);
    // dezelfde knop nog eens op een verouderde taak geeft een fout en verandert niets
    await expect(home.act(taken[0]!, 'vervallen-niet-gebruikt')).rejects.toThrow();
    expect(vervallenAantal(o.db)).toBe(3);
  });

  it('REEKS-14 gedragsneutraal: zonder telefoonfacturen verandert Vandaag niet (geen extra taken) en in de kopie bij de boekhouder (officeCopy) komt de melding niet', () => {
    const o = omgeving();
    // een administratie zonder telefoonfacturen: geen gaten, geen extra taken
    const voor = o.s.inbox.tasks();
    expect(o.reeks.gaten()).toEqual([]);
    expect(voor.some((x) => x.kind === 'invoice-series-gap')).toBe(false);
    expect(o.s.inbox.tasks()).toEqual(voor);
    expect(o.s.inbox.home().tasks).toEqual(voor);
    // een reeks zonder gat voegt geen taak toe (de btw-taak van gewone facturen daargelaten)
    o.factuur(1);
    o.factuur(2);
    const zonderGat = o.s.inbox.tasks();
    expect(zonderGat.some((x) => x.kind === 'invoice-series-gap')).toBe(false);
    // gewone facturen kunnen een btw-taak geven (afhankelijk van de datum van vandaag); verder verandert er niets
    expect(zonderGat.filter((x) => x.kind !== 'vat-due').map((x) => x.key)).toEqual(voor.filter((x) => x.kind !== 'vat-due').map((x) => x.key));
    // met een gat is er een extra taak, en alleen die
    o.factuur(4);
    const met = o.s.inbox.tasks();
    expect(met).toHaveLength(zonderGat.length + 1);
    expect(met.filter((x) => x.kind === 'invoice-series-gap')).toHaveLength(1);
    expect(met.filter((x) => x.kind !== 'invoice-series-gap').map((x) => x.key)).toEqual(zonderGat.map((x) => x.key));
    // in de kopie bij de boekhouder is Vandaag leeg: de melding komt er niet
    o.s.settings.markOfficeCopy({ office: 'Kantoor', exchange: 1, endDate: iso(Date.now() - 30 * DAG) });
    expect(o.s.settings.officeCopy()).not.toBeNull();
    expect(o.reeks.gaten()).toEqual([gat(3, 3)]);
    expect(o.s.inbox.tasks()).toEqual([]);
  });
});
