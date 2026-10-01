import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import type { Db } from '../db/database';
import type { SettingsService } from '../settings/settings';
import { sameBankName } from '../shared/bank-name';
import { addDays, today, type IsoDate } from '../shared/dates';
import { ValidationError } from '../shared/validation';
import type { BankService } from './bank';
import { headerSignature, previewCsv, type CsvMapping } from './csv';
import { detectFormat } from './detect';
import { parseBankFile } from './parse-file';

/**
 * Afschriften uit je downloadmap (#184, deel 2). Staat standaard uit. Staat het aan, dan kijkt de app in
 * de map die de gebruiker koos naar nieuwe bestanden die een bankafschrift van deze administratie zijn, en
 * vraagt op Vandaag "Inlezen?". Er gaat niets vanzelf de boeken in, er gaat niets naar buiten, en de app
 * verplaatst of verwijdert nooit iets in die map.
 */

/** Alleen bestanden met deze extensies worden geopend om te zien of het een afschrift is. */
export const STATEMENT_EXTENSIONS = ['.xml', '.sta', '.940', '.txt', '.csv'];
/** Groter dan dit is geen bankafschrift. */
export const MAX_STATEMENT_BYTES = 20 * 1024 * 1024;
/** Bij het aanzetten kijkt de app ook naar afschriften van de afgelopen dagen. */
export const LOOK_BACK_DAYS = 14;
/** Na zoveel keer "Niet nu" vraagt de app het voor dat bestand niet meer. */
export const MAX_DECLINES = 3;
/** Korter geleden gewijzigd dan dit (ms): misschien nog aan het downloaden, dus tot de volgende keer wachten. */
export const STABLE_MS = 5000;

export interface FolderFile {
  name: string;
  size: number;
  /** wijzigingstijd van het bestand */
  mtimeMs: number;
  /** wanneer het bestand hier voor het laatst veranderde of binnenkwam */
  changedMs: number;
}

/** Toegang tot de map, geleverd door het hoofdproces (src/main/statement-files.ts): alleen lezen. */
export interface FolderAccess {
  isDirectory(dir: string): boolean;
  /** gewone bestanden direct in de map: geen submappen, geen snelkoppelingen */
  list(dir: string): FolderFile[];
  /** één bestand uit de map; gooit als het buiten de map valt of te groot is */
  read(dir: string, name: string, maxBytes: number): Buffer;
}

export interface StatementFolderConfig {
  enabled: boolean;
  path: string;
  /** alleen bestanden die sinds dit tijdstip (ISO) in de map kwamen of veranderden */
  since: string | null;
}

/** Een afschrift in de map waarover de app "Inlezen?" vraagt. */
export interface FoundStatement {
  id: number;
  filename: string;
  /** namen van de rekeningen in het afschrift */
  accounts: string;
  from: IsoDate;
  to: IsoDate;
  transactions: number;
}

const SETTING = 'statementFolder';
/** een afschrift waar de app al naar vraagt, dat al is ingelezen of dat drie keer is afgewezen */
const ACTIVE = `((status = 'gevonden' AND present = 1) OR status IN ('ingelezen', 'afgewezen'))`;

/** Zoals het scherm een gesleept bestand leest: UTF-8, anders Windows-1252 (veel bank-CSV's). */
export function decodeStatement(data: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return new TextDecoder('windows-1252').decode(data);
  }
}

/** Dezelfde inhoud = hetzelfde afschrift, hoe het bestand ook heet. */
export function statementHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function isStatementName(name: string): boolean {
  return STATEMENT_EXTENSIONS.includes(extname(name).toLowerCase());
}

export class StatementFolder {
  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly bank: BankService,
    /** null = op deze plek kan de app niet in mappen kijken */
    private readonly files: FolderAccess | null,
  ) {}

  /** Eén keer kijken tegelijk; een tweede verzoek wacht op de lopende. */
  private running: Promise<{ found: number; waiting: boolean }> | null = null;

  get available(): boolean {
    return this.files !== null;
  }

  config(): StatementFolderConfig {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = ?`).get(SETTING) as { value: string } | undefined;
    const stored = row ? (JSON.parse(row.value) as Partial<StatementFolderConfig>) : {};
    return { enabled: stored.enabled === true, path: typeof stored.path === 'string' ? stored.path : '', since: typeof stored.since === 'string' ? stored.since : null };
  }

  private save(cfg: StatementFolderConfig): void {
    this.db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(SETTING, JSON.stringify(cfg));
  }

  /**
   * Aanzetten voor deze map. De app kijkt dan ook naar afschriften van de afgelopen 14 dagen; wat ouder
   * is, laat hij liggen. Een andere map kiezen terwijl het al aanstaat, begint opnieuw.
   */
  enable(path: string, now: Date = new Date()): StatementFolderConfig {
    if (!this.files) throw new ValidationError('In mappen kijken kan alleen in de app zelf');
    if (this.settings.officeCopy()) throw new ValidationError('Dit is de kopie van een klant: afschriften leest de klant zelf in.');
    if (!path || !this.files.isDirectory(path)) throw new ValidationError('Deze map bestaat niet (meer). Kies een andere map.');
    const current = this.config();
    if (current.enabled && current.path === path) return current;
    const cfg = { enabled: true, path, since: new Date(now.getTime() - LOOK_BACK_DAYS * 86_400_000).toISOString() };
    this.save(cfg);
    return cfg;
  }

  /**
   * Uitzetten: de app kijkt niet meer en de vragen op Vandaag verdwijnen. De bestanden blijven staan.
   * `path`: de map die de gebruiker alvast koos voor als hij het aanzet.
   */
  disable(path?: string): StatementFolderConfig {
    if (path !== undefined && !this.files?.isDirectory(path)) throw new ValidationError('Deze map bestaat niet (meer). Kies een andere map.');
    const cfg = { enabled: false, path: path ?? this.config().path, since: null };
    this.save(cfg);
    return cfg;
  }

  private key(dir: string, f: FolderFile): string {
    return createHash('sha256').update([dir, f.name, f.size, f.mtimeMs].join('\n')).digest('hex');
  }

  /**
   * In de map kijken. Nieuwe bestanden met een van de extensies worden één keer geopend; wat een afschrift
   * van deze administratie is, wordt een vraag op Vandaag. `waiting`: er is een bestand dat nog aan het
   * downloaden lijkt, dus straks nog een keer kijken.
   */
  scan(now: Date = new Date()): Promise<{ found: number; waiting: boolean }> {
    this.running ??= this.look(now).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async look(now: Date): Promise<{ found: number; waiting: boolean }> {
    const cfg = this.config();
    if (!this.files || !cfg.enabled || !cfg.path || this.settings.officeCopy()) return { found: 0, waiting: false };
    let listing: FolderFile[];
    try {
      listing = this.files.list(cfg.path);
    } catch {
      // de map is er (even) niet, bv. een losgekoppelde schijf: niets doen, niets vergeten
      return { found: 0, waiting: false };
    }
    const since = cfg.since ? Date.parse(cfg.since) : 0;
    const candidates = new Map<string, FolderFile>();
    for (const f of listing) {
      if (!isStatementName(f.name) || f.size === 0 || f.size >= MAX_STATEMENT_BYTES || f.changedMs < since) continue;
      candidates.set(this.key(cfg.path, f), f);
    }
    // wat niet meer in de map staat: een vraag vervalt, en van andere bestanden vergeten we ook de hash
    const known = this.db.prepare('SELECT id, file_key, status, present FROM statement_files').all() as { id: number; file_key: string; status: string; present: number }[];
    for (const row of known) {
      const present = candidates.has(row.file_key) ? 1 : 0;
      if (!present && row.status === 'geen') this.db.prepare('DELETE FROM statement_files WHERE id = ?').run(row.id);
      else if (present !== row.present) this.db.prepare('UPDATE statement_files SET present = ? WHERE id = ?').run(present, row.id);
    }
    // de enige overgebleven kopie van een afschrift waar nog naar gevraagd werd (het origineel is uit de map
    // gehaald): daar gaat de vraag nu over
    this.db.exec(`UPDATE statement_files SET status = 'gevonden' WHERE status = 'dubbel' AND present = 1
      AND id = (SELECT MIN(d.id) FROM statement_files d WHERE d.content_hash = statement_files.content_hash AND d.status = 'dubbel' AND d.present = 1)
      AND NOT EXISTS (SELECT 1 FROM statement_files o WHERE o.content_hash = statement_files.content_hash AND o.id <> statement_files.id AND ${ACTIVE.replaceAll('status', 'o.status').replaceAll('present', 'o.present')})`);
    const seen = new Set(known.map((r) => r.file_key));
    let found = 0;
    let waiting = false;
    for (const [key, f] of candidates) {
      if (seen.has(key)) continue;
      // net gewijzigd: de download loopt misschien nog (een half bestand zou "geen afschrift" lijken)
      if (now.getTime() - f.changedMs < STABLE_MS) {
        waiting = true;
        continue;
      }
      let content: string;
      try {
        content = decodeStatement(this.files.read(cfg.path, f.name, MAX_STATEMENT_BYTES));
      } catch {
        // nu niet te lezen (bv. nog in gebruik door de browser): de volgende keer opnieuw proberen
        waiting = true;
        continue;
      }
      // is de grootte tijdens het lezen veranderd, dan was het bestand nog niet klaar
      const after = this.files.list(cfg.path).find((x) => x.name === f.name);
      if (!after || after.size !== f.size || after.mtimeMs !== f.mtimeMs) {
        waiting = true;
        continue;
      }
      const statement = await this.recognize(f.name, content);
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO statement_files (file_key, status, filename, content_hash, source, accounts, period_from, period_to, transactions, import_batch_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      if (!statement) {
        // geen afschrift van deze administratie: alleen onthouden dát we het bekeken hebben
        insert.run(key, 'geen', null, null, null, null, null, null, null, null);
        continue;
      }
      const hash = statementHash(content);
      // al ingelezen (bv. in de app gesleept), of hetzelfde afschrift onder een andere naam: niet (nog eens) vragen
      const imported = this.db.prepare('SELECT id FROM import_batches WHERE content_hash = ? ORDER BY id LIMIT 1').get(hash) as { id: number } | undefined;
      const same = this.db.prepare(`SELECT 1 FROM statement_files WHERE content_hash = ? AND ${ACTIVE} LIMIT 1`).get(hash);
      const status = imported ? 'ingelezen' : same ? 'dubbel' : 'gevonden';
      insert.run(key, status, f.name, hash, statement.source, statement.accounts, statement.from, statement.to, statement.transactions, imported?.id ?? null);
      if (status === 'gevonden') found++;
    }
    return { found, waiting };
  }

  /**
   * Is dit een bankafschrift van deze administratie? CAMT en MT940 met het rekeningnummer van een rekening
   * in de administratie, of een CSV die de app als bankexport herkent (een bekende bank, of kolommen die
   * de gebruiker eerder aanwees) van een rekening die er al in staat. Verandert niets: alleen lezen.
   */
  private async recognize(filename: string, content: string): Promise<{ source: string; accounts: string; from: IsoDate; to: IsoDate; transactions: number } | null> {
    try {
      const format = detectFormat(filename, content);
      if (format === 'onbekend') return null;
      let mapping: CsvMapping | undefined;
      if (format === 'csv') {
        const preview = previewCsv(content);
        const saved = this.db.prepare('SELECT mapping FROM csv_mappings WHERE header_signature = ?').get(headerSignature(preview.headers)) as { mapping: string } | undefined;
        // alleen wat de app zeker als bankexport kent: geen gok op kolomnamen
        const known = saved ? (JSON.parse(saved.mapping) as CsvMapping) : preview.detectedBank ? preview.suggestedMapping : null;
        if (!known) return null;
        mapping = known;
      }
      const parsed = await parseBankFile(filename, content, mapping);
      if (parsed.transactions.length === 0) return null;
      const accounts = this.bank.listAccounts().filter((a) => !a.is_pot);
      const ibans = new Set(parsed.transactions.map((t) => t.ownIban).filter((x): x is string => !!x));
      const own = accounts.filter((a) => a.iban && ibans.has(a.iban));
      // een bestand zonder eigen rekeningnummer (bv. Revolut): de rekening met de naam van die bank
      if (own.length === 0 && ibans.size === 0 && parsed.bank) own.push(...accounts.filter((a) => sameBankName(a.name, parsed.bank!)).slice(0, 1));
      if (own.length === 0) return null;
      const dates = parsed.transactions.map((t) => t.date).sort();
      return { source: parsed.source, accounts: own.map((a) => a.name).join(' en '), from: dates[0]!, to: dates.at(-1)!, transactions: parsed.transactions.length };
    } catch {
      // niet te lezen als afschrift
      return null;
    }
  }

  /** De afschriften waarover de app nu "Inlezen?" vraagt. */
  pending(asOf: IsoDate = today()): FoundStatement[] {
    if (!this.files || !this.config().enabled || this.settings.officeCopy()) return [];
    return this.db
      .prepare(
        `SELECT id, filename, accounts, period_from AS "from", period_to AS "to", transactions FROM statement_files
         WHERE status = 'gevonden' AND present = 1 AND (ask_from IS NULL OR ask_from <= ?) ORDER BY period_from, id`,
      )
      .all(asOf) as FoundStatement[];
  }

  /**
   * Het bestand voor "Inlezen": nog steeds hetzelfde bestand (naam, grootte en wijzigingstijd) in de
   * gekozen map, met dezelfde inhoud als toen de app het vond.
   */
  open(id: number): { filename: string; content: string; contentHash: string } {
    const cfg = this.config();
    const row = this.db.prepare(`SELECT file_key, filename, content_hash FROM statement_files WHERE id = ? AND status = 'gevonden'`).get(id) as { file_key: string; filename: string; content_hash: string } | undefined;
    if (!row) throw new ValidationError('Dit afschrift is al ingelezen of staat er niet meer');
    const gone = new ValidationError('Dit bestand staat niet meer in de map. Download het afschrift opnieuw bij je bank, of sleep het bij Bank in de app.');
    if (!this.files || !cfg.enabled || !cfg.path) throw gone;
    let content: string;
    try {
      const file = this.files.list(cfg.path).find((f) => this.key(cfg.path, f) === row.file_key);
      if (!file) throw gone;
      content = decodeStatement(this.files.read(cfg.path, file.name, MAX_STATEMENT_BYTES));
    } catch {
      this.db.prepare('UPDATE statement_files SET present = 0 WHERE id = ?').run(id);
      throw gone;
    }
    if (statementHash(content) !== row.content_hash) {
      this.db.prepare('UPDATE statement_files SET present = 0 WHERE id = ?').run(id);
      throw gone;
    }
    return { filename: row.filename, content, contentHash: row.content_hash };
  }

  /** Ingelezen via de vraag op Vandaag. */
  markImported(id: number, batchId: number): void {
    this.db.prepare(`UPDATE statement_files SET status = 'ingelezen', import_batch_id = ? WHERE id = ?`).run(batchId, id);
  }

  /** Hetzelfde afschrift is op een andere manier ingelezen (in de app gesleept): de vraag vervalt. */
  noteImported(contentHash: string, batchId: number): void {
    this.db.prepare(`UPDATE statement_files SET status = 'ingelezen', import_batch_id = ? WHERE content_hash = ? AND status = 'gevonden'`).run(batchId, contentHash);
  }

  /** "Niet nu": morgen opnieuw vragen; na drie keer niet meer voor dit bestand. */
  notNow(id: number, asOf: IsoDate = today()): void {
    const row = this.db.prepare(`SELECT declined FROM statement_files WHERE id = ? AND status = 'gevonden'`).get(id) as { declined: number } | undefined;
    if (!row) return;
    const declined = row.declined + 1;
    this.db.prepare('UPDATE statement_files SET declined = ?, ask_from = ?, status = ? WHERE id = ?').run(declined, addDays(asOf, 1), declined >= MAX_DECLINES ? 'afgewezen' : 'gevonden', id);
  }
}
