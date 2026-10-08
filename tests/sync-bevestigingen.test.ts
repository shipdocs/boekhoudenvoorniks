import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeTotals, type LineInput } from '@gratis-boekhouden/kern';
import { setup } from './helpers';
import { migrate } from '../src/db/database';
import { migrations } from '../src/db/migrations';
import { Bonnenscanner, type ScannerDeps } from '../src/scanner/scanner';
import { PHONE_SCANNER } from '../src/shared/phone-scanner';
import { CONTENT_TYPE, ENDPOINT_PATH, decodePairing, encodeFrame, openResponse, sealRequest, type PairingPayload, type ProtocolVersion } from '../src/scanner/protocol';
import { BEVESTIGINGEN_PAGINA, leesBevestigingen } from '../src/sync/bevestigingen';
import { SyncWachtrij } from '../src/sync/wachtrij';

// Het bericht `bevestigingen` van de pc (docs/bonnenscanner-protocol.md): wat er gebeurde met wijzigingen die
// eerst het antwoord wacht kregen. Alles tegen een echte databank, de echte receiver en de echte
// SyncOntvangst, SyncWachtrij en InvoiceService; datums zijn relatief aan vandaag.

const LOOPBACK = [{ address: '127.0.0.1', netmask: '255.0.0.0' }];
const DAG = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const DATUM = iso(Date.now() - 10 * DAG);
const VERVAL = iso(Date.now() + 20 * DAG);
const JAAR = DATUM.slice(0, 4);
const factuurNummer = (volgnr: number, code = 'M1') => `${code}-${JAAR}-${String(volgnr).padStart(4, '0')}`;

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

function start(extra: Partial<ScannerDeps> = {}) {
  const t = setup();
  const spoolDir = mkdtempSync(join(tmpdir(), 'bvn-bevestigingen-'));
  dirs.push(spoolDir);
  const clock = { now: Date.now() };
  const scanner = new Bonnenscanner({ db: t.db, secrets: t.secrets, intake: t.s.intake, settings: t.s.settings, spoolDir, interfaces: () => LOOPBACK, now: () => clock.now, invoices: t.s.invoices, ...extra });
  open.push(scanner);
  return { ...t, scanner, clock };
}
type T = ReturnType<typeof start>;

interface Reply {
  status: number;
  sealed: boolean;
  json: Record<string, unknown> | null;
  raw: Buffer;
}
interface Bev {
  seq: number;
  entiteit: string;
  uuid: string;
  revisie: number;
  uitkomst: string;
  fout: string | null;
}
interface Pagina {
  ok: boolean;
  soort: string;
  pcTijd: number;
  apparaatcode: string;
  bevestigingen: Bev[];
  volgende: number | null;
  bevestigd_tot: number;
}

function phone(pairing: PairingPayload, t: T) {
  const key = Buffer.from(pairing.sleutel, 'base64url');
  const deviceId = Buffer.from(pairing.apparaat, 'base64url');
  const url = `http://${pairing.adressen[0]}:${pairing.poort}${ENDPOINT_PATH}`;
  const verstuur = async (json: Record<string, unknown>, versie: ProtocolVersion = 2): Promise<Reply> => {
    const nonce = randomBytes(12);
    const body = sealRequest(deviceId, key, encodeFrame(json), nonce, versie);
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': CONTENT_TYPE }, body: new Uint8Array(body) });
    const raw = Buffer.from(await res.arrayBuffer());
    if ((res.headers.get('content-type') ?? '') === CONTENT_TYPE) {
      const json2 = openResponse(raw, key, nonce);
      return { status: res.status, sealed: json2 !== null, json: json2, raw };
    }
    return { status: res.status, sealed: false, json: raw.length ? (JSON.parse(raw.toString('utf8')) as Record<string, unknown>) : null, raw };
  };
  const vraag = (extra: Record<string, unknown> = {}) => verstuur({ soort: 'bevestigingen', tijd: t.clock.now, ...extra });
  const pagina = async (extra: Record<string, unknown> = {}): Promise<Pagina> => {
    const r = await vraag(extra);
    expect(r.status).toBe(200);
    return r.json as unknown as Pagina;
  };
  const wijzig = (entiteit: 'klant' | 'project' | 'factuur', uuid: string, revisie: number, velden: Record<string, unknown>) =>
    verstuur({ soort: 'wijziging', tijd: t.clock.now, wijziging: { entiteit, uuid, revisie, tijd: t.clock.now - DAG, velden } });
  const hallo = () => verstuur({ soort: 'hallo', tijd: t.clock.now, naam: 'Pixel van Piet', app: '1.0.0' });
  return { deviceId, id: deviceId.toString('base64url'), verstuur, vraag, pagina, wijzig, hallo };
}
type P = ReturnType<typeof phone>;

async function pair(t: T) {
  const p = phone(decodePairing((await t.scanner.pair()).payload), t);
  expect((await p.hallo()).status).toBe(200);
  return p;
}

const alle = <R>(t: T, sql: string, ...params: unknown[]) => t.db.prepare(sql).all(...params) as R[];
const een = <R>(t: T, sql: string, ...params: unknown[]) => t.db.prepare(sql).get(...params) as R;
const teller = (db: Database.Database, naam: string) => (db.prepare('SELECT waarde FROM sync_teller WHERE naam = ?').get(naam) as { waarde: number }).waarde;

const KLANT_SNAPSHOT = { name: 'Bakkerij De Korst', address: 'Dorpsstraat 1', city: 'Utrecht', country: 'NL', vat_number: 'NL123456789B01', kvk_number: '12345678', email: 'info@korst.example' };

/** een factuur van de telefoon, doorgerekend met de kern */
function factuurVelden(klantUuid: string, volgnr: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  const regels = [{ omschrijving: 'Montage', hoeveelheid: 2, prijs: 4550, btw_soort: 'hoog', eenheid: 'uur' }];
  const totaal = computeTotals(regels.map((r): LineInput => ({ description: r.omschrijving, quantity: r.hoeveelheid, unitPrice: r.prijs, vatCode: r.btw_soort as LineInput['vatCode'] })));
  return {
    nummer: factuurNummer(volgnr),
    datum: DATUM,
    vervaldatum: VERVAL,
    klant_uuid: klantUuid,
    klant_momentopname: { ...KLANT_SNAPSHOT },
    bedrijf_momentopname: { name: 'Jansen Klus', address: 'Werfstraat 2', city: 'Zwolle', kvkNumber: '87654321', vatNumber: 'NL987654321B01', kor: false },
    regels,
    totalen: { subtotaal: totaal.subtotal, btw: totaal.vatTotal, totaal: totaal.total },
    verzonden_op: `${DATUM} 10:30:00`,
    regeltabel_versie: '2026-1',
    ...over,
  };
}

/** zet `aantal` afgehandelde rijen voor een apparaat in de wachtrij, met de echte wachtrij (een nummer per markering) */
function vulAfgehandeld(t: T, apparaatId: string, aantal: number): string[] {
  const wachtrij = new SyncWachtrij(t.db, [], { now: () => t.clock.now });
  const uuids: string[] = [];
  t.db.transaction(() => {
    for (let i = 0; i < aantal; i++) {
      const uuid = randomUUID();
      const w = { entiteit: 'project', uuid, revisie: 1, tijd: t.clock.now - DAG, velden: { titel: `Klus ${i}` } };
      expect(wachtrij.zetIn(apparaatId, 'M1', w, { entiteit: 'klant', uuid: randomUUID(), reden: 'klant-onbekend' })).toBe('toegevoegd');
      const rij = wachtrij.rij(apparaatId, 'project', uuid, 1)!;
      expect(wachtrij.markeer(rij.id, 'toegepast', null)).toBe(true);
      uuids.push(uuid);
    }
  })();
  return uuids;
}

describe('bevestigingen van de pc naar de telefoon', () => {
  it('BEVEST-01 leeg: een telefoon zonder afgehandelde wachtende wijzigingen krijgt bevestigingen [], volgende null en bevestigd_tot gelijk aan het gevraagde na (standaard 0)', async () => {
    const t = start();
    const p = await pair(t);
    const r = await p.vraag();
    expect(r).toMatchObject({ status: 200, sealed: true });
    expect(r.json).toEqual({ ok: true, soort: 'bevestigingen', pcTijd: t.clock.now, apparaatcode: 'M1', bevestigingen: [], volgende: null, bevestigd_tot: 0 });
    expect(await p.pagina({ na: 7 })).toMatchObject({ bevestigingen: [], volgende: null, bevestigd_tot: 7 });
    // een wijziging die wacht en nog niet is afgehandeld is geen bevestiging
    expect((await p.wijzig('project', randomUUID(), 1, { titel: 'Badkamer', klant: randomUUID() })).json).toMatchObject({ uitkomst: 'wacht' });
    expect(await p.pagina()).toMatchObject({ bevestigingen: [], volgende: null, bevestigd_tot: 0 });
  });

  it('BEVEST-02 toegepast: een factuur die wachtte op een klant en daarna is toegepast, staat als {entiteit, uuid, revisie, uitkomst toegepast, fout null} in de bevestigingen van die telefoon', async () => {
    const t = start();
    const p = await pair(t);
    const klant = randomUUID();
    const factuur = randomUUID();
    const w = await p.wijzig('factuur', factuur, 1, factuurVelden(klant, 1));
    expect(w.json).toMatchObject({ ok: true, uitkomst: 'wacht' });
    expect((await p.pagina()).bevestigingen).toEqual([]);
    expect((await p.wijzig('klant', klant, 1, { naam: 'Bakkerij De Korst' })).json).toMatchObject({ uitkomst: 'toegepast' });
    expect(een<{ n: number }>(t, 'SELECT COUNT(*) AS n FROM invoices WHERE uuid = ?', factuur).n).toBe(1);
    const rij = een<{ verwerkt_seq: number }>(t, 'SELECT verwerkt_seq FROM sync_wachtrij WHERE uuid = ?', factuur);
    expect(rij.verwerkt_seq).toBeGreaterThan(0);
    const pagina = await p.pagina();
    expect(pagina.bevestigingen).toEqual([{ seq: rij.verwerkt_seq, entiteit: 'factuur', uuid: factuur, revisie: 1, uitkomst: 'toegepast', fout: null }]);
    expect(pagina).toMatchObject({ volgende: null, bevestigd_tot: rij.verwerkt_seq });
  });

  it('BEVEST-03 afgewezen: een wachtende wijziging die bij het verwerken wordt afgewezen staat er met uitkomst afgewezen en de foutcode; dat geldt voor een project en voor een factuur', async () => {
    const t = start();
    const p = await pair(t);
    const klant = randomUUID();
    const project = randomUUID();
    const wachtendeFactuur = randomUUID();
    expect((await p.wijzig('project', project, 1, { titel: 'Badkamer', klant })).json).toMatchObject({ uitkomst: 'wacht' });
    expect((await p.wijzig('factuur', wachtendeFactuur, 1, factuurVelden(klant, 1))).json).toMatchObject({ uitkomst: 'wacht' });
    // een andere factuur met hetzelfde nummer van een bekende klant wordt eerst toegepast: het nummer is dan bezet
    const bekend = randomUUID();
    expect((await p.wijzig('klant', bekend, 1, { naam: 'Andere klant' })).json).toMatchObject({ uitkomst: 'toegepast' });
    expect((await p.wijzig('factuur', randomUUID(), 1, factuurVelden(bekend, 1))).json).toMatchObject({ uitkomst: 'toegepast' });
    // de wachtende projectwijziging is intussen onleesbaar geworden: bij het verwerken wordt hij afgewezen
    t.db.prepare(`UPDATE sync_wachtrij SET wijziging = '{"kapot":true}' WHERE uuid = ?`).run(project);
    expect((await p.wijzig('klant', klant, 1, { naam: 'Bakkerij De Korst' })).json).toMatchObject({ uitkomst: 'toegepast' });
    const pagina = await p.pagina();
    const perUuid = new Map(pagina.bevestigingen.map((b) => [b.uuid, b]));
    expect(perUuid.get(project)).toMatchObject({ entiteit: 'project', revisie: 1, uitkomst: 'afgewezen', fout: 'veld-ongeldig' });
    expect(perUuid.get(wachtendeFactuur)).toMatchObject({ entiteit: 'factuur', revisie: 1, uitkomst: 'afgewezen', fout: 'nummer-bezet' });
    expect(pagina.bevestigingen).toHaveLength(2);
    expect(een<{ n: number }>(t, 'SELECT COUNT(*) AS n FROM invoices WHERE uuid = ?', wachtendeFactuur).n).toBe(0);
  });

  it('BEVEST-04 alleen eigen apparaat: een ander gekoppeld apparaat ziet de bevestigingen van de eerste telefoon nooit', async () => {
    const t = start();
    const a = await pair(t);
    const b = await pair(t);
    const uuidsA = vulAfgehandeld(t, a.id, 3);
    const uuidsB = vulAfgehandeld(t, b.id, 2);
    const vanA = await a.pagina();
    const vanB = await b.pagina();
    expect(vanA.bevestigingen.map((x) => x.uuid)).toEqual(uuidsA);
    expect(vanB.bevestigingen.map((x) => x.uuid)).toEqual(uuidsB);
    expect(vanA.apparaatcode).not.toBe(vanB.apparaatcode);
    const rawB = JSON.stringify(vanB);
    for (const u of uuidsA) expect(rawB).not.toContain(u);
    // het apparaat komt uit de envelop: een meegestuurd apparaat in het bericht is nooit goed
    expect((await b.vraag({ apparaat_id: a.id })).status).toBe(400);
  });

  it('BEVEST-05 volgorde en paginering: 250 afgehandelde wijzigingen komen in pagina\'s van hoogstens 100, op oplopend bevestigingsnummer, zonder dubbele of verloren; volgende is de laatste seq van de pagina als er meer is; een tweede keer met hetzelfde na geeft hetzelfde antwoord (lezen verandert niets)', async () => {
    const t = start();
    const p = await pair(t);
    const uuids = vulAfgehandeld(t, p.id, 250);
    const paginas: Pagina[] = [];
    let na: number | undefined;
    for (let i = 0; i < 10; i++) {
      const pagina = await p.pagina(na === undefined ? {} : { na });
      paginas.push(pagina);
      if (pagina.volgende === null) break;
      expect(pagina.volgende).toBe(pagina.bevestigingen.at(-1)!.seq);
      na = pagina.volgende;
    }
    expect(paginas.map((x) => x.bevestigingen.length)).toEqual([BEVESTIGINGEN_PAGINA, BEVESTIGINGEN_PAGINA, 50]);
    const seqs = paginas.flatMap((x) => x.bevestigingen.map((b) => b.seq));
    expect([...seqs].sort((x, y) => x - y)).toEqual(seqs);
    expect(new Set(seqs).size).toBe(250);
    expect(paginas.flatMap((x) => x.bevestigingen.map((b) => b.uuid))).toEqual(uuids);
    expect(paginas[2]).toMatchObject({ volgende: null, bevestigd_tot: seqs.at(-1) });
    expect(paginas[0]!.bevestigd_tot).toBe(seqs[99]);
    // lezen verandert niets: dezelfde vraag geeft hetzelfde antwoord
    const voor = alle(t, 'SELECT * FROM sync_wachtrij ORDER BY id');
    expect(await p.pagina({ na: paginas[0]!.volgende })).toEqual(paginas[1]);
    expect(await p.pagina()).toEqual(paginas[0]);
    expect(alle(t, 'SELECT * FROM sync_wachtrij ORDER BY id')).toEqual(voor);
  });

  it('BEVEST-06 nieuw erbij: een daarna afgehandelde wijziging krijgt een hoger nummer dan alles wat al getoond is en verschijnt bij na gelijk aan het laatste nummer; een onverwerkte wachtrijrij wordt nooit getoond', async () => {
    const t = start();
    const p = await pair(t);
    vulAfgehandeld(t, p.id, 3);
    const eerste = await p.pagina();
    const laatste = eerste.bevestigd_tot;
    expect(eerste.bevestigingen).toHaveLength(3);
    // een rij die nog wacht
    const wachtrij = new SyncWachtrij(t.db, [], { now: () => t.clock.now });
    const wachtend = randomUUID();
    wachtrij.zetIn(p.id, 'M1', { entiteit: 'project', uuid: wachtend, revisie: 1, tijd: t.clock.now - DAG, velden: { titel: 'Wacht' } }, { entiteit: 'klant', uuid: randomUUID(), reden: 'klant-onbekend' });
    expect(await p.pagina({ na: laatste })).toMatchObject({ bevestigingen: [], bevestigd_tot: laatste });
    // daarna afgehandeld
    const nieuw = vulAfgehandeld(t, p.id, 1);
    const tweede = await p.pagina({ na: laatste });
    expect(tweede.bevestigingen.map((b) => b.uuid)).toEqual(nieuw);
    expect(tweede.bevestigingen[0]!.seq).toBeGreaterThan(laatste);
    expect(tweede.bevestigd_tot).toBe(tweede.bevestigingen[0]!.seq);
    expect((await p.pagina()).bevestigingen.map((b) => b.uuid)).not.toContain(wachtend);
    const wachtRij = wachtrij.rij(p.id, 'project', wachtend, 1)!;
    expect(wachtRij.verwerkt_seq).toBeNull();
    expect(wachtrij.markeer(wachtRij.id, 'overgeslagen', null)).toBe(true);
    const derde = await p.pagina({ na: tweede.bevestigd_tot });
    expect(derde.bevestigingen).toEqual([{ seq: wachtrij.rij(p.id, 'project', wachtend, 1)!.verwerkt_seq, entiteit: 'project', uuid: wachtend, revisie: 1, uitkomst: 'overgeslagen', fout: null }]);
    expect(derde.bevestigingen[0]!.seq).toBeGreaterThan(tweede.bevestigd_tot);
  });

  it('BEVEST-07 invoer: ontbrekend na is 0; een negatief, niet-geheel, te groot (boven de veilige gehele getallen), tekst- of null-na en een onbekend veld in het bericht geven 400 ongeldig zonder iets te lezen of te schrijven', async () => {
    const t = start();
    const p = await pair(t);
    vulAfgehandeld(t, p.id, 2);
    expect((await p.pagina()).bevestigingen).toHaveLength(2);
    expect((await p.pagina({ na: 0 })).bevestigingen).toHaveLength(2);
    expect(await p.pagina({ na: Number.MAX_SAFE_INTEGER })).toMatchObject({ bevestigingen: [], volgende: null, bevestigd_tot: Number.MAX_SAFE_INTEGER });
    const toestand = () => ({
      wachtrij: alle(t, 'SELECT * FROM sync_wachtrij ORDER BY id'),
      teller: alle(t, 'SELECT * FROM sync_teller ORDER BY naam'),
      register: alle(t, 'SELECT * FROM sync_ontvangen'),
      gezien: alle(t, 'SELECT id, last_seen_at FROM scanner_devices'),
    });
    const voor = toestand();
    const proto = JSON.parse('{"soort":"bevestigingen","__proto__":{"na":1}}') as Record<string, unknown>;
    const slecht: Record<string, unknown>[] = [
      { na: -1 },
      { na: 1.5 },
      { na: Number.MAX_SAFE_INTEGER + 1 },
      { na: 1e300 },
      { na: '1' },
      { na: null },
      { na: true },
      { na: [1] },
      { na: { n: 1 } },
      { extra: 1 },
      { na: 1, sinds: 0 },
      { apparaat_id: 'x' },
      proto,
    ];
    for (const extra of slecht) {
      const r = await p.verstuur({ ...(extra === proto ? {} : { soort: 'bevestigingen', tijd: t.clock.now }), ...extra });
      expect(r, JSON.stringify(extra)).toMatchObject({ status: 400, json: { ok: false, fout: 'ongeldig' } });
    }
    expect(toestand()).toEqual(voor);
  });

  it('BEVEST-08 privacy: het antwoord bevat per bevestiging precies de sleutels entiteit, uuid, revisie, uitkomst en fout (plus seq), geen wijziging-JSON, geen nummer, geen klantnaam of ander veld; getest op sleutels en ruwe bytes met geplante waarden', async () => {
    const t = start();
    const p = await pair(t);
    const klant = randomUUID();
    const klantNaam = 'Geheimbakker Zwartboek';
    const notitie = 'GEPLANTE-NOTITIE-4711';
    const project = randomUUID();
    const factuur = randomUUID();
    await p.wijzig('project', project, 1, { titel: 'Geplant project', klant, notities: notitie });
    await p.wijzig('factuur', factuur, 1, factuurVelden(klant, 1, { opmerking: 'GEPLANTE-OPMERKING-0815', klant_momentopname: { ...KLANT_SNAPSHOT, name: klantNaam, address: 'Geheimstraat 9' } }));
    await p.wijzig('klant', klant, 1, { naam: klantNaam });
    const dubbel = randomUUID();
    await p.wijzig('project', dubbel, 1, { titel: 'Kapot', klant });
    const antwoord = await p.vraag();
    const pagina = antwoord.json as unknown as Pagina;
    expect(pagina.bevestigingen.map((b) => b.entiteit).sort()).toEqual(['factuur', 'project']);
    expect(Object.keys(pagina).sort()).toEqual(['apparaatcode', 'bevestigd_tot', 'bevestigingen', 'ok', 'pcTijd', 'soort', 'volgende']);
    for (const b of pagina.bevestigingen) expect(Object.keys(b).sort()).toEqual(['entiteit', 'fout', 'revisie', 'seq', 'uitkomst', 'uuid']);
    // de ontsleutelde bytes van het antwoord bevatten geen geplante waarde
    const platte = JSON.stringify(antwoord.json);
    for (const geheim of [klantNaam, 'Geheimstraat', notitie, 'GEPLANTE-OPMERKING-0815', 'Geplant project', factuurNummer(1), klant, 'Bakkerij', 'wijziging', 'velden', 'nummer', 'klant_uuid']) {
      expect(platte, geheim).not.toContain(geheim);
    }
    expect(antwoord.raw.toString('utf8')).not.toContain(klantNaam);
    // de pc heeft de geplante waarden wel bewaard (de test test dus iets)
    expect(een<{ n: number }>(t, `SELECT COUNT(*) AS n FROM sync_wachtrij WHERE wijziging LIKE '%GEPLANTE-OPMERKING-0815%'`).n).toBe(1);
    // ook de functie zelf geeft alleen de whitelist
    const direct = leesBevestigingen(t.db, p.id, 0);
    for (const b of direct.bevestigingen) expect(Object.keys(b).sort()).toEqual(['entiteit', 'fout', 'revisie', 'seq', 'uitkomst', 'uuid']);
  });

  it('BEVEST-09 alleen lezen: het bericht verbruikt geen nummer van de teller wijziging, schrijft geen wachtrijrij en geen registerrij (alleen laatst gezien en de apparaatcode zoals bij stamgegevens)', async () => {
    const t = start();
    const p = await pair(t);
    vulAfgehandeld(t, p.id, 120);
    const toestand = () => ({
      teller: alle(t, 'SELECT naam, waarde FROM sync_teller ORDER BY naam'),
      wachtrij: alle(t, 'SELECT * FROM sync_wachtrij ORDER BY id'),
      register: alle(t, 'SELECT * FROM sync_ontvangen ORDER BY apparaat_id, entiteit, uuid, revisie'),
      relations: een<{ n: number }>(t, 'SELECT COUNT(*) AS n FROM relations').n,
      jobs: een<{ n: number }>(t, 'SELECT COUNT(*) AS n FROM jobs').n,
      invoices: een<{ n: number }>(t, 'SELECT COUNT(*) AS n FROM invoices').n,
      codes: alle(t, 'SELECT * FROM scanner_device_codes'),
    });
    const voor = toestand();
    const wijziging = teller(t.db, 'wijziging');
    const bevestiging = teller(t.db, 'bevestiging');
    const eerste = await p.pagina();
    await p.pagina({ na: eerste.volgende });
    await p.pagina({ na: 9999 });
    expect(toestand()).toEqual(voor);
    expect(teller(t.db, 'wijziging')).toBe(wijziging);
    expect(teller(t.db, 'bevestiging')).toBe(bevestiging);
    expect(bevestiging).toBe(120);
  });

  it('BEVEST-10 migratie: relatief getest (oude toestand uit migrations.slice met findIndex op een zoektekst uit de nieuwe migratie); bestaande rijen overleven; reeds afgehandelde rijen van voor de migratie hebben bevestigingsnummer NULL en worden niet getoond; user_version is gelijk aan migrations.length', () => {
    const eigen = migrations.findIndex((m) => /ADD COLUMN verwerkt_seq\b/.test(m));
    expect(eigen).toBeGreaterThan(0);
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    for (const m of migrations.slice(0, eigen)) db.exec(m);
    db.pragma(`user_version = ${eigen}`);
    expect(db.prepare(`SELECT 1 FROM sync_teller WHERE naam = 'bevestiging'`).get()).toBeUndefined();
    const voegToe = db.prepare(
      `INSERT INTO sync_wachtrij (apparaat_id, bron, entiteit, uuid, revisie, tijd, wijziging, wacht_op_entiteit, wacht_op_uuid, reden, ontvangen_op, verwerkt_op, verwerkt_uitkomst, verwerkt_reden)
       VALUES ('dev-1', 'M1', 'project', ?, 1, 1, '{}', 'klant', ?, 'klant-onbekend', 1, ?, ?, ?)`,
    );
    const afgehandeld = randomUUID();
    const wachtend = randomUUID();
    voegToe.run(afgehandeld, randomUUID(), 5, 'toegepast', null);
    voegToe.run(wachtend, randomUUID(), null, null, null);
    const voor = db.prepare('SELECT * FROM sync_wachtrij ORDER BY id').all() as Record<string, unknown>[];
    const tellerVoor = db.prepare(`SELECT waarde FROM sync_teller WHERE naam = 'wijziging'`).get();
    migrate(db);
    const na = db.prepare('SELECT * FROM sync_wachtrij ORDER BY id').all() as Record<string, unknown>[];
    expect(na).toHaveLength(2);
    expect(na.map(({ verwerkt_seq, ...rest }) => rest)).toEqual(voor);
    expect(na.map((r) => r.verwerkt_seq)).toEqual([null, null]);
    expect(db.prepare(`SELECT waarde FROM sync_teller WHERE naam = 'wijziging'`).get()).toEqual(tellerVoor);
    expect(teller(db, 'bevestiging')).toBe(0);
    expect(db.pragma('user_version', { simple: true })).toBe(migrations.length);
    // de afgehandelde rij van voor de migratie wordt niet getoond
    expect(leesBevestigingen(db, 'dev-1', 0)).toEqual({ bevestigingen: [], volgende: null, bevestigd_tot: 0 });
    // een rij die daarna wordt afgehandeld krijgt het eerste nummer
    const wachtrij = new SyncWachtrij(db);
    const rij = wachtrij.rij('dev-1', 'project', wachtend, 1)!;
    expect(wachtrij.markeer(rij.id, 'toegepast', null)).toBe(true);
    expect(leesBevestigingen(db, 'dev-1', 0).bevestigingen.map((b) => [b.seq, b.uuid])).toEqual([[1, wachtend]]);
    expect(afgehandeld).not.toBe(wachtend);
    // de migratie nog eens draaien verandert niets
    migrate(db);
    expect(teller(db, 'bevestiging')).toBe(1);
  });

  it('BEVEST-11 nummer per markering: SyncWachtrij.markeer geeft bij het afhandelen een nieuw nummer uit de nieuwe teller; een rij die al afgehandeld is behoudt haar nummer en verbruikt geen nieuw nummer; een teruggedraaide transactie geeft zijn nummer terug', () => {
    const t = start();
    const wachtrij = new SyncWachtrij(t.db, [], { now: () => t.clock.now });
    const maak = () => {
      const uuid = randomUUID();
      wachtrij.zetIn('dev-1', 'M1', { entiteit: 'project', uuid, revisie: 1, tijd: t.clock.now - DAG, velden: { titel: 'x' } }, { entiteit: 'klant', uuid: randomUUID(), reden: 'klant-onbekend' });
      return wachtrij.rij('dev-1', 'project', uuid, 1)!;
    };
    const begin = teller(t.db, 'bevestiging');
    const wijziging = teller(t.db, 'wijziging');
    const a = maak();
    const b = maak();
    const c = maak();
    expect(a.verwerkt_seq).toBeNull();
    expect(wachtrij.markeer(a.id, 'toegepast', null)).toBe(true);
    expect(wachtrij.rij('dev-1', 'project', a.uuid, 1)!.verwerkt_seq).toBe(begin + 1);
    expect(teller(t.db, 'bevestiging')).toBe(begin + 1);
    // nog eens markeren: niets verandert, geen nummer verbruikt
    const eerder = wachtrij.rij('dev-1', 'project', a.uuid, 1)!;
    expect(wachtrij.markeer(a.id, 'afgewezen', 'veld-ongeldig')).toBe(false);
    expect(wachtrij.rij('dev-1', 'project', a.uuid, 1)).toEqual(eerder);
    expect(teller(t.db, 'bevestiging')).toBe(begin + 1);
    // een teruggedraaide transactie geeft zijn nummer terug en laat de rij onverwerkt
    expect(() =>
      t.db.transaction(() => {
        expect(wachtrij.markeer(b.id, 'toegepast', null)).toBe(true);
        expect(teller(t.db, 'bevestiging')).toBe(begin + 2);
        throw new Error('teruggedraaid');
      })(),
    ).toThrow('teruggedraaid');
    expect(teller(t.db, 'bevestiging')).toBe(begin + 1);
    expect(wachtrij.rij('dev-1', 'project', b.uuid, 1)).toMatchObject({ verwerkt_op: null, verwerkt_seq: null });
    // het nummer wordt daarna wel gebruikt, zonder gat
    expect(wachtrij.markeer(b.id, 'overgeslagen', null)).toBe(true);
    expect(wachtrij.markeer(c.id, 'toegepast', null)).toBe(true);
    expect([b, c].map((r) => wachtrij.rij('dev-1', 'project', r.uuid, 1)!.verwerkt_seq)).toEqual([begin + 2, begin + 3]);
    // de wijzigingsteller blijft van de bevestigingen af
    expect(teller(t.db, 'wijziging')).toBe(wijziging);
  });

  it('BEVEST-12 ontkoppeld en niet gekoppeld: via de receiver geeft een niet-gekoppeld apparaat 401 niet-gekoppeld en een ontkoppeld apparaat krijgt zijn bevestigingen niet meer; versie 1 kent het bericht niet (400)', async () => {
    const t = start();
    const a = await pair(t);
    const b = await pair(t);
    const uuidsA = vulAfgehandeld(t, a.id, 2);
    vulAfgehandeld(t, b.id, 1);
    expect((await a.pagina()).bevestigingen.map((x) => x.uuid)).toEqual(uuidsA);
    // een telefoon met een verkeerde sleutel is niet gekoppeld
    const vreemd = phone({ ...decodePairing((await t.scanner.pair()).payload), sleutel: randomBytes(32).toString('base64url') }, t);
    const onbekend = await vreemd.vraag();
    expect(onbekend).toMatchObject({ status: 401, sealed: false, json: { ok: false, fout: 'niet-gekoppeld' } });
    expect(onbekend.raw.toString('utf8')).not.toContain(uuidsA[0]!);
    // versie 1 kent het bericht niet
    const v1 = await a.verstuur({ soort: 'bevestigingen', tijd: t.clock.now }, 1);
    expect(v1).toMatchObject({ status: 400, sealed: true, json: { ok: false, fout: 'ongeldig' } });
    expect(JSON.stringify(v1.json)).not.toContain(uuidsA[0]!);
    // ontkoppeld: geen bevestigingen meer, de andere telefoon wel
    await t.scanner.unpair(a.id);
    const weg = await a.vraag();
    expect(weg).toMatchObject({ status: 401, sealed: false, json: { ok: false, fout: 'niet-gekoppeld' } });
    expect(weg.raw.toString('utf8')).not.toContain(uuidsA[0]!);
    expect((await b.pagina()).bevestigingen).toHaveLength(1);
    // de rijen zelf blijven bestaan (er wordt niets verwijderd)
    expect(een<{ n: number }>(t, 'SELECT COUNT(*) AS n FROM sync_wachtrij WHERE apparaat_id = ?', a.id).n).toBe(2);
  });
});
