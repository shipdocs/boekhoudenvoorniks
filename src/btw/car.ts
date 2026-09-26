import type { Cents } from '../shared/money';
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
  | { state: 'bekend'; amount: Cents; pct: number; catalogValue: Cents; partialYear: boolean };

export function carPrivateUse(s: Pick<AppSettings, 'carUse' | 'carPrivateUse' | 'carCatalogValue' | 'carInUseSince' | 'kor'>, year: number): CarPrivateUse {
  if (s.kor || s.carUse !== 'zakelijk' || s.carPrivateUse === false) return { state: 'n.v.t.' };
  if (s.carInUseSince !== null && s.carInUseSince > year) return { state: 'n.v.t.' };
  if (s.carPrivateUse !== true || !s.carCatalogValue || s.carCatalogValue <= 0) return { state: 'onbekend' };
  const old = s.carInUseSince !== null && year >= s.carInUseSince + CAR_OLD_AFTER_YEARS;
  const pct = old ? CAR_PRIVATE_PCT_OLD : CAR_PRIVATE_PCT;
  return { state: 'bekend', amount: Math.round(s.carCatalogValue * pct), pct, catalogValue: s.carCatalogValue, partialYear: s.carInUseSince === year };
}
