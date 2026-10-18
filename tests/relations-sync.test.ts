import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '../src/db/database';
import { herstelRelatieUuids } from '../src/relations/herstel';
import { RELATIE_VELD_MAPPING, RelationsService } from '../src/relations/relations';
import { ValidationError } from '../src/shared/validation';
import { setup } from './helpers';
import { migrations } from '../src/db/migrations';
import { volgendeSyncSeq } from '../src/sync/teller';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

beforeEach(() => {
  expect.hasAssertions();
});

/** de migratie die de sync-identiteit van klanten toevoegt, gevonden op inhoud (geen vast nummer) */
const eigen = migrations.findIndex((m) => /CREATE TABLE IF NOT EXISTS relation_field_rev\b/.test(m));

/** een database in de toestand vlak vóór de eigen migratie */
function oudeToestand(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const m of migrations.slice(0, eigen)) db.exec(m);
  db.pragma(`user_version = ${eigen}`);
  return db;
}

function nieuweKlant(db: Database.Database, naam: string, extra: { type?: string; archived?: number; created_at?: string } = {}): number {
  const r = db
    .prepare(`INSERT INTO relations (type, name, archived, created_at) VALUES (?, ?, ?, ?)`)
    .run(extra.type ?? 'klant', naam, extra.archived ?? 0, extra.created_at ?? '2025-03-04 10:20:30');
  return Number(r.lastInsertRowid);
}

describe('Klantidentiteit', () => {
  it('migratie: de eigen migratie is gevonden en staat niet vooraan', () => {
    expect(eigen).toBeGreaterThan(0);
    expect(migrations[eigen]).toMatch(/ADD COLUMN uuid/);
  });

  it('migratie: drie klanten krijgen verschillende uuid-v4 en behouden hun andere kolommen', () => {
    const db = oudeToestand();
    const a = nieuweKlant(db, 'Jansen');
    const b = nieuweKlant(db, 'Archief BV', { archived: 1 });
    const c = nieuweKlant(db, 'Leverancier Piet', { type: 'leverancier' });
    const voor = db.prepare('SELECT * FROM relations ORDER BY id').all() as Record<string, unknown>[];
    migrate(db);
    const na = db.prepare('SELECT * FROM relations ORDER BY id').all() as Record<string, unknown>[];
    expect(na.map((r) => r.id)).toEqual([a, b, c]);
    const uuids = na.map((r) => String(r.uuid));
    for (const u of uuids) expect(u).toMatch(UUID_V4);
    expect(new Set(uuids).size).toBe(3);
    for (let i = 0; i < 3; i++) {
      const { uuid, revisie, gewijzigd_op, sync_seq, ...rest } = na[i]!;
      void uuid; void revisie; void gewijzigd_op; void sync_seq;
      expect(rest).toEqual(voor[i]);
    }
    expect(na.map((r) => r.archived)).toEqual([0, 1, 0]);
    expect(na.map((r) => r.type)).toEqual(['klant', 'klant', 'leverancier']);
  });

  it('migratie: beginwaarden van rijversie, bewerktijd en volgnummer voor bestaande klanten', () => {
    const db = oudeToestand();
    nieuweKlant(db, 'Jansen', { created_at: '2025-03-04 10:20:30' });
    nieuweKlant(db, 'Pietersen', { created_at: '2024-01-01 00:00:00' });
    migrate(db);
    const rijen = db.prepare('SELECT id, revisie, gewijzigd_op, sync_seq FROM relations ORDER BY id').all() as { id: number; revisie: number; gewijzigd_op: number; sync_seq: number }[];
    expect(rijen.map((r) => r.revisie)).toEqual([1, 1]);
    expect(rijen[0]!.gewijzigd_op).toBe(Date.UTC(2025, 2, 4, 10, 20, 30));
    expect(rijen[1]!.gewijzigd_op).toBe(Date.UTC(2024, 0, 1));
    expect(rijen[0]!.gewijzigd_op).toBeGreaterThan(0);
    expect(rijen.map((r) => r.sync_seq)).toEqual(rijen.map((r) => r.id));
  });

  it('migratie: veldtijden en logboek en aliassen blijven leeg voor bestaande klanten', () => {
    const db = oudeToestand();
    nieuweKlant(db, 'Jansen');
    migrate(db);
    for (const t of ['relation_field_rev', 'relation_changelog', 'relation_aliases']) {
      expect((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n).toBe(0);
    }
  });

  it('migratie: de wijzigingsteller heeft een rij met het hoogste klantnummer', () => {
    const db = oudeToestand();
    nieuweKlant(db, 'A');
    nieuweKlant(db, 'B');
    const c = nieuweKlant(db, 'C');
    migrate(db);
    expect(db.prepare("SELECT naam, waarde FROM sync_teller WHERE naam = 'wijziging'").all()).toEqual([{ naam: 'wijziging', waarde: c }]);
  });

  it('migratie: zonder klanten begint de wijzigingsteller op 0', () => {
    const db = oudeToestand();
    migrate(db);
    expect(db.prepare("SELECT naam, waarde FROM sync_teller WHERE naam = 'wijziging'").all()).toEqual([{ naam: 'wijziging', waarde: 0 }]);
    // latere migraties voegen eigen tellers toe (bevestiging); die beginnen ook op 0
    expect(db.prepare('SELECT naam, waarde FROM sync_teller ORDER BY naam').all()).toEqual([{ naam: 'bevestiging', waarde: 0 }, { naam: 'wijziging', waarde: 0 }]);
    expect(db.pragma('user_version', { simple: true })).toBe(migrations.length);
  });

  it('migratie: een hoogste klantnummer met een gat telt de teller vanaf het hoogste nummer', () => {
    const db = oudeToestand();
    nieuweKlant(db, 'A');
    const b = nieuweKlant(db, 'B');
    db.prepare('UPDATE relations SET id = 40 WHERE id = ?').run(b);
    migrate(db);
    expect((db.prepare(`SELECT waarde FROM sync_teller WHERE naam = 'wijziging'`).get() as { waarde: number }).waarde).toBe(40);
  });

  it('migratie: user_version is gelijk aan het aantal migraties', () => {
    const db = oudeToestand();
    nieuweKlant(db, 'A');
    migrate(db);
    expect(db.pragma('user_version', { simple: true })).toBe(migrations.length);
  });

  it('migratie: de unieke index op uuid en de index op het volgnummer bestaan', () => {
    const db = oudeToestand();
    migrate(db);
    const indexen = db.pragma('index_list(relations)') as { name: string; unique: number }[];
    const uuidIndex = indexen.find((i) => i.name === 'idx_relations_uuid');
    expect(uuidIndex?.unique).toBe(1);
    expect((db.pragma('index_info(idx_relations_uuid)') as { name: string }[]).map((c) => c.name)).toEqual(['uuid']);
    const seqIndex = indexen.find((i) => (db.pragma(`index_info(${i.name})`) as { name: string }[]).some((c) => c.name === 'sync_seq'));
    expect(seqIndex).toBeDefined();
    expect(seqIndex?.unique).toBe(0);
  });

  it('migratie: de unieke index weigert een tweede rij met dezelfde uuid', () => {
    const db = oudeToestand();
    nieuweKlant(db, 'A');
    migrate(db);
    const uuid = (db.prepare('SELECT uuid FROM relations').get() as { uuid: string }).uuid;
    expect(() => db.prepare(`INSERT INTO relations (type, name, uuid) VALUES ('klant', 'B', ?)`).run(uuid)).toThrow(/UNIQUE/);
    // meerdere rijen zonder uuid (een oudere app-versie) zijn wel toegestaan
    db.prepare(`INSERT INTO relations (type, name) VALUES ('klant', 'C')`).run();
    db.prepare(`INSERT INTO relations (type, name) VALUES ('klant', 'D')`).run();
    expect((db.prepare('SELECT COUNT(*) AS n FROM relations WHERE uuid IS NULL').get() as { n: number }).n).toBe(2);
  });

  it('migratie: nieuwe rijen van een oudere app-versie krijgen de kolomstandaarden', () => {
    const db = oudeToestand();
    migrate(db);
    db.prepare(`INSERT INTO relations (type, name) VALUES ('klant', 'Oud')`).run();
    expect(db.prepare('SELECT uuid, revisie, gewijzigd_op, sync_seq FROM relations').get()).toEqual({ uuid: null, revisie: 1, gewijzigd_op: 0, sync_seq: 0 });
  });

  it('migratie: de nieuwe kolommen en tabellen hebben precies het afgesproken schema', () => {
    const db = oudeToestand();
    migrate(db);
    const kolommen = (t: string) =>
      (db.pragma(`table_info(${t})`) as { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }[]).map((k) => [k.name, k.type, k.notnull, k.dflt_value, k.pk]);
    const relatie = kolommen('relations').filter((k) => ['uuid', 'revisie', 'gewijzigd_op', 'sync_seq'].includes(String(k[0])));
    expect(relatie).toEqual([
      ['uuid', 'TEXT', 0, null, 0],
      ['revisie', 'INTEGER', 1, '1', 0],
      ['gewijzigd_op', 'INTEGER', 1, '0', 0],
      ['sync_seq', 'INTEGER', 1, '0', 0],
    ]);
    expect(kolommen('relation_field_rev')).toEqual([
      ['relation_id', 'INTEGER', 1, null, 1],
      ['veld', 'TEXT', 1, null, 2],
      ['tijd', 'INTEGER', 1, null, 0],
      ['bron', 'TEXT', 1, null, 0],
    ]);
    expect(kolommen('relation_changelog')).toEqual([
      ['id', 'INTEGER', 0, null, 1],
      ['relation_id', 'INTEGER', 1, null, 0],
      ['revisie', 'INTEGER', 1, null, 0],
      ['veld', 'TEXT', 1, null, 0],
      ['oud', 'TEXT', 0, null, 0],
      ['nieuw', 'TEXT', 0, null, 0],
      ['tijd', 'INTEGER', 1, null, 0],
      ['bron', 'TEXT', 1, null, 0],
    ]);
    expect(kolommen('relation_aliases')).toEqual([
      ['alias_uuid', 'TEXT', 0, null, 1],
      ['relation_id', 'INTEGER', 1, null, 0],
      ['aangemaakt_op', 'INTEGER', 1, null, 0],
    ]);
    expect(kolommen('sync_teller')).toEqual([
      ['naam', 'TEXT', 0, null, 1],
      ['waarde', 'INTEGER', 1, null, 0],
    ]);
    const logIndex = (db.pragma('index_list(relation_changelog)') as { name: string }[]).some((i) => (db.pragma(`index_info(${i.name})`) as { name: string }[]).some((c) => c.name === 'relation_id'));
    expect(logIndex).toBe(true);
  });

  it('migratie: bevat geen verwijderende stappen en maakt de tabellen met IF NOT EXISTS', () => {
    const db = oudeToestand();
    nieuweKlant(db, 'A');
    migrate(db);
    expect(migrations[eigen]).not.toMatch(/\b(DROP|DELETE|RENAME)\b/i);
    expect(migrations[eigen]).toMatch(/IF NOT EXISTS relation_changelog/);
  });
});

describe('Wijzigingsnummers', () => {
  function metTeller(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    return db;
  }

  it('teller: levert opeenvolgende strikt stijgende nummers vanaf de beginwaarde', () => {
    const db = metTeller();
    expect([volgendeSyncSeq(db), volgendeSyncSeq(db), volgendeSyncSeq(db)]).toEqual([1, 2, 3]);
  });

  it('teller: begint na de migratie op een gevulde database bij het hoogste klantnummer', () => {
    const db = oudeToestand();
    nieuweKlant(db, 'A');
    const b = nieuweKlant(db, 'B');
    migrate(db);
    expect(volgendeSyncSeq(db)).toBe(b + 1);
    expect(volgendeSyncSeq(db)).toBe(b + 2);
  });

  it('teller: loopt mee in de transactie van de aanroeper en rolt mee terug', () => {
    const db = metTeller();
    volgendeSyncSeq(db);
    expect(() =>
      db.transaction(() => {
        volgendeSyncSeq(db);
        volgendeSyncSeq(db);
        throw new Error('mislukt');
      })(),
    ).toThrow('mislukt');
    expect(volgendeSyncSeq(db)).toBe(2);
    expect(db.inTransaction).toBe(false);
  });

  it('teller: een nummer uit een geslaagde transactie blijft behouden', () => {
    const db = metTeller();
    const n = db.transaction(() => volgendeSyncSeq(db))();
    expect(n).toBe(1);
    expect(volgendeSyncSeq(db)).toBe(2);
  });

  it('teller: gooit een duidelijke fout als de rij ontbreekt', () => {
    const db = metTeller();
    db.exec(`DELETE FROM sync_teller`);
    expect(() => volgendeSyncSeq(db)).toThrow(/wijzigingsteller/);
  });
});

describe('Aanvullen na een oudere app-versie', () => {
  const mappen: string[] = [];
  afterEach(() => {
    for (const m of mappen.splice(0)) rmSync(m, { recursive: true, force: true });
  });

  function metKlanten(): Database.Database {
    const db = oudeToestand();
    nieuweKlant(db, 'A');
    nieuweKlant(db, 'B');
    migrate(db);
    return db;
  }
  const teller = (db: Database.Database) => (db.prepare(`SELECT waarde FROM sync_teller WHERE naam = 'wijziging'`).get() as { waarde: number }).waarde;

  it('herstel: een rij zonder uuid krijgt een geldige versie-4-uuid en andere uuid\'s blijven gelijk', () => {
    const db = metKlanten();
    const voor = db.prepare('SELECT id, uuid FROM relations ORDER BY id').all() as { id: number; uuid: string }[];
    const r = db.prepare(`INSERT INTO relations (type, name) VALUES ('klant', 'Oud')`).run();
    herstelRelatieUuids(db, () => {});
    const rij = db.prepare('SELECT uuid FROM relations WHERE id = ?').get(Number(r.lastInsertRowid)) as { uuid: string };
    expect(rij.uuid).toMatch(UUID_V4);
    expect(db.prepare('SELECT id, uuid FROM relations WHERE id <= ? ORDER BY id').all(voor[1]!.id)).toEqual(voor);
  });

  it('herstel: een rij met wijzigingsnummer 0 krijgt een volgend, uniek nummer boven alle bestaande', () => {
    const db = metKlanten();
    const hoogste = teller(db);
    db.prepare(`INSERT INTO relations (type, name) VALUES ('klant', 'Oud 1')`).run();
    db.prepare(`INSERT INTO relations (type, name) VALUES ('klant', 'Oud 2')`).run();
    herstelRelatieUuids(db, () => {});
    const nummers = (db.prepare('SELECT sync_seq FROM relations ORDER BY id').all() as { sync_seq: number }[]).map((r) => r.sync_seq);
    expect(nummers.slice(0, 2)).toEqual([1, 2]);
    expect(nummers.slice(2)).toEqual([hoogste + 1, hoogste + 2]);
    expect(new Set(nummers).size).toBe(4);
    expect(teller(db)).toBe(hoogste + 2);
  });

  it('herstel: zonder rijen om aan te vullen wordt er niets geschreven', () => {
    const db = metKlanten();
    const rijen = db.prepare('SELECT * FROM relations ORDER BY id').all();
    const tellerVoor = teller(db);
    const meldingen: string[] = [];
    const voor = db.prepare('SELECT total_changes() AS n').get() as { n: number };
    herstelRelatieUuids(db, (m) => meldingen.push(m));
    expect((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n).toBe(voor.n);
    expect(db.prepare('SELECT * FROM relations ORDER BY id').all()).toEqual(rijen);
    expect(teller(db)).toBe(tellerVoor);
    expect(meldingen).toEqual([]);
  });

  it('herstel: een tweede aanroep verandert niets', () => {
    const db = metKlanten();
    db.prepare(`INSERT INTO relations (type, name) VALUES ('klant', 'Oud')`).run();
    herstelRelatieUuids(db, () => {});
    const na1 = db.prepare('SELECT * FROM relations ORDER BY id').all();
    const teller1 = teller(db);
    herstelRelatieUuids(db, () => {});
    expect(db.prepare('SELECT * FROM relations ORDER BY id').all()).toEqual(na1);
    expect(teller(db)).toBe(teller1);
  });

  it('herstel: een fout wordt gelogd en niet gegooid en laat de rijen ongemoeid', () => {
    const db = metKlanten();
    db.prepare(`INSERT INTO relations (type, name) VALUES ('klant', 'Oud')`).run();
    db.exec(`DROP TABLE sync_teller`);
    const meldingen: string[] = [];
    expect(() => herstelRelatieUuids(db, (m) => meldingen.push(m))).not.toThrow();
    expect(meldingen).toHaveLength(1);
    expect(meldingen[0]).toMatch(/niet gelukt/);
    expect(db.prepare(`SELECT uuid, sync_seq FROM relations WHERE name = 'Oud'`).get()).toEqual({ uuid: null, sync_seq: 0 });
    expect(db.inTransaction).toBe(false);
  });

  it('herstel: openDatabase vult een rij van een tweede verbinding aan bij het opnieuw openen', () => {
    const map = mkdtempSync(join(tmpdir(), 'bvn-herstel-'));
    mappen.push(map);
    const bestand = join(map, 'administratie.sqlite');
    openDatabase(bestand, () => {}).close();
    const tweede = new Database(bestand);
    tweede.prepare(`INSERT INTO relations (type, name) VALUES ('klant', 'Van een oude versie')`).run();
    tweede.close();
    const db = openDatabase(bestand, () => {});
    try {
      const rij = db.prepare(`SELECT uuid, sync_seq FROM relations WHERE name = 'Van een oude versie'`).get() as { uuid: string; sync_seq: number };
      expect(rij.uuid).toMatch(UUID_V4);
      expect(rij.sync_seq).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});

/** een service op een verse database met een instelbare klok */
function metService(start = 1_000_000) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  const nu = { t: start };
  const service = new RelationsService(db, () => nu.t);
  const volgnummer = () => (db.prepare(`SELECT waarde FROM sync_teller WHERE naam = 'wijziging'`).get() as { waarde: number }).waarde;
  const rij = (id: number) => db.prepare('SELECT * FROM relations WHERE id = ?').get(id) as Record<string, unknown>;
  const velden = (id: number) => db.prepare('SELECT veld, tijd, bron FROM relation_field_rev WHERE relation_id = ? ORDER BY veld').all(id) as { veld: string; tijd: number; bron: string }[];
  const log = (id: number) => db.prepare('SELECT revisie, veld, oud, nieuw, tijd, bron FROM relation_changelog WHERE relation_id = ? ORDER BY id').all(id) as Record<string, unknown>[];
  return { db, nu, service, volgnummer, rij, velden, log };
}

describe('Administratie van lokale wijzigingen', () => {
  it('administratie: create geeft uuid, revisie 1, gewijzigd_op en een wijzigingsnummer', () => {
    const { service, nu } = metService(5000);
    nu.t = 7777;
    const r = service.create({ name: 'Jansen', email: 'jansen@example.nl' });
    expect(r.uuid).toMatch(UUID_V4);
    expect(r.revisie).toBe(1);
    expect(r.gewijzigd_op).toBe(7777);
    expect(r.sync_seq).toBeGreaterThan(0);
  });

  it('administratie: create schrijft een veldrij en een logregel per ingevuld veld', () => {
    const { service, velden, log } = metService(4242);
    const r = service.create({ name: 'Jansen', email: 'jansen@example.nl', city: 'Utrecht', payment_term_days: 14 });
    // type en land krijgen een standaardwaarde en tellen dus als ingevuld; lege velden niet
    expect(velden(r.id).map((v) => v.veld)).toEqual(['city', 'country', 'email', 'name', 'payment_term_days', 'type']);
    expect(velden(r.id).every((v) => v.tijd === 4242 && v.bron === 'pc')).toBe(true);
    const regels = log(r.id);
    expect(regels).toHaveLength(6);
    expect(regels.every((l) => l.oud === null && l.revisie === 1 && l.tijd === 4242 && l.bron === 'pc')).toBe(true);
    expect(regels.find((l) => l.veld === 'payment_term_days')?.nieuw).toBe('14');
    expect(regels.find((l) => l.veld === 'phone')).toBeUndefined();
  });

  it('administratie: een leverancier krijgt ook een uuid, revisie en wijzigingsnummer', () => {
    const { service } = metService();
    const l = service.create({ name: 'Bouwmaat', type: 'leverancier' });
    expect(l.uuid).toMatch(UUID_V4);
    expect(l.revisie).toBe(1);
    expect(l.sync_seq).toBeGreaterThan(0);
    const g = service.findOrCreateSupplier('Gamma');
    expect(g.uuid).toMatch(UUID_V4);
  });

  it('administratie: twee klanten krijgen verschillende uuid en wijzigingsnummer', () => {
    const { service } = metService();
    const a = service.create({ name: 'A' });
    const b = service.create({ name: 'B' });
    expect(a.uuid).not.toBe(b.uuid);
    expect(b.sync_seq).toBeGreaterThan(a.sync_seq);
  });

  it('administratie: update met een echte verandering geeft een hogere revisie en een nieuw wijzigingsnummer', () => {
    const { service, nu } = metService(1000);
    const a = service.create({ name: 'Jansen' });
    nu.t = 2000;
    const b = service.update(a.id, { city: 'Zeist' });
    expect(b.revisie).toBe(2);
    expect(b.sync_seq).toBeGreaterThan(a.sync_seq);
    expect(b.gewijzigd_op).toBe(2000);
    expect(b.uuid).toBe(a.uuid);
  });

  it('administratie: update schrijft per gewijzigd veld een veldrij en een logregel met oud en nieuw', () => {
    const { service, nu, velden, log } = metService(1000);
    const a = service.create({ name: 'Jansen', city: 'Utrecht' });
    nu.t = 3000;
    service.update(a.id, { city: 'Zeist', phone: '0612345678' });
    const veldRijen = velden(a.id);
    expect(veldRijen.find((v) => v.veld === 'city')).toEqual({ veld: 'city', tijd: 3000, bron: 'pc' });
    expect(veldRijen.find((v) => v.veld === 'phone')).toEqual({ veld: 'phone', tijd: 3000, bron: 'pc' });
    expect(veldRijen.find((v) => v.veld === 'name')?.tijd).toBe(1000);
    expect(log(a.id).filter((l) => l.revisie === 2).sort((x, y) => String(x.veld).localeCompare(String(y.veld)))).toEqual([
      { revisie: 2, veld: 'city', oud: 'Utrecht', nieuw: 'Zeist', tijd: 3000, bron: 'pc' },
      { revisie: 2, veld: 'phone', oud: null, nieuw: '0612345678', tijd: 3000, bron: 'pc' },
    ]);
  });

  it('administratie: een update met dezelfde waarden of alleen witruimte schrijft niets', () => {
    const { service, db, volgnummer, rij } = metService();
    const a = service.create({ name: 'Jansen', city: 'Utrecht', email: 'jansen@example.nl' });
    const voor = { relatie: rij(a.id), teller: volgnummer(), velden: db.prepare('SELECT * FROM relation_field_rev').all(), log: db.prepare('SELECT * FROM relation_changelog').all() };
    service.update(a.id, { city: 'Utrecht' });
    service.update(a.id, { city: '  Utrecht  ', email: ' jansen@example.nl ', notes: '   ' });
    service.update(a.id, {});
    expect(rij(a.id)).toEqual(voor.relatie);
    expect(volgnummer()).toBe(voor.teller);
    expect(db.prepare('SELECT * FROM relation_field_rev').all()).toEqual(voor.velden);
    expect(db.prepare('SELECT * FROM relation_changelog').all()).toEqual(voor.log);
  });

  it('administratie: archive verhoogt revisie en wijzigingsnummer en schrijft het veld gearchiveerd', () => {
    const { service, nu, velden, log } = metService(1000);
    const a = service.create({ name: 'Jansen' });
    nu.t = 9000;
    service.archive(a.id);
    const na = service.get(a.id);
    expect(na.archived).toBe(1);
    expect(na.revisie).toBe(2);
    expect(na.sync_seq).toBeGreaterThan(a.sync_seq);
    expect(na.gewijzigd_op).toBe(9000);
    expect(velden(a.id).find((v) => v.veld === 'gearchiveerd')).toEqual({ veld: 'gearchiveerd', tijd: 9000, bron: 'pc' });
    expect(log(a.id).filter((l) => l.veld === 'gearchiveerd')).toEqual([{ revisie: 2, veld: 'gearchiveerd', oud: '0', nieuw: '1', tijd: 9000, bron: 'pc' }]);
  });

  it('administratie: archive van een al gearchiveerde klant of een onbekend id doet niets', () => {
    const { service, db, volgnummer, rij } = metService();
    const a = service.create({ name: 'Jansen' });
    service.archive(a.id);
    const voor = { relatie: rij(a.id), teller: volgnummer(), veld: db.prepare('SELECT COUNT(*) AS n FROM relation_field_rev').get(), log: db.prepare('SELECT COUNT(*) AS n FROM relation_changelog').get() };
    expect(() => service.archive(a.id)).not.toThrow();
    expect(() => service.archive(9999)).not.toThrow();
    expect(rij(a.id)).toEqual(voor.relatie);
    expect(volgnummer()).toBe(voor.teller);
    expect(db.prepare('SELECT COUNT(*) AS n FROM relation_field_rev').get()).toEqual(voor.veld);
    expect(db.prepare('SELECT COUNT(*) AS n FROM relation_changelog').get()).toEqual(voor.log);
    expect(db.prepare('SELECT COUNT(*) AS n FROM relations').get()).toEqual({ n: 1 });
  });

  it('administratie: setPaidWith verandert revisie, wijzigingsnummer en logboek niet', () => {
    const { service, db, volgnummer, rij } = metService();
    const a = service.create({ name: 'Bouwmaat', type: 'leverancier' });
    const voor = rij(a.id);
    const teller = volgnummer();
    const log = db.prepare('SELECT COUNT(*) AS n FROM relation_changelog').get();
    const na = service.setPaidWith(a.id, 'prive');
    expect(na.paid_with).toBe('prive');
    expect(na.revisie).toBe(a.revisie);
    expect(na.sync_seq).toBe(a.sync_seq);
    expect({ ...rij(a.id), paid_with: null }).toEqual(voor);
    expect(volgnummer()).toBe(teller);
    expect(db.prepare('SELECT COUNT(*) AS n FROM relation_changelog').get()).toEqual(log);
  });

  it('administratie: twee updates op verschillende velden geven twee revisies en per veld de eigen tijd', () => {
    const { service, nu, velden } = metService(1000);
    const a = service.create({ name: 'Jansen' });
    nu.t = 2000;
    service.update(a.id, { city: 'Zeist' });
    nu.t = 3000;
    const c = service.update(a.id, { phone: '0201234567' });
    expect(c.revisie).toBe(3);
    const tijden = Object.fromEntries(velden(a.id).map((v) => [v.veld, v.tijd]));
    expect(tijden).toMatchObject({ name: 1000, city: 2000, phone: 3000 });
  });

  it('administratie: een tweede update op hetzelfde veld werkt de bestaande veldrij bij', () => {
    const { service, nu, db, velden, log } = metService(1000);
    const a = service.create({ name: 'Jansen', city: 'Utrecht' });
    nu.t = 2000;
    service.update(a.id, { city: 'Zeist' });
    nu.t = 4000;
    service.update(a.id, { city: 'Delft' });
    expect(velden(a.id).filter((v) => v.veld === 'city')).toEqual([{ veld: 'city', tijd: 4000, bron: 'pc' }]);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM relation_field_rev WHERE relation_id = ? AND veld = 'city'`).get(a.id) as { n: number }).n).toBe(1);
    expect(log(a.id).filter((l) => l.veld === 'city').map((l) => [l.revisie, l.oud, l.nieuw])).toEqual([
      [1, null, 'Utrecht'],
      [2, 'Utrecht', 'Zeist'],
      [3, 'Zeist', 'Delft'],
    ]);
  });

  it('administratie: een update die een veld leegmaakt logt de oude waarde en nieuw NULL', () => {
    const { service, log } = metService();
    const a = service.create({ name: 'Jansen', phone: '0612345678' });
    service.update(a.id, { phone: '' });
    expect(log(a.id).filter((l) => l.veld === 'phone')).toEqual([
      expect.objectContaining({ revisie: 1, oud: null, nieuw: '0612345678' }),
      expect.objectContaining({ revisie: 2, oud: '0612345678', nieuw: null }),
    ]);
  });

  it('administratie: een update van een klant uit de oude toestand begint bij revisie 2 met een veldtijd voor alleen het gewijzigde veld', () => {
    const db = oudeToestand();
    const id = nieuweKlant(db, 'Oud', { created_at: '2020-01-01 00:00:00' });
    migrate(db);
    const service = new RelationsService(db, () => 123456);
    service.update(id, { city: 'Zeist' });
    expect(service.get(id).revisie).toBe(2);
    expect(db.prepare('SELECT veld, tijd, bron FROM relation_field_rev WHERE relation_id = ?').all(id)).toEqual([{ veld: 'city', tijd: 123456, bron: 'pc' }]);
  });

  it('administratie: setPaidWith en lezen laten het wijzigingsnummer van andere klanten ongemoeid', () => {
    const { service, volgnummer } = metService();
    const a = service.create({ name: 'A' });
    const b = service.create({ name: 'B' });
    const teller = volgnummer();
    service.list();
    service.get(a.id);
    service.findByEmail('geen@example.nl');
    expect(volgnummer()).toBe(teller);
    expect(service.get(b.id).sync_seq).toBe(teller);
  });
});

describe('Klok en vaste mapping', () => {
  it('klok en mapping: de ingestelde klok bepaalt de tijd en gewijzigd_op', () => {
    const { service, nu, velden } = metService(111);
    const a = service.create({ name: 'A' });
    expect(a.gewijzigd_op).toBe(111);
    nu.t = 222;
    const b = service.update(a.id, { city: 'X' });
    expect(b.gewijzigd_op).toBe(222);
    expect(velden(a.id).find((v) => v.veld === 'city')?.tijd).toBe(222);
  });

  it('klok en mapping: zonder eigen klok wordt de systeemtijd gebruikt', () => {
    const db = new Database(':memory:');
    migrate(db);
    const voor = Date.now();
    const a = new RelationsService(db).create({ name: 'A' });
    expect(a.gewijzigd_op).toBeGreaterThanOrEqual(voor);
    expect(a.gewijzigd_op).toBeLessThanOrEqual(Date.now());
  });

  it('klok en mapping: de bron is pc bij elke lokale wijziging', () => {
    const { service, db } = metService();
    const a = service.create({ name: 'A' });
    service.update(a.id, { city: 'X' });
    service.archive(a.id);
    const bronnen = [
      ...(db.prepare('SELECT bron FROM relation_field_rev').all() as { bron: string }[]),
      ...(db.prepare('SELECT bron FROM relation_changelog').all() as { bron: string }[]),
    ].map((r) => r.bron);
    expect(bronnen.length).toBeGreaterThan(0);
    expect(new Set(bronnen)).toEqual(new Set(['pc']));
  });

  it('klok en mapping: archived hoort bij gearchiveerd en elke andere kolom bij zichzelf', () => {
    expect(RELATIE_VELD_MAPPING.archived).toBe('gearchiveerd');
    const { archived, ...rest } = RELATIE_VELD_MAPPING;
    void archived;
    for (const [kolom, veld] of Object.entries(rest)) expect(veld).toBe(kolom);
    expect(Object.keys(rest)).toEqual(['type', 'name', 'contact_name', 'email', 'phone', 'address', 'postcode', 'city', 'country', 'vat_number', 'kvk_number', 'iban', 'payment_term_days', 'notes']);
  });
});

describe('Wijzigingsnummers van klanten', () => {
  it('teller: twee klanten krijgen nooit hetzelfde nummer, ook niet na updates en archiveringen', () => {
    const { service, db } = metService();
    const a = service.create({ name: 'A' });
    const b = service.create({ name: 'B' });
    const c = service.create({ name: 'C' });
    service.update(a.id, { city: 'X' });
    service.update(b.id, { city: 'Y' });
    service.archive(c.id);
    service.update(a.id, { city: 'Z' });
    service.archive(b.id);
    const nummers = (db.prepare('SELECT sync_seq FROM relations').all() as { sync_seq: number }[]).map((r) => r.sync_seq);
    expect(new Set(nummers).size).toBe(3);
    expect(Math.min(...nummers)).toBeGreaterThan(0);
  });

  it('teller: elke echte wijziging verhoogt de teller met precies een', () => {
    const { service, volgnummer } = metService();
    const a = service.create({ name: 'A' });
    expect(volgnummer()).toBe(1);
    service.update(a.id, { city: 'X', phone: '0201234567' });
    expect(volgnummer()).toBe(2);
    service.archive(a.id);
    expect(volgnummer()).toBe(3);
    expect(service.get(a.id).sync_seq).toBe(3);
  });
});

describe('Geweigerde schrijfacties', () => {
  function toestand(db: Database.Database) {
    return {
      relations: db.prepare('SELECT * FROM relations ORDER BY id').all(),
      velden: db.prepare('SELECT * FROM relation_field_rev ORDER BY relation_id, veld').all(),
      log: db.prepare('SELECT * FROM relation_changelog ORDER BY id').all(),
      teller: db.prepare('SELECT * FROM sync_teller').all(),
    };
  }

  it('geweigerd: een update met een ongeldig e-mailadres laat alles ongewijzigd', () => {
    const { service, db } = metService();
    const a = service.create({ name: 'Jansen', city: 'Utrecht' });
    const voor = toestand(db);
    expect(() => service.update(a.id, { city: 'Zeist', email: 'geen-email' })).toThrow(ValidationError);
    expect(toestand(db)).toEqual(voor);
  });

  it('geweigerd: een create met een lege naam laat alles ongewijzigd', () => {
    const { service, db } = metService();
    service.create({ name: 'Jansen' });
    const voor = toestand(db);
    expect(() => service.create({ name: '   ' })).toThrow(/Naam is verplicht/);
    expect(toestand(db)).toEqual(voor);
  });
});

describe('Fout na de schrijfactie', () => {
  function breekLogboek(db: Database.Database) {
    db.exec(`CREATE TRIGGER stop_logboek BEFORE INSERT ON relation_changelog BEGIN SELECT RAISE(ABORT, 'logboek vol'); END`);
  }
  function toestand(db: Database.Database) {
    return {
      relations: db.prepare('SELECT * FROM relations ORDER BY id').all(),
      velden: db.prepare('SELECT * FROM relation_field_rev ORDER BY relation_id, veld').all(),
      log: db.prepare('SELECT * FROM relation_changelog ORDER BY id').all(),
      teller: db.prepare('SELECT * FROM sync_teller').all(),
    };
  }

  it('terugrollen: een fout in het logboek rolt een create helemaal terug', () => {
    const { service, db } = metService();
    service.create({ name: 'Bestaand' });
    const voor = toestand(db);
    breekLogboek(db);
    expect(() => service.create({ name: 'Nieuw', city: 'Zeist' })).toThrow(/logboek vol/);
    expect(toestand(db)).toEqual(voor);
    expect(db.inTransaction).toBe(false);
  });

  it('terugrollen: een fout in het logboek rolt een update helemaal terug', () => {
    const { service, db } = metService();
    const a = service.create({ name: 'Jansen', city: 'Utrecht' });
    const voor = toestand(db);
    breekLogboek(db);
    expect(() => service.update(a.id, { city: 'Zeist' })).toThrow(/logboek vol/);
    expect(toestand(db)).toEqual(voor);
    expect(service.get(a.id)).toMatchObject({ revisie: 1, city: 'Utrecht', sync_seq: a.sync_seq, gewijzigd_op: a.gewijzigd_op });
  });

  it('terugrollen: een fout in het logboek rolt een archive helemaal terug', () => {
    const { service, db } = metService();
    const a = service.create({ name: 'Jansen' });
    const voor = toestand(db);
    breekLogboek(db);
    expect(() => service.archive(a.id)).toThrow(/logboek vol/);
    expect(toestand(db)).toEqual(voor);
    expect(service.get(a.id)).toMatchObject({ archived: 0, revisie: 1 });
  });

  it('terugrollen: ook binnen de transactie van een aanroeper blijft de rest van die transactie intact', () => {
    const { service, db } = metService();
    service.create({ name: 'Bestaand' });
    breekLogboek(db);
    db.transaction(() => {
      expect(() => service.create({ name: 'Mislukt' })).toThrow(/logboek vol/);
    })();
    expect((db.prepare('SELECT COUNT(*) AS n FROM relations').get() as { n: number }).n).toBe(1);
  });
});

describe('Bestaande routes naar klanten', () => {
  it('bestaande routes: een leverancier via een snelle uitgave krijgt uuid, revisie 1 en een wijzigingsnummer', () => {
    const { s, db } = setup();
    s.quick.recordExpense({ date: '2026-07-12', supplierName: 'Gamma', description: 'Verf', categoryKey: 'materiaal', grossAmount: 12100, vatCode: 'hoog', paidWith: 'kas' });
    const g = db.prepare(`SELECT uuid, revisie, sync_seq FROM relations WHERE name = 'Gamma'`).get() as { uuid: string; revisie: number; sync_seq: number };
    expect(g.uuid).toMatch(UUID_V4);
    expect(g.revisie).toBe(1);
    expect(g.sync_seq).toBeGreaterThan(0);
  });

  it('bestaande routes: een leverancier via het bonnetje en een klant via de service krijgen elk een eigen uuid', async () => {
    const { s, db } = setup();
    const d = await s.intake.add('b1.jpg', new Uint8Array([1]), '2026-09-25');
    s.intake.confirm(d.id, { supplier: 'Bouwmaat', date: '2026-09-10', total: 12100, categoryKey: 'materiaal', vatCode: 'hoog', business: true, paidWith: 'kas' });
    s.quick.recordExpense({ date: '2026-07-12', supplierName: 'Hornbach', description: 'Steiger', categoryKey: 'gereedschap', grossAmount: 60500, vatCode: 'hoog', paidWith: 'kas' });
    const rijen = db.prepare(`SELECT name, uuid, revisie, sync_seq FROM relations WHERE name IN ('Bouwmaat', 'Hornbach', 'Familie Jansen')`).all() as { name: string; uuid: string; revisie: number; sync_seq: number }[];
    expect(rijen.map((r) => r.name).sort()).toEqual(['Bouwmaat', 'Familie Jansen', 'Hornbach']);
    for (const r of rijen) {
      expect(r.uuid).toMatch(UUID_V4);
      expect(r.revisie).toBe(1);
      expect(r.sync_seq).toBeGreaterThan(0);
    }
    expect(new Set(rijen.map((r) => r.uuid)).size).toBe(3);
    expect(new Set(rijen.map((r) => r.sync_seq)).size).toBe(3);
  });
});
