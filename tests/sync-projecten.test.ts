import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, openDatabase } from '../src/db/database';
import { migrations } from '../src/db/migrations';
import { setup } from './helpers';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import { herstelJobUuids } from '../src/jobs/herstel';
import { veldOndergrens } from '../src/sync/ondergrens';
import { RelationsService } from '../src/relations/relations';
import { SyncOntvangst } from '../src/sync/ontvangst';
import { Bonnenscanner } from '../src/scanner/scanner';
import { PHONE_SCANNER } from '../src/shared/phone-scanner';
import { CONTENT_TYPE, ENDPOINT_PATH, LIMITS, decodePairing, encodeFrame, openResponse, sealRequest, type PairingPayload } from '../src/scanner/protocol';

// Projecten (klussen, tabel jobs) in de sync: uuid, revisie, wijzigingsteller, tijd per veld, logboek,
// archief en de wachtrij voor wijzigingen die op een onbekende klant wachten. Dit bestand begint met de
// migratie, de lokale schrijfpaden en de archieffilters; de ontvangst van projecten staat verderop.

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const n = (db: Database.Database, sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { n: number }).n;
/** De datum van vandaag zoals de code hem bepaalt (SQLite date('now'), UTC); de testklok stuurt SQLite niet aan. */
const vandaag = (db: Database.Database) => (db.prepare(`SELECT date('now') AS d`).get() as { d: string }).d;
const teller = (db: Database.Database) => (db.prepare(`SELECT waarde FROM sync_teller WHERE naam = 'wijziging'`).get() as { waarde: number }).waarde;
type Kolom = { name: string; type: string; notnull: number; dflt_value: string | null; pk: number };
const kolommen = (db: Database.Database, tabel: string) => db.prepare(`PRAGMA table_info(${tabel})`).all() as Kolom[];

/** de index van de eigen migratie, op inhoud gevonden zodat latere migraties dit niet breken */
const EIGEN = migrations.findIndex((m) => /CREATE TABLE (IF NOT EXISTS )?sync_wachtrij\b/.test(m));

/** Een database in de toestand vóór de eigen migratie, met een paar klussen. */
function oudeToestand() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const m of migrations.slice(0, EIGEN)) db.exec(m);
  db.pragma(`user_version = ${EIGEN}`);
  return db;
}

describe('projecten-migratie', () => {
  it('de eigen migratie bestaat precies een keer en user_version is gelijk aan migrations.length', () => {
    expect(EIGEN).toBeGreaterThan(0);
    expect(migrations.filter((m) => /CREATE TABLE (IF NOT EXISTS )?sync_wachtrij\b/.test(m))).toHaveLength(1);
    const db = new Database(':memory:');
    migrate(db);
    expect(db.pragma('user_version', { simple: true })).toBe(migrations.length);
  });

  it('jobs krijgt uuid, revisie, gewijzigd_op, archived en sync_seq met een unieke index op uuid en een gewone op sync_seq', () => {
    const db = new Database(':memory:');
    migrate(db);
    const k = Object.fromEntries(kolommen(db, 'jobs').map((c) => [c.name, c]));
    expect(k.uuid).toMatchObject({ type: 'TEXT', notnull: 0 });
    expect(k.revisie).toMatchObject({ type: 'INTEGER', notnull: 1, dflt_value: '1' });
    expect(k.gewijzigd_op).toMatchObject({ type: 'INTEGER' });
    expect(k.archived).toMatchObject({ type: 'INTEGER', notnull: 1, dflt_value: '0' });
    expect(k.sync_seq).toMatchObject({ type: 'INTEGER', notnull: 1, dflt_value: '0' });
    const indexen = db.prepare(`PRAGMA index_list(jobs)`).all() as { name: string; unique: number }[];
    const opKolom = (kolom: string) => indexen.filter((i) => (db.prepare(`PRAGMA index_info(${i.name})`).all() as { name: string }[]).map((c) => c.name).join() === kolom);
    expect(opKolom('uuid')).toHaveLength(1);
    expect(opKolom('uuid')[0]!.unique).toBe(1);
    expect(opKolom('sync_seq')).toHaveLength(1);
    expect(opKolom('sync_seq')[0]!.unique).toBe(0);
    // de CHECK op archived en de unieke uuid werken echt
    const klant = Number(db.prepare(`INSERT INTO relations (type, name) VALUES ('klant', 'K')`).run().lastInsertRowid);
    expect(() => db.prepare(`INSERT INTO jobs (relation_id, title, archived) VALUES (?, 'x', 2)`).run(klant)).toThrow(/CHECK/);
    db.prepare(`INSERT INTO jobs (relation_id, title, uuid) VALUES (?, 'x', 'dubbel')`).run(klant);
    expect(() => db.prepare(`INSERT INTO jobs (relation_id, title, uuid) VALUES (?, 'y', 'dubbel')`).run(klant)).toThrow(/UNIQUE/);
    db.prepare(`INSERT INTO jobs (relation_id, title) VALUES (?, 'zonder uuid')`).run(klant);
    db.prepare(`INSERT INTO jobs (relation_id, title) VALUES (?, 'ook zonder uuid')`).run(klant);
    expect(n(db, 'SELECT COUNT(*) AS n FROM jobs WHERE uuid IS NULL')).toBe(2);
  });

  it('job_field_rev en job_changelog hebben precies de kolommen van het contract', () => {
    const db = new Database(':memory:');
    migrate(db);
    expect(kolommen(db, 'job_field_rev').map((c) => c.name)).toEqual(['job_id', 'veld', 'tijd', 'bron']);
    expect(kolommen(db, 'job_field_rev').filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name)).toEqual(['job_id', 'veld']);
    expect(kolommen(db, 'job_changelog').map((c) => c.name)).toEqual(['id', 'job_id', 'revisie', 'veld', 'oud', 'nieuw', 'tijd', 'bron']);
    expect(kolommen(db, 'job_changelog').find((c) => c.name === 'oud')?.notnull).toBe(0);
    expect(kolommen(db, 'job_changelog').find((c) => c.name === 'nieuw')?.notnull).toBe(0);
  });

  it('sync_wachtrij heeft precies de kolommen van het contract, een unieke sleutel en de index voor het verwerken', () => {
    const db = new Database(':memory:');
    migrate(db);
    const k = kolommen(db, 'sync_wachtrij');
    expect(k.map((c) => c.name)).toEqual(['id', 'apparaat_id', 'bron', 'entiteit', 'uuid', 'revisie', 'tijd', 'wijziging', 'nummer', 'wacht_op_entiteit', 'wacht_op_uuid', 'reden', 'ontvangen_op', 'verwerkt_op', 'verwerkt_uitkomst', 'verwerkt_reden', 'route', 'verwerkt_seq']);
    expect(k.find((c) => c.name === 'id')).toMatchObject({ type: 'INTEGER', pk: 1 });
    expect(k.find((c) => c.name === 'nummer')?.notnull).toBe(0);
    expect(k.find((c) => c.name === 'verwerkt_op')?.notnull).toBe(0);
    expect(db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'sync_wachtrij'`).get()).toMatchObject({ sql: expect.stringMatching(/AUTOINCREMENT/) });
    const unieke = (db.prepare(`PRAGMA index_list(sync_wachtrij)`).all() as { name: string; unique: number }[])
      .filter((i) => i.unique === 1)
      .map((i) => (db.prepare(`PRAGMA index_info(${i.name})`).all() as { name: string }[]).map((c) => c.name));
    expect(unieke).toContainEqual(['apparaat_id', 'entiteit', 'uuid', 'revisie']);
    const gewone = (db.prepare(`PRAGMA index_list(sync_wachtrij)`).all() as { name: string; unique: number }[])
      .filter((i) => i.unique === 0)
      .map((i) => (db.prepare(`PRAGMA index_info(${i.name})`).all() as { name: string }[]).map((c) => c.name));
    expect(gewone).toContainEqual(['verwerkt_op', 'wacht_op_entiteit', 'wacht_op_uuid']);
    const rij = (revisie: number) => db.prepare(`INSERT INTO sync_wachtrij (apparaat_id, bron, entiteit, uuid, revisie, tijd, wijziging, wacht_op_entiteit, wacht_op_uuid, reden, ontvangen_op) VALUES ('a', 'M1', 'project', 'u', ?, 1, '{}', 'klant', 'k', 'klant-onbekend', 2)`).run(revisie);
    rij(1);
    expect(() => rij(1)).toThrow(/UNIQUE/);
    rij(2);
  });

  it('een oude toestand wordt gemigreerd: oude kolommen byte-gelijk, sync_seq = oude teller + id, teller opgehoogd, job_field_rev leeg', () => {
    const db = oudeToestand();
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'job_field_rev'`).get()).toBeUndefined();
    const k1 = Number(db.prepare(`INSERT INTO relations (type, name) VALUES ('klant', 'Een')`).run().lastInsertRowid);
    const k2 = Number(db.prepare(`INSERT INTO relations (type, name) VALUES ('klant', 'Twee')`).run().lastInsertRowid);
    db.prepare(`INSERT INTO jobs (relation_id, title, address, status, start_date, end_date, notes, created_at, lat, lon) VALUES (?, 'Badkamer', 'Dorpsstraat 5', 'bezig', '2026-09-01', NULL, 'tegels', '2026-09-02 10:00:00', 52.1, 5.1)`).run(k1);
    db.prepare(`INSERT INTO jobs (relation_id, title, created_at) VALUES (?, 'Keuken', '2026-09-03 08:30:00')`).run(k2);
    db.prepare(`INSERT INTO jobs (relation_id, title, created_at) VALUES (?, 'Dak', '2026-09-04 08:30:00')`).run(k2);
    const voor = db.prepare('SELECT * FROM jobs ORDER BY id').all() as Record<string, unknown>[];
    // de teller staat hoger dan het aantal klanten, zoals na wat bewerkingen
    db.prepare(`UPDATE sync_teller SET waarde = 7 WHERE naam = 'wijziging'`).run();
    const tellerVoor = teller(db);
    expect(tellerVoor).toBe(7);
    migrate(db);
    expect(db.pragma('user_version', { simple: true })).toBe(migrations.length);
    const na = db.prepare('SELECT * FROM jobs ORDER BY id').all() as Record<string, unknown>[];
    expect(na).toHaveLength(3);
    for (const [i, rij] of na.entries()) {
      for (const [naam, waarde] of Object.entries(voor[i]!)) expect(rij[naam], `${naam} van klus ${rij.id}`).toEqual(waarde);
      expect(rij.sync_seq).toBe(tellerVoor + (rij.id as number));
      expect(rij.revisie).toBe(1);
      expect(rij.archived).toBe(0);
      expect(rij.uuid).toMatch(UUID_V4);
    }
    expect(new Set(na.map((r) => r.uuid)).size).toBe(3);
    expect(na[0]!.gewijzigd_op).toBe(veldOndergrens('2026-09-02 10:00:00'));
    expect(teller(db)).toBe(tellerVoor + 3);
    expect(n(db, 'SELECT COUNT(*) AS n FROM job_field_rev')).toBe(0);
    expect(n(db, 'SELECT COUNT(*) AS n FROM job_changelog')).toBe(0);
    expect(n(db, 'SELECT COUNT(*) AS n FROM sync_wachtrij')).toBe(0);
  });

  it('zonder klussen blijft de teller staan en een tweede keer migreren verandert niets', () => {
    const db = oudeToestand();
    db.prepare(`INSERT INTO relations (type, name) VALUES ('klant', 'Een')`).run();
    const voor = teller(db);
    migrate(db);
    expect(teller(db)).toBe(voor);
    migrate(db);
    expect(teller(db)).toBe(voor);
  });

  it('de tekst van de eigen migratie bevat geen DROP, DELETE, RENAME of INSERT OR REPLACE, ook niet in commentaar', () => {
    const tekst = migrations[EIGEN]!;
    expect(tekst).toMatch(/CREATE TABLE (IF NOT EXISTS )?sync_wachtrij\b/);
    for (const verboden of [/\bDROP\b/i, /\bDELETE\b/i, /\bRENAME\b/i, /INSERT\s+OR\s+REPLACE/i, /REPLACE\s+INTO/i]) expect(tekst).not.toMatch(verboden);
    // alleen de toegestane soorten opdrachten
    const opdrachten = tekst.replace(/--.*$/gm, '').split(';').map((s) => s.trim()).filter(Boolean);
    for (const o of opdrachten) expect(o).toMatch(/^(ALTER TABLE jobs ADD COLUMN|CREATE (UNIQUE )?INDEX|CREATE TABLE|UPDATE )/);
  });

  it('herstelJobUuids geeft elke klus zonder uuid een unieke uuid v4 en elke rij met sync_seq 0 een volgend nummer, en doet niets als dat al zo is', () => {
    const db = new Database(':memory:');
    migrate(db);
    const klant = Number(db.prepare(`INSERT INTO relations (type, name) VALUES ('klant', 'K')`).run().lastInsertRowid);
    // zoals een oudere app-versie na de migratie schrijft: geen uuid, sync_seq 0
    for (const t of ['a', 'b', 'c']) db.prepare(`INSERT INTO jobs (relation_id, title) VALUES (?, ?)`).run(klant, t);
    const bestaand = n(db, 'SELECT COUNT(*) AS n FROM jobs');
    const voor = teller(db);
    const meldingen: string[] = [];
    herstelJobUuids(db, (m) => meldingen.push(m));
    const rijen = db.prepare('SELECT uuid, sync_seq FROM jobs ORDER BY id').all() as { uuid: string; sync_seq: number }[];
    expect(rijen).toHaveLength(bestaand);
    for (const r of rijen) expect(r.uuid).toMatch(UUID_V4);
    expect(new Set(rijen.map((r) => r.uuid)).size).toBe(3);
    expect(rijen.map((r) => r.sync_seq)).toEqual([voor + 1, voor + 2, voor + 3]);
    expect(teller(db)).toBe(voor + 3);
    expect(meldingen).toHaveLength(1);
    // een tweede keer is er niets meer te doen
    herstelJobUuids(db, (m) => meldingen.push(m));
    expect(teller(db)).toBe(voor + 3);
    expect(meldingen).toHaveLength(1);
  });

  it('openDatabase roept het herstel van klussen aan', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bvn-projecten-herstel-'));
    try {
      const bestand = join(dir, 'boekhouding.sqlite');
      const db = openDatabase(bestand);
      const klant = Number(db.prepare(`INSERT INTO relations (type, name) VALUES ('klant', 'K')`).run().lastInsertRowid);
      db.prepare(`INSERT INTO jobs (relation_id, title) VALUES (?, 'zonder uuid')`).run(klant);
      db.close();
      const opnieuw = openDatabase(bestand);
      const rij = opnieuw.prepare('SELECT uuid, sync_seq FROM jobs').get() as { uuid: string; sync_seq: number };
      expect(rij.uuid).toMatch(UUID_V4);
      expect(rij.sync_seq).toBeGreaterThan(0);
      opnieuw.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('projecten-lokaal', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-07T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const velden = (db: Database.Database, id: number) => db.prepare('SELECT veld, tijd, bron FROM job_field_rev WHERE job_id = ? ORDER BY veld').all(id) as { veld: string; tijd: number; bron: string }[];
  const rij = (db: Database.Database, id: number) => db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Record<string, any>;
  const logboek = (db: Database.Database, id: number) => db.prepare('SELECT revisie, veld, oud, nieuw, tijd, bron FROM job_changelog WHERE job_id = ? ORDER BY id').all(id) as Record<string, unknown>[];

  it('create zet een unieke uuid v4, revisie 1, een sync_seq groter dan 0 en een veldrij met bron pc voor elk ingevuld veld', () => {
    const { s, db, klant } = setup();
    const voor = teller(db);
    const a = s.jobs.create({ relationId: klant.id, title: ' Badkamer ', address: 'Dorpsstraat 5', startDate: '2026-10-10', notes: 'tegels' });
    const b = s.jobs.create({ relationId: klant.id, title: 'Keuken' });
    expect(a.uuid).toMatch(UUID_V4);
    expect(b.uuid).toMatch(UUID_V4);
    expect(a.uuid).not.toBe(b.uuid);
    expect([a.revisie, b.revisie]).toEqual([1, 1]);
    expect([a.sync_seq, b.sync_seq]).toEqual([voor + 1, voor + 2]);
    expect(teller(db)).toBe(voor + 2);
    expect(a.gewijzigd_op).toBe(Date.parse('2026-10-07T12:00:00Z'));
    const tijd = Date.parse('2026-10-07T12:00:00Z');
    expect(velden(db, a.id)).toEqual(['address', 'notes', 'relation_id', 'start_date', 'status', 'title'].map((veld) => ({ veld, tijd, bron: 'pc' })));
    expect(velden(db, b.id).map((v) => v.veld)).toEqual(['relation_id', 'status', 'title']);
    expect(logboek(db, a.id)).toHaveLength(6);
    expect(logboek(db, a.id).find((l) => l.veld === 'title')).toEqual({ revisie: 1, veld: 'title', oud: null, nieuw: 'Badkamer', tijd, bron: 'pc' });
  });

  it('update verhoogt de revisie en het wijzigingsnummer en schrijft alleen de gewijzigde velden met bron pc', () => {
    const { s, db, klant } = setup();
    const job = s.jobs.create({ relationId: klant.id, title: 'Badkamer', address: 'Dorpsstraat 5' });
    vi.setSystemTime(new Date('2026-10-08T09:00:00Z'));
    const tijd = Date.now();
    const voor = teller(db);
    const na = s.jobs.update(job.id, { title: 'Badkamer groot', address: 'Dorpsstraat 5', notes: 'nieuw' });
    expect(na).toMatchObject({ revisie: 2, sync_seq: voor + 1, gewijzigd_op: tijd, title: 'Badkamer groot', notes: 'nieuw' });
    expect(teller(db)).toBe(voor + 1);
    expect(velden(db, job.id).find((v) => v.veld === 'title')).toEqual({ veld: 'title', tijd, bron: 'pc' });
    expect(velden(db, job.id).find((v) => v.veld === 'address')?.tijd).toBe(Date.parse('2026-10-07T12:00:00Z'));
    expect(logboek(db, job.id).filter((l) => l.revisie === 2)).toEqual([
      { revisie: 2, veld: 'title', oud: 'Badkamer', nieuw: 'Badkamer groot', tijd, bron: 'pc' },
      { revisie: 2, veld: 'notes', oud: null, nieuw: 'nieuw', tijd, bron: 'pc' },
    ]);
  });

  it('update zonder verandering geeft geen nieuwe revisie, geen nieuw wijzigingsnummer en geen logregel', () => {
    const { s, db, klant } = setup();
    const job = s.jobs.create({ relationId: klant.id, title: 'Badkamer', address: 'Dorpsstraat 5' });
    const regels = n(db, 'SELECT COUNT(*) AS n FROM job_changelog');
    const voor = teller(db);
    vi.setSystemTime(new Date('2026-10-09T09:00:00Z'));
    const na = s.jobs.update(job.id, { title: 'Badkamer', address: 'Dorpsstraat 5' });
    s.jobs.update(job.id, {});
    expect(na).toMatchObject({ revisie: 1, sync_seq: job.sync_seq, gewijzigd_op: job.gewijzigd_op });
    expect(teller(db)).toBe(voor);
    expect(n(db, 'SELECT COUNT(*) AS n FROM job_changelog')).toBe(regels);
  });

  it('setStatus klaar schrijft status en end_date in job_field_rev; dezelfde status geeft geen revisie', () => {
    const { s, db, klant } = setup();
    const job = s.jobs.create({ relationId: klant.id, title: 'Badkamer' });
    const tijd = Date.now();
    const klaar = s.jobs.setStatus(job.id, 'klaar');
    expect(klaar).toMatchObject({ status: 'klaar', end_date: vandaag(db), revisie: 2 });
    expect(velden(db, job.id).filter((v) => ['status', 'end_date'].includes(v.veld))).toEqual([
      { veld: 'end_date', tijd, bron: 'pc' },
      { veld: 'status', tijd, bron: 'pc' },
    ]);
    expect(logboek(db, job.id).filter((l) => l.revisie === 2).map((l) => [l.veld, l.oud, l.nieuw])).toEqual([['end_date', null, vandaag(db)], ['status', 'gepland', 'klaar']]);
    const seq = rij(db, job.id).sync_seq;
    expect(s.jobs.setStatus(job.id, 'klaar')).toMatchObject({ revisie: 2, sync_seq: seq });
    expect(rij(db, job.id).sync_seq).toBe(seq);
    expect(() => s.jobs.setStatus(job.id, 'onzin' as never)).toThrow(/Onbekende status/);
    expect(() => s.jobs.setStatus(99999, 'klaar')).toThrow(/bestaat niet/);
  });

  it('een bestaande einddatum blijft bij klaar staan', () => {
    const { s, klant } = setup();
    const job = s.jobs.create({ relationId: klant.id, title: 'Badkamer' });
    s.jobs.update(job.id, { endDate: '2026-09-01' });
    expect(s.jobs.setStatus(job.id, 'klaar')).toMatchObject({ status: 'klaar', end_date: '2026-09-01' });
  });

  it('makeInvoice verhoogt de revisie en schrijft status gefactureerd en end_date', () => {
    const { s, db, klant } = setup();
    const job = s.jobs.create({ relationId: klant.id, title: 'Badkamer' });
    const voor = rij(db, job.id);
    s.jobs.makeInvoice(job.id, [{ description: 'Badkamer', quantity: 1, unitPrice: 10000, vatCode: 'hoog' }]);
    const na = rij(db, job.id);
    expect(na).toMatchObject({ status: 'gefactureerd', end_date: vandaag(db), revisie: voor.revisie + 1 });
    expect(na.sync_seq).toBeGreaterThan(voor.sync_seq);
    expect(logboek(db, job.id).filter((l) => l.revisie === 2).map((l) => [l.veld, l.nieuw])).toEqual([['end_date', vandaag(db)], ['status', 'gefactureerd']]);
    expect(velden(db, job.id).find((v) => v.veld === 'status')).toMatchObject({ bron: 'pc' });
  });

  it('InvoiceService.deleteDraft zet de klus terug naar klaar en houdt revisie en sync_seq bij', () => {
    const { s, db, klant } = setup();
    const job = s.jobs.create({ relationId: klant.id, title: 'Plafond' });
    const inv = s.jobs.makeInvoice(job.id, [{ description: 'Plafond', quantity: 1, unitPrice: 10000, vatCode: 'hoog' }]);
    const gefactureerd = rij(db, job.id);
    vi.setSystemTime(new Date('2026-10-08T10:00:00Z'));
    s.invoices.deleteDraft(inv.id);
    const na = rij(db, job.id);
    expect(na).toMatchObject({ status: 'klaar', revisie: gefactureerd.revisie + 1, gewijzigd_op: Date.now() });
    expect(na.sync_seq).toBeGreaterThan(gefactureerd.sync_seq);
    expect(logboek(db, job.id).at(-1)).toMatchObject({ veld: 'status', oud: 'gefactureerd', nieuw: 'klaar', bron: 'pc', revisie: na.revisie });
    expect(velden(db, job.id).find((v) => v.veld === 'status')?.tijd).toBe(Date.now());
    // een concept van een klus zonder factuurstatus laat de klus ongemoeid
    const andere = s.jobs.create({ relationId: klant.id, title: 'Zolder' });
    const concept = s.invoices.createDraft({ relationId: klant.id, lines: [{ description: 'x', quantity: 1, unitPrice: 100, vatCode: 'hoog' }] });
    db.prepare('UPDATE invoices SET job_id = ? WHERE id = ?').run(andere.id, concept.id);
    const voor = rij(db, andere.id);
    s.invoices.deleteDraft(concept.id);
    expect(rij(db, andere.id)).toEqual(voor);
  });

  it('lat, lon en quote_id verhogen de revisie niet', () => {
    const { s, db, klant } = setup();
    const job = s.jobs.create({ relationId: klant.id, title: 'Badkamer' });
    const voor = rij(db, job.id);
    db.prepare('UPDATE jobs SET lat = 52.1, lon = 5.1 WHERE id = ?').run(job.id);
    expect(rij(db, job.id)).toMatchObject({ revisie: voor.revisie, sync_seq: voor.sync_seq, gewijzigd_op: voor.gewijzigd_op, lat: 52.1 });
    expect(velden(db, job.id).map((v) => v.veld)).not.toContain('lat');
    expect(velden(db, job.id).map((v) => v.veld)).not.toContain('quote_id');
    // learnLocation (via een gekoppelde aankoop met GPS) schrijft ook alleen lat en lon
    const q = s.quotes.create({ relationId: klant.id, reference: 'Offerte', lines: [{ description: 'x', quantity: 1, unitPrice: 1000, vatCode: 'hoog' }] });
    const uitOfferte = s.jobs.acceptQuote(q.id);
    expect(uitOfferte.quote_id).toBe(q.id);
    expect(velden(db, uitOfferte.id).map((v) => v.veld)).not.toContain('quote_id');
  });

  it('acceptQuote levert een klus met uuid, revisie 1 en veldrijen', () => {
    const { s, db, klant } = setup();
    const q = s.quotes.create({ relationId: klant.id, reference: 'Woonkamer', lines: [{ description: 'Woonkamer', quantity: 1, unitPrice: 5000, vatCode: 'hoog' }] });
    const job = s.jobs.acceptQuote(q.id);
    expect(job.uuid).toMatch(UUID_V4);
    expect([job.revisie, job.archived]).toEqual([1, 0]);
    expect(job.sync_seq).toBeGreaterThan(0);
    expect(velden(db, job.id).map((v) => v.veld)).toContain('title');
    // opnieuw accepteren geeft dezelfde klus en verandert niets
    const seq = teller(db);
    expect(s.jobs.acceptQuote(q.id).uuid).toBe(job.uuid);
    expect(teller(db)).toBe(seq);
  });

  it('een mislukte schrijfactie laat ook de revisie en de teller ongemoeid (transactie)', () => {
    const { s, db, klant } = setup();
    const job = s.jobs.create({ relationId: klant.id, title: 'Badkamer' });
    const voor = rij(db, job.id);
    const tellerVoor = teller(db);
    db.exec(`CREATE TRIGGER faal_logboek BEFORE INSERT ON job_changelog BEGIN SELECT RAISE(ABORT, 'faal'); END`);
    expect(() => s.jobs.update(job.id, { notes: 'x' })).toThrow(/faal/);
    db.exec('DROP TRIGGER faal_logboek');
    expect(rij(db, job.id)).toEqual(voor);
    expect(teller(db)).toBe(tellerVoor);
  });
});

describe('projecten-archief', () => {
  /** Een klus archiveren zoals de ontvangst dat doet: archived en een nieuw wijzigingsnummer. */
  const archiveer = (db: Database.Database, id: number) => db.prepare('UPDATE jobs SET archived = 1 WHERE id = ?').run(id);

  it('list en suggest slaan gearchiveerde klussen over en list neemt ze op verzoek mee; get leest ze nog', () => {
    const { s, db, klant } = setup();
    const actief = s.jobs.create({ relationId: klant.id, title: 'Actief', startDate: '2026-09-01' });
    const oud = s.jobs.create({ relationId: klant.id, title: 'Oud', startDate: '2026-09-01' });
    s.jobs.setStatus(actief.id, 'bezig');
    s.jobs.setStatus(oud.id, 'bezig');
    expect(s.jobs.suggest({ date: '2026-09-12' }).map((x) => x.job.id).sort()).toEqual([actief.id, oud.id].sort());
    archiveer(db, oud.id);
    expect(s.jobs.list().map((j) => j.id)).toEqual([actief.id]);
    expect(s.jobs.list({ active: true }).map((j) => j.id)).toEqual([actief.id]);
    expect(s.jobs.list({ status: 'bezig' }).map((j) => j.id)).toEqual([actief.id]);
    expect(s.jobs.list({ includeArchived: true }).map((j) => j.id).sort()).toEqual([actief.id, oud.id].sort());
    expect(s.jobs.list({ status: 'bezig', includeArchived: true })).toHaveLength(2);
    expect(s.jobs.suggest({ date: '2026-09-12' }).map((x) => x.job.id)).toEqual([actief.id]);
    expect(s.jobs.get(oud.id)).toMatchObject({ id: oud.id, title: 'Oud', archived: 1 });
    expect(n(db, 'SELECT COUNT(*) AS n FROM jobs')).toBe(2);
  });

  it('de inbox-taken job-done en job-link slaan gearchiveerde klussen over', () => {
    const { s, db, klant } = setup();
    s.settings.update({ onboardingDone: true });
    const klaar = s.jobs.create({ relationId: klant.id, title: 'Klaar werk' });
    s.jobs.setStatus(klaar.id, 'klaar');
    const bezig = s.jobs.create({ relationId: klant.id, title: 'Bezig werk', startDate: '2026-09-01' });
    s.jobs.setStatus(bezig.id, 'bezig');
    s.purchases.create({ invoiceDate: '2026-09-12', description: 'Tegellijm', lines: [{ account: ACCOUNTS.inkoopMaterialen, netAmount: 15207, vatCode: 'hoog' }] });
    const taken = () => s.inbox.tasks('2026-09-15').filter((t) => t.kind === 'job-done' || t.kind === 'job-link');
    expect(taken().map((t) => [t.kind, t.ref.jobId]).sort()).toEqual([['job-done', klaar.id], ['job-link', bezig.id]].sort());
    archiveer(db, klaar.id);
    archiveer(db, bezig.id);
    expect(taken()).toEqual([]);
    expect(n(db, 'SELECT COUNT(*) AS n FROM jobs')).toBe(2);
  });

  it('results en zoeken tonen gearchiveerde klussen wel, zodat historische cijfers niet verdwijnen', () => {
    const { s, db, klant } = setup();
    const job = s.jobs.create({ relationId: klant.id, title: 'Zeldzaamwoord klus' });
    s.jobs.makeInvoice(job.id, [{ description: 'Werk', quantity: 1, unitPrice: 10000, vatCode: 'hoog' }]);
    expect(s.search.search('Zeldzaamwoord').some((g) => g.key === `klus:${job.id}`)).toBe(true);
    archiveer(db, job.id);
    expect(s.jobs.results().map((r) => r.jobId)).toEqual([job.id]);
    expect(s.jobs.results()[0]).toMatchObject({ invoiced: 10000 });
    expect(s.search.search('Zeldzaamwoord').some((g) => g.key === `klus:${job.id}`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------
// De ontvangst van projecten: rechtstreeks via SyncOntvangst, en daarna via de echte receiver
// ---------------------------------------------------------------------------------------------------

const VAST = Date.UTC(2026, 9, 7, 12, 0, 0);
const MINUUT = 60 * 1000;
const DAG = 24 * 60 * MINUUT;

/** Een administratie met de ontvangst van de telefoon en een BEFORE DELETE-bewaking op alle tabellen waar niets uit mag verdwijnen. */
function admin() {
  const t = setup();
  const meldingen: string[] = [];
  const relations = new RelationsService(t.db, () => VAST);
  const sync = new SyncOntvangst(t.db, relations, { now: () => VAST, log: (m) => meldingen.push(m) });
  for (const tabel of ['jobs', 'job_field_rev', 'job_changelog', 'sync_wachtrij', 'sync_ontvangen', 'relations', 'relation_field_rev', 'relation_changelog']) {
    t.db.exec(`CREATE TRIGGER geen_delete_${tabel} BEFORE DELETE ON ${tabel} BEGIN SELECT RAISE(ABORT, 'DELETE op ${tabel}'); END`);
  }
  const klantUuid = (t.db.prepare('SELECT uuid FROM relations WHERE id = ?').get(t.klant.id) as { uuid: string }).uuid;
  return { ...t, sync, relations, meldingen, klantUuid };
}
type Admin = ReturnType<typeof admin>;

/** Een wijziging zoals de receiver hem aan SyncOntvangst geeft: de velden in een object zonder prototype. */
function wijziging(entiteit: 'project' | 'klant', over: { uuid?: string; revisie?: number; tijd?: number; velden?: Record<string, unknown> } = {}) {
  return { entiteit, uuid: over.uuid ?? randomUUID(), revisie: over.revisie ?? 1, tijd: over.tijd ?? VAST, velden: Object.assign(Object.create(null) as Record<string, unknown>, over.velden ?? {}) };
}
const projectWijziging = (a: Admin, over: Parameters<typeof wijziging>[1] = {}, velden: Record<string, unknown> = {}) =>
  wijziging('project', { ...over, velden: { titel: 'Badkamer', klant: a.klantUuid, ...(over.velden ?? {}), ...velden } });

const TABELLEN = ['jobs', 'job_field_rev', 'job_changelog', 'sync_wachtrij', 'sync_ontvangen'] as const;
const telling = (db: Database.Database) => Object.fromEntries(TABELLEN.map((t) => [t, n(db, `SELECT COUNT(*) AS n FROM ${t}`)]));
const job = (db: Database.Database, uuid: string) => db.prepare('SELECT * FROM jobs WHERE uuid = ?').get(uuid) as Record<string, any> | undefined;
const veldRij = (db: Database.Database, id: number, veld: string) => db.prepare('SELECT tijd, bron FROM job_field_rev WHERE job_id = ? AND veld = ?').get(id, veld) as { tijd: number; bron: string } | undefined;
const register = (db: Database.Database, uuid: string) => db.prepare('SELECT apparaat_id, revisie, uitkomst, fout FROM sync_ontvangen WHERE uuid = ? ORDER BY revisie, apparaat_id').all(uuid) as { apparaat_id: string; revisie: number; uitkomst: string; fout: string | null }[];
const wachtrij = (db: Database.Database, uuid?: string) => db.prepare(`SELECT * FROM sync_wachtrij ${uuid ? 'WHERE uuid = ?' : ''} ORDER BY id`).all(...(uuid ? [uuid] : [])) as Record<string, any>[];
const logRegels = (db: Database.Database, id: number) => db.prepare('SELECT revisie, veld, oud, nieuw, tijd, bron FROM job_changelog WHERE job_id = ? ORDER BY id').all(id) as Record<string, unknown>[];

/** Een klant die de telefoon aanmaakt (voor de wachtrij: de klant komt later). */
const klantWijziging = (uuid: string, naam = 'Nieuwe klant') => wijziging('klant', { uuid, velden: { naam } });

describe('projecten-veld', () => {
  it('een project met geldige velden wordt een klus, met de veldmapping uit het contract', () => {
    const a = admin();
    const w = projectWijziging(a, { tijd: VAST - 5 * MINUUT }, { adres: 'Dorpsstraat 5', startdatum: '2026-10-10', einddatum: '2026-10-12', notities: 'tegels', status: 'bezig', gearchiveerd: 0 });
    expect(a.sync.verwerk('dev-1', 'M1', w)).toEqual({ status: 200, uitkomst: 'toegepast' });
    const j = job(a.db, w.uuid)!;
    expect(j).toMatchObject({ title: 'Badkamer', address: 'Dorpsstraat 5', start_date: '2026-10-10', end_date: '2026-10-12', notes: 'tegels', status: 'bezig', relation_id: a.klant.id, archived: 0, revisie: 1, quote_id: null, lat: null, lon: null, gewijzigd_op: VAST - 5 * MINUUT });
    expect(j.sync_seq).toBeGreaterThan(0);
    const velden = a.db.prepare('SELECT veld, tijd, bron FROM job_field_rev WHERE job_id = ? ORDER BY veld').all(j.id);
    expect(velden).toEqual(['address', 'end_date', 'gearchiveerd', 'notes', 'relation_id', 'start_date', 'status', 'title'].map((veld) => ({ veld, tijd: VAST - 5 * MINUUT, bron: 'M1' })));
    expect(logRegels(a.db, j.id)).toHaveLength(8);
    expect(register(a.db, w.uuid)).toEqual([{ apparaat_id: 'dev-1', revisie: 1, uitkomst: 'toegepast', fout: null }]);
  });

  it('een project met alleen titel en klant krijgt de standaardwaarden en tijd 0 voor de velden die niet zijn meegestuurd', () => {
    const a = admin();
    const w = projectWijziging(a);
    a.sync.verwerk('dev-1', 'M1', w);
    const j = job(a.db, w.uuid)!;
    expect(j).toMatchObject({ status: 'gepland', archived: 0, address: null, notes: null });
    for (const veld of ['address', 'start_date', 'end_date', 'notes', 'status', 'gearchiveerd']) expect(veldRij(a.db, j.id, veld)).toEqual({ tijd: 0, bron: '' });
    expect(logRegels(a.db, j.id).map((l) => l.veld).sort()).toEqual(['relation_id', 'title']);
  });

  const VERBODEN: [string, Record<string, unknown>][] = [
    ['quote_id', { quote_id: 5 }],
    ['kosten', { kosten: 100 }],
    ['marge', { marge: 10 }],
    ['lat', { lat: 52.1 }],
    ['lon', { lon: 5.1 }],
    ['status', { status: 'gefactureerd' }],
    ['__proto__', JSON.parse('{"__proto__":{"gevaar":true}}')],
    ['constructor', { constructor: 'x' }],
    ['prototype', { prototype: 'x' }],
    ['onbekendeNaam', { onbekendeNaam: 'x' }],
  ];
  it.each(VERBODEN)('het verboden veld %s geeft 400 veld-ongeldig zonder iets achter te laten', (veld, extra) => {
    const a = admin();
    // een bestaand project, zodat ook een wijziging van dat project niets mag veranderen
    const bestaand = projectWijziging(a);
    a.sync.verwerk('dev-1', 'M1', bestaand);
    const voor = telling(a.db);
    const tellerVoor = teller(a.db);
    for (const w of [projectWijziging(a, {}, extra), projectWijziging(a, { uuid: bestaand.uuid, revisie: 2 }, extra)]) {
      const r = a.sync.verwerk('dev-1', 'M1', w);
      expect(r).toMatchObject({ status: 400, fout: 'veld-ongeldig', veld });
      expect(r.melding).toContain(veld === 'status' ? 'gefactureerd' : veld);
      expect(r.melding).toMatch(/[a-z]/);
    }
    expect(telling(a.db)).toEqual(voor);
    expect(teller(a.db)).toBe(tellerVoor);
    expect(({} as Record<string, unknown>).gevaar).toBeUndefined();
  });

  it('meer dan 16 velden geeft 400 veld-ongeldig en de limiet van de wijziging zelf (64 sleutels) blijft daarnaast gelden', () => {
    const a = admin();
    const veel: Record<string, unknown> = {};
    for (let i = 0; i < 17; i++) veel[`veld${i}`] = 'x';
    const voor = telling(a.db);
    const r = a.sync.verwerk('dev-1', 'M1', projectWijziging(a, {}, veel));
    expect(r).toMatchObject({ status: 400, fout: 'veld-ongeldig', veld: 'velden' });
    expect(r.melding).toContain('16');
    expect(telling(a.db)).toEqual(voor);
  });

  it('de lengtegrenzen: titel 200, adres 300 en notities 4000 tekens zijn goed, een teken meer is een veldfout', () => {
    const a = admin();
    const voor = telling(a.db);
    for (const [veld, max] of [['titel', 200], ['adres', 300], ['notities', 4000]] as const) {
      const r = a.sync.verwerk('dev-1', 'M1', projectWijziging(a, {}, { [veld]: 'x'.repeat(max + 1) }));
      expect(r, veld).toMatchObject({ status: 400, fout: 'veld-ongeldig', veld });
      expect(r.melding).toContain(String(max));
    }
    expect(telling(a.db)).toEqual(voor);
    const w = projectWijziging(a, {}, { titel: 'x'.repeat(200), adres: 'a'.repeat(300), notities: 'n'.repeat(4000) });
    expect(a.sync.verwerk('dev-1', 'M1', w)).toEqual({ status: 200, uitkomst: 'toegepast' });
    expect(job(a.db, w.uuid)).toMatchObject({ title: 'x'.repeat(200), address: 'a'.repeat(300), notes: 'n'.repeat(4000) });
  });

  const FOUTE_TYPEN: [string, unknown][] = [
    ['titel', 42],
    ['titel', ''],
    ['titel', '   '],
    ['titel', null],
    ['adres', ['Dorpsstraat']],
    ['notities', true],
    ['startdatum', 20261010],
    ['startdatum', '10-10-2026'],
    ['einddatum', '2026-02-30'],
    ['status', 'klaar!'],
    ['status', null],
    ['klant', 'geen-uuid'],
    ['klant', 12],
    ['klant', null],
    ['gearchiveerd', 2],
    ['gearchiveerd', 'ja'],
  ];
  it.each(FOUTE_TYPEN)('het veld %s met waarde %j wordt geweigerd', (veld, waarde) => {
    const a = admin();
    const voor = telling(a.db);
    const r = a.sync.verwerk('dev-1', 'M1', projectWijziging(a, {}, { [veld]: waarde }));
    expect(r).toMatchObject({ status: 400, fout: 'veld-ongeldig', veld });
    expect(r.melding).toContain(veld);
    expect(telling(a.db)).toEqual(voor);
  });

  it('datums mogen leeg (null) zijn en het veld velden moet een object zijn', () => {
    const a = admin();
    const w = projectWijziging(a, {}, { startdatum: null, einddatum: null, adres: null, notities: null });
    expect(a.sync.verwerk('dev-1', 'M1', w)).toEqual({ status: 200, uitkomst: 'toegepast' });
    expect(job(a.db, w.uuid)).toMatchObject({ start_date: null, end_date: null, address: null, notes: null });
    const voor = telling(a.db);
    for (const velden of [null, [], 'tekst']) {
      expect(a.sync.verwerk('dev-1', 'M1', { entiteit: 'project', uuid: randomUUID(), revisie: 1, tijd: VAST, velden: velden as never })).toMatchObject({ status: 400, fout: 'veld-ongeldig' });
    }
    expect(telling(a.db)).toEqual(voor);
  });

  it('de telefoon bewaart nooit een toestand die een gewone pc-bewerking blokkeert', () => {
    const a = admin();
    const w = projectWijziging(a, {}, { titel: '  Badkamer  ', adres: '   ', notities: '', startdatum: '2026-10-10', status: 'klaar' });
    a.sync.verwerk('dev-1', 'M1', w);
    const j = job(a.db, w.uuid)!;
    // opgeschoond zoals de pc dat doet: titel getrimd, een lege notitie of leeg adres is null
    expect(j).toMatchObject({ title: 'Badkamer', address: null, notes: null });
    const na = a.s.jobs.update(j.id, { title: 'Badkamer nieuw', endDate: '2026-10-20', notes: 'pc-notitie' });
    expect(na).toMatchObject({ title: 'Badkamer nieuw', end_date: '2026-10-20', notes: 'pc-notitie', status: 'klaar' });
    expect(a.s.jobs.setStatus(j.id, 'bezig').status).toBe('bezig');
    expect(a.s.jobs.makeInvoice(j.id, [{ description: 'Badkamer', quantity: 1, unitPrice: 1000, vatCode: 'hoog' }]).lines).toHaveLength(1);
    expect(a.s.jobs.get(j.id).status).toBe('gefactureerd');
  });
});

describe('projecten-wachtrij', () => {
  it('een project voor een bekende klant wordt direct een klus en komt niet in de wachtrij', () => {
    const a = admin();
    const w = projectWijziging(a);
    expect(a.sync.verwerk('dev-1', 'M1', w)).toEqual({ status: 200, uitkomst: 'toegepast' });
    expect(job(a.db, w.uuid)).toMatchObject({ title: 'Badkamer', relation_id: a.klant.id });
    expect(wachtrij(a.db)).toEqual([]);
  });

  it('een onbekende klant geeft 200 wacht: een wachtrijrij met de volledige wijziging, geen klus en geen registerrij', () => {
    const a = admin();
    const onbekend = randomUUID();
    const w = projectWijziging(a, { tijd: VAST - MINUUT }, { klant: onbekend, notities: 'wacht even' });
    const tellerVoor = teller(a.db);
    expect(a.sync.verwerk('dev-1', 'M1', w)).toEqual({ status: 200, uitkomst: 'wacht' });
    expect(job(a.db, w.uuid)).toBeUndefined();
    expect(register(a.db, w.uuid)).toEqual([]);
    expect(teller(a.db)).toBe(tellerVoor);
    const rijen = wachtrij(a.db, w.uuid);
    expect(rijen).toHaveLength(1);
    expect(rijen[0]).toMatchObject({ apparaat_id: 'dev-1', bron: 'M1', entiteit: 'project', uuid: w.uuid, revisie: 1, tijd: VAST - MINUUT, nummer: null, wacht_op_entiteit: 'klant', wacht_op_uuid: onbekend, reden: 'klant-onbekend', ontvangen_op: VAST, verwerkt_op: null, verwerkt_uitkomst: null, verwerkt_reden: null });
    expect(JSON.parse(rijen[0]!.wijziging)).toEqual({ entiteit: 'project', uuid: w.uuid, revisie: 1, tijd: VAST - MINUUT, velden: { titel: 'Badkamer', klant: onbekend, notities: 'wacht even' } });
  });

  it('na het toepassen van die klant staat de klus er, is de rij niet verwijderd maar gemarkeerd, en staat er een registerrij toegepast', () => {
    const a = admin();
    const klant = randomUUID();
    const w = projectWijziging(a, {}, { klant, notities: 'wacht even' });
    a.sync.verwerk('dev-1', 'M1', w);
    expect(a.sync.verwerk('dev-1', 'M1', klantWijziging(klant, 'Nieuwe klant BV'))).toEqual({ status: 200, uitkomst: 'toegepast' });
    const nieuweKlant = a.db.prepare('SELECT id FROM relations WHERE uuid = ?').get(klant) as { id: number };
    expect(job(a.db, w.uuid)).toMatchObject({ title: 'Badkamer', notes: 'wacht even', relation_id: nieuweKlant.id, revisie: 1 });
    const rijen = wachtrij(a.db, w.uuid);
    expect(rijen).toHaveLength(1);
    expect(rijen[0]).toMatchObject({ verwerkt_op: VAST, verwerkt_uitkomst: 'toegepast', verwerkt_reden: null });
    expect(register(a.db, w.uuid)).toEqual([{ apparaat_id: 'dev-1', revisie: 1, uitkomst: 'toegepast', fout: null }]);
    // de bron van de velden is de apparaatcode en de tijd de bewerktijd
    expect(veldRij(a.db, job(a.db, w.uuid)!.id, 'notes')).toEqual({ tijd: VAST, bron: 'M1' });
    // en dezelfde wijziging nog eens geeft overgeslagen (register), niet nog een rij
    expect(a.sync.verwerk('dev-1', 'M1', w)).toEqual({ status: 200, uitkomst: 'overgeslagen' });
    expect(wachtrij(a.db, w.uuid)).toHaveLength(1);
  });

  it('revisie 1 (titel en onbekende klant) en revisie 2 (alleen notities) wachten allebei en na de klant heeft de klus de velden van beide', () => {
    const a = admin();
    const klant = randomUUID();
    const uuid = randomUUID();
    expect(a.sync.verwerk('dev-1', 'M1', projectWijziging(a, { uuid, revisie: 1, tijd: VAST - 2 * MINUUT }, { klant, adres: 'Dorpsstraat 5' }))).toEqual({ status: 200, uitkomst: 'wacht' });
    expect(a.sync.verwerk('dev-1', 'M1', wijziging('project', { uuid, revisie: 2, tijd: VAST - MINUUT, velden: { notities: 'later erbij' } }))).toEqual({ status: 200, uitkomst: 'wacht' });
    expect(wachtrij(a.db, uuid).map((r) => [r.revisie, r.wacht_op_entiteit, r.wacht_op_uuid, r.reden])).toEqual([[1, 'klant', klant, 'klant-onbekend'], [2, 'klant', klant, 'klant-onbekend']]);
    expect(job(a.db, uuid)).toBeUndefined();
    a.sync.verwerk('dev-1', 'M1', klantWijziging(klant));
    expect(job(a.db, uuid)).toMatchObject({ title: 'Badkamer', address: 'Dorpsstraat 5', notes: 'later erbij', revisie: 2 });
    expect(wachtrij(a.db, uuid).map((r) => r.verwerkt_uitkomst)).toEqual(['toegepast', 'toegepast']);
    expect(register(a.db, uuid).map((r) => [r.revisie, r.uitkomst])).toEqual([[1, 'toegepast'], [2, 'toegepast']]);
  });

  it('een latere revisie van een wachtend project van een ander apparaat wacht ook, met de wacht_op van de eerste rij', () => {
    const a = admin();
    const klant = randomUUID();
    const uuid = randomUUID();
    a.sync.verwerk('dev-1', 'M1', projectWijziging(a, { uuid }, { klant }));
    expect(a.sync.verwerk('dev-2', 'M2', wijziging('project', { uuid, revisie: 7, tijd: VAST + MINUUT, velden: { status: 'bezig' } }))).toEqual({ status: 200, uitkomst: 'wacht' });
    const rijen = wachtrij(a.db, uuid);
    expect(rijen.map((r) => [r.apparaat_id, r.bron, r.wacht_op_uuid])).toEqual([['dev-1', 'M1', klant], ['dev-2', 'M2', klant]]);
    a.sync.verwerk('dev-1', 'M1', klantWijziging(klant));
    expect(job(a.db, uuid)).toMatchObject({ title: 'Badkamer', status: 'bezig' });
    expect(veldRij(a.db, job(a.db, uuid)!.id, 'status')).toEqual({ tijd: VAST + MINUUT, bron: 'M2' });
  });

  it('een revisie zonder titel of klant, zonder wachtende rij en zonder klus, geeft 409 project-onbekend zonder rijen', () => {
    const a = admin();
    const voor = telling(a.db);
    const tellerVoor = teller(a.db);
    for (const velden of [{ notities: 'alleen notities' }, { titel: 'alleen titel' }, { klant: a.klantUuid }, { gearchiveerd: 1 }]) {
      const r = a.sync.verwerk('dev-1', 'M1', wijziging('project', { revisie: 2, velden }));
      expect(r, JSON.stringify(velden)).toEqual({ status: 409, fout: 'project-onbekend' });
    }
    expect(telling(a.db)).toEqual(voor);
    expect(teller(a.db)).toBe(tellerVoor);
  });

  it('dezelfde wijziging twee keer is een rij en geeft twee keer wacht', () => {
    const a = admin();
    const w = projectWijziging(a, {}, { klant: randomUUID() });
    expect(a.sync.verwerk('dev-1', 'M1', w)).toEqual({ status: 200, uitkomst: 'wacht' });
    expect(a.sync.verwerk('dev-1', 'M1', w)).toEqual({ status: 200, uitkomst: 'wacht' });
    expect(wachtrij(a.db, w.uuid)).toHaveLength(1);
    expect(register(a.db, w.uuid)).toEqual([]);
  });

  it('een alias-uuid wordt opgelost naar de doelklant, zodat het project direct een klus wordt', () => {
    const a = admin();
    const alias = randomUUID();
    a.db.prepare('INSERT INTO relation_aliases (alias_uuid, relation_id, aangemaakt_op) VALUES (?, ?, ?)').run(alias, a.klant.id, VAST);
    const w = projectWijziging(a, {}, { klant: alias });
    expect(a.sync.verwerk('dev-1', 'M1', w)).toEqual({ status: 200, uitkomst: 'toegepast' });
    expect(job(a.db, w.uuid)).toMatchObject({ relation_id: a.klant.id });
    expect(wachtrij(a.db)).toEqual([]);
  });

  it('een fout halverwege laat de rij onverwerkt en jobs ongewijzigd, en daarna lukt het wel', () => {
    const a = admin();
    const klant = randomUUID();
    const w = projectWijziging(a, {}, { klant });
    a.sync.verwerk('dev-1', 'M1', w);
    a.db.exec(`CREATE TRIGGER faal_job_log BEFORE INSERT ON job_changelog BEGIN SELECT RAISE(ABORT, 'faal halverwege'); END`);
    const voorJobs = a.db.prepare('SELECT * FROM jobs ORDER BY id').all();
    a.sync.verwerk('dev-1', 'M1', klantWijziging(klant));
    expect(a.db.prepare('SELECT * FROM jobs ORDER BY id').all()).toEqual(voorJobs);
    expect(job(a.db, w.uuid)).toBeUndefined();
    expect(wachtrij(a.db, w.uuid)[0]).toMatchObject({ verwerkt_op: null, verwerkt_uitkomst: null });
    expect(register(a.db, w.uuid)).toEqual([]);
    expect(n(a.db, 'SELECT COUNT(*) AS n FROM job_field_rev')).toBe(0);
    expect(a.meldingen.some((m) => m.includes('faal halverwege'))).toBe(true);
    // de klant zelf is wel toegepast: die transactie is los van de wachtrij
    expect(a.db.prepare('SELECT 1 FROM relations WHERE uuid = ?').get(klant)).toBeTruthy();
    a.db.exec('DROP TRIGGER faal_job_log');
    a.sync.verwerkWachtrij();
    expect(job(a.db, w.uuid)).toMatchObject({ title: 'Badkamer' });
    expect(wachtrij(a.db, w.uuid)[0]).toMatchObject({ verwerkt_uitkomst: 'toegepast' });
    expect(register(a.db, w.uuid)).toHaveLength(1);
  });

  it('de bewaarde rij levert na verwerking exact dezelfde klus als directe ontvangst', () => {
    const wacht = admin();
    const direct = admin();
    const klantWacht = randomUUID();
    const uuid = randomUUID();
    const velden = { titel: 'Dak', adres: 'Kerkstraat 1', startdatum: '2026-10-01', notities: 'lekkage', status: 'bezig' };
    wacht.sync.verwerk('dev-1', 'M1', wijziging('project', { uuid, tijd: VAST - DAG, velden: { ...velden, klant: klantWacht } }));
    wacht.sync.verwerk('dev-1', 'M1', klantWijziging(klantWacht, 'Klant X'));
    direct.sync.verwerk('dev-1', 'M1', klantWijziging(klantWacht, 'Klant X'));
    direct.sync.verwerk('dev-1', 'M1', wijziging('project', { uuid, tijd: VAST - DAG, velden: { ...velden, klant: klantWacht } }));
    const vorm = (a: Admin) => {
      const j = job(a.db, uuid)!;
      const { id, relation_id, created_at, sync_seq, ...rest } = j;
      return { rest, klant: (a.db.prepare('SELECT uuid, name FROM relations WHERE id = ?').get(relation_id) as object), velden: a.db.prepare('SELECT veld, tijd, bron FROM job_field_rev WHERE job_id = ? ORDER BY veld').all(id), log: logRegels(a.db, id) };
    };
    expect(vorm(wacht)).toEqual(vorm(direct));
    expect(register(wacht.db, uuid)).toEqual(register(direct.db, uuid));
  });

  it('hervalidatie bij verwerken: een ongeldig geworden rij wordt afgewezen gemarkeerd met een registerrij afgewezen', () => {
    const a = admin();
    const klant = randomUUID();
    const uuid = randomUUID();
    a.sync.verwerk('dev-1', 'M1', projectWijziging(a, { uuid }, { klant }));
    a.sync.verwerk('dev-1', 'M1', wijziging('project', { uuid, revisie: 2, velden: { notities: 'goed' } }));
    // de eerste rij is ongeldig geworden (bijvoorbeeld door een strengere regel in een nieuwere versie)
    const rij = wachtrij(a.db, uuid)[0]!;
    const kapot = { ...JSON.parse(rij.wijziging), velden: { titel: 'x'.repeat(500), klant } };
    a.db.prepare('UPDATE sync_wachtrij SET wijziging = ? WHERE id = ?').run(JSON.stringify(kapot), rij.id);
    a.sync.verwerk('dev-1', 'M1', klantWijziging(klant));
    const rijen = wachtrij(a.db, uuid);
    expect(rijen[0]).toMatchObject({ verwerkt_uitkomst: 'afgewezen', verwerkt_reden: 'veld-ongeldig' });
    expect(rijen[0]!.verwerkt_op).not.toBeNull();
    expect(register(a.db, uuid)[0]).toEqual({ apparaat_id: 'dev-1', revisie: 1, uitkomst: 'afgewezen', fout: 'veld-ongeldig' });
    expect(a.meldingen.some((m) => m.includes('afgewezen'))).toBe(true);
    // zonder rij met titel blijft de klus er niet; de tweede rij (alleen notities) kan hem niet maken en blijft wachten
    expect(job(a.db, uuid)).toBeUndefined();
    expect(rijen[1]).toMatchObject({ verwerkt_op: null });
  });

  it('de limiet telt alleen onverwerkte rijen per apparaat: 1000 is vol (503 wachtrij-vol zonder rij), na verwerken past een nieuwe weer', () => {
    const a = admin();
    const klant = randomUUID();
    const eerste = projectWijziging(a, {}, { klant });
    expect(a.sync.verwerk('dev-1', 'M1', eerste)).toEqual({ status: 200, uitkomst: 'wacht' });
    for (let i = 1; i < 1000; i++) expect(a.sync.verwerk('dev-1', 'M1', projectWijziging(a, {}, { klant: randomUUID() })).uitkomst).toBe('wacht');
    expect(n(a.db, 'SELECT COUNT(*) AS n FROM sync_wachtrij WHERE verwerkt_op IS NULL')).toBe(1000);
    const nummer1001 = projectWijziging(a, {}, { klant: randomUUID() });
    const voor = telling(a.db);
    expect(a.sync.verwerk('dev-1', 'M1', nummer1001)).toEqual({ status: 503, fout: 'wachtrij-vol' });
    expect(telling(a.db)).toEqual(voor);
    expect(register(a.db, nummer1001.uuid)).toEqual([]);
    // een ander apparaat heeft zijn eigen ruimte, en een herhaling van een bestaande rij blijft gewoon wacht
    expect(a.sync.verwerk('dev-2', 'M2', projectWijziging(a, {}, { klant: randomUUID() })).uitkomst).toBe('wacht');
    expect(a.sync.verwerk('dev-1', 'M1', eerste)).toEqual({ status: 200, uitkomst: 'wacht' });
    // na het verwerken van een rij is er weer ruimte; de rij blijft bestaan
    a.sync.verwerk('dev-1', 'M1', klantWijziging(klant));
    expect(n(a.db, 'SELECT COUNT(*) AS n FROM sync_wachtrij WHERE verwerkt_op IS NULL AND apparaat_id = ?', 'dev-1')).toBe(999);
    expect(n(a.db, 'SELECT COUNT(*) AS n FROM sync_wachtrij WHERE apparaat_id = ?', 'dev-1')).toBe(1000);
    expect(a.sync.verwerk('dev-1', 'M1', nummer1001)).toEqual({ status: 200, uitkomst: 'wacht' });
    expect(n(a.db, 'SELECT COUNT(*) AS n FROM sync_wachtrij WHERE verwerkt_op IS NULL AND apparaat_id = ?', 'dev-1')).toBe(1000);
  });

  it('een volle wachtrij wijst een project voor een bekende klant of een wijziging van een bestaand project nooit af', () => {
    const a = admin();
    for (let i = 0; i < 1000; i++) a.sync.verwerk('dev-1', 'M1', projectWijziging(a, {}, { klant: randomUUID() }));
    const w = projectWijziging(a);
    expect(a.sync.verwerk('dev-1', 'M1', w)).toEqual({ status: 200, uitkomst: 'toegepast' });
    expect(a.sync.verwerk('dev-1', 'M1', wijziging('project', { uuid: w.uuid, revisie: 2, velden: { notities: 'ok' } }))).toEqual({ status: 200, uitkomst: 'toegepast' });
    expect(job(a.db, w.uuid)).toMatchObject({ notes: 'ok' });
  });

  it('een cascade: projecten die op een klant wachten worden allemaal verwerkt als die klant er is, en een BEFORE DELETE-bewaking ging nooit af', () => {
    const a = admin();
    const klant = randomUUID();
    const uuids = [randomUUID(), randomUUID(), randomUUID()];
    for (const [i, uuid] of uuids.entries()) a.sync.verwerk('dev-1', 'M1', projectWijziging(a, { uuid }, { titel: `Klus ${i}`, klant }));
    expect(wachtrij(a.db).filter((r) => r.verwerkt_op === null)).toHaveLength(3);
    a.sync.verwerk('dev-1', 'M1', klantWijziging(klant));
    expect(uuids.map((u) => job(a.db, u)?.title)).toEqual(['Klus 0', 'Klus 1', 'Klus 2']);
    expect(wachtrij(a.db).every((r) => r.verwerkt_uitkomst === 'toegepast')).toBe(true);
    // geen enkele DELETE: de bewaking zou de test hebben laten falen; de rijen staan er nog
    expect(n(a.db, 'SELECT COUNT(*) AS n FROM sync_wachtrij')).toBe(3);
    expect(a.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'geen_delete_%'`).all()).toHaveLength(8);
  });

  it('een project met een klus die al bestaat en een nog onbekende klant in een latere revisie wacht ook', () => {
    const a = admin();
    const w = projectWijziging(a);
    a.sync.verwerk('dev-1', 'M1', w);
    const nieuweKlant = randomUUID();
    expect(a.sync.verwerk('dev-1', 'M1', wijziging('project', { uuid: w.uuid, revisie: 2, velden: { klant: nieuweKlant, notities: 'x' } }))).toEqual({ status: 200, uitkomst: 'wacht' });
    expect(job(a.db, w.uuid)).toMatchObject({ relation_id: a.klant.id, notes: null });
    a.sync.verwerk('dev-1', 'M1', klantWijziging(nieuweKlant));
    // de klus heeft nog niets dat de klant vastzet, dus de klantwisseling mag
    expect(job(a.db, w.uuid)).toMatchObject({ notes: 'x', revisie: 2 });
    expect(a.db.prepare('SELECT uuid FROM relations WHERE id = ?').get(job(a.db, w.uuid)!.relation_id)).toEqual({ uuid: nieuweKlant });
  });
});

describe('projecten-laatste wijziging', () => {
  it('verschillende velden met verschillende bewerktijd worden samengevoegd', () => {
    const a = admin();
    const uuid = randomUUID();
    a.sync.verwerk('dev-1', 'M1', projectWijziging(a, { uuid, tijd: VAST - 10 * MINUUT }, { adres: 'Oud adres', notities: 'oude notitie' }));
    // een andere telefoon wijzigt later alleen de notities, de eerste daarna alleen het adres, met een eerdere tijd dan de notities
    a.sync.verwerk('dev-2', 'M2', wijziging('project', { uuid, revisie: 1, tijd: VAST - 5 * MINUUT, velden: { notities: 'nieuwe notitie' } }));
    a.sync.verwerk('dev-1', 'M1', wijziging('project', { uuid, revisie: 2, tijd: VAST - 7 * MINUUT, velden: { adres: 'Nieuw adres', notities: 'tussenin' } }));
    const j = job(a.db, uuid)!;
    expect(j).toMatchObject({ address: 'Nieuw adres', notes: 'nieuwe notitie', title: 'Badkamer' });
    expect(veldRij(a.db, j.id, 'address')).toEqual({ tijd: VAST - 7 * MINUUT, bron: 'M1' });
    expect(veldRij(a.db, j.id, 'notes')).toEqual({ tijd: VAST - 5 * MINUUT, bron: 'M2' });
    expect(j.gewijzigd_op).toBe(VAST - 5 * MINUUT);
  });

  it('zelfde veld: de nieuwste tijd wint, in welke volgorde de wijzigingen ook aankomen', () => {
    const eindtoestand = (volgorde: number[]) => {
      const a = admin();
      const uuid = '11111111-1111-4111-8111-111111111111';
      a.sync.verwerk('dev-1', 'M1', projectWijziging(a, { uuid, tijd: VAST - 30 * MINUUT }));
      const wijzigingen = [
        wijziging('project', { uuid, revisie: 2, tijd: VAST - 20 * MINUUT, velden: { notities: 'A', status: 'bezig' } }),
        wijziging('project', { uuid, revisie: 3, tijd: VAST - 10 * MINUUT, velden: { notities: 'B', adres: 'X' } }),
        wijziging('project', { uuid, revisie: 4, tijd: VAST - 15 * MINUUT, velden: { notities: 'C', status: 'klaar' } }),
      ];
      for (const i of volgorde) a.sync.verwerk('dev-1', 'M1', wijzigingen[i]!);
      const j = job(a.db, uuid)!;
      return { notes: j.notes, status: j.status, address: j.address, notes_rev: veldRij(a.db, j.id, 'notes'), status_rev: veldRij(a.db, j.id, 'status') };
    };
    const verwacht = { notes: 'B', status: 'klaar', address: 'X', notes_rev: { tijd: VAST - 10 * MINUUT, bron: 'M1' }, status_rev: { tijd: VAST - 15 * MINUUT, bron: 'M1' } };
    for (const volgorde of [[0, 1, 2], [2, 1, 0], [1, 2, 0], [2, 0, 1]]) expect(eindtoestand(volgorde), volgorde.join()).toEqual(verwacht);
  });

  it('bij gelijke tijd wint de lexicografisch grootste bron: M2 wint van M1 en pc wint van M1', () => {
    const a = admin();
    const uuid = randomUUID();
    a.sync.verwerk('dev-1', 'M1', projectWijziging(a, { uuid, tijd: VAST - 10 * MINUUT }, { notities: 'van M1' }));
    // M2 op precies dezelfde tijd wint, ook als M1 later nog eens komt
    a.sync.verwerk('dev-2', 'M2', wijziging('project', { uuid, revisie: 1, tijd: VAST - 10 * MINUUT, velden: { notities: 'van M2' } }));
    a.sync.verwerk('dev-1', 'M1', wijziging('project', { uuid, revisie: 2, tijd: VAST - 10 * MINUUT, velden: { notities: 'weer M1' } }));
    const j = job(a.db, uuid)!;
    expect(j.notes).toBe('van M2');
    expect(veldRij(a.db, j.id, 'notes')).toEqual({ tijd: VAST - 10 * MINUUT, bron: 'M2' });
    // een pc-bewerking op exact dezelfde tijd (bron pc) wint van M1
    a.db.prepare(`INSERT INTO job_field_rev (job_id, veld, tijd, bron) VALUES (?, 'address', ?, 'pc') ON CONFLICT(job_id, veld) DO UPDATE SET tijd = excluded.tijd, bron = excluded.bron`).run(j.id, VAST);
    a.db.prepare(`UPDATE jobs SET address = 'pc-adres' WHERE id = ?`).run(j.id);
    expect(a.sync.verwerk('dev-1', 'M1', wijziging('project', { uuid, revisie: 3, tijd: VAST, velden: { adres: 'telefoon-adres' } }))).toEqual({ status: 200, uitkomst: 'overgeslagen' });
    expect(job(a.db, uuid)!.address).toBe('pc-adres');
  });

  it('een veld zonder rij in job_field_rev heeft als ondergrens created_at (UTC) met bron pc, nooit gewijzigd_op', () => {
    const a = admin();
    // een klus van vóór de sync: geen veldrijen, aangemaakt op een vaste UTC-tijd, met een veel latere gewijzigd_op
    const aangemaakt = '2026-09-01 10:00:00';
    const id = Number(a.db.prepare(`INSERT INTO jobs (relation_id, title, notes, created_at, uuid, revisie, gewijzigd_op, sync_seq) VALUES (?, 'Oud', 'oude notitie', ?, ?, 1, ?, ?)`).run(a.klant.id, aangemaakt, randomUUID(), Date.UTC(2030, 0, 1), teller(a.db) + 1).lastInsertRowid);
    a.db.prepare(`UPDATE sync_teller SET waarde = waarde + 1 WHERE naam = 'wijziging'`).run();
    const uuid = (a.db.prepare('SELECT uuid FROM jobs WHERE id = ?').get(id) as { uuid: string }).uuid;
    const grens = veldOndergrens(aangemaakt);
    expect(grens).toBe(Date.UTC(2026, 8, 1, 10, 0, 0));
    // een telefoonwijziging net vóór de ondergrens verliest (ook al is gewijzigd_op veel later: die telt niet)
    expect(a.sync.verwerk('dev-1', 'M1', wijziging('project', { uuid, revisie: 1, tijd: grens - 1, velden: { notities: 'te oud', adres: 'te oud' } }))).toEqual({ status: 200, uitkomst: 'overgeslagen' });
    // het adres had geen waarde en ook geen rij: dezelfde ondergrens, dus te oud voor het adres
    const j = job(a.db, uuid)!;
    expect(j.notes).toBe('oude notitie');
    expect(j.address).toBeNull();
    expect(a.sync.verwerk('dev-1', 'M1', wijziging('project', { uuid, revisie: 2, tijd: grens - 1, velden: { notities: 'nog steeds te oud' } }))).toEqual({ status: 200, uitkomst: 'overgeslagen' });
    // precies op de ondergrens wint M1 niet van pc, een milliseconde later wel
    expect(a.sync.verwerk('dev-1', 'M1', wijziging('project', { uuid, revisie: 3, tijd: grens, velden: { notities: 'gelijk' } }))).toEqual({ status: 200, uitkomst: 'overgeslagen' });
    expect(a.sync.verwerk('dev-1', 'M1', wijziging('project', { uuid, revisie: 4, tijd: grens + 1, velden: { notities: 'later' } }))).toEqual({ status: 200, uitkomst: 'toegepast' });
    expect(job(a.db, uuid)!.notes).toBe('later');
    expect(veldRij(a.db, id, 'notes')).toEqual({ tijd: grens + 1, bron: 'M1' });
    // de loggregel heeft de oude waarde, en gewijzigd_op bleef de hoogste (2030)
    expect(logRegels(a.db, id).at(-1)).toMatchObject({ veld: 'notes', oud: 'oude notitie', nieuw: 'later', bron: 'M1' });
    expect(job(a.db, uuid)!.gewijzigd_op).toBe(Date.UTC(2030, 0, 1));
  });

  it('een telefoonwijziging met een bewerktijd van drie dagen geleden zet sync_seq hoger dan het oude nummer', () => {
    const a = admin();
    const uuid = randomUUID();
    a.sync.verwerk('dev-1', 'M1', projectWijziging(a, { uuid, tijd: VAST - 10 * DAG }));
    const voor = job(a.db, uuid)!;
    const andere = admin();
    expect(a.sync.verwerk('dev-1', 'M1', wijziging('project', { uuid, revisie: 2, tijd: VAST - 3 * DAG, velden: { notities: 'oud nieuws' } }))).toEqual({ status: 200, uitkomst: 'toegepast' });
    const na = job(a.db, uuid)!;
    expect(na.sync_seq).toBe(voor.sync_seq + 1);
    expect(na.sync_seq).toBeGreaterThan(voor.sync_seq);
    expect(na.revisie).toBe(voor.revisie + 1);
    // de bewerktijd is niet het wijzigingsnummer: gewijzigd_op is de hoogste toegepaste veldtijd
    expect(na.gewijzigd_op).toBe(Math.max(voor.gewijzigd_op, VAST - 3 * DAG));
    expect(teller(a.db)).toBe(na.sync_seq);
    void andere;
  });

  it('een herhaling van dezelfde sleutel is overgeslagen en verhoogt sync_seq niet', () => {
    const a = admin();
    const w = projectWijziging(a);
    a.sync.verwerk('dev-1', 'M1', w);
    const voor = job(a.db, w.uuid)!;
    const tellerVoor = teller(a.db);
    const aantal = telling(a.db);
    expect(a.sync.verwerk('dev-1', 'M1', w)).toEqual({ status: 200, uitkomst: 'overgeslagen' });
    // zelfde sleutel met andere inhoud: ook overgeslagen, de inhoud van de eerste keer geldt
    expect(a.sync.verwerk('dev-1', 'M1', { ...w, velden: Object.assign(Object.create(null), { titel: 'Heel anders', klant: a.klantUuid }) })).toEqual({ status: 200, uitkomst: 'overgeslagen' });
    expect(job(a.db, w.uuid)).toEqual(voor);
    expect(teller(a.db)).toBe(tellerVoor);
    expect(telling(a.db)).toEqual(aantal);
    // dezelfde uuid en revisie van een ander apparaat is wel een nieuwe sleutel: op gelijke tijd wint de grootste bron (M2)
    expect(a.sync.verwerk('dev-2', 'M2', { ...w, velden: Object.assign(Object.create(null), { titel: 'Van M2', klant: a.klantUuid }) })).toEqual({ status: 200, uitkomst: 'toegepast' });
    expect(job(a.db, w.uuid)!.title).toBe('Van M2');
  });

  it('een wijziging met alleen verouderde velden is overgeslagen zonder logregel en zonder nieuw wijzigingsnummer', () => {
    const a = admin();
    const uuid = randomUUID();
    a.sync.verwerk('dev-1', 'M1', projectWijziging(a, { uuid, tijd: VAST }, { notities: 'nieuw' }));
    const voor = job(a.db, uuid)!;
    const regels = logRegels(a.db, voor.id).length;
    expect(a.sync.verwerk('dev-1', 'M1', wijziging('project', { uuid, revisie: 2, tijd: VAST - MINUUT, velden: { notities: 'verouderd' } }))).toEqual({ status: 200, uitkomst: 'overgeslagen' });
    expect(job(a.db, uuid)).toEqual(voor);
    expect(logRegels(a.db, voor.id)).toHaveLength(regels);
    expect(register(a.db, uuid).map((r) => r.uitkomst)).toEqual(['toegepast', 'overgeslagen']);
  });

  it('job_field_rev houdt tijd en bron per veld bij en job_changelog heeft een regel per toegepast veld', () => {
    const a = admin();
    const uuid = randomUUID();
    a.sync.verwerk('dev-1', 'M1', projectWijziging(a, { uuid, tijd: VAST - 5 * MINUUT }, { notities: 'een' }));
    a.sync.verwerk('dev-2', 'M2', wijziging('project', { uuid, revisie: 1, tijd: VAST, velden: { notities: 'twee', status: 'klaar', einddatum: '2026-10-09' } }));
    const j = job(a.db, uuid)!;
    expect(veldRij(a.db, j.id, 'notes')).toEqual({ tijd: VAST, bron: 'M2' });
    expect(veldRij(a.db, j.id, 'end_date')).toEqual({ tijd: VAST, bron: 'M2' });
    expect(veldRij(a.db, j.id, 'title')).toEqual({ tijd: VAST - 5 * MINUUT, bron: 'M1' });
    expect(logRegels(a.db, j.id).filter((l) => l.revisie === 2)).toEqual([
      { revisie: 2, veld: 'end_date', oud: null, nieuw: '2026-10-09', tijd: VAST, bron: 'M2' },
      { revisie: 2, veld: 'notes', oud: 'een', nieuw: 'twee', tijd: VAST, bron: 'M2' },
      { revisie: 2, veld: 'status', oud: 'gepland', nieuw: 'klaar', tijd: VAST, bron: 'M2' },
    ]);
  });
});

describe('projecten-status', () => {
  /** Een project dat de telefoon heeft aangemaakt, met een tijd ver in het verleden zodat latere wijzigingen winnen. */
  const nieuwProject = (a: Admin, velden: Record<string, unknown> = {}) => {
    const w = projectWijziging(a, { tijd: VAST - DAG }, velden);
    a.sync.verwerk('dev-1', 'M1', w);
    return w.uuid;
  };

  it('een telefoonstatus op een gefactureerde klus wordt overgeslagen ongeacht de tijd, met een regel in job_changelog, en de overige velden worden wel verwerkt', () => {
    const a = admin();
    const uuid = nieuwProject(a);
    const id = job(a.db, uuid)!.id;
    a.s.jobs.makeInvoice(id, [{ description: 'Werk', quantity: 1, unitPrice: 1000, vatCode: 'hoog' }]);
    expect(job(a.db, uuid)!.status).toBe('gefactureerd');
    const voor = job(a.db, uuid)!;
    const r = a.sync.verwerk('dev-1', 'M1', wijziging('project', { uuid, revisie: 2, tijd: VAST + 4 * MINUUT, velden: { status: 'bezig', notities: 'wel verwerkt' } }));
    expect(r).toEqual({ status: 200, uitkomst: 'toegepast' });
    const na = job(a.db, uuid)!;
    expect(na).toMatchObject({ status: 'gefactureerd', notes: 'wel verwerkt', revisie: voor.revisie + 1 });
    expect(veldRij(a.db, id, 'status')!.bron).toBe('pc');
    expect(logRegels(a.db, id).filter((l) => l.revisie === voor.revisie + 1).map((l) => [l.veld, l.oud, l.nieuw, l.bron]).sort()).toEqual([['notes', null, 'wel verwerkt', 'M1'], ['status', 'gefactureerd', 'bezig', 'M1']]);
  });

  it('een telefoonstatus op een klus met een gekoppelde factuur (invoices.job_id) wordt overgeslagen, ook als de status niet gefactureerd is', () => {
    const a = admin();
    const uuid = nieuwProject(a, { status: 'klaar' });
    const id = job(a.db, uuid)!.id;
    const inv = a.s.invoices.createDraft({ relationId: a.klant.id, lines: [{ description: 'x', quantity: 1, unitPrice: 100, vatCode: 'hoog' }] });
    a.db.prepare('UPDATE invoices SET job_id = ? WHERE id = ?').run(id, inv.id);
    const voor = job(a.db, uuid)!;
    expect(voor.status).toBe('klaar');
    const r = a.sync.verwerk('dev-1', 'M1', wijziging('project', { uuid, revisie: 2, tijd: VAST, velden: { status: 'geannuleerd' } }));
    expect(r).toEqual({ status: 200, uitkomst: 'overgeslagen' });
    expect(job(a.db, uuid)).toEqual(voor);
    expect(logRegels(a.db, id).at(-1)).toMatchObject({ veld: 'status', oud: 'klaar', nieuw: 'geannuleerd', bron: 'M1', revisie: voor.revisie });
    expect(register(a.db, uuid).map((x) => x.uitkomst)).toEqual(['toegepast', 'overgeslagen']);
  });

  it('de status gefactureerd van de telefoon is een veldfout (400)', () => {
    const a = admin();
    const uuid = nieuwProject(a);
    const voor = telling(a.db);
    const r = a.sync.verwerk('dev-1', 'M1', wijziging('project', { uuid, revisie: 2, tijd: VAST, velden: { status: 'gefactureerd' } }));
    expect(r).toMatchObject({ status: 400, fout: 'veld-ongeldig', veld: 'status' });
    expect(telling(a.db)).toEqual(voor);
    expect(job(a.db, uuid)!.status).toBe('gepland');
  });

  it('een status van de telefoon op een gewone klus wordt toegepast (gepland, bezig, klaar, geannuleerd)', () => {
    const a = admin();
    const uuid = nieuwProject(a);
    let revisie = 1;
    for (const status of ['bezig', 'klaar', 'geannuleerd', 'gepland']) {
      revisie += 1;
      expect(a.sync.verwerk('dev-1', 'M1', wijziging('project', { uuid, revisie, tijd: VAST + revisie, velden: { status } }))).toEqual({ status: 200, uitkomst: 'toegepast' });
      expect(job(a.db, uuid)!.status).toBe(status);
    }
  });

  /** De vier soorten dingen die aan een klus kunnen hangen. */
  const KOPPELINGEN: [string, (a: Admin, jobId: number) => void][] = [
    ['een factuur', (a, id) => { const i = a.s.invoices.createDraft({ relationId: a.klant.id, lines: [{ description: 'x', quantity: 1, unitPrice: 100, vatCode: 'hoog' }] }); a.db.prepare('UPDATE invoices SET job_id = ? WHERE id = ?').run(id, i.id); }],
    ['een inkoopfactuur', (a, id) => { const p = a.s.purchases.create({ invoiceDate: '2026-09-12', description: 'Tegellijm', lines: [{ account: ACCOUNTS.inkoopMaterialen, netAmount: 1000, vatCode: 'hoog' }] }); a.db.prepare('UPDATE purchase_invoices SET job_id = ? WHERE id = ?').run(id, p.id); }],
    ['een rit', (a, id) => { a.db.prepare(`INSERT INTO trips (trip_date, km, description, job_id, rate) VALUES ('2026-09-12', 10, 'naar de klus', ?, 23)`).run(id); }],
    ['een werkbonregel', (a, id) => { a.s.jobs.addWorkItem(id, { date: '2026-09-12', description: 'Stucwerk', quantity: 1, unitPrice: 4800, vatCode: 'hoog' }); }],
  ];
  it.each(KOPPELINGEN)('de klant wijzigen op een klus met %s geeft 200 afgewezen klus-gekoppeld, een registerrij afgewezen en niets geschreven in jobs', (_naam, koppel) => {
    const a = admin();
    const uuid = nieuwProject(a, { notities: 'oud' });
    const id = job(a.db, uuid)!.id;
    koppel(a, id);
    const andereKlant = a.s.relations.create({ name: 'Andere klant' });
    const andereUuid = (a.db.prepare('SELECT uuid FROM relations WHERE id = ?').get(andereKlant.id) as { uuid: string }).uuid;
    const voor = job(a.db, uuid)!;
    const tellerVoor = teller(a.db);
    const logVoor = logRegels(a.db, id).length;
    const w = wijziging('project', { uuid, revisie: 2, tijd: VAST, velden: { klant: andereUuid, notities: 'nieuw' } });
    const r = a.sync.verwerk('dev-1', 'M1', w);
    expect(r).toMatchObject({ status: 200, uitkomst: 'afgewezen', fout: 'klus-gekoppeld' });
    expect(r.melding).toMatch(/klant/);
    expect(job(a.db, uuid)).toEqual(voor);
    expect(teller(a.db)).toBe(tellerVoor);
    expect(logRegels(a.db, id)).toHaveLength(logVoor);
    expect(register(a.db, uuid).at(-1)).toEqual({ apparaat_id: 'dev-1', revisie: 2, uitkomst: 'afgewezen', fout: 'klus-gekoppeld' });
    // een herhaling levert dezelfde afwijzing
    expect(a.sync.verwerk('dev-1', 'M1', w)).toEqual(r);
    // dezelfde klant als nu mag wel (geen echte wijziging van de klant), net als de andere velden
    expect(a.sync.verwerk('dev-1', 'M1', wijziging('project', { uuid, revisie: 3, tijd: VAST, velden: { klant: a.klantUuid, notities: 'wel' } }))).toEqual({ status: 200, uitkomst: 'toegepast' });
    expect(job(a.db, uuid)).toMatchObject({ notes: 'wel', relation_id: a.klant.id });
  });

  it('zonder koppelingen mag de klant van een bestaande klus wisselen', () => {
    const a = admin();
    const uuid = nieuwProject(a);
    const andere = a.s.relations.create({ name: 'Andere klant' });
    const andereUuid = (a.db.prepare('SELECT uuid FROM relations WHERE id = ?').get(andere.id) as { uuid: string }).uuid;
    expect(a.sync.verwerk('dev-1', 'M1', wijziging('project', { uuid, revisie: 2, tijd: VAST, velden: { klant: andereUuid } }))).toEqual({ status: 200, uitkomst: 'toegepast' });
    expect(job(a.db, uuid)).toMatchObject({ relation_id: andere.id, revisie: 2 });
    expect(logRegels(a.db, job(a.db, uuid)!.id).at(-1)).toMatchObject({ veld: 'relation_id', oud: String(a.klant.id), nieuw: String(andere.id), bron: 'M1' });
  });

  it('na InvoiceService.deleteDraft gaat de klus van gefactureerd terug naar klaar met nieuwe revisie en nieuw wijzigingsnummer', () => {
    const a = admin();
    const uuid = nieuwProject(a);
    const id = job(a.db, uuid)!.id;
    const inv = a.s.jobs.makeInvoice(id, [{ description: 'Werk', quantity: 1, unitPrice: 1000, vatCode: 'hoog' }]);
    const gefactureerd = job(a.db, uuid)!;
    expect(gefactureerd.status).toBe('gefactureerd');
    a.s.invoices.deleteDraft(inv.id);
    const na = job(a.db, uuid)!;
    expect(na).toMatchObject({ status: 'klaar', revisie: gefactureerd.revisie + 1 });
    expect(na.sync_seq).toBeGreaterThan(gefactureerd.sync_seq);
    // en de telefoon mag de status daarna weer zetten
    expect(a.sync.verwerk('dev-1', 'M1', wijziging('project', { uuid, revisie: 2, tijd: Date.now() + MINUUT, velden: { status: 'bezig' } }))).toEqual({ status: 200, uitkomst: 'toegepast' });
    expect(job(a.db, uuid)!.status).toBe('bezig');
  });
});

describe('projecten-archief', () => {
  it('gearchiveerd=1 vanuit de telefoon zet jobs.archived en een hoger wijzigingsnummer, en het aantal rijen in jobs blijft gelijk', () => {
    const a = admin();
    const w = projectWijziging(a, { tijd: VAST - MINUUT });
    a.sync.verwerk('dev-1', 'M1', w);
    const voor = job(a.db, w.uuid)!;
    const rijen = n(a.db, 'SELECT COUNT(*) AS n FROM jobs');
    expect(a.sync.verwerk('dev-1', 'M1', wijziging('project', { uuid: w.uuid, revisie: 2, tijd: VAST, velden: { gearchiveerd: 1 } }))).toEqual({ status: 200, uitkomst: 'toegepast' });
    const na = job(a.db, w.uuid)!;
    expect(na).toMatchObject({ archived: 1, title: 'Badkamer', revisie: voor.revisie + 1 });
    expect(na.sync_seq).toBe(voor.sync_seq + 1);
    expect(n(a.db, 'SELECT COUNT(*) AS n FROM jobs')).toBe(rijen);
    expect(veldRij(a.db, na.id, 'gearchiveerd')).toEqual({ tijd: VAST, bron: 'M1' });
    expect(logRegels(a.db, na.id).at(-1)).toEqual({ revisie: 2, veld: 'gearchiveerd', oud: '0', nieuw: '1', tijd: VAST, bron: 'M1' });
    // gearchiveerd: uit de lijsten, maar get en results zien hem nog
    expect(a.s.jobs.list().map((j) => j.id)).not.toContain(na.id);
    expect(a.s.jobs.get(na.id)).toMatchObject({ archived: 1 });
    expect(a.s.jobs.results().map((r) => r.jobId)).toContain(na.id);
  });

  it('gearchiveerd=0 haalt een klus terug, maar een oudere wijziging doet dat niet', () => {
    const a = admin();
    const w = projectWijziging(a, { tijd: VAST - 10 * MINUUT }, { gearchiveerd: 1 });
    a.sync.verwerk('dev-1', 'M1', w);
    expect(job(a.db, w.uuid)!.archived).toBe(1);
    expect(a.s.jobs.list().map((j) => j.title)).not.toContain('Badkamer');
    // een oudere terugzetting verliest
    expect(a.sync.verwerk('dev-1', 'M1', wijziging('project', { uuid: w.uuid, revisie: 2, tijd: VAST - 20 * MINUUT, velden: { gearchiveerd: 0 } }))).toEqual({ status: 200, uitkomst: 'overgeslagen' });
    expect(job(a.db, w.uuid)!.archived).toBe(1);
    expect(a.sync.verwerk('dev-1', 'M1', wijziging('project', { uuid: w.uuid, revisie: 3, tijd: VAST, velden: { gearchiveerd: 0 } }))).toEqual({ status: 200, uitkomst: 'toegepast' });
    expect(job(a.db, w.uuid)!.archived).toBe(0);
    expect(a.s.jobs.list().map((j) => j.title)).toContain('Badkamer');
  });

  it('een gearchiveerd project blijft bijwerkbaar door de telefoon en een gewone pc-bewerking', () => {
    const a = admin();
    const w = projectWijziging(a, { tijd: VAST - 10 * MINUUT }, { gearchiveerd: 1 });
    a.sync.verwerk('dev-1', 'M1', w);
    expect(a.sync.verwerk('dev-1', 'M1', wijziging('project', { uuid: w.uuid, revisie: 2, tijd: VAST, velden: { notities: 'nog een notitie' } }))).toEqual({ status: 200, uitkomst: 'toegepast' });
    const id = job(a.db, w.uuid)!.id;
    expect(a.s.jobs.update(id, { notes: 'pc-notitie' })).toMatchObject({ notes: 'pc-notitie', archived: 1 });
  });

  it('een BEFORE DELETE-trigger op jobs gaat nooit af, ook niet bij alle JobService-, InvoiceService- en projectpaden', () => {
    const a = admin();
    a.db.exec(`CREATE TRIGGER geen_delete_klussen_extra BEFORE DELETE ON jobs BEGIN SELECT RAISE(ABORT, 'jobs verwijderd'); END`);
    const klus = a.s.jobs.create({ relationId: a.klant.id, title: 'Pad 1' });
    a.s.jobs.update(klus.id, { notes: 'x' });
    a.s.jobs.setStatus(klus.id, 'klaar');
    const inv = a.s.jobs.makeInvoice(klus.id, [{ description: 'Werk', quantity: 1, unitPrice: 1000, vatCode: 'hoog' }]);
    a.s.invoices.deleteDraft(inv.id);
    a.s.jobs.addWorkItem(klus.id, { date: '2026-09-12', description: 'Stucwerk', quantity: 1, unitPrice: 4800, vatCode: 'hoog' });
    a.s.jobs.makeInvoice(klus.id);
    const q = a.s.quotes.create({ relationId: a.klant.id, reference: 'Offerte', lines: [{ description: 'x', quantity: 1, unitPrice: 1000, vatCode: 'hoog' }] });
    a.s.jobs.acceptQuote(q.id);
    const w = projectWijziging(a);
    a.sync.verwerk('dev-1', 'M1', w);
    a.sync.verwerk('dev-1', 'M1', wijziging('project', { uuid: w.uuid, revisie: 2, velden: { gearchiveerd: 1 } }));
    const wacht = projectWijziging(a, {}, { klant: randomUUID() });
    a.sync.verwerk('dev-1', 'M1', wacht);
    a.sync.verwerk('dev-1', 'M1', klantWijziging((JSON.parse(wachtrij(a.db, wacht.uuid)[0]!.wijziging) as { velden: { klant: string } }).velden.klant));
    a.s.search.rebuild();
    expect(n(a.db, 'SELECT COUNT(*) AS n FROM jobs')).toBe(4);
    expect(wachtrij(a.db).every((r) => r.verwerkt_uitkomst === 'toegepast')).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------
// Via de echte receiver: versleutelde berichten over het loopback-netwerk
// ---------------------------------------------------------------------------------------------------

const LOOPBACK = [{ address: '127.0.0.1', netmask: '255.0.0.0' }];
const open: Bonnenscanner[] = [];
const dirs: string[] = [];
beforeEach(() => {
  PHONE_SCANNER.available = true;
});
afterEach(async () => {
  PHONE_SCANNER.available = false;
  for (const s of open.splice(0)) await s.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function startReceiver() {
  const t = setup();
  const spoolDir = mkdtempSync(join(tmpdir(), 'bvn-sync-projecten-'));
  dirs.push(spoolDir);
  const clock = { now: Date.now() };
  const scanner = new Bonnenscanner({ db: t.db, secrets: t.secrets, intake: t.s.intake, settings: t.s.settings, spoolDir, interfaces: () => LOOPBACK, now: () => clock.now });
  open.push(scanner);
  const klantUuid = (t.db.prepare('SELECT uuid FROM relations WHERE id = ?').get(t.klant.id) as { uuid: string }).uuid;
  return { ...t, scanner, clock, klantUuid };
}
type Ontvanger = ReturnType<typeof startReceiver>;

interface Reply {
  status: number;
  sealed: boolean;
  json: Record<string, unknown> | null;
}

/** De telefoon: stuurt versleutelde berichten van protocolversie 2. */
function telefoon(pairing: PairingPayload, clock: { now: number }) {
  const key = Buffer.from(pairing.sleutel, 'base64url');
  const deviceId = Buffer.from(pairing.apparaat, 'base64url');
  const url = `http://${pairing.adressen[0]}:${pairing.poort}${ENDPOINT_PATH}`;
  const verstuurFrame = async (frame: Buffer): Promise<Reply> => {
    const nonce = randomBytes(12);
    const body = sealRequest(deviceId, key, frame, nonce, 2);
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': CONTENT_TYPE }, body: new Uint8Array(body) });
    const raw = Buffer.from(await res.arrayBuffer());
    if ((res.headers.get('content-type') ?? '') === CONTENT_TYPE) {
      const json2 = openResponse(raw, key, nonce);
      return { status: res.status, sealed: json2 !== null, json: json2 };
    }
    return { status: res.status, sealed: false, json: raw.length ? (JSON.parse(raw.toString('utf8')) as Record<string, unknown>) : null };
  };
  const verstuur = (json: Record<string, unknown>) => verstuurFrame(encodeFrame(json, []));
  /** een bericht als ruwe JSON-tekst, zoals een telefoon hem schrijft (met \u-escapes is hij langer dan de tekst die erin zit) */
  const verstuurRuw = (tekst: string) => {
    const body = Buffer.from(tekst, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length, 0);
    return verstuurFrame(Buffer.concat([len, body]));
  };
  const hallo = () => verstuur({ soort: 'hallo', tijd: clock.now, naam: 'Pixel van Piet', app: '1.0.0' });
  const project = (velden: Record<string, unknown>, over: Record<string, unknown> = {}) =>
    verstuur({ soort: 'wijziging', tijd: clock.now, wijziging: { entiteit: 'project', uuid: randomUUID(), revisie: 1, tijd: clock.now, velden, ...over } });
  return { verstuur, verstuurRuw, hallo, project };
}

async function koppel(t: Ontvanger) {
  const started = await t.scanner.pair();
  const p = telefoon(decodePairing(started.payload), t.clock);
  expect((await p.hallo()).status).toBe(200);
  return p;
}

describe('projecten-receiver', () => {
  it('een gekoppeld apparaat stuurt een project met een bekende klant: 200 toegepast en de klus bestaat', async () => {
    const t = startReceiver();
    const p = await koppel(t);
    const uuid = randomUUID();
    const r = await p.project({ titel: 'Badkamer', klant: t.klantUuid, adres: 'Dorpsstraat 5' }, { uuid });
    expect(r).toMatchObject({ status: 200, sealed: true, json: { ok: true, soort: 'wijziging', entiteit: 'project', uuid, revisie: 1, uitkomst: 'toegepast' } });
    expect(t.db.prepare('SELECT title, address, relation_id, status, archived, revisie FROM jobs WHERE uuid = ?').get(uuid)).toEqual({ title: 'Badkamer', address: 'Dorpsstraat 5', relation_id: t.klant.id, status: 'gepland', archived: 0, revisie: 1 });
    expect(register(t.db, uuid)).toHaveLength(1);
    expect(register(t.db, uuid)[0]).toMatchObject({ uitkomst: 'toegepast', revisie: 1 });
    // de bron van de velden is de apparaatcode van de telefoon
    expect(t.db.prepare('SELECT DISTINCT bron FROM job_field_rev WHERE tijd > 0 AND job_id = (SELECT id FROM jobs WHERE uuid = ?)').all(uuid)).toEqual([{ bron: 'M1' }]);
  });

  it('een tweede identieke POST met een andere nonce geeft 200 overgeslagen en er is een klus', async () => {
    const t = startReceiver();
    const p = await koppel(t);
    const uuid = randomUUID();
    await p.project({ titel: 'Badkamer', klant: t.klantUuid }, { uuid });
    const seq = teller(t.db);
    const r = await p.project({ titel: 'Badkamer', klant: t.klantUuid }, { uuid });
    expect(r).toMatchObject({ status: 200, json: { ok: true, uitkomst: 'overgeslagen' } });
    expect(n(t.db, 'SELECT COUNT(*) AS n FROM jobs WHERE uuid = ?', uuid)).toBe(1);
    expect(register(t.db, uuid)).toHaveLength(1);
    expect(teller(t.db)).toBe(seq);
  });

  it('een onbekende klant geeft 200 wacht en een wachtrijrij, zonder registerrij, en de klant daarna maakt de klus', async () => {
    const t = startReceiver();
    const p = await koppel(t);
    const uuid = randomUUID();
    const klant = randomUUID();
    const r = await p.project({ titel: 'Dak', klant }, { uuid });
    expect(r).toMatchObject({ status: 200, sealed: true, json: { ok: true, soort: 'wijziging', uuid, uitkomst: 'wacht' } });
    expect(wachtrij(t.db, uuid)).toHaveLength(1);
    expect(wachtrij(t.db, uuid)[0]).toMatchObject({ bron: 'M1', wacht_op_entiteit: 'klant', wacht_op_uuid: klant, reden: 'klant-onbekend', verwerkt_op: null });
    expect(register(t.db, uuid)).toEqual([]);
    expect(job(t.db, uuid)).toBeUndefined();
    // de klant komt via dezelfde receiver binnen
    const k = await p.verstuur({ soort: 'wijziging', tijd: t.clock.now, wijziging: { entiteit: 'klant', uuid: klant, revisie: 1, tijd: t.clock.now, velden: { naam: 'Dakdekker BV' } } });
    expect(k.json).toMatchObject({ uitkomst: 'toegepast' });
    expect(job(t.db, uuid)).toMatchObject({ title: 'Dak' });
    expect(wachtrij(t.db, uuid)[0]).toMatchObject({ verwerkt_uitkomst: 'toegepast' });
  });

  it('een verboden veld geeft 400 veld-ongeldig met veld en melding en er wordt niets bewaard', async () => {
    const t = startReceiver();
    const p = await koppel(t);
    const voor = telling(t.db);
    const r = await p.project({ titel: 'Badkamer', klant: t.klantUuid, kosten: 5 });
    expect(r).toMatchObject({ status: 400, sealed: true, json: { ok: false, fout: 'veld-ongeldig', veld: 'kosten' } });
    expect(String(r.json!.melding)).toContain('kosten');
    const gefactureerd = await p.project({ titel: 'Badkamer', klant: t.klantUuid, status: 'gefactureerd' });
    expect(gefactureerd).toMatchObject({ status: 400, json: { fout: 'veld-ongeldig', veld: 'status' } });
    expect(telling(t.db)).toEqual(voor);
  });

  it('een project zonder titel of klant en zonder wachtende rij geeft 409 project-onbekend', async () => {
    const t = startReceiver();
    const p = await koppel(t);
    const voor = telling(t.db);
    const r = await p.project({ notities: 'alleen notities' }, { revisie: 2 });
    expect(r).toMatchObject({ status: 409, sealed: true, json: { ok: false, fout: 'project-onbekend' } });
    expect(telling(t.db)).toEqual(voor);
  });

  it('een wachtrij die vol is geeft 503 wachtrij-vol, zonder rij in de wachtrij of het register', async () => {
    const t = startReceiver();
    const p = await koppel(t);
    expect((await p.project({ titel: 'Eerste', klant: randomUUID() })).json).toMatchObject({ uitkomst: 'wacht' });
    const apparaat = (t.db.prepare('SELECT apparaat_id FROM sync_wachtrij').get() as { apparaat_id: string }).apparaat_id;
    const vul = t.db.prepare(`INSERT INTO sync_wachtrij (apparaat_id, bron, entiteit, uuid, revisie, tijd, wijziging, wacht_op_entiteit, wacht_op_uuid, reden, ontvangen_op) VALUES (?, 'M1', 'project', ?, 1, 1, '{}', 'klant', ?, 'klant-onbekend', 1)`);
    t.db.transaction(() => {
      for (let i = 1; i < 1000; i++) vul.run(apparaat, randomUUID(), randomUUID());
    })();
    const voor = telling(t.db);
    const uuid = randomUUID();
    const r = await p.project({ titel: 'Te veel', klant: randomUUID() }, { uuid });
    expect(r).toMatchObject({ status: 503, sealed: true, json: { ok: false, fout: 'wachtrij-vol' } });
    expect(telling(t.db)).toEqual(voor);
    expect(wachtrij(t.db, uuid)).toEqual([]);
    expect(register(t.db, uuid)).toEqual([]);
    // een project voor een bekende klant wordt gewoon toegepast
    expect((await p.project({ titel: 'Wel', klant: t.klantUuid })).json).toMatchObject({ uitkomst: 'toegepast' });
  });

  it('de entiteiten bon en foto blijven 200 niet-ondersteund zonder rijen', async () => {
    const t = startReceiver();
    const p = await koppel(t);
    const voor = telling(t.db);
    const voorBonnen = n(t.db, 'SELECT COUNT(*) AS n FROM scanner_documents');
    for (const entiteit of ['bon', 'foto']) {
      const r = await p.verstuur({ soort: 'wijziging', tijd: t.clock.now, wijziging: { entiteit, uuid: randomUUID(), revisie: 1, tijd: t.clock.now, velden: { titel: 'x', klant: t.klantUuid } } });
      expect(r, entiteit).toMatchObject({ status: 200, json: { ok: true, entiteit, uitkomst: 'niet-ondersteund' } });
    }
    expect(telling(t.db)).toEqual(voor);
    expect(n(t.db, 'SELECT COUNT(*) AS n FROM scanner_documents')).toBe(voorBonnen);
  });

  it('een klantwisseling op een klus met een factuur geeft 200 afgewezen klus-gekoppeld met een Nederlandse melding, ook bij herhaling', async () => {
    const t = startReceiver();
    const p = await koppel(t);
    const uuid = randomUUID();
    await p.project({ titel: 'Badkamer', klant: t.klantUuid }, { uuid });
    t.s.jobs.makeInvoice(job(t.db, uuid)!.id, [{ description: 'Werk', quantity: 1, unitPrice: 1000, vatCode: 'hoog' }]);
    const andere = t.s.relations.create({ name: 'Andere klant' });
    const andereUuid = (t.db.prepare('SELECT uuid FROM relations WHERE id = ?').get(andere.id) as { uuid: string }).uuid;
    const voor = job(t.db, uuid)!;
    const r = await p.project({ klant: andereUuid }, { uuid, revisie: 2 });
    expect(r).toMatchObject({ status: 200, json: { ok: true, uitkomst: 'afgewezen', fout: 'klus-gekoppeld' } });
    expect(String(r.json!.melding)).toMatch(/klant/);
    expect(job(t.db, uuid)).toEqual(voor);
    expect(register(t.db, uuid).at(-1)).toMatchObject({ uitkomst: 'afgewezen', fout: 'klus-gekoppeld' });
  });

  it('bij het starten van de receiver worden wachtende projecten verwerkt waarvan de klant er inmiddels is', async () => {
    const t = startReceiver();
    const uuid = randomUUID();
    // een wachtrijrij van een eerdere sessie, waarvan de klant er inmiddels is (bijvoorbeeld als alias of door de gebruiker aangemaakt)
    const wijz = JSON.stringify({ entiteit: 'project', uuid, revisie: 1, tijd: t.clock.now, velden: { titel: 'Uit de wachtrij', klant: t.klantUuid } });
    t.db.prepare(`INSERT INTO sync_wachtrij (apparaat_id, bron, entiteit, uuid, revisie, tijd, wijziging, wacht_op_entiteit, wacht_op_uuid, reden, ontvangen_op) VALUES ('dev', 'M1', 'project', ?, 1, ?, ?, 'klant', ?, 'klant-onbekend', ?)`).run(uuid, t.clock.now, wijz, t.klantUuid, t.clock.now);
    expect(job(t.db, uuid)).toBeUndefined();
    await t.scanner.start();
    expect(job(t.db, uuid)).toMatchObject({ title: 'Uit de wachtrij', relation_id: t.klant.id });
    expect(wachtrij(t.db, uuid)[0]).toMatchObject({ verwerkt_uitkomst: 'toegepast' });
    expect(register(t.db, uuid)).toEqual([{ apparaat_id: 'dev', revisie: 1, uitkomst: 'toegepast', fout: null }]);
  });

  it('de protocolbeschrijving noemt de projectvelden, de codes en dat de pc een project nooit verwijdert', () => {
    const docs = readFileSync(join(import.meta.dirname, '..', 'docs', 'bonnenscanner-protocol.md'), 'utf8');
    for (const tekst of ['project-onbekend', 'wachtrij-vol', 'klus-gekoppeld', 'wacht', 'titel', 'startdatum', 'einddatum', 'gearchiveerd']) expect(docs, tekst).toContain(tekst);
    expect(docs).toMatch(/nooit[^.]*verwijder/i);
  });
});

describe('projecten-wachtrij', () => {
  it('een wijziging boven LIMITS.maxWijzigingJsonBytes (128 KiB) geeft 413 te-groot zonder rijen', async () => {
    const t = startReceiver();
    const p = await koppel(t);
    const voor = telling(t.db);
    const tekst = JSON.stringify({ soort: 'wijziging', tijd: t.clock.now, wijziging: { entiteit: 'project', uuid: randomUUID(), revisie: 1, tijd: t.clock.now, velden: { titel: 'Groot', klant: randomUUID(), notities: 'x'.repeat(LIMITS.maxWijzigingJsonBytes) } } });
    expect(Buffer.byteLength(tekst)).toBeGreaterThan(LIMITS.maxWijzigingJsonBytes);
    const r = await p.verstuurRuw(tekst);
    expect(r).toMatchObject({ status: 413, json: { ok: false, fout: 'te-groot' } });
    expect(telling(t.db)).toEqual(voor);
  });

  it('een wijziging van ruim 16 KiB tot 128 KiB wordt gewoon bewaard in de wachtrij', async () => {
    const t = startReceiver();
    const p = await koppel(t);
    const uuid = randomUUID();
    const klant = randomUUID();
    // 4000 tekens notities, elk als A geschreven: geldig voor het project, maar ruim boven de 16 KiB op de lijn
    const tekst = `{"soort":"wijziging","tijd":${t.clock.now},"wijziging":{"entiteit":"project","uuid":"${uuid}","revisie":1,"tijd":${t.clock.now},"velden":{"titel":"Groot","klant":"${klant}","notities":"${'\\u0041'.repeat(4000)}"}}}`;
    const lengte = Buffer.byteLength(tekst);
    expect(lengte).toBeGreaterThan(LIMITS.maxJsonBytes);
    expect(lengte).toBeLessThan(LIMITS.maxWijzigingJsonBytes);
    const r = await p.verstuurRuw(tekst);
    expect(r).toMatchObject({ status: 200, json: { ok: true, uitkomst: 'wacht' } });
    const rijen = wachtrij(t.db, uuid);
    expect(rijen).toHaveLength(1);
    expect(JSON.parse(rijen[0]!.wijziging).velden.notities).toBe('A'.repeat(4000));
    expect(rijen[0]).toMatchObject({ wacht_op_uuid: klant, verwerkt_op: null });
  });
});

// ---------------------------------------------------------------------------------------------------
// Herstel na review (PR 347): klus met offerte, leverancier als klant, wachtrij opnieuw proberen,
// kiezen van de aanmaakrij en de eerst opgeslagen inhoud van een wachtrijsleutel.
// ---------------------------------------------------------------------------------------------------

describe('projecten-herstel', () => {
  const uuidVan = (a: Admin, id: number) => (a.db.prepare('SELECT uuid FROM relations WHERE id = ?').get(id) as { uuid: string }).uuid;
  const regel = [{ description: 'Badkamer', quantity: 1, unitPrice: 10000, vatCode: 'hoog' as const }];

  /** Een klus uit een geaccepteerde offerte van de standaardklant. */
  function klusMetOfferte(a: Admin) {
    const q = a.s.quotes.create({ relationId: a.klant.id, reference: 'Badkamer', lines: regel });
    const j = a.s.jobs.acceptQuote(q.id);
    return { q, j };
  }

  it('een klus uit een geaccepteerde offerte blijft bij zijn klant: een klantwisseling via de telefoon is klus-gekoppeld en de factuur gaat naar de offerteklant', () => {
    const a = admin();
    const { j: klus } = klusMetOfferte(a);
    const j = { ...klus, uuid: klus.uuid! };
    const andere = a.s.relations.create({ name: 'Klant B' });
    const voor = job(a.db, j.uuid)!;
    const r = a.sync.verwerk('dev-1', 'M1', wijziging('project', { uuid: j.uuid, revisie: 1, tijd: Date.now() + DAG, velden: { klant: uuidVan(a, andere.id), notities: 'nieuw' } }));
    expect(r).toMatchObject({ status: 200, uitkomst: 'afgewezen', fout: 'klus-gekoppeld' });
    expect(job(a.db, j.uuid)).toEqual(voor);
    expect(a.s.jobs.makeInvoice(j.id).relation_id).toBe(a.klant.id);
  });

  it('de klant van een offerte met een klus wijzigen op de pc kan niet, en makeInvoice weigert een klus en offerte met verschillende klanten', () => {
    const a = admin();
    const { q, j } = klusMetOfferte(a);
    const andere = a.s.relations.create({ name: 'Klant B' });
    a.s.quotes.setStatus(q.id, 'verzonden');
    expect(() => a.s.quotes.update(q.id, { relationId: andere.id })).toThrow(/klus/);
    expect(a.s.quotes.get(q.id).relation_id).toBe(a.klant.id);
    // een bestaande afwijkende toestand levert nooit een factuur voor de verkeerde klant op
    a.db.prepare('UPDATE jobs SET relation_id = ? WHERE id = ?').run(andere.id, j.id);
    a.s.quotes.setStatus(q.id, 'geaccepteerd');
    expect(() => a.s.jobs.makeInvoice(j.id)).toThrow(/verschillen/);
    expect(n(a.db, 'SELECT COUNT(*) AS n FROM invoices')).toBe(0);
  });

  describe('een leverancier is geen klant', () => {
    const leverancier = (a: Admin) => {
      const l = a.s.relations.create({ name: 'Bouwmarkt', type: 'leverancier' });
      return { l, uuid: uuidVan(a, l.id) };
    };

    it('een nieuw project voor een leverancier is afgewezen geen-klant, met een registerrij en zonder klus', () => {
      const a = admin();
      const { uuid: lev } = leverancier(a);
      const w = projectWijziging(a, {}, { klant: lev });
      expect(a.sync.verwerk('dev-1', 'M1', w)).toEqual({ status: 200, uitkomst: 'afgewezen', fout: 'geen-klant' });
      expect(job(a.db, w.uuid)).toBeUndefined();
      expect(register(a.db, w.uuid)).toEqual([{ apparaat_id: 'dev-1', revisie: 1, uitkomst: 'afgewezen', fout: 'geen-klant' }]);
      expect(a.sync.verwerk('dev-1', 'M1', w)).toEqual({ status: 200, uitkomst: 'afgewezen', fout: 'geen-klant' });
    });

    it('ook via een alias van de leverancier, en een klantwisseling naar een leverancier schrijft niets', () => {
      const a = admin();
      const { l } = leverancier(a);
      const alias = randomUUID();
      a.db.prepare('INSERT INTO relation_aliases (alias_uuid, relation_id, aangemaakt_op) VALUES (?, ?, ?)').run(alias, l.id, VAST);
      expect(a.sync.verwerk('dev-1', 'M1', projectWijziging(a, {}, { klant: alias }))).toEqual({ status: 200, uitkomst: 'afgewezen', fout: 'geen-klant' });
      const uuid = nieuwProjectUuid(a);
      const voor = job(a.db, uuid)!;
      expect(a.sync.verwerk('dev-1', 'M1', wijziging('project', { uuid, revisie: 2, tijd: VAST, velden: { klant: alias, notities: 'x' } }))).toEqual({ status: 200, uitkomst: 'afgewezen', fout: 'geen-klant' });
      expect(job(a.db, uuid)).toEqual(voor);
    });

    it('een beide-relatie is wel een klant', () => {
      const a = admin();
      const b = a.s.relations.create({ name: 'Beide BV', type: 'beide' });
      const w = projectWijziging(a, {}, { klant: uuidVan(a, b.id) });
      expect(a.sync.verwerk('dev-1', 'M1', w)).toEqual({ status: 200, uitkomst: 'toegepast' });
      expect(job(a.db, w.uuid)).toMatchObject({ relation_id: b.id });
    });

    it('een wachtend project waarvan de klant later een leverancier blijkt wordt afgewezen geen-klant en de rij wordt gemarkeerd, niet verwijderd', () => {
      const a = admin();
      const { l, uuid: lev } = leverancier(a);
      // de uuid is bij het wachten nog onbekend: de leverancier krijgt hem pas daarna als alias
      const alias = randomUUID();
      const w = projectWijziging(a, {}, { klant: alias });
      expect(a.sync.verwerk('dev-1', 'M1', w)).toEqual({ status: 200, uitkomst: 'wacht' });
      const w2 = wijziging('project', { uuid: w.uuid, revisie: 2, tijd: VAST, velden: { notities: 'later' } });
      expect(a.sync.verwerk('dev-1', 'M1', w2)).toEqual({ status: 200, uitkomst: 'wacht' });
      a.db.prepare('INSERT INTO relation_aliases (alias_uuid, relation_id, aangemaakt_op) VALUES (?, ?, ?)').run(alias, l.id, VAST);
      a.sync.verwerkWachtrij();
      expect(lev).not.toBe(alias);
      expect(job(a.db, w.uuid)).toBeUndefined();
      expect(wachtrij(a.db, w.uuid).map((r) => [r.revisie, r.verwerkt_uitkomst, r.verwerkt_reden])).toEqual([[1, 'afgewezen', 'geen-klant'], [2, 'afgewezen', 'geen-klant']]);
      expect(register(a.db, w.uuid).map((r) => [r.revisie, r.uitkomst, r.fout])).toEqual([[1, 'afgewezen', 'geen-klant'], [2, 'afgewezen', 'geen-klant']]);
    });
  });

  const nieuwProjectUuid = (a: Admin) => {
    const w = projectWijziging(a, { tijd: VAST - DAG });
    a.sync.verwerk('dev-1', 'M1', w);
    return w.uuid;
  };

  it('een wachtend project houdt de route van de eerste ontvangst in de registerrij, ook als het later uit de wachtrij wordt overgenomen', () => {
    const a = admin();
    for (const route of ['map', 'mail']) {
      const klant = randomUUID();
      const w = projectWijziging(a, {}, { klant });
      expect(a.sync.verwerk('dev-1', 'M1', w, route)).toEqual({ status: 200, uitkomst: 'wacht' });
      expect(wachtrij(a.db, w.uuid)[0]).toMatchObject({ route });
      expect(a.sync.verwerk('dev-1', 'M1', klantWijziging(klant), 'netwerk')).toEqual({ status: 200, uitkomst: 'toegepast' });
      expect(job(a.db, w.uuid)).toMatchObject({ title: 'Badkamer' });
      expect((a.db.prepare(`SELECT uitkomst, route FROM sync_ontvangen WHERE entiteit = 'project' AND uuid = ?`).all(w.uuid) as { uitkomst: string; route: string }[]).map((r) => [r.uitkomst, r.route])).toEqual([['toegepast', route]]);
    }
    // een rij van voor de migratie heeft geen route en hervat met netwerk
    const klant = randomUUID();
    const w = projectWijziging(a, {}, { klant });
    expect(a.sync.verwerk('dev-1', 'M1', w, 'map')).toEqual({ status: 200, uitkomst: 'wacht' });
    a.db.prepare('UPDATE sync_wachtrij SET route = NULL WHERE uuid = ?').run(w.uuid);
    a.sync.verwerk('dev-1', 'M1', klantWijziging(klant), 'map');
    expect((a.db.prepare(`SELECT uitkomst, route FROM sync_ontvangen WHERE entiteit = 'project' AND uuid = ?`).all(w.uuid) as { uitkomst: string; route: string }[]).map((r) => [r.uitkomst, r.route])).toEqual([['toegepast', 'netwerk']]);
  });

  it('na een tijdelijke opslagfout verwerkt een herhaling van dezelfde klantwijziging (overgeslagen) de wachtrij alsnog', () => {
    const a = admin();
    const klant = randomUUID();
    const w = projectWijziging(a, {}, { klant });
    expect(a.sync.verwerk('dev-1', 'M1', w)).toEqual({ status: 200, uitkomst: 'wacht' });
    a.db.exec(`CREATE TRIGGER tijdelijk BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT, 'schijf vol'); END`);
    const k = klantWijziging(klant);
    expect(a.sync.verwerk('dev-1', 'M1', k)).toEqual({ status: 200, uitkomst: 'toegepast' });
    expect(job(a.db, w.uuid)).toBeUndefined();
    expect(wachtrij(a.db, w.uuid)[0]).toMatchObject({ verwerkt_op: null });
    a.db.exec('DROP TRIGGER tijdelijk');
    expect(a.sync.verwerk('dev-1', 'M1', k)).toEqual({ status: 200, uitkomst: 'overgeslagen' });
    expect(job(a.db, w.uuid)).toMatchObject({ title: 'Badkamer' });
    expect(wachtrij(a.db, w.uuid)[0]).toMatchObject({ verwerkt_uitkomst: 'toegepast' });
  });

  it('een oudere rij die op een onbekende klant wacht houdt een nieuwere revisie met een bekende klant niet tegen', () => {
    const a = admin();
    const uuid = randomUUID();
    const klantA = randomUUID();
    const klantB = randomUUID();
    expect(a.sync.verwerk('dev-1', 'M1', wijziging('project', { uuid, revisie: 1, tijd: VAST - 2 * MINUUT, velden: { titel: 'Oud', klant: klantA, adres: 'Dorpsstraat 5' } }))).toEqual({ status: 200, uitkomst: 'wacht' });
    expect(a.sync.verwerk('dev-1', 'M1', wijziging('project', { uuid, revisie: 2, tijd: VAST - MINUUT, velden: { titel: 'Nieuw', klant: klantB } }))).toEqual({ status: 200, uitkomst: 'wacht' });
    expect(a.sync.verwerk('dev-1', 'M1', wijziging('project', { uuid, revisie: 3, tijd: VAST, velden: { notities: 'erbij' } }))).toEqual({ status: 200, uitkomst: 'wacht' });
    a.sync.verwerk('dev-1', 'M1', klantWijziging(klantB, 'Klant B'));
    const b = a.db.prepare('SELECT id FROM relations WHERE uuid = ?').get(klantB) as { id: number };
    expect(job(a.db, uuid)).toMatchObject({ title: 'Nieuw', relation_id: b.id, notes: 'erbij' });
    expect(wachtrij(a.db, uuid).map((r) => [r.revisie, r.verwerkt_uitkomst])).toEqual([[1, null], [2, 'toegepast'], [3, 'toegepast']]);
    // komt klant A later, dan wordt de oudere rij per veld samengevoegd: het adres is nog leeg en komt erbij, titel en klant zijn nieuwer
    a.sync.verwerk('dev-1', 'M1', klantWijziging(klantA, 'Klant A'));
    expect(job(a.db, uuid)).toMatchObject({ title: 'Nieuw', relation_id: b.id, address: 'Dorpsstraat 5', notes: 'erbij' });
    expect(wachtrij(a.db, uuid).map((r) => r.verwerkt_uitkomst)).toEqual(['toegepast', 'toegepast', 'toegepast']);
  });

  it('dezelfde sleutel met andere inhoud en een bekende klant omzeilt de wachtrij niet: de eerst opgeslagen inhoud blijft leidend', () => {
    const a = admin();
    const klant = randomUUID();
    const uuid = randomUUID();
    const eerste = wijziging('project', { uuid, revisie: 1, tijd: VAST, velden: { titel: 'Eerste', klant, notities: 'eerst' } });
    expect(a.sync.verwerk('dev-1', 'M1', eerste)).toEqual({ status: 200, uitkomst: 'wacht' });
    const herhaling = wijziging('project', { uuid, revisie: 1, tijd: VAST + MINUUT, velden: { titel: 'Tweede', klant: a.klantUuid, notities: 'anders' } });
    const tellerVoor = teller(a.db);
    expect(a.sync.verwerk('dev-1', 'M1', herhaling)).toEqual({ status: 200, uitkomst: 'wacht' });
    expect(job(a.db, uuid)).toBeUndefined();
    expect(teller(a.db)).toBe(tellerVoor);
    expect(wachtrij(a.db, uuid)).toHaveLength(1);
    expect(JSON.parse(wachtrij(a.db, uuid)[0]!.wijziging).velden.titel).toBe('Eerste');
    // na de klant staat er de eerste inhoud, en een nieuwe herhaling verandert niets meer
    a.sync.verwerk('dev-1', 'M1', klantWijziging(klant));
    expect(job(a.db, uuid)).toMatchObject({ title: 'Eerste', notes: 'eerst' });
    expect(a.sync.verwerk('dev-1', 'M1', herhaling)).toEqual({ status: 200, uitkomst: 'overgeslagen' });
    expect(job(a.db, uuid)).toMatchObject({ title: 'Eerste', notes: 'eerst' });
  });
});
