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
 *
 * Niet automatisch: de gebruiker bevestigt eerst dat er btw is afgetrokken op de auto of de kosten, en
 * kiest de methode. Een eigen bijdrage of een bijzondere historie (bijv. marge-auto) kan het bedrag
 * veranderen; dat staat in de notitie voor de boekhouder.
 */
export const CAR_PRIVATE_PCT = 0.027;
export const CAR_PRIVATE_PCT_OLD = 0.015;
/** vanaf zoveel jaar na het jaar van ingebruikname geldt het lagere percentage */
export const CAR_OLD_AFTER_YEARS = 5;

export type CarPrivateUse =
  | { state: 'n.v.t.' }
  /** privégebruik of cataloguswaarde nog niet ingevuld */
  | { state: 'onbekend' }
  /** werkelijk privégebruik: het bedrag rekent de boekhouder uit (de app boekt niets) */
  | { state: 'werkelijk' }
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

export function carPrivateUse(
  s: Pick<AppSettings, 'carUse' | 'carPrivateUse' | 'carCatalogValue' | 'carInUseSince' | 'carInUseMonth' | 'kor'> & Partial<Pick<AppSettings, 'carVatDeducted' | 'carVatMethod'>>,
  year: number,
  basis?: { purchaseDeducted: boolean | null; purchaseVat: Cents | null; costVat: Cents },
): CarPrivateUse {
  if (s.kor || s.carUse !== 'zakelijk' || s.carPrivateUse === false || s.carVatDeducted === false) return { state: 'n.v.t.' };
  if (s.carInUseSince !== null && s.carInUseSince > year) return { state: 'n.v.t.' };
  if (s.carPrivateUse === true && s.carVatDeducted === true && s.carVatMethod === 'werkelijk') return { state: 'werkelijk' };
  if (s.carVatDeducted !== true || s.carVatMethod !== 'forfait') return { state: 'onbekend' };
  if (s.carPrivateUse !== true || !s.carCatalogValue || s.carCatalogValue <= 0) return { state: 'onbekend' };
  if (!basis || s.carInUseSince === null) return { state: 'onbekend' };
  // in het jaar van ingebruikname naar rato: vanaf de maand van ingebruikname
  const firstYear = s.carInUseSince === year;
  if (firstYear && !(s.carInUseMonth && s.carInUseMonth >= 1 && s.carInUseMonth <= 12)) return { state: 'onbekend' };
  const months = firstYear ? 13 - s.carInUseMonth! : 12;
  const old = s.carInUseSince !== null && year >= s.carInUseSince + CAR_OLD_AFTER_YEARS;
  if (!old && (basis.purchaseDeducted === null || (basis.purchaseDeducted && basis.purchaseVat === null))) return { state: 'onbekend' };
  const pct = old || basis.purchaseDeducted === false ? CAR_PRIVATE_PCT_OLD : CAR_PRIVATE_PCT;
  const forfait = Math.round((s.carCatalogValue * pct * months) / 12);
  const maximum = Math.max(0, basis.costVat + (basis.purchaseDeducted && !old ? Math.round((basis.purchaseVat ?? 0) / 5) : 0));
  return { state: 'bekend', amount: Math.min(forfait, maximum), pct, catalogValue: s.carCatalogValue, months };
}

/** Eén auto in deze administratie: gebruik alleen de werkelijk afgetrokken btw, ook bij gemengde bonnen. */
export function carPrivateUseFromLedger(db: Db, s: AppSettings, year: number): CarPrivateUse {
  const vatOn = (accounts: string[], from: IsoDate, to: IsoDate): Cents => {
    const rows = db.prepare(`SELECT e.id, l.vat_code AS code,
      SUM(CASE WHEN a.rgs_code IN (${accounts.map(() => '?').join(',')}) THEN l.debit - l.credit ELSE 0 END) AS carBase,
      SUM(CASE WHEN a.category IN ('kosten', 'activa') THEN l.debit - l.credit ELSE 0 END) AS base,
      SUM(CASE WHEN a.rgs_code = ? THEN l.debit - l.credit ELSE 0 END) AS vat
      FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN chart_of_accounts a ON a.id = l.account_id
      WHERE e.entry_date BETWEEN ? AND ? AND e.source NOT IN ('btw', 'opening') AND l.vat_code IS NOT NULL
      GROUP BY e.id, l.vat_code`).all(...accounts, ACCOUNTS.btwVoorbelasting, from, to) as { carBase: number; base: number; vat: number }[];
    return rows.reduce((n, r) => n + (r.base ? Math.round(r.vat * r.carBase / r.base) : 0), 0);
  };
  const cars = db.prepare(`SELECT s.is_opening FROM assets s JOIN journal_lines l ON l.id = s.journal_line_id JOIN journal_entries e ON e.id = l.journal_entry_id
    WHERE s.account_rgs = ? AND s.status != 'vervallen' AND s.acquired_on <= ? AND (s.disposed_on IS NULL OR s.disposed_on >= ?)
      AND e.status = 'definitief'`).all(ACCOUNTS.vervoermiddelen, `${year}-12-31`, `${year}-01-01`) as { is_opening: number }[];
  // Het register kan nog leeg zijn: zoek dan naar de aanschafboekingen zelf.
  const acquisitions = db.prepare(`SELECT COUNT(*) AS n FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN chart_of_accounts a ON a.id = l.account_id
    WHERE a.rgs_code = ? AND l.debit > 0 AND e.status = 'definitief' AND e.reverses_entry_id IS NULL AND e.source != 'opening'
      AND COALESCE(l.vat_code, '') != 'niet-aftrekbaar' AND e.entry_date BETWEEN ? AND ?`).get(ACCOUNTS.vervoermiddelen, `${s.carInUseSince ?? year}-01-01`, `${year}-12-31`) as { n: number };
  if ((cars.length > 1 || acquisitions.n > 1) && s.carCostVatOverride?.year !== year) return { state: 'onbekend' };
  const knownAcquisition = (cars.length === 1 && !cars[0]!.is_opening) || (cars.length === 0 && acquisitions.n === 1);
  const purchaseVat = (s.carPurchaseVatDeducted === true ? s.carPurchaseVatAmount : null) ?? (knownAcquisition ? vatOn([ACCOUNTS.vervoermiddelen], `${s.carInUseSince ?? year}-01-01`, `${year}-12-31`) : null);
  const purchaseDeducted = s.carPurchaseVatDeducted ?? (purchaseVat === null ? null : purchaseVat > 0);
  const costVat = s.carCostVatOverride?.year === year ? s.carCostVatOverride.amount : vatOn(['WBedAutBra', 'WBedAutOnd'], `${year}-01-01`, `${year}-12-31`);
  return carPrivateUse(s, year, { purchaseDeducted, purchaseVat, costVat });
}
