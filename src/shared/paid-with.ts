/** Hoe een aankoop betaald is, zoals de bevestiging van een bon het kent. */
export type PaidWith = 'bank' | 'kas' | 'prive' | 'later';

/**
 * Het voorstel voor "Hoe betaald?" bij een bon. De betaalwijze die op de telefoon is gekozen
 * (bonnenscanner, #48) gaat voor bij contant of privé; anders telt of er een betaling op de bank bij
 * gevonden is. Het blijft een voorstel: de gebruiker kan het bij het bevestigen aanpassen.
 */
export function proposedPaidWith(doc: { proposed_paid_with?: PaidWith | null; bank_match?: unknown }): PaidWith {
  if (doc.proposed_paid_with === 'kas' || doc.proposed_paid_with === 'prive') return doc.proposed_paid_with;
  if (doc.bank_match) return 'bank';
  return doc.proposed_paid_with ?? 'later';
}

/** In woorden, voor bij de vraag op Vandaag; leeg als er niets bijzonders te melden is. */
export function paidWithNote(doc: { proposed_paid_with?: PaidWith | null }): string {
  if (doc.proposed_paid_with === 'kas') return ' Contant betaald.';
  if (doc.proposed_paid_with === 'prive') return ' Met privégeld betaald.';
  return '';
}
