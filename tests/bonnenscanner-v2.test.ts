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
import { besluitWijziging, leesWijziging, type WijzigingsFout } from '@gratis-boekhouden/kern';

// Protocol versie 2 naast versie 1 (docs/bonnenscanner-protocol.md): het hallo-antwoord van v2 noemt
// de versie van de btw-regeltabel (rulesVersion) en de ondersteunde protocolversies, en de telefoon
// kan een change-set (`wijziging`) sturen en om `stamgegevens` vragen. Van versie 1 verandert niets.
// Er wordt in deze stap nog niets bewaard of gesynchroniseerd.

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
  const wijziging = (over: Record<string, unknown> = {}, opts: { versie?: ProtocolVersion; fotos?: Buffer[]; nonce?: Buffer } = {}) =>
    verstuur({ soort: 'wijziging', tijd: clock.now, entiteit: 'klant', uuid: randomUUID(), revisie: 1, velden: { naam: 'Familie Jansen' }, ...over }, { versie: 2, ...opts });
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
    expect(Object.keys(r.json!).sort()).toEqual(['limieten', 'ok', 'pc', 'pcTijd', 'protocollen', 'regels', 'soort']);
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
    const w = { soort: 'wijziging', tijd: t.clock.now, entiteit: 'klant', uuid: randomUUID(), revisie: 1, velden: { naam: 'x' } };
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
  it('een geldige change-set wordt bevestigd met alleen de eigen gegevens terug, en niets wordt bewaard', async () => {
    const t = start();
    const p = await pair(t);
    const uuid = randomUUID();
    const r = await p.wijziging({ uuid, velden: { naam: 'Familie Jansen', email: 'jansen@example.nl' } });
    expect(r).toMatchObject({ status: 200, sealed: true, json: { ok: true, soort: 'wijziging', entiteit: 'klant', uuid, revisie: 1 } });
    expect(Object.keys(r.json!).sort()).toEqual(['entiteit', 'ok', 'revisie', 'soort', 'uuid']);
    expect(r.raw[4]).toBe(2);
    // nog niets opslaan of synchroniseren: er is geen document, geen wachtrij en geen eigenaar van gegevens
    expect(t.documents()).toEqual([]);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM scanner_documents').get()).toEqual({ n: 0 });
    expect(existsSync(t.spoolDir) ? readdirSync(t.spoolDir) : []).toEqual([]);
  });

  it('een ongeldige change-set wordt geweigerd en bewaart niets', async () => {
    const t = start();
    const p = await pair(t);
    const basis = { entiteit: 'klant', uuid: randomUUID(), revisie: 1, velden: { naam: 'x' } };
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
      const r = await p.verstuur({ soort: 'wijziging', tijd: t.clock.now, ...json }, { versie: 2 });
      expect(r.status, what).toBe(400);
      expect(r.sealed, what).toBe(true);
      expect(r.json, what).toMatchObject({ ok: false, fout: 'ongeldig' });
    }
    expect(t.documents()).toEqual([]);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM scanner_documents').get()).toEqual({ n: 0 });
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
    for (const entiteit of ['klant', 'project'] as const) expect((await p.wijziging({ entiteit })).status, entiteit).toBe(200);
    for (const entiteit of ['factuur', 'bon', 'foto'] as const) expect((await p.wijziging({ entiteit })).status, entiteit).toBe(200);
  });

  it('documenten worden nooit bewerkt: factuur, bon en foto krijgen alleen revisie 1', async () => {
    const t = start();
    const p = await pair(t);
    for (const entiteit of ['factuur', 'bon', 'foto'] as const) {
      const r = await p.wijziging({ entiteit, revisie: 2 });
      expect(r.status, entiteit).toBe(400);
      expect(r.json, entiteit).toMatchObject({ ok: false, fout: 'ongeldig' });
      // de eerste (en enige) revisie van een document mag wel
      expect((await p.wijziging({ entiteit, revisie: 1 })).status, entiteit).toBe(200);
    }
    // een klant mag juist wel vaker gewijzigd worden
    expect((await p.wijziging({ revisie: 3, velden: { naam: 'derde keer' } })).status).toBe(200);
  });

  it('een wijziging met foto\'s erachter wordt geweigerd', async () => {
    const t = start();
    const p = await pair(t);
    const foto = makeJpeg();
    const r = await p.verstuur({ soort: 'wijziging', tijd: t.clock.now, entiteit: 'klant', uuid: randomUUID(), revisie: 1, velden: { naam: 'x' } }, { versie: 2, fotos: [foto] });
    expect(r).toMatchObject({ status: 400, sealed: true, json: { ok: false, fout: 'ongeldig' } });
  });
});

describe('bonnenscanner v2: stamgegevens', () => {
  it('een vraag om stamgegevens krijgt alleen een bevestiging, geen gegevens uit de administratie', async () => {
    const t = start();
    const p = await pair(t);
    const r = await p.verstuur({ soort: 'stamgegevens', tijd: t.clock.now }, { versie: 2 });
    expect(r).toMatchObject({ status: 200, sealed: true, json: { ok: true, soort: 'stamgegevens' } });
    expect(Object.keys(r.json!).sort()).toEqual(['ok', 'soort']);
    // er komt niets uit de administratie: geen klanten, geen projecten, geen documenten
    expect(t.documents()).toEqual([]);
    // alleen de standaard testadministratie, onaangetast
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM relations').get()).toEqual({ n: 2 });
  });
});

describe('bonnenscanner v2: dezelfde regels als versie 1', () => {
  it('ook een v2-bericht staat op de klok van de pc en op een verse nonce', async () => {
    const t = start();
    const p = await pair(t);
    // te oude tijdstempel
    const oudeTijd = await p.verstuur({ soort: 'wijziging', tijd: t.clock.now - LIMITS.clockWindowMs - 1000, entiteit: 'klant', uuid: randomUUID(), revisie: 1, velden: { naam: 'x' } }, { versie: 2 });
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

  it('het stamgegevens-voorbeeld vraagt om niets meer dan soort en tijd, en krijgt alleen een bevestiging', () => {
    expect(verzoek('stamgegevens')).toEqual({ soort: 'stamgegevens', tijd: 1790848800000 });
    expect(parseFrame(encodeFrame(verzoek('stamgegevens')), 2)).toEqual({ soort: 'stamgegevens', tijd: 1790848800000 });
    expect(() => parseFrame(encodeFrame(verzoek('stamgegevens')), 1)).toThrow();
    expect(antwoord('stamgegevens')).toEqual({ ok: true, soort: 'stamgegevens' });
  });
});
