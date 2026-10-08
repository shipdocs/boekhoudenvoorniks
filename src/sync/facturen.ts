import type { Db } from '../db/database';
import { leesFactuurVelden, leesWijziging, type FactuurVelden, type Wijziging } from '@gratis-boekhouden/kern';
import type { ImportDefinitiefResultaat, InvoiceService } from '../documents/invoices';
import type { RelationsService } from '../relations/relations';
import type { SyncResultaat } from './ontvangst';
import type { SyncWachtrij, WachtrijBehandelaar, WachtrijRij } from './wachtrij';

export interface FactuurOntvangstOpties {
  /** de pc-klok in milliseconden (voor ontvangen_op); standaard Date.now */
  now?: () => number;
  log?: (melding: string) => void;
}

interface RegisterRij {
  uitkomst: string;
  fout: string | null;
}

/** Waar een wachtende factuur op wacht: een klant, een project, een factuur (het origineel van een creditnota) of een open periode. */
interface Wacht {
  entiteit: 'klant' | 'project' | 'factuur' | 'periode';
  /** de uuid waar het op wacht; bij een periode is er geen object en is dit een lege tekst (de kolom is NOT NULL) */
  uuid: string;
  reden: 'klant-onbekend' | 'project-onbekend' | 'origineel-onbekend' | 'periode';
}

type Uitkomst = { uitkomst: 'toegepast' | 'overgeslagen' } | { uitkomst: 'afgewezen'; fout: string; melding?: string } | { uitkomst: 'wacht'; wacht: Wacht };

/**
 * Neemt een definitieve factuur van de telefoon over (entiteit factuur). Een factuur heeft precies een revisie
 * en wordt nooit bewerkt; de pc-teller wordt niet gebruikt, het nummer is dat van de telefoon.
 *
 * Een factuur die naar iets verwijst dat de pc nog niet kent (klant, project, origineel van een creditnota) of
 * die nu niet geboekt kan worden (afgesloten periode bij de boekhouder) gaat in de wachtrij (SyncWachtrij) en
 * wordt daarna vanzelf overgenomen: bij elke toegepaste klant, elk toegepast project en elke toegepaste factuur,
 * bij de volgende wijziging van hetzelfde apparaat en bij het starten van de receiver. Een wachtende factuur
 * wordt dan opnieuw gelezen en gecontroleerd (ook de apparaatcode in het nummer) en kan alsnog worden afgewezen.
 * Een ontkoppeld apparaat of een afgesloten apparaatcode is geen reden om een ontvangen factuur weg te gooien.
 *
 * Volgorde per wijziging, binnen de databasetransactie van SyncOntvangst.verwerk: register, wachtrij, velden,
 * apparaatcode in het nummer, wachten of overnemen via InvoiceService.importDefinitive, registerrij (of
 * wachtrijrij). Een fout laat dus geen halve rijen achter.
 */
export class FactuurOntvangst implements WachtrijBehandelaar {
  readonly entiteit = 'factuur';
  private readonly now: () => number;
  private readonly log: (melding: string) => void;

  constructor(
    private readonly db: Db,
    private readonly relations: RelationsService,
    private readonly invoices: Pick<InvoiceService, 'importDefinitive'>,
    private readonly wachtrij: SyncWachtrij,
    opties: FactuurOntvangstOpties = {},
  ) {
    this.now = opties.now ?? Date.now;
    this.log = opties.log ?? (() => undefined);
  }

  /** Verwerkt een factuurwijziging; hoort binnen een transactie te draaien (SyncOntvangst doet dat). */
  verwerk(deviceId: string, bron: string, w: Wijziging, route: string): SyncResultaat {
    // 1. exact dezelfde sleutel al gezien: niets schrijven en de uitkomst van de eerste keer herhalen
    const bekend = this.db
      .prepare('SELECT uitkomst, fout FROM sync_ontvangen WHERE apparaat_id = ? AND entiteit = ? AND uuid = ? AND revisie = ?')
      .get(deviceId, w.entiteit, w.uuid, w.revisie) as RegisterRij | undefined;
    if (bekend) return bekend.uitkomst === 'afgewezen' ? { status: 200, uitkomst: 'afgewezen', fout: bekend.fout ?? undefined } : { status: 200, uitkomst: 'overgeslagen' };

    // 1b. dezelfde sleutel staat al in de wachtrij (ook al afgehandeld): de eerst opgeslagen inhoud blijft leidend
    const inWachtrij = this.wachtrij.rij(deviceId, w.entiteit, w.uuid, w.revisie);
    if (inWachtrij) {
      if (inWachtrij.verwerkt_op === null) return { status: 200, uitkomst: 'wacht' };
      return inWachtrij.verwerkt_uitkomst === 'afgewezen' ? { status: 200, uitkomst: 'afgewezen', ...(inWachtrij.verwerkt_reden ? { fout: inWachtrij.verwerkt_reden } : {}) } : { status: 200, uitkomst: 'overgeslagen' };
    }

    // 2. de velden controleren en doorrekenen in de kern
    const gelezen = leesFactuurVelden(w.velden);
    if (!gelezen.ok) return { status: 400, fout: 'veld-ongeldig', veld: gelezen.veld, melding: gelezen.melding };
    const f = gelezen.factuur;

    // 3. de apparaatcode in het nummer moet die van het inzendende apparaat zijn
    if (f.apparaat_code !== bron) return this.apparaatcodeFout(f.apparaat_code, bron);

    // 4. wachten of overnemen
    const uitkomst = this.probeer(w.uuid, f);
    if (uitkomst.uitkomst === 'wacht') {
      // zonder registerrij en zonder factuur: alleen een wachtrijrij; een volle wachtrij geeft 503 (herhaalbaar), nooit een afwijzing
      const r = this.wachtrij.zetIn(deviceId, bron, w, { ...uitkomst.wacht, nummer: f.nummer });
      return r === 'vol' ? { status: 503, fout: 'wachtrij-vol' } : { status: 200, uitkomst: 'wacht' };
    }

    // 5. registerrij in dezelfde transactie: de uitkomst van de eerste verwerking
    this.schrijfRegister(deviceId, w, uitkomst, route);
    if (uitkomst.uitkomst !== 'afgewezen') return { status: 200, uitkomst: uitkomst.uitkomst };
    return { status: 200, uitkomst: 'afgewezen', fout: uitkomst.fout, ...(uitkomst.melding ? { melding: uitkomst.melding } : {}) };
  }

  /**
   * Verwerkt de wachtende rijen van een factuur (aangeroepen door SyncWachtrij), in een transactie; geeft true als
   * er een rij is afgehandeld. Herhaalbaar en idempotent: een afgehandelde rij blijft staan (verwerkt_op gevuld) en
   * wordt niet nog eens verwerkt, een bestaande factuur wordt nooit dubbel geboekt.
   */
  verwerkObject(uuid: string): boolean {
    if (this.wachtrij.onverwerkt('factuur', uuid).length === 0) return false;
    return this.db.transaction(() => {
      let voortgang = false;
      for (const rij of this.wachtrij.onverwerkt('factuur', uuid)) {
        const h = this.hervalideer(rij);
        let uitkomst: Uitkomst;
        if (h.fout !== undefined) {
          this.log(`Wachtende factuurwijziging afgewezen bij het verwerken (${h.fout})`);
          uitkomst = { uitkomst: 'afgewezen', fout: 'veld-ongeldig' };
        } else if (h.f.apparaat_code !== rij.bron) {
          uitkomst = { uitkomst: 'afgewezen', fout: 'ongeldig' };
        } else {
          uitkomst = this.probeer(uuid, h.f);
        }
        if (uitkomst.uitkomst === 'wacht') {
          // wacht nog, mogelijk op iets anders dan eerst (de klant is er nu, het project nog niet)
          this.wachtrij.herplan(rij.id, uitkomst.wacht);
          continue;
        }
        const reden = uitkomst.uitkomst === 'afgewezen' ? uitkomst.fout : null;
        this.schrijfRegister(rij.apparaat_id, { entiteit: 'factuur', uuid, revisie: rij.revisie, tijd: rij.tijd }, uitkomst, 'netwerk');
        if (this.wachtrij.markeer(rij.id, uitkomst.uitkomst, reden)) voortgang = true;
      }
      return voortgang;
    })();
  }

  // ---------------------------------------------------------------------------------------------

  private apparaatcodeFout(code: string, bron: string): SyncResultaat {
    return { status: 400, fout: 'ongeldig', veld: 'nummer', melding: `De apparaatcode in het factuurnummer (${code}) hoort niet bij dit apparaat (${bron})` };
  }

  /** De wijziging uit een wachtrijrij opnieuw lezen en controleren, zoals een nieuwe ontvangst. */
  private hervalideer(rij: WachtrijRij): { f: FactuurVelden; fout?: undefined } | { f?: undefined; fout: string } {
    let raw: unknown;
    try {
      raw = JSON.parse(rij.wijziging);
    } catch {
      return { fout: 'onleesbaar' };
    }
    const w = leesWijziging(raw);
    if (!w.ok || w.wijziging.entiteit !== 'factuur' || w.wijziging.uuid !== rij.uuid) return { fout: 'wijziging' };
    const velden = leesFactuurVelden(w.wijziging.velden);
    if (!velden.ok) return { fout: `${velden.veld}: ${velden.melding}` };
    return { f: velden.factuur };
  }

  /**
   * Bepaalt wat er met een gecontroleerde factuur gebeurt: al aanwezig (overgeslagen), wachten (origineel, klant,
   * project of periode ontbreekt), overnemen of afwijzen. Schrijft alleen bij overnemen, via importDefinitive.
   */
  private probeer(uuid: string, f: FactuurVelden): Uitkomst {
    // documenten hebben precies een revisie: staat de uuid al in de administratie, dan blijft de factuur ongewijzigd
    if (this.db.prepare('SELECT 1 FROM invoices WHERE uuid = ?').get(uuid)) return { uitkomst: 'overgeslagen' };

    // een creditnota wacht op haar origineel (dat zelf nog kan wachten)
    if (f.creditnota_van && !this.db.prepare('SELECT 1 FROM invoices WHERE uuid = ?').get(f.creditnota_van)) {
      return { uitkomst: 'wacht', wacht: { entiteit: 'factuur', uuid: f.creditnota_van, reden: 'origineel-onbekend' } };
    }

    // de klant: eerst de uuid zelf, dan een alias; een gearchiveerde klant telt gewoon. Een onbekende klant of een
    // leverancier: wachten (een leverancier is geen klant, maar wordt nooit stil weggegooid)
    const klant = this.relations.vindOpSyncUuid(f.klant_uuid);
    if (!klant || klant.type === 'leverancier') return { uitkomst: 'wacht', wacht: { entiteit: 'klant', uuid: f.klant_uuid, reden: 'klant-onbekend' } };

    // het project: onbekend wacht; een project van een andere klant geeft een factuur zonder job_id (nooit een afwijzing)
    let jobId: number | null = null;
    if (f.project_uuid) {
      const job = this.db.prepare('SELECT id, relation_id FROM jobs WHERE uuid = ?').get(f.project_uuid) as { id: number; relation_id: number } | undefined;
      if (!job) return { uitkomst: 'wacht', wacht: { entiteit: 'project', uuid: f.project_uuid, reden: 'project-onbekend' } };
      if (job.relation_id === klant.id) jobId = job.id;
    }

    const r = this.invoices.importDefinitive({ uuid, velden: f }, klant.id, jobId);
    if (r.uitkomst === 'nieuw') return { uitkomst: 'toegepast' };
    if (r.uitkomst === 'al_aanwezig' || r.uitkomst === 'conflict') return { uitkomst: 'overgeslagen' };
    return this.afwijzing(r, f);
  }

  /** Vertaalt de weigercode van importDefinitive: wachten (periode, origineel) of een foutcode voor de telefoon (de reden-tekst wordt alleen als melding doorgegeven). */
  private afwijzing(r: ImportDefinitiefResultaat, f: FactuurVelden): Uitkomst {
    const melding = r.reden ?? '';
    // een afgesloten periode bij de boekhouder: wachten tot de periode weer open is (geen object om op te wachten)
    if (r.code === 'periode') return { uitkomst: 'wacht', wacht: { entiteit: 'periode', uuid: '', reden: 'periode' } };
    if (r.code === 'origineel-onbekend' && f.creditnota_van) return { uitkomst: 'wacht', wacht: { entiteit: 'factuur', uuid: f.creditnota_van, reden: 'origineel-onbekend' } };
    if (r.code === 'nummer-bezet') return { uitkomst: 'afgewezen', fout: 'nummer-bezet', melding };
    return { uitkomst: 'afgewezen', fout: 'factuur-geweigerd', melding };
  }

  private schrijfRegister(deviceId: string, w: Pick<Wijziging, 'entiteit' | 'uuid' | 'revisie' | 'tijd'>, uitkomst: Exclude<Uitkomst, { uitkomst: 'wacht' }>, route: string): void {
    const fout = uitkomst.uitkomst === 'afgewezen' ? uitkomst.fout : null;
    this.db
      .prepare(
        `INSERT INTO sync_ontvangen (apparaat_id, entiteit, uuid, revisie, tijd, ontvangen_op, uitkomst, fout, route) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(apparaat_id, entiteit, uuid, revisie) DO NOTHING`,
      )
      .run(deviceId, w.entiteit, w.uuid, w.revisie, w.tijd, this.now(), uitkomst.uitkomst, fout, route);
  }
}
