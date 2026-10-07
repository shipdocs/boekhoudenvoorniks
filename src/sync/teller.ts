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
