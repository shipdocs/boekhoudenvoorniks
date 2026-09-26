import { tx, type Db } from '../db/database';
import { ACCOUNTS } from '../core-ledger/accounts';
import type { Ledger } from '../core-ledger/ledger';
import { assertIsoDate, type IsoDate } from '../shared/dates';
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
  entry_date: IsoDate;
  hours: number;
  description: string;
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

/** Uren voor het urencriterium: uren op werkbonnen van klussen + wat je apart invult. */
export class HoursService {
  constructor(private readonly db: Db) {}

  add(input: { date: IsoDate; hours: number; description: string }): TimeEntry {
    assertIsoDate(input.date, 'datum');
    if (!(input.hours > 0) || input.hours > 24) throw new ValidationError('Vul een aantal uren in (tussen 0 en 24)');
    if (!input.description.trim()) throw new ValidationError('Wat heb je gedaan?');
    const id = Number(this.db.prepare('INSERT INTO time_entries (entry_date, hours, description) VALUES (?, ?, ?)').run(input.date, input.hours, input.description.trim()).lastInsertRowid);
    return this.db.prepare('SELECT * FROM time_entries WHERE id = ?').get(id) as TimeEntry;
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
      .prepare(`SELECT COALESCE(SUM(quantity), 0) AS h FROM job_work_items WHERE substr(work_date, 1, 4) = ? AND lower(trim(COALESCE(unit, ''))) IN ('uur', 'uren', 'u', 'hr', 'h')`)
      .get(y) as { h: number };
    const o = this.db.prepare('SELECT COALESCE(SUM(hours), 0) AS h FROM time_entries WHERE substr(entry_date, 1, 4) = ?').get(y) as { h: number };
    const round1 = (n: number) => Math.round(n * 10) / 10;
    return { workOrders: round1(w.h), other: round1(o.h), total: round1(w.h + o.h) };
  }
}
