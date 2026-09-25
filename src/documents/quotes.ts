import type { Db } from '../db/database';
import { tx } from '../db/database';
import type { SettingsService } from '../settings/settings';
import type { RelationsService } from '../relations/relations';
import type { TemplateService } from './templates';
import { renderDocumentHtml } from './templates';
import type { InvoiceService, Invoice } from './invoices';
import { computeTotals, type DocumentTotals, type LineInput } from './totals';
import { normalizeLines, readLines, toLineInputs, writeLines, type DocLine } from './lines';
import { counterKey, formatDocumentNumber } from './numbering';
import { addDays, assertIsoDate, today, type IsoDate } from '../shared/dates';
import type { Cents } from '../shared/money';
import { ValidationError } from '../shared/validation';

export type QuoteStatus = 'concept' | 'verzonden' | 'geaccepteerd' | 'afgewezen' | 'gefactureerd';

export interface QuoteRow {
  id: number;
  relation_id: number;
  number: string;
  quote_date: IsoDate;
  valid_until: IsoDate;
  status: QuoteStatus;
  template_id: number | null;
  reference: string | null;
  intro: string | null;
  notes: string | null;
  sent_at: string | null;
  created_at: string;
}

export interface Quote extends QuoteRow {
  relation_name: string;
  relation_email: string | null;
  lines: DocLine[];
  totals: DocumentTotals;
  expired: boolean;
  invoice_id: number | null;
}

export interface QuoteSummary {
  id: number;
  number: string;
  relation_name: string;
  quote_date: IsoDate;
  valid_until: IsoDate;
  status: QuoteStatus;
  total: Cents;
  expired: boolean;
}

export interface QuoteInput {
  relationId: number;
  quoteDate?: IsoDate;
  validUntil?: IsoDate;
  reference?: string | null;
  intro?: string | null;
  notes?: string | null;
  templateId?: number | null;
  lines: LineInput[];
}

export class QuoteService {
  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly relations: RelationsService,
    private readonly templates: TemplateService,
    private readonly invoices: InvoiceService,
  ) {}

  create(input: QuoteInput): Quote {
    this.relations.get(input.relationId);
    const s = this.settings.get();
    const date = input.quoteDate ?? today();
    assertIsoDate(date, 'offertedatum');
    const validUntil = input.validUntil ?? addDays(date, s.quoteValidityDays);
    assertIsoDate(validUntil, 'geldig tot');
    const lines = normalizeLines(input.lines);
    return tx(this.db, () => {
      const seq = this.settings.nextCounter(counterKey('offerte', s.quoteNumberFormat, date));
      const number = formatDocumentNumber(s.quoteNumberFormat, date, seq);
      const result = this.db
        .prepare('INSERT INTO quotes (relation_id, number, quote_date, valid_until, template_id, reference, intro, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(input.relationId, number, date, validUntil, input.templateId ?? null, input.reference ?? null, input.intro ?? null, input.notes ?? null);
      const id = Number(result.lastInsertRowid);
      writeLines(this.db, 'quote_lines', 'quote_id', id, lines);
      return this.get(id);
    });
  }

  update(id: number, input: Partial<QuoteInput>): Quote {
    const q = this.row(id);
    if (!['concept', 'verzonden'].includes(q.status)) throw new ValidationError('Deze offerte kan niet meer aangepast worden');
    const relationId = input.relationId ?? q.relation_id;
    this.relations.get(relationId);
    const date = input.quoteDate ?? q.quote_date;
    const validUntil = input.validUntil ?? q.valid_until;
    assertIsoDate(date);
    assertIsoDate(validUntil);
    const lines = input.lines ? normalizeLines(input.lines) : null;
    return tx(this.db, () => {
      this.db
        .prepare('UPDATE quotes SET relation_id = ?, quote_date = ?, valid_until = ?, template_id = ?, reference = ?, intro = ?, notes = ? WHERE id = ?')
        .run(
          relationId,
          date,
          validUntil,
          input.templateId !== undefined ? input.templateId : q.template_id,
          input.reference !== undefined ? input.reference : q.reference,
          input.intro !== undefined ? input.intro : q.intro,
          input.notes !== undefined ? input.notes : q.notes,
          id,
        );
      if (lines) writeLines(this.db, 'quote_lines', 'quote_id', id, lines);
      return this.get(id);
    });
  }

  delete(id: number): void {
    const q = this.row(id);
    if (q.status === 'gefactureerd') throw new ValidationError('Een gefactureerde offerte kan niet verwijderd worden');
    this.db.prepare('DELETE FROM quotes WHERE id = ?').run(id);
  }

  markSent(id: number): Quote {
    this.db.prepare(`UPDATE quotes SET status = CASE WHEN status = 'concept' THEN 'verzonden' ELSE status END, sent_at = datetime('now') WHERE id = ?`).run(id);
    return this.get(id);
  }

  setStatus(id: number, status: 'geaccepteerd' | 'afgewezen' | 'verzonden'): Quote {
    const q = this.row(id);
    if (q.status === 'gefactureerd') throw new ValidationError('Deze offerte is al gefactureerd');
    this.db.prepare('UPDATE quotes SET status = ? WHERE id = ?').run(status, id);
    return this.get(id);
  }

  /** Eén klik: offerte → conceptfactuur met dezelfde regels. */
  convertToInvoice(id: number): Invoice {
    return tx(this.db, () => {
      const q = this.get(id);
      if (q.status === 'gefactureerd') throw new ValidationError('Deze offerte is al omgezet naar een factuur');
      if (q.status === 'afgewezen') throw new ValidationError('Deze offerte is afgewezen');
      const invoiceTemplate = this.templates.getDefault('factuur');
      const invoice = this.invoices.createDraft({
        relationId: q.relation_id,
        quoteId: q.id,
        reference: q.reference ?? `Offerte ${q.number}`,
        intro: q.intro,
        templateId: invoiceTemplate.id,
        lines: toLineInputs(q.lines),
      });
      this.db.prepare(`UPDATE quotes SET status = 'gefactureerd' WHERE id = ?`).run(id);
      return invoice;
    });
  }

  private row(id: number): QuoteRow {
    const row = this.db.prepare('SELECT * FROM quotes WHERE id = ?').get(id) as QuoteRow | undefined;
    if (!row) throw new ValidationError(`Offerte ${id} bestaat niet`);
    return row;
  }

  get(id: number, asOf: IsoDate = today()): Quote {
    const row = this.row(id);
    const relation = this.relations.get(row.relation_id);
    const lines = readLines(this.db, 'quote_lines', 'quote_id', id);
    const invoice = this.db.prepare('SELECT id FROM invoices WHERE quote_id = ? ORDER BY id DESC LIMIT 1').get(id) as { id: number } | undefined;
    return {
      ...row,
      relation_name: relation.name,
      relation_email: relation.email,
      lines,
      totals: computeTotals(toLineInputs(lines)),
      expired: ['concept', 'verzonden'].includes(row.status) && row.valid_until < asOf,
      invoice_id: invoice?.id ?? null,
    };
  }

  list(filter: { status?: QuoteStatus; search?: string } = {}, asOf: IsoDate = today()): QuoteSummary[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status) (where.push('q.status = ?'), params.push(filter.status));
    if (filter.search) (where.push('(q.number LIKE ? OR r.name LIKE ?)'), params.push(`%${filter.search}%`, `%${filter.search}%`));
    const ids = this.db
      .prepare(`SELECT q.id FROM quotes q JOIN relations r ON r.id = q.relation_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY q.quote_date DESC, q.id DESC`)
      .all(...params) as { id: number }[];
    return ids.map(({ id }) => {
      const q = this.get(id, asOf);
      return { id, number: q.number, relation_name: q.relation_name, quote_date: q.quote_date, valid_until: q.valid_until, status: q.status, total: q.totals.total, expired: q.expired };
    });
  }

  renderHtml(id: number): string {
    const q = this.get(id);
    const template = q.template_id ? this.templates.get(q.template_id) : this.templates.getDefault('offerte');
    const s = this.settings.get();
    return renderDocumentHtml(
      { kind: 'offerte', number: q.number, date: q.quote_date, validUntil: q.valid_until, reference: q.reference, intro: q.intro, notes: q.notes, lines: q.lines },
      this.relations.get(q.relation_id),
      s.company,
      template,
      { kor: s.kor },
    );
  }
}
