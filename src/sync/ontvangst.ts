import type { Db } from '../db/database';
import { KLANT_VELDEN, leesKlantVelden, type Wijziging } from '@gratis-boekhouden/kern';
import { KlantVeldFout, normaliseerSyncVelden, type RelationsService } from '../relations/relations';

/** De uitkomst van het verwerken van een wijziging, in de ene vorm voor alle routes. */
export interface SyncResultaat {
  /** de statuscode voor de telefoon: 200, 400, 409 of 500 */
  status: number;
  /** bij 200: toegepast, overgeslagen, afgewezen of niet-ondersteund */
  uitkomst?: 'toegepast' | 'overgeslagen' | 'afgewezen' | 'niet-ondersteund';
  /** bij afgewezen en bij elke fout: de reden als code (geen-klant, veld-ongeldig, klant-onbekend, opslaan-mislukt) */
  fout?: string;
  /** bij veld-ongeldig: het veld (Nederlandse naam) waar het om gaat */
  veld?: string;
  /** bij veld-ongeldig: een melding in het Nederlands, met de veldnaam erin */
  melding?: string;
}

export interface SyncOntvangstOpties {
  /** de pc-klok in milliseconden (voor ontvangen_op); standaard Date.now */
  now?: () => number;
  log?: (melding: string) => void;
}

interface RegisterRij {
  uitkomst: string;
  fout: string | null;
}

/** Terug naar de Nederlandse veldnaam bij een kolom (voor de melding aan de telefoon). */
function veldnaamVanKolom(kolom: string): string {
  for (const [naam, def] of Object.entries(KLANT_VELDEN)) if (def.kolom === kolom) return naam;
  return kolom;
}

/**
 * Verwerkt wijzigingen van een telefoon in de administratie. Voor nu alleen klanten; project, factuur,
 * bon en foto geven niet-ondersteund en laten niets achter (de telefoon beschouwt dat als niet afgeleverd).
 *
 * Idempotent op de exacte registersleutel (apparaat_id, entiteit, uuid, revisie) in sync_ontvangen, per
 * veld samengevoegd op (tijd, bron) door RelationsService, en per wijziging één databasetransactie:
 * registercontrole, opzoeken, toepassen, wijzigingsnummer, logboek en registerrij slagen samen of
 * helemaal niet. Er wordt nooit iets verwijderd of stil samengevoegd. Schrijven naar relations gaat
 * uitsluitend via RelationsService.maakVanSync en pasVeldenToe.
 */
export class SyncOntvangst {
  private readonly now: () => number;
  private readonly log: (melding: string) => void;

  constructor(
    private readonly db: Db,
    private readonly relations: RelationsService,
    opties: SyncOntvangstOpties = {},
  ) {
    this.now = opties.now ?? Date.now;
    this.log = opties.log ?? (() => undefined);
  }

  /**
   * @param deviceId het apparaat-ID van de telefoon (base64url), de sleutel in het register
   * @param bron de apparaatcode van de telefoon (M1, M2, ...), de bron van elk veld; nooit het deviceId
   * @param route waar de wijziging vandaan kwam (netwerk, map of mail); alleen voor het register
   */
  verwerk(deviceId: string, bron: string, wijziging: Wijziging, route: string = 'netwerk'): SyncResultaat {
    if (wijziging.entiteit !== 'klant') return { status: 200, uitkomst: 'niet-ondersteund' };
    try {
      return this.db.transaction(() => this.verwerkKlant(deviceId, bron, wijziging, route))();
    } catch (e) {
      this.log(`Klantwijziging van de telefoon opslaan mislukt: ${(e as Error).message}`);
      return { status: 500, fout: 'opslaan-mislukt' };
    }
  }

  private verwerkKlant(deviceId: string, bron: string, w: Wijziging, route: string): SyncResultaat {
    // 1. exact dezelfde sleutel al gezien: niets schrijven en de uitkomst van de eerste keer herhalen
    const bekend = this.db
      .prepare('SELECT uitkomst, fout FROM sync_ontvangen WHERE apparaat_id = ? AND entiteit = ? AND uuid = ? AND revisie = ?')
      .get(deviceId, w.entiteit, w.uuid, w.revisie) as RegisterRij | undefined;
    if (bekend) return bekend.uitkomst === 'afgewezen' ? { status: 200, uitkomst: 'afgewezen', fout: bekend.fout ?? undefined } : { status: 200, uitkomst: 'overgeslagen' };

    // 2. elk veld los controleren: schema in de kern, daarna de regels per veld van de administratie
    const gelezen = leesKlantVelden(w.velden);
    if (!gelezen.ok) return { status: 400, fout: 'veld-ongeldig', veld: gelezen.veld, melding: gelezen.melding };
    let velden: Record<string, unknown>;
    try {
      velden = normaliseerSyncVelden(gelezen.velden);
    } catch (e) {
      if (!(e instanceof KlantVeldFout)) throw e;
      const veld = veldnaamVanKolom(e.kolom);
      return { status: 400, fout: 'veld-ongeldig', veld, melding: `Het veld ${veld} klopt niet: ${e.message}` };
    }

    // 3. opzoeken: eerst de uuid zelf, dan een alias; een bekende klant krijgt de wijziging
    const klant = this.relations.vindOpSyncUuid(w.uuid);
    let uitkomst: 'toegepast' | 'overgeslagen' | 'afgewezen';
    let fout: string | null = null;
    try {
      if (!klant) {
        if (!Object.hasOwn(velden, 'name')) return { status: 409, fout: 'klant-onbekend' };
        this.relations.maakVanSync(w.uuid, velden, w.tijd, bron);
        uitkomst = 'toegepast';
      } else if (klant.type === 'leverancier') {
        uitkomst = 'afgewezen';
        fout = 'geen-klant';
      } else {
        uitkomst = this.relations.pasVeldenToe(klant.id, velden, w.tijd, bron).toegepast.length > 0 ? 'toegepast' : 'overgeslagen';
      }
    } catch (e) {
      // een combinatie die de pc zelf zou weigeren (land met KvK-nummer): de transactie is teruggerold
      if (!(e instanceof KlantVeldFout)) throw e;
      const veld = veldnaamVanKolom(e.kolom);
      return { status: 400, fout: 'veld-ongeldig', veld, melding: `Het veld ${veld} klopt niet: ${e.message}` };
    }

    // 4. registerrij: de uitkomst van de eerste verwerking
    this.db
      .prepare(
        `INSERT INTO sync_ontvangen (apparaat_id, entiteit, uuid, revisie, tijd, ontvangen_op, uitkomst, fout, route) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(apparaat_id, entiteit, uuid, revisie) DO NOTHING`,
      )
      .run(deviceId, w.entiteit, w.uuid, w.revisie, w.tijd, this.now(), uitkomst, fout, route);
    return fout ? { status: 200, uitkomst, fout } : { status: 200, uitkomst };
  }
}
