import type { Db } from '../db/database';

/**
 * Schrijvende handelingen in de boekhoudermodus (#427): een correctieboeking, een boeking terugdraaien, het
 * rekeningschema wijzigen, een ingelezen afschrift weghalen. Kijken (balansen, kaarten, rapporten, exports)
 * laat niets achter. Alleen additief: er is geen knop om dit te wissen, en het gaat mee in back-ups.
 *
 * Waarom: we geven geen advies over een boekhouding; vragen lopen via de boekhouder. Is er buiten de boekhouder
 * om in deze modus geschreven, dan is dat hier te zien (Instellingen → Over, en in het pakket voor de boekhouder).
 * Wat een antwoord van de boekhouder (uitwisseling) in de boeken zet, telt niet mee: dat is de bedoelde route.
 */
export type AdvancedActionKind = 'memoriaal' | 'terugdraaien' | 'rekening-toevoegen' | 'rekening-hernoemen' | 'rekening-weghalen' | 'afschrift-weghalen';

export function recordAdvancedAction(db: Db, kind: AdvancedActionKind, detail: string | null = null): void {
  db.prepare('INSERT INTO advanced_actions (kind, detail) VALUES (?, ?)').run(kind, detail);
}

export interface AdvancedUsage {
  count: number;
  /** SQLite-tijdstip (UTC) van de eerste en laatste handeling, of null als er nooit is geschreven */
  first: string | null;
  last: string | null;
}

export function advancedUsage(db: Db): AdvancedUsage {
  const row = db.prepare('SELECT COUNT(*) AS count, MIN(at) AS first, MAX(at) AS last FROM advanced_actions').get() as { count: number; first: string | null; last: string | null };
  return { count: row.count, first: row.first, last: row.last };
}

/** Eén regel voor mensen: "nooit gebruikt" of "gebruikt: 3 handelingen, eerste 2026-10-15, laatste 2026-10-15". */
export function advancedUsageText(u: AdvancedUsage): string {
  if (u.count === 0) return 'Boekhoudermodus: er is nooit in geschreven.';
  const day = (s: string) => s.slice(0, 10);
  return `Boekhoudermodus: ${u.count === 1 ? '1 handeling' : `${u.count} handelingen`}, eerste op ${day(u.first!)}, laatste op ${day(u.last!)}.`;
}
