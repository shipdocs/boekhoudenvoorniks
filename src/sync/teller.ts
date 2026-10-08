import type { Db } from '../db/database';

/**
 * Het volgende wijzigingsnummer uit de globale teller (tabel sync_teller, rij 'wijziging').
 * Dit nummer (sync_seq) is de enige basis voor delta-sync; de bewerktijd (gewijzigd_op, tijd per veld)
 * is alleen informatief en dient voor "laatste wijziging wint per veld".
 *
 * Geen eigen transactie: de teller loopt mee in de transactie van de aanroeper, zodat een
 * teruggerolde schrijfactie ook zijn nummer teruggeeft. UPDATE en daarna SELECT, geen RETURNING.
 */
export function volgendeSyncSeq(db: Db): number {
  const result = db.prepare(`UPDATE sync_teller SET waarde = waarde + 1 WHERE naam = 'wijziging'`).run();
  if (result.changes !== 1) throw new Error('De wijzigingsteller ontbreekt in deze administratie');
  const row = db.prepare(`SELECT waarde FROM sync_teller WHERE naam = 'wijziging'`).get() as { waarde: number };
  return row.waarde;
}

/**
 * Het volgende bevestigingsnummer uit de tweede teller (rij 'bevestiging'). Het nummer gaat naar
 * sync_wachtrij.verwerkt_seq wanneer een wachtende wijziging wordt afgehandeld; de telefoon vraagt
 * bevestigingen met dat nummer als cursor. Zelfde regels als hierboven: geen eigen transactie, zodat een
 * teruggerolde afhandeling het nummer teruggeeft, en UPDATE en daarna SELECT.
 */
export function volgendeBevestigingSeq(db: Db): number {
  const result = db.prepare(`UPDATE sync_teller SET waarde = waarde + 1 WHERE naam = 'bevestiging'`).run();
  if (result.changes !== 1) throw new Error('De bevestigingsteller ontbreekt in deze administratie');
  const row = db.prepare(`SELECT waarde FROM sync_teller WHERE naam = 'bevestiging'`).get() as { waarde: number };
  return row.waarde;
}
