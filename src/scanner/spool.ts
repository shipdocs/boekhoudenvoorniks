import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db/database';
import { encodeFrame, parseFrame, type ReceiptMessage } from './protocol';

export interface SpoolRow {
  id: string;
  device_id: string;
  content_hash: string;
  state: 'wacht' | 'verwerkt' | 'mislukt';
  document_id: number | null;
  attempts: number;
  error: string | null;
  received_at: string;
}

/** Zo vaak proberen we een ontvangen bon in de inbox te zetten; daarna blijft hij bewaard als "mislukt". */
export const MAX_ATTEMPTS = 3;

const SUFFIX = '.bon';
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Wachtrij op schijf voor bonnen van de telefoon. Een bon wordt eerst hier veilig weggeschreven (en
 * in de database genoteerd); pas dan krijgt de telefoon de bevestiging en mag hij de bon opruimen.
 * Het uitlezen en in de inbox zetten gebeurt daarna, zodat de telefoon niet op de tekstherkenning
 * hoeft te wachten. Het ID van de telefoon maakt dat dezelfde bon maar één keer binnenkomt.
 */
export class ReceiptSpool {
  constructor(
    private readonly db: Db,
    private readonly dir: string,
  ) {}

  /** Vingerafdruk van de inhoud: dezelfde bon nog eens is goed, een ándere bon onder hetzelfde ID niet. */
  static hash(msg: ReceiptMessage): string {
    const h = createHash('sha256');
    h.update(JSON.stringify([msg.betaalwijze, msg.notitie, msg.locatie, msg.fotos.map((f) => f.length)]));
    for (const f of msg.fotos) h.update(f);
    return h.digest('hex');
  }

  private file(id: string): string {
    // het ID is al gecontroleerd (alleen hex en streepjes); toch hier nog eens, want het wordt een bestandsnaam
    if (!ID.test(id)) throw new Error('Ongeldig ID');
    return join(this.dir, `${id}${SUFFIX}`);
  }

  row(id: string): SpoolRow | null {
    return (this.db.prepare('SELECT * FROM scanner_documents WHERE id = ?').get(id) as SpoolRow | undefined) ?? null;
  }

  /**
   * Bewaart een ontvangen bon. 'nieuw' = nu veilig opgeslagen; 'al' = deze bon hadden we al (zelfde
   * ID, zelfde inhoud); 'botst' = dit ID is al gebruikt voor een andere bon.
   *
   * Op schijf komt alleen wat gecontroleerd is (de velden die de app kent, niet het ruwe bericht), en
   * de locatie alleen als de gebruiker daar toestemming voor gaf (#32).
   */
  accept(msg: ReceiptMessage, deviceId: string, opts: { keepLocation: boolean }): 'nieuw' | 'al' | 'botst' {
    const hash = ReceiptSpool.hash(msg);
    const existing = this.row(msg.id);
    if (existing) return existing.content_hash === hash ? 'al' : 'botst';
    const frame = encodeFrame(
      { soort: 'bon', tijd: msg.tijd, id: msg.id, betaalwijze: msg.betaalwijze, notitie: msg.notitie, locatie: opts.keepLocation ? msg.locatie : null, fotos: msg.fotos.map((f) => ({ grootte: f.length })) },
      msg.fotos,
    );
    mkdirSync(this.dir, { recursive: true });
    const target = this.file(msg.id);
    const tmp = `${target}.tmp`;
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, frame);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, target);
    try {
      this.db.prepare('INSERT INTO scanner_documents (id, device_id, content_hash) VALUES (?, ?, ?)').run(msg.id, deviceId, hash);
    } catch (e) {
      unlinkSync(target);
      throw e;
    }
    return 'nieuw';
  }

  /** Bonnen die nog naar de inbox moeten, oudste eerst. */
  waiting(): SpoolRow[] {
    return this.db.prepare(`SELECT * FROM scanner_documents WHERE state = 'wacht' ORDER BY received_at, rowid`).all() as SpoolRow[];
  }

  failed(): SpoolRow[] {
    return this.db.prepare(`SELECT * FROM scanner_documents WHERE state = 'mislukt' ORDER BY received_at, rowid`).all() as SpoolRow[];
  }

  read(id: string): ReceiptMessage {
    const msg = parseFrame(readFileSync(this.file(id)));
    if (msg.soort !== 'bon' || msg.id !== id) throw new Error('Het bewaarde bericht hoort niet bij dit ID');
    return msg;
  }

  /** In de inbox gezet: de kopie in de wachtrij kan weg. */
  done(id: string, documentId: number): void {
    this.db.prepare(`UPDATE scanner_documents SET state = 'verwerkt', document_id = ?, error = NULL WHERE id = ?`).run(documentId, id);
    try {
      unlinkSync(this.file(id));
    } catch {
      /* al weg */
    }
  }

  /** Niet gelukt: later opnieuw; na een paar keer blijft de bon bewaard in de wachtrij (nooit weggegooid). */
  fail(id: string, error: string): void {
    this.db
      .prepare(`UPDATE scanner_documents SET attempts = attempts + 1, error = ?, state = CASE WHEN attempts + 1 >= ? THEN 'mislukt' ELSE state END WHERE id = ?`)
      .run(error.slice(0, 300), MAX_ATTEMPTS, id);
  }

  /** Waar een mislukte bon bewaard is (voor de melding in Instellingen). */
  pathOf(id: string): string {
    return this.file(id);
  }

  /**
   * Bij het opstarten: half geschreven bestanden en bestanden zonder regel in de database weg (de
   * telefoon kreeg daar nooit een bevestiging van en stuurt ze opnieuw).
   */
  cleanup(): void {
    if (!existsSync(this.dir)) return;
    for (const name of readdirSync(this.dir)) {
      const id = name.endsWith(SUFFIX) ? name.slice(0, -SUFFIX.length) : null;
      if (id && ID.test(id) && this.row(id)) continue;
      if (!name.endsWith(SUFFIX) && !name.endsWith(`${SUFFIX}.tmp`)) continue;
      try {
        unlinkSync(join(this.dir, name));
      } catch {
        /* blijft staan; volgende keer */
      }
    }
  }
}
