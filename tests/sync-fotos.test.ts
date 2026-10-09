import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { leesFotoVelden, type Wijziging } from '@gratis-boekhouden/kern';
import { setup } from './helpers';
import { makeJpeg, makeJpegWithGps, GPS_POSITION } from './fixtures/jpeg';
import { migrate } from '../src/db/database';
import { migrations } from '../src/db/migrations';
import { isStoredAttachmentPath, relativizeAttachmentPaths, storedAttachmentPaths } from '../src/db/attachment-paths';
import { readJpegGps } from '../src/intake/exif';
import { createBackupBundle, missingAttachments, readBackupBundle, restoreCompleteBackup } from '../src/main/backup';
import { resolveAttachmentPath } from '../src/main/attachments';
import { RelationsService } from '../src/relations/relations';
import { Bonnenscanner } from '../src/scanner/scanner';
import { ScannerPairing } from '../src/scanner/pairing';
import { ReceiptSpool } from '../src/scanner/spool';
import { PHONE_SCANNER } from '../src/shared/phone-scanner';
import { CONTENT_TYPE, ENDPOINT_PATH, LIMITS, decodePairing, encodeFrame, openResponse, parseFrame, sealRequest } from '../src/scanner/protocol';
import { leesBevestigingen } from '../src/sync/bevestigingen';
import { WACHT_BYTES_LIMIET } from '../src/sync/fotos';
import { SyncOntvangst } from '../src/sync/ontvangst';
import { WACHTRIJ_LIMIET } from '../src/sync/wachtrij';

// De pc-kant van een foto van de telefoon bij een project (docs/bonnenscanner-protocol.md): entiteit foto, revisie 1,
// de JPEG's als bijlage. Echte databank, echte SyncOntvangst, SyncWachtrij en ProjectOntvangst, echte bestanden in een
// tijdelijke administratiemap, een eigen payload-bouwer en relatieve datums.

const LOOPBACK = [{ address: '127.0.0.1', netmask: '255.0.0.0' }];
const DAG = 24 * 60 * 60 * 1000;
const APPARAAT = 'apparaat-1';
const BRON = 'M1';
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const fotoVelden = (fotos: Buffer[]) => fotos.map((f) => ({ grootte: f.length, sha256: sha(f) }));
/** De velden van een fotowijziging: het project, een notitie en per foto grootte en sha256 van wat de telefoon stuurt. */
const velden = (project: string, fotos: Buffer[], over: Record<string, unknown> = {}): Record<string, unknown> => ({ project_uuid: project, notitie: 'Voor het schilderen', fotos: fotoVelden(fotos), ...over });
const pad = (uuid: string, volgnr: number) => `bijlagen/telefoon/${uuid}/${volgnr}.jpg`;
const n = (db: Database.Database, sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { n: number }).n;

const dirs: string[] = [];
const scanners: Bonnenscanner[] = [];
const databanken: Database.Database[] = [];
beforeEach(() => {
  PHONE_SCANNER.available = true;
});
afterEach(async () => {
  PHONE_SCANNER.available = false;
  for (const s of scanners.splice(0)) await s.stop();
  // Windows verwijdert een bestand niet zolang de databank het nog open heeft: eerst sluiten
  for (const db of databanken.splice(0)) {
    try {
      db.close();
    } catch {
      /* al gesloten */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function tijdelijkeMap(voorvoegsel: string): string {
  const d = mkdtempSync(join(tmpdir(), voorvoegsel));
  dirs.push(d);
  return d;
}

/** Alle bestanden onder een map, als relatieve paden met `/`. */
function bestandenIn(dir: string): string[] {
  const uit: string[] = [];
  const loop = (map: string, voor: string): void => {
    if (!statSync(map, { throwIfNoEntry: false })?.isDirectory()) return;
    for (const item of readdirSync(map, { withFileTypes: true })) {
      if (item.isDirectory()) loop(join(map, item.name), `${voor}${item.name}/`);
      else uit.push(`${voor}${item.name}`);
    }
  };
  loop(dir, '');
  return uit.sort();
}

function omgeving(opties: { keepLocation?: boolean; zonderAdminDir?: boolean; bestandsdatabank?: boolean } = {}) {
  const adminDir = tijdelijkeMap('bvn-sync-fotos-');
  const t = setup(opties.bestandsdatabank ? { db: new Database(join(adminDir, 'boekhouding.sqlite')) } : {});
  databanken.push(t.db);
  const logs: string[] = [];
  const blokkeer = { aan: false };
  const sync = new SyncOntvangst(t.db, new RelationsService(t.db), {
    now: () => Date.now(),
    log: (m) => logs.push(m),
    invoices: t.s.invoices,
    keepLocation: () => opties.keepLocation ?? false,
    ...(opties.zonderAdminDir
      ? {}
      : {
          adminDir,
          // een verwijdering die mislukt (bv. een map zonder schrijfrecht) wordt hier nagebootst, ook op Windows
          fotoVerwijderBestand: (p: string) => {
            if (blokkeer.aan) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
            try {
              unlinkSync(p);
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
            }
          },
        }),
  });
  const klant = (uuid: string, naam = 'Bakkerij De Korst', apparaat = APPARAAT) => sync.verwerk(apparaat, BRON, { entiteit: 'klant', uuid, revisie: 1, tijd: Date.now() - 5 * DAG, velden: { naam } });
  const project = (uuid: string, klantUuid: string, apparaat = APPARAAT) =>
    sync.verwerk(apparaat, BRON, { entiteit: 'project', uuid, revisie: 1, tijd: Date.now() - 4 * DAG, velden: { titel: 'Schilderwerk', klant: klantUuid } });
  /** een fotowijziging via SyncOntvangst.verwerk; `bijlagen` overschrijft wat er echt achter de JSON komt */
  const foto = (uuid: string, fotos: Buffer[], v: Record<string, unknown>, over: { revisie?: number; route?: string; apparaat?: string; bijlagen?: Buffer[] } = {}) => {
    const w: Wijziging = { entiteit: 'foto', uuid, revisie: over.revisie ?? 1, tijd: Date.now() - 3 * DAG, velden: v };
    return sync.verwerk(over.apparaat ?? APPARAAT, BRON, w, over.route ?? 'netwerk', over.bijlagen ?? fotos);
  };
  const bestanden = () => bestandenIn(join(adminDir, 'bijlagen')).map((b) => `bijlagen/${b}`);
  const telling = () => ({
    job_photos: n(t.db, 'SELECT COUNT(*) AS n FROM job_photos'),
    bijlagen: n(t.db, 'SELECT COUNT(*) AS n FROM sync_wachtrij_bijlagen'),
    wachtrij: n(t.db, 'SELECT COUNT(*) AS n FROM sync_wachtrij'),
    register: n(t.db, `SELECT COUNT(*) AS n FROM sync_ontvangen WHERE entiteit = 'foto'`),
    bestanden: bestanden().length,
  });
  const leeg = { job_photos: 0, bijlagen: 0, wachtrij: 0, register: 0, bestanden: 0 };
  const fotoRijen = (uuid: string) => t.db.prepare('SELECT * FROM job_photos WHERE wijziging_uuid = ? ORDER BY volgnr').all(uuid) as Record<string, unknown>[];
  const wachtrij = (uuid: string) => t.db.prepare(`SELECT * FROM sync_wachtrij WHERE entiteit = 'foto' AND uuid = ? ORDER BY id`).all(uuid) as Record<string, unknown>[];
  const register = (uuid: string) => t.db.prepare(`SELECT apparaat_id, uitkomst, fout, route FROM sync_ontvangen WHERE entiteit = 'foto' AND uuid = ? ORDER BY apparaat_id`).all(uuid);
  const inhoud = (rel: string) => readFileSync(join(adminDir, ...rel.split('/')));
  return { ...t, adminDir, sync, logs, blokkeer, klant, project, foto, bestanden, telling, leeg, fotoRijen, wachtrij, register, inhoud };
}
type Omg = ReturnType<typeof omgeving>;

/** Een bekend project (met zijn klant) in de administratie. */
function metProject(opties: Parameters<typeof omgeving>[0] = {}) {
  const o = omgeving(opties);
  const klantUuid = randomUUID();
  const projectUuid = randomUUID();
  expect(o.klant(klantUuid)).toMatchObject({ status: 200, uitkomst: 'toegepast' });
  expect(o.project(projectUuid, klantUuid)).toMatchObject({ status: 200, uitkomst: 'toegepast' });
  return { o, klantUuid, projectUuid };
}

/** De telefoon over het netwerk: een eigen payload-bouwer voor de wijziging met bijlagen. */
async function netwerkTelefoon(o: Omg) {
  const spoolDir = tijdelijkeMap('bvn-sync-fotos-spool-');
  const scanner = new Bonnenscanner({ db: o.db, secrets: o.secrets, intake: o.s.intake, settings: o.s.settings, spoolDir, adminDir: o.adminDir, interfaces: () => LOOPBACK });
  scanners.push(scanner);
  const gestart = await scanner.pair();
  const koppeling = decodePairing(gestart.payload);
  const sleutel = Buffer.from(koppeling.sleutel, 'base64url');
  const deviceId = Buffer.from(koppeling.apparaat, 'base64url');
  const url = `http://${koppeling.adressen[0]}:${koppeling.poort}${ENDPOINT_PATH}`;
  const stuur = async (json: Record<string, unknown>, bijlagen: Buffer[]) => {
    const nonce = randomBytes(12);
    const body = sealRequest(deviceId, sleutel, encodeFrame(json, bijlagen), nonce, 2);
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': CONTENT_TYPE }, body: new Uint8Array(body) });
    const antwoord = openResponse(Buffer.from(await res.arrayBuffer()), sleutel, nonce);
    return { status: res.status, json: antwoord };
  };
  return { apparaat: koppeling.apparaat, stuur };
}

describe('een foto van de telefoon bij een project op de pc', () => {
  it('FOTO-01 foto bij een bekend project: een wijziging met entiteit foto (revisie 1, velden project_uuid, notitie, fotos, JPEGs als bijlage) geeft 200 toegepast, een rij per foto in job_photos, de bestanden onder bijlagen/ en een registerrij met route netwerk; byte-voor-byte gelijk aan de bijlagen', async () => {
    const { o, klantUuid, projectUuid } = metProject();
    const telefoon = await netwerkTelefoon(o);
    expect(o.db.prepare('SELECT relation_id FROM jobs WHERE uuid = ?').pluck().get(projectUuid)).toBe(o.db.prepare('SELECT id FROM relations WHERE uuid = ?').pluck().get(klantUuid));
    const fotos = [makeJpeg('voor'), makeJpeg('na')];
    const uuid = randomUUID();
    const tijd = Date.now() - 2 * 60_000;
    const r = await telefoon.stuur({ soort: 'wijziging', tijd: Date.now(), wijziging: { entiteit: 'foto', uuid, revisie: 1, tijd, velden: velden(projectUuid, fotos) } }, fotos);
    expect(r).toMatchObject({ status: 200, json: { ok: true, soort: 'wijziging', entiteit: 'foto', uuid, revisie: 1, uitkomst: 'toegepast' } });
    const jobId = o.db.prepare('SELECT id FROM jobs WHERE uuid = ?').pluck().get(projectUuid) as number;
    const rijen = o.fotoRijen(uuid);
    expect(rijen).toHaveLength(2);
    rijen.forEach((rij, i) => {
      expect(rij).toMatchObject({ job_id: jobId, wijziging_uuid: uuid, volgnr: i + 1, file_path: pad(uuid, i + 1), sha256: sha(fotos[i]!), bytes: fotos[i]!.length, notitie: 'Voor het schilderen', tijd });
      expect(typeof rij.created_at).toBe('string');
      expect(o.inhoud(rij.file_path as string).equals(fotos[i]!)).toBe(true);
    });
    expect(o.bestanden()).toEqual([`bijlagen/telefoon/${uuid}/1.jpg`, `bijlagen/telefoon/${uuid}/2.jpg`]);
    expect(o.register(uuid)).toEqual([{ apparaat_id: telefoon.apparaat, uitkomst: 'toegepast', fout: null, route: 'netwerk' }]);
    expect(o.telling()).toMatchObject({ job_photos: 2, bijlagen: 0, wachtrij: 0, register: 1, bestanden: 2 });
    // het jsonc-voorbeeld in het protocoldocument is precies zo'n bericht, met de JPEG van 751 bytes als bijlage
    const doc = readFileSync(join(__dirname, '..', 'docs', 'bonnenscanner-protocol.md'), 'utf8').replace(/\r\n/g, '\n');
    const voorbeeld = JSON.parse(doc.match(/```jsonc\n(\{"soort":"wijziging"[^\n]*"entiteit":"foto"[^\n]*)\n```/)![1]!) as Record<string, unknown>;
    const voorbeeldFoto = makeJpeg('voorbeeld');
    const gelezen = parseFrame(encodeFrame(voorbeeld, [voorbeeldFoto]), 2);
    if (gelezen.soort !== 'wijziging') throw new Error('onverwacht: geen wijziging');
    expect(gelezen).toMatchObject({ wijziging: { entiteit: 'foto', revisie: 1 }, bijlagen: [voorbeeldFoto] });
    expect(voorbeeldFoto.length).toBe(751);
    expect(leesFotoVelden(gelezen.wijziging.velden)).toMatchObject({ ok: true, velden: { fotos: [{ grootte: 751, sha256: sha(voorbeeldFoto) }] } });
  });

  it('FOTO-02 herhaling en andere route: dezelfde wijziging opnieuw, en verwerk() met route map of mail op dezelfde sleutel, geeft overgeslagen en geen nieuwe rijen of bestanden', () => {
    const { o, projectUuid } = metProject();
    const fotos = [makeJpeg('een'), makeJpeg('twee')];
    const uuid = randomUUID();
    const v = velden(projectUuid, fotos);
    expect(o.foto(uuid, fotos, v)).toEqual({ status: 200, uitkomst: 'toegepast' });
    const na = o.telling();
    const bestanden = o.bestanden();
    const sporen = bestanden.map((b) => statSync(join(o.adminDir, ...b.split('/'))).mtimeMs);
    expect(o.foto(uuid, fotos, v)).toEqual({ status: 200, uitkomst: 'overgeslagen' });
    expect(o.foto(uuid, fotos, v, { route: 'map' })).toEqual({ status: 200, uitkomst: 'overgeslagen' });
    expect(o.foto(uuid, fotos, v, { route: 'mail' })).toEqual({ status: 200, uitkomst: 'overgeslagen' });
    expect(o.telling()).toEqual(na);
    expect(o.bestanden()).toEqual(bestanden);
    expect(bestanden.map((b) => statSync(join(o.adminDir, ...b.split('/'))).mtimeMs)).toEqual(sporen);
    expect(o.register(uuid)).toEqual([{ apparaat_id: APPARAAT, uitkomst: 'toegepast', fout: null, route: 'netwerk' }]);
  });

  it('FOTO-03 onbekend project wacht: 200 wacht, een wachtrijrij (wacht_op_entiteit project, reden project-onbekend), de bestanden staan al op schijf met een verwijzing in sync_wachtrij_bijlagen (geen bytes in de wachtrij), geen job_photos-rij en geen registerrij', () => {
    const o = omgeving();
    const projectUuid = randomUUID();
    const fotos = [makeJpeg('wachtend 1'), makeJpeg('wachtend 2')];
    const uuid = randomUUID();
    const v = velden(projectUuid, fotos);
    expect(o.foto(uuid, fotos, v, { route: 'map' })).toEqual({ status: 200, uitkomst: 'wacht' });
    const rijen = o.wachtrij(uuid);
    expect(rijen).toHaveLength(1);
    expect(rijen[0]).toMatchObject({ apparaat_id: APPARAAT, bron: BRON, entiteit: 'foto', uuid, revisie: 1, wacht_op_entiteit: 'project', wacht_op_uuid: projectUuid, reden: 'project-onbekend', route: 'map', verwerkt_op: null });
    // de wachtrij bewaart alleen de velden (grootte en sha256), nooit de bytes
    const opgeslagen = JSON.parse(rijen[0]!.wijziging as string) as { velden: { fotos: unknown } };
    expect(opgeslagen.velden.fotos).toEqual(fotoVelden(fotos));
    expect((rijen[0]!.wijziging as string).length).toBeLessThan(2000);
    for (const f of fotos) expect((rijen[0]!.wijziging as string).includes(f.toString('base64').slice(0, 80))).toBe(false);
    // de bestanden staan er al, met een verwijzing per bestand
    const verwijzingen = o.db.prepare('SELECT volgnr, file_path, sha256, bytes FROM sync_wachtrij_bijlagen WHERE wachtrij_id = ? ORDER BY volgnr').all(rijen[0]!.id);
    expect(verwijzingen).toEqual(fotos.map((f, i) => ({ volgnr: i + 1, file_path: pad(uuid, i + 1), sha256: sha(f), bytes: f.length })));
    expect(o.bestanden()).toEqual([`bijlagen/telefoon/${uuid}/1.jpg`, `bijlagen/telefoon/${uuid}/2.jpg`]);
    expect(o.inhoud(pad(uuid, 1)).equals(fotos[0]!)).toBe(true);
    expect(o.telling()).toEqual({ job_photos: 0, bijlagen: 2, wachtrij: 1, register: 0, bestanden: 2 });
    // dezelfde wijziging nog eens: nog steeds een rij en geen nieuwe bestanden
    expect(o.foto(uuid, fotos, v)).toEqual({ status: 200, uitkomst: 'wacht' });
    expect(o.telling()).toEqual({ job_photos: 0, bijlagen: 2, wachtrij: 1, register: 0, bestanden: 2 });

    // de wachtende bestanden zijn ook in bytes begrensd (per apparaat): een apparaat dat de limiet vol zet krijgt 503
    // zonder rij en zonder bestanden, een ander apparaat niet; na afhandelen (het project komt) is er weer ruimte
    const klantUuid = randomUUID();
    const vulProject = randomUUID();
    o.db.prepare(`INSERT INTO sync_wachtrij (apparaat_id, bron, entiteit, uuid, revisie, tijd, wijziging, wacht_op_entiteit, wacht_op_uuid, reden, ontvangen_op) VALUES (?, ?, 'project', ?, 1, 5, '{}', 'klant', ?, 'klant-onbekend', 6)`).run(APPARAAT, BRON, vulProject, klantUuid);
    const vulId = o.db.prepare('SELECT id FROM sync_wachtrij WHERE uuid = ?').pluck().get(vulProject) as number;
    const eigen = fotos.reduce((som, f) => som + f.length, 0);
    o.db.prepare('INSERT INTO sync_wachtrij_bijlagen (wachtrij_id, volgnr, file_path, sha256, bytes) VALUES (?, 1, ?, ?, ?)').run(vulId, 'bijlagen/telefoon/vulling/1.jpg', 'x'.repeat(64), WACHT_BYTES_LIMIET - eigen);
    const voorBytes = o.telling();
    const extra = [makeJpeg('past net niet')];
    const volUuid = randomUUID();
    expect(o.foto(volUuid, extra, velden(randomUUID(), extra))).toEqual({ status: 503, fout: 'wachtrij-vol' });
    expect(o.wachtrij(volUuid)).toHaveLength(0);
    expect(o.telling()).toEqual(voorBytes);
    // een ander apparaat heeft zijn eigen ruimte
    const ander = randomUUID();
    expect(o.foto(ander, extra, velden(randomUUID(), extra), { apparaat: 'apparaat-2' })).toEqual({ status: 200, uitkomst: 'wacht' });
    // de klant komt: de vulrij wordt afgehandeld en de wachtende bytes tellen niet meer mee
    expect(o.klant(klantUuid)).toMatchObject({ uitkomst: 'toegepast' });
    expect(o.db.prepare('SELECT verwerkt_op FROM sync_wachtrij WHERE id = ?').pluck().get(vulId)).not.toBeNull();
    expect(o.foto(volUuid, extra, velden(randomUUID(), extra))).toEqual({ status: 200, uitkomst: 'wacht' });

    // een foto die NA de afwijzing van het project aankomt, wacht niet: direct afgewezen met een registerrij, zonder
    // wachtrijrij en zonder bestanden; een ander apparaat voor dezelfde project-uuid blijft wachten
    const leverancier = o.s.relations.create({ name: 'Bouwmarkt', type: 'leverancier' });
    const leverancierUuid = o.db.prepare('SELECT uuid FROM relations WHERE id = ?').pluck().get(leverancier.id) as string;
    const afgewezenProject = randomUUID();
    expect(o.project(afgewezenProject, leverancierUuid)).toEqual({ status: 200, uitkomst: 'afgewezen', fout: 'geen-klant' });
    const laat = [makeJpeg('na afwijzing')];
    const laatUuid = randomUUID();
    const voorLaat = o.telling();
    expect(o.foto(laatUuid, laat, velden(afgewezenProject, laat))).toEqual({ status: 200, uitkomst: 'afgewezen', fout: 'project-afgewezen' });
    expect(o.register(laatUuid)).toEqual([{ apparaat_id: APPARAAT, uitkomst: 'afgewezen', fout: 'project-afgewezen', route: 'netwerk' }]);
    expect(o.wachtrij(laatUuid)).toHaveLength(0);
    expect(o.telling()).toEqual({ ...voorLaat, register: voorLaat.register + 1 });
    expect(o.bestanden().some((b) => b.includes(laatUuid))).toBe(false);
    expect(o.foto(laatUuid, laat, velden(afgewezenProject, laat))).toEqual({ status: 200, uitkomst: 'afgewezen', fout: 'project-afgewezen' });
    expect(o.telling()).toEqual({ ...voorLaat, register: voorLaat.register + 1 });
    expect(o.foto(randomUUID(), laat, velden(afgewezenProject, laat), { apparaat: 'apparaat-2' })).toEqual({ status: 200, uitkomst: 'wacht' });
  });

  it('FOTO-04 project komt binnen: zodra het project is toegepast wordt de wachtende foto in dezelfde verwerking overgenomen (job_photos, registerrij toegepast, wachtrijrij afgehandeld met bevestigingsnummer) zonder dat de bestanden verplaatst of gedupliceerd worden', () => {
    const o = omgeving();
    const klantUuid = randomUUID();
    const projectUuid = randomUUID();
    expect(o.klant(klantUuid)).toMatchObject({ uitkomst: 'toegepast' });
    const fotos = [makeJpeg('later 1'), makeJpeg('later 2'), makeJpeg('later 3')];
    const uuid = randomUUID();
    expect(o.foto(uuid, fotos, velden(projectUuid, fotos))).toEqual({ status: 200, uitkomst: 'wacht' });
    const voor = o.bestanden().map((b) => ({ b, ino: statSync(join(o.adminDir, ...b.split('/'))).ino }));
    expect(o.fotoRijen(uuid)).toHaveLength(0);
    // het project komt binnen: de foto wordt in dezelfde verwerking overgenomen
    expect(o.project(projectUuid, klantUuid)).toEqual({ status: 200, uitkomst: 'toegepast' });
    const jobId = o.db.prepare('SELECT id FROM jobs WHERE uuid = ?').pluck().get(projectUuid) as number;
    expect(o.fotoRijen(uuid).map((r) => ({ job_id: r.job_id, volgnr: r.volgnr, file_path: r.file_path, sha256: r.sha256 }))).toEqual(fotos.map((f, i) => ({ job_id: jobId, volgnr: i + 1, file_path: pad(uuid, i + 1), sha256: sha(f) })));
    expect(o.register(uuid)).toEqual([{ apparaat_id: APPARAAT, uitkomst: 'toegepast', fout: null, route: 'netwerk' }]);
    const rij = o.wachtrij(uuid)[0]!;
    expect(rij).toMatchObject({ verwerkt_uitkomst: 'toegepast', verwerkt_reden: null });
    expect(rij.verwerkt_op).not.toBeNull();
    expect(typeof rij.verwerkt_seq).toBe('number');
    // dezelfde bestanden op dezelfde plek: niet verplaatst, niet gedupliceerd
    expect(o.bestanden()).toEqual(voor.map((v) => v.b));
    expect(o.bestanden().map((b) => statSync(join(o.adminDir, ...b.split('/'))).ino)).toEqual(voor.map((v) => v.ino));
    expect(o.telling()).toEqual({ job_photos: 3, bijlagen: 3, wachtrij: 1, register: 1, bestanden: 3 });
    // en nog eens verwerken verandert niets
    o.sync.verwerkWachtrij();
    expect(o.telling()).toEqual({ job_photos: 3, bijlagen: 3, wachtrij: 1, register: 1, bestanden: 3 });
  });

  it('FOTO-05 klant achter het project onbekend: een project dat zelf nog op zijn klant wacht houdt de foto ook wachtend; komt de klant, dan zijn project en foto beide toegepast (cascade)', () => {
    const o = omgeving();
    const klantUuid = randomUUID();
    const projectUuid = randomUUID();
    expect(o.project(projectUuid, klantUuid)).toEqual({ status: 200, uitkomst: 'wacht' });
    const fotos = [makeJpeg('cascade')];
    const uuid = randomUUID();
    expect(o.foto(uuid, fotos, velden(projectUuid, fotos))).toEqual({ status: 200, uitkomst: 'wacht' });
    o.sync.verwerkWachtrij();
    expect(o.db.prepare('SELECT 1 FROM jobs WHERE uuid = ?').get(projectUuid)).toBeUndefined();
    expect(o.fotoRijen(uuid)).toHaveLength(0);
    expect(o.wachtrij(uuid)[0]).toMatchObject({ wacht_op_entiteit: 'project', wacht_op_uuid: projectUuid, verwerkt_op: null });
    // de klant komt: het project en daarna de foto, in een verwerking
    expect(o.klant(klantUuid)).toEqual({ status: 200, uitkomst: 'toegepast' });
    const job = o.db.prepare('SELECT id, relation_id FROM jobs WHERE uuid = ?').get(projectUuid) as { id: number; relation_id: number };
    expect(job.relation_id).toBe(o.db.prepare('SELECT id FROM relations WHERE uuid = ?').pluck().get(klantUuid));
    expect(o.fotoRijen(uuid)).toMatchObject([{ job_id: job.id, file_path: pad(uuid, 1), sha256: sha(fotos[0]!) }]);
    expect(o.register(uuid)).toEqual([{ apparaat_id: APPARAAT, uitkomst: 'toegepast', fout: null, route: 'netwerk' }]);
    expect(o.wachtrij(uuid)[0]).toMatchObject({ verwerkt_uitkomst: 'toegepast' });
    expect(o.bestanden()).toEqual([pad(uuid, 1)]);
  });

  it('FOTO-06 controles: groottes, sha256, aantal (1 tot 10), JPEG-inhoud, projectreferentie (geen uuid) en onbekende velden geven dezelfde 400s als bij de bon; boven maxPhotoBytes 413 te-groot, ook via map en mail; er blijven geen rijen en geen bestanden achter', () => {
    const o = omgeving();
    const onbekend = randomUUID(); // een onbekend project: een fout mag ook daar nooit in de wachtrij of op schijf komen
    const bekend = metProject();
    const fotos = [makeJpeg('controle 1'), makeJpeg('controle 2')];
    for (const project of [onbekend, bekend.projectUuid]) {
      const omg = project === onbekend ? o : bekend.o;
      const uuid = () => randomUUID();
      const fout = (v: Record<string, unknown>, bijlagen: Buffer[] = fotos, route = 'netwerk') => omg.foto(uuid(), fotos, v, { bijlagen, route });
      const goed = velden(project, fotos);
      // grootte of sha256 die niet bij de bijlage past
      expect(fout({ ...goed, fotos: [{ grootte: fotos[0]!.length + 1, sha256: sha(fotos[0]!) }, fotoVelden(fotos)[1]] })).toMatchObject({ status: 400, fout: 'ongeldig' });
      expect(fout({ ...goed, fotos: [{ grootte: fotos[0]!.length, sha256: sha(fotos[1]!) }, fotoVelden(fotos)[1]] })).toMatchObject({ status: 400, fout: 'ongeldig' });
      // het aantal: minder of meer bijlagen dan fotos, geen foto's, meer dan het maximum
      expect(fout(goed, [fotos[0]!])).toMatchObject({ status: 400, fout: 'ongeldig' });
      expect(fout({ ...goed, fotos: [] }, [])).toMatchObject({ status: 400, fout: 'veld-ongeldig', veld: 'fotos' });
      const veel = Array.from({ length: LIMITS.maxPhotos + 1 }, (_, i) => makeJpeg(`veel ${i}`));
      expect(fout(velden(project, veel), veel)).toMatchObject({ status: 400, fout: 'ongeldig' });
      // geen JPEG, ook al kloppen grootte en sha256
      const geenJpeg = Buffer.from('dit is geen jpeg maar tekst');
      expect(fout(velden(project, [geenJpeg]), [geenJpeg])).toMatchObject({ status: 400, fout: 'ongeldig' });
      // de projectreferentie en onbekende velden (ook __proto__)
      expect(fout({ ...goed, project_uuid: 'geen-uuid' })).toMatchObject({ status: 400, fout: 'veld-ongeldig', veld: 'project_uuid' });
      expect(fout({ ...goed, project_uuid: project.toUpperCase() })).toMatchObject({ status: 400, fout: 'veld-ongeldig', veld: 'project_uuid' });
      expect(fout({ ...goed, extra: 1 })).toMatchObject({ status: 400, fout: 'veld-ongeldig', veld: 'extra' });
      expect(fout(JSON.parse(`{"project_uuid":"${project}","fotos":${JSON.stringify(fotoVelden(fotos))},"__proto__":{"x":1}}`) as Record<string, unknown>)).toMatchObject({ status: 400, fout: 'veld-ongeldig', veld: '__proto__' });
      // te groot: de bijlagen samen, en de JSON op de ruwe velden (een notitie die de kern pas daarna zou afkappen); ook via map en mail
      const groot = [0, 1, 2].map(() => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(Math.ceil(LIMITS.maxPhotoBytes / 2.5))]));
      for (const route of ['netwerk', 'map', 'mail']) {
        expect(fout(velden(project, groot), groot, route)).toMatchObject({ status: 413, fout: 'te-groot' });
        expect(fout({ ...goed, notitie: 'x'.repeat(LIMITS.maxWijzigingJsonBytes + 1) }, fotos, route)).toMatchObject({ status: 413, fout: 'te-groot' });
      }
      expect(omg.telling()).toEqual(omg.leeg);
    }
    expect(o.telling()).toEqual(o.leeg);
    expect(bekend.o.telling()).toEqual(bekend.o.leeg);
  });

  it('FOTO-07 nooit bewerken of verwijderen: een tweede revisie is een vormfout, dezelfde uuid met andere inhoud geeft afgewezen id-botst (de eerste inhoud blijft) en er is geen enkel pad in de code dat een foto of zijn bestand wijzigt of verwijdert', () => {
    const { o, projectUuid } = metProject();
    const fotos = [makeJpeg('eerste inhoud')];
    const uuid = randomUUID();
    expect(o.foto(uuid, fotos, velden(projectUuid, fotos))).toEqual({ status: 200, uitkomst: 'toegepast' });
    const eerste = o.fotoRijen(uuid);
    // een tweede revisie: vormfout, geen rij
    expect(o.foto(uuid, fotos, velden(projectUuid, fotos), { revisie: 2 })).toMatchObject({ status: 400, fout: 'ongeldig' });
    expect(o.foto(randomUUID(), fotos, velden(projectUuid, fotos), { revisie: 2 })).toMatchObject({ status: 400, fout: 'ongeldig' });
    // dezelfde uuid met andere inhoud: van een ander apparaat en van hetzelfde apparaat; de eerste inhoud blijft
    const andere = [makeJpeg('andere inhoud')];
    expect(o.foto(uuid, andere, velden(projectUuid, andere), { apparaat: 'apparaat-2' })).toEqual({ status: 200, uitkomst: 'afgewezen', fout: 'id-botst' });
    expect(o.foto(uuid, andere, velden(projectUuid, andere), { apparaat: 'apparaat-2' })).toEqual({ status: 200, uitkomst: 'afgewezen', fout: 'id-botst' });
    expect(o.foto(uuid, andere, velden(projectUuid, andere))).toEqual({ status: 200, uitkomst: 'afgewezen', fout: 'id-botst' });
    expect(o.register(uuid)).toEqual([
      { apparaat_id: APPARAAT, uitkomst: 'toegepast', fout: null, route: 'netwerk' },
      { apparaat_id: 'apparaat-2', uitkomst: 'afgewezen', fout: 'id-botst', route: 'netwerk' },
    ]);
    expect(o.fotoRijen(uuid)).toEqual(eerste);
    expect(o.inhoud(pad(uuid, 1)).equals(fotos[0]!)).toBe(true);
    // dezelfde inhoud van een ander apparaat is geen botsing: overgeslagen, zonder nieuwe rij of bestand
    expect(o.foto(uuid, fotos, velden(projectUuid, fotos), { apparaat: 'apparaat-3' })).toEqual({ status: 200, uitkomst: 'overgeslagen' });
    expect(o.telling()).toMatchObject({ job_photos: 1, bestanden: 1, wachtrij: 0 });
    // de code: nergens een opdracht die job_photos of de verwijzingen van de wachtrij verwijdert, wijzigt of vervangt
    const bronnen: string[] = [];
    const loop = (map: string): void => {
      for (const item of readdirSync(map, { withFileTypes: true })) {
        if (item.isDirectory()) loop(join(map, item.name));
        else if (item.name.endsWith('.ts')) bronnen.push(join(map, item.name));
      }
    };
    loop(join(__dirname, '..', 'src'));
    expect(bronnen.length).toBeGreaterThan(20);
    const tabel = '(job_photos|sync_wachtrij_bijlagen)';
    const verboden = [new RegExp(`${'DELE'}${'TE'}\\s+FROM\\s+${tabel}`, 'i'), new RegExp(`UPDATE\\s+${tabel}`, 'i'), new RegExp(`${'REPLA'}${'CE'}\\s+INTO\\s+${tabel}`, 'i'), new RegExp(`INSERT\\s+OR\\s+${'REPLA'}${'CE'}\\s+INTO\\s+${tabel}`, 'i')];
    for (const bron of bronnen) {
      const tekst = readFileSync(bron, 'utf8');
      // relativizeAttachmentPaths schrijft het pad van een oudere versie om (alleen tekst, de bestanden blijven); verder niets
      if (bron.endsWith('attachment-paths.ts')) continue;
      for (const re of verboden) expect(re.test(tekst), `${bron} ${re}`).toBe(false);
    }
    expect(readFileSync(join(__dirname, '..', 'src', 'sync', 'fotos.ts'), 'utf8')).toContain('INSERT INTO job_photos');
  });

  it('FOTO-08 atomair: een geforceerde fout bij het opslaan (databank of bestand) geeft 500 opslaan-mislukt en laat geen rij en geen los bestand achter; mislukt het verwijderen van het bestand bij het terugdraaien, dan wordt het onthouden en nooit een foto; daarna werkt dezelfde wijziging gewoon', () => {
    const { o, projectUuid, klantUuid } = metProject();
    const fotos = [makeJpeg('half 1'), makeJpeg('half 2')];
    const w = () => ({ uuid: randomUUID(), v: velden(projectUuid, fotos, { notitie: 'geheime notitie' }) });
    const mislukt = { status: 500, fout: 'opslaan-mislukt' };
    // 1. de databank weigert de fotorij, nadat de bestanden al staan
    const a = w();
    o.db.exec(`CREATE TRIGGER test_foto_kapot BEFORE INSERT ON job_photos BEGIN SELECT RAISE(ABORT, 'kapot'); END`);
    expect(o.foto(a.uuid, fotos, a.v)).toEqual(mislukt);
    expect(o.telling()).toEqual(o.leeg);
    o.db.exec('DROP TRIGGER test_foto_kapot');
    // 2. de databank weigert de registerrij, nadat de bestanden en de fotorijen er al zijn
    o.db.exec(`CREATE TRIGGER test_register_kapot BEFORE INSERT ON sync_ontvangen BEGIN SELECT RAISE(ABORT, 'kapot'); END`);
    expect(o.foto(a.uuid, fotos, a.v)).toEqual(mislukt);
    expect(o.telling()).toEqual(o.leeg);
    o.db.exec('DROP TRIGGER test_register_kapot');
    // 3. wachtend: de databank weigert de verwijzingen, nadat de wachtrijrij en de bestanden er al zijn
    const onbekend = randomUUID();
    o.db.exec(`CREATE TRIGGER test_bijlagen_kapot BEFORE INSERT ON sync_wachtrij_bijlagen BEGIN SELECT RAISE(ABORT, 'kapot'); END`);
    expect(o.foto(a.uuid, fotos, velden(onbekend, fotos))).toEqual(mislukt);
    expect(o.telling()).toEqual(o.leeg);
    o.db.exec('DROP TRIGGER test_bijlagen_kapot');
    // 4. het bestand kan niet geschreven worden (bijlagen is een bestand in plaats van een map)
    const kapot = omgeving();
    writeFileSync(join(kapot.adminDir, 'bijlagen'), 'geen map');
    const klant = randomUUID();
    const project = randomUUID();
    kapot.klant(klant);
    kapot.project(project, klant);
    expect(kapot.foto(a.uuid, fotos, velden(project, fotos))).toEqual(mislukt);
    expect(kapot.telling()).toMatchObject({ job_photos: 0, bijlagen: 0, wachtrij: 0, register: 0 });
    // nooit inhoud of een pad in het logboek
    expect(o.logs.length).toBeGreaterThanOrEqual(3);
    for (const regel of [...o.logs, ...kapot.logs]) expect(regel).not.toMatch(/geheime notitie|telefoon\/|bijlagen\//);
    // een crash midden in het schrijven laat hoogstens een tijdelijk bestand achter (nooit een half bestand onder de
    // echte naam), en dat blokkeert een volgende poging niet: de nieuwe poging kiest een eigen, willekeurige tijdelijke naam
    // (het achtergebleven bestand blijft ongemoeid staan)
    const staleMap = join(o.adminDir, 'bijlagen', 'telefoon', a.uuid);
    mkdirSync(staleMap, { recursive: true });
    writeFileSync(join(staleMap, '1.jpg.tmp'), 'half geschreven bij een crash');
    // daarna werkt dezelfde wijziging gewoon, precies een keer
    expect(o.foto(a.uuid, fotos, a.v)).toEqual({ status: 200, uitkomst: 'toegepast' });
    expect(o.foto(a.uuid, fotos, a.v)).toEqual({ status: 200, uitkomst: 'overgeslagen' });
    expect(o.telling()).toEqual({ job_photos: 2, bijlagen: 0, wachtrij: 0, register: 1, bestanden: 3 });
    expect(readFileSync(join(staleMap, '1.jpg')).length).toBeGreaterThan(30);
    expect(readFileSync(join(staleMap, '1.jpg.tmp'), 'utf8')).toBe('half geschreven bij een crash');
    expect(bestandenIn(staleMap).filter((f) => f.endsWith('.tmp'))).toEqual(['1.jpg.tmp']);

    // 5. het terugdraaien zelf mislukt: de bestanden kunnen niet verwijderd worden. Dat verdwijnt niet stil: ze blijven
    // staan zonder rij (nooit een foto), worden onthouden, en gaan weg zodra het kan
    const b = w();
    const voor = o.telling();
    o.blokkeer.aan = true;
    o.db.exec(`CREATE TRIGGER test_register_kapot2 BEFORE INSERT ON sync_ontvangen BEGIN SELECT RAISE(ABORT, 'kapot'); END`);
    expect(o.foto(b.uuid, fotos, b.v, { route: 'map' })).toEqual(mislukt);
    o.db.exec('DROP TRIGGER test_register_kapot2');
    expect(o.telling()).toEqual({ ...voor, bestanden: voor.bestanden + 2 });
    expect(o.fotoRijen(b.uuid)).toHaveLength(0);
    expect(o.logs.some((r) => /verwijder/i.test(r))).toBe(true);
    for (const regel of o.logs) expect(regel).not.toMatch(/geheime notitie|telefoon\/|bijlagen\//);
    // zolang het verwijderen niet lukt blijven ze staan, en er is nog steeds geen foto
    o.sync.verwerkWachtrij();
    expect(o.telling()).toEqual({ ...voor, bestanden: voor.bestanden + 2 });
    o.blokkeer.aan = false;
    o.sync.verwerkWachtrij();
    expect(o.telling()).toEqual(voor);
    expect(o.fotoRijen(b.uuid)).toHaveLength(0);
    // een achtergebleven bestand dat daarna bij een geslaagde ontvangst hoort, wordt nooit meer weggehaald
    const c = w();
    o.blokkeer.aan = true;
    o.db.exec(`CREATE TRIGGER test_register_kapot3 BEFORE INSERT ON sync_ontvangen BEGIN SELECT RAISE(ABORT, 'kapot'); END`);
    expect(o.foto(c.uuid, fotos, c.v)).toEqual(mislukt);
    o.db.exec('DROP TRIGGER test_register_kapot3');
    expect(o.telling().bestanden).toBe(voor.bestanden + 2);
    // de herhaling neemt de achtergebleven bestanden (zelfde inhoud) over in plaats van ze te vervangen
    expect(o.foto(c.uuid, fotos, c.v)).toEqual({ status: 200, uitkomst: 'toegepast' });
    o.blokkeer.aan = false;
    o.sync.verwerkWachtrij();
    expect(o.fotoRijen(c.uuid)).toHaveLength(2);
    expect(o.inhoud(pad(c.uuid, 2)).equals(fotos[1]!)).toBe(true);
    expect(o.telling()).toEqual({ ...voor, job_photos: voor.job_photos + 2, register: voor.register + 1, bestanden: voor.bestanden + 2 });
    // en een bestand van een ander dan dezelfde inhoud op dezelfde plek wordt nooit overschreven
    const d = w();
    mkdirSync(join(o.adminDir, 'bijlagen', 'telefoon', d.uuid), { recursive: true });
    writeFileSync(join(o.adminDir, ...pad(d.uuid, 1).split('/')), 'iets anders');
    expect(o.foto(d.uuid, fotos, d.v)).toEqual(mislukt);
    expect(readFileSync(join(o.adminDir, ...pad(d.uuid, 1).split('/')), 'utf8')).toBe('iets anders');
    expect(o.fotoRijen(d.uuid)).toHaveLength(0);


    // 6. een leesfout bij het overnemen van een wachtende foto (hier: de map van het bestand is een bestand geworden)
    // komt in het logboek met alleen de foutcode, nooit met het absolute pad van het bestand
    const wachtUuid = randomUUID();
    const wachtProject = randomUUID();
    expect(o.foto(wachtUuid, fotos, velden(wachtProject, fotos))).toEqual({ status: 200, uitkomst: 'wacht' });
    const wachtMap = join(o.adminDir, 'bijlagen', 'telefoon', wachtUuid);
    rmSync(wachtMap, { recursive: true, force: true });
    writeFileSync(wachtMap, 'geen map');
    o.logs.length = 0;
    o.project(wachtProject, klantUuid);
    for (const regel of o.logs) {
      expect(regel).not.toContain(o.adminDir);
      expect(regel).not.toMatch(/telefoon\/|bijlagen\/|'\//);
    }
    expect(o.fotoRijen(wachtUuid)).toHaveLength(0);

    // 7. het tijdelijke bestand heeft een onvoorspelbare naam en volgt nooit een symlink: een symlink op de oude,
    // voorspelbare naam <foto>.tmp naar een bestand buiten de fotomap laat dat bestand ongemoeid en de foto komt gewoon binnen
    const doel = join(tijdelijkeMap('bvn-sync-fotos-buiten-'), 'doel.txt');
    writeFileSync(doel, 'niet aanraken');
    const linkUuid = randomUUID();
    const linkFoto = [makeJpeg('symlink')];
    const linkAbs = resolveAttachmentPath(o.adminDir, pad(linkUuid, 1));
    mkdirSync(join(linkAbs, '..'), { recursive: true });
    let linkGelegd = true;
    try {
      symlinkSync(doel, `${linkAbs}.tmp`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EPERM') throw e;
      linkGelegd = false; // Windows zonder symlink-recht: alleen de unieke naam testen
    }
    expect(o.foto(linkUuid, linkFoto, velden(projectUuid, linkFoto))).toEqual({ status: 200, uitkomst: 'toegepast' });
    expect(readFileSync(doel, 'utf8')).toBe('niet aanraken');
    expect(o.inhoud(pad(linkUuid, 1)).equals(linkFoto[0]!)).toBe(true);
    expect(lstatSync(linkAbs).isSymbolicLink()).toBe(false);
    const restanten = readdirSync(join(linkAbs, '..')).filter((f) => f.endsWith('.tmp'));
    expect(restanten).toEqual(linkGelegd ? ['1.jpg.tmp'] : []);
  });

  it('FOTO-09 locatie: GPS in de JPEG wordt gestript tenzij keepLocation; de sha256 in de velden is die van wat de telefoon stuurde, de sha256 in job_photos die van wat is bewaard', () => {
    const foto = makeJpegWithGps('met locatie');
    expect(readJpegGps(foto)).not.toBeNull();
    // zonder toestemming: gestript, bekend project en wachtend
    const zonder = metProject({ keepLocation: false });
    const uuid1 = randomUUID();
    expect(zonder.o.foto(uuid1, [foto], velden(zonder.projectUuid, [foto]))).toEqual({ status: 200, uitkomst: 'toegepast' });
    const rij1 = zonder.o.fotoRijen(uuid1)[0]!;
    const bewaard1 = zonder.o.inhoud(rij1.file_path as string);
    expect(readJpegGps(bewaard1)).toBeNull();
    expect(bewaard1.equals(foto)).toBe(false);
    expect(rij1.sha256).toBe(sha(bewaard1));
    expect(rij1.sha256).not.toBe(sha(foto));
    expect(rij1.bytes).toBe(bewaard1.length);
    // de sha256 in de velden (van wat de telefoon stuurde) is een andere dan die van het bewaarde bestand
    expect(fotoVelden([foto])[0]!.sha256).toBe(sha(foto));
    const onbekend = randomUUID();
    const uuid2 = randomUUID();
    expect(zonder.o.foto(uuid2, [foto], velden(onbekend, [foto]))).toEqual({ status: 200, uitkomst: 'wacht' });
    const verwijzing = zonder.o.db.prepare('SELECT sha256, file_path FROM sync_wachtrij_bijlagen').get() as { sha256: string; file_path: string };
    expect(readJpegGps(zonder.o.inhoud(verwijzing.file_path))).toBeNull();
    expect(verwijzing.sha256).toBe(sha(zonder.o.inhoud(verwijzing.file_path)));
    expect(verwijzing.sha256).not.toBe(sha(foto));
    // een herhaling met de GPS-foto is gewoon een herhaling
    expect(zonder.o.foto(uuid1, [foto], velden(zonder.projectUuid, [foto]))).toEqual({ status: 200, uitkomst: 'overgeslagen' });
    // met toestemming: byte voor byte bewaard, ook met de positie
    const met = metProject({ keepLocation: true });
    const uuid3 = randomUUID();
    expect(met.o.foto(uuid3, [foto], velden(met.projectUuid, [foto]))).toEqual({ status: 200, uitkomst: 'toegepast' });
    const rij3 = met.o.fotoRijen(uuid3)[0]!;
    const bewaard3 = met.o.inhoud(rij3.file_path as string);
    expect(bewaard3.equals(foto)).toBe(true);
    expect(rij3.sha256).toBe(sha(foto));
    const gps = readJpegGps(bewaard3)!;
    expect(gps.lat).toBeCloseTo(GPS_POSITION.lat, 3);
    expect(gps.lon).toBeCloseTo(GPS_POSITION.lon, 3);

    // dezelfde foto van een tweede apparaat na een wijziging van de locatie-instelling: het bestaande bestand blijft
    // leidend (beide richtingen), er komt een registerrij voor het tweede apparaat en de sha256 in job_photos / de wachtrij
    // is die van wat echt bewaard is
    for (const eerst of [false, true]) {
      const opties = { keepLocation: eerst };
      const { o, projectUuid } = metProject(opties);
      const uuid = randomUUID();
      const v = velden(projectUuid, [foto]);
      expect(o.foto(uuid, [foto], v)).toEqual({ status: 200, uitkomst: 'toegepast' });
      const bewaard = o.inhoud(pad(uuid, 1));
      opties.keepLocation = !eerst;
      expect(o.foto(uuid, [foto], v, { apparaat: 'apparaat-2' })).toEqual({ status: 200, uitkomst: 'overgeslagen' });
      expect(o.register(uuid)).toEqual([
        { apparaat_id: APPARAAT, uitkomst: 'toegepast', fout: null, route: 'netwerk' },
        { apparaat_id: 'apparaat-2', uitkomst: 'overgeslagen', fout: null, route: 'netwerk' },
      ]);
      expect(o.inhoud(pad(uuid, 1)).equals(bewaard)).toBe(true);
      expect(o.fotoRijen(uuid).map((r) => ({ sha256: r.sha256, bytes: r.bytes }))).toEqual([{ sha256: sha(bewaard), bytes: bewaard.length }]);
      // wachtend: apparaat A (onbekend project) en daarna apparaat B met de andere instelling
      const wachtUuid = randomUUID();
      const onbekend = randomUUID();
      opties.keepLocation = eerst;
      expect(o.foto(wachtUuid, [foto], velden(onbekend, [foto]))).toEqual({ status: 200, uitkomst: 'wacht' });
      const eerste = o.inhoud(pad(wachtUuid, 1));
      opties.keepLocation = !eerst;
      expect(o.foto(wachtUuid, [foto], velden(onbekend, [foto]), { apparaat: 'apparaat-2' })).toEqual({ status: 200, uitkomst: 'wacht' });
      expect(o.inhoud(pad(wachtUuid, 1)).equals(eerste)).toBe(true);
      const verwijzingen = o.db.prepare('SELECT sha256, bytes FROM sync_wachtrij_bijlagen b JOIN sync_wachtrij q ON q.id = b.wachtrij_id WHERE q.uuid = ? ORDER BY q.apparaat_id').all(wachtUuid);
      expect(verwijzingen).toEqual([1, 2].map(() => ({ sha256: sha(eerste), bytes: eerste.length })));
      // een echt ander bestand blijft een fout
      const andere = [makeJpeg('echt anders')];
      expect(o.foto(uuid, andere, velden(projectUuid, andere), { apparaat: 'apparaat-3' })).toEqual({ status: 200, uitkomst: 'afgewezen', fout: 'id-botst' });
    }
  });

  it('FOTO-10 migratie en paden: de migratie is relatief getest (oude toestand uit migrations.slice, findIndex op een zoektekst), bestaande rijen overleven, user_version klopt; het pad in job_photos is relatief en valt onder attachment-paths en het back-uppakket', async () => {
    const i = migrations.findIndex((m) => m.includes('CREATE TABLE IF NOT EXISTS job_photos'));
    expect(i).toBeGreaterThan(0);
    expect(migrations.filter((m) => m.includes('CREATE TABLE IF NOT EXISTS job_photos'))).toHaveLength(1);
    expect(migrations[i]).toContain('CREATE TABLE IF NOT EXISTS sync_wachtrij_bijlagen');
    expect(migrations[i]!).not.toMatch(/TRIGGER|DROP|DELETE|RENAME/i);
    const oud = new Database(':memory:');
    oud.pragma('foreign_keys = ON');
    for (const m of migrations.slice(0, i)) oud.exec(m);
    oud.pragma(`user_version = ${i}`);
    expect(oud.prepare(`SELECT 1 FROM sqlite_master WHERE name IN ('job_photos', 'sync_wachtrij_bijlagen')`).all()).toHaveLength(0);
    oud.exec(`INSERT INTO relations (type, name) VALUES ('klant', 'Oude klant')`);
    oud.exec(`INSERT INTO jobs (relation_id, title) VALUES (1, 'Oude klus')`);
    oud.exec(`INSERT INTO sync_wachtrij (apparaat_id, bron, entiteit, uuid, revisie, tijd, wijziging, wacht_op_entiteit, wacht_op_uuid, reden, ontvangen_op) VALUES ('a', 'M1', 'project', 'u1', 1, 5, '{}', 'klant', 'k1', 'klant-onbekend', 6)`);
    migrate(oud);
    expect(oud.pragma('user_version', { simple: true })).toBe(migrations.length);
    expect(oud.prepare('SELECT title FROM jobs').all()).toEqual([{ title: 'Oude klus' }]);
    expect(oud.prepare('SELECT uuid, verwerkt_op FROM sync_wachtrij').all()).toEqual([{ uuid: 'u1', verwerkt_op: null }]);
    const kolommen = (tabel: string) => (oud.prepare(`PRAGMA table_info(${tabel})`).all() as { name: string; notnull: number }[]).map((k) => k.name);
    expect(kolommen('job_photos')).toEqual(['id', 'job_id', 'wijziging_uuid', 'volgnr', 'file_path', 'sha256', 'bytes', 'notitie', 'tijd', 'created_at']);
    expect(kolommen('sync_wachtrij_bijlagen')).toEqual(['wachtrij_id', 'volgnr', 'file_path', 'sha256', 'bytes']);
    // de koppeling aan klus en wachtrij en de unieke sleutel worden afgedwongen
    const voeg = (job: number, uuid: string, volgnr: number) => oud.prepare(`INSERT INTO job_photos (job_id, wijziging_uuid, volgnr, file_path, sha256, bytes, tijd) VALUES (?, ?, ?, 'bijlagen/telefoon/x/1.jpg', 'ab', 1, 5)`).run(job, uuid, volgnr);
    expect(() => voeg(999, 'u', 1)).toThrow();
    voeg(1, 'u', 1);
    expect(() => voeg(1, 'u', 1)).toThrow();
    expect(() => oud.prepare(`INSERT INTO sync_wachtrij_bijlagen (wachtrij_id, volgnr, file_path, sha256, bytes) VALUES (999, 1, 'p', 's', 1)`).run()).toThrow();
    oud.close();

    // het pad is relatief, valt onder attachment-paths (verhuizen) en onder het back-uppakket
    const { o, projectUuid } = metProject({ bestandsdatabank: true });
    const fotos = [makeJpeg('pad 1'), makeJpeg('pad 2')];
    const uuid = randomUUID();
    expect(o.foto(uuid, fotos, velden(projectUuid, fotos))).toEqual({ status: 200, uitkomst: 'toegepast' });
    const paden = o.fotoRijen(uuid).map((r) => r.file_path as string);
    expect(paden).toEqual([pad(uuid, 1), pad(uuid, 2)]);
    for (const p of paden) expect(isStoredAttachmentPath(p)).toBe(true);
    expect(storedAttachmentPaths(o.db).filter((r) => r.table === 'job_photos').map((r) => r.path)).toEqual(paden);
    expect(missingAttachments(join(o.adminDir, 'boekhouding.sqlite'), o.adminDir)).toBe(0);
    // een pad van een oudere versie of een andere computer wordt omgezet; wat al relatief is blijft
    o.db.prepare(`UPDATE job_photos SET file_path = ? WHERE wijziging_uuid = ? AND volgnr = 2`).run(`C:\\Gebruikers\\Piet\\Boekhouding\\Bijlagen\\telefoon\\${uuid}\\2.jpg`, uuid);
    expect(relativizeAttachmentPaths(o.db)).toMatchObject({ converted: 1, kept: [] });
    expect(o.fotoRijen(uuid).map((r) => r.file_path)).toEqual(paden);
    // het back-uppakket bevat de bestanden en terugzetten in een andere map werkt
    const bundel = await createBackupBundle(o.db, o.adminDir);
    const inBundel = readBackupBundle(bundel);
    paden.forEach((p, k) => expect(inBundel.get(p)?.equals(fotos[k]!), p).toBe(true));
    const doelMap = tijdelijkeMap('bvn-sync-fotos-doel-');
    const doelDb = join(doelMap, 'boekhouding.sqlite');
    const leegDoel = new Database(doelDb);
    migrate(leegDoel);
    leegDoel.close();
    restoreCompleteBackup(bundel, doelDb, doelMap);
    paden.forEach((p, k) => expect(readFileSync(resolveAttachmentPath(doelMap, p)).equals(fotos[k]!)).toBe(true));
    expect(missingAttachments(doelDb, doelMap)).toBe(0);
  });

  it('FOTO-11 bevestigingen en wachtrij: een afgehandelde wachtende foto staat in de bevestigingen van die telefoon (toegepast of afgewezen met fout); een volle wachtrij geeft 503 wachtrij-vol zonder rij en zonder bestanden; ontkoppeld na het wachten verliest de foto niet', () => {
    const o = omgeving();
    const pairing = new ScannerPairing(o.db, o.secrets);
    const koppel = () => {
      const { deviceId } = pairing.begin();
      pairing.seen(deviceId);
      return { deviceId, code: pairing.code(deviceId)! };
    };
    const a = koppel();
    const b = koppel();
    const klant = randomUUID();
    const goedProject = randomUUID();
    const kapotProject = randomUUID();
    const goed = [makeJpeg('goed')];
    const kapot = [makeJpeg('wordt beschadigd')];
    const uuidGoed = randomUUID();
    const uuidKapot = randomUUID();
    const stuur = (apparaat: { deviceId: string; code: string }, uuid: string, fotos: Buffer[], project: string) =>
      o.sync.verwerk(apparaat.deviceId, apparaat.code, { entiteit: 'foto', uuid, revisie: 1, tijd: Date.now() - DAG, velden: velden(project, fotos) }, 'netwerk', fotos);
    expect(stuur(a, uuidGoed, goed, goedProject)).toEqual({ status: 200, uitkomst: 'wacht' });
    expect(stuur(a, uuidKapot, kapot, kapotProject)).toEqual({ status: 200, uitkomst: 'wacht' });
    // het bewaarde bestand van de tweede wordt beschadigd voordat het project komt: bij het verwerken wordt het opnieuw gecontroleerd
    writeFileSync(join(o.adminDir, ...pad(uuidKapot, 1).split('/')), Buffer.from('beschadigd'));
    // ontkoppeld na het wachten: de wachtende foto's verdwijnen niet
    pairing.unpair(a.deviceId);
    expect(o.telling()).toMatchObject({ wachtrij: 2, bijlagen: 2, bestanden: 2 });
    expect(o.klant(klant, 'Klant', b.deviceId)).toMatchObject({ uitkomst: 'toegepast' });
    expect(o.project(goedProject, klant, b.deviceId)).toMatchObject({ uitkomst: 'toegepast' });
    expect(o.project(kapotProject, klant, b.deviceId)).toMatchObject({ uitkomst: 'toegepast' });
    expect(o.fotoRijen(uuidGoed)).toHaveLength(1);
    expect(o.fotoRijen(uuidKapot)).toHaveLength(0);
    expect(o.register(uuidGoed)).toEqual([{ apparaat_id: a.deviceId, uitkomst: 'toegepast', fout: null, route: 'netwerk' }]);
    expect(o.register(uuidKapot)).toEqual([{ apparaat_id: a.deviceId, uitkomst: 'afgewezen', fout: 'ongeldig', route: 'netwerk' }]);
    // de bevestigingen van die telefoon: precies zes velden, nooit pad, sha256 of inhoud
    const pagina = leesBevestigingen(o.db, a.deviceId, 0);
    const kort = (uuid: string) => pagina.bevestigingen.filter((x) => x.uuid === uuid).map((x) => ({ entiteit: x.entiteit, revisie: x.revisie, uitkomst: x.uitkomst, fout: x.fout }));
    expect(pagina.bevestigingen).toHaveLength(2);
    expect(kort(uuidGoed)).toEqual([{ entiteit: 'foto', revisie: 1, uitkomst: 'toegepast', fout: null }]);
    expect(kort(uuidKapot)).toEqual([{ entiteit: 'foto', revisie: 1, uitkomst: 'afgewezen', fout: 'ongeldig' }]);
    for (const x of pagina.bevestigingen) expect(Object.keys(x).sort()).toEqual(['entiteit', 'fout', 'revisie', 'seq', 'uitkomst', 'uuid']);
    expect(leesBevestigingen(o.db, b.deviceId, 0).bevestigingen.filter((x) => x.entiteit === 'foto')).toHaveLength(0);

    // een wachtende foto voor een project dat nooit komt omdat het is afgewezen (de klant is een leverancier): de foto
    // wordt afgewezen met project-afgewezen, met registerrij en bevestiging; de bestanden blijven staan
    const leverancier = o.s.relations.create({ name: 'Bouwmarkt', type: 'leverancier' });
    const leverancierUuid = o.db.prepare('SELECT uuid FROM relations WHERE id = ?').pluck().get(leverancier.id) as string;
    const afgewezenProject = randomUUID();
    const uuidAfgewezen = randomUUID();
    const bijProject = [makeJpeg('project afgewezen')];
    expect(stuur(b, uuidAfgewezen, bijProject, afgewezenProject)).toEqual({ status: 200, uitkomst: 'wacht' });
    expect(o.project(afgewezenProject, leverancierUuid, b.deviceId)).toEqual({ status: 200, uitkomst: 'afgewezen', fout: 'geen-klant' });
    expect(o.fotoRijen(uuidAfgewezen)).toHaveLength(0);
    expect(o.register(uuidAfgewezen)).toEqual([{ apparaat_id: b.deviceId, uitkomst: 'afgewezen', fout: 'project-afgewezen', route: 'netwerk' }]);
    expect(o.wachtrij(uuidAfgewezen)[0]).toMatchObject({ verwerkt_uitkomst: 'afgewezen', verwerkt_reden: 'project-afgewezen' });
    expect(o.wachtrij(uuidAfgewezen)[0]!.verwerkt_seq).not.toBeNull();
    expect(leesBevestigingen(o.db, b.deviceId, 0).bevestigingen.filter((x) => x.entiteit === 'foto').map((x) => ({ uuid: x.uuid, uitkomst: x.uitkomst, fout: x.fout }))).toEqual([{ uuid: uuidAfgewezen, uitkomst: 'afgewezen', fout: 'project-afgewezen' }]);
    expect(o.bestanden()).toContain(pad(uuidAfgewezen, 1));
    // een herhaling herhaalt de afwijzing
    expect(stuur(b, uuidAfgewezen, bijProject, afgewezenProject)).toEqual({ status: 200, uitkomst: 'afgewezen', fout: 'project-afgewezen' });

    // een volle wachtrij: 503 wachtrij-vol, zonder rij en zonder bestanden
    const voor = o.telling();
    const vul = o.db.prepare(`INSERT INTO sync_wachtrij (apparaat_id, bron, entiteit, uuid, revisie, tijd, wijziging, wacht_op_entiteit, wacht_op_uuid, reden, ontvangen_op) VALUES (?, ?, 'project', ?, 1, 5, '{}', 'klant', ?, 'klant-onbekend', 6)`);
    o.db.transaction(() => {
      for (let k = 0; k < WACHTRIJ_LIMIET; k++) vul.run(b.deviceId, b.code, randomUUID(), randomUUID());
    })();
    const volUuid = randomUUID();
    const vol = [makeJpeg('wachtrij vol')];
    expect(stuur(b, volUuid, vol, randomUUID())).toEqual({ status: 503, fout: 'wachtrij-vol' });
    expect(o.wachtrij(volUuid)).toHaveLength(0);
    expect(o.telling()).toEqual({ ...voor, wachtrij: voor.wachtrij + WACHTRIJ_LIMIET });
    // een foto voor een bekend project wordt door een volle wachtrij niet geraakt
    const bekendUuid = randomUUID();
    expect(stuur(b, bekendUuid, vol, goedProject)).toEqual({ status: 200, uitkomst: 'toegepast' });
  });

  it('FOTO-12 gedragsneutraal: zonder foto-optie (geen administratiemap) blijft foto niet-ondersteund; de bon en alle andere routes werken ongewijzigd; het antwoord en de bevestigingen bevatten nooit het pad of de inhoud', () => {
    // de echte waarde van het koppelen blijft uit (de test zet hem zelf aan en daarna weer uit)
    expect(readFileSync(join(__dirname, '..', 'src', 'shared', 'phone-scanner.ts'), 'utf8')).toMatch(/available: *false/);
    const zonder = omgeving({ zonderAdminDir: true });
    const klant = randomUUID();
    const project = randomUUID();
    expect(zonder.klant(klant)).toMatchObject({ uitkomst: 'toegepast' });
    expect(zonder.project(project, klant)).toMatchObject({ uitkomst: 'toegepast' });
    const fotos = [makeJpeg('niet ondersteund')];
    const uuid = randomUUID();
    expect(zonder.foto(uuid, fotos, velden(project, fotos))).toEqual({ status: 200, uitkomst: 'niet-ondersteund' });
    expect(zonder.foto(uuid, fotos, velden(project, fotos), { bijlagen: [] })).toEqual({ status: 200, uitkomst: 'niet-ondersteund' });
    expect(zonder.foto(uuid, fotos, velden(project, fotos), { bijlagen: [Buffer.from('geen jpeg')] })).toMatchObject({ status: 400 });
    expect(zonder.telling()).toEqual(zonder.leeg);
    // de bon (met een spool) en de rest werken naast de foto's zoals eerder
    const spoolDir = tijdelijkeMap('bvn-sync-fotos-spool-');
    const met = omgeving();
    const spool = new ReceiptSpool(met.db, spoolDir);
    const sync = new SyncOntvangst(met.db, new RelationsService(met.db), { now: () => Date.now(), invoices: met.s.invoices, spool, adminDir: met.adminDir, log: (m) => met.logs.push(m) });
    const bonFotos = [makeJpeg('bon naast foto')];
    const bonUuid = randomUUID();
    expect(sync.verwerk(APPARAAT, BRON, { entiteit: 'bon', uuid: bonUuid, revisie: 1, tijd: Date.now() - DAG, velden: { betaalwijze: 'pin', fotos: fotoVelden(bonFotos) } }, 'netwerk', bonFotos)).toEqual({ status: 200, uitkomst: 'toegepast' });
    expect(n(met.db, 'SELECT COUNT(*) AS n FROM scanner_documents WHERE id = ?', bonUuid)).toBe(1);
    expect(met.bestanden()).toEqual([]); // een bon komt in de spool, niet onder bijlagen/
    // privacy: in geen enkel antwoord, bevestiging of logregel staat een pad of de inhoud
    const k2 = randomUUID();
    const p2 = randomUUID();
    const f2 = [makeJpeg('privacy')];
    const u2 = randomUUID();
    const antwoorden = [met.foto(u2, f2, velden(p2, f2), { apparaat: 'apparaat-9' }), met.klant(k2, 'K', 'apparaat-9'), met.project(p2, k2, 'apparaat-9'), met.foto(u2, f2, velden(p2, f2), { apparaat: 'apparaat-9' })];
    expect(antwoorden.map((x) => x.uitkomst)).toEqual(['wacht', 'toegepast', 'toegepast', 'overgeslagen']);
    const alles = JSON.stringify([antwoorden, leesBevestigingen(met.db, 'apparaat-9', 0), met.logs]);
    expect(alles).not.toMatch(/bijlagen|telefoon\/|\.jpg|\/9j\//);
    expect(alles).not.toContain(sha(f2[0]!));
    expect(leesBevestigingen(met.db, 'apparaat-9', 0).bevestigingen).toMatchObject([{ entiteit: 'foto', uuid: u2, uitkomst: 'toegepast', fout: null }]);
  });
});
