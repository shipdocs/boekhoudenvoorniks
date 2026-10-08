import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup } from './helpers';
import { makeJpeg } from './fixtures/jpeg';
import { Bonnenscanner, type ScannerDeps } from '../src/scanner/scanner';
import { PHONE_SCANNER } from '../src/shared/phone-scanner';
import { CONTENT_TYPE, ENDPOINT_PATH, LIMITS, PROTOCOL_VERSIONS, RULES_VERSION, decodePairing, encodeFrame, openResponse, parseFrame, sealRequest, type PairingPayload, type ProtocolVersion } from '../src/scanner/protocol';
import { leesCursor } from '../src/sync/stamgegevens';
import { REGELTABEL, REGELTABEL_VERSIE, besluitWijziging, leesWijziging, type WijzigingsFout } from '@gratis-boekhouden/kern';

// Protocol versie 2 naast versie 1 (docs/bonnenscanner-protocol.md): het hallo-antwoord van v2 noemt
// de versie van de btw-regeltabel (rulesVersion) en de ondersteunde protocolversies, en de telefoon
// kan een change-set (`wijziging`) sturen en om `stamgegevens` vragen. Van versie 1 verandert niets.
// Klantwijzigingen worden bewaard (tests/sync-klanten.test.ts); stamgegevens, projecten, facturen, bonnen en foto's nog niet.

const LOOPBACK = [{ address: '127.0.0.1', netmask: '255.0.0.0' }];

const open: Bonnenscanner[] = [];
const dirs: string[] = [];
// Zoals in bonnenscanner.test.ts: koppelen staat in de app nog uit; de test zet het zelf aan.
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
  const spoolDir = mkdtempSync(join(tmpdir(), 'bvn-scanner-v2-'));
  dirs.push(spoolDir);
  const clock = { now: Date.now() };
  const scanner = new Bonnenscanner({
    db: t.db,
    secrets: t.secrets,
    intake: t.s.intake,
    settings: t.s.settings,
    spoolDir,
    interfaces: () => LOOPBACK,
    now: () => clock.now,
    ...extra,
  });
  open.push(scanner);
  const documents = () => t.db.prepare('SELECT id FROM documents ORDER BY id').all() as { id: number }[];
  return { ...t, scanner, spoolDir, clock, documents };
}

interface Reply {
  status: number;
  /** het antwoord was versleuteld en met de sleutel van de telefoon te openen */
  sealed: boolean;
  json: Record<string, unknown> | null;
  /** de ruwe body, om de envelopversie te kunnen zien */
  raw: Buffer;
}

/** De telefoon: kiest zelf in welke protocolversie hij zijn bericht in een envelop stopt. */
function phone(pairing: PairingPayload, clock: { now: number }) {
  const key = Buffer.from(pairing.sleutel, 'base64url');
  const deviceId = Buffer.from(pairing.apparaat, 'base64url');
  const url = `http://${pairing.adressen[0]}:${pairing.poort}${ENDPOINT_PATH}`;
  const post = async (body: Buffer, nonce: Buffer): Promise<Reply> => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': CONTENT_TYPE }, body: new Uint8Array(body) });
    const raw = Buffer.from(await res.arrayBuffer());
    if ((res.headers.get('content-type') ?? '') === CONTENT_TYPE) {
      const json = openResponse(raw, key, nonce);
      return { status: res.status, sealed: json !== null, json, raw };
    }
    return { status: res.status, sealed: false, json: raw.length ? (JSON.parse(raw.toString('utf8')) as Record<string, unknown>) : null, raw };
  };
  const verstuur = (json: Record<string, unknown>, opts: { versie?: ProtocolVersion; fotos?: Buffer[]; nonce?: Buffer } = {}) => {
    const nonce = opts.nonce ?? randomBytes(12);
    return post(sealRequest(deviceId, key, encodeFrame(json, opts.fotos ?? []), nonce, opts.versie ?? 1), nonce);
  };
  const hallo = (versie: ProtocolVersion, naam = 'Pixel van Piet') => verstuur({ soort: 'hallo', tijd: clock.now, naam, app: '1.0.0' }, { versie });
  const bon = (versie: ProtocolVersion, over: Record<string, unknown> = {}, label = 'bon') => {
    const foto = makeJpeg(label);
    return verstuur({ soort: 'bon', tijd: clock.now, id: randomUUID(), betaalwijze: 'pin', fotos: [{ grootte: foto.length }], ...over }, { versie, fotos: [foto] });
  };
  // Een wijziging-bericht draagt de change-set in een eigen sleutel `wijziging`: de `tijd` van het
  // bericht is de verzendtijd (binnen het klokvenster), de `tijd` ín de change-set is het moment van
  // bewerken en mag willekeurig oud zijn. Afwijkingen (`over`) gelden de change-set zelf.
  const wijziging = (over: Record<string, unknown> = {}, opts: { versie?: ProtocolVersion; fotos?: Buffer[]; nonce?: Buffer } = {}) =>
    verstuur(
      { soort: 'wijziging', tijd: clock.now, wijziging: { entiteit: 'klant', uuid: randomUUID(), revisie: 1, tijd: clock.now, velden: { naam: 'Familie Jansen' }, ...over } },
      { versie: 2, ...opts }
    );
  return { key, deviceId, url, post, verstuur, hallo, bon, wijziging };
}

async function pair(t: ReturnType<typeof start>) {
  const started = await t.scanner.pair();
  return phone(decodePairing(started.payload), t.clock);
}

describe('bonnenscanner v2: het hallo-antwoord', () => {
  it('een hallo in een v2-envelop krijgt de regelsversie en de ondersteunde protocolversies terug', async () => {
    const t = start();
    const p = await pair(t);
    const r = await p.hallo(2);
    expect(r).toMatchObject({ status: 200, sealed: true, json: { ok: true, soort: 'hallo', regels: RULES_VERSION, protocollen: [1, 2] } });
    expect(Object.keys(r.json!).sort()).toEqual(['apparaatcode', 'limieten', 'ok', 'pc', 'pcTijd', 'protocollen', 'regels', 'soort']);
    // het antwoord zelf is ook een envelop van versie 2
    expect(r.raw.subarray(0, 4).toString('ascii')).toBe('BVNS');
    expect(r.raw[4]).toBe(2);
  });

  it('een hallo in een v1-envelop krijgt precies het oude antwoord, zonder regels of protocollen', async () => {
    const t = start();
    const p = await pair(t);
    const r = await p.hallo(1);
    expect(r).toMatchObject({ status: 200, sealed: true, json: { ok: true, soort: 'hallo', pcTijd: t.clock.now } });
    expect(Object.keys(r.json!).sort()).toEqual(['limieten', 'ok', 'pc', 'pcTijd', 'soort']);
    expect(r.raw[4]).toBe(1);
  });
});

describe('bonnenscanner v2: versie 1 en versie 2 naast elkaar', () => {
  it('een telefoon van versie 1 en een van versie 2 werken tegelijk op dezelfde pc', async () => {
    const t = start();
    const oud = await pair(t);
    const nieuw = await pair(t);
    expect((await oud.hallo(1, 'Oude telefoon')).status).toBe(200);
    expect((await nieuw.hallo(2, 'Nieuwe telefoon')).status).toBe(200);
    // elk zijn eigen soort berichten, allebei gewoon begrepen
    expect((await oud.bon(1, { notitie: 'van versie 1' }, 'oud')).status).toBe(200);
    expect((await nieuw.wijziging({})).status).toBe(200);
    expect((await nieuw.bon(2, { notitie: 'van versie 2' }, 'nieuw')).status).toBe(200);
    await t.scanner.processSpool();
    expect(t.documents()).toHaveLength(2);
    // beide telefoons zijn gekoppeld en gezien
    expect(t.scanner.status().devices).toMatchObject([
      { name: 'Oude telefoon', pending: false },
      { name: 'Nieuwe telefoon', pending: false },
    ]);
  });

  it('een bericht van versie 2 in een v1-envelop wordt geweigerd: de versie zit in de envelop', async () => {
    const t = start();
    const p = await pair(t);
    const w = { soort: 'wijziging', tijd: t.clock.now, wijziging: { entiteit: 'klant', uuid: randomUUID(), revisie: 1, tijd: t.clock.now, velden: { naam: 'x' } } };
    const s = { soort: 'stamgegevens', tijd: t.clock.now };
    for (const [what, json] of [['wijziging', w], ['stamgegevens', s]] as const) {
      const r = await p.verstuur(json, { versie: 1 });
      expect(r.status, what).toBe(400);
      expect(r.json, what).toMatchObject({ ok: false, fout: 'ongeldig' });
    }
    await t.scanner.processSpool();
    expect(t.documents()).toHaveLength(0);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM scanner_documents').get()).toEqual({ n: 0 });
  });

  it('een bon in een v2-envelop werkt zoals in een v1-envelop', async () => {
    const t = start();
    const p = await pair(t);
    const r = await p.bon(2, { notitie: 'ook zo' });
    expect(r).toMatchObject({ status: 200, sealed: true, json: { ok: true, soort: 'bon', al: false } });
    expect(r.json!.id).toMatch(/^[0-9a-f-]{36}$/);
    await t.scanner.processSpool();
    expect(t.documents()).toHaveLength(1);
    // en het antwoord is netjes in dezelfde versie teruggestuurd
    expect(r.raw[4]).toBe(2);
  });
});

describe('bonnenscanner v2: wijzigingen (change-sets)', () => {
  it('een geldige change-set wordt bevestigd met de eigen gegevens en de uitkomst terug, en de klant wordt bewaard', async () => {
    const t = start();
    const p = await pair(t);
    const uuid = randomUUID();
    const r = await p.wijziging({ uuid, velden: { naam: 'Familie Jansen', email: 'jansen@example.nl' } });
    expect(r).toMatchObject({ status: 200, sealed: true, json: { ok: true, soort: 'wijziging', entiteit: 'klant', uuid, revisie: 1, uitkomst: 'toegepast' } });
    expect(Object.keys(r.json!).sort()).toEqual(['entiteit', 'ok', 'revisie', 'soort', 'uitkomst', 'uuid']);
    expect(r.raw[4]).toBe(2);
    // de klant staat in de administratie, met de uuid van de telefoon, en het register kent de wijziging
    expect(t.db.prepare('SELECT type, name, email, country, revisie FROM relations WHERE uuid = ?').get(uuid)).toEqual({ type: 'klant', name: 'Familie Jansen', email: 'jansen@example.nl', country: 'NL', revisie: 1 });
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM sync_ontvangen WHERE uuid = ?').get(uuid)).toEqual({ n: 1 });
    // een klant is geen document: er is geen document, geen bon en geen bestand in de wachtrij
    expect(t.documents()).toEqual([]);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM scanner_documents').get()).toEqual({ n: 0 });
    expect(existsSync(t.spoolDir) ? readdirSync(t.spoolDir) : []).toEqual([]);
  });

  it('een ongeldige change-set wordt geweigerd en bewaart niets', async () => {
    const t = start();
    const p = await pair(t);
    // precies een afwijking per geval, steeds ín de change-set: het bericht zelf is netjes
    const basis = { entiteit: 'klant', uuid: randomUUID(), revisie: 1, tijd: t.clock.now, velden: { naam: 'x' } };
    const zonderRevisie: Record<string, unknown> = { ...basis };
    delete zonderRevisie.revisie;
    const gevallen: [string, Record<string, unknown>][] = [
      ['uuid in hoofdletters', { ...basis, uuid: randomUUID().toUpperCase() }],
      ['uuid geen uuid', { ...basis, uuid: 'geen-uuid' }],
      ['revisie nul', { ...basis, revisie: 0 }],
      ['revisie geen geheel getal', { ...basis, revisie: 1.5 }],
      ['revisie als tekst', { ...basis, revisie: '1' }],
      ['revisie ontbreekt', zonderRevisie],
      ['velden null', { ...basis, velden: null }],
      ['velden een lijst', { ...basis, velden: ['naam'] }],
      ['velden als tekst', { ...basis, velden: 'niets' }],
      ['veld dat er niet in thuishoort', { ...basis, opmerking: 'x' }],
      ['entiteit null', { ...basis, entiteit: null }],
    ];
    for (const [what, json] of gevallen) {
      const r = await p.verstuur({ soort: 'wijziging', tijd: t.clock.now, wijziging: { ...json } }, { versie: 2 });
      expect(r.status, what).toBe(400);
      expect(r.sealed, what).toBe(true);
      expect(r.json, what).toMatchObject({ ok: false, fout: 'ongeldig' });
    }
    expect(t.documents()).toEqual([]);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM scanner_documents').get()).toEqual({ n: 0 });
  });

  it('dezelfde wijziging nog een keer sturen verandert niets: geen fout, overgeslagen, en nog steeds een klant', async () => {
    const t = start();
    const p = await pair(t);
    const uuid = randomUUID();
    const eerste = await p.wijziging({ uuid, velden: { naam: 'Familie Jansen' } });
    expect(eerste).toMatchObject({ status: 200, json: { ok: true, soort: 'wijziging', entiteit: 'klant', uuid, revisie: 1, uitkomst: 'toegepast' } });
    const aantal = () => t.db.prepare('SELECT COUNT(*) AS n FROM relations WHERE uuid = ?').get(uuid);
    const logboek = () => t.db.prepare('SELECT COUNT(*) AS n FROM relation_changelog').get();
    const voor = logboek();
    // dezelfde uuid met dezelfde revisie: netjes bevestigd als overgeslagen, niets aan de administratie
    const gelijk = await p.wijziging({ uuid, velden: { naam: 'Familie Jansen' } });
    expect(gelijk).toMatchObject({ status: 200, json: { ok: true, soort: 'wijziging', uuid, revisie: 1, uitkomst: 'overgeslagen' } });
    expect(aantal()).toEqual({ n: 1 });
    expect(logboek()).toEqual(voor);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM sync_ontvangen WHERE uuid = ?').get(uuid)).toEqual({ n: 1 });
    // een hogere revisie met nieuwe inhoud wordt wel toegepast, en blijft dezelfde klant
    const hoger = await p.wijziging({ uuid, revisie: 2, tijd: t.clock.now + 1, velden: { plaats: 'Utrecht' } });
    expect(hoger).toMatchObject({ status: 200, json: { ok: true, uuid, revisie: 2, uitkomst: 'toegepast' } });
    expect(aantal()).toEqual({ n: 1 });
    expect(t.db.prepare('SELECT city FROM relations WHERE uuid = ?').get(uuid)).toEqual({ city: 'Utrecht' });
    // er is geen document of bestand bijgekomen
    await t.scanner.processSpool();
    expect(t.documents()).toEqual([]);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM scanner_documents').get()).toEqual({ n: 0 });
    expect(existsSync(t.spoolDir) ? readdirSync(t.spoolDir) : []).toEqual([]);
  });

  it('een onbekende entiteit wordt geweigerd', async () => {
    const t = start();
    const p = await pair(t);
    for (const entiteit of ['leverancier', 'gebruiker', 'relatie', 'Klant', 'bank']) {
      const r = await p.wijziging({ entiteit });
      expect(r.status, entiteit).toBe(400);
      expect(r.json, entiteit).toMatchObject({ ok: false, fout: 'ongeldig' });
    }
    // en de toegestane lijst is precies deze vijf
    for (const entiteit of ['klant'] as const) expect((await p.wijziging({ entiteit })).status, entiteit).toBe(200);
    // factuur zit hier niet meer bij: een factuur wordt echt gevalideerd (willekeurige velden geven 400 veld-ongeldig); die dekking staat in tests/sync-facturen.test.ts
    // bon zit hier ook niet meer bij: een bon wordt echt gevalideerd (willekeurige velden geven 400 veld-ongeldig); die dekking staat in tests/sync-bonnen.test.ts
    for (const entiteit of ['foto'] as const) expect((await p.wijziging({ entiteit })).status, entiteit).toBe(200);
  });

  it('documenten worden nooit bewerkt: factuur, bon en foto krijgen alleen revisie 1', async () => {
    const t = start();
    const p = await pair(t);
    for (const entiteit of ['factuur', 'bon', 'foto'] as const) {
      const r = await p.wijziging({ entiteit, revisie: 2 });
      expect(r.status, entiteit).toBe(400);
      expect(r.json, entiteit).toMatchObject({ ok: false, fout: 'ongeldig' });
      // de eerste (en enige) revisie van een document mag wel; dat geldt alleen voor bon en foto, want een factuur
      // wordt echt gevalideerd (willekeurige velden geven 400 veld-ongeldig) en is in tests/sync-facturen.test.ts gedekt; een bon
      // idem (tests/sync-bonnen.test.ts)
      if (entiteit === 'foto') expect((await p.wijziging({ entiteit, revisie: 1 })).status, entiteit).toBe(200);
    }
    // een klant mag juist wel vaker gewijzigd worden
    expect((await p.wijziging({ revisie: 3, velden: { naam: 'derde keer' } })).status).toBe(200);
  });

  it('een wijziging met foto\'s erachter wordt geweigerd', async () => {
    const t = start();
    const p = await pair(t);
    const foto = makeJpeg();
    const r = await p.verstuur(
      { soort: 'wijziging', tijd: t.clock.now, wijziging: { entiteit: 'klant', uuid: randomUUID(), revisie: 1, tijd: t.clock.now, velden: { naam: 'x' } } },
      { versie: 2, fotos: [foto] }
    );
    expect(r).toMatchObject({ status: 400, sealed: true, json: { ok: false, fout: 'ongeldig' } });
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM scanner_documents').get()).toEqual({ n: 0 });
  });
});

describe('bonnenscanner v2: stamgegevens', () => {
  it('stamgegevens antwoord volgens afspraak', async () => {
    const t = start();
    const p = await pair(t);
    const leverancier = t.s.relations.create({ name: 'Groothandel Geheim BV', type: 'leverancier', iban: 'NL02ABNA0123456789' });
    const klus = t.s.jobs.create({ relationId: t.klant.id, title: 'Stucwerk woonkamer', notes: 'Eerst de gang' });
    // de eerste vraag van een telefoon: zijn apparaatcode bestaat dan nog niet en wordt hier toegekend
    const r = await p.verstuur({ soort: 'stamgegevens', tijd: t.clock.now }, { versie: 2 });
    expect(r).toMatchObject({ status: 200, sealed: true, json: { ok: true, soort: 'stamgegevens', pcTijd: t.clock.now, apparaatcode: 'M1', regels: RULES_VERSION, regeltabel: REGELTABEL, volgende: null, aliassen: [], verborgen: [] } });
    expect(Object.keys(r.json!).sort()).toEqual(['aliassen', 'apparaatcode', 'klanten', 'nieuwe_sinds', 'ok', 'pcTijd', 'projecten', 'regels', 'regeltabel', 'soort', 'verborgen', 'volgende']);
    const klanten = r.json!.klanten as { uuid: string; seq: number; pc_revisie: number; gearchiveerd: boolean; velden: Record<string, { waarde: unknown; tijd: number; bron: string }> }[];
    // de twee klanten van de testadministratie, niet de leverancier
    expect(klanten.map((k) => k.velden.naam!.waarde).sort()).toEqual(['Bouwbedrijf De Vries BV', 'Familie Jansen']);
    const jansen = klanten.find((k) => k.velden.naam!.waarde === 'Familie Jansen')!;
    const rij = t.db.prepare('SELECT uuid, sync_seq, revisie, created_at FROM relations WHERE id = ?').get(t.klant.id) as { uuid: string; sync_seq: number; revisie: number; created_at: string };
    expect(jansen).toMatchObject({ uuid: rij.uuid, seq: rij.sync_seq, pc_revisie: rij.revisie, gearchiveerd: false });
    expect(jansen.velden.email).toEqual({ waarde: 'jansen@example.nl', tijd: expect.any(Number), bron: 'pc' });
    expect(jansen.velden.gearchiveerd).toMatchObject({ waarde: 0, bron: 'pc' });
    const projecten = r.json!.projecten as { uuid: string; seq: number; pc_revisie: number; velden: Record<string, { waarde: unknown; tijd: number; bron: string }> }[];
    expect(projecten).toHaveLength(1);
    const job = t.db.prepare('SELECT uuid, sync_seq, revisie FROM jobs WHERE id = ?').get(klus.id) as { uuid: string; sync_seq: number; revisie: number };
    expect(projecten[0]).toMatchObject({ uuid: job.uuid, seq: job.sync_seq, pc_revisie: job.revisie });
    // de klant van het project gaat als uuid mee, nooit als integer-id
    expect(projecten[0]!.velden.klant!.waarde).toBe(rij.uuid);
    expect(projecten[0]!.velden.titel!.waarde).toBe('Stucwerk woonkamer');
    // geen leverancier en geen id's of interne velden, nergens in het antwoord
    const tekst = JSON.stringify(r.json);
    expect(tekst).not.toContain(leverancier.name);
    expect(tekst).not.toContain('NL02ABNA0123456789');
    // dezelfde vraag nog eens: dezelfde apparaatcode en dezelfde gegevens
    const nog = await p.verstuur({ soort: 'stamgegevens', tijd: t.clock.now }, { versie: 2 });
    expect(nog.json).toEqual(r.json);
    // alleen lezen en geen documenten
    expect(t.documents()).toEqual([]);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM relations').get()).toEqual({ n: 3 });
  });
});

describe('bonnenscanner v2: dezelfde regels als versie 1', () => {
  it('ook een v2-bericht staat op de klok van de pc en op een verse nonce', async () => {
    const t = start();
    const p = await pair(t);
    // te oude verzendtijd
    const oudeTijd = await p.verstuur(
      { soort: 'wijziging', tijd: t.clock.now - LIMITS.clockWindowMs - 1000, wijziging: { entiteit: 'klant', uuid: randomUUID(), revisie: 1, tijd: t.clock.now, velden: { naam: 'x' } } },
      { versie: 2 }
    );
    expect(oudeTijd).toMatchObject({ status: 403, sealed: true, json: { ok: false, fout: 'klok', pcTijd: t.clock.now } });
    // dezelfde nonce nog een keer, met een geldig bericht: geweigerd
    const nonce = randomBytes(12);
    const eerste = await p.wijziging({}, { versie: 2, nonce });
    expect(eerste.status).toBe(200);
    const opnieuw = await p.wijziging({ uuid: randomUUID() }, { versie: 2, nonce });
    expect(opnieuw).toMatchObject({ status: 409, json: { ok: false, fout: 'herhaald' } });
    // er is niets bewaard door al die berichten
    await t.scanner.processSpool();
    expect(t.documents()).toEqual([]);
  });
});

describe('bonnenscanner v2: verzendtijd en bewerktijd', () => {
  it('bewerkmoment van drie dagen geleden wordt geaccepteerd en behouden', async () => {
    const t = start();
    const p = await pair(t);
    const voor = t.db.prepare('SELECT COUNT(*) AS n FROM scanner_documents').get() as { n: number };
    const uuid = randomUUID();
    const drieDagenGeleden = t.clock.now - 3 * 24 * 60 * 60 * 1000;
    // via de receiver: de verzendtijd is nu, het bewerkmoment mag veel ouder zijn (offline gemaakt)
    const r = await p.wijziging({ uuid, tijd: drieDagenGeleden });
    expect(r).toMatchObject({ status: 200, sealed: true, json: { ok: true, soort: 'wijziging', entiteit: 'klant', uuid, revisie: 1 } });
    // parseFrame levert het bewerkmoment ongewijzigd terug
    const bericht = parseFrame(
      encodeFrame({ soort: 'wijziging', tijd: t.clock.now, wijziging: { entiteit: 'klant', uuid, revisie: 1, tijd: drieDagenGeleden, velden: { naam: 'x' } } }),
      2
    );
    if (bericht.soort !== 'wijziging') throw new Error('onverwacht: geen wijziging');
    expect(bericht.wijziging.tijd).toBe(drieDagenGeleden);
    // de tijd van het bericht zelf is de verzendtijd en blijft binnen het klokvenster
    expect(t.clock.now - bericht.tijd).toBeLessThanOrEqual(LIMITS.clockWindowMs);
    await t.scanner.processSpool();
    expect(t.documents()).toEqual([]);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM scanner_documents').get()).toEqual(voor);
  });

  it('bewerkmoment in de toekomst geeft 400 ongeldig', async () => {
    const t = start();
    const p = await pair(t);
    const voor = t.db.prepare('SELECT COUNT(*) AS n FROM scanner_documents').get() as { n: number };
    // een uur vooruit: verder in de toekomst dan het klokvenster toestaat
    const r = await p.wijziging({ tijd: t.clock.now + 60 * 60 * 1000 });
    expect(r).toMatchObject({ status: 400, sealed: true, json: { ok: false, fout: 'ongeldig' } });
    await t.scanner.processSpool();
    expect(t.documents()).toEqual([]);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM scanner_documents').get()).toEqual(voor);
  });

  it('bewerkmoment precies op de grens van het klokvenster', async () => {
    const t = start();
    const p = await pair(t);
    const voor = t.db.prepare('SELECT COUNT(*) AS n FROM scanner_documents').get() as { n: number };
    // precies nu plus het klokvenster is nog goed
    const opGrens = await p.wijziging({ tijd: t.clock.now + LIMITS.clockWindowMs });
    expect(opGrens).toMatchObject({ status: 200, sealed: true, json: { ok: true, soort: 'wijziging' } });
    // een milliseconde erover is te ver
    const erover = await p.wijziging({ uuid: randomUUID(), tijd: t.clock.now + LIMITS.clockWindowMs + 1 });
    expect(erover).toMatchObject({ status: 400, sealed: true, json: { ok: false, fout: 'ongeldig' } });
    await t.scanner.processSpool();
    expect(t.documents()).toEqual([]);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM scanner_documents').get()).toEqual(voor);
  });

  it('het oude platte formaat geeft 400 ongeldig', async () => {
    const t = start();
    const p = await pair(t);
    const voor = t.db.prepare('SELECT COUNT(*) AS n FROM scanner_documents').get() as { n: number };
    // zoals vóór dit formaat: de vijf velden van de change-set rechtstreeks naast `soort` en `tijd`.
    // Als JSON, precies zoals zo'n bericht vroeger binnenkwam — daarvan mag de pc niets aannemen.
    const plat = JSON.parse(
      `{"soort":"wijziging","tijd":${t.clock.now},"entiteit":"klant","uuid":"${randomUUID()}","revisie":1,"velden":{"naam":"x"}}`
    ) as Record<string, unknown>;
    const r = await p.verstuur(plat, { versie: 2 });
    expect(r).toMatchObject({ status: 400, sealed: true, json: { ok: false, fout: 'ongeldig' } });
    await t.scanner.processSpool();
    expect(t.documents()).toEqual([]);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM scanner_documents').get()).toEqual(voor);
  });

  it('een array, een tweede wijziging of extra sleutels geven 400 ongeldig', async () => {
    const t = start();
    const p = await pair(t);
    const voor = t.db.prepare('SELECT COUNT(*) AS n FROM scanner_documents').get() as { n: number };
    const een = { entiteit: 'klant', uuid: randomUUID(), revisie: 1, tijd: t.clock.now, velden: { naam: 'x' } };
    // een array (bijvoorbeeld twee change-sets achter elkaar) is geen change-set
    const lijst = await p.verstuur({ soort: 'wijziging', tijd: t.clock.now, wijziging: [een] }, { versie: 2 });
    expect(lijst).toMatchObject({ status: 400, sealed: true, json: { ok: false, fout: 'ongeldig' } });
    // een poging om er twee in één bericht te stoppen, naast elkaar
    const batch = await p.verstuur({ soort: 'wijziging', tijd: t.clock.now, wijziging: een, wijzigingen: [{ ...een, uuid: randomUUID() }] }, { versie: 2 });
    expect(batch).toMatchObject({ status: 400, sealed: true, json: { ok: false, fout: 'ongeldig' } });
    // en een extra bovenste sleutel hoort er niet bij: precies één wijziging per bericht
    const extra = await p.verstuur({ soort: 'wijziging', tijd: t.clock.now, wijziging: een, extra: 'x' }, { versie: 2 });
    expect(extra).toMatchObject({ status: 400, sealed: true, json: { ok: false, fout: 'ongeldig' } });
    await t.scanner.processSpool();
    expect(t.documents()).toEqual([]);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM scanner_documents').get()).toEqual(voor);
  });

  it('een wijziging met __proto__ in velden geeft 400 ongeldig', async () => {
    const t = start();
    const p = await pair(t);
    const voor = t.db.prepare('SELECT COUNT(*) AS n FROM scanner_documents').get() as { n: number };
    // JSON.parse maakt '__proto__' tot een eigen sleutel; precies zo komt het bij de pc binnen
    const kwaadaardig = JSON.parse(
      `{"soort":"wijziging","tijd":${t.clock.now},"wijziging":{"entiteit":"klant","uuid":"${randomUUID()}","revisie":1,"tijd":${t.clock.now},"velden":{"__proto__":{"gevaar":true}}}}`
    ) as Record<string, unknown>;
    const r = await p.verstuur(kwaadaardig, { versie: 2 });
    expect(r).toMatchObject({ status: 400, sealed: true, json: { ok: false, fout: 'ongeldig' } });
    // en het aanbieden heeft niets in de prototypes kunnen smokkelen
    expect(({} as Record<string, unknown>).gevaar).toBeUndefined();
    await t.scanner.processSpool();
    expect(t.documents()).toEqual([]);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM scanner_documents').get()).toEqual(voor);
  });
});

describe('bonnenscanner v2: grenzen van de berichtgrootte', () => {
  it('wijziging van 16 KiB tot 128 KiB geeft 200', async () => {
    const t = start();
    const p = await pair(t);
    const voor = t.db.prepare('SELECT COUNT(*) AS n FROM scanner_documents').get() as { n: number };
    // 400 korte teksten: boven de 16 KiB van andere berichten, ruim binnen de 128 KiB van een wijziging
    const json = {
      soort: 'wijziging',
      tijd: t.clock.now,
      // entiteit foto: de velden van een klant, project, factuur en bon worden echt gevalideerd (klantveldschema, projectschema,
      // leesFactuurVelden, leesBonVelden); een foto wordt nog niet opgeslagen en laat dit bericht met willekeurige velden dus ongemoeid
      wijziging: { entiteit: 'foto', uuid: randomUUID(), revisie: 1, tijd: t.clock.now, velden: { naam: 'Grote mutatie', lijst: Array.from({ length: 400 }, () => 'x'.repeat(48)) } },
    };
    const lengte = Buffer.byteLength(JSON.stringify(json), 'utf8');
    expect(lengte).toBeGreaterThan(LIMITS.maxJsonBytes);
    expect(lengte).toBeLessThan(LIMITS.maxWijzigingJsonBytes);
    const r = await p.verstuur(json, { versie: 2 });
    expect(r).toMatchObject({ status: 200, sealed: true, json: { ok: true, soort: 'wijziging' } });
    await t.scanner.processSpool();
    expect(t.documents()).toEqual([]);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM scanner_documents').get()).toEqual(voor);
  });

  it('kapotte JSON tussen 16 en 128 KiB blijft 400 ongeldig', async () => {
    const t = start();
    const p = await pair(t);
    const voor = t.db.prepare('SELECT COUNT(*) AS n FROM scanner_documents').get() as { n: number };
    // groot genoeg voor de wijzigingsgrens, maar geen geldige JSON: alsnog gewoon ongeldig
    const tekst = Buffer.from('{"soort":"wijziging","tijd":' + t.clock.now + ',' + 'x'.repeat(LIMITS.maxJsonBytes + 2000), 'utf8');
    expect(tekst.length).toBeGreaterThan(LIMITS.maxJsonBytes);
    expect(tekst.length).toBeLessThan(LIMITS.maxWijzigingJsonBytes);
    const frame = Buffer.concat([Buffer.alloc(4), tekst]);
    frame.writeUInt32BE(tekst.length, 0);
    const nonce = randomBytes(12);
    const r = await p.post(sealRequest(p.deviceId, p.key, frame, nonce, 2), nonce);
    expect(r).toMatchObject({ status: 400, sealed: true, json: { ok: false, fout: 'ongeldig' } });
    await t.scanner.processSpool();
    expect(t.documents()).toEqual([]);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM scanner_documents').get()).toEqual(voor);
  });

  it('hallo, bon en stamgegevens boven 16 KiB geven 413 te-groot, een wijziging boven 128 KiB ook', async () => {
    const t = start();
    const p = await pair(t);
    const voor = t.db.prepare('SELECT COUNT(*) AS n FROM scanner_documents').get() as { n: number };
    const vol = 'x'.repeat(LIMITS.maxJsonBytes); // elke JSON komt hiermee boven de 16 KiB uit
    const hallo = await p.verstuur({ soort: 'hallo', tijd: t.clock.now, naam: vol }, { versie: 2 });
    expect(hallo).toMatchObject({ status: 413, sealed: true, json: { ok: false, fout: 'te-groot' } });
    const bon = await p.bon(2, { overig: vol });
    expect(bon).toMatchObject({ status: 413, sealed: true, json: { ok: false, fout: 'te-groot' } });
    const stamgegevens = await p.verstuur({ soort: 'stamgegevens', tijd: t.clock.now, overig: vol }, { versie: 2 });
    expect(stamgegevens).toMatchObject({ status: 413, sealed: true, json: { ok: false, fout: 'te-groot' } });
    // een wijziging mag tot 128 KiB: 500 teksten van 300 tekens komt daar bovenuit
    const teGroteWijziging = await p.wijziging({ velden: { lijst: Array.from({ length: 500 }, () => 'x'.repeat(300)) } });
    expect(teGroteWijziging).toMatchObject({ status: 413, sealed: true, json: { ok: false, fout: 'te-groot' } });
    await t.scanner.processSpool();
    expect(t.documents()).toEqual([]);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM scanner_documents').get()).toEqual(voor);
  });

  it('versie 1 boven 16 KiB geeft 413 te-groot', async () => {
    const t = start();
    const p = await pair(t);
    const voor = t.db.prepare('SELECT COUNT(*) AS n FROM scanner_documents').get() as { n: number };
    // was vroeger 400 ongeldig boven 16 KiB; sinds de 128 KiB-grens is het bewust 413 te-groot
    const r = await p.verstuur({ soort: 'hallo', tijd: t.clock.now, naam: 'x'.repeat(LIMITS.maxJsonBytes) }, { versie: 1 });
    expect(r).toMatchObject({ status: 413, sealed: true, json: { ok: false, fout: 'te-groot' } });
    // een bon in een v1-envelop boven 16 KiB ook
    const b = await p.bon(1, { overig: 'x'.repeat(LIMITS.maxJsonBytes) });
    expect(b).toMatchObject({ status: 413, sealed: true, json: { ok: false, fout: 'te-groot' } });
    // en ook soort wijziging in een v1-envelop: boven 16 KiB te groot (de 128 KiB-uitzondering geldt
    // alleen in een v2-envelop)
    const w = await p.verstuur(
      { soort: 'wijziging', tijd: t.clock.now, wijziging: { entiteit: 'klant', uuid: randomUUID(), revisie: 1, tijd: t.clock.now, velden: { naam: 'x'.repeat(LIMITS.maxJsonBytes) } } },
      { versie: 1 }
    );
    expect(w).toMatchObject({ status: 413, sealed: true, json: { ok: false, fout: 'te-groot' } });
    // onder de 16 KiB blijft het bestaande v1-gedrag voor soort wijziging ongewijzigd: ongeldig
    const klein = await p.verstuur(
      { soort: 'wijziging', tijd: t.clock.now, wijziging: { entiteit: 'klant', uuid: randomUUID(), revisie: 1, tijd: t.clock.now, velden: { naam: 'x' } } },
      { versie: 1 }
    );
    expect(klein).toMatchObject({ status: 400, sealed: true, json: { ok: false, fout: 'ongeldig' } });
    await t.scanner.processSpool();
    expect(t.documents()).toEqual([]);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM scanner_documents').get()).toEqual(voor);
  });
});

describe('bonnenscanner v2: het wijzigingsformaat in de kern (packages/core, zuiver)', () => {
  const uuid = '3f2b8c1e-5d4a-4e6f-9a7b-0c1d2e3f4a5b';
  const goed = { entiteit: 'klant', uuid, revisie: 2, tijd: 1790848800000, velden: { naam: 'Familie Jansen', adres: { straat: 'Dorpsstraat 5', huisnummer: 5 } } };
  const foutVan = (raw: unknown): WijzigingsFout | null => {
    const r = leesWijziging(raw);
    return r.ok ? null : r.fout;
  };

  it('leest een geldige change-set en geeft haar onveranderd terug', () => {
    expect(leesWijziging(goed)).toEqual({ ok: true, wijziging: goed });
    // een document met zijn enige revisie, en een klant met een latere revisie
    expect(leesWijziging({ ...goed, entiteit: 'bon', revisie: 1 })).toMatchObject({ ok: true });
    expect(leesWijziging({ ...goed, revisie: 5 })).toMatchObject({ ok: true });
  });

  it('wijst alles af dat niet aan het formaat voldoet, met de reden waarom', () => {
    const zonderRevisie: Record<string, unknown> = { ...goed };
    delete zonderRevisie.revisie;
    const gevallen: [WijzigingsFout, unknown][] = [
      ['vorm', null],
      ['vorm', 'wijziging'],
      ['vorm', [goed]],
      ['vorm', { ...goed, extra: 'x' }],
      ['vorm', zonderRevisie],
      ['entiteit', { ...goed, entiteit: 'leverancier' }],
      ['entiteit', { ...goed, entiteit: 'Klant' }],
      ['entiteit', { ...goed, entiteit: 1 }],
      ['uuid', { ...goed, uuid: uuid.toUpperCase() }],
      ['uuid', { ...goed, uuid: 'geen-uuid' }],
      ['revisie', { ...goed, revisie: 0 }],
      ['revisie', { ...goed, revisie: 2.5 }],
      ['revisie', { ...goed, revisie: '2' }],
      ['tijd', { ...goed, tijd: 0 }],
      ['tijd', { ...goed, tijd: 'gisteren' }],
      ['velden', { ...goed, velden: null }],
      ['velden', { ...goed, velden: [] }],
      ['velden', { ...goed, velden: { saldo: NaN } }],
      ['velden', { ...goed, velden: { naam: () => 'niet in JSON' } }],
      ['bewerkt', { ...goed, entiteit: 'factuur', revisie: 2 }],
      ['bewerkt', { ...goed, entiteit: 'bon', revisie: 3 }],
      ['bewerkt', { ...goed, entiteit: 'foto', revisie: 2 }],
    ];
    for (const [verwacht, raw] of gevallen) expect(foutVan(raw), JSON.stringify(raw)).toBe(verwacht);
  });

  it('besluitWijziging: dezelfde uuid met dezelfde of lagere revisie is een no-op', () => {
    const w = { entiteit: 'klant' as const, uuid, revisie: 3, tijd: 1790848800000, velden: { naam: 'derde' } };
    expect(besluitWijziging({ uuid, revisie: 3 }, w)).toBe('overgeslagen');
    expect(besluitWijziging({ uuid, revisie: 4 }, w)).toBe('overgeslagen');
    expect(besluitWijziging({ uuid, revisie: 2 }, w)).toBe('toepassen');
    // een andere uuid is een andere entiteit, ook bij een lagere revisie
    expect(besluitWijziging({ uuid: '9a7b0c1d-2e3f-4a5b-8c1e-5d4a4e6f9a7b', revisie: 9 }, w)).toBe('toepassen');
    // niets bekend: toepassen
    expect(besluitWijziging(null, w)).toBe('toepassen');
  });
});

describe('bonnenscanner v2: de voorbeelden in het document', () => {
  // Het v2-deel van docs/bonnenscanner-protocol.md noemt dit bestand als zijn controle (de json-blokken
  // van versie 1 horen bij tests/bonnenscanner.test.ts). De voorbeeldberichtjes van versie 2 staan er
  // als tekst in; hier worden ze gelezen zoals de telefoon ze ziet.
  const doc = readFileSync(join(__dirname, '..', 'docs', 'bonnenscanner-protocol.md'), 'utf8').replace(/\r\n/g, '\n');
  const voorbeelden = [...doc.matchAll(/```text\n([\s\S]*?)```/g)]
    .map((m) => m[1]!.trim())
    .filter((body) => body.startsWith('{'))
    .map((body) => JSON.parse(body) as Record<string, unknown>);
  const verzoek = (soort: string) => voorbeelden.find((v) => v.soort === soort && v.ok === undefined)!;
  const antwoord = (soort: string) => voorbeelden.find((v) => v.soort === soort && v.ok === true)!;

  it('het hallo-antwoord noemt precies wat de code zegt: regels en protocollen, met de oude velden', () => {
    expect(voorbeelden).toHaveLength(5);
    expect(antwoord('hallo')).toEqual({
      ok: true,
      soort: 'hallo',
      pc: 'oKGio6SlpqeoqaqrrK2urw',
      pcTijd: 1790848800123,
      limieten: { fotos: LIMITS.maxPhotos, fotoBytes: LIMITS.maxPhotoBytes, notitie: LIMITS.maxNoteChars },
      regels: RULES_VERSION,
      protocollen: [...PROTOCOL_VERSIONS],
    });
  });

  it('het wijziging-voorbeeld is een geldige change-set in een v2-envelop, en in een v1-envelop geweigerd', () => {
    const w = verzoek('wijziging');
    expect(parseFrame(encodeFrame(w), 2)).toEqual({
      soort: 'wijziging',
      tijd: 1790848800000,
      wijziging: { entiteit: 'klant', uuid: '3f2b8c1e-5d4a-4e6f-9a7b-0c1d2e3f4a5b', revisie: 1, tijd: 1790848800000, velden: { naam: 'Familie Jansen' } },
    });
    // de envelop bepaalt de versie: dezelfde inhoud kent een pc van versie 1 niet
    expect(() => parseFrame(encodeFrame(w), 1)).toThrow();
  });

  it('het wijziging-antwoord bevestigt precies de change-set die erbij hoort', () => {
    const bericht = parseFrame(encodeFrame(verzoek('wijziging')), 2);
    if (bericht.soort !== 'wijziging') throw new Error('onverwacht: geen wijziging');
    expect(antwoord('wijziging')).toEqual({ ok: true, soort: 'wijziging', entiteit: bericht.wijziging.entiteit, uuid: bericht.wijziging.uuid, revisie: bericht.wijziging.revisie });
  });

  it('het stamgegevens-voorbeeld: het verzoek is geldig, het antwoord heeft de afgesproken vorm', () => {
    expect(verzoek('stamgegevens')).toEqual({ soort: 'stamgegevens', tijd: 1790848800000 });
    expect(parseFrame(encodeFrame(verzoek('stamgegevens')), 2)).toEqual({ soort: 'stamgegevens', tijd: 1790848800000 });
    expect(() => parseFrame(encodeFrame(verzoek('stamgegevens')), 1)).toThrow();
    const voorbeeld = antwoord('stamgegevens');
    expect(Object.keys(voorbeeld)).toEqual(['ok', 'soort', 'pcTijd', 'apparaatcode', 'regels', 'regeltabel', 'klanten', 'projecten', 'aliassen', 'verborgen', 'volgende', 'nieuwe_sinds']);
    expect(voorbeeld.regeltabel).toMatchObject({ versie: REGELTABEL_VERSIE });
    for (const item of voorbeeld.klanten as Record<string, unknown>[]) {
      expect(Object.keys(item)).toEqual(['uuid', 'seq', 'pc_revisie', 'gearchiveerd', 'velden', 'vies']);
    }
    for (const item of voorbeeld.projecten as Record<string, unknown>[]) {
      expect(Object.keys(item)).toEqual(['uuid', 'seq', 'pc_revisie', 'gearchiveerd', 'velden']);
    }
    // de cursor in het tweede verzoek-voorbeeld is er een die de pc zelf zou maken
    const metCursor = JSON.parse(doc.match(/```jsonc\n(\{"soort":"stamgegevens"[\s\S]*?)```/)![1]!) as { sinds: number; na: string };
    expect(parseFrame(encodeFrame(metCursor), 2)).toMatchObject({ soort: 'stamgegevens', sinds: 412, na: metCursor.na });
    expect(leesCursor(metCursor.na)).toEqual({ s: 'p', t: 480, u: '1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9', b: 500 });
  });
});
