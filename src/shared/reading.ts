/**
 * Een bon die zonder de gebruiker binnenkomt (telefoon, bonnenmap) staat meteen in de inbox; de
 * tekstherkenning leest hem daarna op de achtergrond, één bon tegelijk. Hier staan de standen en de
 * teksten die het hoofdproces en de schermen daarvoor delen.
 */

/** `wacht`: staat in de rij om gelezen te worden; `bezig`: wordt nu gelezen; null: er loopt niets */
export type ReadingState = 'wacht' | 'bezig' | null;

/** Geen manier van lezen gekozen of beschikbaar: de gebruiker kiest er een, of vult zelf in. */
export const NOT_READ_MESSAGE = 'Deze bon is nog niet uitgelezen. Kies hoe de app bonnen mag lezen, of vul de gegevens zelf in.';

/**
 * Bewaard bij een bon die nog op de achtergrond gelezen moet worden. Staat dit er na een herstart nog,
 * dan wordt het lezen vanzelf hervat; elke andere melding (bv. "duurde te lang") niet.
 */
export const WAITING_TO_READ_MESSAGE = 'Deze bon wacht op lezen. Dat gebeurt vanzelf; je kunt de gegevens ook zelf invullen.';

export const READING_NOW_MESSAGE = 'Deze bon wordt nu gelezen. Dat kan een paar minuten duren; je kunt de gegevens ook zelf invullen.';

/** De melding zoals de gebruiker hem ziet: is de bon nu aan de beurt, dan staat dat er in plaats van "wacht op lezen". */
export function shownMessage(reading: ReadingState, message: string): string {
  return reading === 'bezig' && message === WAITING_TO_READ_MESSAGE ? READING_NOW_MESSAGE : message;
}

export const READING_LABEL: Record<Exclude<ReadingState, null>, string> = { wacht: 'Wacht op lezen', bezig: 'Wordt gelezen…' };

/** Het leesverzoek aan de ingebouwde herkenning is afgebroken omdat het te lang duurde. */
export const READ_TIMEOUT_MESSAGE = 'Het lezen van deze bon duurde te lang. Probeer het opnieuw met Nu lezen, of vul de gegevens zelf in.';

/** De herkenning op deze computer gaf geen antwoord (gestopt of verbinding verbroken). */
export const READ_CONNECTION_MESSAGE = 'De tekstherkenning op deze computer gaf geen antwoord. Probeer het opnieuw met Nu lezen, of vul de gegevens zelf in.';
