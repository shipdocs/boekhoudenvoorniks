import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, parse } from 'node:path';
import type { Db } from '../db/database';
import type { SecretStore } from '../integrations/types';
import type { IntakeService } from '../intake/intake';
import type { SettingsService } from '../settings/settings';
import { isPathInside } from '../main/path-security';
import { today } from '../shared/dates';
import type { PaidWith } from '../shared/paid-with';
import { ReceiptFolderWatch, type FolderStatus } from './folder-watch';
import { jpegsToPdf } from './jpeg-pdf';
import type { Advertiser } from './mdns';
import { localInterfaces, type LocalInterface } from './network';
import { ScannerPairing, type ScannerDevice } from './pairing';
import { encodePairing, type PaymentMethod, type ReceiptMessage } from './protocol';
import { ScannerReceiver } from './receiver';
import { ReceiptSpool } from './spool';

export interface ScannerDeps {
  db: Db;
  /** dezelfde versleutelde opslag als voor het SMTP-wachtwoord */
  secrets: SecretStore;
  intake: Pick<IntakeService, 'add'>;
  settings: SettingsService;
  /** map van de open administratie waarin ontvangen bonnen wachten tot ze in de inbox staan */
  spoolDir: string;
  /** mappen van de app zelf: daar mag de bonnenmap niet in liggen */
  protectedDirs?: string[];
  homeDir?: string;
  /** mappen die als geheel te breed zijn om te bewaken (Documenten, Downloads, Bureaublad, …) */
  broadDirs?: string[];
  interfaces?: () => LocalInterface[];
  peerAllowed?: (remote: string, local: LocalInterface) => boolean;
  /** mDNS; ontbreekt in tests */
  advertiser?: Advertiser;
  now?: () => number;
  platform?: NodeJS.Platform;
  /** er is iets binnengekomen of veranderd: het scherm mag verversen */
  onChange?: () => void;
  log?: (message: string) => void;
  folderPollMs?: number;
  folderStableMs?: number;
}

export interface ScannerStatus {
  /** waarom de bonnenscanner hier uit staat (demo, kopie bij de boekhouder), of null */
  blocked: string | null;
  /** het ontvangstpunt luistert */
  running: boolean;
  port: number | null;
  addresses: string[];
  devices: ScannerDevice[];
  /** op Windows: de uitleg over de melding van de firewall is nog niet getoond */
  firewallHint: boolean;
  /** bonnen van de telefoon die nog naar de inbox moeten */
  waiting: number;
  /** bonnen die niet in de inbox gezet konden worden; ze blijven bewaard op deze plek */
  failed: { id: string; path: string; error: string | null }[];
  folder: FolderStatus;
}

export interface PairingStart {
  deviceId: string;
  /** de tekst voor de QR-code; bevat de sleutel en blijft dus in het hoofdproces */
  payload: string;
  expiresAt: number;
  addresses: string[];
  port: number;
}

const PAID_WITH: Record<PaymentMethod, PaidWith> = { pin: 'bank', contant: 'kas', prive: 'prive', later: 'later' };
const REFRESH_MS = 15_000;
const FOLDER_KEY = 'receiptFolder';
/** de gewone mappen in een thuismap: als geheel te breed, een submap ervan mag wel */
const COMMON_FOLDERS = ['Desktop', 'Documents', 'Downloads', 'Pictures', 'OneDrive', 'Dropbox', 'Google Drive', 'Bureaublad', 'Documenten', 'Afbeeldingen'];

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

/**
 * De bonnenscanner aan de kant van de desktop (#48): telefoons koppelen, het ontvangstpunt op het
 * lokale netwerk, vindbaar via mDNS, en de bonnenmap als uitwijk. Staat standaard uit: zonder
 * gekoppelde telefoon luistert er niets, en zonder gekozen map wordt er nergens gekeken.
 *
 * Niets hiervan boekt zelf: elke bon komt in de inbox en wacht op controle, zoals bonnen uit de mail.
 */
export class Bonnenscanner {
  readonly pairing: ScannerPairing;
  private readonly spool: ReceiptSpool;
  private readonly receiver: ScannerReceiver;
  private readonly watch: ReceiptFolderWatch;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private draining: Promise<void> = Promise.resolve();
  private inboxQueue: Promise<unknown> = Promise.resolve();
  private readonly log: (message: string) => void;

  constructor(private readonly deps: ScannerDeps) {
    this.log = deps.log ?? (() => undefined);
    this.pairing = new ScannerPairing(deps.db, deps.secrets, deps.now);
    this.spool = new ReceiptSpool(deps.db, deps.spoolDir);
    this.receiver = new ScannerReceiver({
      pairing: this.pairing,
      spool: this.spool,
      interfaces: () => (this.blocked() ? [] : (deps.interfaces ?? localInterfaces)()),
      peerAllowed: deps.peerAllowed,
      now: deps.now,
      keepLocation: () => deps.settings.get().jobLocation,
      onStored: () => void this.processSpool(),
      onActivity: () => deps.onChange?.(),
      log: this.log,
    });
    this.watch = new ReceiptFolderWatch({
      folder: () => this.watchedFolder(),
      configured: () => (this.blocked() ? null : this.folder()),
      add: async (name, data) => {
        return this.toInbox(async () => {
          const known = this.deps.db.prepare('SELECT id FROM documents WHERE sha256 = ?').get(sha256(data)) as { id: number } | undefined;
          const doc = await this.addToInbox(safeFileName(name), data);
          return { documentId: doc.id, duplicate: Boolean(known) };
        });
      },
      now: deps.now,
      pollMs: deps.folderPollMs,
      stableMs: deps.folderStableMs,
      onProcessed: () => deps.onChange?.(),
    });
  }

  /** In de demo en in de kopie bij de boekhouder komt er niets binnen. */
  blocked(): string | null {
    if (this.deps.settings.get().demoMode) return 'In de demo kun je geen telefoon koppelen en geen bonnenmap gebruiken. Wis de demo om echt te beginnen.';
    const copy = this.deps.settings.officeCopy();
    if (copy) return `Dit is de kopie voor ${copy.office}: bonnen komen binnen in de administratie van de klant zelf.`;
    return null;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.spool.recover();
    await this.refresh();
    // intussen gestopt (bv. meteen een andere administratie geopend): niets meer aanzetten
    if (this.stopped) return;
    this.watch.start();
    void this.processSpool();
    this.timer = setInterval(() => {
      void this.refresh();
      // een bon die net niet lukte (bv. schijf even vol): om de zoveel tijd opnieuw, een paar keer
      try {
        if (this.spool.waiting().length > 0) void this.processSpool();
      } catch {
        /* de administratie gaat net dicht */
      }
    }, REFRESH_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.watch.stop();
    this.deps.advertiser?.stop();
    await this.receiver.stop();
  }

  /**
   * Ontvangstpunt en mDNS naar de stand van nu: aan met minstens één telefoon, anders uit; na een
   * nieuw IP-adres op het nieuwe adres. Ruimt ook een verlopen QR-code op.
   */
  async refresh(): Promise<void> {
    if (this.stopped) return;
    await this.receiver.sync();
    if (this.stopped) return;
    const port = this.receiver.port;
    this.deps.advertiser?.update(port ? this.receiver.interfaces.map((i) => ({ pcId: this.pairing.pcId(), port, address: i.address, netmask: i.netmask })) : []);
  }

  status(): ScannerStatus {
    const devices = this.pairing.list();
    // net de laatste (verlopen) QR-code opgeruimd: dan het ontvangstpunt meteen uit, niet pas bij de volgende ronde
    if (this.receiver.running && !devices.some((d) => d.usable)) void this.refresh();
    return {
      blocked: this.blocked(),
      running: this.receiver.running,
      port: this.receiver.port,
      addresses: this.receiver.addresses,
      devices,
      firewallHint: (this.deps.platform ?? process.platform) === 'win32' && !this.pairing.firewallSeen(),
      waiting: this.spool.waiting().length,
      failed: this.spool.failed().map((r) => ({ id: r.id, path: this.spool.pathOf(r.id), error: r.error })),
      folder: this.watch.status(),
    };
  }

  /** De uitleg over de Windows-firewall is getoond. */
  firewallSeen(): void {
    this.pairing.markFirewallSeen();
  }

  /**
   * Telefoon koppelen: nieuwe sleutel, ontvangstpunt aan, en de gegevens voor de QR-code. Meldt de
   * telefoon zich niet binnen tien minuten, dan vervalt de sleutel en gaat het ontvangstpunt weer uit
   * (als er verder geen telefoon gekoppeld is).
   */
  async pair(): Promise<PairingStart> {
    const blocked = this.blocked();
    if (blocked) throw new Error(blocked);
    const { deviceId, key, expiresAt } = this.pairing.begin();
    await this.refresh();
    const port = this.receiver.port;
    if (!port) {
      this.pairing.cancel(deviceId);
      await this.refresh();
      throw new Error('Je computer zit nu niet op een thuis- of kantoornetwerk (wifi of kabel). Verbind hem eerst en probeer het opnieuw.');
    }
    const addresses = this.receiver.addresses.slice(0, 4);
    this.deps.onChange?.();
    return { deviceId, expiresAt, addresses, port, payload: encodePairing({ pc: this.pairing.pcId(), apparaat: deviceId, sleutel: key.toString('base64url'), poort: port, adressen: addresses }) };
  }

  /** De QR-code is gesloten zonder dat de telefoon zich meldde. */
  async cancelPairing(deviceId: string): Promise<void> {
    this.pairing.cancel(deviceId);
    await this.refresh();
  }

  /** Ontkoppelen trekt de sleutel in; was dit de laatste telefoon, dan gaat het ontvangstpunt uit. */
  async unpair(deviceId: string): Promise<void> {
    this.pairing.unpair(deviceId);
    await this.refresh();
    this.deps.onChange?.();
  }

  // ---------- bonnenmap ----------

  folder(): string | null {
    const row = this.deps.db.prepare('SELECT value FROM settings WHERE key = ?').get(FOLDER_KEY) as { value: string } | undefined;
    try {
      const value = row ? (JSON.parse(row.value) as unknown) : null;
      return typeof value === 'string' && value ? value : null;
    } catch {
      return null;
    }
  }

  /**
   * Mag dit de bonnenmap zijn? Geeft het echte pad terug, of gooit met de reden. De app verplaatst
   * bestanden uit deze map, dus een map die te breed is (de schijf, je thuismap, je hele map Documenten
   * of Downloads) of van de app zelf, wordt geweigerd.
   */
  private async checkFolder(path: string): Promise<string> {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Kies een map op deze computer');
    let real: string;
    try {
      real = await realpath(path);
      if (!(await stat(real)).isDirectory()) throw new Error('geen map');
    } catch {
      throw new Error('Deze map bestaat niet (meer). Kies een andere map.');
    }
    const home = await realOr(this.deps.homeDir ?? homedir());
    // "in of gelijk aan": een denkbeeldig bestand in de map ligt dan echt onder de andere map
    const within = (root: string, candidate: string) => isPathInside(root, join(candidate, 'x'));
    const broad = [...COMMON_FOLDERS.map((name) => join(home, name)), ...(await Promise.all((this.deps.broadDirs ?? []).map(realOr)))];
    if (real === parse(real).root || within(real, home) || broad.some((b) => within(real, b))) {
      throw new Error('Deze map is te groot om te bewaken: alles wat erin staat zou als bon binnenkomen. Maak een aparte map voor je bonnen, bijvoorbeeld "Bonnen" in je documenten.');
    }
    for (const own of this.deps.protectedDirs ?? []) {
      if (within(await realOr(own), real)) throw new Error('Dit is een map van BoekhoudenVoorNiks zelf. Kies een aparte map voor je bonnen.');
    }
    return real;
  }

  /**
   * De map waar de rondgang in kijkt: de gekozen map, mits die nog steeds aan de regels voldoet en nog
   * dezelfde map is (bv. niet intussen een snelkoppeling naar elders, of overgenomen uit een back-up
   * van een andere computer).
   */
  private async watchedFolder(): Promise<string | null> {
    const chosen = this.blocked() ? null : this.folder();
    if (!chosen) return null;
    try {
      return (await this.checkFolder(chosen)) === chosen ? chosen : null;
    } catch {
      return null;
    }
  }

  /**
   * De bonnenmap kiezen (of met null: uitzetten). Het pad komt uit het keuzevenster van het
   * besturingssysteem, niet uit het scherm.
   */
  async setFolder(path: string | null): Promise<FolderStatus> {
    if (path === null) {
      this.deps.db.prepare('DELETE FROM settings WHERE key = ?').run(FOLDER_KEY);
    } else {
      const blocked = this.blocked();
      if (blocked) throw new Error(blocked);
      const real = await this.checkFolder(path);
      this.deps.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(FOLDER_KEY, JSON.stringify(real));
    }
    this.watch.reset();
    await this.watch.scan();
    return this.watch.status();
  }

  /** Nu in de bonnenmap kijken (ook gebruikt door tests). */
  scanFolder(): Promise<void> {
    return this.watch.scan();
  }

  // ---------- van de wachtrij naar de inbox ----------

  /** Zet de ontvangen bonnen één voor één in de inbox. */
  processSpool(): Promise<void> {
    this.draining = this.draining.then(() => this.drain()).catch((e) => this.log(`Bonnen van de telefoon verwerken mislukt: ${(e as Error).message}`));
    return this.draining;
  }

  private async drain(): Promise<void> {
    for (const row of this.spool.waiting()) {
      if (this.stopped) return;
      try {
        const msg = this.spool.read(row.id);
        // de naam van het document maakt de app zelf, niet de telefoon
        const one = msg.fotos.length === 1;
        const data = one ? msg.fotos[0]! : jpegsToPdf(msg.fotos);
        const name = `bon-telefoon-${row.received_at.slice(0, 10)}-${sha256(data).slice(0, 8)}.${one ? 'jpg' : 'pdf'}`;
        const doc = await this.toInbox(() => this.addToInbox(name, data));
        if (this.stopped) return;
        this.applyHints(doc.id, msg);
        this.spool.done(row.id, doc.id);
        this.deps.onChange?.();
      } catch (e) {
        if (this.stopped) return;
        this.log(`Bon van de telefoon in de inbox zetten mislukt: ${(e as Error).message}`);
        this.spool.fail(row.id, (e as Error).message);
      }
    }
  }

  /** Net als bonnen uit de mail: nooit vanzelf boeken, altijd eerst laten controleren. */
  private addToInbox(name: string, data: Uint8Array) {
    return this.deps.intake.add(name, data, today(), { autoConfirm: false });
  }

  /**
   * Eén bestand tegelijk naar de inbox. De inbox kijkt eerst of hij het bestand al heeft en voegt het
   * daarna pas toe; komt dezelfde bon tegelijk via de telefoon en de bonnenmap, dan mag dat niet botsen.
   */
  private toInbox<T>(work: () => Promise<T>): Promise<T> {
    const run = this.inboxQueue.then(work, work);
    this.inboxQueue = run.catch(() => undefined);
    return run;
  }

  /**
   * Wat de telefoon erbij vertelde: de betaalwijze als voorstel voor de bevestiging en de notitie bij
   * het document. Alleen bij een bon die nog niet verwerkt is en nog niets van een telefoon kreeg.
   * De locatie volgt de opt-in van #32: zonder die instelling wordt hij nergens bewaard.
   */
  private applyHints(documentId: number, msg: ReceiptMessage): void {
    const open = `id = ? AND status IN ('nieuw','controle')`;
    this.deps.db.prepare(`UPDATE documents SET note = ?, proposed_paid_with = ? WHERE ${open} AND note IS NULL AND proposed_paid_with IS NULL`).run(msg.notitie, PAID_WITH[msg.betaalwijze], documentId);
    if (msg.locatie && this.deps.settings.get().jobLocation) {
      this.deps.db.prepare(`UPDATE documents SET gps_lat = ?, gps_lon = ? WHERE ${open}`).run(msg.locatie.lat, msg.locatie.lon, documentId);
    }
  }
}

/** Naam van een bestand uit de bonnenmap: zonder map of stuurtekens, niet te lang, extensie behouden. */
function safeFileName(name: string): string {
  const { name: base, ext } = parse(basename(name));
  const clean = base.replace(/[^\p{L}\p{N} ._()-]/gu, '_').replace(/^\.+/, '').slice(0, 80) || 'bon';
  return `${clean}${ext.toLowerCase()}`;
}

function realOr(path: string): Promise<string> {
  return realpath(path).catch(() => path);
}

export function scannerSpoolDir(dataDir: string): string {
  return join(dataDir, 'bonnenscanner');
}
