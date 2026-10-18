import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { basename, join, dirname, relative, isAbsolute, resolve, win32 } from 'node:path';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { cpus } from 'node:os';
import { promisify } from 'node:util';
import { GLM_OCR, LLAMA_CPP, llamaAssetPattern, type ModelFile, type OcrModel, type PinnedRuntime } from './manifest';
import { LlamaCppOcrProvider, OcrTimeoutError, type ImageShrinker } from '../intake/ocr-llamacpp';
import type { OcrOutput, OcrProvider } from '../intake/ocr';

/**
 * Ingebouwde tekstherkenning (#9): download bij eerste gebruik, daarna volledig lokaal.
 *
 * Alleen in het hoofdproces (Node). Downloaden gebeurt pas na een klik van de gebruiker in
 * Instellingen; elk bestand wordt tegen een sha256 gecontroleerd, een afgebroken download gaat
 * verder waar hij was. De server draait op 127.0.0.1 op een vrije poort, wordt pas gestart bij de
 * eerste bon en stopt weer na een tijd zonder gebruik (scheelt werkgeheugen).
 *
 * De server stopt ook als de app afsluit (`stopNow`). Welk proces de app startte staat in
 * `llama-server.pid`, met het begin van dat proces en welk programma het startte. Draait het bij een
 * volgende start nog (de app is bv. hard afgebroken), dan wordt het alsnog gestopt, maar alleen als
 * vaststaat dat het precies dat proces is: de eigen llama-server uit deze map, begonnen op het
 * vastgelegde moment, van dezelfde gebruiker, en gestart door een programma dat er niet meer is
 * (`leftoverVerdict`). Opruimen en starten gebeuren per map na elkaar, nooit door elkaar.
 */

export type RuntimeState = 'niet-geinstalleerd' | 'downloaden' | 'geinstalleerd' | 'starten' | 'actief' | 'fout';

export interface RuntimeStatus {
  state: RuntimeState;
  /**
   * Hoeveel servers van een vorige keer bij de laatste opruimpoging zijn blijven staan omdat niet
   * vaststond dat het programma dat ze startte weg is (zie leftoverVerdict, 'overgeslagen').
   */
  skippedLeftovers: number;
  /** voortgang van het downloaden, in bytes */
  progress: { done: number; total: number; file: string } | null;
  error: string | null;
  llamaVersion: string | null;
  model: string;
}

interface Installed {
  version: 1;
  llamaTag: string;
  serverPath: string;
  model: string;
  files: string[];
}

/** Minimale fetch voor downloads (globale fetch voldoet). */
export type DownloadFetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  body: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> | null;
  json(): Promise<unknown>;
}>;

interface LlamaRelease {
  tag_name: string;
  assets: { name: string; size: number; browser_download_url: string; digest?: string | null }[];
}

export interface RuntimeDeps {
  fetch: DownloadFetch;
  /** pakt een zip/tar.gz uit */
  extract?: (archive: string, dest: string) => Promise<void>;
  spawn?: (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcess;
  platform?: string;
  arch?: string;
  model?: OcrModel;
  /** hoe lang zonder bonnen voordat de server stopt */
  idleMs?: number;
  /**
   * De versie uit de Microsoft Store: alleen deze vaste build van de runtime, en pas na toestemming
   * van de gebruiker (`giveConsent`). Zonder dit veld: de nieuwste release, zoals altijd.
   */
  pinned?: PinnedRuntime;
  /** zin achter een foutmelding (in de Store-versie: het kan wel met de gewone Windows-versie) */
  failureHint?: string;
  /** wat er over een proces vast te stellen is (programma, begin, eigenaar); standaard `processInfo`; alleen tests vervangen dit */
  processInfo?: (pid: number) => Promise<ProcessLookup>;
  /** een proces stoppen op proces-ID (standaard process.kill); alleen tests vervangen dit */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** voert de opdracht uit waarmee Windows een achterblijver stopt (zie leftoverKillCommand); alleen tests vervangen dit */
  execKill?: (cmd: string, args: string[]) => Promise<unknown>;
  /** tijdslimiet van één leesverzoek; standaard OCR_REQUEST_TIMEOUT_MS */
  requestTimeoutMs?: number;
  /** verkleint een foto voor de herkenning (hoofdproces: Electron); zonder gaat de foto zoals hij is */
  shrinkImage?: ImageShrinker;
  /** hoe lang een gestopte server de tijd krijgt om zelf te eindigen; standaard STOP_GRACE_MS */
  stopGraceMs?: number;
}

/**
 * Wanneer een proces begon. Samen met het proces-ID wijst dat één proces aan: een proces-ID wordt
 * opnieuw uitgegeven, het begin niet.
 * - Linux: `at` is de tijd sinds het opstarten van de computer (uit /proc/<pid>/stat), `boot` zegt welke
 *   keer opstarten dat was. Dat hangt niet van de klok af: die kan na het opstarten nog verzet worden.
 * - macOS en Windows: `at` is het tijdstip (ms sinds 1970) dat het systeem bij het proces bewaart.
 */
export interface ProcessStart {
  at: number;
  boot?: string;
}

/** Wat er over een draaiend proces vast te stellen is. */
export interface ProcessInfo {
  /** het volledige pad van het programma */
  path: string;
  started: ProcessStart;
  /** van dezelfde gebruiker als de app */
  sameUser: boolean;
}

/** 'weg': het proces bestaat niet (meer). null: het bestaat misschien, maar het is niet vast te stellen. */
export type ProcessLookup = ProcessInfo | 'weg' | null;

/** Eén regel in `llama-server.pid`: een server die de app startte, en welk programma (welke app) dat deed. */
export interface PidRecord {
  pid: number;
  serverPath: string;
  started: ProcessStart;
  app: { pid: number; started: ProcessStart };
}

/** Hoe lang een gestopte server de tijd krijgt om zelf te eindigen voordat hij hard wordt beëindigd. */
const STOP_GRACE_MS = 2000;

/**
 * Hetzelfde begin: precies gelijk, zonder marge. Vastleggen en nakijken vragen het begin op dezelfde
 * manier op, met dezelfde precisie; elk verschil betekent dus een ander proces.
 *
 * Wat hiermee niet te onderscheiden is: op macOS geeft `ps` het begin in hele seconden. Twee processen
 * die in dezelfde seconde na elkaar hetzelfde proces-ID krijgen, zien er daar gelijk uit. Linux
 * (honderdsten van een seconde) en Windows (milliseconden) hebben hetzelfde, in een kleiner venster.
 */
const sameStart = (a: ProcessStart, b: ProcessStart): boolean => (a.boot ?? null) === (b.boot ?? null) && a.at === b.at;

const validStart = (s: unknown): s is ProcessStart => {
  const v = s as ProcessStart | null;
  return !!v && typeof v === 'object' && Number.isFinite(v.at) && (v.boot === undefined || typeof v.boot === 'string');
};

/** De uitvoer van `ps -p <pid> -o uid= -o lstart= -o comm=` (met LC_ALL=C en TZ=UTC), bv. "  501 Tue Oct 13 22:04:04 2026 /pad/naar/llama-server". */
export function parsePsInfo(stdout: string, uid: number | undefined): ProcessInfo | null {
  const m = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S.*)$/.exec(stdout.trim());
  if (!m || uid === undefined) return null;
  const at = Date.parse(`${m[2]} UTC`);
  return Number.isFinite(at) ? { path: m[3]!, started: { at }, sameUser: Number(m[1]) === uid } : null;
}

/** De uitvoer van het PowerShell-verzoek in `processInfo`: "<begin als FILETIME>|<True of False: eigen proces>|<pad>". */
export function parseWindowsInfo(stdout: string): ProcessInfo | null {
  const m = /^(\d+)\|(True|False)\|(.+)$/.exec(stdout.trim());
  if (!m) return null;
  // FILETIME telt per 100 ns vanaf 1601
  const at = Number(BigInt(m[1]!) / 10_000n) - 11_644_473_600_000;
  return { path: m[3]!, started: { at }, sameUser: m[2] === 'True' };
}

/**
 * Programma, begin en eigenaar van een proces.
 * - Linux: /proc/<pid>/exe (programma), veld 22 van /proc/<pid>/stat (begin) en de eigenaar van /proc/<pid>.
 * - macOS: `ps` (uid, lstart, comm).
 * - Windows: PowerShell, Win32_Process (ExecutablePath, CreationDate, GetOwnerSid).
 * Lukt iets niet (geen rechten, hulpprogramma ontbreekt, onverwachte uitvoer), dan null: er wordt dan niets gestopt.
 */
export async function processInfo(pid: number): Promise<ProcessLookup> {
  try {
    process.kill(pid, 0);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'weg';
    // EPERM: het proces is er, maar van iemand anders; hieronder blijkt of er iets over vast te stellen is
    if (code !== 'EPERM') return null;
  }
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // de naam (veld 2) staat tussen haakjes en kan zelf spaties en haakjes bevatten; daarna begint veld 3
      const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
      const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      const uid = process.getuid?.();
      if (!Number.isFinite(ticks) || !boot || uid === undefined) return null;
      const path = readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, '');
      // het begin telt in honderdsten van een seconde sinds het opstarten
      return { path, started: { at: ticks * 10, boot }, sameUser: statSync(`/proc/${pid}`).uid === uid };
    }
    if (process.platform === 'win32') {
      const script = [
        `$ErrorActionPreference = 'Stop'`,
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"`,
        `$sid = (Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid).Sid`,
        `$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value`,
        `[Console]::Out.Write("$($p.CreationDate.ToFileTimeUtc())|$($sid -eq $me)|$($p.ExecutablePath)")`,
      ].join('; ');
      const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 15_000, windowsHide: true });
      return parseWindowsInfo(stdout);
    }
    // vaste taal en tijdzone: de datum is dan altijd op dezelfde manier te lezen, ook na het wijzigen van de tijdzone
    const { stdout } = await run('ps', ['-p', String(pid), '-o', 'uid=', '-o', 'lstart=', '-o', 'comm='], { timeout: 10_000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } });
    return parsePsInfo(stdout, process.getuid?.());
  } catch {
    return null;
  }
}

function realOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Is dit het programma dat de app startte: llama-server, in de eigen map, en hetzelfde bestand als toen? */
function isOwnServer(dir: string, actual: string, recorded: string, platform: string): boolean {
  const norm = (p: string) => (platform === 'win32' ? realOr(p).toLowerCase() : realOr(p));
  const a = norm(actual);
  if (a !== norm(recorded)) return false;
  if (!['llama-server', 'llama-server.exe'].includes(basename(a))) return false;
  const rel = relative(norm(dir), a);
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Wat er met een regel uit het pid-bestand gebeurt. Het proces wordt alleen gestopt ('stoppen') als
 * álles klopt: het is de llama-server uit de eigen map, het begon op het moment dat is vastgelegd, het
 * is van dezelfde gebruiker, en er bestaat geen proces meer met het proces-ID van het programma dat het
 * startte. Bestaat dat nog (een
 * tweede programma op dezelfde gegevensmap, of een andere runtime in dit programma), dan is het zijn
 * server. 'vergeten': het proces van toen is er niet meer, de regel kan weg. 'laten': niet vast te
 * stellen of de server van een programma dat nog draait; er gebeurt niets en de regel blijft staan.
 *
 * 'overgeslagen': net als 'laten' gebeurt er niets, maar hier is het proces wél de eigen server van
 * toen en staat niet vast dat zijn starter nog draait: er bestaat een proces met het proces-ID van de
 * starter, maar met een ander begin (dat proces-ID is dus opnieuw uitgegeven aan een ander programma),
 * of er is niets over vast te stellen. Dan blijft er waarschijnlijk een achterblijver staan; de
 * runtime telt die (`skippedLeftovers`) zodat het te zien is.
 */
export function leftoverVerdict(input: { record: PidRecord; server: ProcessLookup; starter: ProcessLookup; dir: string; platform: string }): 'stoppen' | 'vergeten' | 'laten' | 'overgeslagen' {
  const { record, server, starter } = input;
  if (server === 'weg') return 'vergeten';
  if (!server) return 'laten';
  // een ander programma, of een latere uitvoering van hetzelfde programma, kreeg dit proces-ID
  if (!isOwnServer(input.dir, server.path, record.serverPath, input.platform)) return 'vergeten';
  if (!sameStart(server.started, record.started)) return 'vergeten';
  if (!server.sameUser) return 'laten';
  if (starter === 'weg') return 'stoppen';
  // Er bestaat een proces met het proces-ID van de starter (of het is niet vast te stellen): niets doen. Ook bij
  // een ander begin: dat wijst op een ander programma, maar het is veiliger een achterblijver te laten staan
  // tot de volgende start dan de server van een programma dat nog draait te stoppen op een meetverschil.
  return starter && sameStart(starter.started, record.app.started) ? 'laten' : 'overgeslagen';
}

/**
 * Hoe een achterblijver gestopt wordt, nadat `leftoverVerdict` 'stoppen' gaf.
 *
 * Windows: `taskkill /PID <pid> /F /FI "IMAGENAME eq llama-server.exe"`. Die opdracht kijkt zelf, op
 * het moment van beëindigen, of het proces met dat proces-ID llama-server.exe heet; is het proces-ID
 * intussen van een ander programma, dan doet hij niets. Het venster is daar dus niet de duur van een
 * PowerShell-opvraag. Wat taskkill niet onderscheidt: een ándere llama-server.exe die precies in die
 * tijd hetzelfde proces-ID kreeg. Heet het vastgelegde programma anders, dan is er geen opdracht (null)
 * en wordt er niets gestopt.
 *
 * Linux en macOS ('signaal'): een signaal aan het proces-ID, direct na de laatste controle.
 */
export function leftoverKillCommand(platform: string, record: Pick<PidRecord, 'pid' | 'serverPath'>): { cmd: string; args: string[] } | 'signaal' | null {
  if (platform !== 'win32') return 'signaal';
  if (!Number.isInteger(record.pid) || record.pid <= 0) return null;
  const image = win32.basename(record.serverPath).toLowerCase();
  if (image !== 'llama-server.exe') return null;
  return { cmd: 'taskkill', args: ['/PID', String(record.pid), '/F', '/FI', `IMAGENAME eq ${image}`] };
}

/**
 * Per map één tegelijk: opruimen van een achterblijver en starten van een server kruisen elkaar niet,
 * ook niet tussen twee runtimes in hetzelfde programma.
 */
const turns = new Map<string, Promise<unknown>>();

function inTurn<T>(key: string, work: () => Promise<T>): Promise<T> {
  const run = (turns.get(key) ?? Promise.resolve()).then(work, work);
  const tail: Promise<unknown> = run.then(
    () => void (turns.get(key) === tail && turns.delete(key)),
    () => void (turns.get(key) === tail && turns.delete(key)),
  );
  turns.set(key, tail);
  return run;
}

/** De start is afgebroken omdat de runtime intussen gestopt is (afsluiten, administratie wisselen, verwijderen). */
export class OcrStoppedError extends Error {
  constructor() {
    super('De tekstherkenning is gestopt.');
    this.name = 'OcrStoppedError';
  }
}

/** Vastgelegde toestemming (alleen in de Store-versie): voor welke build, en wanneer. */
interface Consent {
  version: 1;
  llamaTag: string;
  serverSha256: string;
  at: string;
}

/** De vaste build in de vorm van een release van GitHub, zodat hij dezelfde weg volgt als een opgezochte. */
function pinnedRelease(pinned: PinnedRuntime): { release: LlamaRelease; asset: LlamaRelease['assets'][number] } {
  const asset = { name: pinned.archive.name, size: pinned.archive.size, browser_download_url: pinned.archive.url, digest: `sha256:${pinned.archive.sha256}` };
  return { release: { tag_name: pinned.tag, assets: [asset] }, asset };
}

const NO_CONSENT = 'Geef eerst toestemming om het programma voor het lezen van bonnen te downloaden en te starten.';

const run = promisify(execFile);

async function defaultExtract(archive: string, dest: string): Promise<void> {
  mkdirSync(dest, { recursive: true });
  if (/\.tar\.gz$/.test(archive)) return void (await run('tar', ['-xzf', archive, '-C', dest]));
  // Windows 10+ en macOS: bsdtar kan zip; Linux: unzip
  if (process.platform === 'linux') return void (await run('unzip', ['-o', '-q', archive, '-d', dest]));
  await run('tar', ['-xf', archive, '-C', dest]);
}

function findFile(dir: string, names: string[]): string | null {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isFile() && names.includes(entry.name)) return p;
    if (entry.isDirectory()) {
      const found = findFile(p, names);
      if (found) return found;
    }
  }
  return null;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export class LocalOcrRuntime {
  private status_: Omit<RuntimeStatus, 'skippedLeftovers'>;
  /** achterblijvers die bij de laatste opruimpoging zijn blijven staan omdat niet vaststond dat het programma dat ze startte weg is */
  private skipped = 0;
  private process: ChildProcess | null = null;
  private url: string | null = null;
  private starting: Promise<string> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  /** gestopte servers die nog niet weg zijn (ze krijgen even de tijd); bij afsluiten gaan ze meteen */
  private readonly stopping = new Set<ChildProcess>();
  /** gaat omhoog bij elke stop; een start die daarvóór begon, geldt dan niet meer (zie start) */
  private generation = 0;
  /** het begin van het eigen programma, voor in het pid-bestand; één keer opgevraagd */
  private self: Promise<ProcessLookup> | null = null;
  private readonly model: OcrModel;

  constructor(
    private readonly dir: string,
    private readonly deps: RuntimeDeps,
  ) {
    this.model = deps.model ?? GLM_OCR;
    const installed = this.installed();
    this.status_ = { state: installed ? 'geinstalleerd' : 'niet-geinstalleerd', progress: null, error: null, llamaVersion: installed?.llamaTag ?? null, model: this.model.label };
  }

  private installed(): Installed | null {
    const p = join(this.dir, 'installed.json');
    if (!existsSync(p)) return null;
    try {
      const i = JSON.parse(readFileSync(p, 'utf8')) as Installed;
      if (i.model !== this.model.id || !existsSync(i.serverPath) || !i.files.every((f) => existsSync(join(this.dir, 'models', f)))) return null;
      // Store-versie: een runtime van een andere build (bv. eerder gedownload door de gewone versie) telt niet
      if (this.deps.pinned && (i.llamaTag !== this.deps.pinned.tag || !this.hasConsent())) return null;
      return i;
    } catch {
      return null;
    }
  }

  isInstalled(): boolean {
    return this.installed() !== null;
  }

  private consentFile(): string {
    return join(this.dir, 'toestemming.json');
  }

  /** Is er toestemming voor precies deze vaste build? Zonder vaste build (de gewone versie) is die niet nodig. */
  hasConsent(): boolean {
    const pinned = this.deps.pinned;
    if (!pinned) return true;
    try {
      const c = JSON.parse(readFileSync(this.consentFile(), 'utf8')) as Consent;
      return c.llamaTag === pinned.tag && c.serverSha256 === pinned.serverSha256;
    } catch {
      return false;
    }
  }

  /** De gebruiker zei ja tegen downloaden en starten van deze build. Verwijderen (`uninstall`) trekt het weer in. */
  giveConsent(now: Date = new Date()): void {
    const pinned = this.deps.pinned;
    if (!pinned) return;
    mkdirSync(this.dir, { recursive: true });
    const consent: Consent = { version: 1, llamaTag: pinned.tag, serverSha256: pinned.serverSha256, at: now.toISOString() };
    writeFileSync(this.consentFile(), JSON.stringify(consent, null, 2));
    if (this.status_.state === 'niet-geinstalleerd' && this.installed()) this.status_ = { ...this.status_, state: 'geinstalleerd', llamaVersion: pinned.tag };
  }

  private withHint(message: string): string {
    return this.deps.failureHint ? `${message} ${this.deps.failureHint}` : message;
  }

  status(): RuntimeStatus {
    return { ...this.status_, progress: this.status_.progress ? { ...this.status_.progress } : null, skippedLeftovers: this.skipped };
  }

  /** Start het downloaden op de achtergrond; de voortgang is te volgen via status(). */
  startInstall(): RuntimeStatus {
    if (this.status_.state === 'downloaden') return this.status();
    this.install().catch(() => undefined);
    return this.status();
  }

  async install(): Promise<void> {
    const platform = this.deps.platform ?? process.platform;
    const arch = this.deps.arch ?? process.arch;
    const pattern = llamaAssetPattern(platform, arch);
    const pinned = this.deps.pinned;
    // zonder toestemming gebeurt er niets, ook geen voorbereiding
    if (pinned && !this.hasConsent()) throw new Error(NO_CONSENT);
    this.status_ = { ...this.status_, state: 'downloaden', error: null, progress: { done: 0, total: 0, file: 'voorbereiden' } };
    try {
      if (!pattern) throw new Error(`De ingebouwde herkenning is (nog) niet beschikbaar voor ${platform}/${arch}.`);
      if (pinned && !pattern.test(pinned.archive.name)) throw new Error(`De ingebouwde herkenning is in deze versie (nog) niet beschikbaar voor ${platform}/${arch}.`);
      mkdirSync(join(this.dir, 'models'), { recursive: true });
      // 1. welke llama.cpp-build (Store-versie: altijd de vaste build, er wordt niets opgezocht)
      const { release, asset } = pinned ? pinnedRelease(pinned) : await this.findRelease(pattern);
      const sha = asset.digest?.startsWith('sha256:') ? asset.digest.slice(7) : null;
      if (!sha) throw new Error('De runtime heeft geen controlegetal; downloaden afgebroken.');
      const downloads: (ModelFile & { target: string })[] = [
        { name: asset.name, url: asset.browser_download_url, size: asset.size, sha256: sha, target: join(this.dir, 'downloads', asset.name) },
        ...this.model.files.map((f) => ({ ...f, target: join(this.dir, 'models', f.name) })),
      ];
      const total = downloads.reduce((s, d) => s + d.size, 0);
      let done = 0;
      for (const d of downloads) {
        await this.download(d, (n) => {
          done += n;
          this.status_.progress = { done, total, file: d.name };
        });
      }
      // 2. uitpakken en de server zoeken
      const dest = join(this.dir, 'llama', release.tag_name);
      rmSync(dest, { recursive: true, force: true });
      await (this.deps.extract ?? defaultExtract)(downloads[0]!.target, dest);
      const serverPath = findFile(dest, ['llama-server', 'llama-server.exe']);
      if (!serverPath) throw new Error('llama-server niet gevonden in de download.');
      if (pinned && (await sha256File(serverPath)) !== pinned.serverSha256) {
        rmSync(dest, { recursive: true, force: true });
        throw new Error('llama-server is niet het programma dat bij deze versie hoort (controlegetal klopt niet); het wordt niet gebruikt.');
      }
      if (platform !== 'win32') chmodSync(serverPath, 0o755);
      rmSync(join(this.dir, 'downloads'), { recursive: true, force: true });
      const installed: Installed = { version: 1, llamaTag: release.tag_name, serverPath, model: this.model.id, files: this.model.files.map((f) => f.name) };
      writeFileSync(join(this.dir, 'installed.json'), JSON.stringify(installed, null, 2));
      this.status_ = { state: 'geinstalleerd', progress: null, error: null, llamaVersion: release.tag_name, model: this.model.label };
    } catch (e) {
      const message = this.withHint((e as Error).message);
      this.status_ = { ...this.status_, state: 'fout', progress: null, error: message };
      throw this.deps.failureHint ? new Error(message) : e;
    }
  }

  /** Download met hervatten (Range) en sha256-controle. */
  /**
   * De llama.cpp-build om te downloaden. De laatste release bevat de bestanden zelf, of (sinds
   * llama.cpp versienummers gebruikt) alleen `nightly-tag.txt` met de naam van de build die erbij hoort;
   * die build halen we dan op.
   */
  private async findRelease(pattern: RegExp): Promise<{ release: LlamaRelease; asset: LlamaRelease['assets'][number] }> {
    const get = async (url: string): Promise<LlamaRelease> => {
      const res = await this.deps.fetch(url, { headers: { Accept: 'application/vnd.github+json' } });
      if (!res.ok) throw new Error(`Kon de runtime niet vinden (HTTP ${res.status})`);
      return (await res.json()) as LlamaRelease;
    };
    let release = await get(LLAMA_CPP.releaseApi);
    let asset = release.assets.find((a) => pattern.test(a.name));
    const pointer = asset ? undefined : release.assets.find((a) => a.name === 'nightly-tag.txt');
    if (pointer) {
      const res = await this.deps.fetch(pointer.browser_download_url);
      if (!res.ok || !res.body) throw new Error(`Kon de runtime niet vinden (HTTP ${res.status})`);
      const chunks: Uint8Array[] = [];
      for await (const chunk of res.body as AsyncIterable<Uint8Array>) chunks.push(chunk);
      const tag = Buffer.concat(chunks).toString('utf8').trim();
      // de naam komt in een adres: alleen een gewone buildnaam (bv. b11146)
      if (!/^[A-Za-z0-9._-]{1,40}$/.test(tag)) throw new Error('Geen passende runtime gevonden voor dit systeem.');
      release = await get(`${LLAMA_CPP.releaseByTagApi}${tag}`);
      asset = release.assets.find((a) => pattern.test(a.name));
    }
    if (!asset) throw new Error('Geen passende runtime gevonden voor dit systeem.');
    return { release, asset };
  }

  private async download(f: ModelFile & { target: string }, onBytes: (n: number) => void): Promise<void> {
    if (existsSync(f.target) && statSync(f.target).size === f.size) {
      // al aanwezig: alleen gebruiken als het controlegetal klopt, anders opnieuw downloaden
      if ((await sha256File(f.target)) === f.sha256) {
        onBytes(f.size);
        return;
      }
      rmSync(f.target, { force: true });
    }
    mkdirSync(dirname(f.target), { recursive: true });
    const part = `${f.target}.part`;
    let start = existsSync(part) ? statSync(part).size : 0;
    if (start > f.size) {
      rmSync(part);
      start = 0;
    }
    if (start < f.size) {
      const res = await this.deps.fetch(f.url, start ? { headers: { Range: `bytes=${start}-` } } : undefined);
      if (!res.ok) throw new Error(`Downloaden van ${f.name} mislukt (HTTP ${res.status})`);
      if (start && res.status !== 206) start = 0; // server hervat niet: opnieuw beginnen
      onBytes(start);
      const out = createWriteStream(part, { flags: start ? 'a' : 'w' });
      try {
        if (!res.body) throw new Error(`Lege download: ${f.name}`);
        for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
          if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
          onBytes(chunk.byteLength);
        }
      } finally {
        await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
      }
    } else {
      onBytes(f.size);
    }
    const actual = await sha256File(part);
    if (actual !== f.sha256) {
      rmSync(part, { force: true });
      throw new Error(`${f.name} is beschadigd of gewijzigd (controlegetal klopt niet). Probeer het opnieuw.`);
    }
    renameSync(part, f.target);
  }

  /** Start de server (als dat nog niet gebeurd is) en geeft het lokale adres. */
  async ensureStarted(): Promise<string> {
    if (this.url && this.process && this.process.exitCode === null) return this.url;
    if (this.starting) return this.starting;
    const starting: Promise<string> = this.start().finally(() => {
      if (this.starting === starting) this.starting = null;
    });
    this.starting = starting;
    return starting;
  }

  /**
   * Starten wacht op meerdere dingen (controlegetal, opruimen, een vrije poort, de beurt van een andere
   * runtime op dezelfde map). Wordt de runtime in die tijd gestopt (`stop`, `stopNow`, verwijderen), dan
   * geldt deze start niet meer: na ieder wachtpunt en vlak vóór het starten van het programma wordt dat
   * nagekeken, zodat er na het stoppen geen server meer bij komt.
   */
  private async start(): Promise<string> {
    const generation = this.generation;
    const stopped = () => generation !== this.generation;
    const inst = this.installed();
    if (!inst) throw new Error('De ingebouwde herkenning is nog niet geïnstalleerd (Instellingen → Slimme herkenning).');
    // Store-versie: alleen precies het programma waarvoor toestemming is gegeven wordt gestart
    if (this.deps.pinned && (await sha256File(inst.serverPath)) !== this.deps.pinned.serverSha256) {
      if (stopped()) throw new OcrStoppedError();
      this.status_ = { ...this.status_, state: 'fout', error: this.withHint('llama-server is gewijzigd sinds het downloaden (controlegetal klopt niet) en wordt niet gestart. Verwijder de herkenning en installeer hem opnieuw.') };
      throw new Error(this.status_.error!);
    }
    let stderr = '';
    // opruimen, starten en vastleggen in één beurt: een andere start of opruimactie op deze map komt er niet tussen
    const { child, url } = await inTurn(this.turnKey(), async () => {
      if (stopped()) throw new OcrStoppedError();
      // een server van een vorige keer (de app is toen niet netjes afgesloten) mag niet naast de nieuwe blijven rekenen
      await this.cleanLeftovers();
      if (stopped()) throw new OcrStoppedError();
      this.status_.state = 'starten';
      const port = await freePort();
      if (stopped()) throw new OcrStoppedError();
      const [model, mmproj] = inst.files.map((f) => join(this.dir, 'models', f));
      const threads = Math.max(1, Math.min(8, cpus().length - 1));
      const binDir = dirname(inst.serverPath);
      const args = ['-m', model!, '--mmproj', mmproj!, '--host', '127.0.0.1', '--port', String(port), '-c', '8192', '-t', String(threads), '--temp', '0'];
      const env = { ...process.env, LD_LIBRARY_PATH: [binDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') };
      // tussen de controle hierboven en het starten zit geen wachtpunt
      const child = (this.deps.spawn ?? ((c, a, o) => spawn(c, a, { ...o, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })))(inst.serverPath, args, { cwd: binDir, env });
      child.stderr?.on('data', (d: Buffer) => {
        stderr = (stderr + d.toString()).slice(-2000);
      });
      this.process = child;
      // het proces is weg (ook na stop of een crash): dan hoort zijn regel niet meer in het pid-bestand
      child.once?.('exit', () => this.forgetPid(child.pid));
      await this.recordPid(child, inst.serverPath);
      return { child, url: `http://127.0.0.1:${port}` };
    });
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      // intussen gestopt: de server is dan al beëindigd (zie stop), deze start geeft geen adres meer
      if (stopped()) throw new OcrStoppedError();
      if (child.exitCode !== null) {
        this.status_ = { ...this.status_, state: 'fout', error: this.withHint(`De herkenning stopte onverwacht. ${stderr.split('\n').filter(Boolean).slice(-2).join(' ')}`) };
        throw new Error(this.status_.error!);
      }
      try {
        const r = await this.deps.fetch(`${url}/health`);
        if (stopped()) throw new OcrStoppedError();
        if (r.ok) {
          this.url = url;
          this.status_ = { ...this.status_, state: 'actief', error: null };
          return url;
        }
      } catch (e) {
        if (e instanceof OcrStoppedError) throw e;
        // nog aan het laden
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (stopped()) throw new OcrStoppedError();
    this.stop();
    throw new Error(this.withHint('De herkenning start niet (time-out).'));
  }

  private turnKey(): string {
    return resolve(this.dir);
  }

  private pidFile(): string {
    return join(this.dir, 'llama-server.pid');
  }

  private info(pid: number): Promise<ProcessLookup> {
    return (this.deps.processInfo ?? processInfo)(pid).catch(() => null);
  }

  /**
   * De servers die in het pid-bestand staan. Een bestand dat niet te lezen is, of in de vorm van een
   * eerdere versie (zonder het begin van het proces), telt als leeg: daarmee is niets te bewijzen.
   */
  private readPids(): PidRecord[] {
    try {
      const file = JSON.parse(readFileSync(this.pidFile(), 'utf8')) as { version?: number; servers?: unknown };
      if (file.version !== 2 || !Array.isArray(file.servers)) return [];
      return (file.servers as PidRecord[]).filter(
        (r) => !!r && Number.isInteger(r.pid) && r.pid > 0 && typeof r.serverPath === 'string' && validStart(r.started) && !!r.app && Number.isInteger(r.app.pid) && r.app.pid > 0 && validStart(r.app.started),
      );
    } catch {
      return [];
    }
  }

  private writePids(servers: PidRecord[]): void {
    try {
      if (!servers.length) return rmSync(this.pidFile(), { force: true });
      // eerst naast het bestand schrijven, dan in één keer vervangen: een lezer ziet nooit een half bestand
      const tmp = `${this.pidFile()}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 2, servers }));
      renameSync(tmp, this.pidFile());
    } catch {
      /* zonder pid-bestand werkt alles, alleen het opruimen na een harde afbreking niet */
    }
  }

  /**
   * Legt vast welk proces er gestart is, wanneer het begon en welk programma het startte. Is het begin
   * van een van beide niet vast te stellen, dan wordt er niets vastgelegd: zo'n server wordt later ook
   * nooit als achterblijver gestopt.
   */
  private async recordPid(child: ChildProcess, serverPath: string): Promise<void> {
    const pid = child.pid;
    if (typeof pid !== 'number') return;
    this.self ??= this.info(process.pid);
    const [server, app] = await Promise.all([this.info(pid), this.self]);
    // intussen al weg (bv. gestopt tijdens het starten): er valt niets meer vast te leggen
    if (child.exitCode !== null || child.signalCode != null) return;
    if (!server || server === 'weg' || !app || app === 'weg') return;
    this.writePids([...this.readPids().filter((r) => r.pid !== pid), { pid, serverPath, started: server.started, app: { pid: process.pid, started: app.started } }]);
  }

  /** Haalt de regel van dit proces uit het pid-bestand; met `started` alleen als die over hetzelfde proces gaat. */
  private forgetPid(pid: number | undefined, started?: ProcessStart): void {
    if (pid === undefined) return;
    const all = this.readPids();
    const rest = all.filter((r) => !(r.pid === pid && (!started || sameStart(r.started, started))));
    if (rest.length !== all.length) this.writePids(rest);
  }

  /**
   * Stopt een llama-server die een vorige keer door de app is gestart en nog draait (de app is toen
   * bv. hard afgebroken). Alleen als alles klopt, zie `leftoverVerdict`; anders gebeurt er niets.
   * Wacht op zijn beurt: tegelijk met een start op dezelfde map gebeurt dit niet. Geeft terug of er iets gestopt is.
   */
  stopLeftover(): Promise<boolean> {
    return inTurn(this.turnKey(), () => this.cleanLeftovers());
  }

  private async cleanLeftovers(): Promise<boolean> {
    const kill = this.deps.kill ?? ((pid: number, signal: NodeJS.Signals) => void process.kill(pid, signal));
    const platform = this.deps.platform ?? process.platform;
    let stopped = false;
    let skipped = 0;
    for (const record of this.readPids()) {
      const server = await this.info(record.pid);
      // alleen als het proces zelf klopt, hoeft bekend te zijn of het programma dat het startte nog draait
      const starter = server && server !== 'weg' ? await this.info(record.app.pid) : null;
      let verdict = leftoverVerdict({ record, server, starter, dir: this.dir, platform });
      if (verdict === 'stoppen') {
        // Het opzoeken van de starter kostte tijd; in die tijd kan de server geëindigd zijn en een ander
        // proces zijn proces-ID hebben gekregen. Daarom als laatste stap opnieuw naar de server kijken:
        // alleen als het nog precies hetzelfde proces is, wordt het gestopt, direct daarna.
        //
        // Wat overblijft: stoppen gaat op proces-ID. Nodejs biedt geen vaste verwijzing naar een proces,
        // dus uit te sluiten is het niet dat het proces-ID tussen deze laatste controle en het stoppen
        // opnieuw wordt uitgegeven.
        // - Linux: het antwoord komt uit /proc (geen hulpprogramma) en het signaal volgt zonder
        //   wachtpunt; het venster is de tijd tussen die twee stappen in dit programma.
        // - macOS: het antwoord komt van `ps`; het venster is de looptijd van `ps` nadat het het proces
        //   bekeek (tienden van een seconde), en het signaal volgt daarna zonder wachtpunt.
        // - Windows: het stoppen zelf filtert op de naam van het programma (zie leftoverKillCommand), dus
        //   de duur van de PowerShell-opvraag telt niet mee; een andere llama-server.exe die precies dan
        //   hetzelfde proces-ID kreeg, wordt niet onderscheiden.
        verdict = leftoverVerdict({ record, server: await this.info(record.pid), starter, dir: this.dir, platform });
        if (verdict === 'stoppen') {
          const how = leftoverKillCommand(platform, record);
          if (how === 'signaal') {
            try {
              kill(record.pid, 'SIGKILL');
              stopped = true;
            } catch {
              /* net zelf gestopt */
            }
          } else {
            // de opdracht zegt niet betrouwbaar of hij iets stopte (hij filtert zelf): daarna kijken of het proces weg is
            if (how) await (this.deps.execKill ?? ((cmd, args) => run(cmd, args, { timeout: 15_000, windowsHide: true })))(how.cmd, how.args).catch(() => undefined);
            if (!how || (await this.info(record.pid)) !== 'weg') continue;
            stopped = true;
          }
        }
      }
      if (verdict === 'overgeslagen') skipped++;
      if (verdict === 'laten' || verdict === 'overgeslagen') continue;
      this.forgetPid(record.pid, record.started);
    }
    this.skipped = skipped;
    return stopped;
  }

  /**
   * Stopt de server. Hij krijgt eerst de kans om zelf te eindigen; rekent hij nog aan een bon, dan kan
   * dat lang duren, dus na korte tijd wordt hij hard beëindigd.
   */
  stop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    // een start die nog loopt, start hierna geen server meer; een volgende aanvraag begint opnieuw
    this.generation++;
    this.starting = null;
    const child = this.process;
    if (child && child.exitCode === null) {
      child.kill();
      if (child.exitCode === null) {
        this.stopping.add(child);
        const timer = setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL');
        }, this.deps.stopGraceMs ?? STOP_GRACE_MS);
        timer.unref?.();
        child.once?.('exit', () => {
          clearTimeout(timer);
          this.stopping.delete(child);
        });
      }
    }
    this.process = null;
    this.url = null;
    if (this.status_.state === 'actief' || this.status_.state === 'starten') this.status_.state = 'geinstalleerd';
  }

  /**
   * De app sluit af: de server meteen hard beëindigen, zonder te wachten. Er is geen tijd meer om te
   * kijken of hij zelf stopt, en hij heeft niets te bewaren.
   */
  stopNow(): void {
    this.stop();
    for (const child of this.stopping) {
      if (child.exitCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* al weg */
        }
      }
      this.forgetPid(child.pid);
    }
    this.stopping.clear();
  }

  /** Stopt de server en wacht tot het proces echt weg is (Windows houdt bestanden anders vast). */
  private async stopAndWait(): Promise<void> {
    const child = this.process;
    this.stop();
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 5000);
      child.once('exit', done);
      if (child.exitCode !== null) done();
    });
  }

  async uninstall(): Promise<RuntimeStatus> {
    await this.stopAndWait();
    rmSync(this.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    this.status_ = { state: 'niet-geinstalleerd', progress: null, error: null, llamaVersion: null, model: this.model.label };
    return this.status();
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), this.deps.idleMs ?? 10 * 60_000);
    this.idleTimer.unref?.();
  }

  /** OCR-provider voor de intake: start de server pas bij de eerste bon. */
  provider(fetchImpl: ConstructorParameters<typeof LlamaCppOcrProvider>[2]): OcrProvider {
    const self = this;
    return {
      id: this.model.id,
      label: `Ingebouwde herkenning (${this.model.label})`,
      async available() {
        return self.isInstalled();
      },
      async recognize(input): Promise<OcrOutput> {
        const url = await self.ensureStarted();
        self.touch();
        try {
          return await new LlamaCppOcrProvider(self.model.id, url, fetchImpl, self.model.prompt, undefined, self.deps.requestTimeoutMs, self.deps.shrinkImage).recognize(input);
        } catch (e) {
          // te lang bezig: de server stoppen, zodat hij niet doorrekent aan een bon waar niemand meer op wacht
          if (e instanceof OcrTimeoutError) self.stop();
          throw e;
        } finally {
          self.touch();
        }
      },
    };
  }
}
