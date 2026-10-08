import type { Db } from '../db/database';
import { leesFactuurVelden, type Wijziging } from '@gratis-boekhouden/kern';
import type { InvoiceService } from '../documents/invoices';
import type { RelationsService } from '../relations/relations';
import type { SyncResultaat } from './ontvangst';

export interface FactuurOntvangstOpties {
  /** de pc-klok in milliseconden (voor ontvangen_op); standaard Date.now */
  now?: () => number;
  log?: (melding: string) => void;
}

interface RegisterRij {
  uitkomst: string;
  fout: string | null;
}

type Uitkomst = { uitkomst: 'toegepast' | 'overgeslagen' } | { uitkomst: 'afgewezen'; fout: string; melding?: string };

/**
 * Neemt een definitieve factuur van de telefoon over (entiteit factuur), het directe pad: een wachtende
 * wijziging (onbekende klant of project) komt in een latere stap. Een factuur heeft precies een revisie
 * en wordt nooit bewerkt; de pc-teller wordt niet gebruikt, het nummer is dat van de telefoon.
 *
 * Volgorde per wijziging, binnen de databasetransactie van SyncOntvangst.verwerk: register, velden,
 * apparaatcode in het nummer, klant, bestaande uuid, InvoiceService.importDefinitive, registerrij.
 * Een fout laat dus geen halve rijen achter.
 */
export class FactuurOntvangst {
  private readonly now: () => number;

  constructor(
    private readonly db: Db,
    private readonly relations: RelationsService,
    private readonly invoices: Pick<InvoiceService, 'importDefinitive'>,
    opties: FactuurOntvangstOpties = {},
  ) {
    this.now = opties.now ?? Date.now;
  }

  /** Verwerkt een factuurwijziging; hoort binnen een transactie te draaien (SyncOntvangst doet dat). */
  verwerk(deviceId: string, bron: string, w: Wijziging, route: string): SyncResultaat {
    // 1. exact dezelfde sleutel al gezien: niets schrijven en de uitkomst van de eerste keer herhalen
    const bekend = this.db
      .prepare('SELECT uitkomst, fout FROM sync_ontvangen WHERE apparaat_id = ? AND entiteit = ? AND uuid = ? AND revisie = ?')
      .get(deviceId, w.entiteit, w.uuid, w.revisie) as RegisterRij | undefined;
    if (bekend) return bekend.uitkomst === 'afgewezen' ? { status: 200, uitkomst: 'afgewezen', fout: bekend.fout ?? undefined } : { status: 200, uitkomst: 'overgeslagen' };

    // 2. de velden controleren en doorrekenen in de kern
    const gelezen = leesFactuurVelden(w.velden);
    if (!gelezen.ok) return { status: 400, fout: 'veld-ongeldig', veld: gelezen.veld, melding: gelezen.melding };
    const f = gelezen.factuur;

    // 3. de apparaatcode in het nummer moet die van het inzendende apparaat zijn
    if (f.apparaat_code !== bron) {
      return { status: 400, fout: 'ongeldig', veld: 'nummer', melding: `De apparaatcode in het factuurnummer (${f.apparaat_code}) hoort niet bij dit apparaat (${bron})` };
    }

    // 4. de klant: eerst de uuid zelf, dan een alias; een gearchiveerde klant telt gewoon. Een leverancier of
    // onbekende klant: herhaalbaar, zonder rijen (een latere stap zet dit in de wachtrij).
    const klant = this.relations.vindOpSyncUuid(f.klant_uuid);
    if (!klant || klant.type === 'leverancier') return { status: 409, fout: 'klant-onbekend' };

    // 5. documenten hebben precies een revisie: staat de uuid al in de administratie (andere revisie of andere
    // inhoud), dan blijft de factuur ongewijzigd
    let uitkomst: Uitkomst;
    if (this.db.prepare('SELECT 1 FROM invoices WHERE uuid = ?').get(w.uuid)) {
      uitkomst = { uitkomst: 'overgeslagen' };
    } else {
      // 6. overnemen; jobId is null (project_uuid wordt in een latere stap verwerkt)
      const r = this.invoices.importDefinitive({ uuid: w.uuid, velden: f }, klant.id, null);
      if (r.uitkomst === 'nieuw') uitkomst = { uitkomst: 'toegepast' };
      else if (r.uitkomst === 'al_aanwezig' || r.uitkomst === 'conflict') uitkomst = { uitkomst: 'overgeslagen' };
      else uitkomst = this.afwijzing(r.reden ?? '', f.nummer);
    }

    // 7. registerrij in dezelfde transactie: de uitkomst van de eerste verwerking
    const fout = uitkomst.uitkomst === 'afgewezen' ? uitkomst.fout : null;
    this.db
      .prepare(
        `INSERT INTO sync_ontvangen (apparaat_id, entiteit, uuid, revisie, tijd, ontvangen_op, uitkomst, fout, route) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(apparaat_id, entiteit, uuid, revisie) DO NOTHING`,
      )
      .run(deviceId, w.entiteit, w.uuid, w.revisie, w.tijd, this.now(), uitkomst.uitkomst, fout, route);
    if (uitkomst.uitkomst !== 'afgewezen') return { status: 200, uitkomst: uitkomst.uitkomst };
    return { status: 200, uitkomst: 'afgewezen', fout: uitkomst.fout, ...(uitkomst.melding ? { melding: uitkomst.melding } : {}) };
  }

  /** Vertaalt de weigering van importDefinitive (een Nederlandse tekst) naar een foutcode. */
  private afwijzing(reden: string, nummer: string): Uitkomst {
    if (reden === `Factuurnummer ${nummer} bestaat al bij een andere factuur.`) return { uitkomst: 'afgewezen', fout: 'nummer-bezet', melding: reden };
    if (reden === 'De creditnota hoort bij een factuur die de pc niet kent.') return { uitkomst: 'afgewezen', fout: 'origineel-onbekend', melding: reden };
    if (/\bperiode\b|boekhouder/i.test(reden)) return { uitkomst: 'afgewezen', fout: 'periode', melding: reden };
    return { uitkomst: 'afgewezen', fout: 'factuur-geweigerd', melding: reden };
  }
}
