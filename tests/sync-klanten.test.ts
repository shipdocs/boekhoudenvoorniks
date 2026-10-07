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
/** een vaste pc-klok, zodat twee administraties met dezelfde berichten dezelfde tijden krijgen */
const VAST = Date.UTC(2026, 9, 7, 12, 0, 0);

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

describe('een klant van de telefoon bewaren', () => {
  it('een nieuwe klant krijgt de uuid van de telefoon, type klant, land NL en een rij per veld met de apparaatcode als bron', async () => {
    const t = start();
    const p = await koppel(t);
    const uuid = randomUUID();
    const tijd = t.clock.now - 3 * 24 * 60 * MINUUT;
    const voor = telling(t);
    const r = await p.wijziging({ uuid, tijd, velden: { naam: '  Familie Jansen ', email: 'JANSEN@example.nl', postcode: '3511  aa', betaaltermijn_dagen: 14 } });
    expect(r).toMatchObject({ status: 200, sealed: true, json: { ok: true, soort: 'wijziging', uuid, revisie: 1, uitkomst: 'toegepast' } });
    expect(klantRij(t, uuid)).toMatchObject({ type: 'klant', name: 'Familie Jansen', email: 'JANSEN@example.nl', postcode: '3511 AA', payment_term_days: 14, country: 'NL', archived: 0, revisie: 1, gewijzigd_op: tijd });
    const id = klantRij(t, uuid)!.id as number;
    // de bron is de apparaatcode, nooit het deviceId; de tijd is de bewerktijd van de telefoon
    expect(t.db.prepare(`SELECT veld, tijd, bron FROM relation_field_rev WHERE relation_id = ? AND bron <> '' ORDER BY veld`).all(id)).toEqual([
      { veld: 'email', tijd, bron: 'M1' },
      { veld: 'name', tijd, bron: 'M1' },
      { veld: 'payment_term_days', tijd, bron: 'M1' },
      { veld: 'postcode', tijd, bron: 'M1' },
    ]);
    // de andere tien velden krijgen een lege plaatsvervanger (tijd 0) en geen logregel
    expect(t.db.prepare(`SELECT COUNT(*) AS n FROM relation_field_rev WHERE relation_id = ? AND tijd = 0 AND bron = ''`).get(id)).toEqual({ n: 10 });
    expect(t.db.prepare('SELECT veld, oud, nieuw, revisie, bron, tijd FROM relation_changelog WHERE relation_id = ? ORDER BY id').all(id)).toEqual([
      { veld: 'name', oud: null, nieuw: 'Familie Jansen', revisie: 1, bron: 'M1', tijd },
      { veld: 'email', oud: null, nieuw: 'JANSEN@example.nl', revisie: 1, bron: 'M1', tijd },
      { veld: 'postcode', oud: null, nieuw: '3511 AA', revisie: 1, bron: 'M1', tijd },
      { veld: 'payment_term_days', oud: null, nieuw: '14', revisie: 1, bron: 'M1', tijd },
    ]);
    expect(telling(t)).toMatchObject({ relations: voor.relations + 1, relation_changelog: voor.relation_changelog + 4, relation_field_rev: voor.relation_field_rev + 14, sync_ontvangen: voor.sync_ontvangen + 1 });
  });

  it('een revisie die vóór het aanmaken van de klant is gemaakt maar later aankomt, vult de velden die nog leeg waren', async () => {
    const t = start();
    const p = await koppel(t);
    const uuid = randomUUID();
    const nu = t.clock.now;
    // revisie 2 komt eerst aan en maakt de klant; revisie 1 (ouder) voegt een veld toe dat revisie 2 niet noemt
    await p.wijziging({ uuid, revisie: 2, tijd: nu - 1000, velden: { naam: 'Tweede' } });
    const r = await p.wijziging({ uuid, revisie: 1, tijd: nu - 5000, velden: { naam: 'Eerste', plaats: 'Zwolle' } });
    expect(r.json).toMatchObject({ uitkomst: 'toegepast' });
    expect(klantRij(t, uuid)).toMatchObject({ name: 'Tweede', city: 'Zwolle' });
  });

  it('lege tekst wordt null en een optioneel veld mag null zijn', async () => {
    const t = start();
    const p = await koppel(t);
    const uuid = randomUUID();
    await p.wijziging({ uuid, velden: { naam: 'Leeg', email: '   ', plaats: null, contactpersoon: '' } });
    expect(klantRij(t, uuid)).toMatchObject({ name: 'Leeg', email: null, city: null, contact_name: null });
  });
});

describe('een ongeldige wijziging laat niets achter', () => {
  const geen = (voor: ReturnType<typeof telling>, na: ReturnType<typeof telling>) => expect(na).toEqual(voor);

  it('geen rijen: een veld buiten het schema geeft 400 veld-ongeldig, ook type, paid_with, id en uuid', async () => {
    const t = start();
    const p = await koppel(t);
    const voor = telling(t);
    const seq = teller(t);
    for (const veld of ['type', 'paid_with', 'id', 'uuid', 'revisie', 'bedrijfsnaam']) {
      const r = await p.wijziging({ velden: { naam: 'Jansen', [veld]: 'x' } });
      expect(r, veld).toMatchObject({ status: 400, sealed: true, json: { ok: false, fout: 'veld-ongeldig', veld } });
    }
    geen(voor, telling(t));
    expect(teller(t)).toBe(seq);
  });

  it('geen rijen: een ongeldige e-mail geeft 400 veld-ongeldig', async () => {
    const t = start();
    const p = await koppel(t);
    const voor = telling(t);
    const seq = teller(t);
    const r = await p.wijziging({ velden: { naam: 'Jansen', email: 'geen-email' } });
    expect(r).toMatchObject({ status: 400, json: { ok: false, fout: 'veld-ongeldig', veld: 'email' } });
    geen(voor, telling(t));
    expect(teller(t)).toBe(seq);
    expect(Object.keys(r.json!).sort()).toEqual(['fout', 'melding', 'ok', 'veld']);
  });

  it('geen rijen: een lege naam, een te lange tekst en een betaaltermijn buiten de grenzen geven 400', async () => {
    const t = start();
    const p = await koppel(t);
    const voor = telling(t);
    const gevallen: [string, Record<string, unknown>][] = [
      ['naam', { naam: '   ' }],
      ['naam', { naam: null }],
      ['adres', { naam: 'Jansen', adres: 'x'.repeat(501) }],
      ['betaaltermijn_dagen', { naam: 'Jansen', betaaltermijn_dagen: 366 }],
      ['betaaltermijn_dagen', { naam: 'Jansen', betaaltermijn_dagen: -1 }],
      ['gearchiveerd', { naam: 'Jansen', gearchiveerd: 2 }],
      ['iban', { naam: 'Jansen', iban: 'NL00BANK0000000000' }],
      ['btw_nummer', { naam: 'Jansen', btw_nummer: 'XX' }],
      ['land', { naam: 'Jansen', land: 'Atlantis' }],
      ['kvk_nummer', { naam: 'Jansen', kvk_nummer: '!' }],
    ];
    for (const [veld, velden] of gevallen) {
      const r = await p.wijziging({ velden });
      expect(r, veld).toMatchObject({ status: 400, json: { ok: false, fout: 'veld-ongeldig', veld } });
    }
    geen(voor, telling(t));
  });

  it('de veldnaam in de foutmelding: de melding noemt het veld bij naam, in het Nederlands', async () => {
    const t = start();
    const p = await koppel(t);
    for (const [veld, waarde] of [['email', 'x'], ['iban', 'abc'], ['btw_nummer', '1'], ['betaaltermijn_dagen', 999], ['bedrijfsnaam', 'x'], ['adres', 'y'.repeat(501)]] as const) {
      const r = await p.wijziging({ velden: { naam: 'Jansen', [veld]: waarde } });
      expect(r.status, veld).toBe(400);
      expect(r.json!.veld, veld).toBe(veld);
      expect(String(r.json!.melding), veld).toContain(veld);
      expect(String(r.json!.melding).length, veld).toBeGreaterThan(veld.length + 10);
    }
  });

  it('geen rijen: een wijziging op een bestaande klant met een ongeldig veld laat alle velden van die wijziging liggen', async () => {
    const t = start();
    const p = await koppel(t);
    const uuid = randomUUID();
    pcKlant(t, uuid, { email: 'oud@example.nl', city: 'Oudstad' });
    const voor = telling(t);
    const seq = teller(t);
    const r = await p.wijziging({ uuid, velden: { plaats: 'Nieuwstad', email: 'kapot' } });
    expect(r.status).toBe(400);
    expect(klantRij(t, uuid)).toMatchObject({ city: 'Oudstad', email: 'oud@example.nl', revisie: 1 });
    geen(voor, telling(t));
    expect(teller(t)).toBe(seq);
  });

  it('onbekende klant zonder naam geeft 409 klant-onbekend en geen rijen', async () => {
    const t = start();
    const p = await koppel(t);
    const voor = telling(t);
    const seq = teller(t);
    const uuid = randomUUID();
    const r = await p.wijziging({ uuid, velden: { plaats: 'Zwolle' } });
    expect(r).toMatchObject({ status: 409, sealed: true, json: { ok: false, fout: 'klant-onbekend' } });
    expect(klantRij(t, uuid)).toBeUndefined();
    geen(voor, telling(t));
    expect(teller(t)).toBe(seq);
    // een lege wijziging op een onbekende uuid ook
    expect((await p.wijziging({ velden: {} })).status).toBe(409);
    geen(voor, telling(t));
  });
});

describe('idempotent en per veld samengevoegd', () => {
  it('twee nonces: dezelfde wijziging geeft een klant, een logboekregel per veld en een registerrij; het tweede antwoord is overgeslagen', async () => {
    const t = start();
    const p = await koppel(t);
    const uuid = randomUUID();
    const w = { uuid, revisie: 1, tijd: t.clock.now - 1000, velden: { naam: 'Dubbel', email: 'dubbel@example.nl' } };
    const voor = telling(t);
    const een = await p.wijziging(w);
    const seq = teller(t);
    const twee = await p.wijziging(w);
    expect(een.json).toMatchObject({ ok: true, uitkomst: 'toegepast' });
    expect(twee).toMatchObject({ status: 200, json: { ok: true, soort: 'wijziging', uuid, revisie: 1, uitkomst: 'overgeslagen' } });
    expect(telling(t)).toMatchObject({ relations: voor.relations + 1, relation_changelog: voor.relation_changelog + 2, relation_field_rev: voor.relation_field_rev + 14, sync_ontvangen: voor.sync_ontvangen + 1 });
    expect(teller(t)).toBe(seq);
    // het register onthoudt de eerste verwerking
    expect(t.db.prepare('SELECT entiteit, uuid, revisie, tijd, ontvangen_op, uitkomst, fout, route FROM sync_ontvangen WHERE uuid = ?').all(uuid)).toEqual([
      { entiteit: 'klant', uuid, revisie: 1, tijd: w.tijd, ontvangen_op: t.clock.now, uitkomst: 'toegepast', fout: null, route: 'netwerk' },
    ]);
  });

  async function tweeApparaten(volgorde: 'ab' | 'ba', uuid: string) {
    const t = start();
    t.clock.now = VAST;
    const a = await koppel(t);
    const b = await koppel(t);
    pcKlant(t, uuid, { name: 'Oud Bedrijf' });
    const nu = t.clock.now;
    const sturen = {
      a: () => a.wijziging({ uuid, revisie: 1, tijd: nu - 4000, velden: { email: 'a@example.nl', plaats: 'Plaats A', telefoon: '111' } }),
      b: () => b.wijziging({ uuid, revisie: 1, tijd: nu - 2000, velden: { plaats: 'Plaats B', notities: 'van B', naam: 'Nieuwe naam' } }),
    };
    for (const x of volgorde) expect((await sturen[x as 'a' | 'b']()).status).toBe(200);
    const klant = klantRij(t, uuid)!;
    const { id, ...rest } = klant;
    return { rest, velden: t.db.prepare('SELECT veld, tijd, bron FROM relation_field_rev WHERE relation_id = ? ORDER BY veld').all(id) };
  }

  it('omgekeerde volgorde: twee apparaten met verschillende velden geven dezelfde eindtoestand', async () => {
    const uuid = randomUUID();
    const ab = await tweeApparaten('ab', uuid);
    const ba = await tweeApparaten('ba', uuid);
    expect(ab.rest.email).toBe('a@example.nl');
    expect(ab.rest.city).toBe('Plaats B'); // het nieuwste veld wint, wie het ook stuurt
    expect(ab.rest.phone).toBe('111');
    expect(ab.rest.notes).toBe('van B');
    expect(ab.rest.name).toBe('Nieuwe naam');
    // alles gelijk, ook de tijd en bron per veld en de revisie van de rij; alleen created_at is gelijk omdat pcKlant hem vastzet
    expect(ba.rest).toEqual(ab.rest);
    expect(ba.velden).toEqual(ab.velden);
    expect(ab.velden).toContainEqual({ veld: 'city', tijd: expect.any(Number), bron: 'M2' });
  });

  it('revisie 2 voor revisie 1: een latere revisie die eerst aankomt wint per veld op tijd, niet op revisie', async () => {
    const eind = async (volgorde: (1 | 2)[]) => {
      const t = start();
      t.clock.now = VAST;
      const p = await koppel(t);
      const uuid = randomUUID();
      const nu = t.clock.now;
      const sturen = {
        1: () => p.wijziging({ uuid, revisie: 1, tijd: nu - 5000, velden: { naam: 'Eerste naam', plaats: 'Eerste plaats', telefoon: '1' } }),
        2: () => p.wijziging({ uuid, revisie: 2, tijd: nu - 1000, velden: { naam: 'Tweede naam', plaats: 'Tweede plaats' } }),
      };
      const uitkomsten: unknown[] = [];
      for (const r of volgorde) uitkomsten.push((await sturen[r]()).json!.uitkomst);
      const { id, ...rest } = klantRij(t, uuid)!;
      return { rest, uitkomsten, velden: t.db.prepare('SELECT veld, tijd, bron FROM relation_field_rev WHERE relation_id = ? ORDER BY veld').all(id) };
    };
    const normaal = await eind([1, 2]);
    const omgekeerd = await eind([2, 1]);
    expect(normaal.rest).toMatchObject({ name: 'Tweede naam', city: 'Tweede plaats', phone: '1' });
    // revisie 1 komt als tweede: naam en plaats zijn ouder en worden overgeslagen, alleen de telefoon (die revisie 2 niet noemt) wordt toegepast
    expect(omgekeerd.uitkomsten).toEqual(['toegepast', 'toegepast']);
    expect(normaal.uitkomsten).toEqual(['toegepast', 'toegepast']);
    expect(omgekeerd.rest).toMatchObject({ name: 'Tweede naam', city: 'Tweede plaats', phone: '1' });
    expect(omgekeerd.velden).toEqual(normaal.velden);
    expect(omgekeerd.rest.revisie).toBe(normaal.rest.revisie);
  });

  it('revisie 2 voor revisie 1: een revisie waarvan alle velden ouder zijn is overgeslagen en laat de teller staan', async () => {
    const t = start();
    const p = await koppel(t);
    const uuid = randomUUID();
    const nu = t.clock.now;
    await p.wijziging({ uuid, revisie: 2, tijd: nu - 1000, velden: { naam: 'Tweede', plaats: 'Tweede plaats' } });
    const seq = teller(t);
    const voor = telling(t);
    const r = await p.wijziging({ uuid, revisie: 1, tijd: nu - 9000, velden: { naam: 'Eerste', plaats: 'Eerste plaats' } });
    expect(r.json).toMatchObject({ ok: true, revisie: 1, uitkomst: 'overgeslagen' });
    expect(klantRij(t, uuid)).toMatchObject({ name: 'Tweede', city: 'Tweede plaats', revisie: 1 });
    expect(teller(t)).toBe(seq);
    // wel een registerrij, voor de exacte sleutel van revisie 1, en geen logboekregel
    expect(telling(t)).toEqual({ ...voor, sync_ontvangen: voor.sync_ontvangen + 1 });
    expect(t.db.prepare('SELECT uitkomst FROM sync_ontvangen WHERE uuid = ? AND revisie = 1').get(uuid)).toEqual({ uitkomst: 'overgeslagen' });
  });

  it('land en kvk: een buitenlands handelsregisternummer en een land zijn in beide volgorden goed en geven dezelfde klant', async () => {
    const eind = async (volgorde: ('land' | 'kvk')[]) => {
      const t = start();
      t.clock.now = VAST;
      const p = await koppel(t);
      const uuid = randomUUID();
      pcKlant(t, uuid);
      const nu = t.clock.now;
      const velden = { land: { land: 'de' }, kvk: { kvk_nummer: 'HRB 12345 B' } };
      for (const [i, x] of volgorde.entries()) expect((await p.wijziging({ uuid, revisie: i + 1, tijd: nu - 2000 + i, velden: velden[x] })).status).toBe(200);
      const { id, uuid: _uuid, ...rest } = klantRij(t, uuid)!;
      return rest;
    };
    const landEerst = await eind(['land', 'kvk']);
    const kvkEerst = await eind(['kvk', 'land']);
    expect(landEerst).toMatchObject({ country: 'DE', kvk_number: 'HRB 12345 B' });
    expect(kvkEerst).toEqual(landEerst);
  });

  it('land en kvk: een kvk-nummer van 8 cijfers is goed los van het land, en spaties worden weggehaald', async () => {
    const t = start();
    const p = await koppel(t);
    const uuid = randomUUID();
    const r = await p.wijziging({ uuid, velden: { naam: 'Buitenlands', land: 'BE', kvk_nummer: '1234 5678' } });
    expect(r.json).toMatchObject({ uitkomst: 'toegepast' });
    expect(klantRij(t, uuid)).toMatchObject({ country: 'BE', kvk_number: '12345678' });
  });

  it('gelijke tijd: de grootste bron wint, dus pc wint van M1 en M2 van M1, in elke volgorde', async () => {
    const t = start();
    const p = await koppel(t);
    const uuid = randomUUID();
    const id = pcKlant(t, uuid, { email: 'pc@example.nl' });
    const tijd = t.clock.now - 10_000;
    t.db.prepare(`INSERT INTO relation_field_rev (relation_id, veld, tijd, bron) VALUES (?, 'email', ?, 'pc')`).run(id, tijd);
    const seq = teller(t);
    // dezelfde tijd als de pc: de pc wint van M1
    const r = await p.wijziging({ uuid, tijd, velden: { email: 'm1@example.nl' } });
    expect(r.json).toMatchObject({ uitkomst: 'overgeslagen' });
    expect(klantRij(t, uuid)!.email).toBe('pc@example.nl');
    expect(teller(t)).toBe(seq);
    // twee telefoons met dezelfde tijd op een veld zonder rij: M2 wint van M1, ook als M1 later komt
    const tweede = await koppel(t);
    const ander = randomUUID();
    pcKlant(t, ander);
    const gelijk = t.clock.now - 3000;
    expect((await tweede.wijziging({ uuid: ander, tijd: gelijk, velden: { plaats: 'van M2' } })).json).toMatchObject({ uitkomst: 'toegepast' });
    expect((await p.wijziging({ uuid: ander, tijd: gelijk, velden: { plaats: 'van M1' } })).json).toMatchObject({ uitkomst: 'overgeslagen' });
    expect(klantRij(t, ander)!.city).toBe('van M2');
    expect(t.db.prepare(`SELECT bron FROM relation_field_rev WHERE relation_id = ? AND veld = 'city'`).get(klantRij(t, ander)!.id)).toEqual({ bron: 'M2' });
  });

  it('nieuwere tijd: een pc-wijziging wint alleen van een telefoon met een nieuwere tijd', async () => {
    const t = start();
    const p = await koppel(t);
    const pcKlok = t.clock.now - 60_000;
    const relations = new RelationsService(t.db, () => pcKlok);
    const klant = relations.create({ name: 'Piet', city: 'Eerste stad' });
    relations.update(klant.id, { city: 'Pc-stad' });
    const uuid = klant.uuid!;
    // ouder dan de pc-wijziging: de telefoon verliest
    const ouder = await p.wijziging({ uuid, tijd: pcKlok - 1, velden: { plaats: 'Oude telefoonstad' } });
    expect(ouder.json).toMatchObject({ uitkomst: 'overgeslagen' });
    expect(klantRij(t, uuid)!.city).toBe('Pc-stad');
    // precies even oud: de pc wint op bron
    expect((await p.wijziging({ uuid, revisie: 2, tijd: pcKlok, velden: { plaats: 'Gelijke telefoonstad' } })).json).toMatchObject({ uitkomst: 'overgeslagen' });
    // nieuwer: de telefoon wint, ook al heeft de pc het veld al eerder gezet
    const nieuwer = await p.wijziging({ uuid, revisie: 3, tijd: pcKlok + 1, velden: { plaats: 'Nieuwe telefoonstad' } });
    expect(nieuwer.json).toMatchObject({ uitkomst: 'toegepast' });
    expect(klantRij(t, uuid)!.city).toBe('Nieuwe telefoonstad');
    expect(t.db.prepare(`SELECT tijd, bron FROM relation_field_rev WHERE relation_id = ? AND veld = 'city'`).get(klant.id)).toEqual({ tijd: pcKlok + 1, bron: 'M1' });
  });

  it('voor de migratie: een klant zonder rijen in relation_field_rev wordt niet overschreven door een oudere telefoontijd (veldOndergrens)', async () => {
    const t = start();
    const p = await koppel(t);
    const uuid = randomUUID();
    const aangemaakt = '2026-03-01 12:00:00';
    const grens = Date.UTC(2026, 2, 1, 12, 0, 0);
    pcKlant(t, uuid, { created_at: aangemaakt, email: 'pc@example.nl', city: 'Pc-stad' });
    expect(n(t, `SELECT COUNT(*) AS n FROM relation_field_rev WHERE relation_id = ${klantRij(t, uuid)!.id}`)).toBe(0);
    expect(veldOndergrens(aangemaakt)).toBe(grens);
    const seq = teller(t);
    // een milliseconde vóór het aanmaken door de pc (UTC, niet lokale tijd): verloren
    const oud = await p.wijziging({ uuid, revisie: 1, tijd: grens - 1, velden: { email: 'oud@example.nl', plaats: 'Oudstad' } });
    expect(oud.json).toMatchObject({ uitkomst: 'overgeslagen' });
    // een uur ernaast (de fout van lokaal lezen) wint dus ook niet
    expect((await p.wijziging({ uuid, revisie: 2, tijd: grens - 60 * MINUUT, velden: { email: 'uur@example.nl' } })).json).toMatchObject({ uitkomst: 'overgeslagen' });
    // precies op de grens wint de pc (bron pc is groter dan M1)
    expect((await p.wijziging({ uuid, revisie: 3, tijd: grens, velden: { email: 'grens@example.nl' } })).json).toMatchObject({ uitkomst: 'overgeslagen' });
    expect(klantRij(t, uuid)).toMatchObject({ email: 'pc@example.nl', city: 'Pc-stad', revisie: 1 });
    expect(teller(t)).toBe(seq);
    // een milliseconde erna wint de telefoon
    expect((await p.wijziging({ uuid, revisie: 4, tijd: grens + 1, velden: { email: 'nieuw@example.nl' } })).json).toMatchObject({ uitkomst: 'toegepast' });
    expect(klantRij(t, uuid)).toMatchObject({ email: 'nieuw@example.nl', city: 'Pc-stad', revisie: 2 });
  });

  it('alias: een alias-uuid leidt naar de doelklant en maakt geen nieuwe rij', async () => {
    const t = start();
    const p = await koppel(t);
    const doel = randomUUID();
    const alias = randomUUID();
    const id = pcKlant(t, doel, { name: 'Doelklant' });
    t.db.prepare('INSERT INTO relation_aliases (alias_uuid, relation_id, aangemaakt_op) VALUES (?, ?, ?)').run(alias, id, t.clock.now);
    const voor = telling(t);
    const r = await p.wijziging({ uuid: alias, velden: { plaats: 'Via alias' } });
    expect(r).toMatchObject({ status: 200, json: { ok: true, uuid: alias, uitkomst: 'toegepast' } });
    expect(klantRij(t, doel)).toMatchObject({ city: 'Via alias', revisie: 2, name: 'Doelklant' });
    expect(klantRij(t, alias)).toBeUndefined();
    expect(telling(t)).toMatchObject({ relations: voor.relations, relation_aliases: voor.relation_aliases, sync_ontvangen: voor.sync_ontvangen + 1 });
    // het register bewaart de uuid die de telefoon gebruikte
    expect(t.db.prepare('SELECT uuid FROM sync_ontvangen WHERE uuid = ?').get(alias)).toEqual({ uuid: alias });
  });

  it('alias: een wijziging met naam op een alias-uuid maakt ook geen nieuwe klant', async () => {
    const t = start();
    const p = await koppel(t);
    const doel = randomUUID();
    const alias = randomUUID();
    const id = pcKlant(t, doel);
    t.db.prepare('INSERT INTO relation_aliases (alias_uuid, relation_id, aangemaakt_op) VALUES (?, ?, ?)').run(alias, id, t.clock.now);
    const voor = telling(t);
    await p.wijziging({ uuid: alias, velden: { naam: 'Nieuwe naam via alias' } });
    expect(telling(t).relations).toBe(voor.relations);
    expect(klantRij(t, doel)!.name).toBe('Nieuwe naam via alias');
  });

  it('leverancier: een wijziging op een leverancier is 200 afgewezen met fout geen-klant, een registerrij en niets gewijzigd', async () => {
    const t = start();
    const p = await koppel(t);
    const uuid = randomUUID();
    pcKlant(t, uuid, { type: 'leverancier', name: 'Groothandel', city: 'Rotterdam' });
    const voor = telling(t);
    const seq = teller(t);
    const r = await p.wijziging({ uuid, velden: { plaats: 'Amsterdam' } });
    expect(r).toMatchObject({ status: 200, sealed: true, json: { ok: true, soort: 'wijziging', uuid, revisie: 1, uitkomst: 'afgewezen', fout: 'geen-klant' } });
    expect(klantRij(t, uuid)).toMatchObject({ city: 'Rotterdam', revisie: 1 });
    expect(telling(t)).toEqual({ ...voor, sync_ontvangen: voor.sync_ontvangen + 1 });
    expect(teller(t)).toBe(seq);
    expect(t.db.prepare('SELECT uitkomst, fout FROM sync_ontvangen WHERE uuid = ?').get(uuid)).toEqual({ uitkomst: 'afgewezen', fout: 'geen-klant' });
    // een klant van type beide mag wel
    const beide = randomUUID();
    pcKlant(t, beide, { type: 'beide' });
    expect((await p.wijziging({ uuid: beide, velden: { plaats: 'Delft' } })).json).toMatchObject({ uitkomst: 'toegepast' });
  });

  it('afgewezen herhaling: dezelfde afgewezen sleutel nog eens geeft 200 afgewezen met dezelfde fout en geen nieuwe registerrij', async () => {
    const t = start();
    const p = await koppel(t);
    const uuid = randomUUID();
    pcKlant(t, uuid, { type: 'leverancier' });
    const w = { uuid, revisie: 1, tijd: t.clock.now - 500, velden: { plaats: 'Amsterdam' } };
    const eerste = await p.wijziging(w);
    const voor = telling(t);
    const opnieuw = await p.wijziging({ ...w, velden: { plaats: 'Andere inhoud, zelfde sleutel' } });
    expect(eerste.json).toMatchObject({ uitkomst: 'afgewezen', fout: 'geen-klant' });
    expect(opnieuw).toMatchObject({ status: 200, json: { ok: true, uuid, revisie: 1, uitkomst: 'afgewezen', fout: 'geen-klant' } });
    expect(telling(t)).toEqual(voor);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM sync_ontvangen WHERE uuid = ?').get(uuid)).toEqual({ n: 1 });
  });

  it('gearchiveerd: 1 en 0 zetten het veld en er wordt nooit een rij verwijderd', async () => {
    const t = start();
    const p = await koppel(t);
    const uuid = randomUUID();
    const nu = t.clock.now;
    await p.wijziging({ uuid, tijd: nu - 3000, velden: { naam: 'Archief' } });
    const rijen = n(t, 'SELECT COUNT(*) AS n FROM relations');
    const een = await p.wijziging({ uuid, revisie: 2, tijd: nu - 2000, velden: { gearchiveerd: 1 } });
    expect(een.json).toMatchObject({ uitkomst: 'toegepast' });
    expect(klantRij(t, uuid)!.archived).toBe(1);
    expect(t.db.prepare(`SELECT veld, oud, nieuw, bron FROM relation_changelog WHERE relation_id = ? AND veld = 'gearchiveerd'`).all(klantRij(t, uuid)!.id)).toEqual([{ veld: 'gearchiveerd', oud: '0', nieuw: '1', bron: 'M1' }]);
    expect(t.db.prepare(`SELECT tijd FROM relation_field_rev WHERE relation_id = ? AND veld = 'gearchiveerd'`).get(klantRij(t, uuid)!.id)).toEqual({ tijd: nu - 2000 });
    // een oudere terugzetting verliest, een nieuwere wint; de rij blijft er steeds
    expect((await p.wijziging({ uuid, revisie: 3, tijd: nu - 2500, velden: { gearchiveerd: 0 } })).json).toMatchObject({ uitkomst: 'overgeslagen' });
    expect(klantRij(t, uuid)!.archived).toBe(1);
    expect((await p.wijziging({ uuid, revisie: 4, tijd: nu - 1000, velden: { gearchiveerd: 0 } })).json).toMatchObject({ uitkomst: 'toegepast' });
    expect(klantRij(t, uuid)).toMatchObject({ archived: 0, revisie: 3 });
    expect(n(t, 'SELECT COUNT(*) AS n FROM relations')).toBe(rijen);
  });

  it('niet stil samengevoegd: twee uuid\'s met dezelfde KvK, btw-nummer, e-mail en naam geven twee klanten, nul rijen in relation_aliases', async () => {
    const t = start();
    const p = await koppel(t);
    const velden = { naam: 'Dubbel BV', kvk_nummer: '12345678', btw_nummer: 'NL123456789B01', email: 'dubbel@example.nl' };
    const voor = telling(t);
    const een = randomUUID();
    const twee = randomUUID();
    expect((await p.wijziging({ uuid: een, velden })).json).toMatchObject({ uitkomst: 'toegepast' });
    expect((await p.wijziging({ uuid: twee, velden })).json).toMatchObject({ uitkomst: 'toegepast' });
    expect(klantRij(t, een)!.id).not.toBe(klantRij(t, twee)!.id);
    expect(telling(t).relations).toBe(voor.relations + 2);
    expect(n(t, 'SELECT COUNT(*) AS n FROM relation_aliases')).toBe(0);
    expect(n(t, `SELECT COUNT(*) AS n FROM relations WHERE name = 'Dubbel BV' AND archived = 0`)).toBe(2);
  });

  it('niet-ondersteund: project, factuur, bon en foto geven 200 en laten 0 rijen in relations en sync_ontvangen achter', async () => {
    const t = start();
    const p = await koppel(t);
    const voor = telling(t);
    const seq = teller(t);
    for (const entiteit of ['project', 'factuur', 'bon', 'foto']) {
      const r = await p.wijziging({ entiteit, velden: { naam: 'Iets', titel: 'x' } });
      expect(r, entiteit).toMatchObject({ status: 200, sealed: true, json: { ok: true, soort: 'wijziging', entiteit, revisie: 1, uitkomst: 'niet-ondersteund' } });
    }
    expect(telling(t)).toEqual(voor);
    expect(teller(t)).toBe(seq);
  });
});

describe('5 minuten vooruit en het wijzigingsnummer', () => {
  it('5 minuten: bewerktijd 6 minuten vooruit geeft 400 ongeldig en geen rijen, 4 minuten vooruit mag', async () => {
    const t = start();
    const p = await koppel(t);
    expect(LIMITS.clockWindowMs).toBe(5 * MINUUT);
    const voor = telling(t);
    const seq = teller(t);
    const teVer = await p.wijziging({ tijd: t.clock.now + 6 * MINUUT });
    expect(teVer).toMatchObject({ status: 400, sealed: true, json: { ok: false, fout: 'ongeldig' } });
    expect(telling(t)).toEqual(voor);
    expect(teller(t)).toBe(seq);
    const uuid = randomUUID();
    const goed = await p.wijziging({ uuid, tijd: t.clock.now + 4 * MINUUT });
    expect(goed).toMatchObject({ status: 200, json: { ok: true, uitkomst: 'toegepast' } });
    expect(klantRij(t, uuid)).toMatchObject({ gewijzigd_op: t.clock.now + 4 * MINUUT });
  });

  it('sync_seq: een telefoonwijziging van drie dagen geleden krijgt een hoger sync_seq en komt toch in een delta', async () => {
    const t = start();
    const p = await koppel(t);
    const uuid = randomUUID();
    const drieDagen = t.clock.now - 3 * 24 * 60 * MINUUT;
    const sinds = teller(t);
    await p.wijziging({ uuid, tijd: drieDagen, velden: { naam: 'Late klant' } });
    const klant = klantRij(t, uuid)!;
    expect(klant.sync_seq as number).toBeGreaterThan(sinds);
    expect(klant.sync_seq).toBe(teller(t));
    expect(klant.gewijzigd_op).toBe(drieDagen);
    // een andere telefoon die sinds het oude nummer vraagt, krijgt hem: de delta loopt op sync_seq, nooit op de bewerktijd
    const delta = t.db.prepare('SELECT uuid FROM relations WHERE sync_seq > ? ORDER BY sync_seq').all(sinds) as { uuid: string }[];
    expect(delta.map((r) => r.uuid)).toEqual([uuid]);
    // en op een bestaande klant geldt hetzelfde: een late wijziging krijgt een nieuw, hoger nummer
    const bestaand = randomUUID();
    pcKlant(t, bestaand);
    const sinds2 = teller(t);
    await p.wijziging({ uuid: bestaand, tijd: drieDagen, velden: { plaats: 'Ver weg' } });
    expect(klantRij(t, bestaand)!.sync_seq).toBe(sinds2 + 1);
    expect((t.db.prepare('SELECT uuid FROM relations WHERE sync_seq > ?').all(sinds2) as { uuid: string }[]).map((r) => r.uuid)).toEqual([bestaand]);
  });

  it('sync_seq: een toegepaste wijziging verhoogt de teller met precies een, ook met meer velden', async () => {
    const t = start();
    const p = await koppel(t);
    const uuid = randomUUID();
    const voor = teller(t);
    await p.wijziging({ uuid, velden: { naam: 'Veel velden', email: 'v@example.nl', plaats: 'A', telefoon: '1', notities: 'x' } });
    expect(teller(t)).toBe(voor + 1);
    await p.wijziging({ uuid, revisie: 2, tijd: t.clock.now + 1000, velden: { plaats: 'B', telefoon: '2' } });
    expect(teller(t)).toBe(voor + 2);
    expect(klantRij(t, uuid)).toMatchObject({ sync_seq: voor + 2, revisie: 2 });
  });

  it('sync_seq: een overgeslagen, afgewezen of ongeldige wijziging verhoogt de teller niet', async () => {
    const t = start();
    const p = await koppel(t);
    const uuid = randomUUID();
    const leverancier = randomUUID();
    pcKlant(t, leverancier, { type: 'leverancier' });
    const nu = t.clock.now;
    await p.wijziging({ uuid, tijd: nu - 100, velden: { naam: 'Teller' } });
    const seq = teller(t);
    const klantSeq = klantRij(t, uuid)!.sync_seq;
    // overgeslagen: dezelfde sleutel, en een oudere tijd met een andere sleutel
    expect((await p.wijziging({ uuid, tijd: nu - 100, velden: { naam: 'Teller' } })).json).toMatchObject({ uitkomst: 'overgeslagen' });
    expect((await p.wijziging({ uuid, revisie: 2, tijd: nu - 9000, velden: { naam: 'Ouder' } })).json).toMatchObject({ uitkomst: 'overgeslagen' });
    // afgewezen
    expect((await p.wijziging({ uuid: leverancier, velden: { plaats: 'x' } })).json).toMatchObject({ uitkomst: 'afgewezen' });
    // ongeldig: veld-ongeldig, klant-onbekend, te ver vooruit en niet-ondersteund
    expect((await p.wijziging({ uuid, revisie: 3, velden: { email: 'kapot' } })).status).toBe(400);
    expect((await p.wijziging({ uuid: randomUUID(), velden: { plaats: 'x' } })).status).toBe(409);
    expect((await p.wijziging({ uuid, revisie: 4, tijd: nu + 6 * MINUUT })).status).toBe(400);
    expect((await p.wijziging({ entiteit: 'project' })).json).toMatchObject({ uitkomst: 'niet-ondersteund' });
    expect(teller(t)).toBe(seq);
    expect(klantRij(t, uuid)!.sync_seq).toBe(klantSeq);
  });

  it('opslaan-mislukt: een fout midden in het schrijven laat geen halve rijen en geen teller achter, en daarna wordt dezelfde wijziging toegepast', async () => {
    const t = start();
    const p = await koppel(t);
    const uuid = randomUUID();
    const w = { uuid, revisie: 1, tijd: t.clock.now - 1000, velden: { naam: 'Faalt eerst', email: 'faal@example.nl' } };
    const voor = {
      relations: n(t, 'SELECT COUNT(*) AS n FROM relations'),
      relation_changelog: n(t, 'SELECT COUNT(*) AS n FROM relation_changelog'),
      relation_field_rev: n(t, 'SELECT COUNT(*) AS n FROM relation_field_rev'),
      sync_ontvangen: n(t, 'SELECT COUNT(*) AS n FROM sync_ontvangen'),
      teller: teller(t),
    };
    // een echte SQLite-trigger: de klant en de tijd van het veld zijn dan al geschreven als het logboek faalt
    t.db.exec(`CREATE TRIGGER faal_logboek BEFORE INSERT ON relation_changelog BEGIN SELECT RAISE(ABORT, 'logboek kapot'); END`);
    const mislukt = await p.wijziging(w);
    expect(mislukt).toMatchObject({ status: 500, sealed: true, json: { ok: false, fout: 'opslaan-mislukt' } });
    expect(n(t, 'SELECT COUNT(*) AS n FROM relations')).toBe(voor.relations);
    expect(n(t, 'SELECT COUNT(*) AS n FROM relation_changelog')).toBe(voor.relation_changelog);
    expect(n(t, 'SELECT COUNT(*) AS n FROM relation_field_rev')).toBe(voor.relation_field_rev);
    expect(n(t, 'SELECT COUNT(*) AS n FROM sync_ontvangen')).toBe(voor.sync_ontvangen);
    expect(klantRij(t, uuid)).toBeUndefined();
    expect(teller(t)).toBe(voor.teller);
    // ook een wijziging op een bestaande klant rolt terug
    const bestaand = randomUUID();
    pcKlant(t, bestaand, { city: 'Oudstad' });
    const seq = teller(t);
    const velden = n(t, 'SELECT COUNT(*) AS n FROM relation_field_rev');
    expect((await p.wijziging({ uuid: bestaand, velden: { plaats: 'Nieuwstad' } })).status).toBe(500);
    expect(klantRij(t, bestaand)).toMatchObject({ city: 'Oudstad', revisie: 1 });
    expect(teller(t)).toBe(seq);
    expect(n(t, 'SELECT COUNT(*) AS n FROM relation_field_rev')).toBe(velden);
    // trigger weg: dezelfde wijziging wordt nu gewoon toegepast
    t.db.exec('DROP TRIGGER faal_logboek');
    const opnieuw = await p.wijziging(w);
    expect(opnieuw).toMatchObject({ status: 200, json: { ok: true, uuid, uitkomst: 'toegepast' } });
    expect(klantRij(t, uuid)).toMatchObject({ name: 'Faalt eerst', revisie: 1 });
    expect(n(t, 'SELECT COUNT(*) AS n FROM sync_ontvangen')).toBe(voor.sync_ontvangen + 1);
    expect(teller(t)).toBe(seq + 1);
  });

  it('de wijzigingen van een telefoon veranderen de gegevens van de pc niet buiten de opgegeven velden en verwijderen niets', async () => {
    const t = start();
    const p = await koppel(t);
    const uuid = randomUUID();
    const id = pcKlant(t, uuid, { name: 'Gewone klant', email: 'gewoon@example.nl', city: 'Gouda' });
    t.db.prepare(`UPDATE relations SET paid_with = 'prive', iban = 'NL91ABNA0417164300' WHERE id = ?`).run(id);
    const voor = n(t, 'SELECT COUNT(*) AS n FROM relations');
    await p.wijziging({ uuid, velden: { plaats: 'Breda' } });
    expect(klantRij(t, uuid)).toMatchObject({ name: 'Gewone klant', email: 'gewoon@example.nl', city: 'Breda', paid_with: 'prive', iban: 'NL91ABNA0417164300', type: 'klant', id });
    expect(n(t, 'SELECT COUNT(*) AS n FROM relations')).toBe(voor);
  });
});
