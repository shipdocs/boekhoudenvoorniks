import { createHash } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { leesBonVelden, leesFotoVelden, type BonFoto, type Wijziging } from '@gratis-boekhouden/kern';
import type { Db } from '../db/database';
import { jpegInfo } from '../scanner/jpeg-pdf';
import type { ReceiptMessage } from '../scanner/protocol';
import { ReceiptSpool } from '../scanner/spool';
import type { SyncResultaat } from './ontvangst';

interface RegisterRij {
  uitkomst: string;
  fout: string | null;
}

export interface BonOntvangstOpties {
  /** de pc-klok in milliseconden (voor ontvangen_op) */
  now: () => number;
  /** mag de locatie van een bon bewaard worden? (opt-in van #32; standaard niet) */
  keepLocation?: () => boolean;
}

/**
 * Vergelijkt de bijlagen met wat de velden zeggen: evenveel, elke grootte gelijk, elke sha256 gelijk en
 * elke bijlage echt een JPEG (aan de inhoud). Geeft een melding bij de eerste afwijking, anders null.
 * De melding noemt nooit inhoud van de bijlagen.
 */
export function controleerBijlagen(fotos: BonFoto[], bijlagen: Buffer[]): string | null {
  if (bijlagen.length !== fotos.length) return 'Het aantal bijlagen klopt niet met de fotos in de velden';
  for (let i = 0; i < fotos.length; i++) {
    const bijlage = bijlagen[i]!;
    if (bijlage.length !== fotos[i]!.grootte) return `De grootte van foto ${i + 1} klopt niet met de bijlage`;
    if (createHash('sha256').update(bijlage).digest('hex') !== fotos[i]!.sha256) return `De sha256 van foto ${i + 1} klopt niet met de bijlage`;
    if (!jpegInfo(bijlage)) return `Foto ${i + 1} is geen JPEG`;
  }
  return null;
}

/**
 * Een fotowijziging (entiteit foto) met bijlagen wordt gelezen en gecontroleerd, maar nog niet bewaard
 * (dat komt in een volgende stap): geeft een uitslag bij een fout, anders null.
 */
export function controleerFoto(w: Wijziging, bijlagen: Buffer[]): SyncResultaat | null {
  const gelezen = leesFotoVelden(w.velden);
  if (!gelezen.ok) return { status: 400, fout: 'veld-ongeldig', veld: gelezen.veld, melding: gelezen.melding };
  const melding = controleerBijlagen(gelezen.velden.fotos, bijlagen);
  return melding ? { status: 400, fout: 'ongeldig', melding } : null;
}

/**
 * Ontvangst van een bon als wijziging (entiteit bon, revisie 1, JPEG's als bijlage). De opslag is die van
 * het bon-bericht: dezelfde spool (ReceiptSpool.accept), dus dezelfde bestanden en rijen, met het id van de
 * bon als uuid van de wijziging, en de locatie (ook die in de JPEG zelf) alleen bewaard met toestemming.
 *
 * Volgorde: registersleutel al gezien (eerdere uitkomst herhalen), dan de velden en de bijlagen
 * controleren, de bon opslaan, de registerrij schrijven. Wordt aangeroepen binnen de databasetransactie
 * van SyncOntvangst.verwerkEen: een fout daarna draait de rijen terug, en `terugdraaien` haalt het bestand
 * weg dat de spool al had neergezet, zodat een fout nooit een halve rij of een los bestand achterlaat en
 * dezelfde wijziging daarna gewoon opnieuw kan.
 */
/**
 * De databank zoals de spool hem hier mag gebruiken: binnen een transactie. ReceiptSpool.insert zet de
 * schrijfzekerheid (PRAGMA synchronous) tijdelijk op FULL, en SQLite staat dat niet toe binnen een transactie.
 * SyncOntvangst zet die zekerheid daarom zelf vóór de transactie op FULL; deze doorgeefluik laat het instellen
 * ervan dan met rust. Al het andere gaat ongewijzigd door naar de echte databank.
 */
function metVasteSchrijfzekerheid(db: Db): Db {
  return new Proxy(db, {
    get(doel, naam) {
      if (naam === 'pragma') {
        return (bron: string, opties?: { simple?: boolean }) => (/^\s*synchronous\s*=/i.test(bron) ? undefined : doel.pragma(bron, opties));
      }
      const waarde = Reflect.get(doel, naam, doel) as unknown;
      return typeof waarde === 'function' ? (waarde as (...a: unknown[]) => unknown).bind(doel) : waarde;
    },
  });
}

export class BonOntvangst {
  /** het ID van de bon waarvan deze aanroep het bestand in de spool neerzette (en dat nog niet definitief is) */
  private nieuw: string | null = null;
  /** dezelfde spool (zelfde map en regels), maar bruikbaar binnen de transactie van verwerk */
  private readonly spoolInTransactie: ReceiptSpool;

  constructor(
    private readonly db: Db,
    private readonly spool: ReceiptSpool,
    private readonly opties: BonOntvangstOpties,
  ) {
    this.spoolInTransactie = new ReceiptSpool(metVasteSchrijfzekerheid(db), dirname(spool.pathOf('00000000-0000-0000-0000-000000000000')));
  }

  verwerk(deviceId: string, w: Wijziging, route: string, bijlagen: Buffer[]): SyncResultaat {
    this.nieuw = null;
    // 1. exact dezelfde sleutel al gezien: niets schrijven en de uitkomst van de eerste keer herhalen
    const bekend = this.db
      .prepare('SELECT uitkomst, fout FROM sync_ontvangen WHERE apparaat_id = ? AND entiteit = ? AND uuid = ? AND revisie = ?')
      .get(deviceId, w.entiteit, w.uuid, w.revisie) as RegisterRij | undefined;
    if (bekend) return bekend.uitkomst === 'afgewezen' ? { status: 200, uitkomst: 'afgewezen', fout: bekend.fout ?? undefined } : { status: 200, uitkomst: 'overgeslagen' };

    // 2. een document heeft één revisie; de velden en de bijlagen kloppen
    if (w.revisie !== 1) return { status: 400, fout: 'ongeldig', melding: 'Een bon heeft alleen revisie 1' };
    const gelezen = leesBonVelden(w.velden);
    if (!gelezen.ok) return { status: 400, fout: 'veld-ongeldig', veld: gelezen.veld, melding: gelezen.melding };
    const melding = controleerBijlagen(gelezen.velden.fotos, bijlagen);
    if (melding) return { status: 400, fout: 'ongeldig', melding };

    // 3. opslaan in de spool: hetzelfde als bij het bon-bericht
    const bericht: ReceiptMessage = { soort: 'bon', tijd: w.tijd, id: w.uuid, betaalwijze: gelezen.velden.betaalwijze, notitie: gelezen.velden.notitie, locatie: gelezen.velden.locatie, fotos: bijlagen };
    const spoel = this.spoolInTransactie.accept(bericht, deviceId, { keepLocation: this.opties.keepLocation?.() ?? false });
    if (spoel === 'nieuw') this.nieuw = w.uuid;
    const uitkomst = spoel === 'nieuw' ? 'toegepast' : spoel === 'al' ? 'overgeslagen' : 'afgewezen';
    const fout = spoel === 'botst' ? 'id-botst' : null;

    // 4. registerrij: de uitkomst van de eerste verwerking
    this.db
      .prepare(
        `INSERT INTO sync_ontvangen (apparaat_id, entiteit, uuid, revisie, tijd, ontvangen_op, uitkomst, fout, route) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(apparaat_id, entiteit, uuid, revisie) DO NOTHING`,
      )
      .run(deviceId, w.entiteit, w.uuid, w.revisie, w.tijd, this.opties.now(), uitkomst, fout, route);
    return fout ? { status: 200, uitkomst, fout } : { status: 200, uitkomst };
  }

  /** De transactie is gelukt: het bestand in de spool is nu definitief. */
  afgerond(): void {
    this.nieuw = null;
  }

  /**
   * De transactie is mislukt (of teruggedraaid): het bestand dat de spool in deze aanroep neerzette hoort
   * bij een rij die er niet meer is, en gaat weg, net als een half geschreven tijdelijk bestand.
   * Een bestand van een eerdere, bevestigde bon blijft altijd staan.
   */
  terugdraaien(id: string): void {
    const definitief = this.nieuw === id;
    this.nieuw = null;
    let pad: string;
    try {
      pad = this.spool.pathOf(id);
    } catch {
      return;
    }
    // een tijdelijk bestand is nooit bevestigd; het bestand zelf alleen als dit de aanroep was die het neerzette
    for (const bestand of definitief ? [pad, `${pad}.tmp`] : [`${pad}.tmp`]) {
      try {
        unlinkSync(bestand);
      } catch {
        /* al weg */
      }
    }
  }
}
