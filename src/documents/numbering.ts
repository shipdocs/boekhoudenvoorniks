/**
 * Documentnummers. Ondersteunde tokens:
 *   {JJJJ} jaar, {JJ} jaar 2 cijfers, {MM} maand, {N…} volgnummer met zoveel cijfers als N's.
 * Factuurnummers moeten wettelijk een doorlopende, unieke reeks vormen; de teller wordt
 * daarom pas opgehoogd bij het definitief maken (in dezelfde transactie).
 */
export function formatDocumentNumber(format: string, date: string, sequence: number): string {
  if (!/\{N+\}/.test(format)) throw new Error('Nummerformaat moet een volgnummer bevatten, bv. {NNNN}');
  return format
    .replace(/\{JJJJ\}/g, date.slice(0, 4))
    .replace(/\{JJ\}/g, date.slice(2, 4))
    .replace(/\{MM\}/g, date.slice(5, 7))
    .replace(/\{(N+)\}/g, (_m, ns: string) => String(sequence).padStart(ns.length, '0'));
}

/** Teller-sleutel: per jaar als het formaat een jaartal bevat, anders doorlopend. */
export function counterKey(kind: 'factuur' | 'offerte', format: string, date: string): string {
  return /\{JJ(JJ)?\}/.test(format) ? `${kind}:${date.slice(0, 4)}` : kind;
}
