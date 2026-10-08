import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeTotals, type LineInput } from '@gratis-boekhouden/kern';
import { setup } from './helpers';
import { makePdf } from './pdf';
import { migrate } from '../src/db/database';
import { migrations } from '../src/db/migrations';
import { createApi, type HostContext } from '../src/main/api';
import type { Mailer } from '../src/documents/sending';
import { MAIL_LIMITS, MAIL_TELEFOON_LIMITS, TELEFOON_NOTE, type MailAttachment, type MailMessage, type MailSource, type PollResult } from '../src/mail/mail-intake';
import { RelationsService } from '../src/relations/relations';
import { maakTelefoonHandler, type TelefoonHandler } from '../src/scanner/map-route';
import { CONTENT_TYPE, ENDPOINT_PATH, LIMITS, decodePairing, encodeFrame, openResponse, sealRequest } from '../src/scanner/protocol';
import { ScannerReceiver, type Behandeld } from '../src/scanner/receiver';
import { Bonnenscanner } from '../src/scanner/scanner';
import { ReceiptSpool } from '../src/scanner/spool';
import { PHONE_SCANNER } from '../src/shared/phone-scanner';
import { SyncOntvangst } from '../src/sync/ontvangst';

// De mailroute van de telefoon naar de pc (docs/bonnenscanner-protocol.md): een afzonderlijke mail met een versleutelde .bvns-bijlage,
// dezelfde envelop als bij het netwerk en de bonnenmap. Echte databank, de echte mailimport, scanner, receiver, SyncOntvangst en
// InvoiceService; een nep-mailbox (de mailbox zelf is extern), een eigen payload-bouwer en relatieve datums. Niets wacht op een vaste tijd.

const LOOPBACK = [{ address: '127.0.0.1', netmask: '255.0.0.0' }];
const DAG = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const GISTEREN = iso(Date.now() - DAG);
const DATUM = iso(Date.now() - 10 * DAG);

beforeEach(() => {
  PHONE_SCANNER.available = true;
});
const open: Bonnenscanner[] = [];
const dirs: string[] = [];
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
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Nep-mailbox: berichten per map; houdt bij welke aanroepen er waren, wat er verplaatst is en hoeveel er opgehaald werd. */
class FakeMailbox implements MailSource {
  folders = new Map<string, { uidValidity: string; messages: MailMessage[] }>();
  moved: { uid: number; from: string; to: string }[] = [];
  calls: string[] = [];
  fetched = 0;
  private current = '';
  add(folder: string, m: Partial<MailMessage> & { uid: number }) {
    if (!this.folders.has(folder)) this.folders.set(folder, { uidValidity: '1', messages: [] });
    this.folders.get(folder)!.messages.push({ messageId: `<${folder}-${m.uid}@x>`, fromAddress: 'iemand@elders.example', fromName: 'Iemand', subject: 'Bericht', date: GISTEREN, text: '', attachments: [], ...m });
  }
  async open(folder: string) {
    this.calls.push('open');
    const f = this.folders.get(folder);
    this.current = folder;
    return f ? { uidValidity: f.uidValidity } : null;
  }
  async list(afterUid: number) {
    this.calls.push('list');
    return this.folders.get(this.current)!.messages.map((m) => m.uid).filter((u) => u > afterUid).sort((a, b) => a - b);
  }
  async fetch(uid: number) {
    this.calls.push('fetch');
    this.fetched++;
    return this.folders.get(this.current)!.messages.find((m) => m.uid === uid) ?? null;
  }
  async move(uid: number, target: string) {
    this.calls.push('move');
    const f = this.folders.get(this.current)!;
    f.messages = f.messages.filter((m) => m.uid !== uid);
    this.moved.push({ uid, from: this.current, to: target });
  }
}

const att = (filename: string, content: Uint8Array, contentType = 'application/octet-stream'): MailAttachment => ({ filename, content, contentType, inline: false });

// ---------- de omgeving ----------

interface Opties {
  map?: boolean;
  mailer?: Mailer;
  zonderHandler?: boolean;
}

async function omgeving(opties: Opties = {}) {
  const t = setup(opties.mailer ? { mailer: opties.mailer } : {});
  t.s.settings.update({ onboardingDone: true, mailIn: { enabled: true, host: 'imap.example.nl', port: 993, secure: true, user: 'administratie@piet.nl', folder: 'INBOX', extraFolders: [], processedFolder: 'Verwerkt', since: '' } });
  const data = tmp('bvn-mailtel-gegevens-');
  const adminDir = tmp('bvn-mailtel-admin-');
  const folder = tmp('bvn-mailtel-map-');
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
  });
  open.push(scanner);
  if (!opties.zonderHandler) t.s.mail.setTelefoonHandler(scanner.mailHandler());
  if (opties.map) await scanner.setFolder(folder);
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
    scanner,
    box,
    rijen,
    n,
    /** zet een mail met deze bijlagen in de mailbox en geeft zijn uid */
    stuur(bijlagen: MailAttachment[], over: Partial<MailMessage> = {}): number {
      uid++;
      box.add('INBOX', { uid, ...over, attachments: bijlagen });
      return uid;
    },
    poll: (): Promise<PollResult> => t.s.mail.poll(box),
    register: () => rijen('SELECT apparaat_id, entiteit, uuid, revisie, uitkomst, fout, route FROM sync_ontvangen ORDER BY rowid'),
    problemen: () => rijen('SELECT bestandsnaam, apparaat_id, soort, fout, veld, route, gezien_op FROM sync_map_problemen ORDER BY id'),
    mails: () => rijen('SELECT uid, outcome, note, moved_to, document_ids FROM mail_messages ORDER BY id'),
  };
}
type Omg = Awaited<ReturnType<typeof omgeving>>;

/** De telefoon: maakt versleutelde verzoeken (dezelfde bytes voor netwerk, map en mail). */
async function koppel(o: Omg) {
  const gestart = await o.scanner.pair();
  const k = decodePairing(gestart.payload);
  const sleutel = Buffer.from(k.sleutel, 'base64url');
  const deviceId = Buffer.from(k.apparaat, 'base64url');
  const url = `http://${k.adressen[0]}:${k.poort}${ENDPOINT_PATH}`;
  const maak = (json: Record<string, unknown>, bijlagen: Buffer[] = [], opts: { nonce?: Buffer; sleutel?: Buffer; deviceId?: Buffer } = {}) => {
    const nonce = opts.nonce ?? randomBytes(12);
    return { nonce, naam: `${nonce.toString('hex')}.bvns`, body: sealRequest(opts.deviceId ?? deviceId, opts.sleutel ?? sleutel, encodeFrame(json, bijlagen), nonce, 2) };
  };
  /** de bijlage van een mail */
  const bijlage = (json: Record<string, unknown>, bijlagen: Buffer[] = []) => {
    const m = maak(json, bijlagen);
    return att(m.naam, m.body);
  };
  const netwerk = async (body: Buffer, nonce: Buffer) => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': CONTENT_TYPE }, body: new Uint8Array(body) });
    return { status: res.status, json: openResponse(Buffer.from(await res.arrayBuffer()), sleutel, nonce) };
  };
  /** legt de bytes als bestand in van-telefoon/ en draait de rondgang tot het in verwerkt/ staat */
  const viaMap = async (m: { body: Buffer; naam: string }) => {
    mkdirSync(o.van, { recursive: true });
    const pad = join(o.van, m.naam);
    writeFileSync(`${pad}.tmp`, m.body);
    renameSync(`${pad}.tmp`, pad);
    await wacht(async () => {
      await o.scanner.scanMap();
      return existsSync(join(o.verwerkt, m.naam));
    });
  };
  return { apparaat: k.apparaat, deviceId, sleutel, maak, bijlage, netwerk, viaMap };
}

/** Een handler met de echte afhandeling, waarbij per bericht (op nonce) een uitkomst kan worden opgelegd; telt de aanroepen. */
function eigenHandler(o: Omg) {
  const db = o.t.db;
  const receiver = new ScannerReceiver({
    pairing: o.scanner.pairing,
    spool: new ReceiptSpool(db, join(o.data, 'tweede-spool')),
    sync: new SyncOntvangst(db, new RelationsService(db), { now: () => Date.now(), invoices: o.t.s.invoices }),
    database: db,
    interfaces: () => [],
  });
  const opgelegd = new Map<string, Behandeld>();
  const aanroepen = new Map<string, number>();
  const handler: TelefoonHandler = maakTelefoonHandler({
    pairing: o.scanner.pairing,
    actief: () => true,
    behandel: (d, k, pt, r) => {
      const sleutel = k.nonce.toString('hex');
      aanroepen.set(sleutel, (aanroepen.get(sleutel) ?? 0) + 1);
      return opgelegd.get(sleutel) ?? receiver.behandel(d, k, pt, r);
    },
  });
  o.t.s.mail.setTelefoonHandler(handler);
  return { opgelegd, keren: (m: { nonce: Buffer }) => aanroepen.get(m.nonce.toString('hex')) ?? 0, totaal: () => [...aanroepen.values()].reduce((a, b) => a + b, 0) };
}

// ---------- de berichten (een eigen bouwer) ----------

const wijziging = (entiteit: string, velden: Record<string, unknown>, over: { uuid?: string; revisie?: number; tijd?: number; berichtTijd?: number } = {}) => ({
  soort: 'wijziging',
  tijd: over.berichtTijd ?? Date.now(),
  wijziging: { entiteit, uuid: over.uuid ?? randomUUID(), revisie: over.revisie ?? 1, tijd: over.tijd ?? Date.now() - 2 * DAG, velden },
});
const klantBericht = (naam = 'Familie Bakker', over: Parameters<typeof wijziging>[2] = {}) => wijziging('klant', { naam }, over);
const projectBericht = (klant: string, over: Parameters<typeof wijziging>[2] = {}) => wijziging('project', { titel: 'Schilderwerk', klant }, over);
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
      klant_momentopname: { name: 'Familie Bakker', address: 'Dorpsstraat 1', city: 'Utrecht', country: 'NL', vat_number: 'NL123456789B01', kvk_number: '12345678', email: 'info@bakker.example' },
      bedrijf_momentopname: { name: 'Bakker Klus', address: 'Werfstraat 2', city: 'Zwolle', kvkNumber: '87654321', vatNumber: 'NL987654321B01', kor: false },
      regels: [regel],
      totalen: { subtotaal: totalen.subtotal, btw: totalen.vatTotal, totaal: totalen.total },
      verzonden_op: `${DATUM} 10:30:00`,
      regeltabel_versie: '2026-1',
    },
    over,
  );
}

describe('de mailroute van de telefoon', () => {
  it('MAILTEL-01 een wijziging via de mail: een mail met een bijlage <naam>.bvns (de versleutelde envelop van een gekoppelde telefoon, dezelfde bytes als bij het netwerk en de map) wordt bij het ophalen van de mailbox herkend aan de bijlage, ontsleuteld met de koppelsleutel van het apparaat in de kop, verwerkt met route mail (registerrij met route mail), de mail wordt als verwerkt vastgelegd (record met uitkomst overig en een notitie die zegt dat het een telefoonbericht was, zonder inhoud) en naar de verwerkt-map verplaatst, en de bijlage wordt GEEN document in de inbox', async () => {
    const o = await omgeving();
    const p = await koppel(o);
    const uuid = randomUUID();
    const m = p.maak(klantBericht('Bakkerij De Korst', { uuid }));
    // de naam van de bijlage is willekeurig: hoofdletters en een eigen naam doen er niet toe
    const uid = o.stuur([att(`Mijn-Wijziging.BVNS`, m.body)], { subject: 'Geheim onderwerp van de telefoon' });
    const r = await o.poll();
    expect(r).toMatchObject({ documents: 0, errors: 0, other: 1 });
    expect(o.rijen('SELECT name FROM relations WHERE uuid = ?', uuid)).toEqual([{ name: 'Bakkerij De Korst' }]);
    expect(o.register()).toEqual([{ apparaat_id: p.apparaat, entiteit: 'klant', uuid, revisie: 1, uitkomst: 'toegepast', fout: null, route: 'mail' }]);
    // vastgelegd als verwerkt, zonder inhoud, en verplaatst
    expect(o.mails()).toEqual([{ uid, outcome: 'overig', note: TELEFOON_NOTE, moved_to: 'Verwerkt', document_ids: '[]' }]);
    expect(TELEFOON_NOTE).toBe('telefoonbericht');
    expect(JSON.stringify(o.rijen('SELECT * FROM mail_messages'))).not.toContain('Bakkerij De Korst');
    expect(o.box.moved).toEqual([{ uid, from: 'INBOX', to: 'Verwerkt' }]);
    // geen document in de inbox, geen voortgangsrij, geen probleem
    expect(o.t.s.intake.list()).toHaveLength(0);
    expect(o.n('SELECT COUNT(*) AS n FROM documents')).toBe(0);
    expect(o.n('SELECT COUNT(*) AS n FROM mail_attachment_progress')).toBe(0);
    expect(o.problemen()).toEqual([]);
    // nog een ronde verandert niets
    expect(await o.poll()).toMatchObject({ documents: 0, other: 0 });
    expect(o.register()).toHaveLength(1);
  });

  it('MAILTEL-02 gewone mail ongewijzigd: mails zonder .bvns-bijlage (bonnen, facturen, klantmail, eigen kopie, online factuur, tekstbon) geven exact dezelfde uitkomst als voorheen; alle bestaande tests van de mailimport blijven ongewijzigd groen', async () => {
    const toPdf = async (html: string) => makePdf(html.replace(/<br>/g, '\n').replace(/<[^>]+>/g, '').split('\n').map((l) => l.trim()).filter(Boolean));
    const bonText = 'Bedankt voor je bestelling bij Bol\n1x Kitpistool € 12,99\n1x Afplaktape € 4,99\nTotaal € 17,98\nBetaald met iDEAL op 20-09-2026';
    const jpg = new Uint8Array(20_000);
    jpg.set([0xff, 0xd8, 0xff, 1]);
    // dezelfde mails in een omgeving met de telefoonroute aan en in een zonder handler
    const vul = async (o: Omg) => {
      o.t.s.mail.setPdfRenderer(toPdf);
      o.t.s.settings.update({ smtp: { ...o.t.s.settings.get().smtp, fromEmail: 'piet@example.nl' } });
      const inv = o.t.s.invoices.finalize(o.t.s.invoices.createDraft({ relationId: o.t.klant.id, invoiceDate: DATUM, lines: [{ description: 'Werk', quantity: 1, unitPrice: 10000, vatCode: 'hoog' }] }).id);
      o.stuur([att('bon.pdf', makePdf(['Leverancier', 'Totaal 12,50']), 'application/pdf')], { fromAddress: 'facturen@leverancier.example', subject: 'Factuur 4411' });
      o.stuur([att('offerte.jpg', jpg, 'image/jpeg')], { fromAddress: 'jansen@example.nl', subject: 'Getekend' });
      o.stuur([att('bon.jpg', jpg, 'image/jpeg')], { fromAddress: 'piet@example.nl', subject: `Factuur ${inv.number} van Stukadoorsbedrijf Piet` });
      o.stuur([], { fromAddress: 'kpn@kpn.example', fromName: 'KPN', subject: 'Uw factuur staat klaar', text: 'Zie https://mijn.kpn.com/facturen' });
      o.stuur([], { fromAddress: 'noreply@bol.example', fromName: 'Bol', subject: 'Je bestelling 1234', text: bonText });
      o.stuur([att('notities.txt', new TextEncoder().encode('geen bon'))], { fromAddress: 'nieuws@shop.example', subject: 'Nieuwsbrief' });
      const r = await o.poll();
      return { r, mails: o.rijen('SELECT outcome, relation_id, link_domain, document_ids, note, moved_to FROM mail_messages ORDER BY id'), documenten: o.n('SELECT COUNT(*) AS n FROM documents'), verplaatst: o.box.moved.map((x) => x.uid) };
    };
    const aan = await vul(await omgeving());
    const uit = await vul(await omgeving({ zonderHandler: true }));
    expect(aan).toEqual(uit);
    expect(aan.r).toMatchObject({ documents: 2, onlineInvoices: 1, fromCustomers: 1, other: 2, errors: 0 });
    expect(aan.mails.map((m) => m.outcome)).toEqual(['bijlage', 'klant', 'eigen', 'online-factuur', 'bijlage', 'overig']);
    expect(aan.mails.some((m) => m.note === TELEFOON_NOTE)).toBe(false);
  });

  it('MAILTEL-03 voorrang en afzender: de herkenning van een .bvns-bijlage gaat vóór de takken eigen adres (bcc van je eigen factuur) en klant; het apparaat komt uitsluitend uit de kop van de envelop en de koppeling, nooit uit het afzenderadres, het onderwerp of de tekst van de mail; een geldige envelop van een willekeurig afzenderadres wordt verwerkt, een envelop die niet te ontsleutelen is (onbekend apparaat, verkeerde sleutel, aangepast, afgekapt) wordt nooit verwerkt', async () => {
    const o = await omgeving();
    const p = await koppel(o);
    o.t.s.settings.update({ smtp: { ...o.t.s.settings.get().smtp, fromEmail: 'piet@example.nl' } });
    const inv = o.t.s.invoices.finalize(o.t.s.invoices.createDraft({ relationId: o.t.klant.id, invoiceDate: DATUM, lines: [{ description: 'Werk', quantity: 1, unitPrice: 10000, vatCode: 'hoog' }] }).id);
    // van je eigen adres, met het nummer van je eigen factuur in het onderwerp: zonder .bvns zou dit een eigen kopie zijn
    const eigen = p.bijlage(klantBericht('Via eigen adres'));
    o.stuur([eigen], { fromAddress: 'piet@example.nl', subject: `Factuur ${inv.number} van Stukadoorsbedrijf Piet` });
    // van een klant (Familie Jansen staat in de app met dit adres)
    o.stuur([p.bijlage(klantBericht('Via klantadres'))], { fromAddress: 'jansen@example.nl', subject: 'Getekend' });
    // een willekeurige afzender die zich als een ander apparaat voordoet in onderwerp en tekst
    o.stuur([p.bijlage(klantBericht('Via vreemd adres'))], { fromAddress: 'nepper@elders.example', subject: `apparaat M9 ${randomUUID()}`, text: 'apparaat: M9' });
    await o.poll();
    expect(o.rijen('SELECT name FROM relations WHERE name LIKE ? ORDER BY name', 'Via %')).toEqual([{ name: 'Via eigen adres' }, { name: 'Via klantadres' }, { name: 'Via vreemd adres' }]);
    expect(o.register().map((r) => r.apparaat_id)).toEqual([p.apparaat, p.apparaat, p.apparaat]);
    expect(o.mails().map((m) => [m.outcome, m.note])).toEqual([['overig', TELEFOON_NOTE], ['overig', TELEFOON_NOTE], ['overig', TELEFOON_NOTE]]);
    expect(o.rijen(`SELECT COUNT(*) AS n FROM mail_messages WHERE outcome IN ('eigen', 'klant')`)).toEqual([{ n: 0 }]);
    // niet te ontsleutelen: nooit verwerkt, wel definitief afgesloten met een regel in het probleemregister
    const goed = p.maak(klantBericht('Moet niet binnenkomen'));
    const aangepast = Buffer.from(goed.body);
    aangepast[aangepast.length - 5] = aangepast[aangepast.length - 5]! ^ 0xff;
    const kapot = [
      att('onbekend.bvns', p.maak(klantBericht('Onbekend apparaat'), [], { deviceId: randomBytes(16), sleutel: randomBytes(32) }).body),
      att('sleutel.bvns', p.maak(klantBericht('Verkeerde sleutel'), [], { sleutel: randomBytes(32) }).body),
      att('aangepast.bvns', aangepast),
      att('afgekapt.bvns', goed.body.subarray(0, Math.floor(goed.body.length / 2))),
    ];
    for (const b of kapot) o.stuur([b]);
    await o.poll();
    expect(o.n(`SELECT COUNT(*) AS n FROM relations WHERE name IN ('Moet niet binnenkomen', 'Onbekend apparaat', 'Verkeerde sleutel')`)).toBe(0);
    expect(o.register()).toHaveLength(3);
    expect(o.problemen().map((r) => r.soort)).toEqual(['onbekend-apparaat', 'onleesbaar', 'onleesbaar', 'onleesbaar']);
    expect(o.mails().slice(3).every((m) => m.outcome === 'overig' && m.note === TELEFOON_NOTE && m.moved_to === 'Verwerkt')).toBe(true);
  });

  it('MAILTEL-04 definitief en herhaalbaar: een uitkomst 200 (toegepast, overgeslagen, afgewezen, wacht), 400 en 413 zijn definitief (de mail is verwerkt en verplaatst); 503 wachtrij-vol, 500 opslaan-mislukt en niet-ondersteund laten de mail onverwerkt (niet vastgelegd, niet verplaatst, de map gaat bij dit bericht niet verder) en worden bij de volgende ophaalronde opnieuw geprobeerd, zonder dat het de maximum pogingen van gewone mails (3) opeet; pas na een ruime grens (kies en test, bijvoorbeeld 200 pogingen) wordt de mail als probleem vastgelegd en overgeslagen; na herstel is het effect precies een keer', async () => {
    const o = await omgeving();
    const p = await koppel(o);
    const h = eigenHandler(o);
    const mail = (json: Record<string, unknown>) => {
      const m = p.maak(json);
      return { ...m, uid: o.stuur([att(m.naam, m.body)]) };
    };

    // definitief: toegepast, overgeslagen, wacht, afgewezen, 400 (bewerktijd) en 413 (te grote JSON)
    const klant = randomUUID();
    const definitief = [
      mail(klantBericht('Een', { uuid: klant })),
      mail(klantBericht('Een', { uuid: klant })),
      mail(projectBericht(randomUUID())),
      mail(klantBericht('Twee')),
      mail(klantBericht('Straks', { tijd: Date.now() + 60 * 60_000 })),
      mail(klantBericht('x'.repeat(LIMITS.maxWijzigingJsonBytes + 10))),
    ];
    h.opgelegd.set(definitief[3]!.nonce.toString('hex'), { status: 200, json: { ok: true, soort: 'wijziging', uitkomst: 'afgewezen', fout: 'nummer-bezet' } });
    await o.poll();
    expect(o.mails().map((m) => [m.uid, m.outcome, m.moved_to])).toEqual(definitief.map((d) => [d.uid, 'overig', 'Verwerkt']));
    expect(definitief.map((d) => h.keren(d))).toEqual([1, 1, 1, 1, 1, 1]);
    // "overgeslagen", "wacht" en een vormfout laten geen eigen registerrij achter; een afgewezen wijziging hier is opgelegd
    expect(o.register().map((r) => r.uitkomst)).toEqual(['toegepast']);
    expect(o.n('SELECT COUNT(*) AS n FROM sync_wachtrij')).toBe(1);
    expect(o.n('SELECT COUNT(*) AS n FROM relations WHERE name = ?', 'Een')).toBe(1);
    expect(o.n('SELECT COUNT(*) AS n FROM relations WHERE name IN (?, ?)', 'Straks', 'Twee')).toBe(0);
    expect(o.problemen().map((r) => r.soort)).toEqual(['afgewezen']);

    // herhaalbaar: de mail blijft liggen en de map gaat niet verder; elke ronde is een nieuwe poging
    const klantA = randomUUID();
    const herhaalbaar = [
      { naam: '503', opleg: { status: 503, json: { ok: false, fout: 'wachtrij-vol' } } as Behandeld, m: mail(klantBericht('Herhaal 503', { uuid: klantA })) },
      { naam: '500', opleg: { status: 500, json: { ok: false, fout: 'opslaan-mislukt' } } as Behandeld, m: mail(klantBericht('Herhaal 500')) },
      { naam: 'niet ondersteund', opleg: { status: 200, json: { ok: true, soort: 'wijziging', uitkomst: 'niet-ondersteund' } } as Behandeld, m: mail(klantBericht('Herhaal niet ondersteund')) },
    ];
    for (const x of herhaalbaar) h.opgelegd.set(x.m.nonce.toString('hex'), x.opleg);
    const voor = o.mails().length;
    for (let ronde = 1; ronde <= 5; ronde++) {
      await o.poll();
      // meer dan de 3 pogingen van gewone mail, en toch niet vastgelegd, niet verplaatst en niet verder
      expect(h.keren(herhaalbaar[0]!.m), `ronde ${ronde}`).toBe(ronde);
      expect(h.keren(herhaalbaar[1]!.m), `ronde ${ronde}`).toBe(0);
      expect(o.mails()).toHaveLength(voor);
      expect(o.box.moved).toHaveLength(voor);
    }
    expect(o.rijen('SELECT failed_uid, failed_count, telefoon_uid, telefoon_pogingen FROM mail_folders')).toEqual([{ failed_uid: null, failed_count: 0, telefoon_uid: herhaalbaar[0]!.m.uid, telefoon_pogingen: 5 }]);
    // na herstel van elk van de drie: precies een keer verwerkt, in volgorde
    for (const x of herhaalbaar) {
      h.opgelegd.delete(x.m.nonce.toString('hex'));
      await o.poll();
    }
    expect(o.mails().slice(voor).map((m) => [m.uid, m.outcome, m.moved_to])).toEqual(herhaalbaar.map((x) => [x.m.uid, 'overig', 'Verwerkt']));
    expect(o.n('SELECT COUNT(*) AS n FROM sync_ontvangen WHERE uuid = ?', klantA)).toBe(1);
    expect(o.n('SELECT COUNT(*) AS n FROM relations WHERE name LIKE ?', 'Herhaal %')).toBe(3);
    expect(o.rijen('SELECT telefoon_uid, telefoon_pogingen FROM mail_folders')).toEqual([{ telefoon_uid: null, telefoon_pogingen: 0 }]);

    // de grens: een mail die nooit lukt blokkeert de map niet voor altijd
    const vast = mail(klantBericht('Blijft vast'));
    const erachter = mail(klantBericht('Staat erachter'));
    h.opgelegd.set(vast.nonce.toString('hex'), { status: 500, json: { ok: false, fout: 'opslaan-mislukt' } });
    let rondes = 0;
    await wacht(async () => {
      rondes++;
      await o.poll();
      return o.rijen('SELECT 1 FROM mail_messages WHERE uid = ?', vast.uid).length > 0;
    });
    expect(rondes).toBe(MAIL_TELEFOON_LIMITS.maxPogingen);
    expect(MAIL_TELEFOON_LIMITS.maxPogingen).toBeGreaterThan(MAIL_LIMITS.maxAttempts);
    expect(h.keren(vast)).toBe(MAIL_TELEFOON_LIMITS.maxPogingen);
    // als probleem vastgelegd (de mail blijft in de mailbox) en de map ging door met wat erachter stond
    expect(o.rijen('SELECT outcome, note, moved_to FROM mail_messages WHERE uid = ?', vast.uid)).toEqual([{ outcome: 'fout', note: `${TELEFOON_NOTE}: te vaak opnieuw geprobeerd`, moved_to: null }]);
    expect(o.problemen().at(-1)).toMatchObject({ soort: 'afgewezen', fout: 'te-vaak-geprobeerd', route: 'mail' });
    expect(o.box.moved.some((x) => x.uid === vast.uid)).toBe(false);
    expect(o.n('SELECT COUNT(*) AS n FROM relations WHERE name = ?', 'Staat erachter')).toBe(1);
    expect(h.keren(erachter)).toBe(1);
    await o.poll();
    expect(h.keren(vast)).toBe(MAIL_TELEFOON_LIMITS.maxPogingen);
  });

  it('MAILTEL-05 problemen en Vandaag: een afgewezen wijziging, een veldfout en een niet te ontsleutelen .bvns krijgen een regel in het probleemregister van de bonnenmap (sync_map_problemen, nu met een kolom route: netwerk, map of mail via een nieuwe migratie) en tellen mee in precies dezelfde melding op Vandaag per soort (telefoon-map-problemen, bijgewerkt zodat de tekst ook de mail noemt); zonder inhoud, zonder pad; "gezien" markeert de regels; zonder problemen verandert Vandaag niet', async () => {
    const o = await omgeving();
    const p = await koppel(o);
    const taken = () => o.t.s.inbox.tasks().filter((t) => t.kind === 'telefoon-map-problemen');
    const vooraf = o.t.s.inbox.tasks().map((t) => t.key);
    o.stuur([], { subject: 'Gewone mail' });
    await o.poll();
    expect(o.t.s.inbox.tasks().map((t) => t.key)).toEqual(vooraf);
    expect(taken()).toEqual([]);

    const klant = randomUUID();
    o.stuur([p.bijlage(klantBericht('Familie Bakker', { uuid: klant })), p.bijlage(factuurBericht(klant, 1)), p.bijlage(factuurBericht(klant, 1))], { subject: 'Geheim onderwerp' });
    o.stuur([p.bijlage(wijziging('klant', { naam: 'Geheime klantnaam', email: 'geen-adres' }))]);
    o.stuur([att('kapot-1.bvns', randomBytes(300))]);
    o.stuur([att('kapot-2.bvns', randomBytes(301))]);
    await o.poll();
    expect(o.problemen().map((r) => r.soort)).toEqual(['afgewezen', 'veld-ongeldig', 'onleesbaar', 'onleesbaar']);
    expect(o.problemen().every((r) => r.route === 'mail' && r.gezien_op === null)).toBe(true);
    expect(o.problemen()[0]).toMatchObject({ apparaat_id: p.apparaat, fout: 'nummer-bezet' });
    expect(o.problemen()[1]).toMatchObject({ fout: 'veld-ongeldig', veld: 'email' });
    // een oude regel van de bonnenmap (route NULL) telt in dezelfde melding mee
    o.t.db.prepare(`INSERT INTO sync_map_problemen (bestandsnaam, soort, fout, tijd) VALUES ('oud.bvns', 'afgewezen', 'nummer-bezet', 1)`).run();

    const lijst = taken();
    expect(lijst.map((t) => t.key).sort()).toEqual(['afgewezen', 'onleesbaar', 'veld-ongeldig'].map((s) => `telefoon-map-problemen:${s}`));
    expect(lijst.find((t) => t.key.endsWith(':afgewezen'))!.title).toMatch(/^2 /);
    expect(lijst.find((t) => t.key.endsWith(':onleesbaar'))!.title).toMatch(/^2 /);
    for (const t of lijst) {
      expect(t.priority).toBe(2);
      expect(t.actions.map((a) => a.id)).toEqual(['gezien', 'later']);
      expect(`${t.title} ${t.question}`).toMatch(/e-mail/);
    }
    const tekst = JSON.stringify(lijst);
    for (const verboden of [o.adminDir, o.folder, o.data, 'Geheime klantnaam', 'Geheim onderwerp', 'kapot-1', 'geen-adres']) expect(tekst).not.toContain(verboden);
    expect(JSON.stringify(o.problemen())).not.toMatch(/Geheime klantnaam|Geheim onderwerp|geen-adres/);

    // gezien markeert alleen de regels van die soort en verwijdert niets
    const api = createApi(o.t.s, { appVersion: () => 'test' } as unknown as HostContext);
    await api.home.act(lijst.find((t) => t.key.endsWith(':onleesbaar'))!, 'gezien');
    expect(taken()).toHaveLength(2);
    expect(o.problemen()).toHaveLength(5);
    expect(o.problemen().filter((r) => r.gezien_op !== null).map((r) => r.soort)).toEqual(['onleesbaar', 'onleesbaar']);
  });

  it('MAILTEL-06 meerdere bijlagen: een mail met meerdere .bvns-bijlagen (hoogstens 10) verwerkt ze op volgorde; faalt er een herhaalbaar, dan blijft de mail liggen en worden de al toegepaste bijlagen bij de volgende poging niet dubbel toegepast (register); een mail met zowel een .bvns als een gewone PDF verwerkt de .bvns en negeert de PDF (de factuur komt via de wijziging; geen tweede document)', async () => {
    const o = await omgeving();
    const p = await koppel(o);
    const h = eigenHandler(o);
    const ms = ['Eerste', 'Tweede', 'Derde'].map((naam) => p.maak(klantBericht(naam)));
    const pdf = att('factuur.pdf', makePdf(['Factuur 2026-001', 'Totaal 100,00']), 'application/pdf');
    const uid = o.stuur([att(ms[0]!.naam, ms[0]!.body), pdf, att(ms[1]!.naam, ms[1]!.body), att(ms[2]!.naam, ms[2]!.body)]);
    h.opgelegd.set(ms[1]!.nonce.toString('hex'), { status: 503, json: { ok: false, fout: 'wachtrij-vol' } });
    await o.poll();
    // de eerste is toegepast, de tweede faalde herhaalbaar, de derde is nog niet aan de beurt geweest
    expect(o.n(`SELECT COUNT(*) AS n FROM relations WHERE name IN ('Eerste', 'Tweede', 'Derde')`)).toBe(1);
    expect(h.keren(ms[0]!)).toBe(1);
    expect(h.keren(ms[1]!)).toBe(1);
    expect(h.keren(ms[2]!)).toBe(0);
    expect(o.mails()).toEqual([]);
    expect(o.box.moved).toEqual([]);
    // hersteld: de eerste wordt niet dubbel toegepast, de rest volgt op volgorde
    h.opgelegd.clear();
    await o.poll();
    expect(o.rijen(`SELECT name FROM relations WHERE name IN ('Eerste', 'Tweede', 'Derde') ORDER BY id`)).toEqual([{ name: 'Eerste' }, { name: 'Tweede' }, { name: 'Derde' }]);
    expect(o.register().map((r) => r.uitkomst)).toEqual(['toegepast', 'toegepast', 'toegepast']);
    expect(o.mails()).toEqual([{ uid, outcome: 'overig', note: TELEFOON_NOTE, moved_to: 'Verwerkt', document_ids: '[]' }]);
    // de PDF ernaast is genegeerd: geen document
    expect(o.t.s.intake.list()).toHaveLength(0);
    expect(o.n('SELECT COUNT(*) AS n FROM documents')).toBe(0);
  });

  it('MAILTEL-07 idempotent over routes: dezelfde wijziging eerst via het netwerk of de map en daarna via de mail (en andersom, ook als dezelfde mail twee keer binnenkomt met dezelfde Message-ID of als twee verschillende mails dezelfde bijlage dragen) geeft precies een effect, een registerrij (route van de eerste ontvangst) en overgeslagen bij de tweede; een wachtende wijziging komt niet dubbel in sync_wachtrij', async () => {
    const o = await omgeving({ map: true });
    const p = await koppel(o);
    const route = (uuid: string) => o.rijen('SELECT route, uitkomst FROM sync_ontvangen WHERE uuid = ?', uuid);
    const effect = (uuid: string) => o.n('SELECT COUNT(*) AS n FROM relations WHERE uuid = ?', uuid);

    // netwerk eerst, daarna dezelfde bytes per mail
    const uNet = randomUUID();
    const net = p.maak(klantBericht('Via netwerk', { uuid: uNet }));
    expect((await p.netwerk(net.body, net.nonce)).json).toMatchObject({ uitkomst: 'toegepast' });
    o.stuur([att(net.naam, net.body)]);
    // map eerst, daarna per mail
    const uMap = randomUUID();
    const map = p.maak(klantBericht('Via map', { uuid: uMap }));
    await p.viaMap(map);
    o.stuur([att(map.naam, map.body)]);
    await o.poll();
    expect(route(uNet)).toEqual([{ route: 'netwerk', uitkomst: 'toegepast' }]);
    expect(route(uMap)).toEqual([{ route: 'map', uitkomst: 'toegepast' }]);
    expect(effect(uNet) + effect(uMap)).toBe(2);

    // mail eerst, daarna dezelfde bytes over het netwerk en als bestand in de map
    const uMail = randomUUID();
    const mail = p.maak(klantBericht('Via mail', { uuid: uMail }));
    o.stuur([att(mail.naam, mail.body)]);
    await o.poll();
    expect(route(uMail)).toEqual([{ route: 'mail', uitkomst: 'toegepast' }]);
    expect((await p.netwerk(mail.body, mail.nonce)).json).toMatchObject({ uitkomst: 'overgeslagen' });
    await p.viaMap({ body: mail.body, naam: 'andere-naam.bvns' });
    expect(route(uMail)).toEqual([{ route: 'mail', uitkomst: 'toegepast' }]);
    expect(effect(uMail)).toBe(1);

    // dezelfde mail twee keer (zelfde Message-ID) en twee verschillende mails met dezelfde bijlage
    const uDubbel = randomUUID();
    const dubbel = p.maak(klantBericht('Dubbel', { uuid: uDubbel }));
    const eerste = o.stuur([att(dubbel.naam, dubbel.body)], { messageId: '<zelfde@x>' });
    o.stuur([att(dubbel.naam, dubbel.body)], { messageId: '<zelfde@x>' });
    o.stuur([att(dubbel.naam, dubbel.body)], { messageId: '<anders@x>' });
    const voor = o.mails().length;
    await o.poll();
    expect(o.mails().length - voor).toBe(2);
    expect(o.mails().at(-2)!.uid).toBe(eerste);
    expect(route(uDubbel)).toEqual([{ route: 'mail', uitkomst: 'toegepast' }]);
    expect(effect(uDubbel)).toBe(1);

    // een wachtende wijziging (project vóór zijn klant) komt via elke route hoogstens een keer in de wachtrij
    const klant = randomUUID();
    const project = p.maak(projectBericht(klant));
    o.stuur([att(project.naam, project.body)]);
    await o.poll();
    expect(o.n('SELECT COUNT(*) AS n FROM sync_wachtrij')).toBe(1);
    await p.netwerk(project.body, project.nonce);
    await p.viaMap({ body: project.body, naam: 'project-nog-eens.bvns' });
    o.stuur([att('nog-eens.bvns', project.body)], { messageId: '<project-2@x>' });
    await o.poll();
    expect(o.n('SELECT COUNT(*) AS n FROM sync_wachtrij')).toBe(1);

    // een factuur eerst per mail en dan over het netwerk: een factuur
    const k2 = randomUUID();
    const fact = p.maak(factuurBericht(k2, 1));
    o.stuur([att('k.bvns', p.maak(klantBericht('Factuurklant', { uuid: k2 })).body), att(fact.naam, fact.body)]);
    await o.poll();
    expect(o.n('SELECT COUNT(*) AS n FROM invoices')).toBe(1);
    expect((await p.netwerk(fact.body, fact.nonce)).json).toMatchObject({ uitkomst: 'overgeslagen' });
    expect(o.n('SELECT COUNT(*) AS n FROM invoices')).toBe(1);
  });

  it('MAILTEL-08 geen klokvenster en geen nonce: een mail van uren of dagen geleden wordt gewoon verwerkt (geen 403 klok, geen 409 herhaald); de controle van 5 minuten op de bewerktijd van een wijziging geldt wel', async () => {
    const o = await omgeving();
    const p = await koppel(o);
    const uuid = randomUUID();
    const oud = p.maak(klantBericht('Oude mail', { uuid, berichtTijd: Date.now() - 3 * DAG }));
    o.stuur([att(oud.naam, oud.body)], { date: iso(Date.now() - 3 * DAG) });
    // het bewerkmoment: een minuut vooruit mag, een kwartier niet
    const vooruit = p.maak(klantBericht('Straks', { tijd: Date.now() + 60_000, berichtTijd: Date.now() - 5 * 60 * 60 * 1000 }));
    o.stuur([att(vooruit.naam, vooruit.body)]);
    const teVer = p.maak(klantBericht('Te ver vooruit', { tijd: Date.now() + 15 * 60_000 }));
    o.stuur([att(teVer.naam, teVer.body)]);
    await o.poll();
    expect(o.register()).toMatchObject([{ uuid, uitkomst: 'toegepast', fout: null, route: 'mail' }, { entiteit: 'klant', uitkomst: 'toegepast', route: 'mail' }]);
    expect(o.n('SELECT COUNT(*) AS n FROM relations WHERE name IN (?, ?)', 'Oude mail', 'Straks')).toBe(2);
    expect(o.n('SELECT COUNT(*) AS n FROM relations WHERE name = ?', 'Te ver vooruit')).toBe(0);
    // het bericht van drie dagen geleden is over het netwerk te oud, per mail niet
    expect((await p.netwerk(oud.body, oud.nonce)).json).toMatchObject({ ok: false, fout: 'klok' });
    // dezelfde bytes in een tweede mail: geen 409 herhaald (de nonce wordt per mail niet bijgehouden) en geen tweede effect
    o.stuur([att(oud.naam, oud.body)], { messageId: '<opnieuw@x>' });
    await o.poll();
    expect(o.register().filter((r) => r.uuid === uuid)).toHaveLength(1);
    expect(o.n('SELECT COUNT(*) AS n FROM scanner_nonces')).toBe(0);
    // het kwartier te ver vooruit is definitief afgesloten (400), de mail is verwerkt
    expect(o.mails().map((m) => m.outcome)).toEqual(['overig', 'overig', 'overig', 'overig']);
    expect(o.box.moved).toHaveLength(4);
  });

  it('MAILTEL-09 nooit antwoorden: de pc stuurt nooit een mail terug en schrijft nooit naar de mailbox behalve het verplaatsen naar de verwerkt-map zoals nu; er is geen pc-naar-telefoon via e-mail (test dat sendMail en de smtp-routes niet worden aangeroepen en dat stamgegevens- en bevestigingen-berichten via de mail geen antwoord opleveren maar definitief worden afgesloten met een regel in het probleemregister: niet ondersteund via mail)', async () => {
    const verstuurd: unknown[] = [];
    const o = await omgeving({ mailer: { async send(m) { verstuurd.push(m); return { messageId: '<x@local>' }; } } });
    const p = await koppel(o);
    const stam = p.maak({ soort: 'stamgegevens', tijd: Date.now() });
    const bev = p.maak({ soort: 'bevestigingen', tijd: Date.now() });
    const hallo = p.maak({ soort: 'hallo', tijd: Date.now(), naam: 'Pixel van Piet', app: '1.0.0' });
    const wijz = p.maak(klantBericht('Wel ondersteund'));
    for (const m of [stam, bev, hallo, wijz]) o.stuur([att(m.naam, m.body)]);
    await o.poll();
    // alleen de wijziging is verwerkt; de drie anderen zijn definitief afgesloten zonder iets te lezen, te wijzigen of terug te sturen
    expect(o.register()).toMatchObject([{ entiteit: 'klant', route: 'mail', uitkomst: 'toegepast' }]);
    expect(o.problemen().map((r) => [r.soort, r.fout, r.route])).toEqual([['afgewezen', 'niet-ondersteund-via-mail', 'mail'], ['afgewezen', 'niet-ondersteund-via-mail', 'mail'], ['afgewezen', 'niet-ondersteund-via-mail', 'mail']]);
    expect(o.mails().map((m) => [m.outcome, m.moved_to])).toEqual([['overig', 'Verwerkt'], ['overig', 'Verwerkt'], ['overig', 'Verwerkt'], ['overig', 'Verwerkt']]);
    // geen enkele mail verstuurd
    expect(verstuurd).toEqual([]);
    expect(o.t.sent).toEqual([]);
    // de pc raakt de mailbox alleen aan om te lezen en te verplaatsen, en verplaatst alleen naar de verwerkt-map
    expect(new Set(o.box.calls)).toEqual(new Set(['open', 'list', 'fetch', 'move']));
    expect(o.box.moved.every((x) => x.to === 'Verwerkt' && x.from === 'INBOX')).toBe(true);
    // de code van de mailroute kent geen verzendpad
    for (const bestand of ['mail/mail-intake.ts', 'scanner/map-route.ts']) expect(readFileSync(join(__dirname, '..', 'src', bestand), 'utf8'), bestand).not.toMatch(/sendMail|mailerFactory|createSmtpMailer|createTransport|\.send\(/);
  });

  it('MAILTEL-10 grootte en begrenzing: een .bvns boven de grens (maxBodyBytes van het protocol; kies de leesgrens voor deze bijlagen apart van MAIL_LIMITS.maxAttachmentBytes en documenteer ze) wordt definitief afgewezen zonder de inhoud te verwerken en een mail met meer dan 10 .bvns-bijlagen verwerkt alleen de eerste 10 en legt de rest vast als probleem; de ophaalronde blijft begrensd (maxMessagesPerPoll) en er wordt nooit meer in het geheugen genomen dan een mail', async () => {
    const o = await omgeving();
    const p = await koppel(o);
    const h = eigenHandler(o);
    // de leesgrens voor een .bvns is die van het protocol en staat los van die voor gewone bijlagen
    expect(MAIL_TELEFOON_LIMITS.maxBvnsBytes).toBe(LIMITS.maxBodyBytes);
    expect(MAIL_TELEFOON_LIMITS.maxBvnsBytes).toBeGreaterThan(MAIL_LIMITS.maxAttachmentBytes);
    expect(MAIL_TELEFOON_LIMITS.maxBvnsPerMail).toBe(10);
    // een byte boven de grens wordt afgewezen zonder dat de inhoud wordt verwerkt
    const groot = Buffer.alloc(LIMITS.maxBodyBytes + 1, 7);
    const uidGroot = o.stuur([att('te-groot.bvns', groot)]);
    // meer dan 10 bijlagen: alleen de eerste 10, de rest is een probleem
    const twaalf = Array.from({ length: 12 }, (_, i) => p.maak(klantBericht(`Bijlage ${String(i).padStart(2, '0')}`)));
    const uidTwaalf = o.stuur(twaalf.map((m) => att(m.naam, m.body)));
    await o.poll();
    expect(h.totaal()).toBe(10);
    expect(o.problemen().slice(0, 1)).toMatchObject([{ soort: 'onleesbaar', fout: 'te-groot', route: 'mail' }]);
    expect(o.mails().map((m) => [m.uid, m.outcome, m.moved_to])).toEqual([[uidGroot, 'overig', 'Verwerkt'], [uidTwaalf, 'overig', 'Verwerkt']]);
    expect(o.rijen(`SELECT name FROM relations WHERE name LIKE 'Bijlage %' ORDER BY name`).map((r) => r.name)).toEqual(twaalf.slice(0, 10).map((_, i) => `Bijlage ${String(i).padStart(2, '0')}`));
    expect(o.problemen().at(-1)).toMatchObject({ soort: 'afgewezen', fout: 'te-veel-bijlagen', bestandsnaam: twaalf[10]!.naam });
    expect(h.keren(twaalf[10]!)).toBe(0);
    expect(h.keren(twaalf[11]!)).toBe(0);

    // de ophaalronde blijft begrensd en haalt de mails een voor een op
    for (let i = 0; i < MAIL_LIMITS.maxMessagesPerPoll + 5; i++) o.stuur([att(`k${i}.bvns`, p.maak(klantBericht(`Reeks ${i}`)).body)]);
    o.box.fetched = 0;
    await o.poll();
    expect(o.box.fetched).toBe(MAIL_LIMITS.maxMessagesPerPoll);
    expect(o.n(`SELECT COUNT(*) AS n FROM relations WHERE name LIKE 'Reeks %'`)).toBe(MAIL_LIMITS.maxMessagesPerPoll);
    await o.poll();
    expect(o.n(`SELECT COUNT(*) AS n FROM relations WHERE name LIKE 'Reeks %'`)).toBe(MAIL_LIMITS.maxMessagesPerPoll + 5);
  });

  it('MAILTEL-11 uit als de telefoonroute uit staat: zolang PHONE_SCANNER.available false is (en zolang er geen scanner is) worden .bvns-bijlagen behandeld als alle andere onbekende bijlagen (genegeerd, mail "overig"), zodat voor gebruikers niets verandert; met de route aan en een scanner zonder koppelingen geeft elke .bvns een probleemregel (onbekend apparaat)', async () => {
    const o = await omgeving();
    const p = await koppel(o);
    const uuid = randomUUID();
    const m = p.maak(klantBericht('Moet wachten', { uuid }));
    const uitkomst = async (omg: Omg) => {
      const r = await omg.poll();
      return { r, mails: omg.mails(), relaties: omg.n('SELECT COUNT(*) AS n FROM relations WHERE uuid = ?', uuid), problemen: omg.problemen(), verplaatst: omg.box.moved, documenten: omg.n('SELECT COUNT(*) AS n FROM documents') };
    };
    // route uit: de scanner is er wel, maar koppelen staat uit
    PHONE_SCANNER.available = false;
    o.stuur([att(m.naam, m.body)], { subject: 'Wijziging' });
    const uit = await uitkomst(o);
    expect(uit.r).toMatchObject({ documents: 0, other: 1, errors: 0 });
    expect(uit.mails).toEqual([{ uid: 1, outcome: 'overig', note: null, moved_to: null, document_ids: '[]' }]);
    expect([uit.relaties, uit.problemen, uit.verplaatst, uit.documenten]).toEqual([0, [], [], 0]);
    // geen scanner (geen handler): hetzelfde, ook met de route aan, en dezelfde uitkomst als voor deze stap
    PHONE_SCANNER.available = true;
    const zonder = await omgeving({ zonderHandler: true });
    zonder.stuur([att(m.naam, m.body)], { subject: 'Wijziging' });
    expect(await uitkomst(zonder)).toEqual(uit);
    // de route aan en een scanner zonder koppelingen: elke .bvns is een probleemregel (onbekend apparaat), definitief afgesloten
    const leeg = await omgeving();
    const vreemd = (naam: string) => att(naam, sealRequest(randomBytes(16), randomBytes(32), encodeFrame(klantBericht('Vreemd')), randomBytes(12), 2));
    leeg.stuur([vreemd('een.bvns'), vreemd('twee.bvns')]);
    await leeg.poll();
    expect(leeg.problemen().map((r) => [r.soort, r.fout, r.route])).toEqual([['onbekend-apparaat', 'niet-gekoppeld', 'mail'], ['onbekend-apparaat', 'niet-gekoppeld', 'mail']]);
    expect(leeg.mails()).toMatchObject([{ outcome: 'overig', note: TELEFOON_NOTE, moved_to: 'Verwerkt' }]);
    expect(leeg.n('SELECT COUNT(*) AS n FROM sync_ontvangen')).toBe(0);
  });

  it('MAILTEL-12 migratie en nooit verwijderen: de migratie (kolom route op sync_map_problemen, ALTER TABLE ADD COLUMN, bestaande rijen krijgen NULL en gelden als map) is relatief getest (oude toestand uit migrations.slice, findIndex op een zoektekst uit de nieuwe migratie), bestaande rijen overleven, user_version klopt; geen DELETE in de nieuwe code; de CHECK op mail_messages.outcome wordt niet aangeraakt (geen tabel opnieuw opbouwen)', () => {
    const zoek = 'ALTER TABLE sync_map_problemen';
    const i = migrations.findIndex((m) => m.includes(zoek));
    expect(i).toBeGreaterThan(0);
    expect(migrations.filter((m) => m.includes(zoek))).toHaveLength(1);
    expect(migrations[i]!).toMatch(/ALTER TABLE sync_map_problemen\s+ADD COLUMN\s+route TEXT/);
    expect(migrations[i]!).not.toMatch(/TRIGGER|DROP|DELETE|RENAME/i);
    expect(migrations[i]!).not.toMatch(/CREATE TABLE/i);
    const oud = new Database(':memory:');
    oud.pragma('foreign_keys = ON');
    for (const m of migrations.slice(0, i)) oud.exec(m);
    oud.pragma(`user_version = ${i}`);
    const kolommen = (tabel: string) => (oud.prepare(`PRAGMA table_info(${tabel})`).all() as { name: string }[]).map((k) => k.name);
    expect(kolommen('sync_map_problemen')).not.toContain('route');
    // bestaande rijen: een probleem van de bonnenmap, een gelezen map en een vastgelegde mail
    oud.exec(`INSERT INTO sync_map_problemen (bestandsnaam, soort, fout, tijd) VALUES ('oud.bvns', 'afgewezen', 'nummer-bezet', 1)`);
    oud.exec(`INSERT INTO mail_folders (folder, uid_validity, last_uid) VALUES ('INBOX', '1', 7)`);
    oud.exec(`INSERT INTO mail_messages (message_key, folder, uid, outcome) VALUES ('id:<a@x>', 'INBOX', 3, 'overig')`);
    const mailSql = () => (oud.prepare(`SELECT sql FROM sqlite_master WHERE name = 'mail_messages'`).get() as { sql: string }).sql;
    const voor = mailSql();
    migrate(oud);
    expect(oud.pragma('user_version', { simple: true })).toBe(migrations.length);
    expect(kolommen('sync_map_problemen').at(-1)).toBe('route');
    // bestaande rijen overleven en gelden als bonnenmap (NULL)
    expect(oud.prepare('SELECT bestandsnaam, soort, route FROM sync_map_problemen').all()).toEqual([{ bestandsnaam: 'oud.bvns', soort: 'afgewezen', route: null }]);
    expect(oud.prepare('SELECT folder, last_uid, telefoon_uid, telefoon_pogingen FROM mail_folders').all()).toEqual([{ folder: 'INBOX', last_uid: 7, telefoon_uid: null, telefoon_pogingen: 0 }]);
    expect(oud.prepare('SELECT message_key, outcome FROM mail_messages').all()).toEqual([{ message_key: 'id:<a@x>', outcome: 'overig' }]);
    // de CHECK op mail_messages.outcome is onaangeraakt
    expect(mailSql()).toBe(voor);
    expect(() => oud.exec(`INSERT INTO mail_messages (message_key, folder, uid, outcome) VALUES ('id:<b@x>', 'INBOX', 4, 'telefoonbericht')`)).toThrow();
    // de nieuwe code verwijdert niets uit het probleemregister of de synchronisatie
    for (const bestand of ['scanner/map-route.ts', 'scanner/receiver.ts']) expect(readFileSync(join(__dirname, '..', 'src', bestand), 'utf8'), bestand).not.toMatch(/DELETE FROM|INSERT OR REPLACE|REPLACE INTO|ON DELETE CASCADE/);
    // scanner.ts verwijdert alleen de instelling van de gekozen map (bestond al), niets uit het probleemregister of de synchronisatie
    expect([...readFileSync(join(__dirname, '..', 'src', 'scanner', 'scanner.ts'), 'utf8').matchAll(/DELETE FROM (\w+)/g)].map((x) => x[1])).toEqual(['settings']);
    const mailTekst = readFileSync(join(__dirname, '..', 'src', 'mail', 'mail-intake.ts'), 'utf8');
    expect([...mailTekst.matchAll(/DELETE FROM (\w+)/g)].map((x) => x[1])).toEqual(['mail_attachment_progress']);
    expect(mailTekst).not.toMatch(/INSERT OR REPLACE|REPLACE INTO|ON DELETE CASCADE/);
    oud.close();
  });
});
