import type { Db } from '../db/database';
import { ACCOUNTS } from '../core-ledger/accounts';
import type { Cents } from '../shared/money';
import type { IsoDate } from '../shared/dates';
import type { AppSettings } from '../settings/settings';

/**
 * Btw over privégebruik van een auto van de zaak (vak 1d, in de laatste aangifte van het jaar).
 * Forfait van de Belastingdienst: 2,7% van de cataloguswaarde (incl. btw en bpm); vanaf het 5e jaar
 * na het jaar van ingebruikname 1,5%. Alleen als je btw op de auto of de autokosten aftrok.
 * Alternatief: het werkelijke privégebruik uit een kilometeradministratie; dat laat de app aan de boekhouder.
 */
export const CAR_PRIVATE_PCT = 0.027;
export const CAR_PRIVATE_PCT_OLD = 0.015;
/** vanaf zoveel jaar na het jaar van ingebruikname geldt het lagere percentage */
export const CAR_OLD_AFTER_YEARS = 5;

export type CarPrivateUse =
  | { state: 'n.v.t.' }
  /** privégebruik of cataloguswaarde nog niet ingevuld */
  | { state: 'onbekend' }
  /** `months`: over hoeveel maanden (12, of minder in het jaar van ingebruikname) */
  | { state: 'bekend'; amount: Cents; pct: number; catalogValue: Cents; months: number };

/** De (niet teruggedraaide) boekingen van de btw-correctie voor dit jaar, met het bedrag in 1d. */
export function carPrivateUseEntries(db: Db, year: number): { id: number; entry_date: IsoDate; amount: Cents }[] {
  return db
    .prepare(
      `SELECT e.id, e.entry_date, SUM(l.credit - l.debit) AS amount FROM journal_entries e
       JOIN journal_lines l ON l.journal_entry_id = e.id
       JOIN chart_of_accounts a ON a.id = l.account_id
       WHERE e.source_ref = ? AND a.rgs_code = ? AND e.reverses_entry_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id = e.id)
       GROUP BY e.id ORDER BY e.id`,
    )
    .all(`auto-prive:${year}`, ACCOUNTS.btwPriveGebruik) as { id: number; entry_date: IsoDate; amount: Cents }[];
}

export function carPrivateUse(s: Pick<AppSettings, 'carUse' | 'carPrivateUse' | 'carCatalogValue' | 'carInUseSince' | 'carInUseMonth' | 'kor'>, year: number): CarPrivateUse {
  if (s.kor || s.carUse !== 'zakelijk' || s.carPrivateUse === false) return { state: 'n.v.t.' };
  if (s.carInUseSince !== null && s.carInUseSince > year) return { state: 'n.v.t.' };
  if (s.carPrivateUse !== true || !s.carCatalogValue || s.carCatalogValue <= 0) return { state: 'onbekend' };
  // in het jaar van ingebruikname naar rato: vanaf de maand van ingebruikname
  const firstYear = s.carInUseSince === year;
  if (firstYear && !(s.carInUseMonth && s.carInUseMonth >= 1 && s.carInUseMonth <= 12)) return { state: 'onbekend' };
  const months = firstYear ? 13 - s.carInUseMonth! : 12;
  const old = s.carInUseSince !== null && year >= s.carInUseSince + CAR_OLD_AFTER_YEARS;
  const pct = old ? CAR_PRIVATE_PCT_OLD : CAR_PRIVATE_PCT;
  return { state: 'bekend', amount: Math.round((s.carCatalogValue * pct * months) / 12), pct, catalogValue: s.carCatalogValue, months };
}
