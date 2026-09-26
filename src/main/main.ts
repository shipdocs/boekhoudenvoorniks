import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase, type Db } from '../db/database';
import { LedgerError } from '../core-ledger/ledger';
import { createServices, type Services } from '../services';
import { createSmtpMailer, verifySmtp } from '../documents/smtp-mailer';
import { createApi, type Api } from './api';
import { renderPdf } from './pdf';
import { SafeStorageSecretStore } from './secrets';
import { backupTo, dailyBackup, restoreFrom } from './backup';
import { wipeDatabase } from './reset';
import { seedDemo } from '../demo/demo';
import { decryptBackup, encryptBackup, isEncryptedBackup } from './encrypted-backup';
import { tmpdir } from 'node:os';
import { HttpOcrProvider } from '../intake/ocr';
import { LocalOcrRuntime } from '../ocr-runtime/runtime';
import { OllamaClassifier } from '../intake/llm-ollama';
import type { FetchLike } from '../integrations/types';
import { ImapSource } from '../mail/imap-source';
import type { PollResult } from '../mail/mail-intake';

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

function dataDir(): string {
  const dir = process.env.GRATIS_BOEKHOUDEN_DATA ?? app.getPath('userData');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function dbPath(): string {
  return join(dataDir(), 'boekhouding.sqlite');
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
  if (!s.mailIn.enabled || s.demoMode || !secrets.get(IMAP_SECRET)) return;
  try {
    await fetchMail();
  } catch (e) {
    console.error('Mail ophalen mislukt', (e as Error).message);
  }
}

const ALLOWED_ATTACHMENTS = ['.pdf', '.jpg', '.jpeg', '.png', '.heic', '.webp', '.xml'];

async function storeAttachment(name: string, data: Uint8Array): Promise<string> {
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
    if (ocr.engine === 'ingebouwd') {
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
    services.classifier.setLlm(ocr.llmUrl && ocr.llmModel ? new OllamaClassifier(ocr.llmUrl, ocr.llmModel, localFetch) : null);
  } catch (e) {
    console.error('LLM-instelling ongeldig', e);
    services.classifier.setLlm(null);
  }
}

function initServices(): void {
  db = openDatabase(dbPath());
  secrets = new SafeStorageSecretStore(db);
  services = createServices(db, {
    pdf: renderPdf,
    mailerFactory: async () => createSmtpMailer(services.settings.get().smtp, secrets.get(SMTP_SECRET)),
    secrets,
    fetch: localFetch,
    storeFile: storeAttachment,
  });
  localOcr = new LocalOcrRuntime(join(dataDir(), 'ocr'), {
    fetch: (url, init) => fetch(url, init) as never,
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
    readAttachment(path) {
      if (!path.startsWith(join(dataDir(), 'bijlagen'))) throw new Error('Alleen bijlagen van de administratie');
      return readFileSync(path);
    },
    async openPath(path) {
      if (!path.startsWith(join(dataDir(), 'bijlagen'))) throw new Error('Alleen bijlagen van de administratie kunnen geopend worden');
      const err = await shell.openPath(path);
      if (err) throw new Error(err);
    },
    async openExternal(url) {
      if (!/^https:\/\//.test(url)) throw new Error('Alleen https-links');
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
    },
    async backupNow() {
      const result = await dialog.showSaveDialog(mainWindow!, {
        defaultPath: join(app.getPath('documents'), `boekhouding-backup-${new Date().toISOString().slice(0, 10)}.sqlite`),
        filters: [{ name: 'Back-up', extensions: ['sqlite'] }],
      });
      if (result.canceled || !result.filePath) return null;
      await backupTo(db, result.filePath);
      return result.filePath;
    },
    async exportEncrypted(password) {
      const result = await dialog.showSaveDialog(mainWindow!, {
        defaultPath: join(app.getPath('documents'), `boekhouding-versleuteld-${new Date().toISOString().slice(0, 10)}.gbbackup`),
        filters: [{ name: 'Versleutelde back-up', extensions: ['gbbackup'] }],
      });
      if (result.canceled || !result.filePath) return null;
      const tmp = join(tmpdir(), `gb-export-${randomUUID()}.sqlite`);
      try {
        await backupTo(db, tmp);
        writeFileSync(result.filePath, encryptBackup(readFileSync(tmp), password));
      } finally {
        try {
          unlinkSync(tmp);
        } catch {
          /* al weg */
        }
      }
      return result.filePath;
    },
    async restoreBackup(password) {
      const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openFile'], filters: [{ name: 'Back-up', extensions: ['sqlite', 'gbbackup'] }] });
      if (result.canceled || !result.filePaths[0]) return false;
      let source = result.filePaths[0];
      const raw = readFileSync(source);
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
        if (isEncryptedBackup(raw)) {
          if (!password) throw new Error('Dit is een versleutelde back-up: vul eerst het wachtwoord in');
          decrypted = source = join(tmpdir(), `gb-restore-${randomUUID()}.sqlite`);
          writeFileSync(source, decryptBackup(raw, password), { mode: 0o600 });
        }
        const confirm = await dialog.showMessageBox(mainWindow!, {
          type: 'warning',
          buttons: ['Annuleren', 'Terugzetten'],
          defaultId: 0,
          message: 'Weet je zeker dat je deze back-up wilt terugzetten?',
          detail: 'De huidige administratie wordt vervangen (er wordt eerst een kopie van gemaakt). De app start daarna opnieuw.',
        });
        if (confirm.response !== 1) return false;
        await dailyBackup(db, join(dataDir(), 'backups'));
        db.close();
        restoreFrom(source, dbPath());
      } finally {
        cleanup();
      }
      app.relaunch();
      app.exit(0);
      return true;
    },
    async resetData(withDemo) {
      localOcr.stop();
      const backup = await wipeDatabase(db, dbPath(), join(dataDir(), 'backups'), join(dataDir(), 'bijlagen'));
      // nieuwe, lege database met verse services; de IPC-handler gebruikt daarna vanzelf de nieuwe api
      initServices();
      if (withDemo) seedDemo(services);
      return { backup };
    },
    appVersion: () => app.getVersion(),
    localOcr: {
      status: () => localOcr.status(),
      install: () => {
        const st = localOcr.startInstall();
        return st;
      },
      uninstall: () => localOcr.uninstall(),
    },
    async checkForUpdates() {
      if (!app.isPackaged) return 'Updates zijn alleen beschikbaar in de geïnstalleerde versie';
      const r = await autoUpdater.checkForUpdates();
      return r?.updateInfo.version && r.updateInfo.version !== app.getVersion() ? `Versie ${r.updateInfo.version} wordt gedownload` : 'Je hebt de nieuwste versie';
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
    await dailyBackup(db, join(dataDir(), 'backups'));
  } catch (e) {
    console.error('Back-up mislukt', e);
  }
  try {
    // afschrijving van afgesloten jaren (na de jaarwisseling)
    services.assets.bookDue();
  } catch (e) {
    console.error('Afschrijving boeken mislukt', e);
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
    title: 'Gratis Boekhouden',
    backgroundColor: '#f6f7f9',
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
const SMOKE_TEST = process.env.GRATIS_BOEKHOUDEN_SMOKE_TEST === '1';
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

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
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

  app.whenReady().then(() => {
    initServices();
    registerIpc();
    createWindow();
    if (SMOKE_TEST) return;
    setTimeout(() => void backgroundTasks(), 10_000);
    setInterval(() => void backgroundTasks(), SIX_HOURS);
    // inkomende post: kort na het opstarten en daarna elk kwartier
    setTimeout(() => void backgroundMail(), 30_000);
    setInterval(() => void backgroundMail(), FIFTEEN_MINUTES);
    if (app.isPackaged) {
      autoUpdater.autoDownload = true;
      void autoUpdater.checkForUpdatesAndNotify().catch((e) => console.error('Update-controle mislukt', e));
    }
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
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
