import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Wijziging } from '@gratis-boekhouden/kern';
import { setup } from './helpers';
import { makeJpeg } from './fixtures/jpeg';
import { resolveAttachmentPath } from '../src/main/attachments';
import { createApi, type HostContext } from '../src/main/api';
import { JobPhotos } from '../src/jobs/photos';
import { RelationsService } from '../src/relations/relations';
import { SyncOntvangst } from '../src/sync/ontvangst';

// De foto's van de telefoon zichtbaar op de pc (JobPhotos en api.jobs.photos/photo). De foto's komen binnen via de
// echte SyncOntvangst (en dus FotoOntvangst) in een tijdelijke administratiemap, met een echte databank en echte
// bestanden. Een eigen payload-bouwer en relatieve datums.

const DAG = 24 * 60 * 60 * 1000;
const APPARAAT = 'apparaat-1';
const BRON = 'M1';
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const n = (db: { prepare(s: string): { get(...p: unknown[]): unknown } }, sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { n: number }).n;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Alle bestanden onder een map, met grootte en tijd, als meetpunt dat er niets verandert. */
function bestandenIn(dir: string, voor = ''): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((i) => (i.isDirectory() ? bestandenIn(join(dir, i.name), `${voor}${i.name}/`) : [`${voor}${i.name}:${statSync(join(dir, i.name)).size}:${statSync(join(dir, i.name)).mtimeMs}`]))
    .sort();
}

function omgeving() {
  const adminDir = mkdtempSync(join(tmpdir(), 'bvn-jobs-photos-'));
  dirs.push(adminDir);
  const t = setup();
  const sync = new SyncOntvangst(t.db, new RelationsService(t.db), { now: () => Date.now(), invoices: t.s.invoices, adminDir });
  const leesBijlage = (p: string) => readFileSync(resolveAttachmentPath(adminDir, p));
  const gelezen: string[] = [];
  const host = { appVersion: () => '9.9.9', readOnly: () => false, readAttachment: (p: string) => (gelezen.push(p), leesBijlage(p)) } as unknown as HostContext;
  const api = createApi(t.s, host);
  /** een klus via de telefoon: klant en project, geeft het klus-id en de uuid van het project */
  const klus = (titel = 'Schilderwerk') => {
    const klantUuid = randomUUID();
    const projectUuid = randomUUID();
    expect(sync.verwerk(APPARAAT, BRON, { entiteit: 'klant', uuid: klantUuid, revisie: 1, tijd: Date.now() - 5 * DAG, velden: { naam: `Klant ${titel}` } }, 'netwerk')).toMatchObject({ uitkomst: 'toegepast' });
    expect(sync.verwerk(APPARAAT, BRON, { entiteit: 'project', uuid: projectUuid, revisie: 1, tijd: Date.now() - 4 * DAG, velden: { titel, klant: klantUuid } }, 'netwerk')).toMatchObject({ uitkomst: 'toegepast' });
    const id = t.db.prepare('SELECT id FROM jobs WHERE uuid = ?').pluck().get(projectUuid) as number;
    return { id, projectUuid };
  };
  /** een fotowijziging van de telefoon bij een project */
  const foto = (projectUuid: string, fotos: Buffer[], opties: { tijd?: number; notitie?: string; uuid?: string } = {}) => {
    const uuid = opties.uuid ?? randomUUID();
    const velden = { project_uuid: projectUuid, ...(opties.notitie === undefined ? {} : { notitie: opties.notitie }), fotos: fotos.map((f) => ({ grootte: f.length, sha256: sha(f) })) };
    const w: Wijziging = { entiteit: 'foto', uuid, revisie: 1, tijd: opties.tijd ?? Date.now() - DAG, velden };
    expect(sync.verwerk(APPARAAT, BRON, w, 'netwerk', fotos)).toMatchObject({ status: 200, uitkomst: 'toegepast' });
    return uuid;
  };
  const rijen = (jobId: number) => t.db.prepare('SELECT * FROM job_photos WHERE job_id = ? ORDER BY tijd, id').all(jobId) as { id: number; wijziging_uuid: string; volgnr: number; file_path: string; sha256: string; bytes: number; notitie: string | null; tijd: number }[];
  return { ...t, adminDir, sync, api, host, gelezen, leesBijlage, klus, foto, rijen };
}

describe('de foto\'s van de telefoon bij een klus', () => {
  it('FOTOLIJST-01 lijst: JobPhotos.list(jobId) geeft de foto\'s van een klus oplopend op ontvangstvolgorde (tijd van de telefoon, dan id), met per foto id, volgnummer, tijd, notitie, grootte en gecontroleerd, en nooit het pad, de sha256 of de wijziging-uuid; een klus zonder foto\'s geeft []', () => {
    const o = omgeving();
    const { id, projectUuid } = o.klus();
    expect(o.s.jobPhotos.list(id)).toEqual([]);
    const nu = Date.now();
    const laat = makeJpeg('laat');
    const vroeg = makeJpeg('vroeg');
    const twee = [makeJpeg('twee-a'), makeJpeg('twee-b')];
    // eerst de latere, dan de vroegere: de volgorde volgt de tijd van de telefoon, niet de binnenkomst
    o.foto(projectUuid, [laat], { tijd: nu - 1 * DAG, notitie: 'Na het schilderen' });
    o.foto(projectUuid, [vroeg], { tijd: nu - 3 * DAG });
    o.foto(projectUuid, twee, { tijd: nu - 2 * DAG, notitie: 'Twee kanten' });
    const lijst = o.s.jobPhotos.list(id);
    const db = o.rijen(id);
    expect(db).toHaveLength(4);
    expect(lijst).toHaveLength(4);
    // vroeg, dan de twee van dezelfde wijziging (zelfde tijd: op id, dus volgnr 1 voor 2), dan laat
    expect(lijst.map((f) => f.volgnr)).toEqual([1, 1, 2, 1]);
    expect(lijst.map((f) => f.grootte)).toEqual([vroeg.length, twee[0]!.length, twee[1]!.length, laat.length]);
    expect(lijst[0]!).toEqual({ id: db[0]!.id, volgnr: 1, tijd: nu - 3 * DAG, notitie: null, grootte: vroeg.length, gecontroleerd: true });
    expect(lijst[1]!).toEqual({ id: db[1]!.id, volgnr: 1, tijd: nu - 2 * DAG, notitie: 'Twee kanten', grootte: twee[0]!.length, gecontroleerd: true });
    expect(lijst[3]!).toEqual({ id: db[3]!.id, volgnr: 1, tijd: nu - 1 * DAG, notitie: 'Na het schilderen', grootte: laat.length, gecontroleerd: true });
    expect(lijst.every((f) => Object.keys(f).sort().join() === 'gecontroleerd,grootte,id,notitie,tijd,volgnr')).toBe(true);
    // zonder controlesom in de rij is een foto niet gecontroleerd
    o.db.prepare(`UPDATE job_photos SET sha256 = '' WHERE id = ?`).run(db[0]!.id);
    expect(o.s.jobPhotos.list(id)[0]!.gecontroleerd).toBe(false);
  });

  it('FOTOLIJST-02 alleen die klus: foto\'s van een andere klus of van een wachtende wijziging (nog geen job_photos-rij) staan er niet bij; een onbekend klus-id geeft [] en een ongeldig klus-id een Nederlandse fout', () => {
    const o = omgeving();
    const a = o.klus('Klus A');
    const b = o.klus('Klus B');
    o.foto(a.projectUuid, [makeJpeg('a1')], { notitie: 'bij A' });
    o.foto(b.projectUuid, [makeJpeg('b1')], { notitie: 'bij B 1' });
    o.foto(b.projectUuid, [makeJpeg('b2')], { notitie: 'bij B 2' });
    // een foto voor een project dat de pc nog niet kent: wacht in de wachtrij, nog geen job_photos-rij
    const onbekend = randomUUID();
    const wachtFoto = makeJpeg('wacht');
    const wacht = { entiteit: 'foto', uuid: randomUUID(), revisie: 1, tijd: Date.now() - DAG, velden: { project_uuid: onbekend, fotos: [{ grootte: wachtFoto.length, sha256: sha(wachtFoto) }] } } as Wijziging;
    expect(o.sync.verwerk(APPARAAT, BRON, wacht, 'netwerk', [wachtFoto])).toMatchObject({ uitkomst: 'wacht' });
    expect(n(o.db, 'SELECT COUNT(*) AS n FROM job_photos')).toBe(3);
    expect(o.s.jobPhotos.list(a.id).map((f) => f.notitie)).toEqual(['bij A']);
    expect(o.s.jobPhotos.list(b.id).map((f) => f.notitie).sort()).toEqual(['bij B 1', 'bij B 2']);
    expect(o.s.jobPhotos.count(a.id)).toBe(1);
    expect(o.s.jobPhotos.count(b.id)).toBe(2);
    expect(o.s.jobPhotos.list(987654)).toEqual([]);
    expect(o.s.jobPhotos.count(987654)).toBe(0);
    for (const slecht of [0, -1, 1.5, Number.NaN, 2 ** 53, '1' as unknown as number, null as unknown as number]) {
      expect(() => o.s.jobPhotos.list(slecht)).toThrow(/geheel getal/);
    }
  });

  it('FOTOLIJST-03 lezen: JobPhotos.read(photoId, leesBijlage) geeft { mimeType image/jpeg, base64 } van het bewaarde bestand via de veilige route (resolveAttachmentPath: geen pad buiten bijlagen/); een ontbrekend of beschadigd bestand en een onbekend id geven een Nederlandse fout', () => {
    const o = omgeving();
    const { id, projectUuid } = o.klus();
    const bytes = makeJpeg('lezen');
    o.foto(projectUuid, [bytes], { notitie: 'lezen' });
    const rij = o.rijen(id)[0]!;
    const uit = o.s.jobPhotos.read(rij.id, o.leesBijlage);
    expect(uit).toEqual({ mimeType: 'image/jpeg', base64: bytes.toString('base64') });
    expect(Buffer.from(uit.base64, 'base64').equals(readFileSync(join(o.adminDir, ...rij.file_path.split('/'))))).toBe(true);
    // een pad buiten bijlagen/ komt de leesroute niet door (resolveAttachmentPath weigert), en het pad staat niet in de fout
    o.db.prepare('UPDATE job_photos SET file_path = ? WHERE id = ?').run('bijlagen/../geheim.txt', rij.id);
    writeFileSync(join(o.adminDir, 'geheim.txt'), 'niet voor de foto');
    expect(() => o.s.jobPhotos.read(rij.id, o.leesBijlage)).toThrow(/niet in de bijlagen/);
    o.db.prepare('UPDATE job_photos SET file_path = ? WHERE id = ?').run('/etc/passwd', rij.id);
    expect(() => o.s.jobPhotos.read(rij.id, o.leesBijlage)).toThrow(/niet in de bijlagen/);
    o.db.prepare('UPDATE job_photos SET file_path = ? WHERE id = ?').run(rij.file_path, rij.id);
    // beschadigd bestand: niet meer wat er bewaard is
    const bestand = join(o.adminDir, ...rij.file_path.split('/'));
    writeFileSync(bestand, Buffer.concat([bytes, Buffer.from('rommel')]));
    expect(() => o.s.jobPhotos.read(rij.id, o.leesBijlage)).toThrow(/klopt niet meer/);
    // ontbrekend bestand: een nette fout zonder het pad
    unlinkSync(bestand);
    let fout = '';
    try {
      o.s.jobPhotos.read(rij.id, o.leesBijlage);
    } catch (e) {
      fout = (e as Error).message;
    }
    expect(fout).toBe('Het bestand van deze foto is niet gevonden of niet te lezen');
    expect(() => o.s.jobPhotos.read(424242, o.leesBijlage)).toThrow('Foto 424242 bestaat niet');
    expect(() => o.s.jobPhotos.read(0, o.leesBijlage)).toThrow(/geheel getal/);
  });

  it('FOTOLIJST-04 pad nooit lekken: het resultaat van list en read bevat geen pad, geen sha256 en geen wijziging-uuid (sleutels en ruwe JSON met geplante waarden), en de api levert hetzelfde', () => {
    const o = omgeving();
    const { id, projectUuid } = o.klus();
    const wijzigingUuid = o.foto(projectUuid, [makeJpeg('geheim-1'), makeJpeg('geheim-2')], { notitie: 'Gewoon een notitie' });
    const rijen = o.rijen(id);
    expect(rijen).toHaveLength(2);
    const verboden = [wijzigingUuid, projectUuid, 'bijlagen', 'telefoon', '.jpg', ...rijen.flatMap((r) => [r.sha256, r.file_path, r.wijziging_uuid])];
    const sleutelsVan = (x: unknown): string[] => (Array.isArray(x) ? x.flatMap(sleutelsVan) : x && typeof x === 'object' ? Object.entries(x).flatMap(([k, v]) => [k, ...sleutelsVan(v)]) : []);
    const service = o.s.jobPhotos.list(id);
    const viaApi = o.api.jobs.photos(id);
    const lees = o.s.jobPhotos.read(rijen[0]!.id, o.leesBijlage);
    const leesApi = o.api.jobs.photo(rijen[0]!.id);
    for (const uit of [service, viaApi, lees, leesApi]) {
      const ruw = JSON.stringify(uit);
      // de base64 van een foto bevat toevallig geen van deze waarden; de rest is metadata
      for (const v of verboden) expect(ruw).not.toContain(v);
      expect(sleutelsVan(uit).filter((k) => /pad|path|sha|uuid|file/i.test(k))).toEqual([]);
    }
    expect(viaApi).toEqual({ fotos: service, totaal: 2 });
    expect(leesApi).toEqual(lees);
    // het pad gaat wel naar de leesroute van de host (dat is de bedoeling), maar komt nergens in de uitvoer
    expect(o.gelezen).toEqual([rijen[0]!.file_path]);
  });

  it('FOTOLIJST-05 alleen lezen: list en read schrijven niets (rijtelling, bestanden en tellers gelijk) en er bestaat geen api om een foto te wijzigen of te verwijderen', () => {
    const o = omgeving();
    const { id, projectUuid } = o.klus();
    o.foto(projectUuid, [makeJpeg('vast-1')], { notitie: 'een' });
    o.foto(projectUuid, [makeJpeg('vast-2')], { notitie: 'twee' });
    const tabellen = ['job_photos', 'jobs', 'sync_ontvangen', 'sync_wachtrij', 'sync_wachtrij_bijlagen', 'sync_teller', 'relations', 'documents'];
    const meet = () => ({
      rijen: tabellen.map((t) => n(o.db, `SELECT COUNT(*) AS n FROM ${t}`)),
      teller: o.db.prepare('SELECT naam, waarde FROM sync_teller ORDER BY naam').all(),
      foto: o.db.prepare('SELECT * FROM job_photos ORDER BY id').all(),
      jobs: o.db.prepare('SELECT id, sync_seq, revisie FROM jobs ORDER BY id').all(),
      bestanden: bestandenIn(join(o.adminDir, 'bijlagen')),
    });
    const voor = meet();
    expect(voor.bestanden).toHaveLength(2);
    const eerste = o.rijen(id)[0]!.id;
    o.s.jobPhotos.list(id);
    o.s.jobPhotos.count(id);
    o.s.jobPhotos.read(eerste, o.leesBijlage);
    o.api.jobs.photos(id, { limiet: 1, offset: 1 });
    o.api.jobs.photo(eerste);
    expect(meet()).toEqual(voor);
    // de vorm: precies twee fotofuncties in de api, en geen enkele die schrijft
    const fotoFuncties = Object.keys(o.api.jobs).filter((k) => /foto|photo/i.test(k)).sort();
    expect(fotoFuncties).toEqual(['photo', 'photos']);
    expect(Object.keys(o.api.jobs).filter((k) => /foto|photo/i.test(k) && /delete|remove|update|set|add|edit|wijzig|verwijder|create/i.test(k))).toEqual([]);
    expect(Object.getOwnPropertyNames(JobPhotos.prototype).sort()).toEqual(['constructor', 'count', 'list', 'read']);
    expect(Object.keys(o.api).filter((k) => /foto|photo/i.test(k))).toEqual([]);
  });

  it('FOTOLIJST-06 api: api.jobs.photos(id) en api.jobs.photo(photoId) bestaan, valideren hun invoer (geheel getal groter dan 0, anders een Nederlandse fout) en gebruiken host.readAttachment; in de kopie bij de boekhouder en bij een gearchiveerde of gefactureerde klus werkt het lezen gewoon', () => {
    const o = omgeving();
    const { id, projectUuid } = o.klus();
    const bytes = makeJpeg('api');
    o.foto(projectUuid, [bytes], { notitie: 'via de api' });
    const rij = o.rijen(id)[0]!;
    expect(typeof o.api.jobs.photos).toBe('function');
    expect(typeof o.api.jobs.photo).toBe('function');
    for (const slecht of [0, -3, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, '1', null, undefined, {}]) {
      expect(() => o.api.jobs.photos(slecht as number)).toThrow(/geheel getal groter dan 0/);
      expect(() => o.api.jobs.photo(slecht as number)).toThrow(/geheel getal groter dan 0/);
    }
    for (const slecht of ['x', 5, null, []]) expect(() => o.api.jobs.photos(id, slecht as never)).toThrow(/object/);
    for (const limiet of [0, 201, 1.5, -1, '5', Number.NaN]) expect(() => o.api.jobs.photos(id, { limiet: limiet as number })).toThrow(/De limiet moet een geheel getal/);
    for (const offset of [-1, 1.5, 2 ** 40, '0', Number.NaN]) expect(() => o.api.jobs.photos(id, { offset: offset as number })).toThrow(/De offset moet een geheel getal/);
    expect(o.gelezen).toEqual([]);
    expect(o.api.jobs.photo(rij.id)).toEqual({ mimeType: 'image/jpeg', base64: bytes.toString('base64') });
    expect(o.gelezen).toEqual([rij.file_path]);
    // een gefactureerde en gearchiveerde klus, een kopie bij de boekhouder en een alleen-lezen app: lezen werkt gewoon
    o.db.prepare(`UPDATE jobs SET status = 'gefactureerd', archived = 1 WHERE id = ?`).run(id);
    o.s.settings.markOfficeCopy({ office: 'Kantoor Test', exchange: 1, endDate: '2025-12-31' });
    const alleenLezen = createApi(o.s, { ...o.host, readOnly: () => true } as HostContext);
    for (const api of [o.api, alleenLezen]) {
      expect(api.jobs.photos(id)).toEqual({ fotos: [expect.objectContaining({ id: rij.id, notitie: 'via de api' })], totaal: 1 });
      expect(api.jobs.photo(rij.id).base64).toBe(bytes.toString('base64'));
    }
    expect(o.s.settings.officeCopy()).toMatchObject({ office: 'Kantoor Test' });
  });

  it('FOTOLIJST-07 begrensd: een klus met 1000 foto\'s levert hoogstens de eerste 200 in list (met een telling van het totaal); de rest is bereikbaar met limiet en offset en de volgorde is stabiel', () => {
    const o = omgeving();
    const { id, projectUuid } = o.klus();
    const nu = Date.now();
    // 100 wijzigingen van 10 foto's, met oplopende tijden door elkaar gegooid
    for (let w = 0; w < 100; w++) {
      const fotos = Array.from({ length: 10 }, (_, i) => makeJpeg(`m-${w}-${i}`));
      o.foto(projectUuid, fotos, { tijd: nu - ((w * 37) % 100) * 60_000 - 2 * DAG });
    }
    expect(n(o.db, 'SELECT COUNT(*) AS n FROM job_photos WHERE job_id = ?', id)).toBe(1000);
    const eerste = o.s.jobPhotos.list(id);
    expect(eerste).toHaveLength(200);
    expect(o.s.jobPhotos.count(id)).toBe(1000);
    expect(o.api.jobs.photos(id)).toMatchObject({ totaal: 1000 });
    expect(o.api.jobs.photos(id).fotos).toHaveLength(200);
    expect(o.s.jobPhotos.list(id)).toEqual(eerste);
    expect(() => o.s.jobPhotos.list(id, { limiet: 201 })).toThrow(/De limiet/);
    // alle pagina's samen: elke foto precies een keer, oplopend op (tijd, id)
    const alle: ReturnType<typeof o.s.jobPhotos.list> = [];
    for (let offset = 0; offset < 1000; offset += 200) alle.push(...o.s.jobPhotos.list(id, { offset }));
    expect(new Set(alle.map((f) => f.id)).size).toBe(1000);
    const verwacht = o.rijen(id).map((r) => r.id);
    expect(alle.map((f) => f.id)).toEqual(verwacht);
    expect(alle.every((f, i) => i === 0 || alle[i - 1]!.tijd <= f.tijd)).toBe(true);
    expect(o.s.jobPhotos.list(id, { limiet: 50, offset: 975 }).map((f) => f.id)).toEqual(verwacht.slice(975));
    expect(o.s.jobPhotos.list(id, { offset: 1000 })).toEqual([]);
  });

  it('FOTOLIJST-08 gedragsneutraal: zonder foto\'s verandert het klusscherm niet (geen extra gegevens in api.jobs.get, een lege lijst die niet faalt) en de bestaande api-functies van jobs blijven bestaan en gelijk', () => {
    const o = omgeving();
    const zonder = o.klus('Zonder foto');
    const met = o.klus('Met foto');
    const voorGet = JSON.stringify(o.api.jobs.get(zonder.id));
    const voorLijst = JSON.stringify(o.api.jobs.list());
    expect(o.api.jobs.photos(zonder.id)).toEqual({ fotos: [], totaal: 0 });
    expect(o.api.jobs.photos(987654)).toEqual({ fotos: [], totaal: 0 });
    o.foto(met.projectUuid, [makeJpeg('ernaast')], { notitie: 'bij een andere klus' });
    expect(JSON.stringify(o.api.jobs.get(zonder.id))).toBe(voorGet);
    // een klus mét foto's heeft in get geen fotogegevens: het scherm haalt ze apart op
    expect(Object.keys(o.api.jobs.get(met.id)).filter((k) => /foto|photo/i.test(k))).toEqual([]);
    expect(JSON.parse(JSON.stringify(o.api.jobs.list())).map((j: { id: number }) => j.id)).toEqual(JSON.parse(voorLijst).map((j: { id: number }) => j.id));
    for (const naam of ['list', 'get', 'create', 'update', 'setStatus', 'acceptQuote', 'makeInvoice', 'result', 'results', 'suggestForDocument', 'linkPurchase', 'linkBankTransaction', 'linkTrip', 'costItems', 'workItems', 'addWorkItem', 'removeWorkItem']) {
      expect(typeof (o.api.jobs as Record<string, unknown>)[naam]).toBe('function');
    }
    expect(Object.keys(o.api.jobs)).toHaveLength(19);
  });
});
