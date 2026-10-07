import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { setup } from './helpers';
import { makeJpeg } from './fixtures/jpeg';
import { migrate } from '../src/db/database';
import { migrations } from '../src/db/migrations';
import { sanitizeForExchange } from '../src/exchange/exchange';
import { Bonnenscanner, type ScannerDeps } from '../src/scanner/scanner';
import { PAIRING_TTL_MS, ScannerPairing } from '../src/scanner/pairing';
import { PHONE_SCANNER } from '../src/shared/phone-scanner';
import { CONTENT_TYPE, ENDPOINT_PATH, decodePairing, encodeFrame, openResponse, sealRequest, type PairingPayload, type ProtocolVersion } from '../src/scanner/protocol';

// De apparaatcode (M1, M2, …): door de pc toegekend aan elke nieuwe koppeling, nooit hergebruikt
// (ook niet na ontkoppelen: dan wordt hij alleen afgesloten), en terug te zien in het hallo-antwoord
// van versie 2 (docs/bonnenscanner-protocol.md). Het harnas hieronder is gekopieerd uit
// bonnenscanner-v2.test.ts.

const LOOPBACK = [{ address: '127.0.0.1', netmask: '255.0.0.0' }];

const open: Bonnenscanner[] = [];
const dirs: string[] = [];
// Zoals in bonnenscanner.test.ts: koppelen staat in de app nog uit; de test zet het zelf aan.
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
  const spoolDir = mkdtempSync(join(tmpdir(), 'bvn-apparaatcode-'));
  dirs.push(spoolDir);
  const clock = { now: Date.now() };
  const scanner = new Bonnenscanner({
    db: t.db,
    secrets: t.secrets,
    intake: t.s.intake,
    settings: t.s.settings,
    spoolDir,
    interfaces: () => LOOPBACK,
    now: () => clock.now,
    ...extra,
  });
  open.push(scanner);
  const documents = () => t.db.prepare('SELECT id FROM documents ORDER BY id').all() as { id: number }[];
  return { ...t, scanner, spoolDir, clock, documents };
}

interface Reply {
  status: number;
  /** het antwoord was versleuteld en met de sleutel van de telefoon te openen */
  sealed: boolean;
  json: Record<string, unknown> | null;
  /** de ruwe body, om de envelopversie te kunnen zien */
  raw: Buffer;
}

/** De telefoon: kiest zelf in welke protocolversie hij zijn bericht in een envelop stopt. */
function phone(pairing: PairingPayload, clock: { now: number }) {
  const key = Buffer.from(pairing.sleutel, 'base64url');
  const deviceId = Buffer.from(pairing.apparaat, 'base64url');
  const url = `http://${pairing.adressen[0]}:${pairing.poort}${ENDPOINT_PATH}`;
  const post = async (body: Buffer, nonce: Buffer): Promise<Reply> => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': CONTENT_TYPE }, body: new Uint8Array(body) });
    const raw = Buffer.from(await res.arrayBuffer());
    if ((res.headers.get('content-type') ?? '') === CONTENT_TYPE) {
      const json = openResponse(raw, key, nonce);
      return { status: res.status, sealed: json !== null, json, raw };
    }
    return { status: res.status, sealed: false, json: raw.length ? (JSON.parse(raw.toString('utf8')) as Record<string, unknown>) : null, raw };
  };
  const verstuur = (json: Record<string, unknown>, opts: { versie?: ProtocolVersion; fotos?: Buffer[]; nonce?: Buffer } = {}) => {
    const nonce = opts.nonce ?? randomBytes(12);
    return post(sealRequest(deviceId, key, encodeFrame(json, opts.fotos ?? []), nonce, opts.versie ?? 1), nonce);
  };
  const hallo = (versie: ProtocolVersion, naam = 'Pixel van Piet') => verstuur({ soort: 'hallo', tijd: clock.now, naam, app: '1.0.0' }, { versie });
  const bon = (versie: ProtocolVersion, over: Record<string, unknown> = {}, label = 'bon') => {
    const foto = makeJpeg(label);
    return verstuur({ soort: 'bon', tijd: clock.now, id: randomUUID(), betaalwijze: 'pin', fotos: [{ grootte: foto.length }], ...over }, { versie, fotos: [foto] });
  };
  // Een wijziging-bericht draagt de change-set in een eigen sleutel `wijziging`: de `tijd` van het
  // bericht is de verzendtijd (binnen het klokvenster), de `tijd` ín de change-set is het moment van
  // bewerken en mag willekeurig oud zijn. Afwijkingen (`over`) gelden de change-set zelf.
  const wijziging = (over: Record<string, unknown> = {}, opts: { versie?: ProtocolVersion; fotos?: Buffer[]; nonce?: Buffer } = {}) =>
    verstuur(
      { soort: 'wijziging', tijd: clock.now, wijziging: { entiteit: 'klant', uuid: randomUUID(), revisie: 1, tijd: clock.now, velden: { naam: 'Familie Jansen' }, ...over } },
      { versie: 2, ...opts }
    );
  return { key, deviceId, url, post, verstuur, hallo, bon, wijziging };
}

async function pair(t: ReturnType<typeof start>) {
  const started = await t.scanner.pair();
  return phone(decodePairing(started.payload), t.clock);
}

/** ScannerPairing rechtstreeks op de testdatabase, met een eigen klok; voor de toekenning- en lijsttests. */
function direct() {
  const t = setup();
  const clock = { now: Date.now() };
  return { t, clock, pairing: new ScannerPairing(t.db, t.secrets, () => clock.now) };
}

/** Koppelen alsof de telefoon zich meteen meldt: begin() plus het eerste geldige bericht. */
function koppel(p: ScannerPairing, clock: { now: number }): string {
  const { deviceId } = p.begin();
  p.seen(deviceId);
  return deviceId;
}

describe('apparaatcode: de migratie', () => {
  /** de migratie die scanner_device_codes maakt; welk nummer hij heeft doet er niet toe */
  const index = migrations.findIndex((m) => /CREATE TABLE (IF NOT EXISTS )?scanner_device_codes\b/.test(m));

  it('migratie nieuwe tabel', () => {
    const db = new Database(':memory:');
    // de toestand zoals vóór deze migratie
    for (const m of migrations.slice(0, index)) db.exec(m);
    db.pragma(`user_version = ${index}`);
    migrate(db);
    expect(db.pragma('user_version', { simple: true })).toBe(migrations.length);
    // de tabel bestaat, is leeg, en heeft precies deze kolommen
    const kolommen = db.prepare('PRAGMA table_info(scanner_device_codes)').all() as { name: string; type: string; notnull: number; dflt_value: null; pk: number }[];
    expect(kolommen.map((k) => [k.name, k.type, k.notnull, k.pk])).toEqual([
      ['code', 'TEXT', 0, 1],
      ['volgnummer', 'INTEGER', 1, 0],
      ['device_id', 'TEXT', 0, 0],
      ['toegekend_op', 'TEXT', 1, 0],
      ['afgesloten_op', 'TEXT', 0, 0],
    ]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM scanner_device_codes').get()).toEqual({ n: 0 });
    db.close();
  });
});

describe('apparaatcode: toekenning bij het eerste geldige bericht', () => {
  it('M1-M2-M3 na ontkoppelen', () => {
    const { clock, pairing } = direct();
    koppel(pairing, clock); // A
    koppel(pairing, clock); // B
    expect(pairing.list().map((d) => d.code)).toEqual(['M1', 'M2']);
    pairing.unpair(pairing.list()[0]!.id); // A ontkoppeld
    koppel(pairing, clock); // C: krijgt de eerstvolgende code, niet die van A
    const codes = pairing.list().map((d) => d.code);
    expect(codes).toEqual(['M2', 'M3']);
    for (const code of [...codes, 'M1']) expect(code).toMatch(/^M[1-9][0-9]*$/);
  });

  it('verlopen QR geeft geen gat', () => {
    const { t, clock, pairing } = direct();
    pairing.begin(); // deze QR-code wordt nooit gescand
    clock.now += PAIRING_TTL_MS + 1;
    koppel(pairing, clock); // de volgende telefoon krijgt de eerste code: de verlopen QR had er geen
    expect(t.db.prepare('SELECT code, volgnummer, afgesloten_op FROM scanner_device_codes ORDER BY volgnummer').all()).toEqual([
      { code: 'M1', volgnummer: 1, afgesloten_op: null },
    ]);
  });

  it('een tweede bericht van hetzelfde apparaat geeft dezelfde code (idempotent)', () => {
    const { t, clock, pairing } = direct();
    const a = koppel(pairing, clock);
    const eerst = pairing.code(a);
    expect(eerst).toMatch(/^M[1-9][0-9]*$/);
    pairing.seen(a); // het tweede bericht
    expect(pairing.code(a)).toBe(eerst);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM scanner_device_codes').get()).toEqual({ n: 1 });
  });

  it('migratiepad zonder code: een al gekoppeld apparaat krijgt er een bij zijn volgende bericht', () => {
    const { t, clock, pairing } = direct();
    // een koppeling van vóór deze stap: gekoppeld, zonder rij in scanner_device_codes
    t.db.prepare("INSERT INTO scanner_devices (id, name, created_at, expires_at, paired_at) VALUES ('oud-apparaat', 'Telefoon 1', ?, NULL, ?)").run(new Date(clock.now).toISOString(), new Date(clock.now).toISOString());
    pairing.seen('oud-apparaat');
    expect(pairing.code('oud-apparaat')).toMatch(/^M[1-9][0-9]*$/);
    expect(pairing.code('oud-apparaat')).toBe('M1');
  });

  it('ontkoppelen laat rij staan met afgesloten_op gevuld', () => {
    const { t, clock, pairing } = direct();
    const a = koppel(pairing, clock);
    clock.now += 5_000;
    pairing.unpair(a);
    expect(t.db.prepare('SELECT code, device_id, toegekend_op, afgesloten_op FROM scanner_device_codes WHERE device_id = ?').get(a)).toEqual({
      code: 'M1',
      device_id: a,
      toegekend_op: new Date(clock.now - 5_000).toISOString(),
      afgesloten_op: new Date(clock.now).toISOString(),
    });
    // het apparaat zelf is wel degelijk weg
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM scanner_devices WHERE id = ?').get(a)).toEqual({ n: 0 });
  });

  it('lijst heeft code', () => {
    const { clock, pairing } = direct();
    const wachtend = pairing.begin(); // nog niet gemeld: nog geen code
    expect(pairing.list()).toEqual([expect.objectContaining({ id: wachtend.deviceId, pending: true, code: null })]);
    koppel(pairing, clock);
    expect(pairing.list().map((d) => [d.pending, d.code])).toEqual([
      [true, null],
      [false, 'M1'],
    ]);
  });

  it('herinstallatie zonder ontkoppelen geeft M2 en M1 blijft open', () => {
    const { t, clock, pairing } = direct();
    koppel(pairing, clock); // de eerste installatie
    koppel(pairing, clock); // opnieuw installeren is een nieuwe koppeling: de pc kan ze niet onderscheiden
    expect(t.db.prepare('SELECT code, afgesloten_op FROM scanner_device_codes ORDER BY volgnummer').all()).toEqual([
      { code: 'M1', afgesloten_op: null },
      { code: 'M2', afgesloten_op: null },
    ]);
  });

  it('sanitize valt niet terug', async () => {
    const { t, clock, pairing } = direct();
    koppel(pairing, clock);
    koppel(pairing, clock);
    const dir = mkdtempSync(join(tmpdir(), 'bvn-apparaatcode-kopie-'));
    dirs.push(dir);
    const kopiePad = join(dir, 'kopie.sqlite');
    await t.db.backup(kopiePad);
    const kopie = new Database(kopiePad);
    try {
      sanitizeForExchange(kopie);
      // in de kopie voor de boekhouder zijn de koppelingen gewist, maar de codes staan er nog
      expect(kopie.prepare('SELECT COUNT(*) AS n FROM scanner_devices').get()).toEqual({ n: 0 });
      expect(kopie.prepare('SELECT code FROM scanner_device_codes ORDER BY volgnummer').all()).toEqual([{ code: 'M1' }, { code: 'M2' }]);
    } finally {
      kopie.close();
    }
    // de live database houdt zijn codes, en de volgende toekenning telt door op het hoogste volgnummer
    koppel(pairing, clock);
    expect((t.db.prepare('SELECT code FROM scanner_device_codes ORDER BY volgnummer').all() as { code: string }[]).map((r) => r.code)).toEqual(['M1', 'M2', 'M3']);
  });

  it('het v2-hallo-antwoord noemt de apparaatcode, het v1-antwoord niet', async () => {
    const t = start();
    const p = await pair(t);
    const r = await p.hallo(2);
    expect(r).toMatchObject({ status: 200, sealed: true, json: { ok: true, soort: 'hallo', apparaatcode: 'M1' } });
    expect(r.json!.apparaatcode).toMatch(/^M[1-9][0-9]*$/);
    // versie 1 krijgt precies het oude antwoord
    const v1 = await p.hallo(1);
    expect(Object.keys(v1.json!)).not.toContain('apparaatcode');
    // de volgende koppeling krijgt de volgende code
    const q = await pair(t);
    expect((await q.hallo(2)).json!.apparaatcode).toBe('M2');
  });
});
