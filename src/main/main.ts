import { app, BrowserWindow, dialog, ipcMain, Notification, safeStorage, session, shell } from 'electron';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase, openReadonly, type Db } from '../db/database';
import { LedgerError } from '../core-ledger/ledger';
import { createServices, type Services } from '../services';
import { SettingsService } from '../settings/settings';
import { createSmtpMailer, verifySmtp } from '../documents/smtp-mailer';
import { createApi, type Api } from './api';
import { renderPdf } from './pdf';
import { SafeStorageSecretStore } from './secrets';
import { createBackupBundle, dailyBackup, extractBundle, isBackupBundle, restoreCompleteBackup, restoreLegacyDatabase, validateBackup, validateCompleteBackup, writeCompleteBackup } from './backup';
import { wipeDatabase } from './reset';
import { seedDemo } from '../demo/demo';
import { decryptBackup, encryptBackup, isEncryptedBackup } from './encrypted-backup';
import { tmpdir } from 'node:os';
import { HttpOcrProvider } from '../intake/ocr';
import { CliAiProvider, cliEnv, findCli } from '../intake/ocr-cli';
import { nodeCliRunner, tempWorkspace } from './cli-runner';
import { checkCli, openLoginTerminal, programExists } from './assistant-tools';
import { LocalOcrRuntime } from '../ocr-runtime/runtime';
import { OllamaClassifier } from '../intake/llm-ollama';
import { JevClassifier } from '../intake/llm-jev';
import { ONLINE_HELP } from '../shared/online-help';
import type { FetchLike } from '../integrations/types';
import { ImapSource } from '../mail/imap-source';
import { autoUpdater } from 'electron-updater';
import { Updates } from './updates';
import { startMcp } from '../mcp/start';
import { hasOldMcp, mcpCommands } from '../mcp/names';
import type { PollResult } from '../mail/mail-intake';
import { isPathInside } from './path-security';
import { CHOICE_SESSION, handOverLocalState, markComplete, resolveDataDir, resolveForMcp, sharedDataDir, writeChoice, writePointer, type DataDirResolution, type MigrationOutcome } from './data-dir';
import { chooseAfterFailedMigration, chooseOldFolder, confirmSyncFolder, migrateWithProgress, pickDataFolder, refuseDataFolder } from './data-dir-app';
import { isWindowsStore, mcpCommand as mcpCommandFor, migrateForStore, READ_ONLY_MESSAGE, readOnlyError, storeFallbackHint, storeFirstStartNotice, type StartNotice } from './windows-store';
import { STORE_LLAMA_CPP } from '../ocr-runtime/manifest';
import { Administrations, readAdministrationFile } from './administrations';
import { ExchangeService, sanitizeForExchange, type OfficeProfile } from '../exchange/exchange';
import { generateOfficeKeys } from '../exchange/crypto';
import { LICENSE_API_URL } from '../license/license';
import { today } from '../shared/dates';
import Database from 'better-sqlite3';

const SMTP_SECRET = 'smtp:password';
const IMAP_SECRET = 'imap:password';
const FIFTEEN_MINUTES = 15 * 60 * 1000;
const SIX_HOURS = 6 * 60 * 60 * 1000;

let mainWindow: BrowserWindow | null = null;
let db: Db;
let services: Services;
let api: Api;
let secrets: SafeStorageSecretStore;
let localOcr: LocalOcrRuntime;

/** De versie uit de Microsoft Store (MSIX); in de gewone Windows-versie en op Linux altijd onwaar. */
const STORE = isWindowsStore();

/**
 * Alleen in de Store-versie: het overzetten lukte niet en de gebruiker koos "Alleen bekijken". De oude
 * map is dan alleen-lezen geopend; de app schrijft er niets in.
 */
let readOnly = false;

function assertWritable(): void {
  if (readOnly) throw new Error(READ_ONLY_MESSAGE);
}

/** Eigen gegevensmap (tests, rooktest); GRATIS_BOEKHOUDEN_DATA is de naam van vóór de naamswijziging. */
const DATA_ENV = process.env.BOEKHOUDENVOORNIKS_DATA ?? process.env.GRATIS_BOEKHOUDEN_DATA;

/**
 * Waar de gegevens staan als dat niet de map van Chromium (`userData`) is: de oude map in AppData
 * zolang er nog niet is overgezet, of een zelf gekozen map. Zie `resolveDataDir`.
 */
let dataRoot: string | null = null;

/** Map met alle administraties (en het gedeelde OCR-model). */
function rootDir(): string {
  const dir = DATA_ENV ?? dataRoot ?? app.getPath('userData');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function administrations(): Administrations {
  return new Administrations(rootDir());
}

/** Map van de open administratie: database, bijlagen, back-ups. */
function dataDir(): string {
  const dir = administrations().dirFor(administrations().current());
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Het kantoor op deze computer (bij de boekhouder): gedeeld door alle administraties, dus niet in een
 * database maar in de gegevensmap. De privésleutel is versleuteld met de sleutelopslag van het
 * besturingssysteem.
 */
function officeFile(): string {
  return join(rootDir(), 'kantoor.json');
}

/** Het kantoor, of waarom het niet te openen is (fail-closed: nooit een half profiel). */
function officeState(): { profile: OfficeProfile | null; problem: string | null } {
  if (!existsSync(officeFile())) return { profile: null, problem: null };
  try {
    const raw = JSON.parse(readFileSync(officeFile(), 'utf8')) as { office: string; email: string; publicKey: string; privateKey: string };
    if (!secrets.available) return { profile: null, problem: 'De sleutelhanger van je computer is niet beschikbaar, dus de sleutel van je kantoor kan nu niet geopend worden.' };
    return { profile: { office: raw.office, email: raw.email, publicKey: raw.publicKey, privateKey: safeStorage.decryptString(Buffer.from(raw.privateKey, 'base64')) }, problem: null };
  } catch {
    return { profile: null, problem: 'De sleutel van je kantoor kan niet geopend worden (bijvoorbeeld na een nieuwe installatie of een andere sleutelhanger).' };
  }
}

function readOffice(): OfficeProfile | null {
  return officeState().profile;
}

/**
 * `newKey`: bewust een nieuwe kantoorsleutel (klanten koppelen dan opnieuw met een nieuwe uitnodiging).
 * `keys`: de sleutel van een collega overnemen (gedeelde kantoorsleutel).
 */
function saveOffice(input: { office: string; email: string; newKey?: boolean; keys?: { publicKey: string; privateKey: string } }): OfficeProfile {
  assertWritable();
  if (!input.office.trim()) throw new Error('Vul de naam van je kantoor in');
  if (!secrets.available) throw new Error('Veilige opslag is niet beschikbaar op dit systeem (geen sleutelhanger gevonden); de sleutel van je kantoor kan niet veilig bewaard worden');
  const state = officeState();
  if (state.problem && !input.newKey && !input.keys) throw new Error(`${state.problem} Maak een nieuwe kantoorsleutel; je klanten koppelen dan opnieuw met een nieuwe uitnodiging.`);
  const keys = input.keys ?? (input.newKey ? null : state.profile) ?? generateOfficeKeys();
  const profile: OfficeProfile = { office: input.office.trim(), email: input.email.trim(), publicKey: keys.publicKey, privateKey: keys.privateKey };
  writeFileSync(officeFile(), JSON.stringify({ office: profile.office, email: profile.email, publicKey: profile.publicKey, privateKey: safeStorage.encryptString(profile.privateKey).toString('base64') }), { mode: 0o600 });
  return profile;
}

/** Export van een klant: uitpakken als nieuwe administratie (de kopie), klaarzetten en openen. */
async function openClientExport(data: Uint8Array): Promise<{ company: string; exchange: number; endDate: string }> {
  assertWritable();
  const profile = readOffice();
  if (!profile) throw new Error('Vul eerst de naam van je kantoor in (Instellingen > Administraties)');
  const opened = ExchangeService.openExport(profile, data, app.getVersion());
  const result = { company: opened.meta.company, exchange: opened.header.uitwisseling, endDate: opened.header.einddatum };
  const admins = administrations();
  // al ingelezen? dan die kopie openen, niet nog een
  const existing = admins.list(readAdministrationFile).find((a) => a.id === opened.header.administratie && a.officeCopy?.exchange === opened.header.uitwisseling);
  if (existing) {
    await openAdministration(existing.key);
    return result;
  }
  const key = admins.create(`${opened.meta.company || 'Klant'} uitwisseling ${opened.header.uitwisseling}`);
  const dir = admins.dirFor(key);
  try {
    extractBundle(opened.bundle, dir);
    const copyDb = openDatabase(join(dir, 'boekhouding.sqlite'));
    try {
      const copyServices = createServices(copyDb, {
        pdf: renderPdf,
        mailerFactory: async () => { throw new Error('In de kopie van een klant gaat er geen e-mail naar buiten'); },
        secrets: new SafeStorageSecretStore(copyDb),
        fetch: localFetch,
        storeFile: storeAttachment,
      });
      copyServices.exchange.initCopy(opened.header, opened.meta, profile.office);
    } finally {
      copyDb.close();
    }
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  await openAdministration(key);
  return result;
}

/** POST naar de licentie-Worker; een foutmelding van de Worker ("Voor de factuur ontbreekt …") komt zo door. */
async function postLicense<T>(path: string, body: unknown, managementKey?: string): Promise<T> {
  const res = await fetch(`${LICENSE_API_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(managementKey ? { authorization: `Bearer ${managementKey}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await res.json().catch(() => ({}))) as T & { fout?: string };
  if (!res.ok) throw new Error(data.fout ?? `De licentieserver gaf een fout (${res.status}); probeer het later opnieuw`);
  return data;
}

/** Andere administratie openen: de huidige netjes sluiten, de andere openen en het venster verversen. */
async function openAdministration(key: string): Promise<void> {
  assertWritable();
  const admins = administrations();
  if (key === admins.current()) return;
  // eerst controleren of hij bestaat (gooit ook bij een ongeldige sleutel), vóór we iets sluiten
  if (!existsSync(join(admins.dirFor(key), 'boekhouding.sqlite')) && key !== '') throw new Error('Deze administratie bestaat niet (meer)');
  const current = dataDir();
  try {
    await dailyBackup(db, join(current, 'backups'), current);
  } catch (e) {
    console.error('Back-up vóór wisselen mislukt', e);
  }
  localOcr.stop();
  db.close();
  admins.select(key);
  backupBeforeUpgrade();
  initServices();
  mainWindow?.webContents.reload();
}

function dbPath(): string {
  return join(dataDir(), 'boekhouding.sqlite');
}

/** Koppeling (opnieuw) toevoegen onder de huidige naam; een koppeling onder de oude naam gaat eerst weg. */
async function registerMcp(kind: 'claude-code' | 'codex', cli: string) {
  const { command, args } = mcpCommand();
  const { remove, add } = mcpCommands(kind, command, args);
  const opts = { cwd: app.getPath('home'), input: '', timeoutMs: 30_000, env: cliEnv(cli) };
  if (hasOldMcp(kind, app.getPath('home'))) await nodeCliRunner(cli, remove, opts);
  return nodeCliRunner(cli, add, opts);
}

/** Na de naamswijziging: een koppeling onder de oude naam wijst naar het oude programma; zet hem om. */
async function migrateMcp(): Promise<void> {
  const s = services.settings.get().ocr;
  for (const [kind, stored] of [['claude-code', s.claudeCodePath], ['codex', s.codexPath]] as const) {
    if (!hasOldMcp(kind, app.getPath('home'))) continue;
    const cli = stored || findCli(kind);
    if (!cli) continue;
    try {
      const r = await registerMcp(kind, cli);
      console.log(`Koppeling ${kind} omgezet naar de nieuwe naam: ${r.code === 0 ? 'gelukt' : `${r.stdout}${r.stderr}`.trim().slice(0, 200)}`);
    } catch (e) {
      console.error(`Koppeling ${kind} omzetten mislukt`, e);
    }
  }
}

/** Hoe Claude Code/Codex de koppeling start; zie `mcpCommand` in windows-store.ts. */
function mcpCommand(): { command: string; args: string[] } {
  return mcpCommandFor({ store: STORE, localAppData: process.env.LOCALAPPDATA, appImage: process.env.APPIMAGE, isPackaged: app.isPackaged, execPath: process.execPath, appPath: app.getAppPath() });
}

function emit(event: string, payload: unknown): void {
  mainWindow?.webContents.send('app-event', event, payload);
}

/** Eén ophaalronde tegelijk; een tweede verzoek wacht op de lopende. */
let mailRun: Promise<PollResult> | null = null;

function fetchMail(): Promise<PollResult> {
  mailRun ??= (async () => {
    const source = await ImapSource.connect(services.settings.get().mailIn, secrets.get(IMAP_SECRET));
    try {
      const r = await services.mail.poll(source);
      if (r.documents + r.onlineInvoices + r.fromCustomers > 0) emit('auto-processed', r);
      return r;
    } finally {
      await source.close();
    }
  })().finally(() => {
    mailRun = null;
  });
  return mailRun;
}

async function backgroundMail(): Promise<void> {
  const s = services.settings.get();
  if (!s.mailIn.enabled || services.settings.outboundBlocked() || !secrets.get(IMAP_SECRET)) return;
  try {
    await fetchMail();
  } catch (e) {
    console.error('Mail ophalen mislukt', (e as Error).message);
  }
}

const ALLOWED_ATTACHMENTS = ['.pdf', '.jpg', '.jpeg', '.png', '.heic', '.webp', '.xml'];

async function storeAttachment(name: string, data: Uint8Array): Promise<string> {
  assertWritable();
  const year = new Date().getFullYear();
  const dir = join(dataDir(), 'bijlagen', String(year));
  mkdirSync(dir, { recursive: true });
  const ext = extname(name).toLowerCase();
  if (!ALLOWED_ATTACHMENTS.includes(ext)) throw new Error('Alleen PDF, e-factuur (XML) of foto (jpg, png, heic, webp) als bijlage');
  if (data.byteLength > 20 * 1024 * 1024) throw new Error('Bijlage is te groot (max 20 MB)');
  const target = join(dir, `${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}-${basename(name).replace(/[^\w.-]+/g, '_')}`);
  writeFileSync(target, Buffer.from(data));
  return target;
}

const localFetch: FetchLike = (url, init) => fetch(url, init);

/** Lokale OCR/LLM volgens de instellingen (alleen localhost). */
function configureLocalAi(): void {
  const { ocr } = services.settings.get();
  try {
    if (ocr.engine === 'claude-code' || ocr.engine === 'codex') {
      // bonnen lezen met de eigen Claude Code of Codex van de gebruiker (foto gaat naar Anthropic/OpenAI)
      localOcr.stop();
      // alleen het programma dat de gebruiker liet zoeken of zelf koos
      const cmd = ocr.engine === 'codex' ? ocr.codexPath : ocr.claudeCodePath;
      services.intake.setOcrProvider(programExists(cmd) ? new CliAiProvider(ocr.engine, cmd, nodeCliRunner, tempWorkspace) : null);
    } else if (ocr.engine === 'ingebouwd') {
      // ingebouwde herkenning (#9): alleen als die gedownload is; de server start pas bij de eerste bon
      services.intake.setOcrProvider(localOcr.isInstalled() ? localOcr.provider(localFetch) : null);
    } else {
      localOcr.stop();
      services.intake.setOcrProvider(ocr.url ? new HttpOcrProvider(ocr.engine || 'ocr', ocr.url, localFetch) : null);
    }
  } catch (e) {
    console.error('OCR-instelling ongeldig', e);
    services.intake.setOcrProvider(null);
  }
  try {
    if (ONLINE_HELP.available && ocr.onlineCategoryHelp) {
      // online hulp (JEV) vervangt de lokale AI; per aanroep opnieuw gecontroleerd: opt-in én actief abonnement
      services.classifier.setLlm(
        new JevClassifier({
          fetch: localFetch,
          allowed: () => ONLINE_HELP.available && services.settings.get().ocr.onlineCategoryHelp && services.license.status(today()).state === 'actief',
          credentials: () => ({ administrationId: services.settings.administrationId(), managementKey: services.license.managementKey() }),
          appVersion: app.getVersion(),
        }),
      );
    } else {
      services.classifier.setLlm(ocr.llmUrl && ocr.llmModel ? new OllamaClassifier(ocr.llmUrl, ocr.llmModel, localFetch) : null);
    }
  } catch (e) {
    console.error('LLM-instelling ongeldig', e);
    services.classifier.setLlm(null);
  }
}

/**
 * Eerste start van een nieuwe versie: eerst een kopie van de administratie, want een nieuwe versie
 * kan de database aanpassen. De app is dan nog niet open, dus een bestandskopie is veilig.
 */
function backupBeforeUpgrade(): void {
  const marker = join(dataDir(), 'versie.txt');
  const current = app.getVersion();
  const previous = existsSync(marker) ? readFileSync(marker, 'utf8').trim() : null;
  if (previous === current) return;
  try {
    if (existsSync(dbPath())) {
      const dir = join(dataDir(), 'backups');
      mkdirSync(dir, { recursive: true });
      const target = join(dir, `voor-versie-${current}-van-${previous ?? 'onbekend'}-${new Date().toISOString().slice(0, 10)}.sqlite`);
      copyFileSync(dbPath(), target);
      if (existsSync(`${dbPath()}-wal`)) copyFileSync(`${dbPath()}-wal`, `${target}-wal`);
    }
    writeFileSync(marker, current);
  } catch (e) {
    console.error('Kopie vóór de update mislukt', e);
  }
}

let updates: Updates | null = null;

function initServices(): void {
  db = readOnly ? openReadonly(dbPath()) : openDatabase(dbPath());
  secrets = new SafeStorageSecretStore(db);
  services = createServices(db, {
    pdf: renderPdf,
    mailerFactory: async () => createSmtpMailer(services.settings.get().smtp, secrets.get(SMTP_SECRET)),
    secrets,
    fetch: localFetch,
    storeFile: storeAttachment,
  });
  localOcr = new LocalOcrRuntime(join(rootDir(), 'ocr'), {
    fetch: (url, init) => fetch(url, init) as never,
    // Store-versie: alleen de vaste build, pas na toestemming, en bij een fout een verwijzing naar de gewone versie
    ...(STORE ? { pinned: STORE_LLAMA_CPP, failureHint: storeFallbackHint('het lezen van bonnen op deze computer') } : {}),
  });
  configureLocalAi();
  api = createApi(services, {
    async saveFile(defaultName, content, filters) {
      const result = await dialog.showSaveDialog(mainWindow!, { defaultPath: join(app.getPath('documents'), defaultName), filters });
      if (result.canceled || !result.filePath) return null;
      writeFileSync(result.filePath, content);
      return result.filePath;
    },
    storeAttachment,
    reconfigureLocalAi: configureLocalAi,
    findCli: (kind) => findCli(kind),
    programExists,
    pickProgram: async (title) => {
      const r = await dialog.showOpenDialog(mainWindow!, { title, properties: ['openFile'] });
      return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
    },
    checkCli,
    openLoginTerminal: (kind, path) => openLoginTerminal(kind, path),
    mcpCommand,
    connectMcp: async (kind, cli) => {
      const r = await registerMcp(kind, cli);
      const out = `${r.stdout}\n${r.stderr}`;
      if (r.code === 0) return 'Toegevoegd ✓';
      if (/already exists|bestaat al/i.test(out)) return 'Stond er al in ✓';
      throw new Error(`Toevoegen lukte niet. Gebruik de opdracht hieronder in een terminal.${out.trim() ? ` (${out.trim().slice(0, 200)})` : ''}${STORE ? ` ${storeFallbackHint('de koppeling')}` : ''}`);
    },
    readAttachment(path) {
      if (!isPathInside(join(dataDir(), 'bijlagen'), path)) throw new Error('Alleen bijlagen van de administratie');
      return readFileSync(path);
    },
    async openPath(path) {
      if (!isPathInside(join(dataDir(), 'bijlagen'), path)) throw new Error('Alleen bijlagen van de administratie kunnen geopend worden');
      const err = await shell.openPath(path);
      if (err) throw new Error(err);
    },
    async openExternal(url) {
      // https, en een mail aan ons (vragen en feedback); geen andere schema's
      if (!/^https:\/\//.test(url) && !/^mailto:info@shipdocs\.app(\?|$)/.test(url)) throw new Error('Alleen https-links');
      await shell.openExternal(url);
    },
    setSmtpPassword: (pw) => (pw ? secrets.set(SMTP_SECRET, pw) : secrets.delete(SMTP_SECRET)),
    hasSmtpPassword: () => secrets.get(SMTP_SECRET) !== null,
    testSmtp: (smtp, password) => verifySmtp(smtp ?? services.settings.get().smtp, password || secrets.get(SMTP_SECRET)),
    mail: {
      setPassword: (pw) => (pw ? secrets.set(IMAP_SECRET, pw) : secrets.delete(IMAP_SECRET)),
      hasPassword: () => secrets.get(IMAP_SECRET) !== null,
      async test(cfg, password) {
        const source = await ImapSource.connect(cfg ?? services.settings.get().mailIn, password || secrets.get(IMAP_SECRET));
        try {
          const folders = (await source.folders()).map((f) => f.path);
          // geslaagd met een ingetypt wachtwoord: meteen bewaren (zoals bij de uitgaande mail)
          if (password) secrets.set(IMAP_SECRET, password);
          return { folders };
        } finally {
          await source.close();
        }
      },
      fetchNow: () => fetchMail(),
      async saveAsReceipt(id) {
        const source = await ImapSource.connect(services.settings.get().mailIn, secrets.get(IMAP_SECRET));
        try {
          return await services.mail.saveAsReceipt(source, id);
        } finally {
          await source.close();
        }
      },
    },
    async safetyBackup(label) {
      assertWritable();
      const dir = join(dataDir(), 'backups');
      mkdirSync(dir, { recursive: true });
      const target = join(dir, `${label.replace(/[^\w.-]+/g, '_')}-${new Date().toISOString().slice(0, 10)}.gbbackup`);
      await writeCompleteBackup(db, dataDir(), target);
      return target;
    },
    async backupNow() {
      const result = await dialog.showSaveDialog(mainWindow!, {
        defaultPath: join(app.getPath('documents'), `boekhouding-backup-${new Date().toISOString().slice(0, 10)}.gbbackup`),
        filters: [{ name: 'Complete back-up', extensions: ['gbbackup'] }],
      });
      if (result.canceled || !result.filePath) return null;
      await writeCompleteBackup(db, dataDir(), result.filePath);
      return result.filePath;
    },
    async exportEncrypted(password) {
      const result = await dialog.showSaveDialog(mainWindow!, {
        defaultPath: join(app.getPath('documents'), `boekhouding-versleuteld-${new Date().toISOString().slice(0, 10)}.gbbackup`),
        filters: [{ name: 'Versleutelde back-up', extensions: ['gbbackup'] }],
      });
      if (result.canceled || !result.filePath) return null;
      writeFileSync(result.filePath, encryptBackup(await createBackupBundle(db, dataDir()), password), { mode: 0o600 });
      return result.filePath;
    },
    async restoreBackup(password) {
      assertWritable();
      // begin in de map met de automatische back-ups van elke dag, als die er is
      const backups = join(dataDir(), 'backups');
      const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openFile'], filters: [{ name: 'Back-up', extensions: ['sqlite', 'gbbackup'] }], ...(existsSync(backups) ? { defaultPath: backups } : {}) });
      if (result.canceled || !result.filePaths[0]) return false;
      const selected = result.filePaths[0];
      const raw = readFileSync(selected);
      // ontsleutelde kopie: altijd opruimen, ook bij annuleren of een fout
      let decrypted: string | null = null;
      const cleanup = () => {
        if (!decrypted) return;
        try {
          unlinkSync(decrypted);
        } catch {
          /* al weg */
        }
        decrypted = null;
      };
      try {
        let backupData: Buffer = Buffer.from(raw);
        if (isEncryptedBackup(raw)) {
          if (!password) throw new Error('Dit is een versleutelde back-up: vul eerst het wachtwoord in');
          backupData = decryptBackup(raw, password);
        }
        const complete = isBackupBundle(backupData);
        if (complete) validateCompleteBackup(backupData);
        else {
          decrypted = join(tmpdir(), `gb-restore-${randomUUID()}.sqlite`);
          writeFileSync(decrypted, backupData, { mode: 0o600 });
          validateBackup(decrypted);
        }
        const confirm = await dialog.showMessageBox(mainWindow!, {
          type: 'warning',
          buttons: ['Annuleren', 'Terugzetten'],
          defaultId: 0,
          message: 'Weet je zeker dat je deze back-up wilt terugzetten?',
          detail: complete
            ? 'De huidige administratie en bijlagen worden vervangen (er wordt eerst een kopie van gemaakt). De app start daarna opnieuw.'
            : 'Dit is een oude databaseback-up zonder bijlagen. Alleen de boekhouding wordt vervangen; ontbrekende bonnen of facturen kunnen hiermee niet worden hersteld.',
        });
        if (confirm.response !== 1) return false;
        await dailyBackup(db, join(dataDir(), 'backups'), dataDir());
        db.close();
        if (complete) restoreCompleteBackup(backupData, dbPath(), dataDir());
        else restoreLegacyDatabase(decrypted!, dbPath());
      } finally {
        cleanup();
      }
      app.relaunch();
      app.exit(0);
      return true;
    },
    async resetData(withDemo) {
      assertWritable();
      localOcr.stop();
      const backup = await wipeDatabase(db, dbPath(), join(dataDir(), 'backups'), join(dataDir(), 'bijlagen'));
      // nieuwe, lege database met verse services; de IPC-handler gebruikt daarna vanzelf de nieuwe api
      initServices();
      if (withDemo) seedDemo(services);
      return { backup };
    },
    licenseApi: {
      async price() {
        const res = await fetch(`${LICENSE_API_URL}/prijs`, { signal: AbortSignal.timeout(10_000) });
        return res.ok ? ((await res.json()) as { bedrag: string; valuta: string; per: string; inclusiefBtw?: string; btw?: string; proefMaanden?: number }) : null;
      },
      async fetch(administrationId, managementKey) {
        const res = await fetch(`${LICENSE_API_URL}/licentie?administratie=${encodeURIComponent(administrationId)}`, { headers: { authorization: `Bearer ${managementKey}` }, signal: AbortSignal.timeout(15_000) });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`De licentieserver gaf een fout (${res.status}); probeer het later opnieuw`);
        return ((await res.json()) as { token: string }).token;
      },
      start: (input) => postLicense<{ checkout?: string; al?: boolean }>('/start', input),
      cancel: (administrationId, managementKey) => postLicense<{ betaaldTot: string; geldigTot: string }>('/opzeggen', { administratie: administrationId }, managementKey),
    },
    exchange: {
      bundle: () =>
        createBackupBundle(db, dataDir(), (copy) => {
          const d = new Database(copy);
          try {
            sanitizeForExchange(d);
          } finally {
            d.close();
          }
        }),
      office: () => readOffice(),
      officeProblem: () => officeState().problem,
      saveOffice,
      openClientExport,
    },
    administrations: {
      list: () => administrations().list(readAdministrationFile),
      open: (key) => openAdministration(key),
      async create(name) {
        assertWritable();
        if (!name.trim()) throw new Error('Geef de administratie een naam');
        const key = administrations().create(name.trim());
        // de database aanmaken (migraties) met de naam van het bedrijf, daarna openen
        const fresh = openDatabase(join(administrations().dirFor(key), 'boekhouding.sqlite'));
        try {
          const settings = new SettingsService(fresh);
          settings.update({ company: { ...settings.get().company, name: name.trim() } });
        } finally {
          fresh.close();
        }
        await openAdministration(key);
        return key;
      },
    },
    appVersion: () => app.getVersion(),
    windowsStore: STORE,
    readOnly: () => readOnly,
    retryDataMove() {
      app.relaunch();
      app.exit(0);
    },
    localOcr: {
      status: () => localOcr.status(),
      install: () => {
        assertWritable();
        const st = localOcr.startInstall();
        return st;
      },
      uninstall: () => localOcr.uninstall(),
      ...(STORE ? { consent: { runtimeVersion: STORE_LLAMA_CPP.tag, given: () => localOcr.hasConsent(), give: () => (assertWritable(), localOcr.giveConsent()) } } : {}),
    },
    async checkForUpdates() {
      return updates ? updates.checkNow() : 'Updates zijn alleen beschikbaar in de geïnstalleerde versie';
    },
    updates: {
      status: () => updates?.status ?? { state: 'uit', version: null, notes: null, percent: null, error: null },
      install: () => updates?.install(),
      reconfigure: () => updates?.configure(),
    },
  });
}

function registerIpc(): void {
  ipcMain.handle('api', async (event, method: unknown, args: unknown) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('Onbekende afzender');
    if (typeof method !== 'string' || !/^\w+\.\w+$/.test(method) || !Array.isArray(args)) throw new Error('Ongeldige aanroep');
    const [ns, fn] = method.split('.') as [string, string];
    const group = Object.prototype.hasOwnProperty.call(api, ns) ? (api as unknown as Record<string, Record<string, unknown>>)[ns] : undefined;
    const handler = group && Object.prototype.hasOwnProperty.call(group, fn) ? group[fn] : undefined;
    if (typeof handler !== 'function') throw new Error(`Onbekende functie: ${method}`);
    try {
      return await (handler as (...a: unknown[]) => unknown)(...args);
    } catch (e) {
      // de oude map is alleen-lezen open (Store-versie, overzetten mislukt): uitleg in plaats van de fout van SQLite
      const readOnlyProblem = readOnly ? readOnlyError(e) : null;
      if (readOnlyProblem) throw readOnlyProblem;
      // interne boekhoudfouten (journaal, grootboek, gebeurtenissen) zijn vaktaal: niet zo aan de gebruiker tonen
      if (e instanceof LedgerError || /journaalpost|grootboekrekening|tegenboeking|debet|gebeurtenis/i.test(String((e as Error)?.message))) {
        console.error(`Fout in ${method}`, e);
        throw new Error('Er ging iets mis bij het verwerken. Probeer het opnieuw. Blijft het misgaan? Vraag je boekhouder of meld het, dan kijken we mee.');
      }
      throw e;
    }
  });
}

async function backgroundTasks(): Promise<void> {
  try {
    await dailyBackup(db, join(dataDir(), 'backups'), dataDir());
  } catch (e) {
    console.error('Back-up mislukt', e);
  }
  // kopie bij de boekhouder: niets zelf boeken en niets naar buiten, dat doet de klant in zijn eigen administratie
  if (services.settings.officeCopy()) return;
  try {
    // alleen wie ooit een licentie had: verlopen of bijna verlopen → de verlengde ophalen (Mollie incasseert maandelijks)
    if (services.license.needsRefresh(today())) {
      const token = await api.license.refresh().catch(() => null);
      if (token) emit('license', token);
    }
  } catch (e) {
    console.error('Licentie verversen mislukt', e);
  }
  try {
    // afschrijving van afgesloten jaren (na de jaarwisseling)
    services.assets.bookDue();
  } catch (e) {
    console.error('Afschrijving boeken mislukt', e);
  }
  try {
    // bonnen van vóór 0.3.9 die nog gecontroleerd moeten worden en in bv. dollars zijn (#74): nog niets
    // geboekt, dus gewoon opnieuw beoordelen; geboekte aankopen rekent de gebruiker zelf om
    await services.fxRepair.fixDocuments(undefined, { needRate: true });
  } catch (e) {
    console.error('Bonnen in een andere munt omrekenen mislukt', e);
  }
  try {
    const r = services.inbox.autoProcess();
    if (r.matched + r.booked > 0) emit('auto-processed', r);
  } catch (e) {
    console.error('Automatisch verwerken mislukt', e);
  }
  try {
    const r = await services.sender.runAutomaticReminders();
    if (r.sent > 0) {
      new Notification({ title: 'Herinneringen verstuurd', body: `${r.sent} betalingsherinnering(en) verstuurd` }).show();
      emit('reminders', r);
    }
    if (r.failed.length > 0) emit('reminders-failed', r.failed);
  } catch (e) {
    console.error('Herinneringen mislukt', e);
  }
  try {
    const results = await services.integrations.syncAllEnabled();
    if (Object.keys(results).length > 0) emit('integrations', results);
  } catch (e) {
    console.error('Synchronisatie mislukt', e);
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    title: 'BoekhoudenVoorNiks',
    backgroundColor: '#f6f7f9',
    // menubalk (File/Edit/View/Window) blijft uit het zicht; Alt laat hem even zien
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    const devUrl = process.env.VITE_DEV_SERVER_URL;
    if (!(devUrl && url.startsWith(devUrl))) e.preventDefault();
  });
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) void mainWindow.loadURL(devUrl);
  else void mainWindow.loadFile(join(__dirname, '..', '..', 'renderer', 'index.html'));
  mainWindow.on('closed', () => (mainWindow = null));
  if (SMOKE_TEST) {
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        const ok = await mainWindow!.webContents.executeJavaScript('window.bridge.call("app.version", [])');
        // Het scherm moet echt iets tonen: een fout bij het laden van de renderer geeft een leeg venster.
        const rendered = await mainWindow!.webContents.executeJavaScript(
          `new Promise((resolve) => { const t0 = Date.now(); const tick = () => { const n = document.getElementById('root')?.childElementCount ?? 0; if (n > 0) resolve(true); else if (Date.now() - t0 > 15000) resolve(false); else setTimeout(tick, 100); }; tick(); })`,
        );
        if (!rendered) throw new Error('het venster bleef leeg (renderer niet gestart)');
        console.log(`SMOKE OK ${ok}`);
        app.exit(0);
      } catch (e) {
        console.error('SMOKE FAIL', e);
        app.exit(1);
      }
    });
    mainWindow.webContents.once('did-fail-load', (_e, code, desc) => {
      console.error('SMOKE FAIL: laden mislukt', code, desc);
      app.exit(1);
    });
  }
}

/**
 * Rooktest voor de verpakte app (release-workflow): start, open de database, laad het venster
 * en sluit af met code 0. Elke fout in het hoofdproces → code 1 in plaats van een verborgen dialoog.
 */
const SMOKE_TEST = (process.env.BOEKHOUDENVOORNIKS_SMOKE_TEST ?? process.env.GRATIS_BOEKHOUDEN_SMOKE_TEST) === '1';
if (SMOKE_TEST) {
  process.on('uncaughtException', (e) => {
    console.error('SMOKE FAIL', e);
    app.exit(1);
  });
  setTimeout(() => {
    console.error('SMOKE FAIL: timeout');
    app.exit(1);
  }, 60_000).unref();
}

// Nederlandse datumvelden (dd-mm-jjjj) en teksten van Chromium, ook op een Engelstalige computer
app.commandLine.appendSwitch('lang', 'nl');

// "--mcp": de koppeling voor Claude Code/Codex (alleen lezen). Geen venster, geen enkele-instantie-slot:
// de app zelf kan gewoon tegelijk open zijn.
const MCP_MODE = process.argv.includes('--mcp');

// Gegevensmap: de gedeelde map in de thuismap (buiten AppData, zodat verwijderen van de app de
// administratie nooit wist). De interne appnaam (package.json "name") blijft gratis-boekhouden: daaraan
// hangen de Linux-sleutelhanger van de geheimen en de updates over de bestaande installatie.
// Chromium (en dus het enkele-instantie-slot) staat vanaf het begin in de gedeelde map; de gegevens
// uit de oude map in AppData worden na het opstarten overgezet (zie prepareDataDir).
let resolution: DataDirResolution | null = null;
let resolutionError: Error | null = null;
if (!DATA_ENV) {
  const env = { home: app.getPath('home'), appData: app.getPath('appData') };
  const shared = sharedDataDir(env.home);
  if (MCP_MODE) {
    // de koppeling zet niets over en maakt de gedeelde map nooit zelf aan
    try {
      dataRoot = resolveForMcp(env);
      app.setPath('userData', existsSync(shared) ? shared : dataRoot);
    } catch (e) {
      process.stderr.write(`BoekhoudenVoorNiks (koppeling): ${(e as Error).message}\n`);
      app.exit(1);
    }
  } else {
    try {
      resolution = resolveDataDir(env);
    } catch (e) {
      resolutionError = e as Error;
    }
    if (!resolution) {
      // niets aanmaken op de plek van de gegevens; de fout komt zodra er een venster kan
      app.setPath('userData', join(app.getPath('temp'), 'boekhoudenvoorniks-fout'));
    } else if (resolution.kind === 'keuze') {
      // alleen de keuzevraag: Chromium krijgt een wegwerpmap, zodat de gedeelde map nog geen eigen sleutel krijgt
      app.setPath('userData', join(shared, CHOICE_SESSION));
    } else {
      rmSync(join(shared, CHOICE_SESSION), { recursive: true, force: true });
      // de sleutel van de opgeslagen wachtwoorden moet er staan vóór Chromium start
      if (resolution.kind === 'oud') handOverLocalState(resolution.dir, shared);
      app.setPath('userData', shared);
      dataRoot = resolution.dir;
    }
  }
}
const gotLock = MCP_MODE ? false : app.requestSingleInstanceLock();
let preparing = true;
/** Meldingen die na het opstarten één voor één getoond worden. */
const startNotices: StartNotice[] = [];

/** Het overzetten zelf; een fout ná de marker telt als gelukt (alleen de afronding ging mis). */
async function migrate(source: string, target: string): Promise<MigrationOutcome> {
  try {
    return await migrateWithProgress(source, target, !SMOKE_TEST);
  } catch (e) {
    // de marker staat er al: de gedeelde map is compleet, alleen de afronding ging mis
    console.error('Afronden van het overzetten mislukt', e);
    return { status: 'gemigreerd', databases: [], renamedSource: null, movedAside: null, warning: null };
  }
}

/** Waarom de administratie in `root` niet alleen-lezen te openen is, of null als dat kan. */
function viewProblem(root: string): string | null {
  try {
    const admins = new Administrations(root);
    openReadonly(join(admins.dirFor(admins.current()), 'boekhouding.sqlite')).close();
    return null;
  } catch (e) {
    return /andere versie/.test((e as Error).message) ? 'de administratie is van een oudere versie van de app en moet eerst overgezet worden.' : (e as Error).message;
  }
}

function migratedNotice(source: string, target: string, outcome: Extract<MigrationOutcome, { status: 'gemigreerd' }>): StartNotice {
  return {
    type: 'info',
    message: 'Je gegevens staan nu in een vaste map',
    detail:
      `Je administratie staat voortaan in ${target}. Daar blijft hij ook staan als je de app verwijdert of opnieuw installeert.\n\n` +
      (outcome.renamedSource ? `De oude map is bewaard als ${outcome.renamedSource}.` : (outcome.warning ?? `De oude map ${source} is blijven staan.`)) +
      (outcome.movedAside ? `\n\nIn de nieuwe map stond al iets; dat is bewaard in ${outcome.movedAside}.` : '') +
      '\n\nGebruik je de koppeling met Claude Code of Codex? Start dat programma dan opnieuw, zodat het de nieuwe map leest.',
  };
}

/**
 * Na het opstarten, vóór er een database open is: de gegevensmap in orde maken. Onwaar = de app
 * sluit (fout getoond, of de keuze tussen twee oude mappen is gemaakt of geannuleerd).
 */
async function prepareDataDir(): Promise<boolean> {
  if (DATA_ENV) return true;
  if (!resolution) {
    dialog.showErrorBox('BoekhoudenVoorNiks kan je gegevens niet openen', resolutionError?.message ?? 'Onbekende fout');
    app.exit(1);
    return false;
  }
  if (resolution.kind === 'keuze') {
    const chosen = SMOKE_TEST ? null : await chooseOldFolder(resolution.candidates);
    if (chosen) {
      // de keuze onthouden en opnieuw starten: dan staat de sleutel van de gekozen map er vóór Chromium start
      writeChoice(resolution.target, chosen.dir);
      app.relaunch();
    }
    app.exit(SMOKE_TEST ? 1 : 0);
    return false;
  }
  if (resolution.kind === 'nieuw') markComplete(resolution.dir);
  if (resolution.kind !== 'oud') return true;
  const { dir: source, target } = resolution;
  if (STORE) return prepareForStore(source, target);
  const outcome = await migrate(source, target);
  if (outcome.status === 'gemigreerd') {
    dataRoot = target;
    console.log(`Gegevens overgezet van ${source} naar ${target}`);
    startNotices.push(migratedNotice(source, target, outcome));
  } else {
    console.error(`Gegevens overzetten niet gelukt (${outcome.status}): ${outcome.reason}`);
    startNotices.push({
      type: 'warning',
      message: 'Je gegevens zijn nog niet overgezet',
      detail: `${outcome.status === 'mislukt' ? `Het overzetten naar ${target} lukte niet (${outcome.reason}).` : outcome.reason}\n\nEr is niets veranderd: je werkt gewoon verder vanuit ${source}. Bij de volgende start probeert de app het opnieuw.`,
    });
  }
  return true;
}

/**
 * Store-versie: lukt het overzetten niet, dan werkt de app niet verder in de oude map (wat een
 * Store-app in AppData schrijft, verdwijnt bij verwijderen). De gebruiker kiest: opnieuw, een eigen map,
 * of alleen bekijken. Zie `migrateForStore`.
 */
async function prepareForStore(source: string, target: string): Promise<boolean> {
  const result = await migrateForStore({
    source,
    target,
    appData: app.getPath('appData'),
    migrate,
    viewProblem: () => viewProblem(source),
    // de rooktest kan niets kiezen: een mislukte poging is daar gewoon een fout
    choose: async (failure) => (SMOKE_TEST ? 'afsluiten' : chooseAfterFailedMigration(failure)),
    pickFolder: () => pickDataFolder(app.getPath('home')),
    refuse: refuseDataFolder,
    confirmSyncFolder,
    remember: (dir) => writePointer(app.getPath('home'), dir),
  });
  if (result.kind === 'afsluiten') {
    app.exit(SMOKE_TEST ? 1 : 0);
    return false;
  }
  if (result.kind === 'alleen-lezen') {
    console.error(`Gegevens overzetten niet gelukt (${result.reason}); de oude map ${source} is alleen-lezen geopend`);
    readOnly = true;
    return true;
  }
  dataRoot = result.dir;
  console.log(`Gegevens overgezet van ${source} naar ${result.dir}`);
  startNotices.push(migratedNotice(source, result.dir, result.outcome));
  return true;
}

/** De meldingen na het opstarten (overzetten gelukt of niet, eerste start uit de Store); houden de app niet tegen. */
async function showStartNotices(): Promise<void> {
  for (let notice = startNotices.shift(); notice && mainWindow; notice = startNotices.shift()) {
    await dialog.showMessageBox(mainWindow, { ...notice, title: 'BoekhoudenVoorNiks', buttons: ['OK'] });
  }
}
if (MCP_MODE) {
  app.dock?.hide();
  if (DATA_ENV || dataRoot) startMcp(dbPath(), app.getVersion()).then(
    () => app.exit(0),
    (e) => {
      process.stderr.write(`BoekhoudenVoorNiks (koppeling): ${(e as Error).message}\n`);
      app.exit(1);
    },
  );
} else if (!gotLock) {
  // In rooktestmodus is een tweede instantie een fout, geen stille succesvolle exit.
  if (SMOKE_TEST) console.error('SMOKE FAIL: er draait al een instantie');
  app.exit(SMOKE_TEST ? 1 : 0);
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    if (!(await prepareDataDir())) return;
    if (!SMOKE_TEST && !readOnly) backupBeforeUpgrade();
    // De renderer gebruikt geen browserrechten; wijs onverwachte camera-, locatie- en
    // notificatieverzoeken daarom standaard af.
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    initServices();
    registerIpc();
    createWindow();
    preparing = false;
    if (SMOKE_TEST) return;
    if (STORE && !DATA_ENV) {
      const first = storeFirstStartNotice(app.getPath('userData'));
      if (first) startNotices.push(first);
    }
    void showStartNotices();
    // alleen bekijken: geen back-ups, post of automatisch verwerken in de oude map
    if (!readOnly) {
      setTimeout(() => void backgroundTasks(), 10_000);
      setTimeout(() => void migrateMcp(), 20_000);
      setInterval(() => void backgroundTasks(), SIX_HOURS);
      // inkomende post: kort na het opstarten en daarna elk kwartier
      setTimeout(() => void backgroundMail(), 30_000);
      setInterval(() => void backgroundMail(), FIFTEEN_MINUTES);
    }
    // automatisch bijwerken (standaard aan; uit te zetten in Instellingen). In de Store-versie doet dit niets:
    // de Store werkt de app bij en electron-updater wordt nooit aangeroepen.
    updates = new Updates((status) => emit('update', status), () => services.settings.get().autoUpdate, { isPackaged: app.isPackaged, version: () => app.getVersion(), store: STORE, updater: () => autoUpdater });
    updates.configure();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    // het voortgangsvenster van het overzetten sluit vóór het hoofdvenster er is
    if (preparing) return;
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', () => {
    localOcr?.stop();
    try {
      db?.close();
    } catch {
      /* al gesloten */
    }
  });
}
