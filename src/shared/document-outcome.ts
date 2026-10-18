/**
 * Wat er met een bon of factuur gebeurd is (#179). Op de schermen met documenten staat dit in plaats
 * van het algemene "Verwerkt", zodat je ziet of er iets geboekt is.
 */
export type DocumentOutcome = 'nieuwe-aankoop' | 'bewijs-gekoppeld' | 'dubbel' | 'controle' | 'niet-geboekt';

export const DOCUMENT_OUTCOME_LABEL: Record<DocumentOutcome, string> = {
  'nieuwe-aankoop': 'Nieuwe aankoop geboekt',
  'bewijs-gekoppeld': 'Bewijs gekoppeld — niet opnieuw geboekt',
  dubbel: 'Dubbel document — niet geboekt',
  controle: 'Nog controleren',
  // privé of door jou weggelegd: geen van de vier, maar ook niet geboekt
  'niet-geboekt': 'Privé of weggelegd — niet geboekt',
};

/** Exact hetzelfde bestand nog een keer toegevoegd: er is niets bijgekomen of veranderd. */
export const ALREADY_PRESENT = 'Dit document stond er al in.';
export const VIEW_EXISTING = 'Bestaand document bekijken';
