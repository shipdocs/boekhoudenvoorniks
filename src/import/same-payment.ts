import { normalizeIban } from '../shared/validation';

/**
 * Dezelfde betaling, anders opgeschreven (#225). Het ene soort afschrift zet voor een kaartbetaling
 * "Card Payment: Printhuis", het andere alleen "Printhuis"; de ene indeling heeft een naam en een
 * omschrijving, de andere alles in één veld. Hier staat hoe de app twee regels dan toch als dezelfde
 * tegenpartij herkent. Puur: geen database.
 */

/** Wat een bank of kaart vóór de naam van de winkel zet. Alleen als los woord vooraan, met of zonder dubbele punt of streepje. */
const PREFIX = /^\s*(?:(?:card payment|card purchase|card transaction|kaartbetaling|pinbetaling|payment to|payment from|transfer to|transfer from|betaling aan)(?:\s*[:\-–]\s*|\s+)|(?:to|from)\s+)/i;

/** De omschrijving zonder zo'n voorvoegsel, zoals hij er staat. */
export function stripPaymentPrefix(text: string): string {
  const rest = text.replace(PREFIX, '');
  return rest.trim() ? rest : text;
}

/** Om te vergelijken: zonder voorvoegsel, in kleine letters, zonder spaties en leestekens ("Printhuis B.V." = "printhuis bv"). */
export function paymentText(text: string | null | undefined): string {
  return stripPaymentPrefix(text ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface Party {
  counter_iban: string | null;
  counter_name: string | null;
  description: string;
}

/**
 * Bijna dezelfde tegenpartij? Hebben beide regels een tegenrekening, dan beslist die. Anders de naam (of,
 * zonder naam, de omschrijving): gelijk op het voorvoegsel na, de ene begint met of bevat de andere, of de
 * naam van de een staat in de tekst van de ander. Minder dan vier tekens zegt niets.
 */
export function sameCounterparty(a: Party, b: Party): boolean {
  if (a.counter_iban && b.counter_iban) return normalizeIban(a.counter_iban) === normalizeIban(b.counter_iban);
  const [ta, tb] = [paymentText(a.counter_name || a.description), paymentText(b.counter_name || b.description)];
  if (!ta || !tb) return false;
  if (ta === tb) return true;
  const [all1, all2] = [paymentText(`${a.counter_name ?? ''} ${a.description}`), paymentText(`${b.counter_name ?? ''} ${b.description}`)];
  return (ta.length >= 4 && (tb.includes(ta) || all2.includes(ta))) || (tb.length >= 4 && (ta.includes(tb) || all1.includes(tb)));
}

/**
 * Dezelfde regel uit hetzelfde soort afschrift, alleen anders opgeschreven: de tekst is op het voorvoegsel
 * (en leestekens) na gelijk, maar niet letterlijk. Letterlijk gelijk is in één soort afschrift juist een
 * tweede betaling (twee keer koffie op één dag): daar beslist de volgorde in het bestand, zoals altijd.
 */
export function sameTextVariant(a: Pick<Party, 'counter_name' | 'description'>, b: Pick<Party, 'counter_name' | 'description'>): boolean {
  const raw = (p: Pick<Party, 'counter_name' | 'description'>) => `${p.counter_name ?? ''}|${p.description}`.replace(/\s+/g, ' ').trim().toLowerCase();
  if (raw(a) === raw(b)) return false;
  const text = (p: Pick<Party, 'counter_name' | 'description'>) => paymentText(p.description || p.counter_name);
  if (!text(a) || text(a) !== text(b)) return false;
  // heeft elk een naam, dan moet ook die op het voorvoegsel na gelijk zijn
  return !a.counter_name || !b.counter_name || paymentText(a.counter_name) === paymentText(b.counter_name);
}
