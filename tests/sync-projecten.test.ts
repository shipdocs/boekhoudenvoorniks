import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, openDatabase } from '../src/db/database';
import { migrations } from '../src/db/migrations';
import { setup } from './helpers';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import { herstelJobUuids } from '../src/jobs/herstel';
import { veldOndergrens } from '../src/sync/ondergrens';

// Projecten (klussen, tabel jobs) in de sync: uuid, revisie, wijzigingsteller, tijd per veld, logboek,
// archief en de wachtrij voor wijzigingen die op een onbekende klant wachten. Dit bestand begint met de
// migratie, de lokale schrijfpaden en de archieffilters; de ontvangst van projecten staat verderop.

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const n = (db: Database.Database, sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { n: number }).n;
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
    expect(k.map((c) => c.name)).toEqual(['id', 'apparaat_id', 'bron', 'entiteit', 'uuid', 'revisie', 'tijd', 'wijziging', 'nummer', 'wacht_op_entiteit', 'wacht_op_uuid', 'reden', 'ontvangen_op', 'verwerkt_op', 'verwerkt_uitkomst', 'verwerkt_reden']);
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
    expect(klaar).toMatchObject({ status: 'klaar', end_date: '2026-10-07', revisie: 2 });
    expect(velden(db, job.id).filter((v) => ['status', 'end_date'].includes(v.veld))).toEqual([
      { veld: 'end_date', tijd, bron: 'pc' },
      { veld: 'status', tijd, bron: 'pc' },
    ]);
    expect(logboek(db, job.id).filter((l) => l.revisie === 2).map((l) => [l.veld, l.oud, l.nieuw])).toEqual([['end_date', null, '2026-10-07'], ['status', 'gepland', 'klaar']]);
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
    expect(na).toMatchObject({ status: 'gefactureerd', end_date: '2026-10-07', revisie: voor.revisie + 1 });
    expect(na.sync_seq).toBeGreaterThan(voor.sync_seq);
    expect(logboek(db, job.id).filter((l) => l.revisie === 2).map((l) => [l.veld, l.nieuw])).toEqual([['end_date', '2026-10-07'], ['status', 'gefactureerd']]);
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
