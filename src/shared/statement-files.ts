/**
 * De bestandsnamen die de app als bankafschrift aanneemt: bij slepen op het Bank-, start- en overstapscherm,
 * in de downloadmap en bij het herkennen van het formaat. Eén lijst, zodat een bestand dat je kunt slepen ook
 * in de downloadmap gevonden wordt (#459). MT940 heet per bank .sta, .940, .mt940 of .swi; CSV-achtige exports
 * .csv, .txt of .tab (ABN AMRO); CAMT.053 is .xml.
 */
export const MT940_EXTENSIONS = ['.sta', '.940', '.mt940', '.swi'] as const;
export const CSV_EXTENSIONS = ['.csv', '.txt', '.tab'] as const;
export const STATEMENT_EXTENSIONS: readonly string[] = ['.xml', ...MT940_EXTENSIONS, ...CSV_EXTENSIONS];
/** Voor het `accept`-attribuut van een bestandskiezer. */
export const STATEMENT_ACCEPT = STATEMENT_EXTENSIONS.join(',');
/** "…, .txt of .tab": voor in een uitleg. */
export const STATEMENT_EXTENSIONS_TEXT = `${STATEMENT_EXTENSIONS.slice(0, -1).join(', ')} of ${STATEMENT_EXTENSIONS.at(-1)}`;

const extension = (filename: string) => {
  const dot = filename.lastIndexOf('.');
  return dot < 0 ? '' : filename.slice(dot).toLowerCase();
};
export const isMt940Name = (filename: string) => (MT940_EXTENSIONS as readonly string[]).includes(extension(filename));
export const isCsvName = (filename: string) => (CSV_EXTENSIONS as readonly string[]).includes(extension(filename));
export const isStatementName = (filename: string) => STATEMENT_EXTENSIONS.includes(extension(filename));

/**
 * Antwoord van het inlezen als er een rekeningnummer in staat waarvoor stil een nieuwe bankrekening zou ontstaan
 * (#459): eerst vragen. `single`: het hele afschrift is van die ene rekening, dus "hoort bij een bestaande rekening" kan.
 */
export type NeedsAccount = { needsAccount: { ibans: string[]; single: boolean } };
export const needsAccount = (r: unknown): r is NeedsAccount => typeof r === 'object' && r !== null && 'needsAccount' in r;
