import { createHash } from 'node:crypto';
import { leesBonVelden, leesFotoVelden, type BonFoto, type Wijziging } from '@gratis-boekhouden/kern';
import type { Db } from '../db/database';
import { jpegInfo } from '../scanner/jpeg-pdf';
import { LIMITS, type ReceiptMessage } from '../scanner/protocol';
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
  /** logboek voor storingen (nooit met inhoud van een bon) */
  log?: (melding: string) => void;
}

/**
 * De grootte-grenzen van een bon- of fotowijziging, ongeacht de route. Over het netwerk dwingt parseFrame ze af
 * op het ruwe bericht; bij map en mail komt de wijziging al uitgepakt binnen, dus dezelfde grenzen gelden hier ook:
 * - de JSON van de change-set (canoniek JSON.stringify van entiteit, uuid, revisie, tijd, velden) hoogstens
 *   maxWijzigingJsonBytes. Dit is de grens op de RUWE velden: een notitie die de kern pas daarna trimt (of
 *   afkapt) kan er dus niet onderdoor;
 * - de bijlagen samen hoogstens maxPhotoBytes;
 * - JSON plus bijlagen (plus de 4 bytes lengte) samen hoogstens maxBodyBytes.
 * Boven een grens geeft 413 te-groot, zoals over het netwerk. Het aantal foto's (1 tot en met maxPhotos) en de
 * rest van de velden controleert de kern (leesBonVelden), het aantal bijlagen controleerBijlagen. Geeft null als
 * alles binnen de grenzen valt.
 */
export function controleerGrenzen(w: Wijziging, bijlagen: Buffer[]): SyncResultaat | null {
  const teGroot = (melding: string): SyncResultaat => ({ status: 413, fout: 'te-groot', melding });
  let json: number;
  try {
    json = Buffer.byteLength(JSON.stringify({ entiteit: w.entiteit, uuid: w.uuid, revisie: w.revisie, tijd: w.tijd, velden: w.velden }), 'utf8');
  } catch {
    return { status: 400, fout: 'ongeldig', melding: 'De velden van de wijziging zijn niet te lezen' };
  }
  if (json > LIMITS.maxWijzigingJsonBytes) return teGroot('De gegevens van de wijziging zijn te groot');
  if (bijlagen.length > LIMITS.maxPhotos) return { status: 400, fout: 'ongeldig', melding: `Een wijziging heeft hoogstens ${LIMITS.maxPhotos} bijlagen` };
  const som = bijlagen.reduce((totaal, b) => totaal + b.length, 0);
  if (som > LIMITS.maxPhotoBytes) return teGroot("De foto's zijn samen te groot");
  if (4 + json + som > LIMITS.maxBodyBytes) return teGroot('Het bericht is te groot');
  return null;
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
  const groot = controleerGrenzen(w, bijlagen);
  if (groot) return groot;
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
export class BonOntvangst {
  /** het ID van de bon waarvan deze aanroep het bestand in de spool neerzette (en dat nog niet definitief is) */
  private nieuw: string | null = null;
  constructor(
    private readonly db: Db,
    private readonly spool: ReceiptSpool,
    private readonly opties: BonOntvangstOpties,
  ) {
  }

  verwerk(deviceId: string, w: Wijziging, route: string, bijlagen: Buffer[]): SyncResultaat {
    this.nieuw = null;
    // 1. exact dezelfde sleutel al gezien: niets schrijven en de uitkomst van de eerste keer herhalen
    const bekend = this.db
      .prepare('SELECT uitkomst, fout FROM sync_ontvangen WHERE apparaat_id = ? AND entiteit = ? AND uuid = ? AND revisie = ?')
      .get(deviceId, w.entiteit, w.uuid, w.revisie) as RegisterRij | undefined;
    if (bekend) return bekend.uitkomst === 'afgewezen' ? { status: 200, uitkomst: 'afgewezen', fout: bekend.fout ?? undefined } : { status: 200, uitkomst: 'overgeslagen' };

    // 1b. de grootte-grenzen van het protocol, ook voor map en mail (de notitie wordt pas daarna getrimd)
    const groot = controleerGrenzen(w, bijlagen);
    if (groot) return groot;

    // 2. een document heeft één revisie; de velden en de bijlagen kloppen
    if (w.revisie !== 1) return { status: 400, fout: 'ongeldig', melding: 'Een bon heeft alleen revisie 1' };
    const gelezen = leesBonVelden(w.velden);
    if (!gelezen.ok) return { status: 400, fout: 'veld-ongeldig', veld: gelezen.veld, melding: gelezen.melding };
    const melding = controleerBijlagen(gelezen.velden.fotos, bijlagen);
    if (melding) return { status: 400, fout: 'ongeldig', melding };

    // 3. opslaan in de spool: hetzelfde als bij het bon-bericht
    const bericht: ReceiptMessage = { soort: 'bon', tijd: w.tijd, id: w.uuid, betaalwijze: gelezen.velden.betaalwijze, notitie: gelezen.velden.notitie, locatie: gelezen.velden.locatie, fotos: bijlagen };
    const spoel = this.spool.accept(bericht, deviceId, { keepLocation: this.opties.keepLocation?.() ?? false });
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
   *
   * Lukt het verwijderen niet (bv. de map is tijdelijk niet schrijfbaar), dan verdwijnt die fout niet stil: de
   * spool onthoudt het bestand als "moet weg" (ReceiptSpool.intrekken). Dat heeft twee gevolgen: opruimen()
   * probeert het opnieuw (bij de volgende bon en bij de wachtrij), en recover() importeert zo'n bestand nooit
   * als bon, want de telefoon kreeg voor deze ontvangst geen bevestiging. De fout komt in het logboek, zonder inhoud.
   */
  terugdraaien(id: string): void {
    const definitief = this.nieuw === id;
    this.nieuw = null;
    try {
      if (definitief) {
        if (!this.spool.intrekken(id)) this.opties.log?.('Een bestand van een mislukte bonontvangst kon niet worden verwijderd; het wordt later opnieuw geprobeerd en nooit als bon geïmporteerd');
      } else {
        this.spool.ruimTijdelijkOp(id);
      }
    } catch {
      /* ongeldig ID: er is nooit een bestand neergezet */
    }
  }

  /** Probeert bestanden van eerdere mislukte ontvangsten alsnog te verwijderen. Gooit nooit. */
  opruimen(): void {
    try {
      this.spool.opruimen();
    } catch {
      /* volgende keer */
    }
  }
}
