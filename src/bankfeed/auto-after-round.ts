import type { Services } from '../services';

/**
 * Na een feedronde met werkelijk nieuwe transacties: precies één keer automatisch verwerken (regel 4).
 * Zonder nieuwe imports gebeurt er niets. Overlappende aanroepen (de achtergrondronde en "Nu ophalen")
 * krijgen van de service-lock hetzelfde summary-object; dat wordt één keer verwerkt, ook als zowel de
 * achtergrondtaak als de IPC-route dit aanroept (#459). `auto` staat er alleen bij de aanroep die
 * werkelijk verwerkte; `autoMatched` gaat bij elke aanroep mee in het antwoord.
 */
const processed = new WeakMap<object, { autoMatched?: number }>();

export function autoProcessAfterRound(
  inbox: Pick<Services['inbox'], 'autoProcess'>,
  summary: { importedAny: boolean },
): { autoMatched?: number; auto?: { matched: number; booked: number } } {
  if (!summary.importedAny) return {};
  const previous = processed.get(summary);
  if (previous) return previous;
  const result: { autoMatched?: number } = {};
  processed.set(summary, result);
  let auto: { matched: number; booked: number };
  try {
    auto = inbox.autoProcess();
  } catch (e) {
    // mislukt: niet als verwerkt onthouden, zodat een gelijktijdige aanroep het opnieuw kan proberen
    processed.delete(summary);
    throw e;
  }
  result.autoMatched = auto.matched + auto.booked;
  return { ...result, auto };
}
