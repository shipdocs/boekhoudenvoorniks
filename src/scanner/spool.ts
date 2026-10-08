import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db/database';
import { encodeFrame, parseFrame, type ReceiptMessage } from './protocol';
import { stripJpegGps } from './strip-gps';

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
  /**
   * Bestanden van een mislukte ontvangst die niet verwijderd konden worden (bv. een map zonder schrijfrecht).
   * Ze horen bij rijen die zijn teruggedraaid: de telefoon kreeg geen bevestiging. Ze mogen daarom nooit een
   * bon in de inbox worden (recover slaat ze over) en gaan weg zodra opruimen() dat kan. Alleen in het
   * geheugen: na een herstart van de app is de herkomst van zo'n los bestand niet meer te zien.
   */
  private readonly teVerwijderen = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly dir: string,
  ) {}

  /**
   * Vingerafdruk van de inhoud: dezelfde bon nog eens is goed, een ándere bon onder hetzelfde ID niet.
   * De locatie telt niet mee, ook niet die in de foto zelf (EXIF): die staat niet altijd in de wachtrij
   * (alleen met toestemming), en met of zonder is het dezelfde bon.
   */
  static hash(msg: ReceiptMessage): string {
    const h = createHash('sha256');
    const fotos = msg.fotos.map(stripJpegGps);
    h.update(JSON.stringify([msg.betaalwijze, msg.notitie, fotos.map((f) => f.length)]));
    for (const f of fotos) h.update(f);
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
   * de locatie alleen als de gebruiker daar toestemming voor gaf (#32): zonder toestemming gaat ook de
   * positie uit de foto's zelf (EXIF).
   */
  accept(msg: ReceiptMessage, deviceId: string, opts: { keepLocation: boolean }): 'nieuw' | 'al' | 'botst' {
    const hash = ReceiptSpool.hash(msg);
    const existing = this.row(msg.id);
    if (existing) return existing.content_hash === hash ? 'al' : 'botst';
    const fotos = opts.keepLocation ? msg.fotos : msg.fotos.map(stripJpegGps);
    const frame = encodeFrame(
      { soort: 'bon', tijd: msg.tijd, id: msg.id, betaalwijze: msg.betaalwijze, notitie: msg.notitie, locatie: opts.keepLocation ? msg.locatie : null, fotos: fotos.map((f) => ({ grootte: f.length })) },
      fotos,
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
    syncDirectory(this.dir);
    try {
      this.insert(msg.id, deviceId, hash);
    } catch (e) {
      this.intrekken(msg.id);
      throw e;
    }
    // het bestand is nu het bestand van een echte bon (het overschreef een eventueel achtergebleven exemplaar)
    this.teVerwijderen.delete(msg.id);
    return 'nieuw';
  }

  /**
   * De regel in de database, meteen naar schijf: de app schrijft normaal niet bij elke wijziging door
   * (WAL), maar na deze regel krijgt de telefoon de bevestiging en ruimt hij de bon op.
   */
  private insert(id: string, deviceId: string, hash: string): void {
    // Binnen een transactie kan SQLite de schrijfzekerheid niet wijzigen (PRAGMA synchronous mag dan niet): de
    // aanroeper die de transactie opent (SyncOntvangst) zet haar zelf op FULL vóór de transactie.
    if (this.db.inTransaction) {
      this.db.prepare('INSERT INTO scanner_documents (id, device_id, content_hash) VALUES (?, ?, ?)').run(id, deviceId, hash);
      return;
    }
    const before = this.db.pragma('synchronous', { simple: true }) as number;
    this.db.pragma('synchronous = FULL');
    try {
      this.db.prepare('INSERT INTO scanner_documents (id, device_id, content_hash) VALUES (?, ?, ?)').run(id, deviceId, hash);
    } finally {
      this.db.pragma(`synchronous = ${before}`);
    }
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

  /** Verwijdert één bestand; gooit bij elke fout behalve "bestaat niet". Los gemaakt zodat een test de fout kan nabootsen. */
  verwijderBestand(pad: string): void {
    try {
      unlinkSync(pad);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }

  /**
   * Haalt het bestand (en het tijdelijke bestand) van een ontvangst weg die niet gelukt is. Lukt het verwijderen
   * niet, dan wordt het ID onthouden (zie teVerwijderen) en geeft dit false; anders true.
   */
  intrekken(id: string): boolean {
    const pad = this.file(id);
    let gelukt = true;
    for (const bestand of [pad, `${pad}.tmp`]) {
      try {
        this.verwijderBestand(bestand);
      } catch {
        gelukt = false;
      }
    }
    if (gelukt) this.teVerwijderen.delete(id);
    else this.teVerwijderen.add(id);
    return gelukt;
  }

  /** Alleen het tijdelijke bestand van een ontvangst weghalen (daar is nooit een bevestiging voor gegeven). */
  ruimTijdelijkOp(id: string): void {
    try {
      this.verwijderBestand(`${this.file(id)}.tmp`);
    } catch {
      /* volgende keer */
    }
  }

  /**
   * Probeert onthouden bestanden van mislukte ontvangsten alsnog te verwijderen. Een ID waar inmiddels een
   * echte rij voor is (dezelfde wijziging kwam daarna wel binnen), is geen afval meer en wordt vergeten.
   */
  opruimen(): void {
    for (const id of [...this.teVerwijderen]) {
      if (this.row(id)) this.teVerwijderen.delete(id);
      else this.intrekken(id);
    }
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
   * Bij het opstarten de wachtrij op orde brengen. Er wordt geen bon weggegooid:
   * - een bestand zonder regel in de database (stroomuitval vlak na het ontvangen, of een teruggezette
   *   back-up) krijgt opnieuw een regel en gaat alsnog naar de inbox; was hij daar al, dan herkent de
   *   inbox hem aan de hash;
   * - een bon die eerder niet lukte, wordt nog een keer geprobeerd;
   * - weg mogen alleen half geschreven bestanden (daar is nooit een bevestiging voor gegeven) en de
   *   kopie van een bon die al in de inbox staat.
   */
  recover(): void {
    this.opruimen();
    if (existsSync(this.dir)) {
      for (const name of readdirSync(this.dir)) {
        const path = join(this.dir, name);
        if (name.endsWith(`${SUFFIX}.tmp`)) {
          tryUnlink(path);
          continue;
        }
        const id = name.endsWith(SUFFIX) ? name.slice(0, -SUFFIX.length) : null;
        if (!id || !ID.test(id)) continue;
        // een bestand van een mislukte ontvangst dat (nog) niet weg kon: nooit een bon van maken
        if (this.teVerwijderen.has(id)) continue;
        const row = this.row(id);
        if (row?.state === 'verwerkt') tryUnlink(path);
        else if (!row) {
          try {
            this.insert(id, '', ReceiptSpool.hash(this.read(id)));
          } catch {
            /* niet te lezen: laten staan, niet weggooien */
          }
        }
      }
    }
    for (const row of this.failed()) {
      if (existsSync(this.file(row.id))) this.db.prepare(`UPDATE scanner_documents SET state = 'wacht', attempts = 0 WHERE id = ?`).run(row.id);
    }
  }
}

function tryUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* blijft staan; volgende keer */
  }
}

/** De nieuwe naam in de map ook naar schijf (waar het besturingssysteem dat toelaat; op Windows niet nodig). */
function syncDirectory(dir: string): void {
  try {
    const fd = openSync(dir, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* niet ondersteund */
  }
}
