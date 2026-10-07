import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from '../src/db/database';
import { migrations } from '../src/db/migrations';
import { setup } from './helpers';
import { Bonnenscanner, type ScannerDeps } from '../src/scanner/scanner';
import { PHONE_SCANNER } from '../src/shared/phone-scanner';
import { CONTENT_TYPE, ENDPOINT_PATH, LIMITS, decodePairing, encodeFrame, openResponse, sealRequest, type PairingPayload, type ProtocolVersion } from '../src/scanner/protocol';
import { RelationsService } from '../src/relations/relations';
import { SyncOntvangst } from '../src/sync/ontvangst';
import { veldOndergrens } from '../src/sync/ondergrens';

// Klantwijzigingen van de telefoon worden bewaard (docs/bonnenscanner-protocol.md): per veld
// gecontroleerd, idempotent op (apparaat, entiteit, uuid, revisie), per veld samengevoegd op tijd en
// bron, en in een transactie opgeslagen. De tests lopen via de receiver (versleutelde berichten over
// het loopback-netwerk) en kijken daarna in de database.

const LOOPBACK = [{ address: '127.0.0.1', netmask: '255.0.0.0' }];
const MINUUT = 60 * 1000;

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

function start(extra: Partial<ScannerDeps> = {}) {
  const t = setup();
  const spoolDir = mkdtempSync(join(tmpdir(), 'bvn-sync-klanten-'));
  dirs.push(spoolDir);
  const clock = { now: Date.now() };
  const scanner = new Bonnenscanner({ db: t.db, secrets: t.secrets, intake: t.s.intake, settings: t.s.settings, spoolDir, interfaces: () => LOOPBACK, now: () => clock.now, ...extra });
  open.push(scanner);
  return { ...t, scanner, clock };
}
type Admin = ReturnType<typeof start>;

interface Reply {
  status: number;
  sealed: boolean;
  json: Record<string, unknown> | null;
}

/** De telefoon: stuurt versleutelde berichten van protocolversie 2. */
function phone(pairing: PairingPayload, clock: { now: number }) {
  const key = Buffer.from(pairing.sleutel, 'base64url');
  const deviceId = Buffer.from(pairing.apparaat, 'base64url');
  const url = `http://${pairing.adressen[0]}:${pairing.poort}${ENDPOINT_PATH}`;
  const verstuur = async (json: Record<string, unknown>, versie: ProtocolVersion = 2): Promise<Reply> => {
    const nonce = randomBytes(12);
    const body = sealRequest(deviceId, key, encodeFrame(json, []), nonce, versie);
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': CONTENT_TYPE }, body: new Uint8Array(body) });
    const raw = Buffer.from(await res.arrayBuffer());
    if ((res.headers.get('content-type') ?? '') === CONTENT_TYPE) {
      const json2 = openResponse(raw, key, nonce);
      return { status: res.status, sealed: json2 !== null, json: json2 };
    }
    return { status: res.status, sealed: false, json: raw.length ? (JSON.parse(raw.toString('utf8')) as Record<string, unknown>) : null };
  };
  const hallo = (naam = 'Pixel van Piet') => verstuur({ soort: 'hallo', tijd: clock.now, naam, app: '1.0.0' });
  const wijziging = (over: Record<string, unknown> = {}) =>
    verstuur({ soort: 'wijziging', tijd: clock.now, wijziging: { entiteit: 'klant', uuid: randomUUID(), revisie: 1, tijd: clock.now, velden: { naam: 'Familie Jansen' }, ...over } });
  return { verstuur, hallo, wijziging };
}
type Telefoon = ReturnType<typeof phone>;

async function koppel(t: Admin): Promise<Telefoon> {
  const started = await t.scanner.pair();
  const p = phone(decodePairing(started.payload), t.clock);
  // een eerste bericht geeft de telefoon zijn apparaatcode: de eerste die hallo zegt is M1, de volgende M2
  expect((await p.hallo()).status).toBe(200);
  return p;
}

const n = (t: Admin, sql: string) => (t.db.prepare(sql).get() as { n: number }).n;
/** Het aantal rijen in de tabellen waar een telefoonwijziging iets achterlaat. */
function telling(t: Admin) {
  return {
    relations: n(t, 'SELECT COUNT(*) AS n FROM relations'),
    relation_changelog: n(t, 'SELECT COUNT(*) AS n FROM relation_changelog'),
    relation_field_rev: n(t, 'SELECT COUNT(*) AS n FROM relation_field_rev'),
    sync_ontvangen: n(t, 'SELECT COUNT(*) AS n FROM sync_ontvangen'),
    relation_aliases: n(t, 'SELECT COUNT(*) AS n FROM relation_aliases'),
  };
}
const teller = (t: Admin) => (t.db.prepare(`SELECT waarde FROM sync_teller WHERE naam = 'wijziging'`).get() as { waarde: number }).waarde;
const klantRij = (t: Admin, uuid: string) => t.db.prepare('SELECT * FROM relations WHERE uuid = ?').get(uuid) as Record<string, unknown> | undefined;

/** Een bestaande klant van de pc met een eigen uuid en zonder rijen in relation_field_rev (zoals van vóór de sync). */
function pcKlant(t: Admin, uuid: string, over: { name?: string; type?: string; created_at?: string; email?: string | null; city?: string | null } = {}): number {
  const r = t.db
    .prepare(`INSERT INTO relations (type, name, email, city, created_at, uuid, revisie, gewijzigd_op, sync_seq) VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?)`)
    .run(over.type ?? 'klant', over.name ?? 'Oud Bedrijf', over.email ?? null, over.city ?? null, over.created_at ?? '2020-01-01 00:00:00', uuid, teller(t) + 1);
  t.db.prepare(`UPDATE sync_teller SET waarde = waarde + 1 WHERE naam = 'wijziging'`).run();
  return Number(r.lastInsertRowid);
}

describe('sync_ontvangen schema en de ondergrens voor velden', () => {
  it('sync_ontvangen schema: de migratie voegt alleen de tabel toe, met de juiste sleutel en kolommen', () => {
    const i = migrations.findIndex((m) => /CREATE TABLE (IF NOT EXISTS )?sync_ontvangen\b/.test(m));
    expect(i).toBeGreaterThan(0);
    const db = new Database(':memory:');
    for (const m of migrations.slice(0, i)) db.exec(m);
    db.pragma(`user_version = ${i}`);
    const tabel = (naam: string) => db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(naam);
    expect(tabel('sync_ontvangen')).toBeUndefined();
    // een klant van voor de migratie blijft ongemoeid
    db.prepare(`INSERT INTO relations (type, name) VALUES ('klant', 'Oud')`).run();
    migrate(db);
    expect(tabel('sync_ontvangen')).toBeDefined();
    expect(db.pragma('user_version', { simple: true })).toBe(migrations.length);
    const kolommen = db.prepare('PRAGMA table_info(sync_ontvangen)').all() as { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }[];
    expect(kolommen.map((k) => k.name)).toEqual(['apparaat_id', 'entiteit', 'uuid', 'revisie', 'tijd', 'ontvangen_op', 'uitkomst', 'fout', 'route']);
    // de sleutelvolgorde: apparaat, entiteit, uuid, revisie
    expect(kolommen.filter((k) => k.pk > 0).sort((a, b) => a.pk - b.pk).map((k) => k.name)).toEqual(['apparaat_id', 'entiteit', 'uuid', 'revisie']);
    for (const naam of ['tijd', 'ontvangen_op']) expect(kolommen.find((k) => k.name === naam)?.type).toBe('INTEGER');
    expect(kolommen.find((k) => k.name === 'uitkomst')?.type).toBe('TEXT');
    expect(kolommen.find((k) => k.name === 'fout')?.notnull).toBe(0);
    const route = kolommen.find((k) => k.name === 'route')!;
    expect([route.notnull, route.dflt_value]).toEqual([1, `'netwerk'`]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sync_ontvangen').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT name FROM relations').all()).toEqual([{ name: 'Oud' }]);
    // nog een keer migreren verandert niets
    migrate(db);
    expect(db.pragma('user_version', { simple: true })).toBe(migrations.length);
  });

  it('sync_ontvangen schema: de migratie op een al gevulde database opnieuw draaien laat de rijen staan', () => {
    const i = migrations.findIndex((m) => /CREATE TABLE (IF NOT EXISTS )?sync_ontvangen\b/.test(m));
    const db = new Database(':memory:');
    migrate(db);
    db.prepare(`INSERT INTO sync_ontvangen (apparaat_id, entiteit, uuid, revisie, tijd, ontvangen_op, uitkomst) VALUES ('a', 'klant', 'u', 1, 1, 2, 'toegepast')`).run();
    db.pragma(`user_version = ${i}`);
    migrate(db);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sync_ontvangen').get()).toEqual({ n: 1 });
    expect(db.pragma('user_version', { simple: true })).toBe(migrations.length);
    // dezelfde sleutel kan er niet twee keer in
    expect(() => db.prepare(`INSERT INTO sync_ontvangen (apparaat_id, entiteit, uuid, revisie) VALUES ('a', 'klant', 'u', 1)`).run()).toThrow(/UNIQUE|PRIMARY/);
  });

  it('de ondergrens van een veld zonder rij is created_at gelezen als UTC, in milliseconden', () => {
    expect(veldOndergrens('2026-03-01 12:00:00')).toBe(Date.UTC(2026, 2, 1, 12, 0, 0));
    expect(veldOndergrens('1999-12-31 23:59:59')).toBe(Date.UTC(1999, 11, 31, 23, 59, 59));
    // SQLite's eigen datetime('now') geeft precies dit formaat
    const db = new Database(':memory:');
    const nu = (db.prepare(`SELECT datetime('now') AS t`).get() as { t: string }).t;
    expect(Math.abs(veldOndergrens(nu) - Date.now())).toBeLessThan(5000);
    expect(veldOndergrens(nu)).toBe(Date.parse(nu.replace(' ', 'T') + 'Z'));
  });

  it('de ondergrens weigert een tekst die geen UTC-tijd van SQLite is', () => {
    expect(() => veldOndergrens('gisteren')).toThrow(/UTC-tijd/);
    expect(() => veldOndergrens('')).toThrow();
  });

  it('SyncOntvangst gebruikt een register dat niet van de route afhangt: dezelfde sleutel via map en netwerk is een rij', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    const sync = new SyncOntvangst(db, new RelationsService(db), { now: () => 5000 });
    const wijziging = { entiteit: 'klant' as const, uuid: randomUUID(), revisie: 1, tijd: 1000, velden: Object.assign(Object.create(null) as Record<string, unknown>, { naam: 'Via de map' }) };
    expect(sync.verwerk('apparaat-1', 'M1', wijziging, 'map')).toEqual({ status: 200, uitkomst: 'toegepast' });
    expect(sync.verwerk('apparaat-1', 'M1', wijziging, 'netwerk')).toEqual({ status: 200, uitkomst: 'overgeslagen' });
    expect(db.prepare('SELECT route, ontvangen_op, tijd, uitkomst FROM sync_ontvangen').all()).toEqual([{ route: 'map', ontvangen_op: 5000, tijd: 1000, uitkomst: 'toegepast' }]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM relations').get()).toEqual({ n: 1 });
  });
});
