import type { Db } from '../db/database';
import { KLANT_VELDEN, leesKlantVelden, type Wijziging } from '@gratis-boekhouden/kern';
import { KlantVeldFout, normaliseerSyncVelden, type RelationsService } from '../relations/relations';
import { Ledger } from '../core-ledger/ledger';
import { InvoiceService } from '../documents/invoices';
import { TemplateService } from '../documents/templates';
import { SettingsService } from '../settings/settings';
import { FactuurOntvangst } from './facturen';
import { ProjectOntvangst } from './projecten';
import { SyncWachtrij } from './wachtrij';

/** De uitkomst van het verwerken van een wijziging, in de ene vorm voor alle routes. */
export interface SyncResultaat {
  /** de statuscode voor de telefoon: 200, 400, 409, 500 of 503 */
  status: number;
  /** bij 200: toegepast, overgeslagen, afgewezen, wacht (in de wachtrij) of niet-ondersteund */
  uitkomst?: 'toegepast' | 'overgeslagen' | 'afgewezen' | 'wacht' | 'niet-ondersteund';
  /** bij afgewezen en bij elke fout: de reden als code (geen-klant, klus-gekoppeld, nummer-bezet, origineel-onbekend, periode, factuur-geweigerd, ongeldig, veld-ongeldig, klant-onbekend, project-onbekend, wachtrij-vol, opslaan-mislukt) */
  fout?: string;
  /** bij veld-ongeldig: het veld (Nederlandse naam) waar het om gaat */
  veld?: string;
  /** bij veld-ongeldig en bij een afwijzing die uitleg nodig heeft: een melding in het Nederlands */
  melding?: string;
}

export interface SyncOntvangstOpties {
  /** de pc-klok in milliseconden (voor ontvangen_op); standaard Date.now */
  now?: () => number;
  log?: (melding: string) => void;
  /** de factuurdienst voor het overnemen van telefoonfacturen; standaard een eigen InvoiceService op dezelfde databank */
  invoices?: Pick<InvoiceService, 'importDefinitive'>;
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
 * Verwerkt wijzigingen van een telefoon in de administratie. Voor nu klanten, projecten en facturen (het directe pad, zie src/sync/facturen.ts); bon
 * en foto geven niet-ondersteund en laten niets achter (de telefoon beschouwt dat als niet afgeleverd).
 *
 * Idempotent op de exacte registersleutel (apparaat_id, entiteit, uuid, revisie) in sync_ontvangen, per
 * veld samengevoegd op (tijd, bron) door RelationsService, en per wijziging één databasetransactie:
 * registercontrole, opzoeken, toepassen, wijzigingsnummer, logboek en registerrij slagen samen of
 * helemaal niet. Er wordt nooit iets verwijderd of stil samengevoegd. Schrijven naar relations gaat
 * uitsluitend via RelationsService.maakVanSync en pasVeldenToe; projecten gaan via ProjectOntvangst
 * (src/sync/projecten.ts), met de wachtrij (src/sync/wachtrij.ts) voor projecten van een onbekende klant.
 * Na elke toegepaste klant en elk toegepast project wordt de wachtrij verwerkt.
 */
export class SyncOntvangst {
  private readonly now: () => number;
  private readonly log: (melding: string) => void;
  private readonly projecten: ProjectOntvangst;
  private readonly facturen: FactuurOntvangst;
  private readonly wachtrij: SyncWachtrij;

  constructor(
    private readonly db: Db,
    private readonly relations: RelationsService,
    opties: SyncOntvangstOpties = {},
  ) {
    this.now = opties.now ?? Date.now;
    this.log = opties.log ?? (() => undefined);
    const wachtrijOpties = { now: this.now, log: this.log };
    // de wachtrij en de projectontvangst kennen elkaar: de wachtrij roept de ontvangst aan om rijen te verwerken
    const behandelaars: ProjectOntvangst[] = [];
    this.wachtrij = new SyncWachtrij(db, behandelaars, wachtrijOpties);
    this.projecten = new ProjectOntvangst(db, relations, this.wachtrij, wachtrijOpties);
    behandelaars.push(this.projecten);
    // zonder meegegeven dienst: een eigen InvoiceService op dezelfde databank (hij schrijft alleen via importDefinitive)
    const invoices = opties.invoices ?? new InvoiceService(db, new Ledger(db), new SettingsService(db), relations, new TemplateService(db));
    this.facturen = new FactuurOntvangst(db, relations, invoices, wachtrijOpties);
  }

  /**
   * @param deviceId het apparaat-ID van de telefoon (base64url), de sleutel in het register
   * @param bron de apparaatcode van de telefoon (M1, M2, ...), de bron van elk veld; nooit het deviceId
   * @param route waar de wijziging vandaan kwam (netwerk, map of mail); alleen voor het register
   */
  verwerk(deviceId: string, bron: string, wijziging: Wijziging, route: string = 'netwerk'): SyncResultaat {
    if (wijziging.entiteit !== 'klant' && wijziging.entiteit !== 'project' && wijziging.entiteit !== 'factuur') return { status: 200, uitkomst: 'niet-ondersteund' };
    let uitslag: SyncResultaat;
    try {
      uitslag = this.db.transaction(() => {
        if (wijziging.entiteit === 'klant') return this.verwerkKlant(deviceId, bron, wijziging, route);
        if (wijziging.entiteit === 'factuur') return this.facturen.verwerk(deviceId, bron, wijziging, route);
        return this.projecten.verwerk(deviceId, bron, wijziging, route);
      })();
    } catch (e) {
      this.log(`${wijziging.entiteit === 'klant' ? 'Klantwijziging' : wijziging.entiteit === 'factuur' ? 'Factuurwijziging' : 'Projectwijziging'} van de telefoon opslaan mislukt: ${(e as Error).message}`);
      return { status: 500, fout: 'opslaan-mislukt' };
    }
    // een toegepaste klant of een toegepast project kan wachtende wijzigingen vrijmaken (een cascade);
    // dat gebeurt na de transactie van deze wijziging, zodat een fout daarin deze wijziging niet terugdraait.
    // Een klantwijziging die als overgeslagen wordt beantwoord (een herhaling) probeert de wachtrij ook opnieuw:
    // na een tijdelijke opslagfout kan de klant er al zijn terwijl het wachtende project nog ontbreekt.
    if (wijziging.entiteit !== 'factuur' && uitslag.status === 200 && (uitslag.uitkomst === 'toegepast' || (uitslag.uitkomst === 'overgeslagen' && wijziging.entiteit === 'klant'))) this.verwerkWachtrij();
    return uitslag;
  }

  /** Verwerkt wat in de wachtrij kan worden verwerkt (ook bij het starten van de receiver). Gooit nooit. */
  verwerkWachtrij(): void {
    try {
      this.wachtrij.verwerk();
    } catch (e) {
      this.log(`De wachtrij van de telefoon verwerken is mislukt: ${(e as Error).message}`);
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
