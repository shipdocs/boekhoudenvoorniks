import { watch, type FSWatcher } from 'node:fs';
import { STABLE_MS } from '../import/statement-folder';

/**
 * Op de map met gedownloade afschriften letten (#184): bij een nieuw bestand (fs.watch) even later kijken,
 * en daarnaast elke paar minuten, omdat fs.watch niet overal alles meldt. Dit kijkt alleen wanneer; wát er
 * gelezen wordt en of het een afschrift is, beslist `scan` (StatementFolder.scan). Uit = nergens op letten.
 */
export interface StatementWatchDeps {
  /** de map waar de gebruiker voor koos, of null als het uit staat */
  folder(): string | null;
  scan(): Promise<{ found: number; waiting: boolean }>;
  /** er is een afschrift gevonden waarover de app "Inlezen?" gaat vragen */
  onFound(found: number): void;
  /** wachttijden in ms (korter in tests) */
  settleMs?: number;
  intervalMs?: number;
}

export class StatementWatch {
  private watcher: FSWatcher | null = null;
  private soon: NodeJS.Timeout | null = null;
  private every: NodeJS.Timeout | null = null;
  private active = false;

  constructor(private readonly deps: StatementWatchDeps) {}

  /** (Opnieuw) beginnen volgens de instelling van nu; staat het uit, dan stopt alles. */
  start(): void {
    this.stop();
    const dir = this.deps.folder();
    if (!dir) return;
    this.active = true;
    try {
      this.watcher = watch(dir, { persistent: false }, () => this.lookSoon(this.deps.settleMs ?? 2000));
      // de map is weg of niet te volgen: de controle elke paar minuten blijft over
      this.watcher.on('error', () => {
        this.watcher?.close();
        this.watcher = null;
      });
    } catch (e) {
      console.error('Op de map met afschriften letten lukt niet', (e as Error).message);
    }
    this.every = setInterval(() => void this.look(), this.deps.intervalMs ?? 5 * 60 * 1000);
    this.every.unref();
    this.lookSoon(this.deps.settleMs ?? 2000);
  }

  stop(): void {
    this.active = false;
    this.watcher?.close();
    this.watcher = null;
    if (this.soon) clearTimeout(this.soon);
    if (this.every) clearInterval(this.every);
    this.soon = this.every = null;
  }

  private lookSoon(delay: number): void {
    if (this.soon) clearTimeout(this.soon);
    this.soon = setTimeout(() => {
      this.soon = null;
      void this.look();
    }, delay);
    this.soon.unref();
  }

  private async look(): Promise<void> {
    try {
      const r = await this.deps.scan();
      if (r.found > 0) this.deps.onFound(r.found);
      // een bestand dat nog aan het downloaden lijkt: zo meteen nog een keer kijken
      if (r.waiting && this.active) this.lookSoon(STABLE_MS + 1000);
    } catch (e) {
      console.error('Kijken in de map met afschriften mislukt', (e as Error).message);
    }
  }
}
