import type { Db } from '../db/database';
import { tx } from '../db/database';
import type { QuoteService } from '../documents/quotes';
import type { InvoiceService, Invoice } from '../documents/invoices';
import type { LineInput } from '../documents/totals';
import type { RelationsService } from '../relations/relations';
import type { IsoDate } from '../shared/dates';
import type { Cents } from '../shared/money';
import { ValidationError } from '../shared/validation';
import { supplierKey as supplierKeyOf } from '../intake/supplier-memory';
import { distanceMeters } from '../intake/exif';

export type JobStatus = 'gepland' | 'bezig' | 'klaar' | 'gefactureerd' | 'geannuleerd';

export interface Job {
  id: number;
  relation_id: number;
  relation_name: string;
  quote_id: number | null;
  quote_number: string | null;
  title: string;
  address: string | null;
  status: JobStatus;
  start_date: IsoDate | null;
  end_date: IsoDate | null;
  notes: string | null;
  created_at: string;
  /** geoffreerd bedrag excl. BTW */
  quoted: Cents;
  /** gefactureerd excl. BTW */
  invoiced: Cents;
  /** materiaal/kosten gekoppeld aan deze klus, excl. BTW */
  costs: Cents;
  invoices: { id: number; number: string | null; status: string; total: Cents }[];
  lat: number | null;
  lon: number | null;
}

/** Resultaat van een klus in gewone taal (#32). Kosten komen uit de boekingen die aan de klus hangen. */
export interface JobResult {
  jobId: number;
  title: string;
  relationName: string;
  status: JobStatus;
  invoiced: Cents;
  costs: { label: string; amount: Cents }[];
  totalCosts: Cents;
  margin: Cents;
  /** marge in procenten van het gefactureerde, of null als er nog niets gefactureerd is */
  marginPct: number | null;
}

export interface WorkItem {
  id: number;
  job_id: number;
  work_date: IsoDate;
  description: string;
  quantity: number;
  unit: string | null;
  unit_price: Cents;
  vat_code: string;
  invoice_id: number | null;
}

export interface JobSuggestion {
  job: Pick<Job, 'id' | 'title' | 'relation_name' | 'status'>;
  score: number;
  reason: string;
}

const COST_LABEL = (rgs: string) => (rgs === 'WKprInkMat' ? 'Materiaal' : rgs === 'WKprKuwKuw' ? 'Uitbesteed werk' : 'Overige kosten');
/** Binnen deze afstand van de kluslocatie telt een foto als "op de klus". */
export const NEAR_JOB_METERS = 300;

/**
 * Klussen: de brug tussen offerte en factuur, zoals een vakman denkt.
 * Offerte geaccepteerd → klus; werk klaar → factuur (opgebouwd uit de offerte).
 */
export class JobService {
  constructor(
    private readonly db: Db,
    private readonly quotes: QuoteService,
    private readonly invoices: InvoiceService,
    private readonly relations: RelationsService,
  ) {}

  create(input: { relationId: number; title: string; address?: string | null; startDate?: IsoDate | null; notes?: string | null; quoteId?: number | null }): Job {
    this.relations.get(input.relationId);
    if (!input.title?.trim()) throw new ValidationError('Geef de klus een naam');
    const id = Number(
      this.db
        .prepare('INSERT INTO jobs (relation_id, quote_id, title, address, start_date, notes) VALUES (?, ?, ?, ?, ?, ?)')
        .run(input.relationId, input.quoteId ?? null, input.title.trim(), input.address ?? null, input.startDate ?? null, input.notes ?? null).lastInsertRowid,
    );
    return this.get(id);
  }

  /** Klant akkoord: offerte → klus. */
  acceptQuote(quoteId: number): Job {
    return tx(this.db, () => {
      const q = this.quotes.setStatus(quoteId, 'geaccepteerd');
      const existing = this.db.prepare('SELECT id FROM jobs WHERE quote_id = ?').get(quoteId) as { id: number } | undefined;
      if (existing) return this.get(existing.id);
      const relation = this.relations.get(q.relation_id);
      const title = q.reference || q.lines[0]?.description || `Klus ${relation.name}`;
      return this.create({ relationId: q.relation_id, quoteId, title, address: [relation.address, relation.city].filter(Boolean).join(', ') || null });
    });
  }

  update(id: number, patch: Partial<{ title: string; address: string | null; startDate: IsoDate | null; endDate: IsoDate | null; notes: string | null }>): Job {
    const j = this.get(id);
    this.db
      .prepare('UPDATE jobs SET title = ?, address = ?, start_date = ?, end_date = ?, notes = ? WHERE id = ?')
      .run(patch.title?.trim() || j.title, patch.address !== undefined ? patch.address : j.address, patch.startDate !== undefined ? patch.startDate : j.start_date, patch.endDate !== undefined ? patch.endDate : j.end_date, patch.notes !== undefined ? patch.notes : j.notes, id);
    return this.get(id);
  }

  setStatus(id: number, status: JobStatus): Job {
    if (!['gepland', 'bezig', 'klaar', 'gefactureerd', 'geannuleerd'].includes(status)) throw new ValidationError('Onbekende status');
    this.db.prepare('UPDATE jobs SET status = ?, end_date = CASE WHEN ? = \'klaar\' AND end_date IS NULL THEN date(\'now\') ELSE end_date END WHERE id = ?').run(status, status, id);
    return this.get(id);
  }

  /** "Werk afgerond → Factuur maken": conceptfactuur uit de offerte (of uit opgegeven regels). */
  makeInvoice(id: number, lines?: LineInput[]): Invoice {
    return tx(this.db, () => {
      const job = this.get(id);
      let invoice: Invoice;
      const open = this.workItems(id).filter((w) => !w.invoice_id);
      if (!lines && open.length > 0) {
        // werkbon → factuurregels
        invoice = this.invoices.createDraft({
          relationId: job.relation_id,
          reference: job.title,
          lines: open.map((w) => ({ description: `${w.description}${w.work_date ? ` (${w.work_date})` : ''}`, quantity: w.quantity, unit: w.unit, unitPrice: w.unit_price, vatCode: w.vat_code as LineInput['vatCode'] })),
        });
        const mark = this.db.prepare('UPDATE job_work_items SET invoice_id = ? WHERE id = ?');
        for (const w of open) mark.run(invoice.id, w.id);
      } else if (!lines && job.quote_id && this.quotes.get(job.quote_id).status !== 'gefactureerd') {
        invoice = this.quotes.convertToInvoice(job.quote_id);
        if (!invoice.reference) this.invoices.updateDraft(invoice.id, { reference: job.title });
      } else {
        if (!lines || lines.length === 0) throw new ValidationError('Voeg regels toe voor de factuur');
        invoice = this.invoices.createDraft({ relationId: job.relation_id, reference: job.title, lines });
      }
      this.db.prepare('UPDATE invoices SET job_id = ? WHERE id = ?').run(id, invoice.id);
      this.db.prepare(`UPDATE jobs SET status = 'gefactureerd', end_date = COALESCE(end_date, date('now')) WHERE id = ?`).run(id);
      return this.invoices.get(invoice.id);
    });
  }

  get(id: number): Job {
    const row = this.db
      .prepare(`SELECT j.*, r.name AS relation_name, q.number AS quote_number FROM jobs j JOIN relations r ON r.id = j.relation_id LEFT JOIN quotes q ON q.id = j.quote_id WHERE j.id = ?`)
      .get(id) as Omit<Job, 'quoted' | 'invoiced' | 'costs' | 'invoices'> | undefined;
    if (!row) throw new ValidationError(`Klus ${id} bestaat niet`);
    const quoted = row.quote_id ? this.quotes.get(row.quote_id).totals.subtotal : 0;
    const invoices = (this.db.prepare('SELECT id FROM invoices WHERE job_id = ? ORDER BY id').all(id) as { id: number }[]).map(({ id: invId }) => {
      const inv = this.invoices.get(invId);
      return { id: inv.id, number: inv.number, status: inv.display_status, total: inv.total ?? inv.totals.total, net: inv.subtotal ?? inv.totals.subtotal };
    });
    const costs = this.costLines(id).reduce((sum, c) => sum + c.amount, 0);
    return {
      ...row,
      quoted,
      invoiced: invoices.reduce((s, i) => s + i.net, 0),
      costs,
      invoices: invoices.map(({ net: _net, ...rest }) => rest),
    };
  }

  /** Kosten per soort uit de journaalregels van alle gebeurtenissen die aan de klus hangen. */
  private costLines(id: number): { label: string; amount: Cents }[] {
    const rows = this.db
      .prepare(
        `SELECT a.rgs_code, SUM(l.debit) - SUM(l.credit) AS net
         FROM journal_lines l
         JOIN journal_entries e ON e.id = l.journal_entry_id
         JOIN events ev ON ev.id = e.event_id
         JOIN chart_of_accounts a ON a.id = l.account_id
         WHERE ev.job_id = ? AND a.category = 'kosten'
         GROUP BY a.rgs_code`,
      )
      .all(id) as { rgs_code: string; net: number }[];
    const byLabel = new Map<string, number>();
    for (const r of rows) byLabel.set(COST_LABEL(r.rgs_code), (byLabel.get(COST_LABEL(r.rgs_code)) ?? 0) + r.net);
    return ['Materiaal', 'Uitbesteed werk', 'Overige kosten'].filter((l) => byLabel.get(l)).map((label) => ({ label, amount: byLabel.get(label)! }));
  }

  result(id: number): JobResult {
    const j = this.get(id);
    const costs = this.costLines(id);
    const totalCosts = costs.reduce((s, c) => s + c.amount, 0);
    const margin = j.invoiced - totalCosts;
    return {
      jobId: id,
      title: j.title,
      relationName: j.relation_name,
      status: j.status,
      invoiced: j.invoiced,
      costs,
      totalCosts,
      margin,
      marginPct: j.invoiced > 0 ? Math.round((margin / j.invoiced) * 1000) / 10 : null,
    };
  }

  /** "Wat verdien ik per klus?" */
  results(filter: { relationId?: number } = {}): JobResult[] {
    const rows = this.db
      .prepare(`SELECT id FROM jobs WHERE status <> 'geannuleerd' ${filter.relationId ? 'AND relation_id = ?' : ''} ORDER BY COALESCE(end_date, start_date, created_at) DESC`)
      .all(...(filter.relationId ? [filter.relationId] : [])) as { id: number }[];
    return rows.map((r) => this.result(r.id));
  }

  /** Een inkoop aan een klus koppelen (of loskoppelen met null). Geldt ook voor de boeking erachter. */
  linkPurchase(purchaseId: number, jobId: number | null): void {
    if (jobId) this.get(jobId);
    tx(this.db, () => {
      this.db.prepare('UPDATE purchase_invoices SET job_id = ? WHERE id = ?').run(jobId, purchaseId);
      this.db
        .prepare(`UPDATE events SET job_id = ? WHERE id IN (SELECT e.event_id FROM journal_entries e JOIN purchase_invoices p ON p.journal_entry_id = e.id WHERE p.id = ?)`)
        .run(jobId, purchaseId);
      this.learnLocation(jobId, this.db.prepare('SELECT document_id FROM purchase_invoices WHERE id = ?').get(purchaseId) as { document_id: number | null } | undefined);
    });
  }

  /** Een direct geboekte betaling (bv. materiaal zonder bon) aan een klus koppelen. */
  linkBankTransaction(txId: number, jobId: number | null): void {
    if (jobId) this.get(jobId);
    const t = this.db.prepare('SELECT matched_journal_entry_id FROM bank_transactions WHERE id = ?').get(txId) as { matched_journal_entry_id: number | null } | undefined;
    if (!t?.matched_journal_entry_id) throw new ValidationError('Deze betaling is nog niet verwerkt');
    this.db.prepare('UPDATE events SET job_id = ? WHERE id = (SELECT event_id FROM journal_entries WHERE id = ?)').run(jobId, t.matched_journal_entry_id);
  }

  /** Eerste foto met locatie bij een klus zonder locatie: die plek wordt de kluslocatie (alleen na opt-in). */
  private learnLocation(jobId: number | null, doc: { document_id: number | null } | undefined): void {
    if (!jobId || !doc?.document_id) return;
    const gps = this.db.prepare('SELECT gps_lat, gps_lon FROM documents WHERE id = ?').get(doc.document_id) as { gps_lat: number | null; gps_lon: number | null } | undefined;
    if (gps?.gps_lat == null || gps.gps_lon == null) return;
    this.db.prepare('UPDATE jobs SET lat = ?, lon = ? WHERE id = ? AND lat IS NULL').run(gps.gps_lat, gps.gps_lon, jobId);
  }

  /**
   * Bij welke klus hoort deze aankoop? Kandidaten: klussen die gepland/bezig zijn of net klaar.
   * Volgorde: op de kluslocatie (alleen met opt-in), eerdere keuzes bij deze leverancier, recentheid.
   */
  suggest(input: { date: IsoDate; supplier?: string | null; gps?: { lat: number; lon: number } | null }): JobSuggestion[] {
    const candidates = this.db
      .prepare(
        `SELECT j.id, j.title, j.status, j.start_date, j.end_date, j.lat, j.lon, r.name AS relation_name FROM jobs j JOIN relations r ON r.id = j.relation_id
         WHERE j.status IN ('gepland','bezig') OR (j.status IN ('klaar','gefactureerd') AND COALESCE(j.end_date, j.start_date, date(j.created_at)) >= date(?, '-14 days'))`,
      )
      .all(input.date) as { id: number; title: string; status: JobStatus; start_date: string | null; end_date: string | null; lat: number | null; lon: number | null; relation_name: string }[];
    const key = input.supplier ? supplierKeyOf(input.supplier) : null;
    return candidates
      .map((c) => {
        let score = c.status === 'bezig' ? 30 : c.status === 'gepland' ? 20 : 10;
        const reasons: string[] = [];
        if (c.start_date && c.start_date <= input.date && (!c.end_date || c.end_date >= input.date)) (score += 20, reasons.push('de klus liep toen'));
        if (key) {
          const earlier = (this.db
            .prepare('SELECT COUNT(*) AS n FROM purchase_invoices p LEFT JOIN relations r ON r.id = p.relation_id WHERE p.job_id = ? AND r.name IS NOT NULL')
            .get(c.id) as { n: number }).n;
          const sameSupplier = (this.db.prepare('SELECT r.name FROM purchase_invoices p JOIN relations r ON r.id = p.relation_id WHERE p.job_id = ?').all(c.id) as { name: string }[]).filter((x) => supplierKeyOf(x.name) === key).length;
          if (sameSupplier) (score += 15, reasons.push(`je koppelde ${sameSupplier}× eerder een bon van deze winkel aan deze klus`));
          else if (earlier) score += 5;
        }
        if (input.gps && c.lat != null && c.lon != null && distanceMeters(input.gps, { lat: c.lat, lon: c.lon }) <= NEAR_JOB_METERS) (score += 60, reasons.push('de foto is op de kluslocatie gemaakt'));
        return { job: { id: c.id, title: c.title, relation_name: c.relation_name, status: c.status }, score, reason: reasons.join(', ') || 'actieve klus' };
      })
      .sort((a, b) => b.score - a.score);
  }

  addWorkItem(jobId: number, item: { date: IsoDate; description: string; quantity: number; unit?: string | null; unitPrice: Cents; vatCode: string }): WorkItem {
    this.get(jobId);
    if (!item.description.trim()) throw new ValidationError('Omschrijving is verplicht');
    if (!(item.quantity > 0)) throw new ValidationError('Aantal moet groter dan 0 zijn');
    const id = Number(
      this.db
        .prepare('INSERT INTO job_work_items (job_id, work_date, description, quantity, unit, unit_price, vat_code) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(jobId, item.date, item.description.trim(), item.quantity, item.unit ?? null, item.unitPrice, item.vatCode).lastInsertRowid,
    );
    return this.db.prepare('SELECT * FROM job_work_items WHERE id = ?').get(id) as WorkItem;
  }

  workItems(jobId: number): WorkItem[] {
    return this.db.prepare('SELECT * FROM job_work_items WHERE job_id = ? ORDER BY work_date, id').all(jobId) as WorkItem[];
  }

  removeWorkItem(id: number): void {
    const w = this.db.prepare('SELECT invoice_id FROM job_work_items WHERE id = ?').get(id) as { invoice_id: number | null } | undefined;
    if (w?.invoice_id) throw new ValidationError('Deze regel is al gefactureerd');
    this.db.prepare('DELETE FROM job_work_items WHERE id = ?').run(id);
  }

  list(filter: { status?: JobStatus; active?: boolean } = {}): Job[] {
    const where = filter.status ? 'WHERE status = ?' : filter.active ? `WHERE status IN ('gepland','bezig','klaar')` : '';
    const rows = this.db.prepare(`SELECT id FROM jobs ${where} ORDER BY CASE status WHEN 'klaar' THEN 0 WHEN 'bezig' THEN 1 WHEN 'gepland' THEN 2 ELSE 3 END, id DESC`).all(...(filter.status ? [filter.status] : [])) as { id: number }[];
    return rows.map((r) => this.get(r.id));
  }
}
