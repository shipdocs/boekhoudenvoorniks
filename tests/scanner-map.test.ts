import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, existsSync, ftruncateSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeTotals, type LineInput } from '@gratis-boekhouden/kern';
import { setup } from './helpers';
import { makeJpeg } from './fixtures/jpeg';
import { migrate } from '../src/db/database';
import { migrations } from '../src/db/migrations';
import { createApi, type HostContext } from '../src/main/api';
import { RelationsService } from '../src/relations/relations';
import { MAP_MAX_ONGEZIEN, MAP_MAX_PER_RONDE, MapRoute } from '../src/scanner/map-route';
import { ScannerPairing } from '../src/scanner/pairing';
import { CONTENT_TYPE, ENDPOINT_PATH, LIMITS, decodePairing, encodeFrame, openResponse, sealRequest, type ProtocolVersion } from '../src/scanner/protocol';
import { ScannerReceiver, type Behandeld } from '../src/scanner/receiver';
import { Bonnenscanner } from '../src/scanner/scanner';
import { ReceiptSpool } from '../src/scanner/spool';
import { PHONE_SCANNER } from '../src/shared/phone-scanner';
import { SyncOntvangst } from '../src/sync/ontvangst';

// De bonnenmap als tweede route (docs/bonnenscanner-protocol.md): dezelfde versleutelde berichten als over het netwerk reizen
// als bestanden door van-telefoon/ en van-pc/. Echte databank, echte bestanden in tijdelijke mappen, de echte receiver, SyncOntvangst
// en InvoiceService, een eigen payload-bouwer en relatieve datums. De rondgang wordt met scanMap() zelf gedraaid (stabiele grootte
// 0 ms): de test wacht op een toestand, nooit een vaste tijd. Bestandsfouten worden nagebootst via de opties van de scanner (ook op Windows).

const LOOPBACK = [{ address: '127.0.0.1', netmask: '255.0.0.0' }];
const DAG = 24 * 60 * 60 * 1000;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const fotoVelden = (fotos: Buffer[]) => fotos.map((f) => ({ grootte: f.length, sha256: sha(f) }));

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

const tmp = (voorvoegsel: string) => {
  // het echte pad (op macOS en Windows wijst de tijdelijke map via een omweg); .native geeft op Windows de lange naam
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), voorvoegsel)));
  dirs.push(d);
  return d;
};

/** Wacht tot een toestand waar is (pollt kort, geen vaste slaaptijd). */
async function wacht(voorwaarde: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const eind = Date.now() + ms;
  while (!(await voorwaarde())) {
    if (Date.now() > eind) throw new Error('de verwachte toestand kwam niet');
    await new Promise((r) => setTimeout(r, 5));
  }
}

interface Opties {
  mapBestanden?: ConstructorParameters<typeof Bonnenscanner>[0]['mapBestanden'];
  homeDir?: string;
  zonderMap?: boolean;
}

function bouwScanner(t: ReturnType<typeof setup>, data: string, adminDir: string, opties: Opties = {}): Bonnenscanner {
  const scanner = new Bonnenscanner({
    db: t.db,
    secrets: t.secrets,
    intake: t.s.intake,
    settings: t.s.settings,
    invoices: t.s.invoices,
    spoolDir: join(data, 'bonnenscanner'),
    adminDir,
    protectedDirs: [data],
    homeDir: opties.homeDir,
    interfaces: () => LOOPBACK,
    folderPollMs: 5,
    folderStableMs: 0,
    mapBestanden: opties.mapBestanden,
  });
  open.push(scanner);
  return scanner;
}

/** Een administratie met een bonnenmap en een scanner die nog niet draait. */
async function omgeving(opties: Opties = {}) {
  const t = setup();
  const folder = tmp('bvn-map-');
  const data = tmp('bvn-map-gegevens-');
  const adminDir = tmp('bvn-map-admin-');
  const scanner = bouwScanner(t, data, adminDir, opties);
  if (!opties.zonderMap) await scanner.setFolder(folder);
  const van = join(folder, 'van-telefoon');
  const verwerkt = join(van, 'verwerkt');
  const naar = join(folder, 'van-pc');
  const rijen = (sql: string, ...p: unknown[]) => t.db.prepare(sql).all(...p) as Record<string, any>[];
  const n = (sql: string, ...p: unknown[]) => (t.db.prepare(sql).get(...p) as { n: number }).n;
  const problemen = () => rijen('SELECT bestandsnaam, apparaat_id, soort, fout, veld, gezien_op FROM sync_map_problemen ORDER BY id');
  const register = () => rijen('SELECT entiteit, uuid, revisie, uitkomst, fout, route FROM sync_ontvangen ORDER BY entiteit, uuid, revisie');
  /** draait de rondgang tot de toestand waar is */
  const draai = (voorwaarde: () => boolean | Promise<boolean>) =>
    wacht(async () => {
      await scanner.scanMap();
      return voorwaarde();
    });
  const lijst = (map: string) => (existsSync(map) ? readdirSync(map).sort() : []);
  return { t, folder, data, adminDir, scanner, van, verwerkt, naar, rijen, n, problemen, register, draai, lijst };
}
type Omg = Awaited<ReturnType<typeof omgeving>>;

/** De telefoon: schrijft versleutelde verzoeken als bestand (eerst .tmp, dan hernoemen) en leest antwoorden op nonce; over het netwerk kan ook. */
async function koppel(o: Omg) {
  const gestart = await o.scanner.pair();
  const k = decodePairing(gestart.payload);
  const sleutel = Buffer.from(k.sleutel, 'base64url');
  const deviceId = Buffer.from(k.apparaat, 'base64url');
  const url = `http://${k.adressen[0]}:${k.poort}${ENDPOINT_PATH}`;
  const antwoordPad = (nonce: Buffer) => join(o.naar, `${nonce.toString('hex')}.antwoord.bvns`);
  const maak = (json: Record<string, unknown>, bijlagen: Buffer[] = [], opts: { versie?: ProtocolVersion; nonce?: Buffer; sleutel?: Buffer } = {}) => {
    const nonce = opts.nonce ?? randomBytes(12);
    return { nonce, body: sealRequest(deviceId, opts.sleutel ?? sleutel, encodeFrame(json, bijlagen), nonce, opts.versie ?? 2) };
  };
  const schrijfBytes = (naam: string, body: Buffer) => {
    mkdirSync(o.van, { recursive: true });
    const pad = join(o.van, naam);
    writeFileSync(`${pad}.tmp`, body);
    renameSync(`${pad}.tmp`, pad);
    return pad;
  };
  const schrijf = (json: Record<string, unknown>, bijlagen: Buffer[] = [], opts: { versie?: ProtocolVersion; nonce?: Buffer; naam?: string } = {}) => {
    const { nonce, body } = maak(json, bijlagen, opts);
    const naam = opts.naam ?? `${nonce.toString('hex')}.bvns`;
    return { nonce, naam, body, pad: schrijfBytes(naam, body) };
  };
  const antwoord = (nonce: Buffer) => (existsSync(antwoordPad(nonce)) ? openResponse(readFileSync(antwoordPad(nonce)), sleutel, nonce) : null);
  /** schrijft het verzoek en draait de rondgang tot het antwoord er staat */
  const viaMap = async (json: Record<string, unknown>, bijlagen: Buffer[] = [], opts: Parameters<typeof schrijf>[2] = {}) => {
    const v = schrijf(json, bijlagen, opts);
    await o.draai(() => existsSync(antwoordPad(v.nonce)));
    return { ...v, json: antwoord(v.nonce)! };
  };
  const netwerk = async (json: Record<string, unknown>, bijlagen: Buffer[] = [], versie: ProtocolVersion = 2) => {
    const { nonce, body } = maak(json, bijlagen, { versie });
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': CONTENT_TYPE }, body: new Uint8Array(body) });
    return { status: res.status, json: openResponse(Buffer.from(await res.arrayBuffer()), sleutel, nonce) };
  };
  return { apparaat: k.apparaat, deviceId, sleutel, maak, schrijf, schrijfBytes, antwoord, antwoordPad, viaMap, netwerk };
}
type Telefoon = Awaited<ReturnType<typeof koppel>>;

// ---------- de berichten (een eigen bouwer) ----------

const wijziging = (entiteit: string, velden: Record<string, unknown>, over: { uuid?: string; revisie?: number; tijd?: number; berichtTijd?: number } = {}) => ({
  soort: 'wijziging',
  tijd: over.berichtTijd ?? Date.now(),
  wijziging: { entiteit, uuid: over.uuid ?? randomUUID(), revisie: over.revisie ?? 1, tijd: over.tijd ?? Date.now() - 2 * DAG, velden },
});
const klantBericht = (naam = 'Familie Jansen', over: Parameters<typeof wijziging>[2] = {}) => wijziging('klant', { naam }, over);
const projectBericht = (klant: string, over: Parameters<typeof wijziging>[2] = {}) => wijziging('project', { titel: 'Schilderwerk', klant }, over);
const bonBericht = (fotos: Buffer[], over: Parameters<typeof wijziging>[2] = {}) => wijziging('bon', { betaalwijze: 'contant', notitie: 'Schroeven voor de klus', fotos: fotoVelden(fotos) }, over);
const fotoBericht = (project: string, fotos: Buffer[], over: Parameters<typeof wijziging>[2] = {}) => wijziging('foto', { project_uuid: project, notitie: 'Voor het schilderen', fotos: fotoVelden(fotos) }, over);

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** de factuurdatum: tien dagen geleden; het jaar van de reeks volgt de datum */
const DATUM = iso(Date.now() - 10 * DAG);
function factuurBericht(klantUuid: string, volgnr: number, over: Parameters<typeof wijziging>[2] = {}) {
  const regel = { omschrijving: 'Montage', hoeveelheid: 2, prijs: 4550, btw_soort: 'hoog', eenheid: 'uur' };
  const totalen = computeTotals([{ description: regel.omschrijving, quantity: regel.hoeveelheid, unitPrice: regel.prijs, vatCode: 'hoog' } as LineInput]);
  return wijziging(
    'factuur',
    {
      nummer: `M1-${DATUM.slice(0, 4)}-${String(volgnr).padStart(4, '0')}`,
      datum: DATUM,
      vervaldatum: iso(Date.parse(DATUM) + 30 * DAG),
      klant_uuid: klantUuid,
      klant_momentopname: { name: 'Familie Jansen', address: 'Dorpsstraat 1', city: 'Utrecht', country: 'NL', vat_number: 'NL123456789B01', kvk_number: '12345678', email: 'info@jansen.example' },
      bedrijf_momentopname: { name: 'Jansen Klus', address: 'Werfstraat 2', city: 'Zwolle', kvkNumber: '87654321', vatNumber: 'NL987654321B01', kor: false },
      regels: [regel],
      totalen: { subtotaal: totalen.subtotal, btw: totalen.vatTotal, totaal: totalen.total },
      verzonden_op: `${DATUM} 10:30:00`,
      regeltabel_versie: '2026-1',
    },
    over,
  );
}

const norm = (j: Record<string, unknown> | null) => {
  const { pc: _pc, pcTijd: _pcTijd, ...rest } = j ?? {};
  return rest;
};
/** alle uuid's vervangen door tokens in volgorde van voorkomen: administraties die los van elkaar zijn opgebouwd hebben andere uuid's */
const zonderUuids = (j: unknown) => {
  const gezien = new Map<string, string>();
  return JSON.parse(JSON.stringify(j).replace(UUID_RE, (m) => gezien.get(m) ?? (gezien.set(m, `#${gezien.size}`), `#${gezien.size - 1}`))) as unknown;
};

describe('de bonnenmap als tweede route', () => {
  it('MAP-01 wijziging via de map: een versleuteld verzoek (dezelfde bytes als bij het netwerk) met een klantwijziging in van-telefoon/ wordt gelezen, ontsleuteld met de koppelsleutel van het apparaat in de kop, verwerkt met route map (registerrij met route map) en het antwoord (hetzelfde versleutelde antwoord als bij het netwerk, gebonden aan de nonce van het verzoek) staat als nieuw bestand in van-pc/; het verzoekbestand staat daarna in van-telefoon/verwerkt/ en niets is verwijderd of overschreven', async () => {
    const o = await omgeving();
    const p = await koppel(o);
    const uuid = randomUUID();
    const m = p.maak(klantBericht('Bakkerij De Korst', { uuid }));
    const v = { ...m, naam: `${m.nonce.toString('hex')}.bvns` };
    // een crash midden in het schrijven van een antwoord laat hoogstens een tijdelijk bestand achter: dat blokkeert niets
    writeFileSync(`${p.antwoordPad(v.nonce)}.tmp`, 'half geschreven bij een crash');
    p.schrijfBytes(v.naam, v.body);
    expect(o.lijst(o.van)).toEqual([v.naam, 'verwerkt'].sort());
    await o.draai(() => existsSync(p.antwoordPad(v.nonce)));
    // het antwoord: dezelfde envelop als bij het netwerk, in de versie van het verzoek, gebonden aan de nonce van het verzoek
    const bytes = readFileSync(p.antwoordPad(v.nonce));
    expect(bytes[4]).toBe(2);
    expect(openResponse(bytes, p.sleutel, v.nonce)).toEqual({ ok: true, soort: 'wijziging', entiteit: 'klant', uuid, revisie: 1, uitkomst: 'toegepast' });
    expect(openResponse(bytes, p.sleutel, randomBytes(12))).toBeNull();
    expect(openResponse(bytes, randomBytes(32), v.nonce)).toBeNull();
    // de klant staat in de administratie en het register kent de route map
    expect(o.rijen('SELECT name FROM relations WHERE uuid = ?', uuid)).toEqual([{ name: 'Bakkerij De Korst' }]);
    expect(o.register()).toEqual([{ entiteit: 'klant', uuid, revisie: 1, uitkomst: 'toegepast', fout: null, route: 'map' }]);
    // het verzoek staat in verwerkt/ (byte voor byte), niets is verwijderd of overschreven, er is niets anders bijgekomen
    await o.draai(() => o.lijst(o.verwerkt).length === 1);
    expect(o.lijst(o.van)).toEqual(['verwerkt']);
    expect(readFileSync(join(o.verwerkt, v.naam)).equals(v.body)).toBe(true);
    expect(o.lijst(o.naar)).toEqual([`${v.nonce.toString('hex')}.antwoord.bvns`]);
    expect(o.problemen()).toEqual([]);
  });

  it('MAP-02 alle berichtsoorten: hallo, bon, wijziging (klant, project, factuur, bon, foto met bijlagen), stamgegevens en bevestigingen werken via de map met dezelfde uitkomsten en dezelfde inhoud als via het netwerk (vergelijk met een netwerkverzoek op een tweede identieke administratie); stamgegevens en bevestigingen leveren hun pagina als antwoordbestand (de telefoon vraagt de volgende pagina met een volgend verzoekbestand)', async () => {
    const a = await omgeving();
    const b = await omgeving();
    const pa = await koppel(a);
    const pb = await koppel(b);
    const klant = randomUUID();
    const project = randomUUID();
    const fotos = [makeJpeg('een'), makeJpeg('twee')];
    const bonFoto = [makeJpeg('bon')];
    const bonId = randomUUID();
    const stappen: { naam: string; json: Record<string, unknown>; bijlagen: Buffer[]; versie: ProtocolVersion; uitkomst?: string }[] = [
      { naam: 'hallo', json: { soort: 'hallo', tijd: Date.now(), naam: 'Pixel van Piet', app: '1.0.0' }, bijlagen: [], versie: 2 },
      // het project komt eerst en wacht op zijn klant; de klant erna laat het project toepassen
      { naam: 'project', json: projectBericht(klant, { uuid: project }), bijlagen: [], versie: 2, uitkomst: 'wacht' },
      { naam: 'klant', json: klantBericht('Familie Jansen', { uuid: klant }), bijlagen: [], versie: 2, uitkomst: 'toegepast' },
      { naam: 'factuur', json: factuurBericht(klant, 1), bijlagen: [], versie: 2, uitkomst: 'toegepast' },
      { naam: 'bon als wijziging', json: bonBericht(bonFoto), bijlagen: bonFoto, versie: 2, uitkomst: 'toegepast' },
      { naam: 'foto', json: fotoBericht(project, fotos), bijlagen: fotos, versie: 2, uitkomst: 'toegepast' },
      { naam: 'bon (versie 1)', json: { soort: 'bon', tijd: Date.now(), id: bonId, betaalwijze: 'pin', fotos: bonFoto.map((f) => ({ grootte: f.length })) }, bijlagen: bonFoto, versie: 1 },
    ];
    for (const s of stappen) {
      const viaNetwerk = await pa.netwerk(s.json, s.bijlagen, s.versie);
      const viaMap = await pb.viaMap(s.json, s.bijlagen, { versie: s.versie });
      expect(viaNetwerk.status, s.naam).toBe(200);
      expect(norm(viaMap.json), s.naam).toEqual(norm(viaNetwerk.json));
      if (s.uitkomst) expect(viaMap.json.uitkomst, s.naam).toBe(s.uitkomst);
      // de envelop van het antwoord heeft de versie van het verzoek
      expect(readFileSync(pb.antwoordPad(viaMap.nonce))[4], s.naam).toBe(s.versie);
    }
    // dezelfde gevolgen in de administratie, alleen de route verschilt
    const zonderRoute = (o: Omg) => o.register().map(({ route: _r, ...rest }) => rest);
    expect(zonderRoute(b)).toEqual(zonderRoute(a));
    expect(new Set(a.register().map((r) => r.route))).toEqual(new Set(['netwerk']));
    expect(new Set(b.register().map((r) => r.route))).toEqual(new Set(['map']));
    for (const tabel of ['invoices', 'scanner_documents', 'job_photos', 'sync_wachtrij']) expect(b.n(`SELECT COUNT(*) AS n FROM ${tabel}`), tabel).toBe(a.n(`SELECT COUNT(*) AS n FROM ${tabel}`));
    expect(b.n('SELECT COUNT(*) AS n FROM invoices')).toBe(1);
    expect(b.n('SELECT COUNT(*) AS n FROM job_photos')).toBe(2);
    expect(b.n('SELECT COUNT(*) AS n FROM scanner_documents')).toBe(2);
    // stamgegevens en bevestigingen: dezelfde inhoud via het netwerk en via de map, ook de tweede pagina
    for (let i = 0; i < 105; i++) b.t.s.relations.create({ name: `Klant ${String(i).padStart(3, '0')}` });
    const stam = { soort: 'stamgegevens', tijd: Date.now() };
    const stam1n = await pb.netwerk(stam);
    const stam1m = await pb.viaMap(stam);
    expect(zonderUuids(norm(stam1m.json))).toEqual(zonderUuids(norm(stam1n.json)));
    expect(stam1m.json).toMatchObject({ ok: true, soort: 'stamgegevens', apparaatcode: 'M1' });
    const volgende = stam1m.json.volgende;
    expect(typeof volgende).toBe('string');
    const stam2 = { soort: 'stamgegevens', tijd: Date.now(), na: volgende };
    const stam2n = await pb.netwerk(stam2);
    const stam2m = await pb.viaMap(stam2);
    expect(zonderUuids(norm(stam2m.json))).toEqual(zonderUuids(norm(stam2n.json)));
    expect(stam2m.json.volgende).toBeNull();
    expect((stam1m.json.klanten as unknown[]).length + (stam1m.json.projecten as unknown[]).length).toBe(100);
    const bev = { soort: 'bevestigingen', tijd: Date.now() };
    const bevn = await pb.netwerk(bev);
    const bevm = await pb.viaMap(bev);
    expect(norm(bevm.json)).toEqual(norm(bevn.json));
    expect(bevm.json).toMatchObject({ ok: true, soort: 'bevestigingen', bevestigingen: [{ entiteit: 'project', uuid: project, uitkomst: 'toegepast' }] });
  });

  it('MAP-03 geen klokvenster en geen nonce: een verzoekbestand met een verzendtijd uren oud wordt gewoon verwerkt (geen 403 klok) en hetzelfde bestand nog eens aanbieden geeft geen tweede effect (idempotent via het register; geen 409 herhaald); de controle van 5 minuten op de bewerktijd van een wijziging geldt wel (te ver in de toekomst geeft 400 ongeldig)', async () => {
    const o = await omgeving();
    const p = await koppel(o);
    const uuid = randomUUID();
    const oud = klantBericht('Oud verzoek', { uuid, berichtTijd: Date.now() - 5 * 60 * 60 * 1000 });
    const eerste = await p.viaMap(oud);
    expect(eerste.json).toMatchObject({ ok: true, uitkomst: 'toegepast' });
    // over het netwerk is hetzelfde bericht te oud (403 klok)
    expect(await p.netwerk(oud)).toMatchObject({ status: 403, json: { ok: false, fout: 'klok' } });
    const antwoordBytes = readFileSync(p.antwoordPad(eerste.nonce));
    // dezelfde bytes nog eens, onder dezelfde naam (de eerste staat intussen in verwerkt/)
    await o.draai(() => o.lijst(o.verwerkt).length === 1);
    p.schrijfBytes(eerste.naam, eerste.body);
    await o.draai(() => o.lijst(o.verwerkt).length === 2);
    expect(o.lijst(o.van)).toEqual(['verwerkt']);
    expect(o.n('SELECT COUNT(*) AS n FROM relations WHERE uuid = ?', uuid)).toBe(1);
    expect(o.register()).toHaveLength(1);
    // de nonce wordt in de map niet bijgehouden, en het eerste antwoord blijft zoals het was
    expect(o.n('SELECT COUNT(*) AS n FROM scanner_nonces')).toBe(0);
    expect(readFileSync(p.antwoordPad(eerste.nonce)).equals(antwoordBytes)).toBe(true);
    expect(o.lijst(o.naar)).toHaveLength(1);
    // het bewerkmoment van de wijziging: een minuut vooruit mag, een kwartier niet
    const vooruit = await p.viaMap(klantBericht('Straks', { tijd: Date.now() + 60_000 }));
    expect(vooruit.json).toMatchObject({ ok: true, uitkomst: 'toegepast' });
    const te = klantBericht('Te ver vooruit', { tijd: Date.now() + 15 * 60_000 });
    const teVer = await p.viaMap(te);
    expect(teVer.json).toEqual({ ok: false, fout: 'ongeldig' });
    expect(o.n('SELECT COUNT(*) AS n FROM relations WHERE name = ?', 'Te ver vooruit')).toBe(0);
    await o.draai(() => existsSync(join(o.verwerkt, teVer.naam)));
  });

  it('MAP-04 definitief en herhaalbaar: een uitkomst 200 (toegepast, overgeslagen, afgewezen, wacht), 400 en 413 zijn definitief: antwoordbestand en het verzoek naar verwerkt/; 503 wachtrij-vol, 500 opslaan-mislukt en een nog niet bestaande koppeling/klok-uitkomst die herhaalbaar is laten het verzoekbestand staan en worden later opnieuw geprobeerd (met een rustige terugval) zonder een antwoordbestand te schrijven; na herstel wordt het alsnog verwerkt, precies een keer', async () => {
    const o = await omgeving();
    const p = await koppel(o);
    const db = o.t.db;
    // de echte afhandeling, met daarvoor een stand-in die een uitkomst kan opleggen
    const receiver = new ScannerReceiver({
      pairing: o.scanner.pairing,
      spool: new ReceiptSpool(db, join(o.data, 'tweede-spool')),
      sync: new SyncOntvangst(db, new RelationsService(db), { now: () => Date.now(), invoices: o.t.s.invoices }),
      database: db,
      interfaces: () => [],
    });
    // per verzoek (op nonce) kan een uitkomst worden opgelegd; zonder gaat het naar de echte afhandeling
    const opgelegd = new Map<string, Behandeld>();
    const aanroepen = new Map<string, number>();
    const klok = { nu: 1_000_000 };
    const route = new MapRoute({
      db,
      pairing: o.scanner.pairing,
      behandel: (d, k, pt, r) => {
        const sleutel = k.nonce.toString('hex');
        aanroepen.set(sleutel, (aanroepen.get(sleutel) ?? 0) + 1);
        return opgelegd.get(sleutel) ?? receiver.behandel(d, k, pt, r);
      },
      folder: async () => o.folder,
      pollMs: 10,
      stableMs: 0,
      klok: () => klok.nu,
    });
    const ronde = async (verder = 0) => {
      klok.nu += verder;
      await route.scan();
    };
    const keren = (nonce: Buffer) => aanroepen.get(nonce.toString('hex')) ?? 0;

    // definitief: toegepast, overgeslagen, wacht, 400 (bewerktijd), 413 (te grote JSON) en een afgewezen wijziging
    const klantUuid = randomUUID();
    const definitief: { naam: string; bericht: Record<string, unknown>; verwacht: Record<string, unknown>; opleg?: Behandeld }[] = [
      { naam: 'toegepast', bericht: klantBericht('Een', { uuid: klantUuid }), verwacht: { ok: true, uitkomst: 'toegepast' } },
      { naam: 'overgeslagen', bericht: klantBericht('Een', { uuid: klantUuid }), verwacht: { ok: true, uitkomst: 'overgeslagen' } },
      { naam: 'wacht', bericht: projectBericht(randomUUID()), verwacht: { ok: true, uitkomst: 'wacht' } },
      { naam: '400', bericht: klantBericht('Straks', { tijd: Date.now() + 60 * 60_000 }), verwacht: { ok: false, fout: 'ongeldig' } },
      { naam: '413', bericht: klantBericht('x'.repeat(LIMITS.maxWijzigingJsonBytes + 10)), verwacht: { ok: false, fout: 'te-groot' } },
      { naam: 'afgewezen', bericht: klantBericht('Twee'), verwacht: { ok: true, uitkomst: 'afgewezen', fout: 'nummer-bezet' }, opleg: { status: 200, json: { ok: true, soort: 'wijziging', uitkomst: 'afgewezen', fout: 'nummer-bezet' } } },
    ];
    for (const d of definitief) {
      const v = p.schrijf(d.bericht);
      if (d.opleg) opgelegd.set(v.nonce.toString('hex'), d.opleg);
      await ronde(); // gezien
      await ronde(); // afgehandeld
      expect(p.antwoord(v.nonce), d.naam).toMatchObject(d.verwacht);
      expect(existsSync(join(o.verwerkt, v.naam)), d.naam).toBe(true);
      expect(existsSync(v.pad), d.naam).toBe(false);
      expect(keren(v.nonce), d.naam).toBe(1);
    }
    expect(o.problemen().map((r) => r.soort)).toEqual(['afgewezen']);
    expect(o.n('SELECT COUNT(*) AS n FROM relations WHERE name = ?', 'Een')).toBe(1);

    // herhaalbaar: de uitkomst wordt opgelegd, het bestand blijft staan zonder antwoord
    const herhaalbaar: { naam: string; opleg: Behandeld; uuid: string; v: ReturnType<Telefoon['schrijf']> }[] = [
      { naam: '503', opleg: { status: 503, json: { ok: false, fout: 'wachtrij-vol' } } },
      { naam: '500', opleg: { status: 500, json: { ok: false, fout: 'opslaan-mislukt' } } },
      { naam: '409', opleg: { status: 409, json: { ok: false, fout: 'klant-onbekend' } } },
      { naam: 'niet ondersteund', opleg: { status: 200, json: { ok: true, soort: 'wijziging', uitkomst: 'niet-ondersteund' } } },
    ].map((h) => {
      const uuid = randomUUID();
      const v = p.schrijf(klantBericht(`Herhaalbaar ${h.naam}`, { uuid }));
      opgelegd.set(v.nonce.toString('hex'), h.opleg);
      return { ...h, uuid, v };
    });
    await ronde(); // gezien
    await ronde(); // eerste poging
    for (const h of herhaalbaar) {
      expect(keren(h.v.nonce), h.naam).toBe(1);
      expect(existsSync(h.v.pad), h.naam).toBe(true);
      expect(existsSync(p.antwoordPad(h.v.nonce)), h.naam).toBe(false);
    }
    // rustige terugval: zonder dat de klok verder gaat geen nieuwe poging; daarna wordt de wachttijd steeds langer
    await ronde();
    await ronde(5);
    for (const h of herhaalbaar) expect(keren(h.v.nonce), h.naam).toBe(1);
    await ronde(25);
    for (const h of herhaalbaar) expect(keren(h.v.nonce), h.naam).toBe(2);
    await ronde(25);
    for (const h of herhaalbaar) expect(keren(h.v.nonce), h.naam).toBe(2);
    await ronde(100);
    for (const h of herhaalbaar) {
      expect(keren(h.v.nonce), h.naam).toBe(3);
      expect(existsSync(p.antwoordPad(h.v.nonce)), h.naam).toBe(false);
    }
    expect(route.status()).toMatchObject({ wachtend: 4, herhaalt: 4, problemen: 1 });
    expect(o.n('SELECT COUNT(*) AS n FROM relations WHERE name LIKE ?', 'Herhaalbaar %')).toBe(0);
    // na herstel: precies een keer verwerkt, met een antwoord en verwerkt/
    opgelegd.clear();
    await ronde(1_000_000);
    expect(route.status()).toMatchObject({ wachtend: 0, herhaalt: 0 });
    for (const h of herhaalbaar) {
      expect(p.antwoord(h.v.nonce), h.naam).toMatchObject({ ok: true, uitkomst: 'toegepast' });
      expect(existsSync(join(o.verwerkt, h.v.naam)), h.naam).toBe(true);
      expect(o.n('SELECT COUNT(*) AS n FROM sync_ontvangen WHERE uuid = ?', h.uuid), h.naam).toBe(1);
    }
    await ronde(1_000_000);
    expect(o.n('SELECT COUNT(*) AS n FROM relations WHERE name LIKE ?', 'Herhaalbaar %')).toBe(4);
    for (const h of herhaalbaar) expect(keren(h.v.nonce), h.naam).toBe(4);
  });

  it('MAP-05 onbekend of ongeldig: een bestand met een onbekend apparaat, een verkeerde sleutel, een aangepast bericht, een te kort of te groot bestand, een bestand dat geen envelop is, of een versie die de pc niet kent, is definitief: het gaat naar verwerkt/ met een vermelding van de reden in het probleemregister, er wordt GEEN antwoord geschreven (de pc kent de sleutel niet) en er wordt niets in het geheugen gelezen boven maxBodyBytes + de kop', async () => {
    const o = await omgeving();
    const p = await koppel(o);
    const geldig = p.maak(klantBericht('Onzichtbaar'));
    const onbekend = sealRequest(randomBytes(16), randomBytes(32), encodeFrame(klantBericht('Vreemd')), randomBytes(12), 2);
    const verkeerdeSleutel = p.maak(klantBericht('Verkeerd'), [], { sleutel: randomBytes(32) }).body;
    const aangepast = Buffer.from(geldig.body);
    aangepast[aangepast.length - 20] = ~aangepast[aangepast.length - 20]! & 0xff;
    const teKort = geldig.body.subarray(0, 40);
    const geenEnvelop = Buffer.from('dit is helemaal geen envelop maar gewoon een stuk tekst dat te lang is om meteen te kort te zijn');
    const onbekendeVersie = Buffer.from(geldig.body);
    onbekendeVersie[4] = 9;
    const antwoordRichting = Buffer.from(geldig.body);
    antwoordRichting[5] = 2;
    const bestanden: Record<string, Buffer> = { 'onbekend.bvns': onbekend, 'verkeerd.bvns': verkeerdeSleutel, 'aangepast.bvns': aangepast, 'kort.bvns': teKort, 'tekst.bvns': geenEnvelop, 'versie.bvns': onbekendeVersie, 'richting.bvns': antwoordRichting };
    for (const [naam, inhoud] of Object.entries(bestanden)) p.schrijfBytes(naam, inhoud);
    // te groot: een bestand van 64 MiB (ruim boven de grens), zonder echte schijfruimte; het wordt niet eens ingelezen
    const groot = join(o.van, 'groot.bvns');
    const fd = openSync(groot, 'w');
    ftruncateSync(fd, 64 * 1024 * 1024);
    closeSync(fd);
    expect(statSync(groot).size).toBeGreaterThan(LIMITS.maxBodyBytes);
    const namen = [...Object.keys(bestanden), 'groot.bvns'];
    await o.draai(() => namen.every((nm) => existsSync(join(o.verwerkt, nm))));
    expect(o.lijst(o.van)).toEqual(['verwerkt']);
    // geen antwoord, geen effect
    expect(o.lijst(o.naar)).toEqual([]);
    expect(o.register()).toEqual([]);
    expect(o.n('SELECT COUNT(*) AS n FROM relations WHERE name IN (?, ?, ?)', 'Onzichtbaar', 'Vreemd', 'Verkeerd')).toBe(0);
    // in het register: wie en waarom, per bestand maar een keer
    const per = Object.fromEntries(o.problemen().map((r) => [r.bestandsnaam, r]));
    expect(Object.keys(per).sort()).toEqual([...namen].sort());
    expect(per['onbekend.bvns']).toMatchObject({ soort: 'onbekend-apparaat', fout: 'niet-gekoppeld' });
    expect(per['verkeerd.bvns']).toMatchObject({ soort: 'onleesbaar', fout: 'niet-te-openen', apparaat_id: p.apparaat });
    expect(per['aangepast.bvns']).toMatchObject({ soort: 'onleesbaar', fout: 'niet-te-openen', apparaat_id: p.apparaat });
    expect(per['kort.bvns']).toMatchObject({ soort: 'onleesbaar', fout: 'te-kort', apparaat_id: null });
    expect(per['groot.bvns']).toMatchObject({ soort: 'onleesbaar', fout: 'te-groot', apparaat_id: null });
    for (const naam of ['tekst.bvns', 'versie.bvns', 'richting.bvns']) expect(per[naam], naam).toMatchObject({ soort: 'onleesbaar', fout: 'geen-envelop', apparaat_id: null });
    // nooit een pad of inhoud in het register
    expect(JSON.stringify(o.problemen())).not.toContain(o.folder);
    expect(o.scanner.status().map).toMatchObject({ problemen: namen.length, verwerkt: namen.length, wachtend: 0 });
  });

  it('MAP-06 bestanden: alleen gewone bestanden direct in van-telefoon/ (geen submappen, geen snelkoppelingen of symlinks, geen verborgen of tijdelijke bestanden zoals .tmp, .part en bestanden die nog groeien: de grootte moet stabiel zijn zoals bij de bonnenmap), hoogstens een vaste hoeveelheid per ronde, en nooit buiten de gekozen map; een bestandsnaam met rare tekens of een pad wordt nooit gebruikt om te schrijven (de namen van antwoordbestanden komen van de pc: de nonce in hexadecimaal)', async () => {
    const o = await omgeving();
    const p = await koppel(o);
    // wat nooit wordt opgepakt, ook al is de inhoud een geldig verzoek
    const body = p.maak(klantBericht('Nooit')).body;
    mkdirSync(join(o.van, 'submap.bvns'));
    writeFileSync(join(o.van, 'submap.bvns', 'binnen.bvns'), body);
    writeFileSync(join(o.van, '.verborgen.bvns'), body);
    writeFileSync(join(o.van, '~sync.bvns'), body);
    writeFileSync(join(o.van, 'half.bvns.tmp'), body);
    writeFileSync(join(o.van, 'deel.part'), body);
    writeFileSync(join(o.van, 'gewoon.txt'), body);
    const buiten = join(o.data, 'buiten.bvns');
    writeFileSync(buiten, body);
    try {
      symlinkSync(buiten, join(o.van, 'snelkoppeling.bvns'));
    } catch {
      /* geen rechten voor symlinks (Windows): dit deel valt dan weg */
    }
    const voor = o.lijst(o.van);
    for (let i = 0; i < 4; i++) await o.scanner.scanMap();
    expect(o.lijst(o.van)).toEqual(voor);
    expect(o.lijst(o.naar)).toEqual([]);
    expect(o.lijst(o.verwerkt)).toEqual([]);
    expect(o.problemen()).toEqual([]);
    expect(o.n('SELECT COUNT(*) AS n FROM relations WHERE name = ?', 'Nooit')).toBe(0);

    // een bestand dat nog groeit wordt pas opgepakt als de grootte stabiel is
    const groeiend = p.maak(klantBericht('Groeiend'));
    const pad = join(o.van, 'groeiend.bvns');
    writeFileSync(pad, groeiend.body.subarray(0, 50));
    await o.scanner.scanMap();
    writeFileSync(pad, groeiend.body);
    await o.scanner.scanMap();
    expect(o.lijst(o.naar)).toEqual([]);
    expect(o.n('SELECT COUNT(*) AS n FROM relations WHERE name = ?', 'Groeiend')).toBe(0);
    await o.draai(() => existsSync(p.antwoordPad(groeiend.nonce)));
    expect(p.antwoord(groeiend.nonce)).toMatchObject({ ok: true, uitkomst: 'toegepast' });

    // hoogstens een vaste hoeveelheid per ronde
    const aantal = MAP_MAX_PER_RONDE + 5;
    const reeks = Array.from({ length: aantal }, (_, i) => p.schrijf(klantBericht(`Reeks ${i}`)));
    await o.scanner.scanMap(); // alles gezien
    await o.scanner.scanMap();
    expect(o.lijst(o.naar).length).toBe(1 + MAP_MAX_PER_RONDE);
    expect(o.scanner.status().map.wachtend).toBe(5);
    await o.scanner.scanMap();
    expect(o.lijst(o.naar).length).toBe(1 + aantal);
    expect(reeks.every((v) => p.antwoord(v.nonce) !== null)).toBe(true);

    // een rare naam wordt nooit gebruikt om te schrijven: het antwoord heet naar de nonce uit de kop
    const rare = p.schrijf(klantBericht('Rare naam'), [], { naam: 'we ird;naam $(x) ü %n.bvns' });
    await o.draai(() => existsSync(p.antwoordPad(rare.nonce)));
    expect(o.lijst(o.naar).filter((nm) => !/^[0-9a-f]{24}\.antwoord\.bvns$/.test(nm))).toEqual([]);
    expect(existsSync(join(o.verwerkt, 'we ird;naam $(x) ü %n.bvns'))).toBe(true);
    // niets buiten de gekozen map, en in de map alleen de twee eigen mappen
    expect(o.lijst(o.folder)).toEqual(['van-pc', 'van-telefoon']);
    expect(readFileSync(buiten).equals(body)).toBe(true);
    expect(o.lijst(o.data).filter((nm) => nm !== 'bonnenscanner' && nm !== 'buiten.bvns')).toEqual([]);

    // het tijdelijke bestand heeft een onvoorspelbare naam en wordt exclusief aangemaakt: de oude, voorspelbare naam
    // (<nonce>.antwoord.bvns.tmp, de nonce staat in het verzoek) wordt niet gebruikt, niet overschreven en niet gevolgd
    const doelBuiten = join(o.data, 'gebruikersbestand.txt');
    writeFileSync(doelBuiten, 'van de gebruiker');
    const sym = p.maak(klantBericht('Symlink tmp'));
    const symTmp = `${p.antwoordPad(sym.nonce)}.tmp`;
    let gelinkt = true;
    try {
      symlinkSync(doelBuiten, symTmp);
    } catch {
      gelinkt = false; // geen rechten voor symlinks (Windows): dan alleen het gewone bestand hieronder
    }
    const gewoon = p.maak(klantBericht('Gewoon tmp'));
    const gewoonTmp = `${p.antwoordPad(gewoon.nonce)}.tmp`;
    writeFileSync(gewoonTmp, 'staat er al');
    p.schrijfBytes(`${sym.nonce.toString('hex')}.bvns`, sym.body);
    p.schrijfBytes(`${gewoon.nonce.toString('hex')}.bvns`, gewoon.body);
    await o.draai(() => existsSync(p.antwoordPad(sym.nonce)) && existsSync(p.antwoordPad(gewoon.nonce)));
    expect(p.antwoord(sym.nonce)).toMatchObject({ ok: true, uitkomst: 'toegepast' });
    expect(p.antwoord(gewoon.nonce)).toMatchObject({ ok: true, uitkomst: 'toegepast' });
    expect(readFileSync(doelBuiten, 'utf8')).toBe('van de gebruiker');
    expect(readFileSync(gewoonTmp, 'utf8')).toBe('staat er al');
    if (gelinkt) expect(lstatSync(symTmp).isSymbolicLink()).toBe(true);
    // de rondgang negeert achtergebleven tijdelijke bestanden (ook die van een crash): geen verzoek, geen regel
    expect(o.problemen()).toEqual([]);
  });

  it('MAP-07 nooit overschrijven of verwijderen: een antwoordbestand dat al bestaat wordt niet overschreven (exclusief aanmaken; bij een botsing met andere inhoud een melding in het probleemregister); het verplaatsen naar verwerkt/ botst nooit met een bestaand bestand (uniek maken); een mislukte verplaatsing of schrijfactie laat het verzoek staan en wordt herhaald zonder dubbel effect; er staat geen unlink of rm van verzoek- of antwoordbestanden in de nieuwe code', async () => {
    const stuk = { schrijf: false, verplaats: false };
    const bron = (code: string) => Object.assign(new Error('nagebootst'), { code });
    const o = await omgeving({
      mapBestanden: {
        schrijfNieuw: async (pad, data) => {
          if (stuk.schrijf) throw bron('EACCES');
          writeFileSync(pad, data, { flag: 'wx' });
        },
        verplaats: async (van, naar) => {
          if (stuk.verplaats) throw bron('EBUSY');
          renameSync(van, naar);
        },
      },
    });
    const p = await koppel(o);

    // (a) er staat al iets anders onder de naam van het antwoord: blijft staan, melding, het verzoek is wel afgehandeld
    const a = p.maak(klantBericht('Botsing'));
    const vreemd = Buffer.from('dit is geen antwoord');
    writeFileSync(p.antwoordPad(a.nonce), vreemd);
    p.schrijfBytes(`${a.nonce.toString('hex')}.bvns`, a.body);
    await o.draai(() => existsSync(join(o.verwerkt, `${a.nonce.toString('hex')}.bvns`)));
    expect(readFileSync(p.antwoordPad(a.nonce)).equals(vreemd)).toBe(true);
    expect(o.problemen()).toMatchObject([{ soort: 'schrijven-mislukt', fout: 'antwoord-bestaat-al', apparaat_id: p.apparaat }]);
    expect(o.n('SELECT COUNT(*) AS n FROM relations WHERE name = ?', 'Botsing')).toBe(1);

    // (b) hetzelfde verzoek nog eens: het echte antwoord van de eerste keer blijft zoals het was, zonder nieuwe melding
    const eerst = await p.viaMap(klantBericht('Twee keer'));
    const eerstBytes = readFileSync(p.antwoordPad(eerst.nonce));
    p.schrijfBytes(eerst.naam, eerst.body);
    await o.draai(() => o.lijst(o.verwerkt).includes(`${eerst.nonce.toString('hex')} (2).bvns`));
    expect(readFileSync(p.antwoordPad(eerst.nonce)).equals(eerstBytes)).toBe(true);
    expect(o.problemen()).toHaveLength(1);

    // (c) verplaatsen botst nooit: de naam in verwerkt/ is bezet, het bestand daar blijft zoals het is
    const c = p.maak(klantBericht('Bezette naam'));
    const bezet = join(o.verwerkt, `${c.nonce.toString('hex')}.bvns`);
    writeFileSync(bezet, 'ander bestand');
    p.schrijfBytes(`${c.nonce.toString('hex')}.bvns`, c.body);
    await o.draai(() => existsSync(join(o.verwerkt, `${c.nonce.toString('hex')} (2).bvns`)));
    expect(readFileSync(bezet, 'utf8')).toBe('ander bestand');
    expect(readFileSync(join(o.verwerkt, `${c.nonce.toString('hex')} (2).bvns`)).equals(c.body)).toBe(true);

    // (d) schrijven van het antwoord mislukt: het verzoek blijft staan en wordt herhaald, het effect komt maar een keer
    stuk.schrijf = true;
    const dUuid = randomUUID();
    const d = p.schrijf(klantBericht('Schrijffout', { uuid: dUuid }));
    await o.draai(() => o.problemen().some((r) => r.soort === 'schrijven-mislukt' && r.fout === 'EACCES'));
    expect(existsSync(d.pad)).toBe(true);
    expect(existsSync(p.antwoordPad(d.nonce))).toBe(false);
    expect(o.n('SELECT COUNT(*) AS n FROM relations WHERE name = ?', 'Schrijffout')).toBe(1);
    expect(o.n('SELECT COUNT(*) AS n FROM sync_ontvangen WHERE uuid = ?', dUuid)).toBe(1);
    stuk.schrijf = false;
    await o.draai(() => existsSync(p.antwoordPad(d.nonce)) && existsSync(join(o.verwerkt, d.naam)));
    expect(p.antwoord(d.nonce)).toMatchObject({ ok: true, uitkomst: 'toegepast' });
    expect(o.n('SELECT COUNT(*) AS n FROM relations WHERE name = ?', 'Schrijffout')).toBe(1);
    expect(o.problemen().filter((r) => r.fout === 'EACCES')).toHaveLength(1);

    // (e) verplaatsen mislukt: het antwoord staat er, het verzoek blijft staan; het herhalen verplaatst alleen en verwerkt niets opnieuw
    stuk.verplaats = true;
    const e = p.schrijf(klantBericht('Verplaatsfout'));
    await o.draai(() => existsSync(p.antwoordPad(e.nonce)) && o.scanner.status().map.herhaalt === 1);
    const eBytes = readFileSync(p.antwoordPad(e.nonce));
    const registerVoor = o.register().length;
    expect(existsSync(e.pad)).toBe(true);
    expect(p.antwoord(e.nonce)).toMatchObject({ uitkomst: 'toegepast' });
    stuk.verplaats = false;
    await o.draai(() => existsSync(join(o.verwerkt, e.naam)));
    expect(existsSync(e.pad)).toBe(false);
    expect(readFileSync(p.antwoordPad(e.nonce)).equals(eBytes)).toBe(true);
    expect(o.register()).toHaveLength(registerVoor);
    expect(o.n('SELECT COUNT(*) AS n FROM relations WHERE name = ?', 'Verplaatsfout')).toBe(1);

    // (f) de nieuwe code kent geen unlink, rm of DELETE FROM voor bestanden of rijen
    const bronTekst = readFileSync(join(__dirname, '..', 'src', 'scanner', 'map-route.ts'), 'utf8');
    for (const verboden of [['unl', 'ink'], ['rm', 'Sync'], ['rm', 'dir'], ['DELETE', ' FROM'], ['INSERT OR ', 'REPLACE'], ['REPLACE', ' INTO'], ['next', 'Counter']]) expect(bronTekst, verboden.join('')).not.toContain(verboden.join(''));
    expect(bronTekst).not.toMatch(/\brm\(/);
  });

  it('MAP-08 gedeelde afhandeling: de afhandeling na de ontsleuteling is dezelfde code als bij het netwerk (geen kopie): de receiver is zo herschikt dat de HTTP-kant alleen ontvangt en seal-t, en dat dezelfde functie door de mapkant wordt aangeroepen met route map; alle bestaande tests van de receiver (netwerk) blijven ongewijzigd groen', async () => {
    const o = await omgeving();
    const db = o.t.db;
    const pairing = new ScannerPairing(db, o.t.secrets);
    const begin = pairing.begin();
    const deviceId = Buffer.from(begin.deviceId, 'base64url');
    const receiver = new ScannerReceiver({
      pairing,
      spool: new ReceiptSpool(db, join(o.data, 'derde-spool')),
      sync: new SyncOntvangst(db, new RelationsService(db), { now: () => Date.now() }),
      database: db,
      interfaces: () => LOOPBACK,
    });
    const aanroepen: { route: string; soort: string }[] = [];
    const echt = receiver.behandel.bind(receiver);
    receiver.behandel = (d, k, pt, r) => {
      aanroepen.push({ route: r, soort: pt.length > 0 ? 'bericht' : 'leeg' });
      return echt(d, k, pt, r);
    };
    await receiver.sync();
    const url = `http://127.0.0.1:${receiver.port}${ENDPOINT_PATH}`;
    const stuur = async (json: Record<string, unknown>, nonce = randomBytes(12)) => {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': CONTENT_TYPE }, body: new Uint8Array(sealRequest(deviceId, begin.key, encodeFrame(json), nonce, 2)) });
      return { status: res.status, json: openResponse(Buffer.from(await res.arrayBuffer()), begin.key, nonce), nonce };
    };
    const map = tmp('bvn-map-gedeeld-');
    mkdirSync(join(map, 'van-telefoon', 'verwerkt'), { recursive: true });
    const route = new MapRoute({ db, pairing, behandel: (d, k, pt, r) => receiver.behandel(d, k, pt, r), folder: async () => map, stableMs: 0, pollMs: 5 });
    try {
      // netwerk: de klokcontrole en de nonce gelden
      const oud = klantBericht('Netwerk', { berichtTijd: Date.now() - 60 * 60_000 });
      expect(await stuur(oud)).toMatchObject({ status: 403, json: { fout: 'klok' } });
      const goed = klantBericht('Netwerk');
      const nonce = randomBytes(12);
      expect(await stuur(goed, nonce)).toMatchObject({ status: 200, json: { uitkomst: 'toegepast' } });
      expect((await stuur(goed, nonce)).status).toBe(409);
      expect(aanroepen.map((a) => a.route)).toEqual(['netwerk', 'netwerk', 'netwerk']);
      // map: dezelfde functie, route map, zonder die controles
      const verzoek = sealRequest(deviceId, begin.key, encodeFrame(oud), nonce, 2);
      writeFileSync(join(map, 'van-telefoon', 'x.bvns'), verzoek);
      await route.scan();
      await route.scan();
      expect(aanroepen.map((a) => a.route)).toEqual(['netwerk', 'netwerk', 'netwerk', 'map']);
      expect(openResponse(readFileSync(join(map, 'van-pc', `${nonce.toString('hex')}.antwoord.bvns`)), begin.key, nonce)).toMatchObject({ ok: true, uitkomst: 'toegepast' });
    } finally {
      await receiver.stop();
    }
    // geen kopie: elk onderdeel van de afhandeling staat precies een keer in de receiver, en de mapkant bevat er niets van
    const rec = readFileSync(join(__dirname, '..', 'src', 'scanner', 'receiver.ts'), 'utf8');
    for (const onderdeel of ['parseFrame(', 'leesStamgegevens(', 'leesBevestigingen(', 'sync.verwerk(', 'spool.accept(', 'useNonce(']) expect(rec.split(onderdeel).length - 1, onderdeel).toBe(1);
    expect(rec).toContain("this.behandel(deviceId, head, plaintext, 'netwerk')");
    const mapTekst = readFileSync(join(__dirname, '..', 'src', 'scanner', 'map-route.ts'), 'utf8');
    for (const onderdeel of ['parseFrame', 'leesStamgegevens', 'leesBevestigingen', 'useNonce', 'spool.accept', 'sync.verwerk']) expect(mapTekst, onderdeel).not.toContain(onderdeel);
    expect(mapTekst).toContain("'map'");
  });

  it('MAP-09 problemen en Vandaag: bij een afgewezen wijziging of veldfout via de map (en bij onleesbare of onbekende bestanden) komt er een regel in het probleemregister (tabel via migratie: bestandsnaam, apparaat, soort, fout, veld, tijd, gezien) en precies een melding op Vandaag per soort probleem met een telling (kind telefoon-map-problemen, prioriteit 2, acties bekijken-niet-nodig: gezien, later), zonder inhoud van de wijziging of het pad; gezien markeert de regels; zonder problemen verandert Vandaag niet; in de kopie bij de boekhouder komt hij niet; begrensd (hoogstens 1000 regels worden bijgehouden per ronde en de melding toont een telling)', async () => {
    const o = await omgeving();
    const p = await koppel(o);
    const taken = () => o.t.s.inbox.tasks().filter((t) => t.kind === 'telefoon-map-problemen');
    const vooraf = o.t.s.inbox.tasks().map((t) => t.key);
    expect(taken()).toEqual([]);
    await o.scanner.scanMap();
    expect(o.t.s.inbox.tasks().map((t) => t.key)).toEqual(vooraf);

    // een afgewezen wijziging (nummer bezet), een veldfout, een onleesbaar en een onbekend bestand
    const klant = randomUUID();
    await p.viaMap(klantBericht('Familie Jansen', { uuid: klant }));
    expect((await p.viaMap(factuurBericht(klant, 1))).json).toMatchObject({ uitkomst: 'toegepast' });
    const bezet = await p.viaMap(factuurBericht(klant, 1));
    expect(bezet.json).toMatchObject({ uitkomst: 'afgewezen', fout: 'nummer-bezet' });
    const veldfout = await p.viaMap(wijziging('klant', { naam: 'Geheime klantnaam', email: 'geen-adres' }));
    expect(veldfout.json).toMatchObject({ ok: false, fout: 'veld-ongeldig', veld: 'email' });
    p.schrijfBytes('kapot-1.bvns', randomBytes(300));
    p.schrijfBytes('kapot-2.bvns', randomBytes(301));
    p.schrijfBytes('kapot-3.bvns', randomBytes(302));
    p.schrijfBytes('vreemd.bvns', sealRequest(randomBytes(16), randomBytes(32), encodeFrame(klantBericht('Vreemd')), randomBytes(12), 2));
    await o.draai(() => ['kapot-1.bvns', 'kapot-2.bvns', 'kapot-3.bvns', 'vreemd.bvns'].every((nm) => existsSync(join(o.verwerkt, nm))));
    expect(o.problemen().map((r) => r.soort).sort()).toEqual(['afgewezen', 'onbekend-apparaat', 'onleesbaar', 'onleesbaar', 'onleesbaar', 'veld-ongeldig']);
    expect(o.problemen().find((r) => r.soort === 'afgewezen')).toMatchObject({ bestandsnaam: bezet.naam, apparaat_id: p.apparaat, fout: 'nummer-bezet', veld: null, gezien_op: null });
    expect(o.problemen().find((r) => r.soort === 'veld-ongeldig')).toMatchObject({ fout: 'veld-ongeldig', veld: 'email' });
    expect(o.rijen('SELECT tijd FROM sync_map_problemen').every((r) => Number.isSafeInteger(r.tijd) && r.tijd > 0)).toBe(true);

    // precies een melding per soort, met een telling, zonder inhoud of pad
    const lijst = taken();
    expect(lijst.map((t) => t.key).sort()).toEqual(['afgewezen', 'onbekend-apparaat', 'onleesbaar', 'veld-ongeldig'].map((s) => `telefoon-map-problemen:${s}`));
    for (const t of lijst) {
      expect(t.priority).toBe(2);
      expect(t.actions.map((a) => a.id)).toEqual(['gezien', 'later']);
      expect(t.actions.every((a) => typeof a.hint === 'string' && a.hint.length > 0)).toBe(true);
    }
    expect(lijst.find((t) => t.key.endsWith(':onleesbaar'))!.title).toMatch(/^3 /);
    expect(lijst.find((t) => t.key.endsWith(':afgewezen'))!.title).toMatch(/^1 /);
    const tekst = JSON.stringify(lijst);
    for (const verboden of [o.folder, 'Geheime klantnaam', 'kapot-1', bezet.naam, 'geen-adres']) expect(tekst).not.toContain(verboden);
    expect(o.scanner.status().map.problemen).toBe(6);

    // later verandert niets; gezien markeert alleen de regels van die soort en verwijdert niets
    const api = createApi(o.t.s, { appVersion: () => 'test' } as unknown as HostContext);
    const onleesbaar = lijst.find((t) => t.key.endsWith(':onleesbaar'))!;
    await api.home.act(onleesbaar, 'later');
    expect(taken()).toHaveLength(4);
    await api.home.act(onleesbaar, 'gezien');
    expect(taken().map((t) => t.key)).not.toContain(onleesbaar.key);
    expect(taken()).toHaveLength(3);
    expect(o.problemen()).toHaveLength(6);
    expect(o.problemen().filter((r) => r.gezien_op !== null).map((r) => r.soort)).toEqual(['onleesbaar', 'onleesbaar', 'onleesbaar']);
    expect(o.scanner.status().map.problemen).toBe(3);
    // een nieuw probleem van die soort geeft de melding opnieuw
    p.schrijfBytes('kapot-4.bvns', randomBytes(303));
    await o.draai(() => existsSync(join(o.verwerkt, 'kapot-4.bvns')));
    expect(taken().find((t) => t.key === onleesbaar.key)!.title).toMatch(/^1 /);

    // begrensd: geziene regels tellen nooit mee voor de grens, en meer dan de grens wordt niet bijgehouden
    const vul = o.t.db.prepare(`INSERT INTO sync_map_problemen (bestandsnaam, soort, fout, tijd, gezien_op) VALUES (?, 'schrijven-mislukt', 'EACCES', ?, ?)`);
    o.t.db.transaction(() => {
      for (let i = 0; i < MAP_MAX_ONGEZIEN + 50; i++) vul.run(`oud-${i}`, 1, 1);
      for (let i = 0; i < 3; i++) vul.run(`nieuw-${i}`, 2, null);
    })();
    expect(taken().find((t) => t.key.endsWith(':schrijven-mislukt'))!.title).toMatch(/^3 /);
    o.t.db.transaction(() => {
      for (let i = 0; i < MAP_MAX_ONGEZIEN + 50; i++) vul.run(`veel-${i}`, 3, null);
    })();
    expect(taken().find((t) => t.key.endsWith(':schrijven-mislukt'))!.title).toContain(`${MAP_MAX_ONGEZIEN} of meer`);
    const ongezien = () => o.n('SELECT COUNT(*) AS n FROM sync_map_problemen WHERE gezien_op IS NULL');
    p.schrijfBytes('kapot-5.bvns', randomBytes(304));
    await o.draai(() => existsSync(join(o.verwerkt, 'kapot-5.bvns')));
    const voor = ongezien();
    expect(voor).toBeGreaterThanOrEqual(MAP_MAX_ONGEZIEN);
    p.schrijfBytes('kapot-6.bvns', randomBytes(305));
    await o.draai(() => existsSync(join(o.verwerkt, 'kapot-6.bvns')));
    expect(ongezien()).toBe(voor);

    // in de kopie bij de boekhouder komt de melding niet
    o.t.s.settings.markOfficeCopy({ office: 'Kantoor Test', exchange: 1, endDate: iso(Date.now() - 30 * DAG) });
    expect(o.t.s.inbox.tasks()).toEqual([]);
  });

  it('MAP-10 zelfde mappen als de bonnenmap: van-telefoon/ en van-pc/ liggen in de gekozen bonnenmap (de bestaande instelling) en worden aangemaakt als ze er niet zijn; de bonnenmap-bewaking van gewone bonnen (jpg, png, pdf, xml in de hoofdmap) blijft ongewijzigd werken en pikt de bestanden in de submappen nooit op; zonder gekozen map of met een niet-toegestane map gebeurt er niets', async () => {
    const o = await omgeving();
    const p = await koppel(o);
    for (const d of [o.van, o.verwerkt, o.naar]) expect(statSync(d).isDirectory(), d).toBe(true);
    expect(o.lijst(o.folder)).toEqual(['van-pc', 'van-telefoon']);
    expect(o.scanner.folder()).toBe(o.folder);
    // ontbreken ze, dan maakt de volgende rondgang ze opnieuw aan
    rmSync(o.naar, { recursive: true });
    rmSync(o.verwerkt, { recursive: true });
    await o.scanner.scanMap();
    for (const d of [o.van, o.verwerkt, o.naar]) expect(statSync(d).isDirectory(), d).toBe(true);
    // gewone bonnen in de hoofdmap gaan zoals altijd de inbox in; een foto in een submap nooit
    writeFileSync(join(o.folder, 'tankbon.jpg'), makeJpeg('tank'));
    writeFileSync(join(o.van, 'foto.jpg'), makeJpeg('in van-telefoon'));
    writeFileSync(join(o.naar, 'foto.jpg'), makeJpeg('in van-pc'));
    for (let i = 0; i < 3; i++) await o.scanner.scanFolder();
    expect(o.t.db.prepare('SELECT original_name FROM documents ORDER BY id').all()).toEqual([{ original_name: 'tankbon.jpg' }]);
    expect(o.lijst(o.folder)).toEqual(['van-pc', 'van-telefoon', 'verwerkt']);
    expect(o.lijst(o.van)).toContain('foto.jpg');
    // een verzoek in de hoofdmap is geen verzoek: alleen van-telefoon/ telt
    const hoofd = p.maak(klantBericht('Hoofdmap'));
    writeFileSync(join(o.folder, `${hoofd.nonce.toString('hex')}.bvns`), hoofd.body);
    for (let i = 0; i < 3; i++) await o.scanner.scanMap();
    expect(o.n('SELECT COUNT(*) AS n FROM relations WHERE name = ?', 'Hoofdmap')).toBe(0);

    // zonder gekozen map: niets aangemaakt
    const leeg = await omgeving({ zonderMap: true });
    await leeg.scanner.scanMap();
    expect(leeg.scanner.status().map).toMatchObject({ bereikbaar: false, wachtend: 0 });
    expect(leeg.lijst(leeg.folder)).toEqual([]);
    // een map die niet (meer) mag: de gekozen map is te breed geworden, dus niets
    const thuis = await omgeving({ zonderMap: true });
    thuis.t.db.prepare(`INSERT INTO settings (key, value) VALUES ('receiptFolder', ?)`).run(JSON.stringify(thuis.folder));
    const toegestaan = bouwScanner(thuis.t, thuis.data, thuis.adminDir, { homeDir: thuis.folder });
    await toegestaan.scanMap();
    expect(thuis.lijst(thuis.folder)).toEqual([]);
    // zolang koppelen uit staat (PHONE_SCANNER) gebeurt er niets, ook niet met een geldige map
    PHONE_SCANNER.available = false;
    const uit = await omgeving({ zonderMap: true });
    uit.t.db.prepare(`INSERT INTO settings (key, value) VALUES ('receiptFolder', ?)`).run(JSON.stringify(uit.folder));
    await uit.scanner.scanMap();
    await uit.scanner.scanMap();
    expect(uit.lijst(uit.folder)).toEqual([]);
    expect(uit.scanner.status().map).toMatchObject({ bereikbaar: false });
  });

  it('MAP-11 apparaat uit de inhoud: het apparaat (deviceId) en zijn apparaatcode komen uit de kop van de envelop en uit de koppeling, nooit uit de bestandsnaam of een veld in het bericht; een ontkoppeld apparaat krijgt geen antwoord en zijn bestanden zijn definitief (naar verwerkt/ met reden niet-gekoppeld)', async () => {
    const o = await omgeving();
    const een = await koppel(o);
    const twee = await koppel(o);
    expect((await een.viaMap(klantBericht('Van een'))).json).toMatchObject({ uitkomst: 'toegepast' });
    // het tweede apparaat noemt zijn bestand naar het eerste apparaat en de nonce van een ander: de inhoud beslist
    const uuid = randomUUID();
    const v = twee.schrijf(klantBericht('Van twee', { uuid }), [], { naam: `${een.apparaat}.bvns` });
    await o.draai(() => existsSync(twee.antwoordPad(v.nonce)));
    expect(twee.antwoord(v.nonce)).toMatchObject({ ok: true, uitkomst: 'toegepast' });
    expect(openResponse(readFileSync(twee.antwoordPad(v.nonce)), een.sleutel, v.nonce)).toBeNull();
    expect(o.register().find((r) => r.uuid === uuid)).toMatchObject({ route: 'map' });
    expect(o.rijen('SELECT apparaat_id FROM sync_ontvangen WHERE uuid = ?', uuid)).toEqual([{ apparaat_id: twee.apparaat }]);
    expect(o.rijen('SELECT code FROM scanner_device_codes WHERE device_id = ?', twee.apparaat)).toEqual([{ code: 'M2' }]);
    expect(o.rijen('SELECT DISTINCT bron FROM relation_field_rev WHERE LENGTH(bron) > 0 AND relation_id = (SELECT id FROM relations WHERE uuid = ?)', uuid)).toEqual([{ bron: 'M2' }]);
    // ontkoppeld: geen antwoord, definitief, met de reden
    await o.scanner.unpair(twee.apparaat);
    const na = twee.schrijf(klantBericht('Na ontkoppelen'));
    await o.draai(() => existsSync(join(o.verwerkt, na.naam)));
    expect(existsSync(twee.antwoordPad(na.nonce))).toBe(false);
    expect(o.n('SELECT COUNT(*) AS n FROM relations WHERE name = ?', 'Na ontkoppelen')).toBe(0);
    expect(o.problemen()).toMatchObject([{ bestandsnaam: na.naam, soort: 'onbekend-apparaat', fout: 'niet-gekoppeld', apparaat_id: twee.apparaat }]);
    // het eerste apparaat werkt gewoon door
    expect((await een.viaMap(klantBericht('Nog van een'))).json).toMatchObject({ uitkomst: 'toegepast' });
  });

  it('MAP-12 migratie en nooit verwijderen: de migratie is relatief getest (oude toestand uit migrations.slice, findIndex op een zoektekst uit de nieuwe migratie), bestaande rijen overleven, user_version klopt; geen DELETE in de nieuwe code', () => {
    const zoek = 'CREATE TABLE IF NOT EXISTS sync_map_problemen';
    const i = migrations.findIndex((m) => m.includes(zoek));
    expect(i).toBeGreaterThan(0);
    expect(migrations.filter((m) => m.includes(zoek))).toHaveLength(1);
    expect(migrations[i]!).not.toMatch(/TRIGGER|DROP|DELETE|RENAME/i);
    const oud = new Database(':memory:');
    oud.pragma('foreign_keys = ON');
    for (const m of migrations.slice(0, i)) oud.exec(m);
    oud.pragma(`user_version = ${i}`);
    expect(oud.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'sync_map_problemen'`).all()).toHaveLength(0);
    oud.exec(`INSERT INTO relations (type, name, uuid) VALUES ('klant', 'Oude klant', 'u-oud')`);
    oud.exec(`INSERT INTO sync_ontvangen (apparaat_id, entiteit, uuid, revisie, tijd, ontvangen_op, uitkomst, route) VALUES ('d', 'klant', 'u-oud', 1, 1, 1, 'toegepast', 'netwerk')`);
    migrate(oud);
    expect(oud.pragma('user_version', { simple: true })).toBe(migrations.length);
    expect(oud.prepare('SELECT name, uuid FROM relations').all()).toEqual([{ name: 'Oude klant', uuid: 'u-oud' }]);
    expect(oud.prepare('SELECT uuid, route FROM sync_ontvangen').all()).toEqual([{ uuid: 'u-oud', route: 'netwerk' }]);
    const kolommen = (oud.prepare('PRAGMA table_info(sync_map_problemen)').all() as { name: string }[]).map((k) => k.name);
    expect(kolommen).toEqual(['id', 'bestandsnaam', 'apparaat_id', 'soort', 'fout', 'veld', 'tijd', 'gezien_op']);
    const voeg = (soort: string) => oud.prepare(`INSERT INTO sync_map_problemen (bestandsnaam, soort, tijd) VALUES ('x.bvns', ?, 1)`).run(soort);
    expect(voeg('onleesbaar').changes).toBe(1);
    expect(() => voeg('iets-anders')).toThrow();
    // de nieuwe code verwijdert geen rijen: gezien zet alleen gezien_op
    expect(oud.prepare('UPDATE sync_map_problemen SET gezien_op = 5 WHERE soort = ?').run('onleesbaar').changes).toBe(1);
    expect(oud.prepare('SELECT COUNT(*) AS n FROM sync_map_problemen').get()).toEqual({ n: 1 });
    for (const bestand of ['scanner/map-route.ts', 'scanner/scanner.ts']) expect(readFileSync(join(__dirname, '..', 'src', bestand), 'utf8'), bestand).not.toMatch(/DELETE FROM sync_map_problemen|DELETE FROM sync_/);
    oud.close();
  });

  it('MAP-13 start en stop: het opstarten van de scanner verwerkt wat al in van-telefoon/ ligt (inclusief herhaalbare bestanden van voor het afsluiten), het stoppen laat geen half verwerkt bestand achter en dezelfde bestanden worden daarna niet dubbel toegepast; de status van de scanner toont de maproute (aantal wachtend, verwerkt, problemen) zonder paden of inhoud', async () => {
    const o = await omgeving();
    const p = await koppel(o);
    const klant = randomUUID();
    // een herhaalbaar bestand van voor het afsluiten: een latere revisie van een klant die de pc nog niet kent
    const later = p.schrijf(wijziging('klant', { plaats: 'Utrecht' }, { uuid: klant, revisie: 2, tijd: Date.now() - DAG }));
    await o.scanner.start();
    await wacht(() => o.scanner.status().map.herhaalt === 1);
    expect(o.scanner.status().map).toMatchObject({ actief: true, bereikbaar: true, wachtend: 1, herhaalt: 1, verwerkt: 0, problemen: 0 });
    expect(existsSync(p.antwoordPad(later.nonce))).toBe(false);
    await o.scanner.stop();
    expect(o.scanner.status().map.actief).toBe(false);
    expect(o.lijst(o.van)).toEqual([later.naam, 'verwerkt'].sort());
    expect(o.lijst(o.naar)).toEqual([]);

    // de volgende keer dat de scanner start ligt er ook de eerste revisie; beide worden verwerkt, ieder een keer
    const eerste = p.schrijf(klantBericht('Familie Bakker', { uuid: klant }));
    const tweede = bouwScanner(o.t, o.data, o.adminDir);
    await tweede.start();
    await wacht(() => existsSync(join(o.verwerkt, later.naam)) && existsSync(join(o.verwerkt, eerste.naam)));
    expect(p.antwoord(eerste.nonce)).toMatchObject({ uitkomst: 'toegepast' });
    expect(p.antwoord(later.nonce)).toMatchObject({ uitkomst: 'toegepast' });
    expect(o.rijen('SELECT name, city FROM relations WHERE uuid = ?', klant)).toEqual([{ name: 'Familie Bakker', city: 'Utrecht' }]);
    expect(o.register().filter((r) => r.uuid === klant)).toHaveLength(2);
    // de status: aantallen, nooit paden of inhoud
    const status = tweede.status().map;
    expect(Object.keys(status).sort()).toEqual(['actief', 'bereikbaar', 'herhaalt', 'problemen', 'verwerkt', 'wachtend']);
    expect(status).toMatchObject({ actief: true, bereikbaar: true, wachtend: 0, herhaalt: 0, verwerkt: 2, problemen: 0 });
    expect(JSON.stringify(tweede.status())).not.toContain(eerste.naam);
    await tweede.stop();

    // stoppen tijdens het werk: elk bestand is helemaal klaar (antwoord en verwerkt/) of helemaal onaangeroerd
    const aantal = 15;
    const reeks = Array.from({ length: aantal }, (_, i) => p.schrijf(klantBericht(`Stop ${i}`)));
    const derde = bouwScanner(o.t, o.data, o.adminDir);
    await derde.start();
    await wacht(() => o.lijst(o.naar).length >= 1);
    await derde.stop();
    for (const v of reeks) {
      const klaar = existsSync(join(o.verwerkt, v.naam)) && existsSync(p.antwoordPad(v.nonce));
      const onaangeroerd = existsSync(v.pad) && !existsSync(p.antwoordPad(v.nonce)) && !existsSync(join(o.verwerkt, v.naam));
      expect(klaar || onaangeroerd, v.naam).toBe(true);
    }
    expect(o.lijst(o.van).filter((nm) => nm.endsWith('.tmp'))).toEqual([]);
    // opnieuw starten maakt de rest af, en niets wordt dubbel toegepast
    const vierde = bouwScanner(o.t, o.data, o.adminDir);
    await vierde.start();
    await wacht(() => reeks.every((v) => existsSync(join(o.verwerkt, v.naam))));
    await vierde.stop();
    expect(o.n('SELECT COUNT(*) AS n FROM relations WHERE name LIKE ?', 'Stop %')).toBe(aantal);
    expect(o.n(`SELECT COUNT(*) AS n FROM sync_ontvangen WHERE route = 'map'`)).toBe(aantal + 2);
    expect(o.lijst(o.naar)).toHaveLength(aantal + 2);
  });

  it('MAP-14 bewijs met twee routes: dezelfde bon of factuur eerst via het netwerk en daarna via de map (en andersom) geeft precies een effect (een registerrij met de route van de eerste ontvangst, een spoolrij of factuur) en een tweede uitkomst overgeslagen; een wachtende wijziging die via de map binnenkomt en later via het netwerk komt, komt niet dubbel in de wachtrij', async () => {
    const o = await omgeving();
    const p = await koppel(o);
    const klant = randomUUID();
    expect((await p.netwerk(klantBericht('Familie Jansen', { uuid: klant }))).json).toMatchObject({ uitkomst: 'toegepast' });
    const route = (uuid: string) => o.rijen('SELECT route FROM sync_ontvangen WHERE uuid = ?', uuid);
    const telling = () => ({ spool: o.n('SELECT COUNT(*) AS n FROM scanner_documents'), facturen: o.n('SELECT COUNT(*) AS n FROM invoices'), register: o.n('SELECT COUNT(*) AS n FROM sync_ontvangen') });

    // bon: eerst het netwerk, dan de map
    const fotos1 = [makeJpeg('netwerk eerst')];
    const bon1 = bonBericht(fotos1);
    const bon1Uuid = (bon1.wijziging as { uuid: string }).uuid;
    expect((await p.netwerk(bon1, fotos1)).json).toMatchObject({ uitkomst: 'toegepast' });
    const na1 = telling();
    expect((await p.viaMap(bon1, fotos1)).json).toMatchObject({ ok: true, uitkomst: 'overgeslagen' });
    expect(telling()).toEqual(na1);
    expect(route(bon1Uuid)).toEqual([{ route: 'netwerk' }]);
    // bon: eerst de map, dan het netwerk
    const fotos2 = [makeJpeg('map eerst')];
    const bon2 = bonBericht(fotos2);
    const bon2Uuid = (bon2.wijziging as { uuid: string }).uuid;
    expect((await p.viaMap(bon2, fotos2)).json).toMatchObject({ uitkomst: 'toegepast' });
    const na2 = telling();
    expect((await p.netwerk(bon2, fotos2)).json).toMatchObject({ ok: true, uitkomst: 'overgeslagen' });
    expect(telling()).toEqual(na2);
    expect(route(bon2Uuid)).toEqual([{ route: 'map' }]);
    expect(telling().spool).toBe(na1.spool + 1);

    // factuur: dezelfde twee volgordes
    const f1 = factuurBericht(klant, 1);
    expect((await p.netwerk(f1)).json).toMatchObject({ uitkomst: 'toegepast' });
    expect((await p.viaMap(f1)).json).toMatchObject({ uitkomst: 'overgeslagen' });
    const f2 = factuurBericht(klant, 2);
    expect((await p.viaMap(f2)).json).toMatchObject({ uitkomst: 'toegepast' });
    expect((await p.netwerk(f2)).json).toMatchObject({ uitkomst: 'overgeslagen' });
    expect(o.n('SELECT COUNT(*) AS n FROM invoices')).toBe(2);
    expect(route((f1.wijziging as { uuid: string }).uuid)).toEqual([{ route: 'netwerk' }]);
    expect(route((f2.wijziging as { uuid: string }).uuid)).toEqual([{ route: 'map' }]);

    // een wachtende wijziging: eerst de map, later het netwerk: een wachtrijrij
    const projectUuid = randomUUID();
    const onbekendeKlant = randomUUID();
    const proj = projectBericht(onbekendeKlant, { uuid: projectUuid });
    expect((await p.viaMap(proj)).json).toMatchObject({ uitkomst: 'wacht' });
    expect((await p.netwerk(proj)).json).toMatchObject({ uitkomst: 'wacht' });
    expect(o.rijen(`SELECT route, verwerkt_op FROM sync_wachtrij WHERE entiteit = 'project' AND uuid = ?`, projectUuid)).toEqual([{ route: 'map', verwerkt_op: null }]);
    // zodra de klant er is, wordt het project een keer toegepast, met de route van de eerste ontvangst
    expect((await p.netwerk(klantBericht('Wachtende klant', { uuid: onbekendeKlant }))).json).toMatchObject({ uitkomst: 'toegepast' });
    expect(o.n('SELECT COUNT(*) AS n FROM jobs WHERE uuid = ?', projectUuid)).toBe(1);
    expect(route(projectUuid)).toEqual([{ route: 'map' }]);
    expect(o.n(`SELECT COUNT(*) AS n FROM sync_wachtrij WHERE entiteit = 'project' AND uuid = ?`, projectUuid)).toBe(1);
    // en andersom: eerst het netwerk, later de map
    const project2 = randomUUID();
    const proj2 = projectBericht(randomUUID(), { uuid: project2 });
    expect((await p.netwerk(proj2)).json).toMatchObject({ uitkomst: 'wacht' });
    expect((await p.viaMap(proj2)).json).toMatchObject({ uitkomst: 'wacht' });
    expect(o.rijen(`SELECT route FROM sync_wachtrij WHERE entiteit = 'project' AND uuid = ?`, project2)).toEqual([{ route: 'netwerk' }]);
  });
});
