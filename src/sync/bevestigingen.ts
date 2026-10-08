import type { Db } from '../db/database';

/**
 * Bevestigingen van de pc voor de telefoon (protocol v2, bericht `bevestigingen`): wat er gebeurde met
 * wijzigingen die eerst het antwoord `wacht` kregen. Alleen lezen. Een bevestiging hoort bij een rij uit
 * sync_wachtrij van dit apparaat die is afgehandeld en een bevestigingsnummer (verwerkt_seq) heeft; rijen
 * die al waren afgehandeld voor die kolom bestond hebben geen nummer en worden niet getoond.
 */
export const BEVESTIGINGEN_PAGINA = 100;

export type BevestigingUitkomst = 'toegepast' | 'overgeslagen' | 'afgewezen';

/** Precies deze zes velden verlaten de pc; de opgeslagen wijziging, het nummer en de rest nooit. */
export interface Bevestiging {
  seq: number;
  entiteit: string;
  uuid: string;
  revisie: number;
  uitkomst: BevestigingUitkomst;
  fout: string | null;
}

export interface BevestigingenPagina {
  bevestigingen: Bevestiging[];
  volgende: number | null;
  bevestigd_tot: number;
}

interface Rij {
  verwerkt_seq: number;
  entiteit: string;
  uuid: string;
  revisie: number;
  verwerkt_uitkomst: string;
  verwerkt_reden: string | null;
}

/**
 * Een pagina bevestigingen van een apparaat, oplopend op bevestigingsnummer, met nummers groter dan `na`.
 * `deviceId` komt uit de envelop, nooit uit het bericht. SQL met parameters; de index op
 * (apparaat_id, verwerkt_seq) begrenst de scan, en er worden er hoogstens BEVESTIGINGEN_PAGINA + 1 gelezen.
 */
export function leesBevestigingen(db: Db, deviceId: string, na: number): BevestigingenPagina {
  const rijen = db
    .prepare(
      `SELECT verwerkt_seq, entiteit, uuid, revisie, verwerkt_uitkomst, verwerkt_reden
         FROM sync_wachtrij
        WHERE apparaat_id = ? AND verwerkt_op IS NOT NULL AND verwerkt_seq > ?
        ORDER BY verwerkt_seq
        LIMIT ?`,
    )
    .all(deviceId, na, BEVESTIGINGEN_PAGINA + 1) as Rij[];
  const meer = rijen.length > BEVESTIGINGEN_PAGINA;
  const pagina = meer ? rijen.slice(0, BEVESTIGINGEN_PAGINA) : rijen;
  // een whitelist: de zes velden worden een voor een overgenomen, nooit de hele databaserij
  const bevestigingen: Bevestiging[] = pagina.map((r) => ({
    seq: r.verwerkt_seq,
    entiteit: r.entiteit,
    uuid: r.uuid,
    revisie: r.revisie,
    uitkomst: r.verwerkt_uitkomst as BevestigingUitkomst,
    fout: r.verwerkt_reden ?? null,
  }));
  const laatste = bevestigingen.length > 0 ? bevestigingen[bevestigingen.length - 1]!.seq : na;
  return { bevestigingen, volgende: meer ? laatste : null, bevestigd_tot: laatste };
}
