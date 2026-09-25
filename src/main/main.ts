import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase, type Db } from '../db/database';
import { createServices, type Services } from '../services';
import { createSmtpMailer, verifySmtp } from '../documents/smtp-mailer';
import { createApi, type Api } from './api';
import { renderPdf } from './pdf';
import { SafeStorageSecretStore } from './secrets';
import { backupTo, dailyBackup, restoreFrom } from './backup';
import { HttpOcrProvider } from '../intake/ocr';
import { OllamaClassifier } from '../intake/llm-ollama';
import type { FetchLike } from '../integrations/types';

const SMTP_SECRET = 'smtp:password';
const SIX_HOURS = 6 * 60 * 60 * 1000;

let mainWindow: BrowserWindow | null = null;
let db: Db;
let services: Services;
let api: Api;
let secrets: SafeStorageSecretStore;

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
    services.intake.setOcrProvider(ocr.url ? new HttpOcrProvider(ocr.engine || 'ocr', ocr.url, localFetch) : null);
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
    testSmtp: () => verifySmtp(services.settings.get().smtp, secrets.get(SMTP_SECRET)),
    async backupNow() {
      const result = await dialog.showSaveDialog(mainWindow!, {
        defaultPath: join(app.getPath('documents'), `boekhouding-backup-${new Date().toISOString().slice(0, 10)}.sqlite`),
        filters: [{ name: 'Back-up', extensions: ['sqlite'] }],
      });
      if (result.canceled || !result.filePath) return null;
      await backupTo(db, result.filePath);
      return result.filePath;
    },
    async restoreBackup() {
      const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openFile'], filters: [{ name: 'Back-up', extensions: ['sqlite'] }] });
      if (result.canceled || !result.filePaths[0]) return false;
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
      restoreFrom(result.filePaths[0], dbPath());
      app.relaunch();
      app.exit(0);
      return true;
    },
    appVersion: () => app.getVersion(),
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
    return await (handler as (...a: unknown[]) => unknown)(...args);
  });
}

async function backgroundTasks(): Promise<void> {
  try {
    await dailyBackup(db, join(dataDir(), 'backups'));
  } catch (e) {
    console.error('Back-up mislukt', e);
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
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
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
    setTimeout(() => void backgroundTasks(), 10_000);
    setInterval(() => void backgroundTasks(), SIX_HOURS);
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
    try {
      db?.close();
    } catch {
      /* al gesloten */
    }
  });
}
