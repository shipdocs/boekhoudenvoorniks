import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeTotals, type LineInput } from '@gratis-boekhouden/kern';
import { setup } from './helpers';
import { migrate } from '../src/db/database';
import { migrations } from '../src/db/migrations';
import { createApi, type HostContext } from '../src/main/api';
import { RelationsService, type RelationInput } from '../src/relations/relations';
import { MAX_KLANTEN_PER_SLEUTEL, MAX_NIEUWE_VOORSTELLEN, MAX_ZICHTBARE_VOORSTELLEN, openVoorstellen, voegVoorstelSamen, wijsVoorstelAf, zoekDubbelen } from '../src/relations/dubbelen';
import { SyncOntvangst } from '../src/sync/ontvangst';
import { leesBevestigingen } from '../src/sync/bevestigingen';
import { leesStamgegevens } from '../src/sync/stamgegevens';
import type { Task } from '../src/inbox/inbox';

// Dubbele klanten op de pc (docs/bonnenscanner-protocol.md): zoeken, voorstellen op Vandaag en alleen na een
// expliciete keuze samenvoegen via een alias. Echte databank, echte klassen, relatieve datums, geen mocks.

const DAG = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** de factuurdatum: tien dagen geleden; het jaar van de reeks volgt de datum */
const DATUM = iso(Date.now() - 10 * DAG);
const verval = (datum: string) => iso(Date.parse(datum) + 30 * DAG);
const APPARAAT = 'apparaat-1';
const BRON = 'M1';

const MOMENTOPNAME = { name: 'Naam uit de momentopname', address: 'Dorpsstraat 1', city: 'Utrecht', country: 'NL', vat_number: 'NL123456789B01', kvk_number: '12345678', email: 'info@momentopname.example' };
const BEDRIJF = { name: 'Jansen Klus', address: 'Werfstraat 2', city: 'Zwolle', kvkNumber: '87654321', vatNumber: 'NL987654321B01', kor: false };
const REGEL = { omschrijving: 'Montage', hoeveelheid: 2, prijs: 4550, btw_soort: 'hoog', eenheid: 'uur' };

/** De velden van een factuurwijziging, doorgerekend met de kern (een eigen bouwer, niet uit een ander testbestand). */
function factuurVelden(klantUuid: string, volgnr: number): Record<string, unknown> {
  const t = computeTotals([{ description: REGEL.omschrijving, quantity: REGEL.hoeveelheid, unitPrice: REGEL.prijs, vatCode: 'hoog' } as LineInput]);
  return {
    nummer: `${BRON}-${DATUM.slice(0, 4)}-${String(volgnr).padStart(4, '0')}`,
    datum: DATUM,
    vervaldatum: verval(DATUM),
    klant_uuid: klantUuid,
    klant_momentopname: { ...MOMENTOPNAME },
    bedrijf_momentopname: { ...BEDRIJF },
    regels: [REGEL],
    totalen: { subtotaal: t.subtotal, btw: t.vatTotal, totaal: t.total },
    verzonden_op: `${DATUM} 10:30:00`,
    regeltabel_versie: '2026-1',
  };
}

function omgeving() {
  const t = setup();
  const relations = new RelationsService(t.db);
  const sync = new SyncOntvangst(t.db, relations, { now: () => Date.now(), invoices: t.s.invoices });
  const api = () => createApi(t.s, { appVersion: () => 'test' } as unknown as HostContext);
  /** een klant die de telefoon aanmaakte: met een eigen uuid, zonder dat de wachtrij daarna draait */
  const telefoonKlant = (naam: string, over: Record<string, unknown> = {}) => {
    const uuid = randomUUID();
    const klant = relations.maakVanSync(uuid, { name: naam, ...over }, Date.now() - 5000, BRON);
    return { uuid, klant };
  };
  const dubbelTaken = () => t.s.inbox.tasks().filter((x) => x.kind === 'klant-dubbel');
  return { ...t, relations, sync, api, telefoonKlant, dubbelTaken };
}
type Omgeving = ReturnType<typeof omgeving>;

const n = (db: Database.Database, sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { n: number }).n;
const rijen = (db: Database.Database, sql: string, ...p: unknown[]) => db.prepare(sql).all(...p) as Record<string, any>[];
const voorstellen = (db: Database.Database) => rijen(db, 'SELECT * FROM klant_dubbel_voorstellen ORDER BY id');
const relatie = (db: Database.Database, id: number) => db.prepare('SELECT * FROM relations WHERE id = ?').get(id) as Record<string, any>;
const paar = (a: number, b: number) => ({ relation_a: Math.min(a, b), relation_b: Math.max(a, b) });
const voorstelVan = (db: Database.Database, a: number, b: number) => rijen(db, 'SELECT * FROM klant_dubbel_voorstellen WHERE relation_a = ? AND relation_b = ?', Math.min(a, b), Math.max(a, b));
/** alles wat een weigering niet mag veranderen */
const toestand = (db: Database.Database) => ({
  relations: rijen(db, 'SELECT * FROM relations ORDER BY id'),
  aliassen: rijen(db, 'SELECT * FROM relation_aliases ORDER BY alias_uuid'),
  log: rijen(db, 'SELECT * FROM relation_changelog ORDER BY id'),
  veldtijd: rijen(db, 'SELECT * FROM relation_field_rev ORDER BY relation_id, veld'),
  teller: rijen(db, 'SELECT * FROM sync_teller ORDER BY naam'),
  voorstellen: voorstellen(db),
});
/** een klant met unieke gegevens (KvK uit een teller) */
let kvkTeller = 10_000_000;
const uniekKvk = () => String(++kvkTeller);
const klant = (o: Omgeving, naam: string, over: Partial<RelationInput> = {}) => o.relations.create({ name: naam, ...over });

describe('dubbele klanten: zoeken, voorstellen en samenvoegen op bevestiging', () => {
  it('DUBBEL-01 vinden: twee niet-gearchiveerde klanten (type klant of beide) met hetzelfde KvK-nummer, btw-nummer, e-mailadres (hoofdletterongevoelig) of dezelfde genormaliseerde naam geven een voorstel met een reden; een leverancier of gearchiveerde klant nooit; zonder overeenkomst geen voorstel', () => {
    const o = omgeving();
    const kvk = uniekKvk();
    const k1 = klant(o, 'Dakwerken Visser', { kvk_number: kvk });
    const k2 = klant(o, 'Visser Dak BV', { kvk_number: kvk, type: 'beide' });
    const b1 = klant(o, 'Loodgieter Smit', { vat_number: 'NL123456789B01' });
    const b2 = klant(o, 'Smit Sanitair', { vat_number: 'NL123456789B01' });
    // een btw-nummer dat anders genoteerd staat (hoofdletters, spaties en punten) is hetzelfde nummer
    o.db.prepare('UPDATE relations SET vat_number = ? WHERE id = ?').run(' nl 1234.56.789-b01 ', b2.id);
    const e1 = klant(o, 'Tuinbouw Mei', { email: 'Info@Voorbeeld-Tuin.nl' });
    const e2 = klant(o, 'Mei Tuinen', { email: 'info@voorbeeld-tuin.NL' });
    const m1 = klant(o, 'Van der Berg Installatie B.V.');
    const m2 = klant(o, 'van  der berg-installatie, bv');
    // wat nooit een voorstel geeft: leveranciers, een gearchiveerde klant en klanten zonder overeenkomst
    const kvkL = uniekKvk();
    klant(o, 'Leverancier Een', { type: 'leverancier', kvk_number: kvkL, email: 'lev@voorbeeld.nl' });
    klant(o, 'Leverancier Twee', { type: 'leverancier', kvk_number: kvkL, email: 'lev@voorbeeld.nl' });
    const kvkG = uniekKvk();
    const actief = klant(o, 'Actieve Klant', { kvk_number: kvkG });
    const weg = klant(o, 'Oude Klant', { kvk_number: kvkG });
    o.relations.archive(weg.id);
    klant(o, 'Eenzame Klant', { kvk_number: uniekKvk(), email: 'eenzaam@voorbeeld.nl' });

    expect(zoekDubbelen(o.db)).toBe(4);
    const rij = voorstellen(o.db);
    expect(rij.map((r) => [r.relation_a, r.relation_b])).toEqual([paar(k1.id, k2.id), paar(b1.id, b2.id), paar(e1.id, e2.id), paar(m1.id, m2.id)].map((p) => [p.relation_a, p.relation_b]));
    expect(rij.map((r) => r.reden)).toEqual(['zelfde KvK-nummer', 'zelfde btw-nummer', 'zelfde e-mailadres', 'zelfde naam']);
    expect(rij.every((r) => r.status === 'voorgesteld' && r.beslist_op === null && r.gemaakt_op > 0)).toBe(true);
    expect(voorstelVan(o.db, actief.id, weg.id)).toEqual([]);
    expect(n(o.db, `SELECT COUNT(*) AS n FROM klant_dubbel_voorstellen WHERE relation_a IN (SELECT id FROM relations WHERE type = 'leverancier') OR relation_b IN (SELECT id FROM relations WHERE type = 'leverancier')`)).toBe(0);
  });

  it('DUBBEL-02 geen valse treffers: leeg KvK, e-mail of btw matcht nooit, korte of algemene namen matchen niet op naam alleen, een klant is nooit zijn eigen dubbel en een paar komt precies een keer voor ongeacht de volgorde', () => {
    const o = omgeving();
    const leeg1 = klant(o, 'Leeg Een');
    const leeg2 = klant(o, 'Leeg Twee');
    for (const id of [leeg1.id, leeg2.id]) o.db.prepare(`UPDATE relations SET kvk_number = '', email = '  ', vat_number = '' WHERE id = ?`).run(id);
    const kort1 = klant(o, 'Jo');
    const kort2 = klant(o, 'jo');
    const algemeen1 = klant(o, 'Particulier');
    const algemeen2 = klant(o, ' particulier. ');
    const leestekens1 = klant(o, '. -');
    const leestekens2 = klant(o, '- .');
    expect(zoekDubbelen(o.db)).toBe(0);
    expect(voorstellen(o.db)).toEqual([]);
    for (const id of [leeg1.id, leeg2.id, kort1.id, kort2.id, algemeen1.id, algemeen2.id, leestekens1.id, leestekens2.id]) expect(relatie(o.db, id).archived).toBe(0);

    // drie klanten met hetzelfde e-mailadres, in omgekeerde volgorde aangemaakt: drie paren, elk een keer, het kleinste id eerst
    const x = klant(o, 'Zeta Bouw', { email: 'zelfde@voorbeeld.nl' });
    const y = klant(o, 'Eta Bouw', { email: 'ZELFDE@voorbeeld.nl' });
    const z = klant(o, 'Theta Bouw', { email: 'zelfde@voorbeeld.nl' });
    expect(zoekDubbelen(o.db)).toBe(3);
    expect(voorstellen(o.db).map((r) => [r.relation_a, r.relation_b])).toEqual([[x.id, y.id], [x.id, z.id], [y.id, z.id]]);
    expect(voorstellen(o.db).every((r) => r.relation_a < r.relation_b)).toBe(true);
    expect(() => o.db.prepare(`INSERT INTO klant_dubbel_voorstellen (relation_a, relation_b, reden, gemaakt_op) VALUES (?, ?, 'x', 1)`).run(x.id, x.id)).toThrow();
    expect(() => o.db.prepare(`INSERT INTO klant_dubbel_voorstellen (relation_a, relation_b, reden, gemaakt_op) VALUES (?, ?, 'x', 1)`).run(z.id, x.id)).toThrow();
    expect(zoekDubbelen(o.db)).toBe(0);
  });

  it('DUBBEL-03 voorstellen blijven: eigen tabel, idempotent aangemaakt, een afgewezen paar komt nooit terug (ook niet na wijziging van een klant) en rijen worden nooit verwijderd', () => {
    const o = omgeving();
    const kvk = uniekKvk();
    const a = klant(o, 'Schildersbedrijf Roos', { kvk_number: kvk });
    const b = klant(o, 'Roos Schilders', { kvk_number: kvk });
    expect(o.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'klant_dubbel_voorstellen'`).all()).toHaveLength(1);
    expect(zoekDubbelen(o.db)).toBe(1);
    const eerste = voorstellen(o.db);
    expect(zoekDubbelen(o.db)).toBe(0);
    expect(zoekDubbelen(o.db)).toBe(0);
    expect(voorstellen(o.db)).toEqual(eerste);

    const rij = eerste[0]!;
    const afgewezen = wijsVoorstelAf(o.db, rij.id, () => 4242);
    expect(afgewezen).toMatchObject({ id: rij.id, status: 'afgewezen' });
    expect(voorstellen(o.db)).toEqual([{ ...rij, status: 'afgewezen', beslist_op: 4242 }]);
    // een klant verandert en krijgt er een derde bij met hetzelfde nummer: het afgewezen paar komt niet terug, het nieuwe wel
    o.relations.update(a.id, { email: 'roos@voorbeeld.nl', name: 'Schildersbedrijf Roos en Zonen' });
    const c = klant(o, 'Roos Verf', { kvk_number: kvk });
    expect(zoekDubbelen(o.db)).toBe(2);
    expect(voorstelVan(o.db, a.id, b.id)).toEqual([{ ...rij, status: 'afgewezen', beslist_op: 4242 }]);
    expect(voorstellen(o.db).map((r) => r.id)).toEqual([rij.id, rij.id + 1, rij.id + 2]);
    expect(voorstelVan(o.db, a.id, c.id)[0]!.status).toBe('voorgesteld');
    expect(() => wijsVoorstelAf(o.db, rij.id)).toThrow(/al afgewezen/);
    expect(n(o.db, 'SELECT COUNT(*) AS n FROM klant_dubbel_voorstellen')).toBe(3);
  });

  it('DUBBEL-04 Vandaag: per voorstel precies een melding (kind klant-dubbel, stabiele key, prioriteit 2) met beide klanten in gewone taal en de acties samenvoegen-op-a, samenvoegen-op-b, verschillend en later; niets wordt stil samengevoegd; zonder voorstellen verandert Vandaag niet; niet in de kopie bij de boekhouder; begrensd op 50 met een telling', async () => {
    const o = omgeving();
    const voor = o.s.inbox.tasks();
    expect(voor.filter((x) => x.kind === 'klant-dubbel')).toEqual([]);

    const kvk = uniekKvk();
    const a = klant(o, 'Dakdekker Visser', { kvk_number: kvk, city: 'Utrecht' });
    const b = klant(o, 'Visser Dakwerken', { kvk_number: kvk, city: 'Zwolle' });
    o.s.invoices.createDraft({ relationId: a.id, invoiceDate: DATUM, lines: [{ description: 'Dak', quantity: 1, unitPrice: 10000, vatCode: 'hoog' }] });
    o.s.jobs.create({ relationId: a.id, title: 'Dak links' });
    o.s.jobs.create({ relationId: a.id, title: 'Dak rechts' });
    o.s.jobs.create({ relationId: b.id, title: 'Dakgoot' });
    const taken = o.dubbelTaken();
    expect(taken).toHaveLength(1);
    const taak = taken[0]!;
    expect(taak).toMatchObject({ kind: 'klant-dubbel', key: `klant-dubbel:${a.id}-${b.id}`, priority: 2, ref: { dubbelId: voorstellen(o.db)[0]!.id } });
    for (const tekst of ['Dakdekker Visser', 'Visser Dakwerken', 'Utrecht', 'Zwolle', '1 factuur en 2 klussen', '0 facturen en 1 klus', 'zelfde KvK-nummer', 'niet ongedaan']) expect(`${taak.title} ${taak.question}`).toContain(tekst);
    expect(taak.actions.map((x) => x.id)).toEqual(['samenvoegen-op-a', 'samenvoegen-op-b', 'verschillend', 'later']);
    expect(taak.actions.every((x) => x.hint && x.hint.length > 10)).toBe(true);
    expect(taak.actions[0]!.hint).toContain('Visser Dakwerken wordt gearchiveerd');
    // Vandaag opbouwen, de lijst ophalen en de home-gegevens vragen voegt nooit iets samen
    await o.api().home.get();
    expect(n(o.db, 'SELECT COUNT(*) AS n FROM relations WHERE archived = 1')).toBe(0);
    expect(n(o.db, 'SELECT COUNT(*) AS n FROM relation_aliases')).toBe(0);
    expect(o.dubbelTaken().map((x) => x.key)).toEqual([taak.key]);

    // in de kopie bij de boekhouder zijn de vragen van de klant niet aan hem
    o.s.settings.markOfficeCopy({ office: 'Kantoor Test', exchange: 1, endDate: iso(Date.now() - 30 * DAG) });
    expect(o.s.inbox.tasks()).toEqual([]);

    // de lijst is begrensd: 55 paren geven 50 meldingen en de telling van de rest
    const grote = omgeving();
    for (let i = 0; i < 55; i++) {
      const sleutel = uniekKvk();
      klant(grote, `Alfa ${i} Eerste`, { kvk_number: sleutel });
      klant(grote, `Beta ${i} Tweede`, { kvk_number: sleutel });
    }
    const eerste = grote.dubbelTaken();
    expect(eerste).toHaveLength(MAX_ZICHTBARE_VOORSTELLEN);
    expect(eerste.at(-1)!.question).toContain('nog 5 andere voorstellen');
    expect(eerste[0]!.question).not.toContain('andere voorstellen');
    // wijst de gebruiker de eerste 50 af, dan verschijnen de volgende (de grens beslist niet vóór het wegfilteren)
    for (const taakRij of eerste) wijsVoorstelAf(grote.db, taakRij.ref.dubbelId);
    const volgende = grote.dubbelTaken();
    expect(volgende).toHaveLength(5);
    expect(volgende.map((x) => x.ref.dubbelId)).toEqual([51, 52, 53, 54, 55].map((i) => voorstellen(grote.db)[i - 1]!.id));
    expect(volgende.every((x) => !x.question.includes('andere voorstellen'))).toBe(true);
    expect(n(grote.db, 'SELECT COUNT(*) AS n FROM relations WHERE archived = 1')).toBe(0);
  });

  it('DUBBEL-05 samenvoegen: de bron is gearchiveerd via de archiefroute (revisie, wijzigingsnummer, veldtijd, logregel met reden), krijgt een alias naar het doel, bestaande aliassen van de bron gaan naar het doel, en facturen, klussen en documenten van de bron blijven ongewijzigd bij de bron', () => {
    const o = omgeving();
    const { uuid: bronUuid, klant: bron } = o.telefoonKlant('Bakkerij Bol', { city: 'Delft' });
    const doel = klant(o, 'Bakkerij Bol BV', { city: 'Delft' });
    const eerderAlias = randomUUID();
    o.relations.schrijfAlias(eerderAlias, bron.id, 111);
    o.s.invoices.createDraft({ relationId: bron.id, invoiceDate: DATUM, lines: [{ description: 'Brood', quantity: 3, unitPrice: 500, vatCode: 'laag' }] });
    o.s.jobs.create({ relationId: bron.id, title: 'Oven plaatsen' });
    const bronVoor = relatie(o.db, bron.id);
    const doelVoor = relatie(o.db, doel.id);
    const factuurVoor = rijen(o.db, 'SELECT * FROM invoices WHERE relation_id = ?', bron.id);
    const klusVoor = rijen(o.db, 'SELECT * FROM jobs WHERE relation_id = ?', bron.id);
    const tellingVoor = { facturen: n(o.db, 'SELECT COUNT(*) AS n FROM invoices'), klussen: n(o.db, 'SELECT COUNT(*) AS n FROM jobs'), documenten: n(o.db, 'SELECT COUNT(*) AS n FROM documents') };
    expect(factuurVoor).toHaveLength(1);
    expect(klusVoor).toHaveLength(1);

    expect(o.relations.voegSamen(bron.id, doel.id, 'zelfde naam')).toEqual({ aliasGeschreven: true });

    const bronNa = relatie(o.db, bron.id);
    const doelNa = relatie(o.db, doel.id);
    expect(bronNa).toMatchObject({ archived: 1, revisie: bronVoor.revisie + 1, uuid: bronUuid });
    expect(bronNa.sync_seq).toBeGreaterThan(bronVoor.sync_seq);
    expect(doelNa.sync_seq).toBeGreaterThan(bronNa.sync_seq);
    expect({ ...doelNa, sync_seq: 0 }).toEqual({ ...doelVoor, sync_seq: 0 });
    expect(rijen(o.db, `SELECT tijd, bron FROM relation_field_rev WHERE relation_id = ? AND veld = 'gearchiveerd'`, bron.id)).toEqual([{ tijd: bronNa.gewijzigd_op, bron: 'pc' }]);
    const log = rijen(o.db, 'SELECT revisie, veld, oud, nieuw, bron FROM relation_changelog WHERE relation_id = ? AND revisie = ? ORDER BY id', bron.id, bronNa.revisie);
    expect(log).toEqual([
      { revisie: bronNa.revisie, veld: 'gearchiveerd', oud: '0', nieuw: '1', bron: 'pc' },
      { revisie: bronNa.revisie, veld: 'samengevoegd', oud: null, nieuw: `klant ${doel.id}: zelfde naam`, bron: 'pc' },
    ]);
    expect(rijen(o.db, 'SELECT alias_uuid, relation_id FROM relation_aliases ORDER BY alias_uuid')).toEqual(
      [{ alias_uuid: bronUuid, relation_id: doel.id }, { alias_uuid: eerderAlias, relation_id: doel.id }].sort((x, y) => (x.alias_uuid < y.alias_uuid ? -1 : 1)),
    );
    // niets verhuist en niets verdwijnt
    expect(rijen(o.db, 'SELECT * FROM invoices WHERE relation_id = ?', bron.id)).toEqual(factuurVoor);
    expect(rijen(o.db, 'SELECT * FROM jobs WHERE relation_id = ?', bron.id)).toEqual(klusVoor);
    expect(rijen(o.db, 'SELECT * FROM invoices WHERE relation_id = ?', doel.id)).toEqual([]);
    expect({ facturen: n(o.db, 'SELECT COUNT(*) AS n FROM invoices'), klussen: n(o.db, 'SELECT COUNT(*) AS n FROM jobs'), documenten: n(o.db, 'SELECT COUNT(*) AS n FROM documents') }).toEqual(tellingVoor);

    // een bron zonder sync-uuid krijgt geen alias, maar wordt wel gearchiveerd
    const zonderUuid = klant(o, 'Zonder Uuid');
    o.db.prepare('UPDATE relations SET uuid = NULL WHERE id = ?').run(zonderUuid.id);
    const aliassen = n(o.db, 'SELECT COUNT(*) AS n FROM relation_aliases');
    expect(o.relations.voegSamen(zonderUuid.id, doel.id)).toEqual({ aliasGeschreven: false });
    expect(relatie(o.db, zonderUuid.id).archived).toBe(1);
    expect(n(o.db, 'SELECT COUNT(*) AS n FROM relation_aliases')).toBe(aliassen);
  });

  it('DUBBEL-06 weigeringen: dezelfde klant, een onbekend id, een leverancier, een al gearchiveerde bron of doel en een bron die al een alias van het doel is geven een Nederlandse fout zonder iets te wijzigen; een afgehandeld voorstel kan niet opnieuw worden uitgevoerd', () => {
    const o = omgeving();
    const { klant: bron } = o.telefoonKlant('Bron Klant');
    const doel = klant(o, 'Doel Klant');
    const leverancier = klant(o, 'Leverancier BV', { type: 'leverancier' });
    const weg = klant(o, 'Weg Klant');
    o.relations.archive(weg.id);
    const voor = toestand(o.db);
    const weiger = (b: number, d: number, bericht: RegExp) => {
      expect(() => o.relations.voegSamen(b, d)).toThrow(bericht);
      expect(toestand(o.db)).toEqual(voor);
    };
    weiger(bron.id, bron.id, /niet met zichzelf/);
    weiger(bron.id, 99_999, /bestaat niet/);
    weiger(99_999, doel.id, /bestaat niet/);
    weiger(leverancier.id, doel.id, /leverancier/);
    weiger(bron.id, leverancier.id, /leverancier/);
    weiger(weg.id, doel.id, /al gearchiveerd/);
    weiger(bron.id, weg.id, /al gearchiveerd/);
    weiger(0, doel.id, /twee klanten/);
    weiger(1.5, doel.id, /twee klanten/);
    // de bron is al een alias van het doel (zonder dat hij gearchiveerd is)
    o.relations.schrijfAlias(bron.uuid!, doel.id, 5);
    const metAlias = toestand(o.db);
    expect(() => o.relations.voegSamen(bron.id, doel.id)).toThrow(/al samengevoegd met Doel Klant/);
    expect(toestand(o.db)).toEqual(metAlias);

    // een voorstel kan maar een keer worden uitgevoerd
    const kvk = uniekKvk();
    const p = klant(o, 'Paar Een', { kvk_number: kvk });
    const q = klant(o, 'Paar Twee', { kvk_number: kvk });
    zoekDubbelen(o.db);
    const id = voorstelVan(o.db, p.id, q.id)[0]!.id;
    expect(voegVoorstelSamen(o.db, o.relations, id, q.id)).toMatchObject({ voorstelId: id, doel: { id: q.id }, bron: { id: p.id }, aliasGeschreven: true });
    const klaar = toestand(o.db);
    expect(() => voegVoorstelSamen(o.db, o.relations, id, q.id)).toThrow(/al samengevoegd/);
    expect(() => voegVoorstelSamen(o.db, o.relations, id, p.id)).toThrow(/al samengevoegd/);
    expect(() => wijsVoorstelAf(o.db, id)).toThrow(/al samengevoegd/);
    expect(toestand(o.db)).toEqual(klaar);
  });

  it('DUBBEL-07 opzoeken via alias: na het samenvoegen vindt vindOpSyncUuid(bron-uuid) het doel, een klantwijziging van de telefoon voor de bron-uuid landt per veld op het doel zonder tweede klant, en een wijziging voor het doel zelf blijft werken', () => {
    const o = omgeving();
    const { uuid: bronUuid, klant: bron } = o.telefoonKlant('Slager Kuipers', { city: 'Breda' });
    const doel = klant(o, 'Slagerij Kuipers', { city: 'Breda' });
    expect(o.relations.vindOpSyncUuid(bronUuid)!.id).toBe(bron.id);
    o.relations.voegSamen(bron.id, doel.id);
    // de alias gaat voor een directe treffer op de gearchiveerde bron
    expect(relatie(o.db, bron.id).uuid).toBe(bronUuid);
    expect(o.relations.vindOpSyncUuid(bronUuid)!.id).toBe(doel.id);
    expect(o.relations.vindOpSyncUuid(doel.uuid!)!.id).toBe(doel.id);
    expect(o.relations.vindOpSyncUuid(randomUUID())).toBeUndefined();

    const klanten = n(o.db, 'SELECT COUNT(*) AS n FROM relations');
    const bronVoor = relatie(o.db, bron.id);
    const tijd = Date.now() + 1000;
    expect(o.sync.verwerk(APPARAAT, BRON, { entiteit: 'klant', uuid: bronUuid, revisie: 7, tijd, velden: { telefoon: '06-12345678', plaats: 'Tilburg' } })).toEqual({ status: 200, uitkomst: 'toegepast' });
    expect(n(o.db, 'SELECT COUNT(*) AS n FROM relations')).toBe(klanten);
    expect(relatie(o.db, doel.id)).toMatchObject({ phone: '06-12345678', city: 'Tilburg', name: 'Slagerij Kuipers' });
    expect(rijen(o.db, `SELECT tijd, bron FROM relation_field_rev WHERE relation_id = ? AND veld IN ('phone', 'city') ORDER BY veld`, doel.id)).toEqual([{ tijd, bron: BRON }, { tijd, bron: BRON }]);
    expect(rijen(o.db, `SELECT veld, nieuw, bron FROM relation_changelog WHERE relation_id = ? AND bron = ? ORDER BY veld`, doel.id, BRON)).toEqual([{ veld: 'city', nieuw: 'Tilburg', bron: BRON }, { veld: 'phone', nieuw: '06-12345678', bron: BRON }]);
    expect(relatie(o.db, bron.id)).toEqual(bronVoor);
    // een wijziging voor het doel zelf werkt gewoon
    expect(o.sync.verwerk(APPARAAT, BRON, { entiteit: 'klant', uuid: doel.uuid!, revisie: 1, tijd: tijd + 1000, velden: { notities: 'Bel eerst' } })).toEqual({ status: 200, uitkomst: 'toegepast' });
    expect(relatie(o.db, doel.id).notes).toBe('Bel eerst');
    expect(n(o.db, 'SELECT COUNT(*) AS n FROM relations')).toBe(klanten);

    // een offline wijziging voor de bron-uuid archiveert het doel nooit; de overige velden van dezelfde wijziging worden wel toegepast
    expect(o.sync.verwerk(APPARAAT, BRON, { entiteit: 'klant', uuid: bronUuid, revisie: 8, tijd: tijd + 5000, velden: { gearchiveerd: 1, notities: 'Via de oude uuid' } })).toEqual({ status: 200, uitkomst: 'toegepast' });
    expect(relatie(o.db, doel.id)).toMatchObject({ archived: 0, notes: 'Via de oude uuid' });
    expect(rijen(o.db, `SELECT 1 FROM relation_field_rev WHERE relation_id = ? AND veld = 'archived' AND bron = ?`, doel.id, BRON)).toEqual([]);
    // een wijziging voor de doel-uuid zelf kan archived wel zetten
    expect(o.sync.verwerk(APPARAAT, BRON, { entiteit: 'klant', uuid: doel.uuid!, revisie: 2, tijd: tijd + 6000, velden: { gearchiveerd: 1 } })).toEqual({ status: 200, uitkomst: 'toegepast' });
    expect(relatie(o.db, doel.id).archived).toBe(1);
  });

  it('DUBBEL-08 wachtende wijzigingen: een factuur of project dat op de klant wachtte (de bron-uuid, of een uuid die nu een alias is) wordt na het samenvoegen in dezelfde actie opnieuw verwerkt en overgenomen met de doelklant, de wachtrijrij is afgehandeld (nooit verwijderd) en de bevestiging ligt klaar', async () => {
    const o = omgeving();
    const bronUuid = randomUUID();
    const aliasUuid = randomUUID();
    const factuurUuid = randomUUID();
    const projectUuid = randomUUID();
    // de telefoon stuurt een factuur en een project voor klanten die de pc nog niet kent: ze wachten
    expect(o.sync.verwerk(APPARAAT, BRON, { entiteit: 'factuur', uuid: factuurUuid, revisie: 1, tijd: Date.now() - DAG, velden: factuurVelden(bronUuid, 1) })).toMatchObject({ status: 200, uitkomst: 'wacht' });
    expect(o.sync.verwerk(APPARAAT, BRON, { entiteit: 'project', uuid: projectUuid, revisie: 1, tijd: Date.now() - DAG, velden: { titel: 'Nieuwe keuken', klant: aliasUuid } })).toMatchObject({ status: 200, uitkomst: 'wacht' });
    expect(rijen(o.db, 'SELECT entiteit, wacht_op_entiteit, wacht_op_uuid, verwerkt_op FROM sync_wachtrij ORDER BY id')).toEqual([
      { entiteit: 'factuur', wacht_op_entiteit: 'klant', wacht_op_uuid: bronUuid, verwerkt_op: null },
      { entiteit: 'project', wacht_op_entiteit: 'klant', wacht_op_uuid: aliasUuid, verwerkt_op: null },
    ]);
    // daarna staat de klant er wel (zonder dat de wachtrij draait) en de uuid van het project is een alias van die klant
    const bron = o.relations.maakVanSync(bronUuid, { name: 'Keukenbouw Pieters', email: 'pieters@voorbeeld.nl' }, Date.now() - 2 * DAG, BRON);
    o.relations.schrijfAlias(aliasUuid, bron.id, Date.now());
    const doel = klant(o, 'Pieters Keukens', { city: 'Gouda', email: 'pieters@voorbeeld.nl' });
    expect(zoekDubbelen(o.db)).toBe(1);
    const wachtrijAantal = n(o.db, 'SELECT COUNT(*) AS n FROM sync_wachtrij');
    expect(n(o.db, 'SELECT COUNT(*) AS n FROM invoices WHERE uuid = ?', factuurUuid)).toBe(0);

    const api = o.api();
    const uitslag = await api.relations.mergeDuplicate(voorstellen(o.db)[0]!.id, doel.id);
    expect(uitslag).toMatchObject({ doel: { id: doel.id }, bron: { id: bron.id }, aliasGeschreven: true });

    const factuur = rijen(o.db, 'SELECT relation_id, relation_snapshot, status FROM invoices WHERE uuid = ?', factuurUuid);
    expect(factuur).toHaveLength(1);
    expect(factuur[0]!.relation_id).toBe(doel.id);
    expect(JSON.parse(factuur[0]!.relation_snapshot).name).toBe(MOMENTOPNAME.name);
    expect(rijen(o.db, 'SELECT relation_id FROM jobs WHERE uuid = ?', projectUuid)).toEqual([{ relation_id: doel.id }]);
    // de rijen zijn afgehandeld, niet verwijderd
    expect(n(o.db, 'SELECT COUNT(*) AS n FROM sync_wachtrij')).toBe(wachtrijAantal);
    const rij = rijen(o.db, 'SELECT entiteit, verwerkt_op, verwerkt_uitkomst, verwerkt_seq FROM sync_wachtrij ORDER BY id');
    expect(rij.map((r) => [r.entiteit, r.verwerkt_uitkomst])).toEqual([['factuur', 'toegepast'], ['project', 'toegepast']]);
    expect(rij.every((r) => r.verwerkt_op !== null && r.verwerkt_seq > 0)).toBe(true);
    // de bevestigingen liggen klaar voor de telefoon
    expect(leesBevestigingen(o.db, APPARAAT, 0).bevestigingen.map((b) => [b.entiteit, b.uuid, b.uitkomst])).toEqual(
      expect.arrayContaining([['factuur', factuurUuid, 'toegepast'], ['project', projectUuid, 'toegepast']]),
    );
    // de bron en zijn gegevens zijn niet gewijzigd of verhuisd: er staat niets van de factuur bij de bron
    expect(n(o.db, 'SELECT COUNT(*) AS n FROM invoices WHERE relation_id = ?', bron.id)).toBe(0);
    expect(relatie(o.db, bron.id)).toMatchObject({ archived: 1, name: 'Keukenbouw Pieters' });
    expect(n(o.db, 'SELECT COUNT(*) AS n FROM relations WHERE name = ?', MOMENTOPNAME.name)).toBe(0);
  });

  it('DUBBEL-09 stamgegevens: de aliassen staan op de eerste pagina met de uuid van de bron en van het doel, de bron staat als gearchiveerd in het antwoord, het doel krijgt een hoger wijzigingsnummer zodat de delta beide meeneemt en de privacygrens blijft', () => {
    const o = omgeving();
    const { uuid: bronUuid, klant: bron } = o.telefoonKlant('Elektro Jansen', { city: 'Ede' });
    const doel = klant(o, 'Jansen Elektrotechniek', { city: 'Ede' });
    const leverancier = klant(o, 'Groothandel Elektra', { type: 'leverancier' });
    const sindsVoor = (o.db.prepare(`SELECT waarde FROM sync_teller WHERE naam = 'wijziging'`).get() as { waarde: number }).waarde;
    const voor = leesStamgegevens(o.db, { sinds: 0, na: null });
    expect(voor.aliassen).toEqual([]);
    const doelSeqVoor = voor.klanten.find((k) => k.uuid === doel.uuid)!.seq;
    expect(voor.klanten.find((k) => k.uuid === bronUuid)!.gearchiveerd).toBe(false);

    o.relations.voegSamen(bron.id, doel.id);
    const na = leesStamgegevens(o.db, { sinds: 0, na: null });
    expect(na.aliassen).toEqual([{ alias_uuid: bronUuid, klant: doel.uuid }]);
    expect(na.klanten.find((k) => k.uuid === bronUuid)).toMatchObject({ gearchiveerd: true });
    expect(na.klanten.find((k) => k.uuid === doel.uuid)!.seq).toBeGreaterThan(doelSeqVoor);
    // de delta sinds voor het samenvoegen neemt de bron en het doel mee, en de aliassen staan er ook in
    const delta = leesStamgegevens(o.db, { sinds: sindsVoor, na: null });
    expect(delta.klanten.map((k) => k.uuid).sort()).toEqual([bronUuid, doel.uuid!].sort());
    expect(delta.aliassen).toEqual([{ alias_uuid: bronUuid, klant: doel.uuid }]);
    // een vervolgpagina herhaalt de aliassen niet, en een leverancier komt nergens in het antwoord voor
    const tekst = JSON.stringify([voor, na, delta]);
    expect(tekst).not.toContain(leverancier.uuid!);
    expect(tekst).not.toContain('Groothandel Elektra');
    const vervolg = leesStamgegevens(o.db, { sinds: 0, na: { s: 'k', t: 0, u: '', b: na.nieuwe_sinds } });
    expect(vervolg.aliassen).toEqual([]);
  });

  it('DUBBEL-10 api: duplicates, mergeDuplicate en rejectDuplicate valideren hun invoer (geheel getal groter dan 0, doel is een van de twee), geven Nederlandse fouten, voeren alleen op een expliciete keuze uit en geven alleen veilige velden terug', async () => {
    const o = omgeving();
    const api = o.api();
    expect(api.relations.duplicates()).toEqual([]);
    const kvk = uniekKvk();
    const a = klant(o, 'Hovenier De Groen', { kvk_number: kvk, email: 'groen@voorbeeld.nl', iban: 'NL91ABNA0417164300', city: 'Arnhem' });
    const b = klant(o, 'Groen Hoveniers', { kvk_number: kvk, city: 'Arnhem' });
    const lijst = api.relations.duplicates();
    expect(lijst).toHaveLength(1);
    expect(Object.keys(lijst[0]!).sort()).toEqual(['a', 'b', 'id', 'reden']);
    expect(Object.keys(lijst[0]!.a).sort()).toEqual(['facturen', 'id', 'klussen', 'naam', 'plaats']);
    const json = JSON.stringify(lijst);
    for (const geheim of [a.uuid!, 'groen@voorbeeld.nl', 'NL91ABNA0417164300', kvk]) expect(json).not.toContain(geheim);
    expect(lijst[0]).toMatchObject({ reden: 'zelfde KvK-nummer', a: { id: a.id, naam: 'Hovenier De Groen', plaats: 'Arnhem', facturen: 0, klussen: 0 }, b: { id: b.id } });
    // het opvragen van de lijst voegt niets samen
    expect(n(o.db, 'SELECT COUNT(*) AS n FROM relations WHERE archived = 1')).toBe(0);

    const id = lijst[0]!.id;
    const voor = toestand(o.db);
    for (const slecht of ['1', 0, -1, 1.5, Number.NaN, null, undefined, {}, Number.MAX_SAFE_INTEGER + 2]) {
      expect(() => api.relations.mergeDuplicate(slecht as never, a.id)).toThrow(/klopt niet/);
      expect(() => api.relations.mergeDuplicate(id, slecht as never)).toThrow(/klopt niet/);
      expect(() => api.relations.rejectDuplicate(slecht as never)).toThrow(/klopt niet/);
    }
    expect(() => api.relations.mergeDuplicate(id, 99_999)).toThrow(/Kies een van de twee klanten/);
    expect(() => api.relations.mergeDuplicate(id, o.klant.id)).toThrow(/Kies een van de twee klanten/);
    expect(() => api.relations.mergeDuplicate(99_999, a.id)).toThrow(/bestaat niet/);
    expect(() => api.relations.rejectDuplicate(99_999)).toThrow(/bestaat niet/);
    expect(toestand(o.db)).toEqual(voor);

    // alleen de knop (met de gekozen klant) voert uit; het resultaat bevat alleen veilige velden
    const uitslag = await api.relations.mergeDuplicate(id, b.id);
    expect(uitslag).toEqual({ voorstelId: id, doel: { id: b.id, naam: 'Groen Hoveniers' }, bron: { id: a.id, naam: 'Hovenier De Groen' }, aliasGeschreven: true });
    expect(relatie(o.db, a.id).archived).toBe(1);
    expect(relatie(o.db, b.id).archived).toBe(0);
    expect(voorstellen(o.db)[0]!.status).toBe('samengevoegd');
    await expect(Promise.resolve().then(() => api.relations.mergeDuplicate(id, b.id))).rejects.toThrow(/al samengevoegd/);
    expect(api.relations.duplicates()).toEqual([]);

    // via de knoppen op Vandaag: de taak uit de interface is alleen een aanwijzing
    const p = klant(o, 'Verhuisbedrijf Ster', { email: 'ster@voorbeeld.nl' });
    const q = klant(o, 'Ster Verhuizingen', { email: 'ster@voorbeeld.nl' });
    const r1 = klant(o, 'Aannemer Wit', { kvk_number: uniekKvk() });
    const taken = o.dubbelTaken();
    expect(taken).toHaveLength(1);
    const taak = taken[0]!;
    const vals: Task[] = [{ ...taak, ref: {} }, { ...taak, ref: { dubbelId: 99_999 } }, { ...taak, key: 'klant-dubbel:1-2' }];
    for (const nep of vals) await expect(api.home.act(nep, 'samenvoegen-op-a')).rejects.toThrow();
    expect(relatie(o.db, p.id).archived).toBe(0);
    await api.home.act(taak, 'later');
    expect(relatie(o.db, p.id).archived).toBe(0);
    expect(o.dubbelTaken()).toHaveLength(1);
    await api.home.act(taak, 'samenvoegen-op-b');
    expect(relatie(o.db, p.id).archived).toBe(1);
    expect(relatie(o.db, q.id).archived).toBe(0);
    expect(relatie(o.db, r1.id).archived).toBe(0);
    expect(o.dubbelTaken()).toEqual([]);
    // verschillend wijst af
    const s1 = klant(o, 'Zaak Een', { email: 'zaak@voorbeeld.nl' });
    const s2 = klant(o, 'Zaak Twee', { email: 'zaak@voorbeeld.nl' });
    const taak2 = o.dubbelTaken()[0]!;
    await api.home.act(taak2, 'verschillend');
    expect(voorstelVan(o.db, s1.id, s2.id)[0]).toMatchObject({ status: 'afgewezen' });
    expect([relatie(o.db, s1.id).archived, relatie(o.db, s2.id).archived]).toEqual([0, 0]);
    expect(o.dubbelTaken()).toEqual([]);
  });

  it('DUBBEL-11 migratie en nooit verwijderen: de migratie is relatief getest, bestaande rijen overleven, user_version klopt, de nieuwe code verwijdert niets en alias-rijen worden alleen toegevoegd of van doel verlegd', () => {
    const zoek = 'CREATE TABLE IF NOT EXISTS klant_dubbel_voorstellen';
    const i = migrations.findIndex((m) => m.includes(zoek));
    expect(i).toBeGreaterThan(0);
    expect(migrations.filter((m) => m.includes(zoek))).toHaveLength(1);
    expect(migrations[i]!).not.toMatch(/TRIGGER|DROP|DELETE|RENAME/i);
    const oud = new Database(':memory:');
    oud.pragma('foreign_keys = ON');
    for (const m of migrations.slice(0, i)) oud.exec(m);
    oud.pragma(`user_version = ${i}`);
    expect(oud.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'klant_dubbel_voorstellen'`).all()).toHaveLength(0);
    oud.exec(`INSERT INTO relations (type, name, uuid) VALUES ('klant', 'Oude klant', 'u-oud')`);
    oud.exec(`INSERT INTO relation_aliases (alias_uuid, relation_id, aangemaakt_op) VALUES ('alias-oud', 1, 5)`);
    migrate(oud);
    expect(oud.pragma('user_version', { simple: true })).toBe(migrations.length);
    expect(oud.prepare('SELECT name, uuid FROM relations').all()).toEqual([{ name: 'Oude klant', uuid: 'u-oud' }]);
    expect(oud.prepare('SELECT alias_uuid, relation_id FROM relation_aliases').all()).toEqual([{ alias_uuid: 'alias-oud', relation_id: 1 }]);
    const kolommen = (oud.prepare('PRAGMA table_info(klant_dubbel_voorstellen)').all() as { name: string }[]).map((k) => k.name);
    expect(kolommen).toEqual(['id', 'relation_a', 'relation_b', 'reden', 'status', 'gemaakt_op', 'beslist_op']);
    oud.exec(`INSERT INTO relations (type, name) VALUES ('klant', 'Tweede klant')`);
    const voeg = (a: number, b: number, status = 'voorgesteld') => oud.prepare(`INSERT INTO klant_dubbel_voorstellen (relation_a, relation_b, reden, status, gemaakt_op) VALUES (?, ?, 'zelfde naam', ?, 1)`).run(a, b, status);
    expect(() => voeg(1, 99)).toThrow();
    expect(() => voeg(2, 1)).toThrow();
    expect(() => voeg(1, 2, 'onzin')).toThrow();
    voeg(1, 2);
    expect(() => voeg(1, 2)).toThrow();
    oud.close();

    // de nieuwe code verwijdert niets: geen DELETE, geen vervangende inserts
    const bron = readFileSync(join(__dirname, '..', 'src', 'relations', 'dubbelen.ts'), 'utf8');
    const relationsTekst = readFileSync(join(__dirname, '..', 'src', 'relations', 'relations.ts'), 'utf8');
    const nieuweCode = bron + relationsTekst.slice(relationsTekst.indexOf('schrijfAlias('), relationsTekst.indexOf('private schrijfVeld'));
    for (const verboden of [['DELE', 'TE\\s+FROM'], ['INSERT\\s+OR\\s+REPLA', 'CE'], ['REPLA', 'CE\\s+INTO'], ['ON\\s+DELE', 'TE\\s+CASCADE'], ['next', 'Counter']]) expect(nieuweCode).not.toMatch(new RegExp(verboden.join(''), 'i'));

    // een keten van samenvoegingen: aliassen komen erbij of wijzen daarna naar het nieuwe doel, en het aantal daalt nooit
    const o = omgeving();
    const a = o.telefoonKlant('Keten A');
    const b = o.telefoonKlant('Keten B');
    const c = klant(o, 'Keten C');
    const tel = () => n(o.db, 'SELECT COUNT(*) AS n FROM relation_aliases');
    const alias = () => Object.fromEntries(rijen(o.db, 'SELECT alias_uuid, relation_id FROM relation_aliases').map((r) => [r.alias_uuid, r.relation_id]));
    o.relations.voegSamen(a.klant.id, b.klant.id);
    expect(tel()).toBe(1);
    expect(alias()).toEqual({ [a.uuid]: b.klant.id });
    o.relations.voegSamen(b.klant.id, c.id);
    expect(tel()).toBe(2);
    expect(alias()).toEqual({ [a.uuid]: c.id, [b.uuid]: c.id });
    expect(o.relations.vindOpSyncUuid(a.uuid)!.id).toBe(c.id);
    expect(o.relations.schrijfAlias(a.uuid, c.id)).toBe(false);
    expect(o.relations.schrijfAlias(a.uuid, b.klant.id)).toBe(true);
    expect(tel()).toBe(2);
  });

  it('DUBBEL-12 gedragsneutraal en grenzen: zonder dubbelen verandert niets, het zoeken is begrensd en gebruikt SQL (5000 unieke klanten geven geen voorstellen binnen enkele seconden) en de bestaande aliasroute van de ontvangst blijft werken', () => {
    const o = omgeving();
    // zonder dubbelen: Vandaag, de klanten en de tellers blijven gelijk
    const takenVoor = o.s.inbox.tasks();
    const voor = toestand(o.db);
    expect(zoekDubbelen(o.db)).toBe(0);
    expect(o.s.inbox.tasks()).toEqual(takenVoor);
    expect(toestand(o.db)).toEqual(voor);
    expect(openVoorstellen(o.db)).toEqual({ voorstellen: [], meer: 0 });

    // 5000 klanten met unieke gegevens: nul voorstellen, in SQL, binnen enkele seconden
    const voeg = o.db.prepare(`INSERT INTO relations (type, name, email, kvk_number, vat_number, uuid) VALUES ('klant', ?, ?, ?, ?, ?)`);
    o.db.transaction(() => {
      for (let i = 0; i < 5000; i++) voeg.run(`Bedrijf ${i} Naam`, `contact${i}@voorbeeld.nl`, String(30_000_000 + i), `NL${String(100_000_000 + i)}B01`, randomUUID());
    })();
    const start = Date.now();
    expect(zoekDubbelen(o.db)).toBe(0);
    expect(Date.now() - start).toBeLessThan(5000);
    expect(n(o.db, 'SELECT COUNT(*) AS n FROM klant_dubbel_voorstellen')).toBe(0);

    // een grote groep met hetzelfde e-mailadres geeft per ronde hoogstens de grens aan nieuwe voorstellen en gaat daarna verder
    const groep = omgeving();
    const vul = groep.db.prepare(`INSERT INTO relations (type, name, email, uuid) VALUES ('klant', ?, 'samen@voorbeeld.nl', ?)`);
    groep.db.transaction(() => {
      for (let i = 0; i < 300; i++) vul.run(`Groepslid ${i} Naam`, randomUUID());
    })();
    expect(MAX_NIEUWE_VOORSTELLEN).toBeGreaterThan(MAX_ZICHTBARE_VOORSTELLEN);
    expect(zoekDubbelen(groep.db, Date.now, 50)).toBe(50);
    expect(zoekDubbelen(groep.db, Date.now, 50)).toBe(50);
    expect(n(groep.db, 'SELECT COUNT(*) AS n FROM klant_dubbel_voorstellen')).toBe(100);
    const zichtbaar = openVoorstellen(groep.db);
    expect(zichtbaar.voorstellen).toHaveLength(MAX_ZICHTBARE_VOORSTELLEN);
    expect(zichtbaar.meer).toBe(50);

    // de bestaande aliasroute (FACT-08): een alias in relation_aliases wijst een telefoonwijziging naar de klant, ook voor een factuur
    const d = omgeving();
    const doel = klant(d, 'Doel Alias Klant');
    const aliasUuid = randomUUID();
    d.db.prepare('INSERT INTO relation_aliases (alias_uuid, relation_id, aangemaakt_op) VALUES (?, ?, ?)').run(aliasUuid, doel.id, Date.now());
    const klanten = n(d.db, 'SELECT COUNT(*) AS n FROM relations');
    expect(d.sync.verwerk(APPARAAT, BRON, { entiteit: 'klant', uuid: aliasUuid, revisie: 1, tijd: Date.now() + 1000, velden: { telefoon: '010-1234567' } })).toEqual({ status: 200, uitkomst: 'toegepast' });
    expect(relatie(d.db, doel.id).phone).toBe('010-1234567');
    const factuurUuid = randomUUID();
    expect(d.sync.verwerk(APPARAAT, BRON, { entiteit: 'factuur', uuid: factuurUuid, revisie: 1, tijd: Date.now() - DAG, velden: factuurVelden(aliasUuid, 1) })).toEqual({ status: 200, uitkomst: 'toegepast' });
    expect(rijen(d.db, 'SELECT relation_id FROM invoices WHERE uuid = ?', factuurUuid)).toEqual([{ relation_id: doel.id }]);
    expect(n(d.db, 'SELECT COUNT(*) AS n FROM relations')).toBe(klanten);

    // een gedeelde sleutel schaalt niet kwadratisch: 2000 klanten met hetzelfde e-mailadres geven een beperkt aantal voorstellen, snel
    const veel = omgeving();
    const vulVeel = veel.db.prepare(`INSERT INTO relations (type, name, email, uuid) VALUES ('klant', ?, 'placeholder@voorbeeld.nl', ?)`);
    veel.db.transaction(() => {
      for (let i = 0; i < 2000; i++) vulVeel.run(`Veelvoud ${i} Naam`, randomUUID());
    })();
    const begin = Date.now();
    const nieuw = zoekDubbelen(veel.db);
    expect(Date.now() - begin).toBeLessThan(3000);
    expect(nieuw).toBeGreaterThan(0);
    expect(nieuw).toBeLessThanOrEqual((MAX_KLANTEN_PER_SLEUTEL * (MAX_KLANTEN_PER_SLEUTEL - 1)) / 2);
    expect(n(veel.db, 'SELECT COUNT(*) AS n FROM klant_dubbel_voorstellen')).toBe(nieuw);
    const begin2 = Date.now();
    zoekDubbelen(veel.db);
    expect(Date.now() - begin2).toBeLessThan(3000);

    // een echte fout in het zoeken breekt Vandaag niet en komt met alleen de foutmelding in het logboek
    const stuk = omgeving();
    stuk.db.exec('DROP TABLE klant_dubbel_voorstellen');
    const spion = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => stuk.s.inbox.tasks()).not.toThrow();
      expect(stuk.dubbelTaken()).toEqual([]);
      const regels = spion.mock.calls.filter((c) => String(c[0]).includes('ubbele klanten'));
      expect(regels.length).toBeGreaterThan(0);
      expect(regels[0]).toHaveLength(2);
      expect(String(regels[0]![1])).toContain('klant_dubbel_voorstellen');
    } finally {
      spion.mockRestore();
    }
  });
});

