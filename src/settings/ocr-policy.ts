/**
 * In de kopie van een klant (kantoorkopie) mag de opgeslagen ocr-instelling nooit leiden tot het starten van
 * een programma of een aanroep van een leesdienst: de instelling kan uit een ontvangen, ongeschoonde kopie komen.
 */
export function ocrAllowed(settings: { officeCopy(): unknown }): boolean {
  return !settings.officeCopy();
}

/**
 * In een kantoorkopie krijgt een opgeslagen programma, leesdienst, LLM of online hulp van de afzender nooit
 * werk of gegevens: alles wordt leeggemaakt. Geeft true als de kopie dat afdwong (dan niets anders instellen).
 */
export function blockAiInOfficeCopy(
  services: { settings: { officeCopy(): unknown }; intake: { setOcrProvider(p: null): void }; classifier: { setLlm(l: null): void } },
  stopLocalOcr: () => void,
): boolean {
  if (ocrAllowed(services.settings)) return false;
  stopLocalOcr();
  services.intake.setOcrProvider(null);
  services.classifier.setLlm(null);
  return true;
}
