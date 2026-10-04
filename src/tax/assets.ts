import { tx, type Db } from '../db/database';
import { ACCOUNTS } from '../core-ledger/accounts';
import { NON_DEDUCTIBLE_VAT } from '../core-ledger/rules';
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
 * Afschrijving is lineair per maand, vanaf de maand van ingebruikname (standaard de aankoopdatum), en wordt per afgesloten jaar als één
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
  /** 1 = er was al vóór de instapdatum (overstap): afschrijven vanaf de boekwaarde, geen investeringsaftrek */
  is_opening: number;
  /** datum van ingebruikname als die later is dan de aankoop (fiscaal begint de afschrijving dan); null = aankoopdatum */
  in_use_on: IsoDate | null;
  /** hoe het bedrijfsmiddel de onderneming verliet: verkocht, of overgebracht naar privé */
  disposal_kind: 'verkocht' | 'prive' | null;
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

/** Vanaf wanneer afgeschreven wordt: de ingebruikname, of anders de aankoopdatum. */
export const depreciationStart = (a: Pick<AssetRow, 'acquired_on'> & { in_use_on?: IsoDate | null }): IsoDate => a.in_use_on ?? a.acquired_on;

/**
 * Afschrijving tot en met het einde van een maand, cumulatief en afgerond (zo lopen de jaarbedragen
 * altijd precies op tot aanschaf min restwaarde). `until` = laatste maand die meetelt.
 */
export function cumulativeDepreciation(a: Pick<AssetRow, 'acquired_on' | 'cost' | 'residual' | 'lifetime_months'> & { in_use_on?: IsoDate | null }, untilYear: number, untilMonth: number): Cents {
  const base = Math.max(0, a.cost - a.residual);
  const months = untilYear * 12 + untilMonth - 1 - monthIndex(depreciationStart(a)) + 1;
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
    if (this.db.readonly) return;
    const accounts = Object.keys(DEPRECIATION_ACCOUNTS);
    tx(this.db, () => {
      const fresh = this.db
        .prepare(
          `SELECT l.id, a.rgs_code, COALESCE(NULLIF(l.description, ''), e.description) AS name, e.entry_date,
             ${this.lineAmount('l')} AS debit
           FROM journal_lines l
           JOIN journal_entries e ON e.id = l.journal_entry_id
           JOIN chart_of_accounts a ON a.id = l.account_id
           WHERE a.rgs_code IN (${accounts.map(() => '?').join(',')}) AND l.debit > 0
             AND COALESCE(l.vat_code, '') != '${NON_DEDUCTIBLE_VAT}'
             AND e.status = 'definitief' AND e.reverses_entry_id IS NULL
             -- een beginbalans is geen nieuwe investering (geen KIA, en de afschrijving liep al)
             AND e.source != 'opening'`,
        )
        .all(...accounts) as { id: number; rgs_code: string; name: string; entry_date: IsoDate; debit: Cents }[];
      const since = this.db.prepare(`SELECT value FROM settings WHERE key = 'counter:depreciation-since'`).get() as { value: string } | undefined;
      const sinceYear = since ? Number(JSON.parse(since.value)) : null;
      const insert = this.db.prepare('INSERT OR IGNORE INTO assets (journal_line_id, account_rgs, name, acquired_on, cost, lifetime_months, booked_elsewhere_until) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const f of fresh) {
        // gekocht vóór de update: eerdere jaren niet vanzelf boeken (de gebruiker kan dat wel kiezen)
        const elsewhere = sinceYear && Number(f.entry_date.slice(0, 4)) < sinceYear ? sinceYear - 1 : null;
        insert.run(f.id, f.rgs_code, f.name.slice(0, 200), f.entry_date, f.debit, MIN_LIFETIME_MONTHS, elsewhere);
      }

      // Een gecorrigeerde aankoop krijgt een nieuw bedrijfsmiddel; credits moeten opnieuw passen.
      this.db.prepare(`DELETE FROM asset_credit_allocations WHERE asset_id IN (
        SELECT s.id FROM assets s JOIN journal_lines l ON l.id = s.journal_line_id JOIN journal_entries e ON e.id = l.journal_entry_id WHERE e.status = 'teruggedraaid')`).run();
      // Herstel bestaande KOR-prijzen en trek alleen nog geldige, toegewezen credits af.
      for (const f of fresh) {
        const id = (this.db.prepare('SELECT id FROM assets WHERE journal_line_id = ?').get(f.id) as { id: number }).id;
        const cost = this.costAt(id);
        this.db.prepare(`UPDATE assets SET cost = ? WHERE id = ? AND status = 'actief'`).run(cost, id);
      }
      // Elke credit verlaagt meteen de beschikbare kostprijs; meerdere credits kunnen die niet overschrijden.
      for (const c of this.unassignedCredits(false)) {
        const candidates = c.candidates.filter(a => this.row(a.id).cost >= c.amount);
        if (candidates.length === 1) {
          const id = candidates[0]!.id;
          this.db.prepare('INSERT INTO asset_credit_allocations (journal_line_id, asset_id) VALUES (?, ?)').run(c.lineId, id);
          this.db.prepare('UPDATE assets SET cost = ? WHERE id = ?').run(this.costAt(id), id);
        }
      }

      // aankoop teruggedraaid (bv. andere categorie gekozen): bedrijfsmiddel vervalt, geboekte afschrijving terug
      const gone = this.db
        .prepare(
          `SELECT s.*, (SELECT MIN(r.entry_date) FROM journal_entries r WHERE r.reverses_entry_id = e.id) AS reversed_on FROM assets s JOIN journal_lines l ON l.id = s.journal_line_id JOIN journal_entries e ON e.id = l.journal_entry_id
           WHERE s.status = 'actief' AND e.status = 'teruggedraaid'`,
        )
        .all() as (AssetRow & { reversed_on: IsoDate })[];
      for (const a of gone) {
        const correctionDate = a.reversed_on > asOf ? a.reversed_on : asOf;
        const booked = this.booked(a.id, undefined, correctionDate);
        if (booked > 0) {
          const acc = DEPRECIATION_ACCOUNTS[a.account_rgs]!;
          const entryId = this.ledger.post({
            date: correctionDate,
            description: `Afschrijving teruggenomen: ${a.name} (aankoop gecorrigeerd)`,
            source: 'handmatig',
            sourceRef: `afschrijving-correctie:${a.id}`,
            lines: [
              { account: acc.cumulative, debit: booked },
              { account: acc.expense, credit: booked },
            ],
          });
          this.recordDepreciation(a.id, Number(correctionDate.slice(0, 4)), -booked, entryId);
        }
        this.db.prepare(`UPDATE assets SET status = 'vervallen' WHERE id = ?`).run(a.id);
      }
    });
  }

  private lineAmount(alias: string): string {
    return `${alias}.debit - ${alias}.credit + COALESCE((SELECT SUM(n.debit - n.credit) FROM journal_lines n
      WHERE n.journal_entry_id = ${alias}.journal_entry_id AND n.account_id = ${alias}.account_id AND n.id > ${alias}.id
        AND n.vat_code = '${NON_DEDUCTIBLE_VAT}' AND n.id < COALESCE((SELECT MIN(x.id) FROM journal_lines x
          WHERE x.journal_entry_id = ${alias}.journal_entry_id AND x.account_id = ${alias}.account_id AND x.id > ${alias}.id
            AND COALESCE(x.vat_code, '') != '${NON_DEDUCTIBLE_VAT}'), 9223372036854775807)), 0)`;
  }

  private costAt(assetId: number, to: IsoDate = '9999-12-31'): Cents {
    const row = this.db.prepare(`SELECT ${this.lineAmount('l')} AS base FROM assets s JOIN journal_lines l ON l.id = s.journal_line_id WHERE s.id = ?`).get(assetId) as { base: number };
    const reduction = this.db.prepare(`SELECT COALESCE(SUM(-(${this.lineAmount('l')})), 0) AS amount
      FROM asset_credit_allocations k JOIN journal_lines l ON l.id = k.journal_line_id JOIN journal_entries e ON e.id = l.journal_entry_id
      WHERE k.asset_id = ? AND e.entry_date <= ? AND e.reverses_entry_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id = e.id AND r.entry_date <= ?)`)
      .get(assetId, to, to) as { amount: number };
    return Math.max(0, row.base - reduction.amount);
  }

  /** Credits waarvoor het bedrijfsmiddel nog gekozen moet worden. Geen verkoop- of tegenboekingen. */
  unassignedCredits(sync = true): { lineId: number; date: IsoDate; name: string; amount: Cents; candidates: { id: number; name: string }[] }[] {
    if (sync) this.sync();
    const rows = this.db.prepare(`SELECT l.id, e.entry_date AS date, e.description AS name, -(${this.lineAmount('l')}) AS amount, a.rgs_code AS rgs, l.relation_id AS relation
      FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN chart_of_accounts a ON a.id = l.account_id
      WHERE a.rgs_code IN (?, ?) AND l.credit > 0 AND COALESCE(l.vat_code, '') != '${NON_DEDUCTIBLE_VAT}'
        AND e.source IN ('inkoop', 'bank') AND e.status = 'definitief' AND e.reverses_entry_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM asset_credit_allocations k WHERE k.journal_line_id = l.id)
      ORDER BY e.entry_date, l.id`).all(ACCOUNTS.inventaris, ACCOUNTS.vervoermiddelen) as { id: number; date: IsoDate; name: string; amount: Cents; rgs: string; relation: number | null }[];
    return rows.map(c => ({ lineId: c.id, date: c.date, name: c.name, amount: c.amount, candidates: this.db.prepare(`SELECT s.id, s.name FROM assets s JOIN journal_lines l ON l.id = s.journal_line_id JOIN journal_entries e ON e.id = l.journal_entry_id
      WHERE s.status = 'actief' AND e.status = 'definitief' AND s.account_rgs = ? AND s.acquired_on <= ? AND s.cost >= ? AND (? IS NULL OR l.relation_id = ?) ORDER BY s.id`).all(c.rgs, c.date, c.amount, c.relation, c.relation) as { id: number; name: string }[] }));
  }

  /**
   * Credits die de gebruiker nog moet toewijzen, zonder iets te schrijven (voor controles en
   * overzichten). Reserveer de kostprijs van iedere automatisch koppelbare credit in dezelfde
   * datum-/regelvolgorde als `sync`, zodat volgende credits alleen de resterende kostprijs gebruiken.
   */
  pendingCredits(): ReturnType<AssetService['unassignedCredits']> {
    const remaining = new Map<number, Cents>();
    const pending: ReturnType<AssetService['unassignedCredits']> = [];
    for (const c of this.unassignedCredits(false)) {
      const candidates = c.candidates.filter(a => {
        if (!remaining.has(a.id)) remaining.set(a.id, this.row(a.id).cost);
        return remaining.get(a.id)! >= c.amount;
      });
      if (candidates.length === 1) {
        const id = candidates[0]!.id;
        remaining.set(id, remaining.get(id)! - c.amount);
      } else {
        pending.push({ ...c, candidates });
      }
    }
    return pending;
  }

  allocateCredit(lineId: number, assetId: number): void {
    tx(this.db, () => {
      this.sync();
      const assigned = this.db.prepare('SELECT asset_id FROM asset_credit_allocations WHERE journal_line_id = ?').get(lineId) as { asset_id: number } | undefined;
      if (assigned?.asset_id === assetId) return;
      const credit = this.unassignedCredits(false).find(c => c.lineId === lineId);
      if (!credit || !credit.candidates.some(a => a.id === assetId)) throw new ValidationError('Kies een bestaand bedrijfsmiddel van deze aankoop waarvoor de credit past');
      this.db.prepare('INSERT INTO asset_credit_allocations (journal_line_id, asset_id) VALUES (?, ?)').run(lineId, assetId);
      this.sync();
    });
  }

  /** Afschrijving die buiten de app is gedaan (jaren tot en met booked_elsewhere_until), tot en met `uptoYear`. */
  private elsewhere(a: AssetRow, uptoYear: number): Cents {
    if (a.booked_elsewhere_until === null) return 0;
    return cumulativeDepreciation(a, Math.min(uptoYear, a.booked_elsewhere_until), 12);
  }

  private recordDepreciation(assetId: number, year: number, amount: Cents, entryId: number): void {
    this.db.prepare('INSERT INTO asset_depreciation_history (asset_id, year, amount, journal_entry_id) VALUES (?, ?, ?, ?)').run(assetId, year, amount, entryId);
  }

  private booked(assetId: number, uptoYear?: number, asOf: IsoDate = '9999-12-31'): Cents {
    const r = this.db.prepare(`SELECT COALESCE(SUM(h.amount), 0) AS s
      FROM asset_depreciation_history h JOIN journal_entries e ON e.id = h.journal_entry_id
      WHERE h.asset_id = ? AND e.entry_date <= ? ${uptoYear !== undefined ? 'AND h.year <= ?' : ''}
        AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id = e.id AND r.entry_date <= ?)`)
      .get(...(uptoYear !== undefined ? [assetId, asOf, uptoYear, asOf] : [assetId, asOf, asOf])) as { s: number };
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
    // restwaarde niet opslaan na een credit: eerdere peildata houden de oorspronkelijke restwaarde
    const cost = this.costAt(a.id, asOf);
    a = { ...a, cost, residual: Math.min(a.residual, cost) };
    const reversed = this.db.prepare(`SELECT 1 FROM assets s JOIN journal_lines l ON l.id = s.journal_line_id
      JOIN journal_entries r ON r.reverses_entry_id = l.journal_entry_id WHERE s.id = ? AND r.entry_date <= ?`).get(a.id, asOf);
    const status = reversed ? 'vervallen' : a.disposed_on && a.disposed_on <= asOf ? 'verkocht' : 'actief';
    a = { ...a, status };
    const external = a.booked_elsewhere_until === null ? 0 : Number(asOf.slice(0, 4)) <= a.booked_elsewhere_until
      ? cumulativeDepreciation(a, Number(asOf.slice(0, 4)), Number(asOf.slice(5, 7))) : this.elsewhere(a, a.booked_elsewhere_until);
    const booked = this.booked(a.id, undefined, asOf) + external;
    const deadline = addDays(a.acquired_on, 91);
    return {
      ...a,
      booked,
      bookValue: a.status === 'actief' ? Math.max(0, a.cost - booked) : 0,
      perYear: Math.max(0, Math.round(((a.cost - a.residual) * 12) / a.lifetime_months)),
      belowThreshold: a.cost < ASSET_THRESHOLD,
      energyHint: a.status === 'actief' && !a.is_opening && ENERGY_HINT.test(a.name) && deadline >= asOf ? { deadline } : null,
    };
  }

  list(filter: { includeGone?: boolean } = {}, asOf: IsoDate = today()): Asset[] {
    this.sync(asOf);
    const rows = this.db.prepare(`SELECT * FROM assets ORDER BY acquired_on DESC, id DESC`).all() as AssetRow[];
    return rows.filter(a => a.acquired_on <= asOf).map((a) => this.enrich(a, asOf)).filter(a => filter.includeGone || a.status !== 'vervallen');
  }

  /** Naam, levensduur, restwaarde of "telt niet mee voor de KIA" aanpassen. Afschrijving die al geboekt is, blijft staan. */
  update(id: number, patch: { name?: string; lifetimeMonths?: number; residual?: Cents; kiaExcluded?: boolean; bookInApp?: boolean; inUseOn?: IsoDate | null }): Asset {
    const a = this.row(id);
    if (a.status !== 'actief') throw new ValidationError('Alleen een investering die je nog gebruikt, kun je aanpassen');
    if (patch.inUseOn !== undefined) {
      if (patch.inUseOn !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(patch.inUseOn) || patch.inUseOn < a.acquired_on)) throw new ValidationError('De datum van ingebruikname ligt niet vóór de aankoop');
      if (this.booked(a.id) > 0) throw new ValidationError('Er is al afschrijving voor geboekt; vraag je boekhouder om dit te corrigeren');
      this.db.prepare('UPDATE assets SET in_use_on = ? WHERE id = ?').run(patch.inUseOn && patch.inUseOn !== a.acquired_on ? patch.inUseOn : null, id);
    }
    if (patch.lifetimeMonths !== undefined) {
      // al in gebruik vóór de overstap: de levensduur is wat er nog over is, dat mag korter dan 5 jaar
      const min = a.is_opening ? 12 : MIN_LIFETIME_MONTHS;
      if (!Number.isInteger(patch.lifetimeMonths) || patch.lifetimeMonths < min || patch.lifetimeMonths > 600) {
        throw new ValidationError(a.is_opening ? 'Vul tussen 1 en 50 jaar in' : 'Vul tussen 5 en 50 jaar in (korter dan 5 jaar mag niet voor de belasting)');
      }
    }
    if (patch.residual !== undefined && (!Number.isSafeInteger(patch.residual) || patch.residual < 0 || (a.cost > 0 ? patch.residual >= a.cost : patch.residual > 0))) {
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
    a = { ...a, cost: this.costAt(a.id, `${year}-${String(untilMonth).padStart(2, '0')}-31`) };
    if (Number(depreciationStart(a).slice(0, 4)) > year) return 0;
    if (a.booked_elsewhere_until !== null && year <= a.booked_elsewhere_until) return 0;
    return Math.max(0, cumulativeDepreciation(a, year, untilMonth) - this.booked(a.id, year - 1) - this.elsewhere(a, year - 1));
  }

  /** Afschrijving van een afgesloten jaar boeken (idempotent: een jaar dat al geboekt is, wordt overgeslagen). */
  bookYear(year: number, asOf: IsoDate = today()): { entryId: number | null; amount: Cents } {
    if (year >= Number(asOf.slice(0, 4))) throw new ValidationError(`${year} is nog niet voorbij. De kosten voor dit jaar telt de app als het jaar voorbij is`);
    return tx(this.db, () => {
      const candidates = (this.db.prepare(`SELECT * FROM assets WHERE status = 'actief' AND acquired_on <= ? ORDER BY id`).all(`${year}-12-31`) as AssetRow[]).filter(
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
      for (const { a, amount } of items) {
        rec.run(a.id, year, amount, entryId);
        this.recordDepreciation(a.id, year, amount, entryId);
      }
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
   *
   * `kind = 'prive'`: overgebracht naar privévermogen (fiscaal ook een vervreemding). `proceeds` is
   * dan de waarde in het economisch verkeer; die wordt als privé-opname geboekt tegen boekresultaat.
   * Btw over de onttrekking (als er btw is afgetrokken) boekt de app niet: dat gaat via de boekhouder.
   */
  dispose(id: number, date: IsoDate, proceeds: Cents, kind: 'verkocht' | 'prive' = 'verkocht'): Asset {
    const a = this.row(id);
    if (a.status !== 'actief') throw new ValidationError('Deze investering is al verkocht of weggedaan');
    if (date < a.acquired_on) throw new ValidationError('De verkoopdatum ligt vóór de aankoop');
    if (!Number.isSafeInteger(proceeds) || proceeds < 0) throw new ValidationError(kind === 'prive' ? 'Vul in wat het nu waard is' : 'Vul de verkoopprijs in (0 als je het wegdoet)');
    if (kind !== 'verkocht' && kind !== 'prive') throw new ValidationError('Kies verkocht of naar privé');
    const year = Number(date.slice(0, 4));
    const acc = DEPRECIATION_ACCOUNTS[a.account_rgs]!;
    return tx(this.db, () => {
      this.bookDue(date);
      // afschrijving in het verkoopjaar: tot en met de maand vóór de verkoop
      const bookedYear = this.db.prepare('SELECT amount, journal_entry_id FROM asset_depreciation WHERE asset_id = ? AND year = ?').get(a.id, year) as { amount: Cents; journal_entry_id: number } | undefined;
      if (bookedYear) {
        // verkoop in een jaar dat al (heel) geboekt is: het teveel terugnemen
        const target = Math.max(0, cumulativeDepreciation(a, year, Number(date.slice(5, 7)) - 1) - this.booked(a.id, year - 1) - this.elsewhere(a, year - 1));
        const bookedForYear = this.booked(a.id, year) - this.booked(a.id, year - 1);
        const originalDate = this.ledger.getEntry(bookedYear.journal_entry_id).entry_date;
        // Een latere jaarpost volledig neutraliseren op zijn eigen datum. Het juiste
        // deel krijgt een eigen post op de verkoopdatum, anders wordt de afschrijving
        // vóór 31 december negatief en klopt de historische cumulatieve rekening niet.
        const relocate = originalDate > date;
        const excess = relocate ? bookedForYear : bookedForYear - target;
        if (excess > 0) {
          const entryId = this.ledger.post({
            date: relocate ? originalDate : date,
            description: `Afschrijving ${year} gecorrigeerd tot verkoop: ${a.name}`,
            source: 'handmatig',
            sourceRef: `afschrijving-correctie:${a.id}:${year}`,
            lines: [
              { account: acc.cumulative, debit: excess, description: a.name },
              { account: acc.expense, credit: excess, description: a.name },
            ],
          });
          this.recordDepreciation(a.id, year, -excess, entryId);
        }
        if (relocate && target > 0) {
          const entryId = this.ledger.post({ date, description: `Afschrijving ${year} tot verkoop: ${a.name}`,
            source: 'handmatig', sourceRef: `afschrijving:${year}:${a.id}`,
            lines: [{ account: acc.expense, debit: target, description: a.name }, { account: acc.cumulative, credit: target, description: a.name }] });
          this.recordDepreciation(a.id, year, target, entryId);
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
          this.recordDepreciation(a.id, year, amount, entryId);
        }
      }
      const booked = this.booked(a.id);
      const lines: PostLine[] = [{ account: a.account_rgs, credit: a.cost, description: a.name }];
      if (booked > 0) lines.push({ account: acc.cumulative, debit: booked, description: a.name });
      if (a.cost - booked > 0) lines.push({ account: ACCOUNTS.boekresultaat, debit: a.cost - booked, description: `Boekwaarde ${a.name}` });
      if (kind === 'prive' && proceeds > 0) {
        lines.push({ account: ACCOUNTS.priveOpnamen, debit: proceeds, description: `Naar privé: ${a.name}` }, { account: ACCOUNTS.boekresultaat, credit: proceeds, description: `Waarde naar privé: ${a.name}` });
      }
      const entryId = this.ledger.post({ date, description: `${kind === 'prive' ? 'Naar privé' : 'Verkocht / buiten gebruik'}: ${a.name}`, source: 'handmatig', sourceRef: `desinvestering:${a.id}`, lines });
      this.db.prepare(`UPDATE assets SET status = 'verkocht', disposed_on = ?, proceeds = ?, disposal_entry_id = ?, disposal_kind = ? WHERE id = ?`).run(date, proceeds, entryId, kind, a.id);
      return this.get(a.id, date);
    });
  }
}
