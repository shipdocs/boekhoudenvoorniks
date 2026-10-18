import type { Cents } from '../shared/money';
import { formatEuro } from '../shared/money';
import type { Issue } from './types';

/** Kenmerk van de waarschuwing "afwijkend bedrag": zo vinden controlescherm en tests hem terug. */
export const AMOUNT_OUTLIER = 'afwijkend-bedrag';
/** Zoveel eerdere aankopen bij dezelfde leverancier hebben we minstens nodig om iets "gebruikelijk" te noemen. */
export const OUTLIER_MIN_HISTORY = 3;
/** Het bedrag moet minstens zoveel keer de mediaan zijn... */
export const OUTLIER_FACTOR = 3;
/** ...en minstens zoveel (centen) boven de mediaan liggen, zodat een paar euro bij een kleine post niets meldt. */
export const OUTLIER_MIN_EXCESS: Cents = 10000;

export function median(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : Math.round((v[mid - 1]! + v[mid]!) / 2);
}

/**
 * Een bedrag dat ver boven het gebruikelijke bedrag bij dezelfde leverancier ligt, wijst op een verkeerd gelezen
 * bon of een dubbele boeking. Alleen een waarschuwing; `history` zijn eerdere totalen in euro's (centen).
 */
export function amountOutlierIssue(history: Cents[], total: Cents): Issue | null {
  const past = history.filter((h) => h > 0);
  if (past.length < OUTLIER_MIN_HISTORY || total <= 0) return null;
  const usual = median(past);
  if (total < usual * OUTLIER_FACTOR || total - usual < OUTLIER_MIN_EXCESS) return null;
  return {
    field: 'total',
    severity: 'waarschuwing',
    message: `Dit bedrag (${formatEuro(total)}) is veel hoger dan wat je gewoonlijk bij deze leverancier betaalt (meestal rond ${formatEuro(usual)}, ${past.length} eerdere aankopen). Kijk na of het goed gelezen is en of het niet dubbel is.`,
    suggestion: AMOUNT_OUTLIER,
  };
}
