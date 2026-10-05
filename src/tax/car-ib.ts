import type { Cents } from '../shared/money';
import type { IsoDate } from '../shared/dates';

/**
 * Bijtelling privégebruik auto van de onderneming voor de inkomstenbelasting (belastingdienst.nl, Winst uit onderneming 2026,
 * "Onttrekking privégebruik auto van de onderneming"): 22% van de cataloguswaarde per jaar; een auto die ouder is dan 16 jaar
 * (tot en met 2025: ouder dan 15 jaar): 35% van de waarde in het economisch verkeer, vanaf de maand waarin hij die leeftijd
 * bereikt. Een deel van het jaar: naar rato.
 */
export interface IbCar {
  name: string;
  /** cataloguswaarde incl. btw en bpm, in centen */
  catalogValue: Cents;
  /** bijtellingspercentage; null = 22 */
  pct: number | null;
  inUseFrom: IsoDate;
  inUseUntil: IsoDate | null;
  /** datum eerste tenaamstelling (voor de grens van 16 jaar) */
  registeredOn: IsoDate | null;
  /** waarde in het economisch verkeer, voor een auto ouder dan 16 jaar */
  marketValue: Cents | null;
}

/** Leeftijd vanaf wanneer de bijtelling 35% van de waarde in het economisch verkeer is: 15 jaar t/m 2025, 16 jaar vanaf 2026. */
export const carOldYears = (year: number): number => (year >= 2026 ? 16 : 15);
export const CAR_OLD_PCT = 35;
export const CAR_STANDARD_PCT = 22;

const dayMs = 86_400_000;
const utc = (d: IsoDate) => Date.parse(`${d}T00:00:00Z`);

/** Bijtelling voor het hele jaar (centen) en welke auto's nog gegevens missen. */
export function carBijtellingForYear(cars: IbCar[], year: number): { annual: Cents; incomplete: string[] } {
  let annual = 0;
  const incomplete: string[] = [];
  for (const car of cars) {
    let total = 0;
    let missing = false;
    for (let m = 0; m < 12; m++) {
      const start = Date.UTC(year, m, 1);
      const end = Date.UTC(year, m + 1, 1);
      const from = Math.max(start, utc(car.inUseFrom));
      const until = Math.min(end, car.inUseUntil ? utc(car.inUseUntil) + dayMs : end);
      if (until <= from) continue;
      const share = (until - from) / (end - start);
      let old = false;
      if (car.registeredOn) {
        const b = new Date(utc(car.registeredOn));
        // vanaf de maand waarin de auto die leeftijd bereikt (voorbeeld Belastingdienst: 16 jaar op 1 mei, dan de eerste 4 maanden catalogusprijs)
        old = start >= Date.UTC(b.getUTCFullYear() + carOldYears(year), b.getUTCMonth(), 1);
      }
      if (old) {
        if (!car.marketValue || car.marketValue <= 0) { missing = true; continue; }
        total += (car.marketValue * CAR_OLD_PCT * share) / 1200;
      } else {
        if (!car.catalogValue || car.catalogValue <= 0) { missing = true; continue; }
        total += (car.catalogValue * (car.pct ?? CAR_STANDARD_PCT) * share) / 1200;
      }
    }
    if (missing) incomplete.push(car.name);
    annual += total;
  }
  return { annual: Math.round(annual), incomplete };
}
