import type { Db } from '../db/database';
import { KLANT_VELDEN, leesKlantVelden, type Wijziging } from '@gratis-boekhouden/kern';
import { KlantVeldFout, normaliseerSyncVelden, type RelationsService } from '../relations/relations';
import type { InvoiceService } from '../documents/invoices';
import type { ReceiptSpool } from '../scanner/spool';
import { BonOntvangst, controleerFoto } from './bonnen';
import { FactuurOntvangst } from './facturen';
import { FotoOntvangst } from './fotos';
import { ProjectOntvangst } from './projecten';
import { SyncWachtrij, type WachtrijBehandelaar } from './wachtrij';

/** De uitkomst van het verwerken van een wijziging, in de ene vorm voor alle routes. */
export interface SyncResultaat {
  /** de statuscode voor de telefoon: 200, 400, 409, 500 of 503 */
  status: number;
  /** bij 200: toegepast, overgeslagen, afgewezen, wacht (in de wachtrij) of niet-ondersteund */
  uitkomst?: 'toegepast' | 'overgeslagen' | 'afgewezen' | 'wacht' | 'niet-ondersteund';
  /** bij afgewezen en bij elke fout: de reden als code (id-botst, geen-klant, klus-gekoppeld, nummer-bezet, factuur-geweigerd, veld-ongeldig, ongeldig, veld-ongeldig, klant-onbekend, project-onbekend, wachtrij-vol, opslaan-mislukt) */
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
  /**
   * De factuurdienst voor het overnemen van telefoonfacturen: de InvoiceService van de app, met de gedeelde Ledger
   * en dus de writeGuard van de boekhouderskopie. Ontbreekt hij, dan blijft factuur niet-ondersteund (er wordt
   * niets geboekt): een eigen Ledger zou de guard omzeilen.
   */
  invoices?: Pick<InvoiceService, 'importDefinitive'>;
  /**
   * De spool van de bonnenscanner (src/scanner/spool.ts) voor het opslaan van een bon die als wijziging binnenkomt.
   * Ontbreekt hij, dan blijft bon niet-ondersteund (er wordt niets bewaard).
   */
  spool?: ReceiptSpool;
  /** mag de locatie van een bon bewaard worden? (opt-in van #32; standaard niet) */
  keepLocation?: () => boolean;
  /**
   * De map van de administratie (de map met bijlagen/ erin) voor het bewaren van foto's van de telefoon bij een project.
   * Ontbreekt hij, dan blijft foto niet-ondersteund (er wordt niets bewaard).
   */
  adminDir?: string;
  /** Verwijdert één fotobestand bij het terugdraaien van een mislukte ontvangst; alleen voor tests die een mislukte verwijdering nabootsen. */
  fotoVerwijderBestand?: (pad: string) => void;
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
 * Verwerkt wijzigingen van een telefoon in de administratie. Voor nu klanten, projecten, facturen (src/sync/facturen.ts) en bonnen (src/sync/bonnen.ts, met
 * bijlagen) en foto's bij een project (src/sync/fotos.ts, met bijlagen en de wachtrij voor een nog onbekend project); zonder
 * spool blijft bon, zonder administratiemap blijft foto niet-ondersteund en laat niets achter (de telefoon beschouwt dat als niet afgeleverd).
 *
 * Idempotent op de exacte registersleutel (apparaat_id, entiteit, uuid, revisie) in sync_ontvangen, per
 * veld samengevoegd op (tijd, bron) door RelationsService, en per wijziging één databasetransactie:
 * registercontrole, opzoeken, toepassen, wijzigingsnummer, logboek en registerrij slagen samen of
 * helemaal niet. Er wordt nooit iets verwijderd of stil samengevoegd. Schrijven naar relations gaat
 * uitsluitend via RelationsService.maakVanSync en pasVeldenToe; projecten gaan via ProjectOntvangst
 * (src/sync/projecten.ts), met de wachtrij (src/sync/wachtrij.ts) voor projecten van een onbekende klant.
 * Na elke toegepaste klant, elk toegepast project en elke toegepaste factuur wordt de wachtrij verwerkt, en bij elke volgende wijziging van een apparaat met wachtende facturen.
 */
export class SyncOntvangst {
  private readonly now: () => number;
  private readonly log: (melding: string) => void;
  private readonly projecten: ProjectOntvangst;
  private readonly facturen: FactuurOntvangst | null;
  private readonly wachtrij: SyncWachtrij;
  private readonly bonnen: BonOntvangst | null;
  private readonly fotos: FotoOntvangst | null;

  constructor(
    private readonly db: Db,
    private readonly relations: RelationsService,
    opties: SyncOntvangstOpties = {},
  ) {
    this.now = opties.now ?? Date.now;
    this.log = opties.log ?? (() => undefined);
    const wachtrijOpties = { now: this.now, log: this.log };
    // de wachtrij en de projectontvangst kennen elkaar: de wachtrij roept de ontvangst aan om rijen te verwerken
    const behandelaars: WachtrijBehandelaar[] = [];
    this.wachtrij = new SyncWachtrij(db, behandelaars, wachtrijOpties);
    this.projecten = new ProjectOntvangst(db, relations, this.wachtrij, wachtrijOpties);
    behandelaars.push(this.projecten);
    this.facturen = opties.invoices ? new FactuurOntvangst(db, relations, opties.invoices, this.wachtrij, wachtrijOpties) : null;
    if (this.facturen) behandelaars.push(this.facturen);
    this.fotos = opties.adminDir ? new FotoOntvangst(db, opties.adminDir, this.wachtrij, { ...wachtrijOpties, keepLocation: opties.keepLocation, verwijderBestand: opties.fotoVerwijderBestand }) : null;
    if (this.fotos) behandelaars.push(this.fotos);
    this.bonnen = opties.spool ? new BonOntvangst(db, opties.spool, { now: this.now, keepLocation: opties.keepLocation, log: this.log }) : null;
  }

  /**
   * @param deviceId het apparaat-ID van de telefoon (base64url), de sleutel in het register
   * @param bron de apparaatcode van de telefoon (M1, M2, ...), de bron van elk veld; nooit het deviceId
   * @param route waar de wijziging vandaan kwam (netwerk, map of mail); alleen voor het register
   * @param bijlagen de JPEG's achter een bon- of fotowijziging, in volgorde (anders leeg)
   */
  verwerk(deviceId: string, bron: string, wijziging: Wijziging, route: string = 'netwerk', bijlagen: Buffer[] = []): SyncResultaat {
    const uitslag = this.verwerkEen(deviceId, bron, wijziging, route, bijlagen);
    // een toegepaste klant, project of factuur kan wachtende wijzigingen vrijmaken (een cascade); dat gebeurt na de
    // transactie van deze wijziging, zodat een fout daarin deze wijziging niet terugdraait. Een klantwijziging die als
    // overgeslagen wordt beantwoord (een herhaling) probeert de wachtrij ook opnieuw: na een tijdelijke opslagfout kan
    // de klant er al zijn terwijl het wachtende project nog ontbreekt. Verder hervat elke wijziging van een apparaat met
    // wachtende facturen de wachtrij (bv. nadat de boekhouder de periode heeft heropend), ongeacht de uitkomst of de
    // statuscode (ook 503 wachtrij-vol, 400, 409, 500) en ook voor bon en foto. Het antwoord verandert daar nooit door.
    if ((uitslag.status === 200 && (uitslag.uitkomst === 'toegepast' || (uitslag.uitkomst === 'overgeslagen' && wijziging.entiteit === 'klant'))) || this.heeftWachtendeFacturen(deviceId)) this.verwerkWachtrij();
    return uitslag;
  }

  private verwerkEen(deviceId: string, bron: string, wijziging: Wijziging, route: string, bijlagen: Buffer[]): SyncResultaat {
    if (wijziging.entiteit === 'foto' && this.fotos) return this.verwerkFoto(deviceId, bron, wijziging, route, bijlagen);
    if (wijziging.entiteit === 'foto') {
      // Zonder administratiemap: een foto met bijlagen wordt wel gelezen en gecontroleerd, maar nog niet bewaard; zonder bijlagen is er niets te lezen.
      return (bijlagen.length > 0 ? controleerFoto(wijziging, bijlagen) : null) ?? { status: 200, uitkomst: 'niet-ondersteund' };
    }
    if (wijziging.entiteit === 'bon' && !this.bonnen) return { status: 200, uitkomst: 'niet-ondersteund' };
    if (wijziging.entiteit === 'bon') return this.verwerkBon(deviceId, wijziging, route, bijlagen);
    try {
      return this.db.transaction(() => {
        if (wijziging.entiteit === 'klant') return this.verwerkKlant(deviceId, bron, wijziging, route);
        if (wijziging.entiteit === 'factuur') return this.facturen ? this.facturen.verwerk(deviceId, bron, wijziging, route) : { status: 200, uitkomst: 'niet-ondersteund' as const };
        return this.projecten.verwerk(deviceId, bron, wijziging, route);
      })();
    } catch (e) {
      this.log(`${wijziging.entiteit === 'klant' ? 'Klantwijziging' : wijziging.entiteit === 'factuur' ? 'Factuurwijziging' : 'Projectwijziging'} van de telefoon opslaan mislukt: ${(e as Error).message}`);
      return { status: 500, fout: 'opslaan-mislukt' };
    }
  }

  /**
   * Een bon: het bestand in de spool en de rijen (spool en register) horen bij elkaar. De rijen gaan in één
   * transactie, met volle schrijfzekerheid zoals bij het bon-bericht (de telefoon ruimt de bon op zodra hij
   * de bevestiging heeft); lukt het niet, dan gaat ook het bestand weg en blijft er niets achter.
   */
  private verwerkBon(deviceId: string, w: Wijziging, route: string, bijlagen: Buffer[]): SyncResultaat {
    const bonnen = this.bonnen!;
    bonnen.opruimen(); // bestanden van eerdere mislukte ontvangsten alsnog weg
    const voor = this.db.pragma('synchronous', { simple: true }) as number;
    try {
      this.db.pragma('synchronous = FULL');
      const uitslag = this.db.transaction(() => bonnen.verwerk(deviceId, w, route, bijlagen))();
      bonnen.afgerond();
      return uitslag;
    } catch (e) {
      bonnen.terugdraaien(w.uuid);
      this.log(`Bonwijziging van de telefoon opslaan mislukt: ${(e as Error).message}`);
      return { status: 500, fout: 'opslaan-mislukt' };
    } finally {
      try {
        this.db.pragma(`synchronous = ${voor}`);
      } catch {
        /* de administratie gaat net dicht */
      }
    }
  }

  /**
   * Een foto: de bestanden onder bijlagen/ en de rijen (job_photos, register of wachtrij) horen bij elkaar. Zelfde
   * werkwijze als bij een bon: de rijen gaan in één transactie met volle schrijfzekerheid; lukt het niet, dan gaan ook de
   * bestanden weg die deze ontvangst neerzette en blijft er niets achter.
   */
  private verwerkFoto(deviceId: string, bron: string, w: Wijziging, route: string, bijlagen: Buffer[]): SyncResultaat {
    const fotos = this.fotos!;
    fotos.opruimen(); // bestanden van eerdere mislukte ontvangsten alsnog weg
    const voor = this.db.pragma('synchronous', { simple: true }) as number;
    try {
      this.db.pragma('synchronous = FULL');
      const uitslag = this.db.transaction(() => fotos.verwerk(deviceId, bron, w, route, bijlagen))();
      fotos.afgerond();
      return uitslag;
    } catch (e) {
      fotos.terugdraaien();
      this.log(`Fotowijziging van de telefoon opslaan mislukt: ${(e as Error).message}`);
      return { status: 500, fout: 'opslaan-mislukt' };
    } finally {
      try {
        this.db.pragma(`synchronous = ${voor}`);
      } catch {
        /* de administratie gaat net dicht */
      }
    }
  }

  private heeftWachtendeFacturen(deviceId: string): boolean {
    try {
      return this.wachtrij.aantalOnverwerktVan(deviceId, 'factuur') > 0;
    } catch {
      return false;
    }
  }

  /** Verwerkt wat in de wachtrij kan worden verwerkt (ook bij het starten van de receiver). Gooit nooit. */
  verwerkWachtrij(): void {
    this.bonnen?.opruimen();
    this.fotos?.opruimen();
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
