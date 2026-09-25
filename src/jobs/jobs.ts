import type { Db } from '../db/database';
import { tx } from '../db/database';
import type { QuoteService } from '../documents/quotes';
import type { InvoiceService, Invoice } from '../documents/invoices';
import type { LineInput } from '../documents/totals';
import type { RelationsService } from '../relations/relations';
import type { IsoDate } from '../shared/dates';
import type { Cents } from '../shared/money';
import { ValidationError } from '../shared/validation';

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
}

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
      if (!lines && job.quote_id && this.quotes.get(job.quote_id).status !== 'gefactureerd') {
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
    const costs = (this.db.prepare('SELECT COALESCE(SUM(subtotal), 0) AS c FROM purchase_invoices WHERE job_id = ?').get(id) as { c: number }).c;
    return {
      ...row,
      quoted,
      invoiced: invoices.reduce((s, i) => s + i.net, 0),
      costs,
      invoices: invoices.map(({ net: _net, ...rest }) => rest),
    };
  }

  list(filter: { status?: JobStatus; active?: boolean } = {}): Job[] {
    const where = filter.status ? 'WHERE status = ?' : filter.active ? `WHERE status IN ('gepland','bezig','klaar')` : '';
    const rows = this.db.prepare(`SELECT id FROM jobs ${where} ORDER BY CASE status WHEN 'klaar' THEN 0 WHEN 'bezig' THEN 1 WHEN 'gepland' THEN 2 ELSE 3 END, id DESC`).all(...(filter.status ? [filter.status] : [])) as { id: number }[];
    return rows.map((r) => this.get(r.id));
  }
}
