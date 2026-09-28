import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import { notesAsText, updateErrorText } from './update-notes';

/** Wat de renderer over updates laat zien. */
export interface UpdateStatus {
  /** uit = niet automatisch; klaar = gedownload, wordt geïnstalleerd bij afsluiten */
  state: 'uit' | 'wacht' | 'zoeken' | 'downloaden' | 'klaar' | 'fout';
  version: string | null;
  /** wat er nieuw is, als platte tekst */
  notes: string | null;
  percent: number | null;
  error: string | null;
}

const FOUR_HOURS = 4 * 60 * 60 * 1000;

/**
 * Automatisch bijwerken (standaard aan): elke paar uur kijken, op de achtergrond downloaden en
 * installeren bij het afsluiten, of eerder met "Nu herstarten". Uit = de app kijkt niet zelf;
 * "Zoek naar updates" in Instellingen werkt dan nog wel.
 */
export class Updates {
  status: UpdateStatus = { state: 'uit', version: null, notes: null, percent: null, error: null };
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly emit: (status: UpdateStatus) => void,
    private readonly enabled: () => boolean,
  ) {
    autoUpdater.on('checking-for-update', () => this.set({ state: 'zoeken', error: null }));
    autoUpdater.on('update-not-available', () => this.set({ state: this.enabled() ? 'wacht' : 'uit' }));
    autoUpdater.on('update-available', (info) => this.set({ state: autoUpdater.autoDownload ? 'downloaden' : 'wacht', version: info.version, notes: notesAsText(info.releaseNotes) }));
    autoUpdater.on('download-progress', (p) => this.set({ state: 'downloaden', percent: Math.round(p.percent) }));
    autoUpdater.on('update-downloaded', (info) => this.set({ state: 'klaar', version: info.version, notes: notesAsText(info.releaseNotes) ?? this.status.notes, percent: 100 }));
    autoUpdater.on('error', (e) => this.set({ state: 'fout', error: updateErrorText(e) }));
  }

  private set(patch: Partial<UpdateStatus>): void {
    // een klaarstaande update blijft klaarstaan, ook als een latere controle niets nieuws vindt
    if (this.status.state === 'klaar' && patch.state && patch.state !== 'klaar' && patch.state !== 'fout') return;
    this.status = { ...this.status, ...patch };
    this.emit(this.status);
  }

  /** (Opnieuw) instellen volgens de instelling; bij het starten en als je de schakelaar omzet. */
  configure(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const on = this.enabled();
    autoUpdater.autoDownload = on;
    autoUpdater.autoInstallOnAppQuit = on || this.status.state === 'klaar';
    if (!app.isPackaged) return;
    if (this.status.state !== 'klaar') this.set({ state: on ? 'wacht' : 'uit' });
    if (!on) return;
    const check = () => void autoUpdater.checkForUpdates().catch((e) => this.set({ state: 'fout', error: updateErrorText(e) }));
    setTimeout(check, 20_000);
    this.timer = setInterval(check, FOUR_HOURS);
  }

  /** "Zoek naar updates": ook als automatisch uit staat (dan download je hem bewust zelf). */
  async checkNow(): Promise<string> {
    if (!app.isPackaged) return 'Updates zijn alleen beschikbaar in de geïnstalleerde versie';
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    let r;
    try {
      r = await autoUpdater.checkForUpdates();
    } catch (e) {
      throw new Error(updateErrorText(e));
    }
    const v = r?.updateInfo.version;
    return v && v !== app.getVersion() ? `Versie ${v} wordt gedownload. Hij wordt geïnstalleerd als je de app sluit.` : 'Je hebt de nieuwste versie';
  }

  /** "Nu herstarten": installeren en de app opnieuw openen. */
  install(): void {
    if (this.status.state !== 'klaar') throw new Error('Er staat geen update klaar');
    autoUpdater.quitAndInstall(false, true);
  }
}
