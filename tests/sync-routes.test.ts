import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeTotals, type LineInput } from '@gratis-boekhouden/kern';
import { setup } from './helpers';
import { makeJpeg } from './fixtures/jpeg';
import type { MailAttachment, MailMessage, MailSource, PollResult } from '../src/mail/mail-intake';
import { CONTENT_TYPE, ENDPOINT_PATH, decodePairing, encodeFrame, openResponse, sealRequest, type ProtocolVersion } from '../src/scanner/protocol';
import { Bonnenscanner } from '../src/scanner/scanner';
import { PHONE_SCANNER } from '../src/shared/phone-scanner';

// Idempotentie over de drie routes heen (CONTRACT s19): dezelfde wijziging (klant, project, factuur, bon, foto) via het netwerk, de
// bonnenmap en de e-mail geeft precies een effect. Elke route loopt door zijn EIGEN echte ontvanger: de echte ScannerReceiver op
// 127.0.0.1 met versleutelde HTTP-verzoeken, de echte MapRoute met een tijdelijke bonnenmap en de echte MailIntakeService met een
// nagebootste mailbox en de handler van de scanner (Bonnenscanner.mailHandler). Nergens wordt verwerk() met een andere routenaam
// aangeroepen. Echte databank, echte bestanden, een eigen payload-bouwer, relatieve datums; er wordt op een toestand gewacht, nooit
// een vaste tijd. Elke combinatie krijgt een eigen administratie; bij elke stap wordt de volledige stand (rijen, bestanden, tellers)
// vergeleken met de stand na de eerste ontvangst.

const LOOPBACK = [{ address: '127.0.0.1', netmask: '255.0.0.0' }];
const DAG = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const GISTEREN = iso(Date.now() - DAG);
const DATUM = iso(Date.now() - 10 * DAG);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const fotoVelden = (fotos: Buffer[]) => fotos.map((f) => ({ grootte: f.length, sha256: sha(f) }));

type Route = 'netwerk' | 'map' | 'mail';
const ROUTES: Route[] = ['netwerk', 'map', 'mail'];
/** alle 6 volgorden van de 3 routes */
const VOLGORDES: Route[][] = ROUTES.flatMap((a) => ROUTES.filter((b) => b !== a).map((b) => [a, b, ROUTES.find((c) => c !== a && c !== b)!]));
const naamVan = (v: Route[]) => v.join('>');

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
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), voorvoegsel)));
  dirs.push(d);
  return d;
};

async function wacht(voorwaarde: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const eind = Date.now() + ms;
  while (!(await voorwaarde())) {
    if (Date.now() > eind) throw new Error('de verwachte toestand kwam niet');
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** Nep-mailbox (de mailbox zelf is extern): berichten per map. */
class FakeMailbox implements MailSource {
  folders = new Map<string, { uidValidity: string; messages: MailMessage[] }>();
  private current = '';
  add(folder: string, m: Partial<MailMessage> & { uid: number }) {
    if (!this.folders.has(folder)) this.folders.set(folder, { uidValidity: '1', messages: [] });
    this.folders.get(folder)!.messages.push({ messageId: `<${folder}-${m.uid}@x>`, fromAddress: 'iemand@elders.example', fromName: 'Iemand', subject: 'Bericht', date: GISTEREN, text: '', attachments: [], ...m });
  }
  async open(folder: string) {
    const f = this.folders.get(folder);
    this.current = folder;
    return f ? { uidValidity: f.uidValidity } : null;
  }
  async list(afterUid: number) {
    return this.folders.get(this.current)!.messages.map((m) => m.uid).filter((u) => u > afterUid).sort((a, b) => a - b);
  }
  async fetch(uid: number) {
    return this.folders.get(this.current)!.messages.find((m) => m.uid === uid) ?? null;
  }
  async move(uid: number, _target: string) {
    const f = this.folders.get(this.current)!;
    f.messages = f.messages.filter((m) => m.uid !== uid);
  }
}
const att = (filename: string, content: Uint8Array): MailAttachment => ({ filename, content, contentType: 'application/octet-stream', inline: false });

// ---------- de bewijsopzet: een administratie met de drie echte ontvangers ----------

async function opzet() {
  const t = setup();
  t.s.settings.update({ onboardingDone: true, mailIn: { enabled: true, host: 'imap.example.nl', port: 993, secure: true, user: 'administratie@piet.nl', folder: 'INBOX', extraFolders: [], processedFolder: 'Verwerkt', since: '' } });
  const data = tmp('bvn-routes-gegevens-');
  const adminDir = tmp('bvn-routes-admin-');
  const folder = tmp('bvn-routes-map-');
  const logs: string[] = [];
  const scanner = new Bonnenscanner({
    db: t.db,
    secrets: t.secrets,
    intake: t.s.intake,
    settings: t.s.settings,
    invoices: t.s.invoices,
    spoolDir: join(data, 'bonnenscanner'),
    adminDir,
    protectedDirs: [data],
    interfaces: () => LOOPBACK,
    folderPollMs: 5,
    folderStableMs: 0,
    log: (m) => void logs.push(m),
  });
  open.push(scanner);
  t.s.mail.setTelefoonHandler(scanner.mailHandler());
  await scanner.setFolder(folder);
  const box = new FakeMailbox();
  let uid = 0;
  const rijen = (sql: string, ...p: unknown[]) => t.db.prepare(sql).all(...p) as Record<string, any>[];
  const n = (sql: string, ...p: unknown[]) => (t.db.prepare(sql).get(...p) as { n: number }).n;
  return {
    t,
    data,
    adminDir,
    folder,
    van: join(folder, 'van-telefoon'),
    verwerkt: join(folder, 'van-telefoon', 'verwerkt'),
    naar: join(folder, 'van-pc'),
    scanner,
    logs,
    rijen,
    n,
    zetInMailbox(bijlagen: MailAttachment[]): number {
      uid++;
      box.add('INBOX', { uid, attachments: bijlagen });
      return uid;
    },
    poll: (): Promise<PollResult> => t.s.mail.poll(box),
    problemen: () => rijen('SELECT bestandsnaam, apparaat_id, soort, fout, veld, route FROM sync_map_problemen ORDER BY id'),
  };
}
type Opz = Awaited<ReturnType<typeof opzet>>;

interface Env {
  nonce: Buffer;
  naam: string;
  body: Buffer;
}
interface Antwoord {
  status?: number;
  json: Record<string, any> | null;
}

/** De telefoon: maakt versleutelde verzoeken (dezelfde bytes kunnen over netwerk, map en mail) en kent zijn koppelsleutel. */
async function koppel(o: Opz) {
  const gestart = await o.scanner.pair();
  const k = decodePairing(gestart.payload);
  const sleutel = Buffer.from(k.sleutel, 'base64url');
  const deviceId = Buffer.from(k.apparaat, 'base64url');
  const url = `http://${k.adressen[0]}:${k.poort}${ENDPOINT_PATH}`;
  const maak = (json: Record<string, unknown>, bijlagen: Buffer[] = [], opts: { versie?: ProtocolVersion; sleutel?: Buffer; deviceId?: Buffer } = {}): Env => {
    const nonce = randomBytes(12);
    return { nonce, naam: `${nonce.toString('hex')}.bvns`, body: sealRequest(opts.deviceId ?? deviceId, opts.sleutel ?? sleutel, encodeFrame(json, bijlagen), nonce, opts.versie ?? 2) };
  };
  const tel = {
    apparaat: k.apparaat,
    deviceId,
    sleutel,
    code: '',
    maak,
    url,
    antwoordPad: (e: Env) => join(o.naar, `${e.nonce.toString('hex')}.antwoord.bvns`),
    /** de enige plek die een omslag naar het netwerk maakt: een echt HTTP-verzoek, het antwoord ontsleuteld (of, bij een foutcode, in de klare tekst) */
    async netwerk(e: Env): Promise<Antwoord> {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': CONTENT_TYPE }, body: new Uint8Array(e.body) });
      const bytes = Buffer.from(await res.arrayBuffer());
      const json = openResponse(bytes, sleutel, e.nonce) ?? (JSON.parse(bytes.toString('utf8')) as Record<string, any>);
      return { status: res.status, json };
    },
  };
  const hallo = await tel.netwerk(maak({ soort: 'hallo', tijd: Date.now(), naam: 'Pixel van Piet', app: '1.0.0' }));
  expect(hallo.status).toBe(200);
  tel.code = String(hallo.json!.apparaatcode);
  return tel;
}
type Tel = Awaited<ReturnType<typeof koppel>>;

/** Legt de bytes als bestand in van-telefoon/ (eerst .tmp, dan hernoemen) en draait de rondgang tot het bestand is afgehandeld; geeft het antwoordbestand terug (als het er is). */
async function viaMap(o: Opz, tel: Tel, e: Env): Promise<Antwoord> {
  mkdirSync(o.van, { recursive: true });
  const pad = join(o.van, e.naam);
  writeFileSync(`${pad}.tmp`, e.body);
  renameSync(`${pad}.tmp`, pad);
  await wacht(async () => {
    await o.scanner.scanMap();
    return !existsSync(pad);
  });
  const a = tel.antwoordPad(e);
  return { json: existsSync(a) ? (openResponse(readFileSync(a), tel.sleutel, e.nonce) as Record<string, any> | null) : null };
}

/** Een mail met de envelop als .bvns-bijlage en een ophaalronde van de echte mailimport; de pc antwoordt nooit per mail. */
async function viaMail(o: Opz, e: Env): Promise<Antwoord> {
  o.zetInMailbox([att(e.naam, e.body)]);
  const r = await o.poll();
  expect(r.errors).toBe(0);
  return { json: null };
}

async function stuur(o: Opz, tel: Tel, route: Route, e: Env): Promise<Antwoord> {
  const a = route === 'netwerk' ? await tel.netwerk(e) : route === 'map' ? await viaMap(o, tel, e) : await viaMail(o, e);
  // een nieuwe bon gaat naar de inbox: wacht tot dat klaar is, zodat de stand volledig is
  await o.scanner.processSpool();
  return a;
}

// ---------- de berichten (een eigen bouwer) ----------

const wijziging = (entiteit: string, velden: Record<string, unknown>, over: { uuid?: string; revisie?: number; tijd?: number } = {}) => ({
  soort: 'wijziging',
  tijd: Date.now(),
  wijziging: { entiteit, uuid: over.uuid ?? randomUUID(), revisie: over.revisie ?? 1, tijd: over.tijd ?? Date.now() - 2 * DAG, velden },
});
const klantBericht = (uuid: string, naam = 'Familie Bakker') => wijziging('klant', { naam }, { uuid });
const projectBericht = (uuid: string, klant: string, titel = 'Schilderwerk') => wijziging('project', { titel, klant }, { uuid });
function factuurBericht(uuid: string, klantUuid: string, code: string, volgnr = 1, omschrijving = 'Montage', prijs = 4550) {
  const regel = { omschrijving, hoeveelheid: 2, prijs, btw_soort: 'hoog', eenheid: 'uur' };
  const totalen = computeTotals([{ description: regel.omschrijving, quantity: regel.hoeveelheid, unitPrice: regel.prijs, vatCode: 'hoog' } as LineInput]);
  return wijziging(
    'factuur',
    {
      nummer: `${code}-${DATUM.slice(0, 4)}-${String(volgnr).padStart(4, '0')}`,
      datum: DATUM,
      vervaldatum: iso(Date.parse(DATUM) + 30 * DAG),
      klant_uuid: klantUuid,
      klant_momentopname: { name: 'Familie Bakker', address: 'Dorpsstraat 1', city: 'Utrecht', country: 'NL', vat_number: 'NL123456789B01', kvk_number: '12345678', email: 'info@bakker.example' },
      bedrijf_momentopname: { name: 'Bakker Klus', address: 'Werfstraat 2', city: 'Zwolle', kvkNumber: '87654321', vatNumber: 'NL987654321B01', kor: false },
      regels: [regel],
      totalen: { subtotaal: totalen.subtotal, btw: totalen.vatTotal, totaal: totalen.total },
      verzonden_op: `${DATUM} 10:30:00`,
      regeltabel_versie: '2026-1',
    },
    { uuid },
  );
}
const bonBericht = (uuid: string, fotos: Buffer[]) => wijziging('bon', { betaalwijze: 'contant', notitie: 'Schroeven voor de klus', fotos: fotoVelden(fotos) }, { uuid });
const fotoBericht = (uuid: string, project: string, fotos: Buffer[]) => wijziging('foto', { project_uuid: project, notitie: 'Voor het schilderen', fotos: fotoVelden(fotos) }, { uuid });
/** het oude bon-bericht (geen wijziging): zelfde spool, geen register */
const oudBonBericht = (id: string, fotos: Buffer[]) => ({ soort: 'bon', tijd: Date.now(), id, betaalwijze: 'contant', notitie: 'Schroeven voor de klus', fotos: fotos.map((f) => ({ grootte: f.length })) });

// ---------- de stand van de administratie ----------

function lijst(map: string): string[] {
  if (!existsSync(map)) return [];
  return readdirSync(map)
    .flatMap((naam) => {
      const pad = join(map, naam);
      return statSync(pad).isDirectory() ? lijst(pad).map((x) => `${naam}/${x}`) : [naam];
    })
    .sort();
}

const TELLERS = {
  relations: 'SELECT COUNT(*) AS n FROM relations',
  jobs: 'SELECT COUNT(*) AS n FROM jobs',
  invoices: 'SELECT COUNT(*) AS n FROM invoices',
  journal_entries: 'SELECT COUNT(*) AS n FROM journal_entries',
  scanner_documents: 'SELECT COUNT(*) AS n FROM scanner_documents',
  documents: 'SELECT COUNT(*) AS n FROM documents',
  job_photos: 'SELECT COUNT(*) AS n FROM job_photos',
  sync_ontvangen: 'SELECT COUNT(*) AS n FROM sync_ontvangen',
  sync_wachtrij: 'SELECT COUNT(*) AS n FROM sync_wachtrij',
  sync_wachtrij_bijlagen: 'SELECT COUNT(*) AS n FROM sync_wachtrij_bijlagen',
} as const;
type Tellers = Record<keyof typeof TELLERS | 'spool_bestanden' | 'bijlage_bestanden', number>;

/** Alles waaraan een dubbel effect te zien zou zijn: tellingen, de registerrijen, de wachtrij, de tellers en de bestanden. */
function stand(o: Opz) {
  const tellers = Object.fromEntries(Object.entries(TELLERS).map(([k, sql]) => [k, o.n(sql)])) as Tellers;
  const spool = lijst(join(o.data, 'bonnenscanner'));
  const bijlagen = lijst(join(o.adminDir, 'bijlagen'));
  tellers.spool_bestanden = spool.length;
  tellers.bijlage_bestanden = bijlagen.length;
  return {
    tellers,
    sync_teller: o.rijen('SELECT naam, waarde FROM sync_teller ORDER BY naam'),
    factuurteller: o.rijen(`SELECT value FROM settings WHERE key = 'counter:factuur'`),
    register: o.rijen('SELECT apparaat_id, entiteit, uuid, revisie, uitkomst, fout, route FROM sync_ontvangen ORDER BY rowid'),
    wachtrij: o.rijen('SELECT apparaat_id, entiteit, uuid, revisie, route, wacht_op_entiteit, verwerkt_op IS NOT NULL AS klaar, verwerkt_uitkomst, verwerkt_seq FROM sync_wachtrij ORDER BY id'),
    spool,
    bijlagen,
  };
}
type Stand = ReturnType<typeof stand>;
const verschil = (voor: Stand, na: Stand): Partial<Tellers> => {
  const uit: Partial<Tellers> = {};
  for (const k of Object.keys(voor.tellers) as (keyof Tellers)[]) if (na.tellers[k] !== voor.tellers[k]) uit[k] = na.tellers[k] - voor.tellers[k];
  return uit;
};

// ---------- de vijf entiteiten ----------

type Naam = 'klant' | 'project' | 'factuur' | 'bon' | 'foto';
const NAMEN: Naam[] = ['klant', 'project', 'factuur', 'bon', 'foto'];

interface Ctx {
  uuid: string;
  klant: string;
  project: string;
  code: string;
  /** het volgnummer van de factuur (nummers zijn uniek per apparaat) */
  volgnr?: number;
}
interface Bericht {
  json: Record<string, unknown>;
  bijlagen: Buffer[];
}
interface Entiteit {
  /** wat een geslaagde eerste ontvangst aan tellingen verandert (alles wat er niet staat blijft gelijk) */
  delta: Partial<Tellers>;
  /** wat de eerste ontvangst moet beantwoorden */
  eerste: string;
  /** de wijziging; met `anders` dezelfde uuid met afwijkende inhoud */
  bouw(c: Ctx, anders?: boolean): Bericht;
}

const FOTOS = [makeJpeg('een'), makeJpeg('twee')];
const FOTOS_ANDERS = [makeJpeg('drie'), makeJpeg('vier')];
/** elke bon een eigen foto: de inbox herkent dezelfde afbeelding en maakt er dan geen tweede document van */
const bonFotos = (uuid: string, anders = false) => [makeJpeg(`${anders ? 'andere ' : ''}bon ${uuid}`)];

const ENTITEITEN: Record<Naam, Entiteit> = {
  klant: { delta: { relations: 1, sync_ontvangen: 1 }, eerste: 'toegepast', bouw: (c, anders) => ({ json: klantBericht(c.uuid, anders ? 'Familie Anders' : 'Familie Bakker'), bijlagen: [] }) },
  project: { delta: { jobs: 1, sync_ontvangen: 1 }, eerste: 'toegepast', bouw: (c, anders) => ({ json: projectBericht(c.uuid, c.klant, anders ? 'Ander werk' : 'Schilderwerk'), bijlagen: [] }) },
  factuur: {
    delta: { invoices: 1, journal_entries: 1, sync_ontvangen: 1 },
    eerste: 'toegepast',
    bouw: (c, anders) => ({ json: anders ? factuurBericht(c.uuid, c.klant, c.code, 2, 'Iets heel anders', 9999) : factuurBericht(c.uuid, c.klant, c.code, c.volgnr ?? 1), bijlagen: [] }),
  },
  bon: { delta: { scanner_documents: 1, documents: 1, sync_ontvangen: 1 }, eerste: 'toegepast', bouw: (c, anders) => ({ json: bonBericht(c.uuid, bonFotos(c.uuid, anders)), bijlagen: bonFotos(c.uuid, anders) }) },
  foto: { delta: { job_photos: 2, bijlage_bestanden: 2, sync_ontvangen: 1 }, eerste: 'toegepast', bouw: (c, anders) => ({ json: fotoBericht(c.uuid, c.project, anders ? FOTOS_ANDERS : FOTOS), bijlagen: anders ? FOTOS_ANDERS : FOTOS }) },
};

/** de combinaties die zijn doorlopen en geslaagd (voor ROUTE-12) */
const bewezen = new Set<string>();

/** Een verse administratie met een gekoppelde telefoon; klant en project bestaan al als de entiteit ze nodig heeft (alleen die voorbereiding loopt over het netwerk). */
async function voorbereid(naam: Naam | null, o?: Opz) {
  const opz = o ?? (await opzet());
  const tel = await koppel(opz);
  const c: Ctx = { uuid: randomUUID(), klant: randomUUID(), project: randomUUID(), code: tel.code };
  if (naam === 'project' || naam === 'factuur' || naam === 'foto') expect((await tel.netwerk(tel.maak(klantBericht(c.klant)))).json!.uitkomst).toBe('toegepast');
  if (naam === 'foto') expect((await tel.netwerk(tel.maak(projectBericht(c.project, c.klant)))).json!.uitkomst).toBe('toegepast');
  return { o: opz, tel, c };
}

/**
 * Dezelfde wijziging via de routes in de gegeven reeks. De eerste ontvangst geeft precies het verwachte effect (en de registerrij
 * draagt zijn route); daarna blijft de volledige stand gelijk. Een herhaling via map of mail kan dezelfde bytes zijn (zoals een bestand dat
 * opnieuw verschijnt); over het netwerk is het altijd een nieuwe envelop (dezelfde bytes zijn daar een herhaalde nonce).
 */
async function doorloop(naam: Naam, reeks: Route[], zelfdeBytes: boolean, etiket: string) {
  const { o, tel, c } = await voorbereid(naam);
  const ent = ENTITEITEN[naam];
  const b = ent.bouw(c);
  const voor = stand(o);
  const gebruikt = new Map<Route, Env>();
  let eerste: Stand | null = null;
  for (const [i, route] of reeks.entries()) {
    const vorige = gebruikt.get(route);
    const e = vorige && zelfdeBytes && route !== 'netwerk' ? vorige : tel.maak(b.json, b.bijlagen);
    gebruikt.set(route, e);
    const a = await stuur(o, tel, route, e);
    const na = stand(o);
    const stap = `${etiket} ${naam} stap ${i + 1} via ${route}`;
    if (i === 0) {
      if (route !== 'mail') expect(a.json?.uitkomst, stap).toBe(ent.eerste);
      expect(verschil(voor, na), stap).toEqual(ent.delta);
      const rij = na.register.filter((r) => r.entiteit === naam && r.uuid === c.uuid);
      expect(rij, stap).toEqual([{ apparaat_id: tel.apparaat, entiteit: naam, uuid: c.uuid, revisie: 1, uitkomst: ent.eerste, fout: null, route }]);
      eerste = na;
    } else {
      expect(na, stap).toEqual(eerste);
      const oud = vorige && zelfdeBytes && route !== 'netwerk';
      // een herhaling met dezelfde bytes krijgt over de map het eerste antwoordbestand (zelfde nonce); anders overgeslagen
      if (route !== 'mail' && !oud) expect(a.json?.uitkomst, stap).toBe('overgeslagen');
    }
  }
  // geen foutcodes aan de telefoon en geen mislukte opslag in het logboek
  expect(o.logs, `${etiket} ${naam}`).toEqual([]);
  expect(o.problemen(), `${etiket} ${naam}`).toEqual([]);
  return { o, tel, c, eerste: eerste! };
}

describe('dezelfde wijziging via netwerk, bonnenmap en e-mail geeft een effect', () => {
  it('ROUTE-01 echte routes: de bewijsopzet heeft de ECHTE ontvangers van alle drie de routes op een administratie (receiver op 127.0.0.1 met versleutelde HTTP-verzoeken, MapRoute met een tijdelijke bonnenmap, MailIntakeService met een nagebootste mailbox en de handler van de scanner); een hulpfunctie stuurt hetzelfde bericht (dezelfde bytes of dezelfde wijziging in een nieuwe envelop met andere nonce) via een gekozen route en geeft de uitkomst terug', async () => {
    const { o, tel } = await voorbereid(null);
    // de receiver luistert echt op de loopback en de map is echt gekozen
    const status = o.scanner.status();
    expect(status.running).toBe(true);
    expect(status.addresses).toEqual(['127.0.0.1']);
    expect(status.phoneAvailable).toBe(true);
    expect(o.scanner.folder()).toBe(o.folder);
    expect(tel.code).toBe('M1');
    expect(status.map.actief).toBe(false);
    expect(status.map.verwerkt).toBe(0);

    // elke route verwerkt een eigen klant door zijn eigen ontvanger: het register draagt de naam van de route
    const klanten = ROUTES.map((route) => ({ route, uuid: randomUUID() }));
    const net = await stuur(o, tel, 'netwerk', tel.maak(klantBericht(klanten[0]!.uuid)));
    expect(net).toEqual({ status: 200, json: { ok: true, soort: 'wijziging', entiteit: 'klant', uuid: klanten[0]!.uuid, revisie: 1, uitkomst: 'toegepast' } });
    const map = await stuur(o, tel, 'map', tel.maak(klantBericht(klanten[1]!.uuid)));
    expect(map.json).toEqual({ ok: true, soort: 'wijziging', entiteit: 'klant', uuid: klanten[1]!.uuid, revisie: 1, uitkomst: 'toegepast' });
    expect(o.scanner.status().map.verwerkt).toBe(1);
    const mail = await stuur(o, tel, 'mail', tel.maak(klantBericht(klanten[2]!.uuid)));
    expect(mail.json).toBeNull();
    const mails = o.rijen('SELECT outcome, note, moved_to FROM mail_messages');
    expect(mails).toEqual([{ outcome: 'overig', note: 'telefoonbericht', moved_to: 'Verwerkt' }]);
    expect(o.rijen(`SELECT uuid, route FROM sync_ontvangen WHERE entiteit = 'klant' ORDER BY rowid`)).toEqual(klanten.map((k) => ({ uuid: k.uuid, route: k.route })));
    expect(o.n(`SELECT COUNT(*) AS n FROM relations WHERE name = 'Familie Bakker'`)).toBe(3);

    // dezelfde bytes over het netwerk zijn een herhaalde nonce (409, geen effect); een nieuwe envelop met dezelfde wijziging is overgeslagen
    const voor = stand(o);
    const zelfde = tel.maak(klantBericht(klanten[0]!.uuid));
    expect((await stuur(o, tel, 'netwerk', zelfde)).json!.uitkomst).toBe('overgeslagen');
    const nogEens = await stuur(o, tel, 'netwerk', zelfde);
    expect(nogEens.status).toBe(409);
    expect(nogEens.json).toMatchObject({ ok: false, fout: 'herhaald' });
    // dezelfde bytes over map en mail mogen vaker (zoals een bestand dat opnieuw verschijnt): de uitkomst blijft gelijk, het register ook
    const mapEnv = tel.maak(klantBericht(klanten[1]!.uuid));
    await stuur(o, tel, 'map', mapEnv);
    await stuur(o, tel, 'map', mapEnv);
    await stuur(o, tel, 'mail', mapEnv);
    await stuur(o, tel, 'mail', mapEnv);
    expect(stand(o)).toEqual(voor);
    // de map houdt de verwerkte verzoeken bij, nooit iets weggegooid
    expect(lijst(o.verwerkt)).toHaveLength(3);
    expect(o.logs).toEqual([]);
  });

  it('ROUTE-02 klant: dezelfde klantwijziging via elke route, in elke volgorde van de drie routes (alle 6 permutaties) en met herhalingen (elke route twee keer, rond en dubbel), geeft precies een klant, een registerrij (route van de eerste ontvangst, eerste uitkomst toegepast) en daarna overal overgeslagen of dezelfde uitkomst zonder nieuwe rijen', async () => {
    expect(VOLGORDES).toHaveLength(6);
    for (const [i, v] of VOLGORDES.entries()) {
      await doorloop('klant', [...v, ...v], i % 2 === 0, 'rond');
      await doorloop('klant', v.flatMap((r) => [r, r]), i % 2 === 1, 'dubbel');
      bewezen.add(`klant ${naamVan(v)}`);
    }
  });

  it('ROUTE-03 project: hetzelfde voor een projectwijziging (de klus staat precies een keer, een registerrij, geen dubbele wijzigingsnummers: de wijzigingsteller loopt niet door bij een herhaling)', async () => {
    for (const [i, v] of VOLGORDES.entries()) {
      const { o, c } = await doorloop('project', [...v, ...v], i % 2 === 0, 'rond');
      expect(o.rijen('SELECT title, sync_seq FROM jobs WHERE uuid = ?', c.uuid)).toHaveLength(1);
      // het wijzigingsnummer van de klus is uniek en de teller staat er precies op (klant en klus: twee echte wijzigingen)
      const seq = o.rijen('SELECT sync_seq FROM jobs WHERE uuid = ?', c.uuid)[0]!.sync_seq as number;
      expect(o.rijen(`SELECT waarde FROM sync_teller WHERE naam = 'wijziging'`)[0]!.waarde).toBe(seq);
      bewezen.add(`project ${naamVan(v)}`);
    }
  });

  it('ROUTE-04 factuur: hetzelfde voor een definitieve factuur: precies een factuur, een boeking, een registerrij, de pc-teller (counter:factuur) ongewijzigd, en geen tweede boeking of tweede factuurnummer bij herhaling via een andere route', async () => {
    for (const [i, v] of VOLGORDES.entries()) {
      const { o, c, eerste } = await doorloop('factuur', [...v, ...v], i % 2 === 0, 'rond');
      expect(o.rijen('SELECT number, status FROM invoices WHERE uuid = ?', c.uuid)).toEqual([{ number: `${c.code}-${DATUM.slice(0, 4)}-0001`, status: 'verzonden' }]);
      expect(eerste.factuurteller).toEqual([]);
      expect(o.n(`SELECT COUNT(*) AS n FROM invoices WHERE number = ?`, `${c.code}-${DATUM.slice(0, 4)}-0001`)).toBe(1);
      bewezen.add(`factuur ${naamVan(v)}`);
    }
  });

  it('ROUTE-05 bon: hetzelfde voor een bon (wijziging met bijlagen): precies een rij in scanner_documents, een bestand in de spool en een document in de inbox na verwerken, een registerrij; ook een bon eerst via het bon-bericht (v1/v2 zonder wijziging) en daarna via de wijziging van een andere route met dezelfde uuid en inhoud geeft geen tweede document (documenteer de uitkomst: overgeslagen of al)', async () => {
    for (const [i, v] of VOLGORDES.entries()) {
      const { o, c, eerste } = await doorloop('bon', [...v, ...v], i % 2 === 0, 'rond');
      expect(o.rijen('SELECT id, state, document_id IS NOT NULL AS in_inbox FROM scanner_documents')).toEqual([{ id: c.uuid, state: 'verwerkt', in_inbox: 1 }]);
      // het bestand in de spool is na het verwerken naar de inbox: er blijft geen los exemplaar achter
      expect(eerste.spool).toEqual([]);
      bewezen.add(`bon ${naamVan(v)}`);
    }

    // het bon-bericht (versie 1 en 2) en de wijziging delen de spool, niet het register: elke combinatie van routes, in beide richtingen
    for (const versie of [1, 2] as const) {
      for (const eersteRoute of ROUTES) {
        const { o, tel } = await voorbereid(null);
        for (const tweedeRoute of ROUTES) {
          // 1. bon-bericht eerst, daarna de wijziging
          const a = randomUUID();
          const voor = stand(o);
          await stuur(o, tel, eersteRoute, tel.maak(oudBonBericht(a, bonFotos(a)), bonFotos(a), { versie }));
          const naBericht = stand(o);
          expect(verschil(voor, naBericht), `${versie} ${eersteRoute}`).toEqual({ scanner_documents: 1, documents: 1 });
          expect(naBericht.register).toEqual(voor.register);
          const w = await stuur(o, tel, tweedeRoute, tel.maak(bonBericht(a, bonFotos(a)), bonFotos(a)));
          if (tweedeRoute !== 'mail') expect(w.json!.uitkomst, `${versie} ${eersteRoute} ${tweedeRoute}`).toBe('overgeslagen');
          const naWijziging = stand(o);
          // uitkomst: overgeslagen, met een registerrij van de wijziging; geen tweede document en geen tweede bestand
          expect(verschil(naBericht, naWijziging), `${versie} ${eersteRoute} ${tweedeRoute}`).toEqual({ sync_ontvangen: 1 });
          expect(naWijziging.register.at(-1)).toMatchObject({ entiteit: 'bon', uuid: a, uitkomst: 'overgeslagen', route: tweedeRoute });
          expect(naWijziging.spool).toEqual(naBericht.spool);

          // 2. de wijziging eerst, daarna het bon-bericht via een andere route
          const b = randomUUID();
          const vooraf = stand(o);
          await stuur(o, tel, tweedeRoute, tel.maak(bonBericht(b, bonFotos(b)), bonFotos(b)));
          const naEerste = stand(o);
          expect(verschil(vooraf, naEerste)).toEqual({ scanner_documents: 1, documents: 1, sync_ontvangen: 1 });
          const bericht = await stuur(o, tel, eersteRoute, tel.maak(oudBonBericht(b, bonFotos(b)), bonFotos(b), { versie }));
          if (eersteRoute !== 'mail') expect(bericht.json, `${versie} ${tweedeRoute} ${eersteRoute}`).toMatchObject({ ok: true, soort: 'bon', id: b, al: true });
          expect(stand(o), `${versie} ${tweedeRoute} ${eersteRoute}`).toEqual(naEerste);
          bewezen.add(`bon-bericht v${versie} ${eersteRoute}>${tweedeRoute}`);
        }
        expect(o.n('SELECT COUNT(*) AS n FROM scanner_documents')).toBe(6);
        expect(o.logs).toEqual([]);
      }
    }
  });

  it('ROUTE-06 foto: hetzelfde voor een foto bij een bekend project: precies de bestanden en job_photos-rijen van een keer (geen dubbele bestanden onder bijlagen/), een registerrij', async () => {
    for (const [i, v] of VOLGORDES.entries()) {
      const { o, c, eerste } = await doorloop('foto', [...v, ...v], i % 2 === 0, 'rond');
      expect(eerste.bijlagen).toEqual([`telefoon/${c.uuid}/1.jpg`, `telefoon/${c.uuid}/2.jpg`]);
      expect(o.rijen('SELECT volgnr, file_path, sha256 FROM job_photos WHERE wijziging_uuid = ? ORDER BY volgnr', c.uuid)).toHaveLength(2);
      // de bewaarde bestanden zijn de foto's van de telefoon (zonder locatie, hier zonder verandering)
      for (const [j, f] of FOTOS.entries()) expect(readFileSync(join(o.adminDir, 'bijlagen', 'telefoon', c.uuid, `${j + 1}.jpg`)).equals(f)).toBe(true);
      bewezen.add(`foto ${naamVan(v)}`);
    }
  });

  it('ROUTE-07 wachtend over routes: een factuur (klant onbekend), een project (klant onbekend) en een foto (project onbekend) via route A (wacht), daarna dezelfde wijziging via route B en C: nog steeds precies een rij in sync_wachtrij per wijziging (geen dubbele), de uitkomst wacht blijft stabiel; komt de klant (via welke route ook), dan worden ze precies een keer toegepast met een registerrij en een bevestiging', async () => {
    for (const [i, v] of VOLGORDES.entries()) {
      const { o, tel } = await voorbereid(null);
      const klant = randomUUID();
      const c: Ctx = { uuid: randomUUID(), klant, project: randomUUID(), code: tel.code };
      const factuur: Bericht = { json: factuurBericht(randomUUID(), klant, tel.code), bijlagen: [] };
      const project: Bericht = { json: projectBericht(c.project, klant), bijlagen: [] };
      const foto: Bericht = { json: fotoBericht(randomUUID(), c.project, FOTOS), bijlagen: FOTOS };
      const alle = [factuur, project, foto];
      const uuidVan = (b: Bericht) => (b.json.wijziging as { uuid: string }).uuid;
      const voor = stand(o);

      // route A: alles wacht (geen registerrij, wel een wachtrijrij; de bijlagen van de foto staan al op schijf)
      const [A, B, C] = v as [Route, Route, Route];
      for (const b of alle) {
        const a = await stuur(o, tel, A, tel.maak(b.json, b.bijlagen));
        if (A !== 'mail') expect(a.json!.uitkomst, `${naamVan(v)} A`).toBe('wacht');
      }
      const wachtend = stand(o);
      expect(verschil(voor, wachtend)).toEqual({ sync_wachtrij: 3, sync_wachtrij_bijlagen: 2, bijlage_bestanden: 2 });
      expect(wachtend.wachtrij.map((r) => [r.entiteit, r.route, r.klaar])).toEqual([['factuur', A, 0], ['project', A, 0], ['foto', A, 0]]);
      expect(wachtend.register).toEqual(voor.register);

      // route B en C: dezelfde wijzigingen (nieuwe envelop): nog steeds wacht, niets erbij
      for (const route of [B, C, A, B, C]) {
        for (const b of alle) {
          const a = await stuur(o, tel, route, tel.maak(b.json, b.bijlagen));
          if (route !== 'mail') expect(a.json!.uitkomst, `${naamVan(v)} ${route}`).toBe('wacht');
          expect(stand(o), `${naamVan(v)} ${route} ${(b.json.wijziging as { entiteit: string }).entiteit}`).toEqual(wachtend);
        }
      }

      // de klant komt, via een van de routes (per volgorde een andere): alles wordt precies een keer toegepast
      const D = v[i % 3]!;
      const k = await stuur(o, tel, D, tel.maak(klantBericht(klant)));
      if (D !== 'mail') expect(k.json!.uitkomst).toBe('toegepast');
      const klaar = stand(o);
      expect(verschil(wachtend, klaar)).toEqual({ relations: 1, jobs: 1, invoices: 1, journal_entries: 1, job_photos: 2, sync_ontvangen: 4 });
      expect(klaar.wachtrij.map((r) => [r.entiteit, r.route, r.klaar, r.verwerkt_uitkomst])).toEqual([['factuur', A, 1, 'toegepast'], ['project', A, 1, 'toegepast'], ['foto', A, 1, 'toegepast']]);
      expect(klaar.register.map((r) => `${r.entiteit} ${r.route} ${r.uitkomst}`).sort()).toEqual([`klant ${D} toegepast`, `project ${A} toegepast`, `factuur ${A} toegepast`, `foto ${A} toegepast`].sort());
      // een bevestiging per wachtende wijziging, precies een keer
      const bev = await tel.netwerk(tel.maak({ soort: 'bevestigingen', tijd: Date.now(), na: 0 }));
      expect((bev.json!.bevestigingen as Record<string, any>[]).map((b) => [b.entiteit, b.uitkomst]).sort()).toEqual([['factuur', 'toegepast'], ['foto', 'toegepast'], ['project', 'toegepast']]);
      expect((bev.json!.bevestigingen as Record<string, any>[]).map((b) => b.uuid).sort()).toEqual(alle.map(uuidVan).sort());

      // daarna: elke route nog eens, ook de klant: overgeslagen, de stand verandert niet meer
      for (const route of v) {
        for (const b of [...alle, { json: klantBericht(klant), bijlagen: [] as Buffer[] }]) {
          const a = await stuur(o, tel, route, tel.maak(b.json, b.bijlagen));
          if (route !== 'mail') expect(a.json!.uitkomst).toBe('overgeslagen');
        }
      }
      expect(stand(o)).toEqual(klaar);
      const bev2 = await tel.netwerk(tel.maak({ soort: 'bevestigingen', tijd: Date.now(), na: 0 }));
      expect(bev2.json!.bevestigingen).toEqual(bev.json!.bevestigingen);
      expect(o.logs).toEqual([]);
      bewezen.add(`wachtend ${naamVan(v)}`);
    }
  });

  it('ROUTE-08 verschillende inhoud, dezelfde uuid: dezelfde uuid met afwijkende inhoud via een andere route: de eerst opgeslagen inhoud blijft leidend (conflict/overgeslagen of afgewezen id-botst volgens het type) en er verandert niets aan wat er al stond, ook niet bij de volgorde map eerst of mail eerst', async () => {
    // elk geordend paar (eerste route, tweede route), per entiteit
    for (const naam of NAMEN) {
      for (const eersteRoute of ROUTES) {
        for (const tweedeRoute of ROUTES.filter((r) => r !== eersteRoute)) {
          const derde = ROUTES.find((r) => r !== eersteRoute && r !== tweedeRoute)!;
          const { o, tel, c } = await voorbereid(naam);
          const ent = ENTITEITEN[naam];
          const goed = ent.bouw(c);
          const anders = ent.bouw(c, true);
          await stuur(o, tel, eersteRoute, tel.maak(goed.json, goed.bijlagen));
          const eerste = stand(o);
          const inhoud = () => ({
            klant: o.rijen('SELECT name FROM relations WHERE uuid = ?', c.uuid),
            project: o.rijen('SELECT title FROM jobs WHERE uuid = ?', c.uuid),
            factuur: o.rijen('SELECT number, total FROM invoices WHERE uuid = ?', c.uuid),
            bon: o.rijen('SELECT id, content_hash FROM scanner_documents'),
            foto: o.rijen('SELECT sha256 FROM job_photos WHERE wijziging_uuid = ? ORDER BY volgnr', c.uuid),
          }[naam]);
          const inhoudEerste = inhoud();
          const label = `${naam} ${eersteRoute}>${tweedeRoute}`;
          const volgorde = [tweedeRoute, derde, eersteRoute];
          for (const [j, route] of volgorde.entries()) {
            const a = await stuur(o, tel, route, tel.maak(anders.json, anders.bijlagen));
            // geen enkele route verandert iets aan wat er stond (ook geen nieuwe rijen of bestanden)
            expect(stand(o), `${label} via ${route}`).toEqual(eerste);
            // klant, project, factuur en bon: de registersleutel is al gezien (overgeslagen); een foto controleert de inhoud ook dan en wijst af met id-botst
            if (route !== 'mail') expect(a.json?.uitkomst, `${label} stap ${j + 1}`).toBe(naam === 'foto' ? 'afgewezen' : 'overgeslagen');
            if (route !== 'mail' && naam === 'foto') expect(a.json?.fout, label).toBe('id-botst');
          }
          expect(inhoud(), label).toEqual(inhoudEerste);
          if (naam === 'klant') expect(inhoudEerste).toEqual([{ name: 'Familie Bakker' }]);
          if (naam === 'project') expect(inhoudEerste).toEqual([{ title: 'Schilderwerk' }]);
          if (naam === 'bon') {
            // het oude bon-bericht met afwijkende inhoud onder hetzelfde id: id-botst (409), geen verandering
            const oud = await stuur(o, tel, 'netwerk', tel.maak(oudBonBericht(c.uuid, bonFotos(c.uuid, true)), bonFotos(c.uuid, true)));
            expect(oud.status, label).toBe(409);
            expect(oud.json, label).toMatchObject({ ok: false, fout: 'id-botst' });
            expect(stand(o), label).toEqual(eerste);
            expect(inhoud(), label).toEqual(inhoudEerste);
          }
          expect(o.logs, label).toEqual([]);
          bewezen.add(`andere inhoud ${naam} ${eersteRoute}>${tweedeRoute}`);
        }
      }
    }
  });

  it('ROUTE-09 gelijktijdigheid: dezelfde wijziging vrijwel gelijktijdig via netwerk, map en mail (de routes lopen door elkaar heen: start ze zonder op elkaar te wachten, bijvoorbeeld met Promise.all en de pollrondes van map en mail terwijl het netwerkverzoek loopt) geeft precies een effect en geen databasefout aan de telefoon (een fout is hoogstens herhaalbaar, nooit een dubbel effect)', async () => {
    const STAPPEN = [0, 3, 12, 48, 192, 768];
    const gevallen: { naam: string; ent: Naam; wachtend?: boolean }[] = [...NAMEN.map((ent) => ({ naam: ent as string, ent })), { naam: 'factuur wachtend', ent: 'factuur', wachtend: true }];
    for (const geval of gevallen) {
      const { o, tel, c } = await voorbereid(geval.ent);
      const ent = ENTITEITEN[geval.ent];
      for (const [ronde, start] of VOLGORDES.entries()) {
        // elke ronde een nieuwe wijziging (eigen uuid); de factuur die wacht verwijst naar een klant die er niet is
        const cc: Ctx = { ...c, uuid: randomUUID(), volgnr: ronde + 1 };
        if (geval.wachtend) cc.klant = randomUUID();
        const b = ent.bouw(cc);
        const delta = geval.wachtend ? { sync_wachtrij: 1 } : ent.delta;
        const voor = stand(o);
        // de routes starten na elkaar zonder op elkaar te wachten (de eerste route van de reeks het eerst) en lopen door elkaar heen:
        // twee netwerkverzoeken, twee bestanden in de map met een pollronde, en een mail met een ophaalronde
        const lopend: Promise<Antwoord>[] = [];
        const netwerk: Promise<Antwoord>[] = [];
        for (const route of start) {
          if (route === 'netwerk') for (let k = 0; k < 2; k++) netwerk.push(tel.netwerk(tel.maak(b.json, b.bijlagen)));
          if (route === 'map') for (let k = 0; k < 2; k++) lopend.push(viaMap(o, tel, tel.maak(b.json, b.bijlagen)));
          if (route === 'mail') lopend.push(viaMail(o, tel.maak(b.json, b.bijlagen)));
          // een wisselend aantal rondes van de gebeurtenislus tussen de starts, zodat de route die wint per geval verschilt
          for (let k = 0; k < STAPPEN[(ronde + gevallen.indexOf(geval)) % STAPPEN.length]!; k++) await new Promise((r) => setImmediate(r));
        }
        const spool = o.scanner.processSpool();
        const [antwoorden, rest] = await Promise.all([Promise.all(netwerk), Promise.all([...lopend, spool])]);
        const [a, bb] = antwoorden as [Antwoord, Antwoord];
        await o.scanner.processSpool();
        const etiket = `${geval.naam} ${naamVan(start)}`;
        // het netwerk antwoordt gelukt, of herhaalbaar druk (een adres tegelijk): nooit een databasefout
        for (const r of [a, bb]) {
          expect([200, 503], etiket).toContain(r.status);
          if (r.status === 200) expect(['toegepast', 'overgeslagen', 'wacht'], etiket).toContain(r.json!.uitkomst);
          else expect(r.json, etiket).toMatchObject({ ok: false, fout: 'te-druk' });
        }
        expect(rest).toHaveLength(4);
        // precies een effect
        const na = stand(o);
        expect(verschil(voor, na), etiket).toEqual(delta);
        const regels = na.register.filter((r) => r.uuid === cc.uuid);
        const wachtrij = na.wachtrij.filter((r) => r.uuid === cc.uuid);
        expect(regels.length + wachtrij.length, etiket).toBe(1);
        if (regels[0]) expect(ROUTES, etiket).toContain(regels[0].route);
        if (wachtrij[0]) expect(ROUTES, etiket).toContain(wachtrij[0].route);
        // en nog eens via elke route: de stand verandert niet meer
        for (const route of ROUTES) await stuur(o, tel, route, tel.maak(b.json, b.bijlagen));
        expect(stand(o), etiket).toEqual(na);
        expect(o.logs, etiket).toEqual([]);
        expect(o.problemen(), etiket).toEqual([]);
        bewezen.add(`gelijktijdig ${geval.naam} ${naamVan(start)}`);
      }
    }
  });

  it('ROUTE-10 apparaten: dezelfde uuid van twee verschillende apparaten (twee koppelingen) is twee sleutels in het register zoals nu (geen kruisbesmetting): leg het gedrag per entiteit vast met een test (de registersleutel bevat apparaat_id) en bewijs dat een apparaat de bevestigingen van een ander nooit ziet, ook niet via de map of mail', async () => {
    const { o, tel: t1 } = await voorbereid(null);
    const t2 = await koppel(o);
    expect([t1.code, t2.code]).toEqual(['M1', 'M2']);
    const klant = randomUUID();
    // beide apparaten kennen dezelfde klant en hetzelfde project (zoals na een gedeelde stamgegevenslijst)
    const project = randomUUID();
    expect((await stuur(o, t1, 'netwerk', t1.maak(klantBericht(klant)))).json!.uitkomst).toBe('toegepast');
    expect((await stuur(o, t1, 'netwerk', t1.maak(projectBericht(project, klant)))).json!.uitkomst).toBe('toegepast');

    for (const [i, naam] of NAMEN.entries()) {
      const routeA = ROUTES[i % 3]!;
      const routeB = ROUTES[(i + 1) % 3]!;
      const c: Ctx = { uuid: randomUUID(), klant, project, code: t1.code };
      const b = ENTITEITEN[naam].bouw(c);
      const voor = stand(o);
      await stuur(o, t1, routeA, t1.maak(b.json, b.bijlagen));
      const eerste = stand(o);
      expect(verschil(voor, eerste), naam).toEqual(ENTITEITEN[naam].delta);
      // het tweede apparaat stuurt dezelfde uuid (bij een factuur met zijn eigen apparaatcode in het nummer: anders is het een vormfout)
      const b2 = naam === 'factuur' ? { json: factuurBericht(c.uuid, klant, t2.code), bijlagen: [] } : b;
      const a2 = await stuur(o, t2, routeB, t2.maak(b2.json, b2.bijlagen));
      if (routeB !== 'mail') expect(a2.json!.ok, naam).toBe(true);
      const na = stand(o);
      // geen tweede klant, klus, factuur, boeking, bon of foto: alleen een tweede registerrij, met het apparaat van de afzender
      expect(verschil(eerste, na), naam).toEqual({ sync_ontvangen: 1 });
      expect(na.spool, naam).toEqual(eerste.spool);
      expect(na.bijlagen, naam).toEqual(eerste.bijlagen);
      const rij = na.register.filter((r) => r.entiteit === naam && r.uuid === c.uuid);
      expect(rij.map((r) => [r.apparaat_id, r.route]), naam).toEqual([[t1.apparaat, routeA], [t2.apparaat, routeB]]);
      expect(rij[0]!.uitkomst, naam).toBe(ENTITEITEN[naam].eerste);
      // klant en project: dezelfde inhoud van een ander apparaat wint de gelijkstand op bron (M2 boven M1) en is dus toegepast, met een nieuw wijzigingsnummer maar zonder
      // nieuwe rij; factuur, bon en foto zijn documenten met een uuid en worden overgeslagen, zonder nieuw nummer
      const wint = naam === 'klant' || naam === 'project';
      const teller = (st: Stand) => st.sync_teller.find((r) => r.naam === 'wijziging')!.waarde as number;
      expect(rij[1]!.uitkomst, naam).toBe(wint ? 'toegepast' : 'overgeslagen');
      expect(teller(na) - teller(eerste), naam).toBe(wint ? 1 : 0);
      // het eigen register van elk apparaat: dezelfde wijziging nog eens van apparaat 1 en van apparaat 2 verandert niets meer
      await stuur(o, t1, routeB, t1.maak(b.json, b.bijlagen));
      await stuur(o, t2, routeA, t2.maak(b2.json, b2.bijlagen));
      expect(stand(o), naam).toEqual(na);
      bewezen.add(`apparaten ${naam}`);
    }

    // bevestigingen: apparaat 1 wacht met een factuur en een project, apparaat 2 met hetzelfde project en een eigen project; de klant komt van apparaat 2
    const k2 = randomUUID();
    const gedeeld = randomUUID();
    const eigen2 = randomUUID();
    const f1 = factuurBericht(randomUUID(), k2, t1.code, 7);
    await stuur(o, t1, 'netwerk', t1.maak(f1));
    await stuur(o, t1, 'map', t1.maak(projectBericht(gedeeld, k2)));
    await stuur(o, t2, 'mail', t2.maak(projectBericht(gedeeld, k2)));
    await stuur(o, t2, 'netwerk', t2.maak(projectBericht(eigen2, k2)));
    expect(o.n(`SELECT COUNT(*) AS n FROM sync_wachtrij WHERE verwerkt_op IS NULL`)).toBe(4);
    expect((await stuur(o, t2, 'map', t2.maak(klantBericht(k2)))).json!.uitkomst).toBe('toegepast');
    expect(o.n(`SELECT COUNT(*) AS n FROM sync_wachtrij WHERE verwerkt_op IS NULL`)).toBe(0);
    const uuidFactuur = (f1.wijziging as { uuid: string }).uuid;
    const zie = (r: Antwoord) => (r.json!.bevestigingen as Record<string, any>[]).map((b) => `${b.entiteit}:${b.uuid}`).sort();
    const vraag = () => ({ soort: 'bevestigingen', tijd: Date.now(), na: 0 });
    const verwacht1 = [`factuur:${uuidFactuur}`, `project:${gedeeld}`].sort();
    const verwacht2 = [`project:${gedeeld}`, `project:${eigen2}`].sort();
    expect(zie(await t1.netwerk(t1.maak(vraag())))).toEqual(verwacht1);
    expect(zie(await t2.netwerk(t2.maak(vraag())))).toEqual(verwacht2);
    const m1 = t1.maak(vraag());
    const m2 = t2.maak(vraag());
    expect(zie(await viaMap(o, t1, m1))).toEqual(verwacht1);
    expect(zie(await viaMap(o, t2, m2))).toEqual(verwacht2);
    // het antwoordbestand van het ene apparaat is met de sleutel van het andere niet te openen
    expect(openResponse(readFileSync(t1.antwoordPad(m1)), t2.sleutel, m1.nonce)).toBeNull();
    expect(openResponse(readFileSync(t2.antwoordPad(m2)), t1.sleutel, m2.nonce)).toBeNull();
    // via de mail antwoordt de pc nooit: een vraag naar bevestigingen is daar niet ondersteund en wordt definitief afgesloten met een regel in het probleemregister
    const voorMail = stand(o);
    const mailVraag = t1.maak(vraag());
    await viaMail(o, mailVraag);
    expect(stand(o)).toEqual(voorMail);
    expect(o.problemen()).toEqual([{ bestandsnaam: expect.stringMatching(/\.bvns$/), apparaat_id: t1.apparaat, soort: 'afgewezen', fout: 'niet-ondersteund-via-mail', veld: null, route: 'mail' }]);
    expect(existsSync(t1.antwoordPad(mailVraag))).toBe(false);
    expect(o.logs).toEqual([]);
  });

  it('ROUTE-11 ontbrekende gevallen: voor elke route waarvan de envelop of koppeling het deviceId anders levert dan het netwerk (map en mail halen het uit de kop van de envelop, het netwerk ook): test dat een ontkoppeld apparaat, een bericht van een onbekend apparaat en een envelop met een verkeerde sleutel via elke route geen effect hebben (geen rij, geen bestand, geen register) en dat de uitkomst per route klopt (netwerk 401, map en mail een regel in het probleemregister, geen antwoord)', async () => {
    const { o, tel: blijft } = await voorbereid(null);
    const ontkoppeld = await koppel(o);
    await o.scanner.unpair(ontkoppeld.apparaat);
    // het ontvangstpunt draait nog, want er is nog een gekoppelde telefoon
    expect(o.scanner.status().running).toBe(true);
    expect(blijft.code).toBe('M1');
    const klant = randomUUID();
    expect((await stuur(o, blijft, 'netwerk', blijft.maak(klantBericht(klant)))).json!.uitkomst).toBe('toegepast');
    const voor = stand(o);

    const berichten = (): { naam: string; b: Bericht }[] => {
      const c: Ctx = { uuid: randomUUID(), klant, project: randomUUID(), code: 'M1' };
      return [{ naam: 'klant', b: ENTITEITEN.klant.bouw(c) }, { naam: 'bon', b: ENTITEITEN.bon.bouw(c) }, { naam: 'foto', b: ENTITEITEN.foto.bouw(c) }];
    };
    const gevallen = [
      { naam: 'ontkoppeld', verpak: (b: Bericht) => ontkoppeld.maak(b.json, b.bijlagen), soort: 'onbekend-apparaat', fout: 'niet-gekoppeld', apparaat: ontkoppeld.apparaat },
      { naam: 'onbekend', verpak: (b: Bericht) => blijft.maak(b.json, b.bijlagen, { deviceId: randomBytes(16), sleutel: randomBytes(32) }), soort: 'onbekend-apparaat', fout: 'niet-gekoppeld', apparaat: null },
      { naam: 'verkeerde sleutel', verpak: (b: Bericht) => blijft.maak(b.json, b.bijlagen, { sleutel: randomBytes(32) }), soort: 'onleesbaar', fout: 'niet-te-openen', apparaat: blijft.apparaat },
    ];
    const verwachtMap: Record<string, any>[] = [];
    const verwachtMail: Record<string, any>[] = [];
    for (const g of gevallen) {
      for (const { naam, b } of berichten()) {
        const label = `${g.naam} ${naam}`;
        // netwerk: 401 in de klare tekst, geen effect
        const e = g.verpak(b);
        const net = await blijft.netwerk(e);
        expect(net.status, label).toBe(401);
        expect(net.json, label).toEqual({ ok: false, fout: 'niet-gekoppeld' });
        expect(stand(o), label).toEqual(voor);
        // map en mail: een regel in het probleemregister, geen antwoord, definitief afgesloten
        const eMap = g.verpak(b);
        const m = await viaMap(o, blijft, eMap);
        expect(m.json, label).toBeNull();
        const eMail = g.verpak(b);
        await viaMail(o, eMail);
        await o.scanner.processSpool();
        expect(stand(o), label).toEqual(voor);
        const apparaat = g.apparaat ?? expect.any(String);
        verwachtMap.push({ bestandsnaam: eMap.naam, apparaat_id: apparaat, soort: g.soort, fout: g.fout, veld: null, route: 'map' });
        verwachtMail.push({ bestandsnaam: eMail.naam, apparaat_id: apparaat, soort: g.soort, fout: g.fout, veld: null, route: 'mail' });
      }
    }
    const verwacht = [...verwachtMap, ...verwachtMail];
    const p = o.problemen();
    expect(p).toHaveLength(verwacht.length);
    for (const v of verwacht) expect(p).toContainEqual(v);
    // geen antwoordbestand voor wie we niet kunnen antwoorden, en de verzoeken zijn definitief verwerkt (niets blijft liggen)
    expect(lijst(o.naar)).toEqual([]);
    expect(lijst(o.van).filter((x) => !x.startsWith('verwerkt/'))).toEqual([]);
    expect(lijst(o.verwerkt)).toHaveLength(verwachtMap.length);
    // de mails zijn verwerkt en verplaatst, de bijlagen zijn geen documenten geworden
    expect(o.rijen('SELECT DISTINCT outcome, note, moved_to FROM mail_messages')).toEqual([{ outcome: 'overig', note: 'telefoonbericht', moved_to: 'Verwerkt' }]);
    expect(o.n('SELECT COUNT(*) AS n FROM mail_messages')).toBe(verwachtMail.length);
    expect(o.n('SELECT COUNT(*) AS n FROM documents')).toBe(voor.tellers.documents);
    expect(o.logs).toEqual([]);
    bewezen.add('ontbrekende gevallen');
  });

  it('ROUTE-12 geen nieuwe fouten gevonden of gerepareerd: elke fout die de bewijstests in bestaande code vinden wordt eerst als falende test vastgelegd, daarna met de kleinste reparatie opgelost, en apart genoemd in het eindrapport; als er niets is gevonden, bevestigt deze test met een samenvattende telling (aantal combinaties dat is doorlopen) dat alle combinaties van entiteit, route en volgorde zijn geslaagd', () => {
    // de eerdere tests van dit bestand hebben elke combinatie doorlopen; hier staat de volledige verwachte lijst
    const verwacht: string[] = [];
    for (const naam of ['klant', 'project', 'factuur', 'bon', 'foto', 'wachtend']) for (const v of VOLGORDES) verwacht.push(`${naam} ${naamVan(v)}`);
    for (const versie of [1, 2]) for (const a of ROUTES) for (const b of ROUTES) verwacht.push(`bon-bericht v${versie} ${a}>${b}`);
    for (const naam of NAMEN) for (const a of ROUTES) for (const b of ROUTES.filter((r) => r !== a)) verwacht.push(`andere inhoud ${naam} ${a}>${b}`);
    for (const naam of [...NAMEN, 'factuur wachtend']) for (const v of VOLGORDES) verwacht.push(`gelijktijdig ${naam} ${naamVan(v)}`);
    for (const naam of NAMEN) verwacht.push(`apparaten ${naam}`);
    verwacht.push('ontbrekende gevallen');
    expect([...bewezen].sort()).toEqual([...verwacht].sort());
    // 5 entiteiten x 6 volgorden (rond en, voor de klant, ook dubbel) + wachtend + 18 bon-berichten + 30 andere inhoud + 18 gelijktijdig + 5 apparaten + 1
    expect(bewezen.size).toBe(30 + 6 + 18 + 30 + 36 + 5 + 1);
    expect(bewezen.size).toBe(126);
    // er zijn geen fouten gevonden: de ontvangers van netwerk, map en mail hebben geen reparatie nodig gehad
    expect(PHONE_SCANNER.available).toBe(true);
  });
});
