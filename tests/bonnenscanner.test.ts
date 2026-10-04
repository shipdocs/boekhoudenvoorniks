import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import jsQR from 'jsqr';
import QRCode from 'qrcode';
import { decode as decodeDns, encode as encodeDns } from 'dns-packet';
import { setup } from './helpers';
import { makeJpeg } from './fixtures/jpeg';
import { createApi, type HostContext } from '../src/main/api';
import { sanitizeForExchange } from '../src/exchange/exchange';
import { Bonnenscanner, type ScannerDeps } from '../src/scanner/scanner';
import { PHONE_SCANNER } from '../src/shared/phone-scanner';
import { stripJpegGps } from '../src/scanner/strip-gps';
import { makeJpegWithGps as makeMinimalGpsJpeg, readJpegGps } from '../src/intake/exif';
import { makeJpegWithGps, GPS_POSITION } from './fixtures/jpeg';
import { PAIRING_TTL_MS } from '../src/scanner/pairing';
import { jpegInfo, jpegsToPdf } from '../src/scanner/jpeg-pdf';
import { isPrivateIpv4, localInterfaces, sameSubnet } from '../src/scanner/network';
import makeMdns from 'multicast-dns';
import { MdnsAdvertiser, mdnsAnswer, mdnsNames, type Advertisement } from '../src/scanner/mdns';
import { extractPdf } from '../src/intake/pdf-text';
import { today } from '../src/shared/dates';
import { CONTENT_TYPE, ENDPOINT_PATH, LIMITS, decodePairing, encodeFrame, openRequest, openResponse, parseFrame, sealRequest, type PairingPayload } from '../src/scanner/protocol';

const LOOPBACK = [{ address: '127.0.0.1', netmask: '255.0.0.0' }];

const open: Bonnenscanner[] = [];
const dirs: string[] = [];
// Telefoon koppelen staat in de app nog uit (tot de Android-app er is, #49). Deze tests zetten het zelf
// aan; "telefoon koppelen staat uit" onderaan test de app zoals hij nu is.
beforeEach(() => {
  PHONE_SCANNER.available = true;
});
afterEach(async () => {
  PHONE_SCANNER.available = false;
  for (const s of open.splice(0)) await s.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Een administratie met de bonnenscanner op 127.0.0.1 en een klok die de test kan verzetten. */
function start(extra: Partial<ScannerDeps> = {}) {
  const t = setup();
  const spoolDir = mkdtempSync(join(tmpdir(), 'bvn-scanner-'));
  dirs.push(spoolDir);
  const clock = { now: Date.now() };
  const advertised: Advertisement[][] = [];
  const scanner = new Bonnenscanner({
    db: t.db,
    secrets: t.secrets,
    intake: t.s.intake,
    settings: t.s.settings,
    spoolDir,
    interfaces: () => LOOPBACK,
    now: () => clock.now,
    advertiser: { update: (ads) => void advertised.push(ads), stop: () => void advertised.push([]) },
    ...extra,
  });
  open.push(scanner);
  const documents = () => t.db.prepare('SELECT id, original_name, mime_type, status, note, proposed_paid_with, gps_lat, gps_lon, purchase_invoice_id FROM documents ORDER BY id').all() as { id: number; original_name: string; mime_type: string; status: string; note: string | null; proposed_paid_with: string | null; gps_lat: number | null; gps_lon: number | null; purchase_invoice_id: number | null }[];
  return { ...t, scanner, spoolDir, clock, advertised, documents };
}

interface Reply {
  status: number;
  type: string;
  /** het antwoord was versleuteld en met de sleutel van de telefoon te openen */
  sealed: boolean;
  json: Record<string, unknown> | null;
}

/** De telefoon: verstuurt echte HTTP-verzoeken naar het ontvangstpunt, zoals de Android-app dat gaat doen. */
function phone(pairing: PairingPayload, clock: { now: number }) {
  const key = Buffer.from(pairing.sleutel, 'base64url');
  const deviceId = Buffer.from(pairing.apparaat, 'base64url');
  const url = `http://${pairing.adressen[0]}:${pairing.poort}${ENDPOINT_PATH}`;
  const post = async (body: Buffer, nonce: Buffer, opts: { key?: Buffer; contentType?: string } = {}): Promise<Reply> => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': opts.contentType ?? CONTENT_TYPE }, body: new Uint8Array(body) });
    const raw = Buffer.from(await res.arrayBuffer());
    const type = res.headers.get('content-type') ?? '';
    if (type === CONTENT_TYPE) {
      const json = openResponse(raw, opts.key ?? key, nonce);
      return { status: res.status, type, sealed: json !== null, json };
    }
    return { status: res.status, type, sealed: false, json: raw.length ? (JSON.parse(raw.toString('utf8')) as Record<string, unknown>) : null };
  };
  const send = (json: Record<string, unknown>, photos: Buffer[] = [], opts: { key?: Buffer; nonce?: Buffer; contentType?: string; mutate?: (body: Buffer) => Buffer } = {}) => {
    const nonce = opts.nonce ?? randomBytes(12);
    const body = sealRequest(deviceId, opts.key ?? key, encodeFrame(json, photos), nonce);
    return post(opts.mutate ? opts.mutate(body) : body, nonce, opts);
  };
  return {
    key,
    deviceId,
    url,
    post,
    send,
    hallo: (naam = 'Pixel van Piet') => send({ soort: 'hallo', tijd: clock.now, naam, app: '1.0.0' }),
    bon: (over: Record<string, unknown> = {}, photos: Buffer[] = [makeJpeg()], opts: Parameters<typeof send>[2] = {}) =>
      send({ soort: 'bon', tijd: clock.now, id: randomUUID(), betaalwijze: 'pin', fotos: photos.map((p) => ({ grootte: p.length })), ...over }, photos, opts),
  };
}

async function pair(t: ReturnType<typeof start>) {
  const started = await t.scanner.pair();
  return phone(decodePairing(started.payload), t.clock);
}

/** Lukt een verbinding met deze poort? (onwaar = er luistert niets) */
function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

describe('bonnenscanner: koppelen (#48)', () => {
  it('zonder gekoppelde telefoon staat het ontvangstpunt uit', async () => {
    const t = start();
    await t.scanner.start();
    const st = t.scanner.status();
    expect(st.running).toBe(false);
    expect(st.port).toBeNull();
    expect(st.devices).toEqual([]);
    // en er wordt ook niets bekendgemaakt op het netwerk
    expect(t.advertised.every((ads) => ads.length === 0)).toBe(true);
  });

  it('de QR-code bevat adres, poort, pc-ID en een nieuwe sleutel van 32 bytes', async () => {
    const t = start();
    const a = await t.scanner.pair();
    const p = decodePairing(a.payload);
    expect(Buffer.from(p.sleutel, 'base64url')).toHaveLength(32);
    expect(Buffer.from(p.pc, 'base64url')).toHaveLength(16);
    expect(Buffer.from(p.apparaat, 'base64url')).toHaveLength(16);
    expect(p.adressen).toEqual(['127.0.0.1']);
    expect(p.poort).toBe(t.scanner.status().port);
    // het pc-ID is niet het ID van de administratie
    expect(p.pc).not.toContain(t.s.settings.administrationId().slice(0, 8));
    // een tweede telefoon krijgt een eigen ID en een eigen sleutel, bij dezelfde pc
    const b = decodePairing((await t.scanner.pair()).payload);
    expect(b.sleutel).not.toBe(p.sleutel);
    expect(b.apparaat).not.toBe(p.apparaat);
    expect(b.pc).toBe(p.pc);
    expect(b.poort).toBe(p.poort);
  });

  it('de QR-code is te lezen door een onafhankelijke QR-lezer (via de api, als SVG)', async () => {
    const t = start();
    const api = createApi(t.s, { scanner: { service: () => t.scanner, pickFolder: async () => null } } as unknown as HostContext);
    const r = await api.scanner.pair();
    expect(r.svg).toContain('<svg');
    expect(Object.keys(r)).not.toContain('payload');
    // dezelfde tekst als pixels, teruggelezen met jsQR
    const payload = (await t.scanner.pair()).payload;
    const qr = QRCode.create(payload, { errorCorrectionLevel: 'M' });
    const size = qr.modules.size;
    const scale = 4;
    const border = 4;
    const dim = (size + border * 2) * scale;
    const data = new Uint8ClampedArray(dim * dim * 4).fill(255);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (!qr.modules.get(y, x)) continue;
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
        const px = ((y + border) * scale + dy) * dim + (x + border) * scale + dx;
        data[px * 4] = data[px * 4 + 1] = data[px * 4 + 2] = 0;
      }
    }
    expect(decodePairing(jsQR(data, dim, dim)!.data)).toEqual(decodePairing(payload));
  });

  it('de sleutel staat alleen in de geheimenopslag, nergens leesbaar in de database', async () => {
    const t = start();
    const p = decodePairing((await t.scanner.pair()).payload);
    const key = Buffer.from(p.sleutel, 'base64url');
    expect(t.secrets.get(`scanner:key:${p.apparaat}`)).toBe(key.toString('base64'));
    const tables = (t.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'search%'`).all() as { name: string }[]).map((r) => r.name);
    const dump = JSON.stringify(tables.map((name) => t.db.prepare(`SELECT * FROM "${name}"`).all()));
    for (const form of [p.sleutel, key.toString('base64'), key.toString('hex')]) expect(dump).not.toContain(form);
    // de status voor het scherm bevat de sleutel ook niet
    expect(JSON.stringify(t.scanner.status())).not.toContain(p.sleutel);
  });

  it('zonder veilige opslag wordt er niet gekoppeld', async () => {
    const t = start({
      secrets: {
        available: false,
        get: () => null,
        set: () => {
          throw new Error('Veilige opslag is niet beschikbaar op dit systeem (geen sleutelhanger gevonden)');
        },
        delete: () => undefined,
      },
    });
    await expect(t.scanner.pair()).rejects.toThrow(/Veilige opslag/);
    expect(t.scanner.status().devices).toEqual([]);
    expect(t.scanner.status().running).toBe(false);
  });

  it('hallo van de telefoon maakt de koppeling af: naam en laatst gezien', async () => {
    const t = start();
    const p = await pair(t);
    expect(t.scanner.status().devices).toMatchObject([{ name: 'Telefoon 1', pending: true, lastSeenAt: null }]);
    const r = await p.hallo('Pixel van Piet');
    expect(r).toMatchObject({ status: 200, sealed: true, json: { ok: true, soort: 'hallo', pcTijd: t.clock.now } });
    expect(Object.keys(r.json!).sort()).toEqual(['limieten', 'ok', 'pc', 'pcTijd', 'soort']);
    expect(t.scanner.status().devices).toMatchObject([{ name: 'Pixel van Piet', pending: false, usable: true, expiresAt: null }]);
    expect(t.scanner.status().devices[0]!.lastSeenAt).toBe(new Date(t.clock.now).toISOString());
  });

  it('een QR-code die niet gescand wordt, vervalt na tien minuten: sleutel weg, ontvangstpunt uit', async () => {
    const t = start();
    const p = await pair(t);
    const port = t.scanner.status().port!;
    expect(await listening(port)).toBe(true);
    t.clock.now += PAIRING_TTL_MS + 1;
    // ook als het ontvangstpunt nog even luistert: de verlopen sleutel werkt niet meer
    expect(await p.hallo()).toMatchObject({ status: 401, json: { fout: 'niet-gekoppeld' } });
    await t.scanner.refresh();
    expect(t.scanner.status().devices).toEqual([]);
    expect(t.scanner.status().running).toBe(false);
    expect(await listening(port)).toBe(false);
    expect(t.secrets.get(`scanner:key:${p.deviceId.toString('base64url')}`)).toBeNull();
  });

  it('de QR-code sluiten zonder te scannen trekt de sleutel meteen in', async () => {
    const t = start();
    const a = await t.scanner.pair();
    const port = a.port;
    await t.scanner.cancelPairing(a.deviceId);
    expect(t.scanner.status().devices).toEqual([]);
    expect(await listening(port)).toBe(false);
    // een al gekoppelde telefoon wordt door "sluiten" niet ontkoppeld
    const p = await pair(t);
    await p.hallo();
    await t.scanner.cancelPairing(p.deviceId.toString('base64url'));
    expect(t.scanner.status().devices).toHaveLength(1);
  });

  it('na Ontkoppelen weigert de pc die telefoon; de andere telefoon werkt door', async () => {
    const t = start();
    const a = await pair(t);
    const b = await pair(t);
    expect((await a.hallo('A')).status).toBe(200);
    expect((await b.hallo('B')).status).toBe(200);
    await t.scanner.unpair(a.deviceId.toString('base64url'));
    expect(t.secrets.get(`scanner:key:${a.deviceId.toString('base64url')}`)).toBeNull();
    const refused = await a.bon();
    expect(refused).toMatchObject({ status: 401, sealed: false, json: { ok: false, fout: 'niet-gekoppeld' } });
    expect(t.documents()).toHaveLength(0);
    expect((await b.bon()).status).toBe(200);
    // de laatste telefoon ontkoppeld: er luistert niets meer
    const port = t.scanner.status().port!;
    await t.scanner.unpair(b.deviceId.toString('base64url'));
    expect(t.scanner.status().running).toBe(false);
    expect(await listening(port)).toBe(false);
    await expect(b.hallo()).rejects.toThrow();
  });

  it('zonder netwerk kan er niet gekoppeld worden, en blijft er geen sleutel achter', async () => {
    const t = start({ interfaces: () => [] });
    await expect(t.scanner.pair()).rejects.toThrow(/niet op een thuis- of kantoornetwerk/);
    expect(t.scanner.status()).toMatchObject({ running: false, devices: [] });
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM scanner_devices').get()).toEqual({ n: 0 });
  });

  it('in de demo en in de kopie bij de boekhouder kan er niet gekoppeld worden', async () => {
    const t = start();
    t.s.settings.update({ demoMode: true });
    await expect(t.scanner.pair()).rejects.toThrow(/demo/);
    t.s.settings.update({ demoMode: false });
    const p = await pair(t);
    await p.hallo();
    // wordt de administratie een kopie bij de boekhouder, dan gaat het ontvangstpunt uit
    t.s.settings.markOfficeCopy({ office: 'Kantoor De Boer', exchange: 1, endDate: '2026-09-30' });
    await t.scanner.refresh();
    expect(t.scanner.status().running).toBe(false);
    await expect(t.scanner.pair()).rejects.toThrow(/kopie/);
  });

  it('een export voor de boekhouder bevat geen telefoons, sleutels of bonnenmap', async () => {
    const t = start();
    const p = await pair(t);
    await p.hallo();
    await p.bon();
    await t.scanner.processSpool();
    t.db.prepare(`INSERT INTO settings (key, value) VALUES ('receiptFolder', '"/home/piet/Bonnen"')`).run();
    sanitizeForExchange(t.db);
    for (const table of ['scanner_devices', 'scanner_nonces', 'scanner_documents']) expect(t.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    expect(t.db.prepare(`SELECT COUNT(*) AS n FROM settings WHERE key IN ('scanner', 'receiptFolder')`).get()).toEqual({ n: 0 });
  });
});

describe('bonnenscanner: ontvangen via wifi (#48)', () => {
  it('een geldige bon staat één keer in de inbox, met notitie en betaalwijze als voorstel', async () => {
    const t = start();
    const p = await pair(t);
    const id = randomUUID();
    const r = await p.bon({ id, betaalwijze: 'contant', notitie: 'Schroeven voor de klus bij Jansen' });
    expect(r).toMatchObject({ status: 200, sealed: true, json: { ok: true, soort: 'bon', id, al: false } });
    // de bevestiging komt pas na het opslaan: de bon staat op dat moment in de database (wachtrij of inbox)
    expect(t.db.prepare('SELECT state FROM scanner_documents WHERE id = ?').get(id)).toBeTruthy();
    await t.scanner.processSpool();
    const docs = t.documents();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ mime_type: 'image/jpeg', status: 'controle', note: 'Schroeven voor de klus bij Jansen', proposed_paid_with: 'kas', purchase_invoice_id: null });
    expect(docs[0]!.original_name).toMatch(/^bon-telefoon-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\.jpg$/);
    expect(t.db.prepare('SELECT state, document_id FROM scanner_documents WHERE id = ?').get(id)).toEqual({ state: 'verwerkt', document_id: docs[0]!.id });
    // de wachtrij is weer leeg
    expect(readdirSync(t.spoolDir)).toEqual([]);
    // niets is vanzelf geboekt
    expect(t.s.purchases.list()).toHaveLength(0);
    // het voorstel bij het bevestigen: contant
    expect(t.s.intake.get(docs[0]!.id).proposed_paid_with).toBe('kas');
  });

  it('de betaalwijze van de telefoon wordt het voorstel: pin, contant, privé en later', async () => {
    const t = start();
    const p = await pair(t);
    for (const [i, betaalwijze] of ['pin', 'contant', 'prive', 'later'].entries()) expect((await p.bon({ betaalwijze }, [makeJpeg(`bon ${i}`)])).status).toBe(200);
    await t.scanner.processSpool();
    expect(t.documents().map((d) => d.proposed_paid_with)).toEqual(['bank', 'kas', 'prive', 'later']);
  });

  it('"Ja" op Vandaag boekt een contant betaalde bon als contant betaald', async () => {
    const lines = ['Bouwmaat Utrecht', `Datum: ${today().split('-').reverse().join('-')}`, 'Gips 100,00', 'Subtotaal 100,00', 'BTW 21% 100,00 21,00', 'Totaal 121,00'];
    const ocr = {
      id: 'test',
      label: 'Test OCR',
      available: async () => true,
      recognize: async () => ({ items: lines.map((text, i) => ({ text, page: 1, bbox: [10, 20 + i * 20, 300, 34 + i * 20] as [number, number, number, number], confidence: 0.97 })) }),
    };
    const t = start();
    t.s.intake.setOcrProvider(ocr);
    const p = await pair(t);
    await p.bon({ betaalwijze: 'contant' });
    await t.scanner.processSpool();
    const doc = t.s.intake.get(t.documents()[0]!.id);
    expect(doc.status).toBe('controle');
    expect(doc.result?.total?.value).toBe(12100);
    const api = createApi(t.s, {} as HostContext);
    const task = t.s.inbox.home().tasks.find((x) => x.kind === 'document-review')!;
    expect(task.question).toContain('Contant betaald.');
    await api.home.act(task, 'klopt');
    const purchase = t.s.purchases.list()[0]!;
    expect(purchase.total).toBe(12100);
    // contant: meteen betaald uit de kas, niet open blijven staan tot er een bankbetaling komt
    expect(purchase.amount_paid).toBe(12100);
    expect(t.s.search.infoFor(`inkoop:${purchase.id}`)?.paidVia).toMatch(/contant/i);
  });

  it('twee keer hetzelfde document versturen geeft één document in de inbox', async () => {
    const t = start();
    const p = await pair(t);
    const id = randomUUID();
    const bon = { id, betaalwijze: 'pin', notitie: 'tank' };
    expect((await p.bon(bon)).json).toMatchObject({ ok: true, al: false });
    // nog een keer vóór het verwerken, en nog een keer erna: steeds "al ontvangen"
    expect((await p.bon(bon)).json).toMatchObject({ ok: true, id, al: true });
    await t.scanner.processSpool();
    expect((await p.bon(bon)).json).toMatchObject({ ok: true, id, al: true });
    await t.scanner.processSpool();
    expect(t.documents()).toHaveLength(1);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM scanner_documents').get()).toEqual({ n: 1 });
    // een nieuwe poging van dezelfde bon is geen "dubbel document": geen melding op Vandaag
    expect(t.s.intake.notices()).toEqual([]);
  });

  it('dezelfde foto onder een nieuw ID (bv. na opnieuw koppelen) komt er ook maar één keer in: de hash', async () => {
    const t = start();
    const a = await pair(t);
    await a.bon({ notitie: 'eerste' });
    await t.scanner.processSpool();
    const b = await pair(t);
    expect((await b.bon({ notitie: 'nog een keer' })).json).toMatchObject({ ok: true, al: false });
    await t.scanner.processSpool();
    expect(t.documents()).toHaveLength(1);
    expect(t.documents()[0]!.note).toBe('eerste');
    // de telefoon is netjes bevestigd en de wachtrij is leeg; op Vandaag staat dat de bon er al in stond (#179)
    expect(t.db.prepare(`SELECT state, document_id FROM scanner_documents ORDER BY rowid`).all()).toEqual([{ state: 'verwerkt', document_id: t.documents()[0]!.id }, { state: 'verwerkt', document_id: t.documents()[0]!.id }]);
    expect(readdirSync(t.spoolDir)).toEqual([]);
    expect(t.s.intake.notices()).toMatchObject([{ kind: 'stond-er-al', source: 'telefoon', existing_document_id: t.documents()[0]!.id }]);
    expect(t.s.inbox.home().tasks.find((x) => x.kind === 'document-notice')!.question).toContain('Een bon kwam binnen van je telefoon, maar precies dit bestand staat al in de app');
  });

  it('een ander document onder een al gebruikt ID wordt geweigerd', async () => {
    const t = start();
    const p = await pair(t);
    const id = randomUUID();
    await p.bon({ id });
    const r = await p.bon({ id }, [makeJpeg('andere bon')]);
    expect(r).toMatchObject({ status: 409, sealed: true, json: { ok: false, fout: 'id-botst' } });
    await t.scanner.processSpool();
    expect(t.documents()).toHaveLength(1);
  });

  it('een bericht met een verkeerde sleutel wordt geweigerd en bewaart niets', async () => {
    const t = start();
    const p = await pair(t);
    const r = await p.bon({}, [makeJpeg()], { key: randomBytes(32) });
    expect(r).toMatchObject({ status: 401, type: 'application/json', sealed: false, json: { ok: false, fout: 'niet-gekoppeld' } });
    // het antwoord vertelt verder niets
    expect(Object.keys(r.json!).sort()).toEqual(['fout', 'ok']);
    await t.scanner.processSpool();
    expect(t.documents()).toHaveLength(0);
    expect(existsSync(t.spoolDir) ? readdirSync(t.spoolDir) : []).toEqual([]);
    // en de telefoon telt niet als gekoppeld
    expect(t.scanner.status().devices[0]).toMatchObject({ pending: true, lastSeenAt: null });
  });

  it('een bericht waar onderweg aan gezeten is, wordt geweigerd: inhoud, kop of afgekapt', async () => {
    const t = start();
    const p = await pair(t);
    const other = await pair(t);
    const flip = (at: (b: Buffer) => number) => (b: Buffer) => {
      const copy = Buffer.from(b);
      copy[at(b)]! ^= 0x01;
      return copy;
    };
    const cases: [string, (b: Buffer) => Buffer, number][] = [
      ['één bit in de versleutelde inhoud', flip(() => 60), 401],
      ['één bit in de controlecode', flip((b) => b.length - 1), 401],
      ['één bit in de nonce', flip(() => 25), 401],
      ['het apparaat-ID van een andere gekoppelde telefoon', (b) => Buffer.concat([b.subarray(0, 6), other.deviceId, b.subarray(22)]), 401],
      ['richting omgedraaid (een antwoord als verzoek)', (b) => Buffer.concat([b.subarray(0, 5), Buffer.from([2]), b.subarray(6)]), 400],
      ['andere versie', (b) => Buffer.concat([b.subarray(0, 4), Buffer.from([9]), b.subarray(5)]), 400],
      ['afgekapt', (b) => b.subarray(0, b.length - 200), 401],
      ['geen envelop', () => Buffer.alloc(300, 7), 400],
    ];
    for (const [what, mutate, status] of cases) {
      const r = await p.bon({}, [makeJpeg(what)], { mutate });
      expect(r.status, what).toBe(status);
      expect(r.sealed, what).toBe(false);
    }
    await t.scanner.processSpool();
    expect(t.documents()).toHaveLength(0);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM scanner_documents').get()).toEqual({ n: 0 });
  });

  it('een oude of te vroege tijdstempel wordt geweigerd; het antwoord geeft de tijd van de pc', async () => {
    const t = start();
    const p = await pair(t);
    for (const offset of [-(LIMITS.clockWindowMs + 1000), LIMITS.clockWindowMs + 1000]) {
      const r = await p.bon({ tijd: t.clock.now + offset });
      expect(r).toMatchObject({ status: 403, sealed: true, json: { ok: false, fout: 'klok', pcTijd: t.clock.now } });
    }
    // net binnen het venster mag wel
    expect((await p.bon({ tijd: t.clock.now - LIMITS.clockWindowMs + 1000 }, [makeJpeg('op tijd')])).status).toBe(200);
    await t.scanner.processSpool();
    expect(t.documents()).toHaveLength(1);
    // een geweigerd bericht maakt de koppeling niet af en telt niet als "gezien"... het geldige wel
    expect(t.scanner.status().devices[0]!.pending).toBe(false);
  });

  it('een onderschept bericht later opnieuw insturen werkt niet: tijdstempel', async () => {
    const t = start();
    const p = await pair(t);
    const nonce = randomBytes(12);
    const photo = makeJpeg();
    const body = sealRequest(p.deviceId, p.key, encodeFrame({ soort: 'bon', tijd: t.clock.now, id: randomUUID(), betaalwijze: 'pin', fotos: [{ grootte: photo.length }] }, [photo]), nonce);
    expect((await p.post(body, nonce)).status).toBe(200);
    await t.scanner.processSpool();
    // een uur later stuurt iemand die het bericht onderschepte het opnieuw in
    t.clock.now += 60 * 60 * 1000;
    const again = await p.post(body, nonce);
    expect(again).toMatchObject({ status: 403, json: { fout: 'klok' } });
    expect(t.documents()).toHaveLength(1);
  });

  it('een hergebruikte nonce wordt geweigerd, ook na opnieuw starten van de app', async () => {
    const t = start();
    const p = await pair(t);
    const nonce = randomBytes(12);
    const hello = sealRequest(p.deviceId, p.key, encodeFrame({ soort: 'hallo', tijd: t.clock.now, naam: 'Pixel' }), nonce);
    expect((await p.post(hello, nonce)).status).toBe(200);
    expect(await p.post(hello, nonce)).toMatchObject({ status: 409, sealed: true, json: { ok: false, fout: 'herhaald' } });
    // dezelfde nonce met een andere inhoud (een bon) ook niet
    const r = await p.bon({}, [makeJpeg()], { nonce });
    expect(r).toMatchObject({ status: 409, json: { fout: 'herhaald' } });
    // exact hetzelfde bon-bericht nog een keer: geweigerd op de nonce, en er komt niets bij
    const bonNonce = randomBytes(12);
    const photo = makeJpeg('x');
    const bon = sealRequest(p.deviceId, p.key, encodeFrame({ soort: 'bon', tijd: t.clock.now, id: randomUUID(), betaalwijze: 'pin', fotos: [{ grootte: photo.length }] }, [photo]), bonNonce);
    expect((await p.post(bon, bonNonce)).status).toBe(200);
    expect((await p.post(bon, bonNonce)).json).toMatchObject({ fout: 'herhaald' });
    // opnieuw starten (zelfde database): de nonces zijn onthouden
    await t.scanner.stop();
    const restarted = new Bonnenscanner({ db: t.db, secrets: t.secrets, intake: t.s.intake, settings: t.s.settings, spoolDir: t.spoolDir, interfaces: () => LOOPBACK, now: () => t.clock.now });
    open.push(restarted);
    await restarted.start();
    expect(restarted.status().port).toBe(Number(new URL(p.url).port));
    expect((await p.post(hello, nonce)).json).toMatchObject({ fout: 'herhaald' });
    expect((await p.post(bon, bonNonce)).json).toMatchObject({ fout: 'herhaald' });
    await restarted.processSpool();
    expect(t.documents()).toHaveLength(1);
  });

  it('een te grote body wordt geweigerd zonder iets te bewaren', async () => {
    const t = start();
    const p = await pair(t);
    const r = await p.post(Buffer.alloc(LIMITS.maxBodyBytes + 1, 1), randomBytes(12));
    expect(r).toMatchObject({ status: 413, sealed: false, json: { ok: false, fout: 'te-groot' } });
    // binnen de body-grens maar te veel aan foto's: ook geweigerd (versleuteld antwoord, want de sleutel klopt)
    const big = Buffer.concat([makeJpeg(), Buffer.alloc(LIMITS.maxPhotoBytes, 0)]);
    const r2 = await p.bon({}, [big]);
    expect(r2).toMatchObject({ status: 413, sealed: true, json: { fout: 'te-groot' } });
    // te veel foto's
    const many = Array.from({ length: LIMITS.maxPhotos + 1 }, (_, i) => makeJpeg(`foto ${i}`));
    expect(await p.bon({}, many)).toMatchObject({ status: 400, sealed: true, json: { fout: 'ongeldig' } });
    await t.scanner.processSpool();
    expect(t.documents()).toHaveLength(0);
    expect(existsSync(t.spoolDir) ? readdirSync(t.spoolDir) : []).toEqual([]);
  });

  it('een verkeerd content-type wordt geweigerd', async () => {
    const t = start();
    const p = await pair(t);
    for (const contentType of ['application/json', 'application/octet-stream', 'multipart/form-data; boundary=x', `${CONTENT_TYPE}; charset=utf-8`]) {
      const r = await p.bon({}, [makeJpeg()], { contentType });
      expect(r, contentType).toMatchObject({ status: 415, sealed: false, json: { ok: false, fout: 'verkeerd-type' } });
    }
    await t.scanner.processSpool();
    expect(t.documents()).toHaveLength(0);
  });

  it('alleen echte jpg-foto\'s: iets anders wordt geweigerd, wat de telefoon er ook bij zegt', async () => {
    const t = start();
    const p = await pair(t);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
    const program = Buffer.from('MZ\x90\x00 dit is geen foto');
    const cutOff = makeJpeg().subarray(0, 20);
    for (const [what, data] of [['png', png], ['programma', program], ['afgebroken jpg', cutOff]] as const) {
      expect(await p.bon({ naam: 'bon.jpg', type: 'image/jpeg' }, [data]), what).toMatchObject({ status: 400, sealed: true, json: { ok: false, fout: 'ongeldig' } });
    }
    // één slechte foto tussen goede: de hele bon wordt geweigerd
    expect((await p.bon({}, [makeJpeg('a'), png])).status).toBe(400);
    await t.scanner.processSpool();
    expect(t.documents()).toHaveLength(0);
    expect(existsSync(t.spoolDir) ? readdirSync(t.spoolDir) : []).toEqual([]);
  });

  it('ongeldige velden worden geweigerd; een pad in het ID komt nergens terecht', async () => {
    const t = start();
    const p = await pair(t);
    const bad: Record<string, unknown>[] = [
      { id: '../../../../tmp/kwaad' },
      { id: 'C:\\Windows\\kwaad' },
      { id: 'geen-uuid' },
      { id: 42 },
      { betaalwijze: 'creditcard' },
      { betaalwijze: null },
      { notitie: { tekst: 'x' } },
      { locatie: { lat: 'noord', lon: 5 } },
      { locatie: { lat: 91, lon: 5 } },
      { fotos: [] },
      { fotos: [{ grootte: 1 }] },
      { fotos: [{ grootte: -5 }] },
      { fotos: 'veel' },
      { tijd: 'nu' },
      { soort: 'geef-alles' },
    ];
    for (const over of bad) {
      const r = await p.send({ soort: 'bon', tijd: t.clock.now, id: randomUUID(), betaalwijze: 'pin', fotos: [{ grootte: makeJpeg().length }], ...over }, [makeJpeg()]);
      expect(r, JSON.stringify(over)).toMatchObject({ status: 400, sealed: true, json: { ok: false, fout: 'ongeldig' } });
    }
    await t.scanner.processSpool();
    expect(t.documents()).toHaveLength(0);
    expect(existsSync(t.spoolDir) ? readdirSync(t.spoolDir) : []).toEqual([]);
    expect(existsSync('/tmp/kwaad')).toBe(false);
    // een te lange notitie wordt afgekapt, stuurtekens verdwijnen; een UUID in hoofdletters mag
    const id = randomUUID();
    expect((await p.bon({ id: id.toUpperCase(), notitie: `regel 1\nregel 2\u0000\u0007${'x'.repeat(2000)}` })).json).toMatchObject({ ok: true, id });
    await t.scanner.processSpool();
    const note = t.documents()[0]!.note!;
    expect(note.startsWith('regel 1\nregel 2')).toBe(true);
    expect([...note]).toHaveLength(LIMITS.maxNoteChars);
    // eslint-disable-next-line no-control-regex
    expect(note).not.toMatch(/[\u0000\u0007]/);
  });

  it('andere paden en methoden geven niets terug', async () => {
    const t = start();
    const p = await pair(t);
    const base = p.url.replace(ENDPOINT_PATH, '');
    for (const path of ['/', '/v1/bericht/', '/v1/status', '/api', '/v1/bericht?x=1', '/../etc/passwd']) {
      const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': CONTENT_TYPE }, body: 'x' });
      expect(res.status, path).toBe(404);
      expect(await res.json()).toEqual({ ok: false, fout: 'onbekend' });
    }
    for (const method of ['GET', 'PUT', 'DELETE', 'OPTIONS']) {
      const res = await fetch(p.url, { method });
      expect(res.status, method).toBe(405);
      expect(await res.json()).toEqual({ ok: false, fout: 'onbekend' });
      // geen CORS: een webpagina in een browser kan dit punt niet gebruiken
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    }
  });

  it('een afzender van buiten het eigen netwerk krijgt geen verbinding', async () => {
    const t = start({ peerAllowed: () => false });
    const p = await pair(t);
    await expect(p.hallo()).rejects.toThrow();
    expect(t.scanner.status().devices[0]).toMatchObject({ pending: true });
  });

  it('na veel mislukte pogingen vanaf één adres even niets meer', async () => {
    const t = start();
    const p = await pair(t);
    await p.hallo();
    for (let i = 0; i < 20; i++) expect((await p.send({ soort: 'hallo', tijd: t.clock.now, naam: 'x' }, [], { key: randomBytes(32) })).status).toBe(401);
    expect(await p.hallo()).toMatchObject({ status: 429, sealed: false, json: { fout: 'te-druk' } });
    // na een minuut weer gewoon
    t.clock.now += 61_000;
    expect((await p.hallo()).status).toBe(200);
  });

  it('de locatie volgt de opt-in van #32: zonder toestemming wordt hij niet bewaard', async () => {
    const t = start();
    const p = await pair(t);
    // de inbox doet het even niet: zo is te zien wat er in de wachtrij op schijf staat
    const add = t.s.intake.add.bind(t.s.intake);
    let hold = true;
    t.s.intake.add = async (...args) => {
      if (hold) throw new Error('nog niet');
      return add(...args);
    };
    await p.bon({ locatie: { lat: 52.0907, lon: 5.1214 }, onbekendVeld: 'geheim-van-de-telefoon' }, [makeJpeg('zonder toestemming')]);
    await t.scanner.processSpool();
    // ook in de wachtrij staat de locatie niet, en geen velden die de app niet kent
    const spooled = readFileSync(join(t.spoolDir, readdirSync(t.spoolDir)[0]!));
    expect(parseFrame(spooled)).toMatchObject({ soort: 'bon', locatie: null });
    expect(spooled.toString('latin1')).not.toMatch(/52\.0907|geheim-van-de-telefoon/);
    hold = false;
    await t.scanner.processSpool();
    expect(t.documents()[0]).toMatchObject({ gps_lat: null, gps_lon: null });
    expect(readdirSync(t.spoolDir)).toEqual([]);
    t.s.settings.update({ jobLocation: true });
    await p.bon({ locatie: { lat: 52.0907, lon: 5.1214 } }, [makeJpeg('met toestemming')]);
    await p.bon({}, [makeJpeg('zonder locatie')]);
    await t.scanner.processSpool();
    expect(t.documents().slice(1)).toMatchObject([{ gps_lat: 52.0907, gps_lon: 5.1214 }, { gps_lat: null, gps_lon: null }]);
  });

  it('een bon van meerdere foto\'s wordt één document: een PDF met een pagina per foto', async () => {
    const t = start();
    const p = await pair(t);
    const photos = [makeJpeg('boven'), makeJpeg('midden'), makeJpeg('onder')];
    expect((await p.bon({ betaalwijze: 'prive', notitie: 'lange bon' }, photos)).status).toBe(200);
    await t.scanner.processSpool();
    const docs = t.documents();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ mime_type: 'application/pdf', note: 'lange bon', proposed_paid_with: 'prive' });
    expect(docs[0]!.original_name).toMatch(/^bon-telefoon-.*\.pdf$/);
    // een geldige PDF die de app zelf kan openen, en steeds precies hetzelfde bestand
    const pdf = jpegsToPdf(photos);
    expect(jpegsToPdf(photos).equals(pdf)).toBe(true);
    const read = await extractPdf(new Uint8Array(pdf));
    expect(read.pageSizes).toHaveLength(3);
    expect(read.pageSizes![0]).toMatchObject({ width: 595 });
    expect(jpegInfo(photos[0]!)).toEqual({ width: 48, height: 72, components: 3, orientation: 1 });
  });

  it('een bon die bij het afsluiten nog in de wachtrij stond, komt bij de volgende start in de inbox', async () => {
    const t = start();
    const p = await pair(t);
    // de app stopt meteen na de bevestiging, vóór de bon in de inbox staat
    const add = t.s.intake.add.bind(t.s.intake);
    let block = true;
    t.s.intake.add = async (...args) => {
      if (block) throw new Error('de app sluit af');
      return add(...args);
    };
    expect((await p.bon({ notitie: 'net op tijd' })).json).toMatchObject({ ok: true, al: false });
    await t.scanner.processSpool();
    await t.scanner.stop();
    expect(t.documents()).toHaveLength(0);
    expect(readdirSync(t.spoolDir).filter((f) => f.endsWith('.bon'))).toHaveLength(1);
    block = false;
    const next = new Bonnenscanner({ db: t.db, secrets: t.secrets, intake: t.s.intake, settings: t.s.settings, spoolDir: t.spoolDir, interfaces: () => LOOPBACK, now: () => t.clock.now });
    open.push(next);
    await next.start();
    await next.processSpool();
    expect(t.documents()).toMatchObject([{ note: 'net op tijd' }]);
    expect(readdirSync(t.spoolDir)).toEqual([]);
  });

  it('een bon in de wachtrij zonder regel in de database (stroomuitval, teruggezette back-up) gaat alsnog de inbox in', async () => {
    const t = start();
    const p = await pair(t);
    let block = true;
    const add = t.s.intake.add.bind(t.s.intake);
    t.s.intake.add = async (...args) => {
      if (block) throw new Error('nog niet');
      return add(...args);
    };
    const id = randomUUID();
    expect((await p.bon({ id, notitie: 'bijna kwijt' })).json).toMatchObject({ ok: true });
    await t.scanner.stop();
    // de regel is weg, het bestand staat er nog; daarnaast een half geschreven bestand en iets onleesbaars
    t.db.prepare('DELETE FROM scanner_documents').run();
    writeFileSync(join(t.spoolDir, `${randomUUID()}.bon.tmp`), 'half');
    const broken = `${randomUUID()}.bon`;
    writeFileSync(join(t.spoolDir, broken), 'geen bericht');
    block = false;
    const next = new Bonnenscanner({ db: t.db, secrets: t.secrets, intake: t.s.intake, settings: t.s.settings, spoolDir: t.spoolDir, interfaces: () => LOOPBACK, now: () => t.clock.now });
    open.push(next);
    await next.start();
    await next.processSpool();
    expect(t.documents()).toMatchObject([{ note: 'bijna kwijt' }]);
    // de telefoon die het nog een keer stuurt, krijgt "hadden we al"
    expect((await p.bon({ id, notitie: 'bijna kwijt' })).json).toMatchObject({ ok: true, al: true });
    // het halve bestand is weg; het onleesbare blijft staan (er wordt niets weggegooid dat een bon kan zijn)
    expect(readdirSync(t.spoolDir)).toEqual([broken]);
  });

  it('stoppen terwijl het starten nog loopt laat niets draaien', async () => {
    const t = start();
    const starting = t.scanner.start();
    await t.scanner.stop();
    await starting;
    expect((t.scanner as unknown as { timer: unknown }).timer).toBeNull();
    expect(t.scanner.status().running).toBe(false);
  });

  it('een verbinding die blijft hangen houdt het ontvangstpunt niet bezet', async () => {
    const t = start();
    const p = await pair(t);
    const { hostname, port } = new URL(p.url);
    // geldige kop, 50 bytes aangekondigd, 49 gestuurd, en dan niets meer
    const stalled = connect({ host: hostname, port: Number(port) });
    await new Promise((resolve) => stalled.once('connect', resolve));
    stalled.write(`POST ${ENDPOINT_PATH} HTTP/1.1\r\nHost: x\r\nContent-Type: ${CONTENT_TYPE}\r\nContent-Length: 50\r\n\r\n`);
    stalled.write(Buffer.alloc(49, 1));
    await new Promise((resolve) => setTimeout(resolve, 200));
    // van één adres wordt één verzoek tegelijk ingelezen
    expect(await p.hallo()).toMatchObject({ status: 503, json: { fout: 'te-druk' } });
    // de hangende verbinding wordt na tien seconden zonder gegevens door de pc verbroken
    const closed = await new Promise<boolean>((resolve) => {
      stalled.once('close', () => resolve(true));
      setTimeout(() => resolve(false), 14_000);
    });
    expect(closed).toBe(true);
    expect((await p.hallo()).status).toBe(200);
  });

  it('lukt het in de inbox zetten niet, dan blijft de bon bewaard en wordt hij gemeld', async () => {
    const t = start();
    const p = await pair(t);
    t.s.intake.add = async () => {
      throw new Error('schijf vol');
    };
    await p.bon();
    for (let i = 0; i < 4; i++) await t.scanner.processSpool();
    const st = t.scanner.status();
    expect(st.waiting).toBe(0);
    expect(st.failed).toHaveLength(1);
    expect(st.failed[0]!.error).toBe('schijf vol');
    expect(existsSync(st.failed[0]!.path)).toBe(true);
  });

  it('lukt opslaan niet, dan komt er geen bevestiging en bewaart de telefoon de bon', async () => {
    // de map van de wachtrij kan niet gemaakt worden (er staat een bestand op die plek)
    const t = start();
    rmSync(t.spoolDir, { recursive: true, force: true });
    const blocked = new Bonnenscanner({ db: t.db, secrets: t.secrets, intake: t.s.intake, settings: t.s.settings, spoolDir: join(__filename, 'kan-niet'), interfaces: () => LOOPBACK, now: () => t.clock.now });
    open.push(blocked);
    const p = phone(decodePairing((await blocked.pair()).payload), t.clock);
    const r = await p.bon();
    expect(r).toMatchObject({ status: 500, sealed: true, json: { ok: false, fout: 'opslaan-mislukt' } });
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM scanner_documents').get()).toEqual({ n: 0 });
  });
});

describe('bonnenscanner: protocol (docs/bonnenscanner-protocol.md)', () => {
  // De waarden uit het uitgewerkte voorbeeld in het document, uitgerekend met een andere
  // AES-GCM-implementatie (Python, cryptography) dan die van de app.
  const key = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');
  const deviceId = Buffer.from('a0a1a2a3a4a5a6a7a8a9aaabacadaeaf', 'hex');
  const nonce = Buffer.from('101112131415161718191a1b', 'hex');
  const json = '{"soort":"hallo","tijd":1790848800000,"naam":"Pixel van Piet","app":"1.0.0"}';
  const request =
    '42564e530101a0a1a2a3a4a5a6a7a8a9aaabacadaeaf101112131415161718191a1b7dfe985a32eb49dca5077c3f355b0132bb3c212c37e023d88d9dc05d6f636deb68dd6f3bc5965edf4e1ab03febf97e39299e171a9bee35d2ca7f5411a3fec11f27d41d4239ce290e4fb11bcef6f1cac3e176e4ee5617eb65598ce6d0b2cfabd8';
  const response =
    '42564e530102a0a1a2a3a4a5a6a7a8a9aaabacadaeaf202122232425262728292a2ba918c91b4ea26e7c6f196eecb2779b8ba46bd6bee5ef0dcc40d405766bb07c3a13bc873ced1450f721995af3753d7afe8407d5efad5e0051ad531b2f29816ce9b913af29bab584faa9508f46d72e5c1cc57663598e11bca4052acb14be8b6763';

  it('het voorbeeld uit het document klopt byte voor byte', () => {
    const frame = Buffer.concat([Buffer.from('0000004c', 'hex'), Buffer.from(json, 'utf8')]);
    expect(encodeFrame(JSON.parse(json) as Record<string, unknown>).equals(frame)).toBe(true);
    expect(sealRequest(deviceId, key, frame, nonce).toString('hex')).toBe(request);
    expect(parseFrame(openRequest(Buffer.from(request, 'hex'), key)!)).toEqual({ soort: 'hallo', tijd: 1790848800000, naam: 'Pixel van Piet', app: '1.0.0' });
    expect(openResponse(Buffer.from(response, 'hex'), key, nonce)).toEqual({ ok: true, soort: 'bon', id: '3f2b8c1e-5d4a-4e6f-9a7b-0c1d2e3f4a5b', al: false });
  });

  it('een telefoon die alleen het document volgt (de WebCrypto-code uit het document) wordt begrepen', async () => {
    const t = start();
    const k = decodePairing((await t.scanner.pair()).payload);
    const b64url = (text: string) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const type = 'application/vnd.boekhoudenvoorniks.scanner';

    const verstuur = async (json: object, fotos: Uint8Array[] = []) => {
      const sleutel = await crypto.subtle.importKey('raw', b64url(k.sleutel), 'AES-GCM', false, ['encrypt', 'decrypt']);
      const kop = new Uint8Array([0x42, 0x56, 0x4e, 0x53, 1, 1, ...b64url(k.apparaat)]);
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const tekst = new TextEncoder().encode(JSON.stringify(json));
      const inhoud = new Uint8Array(4 + tekst.length + fotos.reduce((n, f) => n + f.length, 0));
      new DataView(inhoud.buffer).setUint32(0, tekst.length);
      inhoud.set(tekst, 4);
      let plek = 4 + tekst.length;
      for (const f of fotos) {
        inhoud.set(f, plek);
        plek += f.length;
      }
      const cijfer = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: kop }, sleutel, inhoud));
      const body = new Uint8Array(34 + cijfer.length);
      body.set(kop, 0);
      body.set(nonce, 22);
      body.set(cijfer, 34);
      const res = await fetch(`http://${k.adressen[0]}:${k.poort}/v1/bericht`, { method: 'POST', headers: { 'content-type': type }, body });
      if (res.headers.get('content-type') !== type) return { vertrouwd: false, ...((await res.json()) as object) };
      const r = new Uint8Array(await res.arrayBuffer());
      const aad = new Uint8Array([...r.slice(0, 22), ...nonce]);
      const open = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: r.slice(22, 34), additionalData: aad }, sleutel, r.slice(34));
      return { vertrouwd: true, ...(JSON.parse(new TextDecoder().decode(open)) as object) };
    };

    expect(await verstuur({ soort: 'hallo', tijd: t.clock.now, naam: 'Pixel van Piet', app: '1.0.0' })).toMatchObject({ vertrouwd: true, ok: true, soort: 'hallo', pc: k.pc });
    const foto = new Uint8Array(makeJpeg('uit het document'));
    const id = '3f2b8c1e-5d4a-4e6f-9a7b-0c1d2e3f4a5b';
    expect(await verstuur({ soort: 'bon', tijd: t.clock.now, id, betaalwijze: 'contant', notitie: 'uit het document', fotos: [{ grootte: foto.length }] }, [foto])).toEqual({ vertrouwd: true, ok: true, soort: 'bon', id, al: false });
    await t.scanner.processSpool();
    expect(t.documents()).toMatchObject([{ note: 'uit het document', proposed_paid_with: 'kas' }]);
    expect(t.scanner.status().devices).toMatchObject([{ name: 'Pixel van Piet', pending: false }]);
  });

  it('de voorbeelden in het document zijn geldig en gelijk aan wat hier getest wordt', () => {
    // op Windows kan het bestand met \r\n uitgecheckt zijn
    const doc = readFileSync(join(__dirname, '..', 'docs', 'bonnenscanner-protocol.md'), 'utf8').replace(/\r\n/g, '\n');
    const blocks = [...doc.matchAll(/```(json|text)\n([\s\S]*?)```/g)].map((m) => ({ lang: m[1]!, body: m[2]!.trim() }));
    const examples = blocks.filter((b) => b.lang === 'json').map((b) => JSON.parse(b.body) as Record<string, unknown>);
    // de QR-code
    const qr = examples.find((e) => e.bvn === 'scanner')!;
    expect(decodePairing(JSON.stringify(qr))).toMatchObject({ poort: 51234, adressen: ['192.168.1.35'] });
    // elk voorbeeldbericht wordt door de pc begrepen
    const messages = examples.filter((e) => typeof e.soort === 'string' && e.ok === undefined);
    expect(messages.map((m) => m.soort).sort()).toEqual(['bon', 'hallo', 'hallo']);
    for (const m of messages) {
      const fotos = ((m.fotos as { grootte: number }[] | undefined) ?? []).map((f) => Buffer.alloc(f.grootte));
      expect(parseFrame(encodeFrame(m, fotos))).toMatchObject({ soort: m.soort, tijd: m.tijd });
    }
    // de hexadecimale blokken: sleutel, verzoek en antwoord van het uitgewerkte voorbeeld
    const hex = blocks.filter((b) => b.lang === 'text').map((b) => b.body.replace(/\s+/g, ''));
    expect(hex).toContain(request);
    expect(hex).toContain(response);
    expect(doc).toContain(key.toString('hex'));
    expect(doc).toContain(key.toString('base64url'));
    expect(doc).toContain(deviceId.toString('base64url'));
    expect(hex).toContain(Buffer.concat([Buffer.from('0000004c', 'hex'), Buffer.from(json, 'utf8')]).toString('hex'));
    // de grenzen die het document noemt
    expect(doc).toContain(`${LIMITS.maxBodyBytes.toLocaleString('nl-NL')} bytes`);
    expect(doc).toContain(`${LIMITS.maxPhotoBytes.toLocaleString('nl-NL')} bytes`);
    expect(doc).toContain(`"fotoBytes":${LIMITS.maxPhotoBytes}`);
  });

  it('een antwoord hoort bij precies één verzoek en kan niet als verzoek terugkomen', () => {
    const body = Buffer.from(response, 'hex');
    expect(openResponse(body, key, Buffer.from('101112131415161718191a1c', 'hex'))).toBeNull();
    expect(openResponse(body, randomBytes(32), nonce)).toBeNull();
    expect(openRequest(body, key)).toBeNull();
    expect(openResponse(Buffer.from(request, 'hex'), key, nonce)).toBeNull();
  });

  it('de tekst van de QR-code: alleen een complete, geldige koppeling wordt gelezen', () => {
    const ok = { bvn: 'scanner', v: 1, pc: 'oKGio6SlpqeoqaqrrK2urw', apparaat: 'oKGio6SlpqeoqaqrrK2urw', sleutel: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8', poort: 51234, adressen: ['192.168.1.20'] };
    expect(decodePairing(JSON.stringify(ok))).toEqual({ pc: ok.pc, apparaat: ok.apparaat, sleutel: ok.sleutel, poort: 51234, adressen: ['192.168.1.20'] });
    for (const broken of [{ ...ok, bvn: 'iets' }, { ...ok, v: 2 }, { ...ok, sleutel: 'kort' }, { ...ok, poort: 70000 }, { ...ok, adressen: ['voorbeeld.nl'] }, { ...ok, apparaat: 'oKGio6SlpqeoqaqrrK2ur+' }]) {
      expect(() => decodePairing(JSON.stringify(broken))).toThrow();
    }
    expect(() => decodePairing('https://voorbeeld.nl')).toThrow();
  });
});

describe('bonnenscanner: alleen het lokale netwerk, vindbaar via mDNS', () => {
  it('luistert alleen op privé-adressen van echte netwerken', () => {
    const nic = (address: string, netmask = '255.255.255.0', extra: object = {}) => ({ address, netmask, family: 'IPv4' as const, mac: '00:11:22:33:44:55', internal: false, cidr: null, ...extra });
    const found = localInterfaces({
      lo: [nic('127.0.0.1', '255.0.0.0', { internal: true })],
      wlp0s20f3: [nic('192.168.1.35'), { address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: '00:11:22:33:44:55', internal: false, cidr: null, scopeid: 2 }],
      eth0: [nic('10.0.0.12', '255.0.0.0')],
      eth1: [nic('84.12.33.7')],
      docker0: [nic('172.17.0.1', '255.255.0.0')],
      'br-0c1496a62056': [nic('172.22.0.1', '255.255.0.0')],
      virbr0: [nic('192.168.122.1')],
      proton0: [nic('10.2.0.2', '255.255.255.255')],
      tun0: [nic('10.8.0.2')],
      'vEthernet (WSL)': [nic('172.29.0.1', '255.255.240.0')],
      podman0: [nic('10.88.0.1', '255.255.0.0')],
      bridge100: [nic('192.168.64.1')],
      'ZeroTier One [abc]': [nic('10.147.17.5')],
      'Thuis-VPN': [nic('10.6.0.2')],
      'OpenVPN TAP-Windows6': [nic('10.8.1.6')],
      wg0: [nic('10.9.0.1', '255.255.255.255')],
    });
    expect(found).toEqual([{ address: '192.168.1.35', netmask: '255.255.255.0' }, { address: '10.0.0.12', netmask: '255.0.0.0' }]);
    expect(['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.1.1'].every(isPrivateIpv4)).toBe(true);
    expect(['8.8.8.8', '172.32.0.1', '192.169.0.1', '127.0.0.1', '::1', 'voorbeeld.nl', '999.1.1.1'].some(isPrivateIpv4)).toBe(false);
  });

  it('neemt alleen afzenders uit hetzelfde netwerk aan', () => {
    const wifi = { address: '192.168.1.35', netmask: '255.255.255.0' };
    expect(sameSubnet('192.168.1.77', wifi)).toBe(true);
    expect(sameSubnet('::ffff:192.168.1.77', wifi)).toBe(true);
    expect(sameSubnet('192.168.2.77', wifi)).toBe(false);
    expect(sameSubnet('84.12.33.7', wifi)).toBe(false);
    expect(sameSubnet('fe80::1', wifi)).toBe(false);
    expect(sameSubnet('', wifi)).toBe(false);
  });

  it('is vindbaar via mDNS zolang er een telefoon gekoppeld is, en daarna niet meer', async () => {
    const t = start();
    await t.scanner.start();
    expect(t.advertised.at(-1)).toEqual([]);
    const p = await pair(t);
    const pc = t.scanner.pairing.pcId();
    expect(t.advertised.at(-1)).toEqual([{ pcId: pc, port: Number(new URL(p.url).port), address: '127.0.0.1', netmask: '255.0.0.0' }]);
    for (const d of t.scanner.status().devices) await t.scanner.unpair(d.id);
    expect(t.advertised.at(-1)).toEqual([]);
  });

  // Echte mDNS-pakketten (UDP-multicast, poort 5353). Niet standaard aan: in een afgeschermde
  // testomgeving is multicast er vaak niet. Draaien: BVN_TEST_MDNS=127.0.0.1 npx vitest run tests/bonnenscanner.test.ts
  it.skipIf(!process.env.BVN_TEST_MDNS)('live: een andere mDNS-socket vindt het ontvangstpunt en ziet het weer verdwijnen', async () => {
    const address = process.env.BVN_TEST_MDNS!;
    const ad = { pcId: 'oKGio6SlpqeoqaqrrK2urw', port: 51234, address, netmask: '255.0.0.0' };
    const advertiser = new MdnsAdvertiser();
    const client = makeMdns({ interface: address, bind: '0.0.0.0', reuseAddr: true });
    const seen: string[] = [];
    client.on('response', (r) => {
      for (const a of [...r.answers, ...r.additionals] as { name: string; type: string; ttl?: number; data: unknown }[]) {
        if (/gratisboekhouden|bvn-/.test(a.name)) seen.push(`${a.type} ttl=${a.ttl === 0 ? 0 : 'n'} ${a.type === 'A' ? String(a.data) : ''}`.trim());
      }
    });
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    try {
      advertiser.update([ad]);
      await wait(500);
      client.query([{ name: '_gratisboekhouden._tcp.local', type: 'PTR' }]);
      await wait(700);
      expect(seen).toEqual(expect.arrayContaining(['PTR ttl=n', 'SRV ttl=n', 'TXT ttl=n', `A ttl=n ${address}`]));
      advertiser.stop();
      await wait(500);
      expect(seen).toContain('PTR ttl=0');
    } finally {
      advertiser.stop();
      client.destroy();
    }
  });

  // 127.0.0.2 als tweede adres van deze computer bestaat op Linux en Windows, niet op macOS
  it.skipIf(process.platform === 'darwin')('een nieuw IP-adres (router herstart): het ontvangstpunt verhuist mee, op dezelfde poort', async (ctx) => {
    // Sommige testcontainers sturen alle loopback-verzoeken door naar 127.0.0.1.
    // Controleer dit met een onafhankelijke HTTP-server, voordat de scanner getest wordt.
    const probe = createServer((_req, res) => res.end('tweede-loopback'));
    await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.2', resolve); });
    let secondLoopback = false;
    try {
      const url = `http://127.0.0.2:${(probe.address() as { port: number }).port}`;
      secondLoopback = await (await fetch(url, { signal: AbortSignal.timeout(1000) })).text() === 'tweede-loopback';
    } catch { /* de transportlaag ondersteunt dit tweede adres niet */ }
    finally { await new Promise<void>(resolve => probe.close(() => resolve())); }
    if (!secondLoopback) ctx.skip('Deze testomgeving kan een HTTP-server op 127.0.0.2 niet bereiken');
    let current = LOOPBACK;
    const t = start({ interfaces: () => current });
    const p = await pair(t);
    expect((await p.hallo()).status).toBe(200);
    const port = Number(new URL(p.url).port);
    current = [{ address: '127.0.0.2', netmask: '255.0.0.0' }];
    await t.scanner.refresh();
    expect(t.scanner.status()).toMatchObject({ running: true, port, addresses: ['127.0.0.2'] });
    expect(t.advertised.at(-1)).toEqual([{ pcId: t.scanner.pairing.pcId(), port, address: '127.0.0.2', netmask: '255.0.0.0' }]);
    // op het oude adres luistert niets meer; op het nieuwe werkt dezelfde koppeling
    await expect(p.hallo()).rejects.toThrow();
    const moved = phone({ pc: t.scanner.pairing.pcId(), apparaat: p.deviceId.toString('base64url'), sleutel: p.key.toString('base64url'), poort: port, adressen: ['127.0.0.2'] }, t.clock);
    expect((await moved.hallo()).status).toBe(200);
  });

  it('antwoordt op de vraag naar _gratisboekhouden._tcp met poort, pc-ID en adres, en zegt verder niets', () => {
    const ad = { pcId: 'oKGio6SlpqeoqaqrrK2urw', port: 51234, address: '192.168.1.35', netmask: '255.255.255.0' };
    const { instance, host } = mdnsNames(ad.pcId);
    expect(instance).toBe('BoekhoudenVoorNiks-a0a1a2a3._gratisboekhouden._tcp.local');
    const browse = mdnsAnswer([{ name: '_gratisboekhouden._tcp.local', type: 'PTR' }], ad)!;
    expect(browse.answers).toMatchObject([{ type: 'PTR', name: '_gratisboekhouden._tcp.local', data: instance }]);
    expect(browse.additionals).toMatchObject([
      { type: 'SRV', name: instance, data: { port: 51234, target: host } },
      { type: 'TXT', name: instance, data: ['v=1', 'id=oKGio6SlpqeoqaqrrK2urw'] },
      { type: 'A', name: host, data: '192.168.1.35' },
    ]);
    expect(mdnsAnswer([{ name: instance, type: 'SRV' }], ad)!.answers).toMatchObject([{ type: 'SRV' }]);
    expect(mdnsAnswer([{ name: host, type: 'A' }], ad)!.answers).toMatchObject([{ type: 'A', data: '192.168.1.35' }]);
    expect(mdnsAnswer([{ name: '_services._dns-sd._udp.local', type: 'PTR' }], ad)!.answers).toMatchObject([{ data: '_gratisboekhouden._tcp.local' }]);
    // vragen over iets anders: geen antwoord
    expect(mdnsAnswer([{ name: '_ipp._tcp.local', type: 'PTR' }, { name: 'mijn-pc.local', type: 'A' }], ad)).toBeNull();
    // het antwoord is een geldig DNS-pakket, zonder computernaam, bedrijfsnaam of sleutel
    const packet = encodeDns({ type: 'response', answers: browse.answers, additionals: browse.additionals });
    const decoded = decodeDns(packet);
    expect(decoded.answers).toHaveLength(1);
    expect(decoded.additionals).toHaveLength(3);
    expect(packet.toString('latin1')).not.toMatch(/Piet|Stukadoor/);
  });
});

describe('telefoon koppelen staat uit tot de Android-app er is (zoals de app nu is)', () => {
  beforeEach(() => {
    PHONE_SCANNER.available = false;
  });

  it('koppelen wordt geweigerd, ook via de api; er gaat niets luisteren en er wordt niets bekendgemaakt', async () => {
    const t = start();
    await t.scanner.start();
    await expect(t.scanner.pair()).rejects.toThrow(/kan nog niet/);
    const api = createApi(t.s, { scanner: { service: () => t.scanner, pickFolder: async () => null } } as unknown as HostContext);
    await expect(api.scanner.pair()).rejects.toThrow(/kan nog niet/);
    expect(api.app.meta().phoneScanner).toBe(false);
    expect(t.scanner.status()).toMatchObject({ phoneAvailable: false, running: false, port: null, devices: [] });
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM scanner_devices').get()).toEqual({ n: 0 });
    expect(t.advertised.every((ads) => ads.length === 0)).toBe(true);
  });

  it('ook met een telefoon in de database luistert er niets', async () => {
    const t = start();
    PHONE_SCANNER.available = true;
    const p = await pair(t);
    expect((await p.hallo()).status).toBe(200);
    const port = t.scanner.status().port!;
    expect(await listening(port)).toBe(true);
    PHONE_SCANNER.available = false;
    await t.scanner.refresh();
    expect(t.scanner.status()).toMatchObject({ running: false, port: null });
    expect(await listening(port)).toBe(false);
    expect(t.advertised.at(-1)).toEqual([]);
    await expect(p.hallo()).rejects.toThrow();
    // en bij een nieuwe start van de app ook niet
    await t.scanner.stop();
    const next = new Bonnenscanner({ db: t.db, secrets: t.secrets, intake: t.s.intake, settings: t.s.settings, spoolDir: t.spoolDir, interfaces: () => LOOPBACK, now: () => t.clock.now });
    open.push(next);
    await next.start();
    expect(next.status().running).toBe(false);
    expect(await listening(port)).toBe(false);
  });
});

describe('bonnenscanner: de plek van de foto (GPS) gaat eruit als locatie uit staat', () => {
  /** alles vanaf de eerste kwantisatietabel: het beeld zelf, zonder de gegevens over de foto */
  const image = (jpeg: Buffer) => jpeg.subarray(jpeg.indexOf(Buffer.from([0xff, 0xdb])));
  /** de breedtegraad zoals hij in de EXIF staat (52/1, 5/1, 2652/100) */
  const LAT = Buffer.from('340000000100000005000000010000005c0a000064000000', 'hex');

  it('de GPS-gegevens en het XMP-blok met de positie zijn weg; beeld, draairichting en merk blijven', () => {
    const original = makeJpegWithGps();
    const gps = readJpegGps(original)!;
    expect(gps.lat).toBeCloseTo(GPS_POSITION.lat, 6);
    expect(gps.lon).toBeCloseTo(GPS_POSITION.lon, 6);
    expect(original.includes(LAT)).toBe(true);
    expect(original.includes('exif:GPSLatitude')).toBe(true);

    const stripped = stripJpegGps(original);
    expect(readJpegGps(stripped)).toBeNull();
    expect(stripped.includes(LAT)).toBe(false);
    expect(stripped.includes('GPS')).toBe(false);
    // de GPS-datum is weg, de datum van de foto blijft
    expect(original.toString('latin1').split('2026:10:01')).toHaveLength(3);
    expect(stripped.toString('latin1').split('2026:10:01')).toHaveLength(2);
    expect(stripped.includes('2026:10:01 10:00:00')).toBe(true);
    expect(stripped.includes('Testtelefoon')).toBe(true);
    // nog steeds dezelfde JPEG: zelfde afmetingen en draairichting, en het beeld byte voor byte gelijk
    expect(jpegInfo(stripped)).toEqual(jpegInfo(original));
    expect(jpegInfo(stripped)).toMatchObject({ width: 48, height: 72, orientation: 6 });
    expect(image(stripped).equals(image(original))).toBe(true);
    // het origineel is niet aangeraakt, en nog een keer strippen verandert niets meer
    expect(readJpegGps(original)).not.toBeNull();
    expect(stripJpegGps(stripped).equals(stripped)).toBe(true);
    // een foto zonder positie blijft precies zoals hij is
    expect(stripJpegGps(makeJpeg('zonder')).equals(makeJpeg('zonder'))).toBe(true);
    // ook met de andere bytevolgorde (big-endian), zoals de testfoto van #32
    const big = Buffer.from(makeMinimalGpsJpeg(52.0907, 5.1214));
    expect(readJpegGps(big)).not.toBeNull();
    expect(readJpegGps(stripJpegGps(big))).toBeNull();
  });

  it('kapotte EXIF breekt niets: het beeld blijft, een onleesbaar blok gaat in zijn geheel weg', () => {
    const original = makeJpegWithGps();
    const exifAt = original.indexOf('Exif\0\0', 0, 'latin1');
    const tiff = exifAt + 6;
    const broken: [string, (b: Buffer) => void][] = [
      ['geen TIFF-kop', (b) => b.write('XX', tiff, 'latin1')],
      ['hoofdmap buiten het blok', (b) => b.writeUInt32LE(0xfffffff0, tiff + 4)],
      ['veel te veel regels', (b) => b.writeUInt16LE(0xffff, tiff + 8)],
      ['GPS-verwijzing buiten het blok', (b) => b.writeUInt32LE(0x7fffffff, tiff + 8 + 2 + 3 * 12 + 8)],
      ['GPS-map met te veel regels', (b) => b.writeUInt16LE(0xffff, tiff + b.readUInt32LE(tiff + 8 + 2 + 3 * 12 + 8))],
      ['waarde van een GPS-regel buiten het blok', (b) => b.writeUInt32LE(0x7ffffff0, tiff + b.readUInt32LE(tiff + 8 + 2 + 3 * 12 + 8) + 2 + 2 * 12 + 8)],
      ['GPS-verwijzing wijst naar de hoofdmap zelf', (b) => b.writeUInt32LE(8, tiff + 8 + 2 + 3 * 12 + 8)],
    ];
    for (const [what, damage] of broken) {
      const b = Buffer.from(original);
      damage(b);
      const out = stripJpegGps(b);
      expect(image(out).equals(image(original)), what).toBe(true);
      expect(jpegInfo(out), what).toMatchObject({ width: 48, height: 72 });
      expect(out.includes(LAT), what).toBe(false);
      expect(readJpegGps(out), what).toBeNull();
    }
    // afgebroken midden in de EXIF, en willekeurige beschadigingen: nooit een fout
    for (let cut = 4; cut < 400; cut += 7) expect(() => stripJpegGps(original.subarray(0, cut))).not.toThrow();
    let seed = 48;
    const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const end = original.indexOf(Buffer.from([0xff, 0xdb]));
    for (let i = 0; i < 2000; i++) {
      const b = Buffer.from(original);
      for (let n = 0; n < 1 + Math.floor(random() * 4); n++) b[2 + Math.floor(random() * (end - 2))] = Math.floor(random() * 256);
      expect(() => stripJpegGps(b)).not.toThrow();
    }
  });

  it('een bon van de telefoon: zonder toestemming staat er geen positie in het bewaarde bestand, in de wachtrij of in de database', async () => {
    const t = start();
    const p = await pair(t);
    const stored: Buffer[] = [];
    const add = t.s.intake.add.bind(t.s.intake);
    let hold = true;
    t.s.intake.add = async (name, data, ...rest) => {
      if (hold) throw new Error('nog niet');
      stored.push(Buffer.from(data));
      return add(name, data, ...rest);
    };
    const photo = makeJpegWithGps('zonder toestemming');
    const id = randomUUID();
    expect((await p.bon({ id }, [photo])).json).toMatchObject({ ok: true, al: false });
    await t.scanner.processSpool();
    const spooled = readFileSync(join(t.spoolDir, `${id}.bon`));
    expect(spooled.includes(LAT) || spooled.includes('GPS')).toBe(false);
    // nog een keer sturen (met de positie er nog in) is dezelfde bon, geen botsing
    expect((await p.bon({ id }, [photo])).json).toMatchObject({ ok: true, al: true });
    hold = false;
    await t.scanner.processSpool();
    expect(stored).toHaveLength(1);
    expect(readJpegGps(stored[0]!)).toBeNull();
    expect(stored[0]!.includes(LAT) || stored[0]!.includes('GPS')).toBe(false);
    expect(jpegInfo(stored[0]!)).toMatchObject({ width: 48, height: 72, orientation: 6 });
    expect(image(stored[0]!).equals(image(photo))).toBe(true);
    expect(t.documents()).toMatchObject([{ mime_type: 'image/jpeg', gps_lat: null, gps_lon: null }]);
  });

  it('met toestemming blijft de positie zoals nu: in het bestand en bij het document', async () => {
    const t = start();
    t.s.settings.update({ jobLocation: true });
    const p = await pair(t);
    const stored: Buffer[] = [];
    const add = t.s.intake.add.bind(t.s.intake);
    t.s.intake.add = async (name, data, ...rest) => {
      stored.push(Buffer.from(data));
      return add(name, data, ...rest);
    };
    const photo = makeJpegWithGps('met toestemming');
    const id = randomUUID();
    expect((await p.bon({ id }, [photo])).status).toBe(200);
    await t.scanner.processSpool();
    expect(stored[0]!.equals(photo)).toBe(true);
    const doc = t.documents()[0]!;
    expect(doc.gps_lat).toBeCloseTo(GPS_POSITION.lat, 6);
    expect(doc.gps_lon).toBeCloseTo(GPS_POSITION.lon, 6);
    // dezelfde bon nog een keer nadat locatie is uitgezet: nog steeds dezelfde bon
    t.s.settings.update({ jobLocation: false });
    expect((await p.bon({ id }, [photo])).json).toMatchObject({ ok: true, al: true });
  });

  it('een bon van meerdere foto\'s: ook in de PDF staat zonder toestemming geen positie', async () => {
    const t = start();
    const p = await pair(t);
    const stored: Buffer[] = [];
    const add = t.s.intake.add.bind(t.s.intake);
    t.s.intake.add = async (name, data, ...rest) => {
      stored.push(Buffer.from(data));
      return add(name, data, ...rest);
    };
    const photos = [makeJpegWithGps('boven'), makeJpegWithGps('onder')];
    expect((await p.bon({}, photos)).status).toBe(200);
    await t.scanner.processSpool();
    expect(t.documents()).toMatchObject([{ mime_type: 'application/pdf', gps_lat: null }]);
    expect(stored[0]!.includes(LAT) || stored[0]!.includes('GPS')).toBe(false);
    // de pagina's staan er nog steeds gekanteld in zoals de foto zegt, en de PDF is te openen
    expect(stored[0]!.includes('/Rotate 90')).toBe(true);
    expect((await extractPdf(new Uint8Array(stored[0]!))).pageSizes).toHaveLength(2);
    // met toestemming gaan de foto's ongewijzigd de PDF in
    t.s.settings.update({ jobLocation: true });
    expect((await p.bon({}, [makeJpegWithGps('boven 2'), makeJpegWithGps('onder 2')])).status).toBe(200);
    await t.scanner.processSpool();
    expect(stored[1]!.includes(LAT)).toBe(true);
  });
});
