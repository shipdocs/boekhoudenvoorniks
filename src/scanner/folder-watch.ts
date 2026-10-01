import { access, lstat, mkdir, readdir, readFile, rename } from 'node:fs/promises';
import { extname, join, parse } from 'node:path';
import { isUbl } from '../intake/ubl';

export interface FolderWatchOptions {
  /** de gekozen bonnenmap, of null als er geen gekozen is (of als hij niet meer aan de regels voldoet) */
  folder: () => Promise<string | null>;
  /** de gekozen map voor de status, zonder controle */
  configured: () => string | null;
  /** zet een bestand in de inbox; `duplicate` = dit bestand hadden we al (zelfde hash) */
  add: (name: string, data: Uint8Array) => Promise<{ documentId: number; duplicate: boolean }>;
  now?: () => number;
  /** zo vaak kijken we in de map (ms) */
  pollMs?: number;
  /** zo lang moet de grootte gelijk blijven voordat een bestand wordt opgepakt (ms) */
  stableMs?: number;
  onProcessed?: () => void;
}

export interface FolderStatus {
  folder: string | null;
  /** de map is te lezen (bestaat en is bereikbaar) */
  reachable: boolean;
  /** bestanden die sinds het opstarten in de inbox zijn gezet */
  processed: number;
  recent: { name: string; at: string; duplicate: boolean }[];
  /** bestanden die zijn blijven staan, met de reden */
  problems: { name: string; reason: string }[];
}

export const PROCESSED_DIR = 'verwerkt';
const MAX_BYTES = 20 * 1024 * 1024;
const TYPES: Record<string, 'jpg' | 'png' | 'pdf' | 'xml'> = { '.jpg': 'jpg', '.jpeg': 'jpg', '.png': 'png', '.pdf': 'pdf', '.xml': 'xml' };

function startsWith(data: Uint8Array, bytes: number[]): boolean {
  return bytes.every((b, i) => data[i] === b);
}

/** Is de inhoud echt wat de naam zegt? (geen programma met .pdf erachter) */
function contentProblem(kind: 'jpg' | 'png' | 'pdf' | 'xml', data: Buffer): string | null {
  if (kind === 'jpg') return startsWith(data, [0xff, 0xd8, 0xff]) ? null : 'is geen jpg-foto';
  if (kind === 'png') return startsWith(data, [0x89, 0x50, 0x4e, 0x47]) ? null : 'is geen png-afbeelding';
  if (kind === 'pdf') return startsWith(data, [0x25, 0x50, 0x44, 0x46]) ? null : 'is geen PDF';
  return isUbl(data.subarray(0, 4096).toString('utf8')) ? null : 'is geen e-factuur (UBL)';
}

/** Bestanden die een synchronisatieprogramma of browser nog aan het schrijven is, en verborgen bestanden. */
function isTemporary(name: string): boolean {
  return name.startsWith('.') || name.startsWith('~') || /\.(tmp|part|partial|crdownload|download)$/i.test(name);
}

/**
 * Bonnenmap (#48): nieuwe bestanden (jpg, png, pdf, xml) in de gekozen map gaan de inbox in en worden
 * daarna verplaatst naar de submap `verwerkt/`. Er wordt nooit iets verwijderd of overschreven. Een
 * bestand dat nog geschreven wordt (bv. door Syncthing of Google Drive) blijft liggen tot de grootte
 * een paar seconden gelijk is. Alleen bestanden direct in de map; submappen en snelkoppelingen niet.
 *
 * Bewust een rustige rondgang om de paar seconden in plaats van meldingen van het besturingssysteem:
 * die werken niet betrouwbaar op gesynchroniseerde mappen en netwerkschijven. Alle bestandstoegang
 * gaat buiten de hoofdlus om: een netwerkschijf die niet reageert, laat de app niet hangen.
 */
export class ReceiptFolderWatch {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private queued: Promise<void> | null = null;
  private readonly seen = new Map<string, { key: string; since: number }>();
  private readonly skipped = new Map<string, { key: string; reason: string }>();
  /** staat al in de inbox, maar verplaatsen lukte nog niet (bv. nog vast bij het synchronisatieprogramma) */
  private readonly toMove = new Map<string, string>();
  private processed = 0;
  private reachable = false;
  private recent: FolderStatus['recent'] = [];
  private readonly now: () => number;
  private readonly stableMs: number;
  private readonly pollMs: number;

  constructor(private readonly opts: FolderWatchOptions) {
    this.now = opts.now ?? Date.now;
    this.pollMs = opts.pollMs ?? 2_000;
    this.stableMs = opts.stableMs ?? 3_000;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.scan(), this.pollMs);
    this.timer.unref();
    void this.scan();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Na het kiezen van een andere map: opnieuw beginnen. */
  reset(): void {
    this.seen.clear();
    this.skipped.clear();
    this.toMove.clear();
    this.recent = [];
    this.processed = 0;
    this.reachable = false;
  }

  status(): FolderStatus {
    const folder = this.opts.configured();
    return { folder, reachable: folder !== null && this.reachable, processed: this.processed, recent: this.recent.slice(0, 10), problems: [...this.skipped].map(([name, s]) => ({ name, reason: s.reason })).slice(0, 20) };
  }

  /**
   * Eén rondgang door de map. Rondgangen overlappen nooit: loopt er al een, dan volgt er daarna nog
   * precies één (hoe vaak er intussen ook om gevraagd wordt).
   */
  scan(): Promise<void> {
    if (!this.running) {
      this.running = this.scanOnce()
        .catch(() => undefined)
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
    const dir = await this.opts.folder();
    if (!dir) {
      this.reachable = false;
      return;
    }
    let names: string[];
    try {
      // alleen gewone bestanden: geen mappen (ook `verwerkt/` niet) en geen snelkoppelingen
      names = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);
      this.reachable = true;
    } catch {
      this.reachable = false;
      return;
    }
    const present = new Set(names);
    for (const map of [this.seen, this.skipped, this.toMove]) for (const name of [...map.keys()]) if (!present.has(name)) map.delete(name);

    for (const name of names) {
      const kind = TYPES[extname(name).toLowerCase()];
      if (!kind || isTemporary(name)) continue;
      const path = join(dir, name);
      let size: number;
      let key: string;
      try {
        const st = await lstat(path);
        if (!st.isFile()) continue;
        size = st.size;
        key = `${st.size}:${st.mtimeMs}`;
      } catch {
        continue; // intussen weg
      }
      if (this.toMove.get(name) === key) {
        // staat al in de inbox: alleen het verplaatsen nog een keer proberen
        if (await this.move(dir, name)) {
          this.toMove.delete(name);
          this.skipped.delete(name);
        }
        continue;
      }
      if (this.skipped.get(name)?.key === key) continue;
      const prev = this.seen.get(name);
      if (!prev || prev.key !== key) {
        this.skipped.delete(name);
        this.toMove.delete(name);
        this.seen.set(name, { key, since: this.now() });
        continue;
      }
      // nog in beweging, of nog leeg (een synchronisatieprogramma maakt het bestand soms eerst leeg aan)
      if (this.now() - prev.since < this.stableMs || size === 0) continue;
      if (size > MAX_BYTES) {
        this.skipped.set(name, { key, reason: 'is te groot (maximaal 20 MB)' });
        continue;
      }
      await this.process(dir, name, key, kind, size);
    }
  }

  private async process(dir: string, name: string, key: string, kind: 'jpg' | 'png' | 'pdf' | 'xml', size: number): Promise<void> {
    const path = join(dir, name);
    const skip = (reason: string) => void this.skipped.set(name, { key, reason });
    let data: Buffer;
    try {
      data = await readFile(path);
    } catch {
      return skip('kon niet gelezen worden');
    }
    // tijdens het lezen toch nog gegroeid: de volgende rondgang opnieuw
    if (data.length !== size) return void this.seen.delete(name);
    const problem = contentProblem(kind, data);
    if (problem) return skip(problem);
    let duplicate: boolean;
    try {
      ({ duplicate } = await this.opts.add(name, data));
    } catch (e) {
      return skip(`kon niet in de inbox gezet worden: ${(e as Error).message}`.slice(0, 200));
    }
    this.processed++;
    this.recent.unshift({ name, at: new Date(this.now()).toISOString(), duplicate });
    this.recent = this.recent.slice(0, 10);
    this.seen.delete(name);
    if (!(await this.move(dir, name))) {
      // staat wel in de inbox; elke rondgang proberen we het verplaatsen opnieuw
      this.toMove.set(name, key);
      skip(`staat in de inbox, maar kon nog niet naar de map ${PROCESSED_DIR} verplaatst worden`);
    }
    this.opts.onProcessed?.();
  }

  /** Naar `verwerkt/`, onder een naam die daar nog niet bestaat. Onwaar als het (nu) niet lukt. */
  private async move(dir: string, name: string): Promise<boolean> {
    try {
      const target = join(dir, PROCESSED_DIR);
      await mkdir(target, { recursive: true });
      await rename(join(dir, name), await freeName(target, name));
      return true;
    } catch {
      return false;
    }
  }
}

/** Een naam in `dir` die nog niet bestaat: bon.jpg, bon (2).jpg, bon (3).jpg, … Nooit overschrijven. */
async function freeName(dir: string, name: string): Promise<string> {
  const { name: base, ext } = parse(name);
  const exists = (path: string) => access(path).then(() => true, () => false);
  let candidate = join(dir, name);
  for (let i = 2; await exists(candidate); i++) candidate = join(dir, `${base} (${i})${ext}`);
  return candidate;
}
