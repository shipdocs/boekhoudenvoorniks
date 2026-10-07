import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/database';
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
    expect(db.prepare('SELECT naam, waarde FROM sync_teller').all()).toEqual([{ naam: 'wijziging', waarde: c }]);
  });

  it('migratie: zonder klanten begint de wijzigingsteller op 0', () => {
    const db = oudeToestand();
    migrate(db);
    expect(db.prepare('SELECT naam, waarde FROM sync_teller').all()).toEqual([{ naam: 'wijziging', waarde: 0 }]);
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
