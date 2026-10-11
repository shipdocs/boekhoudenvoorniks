import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeTotals, type LineInput } from '@gratis-boekhouden/kern';
import { setup } from './helpers';
import { makeJpeg } from './fixtures/jpeg';
import { protocolVoorbeeld } from './fixtures/protocol';
import { signLicense } from './license-token';
import type { LicenseStatus } from '../src/license/license';
import { eisTelefoonAbonnement, telefoonAbonnement, telefoonAbonnementMelding } from '../src/license/telefoon';
import { createApi, type HostContext } from '../src/main/api';
import type { MailAttachment, MailMessage, MailSource, PollResult } from '../src/mail/mail-intake';
import { CONTENT_TYPE, ENDPOINT_PATH, decodePairing, encodeFrame, openResponse, sealRequest, type ProtocolVersion } from '../src/scanner/protocol';
import { Bonnenscanner, type ScannerDeps } from '../src/scanner/scanner';
import { addDays, formatDateNl, today } from '../src/shared/dates';
import { PHONE_SCANNER } from '../src/shared/phone-scanner';
import { ValidationError } from '../src/shared/validation';
import { ReeksBewaking } from '../src/sync/reeks';

// De koppeling met de telefoon en het abonnement (src/license/telefoon.ts). Een nieuwe telefoon koppelen en gegevens naar de
// telefoon sturen (het bericht stamgegevens) vragen een toegestaan abonnement; ONTVANGEN vraagt het nooit: een bon (bericht en
// wijziging), een foto, een klant, een project en een factuur van een gekoppelde telefoon worden in elke staat van het abonnement
// en op elke route precies zo verwerkt, en het bericht bevestigingen blijft werken.
//
// Echte ontvangers, zoals in tests/sync-routes.test.ts: de ScannerReceiver op 127.0.0.1 met versleutelde HTTP-verzoeken, de
// MapRoute met een tijdelijke bonnenmap en de MailIntakeService met een nagebootste mailbox. Een echte LicenseService met een
// eigen testsleutel en echt ondertekende licenties; datums zijn relatief aan vandaag.

const LOOPBACK = [{ address: '127.0.0.1', netmask: '255.0.0.0' }];
const DAG = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const DATUM = iso(Date.now() - 10 * DAG);
const VANDAAG = today();
const GISTEREN = addDays(VANDAAG, -1);
const OVER_EEN_MAAND = addDays(VANDAAG, 30);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const fotoVelden = (fotos: Buffer[]) => fotos.map((f) => ({ grootte: f.length, sha256: sha(f) }));

type Staat = 'uit' | 'actief' | 'geen' | 'verlopen' | 'ongeldig';
const STATEN: Staat[] = ['uit', 'actief', 'geen', 'verlopen', 'ongeldig'];
const TOEGESTAAN: Record<Staat, boolean> = { uit: true, actief: true, geen: false, verlopen: false, ongeldig: false };
const NIET_TOEGESTAAN = STATEN.filter((s) => !TOEGESTAAN[s]);
const WEL_TOEGESTAAN = STATEN.filter((s) => TOEGESTAAN[s]);

type Route = 'netwerk' | 'map' | 'mail';
const ROUTES: Route[] = ['netwerk', 'map', 'mail'];

function sleutels() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' }) as { x: string; d: string };
  return { publicKey: jwk.x, privateJwk: JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: jwk.x, d: jwk.d }) };
}
/** de sleutel van de app in deze tests, en een vreemde sleutel voor een licentie waarvan de handtekening niet klopt */
const SLEUTEL = sleutels();
const VREEMD = sleutels();

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

function lijst(map: string): string[] {
  if (!existsSync(map)) return [];
  return readdirSync(map)
    .flatMap((naam) => {
      const pad = join(map, naam);
      return statSync(pad).isDirectory() ? lijst(pad).map((x) => `${naam}/${x}`) : [naam];
    })
    .sort();
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

// ---------- de opzet: een administratie met de drie echte ontvangers en een echte licentiedienst ----------

interface OpzetOpties {
  /** licenties uit: de app heeft geen sleutel om ze te controleren (zoals in tests en ontwikkelbuilds) */
  zonderSleutel?: boolean;
  /** een eigen licentiedienst voor de scanner (om te bewijzen wat hij wel en niet opvraagt) */
  license?: ScannerDeps['license'];
}

async function opzet(opties: OpzetOpties = {}) {
  const t = setup(opties.zonderSleutel ? {} : { licensePublicKey: SLEUTEL.publicKey });
  t.s.settings.update({ onboardingDone: true, mailIn: { enabled: true, host: 'imap.example.nl', port: 993, secure: true, user: 'administratie@piet.nl', folder: 'INBOX', extraFolders: [], processedFolder: 'Verwerkt', since: '' } });
  const data = tmp('bvn-abonnement-gegevens-');
  const adminDir = tmp('bvn-abonnement-admin-');
  const folder = tmp('bvn-abonnement-map-');
  const logs: string[] = [];
  /** de klok van de scanner loopt met de echte klok mee; een test kan hem vooruit zetten */
  const klok = { vooruit: 0 };
  const scanner = new Bonnenscanner({
    db: t.db,
    secrets: t.secrets,
    intake: t.s.intake,
    settings: t.s.settings,
    license: opties.license ?? t.s.license,
    invoices: t.s.invoices,
    spoolDir: join(data, 'bonnenscanner'),
    adminDir,
    protectedDirs: [data],
    interfaces: () => LOOPBACK,
    folderPollMs: 5,
    folderStableMs: 0,
    now: () => Date.now() + klok.vooruit,
    log: (m) => void logs.push(m),
  });
  open.push(scanner);
  t.s.mail.setTelefoonHandler(scanner.mailHandler());
  await scanner.setFolder(folder);
  const box = new FakeMailbox();
  let uid = 0;
  const rijen = (sql: string, ...p: unknown[]) => t.db.prepare(sql).all(...p) as Record<string, any>[];
  const n = (sql: string, ...p: unknown[]) => (t.db.prepare(sql).get(...p) as { n: number }).n;
  const licentie = (validUntil: string, privateJwk = SLEUTEL.privateJwk) =>
    signLicense({ v: 1, product: 'uitwisseling', administratie: t.s.settings.administrationId(), email: 'piet@example.nl', validUntil, issuedAt: VANDAAG }, privateJwk);
  const bewaar = (token: string) => t.db.prepare(`INSERT INTO settings (key, value) VALUES ('license', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(token));
  return {
    t,
    data,
    adminDir,
    folder,
    van: join(folder, 'van-telefoon'),
    verwerkt: join(folder, 'van-telefoon', 'verwerkt'),
    naar: join(folder, 'van-pc'),
    scanner,
    box,
    logs,
    klok,
    rijen,
    n,
    licentie,
    /** Zet het abonnement in een staat, zoals het in de administratie zou staan (uit kan alleen bij het opzetten: dan is er geen sleutel). */
    async zet(staat: Exclude<Staat, 'uit'>): Promise<void> {
      if (staat === 'actief') t.s.license.install(await licentie(OVER_EEN_MAAND), VANDAAG);
      else if (staat === 'verlopen') t.s.license.install(await licentie(GISTEREN), VANDAAG);
      else if (staat === 'geen') t.db.prepare(`DELETE FROM settings WHERE key = 'license'`).run();
      // een licentie met een handtekening van een andere sleutel: die neemt install() niet aan, dus rechtstreeks in de administratie
      else bewaar(await licentie(OVER_EEN_MAAND, VREEMD.privateJwk));
      expect(t.s.license.status(today()).state).toBe(staat);
    },
    zetInMailbox(bijlagen: MailAttachment[]): number {
      uid++;
      box.add('INBOX', { uid, attachments: bijlagen });
      return uid;
    },
    poll: (): Promise<PollResult> => t.s.mail.poll(box),
    problemen: () => rijen('SELECT soort, fout, veld, route FROM sync_map_problemen ORDER BY id'),
    apparaten: () => rijen('SELECT d.id, d.name, d.paired_at IS NOT NULL AS gekoppeld, d.expires_at, c.code, c.afgesloten_op FROM scanner_devices d LEFT JOIN scanner_device_codes c ON c.device_id = d.id ORDER BY d.rowid'),
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
async function koppel(o: Opz, naam = 'Pixel van Piet') {
  const gestart = await o.scanner.pair();
  const k = decodePairing(gestart.payload);
  const sleutel = Buffer.from(k.sleutel, 'base64url');
  const deviceId = Buffer.from(k.apparaat, 'base64url');
  const url = `http://${k.adressen[0]}:${k.poort}${ENDPOINT_PATH}`;
  const maak = (json: Record<string, unknown>, bijlagen: Buffer[] = [], versie: ProtocolVersion = 2): Env => {
    const nonce = randomBytes(12);
    return { nonce, naam: `${nonce.toString('hex')}.bvns`, body: sealRequest(deviceId, sleutel, encodeFrame(json, bijlagen), nonce, versie) };
  };
  const tel = {
    apparaat: k.apparaat,
    sleutel,
    code: '',
    maak,
    antwoordPad: (e: Env) => join(o.naar, `${e.nonce.toString('hex')}.antwoord.bvns`),
    /** een echt HTTP-verzoek; `versleuteld` zegt of het antwoord met de sleutel van de telefoon te openen was */
    async netwerk(e: Env): Promise<Antwoord & { versleuteld: boolean }> {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': CONTENT_TYPE }, body: new Uint8Array(e.body) });
      const bytes = Buffer.from(await res.arrayBuffer());
      const geopend = openResponse(bytes, sleutel, e.nonce) as Record<string, any> | null;
      return { status: res.status, versleuteld: geopend !== null, json: geopend ?? (JSON.parse(bytes.toString('utf8')) as Record<string, any>) };
    },
    hallo: (versie: ProtocolVersion = 2) => tel.netwerk(maak({ soort: 'hallo', tijd: Date.now() + o.klok.vooruit, naam, app: '1.0.0' }, [], versie)),
  };
  const hallo = await tel.hallo();
  expect(hallo.status).toBe(200);
  tel.code = String(hallo.json!.apparaatcode);
  return tel;
}
type Tel = Awaited<ReturnType<typeof koppel>>;

/**
 * Een administratie met een gekoppelde telefoon en het abonnement in de gevraagde staat. Koppelen vraagt zelf een toegestaan
 * abonnement, dus de telefoon wordt gekoppeld terwijl het abonnement actief is (of licenties uit staan) en daarna gaat het
 * abonnement naar de staat van de test: precies wat een gebruiker meemaakt van wie het abonnement afloopt.
 */
async function metTelefoon(staat: Staat, opties: OpzetOpties = {}) {
  const o = await opzet({ ...opties, zonderSleutel: staat === 'uit' });
  if (staat !== 'uit') await o.zet('actief');
  const tel = await koppel(o);
  if (staat !== 'uit' && staat !== 'actief') await o.zet(staat);
  expect(o.t.s.license.status(today()).state).toBe(staat);
  return { o, tel };
}

/** Ruimt een administratie direct op (niet pas in afterEach), zodat er nooit tientallen luisterende ontvangers tegelijk staan. */
async function ruim(o: Opz): Promise<void> {
  const i = open.indexOf(o.scanner);
  if (i >= 0) open.splice(i, 1);
  try {
    await o.scanner.stop();
  } finally {
    try {
      o.t.db.close();
    } catch {
      /* al dicht */
    }
    for (const d of [o.data, o.adminDir, o.folder]) rmSync(d, { recursive: true, force: true });
  }
}

/** Legt de bytes als bestand in van-telefoon/ en draait de rondgang tot het bestand is afgehandeld; geeft het antwoord uit van-pc/. */
async function viaMap(o: Opz, tel: Tel, e: Env): Promise<Antwoord> {
  mkdirSync(o.van, { recursive: true });
  const pad = join(o.van, e.naam);
  const voor = lijst(o.verwerkt).length;
  writeFileSync(`${pad}.tmp`, e.body);
  renameSync(`${pad}.tmp`, pad);
  await wacht(async () => {
    await o.scanner.scanMap();
    return !existsSync(pad);
  });
  expect(lijst(o.verwerkt), `de map heeft ${e.naam} afgehandeld`).toHaveLength(voor + 1);
  const a = tel.antwoordPad(e);
  expect(existsSync(a), `de map heeft ${e.naam} beantwoord`).toBe(true);
  const json = openResponse(readFileSync(a), tel.sleutel, e.nonce) as Record<string, any> | null;
  expect(json, 'het antwoord opent met de sleutel van de telefoon').not.toBeNull();
  return { json };
}

/** Een mail met de envelop als .bvns-bijlage en een ophaalronde van de echte mailimport; de pc antwoordt nooit per mail. */
async function viaMail(o: Opz, e: Env): Promise<Antwoord> {
  const mailsVoor = o.n('SELECT COUNT(*) AS n FROM mail_messages');
  o.zetInMailbox([att(e.naam, e.body)]);
  const r = await o.poll();
  expect(r.errors).toBe(0);
  expect(o.n('SELECT COUNT(*) AS n FROM mail_messages'), `de mailroute heeft ${e.naam} vastgelegd`).toBe(mailsVoor + 1);
  expect(o.rijen('SELECT outcome, note, moved_to FROM mail_messages ORDER BY rowid DESC LIMIT 1')).toEqual([{ outcome: 'overig', note: 'telefoonbericht', moved_to: 'Verwerkt' }]);
  return { json: null };
}

async function stuur(o: Opz, tel: Tel, route: Route, e: Env): Promise<Antwoord> {
  let a: Antwoord;
  if (route === 'netwerk') {
    const r = await tel.netwerk(e);
    a = { status: r.status, json: r.json };
  } else a = route === 'map' ? await viaMap(o, tel, e) : await viaMail(o, e);
  // een nieuwe bon gaat naar de inbox: wacht tot dat klaar is, zodat de stand volledig is
  await o.scanner.processSpool();
  return a;
}

// ---------- de berichten ----------

const wijziging = (entiteit: string, uuid: string, velden: Record<string, unknown>, revisie = 1) => ({
  soort: 'wijziging',
  tijd: Date.now(),
  wijziging: { entiteit, uuid, revisie, tijd: Date.now() - 2 * DAG, velden },
});
const klantBericht = (uuid: string, naam: string) => wijziging('klant', uuid, { naam });
const projectBericht = (uuid: string, klant: string, titel: string) => wijziging('project', uuid, { titel, klant });
function factuurBericht(uuid: string, klantUuid: string, code: string, volgnr: number) {
  const regel = { omschrijving: 'Montage', hoeveelheid: 2, prijs: 4550, btw_soort: 'hoog', eenheid: 'uur' };
  const totalen = computeTotals([{ description: regel.omschrijving, quantity: regel.hoeveelheid, unitPrice: regel.prijs, vatCode: 'hoog' } as LineInput]);
  return wijziging('factuur', uuid, {
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
  });
}
const bonBericht = (uuid: string, fotos: Buffer[]) => wijziging('bon', uuid, { betaalwijze: 'contant', notitie: 'Schroeven voor de klus', fotos: fotoVelden(fotos) });
const fotoBericht = (uuid: string, project: string, fotos: Buffer[]) => wijziging('foto', uuid, { project_uuid: project, notitie: 'Voor het schilderen', fotos: fotoVelden(fotos) });
/** het bon-bericht van versie 1 (geen wijziging): zelfde spool, geen register */
const oudBonBericht = (id: string, fotos: Buffer[]) => ({ soort: 'bon', tijd: Date.now(), id, betaalwijze: 'contant', notitie: 'Tegellijm', fotos: fotos.map((f) => ({ grootte: f.length })) });
const stamgegevens = (o: Opz, over: Record<string, unknown> = {}) => ({ soort: 'stamgegevens', tijd: Date.now() + o.klok.vooruit, ...over });
const bevestigingen = () => ({ soort: 'bevestigingen', tijd: Date.now(), na: 0 });

// vaste uuid's: elke staat krijgt een eigen administratie, dus dezelfde uuid's maken de uitkomsten letterlijk vergelijkbaar
const U = {
  bonOud: '10000000-0000-4000-8000-000000000001',
  bon: '10000000-0000-4000-8000-000000000002',
  klant: '10000000-0000-4000-8000-000000000003',
  project: '10000000-0000-4000-8000-000000000004',
  foto: '10000000-0000-4000-8000-000000000005',
  factuur1: '10000000-0000-4000-8000-000000000006',
  factuur3: '10000000-0000-4000-8000-000000000007',
  klantLater: '10000000-0000-4000-8000-000000000008',
  factuurWacht: '10000000-0000-4000-8000-000000000009',
  projectWacht: '10000000-0000-4000-8000-00000000000a',
  fotoWacht: '10000000-0000-4000-8000-00000000000b',
};
const FOTOS = [makeJpeg('abonnement een'), makeJpeg('abonnement twee')];
const FOTOS_WACHT = [makeJpeg('abonnement drie')];

// ---------- wat er na het ontvangen in de administratie staat ----------

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

/** Alles waaraan te zien zou zijn dat ontvangen anders liep: tellingen, register, wachtrij, facturen, reeksbewaking en de bestanden. Zonder apparaat-ID en tijden: die verschillen per administratie. */
function stand(o: Opz) {
  return {
    tellers: Object.fromEntries(Object.entries(TELLERS).map(([k, sql]) => [k, o.n(sql)])),
    sync_teller: o.rijen('SELECT naam, waarde FROM sync_teller ORDER BY naam'),
    register: o.rijen('SELECT entiteit, uuid, revisie, uitkomst, fout, route FROM sync_ontvangen ORDER BY rowid'),
    wachtrij: o.rijen('SELECT entiteit, uuid, revisie, route, nummer, wacht_op_entiteit, wacht_op_uuid, verwerkt_op IS NOT NULL AS klaar, verwerkt_uitkomst, verwerkt_reden, verwerkt_seq FROM sync_wachtrij ORDER BY id'),
    klanten: o.rijen('SELECT uuid, name FROM relations WHERE uuid IN (?, ?) ORDER BY uuid', U.klant, U.klantLater),
    projecten: o.rijen('SELECT j.uuid, j.title, r.uuid AS klant FROM jobs j JOIN relations r ON r.id = j.relation_id WHERE j.uuid IN (?, ?) ORDER BY j.uuid', U.project, U.projectWacht),
    facturen: o.rijen('SELECT uuid, number, apparaat_code, reeks_jaar, reeks_volgnr, total, job_id IS NOT NULL AS met_project FROM invoices WHERE uuid IS NOT NULL ORDER BY reeks_volgnr'),
    gaten: new ReeksBewaking(o.t.db).gaten().map((g) => ({ apparaat_code: g.apparaat_code, reeks_jaar: g.reeks_jaar, van: g.van, tot: g.tot })),
    reeksmeldingen: o.t.s.inbox.tasks().filter((t) => t.kind === 'invoice-series-gap').map((t) => ({ key: t.key, title: t.title, question: t.question })),
    problemen: o.problemen(),
    spool: lijst(join(o.data, 'bonnenscanner')).length,
    bijlagen: lijst(join(o.adminDir, 'bijlagen')).length,
  };
}

/** De bevestigingen zoals de telefoon ze krijgt, zonder de klok van de pc. */
const zonderKlok = (json: Record<string, any> | null) => {
  if (!json) return json;
  const { pcTijd: _pcTijd, ...rest } = json;
  return rest;
};

/**
 * Het hele ontvangen langs een route, op een eigen administratie in de gevraagde staat: het bon-bericht, een bon als wijziging,
 * een klant, een project, een foto, twee facturen met een gat ertussen (reeksbewaking), een factuur, een project en een foto die
 * eerst wachten (wachtrij) en daarna vanzelf worden toegepast, een herhaling, en de bevestigingen via het netwerk en via de map.
 */
async function ontvangAlles(route: Route, staat: Staat) {
  const { o, tel } = await metTelefoon(staat);
  try {
    const antwoorden: { stap: string; antwoord: Antwoord }[] = [];
    const stap = async (naam: string, json: Record<string, unknown>, bijlagen: Buffer[] = []) => void antwoorden.push({ stap: naam, antwoord: await stuur(o, tel, route, tel.maak(json, bijlagen)) });
    const bonFoto = [makeJpeg('abonnement bon')];
    const oudeBonFoto = [makeJpeg('abonnement bon-bericht')];
    await stap('bon-bericht', oudBonBericht(U.bonOud, oudeBonFoto), oudeBonFoto);
    await stap('bon', bonBericht(U.bon, bonFoto), bonFoto);
    await stap('klant', klantBericht(U.klant, 'Familie Bakker'));
    await stap('project', projectBericht(U.project, U.klant, 'Schilderwerk'));
    await stap('foto', fotoBericht(U.foto, U.project, FOTOS), FOTOS);
    await stap('factuur 1', factuurBericht(U.factuur1, U.klant, tel.code, 1));
    await stap('factuur 3', factuurBericht(U.factuur3, U.klant, tel.code, 3));
    // de klant is nog niet bekend: de factuur, het project en de foto wachten
    await stap('factuur wacht', factuurBericht(U.factuurWacht, U.klantLater, tel.code, 4));
    await stap('project wacht', projectBericht(U.projectWacht, U.klantLater, 'Badkamer'));
    await stap('foto wacht', fotoBericht(U.fotoWacht, U.projectWacht, FOTOS_WACHT), FOTOS_WACHT);
    const tussenstand = { wachtend: o.n('SELECT COUNT(*) AS n FROM sync_wachtrij WHERE verwerkt_op IS NULL') };
    // de klant komt: wat wachtte wordt in dezelfde beweging toegepast
    await stap('klant later', klantBericht(U.klantLater, 'Familie De Wit'));
    await stap('klant nog eens', klantBericht(U.klant, 'Familie Bakker'));
    // de bevestigingen: altijd, via het netwerk en via de map (over de e-mail antwoordt de pc nooit)
    const bevNetwerk = await tel.netwerk(tel.maak(bevestigingen()));
    const bevMap = await viaMap(o, tel, tel.maak(bevestigingen()));
    return {
      antwoorden,
      tussenstand,
      bevestigingen: { netwerk: { status: bevNetwerk.status, versleuteld: bevNetwerk.versleuteld, json: zonderKlok(bevNetwerk.json) }, map: zonderKlok(bevMap.json) },
      stand: stand(o),
      // er is niets ontkoppeld, afgesloten of weggegooid, en de pc luistert nog
      apparaten: o.apparaten().map((a) => ({ gekoppeld: a.gekoppeld, code: a.code, afgesloten_op: a.afgesloten_op })),
      luistert: o.scanner.status().running,
      logs: o.logs,
    };
  } finally {
    await ruim(o);
  }
}
type Ontvangen = Awaited<ReturnType<typeof ontvangAlles>>;

/** De uitkomst met een actief abonnement, per route één keer gedraaid: daarmee wordt elke andere staat vergeleken. */
const metAbonnement = new Map<Route, Promise<Ontvangen>>();
function referentie(route: Route): Promise<Ontvangen> {
  let r = metAbonnement.get(route);
  if (!r) {
    r = ontvangAlles(route, 'actief');
    metAbonnement.set(route, r);
  }
  return r;
}

/** Een momentopname van de hele databank, behalve de twee tabellen die een geldig bericht altijd bijwerkt (laatst gezien en de nonce). */
function databank(o: Opz): Record<string, unknown[]> {
  const tabellen = (o.rijen(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`) as { name: string }[]).map((r) => r.name);
  return Object.fromEntries(tabellen.filter((naam) => naam !== 'scanner_devices' && naam !== 'scanner_nonces').map((naam) => [naam, o.rijen(`SELECT * FROM "${naam}"`)]));
}

/** Houdt bij welke SQL er tijdens `werk` wordt voorbereid op de databank van de administratie. */
async function sqlTijdens(o: Opz, werk: () => Promise<void>): Promise<string[]> {
  const db = o.t.db as unknown as { prepare: (sql: string) => unknown };
  const echt = db.prepare;
  const gezien: string[] = [];
  db.prepare = function (this: unknown, sql: string) {
    gezien.push(sql.replace(/\s+/g, ' ').trim());
    return echt.call(this, sql);
  };
  try {
    await werk();
  } finally {
    db.prepare = echt;
  }
  return gezien;
}
const schrijft = (sql: string) => /^(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i.test(sql);
/** de tabellen waaruit de klanten, projecten, aliassen en verbergmeldingen van de stamgegevens komen */
const STAMTABELLEN = /\b(relations|relation_field_rev|relation_aliases|relation_changelog|jobs|job_field_rev|vies_checks|sync_teller)\b/;
/** het blok bedrijf leest de instellingen als geheel; de licentie staat in een eigen rij en wordt apart gelezen */
const ALLE_INSTELLINGEN = /SELECT key, value FROM settings/;

// ====================================================================================================================

describe('telefoon en abonnement: de regel staat op een plek', () => {
  it('ABO-01 toegestaan bij actief en bij uit (licenties staan uit zonder sleutel); niet toegestaan bij geen, verlopen en ongeldig', () => {
    const staten: Record<Staat, LicenseStatus> = {
      uit: { state: 'uit' },
      actief: { state: 'actief', validUntil: OVER_EEN_MAAND, email: 'piet@example.nl', cancelled: false },
      geen: { state: 'geen' },
      verlopen: { state: 'verlopen', validUntil: GISTEREN, email: 'piet@example.nl' },
      ongeldig: { state: 'ongeldig', reason: 'De handtekening van deze licentie klopt niet' },
    };
    for (const staat of STATEN) expect(telefoonAbonnement(staten[staat]).toegestaan, staat).toBe(TOEGESTAAN[staat]);
    // een opgezegd abonnement loopt tot het eind van de betaalde periode en is tot dan gewoon actief
    expect(telefoonAbonnement({ state: 'actief', validUntil: VANDAAG, email: 'piet@example.nl', cancelled: true })).toEqual({ toegestaan: true, verlopenOp: null });
    expect(telefoonAbonnement(staten.verlopen)).toEqual({ toegestaan: false, verlopenOp: GISTEREN });
    expect(telefoonAbonnement(staten.geen)).toEqual({ toegestaan: false, verlopenOp: null });
    expect(telefoonAbonnement(staten.ongeldig)).toEqual({ toegestaan: false, verlopenOp: null });
  });

  it('ABO-02 de melding zegt wat bij het abonnement hoort, dat ontvangen altijd blijft werken, en bij verlopen de datum', () => {
    expect(telefoonAbonnementMelding({ toegestaan: true, verlopenOp: null })).toBeNull();
    expect(() => eisTelefoonAbonnement({ toegestaan: true, verlopenOp: null })).not.toThrow();
    const geen = telefoonAbonnementMelding({ toegestaan: false, verlopenOp: null })!;
    expect(geen).toMatch(/Een telefoon koppelen en het bijwerken van klanten, projecten en btw-regels op je telefoon horen bij het abonnement/);
    expect(geen).toMatch(/Wat een gekoppelde telefoon stuurt, komt altijd aan\./);
    const verlopen = telefoonAbonnementMelding({ toegestaan: false, verlopenOp: GISTEREN })!;
    expect(verlopen).toContain(`Je abonnement liep tot ${formatDateNl(GISTEREN)}.`);
    expect(verlopen).toMatch(/Wat een gekoppelde telefoon stuurt, komt altijd aan\./);
    // een weigering is een melding voor de gebruiker, geen programmafout
    expect(() => eisTelefoonAbonnement({ toegestaan: false, verlopenOp: null })).toThrow(ValidationError);
  });

  it('ABO-03 de scanner leest de staat van het abonnement uit de licentiedienst van de administratie (status), en zonder die dienst gelden licenties als uit', async () => {
    for (const staat of STATEN) {
      const o = await opzet({ zonderSleutel: staat === 'uit' });
      try {
        if (staat !== 'uit') await o.zet(staat);
        expect(o.scanner.abonnement(), staat).toEqual({ toegestaan: TOEGESTAAN[staat], verlopenOp: staat === 'verlopen' ? GISTEREN : null });
        expect(o.scanner.status().abonnement, staat).toEqual(o.scanner.abonnement());
      } finally {
        await ruim(o);
      }
    }
    const t = setup({ licensePublicKey: SLEUTEL.publicKey });
    const zonder = new Bonnenscanner({ db: t.db, secrets: t.secrets, intake: t.s.intake, settings: t.s.settings, spoolDir: tmp('bvn-abonnement-zonder-'), interfaces: () => LOOPBACK });
    open.push(zonder);
    expect(zonder.abonnement()).toEqual({ toegestaan: true, verlopenOp: null });
  });
});

describe('telefoon en abonnement: de app geeft de licentie door', () => {
  // Zonder licentiedienst gelden licenties voor de scanner als uit (ABO-03). De plekken die een echte scanner maken moeten haar
  // dus meegeven; het hoofdproces van de app is niet in een test te starten, daarom hier aan de bron.
  it.each([
    ['src/main/main.ts', 'services'],
    ['e2e/server.cjs', 'services'],
  ])('ABO-22 abonnement: %s maakt de scanner met de licentiedienst van de administratie', (bestand, diensten) => {
    // op Windows kan het bestand met \r\n uitgecheckt zijn
    const bron = readFileSync(join(__dirname, '..', bestand), 'utf8').replace(/\r\n/g, '\n');
    const begin = bron.indexOf('new Bonnenscanner({');
    expect(begin).toBeGreaterThan(-1);
    expect(bron.indexOf('new Bonnenscanner({', begin + 1), 'precies een scanner').toBe(-1);
    const opties = bron.slice(begin, bron.indexOf('\n  });', begin));
    expect(opties).toMatch(new RegExp(`^\\s*license: ${diensten}\\.license,$`, 'm'));
  });
});

describe('telefoon en abonnement: een nieuwe koppeling', () => {
  it.each(NIET_TOEGESTAAN)('ABO-04 abonnement %s: Telefoon koppelen wordt geweigerd met de melding; er komt geen sleutel, geen telefoon in de lijst en er gaat niets luisteren', async (staat) => {
    const o = await opzet();
    try {
      await o.zet(staat as Exclude<Staat, 'uit'>);
      // elke sleutel die in de geheimenopslag zou komen
      const bewaard: string[] = [];
      const echtBewaren = o.t.secrets.set.bind(o.t.secrets);
      o.t.secrets.set = (naam: string, waarde: string) => {
        bewaard.push(naam);
        echtBewaren(naam, waarde);
      };
      const poging = o.scanner.pair();
      await expect(poging).rejects.toThrow(ValidationError);
      await expect(poging).rejects.toThrow(staat === 'verlopen' ? `Je abonnement liep tot ${formatDateNl(GISTEREN)}.` : 'horen bij het abonnement');
      await expect(poging).rejects.toThrow('Wat een gekoppelde telefoon stuurt, komt altijd aan.');
      expect(o.apparaten()).toEqual([]);
      expect(o.n('SELECT COUNT(*) AS n FROM scanner_device_codes')).toBe(0);
      expect(bewaard).toEqual([]);
      expect(o.scanner.status()).toMatchObject({ running: false, port: null, devices: [] });
    } finally {
      await ruim(o);
    }
  });

  it.each(WEL_TOEGESTAAN)('ABO-05 abonnement %s: koppelen werkt zoals altijd', async (staat) => {
    const { o, tel } = await metTelefoon(staat);
    try {
      expect(tel.code).toBe('M1');
      expect(o.scanner.status()).toMatchObject({ running: true, devices: [{ name: 'Pixel van Piet', pending: false, code: 'M1', usable: true }] });
    } finally {
      await ruim(o);
    }
  });

  it.each(NIET_TOEGESTAAN)('ABO-06 abonnement %s na het koppelen: de koppeling blijft bestaan (niets ontkoppeld, de apparaatcode niet afgesloten, de sleutel niet weggegooid, de pc blijft luisteren) en ontkoppelen kan altijd', async (staat) => {
    const o = await opzet();
    try {
      await o.zet('actief');
      const tel = await koppel(o);
      const voor = o.apparaten();
      expect(voor).toEqual([{ id: tel.apparaat, name: 'Pixel van Piet', gekoppeld: 1, expires_at: null, code: 'M1', afgesloten_op: null }]);
      await o.zet(staat as Exclude<Staat, 'uit'>);
      // ook na de rondgang die het ontvangstpunt bijwerkt
      await o.scanner.refresh();
      expect(o.apparaten()).toEqual(voor);
      expect(o.scanner.pairing.key(tel.apparaat)?.equals(tel.sleutel)).toBe(true);
      expect(o.scanner.status()).toMatchObject({ running: true, devices: [{ id: tel.apparaat, pending: false, usable: true, code: 'M1' }] });
      // de telefoon kan zich gewoon blijven melden
      expect((await tel.hallo()).status).toBe(200);
      // een tweede telefoon koppelen kan nu niet, en dat raakt de eerste niet
      await expect(o.scanner.pair()).rejects.toThrow(ValidationError);
      expect(o.apparaten()).toEqual(voor);
      // ontkoppelen kan altijd: de sleutel wordt ingetrokken en de code afgesloten, zoals met abonnement
      await o.scanner.unpair(tel.apparaat);
      expect(o.rijen('SELECT id FROM scanner_devices')).toEqual([]);
      expect(o.rijen('SELECT code, afgesloten_op IS NOT NULL AS afgesloten FROM scanner_device_codes')).toEqual([{ code: 'M1', afgesloten: 1 }]);
      expect(o.scanner.pairing.key(tel.apparaat)).toBeNull();
      // het was de enige telefoon: er luistert niets meer
      expect(o.scanner.status().running).toBe(false);
      await expect(tel.hallo()).rejects.toThrow();
    } finally {
      await ruim(o);
    }
  });

  it('ABO-07 een QR-code die openstond toen het abonnement afliep blijft tot zijn eigen einde geldig, en sluiten kan altijd', async () => {
    const o = await opzet();
    try {
      await o.zet('actief');
      const gestart = await o.scanner.pair();
      await o.zet('verlopen');
      expect(o.scanner.status().devices).toMatchObject([{ id: gestart.deviceId, pending: true }]);
      // sluiten zonder scannen trekt de sleutel in, met of zonder abonnement
      await o.scanner.cancelPairing(gestart.deviceId);
      expect(o.apparaten()).toEqual([]);
      expect(o.scanner.status().running).toBe(false);
    } finally {
      await ruim(o);
    }
  });

  it('ABO-08 de stap voor het koppelen (checkSubscription) haalt de licentie op en start niets; koppelen zelf haalt nooit iets op en weigert zonder abonnement', async () => {
    const o = await opzet();
    try {
      let geleverd: string | null = null;
      let offline = false;
      const opgehaald: string[] = [];
      const api = createApi(o.t.s, {
        scanner: { service: () => o.scanner, pickFolder: async () => null },
        licenseApi: {
          price: async () => null,
          fetch: async (administratie: string) => {
            opgehaald.push(administratie);
            if (offline) throw new Error('geen verbinding');
            return geleverd;
          },
          start: async () => ({}),
          cancel: async () => ({}),
        },
      } as unknown as HostContext);
      const id = o.t.s.settings.administrationId();
      const niets = () => {
        expect(o.apparaten()).toEqual([]);
        expect(o.scanner.status()).toMatchObject({ running: false, port: null, devices: [] });
      };

      // koppelen zonder abonnement: geweigerd, en er gaat niets naar de licentieserver
      await expect(api.scanner.pair()).rejects.toThrow('horen bij het abonnement');
      expect(opgehaald).toEqual([]);
      niets();
      // de stap ervoor haalt de licentie op; de licentieserver kent er geen: niet toegestaan, niets gestart
      expect(await api.scanner.checkSubscription()).toEqual({ toegestaan: false, verlopenOp: null });
      expect(opgehaald).toEqual([id]);
      niets();
      // verlopen en geen verbinding: de stand met de datum, geen andere fout
      await o.zet('verlopen');
      offline = true;
      expect(await api.scanner.checkSubscription()).toEqual({ toegestaan: false, verlopenOp: GISTEREN });
      expect(opgehaald).toEqual([id, id]);
      await expect(api.scanner.pair()).rejects.toThrow(`Je abonnement liep tot ${formatDateNl(GISTEREN)}.`);
      niets();
      // in de demo weigert de scanner toch al: dan gaat er niets naar de licentieserver
      o.t.s.settings.update({ demoMode: true });
      expect((await api.scanner.checkSubscription()).toegestaan).toBe(false);
      await expect(api.scanner.pair()).rejects.toThrow(/In de demo/);
      o.t.s.settings.update({ demoMode: false });
      expect(opgehaald).toHaveLength(2);
      // net verlengd: de stap haalt de licentie op en zegt dat het mag, maar start zelf niets (geen sleutel, geen QR-code, er luistert niets)
      offline = false;
      geleverd = await o.licentie(OVER_EEN_MAAND);
      expect(await api.scanner.checkSubscription()).toEqual({ toegestaan: true, verlopenOp: null });
      expect(opgehaald).toHaveLength(3);
      expect(o.t.s.license.status(today()).state).toBe('actief');
      niets();
      // pas het koppelen zelf start het ontvangstpunt
      const p = await api.scanner.pair();
      expect(p.svg).toContain('<svg');
      expect(o.scanner.status()).toMatchObject({ running: true, devices: [{ id: p.deviceId, pending: true }] });
      await api.scanner.cancelPairing(p.deviceId);
      // met een actief abonnement wordt er niets opgehaald, ook niet door de stap ervoor
      expect((await api.scanner.checkSubscription()).toegestaan).toBe(true);
      const q = await api.scanner.pair();
      expect(opgehaald).toHaveLength(3);
      await api.scanner.cancelPairing(q.deviceId);
      // zolang telefoon koppelen uit staat bestaat de stap niet
      PHONE_SCANNER.available = false;
      await expect(api.scanner.checkSubscription()).rejects.toThrow(/kan nog niet/);
      expect(opgehaald).toHaveLength(3);
      PHONE_SCANNER.available = true;
    } finally {
      await ruim(o);
    }
  });
});

describe('telefoon en abonnement: het hallo-antwoord', () => {
  it.each(STATEN)('ABO-09 abonnement %s: een hallo van versie 2 wordt altijd beantwoord en zegt in het veld abonnement of de telefoon de stamgegevens mag ophalen (netwerk en bonnenmap)', async (staat) => {
    const { o, tel } = await metTelefoon(staat);
    try {
      const r = await tel.hallo(2);
      expect(r).toMatchObject({ status: 200, versleuteld: true });
      expect(r.json).toMatchObject({ ok: true, soort: 'hallo', apparaatcode: 'M1', abonnement: TOEGESTAAN[staat] });
      expect(typeof r.json!.abonnement).toBe('boolean');
      expect(Object.keys(r.json!)).toEqual(['ok', 'soort', 'pc', 'pcTijd', 'limieten', 'regels', 'protocollen', 'apparaatcode', 'abonnement']);
      const viaDeMap = await viaMap(o, tel, tel.maak({ soort: 'hallo', tijd: Date.now(), naam: 'Pixel van Piet', app: '1.0.0' }));
      expect(viaDeMap.json).toMatchObject({ ok: true, soort: 'hallo', apparaatcode: 'M1', abonnement: TOEGESTAAN[staat] });
      expect(Object.keys(viaDeMap.json!)).toEqual(Object.keys(r.json!));
      expect(o.problemen()).toEqual([]);
    } finally {
      await ruim(o);
    }
  });

  it.each(STATEN)('ABO-10 abonnement %s: een hallo van versie 1 krijgt byte voor byte het antwoord van altijd, zonder het veld', async (staat) => {
    const { o, tel } = await metTelefoon(staat);
    try {
      const r = await tel.hallo(1);
      expect(r).toMatchObject({ status: 200, versleuteld: true });
      // het voorbeeld van versie 1 uit de testgegevens, met het pc-ID en de klok van deze pc: dezelfde tekst, teken voor teken
      const voorbeeld = protocolVoorbeeld('versie-1', 'hallo-antwoord');
      const verwacht = voorbeeld.replace('"pc":"oKGio6SlpqeoqaqrrK2urw"', `"pc":"${o.scanner.pairing.pcId()}"`).replace('"pcTijd":1790848800123', `"pcTijd":${r.json!.pcTijd}`);
      expect(verwacht).not.toBe(voorbeeld);
      expect(JSON.stringify(r.json)).toBe(verwacht);
      expect(JSON.stringify(r.json)).not.toContain('abonnement');
    } finally {
      await ruim(o);
    }
  });
});

describe('telefoon en abonnement: het bericht stamgegevens', () => {
  it.each(NIET_TOEGESTAAN)('ABO-11 abonnement %s via het netwerk: versleuteld 403 geen-abonnement, er wordt niets uit de administratie gelezen of gestuurd en niets geschreven behalve laatst gezien', async (staat) => {
    const { o, tel } = await metTelefoon(staat);
    try {
      const voor = databank(o);
      const gezienVoor = o.rijen('SELECT id, name, paired_at, expires_at, last_seen_at FROM scanner_devices');
      o.klok.vooruit = 2_000;
      let r!: Awaited<ReturnType<Tel['netwerk']>>;
      const sql = await sqlTijdens(o, async () => {
        r = await tel.netwerk(tel.maak(stamgegevens(o)));
      });
      expect(r).toEqual({ status: 403, versleuteld: true, json: { ok: false, fout: 'geen-abonnement' } });
      // niets gelezen uit de tabellen van klanten, projecten, aliassen en de controles van btw-nummers, en ook de instellingen
      // (waar het blok bedrijf uit komt) niet
      expect(sql.filter((s) => STAMTABELLEN.test(s) || ALLE_INSTELLINGEN.test(s))).toEqual([]);
      // en het enige wat is geschreven: laatst gezien bij de telefoon en de nonce van het verzoek
      expect(sql.filter(schrijft).every((s) => /\b(scanner_devices|scanner_nonces)\b/.test(s))).toBe(true);
      expect(databank(o)).toEqual(voor);
      const gezienNa = o.rijen('SELECT id, name, paired_at, expires_at, last_seen_at FROM scanner_devices');
      expect(gezienNa.map(({ last_seen_at: _l, ...rest }) => rest)).toEqual(gezienVoor.map(({ last_seen_at: _l, ...rest }) => rest));
      expect(Date.parse(gezienNa[0]!.last_seen_at)).toBeGreaterThan(Date.parse(gezienVoor[0]!.last_seen_at));
      // ook een verzoek om een vervolgpagina of een delta krijgt hetzelfde antwoord
      expect((await tel.netwerk(tel.maak(stamgegevens(o, { sinds: 3 })))).json).toEqual({ ok: false, fout: 'geen-abonnement' });
      expect(o.logs).toEqual([]);
    } finally {
      await ruim(o);
    }
  });

  it.each(NIET_TOEGESTAAN)('ABO-12 abonnement %s via de bonnenmap: een definitief antwoordbestand met geen-abonnement, het verzoek naar verwerkt/, geen herhaling en geen melding over een probleem', async (staat) => {
    const { o, tel } = await metTelefoon(staat);
    try {
      const voor = databank(o);
      const verzoek = tel.maak(stamgegevens(o));
      const a = await viaMap(o, tel, verzoek);
      expect(a.json).toEqual({ ok: false, fout: 'geen-abonnement' });
      expect(lijst(o.van)).toEqual([`verwerkt/${verzoek.naam}`]);
      expect(lijst(o.naar)).toEqual([`${verzoek.nonce.toString('hex')}.antwoord.bvns`]);
      // geen herhaling: latere rondgangen doen niets meer met dit verzoek
      for (let i = 0; i < 5; i++) await o.scanner.scanMap();
      expect(lijst(o.van)).toEqual([`verwerkt/${verzoek.naam}`]);
      expect(lijst(o.naar)).toHaveLength(1);
      expect(o.scanner.status().map).toMatchObject({ wachtend: 0, herhaalt: 0, verwerkt: 1, problemen: 0 });
      expect(o.problemen()).toEqual([]);
      expect(o.t.s.inbox.tasks().filter((t) => t.kind === 'telefoon-map-problemen')).toEqual([]);
      expect(databank(o)).toEqual(voor);
      expect(o.logs).toEqual([]);
    } finally {
      await ruim(o);
    }
  });

  it.each(WEL_TOEGESTAAN)('ABO-13 abonnement %s: de stamgegevens komen zoals altijd, via het netwerk en via de bonnenmap', async (staat) => {
    const { o, tel } = await metTelefoon(staat);
    try {
      let r!: Awaited<ReturnType<Tel['netwerk']>>;
      const sql = await sqlTijdens(o, async () => {
        r = await tel.netwerk(tel.maak(stamgegevens(o)));
      });
      expect(r).toMatchObject({ status: 200, versleuteld: true, json: { ok: true, soort: 'stamgegevens', apparaatcode: 'M1' } });
      expect(Object.keys(r.json!)).toEqual(['ok', 'soort', 'pcTijd', 'apparaatcode', 'regels', 'regeltabel', 'bedrijf', 'klanten', 'projecten', 'aliassen', 'verborgen', 'volgende', 'nieuwe_sinds']);
      expect(r.json!.klanten.length).toBeGreaterThan(0);
      // dezelfde meting ziet hier wel de tabellen van de stamgegevens en de instellingen: het bewijs van ABO-11 meet dus echt
      expect(sql.some((s) => STAMTABELLEN.test(s))).toBe(true);
      expect(sql.some((s) => ALLE_INSTELLINGEN.test(s))).toBe(true);
      const m = await viaMap(o, tel, tel.maak(stamgegevens(o)));
      expect(Object.keys(m.json!)).toEqual(Object.keys(r.json!));
      expect(m.json!.klanten).toEqual(r.json!.klanten);
    } finally {
      await ruim(o);
    }
  });

  it('ABO-14 zonder abonnement: de vorm gaat voor (een verknoeide cursor is 400 ongeldig), een cursor die alleen met lezen te weerleggen is krijgt geen-abonnement, en over de e-mail blijft het bericht niet ondersteund zoals met abonnement', async () => {
    const { o, tel } = await metTelefoon('verlopen');
    try {
      // vormfout: geweigerd zonder dat de telefoon als gezien geldt, zoals met abonnement
      const kapot = await tel.netwerk(tel.maak(stamgegevens(o, { na: 'geen-cursor' })));
      expect(kapot).toEqual({ status: 400, versleuteld: true, json: { ok: false, fout: 'ongeldig' } });
      // een cursor in de goede vorm met een bovengrens die deze pc nooit gaf: dat blijkt pas bij het lezen, en gelezen wordt er niet
      const onmogelijk = Buffer.from(JSON.stringify({ s: 'k', t: 999_999, u: U.klant, b: 999_999 })).toString('base64url');
      expect((await tel.netwerk(tel.maak(stamgegevens(o, { na: onmogelijk })))).json).toEqual({ ok: false, fout: 'geen-abonnement' });
      await o.zet('actief');
      expect(await tel.netwerk(tel.maak(stamgegevens(o, { na: onmogelijk })))).toEqual({ status: 400, versleuteld: true, json: { ok: false, fout: 'ongeldig' } });
      // over de e-mail: in beide staten dezelfde definitieve afwijzing (er is daar geen antwoord mogelijk)
      const afwijzing = { soort: 'afgewezen', fout: 'niet-ondersteund-via-mail', veld: null, route: 'mail' };
      await viaMail(o, tel.maak(stamgegevens(o)));
      expect(o.problemen()).toEqual([afwijzing]);
      await o.zet('verlopen');
      await viaMail(o, tel.maak(stamgegevens(o)));
      expect(o.problemen()).toEqual([afwijzing, afwijzing]);
    } finally {
      await ruim(o);
    }
  });

  it('ABO-15 het antwoord geen-abonnement en het hallo-antwoord zijn precies de voorbeelden uit de testgegevens van het protocol', async () => {
    const { o, tel } = await metTelefoon('geen');
    try {
      const r = await tel.netwerk(tel.maak(stamgegevens(o)));
      expect(JSON.stringify(r.json)).toBe(protocolVoorbeeld('stamgegevens-vervolg', 'geen-abonnement'));
      // het voorbeeld van het hallo-antwoord van versie 2 heeft dezelfde velden in dezelfde volgorde als het echte antwoord
      const voorbeeld = JSON.parse(protocolVoorbeeld('versie-2', 'hallo-antwoord')) as Record<string, unknown>;
      const echt = (await tel.hallo(2)).json!;
      expect(Object.keys(voorbeeld)).toEqual(Object.keys(echt));
      expect(typeof voorbeeld.abonnement).toBe('boolean');
      expect(echt).toEqual({ ...voorbeeld, pc: o.scanner.pairing.pcId(), pcTijd: echt.pcTijd, abonnement: false });
    } finally {
      await ruim(o);
    }
  });
});

describe('telefoon en abonnement: ontvangen blijft altijd werken', () => {
  it.each(ROUTES)('ABO-16 met abonnement via %s: bon-bericht, bon, klant, project, foto en facturen worden verwerkt, wat op een klant wacht komt in de wachtrij en wordt daarna toegepast, het gat in de nummers wordt gezien en de bevestigingen komen', { timeout: 60_000 }, async (route) => {
    const r = await referentie(route);
    const uitkomsten = r.antwoorden.map((a) => (a.antwoord.json === null ? null : a.stap === 'bon-bericht' ? `al:${a.antwoord.json.al}` : a.antwoord.json.uitkomst));
    // over de e-mail antwoordt de pc nooit; de uitkomst staat dan alleen in de administratie
    if (route === 'mail') expect(uitkomsten).toEqual(r.antwoorden.map(() => null));
    else expect(uitkomsten).toEqual(['al:false', 'toegepast', 'toegepast', 'toegepast', 'toegepast', 'toegepast', 'toegepast', 'wacht', 'wacht', 'wacht', 'toegepast', 'overgeslagen']);
    if (route === 'netwerk') expect(r.antwoorden.map((a) => a.antwoord.status)).toEqual(r.antwoorden.map(() => 200));
    expect(r.tussenstand).toEqual({ wachtend: 3 });
    expect(r.stand.tellers).toMatchObject({ invoices: 3, journal_entries: 3, scanner_documents: 2, documents: 2, job_photos: 3, sync_ontvangen: 10, sync_wachtrij: 3 });
    expect(r.stand.register.map((x) => `${x.entiteit}:${x.uitkomst}`).sort()).toEqual(['bon:toegepast', 'factuur:toegepast', 'factuur:toegepast', 'factuur:toegepast', 'foto:toegepast', 'foto:toegepast', 'klant:toegepast', 'klant:toegepast', 'project:toegepast', 'project:toegepast']);
    expect(new Set(r.stand.register.map((x) => x.route))).toEqual(new Set([route]));
    expect(r.stand.wachtrij.map((w) => ({ entiteit: w.entiteit, klaar: w.klaar, uitkomst: w.verwerkt_uitkomst }))).toEqual([
      { entiteit: 'factuur', klaar: 1, uitkomst: 'toegepast' },
      { entiteit: 'project', klaar: 1, uitkomst: 'toegepast' },
      { entiteit: 'foto', klaar: 1, uitkomst: 'toegepast' },
    ]);
    expect(r.stand.klanten).toEqual([{ uuid: U.klant, name: 'Familie Bakker' }, { uuid: U.klantLater, name: 'Familie De Wit' }]);
    expect(r.stand.projecten).toEqual([{ uuid: U.project, title: 'Schilderwerk', klant: U.klant }, { uuid: U.projectWacht, title: 'Badkamer', klant: U.klantLater }]);
    expect(r.stand.facturen.map((f) => f.reeks_volgnr)).toEqual([1, 3, 4]);
    // reeksbewaking: nummer 2 ontbreekt, en dat staat als een melding op Vandaag
    expect(r.stand.gaten).toEqual([{ apparaat_code: 'M1', reeks_jaar: Number(DATUM.slice(0, 4)), van: 2, tot: 2 }]);
    expect(r.stand.reeksmeldingen).toHaveLength(1);
    expect(r.stand.problemen).toEqual([]);
    // de bevestigingen van wat eerst wachtte, via het netwerk en via de map hetzelfde
    expect(r.bevestigingen.netwerk).toMatchObject({ status: 200, versleuteld: true, json: { ok: true, soort: 'bevestigingen', apparaatcode: 'M1' } });
    expect(r.bevestigingen.netwerk.json!.bevestigingen.map((b: { entiteit: string; uuid: string; uitkomst: string }) => `${b.entiteit}:${b.uuid}:${b.uitkomst}`).sort()).toEqual(
      [`factuur:${U.factuurWacht}:toegepast`, `foto:${U.fotoWacht}:toegepast`, `project:${U.projectWacht}:toegepast`].sort(),
    );
    expect(r.bevestigingen.map).toEqual(r.bevestigingen.netwerk.json);
    expect(r.apparaten).toEqual([{ gekoppeld: 1, code: 'M1', afgesloten_op: null }]);
    expect(r.luistert).toBe(true);
    expect(r.logs).toEqual([]);
  });

  for (const route of ROUTES) {
    it.each(STATEN.filter((s) => s !== 'actief'))(`ABO-17 abonnement %s via ${route}: precies dezelfde antwoorden, registerrijen, wachtrij, reeksbewaking en bevestigingen als met een actief abonnement`, { timeout: 60_000 }, async (staat) => {
      const met = await referentie(route);
      const zonder = await ontvangAlles(route, staat);
      expect(zonder).toEqual(met);
    });
  }

  it('ABO-18 ontvangen vraagt het abonnement niet eens op: met een licentiedienst die bij elke vraag een fout geeft worden bon, wijziging en bevestigingen op alle routes gewoon verwerkt', { timeout: 60_000 }, async () => {
    const dienst = { vragen: 0, stuk: false };
    const o = await opzet({
      zonderSleutel: true,
      license: {
        status: () => {
          dienst.vragen++;
          if (dienst.stuk) throw new Error('de licentie is hier niet nodig');
          return { state: 'actief', validUntil: OVER_EEN_MAAND, email: 'piet@example.nl', cancelled: false };
        },
      },
    });
    try {
      const tel = await koppel(o);
      dienst.stuk = true;
      const vragenVoor = dienst.vragen;
      for (const [i, route] of ROUTES.entries()) {
        const foto = [makeJpeg(`abonnement stuk ${route}`)];
        const oud = [makeJpeg(`abonnement stuk oud ${route}`)];
        const u = (n: number) => `20000000-0000-4000-8000-0000000000${i}${n}`;
        const antwoorden = [
          await stuur(o, tel, route, tel.maak(oudBonBericht(u(1), oud), oud)),
          await stuur(o, tel, route, tel.maak(bonBericht(u(2), foto), foto)),
          await stuur(o, tel, route, tel.maak(klantBericht(u(3), `Klant ${route}`))),
          await stuur(o, tel, route, tel.maak(projectBericht(u(4), u(3), `Project ${route}`))),
          await stuur(o, tel, route, tel.maak(fotoBericht(u(5), u(4), [foto[0]!]), [foto[0]!])),
          await stuur(o, tel, route, tel.maak(factuurBericht(u(6), u(3), tel.code, i + 1))),
        ];
        if (route !== 'mail') expect(antwoorden.map((a) => a.json!.uitkomst ?? `al:${a.json!.al}`), route).toEqual(['al:false', 'toegepast', 'toegepast', 'toegepast', 'toegepast', 'toegepast']);
        expect(o.rijen('SELECT entiteit, uitkomst FROM sync_ontvangen WHERE route = ? ORDER BY rowid', route), route).toEqual(['bon', 'klant', 'project', 'foto', 'factuur'].map((entiteit) => ({ entiteit, uitkomst: 'toegepast' })));
      }
      expect((await tel.netwerk(tel.maak(bevestigingen()))).json).toMatchObject({ ok: true, soort: 'bevestigingen', bevestigingen: [] });
      expect((await viaMap(o, tel, tel.maak(bevestigingen()))).json).toMatchObject({ ok: true, soort: 'bevestigingen', bevestigingen: [] });
      expect(o.n('SELECT COUNT(*) AS n FROM invoices WHERE apparaat_code IS NOT NULL')).toBe(3);
      expect(o.n('SELECT COUNT(*) AS n FROM documents')).toBe(6);
      // bij al dit ontvangen is de licentie geen enkele keer gevraagd
      expect(dienst.vragen).toBe(vragenVoor);
      expect(o.logs).toEqual([]);
    } finally {
      await ruim(o);
    }
  });
});

describe('telefoon en abonnement: weer actief', () => {
  it.each(NIET_TOEGESTAAN)('ABO-19 van %s naar actief: het hallo zegt het meteen, de stamgegevens komen weer en een nieuwe telefoon koppelen kan, met dezelfde koppeling, sleutel en apparaatcode', async (staat) => {
    const { o, tel } = await metTelefoon(staat);
    try {
      const voor = o.apparaten();
      expect((await tel.hallo()).json).toMatchObject({ abonnement: false, apparaatcode: 'M1' });
      expect((await tel.netwerk(tel.maak(stamgegevens(o)))).status).toBe(403);
      const wachtend = tel.maak(stamgegevens(o));
      expect((await viaMap(o, tel, wachtend)).json).toEqual({ ok: false, fout: 'geen-abonnement' });
      await expect(o.scanner.pair()).rejects.toThrow(ValidationError);
      // wat intussen binnenkwam is gewoon verwerkt
      expect((await tel.netwerk(tel.maak(klantBericht(U.klant, 'Familie Bakker')))).json).toMatchObject({ ok: true, uitkomst: 'toegepast' });

      await o.zet('actief');
      // dezelfde telefoon, zonder opnieuw koppelen
      expect((await tel.hallo()).json).toMatchObject({ abonnement: true, apparaatcode: 'M1' });
      const r = await tel.netwerk(tel.maak(stamgegevens(o)));
      expect(r).toMatchObject({ status: 200, versleuteld: true, json: { ok: true, soort: 'stamgegevens', apparaatcode: 'M1' } });
      expect(r.json!.klanten.map((k: { uuid: string }) => k.uuid)).toContain(U.klant);
      const viaDeMap = await viaMap(o, tel, tel.maak(stamgegevens(o)));
      expect(viaDeMap.json).toMatchObject({ ok: true, soort: 'stamgegevens' });
      expect(o.apparaten()).toEqual(voor);
      expect(o.scanner.status().abonnement).toEqual({ toegestaan: true, verlopenOp: null });
      const tweede = await koppel(o, 'Tweede telefoon');
      expect(tweede.code).toBe('M2');
    } finally {
      await ruim(o);
    }
  });
});

describe('telefoon en abonnement: de melding op Vandaag', () => {
  const meldingen = (o: Opz) => o.t.s.inbox.tasks().filter((t) => t.kind === 'telefoon-abonnement');
  const app = (o: Opz) => createApi(o.t.s, { appVersion: () => 'test', scanner: { service: () => o.scanner, pickFolder: async () => null } } as unknown as HostContext);

  it.each(NIET_TOEGESTAAN)('ABO-20 abonnement %s met een gekoppelde telefoon: precies een melding, die zegt wat bij het abonnement hoort en dat ontvangen blijft werken; wegklikken haalt hem weg', async (staat) => {
    const { o } = await metTelefoon(staat);
    try {
      const lijstje = meldingen(o);
      expect(lijstje).toHaveLength(1);
      const m = lijstje[0]!;
      expect(m).toMatchObject({ key: `telefoon-abonnement:${staat === 'verlopen' ? GISTEREN : 'geen'}`, priority: 3, actions: [{ id: 'open', label: 'Naar het abonnement', primary: true }, { id: 'gezien', label: 'Gezien' }], ref: {} });
      expect(m.question).toContain('horen bij het abonnement');
      expect(m.question).toContain('komt altijd aan');
      expect(m.question.includes(`Je abonnement liep tot ${formatDateNl(GISTEREN)}.`)).toBe(staat === 'verlopen');
      // de knop gaat naar het abonnement en verandert niets
      expect(await app(o).home.act(m, 'open')).toEqual({ navigate: { screen: 'overzicht', extra: { abonnement: true } } });
      expect(meldingen(o)).toHaveLength(1);
      // een taak met een andere sleutel dan de melding van nu wordt geweigerd
      await expect(app(o).home.act({ ...m, key: 'telefoon-abonnement:2001-01-01' }, 'gezien')).rejects.toThrow(/intussen veranderd/);
      expect(meldingen(o)).toHaveLength(1);
      await app(o).home.act(m, 'gezien');
      expect(meldingen(o)).toEqual([]);
      // en hij blijft weg, ook na nieuwe berichten van de telefoon
      expect(meldingen(o)).toEqual([]);
    } finally {
      await ruim(o);
    }
  });

  it('ABO-21 geen melding met een toegestaan abonnement, zonder gekoppelde telefoon, in de kopie bij de boekhouder en zolang telefoon koppelen uit staat; een abonnement dat op een andere dag afloopt geeft een nieuwe melding', async () => {
    for (const staat of WEL_TOEGESTAAN) {
      const { o } = await metTelefoon(staat);
      try {
        expect(meldingen(o), staat).toEqual([]);
      } finally {
        await ruim(o);
      }
    }
    // zonder telefoon: niets te melden, ook niet met een QR-code die nog openstaat
    const leeg = await opzet();
    try {
      await leeg.zet('actief');
      await leeg.scanner.pair();
      await leeg.zet('geen');
      expect(meldingen(leeg)).toEqual([]);
    } finally {
      await ruim(leeg);
    }
    // de kopie bij de boekhouder: de vragen van de klant zijn niet aan hem
    const kopie = await metTelefoon('verlopen');
    try {
      expect(meldingen(kopie.o)).toHaveLength(1);
      kopie.o.t.s.settings.markOfficeCopy({ office: 'Kantoor De Vries', exchange: 1, endDate: GISTEREN });
      expect(meldingen(kopie.o)).toEqual([]);
      expect(kopie.o.t.s.inbox.telefoonAbonnementTaak()).toBeNull();
    } finally {
      await ruim(kopie.o);
    }
    const { o, tel } = await metTelefoon('verlopen');
    try {
      expect(meldingen(o)).toHaveLength(1);
      // de functieschakelaar uit: niets te zien
      PHONE_SCANNER.available = false;
      expect(meldingen(o)).toEqual([]);
      PHONE_SCANNER.available = true;
      await app(o).home.act(meldingen(o)[0]!, 'gezien');
      expect(meldingen(o)).toEqual([]);
      // weer actief en daarna op een andere dag verlopen: een nieuwe melding
      await o.zet('actief');
      expect(meldingen(o)).toEqual([]);
      const eergisteren = addDays(VANDAAG, -2);
      o.t.s.license.install(await o.licentie(eergisteren), VANDAAG);
      expect(meldingen(o).map((m) => m.key)).toEqual([`telefoon-abonnement:${eergisteren}`]);
      // na het ontkoppelen van de enige telefoon is er niets meer te melden
      await o.scanner.unpair(tel.apparaat);
      expect(meldingen(o)).toEqual([]);
    } finally {
      await ruim(o);
    }
  });
});
