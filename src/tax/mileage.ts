import { tx, type Db } from '../db/database';
import { ACCOUNTS } from '../core-ledger/accounts';
import type { Ledger } from '../core-ledger/ledger';
import { addDays, addMonths, assertIsoDate, diffDays, monthOf, weekOf, type IsoDate } from '../shared/dates';
import type { Cents } from '../shared/money';
import { ValidationError } from '../shared/validation';
import { rulesFor } from './income-tax';

export interface Trip {
  id: number;
  trip_date: IsoDate;
  km: number;
  description: string;
  job_id: number | null;
  /** centen per km in het jaar van de rit */
  rate: Cents;
  amount: Cents;
}

export interface TimeEntry {
  id: number;
  /** begin van de periode (bij één dag: die dag) */
  entry_date: IsoDate;
  /** laatste dag van de periode; leeg = één dag */
  period_end: IsoDate | null;
  hours: number;
  description: string;
}

export interface HoursForecast {
  target: number;
  /** gewerkt tot en met vandaag */
  total: number;
  /** uren die nog op de planning staan (een herhaling of periode die nog loopt) */
  planned: number;
  remaining: number;
  /** uren per week die je tot 31 december nog moet maken */
  perWeekNeeded: number;
  /** je tempo sinds je eerste uren dit jaar, per week */
  perWeekNow: number;
  /** wanneer je het haalt bij dat tempo; leeg als dat niet dit jaar lukt of er geen tempo is */
  reachDate: IsoDate | null;
}

export type HoursPeriod = 'dag' | 'week' | 'maand';

export interface HoursInput {
  /** dag: de dag; week: een dag in de week; maand: een dag in de maand */
  date: IsoDate;
  /** bij week en maand: de uren in totaal over die periode */
  hours: number;
  description: string;
  period?: HoursPeriod;
  /** herhaal dezelfde regel tot en met deze datum (dag: werkdagen, week: wekelijks, maand: maandelijks) */
  repeatUntil?: IsoDate;
}

interface Span {
  start: IsoDate;
  end: IsoDate;
}

const MAX_SPANS = 400;
const weekday = (date: IsoDate): number => new Date(`${date}T00:00:00Z`).getUTCDay();
const days = (span: Span): number => diffDays(span.start, span.end) + 1;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** De periode waarin `date` valt: de dag zelf, maandag t/m zondag, of de hele maand. */
function spanFor(date: IsoDate, period: HoursPeriod): Span {
  if (period === 'dag') return { start: date, end: date };
  return period === 'maand' ? monthOf(date) : weekOf(date);
}

/** Alle periodes van een invoer, met herhaling; één periode die over de jaargrens gaat wordt twee. */
function spansFor(input: HoursInput): Span[] {
  const period = input.period ?? 'dag';
  const first = spanFor(input.date, period);
  const spans: Span[] = [];
  if (!input.repeatUntil) spans.push(first);
  else {
    assertIsoDate(input.repeatUntil, 'einddatum van de herhaling');
    if (input.repeatUntil < input.date) throw new ValidationError('De herhaling moet eindigen op of na de begindatum');
    if (period === 'dag') {
      for (let d = input.date; d <= input.repeatUntil && spans.length <= MAX_SPANS; d = addDays(d, 1)) if (weekday(d) !== 0 && weekday(d) !== 6) spans.push({ start: d, end: d });
    } else {
      for (let i = 0; ; i++) {
        const span = period === 'week' ? spanFor(addDays(first.start, 7 * i), 'week') : spanFor(addMonths(first.start, i), 'maand');
        if (span.start > input.repeatUntil) break;
        spans.push(span);
        if (spans.length > MAX_SPANS) break;
      }
    }
    if (spans.length === 0) throw new ValidationError('In die herhaling zit geen werkdag');
  }
  if (spans.length > MAX_SPANS) throw new ValidationError('Dat zijn te veel regels in één keer; kies een kortere herhaling');
  return spans;
}

/**
 * Zakelijke kilometers met een privévervoermiddel. Per rit een boeking: kilometervergoeding (kosten)
 * tegen privé gestort — je betaalt de auto privé, de zaak "vergoedt" je per km. Brandstof, parkeren,
 * verzekering en onderhoud zitten in dat bedrag en zijn dan niet los aftrekbaar.
 */
export class MileageService {
  constructor(
    private readonly db: Db,
    private readonly ledger: Ledger,
  ) {}

  add(input: { date: IsoDate; km: number; description: string; jobId?: number | null }): Trip {
    assertIsoDate(input.date, 'datum');
    if (!(input.km > 0) || input.km > 5000) throw new ValidationError('Vul het aantal kilometers in (meer dan 0)');
    if (!input.description.trim()) throw new ValidationError('Waar ging de rit naartoe?');
    const km = Math.round(input.km * 10) / 10;
    const rate = rulesFor(Number(input.date.slice(0, 4))).rules.kmRate;
    const amount = Math.round(km * rate);
    return tx(this.db, () => {
      const id = Number(
        this.db.prepare('INSERT INTO trips (trip_date, km, description, job_id, rate) VALUES (?, ?, ?, ?, ?)').run(input.date, km, input.description.trim(), input.jobId ?? null, rate).lastInsertRowid,
      );
      const entryId = this.ledger.post({
        date: input.date,
        description: `Zakelijke rit ${km} km: ${input.description.trim()}`,
        source: 'handmatig',
        sourceRef: `km:${id}`,
        lines: [
          { account: ACCOUNTS.kilometervergoeding, debit: amount },
          { account: ACCOUNTS.priveStortingen, credit: amount },
        ],
      });
      this.db.prepare('UPDATE trips SET journal_entry_id = ? WHERE id = ?').run(entryId, id);
      return this.get(id);
    });
  }

  get(id: number): Trip {
    const t = this.db.prepare('SELECT id, trip_date, km, description, job_id, rate, CAST(ROUND(km * rate) AS INTEGER) AS amount FROM trips WHERE id = ? AND deleted = 0').get(id) as Trip | undefined;
    if (!t) throw new ValidationError('Deze rit bestaat niet');
    return t;
  }

  list(year: number): Trip[] {
    return this.db
      .prepare(`SELECT id, trip_date, km, description, job_id, rate, CAST(ROUND(km * rate) AS INTEGER) AS amount FROM trips WHERE deleted = 0 AND substr(trip_date, 1, 4) = ? ORDER BY trip_date DESC, id DESC`)
      .all(String(year)) as Trip[];
  }

  /** Rit weghalen: tegenboeking op de datum van de rit, zodat het jaartotaal klopt. */
  remove(id: number): void {
    const t = this.db.prepare('SELECT * FROM trips WHERE id = ? AND deleted = 0').get(id) as { journal_entry_id: number | null; trip_date: IsoDate } | undefined;
    if (!t) throw new ValidationError('Deze rit bestaat niet');
    tx(this.db, () => {
      if (t.journal_entry_id) this.ledger.reverse(t.journal_entry_id, t.trip_date, 'Rit verwijderd');
      this.db.prepare('UPDATE trips SET deleted = 1 WHERE id = ?').run(id);
    });
  }

  totals(year: number): { km: number; amount: Cents; trips: number } {
    const r = this.db
      .prepare(`SELECT COALESCE(SUM(km), 0) AS km, COALESCE(SUM(CAST(ROUND(km * rate) AS INTEGER)), 0) AS amount, COUNT(*) AS n FROM trips WHERE deleted = 0 AND substr(trip_date, 1, 4) = ?`)
      .get(String(year)) as { km: number; amount: number; n: number };
    return { km: Math.round(r.km * 10) / 10, amount: r.amount, trips: r.n };
  }
}

const WORK_UNIT = `lower(trim(COALESCE(unit, ''))) IN ('uur', 'uren', 'u', 'hr', 'h')`;

/** Uren voor het urencriterium: uren op werkbonnen van klussen + wat je apart invult. */
export class HoursService {
  constructor(private readonly db: Db) {}

  private validate(input: HoursInput): Span[] {
    assertIsoDate(input.date, 'datum');
    const spans = spansFor(input);
    if (!(input.hours > 0)) throw new ValidationError('Vul een aantal uren in');
    const max = Math.max(...spans.map(days)) * 24;
    if (input.hours > max) {
      const unit = (input.period ?? 'dag') === 'dag' ? 'per dag' : (input.period ?? 'dag') === 'week' ? 'in een week' : 'in een maand';
      throw new ValidationError(`Dat zijn meer uren dan er ${unit} bestaan (maximaal ${max})`);
    }
    return spans;
  }

  /**
   * Voegt uren toe voor een dag, week of maand (eventueel herhaald). Een periode over de jaargrens
   * wordt twee regels, met de uren naar verhouding verdeeld, zodat de jaartotalen kloppen.
   */
  add(input: HoursInput): TimeEntry[] {
    const spans = this.validate(input);
    if (!input.description.trim()) throw new ValidationError('Wat heb je gedaan?');
    const insert = this.db.prepare('INSERT INTO time_entries (entry_date, period_end, hours, description) VALUES (?, ?, ?, ?)');
    const ids: number[] = [];
    tx(this.db, () => {
      for (const span of spans) {
        const parts: Span[] =
          span.start.slice(0, 4) === span.end.slice(0, 4) ? [span] : [{ start: span.start, end: `${span.start.slice(0, 4)}-12-31` }, { start: `${span.end.slice(0, 4)}-01-01`, end: span.end }];
        let left = input.hours;
        parts.forEach((part, i) => {
          const h = i === parts.length - 1 ? round2(left) : round2((input.hours * days(part)) / days(span));
          left -= h;
          ids.push(Number(insert.run(part.start, part.end === part.start ? null : part.end, h, input.description.trim()).lastInsertRowid));
        });
      }
    });
    return ids.map((id) => this.db.prepare('SELECT * FROM time_entries WHERE id = ?').get(id) as TimeEntry);
  }

  /** Waarschuwingen vóór het toevoegen: staat er al iets in die periode, en is het aantal uren haalbaar? Nooit een blokkade. */
  check(input: HoursInput): { regels: number; warnings: string[] } {
    const spans = this.validate(input);
    const fmt = (n: number) => (Math.round(n * 10) / 10).toLocaleString('nl-NL');
    // Een bestaande regel telt één keer, ook als hij in meer herhaalde periodes valt.
    const seen = new Map<string, { hours: number; workOrder: boolean }>();
    let tooMany = false;
    for (const span of spans) {
      const entries = this.db
        .prepare(`SELECT id, hours FROM time_entries WHERE entry_date <= ? AND COALESCE(period_end, entry_date) >= ?`)
        .all(span.end, span.start) as { id: number; hours: number }[];
      const items = this.db
        .prepare(`SELECT id, quantity AS hours FROM job_work_items WHERE work_date BETWEEN ? AND ? AND ${WORK_UNIT}`)
        .all(span.start, span.end) as { id: number; hours: number }[];
      for (const r of entries) seen.set(`e${r.id}`, { hours: r.hours, workOrder: false });
      for (const r of items) seen.set(`w${r.id}`, { hours: r.hours, workOrder: true });
      const inSpan = [...entries, ...items].reduce((sum, r) => sum + r.hours, 0);
      if (inSpan + input.hours > 16 * days(span)) tooMany = true;
    }
    const existing = [...seen.values()].reduce((sum, r) => sum + r.hours, 0);
    const onWorkOrders = [...seen.values()].filter((r) => r.workOrder).reduce((sum, r) => sum + r.hours, 0);
    const warnings: string[] = [];
    if (existing > 0) {
      warnings.push(`In ${spans.length > 1 ? 'deze periodes' : 'deze periode'} staat al ${fmt(existing)} uur${onWorkOrders > 0 ? ` (waarvan ${fmt(onWorkOrders)} op werkbonnen)` : ''}. Tel je niets dubbel?`);
    }
    if (tooMany) warnings.push('Samen is dat gemiddeld meer dan 16 uur per dag. Klopt dat?');
    return { regels: spans.length, warnings };
  }

  remove(id: number): void {
    this.db.prepare('DELETE FROM time_entries WHERE id = ?').run(id);
  }

  list(year: number): TimeEntry[] {
    return this.db.prepare('SELECT * FROM time_entries WHERE substr(entry_date, 1, 4) = ? ORDER BY entry_date DESC, id DESC').all(String(year)) as TimeEntry[];
  }

  totals(year: number): { workOrders: number; other: number; total: number } {
    const y = String(year);
    // werkbonregels in uren ("uur", "uren", "u")
    const w = this.db
      .prepare(`SELECT COALESCE(SUM(quantity), 0) AS h FROM job_work_items WHERE substr(work_date, 1, 4) = ? AND ${WORK_UNIT}`)
      .get(y) as { h: number };
    const o = this.db.prepare('SELECT COALESCE(SUM(hours), 0) AS h FROM time_entries WHERE substr(entry_date, 1, 4) = ?').get(y) as { h: number };
    const round1 = (n: number) => Math.round(n * 10) / 10;
    return { workOrders: round1(w.h), other: round1(o.h), total: round1(w.h + o.h) };
  }

  /**
   * Hoeveel uur je nog nodig hebt voor het urencriterium, wat dat per week is tot 31 december en
   * wanneer je het haalt bij het tempo sinds je eerste uren dit jaar. Alleen voor het lopende jaar.
   */
  forecast(year: number, asOf: IsoDate, target: number): HoursForecast | null {
    if (year !== Number(asOf.slice(0, 4))) return null;
    const y = String(year);
    const total = this.totals(year).total;
    const first = this.db
      .prepare(`SELECT MIN(d) AS d FROM (SELECT MIN(entry_date) AS d FROM time_entries WHERE substr(entry_date, 1, 4) = ? UNION ALL SELECT MIN(work_date) FROM job_work_items WHERE substr(work_date, 1, 4) = ? AND ${WORK_UNIT})`)
      .get(y, y) as { d: IsoDate | null };
    // Alleen wat tot en met vandaag gewerkt is telt als gedaan; een periode die doorloopt wordt naar verhouding geteld.
    const rows = this.db.prepare('SELECT entry_date, period_end, hours FROM time_entries WHERE substr(entry_date, 1, 4) = ? AND entry_date <= ?').all(y, asOf) as { entry_date: IsoDate; period_end: IsoDate | null; hours: number }[];
    const fromEntries = rows.reduce((sum, r) => {
      const end = r.period_end ?? r.entry_date;
      if (end <= asOf) return sum + r.hours;
      return sum + (r.hours * (diffDays(r.entry_date, asOf) + 1)) / (diffDays(r.entry_date, end) + 1);
    }, 0);
    const fromWorkOrders = (this.db.prepare(`SELECT COALESCE(SUM(quantity), 0) AS h FROM job_work_items WHERE substr(work_date, 1, 4) = ? AND work_date <= ? AND ${WORK_UNIT}`).get(y, asOf) as { h: number }).h;
    const done = Math.round((fromEntries + fromWorkOrders) * 10) / 10;
    const remaining = Math.max(0, Math.round((target - done) * 10) / 10);
    const weeksLeft = (diffDays(asOf, `${year}-12-31`) + 1) / 7;
    const perDay = first.d && first.d <= asOf ? done / (diffDays(first.d, asOf) + 1) : 0;
    let reachDate: IsoDate | null = null;
    if (remaining > 0 && perDay > 0) {
      const d = addDays(asOf, Math.ceil(remaining / perDay));
      if (d.slice(0, 4) === y) reachDate = d;
    }
    return {
      target,
      total: done,
      planned: Math.max(0, Math.round((total - done) * 10) / 10),
      remaining,
      perWeekNeeded: remaining > 0 && weeksLeft > 0 ? Math.ceil((remaining / weeksLeft) * 10) / 10 : 0,
      perWeekNow: Math.round(perDay * 7 * 10) / 10,
      reachDate,
    };
  }
}
