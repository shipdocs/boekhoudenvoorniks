import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup } from './helpers';
import { Bonnenscanner, type ScannerDeps } from '../src/scanner/scanner';
import { PHONE_SCANNER } from '../src/shared/phone-scanner';
import { CONTENT_TYPE, ENDPOINT_PATH, RULES_VERSION, decodePairing, encodeFrame, openResponse, sealRequest, type PairingPayload, type ProtocolVersion } from '../src/scanner/protocol';
import { KLANT_VELDEN, PROJECT_VELDEN } from '@gratis-boekhouden/kern';
import { veldOndergrens } from '../src/sync/ondergrens';
import { volgendeSyncSeq } from '../src/sync/teller';
import { CURSOR_MAX_TEKENS, STAMGEGEVENS_PAGINA, leesCursor, maakCursor } from '../src/sync/stamgegevens';
import { maakJobAan } from '../src/jobs/revisie';

// Het stamgegevens-antwoord van de pc (docs/bonnenscanner-protocol.md, deel `stamgegevens`): klanten en
// projecten per pagina, delta op de pc-teller sync_seq, de aliassen op de eerste pagina, alleen lezen en
// alleen de whitelist uit de administratie. De vervanger van de oude bevestigingstest staat in
// tests/bonnenscanner-v2.test.ts.

const LOOPBACK = [{ address: '127.0.0.1', netmask: '255.0.0.0' }];
const DAG = 24 * 60 * 60 * 1000;
const MIB = 1024 * 1024;

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
  const spoolDir = mkdtempSync(join(tmpdir(), 'bvn-stamgegevens-'));
  dirs.push(spoolDir);
  const clock = { now: Date.now() };
  const scanner = new Bonnenscanner({ db: t.db, secrets: t.secrets, intake: t.s.intake, settings: t.s.settings, spoolDir, interfaces: () => LOOPBACK, now: () => clock.now, ...extra });
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

interface VeldW {
  waarde: unknown;
  tijd: number;
  bron: string;
}
interface Item {
  uuid: string;
  seq: number;
  pc_revisie: number;
  gearchiveerd: boolean;
  velden: Record<string, VeldW>;
}
interface Pagina {
  ok: boolean;
  soort: string;
  pcTijd: number;
  apparaatcode: string;
  regels: number;
  klanten: Item[];
  projecten: Item[];
  aliassen: { alias_uuid: string; klant: string }[];
  volgende: string | null;
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
  const vraag = (extra: Record<string, unknown> = {}) => verstuur({ soort: 'stamgegevens', tijd: t.clock.now, ...extra });
  const pagina = async (extra: Record<string, unknown> = {}): Promise<Pagina> => {
    const r = await vraag(extra);
    expect(r.status).toBe(200);
    return r.json as unknown as Pagina;
  };
  /** de hele stroom: volgende opvragen tot hij null is */
  const alles = async (sinds?: number) => {
    const paginas: Pagina[] = [];
    let na: string | undefined;
    for (let i = 0; i < 20; i++) {
      const p = await pagina({ ...(sinds === undefined ? {} : { sinds }), ...(na ? { na } : {}) });
      paginas.push(p);
      if (p.volgende === null) break;
      na = p.volgende;
    }
    return { paginas, klanten: paginas.flatMap((p) => p.klanten), projecten: paginas.flatMap((p) => p.projecten) };
  };
  const hallo = () => verstuur({ soort: 'hallo', tijd: t.clock.now, naam: 'Pixel van Piet', app: '1.0.0' });
  /** een klant- of projectwijziging van deze telefoon; `tijd` is het bewerkmoment */
  const wijzig = (entiteit: 'klant' | 'project', uuid: string, revisie: number, tijd: number, velden: Record<string, unknown>) =>
    verstuur({ soort: 'wijziging', tijd: t.clock.now, wijziging: { entiteit, uuid, revisie, tijd, velden } });
  return { key, deviceId, verstuur, vraag, pagina, alles, hallo, wijzig };
}

async function pair(t: T) {
  const started = await t.scanner.pair();
  return phone(decodePairing(started.payload), t);
}

const rij = <R>(t: T, sql: string, ...params: unknown[]) => t.db.prepare(sql).get(...params) as R;

/** een klant van de telefoon, met een gelijke tijd voor iedereen (de volgorde komt dan alleen van sync_seq) */
function maakKlanten(t: T, aantal: number, tijd: number, notitie?: string) {
  const uuids: string[] = [];
  for (let i = 0; i < aantal; i++) {
    const uuid = randomUUID();
    t.s.relations.maakVanSync(uuid, { name: `Klant ${i}`, ...(notitie ? { notes: notitie } : {}) }, tijd, 'M9');
    uuids.push(uuid);
  }
  return uuids;
}

function maakProjecten(t: T, aantal: number, relationId: number) {
  for (let i = 0; i < aantal; i++) maakJobAan(t.db, { relationId, title: `Project ${i}` }, () => t.clock.now);
}

/** (seq, uuid) oplopend, strikt: dezelfde volgorde als de pc bedoelt */
function opVolgorde(items: Item[]): boolean {
  return items.every((it, i) => i === 0 || items[i - 1]!.seq < it.seq || (items[i - 1]!.seq === it.seq && items[i - 1]!.uuid < it.uuid));
}

function controlesom(t: T, tabellen: string[]): Record<string, { n: number; sha: string }> {
  const uit: Record<string, { n: number; sha: string }> = {};
  for (const tabel of tabellen) {
    const rijen = t.db.prepare(`SELECT * FROM ${tabel} ORDER BY rowid`).all();
    uit[tabel] = { n: rijen.length, sha: createHash('sha256').update(JSON.stringify(rijen)).digest('hex') };
  }
  return uit;
}

describe('stamgegevens: paginering en delta', () => {
  it('paginering 250 klanten en 120 projecten', async () => {
    const t = start();
    const p = await pair(t);
    maakKlanten(t, 250, t.clock.now);
    maakProjecten(t, 120, t.klant.id);
    const verwachtK = rij<{ n: number }>(t, `SELECT COUNT(*) AS n FROM relations WHERE type IN ('klant','beide')`).n;
    const verwachtP = rij<{ n: number }>(t, `SELECT COUNT(*) AS n FROM jobs`).n;
    expect(verwachtK).toBe(252);
    expect(verwachtP).toBe(120);

    const stroom = await p.alles();
    // steeds volgende opvragen: nooit meer dan 100 items, alleen de laatste pagina heeft geen volgende
    expect(stroom.paginas.every((x) => x.klanten.length + x.projecten.length <= STAMGEGEVENS_PAGINA)).toBe(true);
    expect(stroom.paginas.map((x) => x.klanten.length + x.projecten.length)).toEqual([100, 100, 100, 72]);
    expect(stroom.paginas.slice(0, -1).every((x) => x.volgende !== null)).toBe(true);
    expect(stroom.paginas.at(-1)!.volgende).toBeNull();
    // alles precies een keer
    expect(stroom.klanten).toHaveLength(verwachtK);
    expect(stroom.projecten).toHaveLength(verwachtP);
    expect(new Set(stroom.klanten.map((k) => k.uuid)).size).toBe(verwachtK);
    expect(new Set(stroom.projecten.map((k) => k.uuid)).size).toBe(verwachtP);
    // vaste volgorde: eerst alle klanten, dan alle projecten, elk op (seq, uuid)
    expect(opVolgorde(stroom.klanten)).toBe(true);
    expect(opVolgorde(stroom.projecten)).toBe(true);
    const soortPerPagina = stroom.paginas.map((x) => (x.klanten.length > 0 ? 'k' : '') + (x.projecten.length > 0 ? 'p' : ''));
    expect(soortPerPagina).toEqual(['k', 'k', 'kp', 'p']);
    // en dezelfde vraag nog eens geeft dezelfde stroom
    const nog = await p.alles();
    expect(nog.paginas.map((x) => x.volgende)).toEqual(stroom.paginas.map((x) => x.volgende));
    expect(nog.klanten.map((k) => k.uuid)).toEqual(stroom.klanten.map((k) => k.uuid));
  });

  it('precies 100 items geeft geen volgende, 101 wel', async () => {
    const t = start();
    const p = await pair(t);
    maakKlanten(t, 98, t.clock.now);
    const vol = await p.pagina();
    expect(vol.klanten).toHaveLength(100);
    expect(vol.volgende).toBeNull();
    maakProjecten(t, 1, t.klant.id);
    const meer = await p.alles();
    expect(meer.paginas.map((x) => x.klanten.length + x.projecten.length)).toEqual([100, 1]);
    expect(meer.paginas[0]!.volgende).not.toBeNull();
    expect(meer.paginas[1]).toMatchObject({ klanten: [], volgende: null });
  });

  it('sinds levert alleen gewijzigde', async () => {
    const t = start();
    const p = await pair(t);
    const [uuid] = maakKlanten(t, 3, t.clock.now);
    maakProjecten(t, 2, t.klant.id);
    const eerst = await p.alles();
    const hoogste = Math.max(...eerst.klanten.map((k) => k.seq), ...eerst.projecten.map((k) => k.seq));
    // niets veranderd: een delta is leeg
    const leeg = await p.alles(hoogste);
    expect(leeg.klanten).toEqual([]);
    expect(leeg.projecten).toEqual([]);
    // een klant en een project veranderen op de pc
    const id = rij<{ id: number }>(t, 'SELECT id FROM relations WHERE uuid = ?', uuid).id;
    t.s.relations.update(id, { phone: '030-1234567' });
    const jobId = rij<{ id: number }>(t, 'SELECT id FROM jobs ORDER BY id LIMIT 1').id;
    t.s.jobs.update(jobId, { notes: 'Aangepast' });
    const delta = await p.alles(hoogste);
    expect(delta.klanten.map((k) => k.uuid)).toEqual([uuid]);
    expect(delta.projecten).toHaveLength(1);
    expect(delta.klanten[0]!.velden.telefoon!.waarde).toBe('030-1234567');
    expect(delta.klanten[0]!.seq).toBeGreaterThan(hoogste);
    expect(delta.projecten[0]!.velden.notities!.waarde).toBe('Aangepast');
    // de aliassen horen niet bij een delta-selectie maar staan wel op de eerste pagina: hier leeg omdat er geen zijn
    expect(delta.paginas[0]!.aliassen).toEqual([]);
  });

  it('sinds gelijk aan seq levert het item niet', async () => {
    const t = start();
    const p = await pair(t);
    maakKlanten(t, 3, t.clock.now);
    const alle = await p.alles();
    const seqs = alle.klanten.map((k) => k.seq).sort((a, b) => a - b);
    const tweede = seqs[seqs.length - 2]!;
    const laatste = seqs[seqs.length - 1]!;
    // strikt groter dan: met sinds = seq van het voorlaatste item komt alleen het laatste mee
    const na = await p.alles(tweede);
    expect(na.klanten.map((k) => k.seq)).toEqual([laatste]);
    // en met sinds = het hoogste seq niets meer
    expect((await p.alles(laatste)).klanten).toEqual([]);
    // sinds ver voorbij alles geeft ook niets, en is geen fout
    expect((await p.alles(laatste + 1_000_000)).klanten).toEqual([]);
  });

  it('late wijziging komt in delta van tweede telefoon', async () => {
    const t = start();
    const a = await pair(t);
    const b = await pair(t);
    await a.hallo();
    await b.hallo();
    // telefoon A heeft alles opgehaald en onthoudt het hoogste seq
    const eerst = await a.alles();
    const hoogste = Math.max(...eerst.klanten.map((k) => k.seq));
    // telefoon B meldt een klant die hij drie dagen geleden heeft bewerkt (offline) en pas nu aankomt
    const uuid = randomUUID();
    const drieDagenGeleden = t.clock.now - 3 * DAG;
    const r = await b.wijzig('klant', uuid, 1, drieDagenGeleden, { naam: 'Offline Oma' });
    expect(r).toMatchObject({ status: 200, json: { uitkomst: 'toegepast' } });
    // de delta van A (sinds ver voorbij die bewerktijd) bevat hem toch: de delta loopt op sync_seq
    const delta = await a.alles(hoogste);
    expect(delta.klanten.map((k) => k.uuid)).toEqual([uuid]);
    expect(delta.klanten[0]!.velden.naam).toEqual({ waarde: 'Offline Oma', tijd: drieDagenGeleden, bron: 'M2' });
    expect(delta.klanten[0]!.seq).toBeGreaterThan(hoogste);
    // een latere (maar nog altijd oude) wijziging van B aan hetzelfde veld komt ook in de volgende delta
    const nieuwHoogste = delta.klanten[0]!.seq;
    const r2 = await b.wijzig('klant', uuid, 2, t.clock.now - 2 * DAG, { plaats: 'Utrecht' });
    expect(r2).toMatchObject({ status: 200, json: { uitkomst: 'toegepast' } });
    const delta2 = await a.alles(nieuwHoogste);
    expect(delta2.klanten.map((k) => k.uuid)).toEqual([uuid]);
    expect(delta2.klanten[0]!.velden.plaats).toMatchObject({ waarde: 'Utrecht', tijd: t.clock.now - 2 * DAG, bron: 'M2' });
  });

  it('delta levert gearchiveerde klant', async () => {
    const t = start();
    const p = await pair(t);
    const [uuid] = maakKlanten(t, 2, t.clock.now);
    const eerst = await p.alles();
    const hoogste = Math.max(...eerst.klanten.map((k) => k.seq));
    expect(eerst.klanten.find((k) => k.uuid === uuid)!.gearchiveerd).toBe(false);
    t.s.relations.archive(rij<{ id: number }>(t, 'SELECT id FROM relations WHERE uuid = ?', uuid).id);
    const delta = await p.alles(hoogste);
    expect(delta.klanten).toHaveLength(1);
    expect(delta.klanten[0]).toMatchObject({ uuid, gearchiveerd: true });
    expect(delta.klanten[0]!.velden.gearchiveerd!.waarde).toBe(1);
    // ook in de volledige stroom blijft de gearchiveerde klant staan: de pc verwijdert nooit
    expect((await p.alles()).klanten.some((k) => k.uuid === uuid && k.gearchiveerd)).toBe(true);
    // en een project dat een telefoon archiveert komt ook in de delta
    maakProjecten(t, 1, t.klant.id);
    const pUuid = rij<{ uuid: string }>(t, 'SELECT uuid FROM jobs').uuid;
    const hoogste2 = Math.max(...(await p.alles()).projecten.map((k) => k.seq));
    expect(await p.wijzig('project', pUuid, 1, t.clock.now + 1000, { gearchiveerd: 1 })).toMatchObject({ status: 200, json: { uitkomst: 'toegepast' } });
    const deltaP = await p.alles(hoogste2);
    expect(deltaP.projecten).toHaveLength(1);
    expect(deltaP.projecten[0]).toMatchObject({ uuid: pUuid, gearchiveerd: true });
  });
});

describe('stamgegevens: strenge controle van het verzoek', () => {
  const geenLek = (r: Reply) => {
    const tekst = JSON.stringify(r.json);
    expect(tekst).not.toMatch(/stack|Error|\bat \w|node_modules|\.ts:/);
    expect(r.json).toEqual({ ok: false, fout: 'ongeldig' });
  };

  it('verknoeide cursor geeft ongeldig', async () => {
    const t = start();
    const p = await pair(t);
    maakKlanten(t, 120, t.clock.now);
    const echt = (await p.pagina()).volgende!;
    expect(echt).toBeTruthy();
    // de echte cursor werkt
    expect((await p.vraag({ na: echt })).status).toBe(200);
    const json = Buffer.from(echt, 'base64url').toString('utf8');
    const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
    const u = randomUUID();
    const verknoeid = [
      echt.slice(0, -2),
      echt + 'AA',
      echt.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')),
      `${echt}=`,
      'geen cursor!',
      '!!!',
      b64('geen json'),
      b64('[]'),
      b64('null'),
      b64(JSON.stringify({ s: 'k', t: 5 })),
      b64(JSON.stringify({ s: 'k', t: 5, u, x: 1 })),
      b64(JSON.stringify({ s: 'x', t: 5, u })),
      b64(JSON.stringify({ s: 'k', t: -1, u })),
      b64(JSON.stringify({ s: 'k', t: 1.5, u })),
      b64(JSON.stringify({ s: 'k', t: '5', u })),
      b64(JSON.stringify({ s: 'k', t: 5, u: u.toUpperCase() })),
      b64(JSON.stringify({ s: 'k', t: 5, u: "x'; DROP TABLE relations; --" })),
      b64(JSON.stringify({ s: 'k', t: '5 OR 1=1', u })),
      b64(json.replace('"s"', ' "s"')),
      b64(JSON.stringify({ u, t: 5, s: 'k' })),
      b64(JSON.stringify({ s: 'k', t: Number.MAX_SAFE_INTEGER + 2, u })),
      '',
    ];
    for (const na of verknoeid) {
      const r = await p.vraag({ na });
      expect(r, JSON.stringify(na)).toMatchObject({ status: 400, sealed: true });
      geenLek(r);
    }
    // alle tabellen zijn er nog
    expect(rij<{ n: number }>(t, 'SELECT COUNT(*) AS n FROM relations').n).toBe(122);
  });

  it('verzoek met onbekende sleutel, sinds als tekst of negatief, of te lange na geeft 400 ongeldig', async () => {
    const t = start();
    const p = await pair(t);
    const geldig = maakCursor({ s: 'k', t: 1, u: randomUUID() });
    const slecht: Record<string, unknown>[] = [
      { limiet: 5 },
      { extra: 'x', sinds: 0 },
      { sinds: '5' },
      { sinds: 'nul' },
      { sinds: -1 },
      { sinds: 1.5 },
      { sinds: null },
      { sinds: true },
      { sinds: [1] },
      { sinds: 2 ** 60 },
      { na: 5 },
      { na: null },
      { na: {} },
      { na: 'a'.repeat(CURSOR_MAX_TEKENS + 1) },
      { na: geldig, sinds: -3 },
      { na: geldig, soort2: 'k' },
    ];
    for (const extra of slecht) {
      const r = await p.vraag(extra);
      expect(r, JSON.stringify(extra)).toMatchObject({ status: 400, sealed: true });
      geenLek(r);
    }
    // __proto__ als sleutel: letterlijk in de JSON, dus een eigen sleutel na het inlezen
    const proto = await p.verstuur(JSON.parse(`{"soort":"stamgegevens","tijd":${t.clock.now},"__proto__":{"sinds":0}}`) as Record<string, unknown>);
    expect(proto).toMatchObject({ status: 400, sealed: true });
    geenLek(proto);
    // en een geldig verzoek met alleen toegestane sleutels werkt
    expect((await p.vraag({ sinds: 0 })).status).toBe(200);
    expect((await p.vraag({ sinds: 0, na: geldig })).status).toBe(200);
  });

  it('een stamgegevens-verzoek in een v1-envelop wordt geweigerd en geeft niets uit de administratie', async () => {
    const t = start();
    const p = await pair(t);
    const r = await p.verstuur({ soort: 'stamgegevens', tijd: t.clock.now, sinds: 0 }, 1);
    expect(r).toMatchObject({ status: 400, sealed: true });
    expect(r.json).toEqual({ ok: false, fout: 'ongeldig' });
  });

  it('een onbekende telefoon of een verkeerde sleutel krijgt niets uit de administratie', async () => {
    const t = start();
    const p = await pair(t);
    const vreemd = phone({ ...decodePairing((await t.scanner.pair()).payload), sleutel: randomBytes(32).toString('base64url') }, t);
    const r = await vreemd.vraag();
    expect(r.status).toBe(401);
    expect(r.sealed).toBe(false);
    expect(r.json).toEqual({ ok: false, fout: 'niet-gekoppeld' });
    expect(r.raw.toString('utf8')).not.toContain('Familie Jansen');
    // de gekoppelde telefoon krijgt wel antwoord
    expect((await p.pagina()).klanten.length).toBeGreaterThan(0);
  });

  it('de cursor is streng: alleen wat de pc zelf maakt komt erdoor', () => {
    const u = randomUUID();
    const c = maakCursor({ s: 'p', t: 7, u });
    expect(leesCursor(c)).toEqual({ s: 'p', t: 7, u });
    expect(c.length).toBeLessThanOrEqual(CURSOR_MAX_TEKENS);
    expect(Buffer.from(c, 'base64url').toString('utf8')).toBe(JSON.stringify({ s: 'p', t: 7, u }));
    for (const slecht of [undefined, null, 5, '', 'x'.repeat(CURSOR_MAX_TEKENS + 1), `${c}==`, c.toUpperCase(), Buffer.from(JSON.stringify({ s: 'p', t: 7, u, w: 1 })).toString('base64url')]) {
      expect(leesCursor(slecht)).toBeNull();
    }
  });
});

describe('stamgegevens: privacygrens', () => {
  /** een administratie met bewust herkenbare gegevens die nooit naar een telefoon mogen */
  function plant(t: T) {
    const leverancier = t.s.relations.create({
      name: 'GEHEIMLEVERANCIER Staalhandel BV',
      type: 'leverancier',
      email: 'inkoop@geheimleverancier.example',
      iban: 'NL02ABNA0123456789',
      vat_number: 'NL851234567B01',
      notes: 'GEHEIMNOTITIE korting 40 procent',
    });
    t.db.prepare(`UPDATE relations SET paid_with = 'prive' WHERE id = ?`).run(leverancier.id);
    const prive = t.s.relations.create({ name: 'PRIVELEVERANCIER Tuincentrum', type: 'leverancier', iban: 'NL86INGB0002445588' });
    t.db.prepare(`UPDATE relations SET paid_with = 'prive' WHERE id = ?`).run(prive.id);
    t.db.prepare(`INSERT INTO purchase_invoices (relation_id, supplier_reference, invoice_date, description, subtotal, vat_total, total) VALUES (?, 'INKOOPREF-77', '2020-01-02', 'GEHEIMINKOOP staal', 123456, 25925, 149381)`).run(leverancier.id);
    t.db.prepare(`INSERT INTO invoices (relation_id, number, invoice_date, due_date, reference, notes) VALUES (?, 'FACTUURNR-9001', '2020-01-02', '2020-02-01', 'FACTREF-ZEER-GEHEIM', 'FACTUURNOTITIE')`).run(t.klant.id);
    const rekening = rij<{ id: number }>(t, 'SELECT id FROM chart_of_accounts ORDER BY id LIMIT 1').id;
    const bank = Number(t.db.prepare(`INSERT INTO bank_accounts (name, iban, account_id) VALUES ('GEHEIMEBANK zakelijk', 'NL91RABO0315273637', ?)`).run(rekening).lastInsertRowid);
    t.db.prepare(`INSERT INTO bank_transactions (bank_account_id, transaction_date, amount, counter_iban, counter_name, description, source, dedup_hash) VALUES (?, '2020-01-03', -149381, 'NL02ABNA0123456789', 'GEHEIMTEGENPARTIJ', 'BANKOMSCHRIJVING-GEHEIM', 'csv', 'hash-privacy-1')`).run(bank);
    t.db.prepare(`INSERT INTO journal_entries (entry_date, description, source) VALUES ('2020-01-04', 'GEHEIMBOEKING memoriaal', 'handmatig')`).run();
    return [
      'GEHEIMLEVERANCIER', 'inkoop@geheimleverancier.example', 'NL02ABNA0123456789', 'NL851234567B01', 'GEHEIMNOTITIE', 'PRIVELEVERANCIER', 'NL86INGB0002445588', 'INKOOPREF-77', 'GEHEIMINKOOP', 'FACTUURNR-9001',
      'FACTREF-ZEER-GEHEIM', 'FACTUURNOTITIE', 'GEHEIMEBANK', 'NL91RABO0315273637', 'GEHEIMTEGENPARTIJ', 'BANKOMSCHRIJVING-GEHEIM', 'GEHEIMBOEKING',
      // de administratie zelf (bedrijfsgegevens en instellingen uit setup())
      'Stukadoorsbedrijf Piet', 'Kalkweg 1', 'piet@example.nl', 'NL123456789B01', 'NL91ABNA0417164300',
    ];
  }

  it('privacy sleutels whitelist', async () => {
    const t = start();
    const p = await pair(t);
    plant(t);
    const lev = rij<{ id: number }>(t, `SELECT id FROM relations WHERE type = 'leverancier' ORDER BY id LIMIT 1`).id;
    maakProjecten(t, 2, t.klant.id);
    maakProjecten(t, 1, lev);
    const [uuid] = maakKlanten(t, 1, t.clock.now, 'een notitie');
    t.s.relations.update(rij<{ id: number }>(t, 'SELECT id FROM relations WHERE uuid = ?', uuid).id, { phone: '06-12345678' });
    const alle = await p.alles();
    expect(Object.keys(alle.paginas[0]!).sort()).toEqual(['aliassen', 'apparaatcode', 'klanten', 'ok', 'pcTijd', 'projecten', 'regels', 'soort', 'volgende']);
    expect(alle.klanten.length).toBeGreaterThan(0);
    expect(alle.projecten.length).toBe(2);
    const itemSleutels = ['gearchiveerd', 'pc_revisie', 'seq', 'uuid', 'velden'];
    for (const k of alle.klanten) {
      expect(Object.keys(k).sort()).toEqual(itemSleutels);
      expect(Object.keys(k.velden).sort()).toEqual(Object.keys(KLANT_VELDEN).sort());
      for (const v of Object.values(k.velden)) expect(Object.keys(v).sort()).toEqual(['bron', 'tijd', 'waarde']);
    }
    for (const pr of alle.projecten) {
      expect(Object.keys(pr).sort()).toEqual(itemSleutels);
      expect(Object.keys(pr.velden).sort()).toEqual(Object.keys(PROJECT_VELDEN).sort());
      for (const v of Object.values(pr.velden)) expect(Object.keys(v).sort()).toEqual(['bron', 'tijd', 'waarde']);
    }
    // nergens, op geen enkel niveau, een sleutel buiten de whitelist (type, paid_with, id's, bedrijfsgegevens, ...)
    const toegestaan = new Set([...itemSleutels, ...Object.keys(KLANT_VELDEN), ...Object.keys(PROJECT_VELDEN), 'bron', 'tijd', 'waarde', 'ok', 'soort', 'pcTijd', 'apparaatcode', 'regels', 'klanten', 'projecten', 'aliassen', 'volgende', 'alias_uuid', 'klant']);
    const sleutels = new Set<string>();
    const loop = (x: unknown) => {
      if (Array.isArray(x)) x.forEach(loop);
      else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) (sleutels.add(k), loop(v));
    };
    alle.paginas.forEach(loop);
    expect([...sleutels].filter((s) => !toegestaan.has(s))).toEqual([]);
    // het project van een leverancier is er niet bij, de uuid's zijn UUID's en de klant van een project is een uuid
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    for (const pr of alle.projecten) expect(String(pr.velden.klant!.waarde)).toMatch(uuidRe);
    for (const it of [...alle.klanten, ...alle.projecten]) expect(it.uuid).toMatch(uuidRe);
  });

  it('privacy waarden niet in ruwe bytes', async () => {
    const t = start();
    const p = await pair(t);
    const geheim = plant(t);
    const lev = rij<{ id: number }>(t, `SELECT id FROM relations WHERE type = 'leverancier' ORDER BY id LIMIT 1`).id;
    maakProjecten(t, 1, lev);
    maakProjecten(t, 1, t.klant.id);
    // ook een tweede pagina en een delta, want ook daar mag niets weglekken
    maakKlanten(t, 120, t.clock.now);
    const gezien: Buffer[] = [];
    for (let na: string | undefined, i = 0; i < 5; i++) {
      const r = await p.vraag(na ? { na } : {});
      expect(r.status).toBe(200);
      gezien.push(Buffer.from(JSON.stringify(r.json), 'utf8'), r.raw);
      na = (r.json as unknown as Pagina).volgende ?? undefined;
      if (!na) break;
    }
    gezien.push(Buffer.from(JSON.stringify((await p.vraag({ sinds: 0 })).json)));
    // de klanten zelf zijn er wel (de proef is dus niet leeg)
    expect(gezien[0]!.toString('utf8')).toContain('Familie Jansen');
    for (const waarde of geheim) {
      for (const bytes of gezien) expect(bytes.includes(Buffer.from(waarde, 'utf8')), waarde).toBe(false);
    }
    // het IBAN van een klant is een klantveld en mag wel, dat van de administratie zelf niet
    expect(gezien[0]!.toString('utf8')).toContain('NL44RABO0123456789');
  });

  it('privacy project van leverancier wordt niet geleverd', async () => {
    const t = start();
    const p = await pair(t);
    const lev = t.s.relations.create({ name: 'Leverancier met project', type: 'leverancier' });
    const beide = t.s.relations.create({ name: 'Zowel klant als leverancier', type: 'beide' });
    maakJobAan(t.db, { relationId: lev.id, title: 'LEVERANCIERSPROJECT' }, () => t.clock.now);
    maakJobAan(t.db, { relationId: beide.id, title: 'Project van beide' }, () => t.clock.now);
    maakJobAan(t.db, { relationId: t.klant.id, title: 'Project van klant' }, () => t.clock.now);
    // een project zonder (bestaande) relatie wordt wel geleverd, met klant null
    t.db.pragma('foreign_keys = OFF');
    t.db.prepare(`INSERT INTO jobs (relation_id, title, uuid, sync_seq) VALUES (987654, 'Project zonder klant', ?, ?)`).run(randomUUID(), volgendeSyncSeq(t.db));
    t.db.pragma('foreign_keys = ON');
    // rijen zonder uuid of met sync_seq 0 (van een oudere app-versie) worden niet geleverd
    t.db.prepare(`INSERT INTO jobs (relation_id, title, uuid, sync_seq) VALUES (?, 'Zonder uuid', NULL, ?)`).run(t.klant.id, volgendeSyncSeq(t.db));
    t.db.prepare(`INSERT INTO jobs (relation_id, title, uuid, sync_seq) VALUES (?, 'Zonder nummer', ?, 0)`).run(t.klant.id, randomUUID());
    t.db.prepare(`INSERT INTO relations (type, name, uuid, sync_seq) VALUES ('klant', 'Klant zonder nummer', ?, 0)`).run(randomUUID());
    t.db.prepare(`INSERT INTO relations (type, name, uuid, sync_seq) VALUES ('klant', 'Klant zonder uuid', NULL, ?)`).run(volgendeSyncSeq(t.db));
    const alle = await p.alles();
    const titels = alle.projecten.map((x) => x.velden.titel!.waarde).sort();
    expect(titels).toEqual(['Project van beide', 'Project van klant', 'Project zonder klant']);
    expect(JSON.stringify(alle.paginas)).not.toContain('LEVERANCIERSPROJECT');
    expect(JSON.stringify(alle.paginas)).not.toContain('Leverancier met project');
    const zonder = alle.projecten.find((x) => x.velden.titel!.waarde === 'Project zonder klant')!;
    expect(zonder.velden.klant!.waarde).toBeNull();
    expect(alle.projecten.find((x) => x.velden.titel!.waarde === 'Project van beide')!.velden.klant!.waarde).toBe(beide.uuid);
    const namen = alle.klanten.map((x) => x.velden.naam!.waarde);
    expect(namen).toContain('Zowel klant als leverancier');
    expect(namen).not.toContain('Leverancier met project');
    expect(namen).not.toContain('Klant zonder nummer');
    expect(namen).not.toContain('Klant zonder uuid');
  });
});

describe('stamgegevens: alleen lezen', () => {
  it('alleen lezen rijtelling en checksum', async () => {
    const t = start();
    const p = await pair(t);
    const a = await pair(t);
    await a.hallo();
    await p.hallo();
    maakKlanten(t, 130, t.clock.now);
    maakProjecten(t, 3, t.klant.id);
    t.db.prepare('INSERT INTO relation_aliases (alias_uuid, relation_id, aangemaakt_op) VALUES (?, ?, ?)').run(randomUUID(), t.klant.id, t.clock.now);
    // een ontvangen wijziging en een wachtende wijziging, zodat die tabellen niet leeg zijn
    expect(await p.wijzig('klant', randomUUID(), 1, t.clock.now, { naam: 'Telefoonklant' })).toMatchObject({ status: 200 });
    expect(await p.wijzig('project', randomUUID(), 1, t.clock.now, { titel: 'Wachtend', klant: randomUUID() })).toMatchObject({ status: 200, json: { uitkomst: 'wacht' } });
    const tabellen = ['relations', 'jobs', 'relation_aliases', 'relation_field_rev', 'job_field_rev', 'sync_ontvangen', 'sync_wachtrij', 'sync_teller', 'relation_changelog', 'job_changelog'];
    const voor = controlesom(t, tabellen);
    for (const tel of ['sync_ontvangen', 'sync_wachtrij', 'relation_aliases']) expect(voor[tel]!.n, tel).toBeGreaterThan(0);
    // eerste pagina, volgende pagina's, een delta en een vraag met een ongeldige cursor
    await p.alles();
    await a.alles(5);
    await a.vraag({ na: 'onzin' });
    await a.vraag({ sinds: 3 });
    expect(controlesom(t, tabellen)).toEqual(voor);
  });
});

describe('stamgegevens: aliassen, apparaatcode en gegevens per rij', () => {
  it('aliassen in antwoord op eerste pagina', async () => {
    const t = start();
    const p = await pair(t);
    maakKlanten(t, 150, t.clock.now);
    const doel = rij<{ id: number; uuid: string }>(t, 'SELECT id, uuid FROM relations WHERE id = ?', t.klant.id);
    const lev = t.s.relations.create({ name: 'Een leverancier', type: 'leverancier' });
    const a1 = randomUUID();
    const a2 = randomUUID();
    const a3 = randomUUID();
    const insert = t.db.prepare('INSERT INTO relation_aliases (alias_uuid, relation_id, aangemaakt_op) VALUES (?, ?, ?)');
    insert.run(a1, doel.id, t.clock.now - DAG);
    insert.run(a2, doel.id, t.clock.now);
    insert.run(a3, lev.id, t.clock.now); // alias van een leverancier: nooit mee
    const verwacht = [a1, a2].sort().map((alias_uuid) => ({ alias_uuid, klant: doel.uuid }));
    const stroom = await p.alles();
    expect(stroom.paginas.length).toBeGreaterThan(1);
    expect(stroom.paginas[0]!.aliassen).toEqual(verwacht);
    // geen aliassen op een vervolgpagina, en ze tellen niet mee in de 100 items
    for (const vervolg of stroom.paginas.slice(1)) expect(vervolg.aliassen).toEqual([]);
    expect(stroom.paginas[0]!.klanten).toHaveLength(100);
    // ook bij een delta (met sinds), zelfs als er niets nieuws is, staan ze op de eerste pagina
    const hoogste = Math.max(...stroom.klanten.map((k) => k.seq));
    const delta = await p.alles(hoogste);
    expect(delta.klanten).toEqual([]);
    expect(delta.paginas).toHaveLength(1);
    expect(delta.paginas[0]!.aliassen).toEqual(verwacht);
    // een vervolgpagina met sinds heeft ze niet
    const vervolg = await p.pagina({ sinds: 0, na: stroom.paginas[0]!.volgende! });
    expect(vervolg.aliassen).toEqual([]);
    expect(JSON.stringify(stroom.paginas)).not.toContain(a3);
  });

  it('ander apparaat eigen apparaatcode', async () => {
    const t = start();
    const a = await pair(t);
    const b = await pair(t);
    const helloA = (await a.hallo()).json!;
    const helloB = (await b.hallo()).json!;
    expect(helloA.apparaatcode).toBe('M1');
    expect(helloB.apparaatcode).toBe('M2');
    const pa = await a.pagina();
    const pb = await b.pagina();
    expect(pa.apparaatcode).toBe('M1');
    expect(pb.apparaatcode).toBe('M2');
    // dezelfde gegevens, alleen de apparaatcode verschilt
    const zonder = (x: Pagina) => ({ ...x, apparaatcode: undefined });
    expect(zonder(pa)).toEqual(zonder(pb));
    // pcTijd en regels zijn gelijk aan het hallo-antwoord
    expect(pa.pcTijd).toBe(helloA.pcTijd);
    expect(pb.pcTijd).toBe(helloB.pcTijd);
    expect(pa.regels).toBe(RULES_VERSION);
    expect(pa.regels).toBe(((await a.verstuur({ soort: 'hallo', tijd: t.clock.now, naam: 'x', app: '1' }, 2)).json!.regels as number));
    expect(pa.pcTijd).toBe(t.clock.now);
  });

  it('een telefoon die nog niets heeft gestuurd krijgt zijn apparaatcode bij de eerste vraag om stamgegevens', async () => {
    const t = start();
    const a = await pair(t);
    expect((await a.pagina()).apparaatcode).toBe('M1');
    expect(rij<{ n: number }>(t, 'SELECT COUNT(*) AS n FROM scanner_device_codes').n).toBe(1);
    expect((await a.pagina()).apparaatcode).toBe('M1');
    expect(rij<{ n: number }>(t, 'SELECT COUNT(*) AS n FROM scanner_device_codes').n).toBe(1);
  });

  it('volle pagina onder 1 MiB', async () => {
    const t = start();
    const p = await pair(t);
    // 100 klanten met notities van 4000 tekens uit tweebyte-tekens (WIJZIGING_LIMIETEN.maxTekens)
    const notitie = 'é'.repeat(4000);
    expect(Buffer.byteLength(notitie, 'utf8')).toBe(8000);
    t.db.prepare(`UPDATE relations SET notes = ? WHERE 1 = 1`).run(notitie);
    maakKlanten(t, 98, t.clock.now, notitie);
    const r = await p.vraag();
    expect(r.status).toBe(200);
    const pagina = r.json as unknown as Pagina;
    expect(pagina.klanten).toHaveLength(100);
    expect(pagina.klanten.every((k) => k.velden.notities!.waarde === notitie)).toBe(true);
    expect(pagina.volgende).toBeNull();
    // de versleutelde envelop, zoals hij over het netwerk gaat, blijft onder 1 MiB (en onder maxBodyBytes)
    expect(r.raw.length).toBeLessThan(MIB);
    expect(r.raw.length).toBeGreaterThan(800_000);
    // niets afgekapt
    expect(pagina.klanten.every((k) => String(k.velden.notities!.waarde).length === 4000)).toBe(true);
  });

  it('rij zonder veldrevisies', async () => {
    const t = start();
    const p = await pair(t);
    const vroeger = Math.floor((t.clock.now - 10 * DAG) / 1000) * 1000;
    const uuid = randomUUID();
    const jobUuid = randomUUID();
    // rijen van vóór de sync: geen veldrijen, created_at in SQLite-tekst (UTC, zonder T of Z)
    const id = Number(
      t.db.prepare(`INSERT INTO relations (type, name, email, uuid, sync_seq, created_at) VALUES ('klant', 'Oude Klant', 'oud@example.nl', ?, ?, datetime(? / 1000, 'unixepoch'))`).run(uuid, volgendeSyncSeq(t.db), vroeger).lastInsertRowid,
    );
    t.db.prepare(`INSERT INTO jobs (relation_id, title, uuid, sync_seq, created_at) VALUES (?, 'Oud project', ?, ?, datetime(? / 1000, 'unixepoch'))`).run(id, jobUuid, volgendeSyncSeq(t.db), vroeger);
    expect(rij<{ n: number }>(t, 'SELECT COUNT(*) AS n FROM relation_field_rev WHERE relation_id = ?', id).n).toBe(0);
    const createdAt = rij<{ created_at: string }>(t, 'SELECT created_at FROM relations WHERE id = ?', id).created_at;
    expect(createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const stroom = await p.alles();
    const klant = stroom.klanten.find((k) => k.uuid === uuid)!;
    const project = stroom.projecten.find((k) => k.uuid === jobUuid)!;
    // tijd = veldOndergrens(created_at), en dat is het UTC-moment waarop de rij is aangemaakt; bron pc
    expect(veldOndergrens(createdAt)).toBe(vroeger);
    for (const naam of Object.keys(KLANT_VELDEN)) expect(klant.velden[naam], naam).toMatchObject({ tijd: vroeger, bron: 'pc' });
    for (const naam of Object.keys(PROJECT_VELDEN)) expect(project.velden[naam], naam).toMatchObject({ tijd: vroeger, bron: 'pc' });
    expect(klant.velden.naam).toEqual({ waarde: 'Oude Klant', tijd: vroeger, bron: 'pc' });
    expect(klant.velden.email!.waarde).toBe('oud@example.nl');
    expect(project.velden.klant!.waarde).toBe(uuid);
    // ... en niet de wijzigingstijd en niet 0
    expect(klant.velden.naam!.tijd).not.toBe(0);
    // een veld mét veldrij houdt zijn eigen tijd en bron (hier: 3 uur eerder bewerkt door een telefoon)
    t.db.prepare('INSERT INTO relation_field_rev (relation_id, veld, tijd, bron) VALUES (?, ?, ?, ?)').run(id, 'phone', vroeger + 5000, 'M7');
    t.db.prepare(`UPDATE relations SET phone = '010-5555555', sync_seq = ? WHERE id = ?`).run(volgendeSyncSeq(t.db), id);
    const opnieuw = (await p.alles()).klanten.find((k) => k.uuid === uuid)!;
    expect(opnieuw.velden.telefoon).toEqual({ waarde: '010-5555555', tijd: vroeger + 5000, bron: 'M7' });
    expect(opnieuw.velden.email).toMatchObject({ tijd: vroeger, bron: 'pc' });
  });
});
