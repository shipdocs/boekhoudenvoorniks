import { lstat, mkdir, open, readdir, rename, writeFile } from 'node:fs/promises';
import { join, parse } from 'node:path';
import type { Db } from '../db/database';
import type { ScannerPairing } from './pairing';
import { DIRECTION, HEADER_BYTES, LIMITS, TAG_BYTES, openRequest, openResponse, readHeader, sealResponse, toBase64Url, type ProtocolVersion } from './protocol';
import type { Behandeld } from './receiver';

/**
 * De bonnenmap als tweede route (stap 17): dezelfde versleutelde berichten als over het netwerk reizen als
 * bestanden door de bonnenmap, die de gebruiker bijvoorbeeld met Syncthing laat synchroniseren.
 *
 * - De telefoon schrijft een verzoek in `van-telefoon/` (naam: de nonce in hexadecimaal plus `.bvns`, door de
 *   telefoon gekozen; de pc vertrouwt de naam nooit). De pc leest het, ontsleutelt het met de koppelsleutel van
 *   het apparaat in de kop, handelt het af met dezelfde functie als het netwerk (`ScannerReceiver.behandel`, route
 *   map) en schrijft het versleutelde antwoord als nieuw bestand in `van-pc/` (naam: `<nonce-hex>.antwoord.bvns`).
 * - Elke kant schrijft alleen in zijn eigen map. Verwerkte verzoeken gaan naar `van-telefoon/verwerkt/`. De pc maakt
 *   nooit iets weg en overschrijft nooit iets: een bestand dat al bestaat blijft zoals het is.
 * - Definitief (200, 400, 413 en een bestand dat nooit zal lukken): antwoordbestand waar dat kan, verzoek naar
 *   verwerkt/. Herhaalbaar (503, 500, 409 klant-/project-onbekend, niet-ondersteund): het verzoek blijft liggen en
 *   wordt na een rustige terugval opnieuw geprobeerd; het register van SyncOntvangst maakt dat zonder dubbel effect.
 * - Bestanden die niet te lezen zijn, niet van een gekoppeld apparaat komen of zijn aangepast, krijgen geen antwoord
 *   (de pc heeft geen sleutel om mee te antwoorden): definitief naar verwerkt/ met een regel in het probleemregister.
 *
 * Bewust een rustige rondgang, zoals ReceiptFolderWatch (src/scanner/folder-watch.ts): alleen gewone bestanden
 * direct in de map (geen submappen, geen snelkoppelingen, geen verborgen of tijdelijke bestanden), pas als de
 * grootte een tijd gelijk is gebleven. Stabiliteit en terugval lopen op de echte klok, niet op de klok van de administratie.
 */

export const MAP_VAN_TELEFOON = 'van-telefoon';
export const MAP_VAN_PC = 'van-pc';
export const MAP_VERWERKT = 'verwerkt';
export const MAP_EXTENSIE = '.bvns';
export const MAP_ANTWOORD_ACHTERVOEGSEL = '.antwoord.bvns';
/** zoveel bestanden pakt één rondgang hoogstens aan */
export const MAP_MAX_PER_RONDE = 20;
/** zoveel ongeziene regels houdt het probleemregister hoogstens bij */
export const MAP_MAX_ONGEZIEN = 1000;
export const MAP_SOORTEN = ['onleesbaar', 'onbekend-apparaat', 'afgewezen', 'veld-ongeldig', 'schrijven-mislukt'] as const;
export type MapProbleemSoort = (typeof MAP_SOORTEN)[number];

/** na zoveel mislukte pogingen om te schrijven of te verplaatsen komt er een regel in het probleemregister */
const MELDEN_NA_POGINGEN = 3;
const MAX_TERUGVAL_MS = 60_000;

export interface MapStatus {
  /** de rondgang loopt */
  actief: boolean;
  /** de mappen zijn er en te lezen */
  bereikbaar: boolean;
  /** verzoekbestanden die nu in van-telefoon/ liggen */
  wachtend: number;
  /** waarvan er een aantal wacht op een nieuwe poging */
  herhaalt: number;
  /** verzoekbestanden die sinds het opstarten definitief zijn afgehandeld */
  verwerkt: number;
  /** ongeziene regels in het probleemregister */
  problemen: number;
}

/** De twee bestandsacties die mislukken kunnen; tests vervangen ze om een mislukking na te bootsen (ook op Windows). */
export interface MapBestanden {
  /** schrijft een nieuw bestand en gooit met code EEXIST als het al bestaat; overschrijft nooit */
  schrijfNieuw(pad: string, data: Buffer): Promise<void>;
  /** verplaatst een bestand naar een naam die niet bestaat */
  verplaats(van: string, naar: string): Promise<void>;
}

export interface MapRouteOptions {
  db: Db;
  pairing: Pick<ScannerPairing, 'key'>;
  /** de gedeelde afhandeling van het netwerk (ScannerReceiver.behandel) */
  behandel: (deviceId: string, kop: { versie: ProtocolVersion; nonce: Buffer }, plaintext: Buffer, route: 'map') => Behandeld;
  /** de gekozen bonnenmap, of null (niet gekozen, niet toegestaan of de route staat uit) */
  folder: () => Promise<string | null>;
  /** de tijd voor de regels in het probleemregister (de klok van de administratie) */
  now?: () => number;
  /** de klok voor stabiele grootte en terugval (ms); standaard de echte klok, tests geven een eigen klok */
  klok?: () => number;
  pollMs?: number;
  stableMs?: number;
  bestanden?: Partial<MapBestanden>;
  onProcessed?: () => void;
  log?: (message: string) => void;
}

interface Probleem {
  soort: MapProbleemSoort;
  apparaat: string | null;
  fout: string | null;
  veld: string | null;
}

interface Antwoord {
  deviceId: Buffer;
  nonce: Buffer;
  versie: ProtocolVersion;
  status: number;
  json: Record<string, unknown>;
}

/** Wat er na het afhandelen van één verzoekbestand nog moet gebeuren; staat vast zodra de pc het bestand heeft afgehandeld. */
interface Afronding {
  probleem?: Probleem;
  antwoord?: Antwoord;
}

interface Staat {
  /** grootte en wijzigingstijd van het bestand waar deze staat bij hoort */
  key: string;
  pogingen: number;
  /** vóór dit moment (echte klok) niet opnieuw proberen */
  volgende: number;
  afronding?: Afronding;
  probleemGelegd: boolean;
  antwoordGeschreven: boolean;
  schrijfMelding: boolean;
}

const standaardBestanden: MapBestanden = {
  async schrijfNieuw(pad, data) {
    await writeFile(pad, data, { flag: 'wx' });
  },
  async verplaats(van, naar) {
    await rename(van, naar);
  },
};

export class MapRoute {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private queued: Promise<void> | null = null;
  private stopped = false;
  private readonly seen = new Map<string, { key: string; since: number }>();
  private readonly staat = new Map<string, Staat>();
  private verwerkt = 0;
  private wachtend = 0;
  private bereikbaar = false;
  private readonly bestanden: MapBestanden;
  private readonly now: () => number;
  private readonly klok: () => number;
  private readonly pollMs: number;
  private readonly stableMs: number;

  constructor(private readonly opts: MapRouteOptions) {
    this.now = opts.now ?? Date.now;
    this.klok = opts.klok ?? Date.now;
    this.pollMs = opts.pollMs ?? 2_000;
    this.stableMs = opts.stableMs ?? 3_000;
    this.bestanden = { ...standaardBestanden, ...opts.bestanden };
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.scan(), this.pollMs);
    this.timer.unref();
    void this.scan();
  }

  /** Stopt de rondgang; een bestand dat al in behandeling is wordt eerst afgemaakt, er blijft niets half achter. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  /** Na het kiezen van een andere map: opnieuw beginnen. */
  reset(): void {
    this.seen.clear();
    this.staat.clear();
    this.wachtend = 0;
    this.bereikbaar = false;
  }

  status(): MapStatus {
    let problemen = 0;
    try {
      problemen = (this.opts.db.prepare('SELECT COUNT(*) AS n FROM sync_map_problemen WHERE gezien_op IS NULL').get() as { n: number }).n;
    } catch {
      /* de administratie gaat net dicht */
    }
    return { actief: this.timer !== null, bereikbaar: this.bereikbaar, wachtend: this.wachtend, herhaalt: [...this.staat.values()].filter((s) => s.pogingen > 0).length, verwerkt: this.verwerkt, problemen };
  }

  /** Eén rondgang. Rondgangen overlappen nooit: loopt er al een, dan volgt er daarna nog precies één. */
  scan(): Promise<void> {
    if (!this.running) {
      this.running = this.scanOnce()
        .catch((e) => this.opts.log?.(`Bonnenmap bekijken mislukt (${codeVan(e)})`))
        .finally(() => {
          this.running = null;
        });
      return this.running;
    }
    this.queued ??= this.running.then(() => {
      this.queued = null;
      return this.scan();
    });
    return this.queued;
  }

  private async scanOnce(): Promise<void> {
    if (this.stopped) return;
    const dir = await this.opts.folder();
    if (!dir) {
      this.bereikbaar = false;
      this.wachtend = 0;
      return;
    }
    const van = join(dir, MAP_VAN_TELEFOON);
    const verwerkt = join(van, MAP_VERWERKT);
    const naar = join(dir, MAP_VAN_PC);
    if (!(await maakMap(van)) || !(await maakMap(verwerkt)) || !(await maakMap(naar))) {
      this.bereikbaar = false;
      this.wachtend = 0;
      return;
    }
    let namen: string[];
    try {
      // alleen gewone bestanden: geen mappen (ook verwerkt/ niet) en geen snelkoppelingen; een tijdelijk bestand telt niet
      namen = (await readdir(van, { withFileTypes: true })).filter((e) => e.isFile() && e.name.toLowerCase().endsWith(MAP_EXTENSIE) && !isTijdelijk(e.name)).map((e) => e.name);
      this.bereikbaar = true;
    } catch {
      this.bereikbaar = false;
      return;
    }
    const aanwezig = new Set(namen);
    for (const kaart of [this.seen, this.staat]) for (const naam of [...kaart.keys()]) if (!aanwezig.has(naam)) kaart.delete(naam);

    const kandidaten: { naam: string; key: string; size: number; mtime: number }[] = [];
    for (const naam of namen) {
      try {
        const st = await lstat(join(van, naam));
        if (!st.isFile()) continue;
        kandidaten.push({ naam, key: `${st.size}:${st.mtimeMs}`, size: st.size, mtime: st.mtimeMs });
      } catch {
        /* intussen weg */
      }
    }
    this.wachtend = kandidaten.length;
    // oudste eerst, zodat de volgorde van de telefoon zoveel mogelijk blijft
    kandidaten.sort((a, b) => a.mtime - b.mtime || (a.naam < b.naam ? -1 : a.naam > b.naam ? 1 : 0));

    const nu = this.klok();
    let aangepakt = 0;
    for (const k of kandidaten) {
      if (this.stopped || aangepakt >= MAP_MAX_PER_RONDE) break;
      const gezien = this.seen.get(k.naam);
      if (!gezien || gezien.key !== k.key) {
        // nieuw of nog in beweging: opnieuw tellen
        this.seen.set(k.naam, { key: k.key, since: nu });
        this.staat.delete(k.naam);
        continue;
      }
      // nog te kort gelijk gebleven, of nog leeg (een synchronisatieprogramma maakt het bestand soms eerst leeg aan)
      if (nu - gezien.since < this.stableMs || k.size === 0) continue;
      const staat = this.staat.get(k.naam);
      if (staat && staat.key === k.key && nu < staat.volgende) continue;
      aangepakt++;
      await this.verwerk(van, verwerkt, naar, k.naam, k.key, k.size);
    }
  }

  private async verwerk(van: string, verwerkt: string, naar: string, naam: string, key: string, size: number): Promise<void> {
    let staat = this.staat.get(naam);
    if (!staat || staat.key !== key) {
      staat = { key, pogingen: 0, volgende: 0, probleemGelegd: false, antwoordGeschreven: false, schrijfMelding: false };
      this.staat.set(naam, staat);
    }
    if (!staat.afronding) {
      const gelezen = await this.lees(join(van, naam), size);
      if (gelezen === 'groeit') return void this.seen.delete(naam);
      if (gelezen === 'weg') return void this.staat.delete(naam);
      if (gelezen === 'herhaal') return this.uitstellen(staat);
      staat.afronding = gelezen.afronding;
      // een nieuwe bon ligt in de spool: op naar de inbox, ook als het antwoord of het verplaatsen nog niet lukt
      try {
        gelezen.na?.();
      } catch (e) {
        this.opts.log?.(`Bonnenmap: na het afhandelen ging iets mis (${codeVan(e)})`);
      }
    }
    await this.rondAf(van, verwerkt, naar, naam, staat);
  }

  /**
   * Leest en handelt één verzoekbestand af. Geeft de afronding (wat er nog met bestanden en register moet gebeuren) terug, of
   * 'herhaal' als het later opnieuw moet. Het bestand wordt niet langer open gehouden dan nodig is (op Windows is een open bestand niet te verplaatsen).
   */
  private async lees(pad: string, size: number): Promise<'groeit' | 'weg' | 'herhaal' | { afronding: Afronding; na?: () => void }> {
    const onleesbaar = (fout: string, apparaat: string | null = null, soort: MapProbleemSoort = 'onleesbaar') => ({ afronding: { probleem: { soort, apparaat, fout, veld: null } } });
    // nooit meer in het geheugen nemen dan het netwerk aanneemt, en niets dat te kort is om een envelop te zijn
    if (size < HEADER_BYTES + TAG_BYTES) return onleesbaar('te-kort');
    if (size > LIMITS.maxBodyBytes) return onleesbaar('te-groot');
    let data: Buffer;
    try {
      const handle = await open(pad, 'r');
      try {
        const buf = Buffer.alloc(size + 1);
        const { bytesRead } = await handle.read(buf, 0, size + 1, 0);
        data = buf.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    } catch (e) {
      if (codeVan(e) === 'ENOENT') return 'weg';
      this.opts.log?.(`Bonnenmap: een verzoekbestand lezen mislukt (${codeVan(e)})`);
      return 'herhaal';
    }
    // tijdens het lezen toch nog veranderd: de volgende rondgang opnieuw
    if (data.length !== size) return 'groeit';

    // het apparaat en zijn sleutel komen uit de kop van de envelop, nooit uit de bestandsnaam of het bericht
    const kop = readHeader(data, DIRECTION.request);
    if (!kop) return onleesbaar('geen-envelop');
    const apparaat = toBase64Url(kop.deviceId);
    let sleutel: Buffer | null;
    try {
      sleutel = this.opts.pairing.key(apparaat);
    } catch {
      // de administratie gaat net dicht
      return 'herhaal';
    }
    if (!sleutel) return onleesbaar('niet-gekoppeld', apparaat, 'onbekend-apparaat');
    const plaintext = openRequest(data, sleutel);
    if (!plaintext) return onleesbaar('niet-te-openen', apparaat);

    let uitkomst: Behandeld;
    try {
      uitkomst = this.opts.behandel(apparaat, { versie: kop.versie, nonce: kop.nonce }, plaintext, 'map');
    } catch (e) {
      this.opts.log?.(`Bonnenmap: een verzoek afhandelen mislukt (${codeVan(e)})`);
      return 'herhaal';
    }
    const soort = classificeer(uitkomst);
    if (soort === 'herhaal') return 'herhaal';
    const antwoord: Antwoord = { deviceId: Buffer.from(kop.deviceId), nonce: Buffer.from(kop.nonce), versie: kop.versie, status: uitkomst.status, json: uitkomst.json };
    return { afronding: { antwoord, ...(soort.probleem ? { probleem: { ...soort.probleem, apparaat } } : {}) }, na: uitkomst.na };
  }

  /** Antwoordbestand, probleemregel en verplaatsen; lukt iets niet, dan blijft het verzoek staan en volgt een nieuwe poging. */
  private async rondAf(van: string, verwerkt: string, naar: string, naam: string, staat: Staat): Promise<void> {
    const afronding = staat.afronding!;
    try {
      if (afronding.probleem && !staat.probleemGelegd) {
        this.leg(afronding.probleem, naam);
        staat.probleemGelegd = true;
      }
    } catch (e) {
      this.opts.log?.(`Bonnenmap: het probleemregister bijwerken mislukt (${codeVan(e)})`);
      return this.uitstellen(staat);
    }
    if (afronding.antwoord && !staat.antwoordGeschreven) {
      const uitslag = await this.schrijfAntwoord(naar, afronding.antwoord);
      if (uitslag.soort === 'mislukt') return this.mislukt(staat, naam, uitslag.code);
      if (uitslag.soort === 'botsing') {
        try {
          this.leg({ soort: 'schrijven-mislukt', apparaat: toBase64Url(afronding.antwoord.deviceId), fout: 'antwoord-bestaat-al', veld: null }, naam);
        } catch (e) {
          this.opts.log?.(`Bonnenmap: het probleemregister bijwerken mislukt (${codeVan(e)})`);
          return this.uitstellen(staat);
        }
      }
      staat.antwoordGeschreven = true;
    }
    try {
      const doel = await vrijeNaam(verwerkt, naam);
      await this.bestanden.verplaats(join(van, naam), doel);
    } catch (e) {
      return this.mislukt(staat, naam, codeVan(e));
    }
    this.staat.delete(naam);
    this.seen.delete(naam);
    this.verwerkt++;
    this.wachtend = Math.max(0, this.wachtend - 1);
    this.opts.onProcessed?.();
  }

  /**
   * Het antwoord als nieuw bestand in van-pc/, gebonden aan de nonce van het verzoek en in de protocolversie van het verzoek.
   * Bestaat het bestand al en is het een echt antwoord op dit verzoek (bijvoorbeeld na een onderbreking tussen schrijven en
   * verplaatsen), dan blijft het zoals het is. Is het iets anders, dan is dat een botsing: nooit overschrijven.
   */
  private async schrijfAntwoord(naar: string, a: Antwoord): Promise<{ soort: 'ok' } | { soort: 'botsing' } | { soort: 'mislukt'; code: string }> {
    let sleutel: Buffer | null;
    try {
      sleutel = this.opts.pairing.key(toBase64Url(a.deviceId));
    } catch {
      return { soort: 'mislukt', code: 'ONBEKEND' };
    }
    // intussen ontkoppeld: de pc heeft geen sleutel meer om mee te antwoorden
    if (!sleutel) return { soort: 'ok' };
    const pad = join(naar, `${a.nonce.toString('hex')}${MAP_ANTWOORD_ACHTERVOEGSEL}`);
    const data = sealResponse(a.deviceId, sleutel, a.nonce, a.json, undefined, a.versie);
    try {
      await this.bestanden.schrijfNieuw(pad, data);
      return { soort: 'ok' };
    } catch (e) {
      if (codeVan(e) !== 'EEXIST') return { soort: 'mislukt', code: codeVan(e) };
    }
    try {
      const st = await lstat(pad);
      if (!st.isFile() || st.size > LIMITS.maxBodyBytes) return { soort: 'botsing' };
      const handle = await open(pad, 'r');
      let bestaand: Buffer;
      try {
        const buf = Buffer.alloc(st.size);
        const { bytesRead } = await handle.read(buf, 0, st.size, 0);
        bestaand = buf.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
      return openResponse(bestaand, sleutel, a.nonce) ? { soort: 'ok' } : { soort: 'botsing' };
    } catch (e) {
      return { soort: 'mislukt', code: codeVan(e) };
    }
  }

  /** Een regel in het probleemregister: alleen de naam van het bestand, nooit het pad of de inhoud, en nooit twee keer dezelfde ongeziene regel. */
  private leg(p: Probleem, naam: string): void {
    const db = this.opts.db;
    const bestandsnaam = schoonNaam(naam);
    const fout = p.fout === null ? null : p.fout.slice(0, 100);
    const veld = p.veld === null ? null : p.veld.slice(0, 100);
    const bestaat = db
      .prepare(`SELECT 1 FROM sync_map_problemen WHERE gezien_op IS NULL AND bestandsnaam = ? AND soort = ? AND COALESCE(fout, '') = COALESCE(?, '') AND COALESCE(veld, '') = COALESCE(?, '') AND COALESCE(apparaat_id, '') = COALESCE(?, '')`)
      .get(bestandsnaam, p.soort, fout, veld, p.apparaat);
    if (bestaat) return;
    // begrensd: meer dan dit aantal ongeziene regels wordt niet bijgehouden (de melding toont dan een telling)
    const ongezien = (db.prepare('SELECT COUNT(*) AS n FROM sync_map_problemen WHERE gezien_op IS NULL').get() as { n: number }).n;
    if (ongezien >= MAP_MAX_ONGEZIEN) return;
    db.prepare('INSERT INTO sync_map_problemen (bestandsnaam, apparaat_id, soort, fout, veld, tijd) VALUES (?, ?, ?, ?, ?, ?)').run(bestandsnaam, p.apparaat, p.soort, fout, veld, this.now());
  }

  /** Een schrijf- of verplaatsactie mislukte: onthouden, later opnieuw, en na een paar keer een regel in het probleemregister. */
  private mislukt(staat: Staat, naam: string, code: string): void {
    this.opts.log?.(`Bonnenmap: schrijven of verplaatsen mislukt (${code})`);
    this.uitstellen(staat);
    if (staat.pogingen >= MELDEN_NA_POGINGEN && !staat.schrijfMelding) {
      try {
        this.leg({ soort: 'schrijven-mislukt', apparaat: null, fout: veiligeCode(code), veld: null }, naam);
        staat.schrijfMelding = true;
      } catch {
        /* de administratie gaat net dicht */
      }
    }
  }

  /** Rustige terugval: de wachttijd verdubbelt per poging, van een poll tot hoogstens een minuut. */
  private uitstellen(staat: Staat): void {
    staat.pogingen++;
    staat.volgende = this.klok() + Math.min(MAX_TERUGVAL_MS, this.pollMs * 2 ** Math.min(staat.pogingen, 12));
  }
}

/**
 * Wat betekent een uitkomst van de gedeelde afhandeling voor een bestand? Herhaalbaar blijft liggen; definitief krijgt een
 * antwoord en gaat naar verwerkt/, met een regel voor een afgewezen wijziging of een veldfout.
 */
function classificeer(u: Behandeld): 'herhaal' | { probleem?: Omit<Probleem, 'apparaat'> } {
  const fout = typeof u.json.fout === 'string' ? u.json.fout : null;
  if (u.status === 200) {
    if (u.json.uitkomst === 'niet-ondersteund') return 'herhaal';
    if (u.json.uitkomst === 'afgewezen') return { probleem: { soort: 'afgewezen', fout, veld: null } };
    return {};
  }
  if (u.status === 400) return fout === 'veld-ongeldig' ? { probleem: { soort: 'veld-ongeldig', fout, veld: typeof u.json.veld === 'string' ? u.json.veld : null } } : {};
  if (u.status === 413) return {};
  // dezelfde bon-id met andere inhoud komt nooit goed door opnieuw te proberen
  if (u.status === 409 && fout === 'id-botst') return { probleem: { soort: 'afgewezen', fout, veld: null } };
  return 'herhaal';
}

/** Bestanden die een synchronisatieprogramma nog aan het schrijven is, en verborgen bestanden. */
function isTijdelijk(naam: string): boolean {
  return naam.startsWith('.') || naam.startsWith('~') || /\.(tmp|part|partial|crdownload|download)$/i.test(naam);
}

/** Alleen de naam, zonder stuurtekens en niet te lang. */
function schoonNaam(naam: string): string {
  return naam.replace(/[\u0000-\u001f\u007f]/g, '_').slice(0, 120);
}

function codeVan(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' ? veiligeCode(code) : 'ONBEKEND';
}

/** Alleen een foutcode als EACCES; nooit een tekst waar een pad in kan staan. */
function veiligeCode(code: string): string {
  return /^[A-Z][A-Z0-9_]{1,30}$/.test(code) ? code : 'ONBEKEND';
}

/** Maakt een map aan als ze er niet is. Onwaar als er iets anders dan een echte map staat (ook een snelkoppeling): dan wordt er niet in gewerkt. */
async function maakMap(pad: string): Promise<boolean> {
  try {
    let st = await lstat(pad).catch(() => null);
    if (!st) {
      await mkdir(pad).catch((e: unknown) => {
        if (codeVan(e) !== 'EEXIST') throw e;
      });
      st = await lstat(pad);
    }
    return st.isDirectory();
  } catch {
    return false;
  }
}

/** Een naam in `map` die nog niet bestaat: x.bvns, x (2).bvns, x (3).bvns, … Nooit overschrijven. */
async function vrijeNaam(map: string, naam: string): Promise<string> {
  const { name: basis, ext } = parse(naam);
  const bestaat = (pad: string) => lstat(pad).then(() => true, () => false);
  let kandidaat = join(map, naam);
  for (let i = 2; await bestaat(kandidaat); i++) kandidaat = join(map, `${basis} (${i})${ext}`);
  return kandidaat;
}
