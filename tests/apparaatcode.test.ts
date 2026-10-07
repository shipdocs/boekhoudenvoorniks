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
import { Bonnenscanner, type ScannerDeps } from '../src/scanner/scanner';
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

describe('apparaatcode: de migratie', () => {
  /** de migratie die scanner_device_codes maakt; welk nummer hij heeft doet er niet toe */
  const index = migrations.findIndex((m) => m.includes('CREATE TABLE IF NOT EXISTS scanner_device_codes'));

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
