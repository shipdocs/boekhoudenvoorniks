import type { Db } from '../db/database';
import { leesProjectVelden, leesWijziging, type Wijziging } from '@gratis-boekhouden/kern';
import { BRON_PC, JOB_KOLOMMEN, JOB_VELD_MAPPING, logJobVeld, schrijfJobVeld, type JobKolom } from '../jobs/revisie';
import { wintVeld, type RelationsService } from '../relations/relations';
import { volgendeSyncSeq } from './teller';
import { veldOndergrens } from './ondergrens';
import type { SyncResultaat } from './ontvangst';
import type { SyncWachtrij, WachtrijBehandelaar, WachtrijRij } from './wachtrij';

/** De melding bij een afwijzing die in het register staat (herhaling levert dezelfde afwijzing). */
export const KLUS_GEKOPPELD_MELDING = 'De klant van dit project kan niet meer wijzigen: er hangen al een offerte, facturen, aankopen, ritten of werkbonregels aan.';

export interface ProjectOntvangstOpties {
  now?: () => number;
  log?: (melding: string) => void;
}

interface RegisterRij {
  uitkomst: string;
  fout: string | null;
}

interface JobRij {
  id: number;
  relation_id: number;
  title: string;
  status: string;
  revisie: number;
  gewijzigd_op: number;
  created_at: string;
  [kolom: string]: unknown;
}

/** Een gecontroleerde en genormaliseerde projectwijziging; de klant is nog de uuid-tekst. */
type ProjectVelden = Record<string, string | number | null>;

type Uitkomst = { uitkomst: 'toegepast' | 'overgeslagen' } | { uitkomst: 'afgewezen'; fout: string } | { uitkomst: 'wacht'; wachtOp: string };

const tekst = (v: unknown) => (typeof v === 'string' ? v.trim() || null : v ?? null);

/**
 * Opschonen van de waarden zoals de pc ze bewaart (JobService): titel getrimd, een leeg adres of lege
 * notitie wordt null. De regels zelf (titel niet leeg, datums, status) zijn al in de kern gecontroleerd en
 * zijn dezelfde of strenger dan die van het pc-pad, zodat een gewone pc-bewerking daarna nooit wordt geblokkeerd.
 */
function schoon(velden: ProjectVelden): ProjectVelden {
  const uit = Object.create(null) as ProjectVelden;
  for (const kolom of Object.keys(velden)) {
    const waarde = velden[kolom]!;
    uit[kolom] = kolom === 'title' ? (waarde as string).trim() : kolom === 'address' || kolom === 'notes' ? (tekst(waarde) as string | null) : waarde;
  }
  return uit;
}

/**
 * De ontvangst van projecten (klussen) van een telefoon: dezelfde regels als klanten (SyncOntvangst), per
 * veld samengevoegd op (tijd, bron), idempotent op de registersleutel, en elke wijziging in een transactie.
 * Een project voor een nog onbekende klant gaat in de wachtrij (SyncWachtrij) en wordt vanzelf verwerkt
 * zodra die klant er is. Schrijven naar jobs gaat per veld met directe SQL en een vaste kolommenlijst:
 * een veldnaam van de telefoon wordt nooit als kolomnaam of objectsleutel gebruikt.
 */
export class ProjectOntvangst implements WachtrijBehandelaar {
  readonly entiteit = 'project';
  private readonly now: () => number;
  private readonly log: (melding: string) => void;

  constructor(
    private readonly db: Db,
    private readonly relations: RelationsService,
    private readonly wachtrij: SyncWachtrij,
    opties: ProjectOntvangstOpties = {},
  ) {
    this.now = opties.now ?? Date.now;
    this.log = opties.log ?? (() => undefined);
  }

  /** Verwerkt een projectwijziging; hoort binnen een transactie te draaien (SyncOntvangst doet dat). */
  verwerk(deviceId: string, bron: string, w: Wijziging, route: string): SyncResultaat {
    // 1. exact dezelfde sleutel al gezien: niets schrijven en de uitkomst van de eerste keer herhalen
    const bekend = this.db
      .prepare('SELECT uitkomst, fout FROM sync_ontvangen WHERE apparaat_id = ? AND entiteit = ? AND uuid = ? AND revisie = ?')
      .get(deviceId, w.entiteit, w.uuid, w.revisie) as RegisterRij | undefined;
    if (bekend) return bekend.uitkomst === 'afgewezen' ? this.afwijzing(bekend.fout) : { status: 200, uitkomst: 'overgeslagen' };

    // 1b. dezelfde sleutel staat al in de wachtrij (ook al afgehandeld): de eerst opgeslagen inhoud blijft leidend,
    // de herhaling wordt niet toegepast en krijgt het antwoord van de eerste keer
    const inWachtrij = this.wachtrij.rij(deviceId, w.entiteit, w.uuid, w.revisie);
    if (inWachtrij) {
      if (inWachtrij.verwerkt_op === null) return { status: 200, uitkomst: 'wacht' };
      return inWachtrij.verwerkt_uitkomst === 'afgewezen' ? this.afwijzing(inWachtrij.verwerkt_reden) : { status: 200, uitkomst: 'overgeslagen' };
    }

    // 2. elk veld los controleren in de kern
    const gelezen = leesProjectVelden(w.velden);
    if (!gelezen.ok) return { status: 400, fout: 'veld-ongeldig', veld: gelezen.veld, melding: gelezen.melding };
    const velden = schoon(gelezen.velden);

    // 3. bestaat het project al?
    const job = this.vindJob(w.uuid);
    let uitkomst: Uitkomst;
    if (!job) {
      const heeftBeide = Object.hasOwn(velden, 'title') && Object.hasOwn(velden, 'relation_id');
      if (heeftBeide) {
        uitkomst = this.maakAan(w, velden, bron);
      } else {
        // een latere revisie van een wachtend project wacht ook, met dezelfde reden als de eerste rij; anders is het onbekend
        const wachtOp = this.wachtrij.eersteWachtOp('project', w.uuid);
        if (!wachtOp) return { status: 409, fout: 'project-onbekend' };
        uitkomst = { uitkomst: 'wacht', wachtOp: wachtOp.uuid };
      }
    } else {
      uitkomst = this.pasToe(job, w, velden, bron);
    }

    // 4. wachten: in de wachtrij, zonder registerrij
    if (uitkomst.uitkomst === 'wacht') return this.zetInWachtrij(deviceId, bron, w, uitkomst.wachtOp);

    // 5. registerrij: de uitkomst van de eerste verwerking
    this.schrijfRegister(deviceId, w, uitkomst.uitkomst, uitkomst.uitkomst === 'afgewezen' ? uitkomst.fout : null, route);
    return uitkomst.uitkomst === 'afgewezen' ? this.afwijzing(uitkomst.fout) : { status: 200, uitkomst: uitkomst.uitkomst };
  }

  /** Verwerkt de wachtende rijen van een project (aangeroepen door SyncWachtrij); true als er een rij is afgehandeld. */
  verwerkObject(uuid: string): boolean {
    if (this.wachtrij.onverwerkt('project', uuid).length === 0) return false;
    return this.db.transaction(() => {
      let voortgang = false;
      const rijen = this.wachtrij.onverwerkt('project', uuid).map((rij) => ({ rij, ...this.hervalideer(rij) }));
      // een rij die bij het verwerken niet meer klopt wordt afgewezen, ook als de klant er nog niet is
      for (const r of rijen) {
        if (r.fout === undefined) continue;
        this.schrijfRegister(r.rij.apparaat_id, { entiteit: 'project', uuid, revisie: r.rij.revisie, tijd: r.rij.tijd }, 'afgewezen', 'veld-ongeldig', 'netwerk');
        this.wachtrij.markeer(r.rij.id, 'afgewezen', 'veld-ongeldig');
        this.log(`Wachtende projectwijziging afgewezen bij het verwerken (${r.fout})`);
        voortgang = true;
      }
      const geldig = rijen.filter((r): r is typeof r & { w: Wijziging; velden: ProjectVelden } => r.fout === undefined);
      const heeftMaakVelden = (r: { velden: ProjectVelden }) => Object.hasOwn(r.velden, 'title') && Object.hasOwn(r.velden, 'relation_id');
      const afgehandeld = new Set<unknown>();
      let job = this.vindJob(uuid);
      let makerAfgewezen = false;
      if (!job) {
        // een rij met titel en een beschikbare klant maakt het project; een oudere rij die nog op een onbekende klant
        // wacht houdt een nieuwere rij met een bekende klant niet tegen (de revisievolgorde is hier niet van belang)
        for (const maker of geldig.filter(heeftMaakVelden)) {
          if (this.klant(maker.velden.relation_id as string).soort === 'onbekend') continue;
          const uitkomst = this.maakAan(maker.w, maker.velden, maker.rij.bron);
          this.rondAf(maker.rij, maker.w, uitkomst);
          afgehandeld.add(maker);
          voortgang = true;
          if (uitkomst.uitkomst === 'afgewezen') makerAfgewezen = true;
          job = this.vindJob(uuid);
          if (job) break;
        }
      }
      for (const r of geldig) {
        if (afgehandeld.has(r) || !job) continue;
        // een rij die nog op een onbekende klant wacht blijft liggen; de rest gaat door
        if (Object.hasOwn(r.velden, 'relation_id') && this.klant(r.velden.relation_id as string).soort === 'onbekend') continue;
        const uitkomst = this.pasToe(this.vindJob(uuid)!, r.w, r.velden, r.rij.bron);
        this.rondAf(r.rij, r.w, uitkomst);
        afgehandeld.add(r);
        voortgang = true;
      }
      // het project is afgewezen (leverancier als klant) en er wacht niets meer dat het kan maken: de gedeeltelijke
      // revisies erna hebben geen project om op te wachten en worden met dezelfde reden afgehandeld
      if (!job && makerAfgewezen && !geldig.some((r) => !afgehandeld.has(r) && heeftMaakVelden(r))) {
        for (const r of geldig) {
          if (afgehandeld.has(r)) continue;
          this.rondAf(r.rij, r.w, { uitkomst: 'afgewezen', fout: 'geen-klant' });
          voortgang = true;
        }
      }
      return voortgang;
    })();
  }

  // ---------------------------------------------------------------------------------------------

  private vindJob(uuid: string): JobRij | undefined {
    return this.db.prepare('SELECT * FROM jobs WHERE uuid = ?').get(uuid) as JobRij | undefined;
  }

  /** De wijziging uit een wachtrijrij opnieuw lezen en controleren, zoals een nieuwe ontvangst. */
  private hervalideer(rij: WachtrijRij): { w?: Wijziging; velden?: ProjectVelden; fout?: string } {
    let raw: unknown;
    try {
      raw = JSON.parse(rij.wijziging);
    } catch {
      return { fout: 'onleesbaar' };
    }
    const w = leesWijziging(raw);
    if (!w.ok || w.wijziging.entiteit !== 'project') return { fout: 'wijziging' };
    const velden = leesProjectVelden(w.wijziging.velden);
    if (!velden.ok) return { fout: `${velden.veld}: ${velden.melding}` };
    return { w: w.wijziging, velden: schoon(velden.velden) };
  }

  /** Een afgehandelde wachtrijrij: de registerrij en de markering in dezelfde transactie als het project. */
  private rondAf(rij: WachtrijRij, w: Wijziging, uitkomst: Uitkomst): void {
    if (uitkomst.uitkomst === 'wacht') return;
    const reden = uitkomst.uitkomst === 'afgewezen' ? uitkomst.fout : null;
    this.schrijfRegister(rij.apparaat_id, w, uitkomst.uitkomst, reden, 'netwerk');
    this.wachtrij.markeer(rij.id, uitkomst.uitkomst, reden);
  }

  private zetInWachtrij(deviceId: string, bron: string, w: Wijziging, wachtOpKlant: string): SyncResultaat {
    const r = this.wachtrij.zetIn(deviceId, bron, w, { entiteit: 'klant', uuid: wachtOpKlant, reden: 'klant-onbekend' });
    if (r === 'vol') return { status: 503, fout: 'wachtrij-vol' };
    return { status: 200, uitkomst: 'wacht' };
  }

  private afwijzing(fout: string | null): SyncResultaat {
    return fout === 'klus-gekoppeld' ? { status: 200, uitkomst: 'afgewezen', fout, melding: KLUS_GEKOPPELD_MELDING } : { status: 200, uitkomst: 'afgewezen', ...(fout ? { fout } : {}) };
  }

  private schrijfRegister(deviceId: string, w: Pick<Wijziging, 'entiteit' | 'uuid' | 'revisie' | 'tijd'>, uitkomst: string, fout: string | null, route: string): void {
    this.db
      .prepare(
        `INSERT INTO sync_ontvangen (apparaat_id, entiteit, uuid, revisie, tijd, ontvangen_op, uitkomst, fout, route) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(apparaat_id, entiteit, uuid, revisie) DO NOTHING`,
      )
      .run(deviceId, w.entiteit, w.uuid, w.revisie, w.tijd, this.now(), uitkomst, fout, route);
  }

  /**
   * De klant van de wijziging: onbekend (ook niet als alias), een leverancier (geen klant, ook via een alias)
   * of een klant (type klant of beide) met zijn id.
   */
  private klant(uuid: string): { soort: 'onbekend' } | { soort: 'geen-klant' } | { soort: 'klant'; id: number } {
    const relatie = this.relations.vindOpSyncUuid(uuid);
    if (!relatie) return { soort: 'onbekend' };
    return relatie.type === 'leverancier' ? { soort: 'geen-klant' } : { soort: 'klant', id: relatie.id };
  }

  /** Maakt een nieuw project; de klant moet er zijn, anders wacht het. */
  private maakAan(w: Wijziging, velden: ProjectVelden, bron: string): Uitkomst {
    const klant = velden.relation_id as string;
    const gevonden = this.klant(klant);
    if (gevonden.soort === 'onbekend') return { uitkomst: 'wacht', wachtOp: klant };
    if (gevonden.soort === 'geen-klant') return { uitkomst: 'afgewezen', fout: 'geen-klant' };
    this.maakVanSync(w.uuid, { ...velden, relation_id: gevonden.id }, w.tijd, bron);
    return { uitkomst: 'toegepast' };
  }

  /**
   * Maakt een nieuw project van een telefoonwijziging: revisie 1, een nieuw wijzigingsnummer, en per
   * meegestuurd veld een tijdrij en een logregel met de apparaatcode als bron en de bewerktijd als tijd.
   * De velden die de telefoon niet meestuurt krijgen een tijdrij met tijd 0 en een lege bron (zonder
   * logregel): zo wint elke latere wijziging, ook een oudere revisie die pas na deze komt, en hangt de
   * eindtoestand niet af van de volgorde (dezelfde keuze als bij klanten).
   */
  private maakVanSync(uuid: string, velden: Record<string, string | number | null>, tijd: number, bron: string): number {
    const kolommen = JOB_KOLOMMEN.filter((k) => Object.hasOwn(velden, k));
    const result = this.db
      .prepare(`INSERT INTO jobs (${kolommen.join(', ')}, uuid, revisie, gewijzigd_op, sync_seq) VALUES (${kolommen.map(() => '?').join(', ')}, ?, 1, ?, ?)`)
      .run(...kolommen.map((k) => velden[k] ?? null), uuid, tijd, volgendeSyncSeq(this.db));
    const id = Number(result.lastInsertRowid);
    for (const kolom of kolommen) schrijfJobVeld(this.db, id, 1, JOB_VELD_MAPPING[kolom], null, velden[kolom], tijd, bron);
    const nogLeeg = this.db.prepare(`INSERT INTO job_field_rev (job_id, veld, tijd, bron) VALUES (?, ?, 0, '') ON CONFLICT(job_id, veld) DO NOTHING`);
    for (const kolom of JOB_KOLOMMEN) if (!kolommen.includes(kolom)) nogLeeg.run(id, JOB_VELD_MAPPING[kolom]);
    return id;
  }

  /** Hangt er iets aan dit project dat de klant vastzet: een offerte, facturen, aankopen, ritten of werkbonregels? */
  private heeftKoppelingen(jobId: number): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 WHERE EXISTS (SELECT 1 FROM jobs WHERE id = ? AND quote_id IS NOT NULL) OR EXISTS (SELECT 1 FROM invoices WHERE job_id = ?) OR EXISTS (SELECT 1 FROM purchase_invoices WHERE job_id = ?)
             OR EXISTS (SELECT 1 FROM trips WHERE job_id = ?) OR EXISTS (SELECT 1 FROM job_work_items WHERE job_id = ?)`,
        )
        .get(jobId, jobId, jobId, jobId, jobId),
    );
  }

  /**
   * Past velden van een telefoonwijziging toe op een bestaand project, per veld op (tijd, bron): de
   * nieuwste wint, bij gelijke tijd de lexicografisch grootste bron, en een veld met een oudere tijd
   * wordt overgeslagen zonder logregel. Een veld zonder rij in job_field_rev heeft als tijd de ondergrens uit
   * created_at en als bron pc. Is minstens een veld toegepast, dan gaat de revisie met een omhoog, krijgt
   * het project een nieuw wijzigingsnummer en wordt gewijzigd_op de hoogste van de oude waarde en de
   * toegepaste veldtijden. Bijzonder:
   * - een status van de telefoon wordt, ongeacht de tijd, overgeslagen als het project gefactureerd is of
   *   een factuur heeft; dat veld krijgt dan alleen een logregel;
   * - de klant van een project met koppelingen (ook een offerte) wijzigt niet: de hele wijziging is dan afgewezen
   *   (klus-gekoppeld) en er wordt niets geschreven;
   * - de klant in de wijziging moet bekend zijn; anders wacht de wijziging, en een leverancier is geen klant
   *   (afgewezen, geen-klant, niets geschreven).
   */
  private pasToe(job: JobRij, w: Wijziging, velden: ProjectVelden, bron: string): Uitkomst {
    const tijd = w.tijd;
    const klantUuid = Object.hasOwn(velden, 'relation_id') ? (velden.relation_id as string) : undefined;
    let nieuweKlant: number | undefined;
    if (klantUuid !== undefined) {
      const gevonden = this.klant(klantUuid);
      if (gevonden.soort === 'onbekend') return { uitkomst: 'wacht', wachtOp: klantUuid };
      if (gevonden.soort === 'geen-klant') return { uitkomst: 'afgewezen', fout: 'geen-klant' };
      nieuweKlant = gevonden.id;
    }
    const ondergrens = veldOndergrens(job.created_at);
    const statusGeblokkeerd = Object.hasOwn(velden, 'status') && (job.status === 'gefactureerd' || Boolean(this.db.prepare('SELECT 1 FROM invoices WHERE job_id = ?').get(job.id)));
    const waarden: Record<string, string | number | null> = { ...velden };
    if (nieuweKlant !== undefined) waarden.relation_id = nieuweKlant;
    // eerst bepalen welke velden winnen, dan pas schrijven
    const zetten: JobKolom[] = [];
    for (const kolom of JOB_KOLOMMEN) {
      if (!Object.hasOwn(waarden, kolom) || (kolom === 'status' && statusGeblokkeerd)) continue;
      const opgeslagen = this.db.prepare('SELECT tijd, bron FROM job_field_rev WHERE job_id = ? AND veld = ?').get(job.id, JOB_VELD_MAPPING[kolom]) as { tijd: number; bron: string } | undefined;
      const huidig = { ...(opgeslagen ?? { tijd: ondergrens, bron: BRON_PC }), waarde: job[kolom] };
      if (wintVeld({ tijd, bron, waarde: waarden[kolom] }, huidig)) zetten.push(kolom);
    }
    if (zetten.includes('relation_id') && waarden.relation_id !== job.relation_id && this.heeftKoppelingen(job.id)) return { uitkomst: 'afgewezen', fout: 'klus-gekoppeld' };
    const revisie = zetten.length > 0 ? job.revisie + 1 : job.revisie;
    if (statusGeblokkeerd) logJobVeld(this.db, job.id, revisie, JOB_VELD_MAPPING.status, job.status, waarden.status, tijd, bron);
    if (zetten.length === 0) return { uitkomst: 'overgeslagen' };
    this.db
      .prepare(`UPDATE jobs SET ${zetten.map((k) => `${k} = ?`).join(', ')}, revisie = ?, gewijzigd_op = ?, sync_seq = ? WHERE id = ?`)
      .run(...zetten.map((k) => waarden[k] ?? null), revisie, Math.max(job.gewijzigd_op, tijd), volgendeSyncSeq(this.db), job.id);
    for (const kolom of zetten) schrijfJobVeld(this.db, job.id, revisie, JOB_VELD_MAPPING[kolom], job[kolom], waarden[kolom], tijd, bron);
    return { uitkomst: 'toegepast' };
  }
}
