import type { Db } from '../db/database';
import type { BankTransaction } from './bank';
import type { SupplierMemory } from '../intake/supplier-memory';
import { supplierKey } from '../intake/supplier-memory';
import { addDays, addMonths, diffDays, today, type IsoDate } from '../shared/dates';
import { normalizeIban, ValidationError } from '../shared/validation';
import type { Cents } from '../shared/money';

/**
 * Vaste lasten en abonnementen herkennen (#30). Deterministisch: minstens 3 afschrijvingen aan
 * dezelfde tegenpartij met een regelmatig interval en een bedrag binnen de marge. De gebruiker
 * bevestigt een reeks één keer; daarna signaleren we een ontbrekende factuur of betaling.
 */
export type Interval = 'maand' | 'kwartaal' | 'jaar';

export interface RecurringSeries {
  id: number;
  counter_key: string;
  counter_name: string;
  interval: Interval;
  /** positief bedrag per keer (mediaan), in centen */
  amount: Cents;
  amount_min: Cents;
  amount_max: Cents;
  category_key: string | null;
  vat_code: string | null;
  expects_invoice: number;
  status: 'voorgesteld' | 'actief' | 'afgewezen' | 'gestopt';
  created_at: string;
}

export interface SeriesState extends RecurringSeries {
  payments: BankTransaction[];
  lastSeen: IsoDate | null;
  nextExpected: IsoDate | null;
  /** verwachte afschrijvingen die (na de coulance) niet gebeurd zijn */
  missed: IsoDate[];
  /** verwachte afschrijvingen tussen twee betalingen in die ontbreken (laatste 12 maanden) */
  gaps: IsoDate[];
  /** per maand omgerekend */
  monthly: Cents;
  /** prijsverschil t.o.v. ongeveer een jaar eerder, in procenten (afgerond), of null */
  priceChangePct: number | null;
}

const GAP: Record<Interval, [number, number]> = { maand: [25, 36], kwartaal: [80, 100], jaar: [350, 380] };
const MONTHS: Record<Interval, number> = { maand: 1, kwartaal: 3, jaar: 12 };
/** Coulance voordat een betaling als "gemist" telt. */
export const GRACE_DAYS: Record<Interval, number> = { maand: 7, kwartaal: 14, jaar: 30 };
/** Zoveel dagen na een betaling verwachten we de factuur. */
export const INVOICE_GRACE_DAYS = 7;
/** Bedragen mogen zoveel van de mediaan afwijken om bij de reeks te horen. */
export const AMOUNT_TOLERANCE = 0.1;

export function counterKey(t: Pick<BankTransaction, 'counter_iban' | 'counter_name'>): string | null {
  if (t.counter_iban) return `iban:${normalizeIban(t.counter_iban)}`;
  const name = t.counter_name ? supplierKey(t.counter_name) : '';
  return name ? `naam:${name}` : null;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
};

/** Zoekt in een tijdgesorteerde lijst betalingen de meest recente regelmatige reeks van ≥ 3. */
export function detectRun(payments: { date: IsoDate; amount: Cents }[]): { interval: Interval; amounts: Cents[] } | null {
  if (payments.length < 3) return null;
  for (const interval of ['maand', 'kwartaal', 'jaar'] as Interval[]) {
    const [lo, hi] = GAP[interval];
    const run = [payments[payments.length - 1]!];
    for (let i = payments.length - 2; i >= 0; i--) {
      const gap = diffDays(payments[i]!.date, run[0]!.date);
      if (gap < lo) continue; // bv. een extra betaling tussendoor: overslaan
      if (gap > hi) break;
      run.unshift(payments[i]!);
    }
    if (run.length < 3) continue;
    const amounts = run.map((p) => p.amount);
    const m = median(amounts);
    if (amounts.every((a) => Math.abs(a - m) <= m * AMOUNT_TOLERANCE)) return { interval, amounts };
  }
  return null;
}

export class RecurringService {
  constructor(private readonly db: Db, private readonly memory: SupplierMemory) {}

  /** Zoekt nieuwe reeksen en stelt ze voor. Bestaande (ook afgewezen) reeksen blijven zoals ze zijn. */
  detect(): RecurringSeries[] {
    const txs = this.db
      .prepare(`SELECT * FROM bank_transactions WHERE amount < 0 AND status <> 'genegeerd' ORDER BY transaction_date, id`)
      .all() as BankTransaction[];
    const groups = new Map<string, BankTransaction[]>();
    for (const t of txs) {
      const key = counterKey(t);
      if (key) groups.set(key, [...(groups.get(key) ?? []), t]);
    }
    const known = new Set((this.db.prepare('SELECT counter_key FROM recurring_series').all() as { counter_key: string }[]).map((r) => r.counter_key));
    const insert = this.db.prepare(
      `INSERT INTO recurring_series (counter_key, counter_name, interval, amount, amount_min, amount_max, category_key, vat_code, expects_invoice)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const [key, list] of groups) {
      if (known.has(key)) continue;
      const found = detectRun(list.map((t) => ({ date: t.transaction_date, amount: -t.amount })));
      if (!found) continue;
      const name = list[list.length - 1]!.counter_name ?? key.replace(/^\w+:/, '');
      const rule = this.memory.get(name);
      const m = median(found.amounts);
      const noInvoice = rule?.vat_code === 'geen' || rule?.business === 0;
      insert.run(key, name, found.interval, m, Math.round(Math.min(...found.amounts) * (1 - AMOUNT_TOLERANCE)), Math.round(Math.max(...found.amounts) * (1 + AMOUNT_TOLERANCE)), rule?.category_key ?? null, rule?.vat_code ?? null, noInvoice ? 0 : 1);
    }
    return this.list();
  }

  list(status?: RecurringSeries['status']): RecurringSeries[] {
    return this.db.prepare(`SELECT * FROM recurring_series ${status ? 'WHERE status = ?' : ''} ORDER BY counter_name`).all(...(status ? [status] : [])) as RecurringSeries[];
  }

  get(id: number): RecurringSeries {
    const s = this.db.prepare('SELECT * FROM recurring_series WHERE id = ?').get(id) as RecurringSeries | undefined;
    if (!s) throw new ValidationError('Onbekende vaste last');
    return s;
  }

  /** De gebruiker bevestigt: dit is een vaste last. Bekende categorie → voortaan automatisch boeken. */
  confirm(id: number, opts: { expectsInvoice?: boolean } = {}): RecurringSeries {
    const s = this.get(id);
    this.db.prepare(`UPDATE recurring_series SET status = 'actief', expects_invoice = COALESCE(?, expects_invoice) WHERE id = ?`).run(opts.expectsInvoice === undefined ? null : opts.expectsInvoice ? 1 : 0, id);
    const rule = this.memory.get(s.counter_name);
    if (rule && rule.auto_approved !== -1) this.memory.setAutomatic(rule.supplier_key, true);
    return this.get(id);
  }

  setStatus(id: number, status: 'afgewezen' | 'gestopt' | 'actief'): RecurringSeries {
    this.get(id);
    this.db.prepare('UPDATE recurring_series SET status = ? WHERE id = ?').run(status, id);
    return this.get(id);
  }

  setExpectsInvoice(id: number, expects: boolean): void {
    this.db.prepare('UPDATE recurring_series SET expects_invoice = ? WHERE id = ?').run(expects ? 1 : 0, id);
  }

  /** Afschrijvingen die bij de reeks horen (zelfde tegenpartij, bedrag binnen de marge). */
  payments(s: RecurringSeries): BankTransaction[] {
    const txs = this.db
      .prepare(`SELECT * FROM bank_transactions WHERE amount < 0 AND status <> 'genegeerd' AND -amount BETWEEN ? AND ? ORDER BY transaction_date, id`)
      .all(s.amount_min, s.amount_max) as BankTransaction[];
    return txs.filter((t) => counterKey(t) === s.counter_key);
  }

  state(s: RecurringSeries, asOf: IsoDate = today()): SeriesState {
    const payments = this.payments(s);
    const lastSeen = payments.length ? payments[payments.length - 1]!.transaction_date : null;
    const step = MONTHS[s.interval];
    const nextExpected = lastSeen ? addMonths(lastSeen, step) : null;
    const missed: IsoDate[] = [];
    if (lastSeen) {
      for (let k = 1; k <= 24; k++) {
        const due = addMonths(lastSeen, step * k);
        if (addDays(due, GRACE_DAYS[s.interval]) > asOf) break;
        missed.push(due);
      }
    }
    // gaten tussen twee betalingen: een maand overgeslagen (of een afschrijving die we niet zien)
    const gaps: IsoDate[] = [];
    const since = addMonths(asOf, -12);
    for (let i = 1; i < payments.length; i++) {
      const prev = payments[i - 1]!.transaction_date;
      const next = payments[i]!.transaction_date;
      for (let k = 1; k <= 24; k++) {
        const due = addMonths(prev, step * k);
        if (addDays(due, GRACE_DAYS[s.interval]) >= next) break;
        if (due >= since) gaps.push(due);
      }
    }
    let priceChangePct: number | null = null;
    const latest = payments[payments.length - 1];
    const yearAgo = latest ? [...payments].reverse().find((p) => diffDays(p.transaction_date, latest.transaction_date) >= 330) : undefined;
    if (latest && yearAgo && yearAgo.amount !== 0) priceChangePct = Math.round(((latest.amount - yearAgo.amount) / yearAgo.amount) * 100);
    return { ...s, payments, lastSeen, nextExpected, missed, gaps, monthly: Math.round(s.amount / step), priceChangePct };
  }

  /** Betalingen van een actieve reeks die een factuur verwachten maar er (na de coulance) nog geen hebben. */
  missingInvoices(s: RecurringSeries, asOf: IsoDate = today()): BankTransaction[] {
    if (s.status !== 'actief' || !s.expects_invoice) return [];
    return this.payments(s).filter((t) => {
      const age = diffDays(t.transaction_date, asOf);
      if (age < INVOICE_GRACE_DAYS || age > 120) return false;
      if (t.matched_purchase_invoice_id) return false;
      const doc = this.db.prepare(`SELECT 1 FROM documents WHERE classification LIKE ? LIMIT 1`).get(`%banktransactie #${t.id}"%`);
      return !doc;
    });
  }
}
