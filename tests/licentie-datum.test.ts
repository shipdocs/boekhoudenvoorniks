import Database from 'better-sqlite3';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LicenseService, httpDateToIso } from '../src/license/license';
import { telefoonAbonnement } from '../src/license/telefoon';
import { createApi, type HostContext } from '../src/main/api';
import { SettingsService } from '../src/settings/settings';
import { addDays, formatDateNl, toIsoDate, today, type IsoDate } from '../src/shared/dates';
import { setup } from './helpers';
import { signLicense } from './license-token';

// De licentiecontrole is offline en rekent met de laatst geziene datum: de laatste van vandaag en de datum die bij een eerdere
// controle in de administratie is bewaard (settings, sleutel licenseSeenDate). Een klok die wordt teruggezet maakt een verlopen
// licentie niet opnieuw geldig. De bewaarde datum gaat alleen omhoog; alleen een licentie die met de datum van de
// licentieserver binnenkomt zet hem (ook terug), zodat een klok die ooit te ver vooruit stond niemand laat vastlopen.
// Datums zijn relatief aan vandaag.

const VANDAAG = today();
const dag = (n: number) => addDays(VANDAAG, n);

function sleutels() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' }) as { x: string; d: string };
  return { publicKey: jwk.x, privateJwk: JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: jwk.x, d: jwk.d }) };
}
const SLEUTEL = sleutels();
const VREEMD = sleutels();

const mappen: string[] = [];
afterEach(() => {
  for (const m of mappen.splice(0)) rmSync(m, { recursive: true, force: true });
});

function opzet(opties: { zonderSleutel?: boolean; db?: Database.Database } = {}) {
  const t = setup({ ...(opties.zonderSleutel ? {} : { licensePublicKey: SLEUTEL.publicKey }), ...(opties.db ? { db: opties.db } : {}) });
  const licentie = (validUntil: IsoDate, over: { privateJwk?: string; administratie?: string } = {}) =>
    signLicense({ v: 1, product: 'uitwisseling', administratie: over.administratie ?? t.s.settings.administrationId(), email: 'piet@example.nl', validUntil, issuedAt: VANDAAG }, over.privateJwk ?? SLEUTEL.privateJwk);
  /** de bewaarde laatst geziene datum, of null als er geen rij is */
  const bewaard = (): string | null => {
    const rij = t.db.prepare(`SELECT value FROM settings WHERE key = 'licenseSeenDate'`).get() as { value: string } | undefined;
    return rij ? (JSON.parse(rij.value) as string) : null;
  };
  return { ...t, licentie, bewaard };
}

describe('licentie: de laatst geziene datum', () => {
  it('KLOK-01 verlopen en daarna de klok terug: de licentie blijft verlopen, voor versturen naar de boekhouder en voor de telefoon', async () => {
    const o = opzet();
    const tot = dag(5);
    expect(o.s.license.install(await o.licentie(tot), VANDAAG)).toMatchObject({ state: 'actief', validUntil: tot });
    expect(o.s.license.status(tot).state).toBe('actief');
    expect(() => o.s.license.requireActive(tot)).not.toThrow();
    expect(telefoonAbonnement(o.s.license.status(tot)).toegestaan).toBe(true);
    // de dag erna: verlopen
    expect(o.s.license.status(dag(6))).toEqual({ state: 'verlopen', validUntil: tot, email: 'piet@example.nl' });
    // de klok terug naar de laatste geldige dag (en verder terug): nog steeds verlopen
    for (const terug of [tot, dag(1), VANDAAG, dag(-30)]) {
      expect(o.s.license.status(terug), terug).toEqual({ state: 'verlopen', validUntil: tot, email: 'piet@example.nl' });
      expect(() => o.s.license.requireActive(terug), terug).toThrow(`Je abonnement liep tot ${formatDateNl(tot)}.`);
      expect(telefoonAbonnement(o.s.license.status(terug)), terug).toEqual({ toegestaan: false, verlopenOp: tot });
      // de app haalt dan nog steeds op de achtergrond de verlengde licentie op
      expect(o.s.license.needsRefresh(terug), terug).toBe(true);
    }
    expect(o.bewaard()).toBe(dag(6));
  });

  it('KLOK-02 de bewaarde datum gaat alleen omhoog', async () => {
    const o = opzet();
    o.s.license.install(await o.licentie(dag(400)), VANDAAG);
    expect(o.bewaard()).toBe(VANDAAG);
    o.s.license.status(dag(3));
    expect(o.bewaard()).toBe(dag(3));
    for (const eerder of [dag(2), VANDAAG, dag(-365)]) {
      o.s.license.status(eerder);
      o.s.license.needsRefresh(eerder);
      expect(o.bewaard(), eerder).toBe(dag(3));
    }
    o.s.license.status(dag(3));
    expect(o.bewaard()).toBe(dag(3));
    o.s.license.status(dag(8));
    expect(o.bewaard()).toBe(dag(8));
    // een licentie met de hand installeren (zonder datum van de server) verandert de bewaarde datum niet
    o.s.license.install(await o.licentie(dag(500)), VANDAAG);
    expect(o.bewaard()).toBe(dag(8));
    // een bewaarde waarde die geen datum is telt niet, en wordt bij de volgende controle vervangen
    o.db.prepare(`UPDATE settings SET value = ? WHERE key = 'licenseSeenDate'`).run(JSON.stringify('geen datum'));
    expect(o.s.license.status(dag(1)).state).toBe('actief');
    expect(o.bewaard()).toBe(dag(1));
  });

  it('KLOK-03 de klok stond per ongeluk ver in de toekomst: een opgehaalde licentie met de datum van de server herstelt een geldige licentie', async () => {
    const o = opzet();
    let antwoord: string | { token: string; serverDate?: IsoDate | null } | null = null;
    const api = createApi(o.s, { appVersion: () => 'test', licenseApi: { price: async () => null, fetch: async () => antwoord, start: async () => ({}), cancel: async () => ({}) } } as unknown as HostContext);
    o.s.license.install(await o.licentie(dag(20)), VANDAAG);
    // de klok staat een keer jaren vooruit en daarna weer goed
    expect(o.s.license.status(dag(2000)).state).toBe('verlopen');
    expect(o.bewaard()).toBe(dag(2000));
    expect((await api.license.status()).state).toBe('verlopen');
    expect(o.s.license.needsRefresh(VANDAAG)).toBe(true);
    // zonder datum van de server (alleen de licentie als tekst): de bewaarde datum blijft en de licentie blijft verlopen
    antwoord = await o.licentie(dag(20));
    expect((await api.license.refresh()).state).toBe('verlopen');
    expect(o.bewaard()).toBe(dag(2000));
    antwoord = { token: await o.licentie(dag(20)), serverDate: null };
    expect((await api.license.refresh()).state).toBe('verlopen');
    expect(o.bewaard()).toBe(dag(2000));
    // met de datum van de server: de bewaarde datum wordt die datum en de licentie is weer geldig
    antwoord = { token: await o.licentie(dag(20)), serverDate: VANDAAG };
    expect(await api.license.refresh()).toMatchObject({ state: 'actief', validUntil: dag(20) });
    expect(o.bewaard()).toBe(VANDAAG);
    expect((await api.license.status()).state).toBe('actief');
    expect(() => o.s.license.requireActive(VANDAAG)).not.toThrow();
    // de datum van de server maakt een verlopen licentie niet geldig: hij telt gewoon als de laatst geziene datum
    antwoord = { token: await o.licentie(dag(-3)), serverDate: VANDAAG };
    expect(await api.license.refresh()).toMatchObject({ state: 'verlopen', validUntil: dag(-3) });
  });

  it('KLOK-04 een datum van de server zonder geldige licentie voor deze administratie verandert niets', async () => {
    const o = opzet();
    let antwoord: string | { token: string; serverDate?: IsoDate | null } | null = null;
    const api = createApi(o.s, { appVersion: () => 'test', licenseApi: { price: async () => null, fetch: async () => antwoord, start: async () => ({}), cancel: async () => ({}) } } as unknown as HostContext);
    const eigen = await o.licentie(dag(5));
    o.s.license.install(eigen, VANDAAG);
    o.s.license.status(dag(9));
    expect(o.bewaard()).toBe(dag(9));
    const licentieVoor = o.db.prepare(`SELECT value FROM settings WHERE key = 'license'`).get();
    const ongeldig: [string, string][] = [
      ['een handtekening van een andere sleutel', await o.licentie(dag(50), { privateJwk: VREEMD.privateJwk })],
      ['een andere administratie', await o.licentie(dag(50), { administratie: '00000000-0000-4000-8000-000000000000' })],
      ['geen licentie', 'rommel'],
    ];
    for (const [wat, token] of ongeldig) {
      expect(() => o.s.license.install(token, VANDAAG, VANDAAG), wat).toThrow();
      antwoord = { token, serverDate: VANDAAG };
      await expect(api.license.refresh(), wat).rejects.toThrow();
      expect(o.bewaard(), wat).toBe(dag(9));
      expect(o.db.prepare(`SELECT value FROM settings WHERE key = 'license'`).get(), wat).toEqual(licentieVoor);
      expect(o.s.license.status(VANDAAG).state, wat).toBe('verlopen');
    }
    // geen licentie in het antwoord: ook dan niets
    antwoord = null;
    await expect(api.license.refresh()).rejects.toThrow(/Nog geen betaald abonnement/);
    antwoord = { token: '', serverDate: VANDAAG };
    await expect(api.license.refresh()).rejects.toThrow(/Nog geen betaald abonnement/);
    expect(o.bewaard()).toBe(dag(9));
    // een geldige licentie met iets wat geen datum is als serverdatum: de licentie wordt bewaard, de datum blijft
    for (const geenDatum of ['morgen', '2026-13-45', '', 20261011 as unknown as string]) {
      expect(o.s.license.install(await o.licentie(dag(700)), VANDAAG, geenDatum).state).toBe('actief');
      expect(o.bewaard(), String(geenDatum)).toBe(dag(9));
    }
  });

  it('KLOK-05 de kopie bij de boekhouder en de demo: de controle schrijft niets en rekent met wat er staat', async () => {
    for (const soort of ['kopie', 'demo'] as const) {
      const o = opzet();
      o.s.license.install(await o.licentie(dag(5)), VANDAAG);
      o.s.license.status(dag(2));
      expect(o.bewaard()).toBe(dag(2));
      if (soort === 'kopie') o.s.settings.markOfficeCopy({ office: 'Kantoor De Vries', exchange: 1, endDate: dag(-1) });
      else o.s.settings.update({ demoMode: true });
      const voor = o.db.prepare('SELECT key, value FROM settings ORDER BY key').all();
      // een latere datum wordt gebruikt voor de uitkomst, maar niet bewaard
      expect(o.s.license.status(dag(6)).state, soort).toBe('verlopen');
      expect(o.s.license.status(dag(3)).state, soort).toBe('actief');
      // een eerdere datum dan de bewaarde: er wordt gerekend met de bewaarde
      o.db.prepare(`UPDATE settings SET value = ? WHERE key = 'licenseSeenDate'`).run(JSON.stringify(dag(6)));
      expect(o.s.license.status(dag(3)).state, soort).toBe('verlopen');
      o.db.prepare(`UPDATE settings SET value = ? WHERE key = 'licenseSeenDate'`).run(JSON.stringify(dag(2)));
      expect(o.db.prepare('SELECT key, value FROM settings ORDER BY key').all(), soort).toEqual(voor);
    }
  });

  it('KLOK-06 een administratie die alleen gelezen kan worden: de controle mislukt niet en schrijft niets', async () => {
    const map = mkdtempSync(join(tmpdir(), 'bvn-licentie-datum-'));
    mappen.push(map);
    const bestand = join(map, 'boekhouding.sqlite');
    const schrijfbaar = new Database(bestand);
    const o = opzet({ db: schrijfbaar });
    o.s.license.install(await o.licentie(dag(5)), VANDAAG);
    o.s.license.status(dag(1));
    expect(o.bewaard()).toBe(dag(1));
    schrijfbaar.close();

    const alleenLezen = new Database(bestand, { readonly: true, fileMustExist: true });
    try {
      const licentie = new LicenseService(alleenLezen, new SettingsService(alleenLezen), SLEUTEL.publicKey);
      const lees = () => (JSON.parse((alleenLezen.prepare(`SELECT value FROM settings WHERE key = 'licenseSeenDate'`).get() as { value: string }).value) as string);
      expect(licentie.status(dag(4)).state).toBe('actief');
      expect(licentie.status(dag(6))).toMatchObject({ state: 'verlopen', validUntil: dag(5) });
      expect(() => licentie.requireActive(dag(6))).toThrow(/liep tot/);
      expect(licentie.needsRefresh(dag(6))).toBe(true);
      // niets bewaard: er staat nog wat er stond, en daarmee wordt gerekend
      expect(lees()).toBe(dag(1));
      expect(licentie.status(VANDAAG).state).toBe('actief');
    } finally {
      alleenLezen.close();
    }
  });

  it('KLOK-07 licenties uit (geen sleutel): alles mag, er wordt niets gelezen of bewaard, ook niet met een licentie en een datum in de administratie', async () => {
    const o = opzet({ zonderSleutel: true });
    const zetRij = (key: string, value: unknown) => o.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
    for (const datum of [VANDAAG, dag(900), dag(-900)]) {
      expect(o.s.license.status(datum)).toEqual({ state: 'uit' });
      expect(() => o.s.license.requireActive(datum)).not.toThrow();
      expect(o.s.license.needsRefresh(datum)).toBe(false);
      expect(telefoonAbonnement(o.s.license.status(datum))).toEqual({ toegestaan: true, verlopenOp: null });
    }
    expect(o.bewaard()).toBeNull();
    // ook als er uit een eerdere versie een verlopen licentie en een latere datum staan
    zetRij('license', 'oud.token');
    zetRij('licenseSeenDate', dag(50));
    const voor = o.db.prepare('SELECT key, value FROM settings ORDER BY key').all();
    expect(o.s.license.status(VANDAAG)).toEqual({ state: 'uit' });
    expect(() => o.s.license.requireActive(VANDAAG)).not.toThrow();
    expect(o.db.prepare('SELECT key, value FROM settings ORDER BY key').all()).toEqual(voor);
  });

  it('KLOK-08 zonder licentie valt er niets te beoordelen: geen en ongeldig blijven wat ze waren, en zonder licentie wordt er geen datum bewaard', async () => {
    const o = opzet();
    expect(o.s.license.status(dag(40))).toEqual({ state: 'geen' });
    expect(o.s.license.status(VANDAAG)).toEqual({ state: 'geen' });
    expect(() => o.s.license.requireActive(VANDAAG)).toThrow(/extra functies van het abonnement/);
    expect(o.s.license.needsRefresh(VANDAAG)).toBe(false);
    expect(o.bewaard()).toBeNull();
    // een licentie die niet klopt blijft ongeldig, op welke datum ook
    o.db.prepare(`INSERT INTO settings (key, value) VALUES ('license', ?)`).run(JSON.stringify(await o.licentie(dag(50), { privateJwk: VREEMD.privateJwk })));
    expect(o.s.license.status(dag(2)).state).toBe('ongeldig');
    expect(o.s.license.status(VANDAAG).state).toBe('ongeldig');
  });

  it('KLOK-09 de datum van de server komt uit de HTTP Date-kop, als kalenderdatum op deze computer; iets anders dan een datum telt niet', () => {
    const kop = 'Sun, 11 Oct 2026 07:52:39 GMT';
    expect(httpDateToIso(kop)).toBe(toIsoDate(new Date(Date.UTC(2026, 9, 11, 7, 52, 39))));
    // rond middernacht in GMT: de dag zoals deze computer hem telt (dezelfde afspraak als "vandaag" in de app)
    const laat = 'Sat, 31 Oct 2026 23:30:00 GMT';
    expect(httpDateToIso(laat)).toBe(toIsoDate(new Date(Date.UTC(2026, 9, 31, 23, 30, 0))));
    expect(httpDateToIso(new Date().toUTCString())).toBe(today());
    for (const geen of [null, undefined, '', '   ', 'geen datum', 'x'.repeat(200)]) expect(httpDateToIso(geen), String(geen)).toBeNull();
  });

  it('KLOK-10 de app geeft bij het ophalen de datum van de server mee uit hetzelfde antwoord als de licentie (src/main/main.ts)', () => {
    // het hoofdproces van de app is niet in een test te starten, daarom hier aan de bron (op Windows kan het bestand met \r\n uitgecheckt zijn)
    const bron = readFileSync(join(__dirname, '..', 'src', 'main', 'main.ts'), 'utf8').replace(/\r\n/g, '\n');
    const begin = bron.indexOf('async fetch(administrationId, managementKey) {');
    expect(begin).toBeGreaterThan(-1);
    const functie = bron.slice(begin, bron.indexOf('\n      },', begin));
    expect(functie).toContain("serverDate: httpDateToIso(res.headers.get('date'))");
    // de datum komt van het antwoord met de licentie, nooit van de klok van de computer
    expect(functie).not.toMatch(/today\(|new Date\(|Date\.now/);
  });
});
