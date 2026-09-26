import type { Db } from '../db/database';
import { parseEuro, type Cents } from '../shared/money';
import { addMonths, diffDays, today, type IsoDate } from '../shared/dates';

/**
 * Eén zoekbalk (#26) over documenten, factuur- en inkoopregels, relaties, betalingen, klussen en
 * offertes. SQLite FTS5 in hetzelfde databasebestand: er gaat niets naar buiten.
 */
export type SearchKind = 'document' | 'factuur' | 'offerte' | 'relatie' | 'bank' | 'klus' | 'inkoop';

export interface SearchHit {
  kind: SearchKind;
  id: number;
  title: string;
  /** tekst rond de gevonden woorden; [[ en ]] markeren de treffer */
  snippet: string;
  date: IsoDate | null;
  amount: Cents | null;
}

export interface SearchGroup {
  key: string;
  title: string;
  date: IsoDate | null;
  amount: Cents | null;
  hits: SearchHit[];
  /** verbonden onderdelen van dezelfde gebeurtenis (document ↔ inkoop ↔ betaling ↔ boeking ↔ klus) */
  links: { kind: SearchKind | 'boeking'; id: number; label: string }[];
  /** garantie bij gereedschap/investeringen, bv. "nog 14 maanden garantie" */
  warranty?: string | null;
}

export interface SearchFilters {
  from?: IsoDate;
  to?: IsoDate;
  minAmount?: Cents;
  maxAmount?: Cents;
  jobId?: number;
}

/** Losse woorden → FTS-query (alle woorden, als voorvoegsel); bedragfilters als "> 400" of "<50". */
export function parseQuery(input: string): { match: string | null; filters: SearchFilters } {
  const filters: SearchFilters = {};
  let rest = input;
  rest = rest.replace(/(>=?|<=?)\s*€?\s*(\d+(?:[.,]\d{1,2})?)/g, (_m, op: string, v: string) => {
    const cents = parseEuro(v.includes(',') || v.includes('.') ? v : `${v},00`);
    if (op.startsWith('>')) filters.minAmount = cents;
    else filters.maxAmount = cents;
    return ' ';
  });
  // periode: "2026" of "2026-09" (niet in een factuurnummer als "2026-0007")
  rest = rest.replace(/\b(20\d{2})(?:-(0[1-9]|1[0-2]))?\b(?![-\d])/g, (_m, y: string, m?: string) => {
    filters.from = m ? `${y}-${m}-01` : `${y}-01-01`;
    filters.to = m ? new Date(Date.UTC(Number(y), Number(m), 0)).toISOString().slice(0, 10) : `${y}-12-31`;
    return ' ';
  });
  const words = rest
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2);
  return { match: words.length ? words.map((w) => `"${w.replace(/"/g, '')}"*`).join(' AND ') : null, filters };
}

export class SearchService {
  constructor(private readonly db: Db) {}

  /** Index opnieuw opbouwen (bv. na een herstel of voor bestaande administraties). */
  rebuild(): void {
    this.db.exec(`DELETE FROM search_index;`);
    // de triggers vullen de index bij elke wijziging; opnieuw vullen = elke bronrij "aanraken"
    for (const table of ['documents', 'invoices', 'quotes', 'relations', 'bank_transactions', 'jobs', 'purchase_invoices']) {
      this.db.exec(`UPDATE ${table} SET id = id;`);
    }
  }

  search(query: string, extra: SearchFilters = {}, limit = 50): SearchGroup[] {
    const { match, filters } = parseQuery(query);
    const f = { ...filters, ...extra };
    if (!match && f.minAmount === undefined && f.maxAmount === undefined && !f.from && !f.jobId) return [];
    const where: string[] = [];
    const params: unknown[] = [];
    if (match) {
      where.push('search_index MATCH ?');
      params.push(match);
    }
    if (f.from) (where.push('date >= ?'), params.push(f.from));
    if (f.to) (where.push('date <= ?'), params.push(f.to));
    if (f.minAmount !== undefined) (where.push('ABS(amount) >= ?'), params.push(f.minAmount));
    if (f.maxAmount !== undefined) (where.push('ABS(amount) <= ?'), params.push(f.maxAmount));
    const rows = this.db
      .prepare(
        `SELECT kind, ref_id AS id, title, ${match ? "snippet(search_index, 3, '[[', ']]', '…', 12)" : "substr(body, 1, 120)"} AS snippet, date, amount
         FROM search_index ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY ${match ? 'rank' : 'date DESC'} LIMIT ?`,
      )
      .all(...params, limit * 3) as SearchHit[];
    const groups = new Map<string, SearchGroup>();
    for (const hit of rows) {
      const { key, links, jobId } = this.linksFor(hit);
      if (f.jobId && jobId !== f.jobId) continue;
      const g = groups.get(key) ?? { key, title: hit.title, date: hit.date, amount: hit.amount, hits: [], links, warranty: this.warrantyFor(key) };
      g.hits.push(hit);
      for (const l of links) if (!g.links.some((x) => x.kind === l.kind && x.id === l.id)) g.links.push(l);
      groups.set(key, g);
      if (groups.size >= limit) break;
    }
    return [...groups.values()];
  }

  /** Bij welke gebeurtenis hoort een treffer, en wat hangt eraan vast? */
  private linksFor(hit: SearchHit): { key: string; links: SearchGroup['links']; jobId: number | null } {
    const one = <T>(sql: string, ...p: unknown[]) => this.db.prepare(sql).get(...p) as T | undefined;
    const links: SearchGroup['links'] = [];
    const purchaseLinks = (pid: number) => {
      const p = one<{ id: number; document_id: number | null; journal_entry_id: number | null; job_id: number | null; description: string }>('SELECT id, document_id, journal_entry_id, job_id, description FROM purchase_invoices WHERE id = ?', pid);
      if (!p) return null;
      links.push({ kind: 'inkoop', id: p.id, label: p.description });
      if (p.document_id) links.push({ kind: 'document', id: p.document_id, label: 'bon/factuur' });
      if (p.journal_entry_id) links.push({ kind: 'boeking', id: p.journal_entry_id, label: `boeking #${p.journal_entry_id}` });
      for (const b of this.db.prepare('SELECT id, transaction_date FROM bank_transactions WHERE matched_purchase_invoice_id = ?').all(pid) as { id: number; transaction_date: string }[]) {
        links.push({ kind: 'bank', id: b.id, label: `betaling ${b.transaction_date}` });
      }
      if (p.job_id) links.push({ kind: 'klus', id: p.job_id, label: 'klus' });
      return p.job_id;
    };
    const invoiceLinks = (iid: number) => {
      const i = one<{ id: number; number: string | null; journal_entry_id: number | null; job_id: number | null }>('SELECT id, number, journal_entry_id, job_id FROM invoices WHERE id = ?', iid);
      if (!i) return null;
      links.push({ kind: 'factuur', id: i.id, label: `factuur ${i.number ?? 'concept'}` });
      if (i.journal_entry_id) links.push({ kind: 'boeking', id: i.journal_entry_id, label: `boeking #${i.journal_entry_id}` });
      for (const b of this.db.prepare('SELECT id, transaction_date FROM bank_transactions WHERE matched_invoice_id = ?').all(iid) as { id: number; transaction_date: string }[]) {
        links.push({ kind: 'bank', id: b.id, label: `betaling ${b.transaction_date}` });
      }
      if (i.job_id) links.push({ kind: 'klus', id: i.job_id, label: 'klus' });
      return i.job_id;
    };
    switch (hit.kind) {
      case 'inkoop':
        return { key: `inkoop:${hit.id}`, jobId: purchaseLinks(hit.id), links };
      case 'document': {
        const d = one<{ purchase_invoice_id: number | null }>('SELECT purchase_invoice_id FROM documents WHERE id = ?', hit.id);
        if (d?.purchase_invoice_id) return { key: `inkoop:${d.purchase_invoice_id}`, jobId: purchaseLinks(d.purchase_invoice_id), links };
        links.push({ kind: 'document', id: hit.id, label: 'bon/factuur' });
        return { key: `document:${hit.id}`, jobId: null, links };
      }
      case 'bank': {
        const b = one<{ matched_invoice_id: number | null; matched_purchase_invoice_id: number | null; matched_journal_entry_id: number | null }>('SELECT matched_invoice_id, matched_purchase_invoice_id, matched_journal_entry_id FROM bank_transactions WHERE id = ?', hit.id);
        if (b?.matched_purchase_invoice_id) return { key: `inkoop:${b.matched_purchase_invoice_id}`, jobId: purchaseLinks(b.matched_purchase_invoice_id), links };
        if (b?.matched_invoice_id) return { key: `factuur:${b.matched_invoice_id}`, jobId: invoiceLinks(b.matched_invoice_id), links };
        links.push({ kind: 'bank', id: hit.id, label: 'betaling' });
        if (b?.matched_journal_entry_id) links.push({ kind: 'boeking', id: b.matched_journal_entry_id, label: `boeking #${b.matched_journal_entry_id}` });
        const ev = b?.matched_journal_entry_id ? one<{ job_id: number | null }>('SELECT ev.job_id FROM journal_entries e JOIN events ev ON ev.id = e.event_id WHERE e.id = ?', b.matched_journal_entry_id) : undefined;
        return { key: `bank:${hit.id}`, jobId: ev?.job_id ?? null, links };
      }
      case 'factuur':
        return { key: `factuur:${hit.id}`, jobId: invoiceLinks(hit.id), links };
      case 'klus':
        links.push({ kind: 'klus', id: hit.id, label: 'klus' });
        return { key: `klus:${hit.id}`, jobId: hit.id, links };
      default:
        links.push({ kind: hit.kind, id: hit.id, label: hit.kind });
        return { key: `${hit.kind}:${hit.id}`, jobId: null, links };
    }
  }

  /** "nog 14 maanden garantie" voor een inkoop met garantietermijn. */
  private warrantyFor(key: string, asOf: IsoDate = today()): string | null {
    if (!key.startsWith('inkoop:')) return null;
    const p = this.db.prepare('SELECT invoice_date, warranty_months FROM purchase_invoices WHERE id = ?').get(Number(key.slice(7))) as { invoice_date: IsoDate; warranty_months: number | null } | undefined;
    if (!p?.warranty_months) return null;
    const until = addMonths(p.invoice_date, p.warranty_months);
    const days = diffDays(asOf, until);
    if (days < 0) return `garantie verlopen (${until})`;
    const months = Math.floor(days / 30.44);
    return months >= 1 ? `nog ${months} ${months === 1 ? 'maand' : 'maanden'} garantie` : `nog ${days} dagen garantie`;
  }

  setWarranty(purchaseId: number, months: number | null): void {
    this.db.prepare('UPDATE purchase_invoices SET warranty_months = ? WHERE id = ?').run(months && months > 0 ? Math.round(months) : null, purchaseId);
  }
}
