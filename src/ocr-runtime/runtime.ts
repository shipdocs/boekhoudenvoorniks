import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { cpus } from 'node:os';
import { promisify } from 'node:util';
import { GLM_OCR, LLAMA_CPP, llamaAssetPattern, type ModelFile, type OcrModel, type PinnedRuntime } from './manifest';
import { LlamaCppOcrProvider } from '../intake/ocr-llamacpp';
import type { OcrOutput, OcrProvider } from '../intake/ocr';

/**
 * Ingebouwde tekstherkenning (#9): download bij eerste gebruik, daarna volledig lokaal.
 *
 * Alleen in het hoofdproces (Node). Downloaden gebeurt pas na een klik van de gebruiker in
 * Instellingen; elk bestand wordt tegen een sha256 gecontroleerd, een afgebroken download gaat
 * verder waar hij was. De server draait op 127.0.0.1 op een vrije poort, wordt pas gestart bij de
 * eerste bon en stopt weer na een tijd zonder gebruik (scheelt werkgeheugen).
 */

export type RuntimeState = 'niet-geinstalleerd' | 'downloaden' | 'geinstalleerd' | 'starten' | 'actief' | 'fout';

export interface RuntimeStatus {
  state: RuntimeState;
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
}

/** Vastgelegde toestemming (alleen in de Store-versie): voor welke build, en wanneer. */
interface Consent {
  version: 1;
  llamaTag: string;
  serverSha256: string;
  at: string;
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
  private status_: RuntimeStatus;
  private process: ChildProcess | null = null;
  private url: string | null = null;
  private starting: Promise<string> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
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
    return { ...this.status_, progress: this.status_.progress ? { ...this.status_.progress } : null };
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
      // 1. welke llama.cpp-build: de vaste (Store-versie), anders de nieuwste release
      const runtime = pinned ? { tag: pinned.tag, archive: pinned.archive } : await this.latestRuntime(pattern);
      const release = { tag_name: runtime.tag };
      const downloads: (ModelFile & { target: string })[] = [
        { ...runtime.archive, target: join(this.dir, 'downloads', runtime.archive.name) },
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

  /** De nieuwste release van llama.cpp voor dit platform, met het controlegetal dat GitHub erbij geeft. */
  private async latestRuntime(pattern: RegExp): Promise<{ tag: string; archive: ModelFile }> {
    const rel = await this.deps.fetch(LLAMA_CPP.releaseApi, { headers: { Accept: 'application/vnd.github+json' } });
    if (!rel.ok) throw new Error(`Kon de runtime niet vinden (HTTP ${rel.status})`);
    const release = (await rel.json()) as { tag_name: string; assets: { name: string; size: number; browser_download_url: string; digest?: string | null }[] };
    const asset = release.assets.find((a) => pattern.test(a.name));
    if (!asset) throw new Error('Geen passende runtime gevonden voor dit systeem.');
    const sha = asset.digest?.startsWith('sha256:') ? asset.digest.slice(7) : null;
    if (!sha) throw new Error('De runtime heeft geen controlegetal; downloaden afgebroken.');
    return { tag: release.tag_name, archive: { name: asset.name, url: asset.browser_download_url, size: asset.size, sha256: sha } };
  }

  /** Download met hervatten (Range) en sha256-controle. */
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
    this.starting = this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(): Promise<string> {
    const inst = this.installed();
    if (!inst) throw new Error('De ingebouwde herkenning is nog niet geïnstalleerd (Instellingen → Slimme herkenning).');
    // Store-versie: alleen precies het programma waarvoor toestemming is gegeven wordt gestart
    if (this.deps.pinned && (await sha256File(inst.serverPath)) !== this.deps.pinned.serverSha256) {
      this.status_ = { ...this.status_, state: 'fout', error: this.withHint('llama-server is gewijzigd sinds het downloaden (controlegetal klopt niet) en wordt niet gestart. Verwijder de herkenning en installeer hem opnieuw.') };
      throw new Error(this.status_.error!);
    }
    this.status_.state = 'starten';
    const port = await freePort();
    const [model, mmproj] = inst.files.map((f) => join(this.dir, 'models', f));
    const threads = Math.max(1, Math.min(8, cpus().length - 1));
    const binDir = dirname(inst.serverPath);
    const args = ['-m', model!, '--mmproj', mmproj!, '--host', '127.0.0.1', '--port', String(port), '-c', '8192', '-t', String(threads), '--temp', '0'];
    const env = { ...process.env, LD_LIBRARY_PATH: [binDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') };
    const child = (this.deps.spawn ?? ((c, a, o) => spawn(c, a, { ...o, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })))(inst.serverPath, args, { cwd: binDir, env });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-2000);
    });
    this.process = child;
    const url = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        this.status_ = { ...this.status_, state: 'fout', error: this.withHint(`De herkenning stopte onverwacht. ${stderr.split('\n').filter(Boolean).slice(-2).join(' ')}`) };
        throw new Error(this.status_.error!);
      }
      try {
        const r = await this.deps.fetch(`${url}/health`);
        if (r.ok) {
          this.url = url;
          this.status_ = { ...this.status_, state: 'actief', error: null };
          return url;
        }
      } catch {
        // nog aan het laden
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    this.stop();
    throw new Error(this.withHint('De herkenning start niet (time-out).'));
  }

  stop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.process && this.process.exitCode === null) this.process.kill();
    this.process = null;
    this.url = null;
    if (this.status_.state === 'actief' || this.status_.state === 'starten') this.status_.state = 'geinstalleerd';
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
          return await new LlamaCppOcrProvider(self.model.id, url, fetchImpl, self.model.prompt).recognize(input);
        } finally {
          self.touch();
        }
      },
    };
  }
}
