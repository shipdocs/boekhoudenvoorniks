import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { AppUpdater } from 'electron-updater';
import { XMLValidator } from 'fast-xml-parser';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, openReadonly } from '../src/db/database';
import { createApi, type HostContext } from '../src/main/api';
import { MARKER, markComplete, migrateToSharedDir, planSwitch, readPointer, resolveDataDir, sharedDataDir, switchDataDir, type MigrationOutcome } from '../src/main/data-dir';
import { Updates, type UpdateStatus } from '../src/main/updates';
import {
  DOWNLOAD_URL,
  FIRST_START_FLAG,
  isWindowsStore,
  mcpCommand,
  migrateForStore,
  READ_ONLY_MESSAGE,
  readOnlyError,
  STORE_ALIAS,
  STORE_UPDATE_TEXT,
  storeAliasPath,
  storeFallbackHint,
  storeFirstStartNotice,
  storeFolderProblem,
  type StoreMigrationChoice,
  type StoreMigrationDeps,
  type StoreMigrationFailure,
} from '../src/main/windows-store';
import { GLM_OCR, STORE_LLAMA_CPP, type OcrModel, type PinnedRuntime } from '../src/ocr-runtime/manifest';
import { LocalOcrRuntime, type DownloadFetch } from '../src/ocr-runtime/runtime';
import { createZip } from '../src/shared/zip';
import { setup } from './helpers';

const require = createRequire(import.meta.url);
const ROOT = join(__dirname, '..');
const pkg = require('../package.json') as { name: string; version: string; description: string; build: { productName: string; win: { target: string[] }; appx: Record<string, unknown>; appxManifestCreated: string } };
const storeManifest = require('../scripts/store-manifest.cjs') as {
  appxManifestCreated(path: string): Promise<void>;
  storeVersion(version: string): string;
  withStoreVersion(xml: string, version: string): string;
  manifestProblems(xml: string, version: string): string[];
  readManifest(appx: Buffer): string;
  IDENTITY: { name: string; publisher: string; publisherDisplayName: string };
  ALIAS: string;
};

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gb-store-')));
  roots.push(dir);
  return dir;
}

describe('de versie uit de Microsoft Store herkennen', () => {
  it('alleen als Electron process.windowsStore zet; anders is het de gewone versie', () => {
    expect(isWindowsStore({ windowsStore: true })).toBe(true);
    expect(isWindowsStore({})).toBe(false);
    expect(isWindowsStore({ windowsStore: undefined })).toBe(false);
    // in de tests zelf (en dus in elke build die geen Store-pakket is)
    expect(isWindowsStore()).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------

/** Een nagebootste electron-updater die bijhoudt wat ermee gedaan wordt. */
function fakeUpdater(version = '9.9.9') {
  const calls: string[] = [];
  const emitter = new EventEmitter();
  const updater = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    on(event: string, listener: (...args: unknown[]) => void) {
      calls.push(`on:${event}`);
      emitter.on(event, listener);
      return updater;
    },
    async checkForUpdates() {
      calls.push('checkForUpdates');
      return { updateInfo: { version } };
    },
    quitAndInstall() {
      calls.push('quitAndInstall');
    },
  };
  return { updater: updater as unknown as AppUpdater, calls, emitter };
}

describe('updates', () => {
  it('Store-versie: electron-updater wordt nooit aangeroepen, ook niet opgevraagd', async () => {
    let asked = 0;
    const statuses: UpdateStatus[] = [];
    const updates = new Updates((s) => statuses.push(s), () => true, {
      isPackaged: true,
      version: () => '0.7.6',
      store: true,
      updater: () => {
        asked++;
        throw new Error('electron-updater hoort in de Store-versie niet gebruikt te worden');
      },
    });
    updates.configure();
    expect(await updates.checkNow()).toBe(STORE_UPDATE_TEXT);
    expect(STORE_UPDATE_TEXT).toMatch(/Microsoft Store/);
    expect(() => updates.install()).toThrow('Er staat geen update klaar');
    expect(asked).toBe(0);
    expect(statuses).toEqual([]);
    expect(updates.status.state).toBe('uit');
  });

  it('gewone versie: zoekt, downloadt en installeert via electron-updater, zoals altijd', async () => {
    const { updater, calls, emitter } = fakeUpdater();
    const statuses: UpdateStatus[] = [];
    const updates = new Updates((s) => statuses.push(s), () => true, { isPackaged: true, version: () => '0.7.6', store: false, updater: () => updater });
    expect(calls).toContain('on:update-downloaded');
    expect(await updates.checkNow()).toBe('Versie 9.9.9 wordt gedownload. Hij wordt geïnstalleerd als je de app sluit.');
    expect(updater.autoDownload).toBe(true);
    expect(() => updates.install()).toThrow('Er staat geen update klaar');
    emitter.emit('update-downloaded', { version: '9.9.9', releaseNotes: '<p>Nieuw</p>' });
    expect(updates.status).toMatchObject({ state: 'klaar', version: '9.9.9', notes: 'Nieuw' });
    updates.install();
    expect(calls).toContain('quitAndInstall');
    // niet geïnstalleerd (ontwikkelen): geen controle
    const dev = fakeUpdater();
    expect(await new Updates(() => undefined, () => true, { isPackaged: false, version: () => '0.7.6', store: false, updater: () => dev.updater }).checkNow()).toBe('Updates zijn alleen beschikbaar in de geïnstalleerde versie');
    expect(dev.calls).not.toContain('checkForUpdates');
  });
});

// ---------------------------------------------------------------------------------------------

describe('koppeling met Claude Code/Codex (--mcp)', () => {
  const packaged = { isPackaged: true, execPath: 'C:\\Program Files\\WindowsApps\\ShipDocs.BoekhoudenVoorNiks_1.7.6.0_x64__xxc75kaw9g27y\\app\\BoekhoudenVoorNiks.exe', appPath: 'C:\\app' };

  it('Store-versie: de alias, niet het pad met het versienummer erin', () => {
    const cmd = mcpCommand({ ...packaged, store: true, localAppData: 'C:\\Users\\Piet\\AppData\\Local' });
    expect(cmd).toEqual({ command: 'C:\\Users\\Piet\\AppData\\Local\\Microsoft\\WindowsApps\\boekhoudenvoorniks.exe', args: ['--mcp'] });
    expect(cmd.command).not.toContain('1.7.6.0');
    // zonder %LOCALAPPDATA%: de kale naam (WindowsApps staat op het zoekpad)
    expect(mcpCommand({ ...packaged, store: true, localAppData: undefined }).command).toBe(STORE_ALIAS);
    expect(storeAliasPath(null)).toBe('boekhoudenvoorniks.exe');
  });

  it('gewone versie: ongewijzigd (programma zelf, AppImage-bestand, of electron met de app-map)', () => {
    expect(mcpCommand({ ...packaged, store: false, localAppData: 'C:\\Users\\Piet\\AppData\\Local' })).toEqual({ command: packaged.execPath, args: ['--mcp'] });
    expect(mcpCommand({ store: false, appImage: '/home/piet/BoekhoudenVoorNiks.AppImage', isPackaged: true, execPath: '/tmp/.mount_x/boekhoudenvoorniks', appPath: '/tmp/.mount_x/resources/app.asar' })).toEqual({ command: '/home/piet/BoekhoudenVoorNiks.AppImage', args: ['--mcp'] });
    expect(mcpCommand({ store: false, isPackaged: false, execPath: '/repo/node_modules/electron/dist/electron', appPath: '/repo' })).toEqual({ command: '/repo/node_modules/electron/dist/electron', args: ['/repo', '--mcp'] });
  });

  it('de alias in de app is dezelfde als in het pakket', () => {
    expect(storeManifest.ALIAS).toBe(STORE_ALIAS);
    expect(readFileSync(join(ROOT, 'build', 'appx-extensions.xml'), 'utf8')).toContain(`<desktop:ExecutionAlias Alias="${STORE_ALIAS}" />`);
  });

  it('werkt de koppeling niet: verwijzing naar de gewone Windows-versie', () => {
    const { s } = setup();
    const host = (store: boolean) => ({ windowsStore: store, mcpCommand: () => ({ command: 'x', args: ['--mcp'] }), localOcr: { status: () => ({ state: 'niet-geinstalleerd' }) } }) as unknown as HostContext;
    const note = createApi(s, host(true)).assistant.info().storeNote;
    expect(note).toContain(DOWNLOAD_URL);
    expect(note).toMatch(/Lukt de koppeling niet in de versie uit de Microsoft Store\?/);
    expect(createApi(s, host(false)).assistant.info().storeNote).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const MODEL_A = Buffer.from('model-a'.repeat(1000));
const MODEL_B = Buffer.from('mmproj-b'.repeat(500));
const ARCHIVE = Buffer.from('zip-inhoud');
const SERVER = Buffer.from('MZ llama-server');
const model: OcrModel = {
  ...GLM_OCR,
  files: [
    { name: 'a.gguf', url: 'https://hf.example/a.gguf', size: MODEL_A.length, sha256: sha(MODEL_A) },
    { name: 'mmproj-b.gguf', url: 'https://hf.example/b.gguf', size: MODEL_B.length, sha256: sha(MODEL_B) },
  ],
};
const pinned: PinnedRuntime = {
  tag: 'b1234',
  archive: { name: 'llama-b1234-bin-win-cpu-x64.zip', url: 'https://gh.example/vast/llama-b1234-bin-win-cpu-x64.zip', size: ARCHIVE.length, sha256: sha(ARCHIVE) },
  serverSha256: sha(SERVER),
};
const HINT = storeFallbackHint('het lezen van bonnen op deze computer');

function fakeFetch(opts: { archive?: Buffer } = {}): DownloadFetch & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    const bytes = (b: Buffer) => ({ ok: true, status: 200, headers: { get: () => null }, body: (async function* () { yield new Uint8Array(b); })(), json: async () => ({}) });
    if (url.includes('api.github.com')) {
      return { ok: true, status: 200, headers: { get: () => null }, body: null, json: async () => ({ tag_name: 'b9999', assets: [{ name: 'llama-b9999-bin-win-cpu-x64.zip', size: ARCHIVE.length, browser_download_url: 'https://gh.example/nieuwste/win.zip', digest: `sha256:${sha(ARCHIVE)}` }] }) };
    }
    if (url.endsWith('.zip')) return bytes(opts.archive ?? ARCHIVE);
    if (url.endsWith('a.gguf')) return bytes(MODEL_A);
    if (url.endsWith('b.gguf')) return bytes(MODEL_B);
    if (url.endsWith('/health')) return { ok: true, status: 200, headers: { get: () => null }, body: null, json: async () => ({}) };
    throw new Error(`onverwacht: ${url}`);
  }) as unknown as DownloadFetch & { calls: string[] };
  fn.calls = calls;
  return fn;
}

const extractWith = (server: Buffer) => async (_archive: string, dest: string) => {
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, 'llama-server.exe'), server);
};

function fakeSpawn() {
  const spawned: string[] = [];
  const spawn = (cmd: string) => {
    spawned.push(cmd);
    const child = new EventEmitter() as unknown as ChildProcess & { exitCode: number | null };
    (child as { exitCode: number | null }).exitCode = null;
    (child as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
    (child as unknown as { kill: () => boolean }).kill = () => true;
    return child;
  };
  return { spawn: spawn as never, spawned };
}

/** De runtime zoals de Store-versie hem maakt: vaste build, toestemming nodig, verwijzing bij een fout. */
function storeRuntime(dir: string, fetch = fakeFetch(), server = SERVER, spawn?: never) {
  return new LocalOcrRuntime(dir, { fetch, extract: extractWith(server), spawn, platform: 'win32', arch: 'x64', model, pinned, failureHint: HINT });
}

describe('lokale OCR in de Store-versie', () => {
  it('staat standaard uit: zonder toestemming wordt er niets gedownload', async () => {
    const dir = join(tempDir(), 'ocr');
    const fetch = fakeFetch();
    const rt = storeRuntime(dir, fetch);
    expect(rt.hasConsent()).toBe(false);
    expect(rt.isInstalled()).toBe(false);
    await expect(rt.install()).rejects.toThrow(/Geef eerst toestemming/);
    expect(fetch.calls).toEqual([]);
    expect(existsSync(dir)).toBe(false);
    expect(rt.status().state).toBe('niet-geinstalleerd');
  });

  it('na toestemming: precies de vaste build, nooit "de nieuwste", en llama-server.exe moet kloppen', async () => {
    const dir = join(tempDir(), 'ocr');
    const fetch = fakeFetch();
    const rt = storeRuntime(dir, fetch);
    rt.giveConsent(new Date('2026-10-01T10:00:00Z'));
    expect(JSON.parse(readFileSync(join(dir, 'toestemming.json'), 'utf8'))).toEqual({ version: 1, llamaTag: 'b1234', serverSha256: pinned.serverSha256, at: '2026-10-01T10:00:00.000Z' });
    await rt.install();
    expect(fetch.calls).toContain(pinned.archive.url);
    expect(fetch.calls.some((u) => u.includes('api.github.com'))).toBe(false);
    expect(rt.status()).toMatchObject({ state: 'geinstalleerd', llamaVersion: 'b1234' });
    // na een herstart nog steeds, en verwijderen trekt ook de toestemming in
    expect(storeRuntime(dir).isInstalled()).toBe(true);
    await rt.uninstall();
    expect(storeRuntime(dir).hasConsent()).toBe(false);
  });

  it('een archief of llama-server.exe met een ander controlegetal wordt geweigerd, met een verwijzing naar de gewone versie', async () => {
    const wrongArchive = storeRuntime(join(tempDir(), 'ocr'), fakeFetch({ archive: Buffer.from('ander-zip!') }));
    wrongArchive.giveConsent();
    await expect(wrongArchive.install()).rejects.toThrow(/controlegetal klopt niet/);
    expect(wrongArchive.status().error).toContain(DOWNLOAD_URL);

    const dir = join(tempDir(), 'ocr');
    const wrongServer = storeRuntime(dir, fakeFetch(), Buffer.from('MZ iets anders'));
    wrongServer.giveConsent();
    await expect(wrongServer.install()).rejects.toThrow(/niet het programma dat bij deze versie hoort/);
    expect(wrongServer.isInstalled()).toBe(false);
    expect(wrongServer.status()).toMatchObject({ state: 'fout' });
    expect(wrongServer.status().error).toContain('gewone Windows-versie');
    expect(existsSync(join(dir, 'llama', 'b1234'))).toBe(false);
  });

  it('vóór elke start wordt llama-server.exe opnieuw gecontroleerd; een gewijzigd programma start niet', async () => {
    const dir = join(tempDir(), 'ocr');
    const { spawn, spawned } = fakeSpawn();
    const rt = storeRuntime(dir, fakeFetch(), SERVER, spawn);
    rt.giveConsent();
    await rt.install();
    await rt.ensureStarted();
    expect(spawned).toEqual([join(dir, 'llama', 'b1234', 'llama-server.exe')]);
    rt.stop();
    writeFileSync(join(dir, 'llama', 'b1234', 'llama-server.exe'), 'MZ vervangen');
    await expect(rt.ensureStarted()).rejects.toThrow(/gewijzigd sinds het downloaden/);
    expect(spawned).toHaveLength(1);
    expect(rt.status().error).toContain(DOWNLOAD_URL);
  });

  it('een runtime die de gewone versie eerder downloadde (andere build) telt niet: eerst toestemming en de vaste build', async () => {
    const dir = join(tempDir(), 'ocr');
    // de gewone versie: de nieuwste release, zonder toestemming
    const plain = new LocalOcrRuntime(dir, { fetch: fakeFetch(), extract: extractWith(SERVER), platform: 'win32', arch: 'x64', model });
    expect(plain.hasConsent()).toBe(true);
    await plain.install();
    expect(plain.status()).toMatchObject({ state: 'geinstalleerd', llamaVersion: 'b9999' });
    expect(plain.status().error).toBeNull();
    // dezelfde map in de Store-versie
    const store = storeRuntime(dir);
    expect(store.isInstalled()).toBe(false);
    store.giveConsent();
    expect(store.isInstalled()).toBe(false);
    await store.install();
    expect(store.status()).toMatchObject({ state: 'geinstalleerd', llamaVersion: 'b1234' });
  });

  it('de vaste build voor de Store is een Windows x64-build met controlegetallen', () => {
    expect(STORE_LLAMA_CPP.archive.name).toBe(`llama-${STORE_LLAMA_CPP.tag}-bin-win-cpu-x64.zip`);
    expect(STORE_LLAMA_CPP.archive.url).toBe(`https://github.com/ggml-org/llama.cpp/releases/download/${STORE_LLAMA_CPP.tag}/${STORE_LLAMA_CPP.archive.name}`);
    expect(STORE_LLAMA_CPP.archive.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(STORE_LLAMA_CPP.serverSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(STORE_LLAMA_CPP.archive.size).toBeGreaterThan(1_000_000);
  });

  /** De api zoals het scherm hem aanroept, met de runtime erachter. */
  function apiWith(rt: LocalOcrRuntime, store: boolean) {
    const { s } = setup();
    const installs: Promise<void>[] = [];
    const host = {
      windowsStore: store,
      reconfigureLocalAi: () => undefined,
      hasSmtpPassword: () => false,
      localOcr: {
        status: () => rt.status(),
        install: () => {
          installs.push(rt.install().catch(() => undefined));
          return rt.status();
        },
        uninstall: () => rt.uninstall(),
        ...(store ? { consent: { runtimeVersion: pinned.tag, given: () => rt.hasConsent(), give: () => rt.giveConsent() } } : {}),
      },
    } as unknown as HostContext;
    return { s, api: createApi(s, host), installs };
  }

  it('in het scherm: "op deze computer" kan pas na een uitdrukkelijk ja', async () => {
    const rt = storeRuntime(join(tempDir(), 'ocr'));
    const { s, api, installs } = apiWith(rt, true);
    expect(api.reader.options().local).toMatchObject({ consentNeeded: true, runtimeVersion: 'b1234' });
    expect(api.localOcr.info()).toMatchObject({ consentNeeded: true, runtimeVersion: 'b1234' });
    expect(() => api.reader.choose('lokaal')).toThrow(/Geef eerst toestemming/);
    expect(() => api.localOcr.install()).toThrow(/Geef eerst toestemming/);
    expect(() => api.localOcr.use()).toThrow(/Geef eerst toestemming/);
    expect(s.settings.get().ocr.engine).not.toBe('ingebouwd');
    expect(installs).toHaveLength(0);
    // stond lokaal lezen nog aan uit de gewone versie, dan is het hier toch uit
    s.settings.update({ ocr: { ...s.settings.get().ocr, engine: 'ingebouwd', askedReader: true } });
    expect(api.reader.options().current).toBe('geen');

    api.reader.choose('lokaal', true);
    expect(rt.hasConsent()).toBe(true);
    await Promise.all(installs);
    expect(installs).toHaveLength(1);
    expect(rt.isInstalled()).toBe(true);
    expect(api.reader.options()).toMatchObject({ current: 'ingebouwd', local: { consentNeeded: false } });
  });

  it('gewone versie: geen toestemmingsvraag, alles zoals het was', async () => {
    const rt = new LocalOcrRuntime(join(tempDir(), 'ocr'), { fetch: fakeFetch(), extract: extractWith(SERVER), platform: 'win32', arch: 'x64', model });
    const { api, installs } = apiWith(rt, false);
    expect(api.reader.options().local).toMatchObject({ consentNeeded: false, runtimeVersion: null });
    api.reader.choose('lokaal');
    await Promise.all(installs);
    expect(rt.status()).toMatchObject({ state: 'geinstalleerd', llamaVersion: 'b9999' });
    expect(api.reader.options().current).toBe('ingebouwd');
    expect(api.app.distribution()).toEqual({ store: false, readOnly: false });
  });
});

// ---------------------------------------------------------------------------------------------

/** Een nagebootste computer met een oude gegevensmap in AppData. */
function machine() {
  const root = tempDir();
  const home = join(root, 'home');
  const appData = join(root, 'AppData', 'Roaming');
  const source = join(appData, 'boekhoudenvoorniks');
  mkdirSync(home, { recursive: true });
  mkdirSync(source, { recursive: true });
  const db = openDatabase(join(source, 'boekhouding.sqlite'));
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('proef', '"oud"')`).run();
  db.close();
  return { root, home, appData, source, target: sharedDataDir(home) };
}

/**
 * De afhankelijkheden van `migrateForStore` zoals de app ze geeft: echt overzetten, en voor een zelf
 * gekozen map de weg van Instellingen (`planSwitch`, `switchDataDir`). De antwoorden van de gebruiker
 * staan op een rij.
 */
function storeFlow(m: ReturnType<typeof machine>, answers: StoreMigrationChoice[], opts: { failFirst?: number; picks?: (string | null)[]; syncOk?: boolean; viewProblem?: string | null; stopSwitch?: boolean; platform?: NodeJS.Platform } = {}) {
  const log = { failures: [] as StoreMigrationFailure[], targets: [] as string[], switched: [] as string[], refused: [] as string[], syncWarnings: [] as string[] };
  let attempts = 0;
  const deps: StoreMigrationDeps = {
    source: m.source,
    target: m.target,
    appData: m.appData,
    migrate: (source, target): Promise<MigrationOutcome> => {
      log.targets.push(target);
      // de eerste poging(en) mislukken: geen ruimte op de schijf
      return migrateToSharedDir({ source, target, freeSpace: () => (attempts++ < (opts.failFirst ?? 1) ? 0 : 1e12) });
    },
    // een eigen "computer" voor de synchronisatiediensten: alleen wat er in de testmap staat telt
    plan: (chosen) => planSwitch({ home: m.home, current: m.source, chosen, sync: { platform: process.platform, home: m.home, env: {}, exists: existsSync, readFile: (file) => readFileSync(file, 'utf8') } }),
    switchTo: (target) => {
      log.switched.push(target);
      return switchDataDir({ home: m.home, source: m.source, target, action: 'kopieren', shouldStop: () => opts.stopSwitch === true });
    },
    viewProblem: () => opts.viewProblem ?? null,
    choose: async (failure) => {
      log.failures.push(failure);
      return answers.shift() ?? 'afsluiten';
    },
    pickFolder: async () => opts.picks?.shift() ?? null,
    refuse: async (reason) => void log.refused.push(reason),
    confirmSyncFolder: async (dir, service) => {
      log.syncWarnings.push(`${service}: ${dir}`);
      return opts.syncOk ?? false;
    },
    platform: opts.platform ?? process.platform,
  };
  return { deps, log };
}

describe('Store-versie: het overzetten van de gegevens lukt niet', () => {
  it('opnieuw proberen: de tweede poging zet over naar de gedeelde map', async () => {
    const m = machine();
    const { deps, log } = storeFlow(m, ['opnieuw']);
    const result = await migrateForStore(deps);
    expect(result).toMatchObject({ kind: 'gemigreerd', dir: m.target });
    expect(log.failures).toHaveLength(1);
    expect(log.failures[0]).toMatchObject({ status: 'geen-ruimte', source: m.source, target: m.target, viewProblem: null });
    expect(existsSync(join(m.target, MARKER))).toBe(true);
    expect(readPointer(m.home)).toBeNull();
  });

  it('lukt het meteen, dan komt er geen vraag', async () => {
    const m = machine();
    const { deps, log } = storeFlow(m, [], { failFirst: 0 });
    expect(await migrateForStore(deps)).toMatchObject({ kind: 'gemigreerd', dir: m.target });
    expect(log.failures).toEqual([]);
  });

  it('zelf een map kiezen: dezelfde weigeringen en waarschuwing als in Instellingen, daarna een eigen map die de app onthoudt', async () => {
    const m = machine();
    const oneDrive = join(m.home, 'OneDrive', 'Boekhouding');
    const used = join(m.root, 'documenten');
    const taken = join(m.root, 'andere-administratie');
    const own = join(m.root, 'schijf-d', 'Administratie');
    for (const dir of [oneDrive, used, taken, own]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(used, 'brief.txt'), 'x');
    openDatabase(join(taken, 'boekhouding.sqlite')).close();
    markComplete(taken);
    const { deps, log } = storeFlow(m, ['kiezen', 'kiezen', 'kiezen', 'kiezen', 'kiezen', 'kiezen'], { picks: [null, m.source, used, taken, oneDrive, own] });
    const result = await migrateForStore(deps);
    // 1: geannuleerd, 2: de oude map zelf, 3: een map met andere bestanden, 4: een map met een administratie
    // (hier alleen kopiëren, niet openen), 5: OneDrive (gewaarschuwd, niet gebruikt), 6: een lege eigen map
    expect(log.failures).toHaveLength(6);
    expect(log.refused).toHaveLength(3);
    expect(log.refused[0]).toBe('Dit is de map die je nu al gebruikt.');
    expect(log.refused[1]).toMatch(/staan al andere bestanden\. Kies een lege map/);
    expect(log.refused[2]).toBe(`In ${taken} staat al een administratie. Kies een lege map; dan zet de app je gegevens erin.`);
    expect(log.syncWarnings).toEqual([`OneDrive: ${oneDrive}`]);
    // het gewone overzetten is één keer geprobeerd; alleen de laatste keuze is gekopieerd
    expect(log.targets).toEqual([m.target]);
    expect(log.switched).toEqual([own]);
    expect(result).toMatchObject({ kind: 'gekozen', dir: own, outcome: { status: 'gewisseld', action: 'kopieren' } });
    expect(existsSync(join(own, MARKER))).toBe(true);
    expect(existsSync(join(oneDrive, 'boekhouding.sqlite'))).toBe(false);
    // de oude map blijft onder zijn eigen naam staan; app en koppeling vinden de gekozen map via de pointer
    expect(existsSync(join(m.source, 'boekhouding.sqlite'))).toBe(true);
    expect(readPointer(m.home)).toBe(own);
    expect(resolveDataDir({ home: m.home, appData: m.appData })).toEqual({ kind: 'pointer', dir: own });
  });

  it('een map onder AppData kan niet: wat de Store-versie daar neerzet, verdwijnt bij verwijderen', async () => {
    const m = machine();
    const local = join(m.root, 'AppData', 'Local', 'Boekhouding');
    mkdirSync(local, { recursive: true });
    const { deps, log } = storeFlow(m, ['kiezen', 'afsluiten'], { picks: [local], platform: 'win32' });
    expect(await migrateForStore(deps)).toEqual({ kind: 'afsluiten' });
    expect(log.refused).toEqual(['Kies een map buiten AppData. Wat de versie uit de Microsoft Store daar neerzet, verdwijnt als je de app verwijdert.']);
    expect(log.switched).toEqual([]);
    expect(readPointer(m.home)).toBeNull();

    const appData = 'C:\\Users\\Piet\\AppData\\Roaming';
    expect(storeFolderProblem('C:\\Users\\Piet\\AppData\\Local\\Boekhouding', appData, 'win32')).toMatch(/buiten AppData/);
    expect(storeFolderProblem('c:\\users\\piet\\appdata', appData, 'win32')).toMatch(/buiten AppData/);
    expect(storeFolderProblem('C:\\Users\\Piet\\AppDataBackup', appData, 'win32')).toBeNull();
    expect(storeFolderProblem('D:\\Administratie', appData, 'win32')).toBeNull();
    // alleen Windows kent die omleiding
    expect(storeFolderProblem('/home/piet/.config/boekhouding', '/home/piet/.config', 'linux')).toBeNull();
  });

  it('lukt het kopiëren naar de gekozen map niet, dan komt de vraag terug en is er niets vastgelegd', async () => {
    const m = machine();
    const own = join(m.root, 'schijf-d');
    mkdirSync(own);
    const { deps, log } = storeFlow(m, ['kiezen', 'afsluiten'], { picks: [own], stopSwitch: true });
    expect(await migrateForStore(deps)).toEqual({ kind: 'afsluiten' });
    expect(log.failures[1]).toMatchObject({ status: 'gestopt', target: own, source: m.source });
    expect(readPointer(m.home)).toBeNull();
    expect(existsSync(join(own, MARKER))).toBe(false);
    expect(existsSync(join(m.source, 'boekhouding.sqlite'))).toBe(true);
  });

  it('de gewone gedeelde map aanwijzen is opnieuw proberen: geen map erin en geen pointer', async () => {
    const m = machine();
    // zoals in de app: Chromium heeft de gedeelde map al aangemaakt
    mkdirSync(m.target, { recursive: true });
    writeFileSync(join(m.target, 'Local State'), '{}');
    const { deps, log } = storeFlow(m, ['kiezen'], { picks: [m.target] });
    expect(await migrateForStore(deps)).toMatchObject({ kind: 'gemigreerd', dir: m.target });
    expect(log.targets).toEqual([m.target, m.target]);
    expect(readPointer(m.home)).toBeNull();
    expect(resolveDataDir({ home: m.home, appData: m.appData })).toEqual({ kind: 'gedeeld', dir: m.target });
  });

  it('een synchronisatiemap mag, maar alleen na "toch gebruiken"', async () => {
    const m = machine();
    const dropbox = join(m.home, 'Dropbox', 'Boekhouding');
    mkdirSync(dropbox, { recursive: true });
    const { deps, log } = storeFlow(m, ['kiezen'], { picks: [dropbox], syncOk: true });
    expect(await migrateForStore(deps)).toMatchObject({ kind: 'gekozen', dir: dropbox });
    expect(log.syncWarnings).toEqual([`Dropbox: ${dropbox}`]);
    expect(readPointer(m.home)).toBe(dropbox);
  });

  it('alleen bekijken: de oude map blijft zoals hij was en gaat alleen-lezen open', async () => {
    const m = machine();
    const before = readdirSync(m.source).sort();
    const { deps } = storeFlow(m, ['bekijken']);
    const result = await migrateForStore(deps);
    expect(result).toMatchObject({ kind: 'alleen-lezen', dir: m.source });
    expect(readdirSync(m.source).sort()).toEqual(before);
    expect(existsSync(join(m.target, MARKER))).toBe(false);
    const db = openReadonly(join(m.source, 'boekhouding.sqlite'));
    expect(db.readonly).toBe(true);
    expect(db.prepare(`SELECT value FROM settings WHERE key = 'proef'`).get()).toEqual({ value: '"oud"' });
    db.close();
  });

  it('bekijken kan niet (administratie van een oudere versie): de keuze blijft opnieuw, zelf kiezen of afsluiten', async () => {
    const m = machine();
    const { deps, log } = storeFlow(m, ['bekijken', 'afsluiten'], { viewProblem: 'de administratie is van een oudere versie' });
    expect(await migrateForStore(deps)).toEqual({ kind: 'afsluiten' });
    expect(log.failures.map((f) => f.viewProblem)).toEqual(['de administratie is van een oudere versie', 'de administratie is van een oudere versie']);
    expect(existsSync(join(m.source, 'boekhouding.sqlite'))).toBe(true);
  });

  it('alleen-lezen is mode=ro, niet immutable=1: wat nog in de WAL staat is zichtbaar, schrijven kan niet', () => {
    const file = join(tempDir(), 'boekhouding.sqlite');
    const writer = openDatabase(file);
    // niets naar het hoofdbestand: de wijziging staat alleen in de WAL (zoals na een niet netjes gesloten app)
    writer.pragma('wal_autocheckpoint = 0');
    writer.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('proef', '"in de wal"')`).run();
    expect(statSync(`${file}-wal`).size).toBeGreaterThan(0);

    const ro = openReadonly(file);
    const read = () => (ro.prepare(`SELECT value FROM settings WHERE key = 'proef'`).get() as { value: string } | undefined)?.value;
    // immutable=1 slaat de WAL over en zou hier niets (of iets ouds) teruggeven
    expect(read()).toBe('"in de wal"');
    // en ziet nooit wat er daarna nog bij komt; mode=ro wel
    writer.prepare(`UPDATE settings SET value = '"later"' WHERE key = 'proef'`).run();
    expect(read()).toBe('"later"');

    expect(ro.readonly).toBe(true);
    let error: unknown;
    try {
      ro.prepare(`UPDATE settings SET value = '"x"' WHERE key = 'proef'`).run();
    } catch (e) {
      error = e;
    }
    expect((error as { code?: string }).code).toBe('SQLITE_READONLY');
    expect(readOnlyError(error)?.message).toBe(READ_ONLY_MESSAGE);
    expect(readOnlyError(new Error('Vul een bedrag in'))).toBeNull();
    ro.close();
    writer.close();
    // nergens in de broncode wordt een database met immutable geopend
    for (const source of ['src/db/database.ts', 'src/main/windows-store.ts', 'src/main/main.ts', 'src/main/data-dir.ts', 'src/main/administrations.ts']) {
      expect(readFileSync(join(ROOT, source), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, ''), source).not.toMatch(/immutable/i);
    }
  });

  it('het scherm weet dat de administratie alleen te bekijken is en kan het overzetten opnieuw starten', () => {
    const { s } = setup();
    let retried = 0;
    const api = createApi(s, { windowsStore: true, readOnly: () => true, retryDataMove: () => void retried++, localOcr: { status: () => ({ state: 'niet-geinstalleerd' }) } } as unknown as HostContext);
    expect(api.app.distribution()).toEqual({ store: true, readOnly: true });
    api.app.retryDataMove();
    expect(retried).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------

describe('eerste start van de Store-versie', () => {
  it('meldt één keer dat een oude installatie van de website weg moet of bijgewerkt moet worden', () => {
    const dir = tempDir();
    const notice = storeFirstStartNotice(dir);
    expect(notice?.type).toBe('info');
    expect(notice?.detail).toMatch(/Setup\.exe/);
    expect(notice?.detail).toMatch(/Verwijder die oude versie.*of werk hem bij naar versie 0\.7\.6 of nieuwer/s);
    expect(existsSync(join(dir, FIRST_START_FLAG))).toBe(true);
    expect(storeFirstStartNotice(dir)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------

describe('het Store-pakket (appx/MSIX)', () => {
  // op Windows kan git de regeleinden omzetten
  const workflow = (name: string): string => readFileSync(join(ROOT, '.github', 'workflows', name), 'utf8').replace(/\r\n/g, '\n');
  const ci = workflow('ci.yml');
  const release = workflow('release.yml');
  /** De tekst van één job uit een workflow (tot de volgende job), zonder commentaarregels. */
  const job = (yaml: string, name: string): string => new RegExp(`\\n  ${name}:\\n[\\s\\S]*?(?=\\n  [\\w-]+:\\n|$)`).exec(yaml.replace(/^\s*#.*\n/gm, ''))?.[0] ?? '';

  it('heeft de vaste identiteit uit Partner Center', () => {
    expect(pkg.build.appx).toMatchObject({
      identityName: 'ShipDocs.BoekhoudenVoorNiks',
      publisher: 'CN=B884F2A1-35F1-4BD8-9EB7-F2746D9FB427',
      publisherDisplayName: 'ShipDocs',
      applicationId: 'BoekhoudenVoorNiks',
      languages: ['nl-NL'],
    });
    expect(storeManifest.IDENTITY).toEqual({ name: pkg.build.appx.identityName, publisher: pkg.build.appx.publisher, publisherDisplayName: pkg.build.appx.publisherDisplayName });
  });

  it('staat niet in de release-matrix: die bouwt alleen NSIS en publiceert naar GitHub', () => {
    expect(pkg.build.win.target).toEqual(['nsis']);
    const build = job(release, 'build');
    expect(build).toContain('--publish always');
    expect(build).not.toMatch(/appx|msix/i);
    expect(job(release, 'publish')).not.toMatch(/appx|msix/i);
    // de controlegetallen en dus de release bevatten alleen de bestaande bestanden
    expect(build).toContain('files=(*.AppImage *.deb *.exe)');
  });

  it('wordt in een eigen job gebouwd met --publish never en alleen als artefact bewaard', () => {
    for (const [yaml, name] of [[ci, 'package-store-windows'], [release, 'store']] as const) {
      const text = job(yaml, name);
      expect(text, name).toContain('runs-on: windows-latest');
      expect(text, name).toContain('npx electron-builder --win appx --publish never');
      expect(text, name).toContain('node scripts/store-manifest.cjs');
      expect(text, name).toMatch(/actions\/upload-artifact@v4[\s\S]*path: release\/\*\.appx/);
      // geen token, geen certificaat, niets naar een release
      expect(text, name).not.toMatch(/GH_TOKEN|GITHUB_TOKEN|CSC_LINK|gh release|--publish always/);
    }
    expect(job(release, 'store')).toMatch(/permissions:\n\s+contents: read/);
    // de release wacht niet op het Store-pakket
    expect(job(release, 'publish')).toContain('needs: build\n');
  });

  it('de afbeeldingen hebben de maten die electron-builder verwacht', () => {
    const sizes: Record<string, [number, number]> = { 'StoreLogo.png': [50, 50], 'Square44x44Logo.png': [44, 44], 'Square150x150Logo.png': [150, 150], 'Wide310x150Logo.png': [310, 150], 'SmallTile.png': [71, 71], 'LargeTile.png': [310, 310] };
    const dir = join(ROOT, 'build', 'appx');
    expect(readdirSync(dir).sort()).toEqual(Object.keys(sizes).sort());
    for (const [name, [width, height]] of Object.entries(sizes)) {
      const png = readFileSync(join(dir, name));
      expect(png.subarray(1, 4).toString(), name).toBe('PNG');
      expect([png.readUInt32BE(16), png.readUInt32BE(20)], name).toEqual([width, height]);
    }
  });

  it('pakketversie: het eerste getal één hoger (de Store weigert 0.x), het vierde 0', () => {
    expect(storeManifest.storeVersion('0.7.6')).toBe('1.7.6.0');
    expect(storeManifest.storeVersion('0.10.0')).toBe('1.10.0.0');
    expect(storeManifest.storeVersion('1.0.0')).toBe('2.0.0.0');
    expect(() => storeManifest.storeVersion('0.8.0-beta.1')).toThrow(/drie getallen/);
    expect(storeManifest.withStoreVersion(`<Identity Name="x" Version="0.7.6.0" />`, '0.7.6')).toBe(`<Identity Name="x" Version="1.7.6.0" />`);
    expect(() => storeManifest.withStoreVersion(`<Identity Name="x" Version="9.9.9.0" />`, '0.7.6')).toThrow(/niet precies één keer/);
  });

  it('het manifest zoals electron-builder het maakt: identiteit, taal, alias en geldige XML', async () => {
    // de echte code van electron-builder die het manifest schrijft, met ons sjabloon en onze instellingen;
    // het pakket zelf kan alleen op Windows gebouwd worden
    const AppXTarget = (require('app-builder-lib/out/targets/AppxTarget') as { default: { prototype: Record<string, unknown> } }).default;
    const { AppInfo } = require('app-builder-lib/out/appInfo') as { AppInfo: { prototype: { getVersionInWeirdWindowsForm(this: { version: string }, build: boolean): string } } };
    const { Arch } = require('builder-util') as { Arch: { x64: number } };
    const target = Object.create(AppXTarget.prototype) as { options: unknown; packager: unknown; writeManifest(out: string, arch: number, publisher: string, assets: string[]): Promise<void> };
    target.options = { ...pkg.build.win, ...pkg.build.appx };
    target.packager = {
      config: pkg.build,
      platformSpecificBuildOptions: pkg.build.win,
      info: { appDir: ROOT, metadata: pkg },
      appInfo: {
        name: pkg.name,
        productName: pkg.build.productName,
        productFilename: pkg.build.productName,
        description: pkg.description,
        companyName: 'niet gebruikt',
        getVersionInWeirdWindowsForm: (build: boolean) => AppInfo.prototype.getVersionInWeirdWindowsForm.call({ version: pkg.version }, build),
      },
      getResource: async (custom?: string) => (custom ? join(ROOT, 'build', custom) : null),
    };
    const out = join(tempDir(), 'AppxManifest.xml');
    await target.writeManifest(out, Arch.x64, String(pkg.build.appx.publisher), readdirSync(join(ROOT, 'build', 'appx')));
    const raw = readFileSync(out, 'utf8');
    expect(raw).toContain(`Version="${pkg.version}.0"`);
    expect(storeManifest.manifestProblems(raw, pkg.version)).toEqual([`Identity Version is ${storeManifest.storeVersion(pkg.version)}`]);

    // de hook uit package.json zet de pakketversie erin
    expect(pkg.build.appxManifestCreated).toBe('./scripts/store-manifest.cjs');
    await storeManifest.appxManifestCreated(out);
    const xml = readFileSync(out, 'utf8');
    expect(XMLValidator.validate(xml)).toBe(true);
    expect(storeManifest.manifestProblems(xml, pkg.version)).toEqual([]);
    expect(xml).toContain(`<Identity Name="ShipDocs.BoekhoudenVoorNiks"`);
    expect(xml).toContain(`Publisher='CN=B884F2A1-35F1-4BD8-9EB7-F2746D9FB427'`);
    expect(xml).toContain('<PublisherDisplayName>ShipDocs</PublisherDisplayName>');
    expect(xml).toContain('<Application Id="BoekhoudenVoorNiks" Executable="app\\BoekhoudenVoorNiks.exe" EntryPoint="Windows.FullTrustApplication">');
    expect(xml).toContain('<Resource Language="nl-NL" />');
    expect(xml).toContain('<uap3:Extension Category="windows.appExecutionAlias" Executable="app\\BoekhoudenVoorNiks.exe" EntryPoint="Windows.FullTrustApplication">');
    expect(xml).toContain('Square310x310Logo="assets\\LargeTile.png"');
    expect(xml).not.toMatch(/\$\{/);
    // een afwijking wordt gemeld
    expect(storeManifest.manifestProblems(xml.replace('ShipDocs.BoekhoudenVoorNiks', 'ShipDocs.Anders'), pkg.version)).toEqual(['Identity Name is ShipDocs.BoekhoudenVoorNiks']);
    expect(storeManifest.manifestProblems(xml.replace(/<uap3:Extension[\s\S]*<\/uap3:Extension>/, ''), pkg.version)).toEqual(['de App Execution Alias staat erin', 'de alias start hetzelfde programma als de app']);

    // de controle in CI leest het manifest terug uit het pakket (een zip)
    const appx = Buffer.from(createZip([{ path: 'app/AppxManifest.xml.oud', data: '<Package>oud</Package>' }, { path: 'AppxManifest.xml', data: xml }, { path: '[Content_Types].xml', data: '<Types/>' }]));
    expect(storeManifest.manifestProblems(storeManifest.readManifest(appx), pkg.version)).toEqual([]);
    expect(() => storeManifest.readManifest(Buffer.from('geen pakket'))).toThrow(/niet gevonden/);
  });
});
