import type { Db } from '../db/database';
import type { Ledger } from '../core-ledger/ledger';
import { BV_LOON } from '../core-ledger/accounts';
import type { SettingsService } from '../settings/settings';
import { assertIsoDate, monthOf, today, type IsoDate } from '../shared/dates';
import { formatEuro, type Cents } from '../shared/money';
import { ValidationError } from '../shared/validation';

/**
 * Loon bij een bv: de directeur krijgt elke maand loon volgens de loonstrook (die komt van de salarisadministratie,
 * niet uit deze app). De app boekt dat loon pas na een bevestiging op Vandaag, nooit vanzelf, met de bedragen uit de
 * instellingen: Loon directeur-grootaandeelhouder aan Af te dragen loonheffing en Nog te betalen nettoloon.
 * De betalingen van het nettoloon en de loonheffing kies je daarna op het bankscherm; die halen de schuld weer weg.
 * Geen loonadministratie: pensioenpremie en andere inhoudingen boek je met een correctieboeking.
 */
export interface LoonSettings {
  bruto: Cents;
  loonheffing: Cents;
  netto: Cents;
  /** eerste maand, JJJJ-MM */
  vanaf: string;
}

const MAANDEN = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
/** vanaf deze dag van de maand staat het loon van die maand op Vandaag (de loonstrook is er dan meestal) */
const PROPOSE_FROM_DAY = 20;
/** nooit meer dan dit aantal maanden tegelijk voorstellen (een oude instelling levert anders een lawine op) */
const MAX_PENDING = 24;

/** "oktober 2026" */
export function monthLabel(month: string): string {
  const m = MONTH.exec(month);
  if (!m) throw new ValidationError('Ongeldige maand');
  return `${MAANDEN[Number(m[2]) - 1]} ${m[1]}`;
}

/** de volgende maand (JJJJ-MM) */
function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

export class LoonService {
  constructor(
    private readonly db: Db,
    private readonly ledger: Ledger,
    private readonly settings: SettingsService,
  ) {}

  /** De looninstelling als die geldt: alleen bij rechtsvorm bv. */
  active(): LoonSettings | null {
    const s = this.settings.get();
    return s.legalForm === 'bv' && s.loon ? s.loon : null;
  }

  /** Is het loon van deze maand al geboekt (en niet teruggedraaid)? De tegenboeking zelf telt niet mee. */
  isBooked(month: string): boolean {
    if (!MONTH.test(month)) throw new ValidationError('Ongeldige maand');
    const row = this.db.prepare(`SELECT 1 FROM journal_entries WHERE source_ref = ? AND status = 'definitief' AND reverses_entry_id IS NULL LIMIT 1`).get(`loon:${month}`);
    return row !== undefined;
  }

  /** Alle maanden waarvoor loon geboekt is, oudste eerst. */
  bookedMonths(): string[] {
    const rows = this.db.prepare(`SELECT DISTINCT source_ref AS ref FROM journal_entries WHERE source_ref LIKE 'loon:%' AND status = 'definitief' AND reverses_entry_id IS NULL ORDER BY source_ref`).all() as { ref: string }[];
    return rows.map((r) => r.ref.slice(5));
  }

  /**
   * De maanden die op Vandaag een voorstel verdienen: vanaf de ingestelde eerste maand tot en met de huidige maand
   * (die pas vanaf de 20e, als de loonstrook er is), zonder de maanden die al geboekt zijn.
   */
  pendingMonths(asOf: IsoDate = today()): { month: string; label: string }[] {
    const loon = this.active();
    if (!loon) return [];
    const current = asOf.slice(0, 7);
    const last = Number(asOf.slice(8, 10)) >= PROPOSE_FROM_DAY ? current : null;
    const out: { month: string; label: string }[] = [];
    for (let month = loon.vanaf; month < current || month === last; month = nextMonth(month)) {
      if (!this.isBooked(month)) out.push({ month, label: monthLabel(month) });
      if (out.length >= MAX_PENDING) break;
    }
    return out;
  }

  /**
   * Boekt het loon van een maand op de laatste dag van die maand: Loon DGA (bruto) aan Af te dragen loonheffing en
   * Nog te betalen nettoloon. Met `amounts` voor een maand die van de instelling afwijkt. Eén keer per maand;
   * opnieuw boeken na een terugdraaiing kan wel.
   */
  book(month: string, amounts?: Pick<LoonSettings, 'bruto' | 'loonheffing' | 'netto'>): number {
    const loon = this.active();
    if (!loon) throw new ValidationError('Loon boeken hoort bij een bv met een ingesteld maandloon (Instellingen → Btw, bij de rechtsvorm)');
    if (!MONTH.test(month)) throw new ValidationError('Ongeldige maand');
    const a = amounts ?? loon;
    if (!Number.isSafeInteger(a.bruto) || !Number.isSafeInteger(a.loonheffing) || !Number.isSafeInteger(a.netto) || a.bruto <= 0 || a.loonheffing < 0 || a.netto <= 0) throw new ValidationError('Vul bruto, loonheffing en netto in');
    if (a.loonheffing + a.netto !== a.bruto) throw new ValidationError('Bruto moet gelijk zijn aan loonheffing plus netto');
    if (this.isBooked(month)) throw new ValidationError(`Het loon van ${monthLabel(month)} is al geboekt`);
    // de rekeningen van een bv staan er niet vanzelf in een oudere administratie
    this.ledger.seedBvAccounts();
    const date = monthOf(`${month}-01` as IsoDate).end;
    assertIsoDate(date);
    return this.ledger.post({
      date,
      description: `Loon ${monthLabel(month)}: bruto ${formatEuro(a.bruto)}, loonheffing ${formatEuro(a.loonheffing)}, netto ${formatEuro(a.netto)}`,
      source: 'handmatig',
      sourceRef: `loon:${month}`,
      lines: [
        { account: BV_LOON.loonDga, debit: a.bruto, description: 'Loon directeur-grootaandeelhouder' },
        ...(a.loonheffing > 0 ? [{ account: BV_LOON.loonheffing, credit: a.loonheffing, description: 'Af te dragen loonheffing' }] : []),
        { account: BV_LOON.nettoloon, credit: a.netto, description: 'Nog te betalen nettoloon' },
      ],
    });
  }
}
