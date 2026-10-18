import type { Db } from '../db/database';
import type { Wijziging } from '@gratis-boekhouden/kern';
import { volgendeBevestigingSeq } from './teller';

/**
 * De wachtrij voor wijzigingen van een telefoon die verwijzen naar iets dat de pc nog niet kent (een
 * project voor een nog onbekende klant; later een factuur voor een onbekend project). Een rij bewaart
 * de volledige wijziging als JSON en wacht tot het object waar ze op wacht er is. Rijen worden nooit
 * verwijderd: afhandelen is verwerkt_op, verwerkt_uitkomst en verwerkt_reden invullen.
 *
 * Per apparaat staan er hoogstens WACHTRIJ_LIMIET onverwerkte rijen. Een volle wachtrij wijst nooit een
 * geldige wijziging af: de ontvanger antwoordt dan 503 wachtrij-vol, de telefoon bewaart de wijziging en
 * probeert het later opnieuw.
 */
export const WACHTRIJ_LIMIET = 1000;

export interface WachtrijRij {
  id: number;
  apparaat_id: string;
  bron: string;
  entiteit: string;
  uuid: string;
  revisie: number;
  tijd: number;
  wijziging: string;
  nummer: string | null;
  wacht_op_entiteit: string;
  wacht_op_uuid: string;
  reden: string;
  ontvangen_op: number;
  verwerkt_op: number | null;
  verwerkt_uitkomst: string | null;
  verwerkt_reden: string | null;
  /** de route van de eerste ontvangst (netwerk, map of mail); NULL bij rijen van voor deze kolom */
  route: string | null;
  /** het bevestigingsnummer bij het afhandelen; NULL bij rijen die voor die kolom al waren afgehandeld */
  verwerkt_seq: number | null;
}

/** Wat per soort object nodig is om wachtende rijen te verwerken (project en factuur). */
export interface WachtrijBehandelaar {
  entiteit: string;
  /** Verwerkt de wachtende rijen van een object, in een transactie; geeft true als er minstens een rij is afgehandeld. */
  verwerkObject(uuid: string): boolean;
}

export interface WachtrijOpties {
  now?: () => number;
  log?: (melding: string) => void;
}

export type ZetInUitkomst = 'toegevoegd' | 'bestond' | 'vol';

export class SyncWachtrij {
  private readonly now: () => number;
  private readonly log: (melding: string) => void;
  private bezig = false;

  constructor(
    private readonly db: Db,
    private readonly behandelaars: WachtrijBehandelaar[] = [],
    opties: WachtrijOpties = {},
  ) {
    this.now = opties.now ?? Date.now;
    this.log = opties.log ?? (() => undefined);
  }

  /**
   * Zet een wijziging in de wachtrij, ON CONFLICT DO NOTHING: dezelfde wijziging nog eens (zelfde apparaat,
   * entiteit, uuid en revisie) is nog steeds een rij en geeft 'bestond'. Is de wachtrij van dit apparaat
   * vol, dan wordt er niets geschreven ('vol'). De route van de eerste ontvangst wordt bewaard voor de registerrij bij het later overnemen.
   */
  zetIn(deviceId: string, bron: string, w: Wijziging, wacht: { entiteit: string; uuid: string; reden: string; nummer?: string | null }, route: string = 'netwerk'): ZetInUitkomst {
    const bestaat = this.db.prepare('SELECT 1 FROM sync_wachtrij WHERE apparaat_id = ? AND entiteit = ? AND uuid = ? AND revisie = ?').get(deviceId, w.entiteit, w.uuid, w.revisie);
    if (bestaat) return 'bestond';
    if (this.aantalOnverwerkt(deviceId) >= WACHTRIJ_LIMIET) return 'vol';
    const result = this.db
      .prepare(
        `INSERT INTO sync_wachtrij (apparaat_id, bron, entiteit, uuid, revisie, tijd, wijziging, nummer, wacht_op_entiteit, wacht_op_uuid, reden, ontvangen_op, route)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(apparaat_id, entiteit, uuid, revisie) DO NOTHING`,
      )
      .run(deviceId, bron, w.entiteit, w.uuid, w.revisie, w.tijd, JSON.stringify({ entiteit: w.entiteit, uuid: w.uuid, revisie: w.revisie, tijd: w.tijd, velden: w.velden }), wacht.nummer ?? null, wacht.entiteit, wacht.uuid, wacht.reden, this.now(), route);
    return result.changes === 1 ? 'toegevoegd' : 'bestond';
  }

  /** De rij met deze sleutel (apparaat, entiteit, uuid, revisie), verwerkt of niet. */
  rij(deviceId: string, entiteit: string, uuid: string, revisie: number): WachtrijRij | undefined {
    return this.db.prepare('SELECT * FROM sync_wachtrij WHERE apparaat_id = ? AND entiteit = ? AND uuid = ? AND revisie = ?').get(deviceId, entiteit, uuid, revisie) as WachtrijRij | undefined;
  }

  /** Het aantal onverwerkte rijen van een apparaat: alleen die tellen mee voor de limiet. */
  aantalOnverwerkt(deviceId: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM sync_wachtrij WHERE apparaat_id = ? AND verwerkt_op IS NULL').get(deviceId) as { n: number }).n;
  }

  /** De onverwerkte rijen van een object, de oudste revisie eerst. */
  onverwerkt(entiteit: string, uuid: string): WachtrijRij[] {
    return this.db.prepare('SELECT * FROM sync_wachtrij WHERE entiteit = ? AND uuid = ? AND verwerkt_op IS NULL ORDER BY revisie, id').all(entiteit, uuid) as WachtrijRij[];
  }

  /** Waar het object waar een onverwerkte rij voor dit (entiteit, uuid) op wacht, door de eerste rij. */
  eersteWachtOp(entiteit: string, uuid: string): { entiteit: string; uuid: string } | undefined {
    const rij = this.db.prepare('SELECT wacht_op_entiteit, wacht_op_uuid FROM sync_wachtrij WHERE entiteit = ? AND uuid = ? AND verwerkt_op IS NULL ORDER BY id LIMIT 1').get(entiteit, uuid) as { wacht_op_entiteit: string; wacht_op_uuid: string } | undefined;
    return rij ? { entiteit: rij.wacht_op_entiteit, uuid: rij.wacht_op_uuid } : undefined;
  }

  /**
   * Markeert een rij als afgehandeld en geeft haar een nieuw bevestigingsnummer; een rij die al afgehandeld is
   * blijft zoals ze is, houdt haar nummer en verbruikt er geen. Geeft false als er niets veranderde. Het
   * nummer komt uit de teller in de transactie van de aanroeper (geen eigen transactie), zodat een
   * teruggerolde afhandeling zijn nummer teruggeeft.
   */
  markeer(id: number, uitkomst: 'toegepast' | 'overgeslagen' | 'afgewezen', reden: string | null): boolean {
    const open = this.db.prepare('SELECT 1 FROM sync_wachtrij WHERE id = ? AND verwerkt_op IS NULL').get(id);
    if (!open) return false;
    const seq = volgendeBevestigingSeq(this.db);
    return this.db.prepare('UPDATE sync_wachtrij SET verwerkt_op = ?, verwerkt_uitkomst = ?, verwerkt_reden = ?, verwerkt_seq = ? WHERE id = ? AND verwerkt_op IS NULL').run(this.now(), uitkomst, reden, seq, id).changes === 1;
  }

  /**
   * Een rij die nog wacht blijft wachten, maar nu ergens anders op (de klant is er, het project nog niet):
   * alleen de wachtkolommen veranderen, de rij zelf blijft. Een afgehandelde rij blijft zoals ze is.
   */
  herplan(id: number, wacht: { entiteit: string; uuid: string; reden: string }): boolean {
    return this.db.prepare('UPDATE sync_wachtrij SET wacht_op_entiteit = ?, wacht_op_uuid = ?, reden = ? WHERE id = ? AND verwerkt_op IS NULL AND (wacht_op_entiteit <> ? OR wacht_op_uuid <> ? OR reden <> ?)').run(wacht.entiteit, wacht.uuid, wacht.reden, id, wacht.entiteit, wacht.uuid, wacht.reden).changes === 1;
  }

  /** Het aantal onverwerkte rijen van een entiteit voor een apparaat (om te zien of er iets te hervatten is). */
  aantalOnverwerktVan(deviceId: string, entiteit: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM sync_wachtrij WHERE apparaat_id = ? AND entiteit = ? AND verwerkt_op IS NULL').get(deviceId, entiteit) as { n: number }).n;
  }

  /**
   * Verwerkt wat verwerkt kan worden, per object in een transactie (door de behandelaar), en begint
   * opnieuw zolang er voortgang is: een toegepast project kan weer iets anders vrijmaken. Een fout bij
   * een object laat de rijen daarvan onverwerkt (de transactie is teruggerold) en stopt de rest niet.
   * Geeft het aantal objecten waar voortgang op was.
   */
  verwerk(): number {
    if (this.bezig) return 0;
    this.bezig = true;
    let voortgangTotaal = 0;
    try {
      for (let ronde = 0; ronde < 1000; ronde++) {
        let voortgang = false;
        for (const b of this.behandelaars) {
          const uuids = (this.db.prepare('SELECT DISTINCT uuid FROM sync_wachtrij WHERE entiteit = ? AND verwerkt_op IS NULL ORDER BY uuid').all(b.entiteit) as { uuid: string }[]).map((r) => r.uuid);
          for (const uuid of uuids) {
            try {
              if (b.verwerkObject(uuid)) {
                voortgang = true;
                voortgangTotaal += 1;
              }
            } catch (e) {
              this.log(`Wachtende wijziging van de telefoon verwerken mislukt (${b.entiteit} ${uuid}): ${(e as Error).message}`);
            }
          }
        }
        if (!voortgang) break;
      }
    } finally {
      this.bezig = false;
    }
    return voortgangTotaal;
  }
}
