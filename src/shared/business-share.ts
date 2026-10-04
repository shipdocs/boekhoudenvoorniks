import { roundHalfAwayFromZero, type Cents } from './money';

/** Een ongewijzigde standaard is geen persoonlijke keuze; een ingetikte 100 wel. */
export function selectedBusinessPct(edited: number | null, remembered: number | null | undefined): number | undefined {
  return edited ?? (remembered !== undefined && remembered !== null && remembered < 100 ? remembered : undefined);
}

/** Zakelijk deel van een bedrag; 100% laat het ongemoeid. Zelfde afronding als het boeken. */
export function shareOf(amount: Cents, pct: number): Cents {
  return pct === 100 ? amount : roundHalfAwayFromZero((amount * pct) / 100);
}

/** Kosten en btw-aftrek van een uitgave bij een zakelijk percentage, voor de lijst met boekingen. */
export function businessEffect(parts: { net: Cents; vat: Cents }[], pct: number, noVatDeduction = false): { kosten: Cents; btw: Cents } {
  let kosten = 0;
  let btw = 0;
  for (const p of parts) {
    kosten += shareOf(p.net, pct);
    if (noVatDeduction) kosten += shareOf(p.vat, pct);
    else btw += shareOf(p.vat, pct);
  }
  return { kosten, btw };
}
