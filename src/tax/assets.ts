import { tx, type Db } from '../db/database';
import { ACCOUNTS } from '../core-ledger/accounts';
import type { Ledger, PostLine } from '../core-ledger/ledger';
import { addDays, today, type IsoDate } from '../shared/dates';
import type { Cents } from '../shared/money';
import { ValidationError } from '../shared/validation';

/**
 * Bedrijfsmiddelen en afschrijving.
 *
 * Het register wordt afgeleid uit de journaalregels op een activarekening (inventaris, vervoermiddelen),
 * dus het maakt niet uit hoe de aankoop geboekt is (bon, inkoopfactuur, bank). De gebruiker kan per
 * bedrijfsmiddel de naam, levensduur en restwaarde aanpassen.
 *
 * Afschrijving is lineair per maand, vanaf de maand van aanschaf, en wordt per afgesloten jaar als één
 * journaalpost op 31 december geboekt (bij verkoop tot de verkoopdatum). Fiscaal mag maximaal 20% per
 * jaar: de levensduur is daarom minstens 60 maanden. Voor het lopende jaar rekent de app een verwachting
 * (voor de schatting van de inkomstenbelasting), zonder te boeken.
 */

export const DEPRECIATION_ACCOUNTS: Record<string, { cumulative: string; expense: string }> = {
  [ACCOUNTS.inventaris]: { cumulative: ACCOUNTS.cumAfschrijvingInventaris, expense: ACCOUNTS.afschrijvingInventaris },
  [ACCOUNTS.vervoermiddelen]: { cumulative: ACCOUNTS.cumAfschrijvingVervoer, expense: ACCOUNTS.afschrijvingVervoer },
};

/** fiscaal maximaal 20% per jaar */
export const MIN_LIFETIME_MONTHS = 60;
/** onder dit bedrag (excl. btw, per stuk) mag je direct als kosten nemen */
export const ASSET_THRESHOLD: Cents = 450_00;

/** Lijkt op iets van de Energielijst of Milieulijst (EIA/MIA/Vamil)? Alleen een signaal, geen oordeel. */
const ENERGY_HINT = /zonnepane|pv[- ]?install|warmtepomp|laadpa(a)?l|thuisbatterij|accupakket|elektrisch|e-?bus|e-?bike|bakfiets|ev\b|led[- ]?verlicht|isolat|hr\+\+|zonneboiler/i;

export interface AssetRow {
  id: number;
  journal_line_id: number;
  account_rgs: string;
  name: string;
  acquired_on: IsoDate;
  cost: Cents;
  residual: Cents;
  lifetime_months: number;
  kia_excluded: number;
  status: 'actief' | 'verkocht' | 'vervallen';
  disposed_on: IsoDate | null;
  proceeds: Cents | null;
  disposal_entry_id: number | null;
  booked_elsewhere_until: number | null;
}

export interface Asset extends AssetRow {
  /** tot nu toe afgeschreven (in de app geboekt + wat buiten de app al is gedaan) */
  booked: Cents;
  /** boekwaarde: aanschaf min geboekte afschrijving */
  bookValue: Cents;
  /** afschrijving per jaar bij een volledig jaar */
  perYear: Cents;
  /** onder de € 450: had direct als kosten gekund (en telt niet mee voor de KIA) */
  belowThreshold: boolean;
  /** mogelijk EIA/MIA/Vamil: melden bij RVO binnen 3 maanden */
  energyHint: { deadline: IsoDate } | null;
}

const monthIndex = (d: IsoDate) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7)) - 1;

/**
 * Afschrijving tot en met het einde van een maand, cumulatief en afgerond (zo lopen de jaarbedragen
 * altijd precies op tot aanschaf min restwaarde). `until` = laatste maand die meetelt.
 */
export function cumulativeDepreciation(a: Pick<AssetRow, 'acquired_on' | 'cost' | 'residual' | 'lifetime_months'>, untilYear: number, untilMonth: number): Cents {
  const base = Math.max(0, a.cost - a.residual);
  const months = untilYear * 12 + untilMonth - 1 - monthIndex(a.acquired_on) + 1;
  if (months <= 0) return 0;
  return Math.min(base, Math.round((base * months) / a.lifetime_months));
}

export class AssetService {
  constructor(
    private readonly db: Db,
    private readonly ledger: Ledger,
  ) {}

  /** Nieuwe aankopen op een activarekening opnemen; teruggedraaide aankopen laten vervallen. */
  sync(asOf: IsoDate = today()): void {
    const accounts = Object.keys(DEPRECIATION_ACCOUNTS);
    tx(this.db, () => {
      const fresh = this.db
        .prepare(
          `SELECT l.id, a.rgs_code, COALESCE(NULLIF(l.description, ''), e.description) AS name, e.entry_date, l.debit
           FROM journal_lines l
           JOIN journal_entries e ON e.id = l.journal_entry_id
           JOIN chart_of_accounts a ON a.id = l.account_id
           WHERE a.rgs_code IN (${accounts.map(() => '?').join(',')}) AND l.debit > 0
             AND e.status = 'definitief' AND e.reverses_entry_id IS NULL
             -- een beginbalans is geen nieuwe investering (geen KIA, en de afschrijving liep al)
             AND e.source != 'opening'
             AND NOT EXISTS (SELECT 1 FROM assets s WHERE s.journal_line_id = l.id)`,
        )
        .all(...accounts) as { id: number; rgs_code: string; name: string; entry_date: IsoDate; debit: Cents }[];
      const since = this.db.prepare(`SELECT value FROM settings WHERE key = 'counter:depreciation-since'`).get() as { value: string } | undefined;
      const sinceYear = since ? Number(JSON.parse(since.value)) : null;
      const insert = this.db.prepare('INSERT INTO assets (journal_line_id, account_rgs, name, acquired_on, cost, lifetime_months, booked_elsewhere_until) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const f of fresh) {
        // gekocht vóór de update: eerdere jaren niet vanzelf boeken (de gebruiker kan dat wel kiezen)
        const elsewhere = sinceYear && Number(f.entry_date.slice(0, 4)) < sinceYear ? sinceYear - 1 : null;
        insert.run(f.id, f.rgs_code, f.name.slice(0, 200), f.entry_date, f.debit, MIN_LIFETIME_MONTHS, elsewhere);
      }

      // aankoop teruggedraaid (bv. andere categorie gekozen): bedrijfsmiddel vervalt, geboekte afschrijving terug
      const gone = this.db
        .prepare(
          `SELECT s.* FROM assets s JOIN journal_lines l ON l.id = s.journal_line_id JOIN journal_entries e ON e.id = l.journal_entry_id
           WHERE s.status = 'actief' AND e.status = 'teruggedraaid'`,
        )
        .all() as AssetRow[];
      for (const a of gone) {
        const booked = this.booked(a.id);
        if (booked > 0) {
          const acc = DEPRECIATION_ACCOUNTS[a.account_rgs]!;
          this.ledger.post({
            date: asOf,
            description: `Afschrijving teruggenomen: ${a.name} (aankoop gecorrigeerd)`,
            source: 'handmatig',
            sourceRef: `afschrijving-correctie:${a.id}`,
            lines: [
              { account: acc.cumulative, debit: booked },
              { account: acc.expense, credit: booked },
            ],
          });
        }
        this.db.prepare(`UPDATE assets SET status = 'vervallen' WHERE id = ?`).run(a.id);
      }
    });
  }

  /** Afschrijving die buiten de app is gedaan (jaren tot en met booked_elsewhere_until), tot en met `uptoYear`. */
  private elsewhere(a: AssetRow, uptoYear: number): Cents {
    if (a.booked_elsewhere_until === null) return 0;
    return cumulativeDepreciation(a, Math.min(uptoYear, a.booked_elsewhere_until), 12);
  }

  private booked(assetId: number, uptoYear?: number): Cents {
    const r = this.db
      .prepare(`SELECT COALESCE(SUM(amount), 0) AS s FROM asset_depreciation WHERE asset_id = ? ${uptoYear !== undefined ? 'AND year <= ?' : ''}`)
      .get(...(uptoYear !== undefined ? [assetId, uptoYear] : [assetId])) as { s: number };
    return r.s;
  }

  private row(id: number): AssetRow {
    const a = this.db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as AssetRow | undefined;
    if (!a) throw new ValidationError('Deze investering bestaat niet (meer)');
    return a;
  }

  get(id: number, asOf: IsoDate = today()): Asset {
    return this.enrich(this.row(id), asOf);
  }

  private enrich(a: AssetRow, asOf: IsoDate): Asset {
    const booked = this.booked(a.id) + this.elsewhere(a, 9999);
    const deadline = addDays(a.acquired_on, 91);
    return {
      ...a,
      booked,
      bookValue: a.status === 'actief' ? a.cost - booked : 0,
      perYear: Math.round(((a.cost - a.residual) * 12) / a.lifetime_months),
      belowThreshold: a.cost < ASSET_THRESHOLD,
      energyHint: a.status === 'actief' && ENERGY_HINT.test(a.name) && deadline >= asOf ? { deadline } : null,
    };
  }

  list(filter: { includeGone?: boolean } = {}, asOf: IsoDate = today()): Asset[] {
    this.sync(asOf);
    const rows = this.db.prepare(`SELECT * FROM assets ${filter.includeGone ? '' : `WHERE status != 'vervallen'`} ORDER BY acquired_on DESC, id DESC`).all() as AssetRow[];
    return rows.map((a) => this.enrich(a, asOf));
  }

  /** Naam, levensduur, restwaarde of "telt niet mee voor de KIA" aanpassen. Afschrijving die al geboekt is, blijft staan. */
  update(id: number, patch: { name?: string; lifetimeMonths?: number; residual?: Cents; kiaExcluded?: boolean; bookInApp?: boolean }): Asset {
    const a = this.row(id);
    if (a.status !== 'actief') throw new ValidationError('Alleen een investering die je nog gebruikt, kun je aanpassen');
    if (patch.lifetimeMonths !== undefined) {
      if (!Number.isInteger(patch.lifetimeMonths) || patch.lifetimeMonths < MIN_LIFETIME_MONTHS || patch.lifetimeMonths > 600) {
        throw new ValidationError('Vul tussen 5 en 50 jaar in (korter dan 5 jaar mag niet voor de belasting)');
      }
    }
    if (patch.residual !== undefined && (!Number.isSafeInteger(patch.residual) || patch.residual < 0 || patch.residual >= a.cost)) {
      throw new ValidationError('Wat het daarna nog waard is, moet lager zijn dan wat je ervoor betaalde');
    }
    if (patch.name !== undefined && !patch.name.trim()) throw new ValidationError('Geef de investering een naam');
    this.db
      .prepare('UPDATE assets SET name = COALESCE(?, name), lifetime_months = COALESCE(?, lifetime_months), residual = COALESCE(?, residual), kia_excluded = COALESCE(?, kia_excluded) WHERE id = ?')
      .run(patch.name?.trim() ?? null, patch.lifetimeMonths ?? null, patch.residual ?? null, patch.kiaExcluded === undefined ? null : patch.kiaExcluded ? 1 : 0, id);
    // "ook eerdere jaren in de app boeken": de volgende bookDue haalt ze in
    if (patch.bookInApp) this.db.prepare('UPDATE assets SET booked_elsewhere_until = NULL WHERE id = ?').run(id);
    return this.get(id);
  }

  /** Nog te boeken afschrijving van één bedrijfsmiddel over een jaar (tot en met `untilMonth`). */
  private dueFor(a: AssetRow, year: number, untilMonth = 12): Cents {
    if (Number(a.acquired_on.slice(0, 4)) > year) return 0;
    if (a.booked_elsewhere_until !== null && year <= a.booked_elsewhere_until) return 0;
    return Math.max(0, cumulativeDepreciation(a, year, untilMonth) - this.booked(a.id, year - 1) - this.elsewhere(a, year - 1));
  }

  /** Afschrijving van een afgesloten jaar boeken (idempotent: een jaar dat al geboekt is, wordt overgeslagen). */
  bookYear(year: number, asOf: IsoDate = today()): { entryId: number | null; amount: Cents } {
    if (year >= Number(asOf.slice(0, 4))) throw new ValidationError(`${year} is nog niet voorbij. De kosten voor dit jaar telt de app als het jaar voorbij is`);
    return tx(this.db, () => {
      const candidates = (this.db.prepare(`SELECT * FROM assets WHERE status = 'actief' AND acquired_on <= ?`).all(`${year}-12-31`) as AssetRow[]).filter(
        (a) => !this.db.prepare('SELECT 1 FROM asset_depreciation WHERE asset_id = ? AND year = ?').get(a.id, year),
      );
      const items = candidates.map((a) => ({ a, amount: this.dueFor(a, year) })).filter((x) => x.amount > 0);
      if (items.length === 0) return { entryId: null, amount: 0 };
      const lines: PostLine[] = [];
      for (const { a, amount } of items) {
        const acc = DEPRECIATION_ACCOUNTS[a.account_rgs]!;
        lines.push({ account: acc.expense, debit: amount, description: a.name }, { account: acc.cumulative, credit: amount, description: a.name });
      }
      const entryId = this.ledger.post({ date: `${year}-12-31`, description: `Afschrijving bedrijfsmiddelen ${year}`, source: 'handmatig', sourceRef: `afschrijving:${year}`, lines });
      const rec = this.db.prepare('INSERT INTO asset_depreciation (asset_id, year, amount, journal_entry_id) VALUES (?, ?, ?, ?)');
      for (const { a, amount } of items) rec.run(a.id, year, amount, entryId);
      return { entryId, amount: items.reduce((s, x) => s + x.amount, 0) };
    });
  }

  /** Alle afgesloten jaren die nog niet geboekt zijn (achtergrondtaak en knop). */
  bookDue(asOf: IsoDate = today()): { years: number[]; amount: Cents } {
    this.sync(asOf);
    const first = this.db.prepare(`SELECT MIN(substr(acquired_on, 1, 4)) AS y FROM assets WHERE status = 'actief'`).get() as { y: string | null };
    const years: number[] = [];
    let amount = 0;
    if (!first.y) return { years, amount };
    for (let y = Number(first.y); y < Number(asOf.slice(0, 4)); y++) {
      const r = this.bookYear(y, asOf);
      if (r.entryId) {
        years.push(y);
        amount += r.amount;
      }
    }
    return { years, amount };
  }

  /** Nog niet geboekte afschrijving van een jaar, tot en met `untilMonth` (12 = het hele jaar). */
  projected(year: number, untilMonth = 12): Cents {
    const rows = this.db.prepare(`SELECT * FROM assets WHERE status = 'actief'`).all() as AssetRow[];
    return rows
      .filter((a) => !this.db.prepare('SELECT 1 FROM asset_depreciation WHERE asset_id = ? AND year = ?').get(a.id, year))
      .reduce((s, a) => s + this.dueFor(a, year, untilMonth), 0);
  }

  /**
   * Verkocht of weggedaan. Eerst de afschrijving tot de verkoopmaand, dan gaat de boekwaarde naar
   * "boekresultaat". De opbrengst zelf komt binnen via een gewone factuur (met btw); `proceeds`
   * (excl. btw) is alleen voor de desinvesteringsbijtelling.
   */
  dispose(id: number, date: IsoDate, proceeds: Cents): Asset {
    const a = this.row(id);
    if (a.status !== 'actief') throw new ValidationError('Deze investering is al verkocht of weggedaan');
    if (date < a.acquired_on) throw new ValidationError('De verkoopdatum ligt vóór de aankoop');
    if (!Number.isSafeInteger(proceeds) || proceeds < 0) throw new ValidationError('Vul de verkoopprijs in (0 als je het wegdoet)');
    const year = Number(date.slice(0, 4));
    const acc = DEPRECIATION_ACCOUNTS[a.account_rgs]!;
    return tx(this.db, () => {
      this.bookDue(date);
      // afschrijving in het verkoopjaar: tot en met de maand vóór de verkoop
      const bookedYear = this.db.prepare('SELECT amount, journal_entry_id FROM asset_depreciation WHERE asset_id = ? AND year = ?').get(a.id, year) as { amount: Cents } | undefined;
      if (bookedYear) {
        // verkoop in een jaar dat al (heel) geboekt is: het teveel terugnemen
        const target = Math.max(0, cumulativeDepreciation(a, year, Number(date.slice(5, 7)) - 1) - this.booked(a.id, year - 1) - this.elsewhere(a, year - 1));
        const excess = bookedYear.amount - target;
        if (excess > 0) {
          this.ledger.post({
            date,
            description: `Afschrijving ${year} gecorrigeerd tot verkoop: ${a.name}`,
            source: 'handmatig',
            sourceRef: `afschrijving-correctie:${a.id}:${year}`,
            lines: [
              { account: acc.cumulative, debit: excess, description: a.name },
              { account: acc.expense, credit: excess, description: a.name },
            ],
          });
          this.db.prepare('UPDATE asset_depreciation SET amount = amount - ? WHERE asset_id = ? AND year = ?').run(excess, a.id, year);
        }
      } else {
        const amount = this.dueFor(a, year, Number(date.slice(5, 7)) - 1);
        if (amount > 0) {
          const entryId = this.ledger.post({
            date,
            description: `Afschrijving ${year} tot verkoop: ${a.name}`,
            source: 'handmatig',
            sourceRef: `afschrijving:${year}:${a.id}`,
            lines: [
              { account: acc.expense, debit: amount, description: a.name },
              { account: acc.cumulative, credit: amount, description: a.name },
            ],
          });
          this.db.prepare('INSERT INTO asset_depreciation (asset_id, year, amount, journal_entry_id) VALUES (?, ?, ?, ?)').run(a.id, year, amount, entryId);
        }
      }
      const booked = this.booked(a.id);
      const lines: PostLine[] = [{ account: a.account_rgs, credit: a.cost, description: a.name }];
      if (booked > 0) lines.push({ account: acc.cumulative, debit: booked, description: a.name });
      if (a.cost - booked > 0) lines.push({ account: ACCOUNTS.boekresultaat, debit: a.cost - booked, description: `Boekwaarde ${a.name}` });
      const entryId = this.ledger.post({ date, description: `Verkocht / buiten gebruik: ${a.name}`, source: 'handmatig', sourceRef: `desinvestering:${a.id}`, lines });
      this.db.prepare(`UPDATE assets SET status = 'verkocht', disposed_on = ?, proceeds = ?, disposal_entry_id = ? WHERE id = ?`).run(date, proceeds, entryId, a.id);
      return this.get(a.id, date);
    });
  }
}
