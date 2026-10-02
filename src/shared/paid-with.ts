/** Hoe een aankoop betaald is, zoals de bevestiging van een bon het kent. */
export type PaidWith = 'bank' | 'kas' | 'prive' | 'later';

type Proposal = { proposed_paid_with?: PaidWith | null; bank_match?: unknown; bank_match_strong?: boolean };

/** Staat er een afschrijving op een eigen rekening die bij deze bon past: bedrag, leverancier en datum? */
const awaitsDebit = (doc: Proposal): boolean => Boolean(doc.bank_match && doc.bank_match_strong);

/**
 * Het voorstel voor "Hoe betaald?" bij een bon. De betaalwijze die op de telefoon is gekozen
 * (bonnenscanner, #48) gaat voor bij contant of privé; anders telt of er een betaling op de bank bij
 * gevonden is. Zegt de telefoon contant of privé, maar staat er ook een afschrijving op een eigen rekening
 * die erbij past op bedrag, leverancier en datum (#222), dan blijft de aankoop open ("later"): bij die
 * betaling vraagt de app of hij erbij hoort. Past alleen het bedrag (een andere naam op het afschrift), dan
 * geldt de keuze van de telefoon: anders blijft de bon na "Nee" bij die betaling als schuld open staan.
 * Het blijft een voorstel: de gebruiker kan het bij het bevestigen aanpassen.
 */
export function proposedPaidWith(doc: Proposal): PaidWith {
  if (doc.proposed_paid_with === 'kas' || doc.proposed_paid_with === 'prive') return awaitsDebit(doc) ? 'later' : doc.proposed_paid_with;
  if (doc.bank_match) return 'bank';
  return doc.proposed_paid_with ?? 'later';
}

/** In woorden, voor bij de vraag op Vandaag en bij "Hoe betaald?"; leeg als er niets bijzonders te melden is. */
export function paidWithNote(doc: Proposal): string {
  const phone = doc.proposed_paid_with;
  if (phone !== 'kas' && phone !== 'prive') return '';
  if (awaitsDebit(doc)) return ` Op je telefoon koos je ${phone === 'kas' ? 'contant' : 'privégeld'}, maar op je rekening staat ook een afschrijving van dit bedrag. De aankoop blijft open; bij de betaling vraagt de app of die erbij hoort.`;
  return phone === 'kas' ? ' Contant betaald.' : ' Met privégeld betaald.';
}
