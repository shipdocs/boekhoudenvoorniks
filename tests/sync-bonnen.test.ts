import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BON_BETAALWIJZEN, BON_LIMIETEN, leesBonVelden, leesFotoVelden, type Wijziging } from '@gratis-boekhouden/kern';
import { setup } from './helpers';
import { makeJpeg, makeJpegWithGps } from './fixtures/jpeg';
import { readJpegGps } from '../src/intake/exif';
import { RelationsService } from '../src/relations/relations';
import { Bonnenscanner } from '../src/scanner/scanner';
import { PHONE_SCANNER } from '../src/shared/phone-scanner';
import { ReceiptSpool } from '../src/scanner/spool';
import { CONTENT_TYPE, ENDPOINT_PATH, LIMITS, PAYMENT_METHODS, decodePairing, encodeFrame, openResponse, parseFrame, sealRequest, type PairingPayload, type ProtocolVersion } from '../src/scanner/protocol';
import { SyncOntvangst } from '../src/sync/ontvangst';

// De pc-kant van een bon als v2-wijziging (docs/bonnenscanner-protocol.md): entiteit bon, revisie 1, de JPEG's als
// bijlage achter de JSON met grootte en sha256 per foto. De tests gebruiken een echte databank, de echte spool, de echte
// SyncOntvangst en de echte receiver (HTTP over loopback), en relatieve datums.

const LOOPBACK = [{ address: '127.0.0.1', netmask: '255.0.0.0' }];
const DAG = 24 * 60 * 60 * 1000;
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const fotoVelden = (fotos: Buffer[]) => fotos.map((f) => ({ grootte: f.length, sha256: sha(f) }));
const bonVelden = (fotos: Buffer[], over: Record<string, unknown> = {}): Record<string, unknown> => ({ betaalwijze: 'contant', notitie: 'Schroeven voor de klus', fotos: fotoVelden(fotos), ...over });

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

function start(beginKlok = Date.now()) {
  const t = setup();
  const spoolDir = mkdtempSync(join(tmpdir(), 'bvn-sync-bonnen-'));
  dirs.push(spoolDir);
  const clock = { now: beginKlok };
  const scanner = new Bonnenscanner({ db: t.db, secrets: t.secrets, intake: t.s.intake, settings: t.s.settings, spoolDir, interfaces: () => LOOPBACK, now: () => clock.now });
  open.push(scanner);
  // de inbox doet het even niet: zo is te zien wat er in de spool staat; geefVrij() zet hem weer aan
  let vast = true;
  const add = t.s.intake.add.bind(t.s.intake);
  t.s.intake.add = async (...args) => {
    if (vast) throw new Error('nog niet');
    return add(...args);
  };
  const geefVrij = () => {
    vast = false;
  };
  const documents = () => t.db.prepare('SELECT * FROM documents ORDER BY id').all() as Record<string, unknown>[];
  const logs: string[] = [];
  /** een tweede ingang op dezelfde administratie en spool (route map of mail, of met een kapotte opslag) */
  const direct = (spool = new ReceiptSpool(t.db, spoolDir), keepLocation = () => false) =>
    new SyncOntvangst(t.db, new RelationsService(t.db), { now: () => clock.now, log: (m) => logs.push(m), spool, keepLocation });
  const n = (sql: string, ...p: unknown[]) => (t.db.prepare(sql).get(...p) as { n: number }).n;
  const rijen = () => ({
    spool: n('SELECT COUNT(*) AS n FROM scanner_documents'),
    register: n('SELECT COUNT(*) AS n FROM sync_ontvangen'),
    wachtrij: n('SELECT COUNT(*) AS n FROM sync_wachtrij'),
    bestanden: existsSync(spoolDir) ? readdirSync(spoolDir).length : 0,
  });
  return { ...t, scanner, spoolDir, clock, documents, direct, n, rijen, logs, geefVrij };
}
type Omg = ReturnType<typeof start>;

interface Reply {
  status: number;
  sealed: boolean;
  json: Record<string, unknown> | null;
}

/** De telefoon: een eigen payload-bouwer voor het bon-bericht en voor de wijziging met bijlagen. */
async function koppel(t: Omg, pairingOver?: (p: PairingPayload) => PairingPayload) {
  const started = await t.scanner.pair();
  const pairing = pairingOver ? pairingOver(decodePairing(started.payload)) : decodePairing(started.payload);
  const key = Buffer.from(pairing.sleutel, 'base64url');
  const deviceId = Buffer.from(pairing.apparaat, 'base64url');
  const url = `http://${pairing.adressen[0]}:${pairing.poort}${ENDPOINT_PATH}`;
  const verstuur = async (json: Record<string, unknown>, opts: { versie?: ProtocolVersion; bijlagen?: Buffer[] } = {}): Promise<Reply> => {
    const nonce = randomBytes(12);
    const body = sealRequest(deviceId, key, encodeFrame(json, opts.bijlagen ?? []), nonce, opts.versie ?? 2);
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': CONTENT_TYPE }, body: new Uint8Array(body) });
    const raw = Buffer.from(await res.arrayBuffer());
    if ((res.headers.get('content-type') ?? '') === CONTENT_TYPE) {
      const antwoord = openResponse(raw, key, nonce);
      return { status: res.status, sealed: antwoord !== null, json: antwoord };
    }
    return { status: res.status, sealed: false, json: raw.length ? (JSON.parse(raw.toString('utf8')) as Record<string, unknown>) : null };
  };
  /** het bon-bericht (de oude route) */
  const bonBericht = (id: string, fotos: Buffer[], over: Record<string, unknown> = {}) =>
    verstuur({ soort: 'bon', tijd: t.clock.now, id, betaalwijze: 'contant', notitie: 'Schroeven voor de klus', fotos: fotos.map((f) => ({ grootte: f.length })), ...over }, { bijlagen: fotos });
  /** een wijziging met entiteit bon; `bijlagen` overschrijft wat er echt achter de JSON komt */
  const bon = (fotos: Buffer[], over: { uuid?: string; revisie?: number; tijd?: number; velden?: Record<string, unknown>; entiteit?: string; versie?: ProtocolVersion; bijlagen?: Buffer[] } = {}) =>
    verstuur(
      { soort: 'wijziging', tijd: t.clock.now, wijziging: { entiteit: over.entiteit ?? 'bon', uuid: over.uuid ?? randomUUID(), revisie: over.revisie ?? 1, tijd: over.tijd ?? t.clock.now - 60_000, velden: over.velden ?? bonVelden(fotos) } },
      { versie: over.versie ?? 2, bijlagen: over.bijlagen ?? fotos },
    );
  return { apparaat: pairing.apparaat, verstuur, bonBericht, bon };
}

/** De bon in de spool terug uit het bestand, voor vergelijking. */
const spoolInhoud = (t: Omg, id: string) => parseFrame(readFileSync(join(t.spoolDir, `${id}.bon`)));

describe('een bon als wijziging met bijlagen op de pc', () => {
  it('BON-01 een bon via de wijzigingsroute: 200 toegepast, dezelfde spool en bestanden als bij het bon-bericht, en een registerrij met route netwerk', async () => {
    const t = start();
    const p = await koppel(t);
    const fotos = [makeJpeg('voorkant'), makeJpeg('achterkant')];
    const uuid = randomUUID();
    const r = await p.bon(fotos, { uuid, velden: bonVelden(fotos, { locatie: { lat: 52.09, lon: 5.12 } }) });
    expect(r).toMatchObject({ status: 200, sealed: true, json: { ok: true, soort: 'wijziging', entiteit: 'bon', uuid, revisie: 1, uitkomst: 'toegepast' } });
    expect(t.db.prepare('SELECT id, device_id, state FROM scanner_documents').all()).toEqual([{ id: uuid, device_id: p.apparaat, state: 'wacht' }]);
    expect(readdirSync(t.spoolDir)).toEqual([`${uuid}.bon`]);
    // hetzelfde bestand als het bon-bericht van dezelfde bon: alleen id en tijd verschillen
    const bonId = randomUUID();
    expect((await p.bonBericht(bonId, fotos)).json).toMatchObject({ ok: true, soort: 'bon', al: false });
    const viaWijziging = spoolInhoud(t, uuid);
    const viaBericht = spoolInhoud(t, bonId);
    expect(viaWijziging).toMatchObject({ soort: 'bon', id: uuid, betaalwijze: 'contant', notitie: 'Schroeven voor de klus', locatie: null });
    expect({ ...viaWijziging, id: '', tijd: 0 }).toEqual({ ...viaBericht, id: '', tijd: 0 });
    expect((viaWijziging as { fotos: Buffer[] }).fotos.map((f) => f.equals(fotos[0]!) || f.equals(fotos[1]!))).toEqual([true, true]);
    // het jsonc-voorbeeld in het document is precies zo'n bericht, met de JPEG van 751 bytes als bijlage
    const doc = readFileSync(join(__dirname, '..', 'docs', 'bonnenscanner-protocol.md'), 'utf8').replace(/\r\n/g, '\n');
    const voorbeeld = JSON.parse(doc.match(/```jsonc\n(\{"soort":"wijziging"[^\n]*"entiteit":"bon"[^\n]*)\n```/)![1]!) as Record<string, unknown>;
    const voorbeeldFoto = makeJpeg('voorbeeld');
    const gelezen = parseFrame(encodeFrame(voorbeeld, [voorbeeldFoto]), 2);
    expect(gelezen).toMatchObject({ soort: 'wijziging', wijziging: { entiteit: 'bon', revisie: 1 }, bijlagen: [voorbeeldFoto] });
    expect(voorbeeldFoto.length).toBe(751);
    if (gelezen.soort !== 'wijziging') throw new Error('onverwacht: geen wijziging');
    expect(leesBonVelden(gelezen.wijziging.velden)).toMatchObject({ ok: true, velden: { betaalwijze: 'contant', fotos: [{ grootte: 751, sha256: sha(voorbeeldFoto) }] } });
    expect(t.db.prepare('SELECT apparaat_id, entiteit, uuid, revisie, uitkomst, fout, route FROM sync_ontvangen').all()).toEqual([
      { apparaat_id: p.apparaat, entiteit: 'bon', uuid, revisie: 1, uitkomst: 'toegepast', fout: null, route: 'netwerk' },
    ]);
  });

  it('BON-02 herhaling: dezelfde wijziging opnieuw (twee dagen later) geeft 200 overgeslagen en geen nieuwe rij of bestand', async () => {
    const t = start();
    const p = await koppel(t);
    const fotos = [makeJpeg('herhaling')];
    const uuid = randomUUID();
    const tijd = t.clock.now - 3 * DAG;
    expect((await p.bon(fotos, { uuid, tijd })).json).toMatchObject({ uitkomst: 'toegepast' });
    const na = t.rijen();
    expect(na).toEqual({ spool: 1, register: 1, wachtrij: 0, bestanden: 1 });
    t.clock.now += 2 * DAG;
    const nogEens = await p.bon(fotos, { uuid, tijd });
    expect(nogEens).toMatchObject({ status: 200, sealed: true, json: { ok: true, uitkomst: 'overgeslagen' } });
    expect(nogEens.json).not.toHaveProperty('fout');
    expect(t.rijen()).toEqual(na);
    expect(t.db.prepare('SELECT uitkomst, tijd FROM sync_ontvangen').all()).toEqual([{ uitkomst: 'toegepast', tijd }]);
  });

  it('BON-03 andere route: verwerk() met route map of mail op dezelfde sleutel geeft overgeslagen en de route in het register blijft die van de eerste', async () => {
    const t = start();
    const p = await koppel(t);
    const fotos = [makeJpeg('route')];
    const uuid = randomUUID();
    expect((await p.bon(fotos, { uuid })).json).toMatchObject({ uitkomst: 'toegepast' });
    const na = t.rijen();
    const sync = t.direct();
    const w: Wijziging = { entiteit: 'bon', uuid, revisie: 1, tijd: t.clock.now, velden: bonVelden(fotos) };
    for (const route of ['map', 'mail']) expect(sync.verwerk(p.apparaat, 'M1', w, route, fotos), route).toEqual({ status: 200, uitkomst: 'overgeslagen' });
    expect(t.rijen()).toEqual(na);
    expect(t.db.prepare('SELECT route FROM sync_ontvangen WHERE uuid = ?').all(uuid)).toEqual([{ route: 'netwerk' }]);
    // een nieuwe bon via de mail wordt wel opgeslagen, met zijn eigen route
    const nieuw = { ...w, uuid: randomUUID() };
    expect(sync.verwerk(p.apparaat, 'M1', nieuw, 'mail', fotos)).toEqual({ status: 200, uitkomst: 'toegepast' });
    expect(t.db.prepare('SELECT route FROM sync_ontvangen WHERE uuid = ?').all(nieuw.uuid)).toEqual([{ route: 'mail' }]);
  });

  it('BON-04 revisie en botsing: revisie 2 is een vormfout; hetzelfde id met andere inhoud (eerst via het bon-bericht) geeft 200 afgewezen id-botst en de eerste inhoud blijft', async () => {
    const t = start();
    const p = await koppel(t);
    const eerste = [makeJpeg('eerste')];
    const andere = [makeJpeg('andere foto')];
    const r2 = await p.bon(eerste, { revisie: 2 });
    expect(r2).toMatchObject({ status: 400, sealed: true, json: { ok: false, fout: 'ongeldig' } });
    expect(t.rijen()).toEqual({ spool: 0, register: 0, wachtrij: 0, bestanden: 0 });
    // dit id kwam al binnen als bon-bericht (geen registerrij); nu hetzelfde id met een andere foto en andere velden
    const id = randomUUID();
    expect((await p.bonBericht(id, eerste)).json).toMatchObject({ ok: true, al: false });
    const botst = await p.bon(andere, { uuid: id, velden: bonVelden(andere, { betaalwijze: 'pin', notitie: null }) });
    expect(botst).toMatchObject({ status: 200, sealed: true, json: { ok: true, uitkomst: 'afgewezen', fout: 'id-botst' } });
    expect(t.db.prepare('SELECT uitkomst, fout, route FROM sync_ontvangen WHERE uuid = ?').all(id)).toEqual([{ uitkomst: 'afgewezen', fout: 'id-botst', route: 'netwerk' }]);
    expect(spoolInhoud(t, id)).toMatchObject({ betaalwijze: 'contant', notitie: 'Schroeven voor de klus', fotos: [eerste[0]] });
    expect(t.rijen()).toEqual({ spool: 1, register: 1, wachtrij: 0, bestanden: 1 });
    // een herhaling levert dezelfde afwijzing, zonder nieuwe rijen
    expect((await p.bon(andere, { uuid: id, velden: bonVelden(andere, { betaalwijze: 'pin', notitie: null }) })).json).toMatchObject({ uitkomst: 'afgewezen', fout: 'id-botst' });
    expect(t.rijen()).toEqual({ spool: 1, register: 1, wachtrij: 0, bestanden: 1 });
  });

  it('BON-05 bijlagen kloppen niet: verkeerde grootte, verkeerde sha256, te veel of te weinig bytes en een bijlage die geen JPEG is geven 400 ongeldig zonder rij of bestand', async () => {
    const t = start();
    const p = await koppel(t);
    const foto = makeJpeg('klopt niet');
    const geen = Buffer.from('dit is geen jpeg, maar wel even lang als een foto'.padEnd(foto.length, '.'));
    const gevallen: [string, Parameters<typeof p.bon>[1]][] = [
      ['grootte te groot', { velden: bonVelden([foto], { fotos: [{ grootte: foto.length + 1, sha256: sha(foto) }] }) }],
      ['grootte te klein', { velden: bonVelden([foto], { fotos: [{ grootte: foto.length - 1, sha256: sha(foto) }] }) }],
      ['verkeerde sha256', { velden: bonVelden([foto], { fotos: [{ grootte: foto.length, sha256: sha(makeJpeg('andere')) }] }) }],
      ['meer bytes dan de velden zeggen', { bijlagen: [foto, Buffer.from([1, 2, 3])] }],
      ['minder bytes dan de velden zeggen', { bijlagen: [foto.subarray(0, foto.length - 5)] }],
      ['geen bijlagen terwijl de velden een foto noemen', { bijlagen: [] }],
      ['geen JPEG', { velden: bonVelden([geen]), bijlagen: [geen] }],
    ];
    for (const [naam, over] of gevallen) {
      const r = await p.bon([foto], over);
      expect(r, naam).toMatchObject({ status: 400, sealed: true, json: { ok: false, fout: 'ongeldig' } });
      expect(t.rijen(), naam).toEqual({ spool: 0, register: 0, wachtrij: 0, bestanden: 0 });
    }
    // ook wie SyncOntvangst rechtstreeks aanroept (map, mail) krijgt dezelfde controle
    const sync = t.direct();
    const w: Wijziging = { entiteit: 'bon', uuid: randomUUID(), revisie: 1, tijd: t.clock.now, velden: bonVelden([foto]) };
    expect(sync.verwerk(p.apparaat, 'M1', w, 'map', [])).toMatchObject({ status: 400, fout: 'ongeldig' });
    expect(sync.verwerk(p.apparaat, 'M1', w, 'map', [geen])).toMatchObject({ status: 400, fout: 'ongeldig' });
    expect(t.rijen()).toEqual({ spool: 0, register: 0, wachtrij: 0, bestanden: 0 });
    expect(sync.verwerk(p.apparaat, 'M1', w, 'map', [foto])).toMatchObject({ status: 200, uitkomst: 'toegepast' });
  });

  it('BON-06 grenzen: 10 foto\'s kan, 11 en nul geven 400, samen boven maxPhotoBytes geeft 413 te-groot en het bericht blijft binnen maxBodyBytes', async () => {
    const t = start();
    const p = await koppel(t);
    const tien = Array.from({ length: 10 }, (_, i) => makeJpeg(`foto ${i}`));
    expect(await p.bon(tien)).toMatchObject({ status: 200, json: { uitkomst: 'toegepast' } });
    expect(spoolInhoud(t, (t.db.prepare('SELECT id FROM scanner_documents').get() as { id: string }).id)).toMatchObject({ fotos: tien });
    const voor = t.rijen();
    const elf = [...tien, makeJpeg('elf')];
    expect(await p.bon(elf)).toMatchObject({ status: 400, json: { ok: false, fout: 'ongeldig' } });
    expect(await p.bon([], { velden: bonVelden([]), bijlagen: [] })).toMatchObject({ status: 400, json: { ok: false, fout: 'veld-ongeldig', veld: 'fotos' } });
    expect(t.rijen()).toEqual(voor);
    // precies op de grens (19 MiB samen) kan, een byte erboven is te groot; de envelop zelf past ruim in maxBodyBytes
    const opvulling = (totaal: number) => Buffer.concat([makeJpeg('groot'), Buffer.alloc(totaal - makeJpeg('groot').length)]);
    const opGrens = opvulling(LIMITS.maxPhotoBytes);
    expect(LIMITS.maxPhotoBytes + 4 * 1024).toBeLessThan(LIMITS.maxBodyBytes);
    expect(await p.bon([opGrens])).toMatchObject({ status: 200, json: { uitkomst: 'toegepast' } });
    const eroverheen = opvulling(LIMITS.maxPhotoBytes + 1);
    expect(await p.bon([eroverheen])).toMatchObject({ status: 413, sealed: true, json: { ok: false, fout: 'te-groot' } });
    // samen boven de grens met meerdere foto's
    const helft = opvulling(Math.ceil((LIMITS.maxPhotoBytes + 1) / 2));
    expect(await p.bon([helft, helft])).toMatchObject({ status: 413, json: { fout: 'te-groot' } });
    expect(t.rijen()).toEqual({ ...voor, spool: voor.spool + 1, register: voor.register + 1, bestanden: voor.bestanden + 1 });
    // Dezelfde grenzen gelden voor wie SyncOntvangst rechtstreeks aanroept (map, mail): het bericht is er niet
    // eerder netwerk-klein gemaakt. Een notitie van spaties wordt door de kern getrimd en mag de grens niet omzeilen.
    const sync = t.direct();
    const foto = makeJpeg('map grens');
    const wijz = (velden: Record<string, unknown>): Wijziging => ({ entiteit: 'bon', uuid: randomUUID(), revisie: 1, tijd: t.clock.now, velden });
    for (const route of ['map', 'mail']) {
      const heleBody = sync.verwerk(p.apparaat, 'M1', wijz(bonVelden([foto], { notitie: ' '.repeat(LIMITS.maxBodyBytes + 1) })), route, [foto]);
      expect(heleBody, route).toMatchObject({ status: 413, fout: 'te-groot' });
      const jsonGroot = sync.verwerk(p.apparaat, 'M1', wijz(bonVelden([foto], { notitie: 'a'.repeat(LIMITS.maxWijzigingJsonBytes) })), route, [foto]);
      expect(jsonGroot, route).toMatchObject({ status: 413, fout: 'te-groot' });
      const somTeGroot = sync.verwerk(p.apparaat, 'M1', wijz(bonVelden([eroverheen])), route, [eroverheen]);
      expect(somTeGroot, route).toMatchObject({ status: 413, fout: 'te-groot' });
      const tweeTeGroot = sync.verwerk(p.apparaat, 'M1', wijz(bonVelden([helft, helft])), route, [helft, helft]);
      expect(tweeTeGroot, route).toMatchObject({ status: 413, fout: 'te-groot' });
      expect(sync.verwerk(p.apparaat, 'M1', wijz(bonVelden(elf)), route, elf), route).toMatchObject({ status: 400 });
      expect(sync.verwerk(p.apparaat, 'M1', wijz(bonVelden(elf)), route, tien), route).toMatchObject({ status: 400 });
      expect(sync.verwerk(p.apparaat, 'M1', wijz(bonVelden([])), route, []), route).toMatchObject({ status: 400, fout: 'veld-ongeldig', veld: 'fotos' });
    }
    // ook een fotowijziging (nog niet ondersteund, wel gecontroleerd) houdt zich aan de grens
    const fotoW: Wijziging = { entiteit: 'foto', uuid: randomUUID(), revisie: 1, tijd: t.clock.now, velden: { project_uuid: randomUUID(), fotos: fotoVelden([eroverheen]) } };
    expect(sync.verwerk(p.apparaat, 'M1', fotoW, 'map', [eroverheen])).toMatchObject({ status: 413, fout: 'te-groot' });
    // een notitie van precies de toegestane lengte (met spaties eromheen binnen de JSON-grens) blijft gewoon kunnen
    expect(sync.verwerk(p.apparaat, 'M1', wijz(bonVelden([foto], { notitie: `  ${'a'.repeat(LIMITS.maxNoteChars)}  ` })), 'map', [foto])).toMatchObject({ status: 200, uitkomst: 'toegepast' });
    expect(t.rijen()).toEqual({ ...voor, spool: voor.spool + 2, register: voor.register + 2, bestanden: voor.bestanden + 2 });
  });

  it('BON-07 velden: onbekend veld, __proto__, onbekende betaalwijze, stuurtekens, lange notitie, ongeldige locatie en lege fotos geven 400 veld-ongeldig met het veld; de kern is zuiver en heeft de grenzen van LIMITS', () => {
    const t = start();
    const sync = t.direct();
    const foto = makeJpeg('velden');
    const metProto = JSON.parse(`{"__proto__":{"x":1},"betaalwijze":"pin","fotos":${JSON.stringify(fotoVelden([foto]))}}`) as Record<string, unknown>;
    const gevallen: [string, Record<string, unknown>, string][] = [
      ['onbekend veld', bonVelden([foto], { kleur: 'rood' }), 'kleur'],
      ['__proto__', metProto, '__proto__'],
      ['onbekende betaalwijze', bonVelden([foto], { betaalwijze: 'bitcoin' }), 'betaalwijze'],
      ['geen betaalwijze', { fotos: fotoVelden([foto]) }, 'betaalwijze'],
      ['stuurtekens in de notitie', bonVelden([foto], { notitie: 'regel\u0000twee\u001b' }), 'notitie'],
      ['notitie boven de limiet', bonVelden([foto], { notitie: 'x'.repeat(LIMITS.maxNoteChars + 1) }), 'notitie'],
      ['notitie geen tekst', bonVelden([foto], { notitie: 12 }), 'notitie'],
      ['locatie buiten bereik', bonVelden([foto], { locatie: { lat: 91, lon: 5 } }), 'locatie'],
      ['locatie met extra sleutel', bonVelden([foto], { locatie: { lat: 1, lon: 5, hoogte: 3 } }), 'locatie'],
      ['locatie geen object', bonVelden([foto], { locatie: '52,5' }), 'locatie'],
      ['lege fotos', bonVelden([foto], { fotos: [] }), 'fotos'],
      ['foto met extra sleutel', bonVelden([foto], { fotos: [{ grootte: foto.length, sha256: sha(foto), naam: 'x' }] }), 'fotos'],
      ['sha256 met hoofdletters', bonVelden([foto], { fotos: [{ grootte: foto.length, sha256: sha(foto).toUpperCase() }] }), 'fotos'],
    ];
    for (const [naam, velden, veld] of gevallen) {
      const r = sync.verwerk(randomUUID(), 'M1', { entiteit: 'bon', uuid: randomUUID(), revisie: 1, tijd: t.clock.now, velden }, 'netwerk', [foto]);
      expect(r, naam).toMatchObject({ status: 400, fout: 'veld-ongeldig', veld });
      expect(r.melding, naam).toEqual(expect.any(String));
    }
    expect(t.rijen()).toEqual({ spool: 0, register: 0, wachtrij: 0, bestanden: 0 });
    // de notitie met regeleinden en een uitgebreide locatie mogen wel
    expect(leesBonVelden(bonVelden([foto], { notitie: 'twee\nregels', locatie: { lat: -90, lon: 180 } }))).toMatchObject({ ok: true, velden: { notitie: 'twee\nregels', locatie: { lat: -90, lon: 180 } } });
    // de kern: dezelfde grenzen als LIMITS en de betaalwijzen van het bon-bericht, zonder Node
    expect(BON_LIMIETEN.maxFotos).toBe(LIMITS.maxPhotos);
    expect(BON_LIMIETEN.maxFotoBytes).toBe(LIMITS.maxPhotoBytes);
    expect(BON_LIMIETEN.maxNotitieTekens).toBe(LIMITS.maxNoteChars);
    expect([...BON_BETAALWIJZEN]).toEqual([...PAYMENT_METHODS]);
    const bron = readFileSync(join(__dirname, '..', 'packages', 'core', 'src', 'sync', 'bon.ts'), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    expect(bron).not.toMatch(/from ['"](node:|fs|path|crypto)|\bBuffer\b|\bprocess\.|\brequire\(/);
    // zuiver: dezelfde invoer geeft hetzelfde en de invoer blijft ongemoeid
    const invoer = Object.freeze(bonVelden([foto]));
    expect(leesBonVelden(invoer)).toEqual(leesBonVelden(invoer));
    expect(leesFotoVelden({ project_uuid: randomUUID(), fotos: fotoVelden([foto]) })).toMatchObject({ ok: true });
    expect(leesFotoVelden({ betaalwijze: 'pin', fotos: fotoVelden([foto]) })).toMatchObject({ ok: false, veld: 'betaalwijze' });
  });

  it('BON-08 locatie: de locatie en de GPS-gegevens in de JPEG worden weggegooid, tenzij de instelling keepLocation (jobLocation) aan staat', async () => {
    const t = start();
    const p = await koppel(t);
    const metGps = makeJpegWithGps('met gps');
    expect(readJpegGps(metGps)).not.toBeNull();
    const zonder = randomUUID();
    expect((await p.bon([metGps], { uuid: zonder, velden: bonVelden([metGps], { locatie: { lat: 52.0907, lon: 5.1214 } }) })).json).toMatchObject({ uitkomst: 'toegepast' });
    const bewaard = spoolInhoud(t, zonder);
    expect(bewaard).toMatchObject({ soort: 'bon', locatie: null });
    expect(readJpegGps((bewaard as { fotos: Buffer[] }).fotos[0]!)).toBeNull();
    expect(readFileSync(join(t.spoolDir, `${zonder}.bon`)).toString('latin1')).not.toMatch(/52\.0907|GPSLatitude/);
    // met toestemming blijven de locatie en de positie in de foto bewaard
    t.s.settings.update({ jobLocation: true });
    const mee = randomUUID();
    const metGps2 = makeJpegWithGps('met toestemming');
    expect((await p.bon([metGps2], { uuid: mee, velden: bonVelden([metGps2], { locatie: { lat: 52.0907, lon: 5.1214 } }) })).json).toMatchObject({ uitkomst: 'toegepast' });
    const bewaard2 = spoolInhoud(t, mee) as unknown as { locatie: unknown; fotos: Buffer[] };
    expect(bewaard2.locatie).toEqual({ lat: 52.0907, lon: 5.1214 });
    expect(readJpegGps(bewaard2.fotos[0]!)).not.toBeNull();
    // en in de inbox: zonder toestemming geen positie bij het document, met toestemming wel
    t.geefVrij();
    await t.scanner.processSpool();
    expect(t.documents()).toMatchObject([{ gps_lat: null, gps_lon: null }, { gps_lat: 52.0907, gps_lon: 5.1214 }]);
  });

  it('BON-09 geen bijlagen bij andere entiteiten: een klant-, project- of factuurwijziging met bijlage geeft 400 ongeldig, en bon of foto in een versie-1-envelop wordt geweigerd', async () => {
    const t = start();
    const p = await koppel(t);
    const foto = makeJpeg('bijlage');
    const voorRelaties = t.n('SELECT COUNT(*) AS n FROM relations');
    for (const entiteit of ['klant', 'project', 'factuur']) {
      const r = await p.bon([foto], { entiteit, velden: entiteit === 'klant' ? { naam: 'Met bijlage' } : { titel: 'x' } });
      expect(r, entiteit).toMatchObject({ status: 400, sealed: true, json: { ok: false, fout: 'ongeldig' } });
    }
    expect(t.n('SELECT COUNT(*) AS n FROM relations')).toBe(voorRelaties);
    // dezelfde klantwijziging zonder bijlage wordt wel verwerkt
    expect((await p.bon([], { entiteit: 'klant', velden: { naam: 'Zonder bijlage' }, bijlagen: [] })).json).toMatchObject({ uitkomst: 'toegepast' });
    for (const entiteit of ['bon', 'foto']) {
      const r = await p.bon([foto], { entiteit, versie: 1, velden: entiteit === 'bon' ? bonVelden([foto]) : { project_uuid: randomUUID(), fotos: fotoVelden([foto]) } });
      expect(r, entiteit).toMatchObject({ status: 400, sealed: true, json: { ok: false, fout: 'ongeldig' } });
    }
    expect(t.rijen()).toEqual({ spool: 0, register: 1, wachtrij: 0, bestanden: 0 });
  });

  it('BON-10 foto blijft niet-ondersteund: een geldige fotowijziging met bijlagen geeft 200 niet-ondersteund en laat niets achter; zonder spool is ook bon niet-ondersteund', async () => {
    const t = start();
    const p = await koppel(t);
    const fotos = [makeJpeg('project 1'), makeJpeg('project 2')];
    const velden = { project_uuid: randomUUID(), notitie: 'voor de klus', fotos: fotoVelden(fotos) };
    const r = await p.bon(fotos, { entiteit: 'foto', velden });
    expect(r).toMatchObject({ status: 200, sealed: true, json: { ok: true, entiteit: 'foto', uitkomst: 'niet-ondersteund' } });
    expect(t.rijen()).toEqual({ spool: 0, register: 0, wachtrij: 0, bestanden: 0 });
    // wel gecontroleerd: een verkeerde sha256 is een vormfout, en velden die niet kloppen zijn veld-ongeldig
    expect(await p.bon(fotos, { entiteit: 'foto', velden: { ...velden, fotos: fotoVelden([fotos[1]!, fotos[0]!]) } })).toMatchObject({ status: 400, json: { fout: 'ongeldig' } });
    expect(await p.bon(fotos, { entiteit: 'foto', velden: { fotos: fotoVelden(fotos) } })).toMatchObject({ status: 400, json: { fout: 'veld-ongeldig', veld: 'project_uuid' } });
    expect(t.rijen()).toEqual({ spool: 0, register: 0, wachtrij: 0, bestanden: 0 });
    // een SyncOntvangst zonder spool laat een bon niet-ondersteund
    const zonderSpool = new SyncOntvangst(t.db, new RelationsService(t.db), { now: () => t.clock.now });
    const w: Wijziging = { entiteit: 'bon', uuid: randomUUID(), revisie: 1, tijd: t.clock.now, velden: bonVelden(fotos) };
    expect(zonderSpool.verwerk(p.apparaat, 'M1', w, 'netwerk', fotos)).toEqual({ status: 200, uitkomst: 'niet-ondersteund' });
    expect(t.rijen()).toEqual({ spool: 0, register: 0, wachtrij: 0, bestanden: 0 });
  });

  it('BON-11 halve rijen: een fout in de databank of in het bestand geeft 500 opslaan-mislukt zonder rij, registerrij of los bestand, en daarna werkt dezelfde wijziging', async () => {
    const t = start();
    const apparaat = randomUUID();
    const fotos = [makeJpeg('half'), makeJpeg('half 2')];
    const w: Wijziging = { entiteit: 'bon', uuid: randomUUID(), revisie: 1, tijd: t.clock.now, velden: bonVelden(fotos, { notitie: 'geheime notitie' }) };
    const sync = t.direct();
    // 1. de databank weigert de registerrij, nadat het bestand en de spoolrij al staan
    t.db.exec(`CREATE TRIGGER test_register_kapot BEFORE INSERT ON sync_ontvangen BEGIN SELECT RAISE(ABORT, 'kapot'); END`);
    expect(sync.verwerk(apparaat, 'M1', w, 'netwerk', fotos)).toEqual({ status: 500, fout: 'opslaan-mislukt' });
    expect(t.rijen()).toEqual({ spool: 0, register: 0, wachtrij: 0, bestanden: 0 });
    t.db.exec('DROP TRIGGER test_register_kapot');
    // 2. de databank weigert de spoolrij, nadat het bestand er staat (de spool ruimt dat zelf op)
    t.db.exec(`CREATE TRIGGER test_spool_kapot BEFORE INSERT ON scanner_documents BEGIN SELECT RAISE(ABORT, 'kapot'); END`);
    expect(sync.verwerk(apparaat, 'M1', w, 'netwerk', fotos)).toEqual({ status: 500, fout: 'opslaan-mislukt' });
    expect(t.rijen()).toEqual({ spool: 0, register: 0, wachtrij: 0, bestanden: 0 });
    t.db.exec('DROP TRIGGER test_spool_kapot');
    // 3. het bestand kan niet geschreven worden (de spoolmap is een bestand)
    const blokkade = join(t.spoolDir, '..', `bvn-blokkade-${randomUUID()}`);
    writeFileSync(blokkade, 'geen map');
    dirs.push(blokkade);
    const kapotteSpool = t.direct(new ReceiptSpool(t.db, join(blokkade, 'spool')));
    expect(kapotteSpool.verwerk(apparaat, 'M1', w, 'netwerk', fotos)).toEqual({ status: 500, fout: 'opslaan-mislukt' });
    expect(t.rijen()).toEqual({ spool: 0, register: 0, wachtrij: 0, bestanden: 0 });
    // nooit inhoud van de bon in het logboek
    expect(t.logs.length).toBeGreaterThanOrEqual(3);
    for (const regel of t.logs) expect(regel).not.toMatch(/geheime notitie/);
    // daarna werkt dezelfde wijziging gewoon, precies een keer
    expect(sync.verwerk(apparaat, 'M1', w, 'netwerk', fotos)).toEqual({ status: 200, uitkomst: 'toegepast' });
    expect(sync.verwerk(apparaat, 'M1', w, 'netwerk', fotos)).toEqual({ status: 200, uitkomst: 'overgeslagen' });
    expect(t.rijen()).toEqual({ spool: 1, register: 1, wachtrij: 0, bestanden: 1 });

    // 4. de rollback zelf mislukt: het bestand kan niet verwijderd worden. Dat verdwijnt niet stil: het bestand wordt
    // onthouden, geen herstel (recover) importeert het ooit als bon, en zodra het kan gaat het alsnog weg.
    const w2: Wijziging = { entiteit: 'bon', uuid: randomUUID(), revisie: 1, tijd: t.clock.now, velden: bonVelden(fotos, { notitie: 'tweede geheime notitie' }) };
    const spool2 = new ReceiptSpool(t.db, t.spoolDir);
    const sync2 = t.direct(spool2);
    const bestand = join(t.spoolDir, `${w2.uuid}.bon`);
    const rijenVoor = t.rijen();
    // kan niet verwijderen: de spoolmap is niet schrijfbaar (niet als root; dan blijft het bestand staan door een
    // nagebootste fout van het verwijderen zelf, zie ReceiptSpool.verwijderBestand)
    const root = typeof process.getuid === 'function' && process.getuid() === 0;
    const hersteld: (() => void)[] = [];
    const echtVerwijderen = spool2.verwijderBestand.bind(spool2);
    t.db.function('blokkeer_verwijderen', () => {
      if (!root) {
        chmodSync(t.spoolDir, 0o500);
        hersteld.push(() => chmodSync(t.spoolDir, 0o700));
      } else {
        spool2.verwijderBestand = () => {
          throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
        };
      }
      return 1;
    });
    t.db.exec(`CREATE TRIGGER test_register_kapot2 BEFORE INSERT ON sync_ontvangen BEGIN SELECT blokkeer_verwijderen(); SELECT RAISE(ABORT, 'kapot'); END`);
    try {
      expect(sync2.verwerk(apparaat, 'M1', w2, 'map', fotos)).toEqual({ status: 500, fout: 'opslaan-mislukt' });
      // de rijen zijn teruggedraaid; het bestand staat nog, maar is gemarkeerd als te verwijderen
      expect(t.rijen()).toEqual({ ...rijenVoor, bestanden: rijenVoor.bestanden + 1 });
      expect(existsSync(bestand)).toBe(true);
      expect(t.logs.some((r) => /verwijder/i.test(r))).toBe(true);
      for (const regel of t.logs) expect(regel).not.toMatch(/geheime notitie/);
    } finally {
      for (const f of hersteld) f();
      spool2.verwijderBestand = echtVerwijderen;
      t.db.exec('DROP TRIGGER test_register_kapot2');
    }
    // zelfs met herstelde rechten: recover en de inbox maken er nooit een bon van, en het bestand gaat weg
    spool2.recover();
    t.geefVrij();
    await t.scanner.processSpool();
    // alleen de eerdere, echte bon (uit stap 1 tot 3) is in de inbox gekomen; zijn kopie in de spool is daarna weg
    expect(t.rijen()).toEqual({ ...rijenVoor, bestanden: 0 });
    expect(existsSync(bestand)).toBe(false);
    expect(t.n('SELECT COUNT(*) AS n FROM scanner_documents WHERE id = ?', w2.uuid)).toBe(0);
    expect(t.documents()).toHaveLength(1);
    // en dezelfde wijziging komt daarna gewoon binnen, precies een keer
    expect(sync2.verwerk(apparaat, 'M1', w2, 'map', fotos)).toEqual({ status: 200, uitkomst: 'toegepast' });
    expect(t.rijen()).toEqual({ ...rijenVoor, spool: rijenVoor.spool + 1, register: rijenVoor.register + 1, bestanden: 1 });
  });

  it('BON-12 bevestiging en aansluiting: toegepast en afgewezen veroorzaken geen wachtrijrij; de bon staat in de inbox zoals een bon uit het bon-bericht en de tellers blijven staan', async () => {
    const t = start(Date.now() - 400 * DAG);
    const p = await koppel(t);
    const tellers = () => ({
      sync: t.db.prepare('SELECT naam, waarde FROM sync_teller ORDER BY naam').all(),
      pc: t.db.prepare(`SELECT key, value FROM settings WHERE key LIKE 'counter:%' ORDER BY key`).all(),
    });
    const voor = tellers();
    const foto = makeJpeg('aansluiting via het bericht');
    const foto2 = makeJpeg('aansluiting via de wijziging');
    // dezelfde bon (andere foto, anders ziet de inbox een dubbele) via beide routes
    const viaBericht = randomUUID();
    const viaWijziging = randomUUID();
    expect((await p.bonBericht(viaBericht, [foto], { betaalwijze: 'prive' })).json).toMatchObject({ ok: true, al: false });
    expect((await p.bon([foto2], { uuid: viaWijziging, velden: bonVelden([foto2], { betaalwijze: 'prive' }) })).json).toMatchObject({ uitkomst: 'toegepast' });
    // een afgewezen bon: hetzelfde id als de eerste, andere foto
    const andere = makeJpeg('botsing');
    expect((await p.bon([andere], { uuid: viaBericht, velden: bonVelden([andere], { betaalwijze: 'prive' }) })).json).toMatchObject({ uitkomst: 'afgewezen', fout: 'id-botst' });
    expect(t.n('SELECT COUNT(*) AS n FROM sync_wachtrij')).toBe(0);
    expect(t.rijen().register).toBe(2);
    t.geefVrij();
    await t.scanner.processSpool();
    const docs = t.documents();
    expect(docs).toHaveLength(2);
    const sleutels = ['mime_type', 'status', 'note', 'proposed_paid_with', 'purchase_invoice_id'] as const;
    const kies = (d: Record<string, unknown>) => Object.fromEntries(sleutels.map((s) => [s, d[s]]));
    expect(kies(docs[1]!)).toEqual(kies(docs[0]!));
    expect(docs[1]).toMatchObject({ mime_type: 'image/jpeg', status: 'controle', note: 'Schroeven voor de klus', proposed_paid_with: 'prive' });
    expect(t.db.prepare('SELECT id, state FROM scanner_documents ORDER BY rowid').all()).toEqual([
      { id: viaBericht, state: 'verwerkt' },
      { id: viaWijziging, state: 'verwerkt' },
    ]);
    expect(readdirSync(t.spoolDir)).toEqual([]);
    expect(t.s.purchases.list()).toHaveLength(0);
    expect(t.n('SELECT COUNT(*) AS n FROM sync_wachtrij')).toBe(0);
    // de pc-teller en de wijzigingsteller zijn niet geraakt
    expect(tellers()).toEqual(voor);
  });
});
