import { ValidationError } from '../shared/validation';
import type { Db } from '../db/database';
import { parseEuro, type Cents } from '../shared/money';
import { addMonths, diffDays, today, type IsoDate } from '../shared/dates';
import type { BookedInfo, BookingInfo } from './booked-info';
import { ACCOUNTS } from '../core-ledger/accounts';
import { EvidenceLinks, type LinkTarget } from '../documents/evidence-links';
import { DOCUMENT_OUTCOME_LABEL } from '../shared/document-outcome';

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
  /** hoe het ervoor staat en waar het geboekt is */
  info?: GroupInfo | null;
}

export interface GroupInfo {
  /** "Nog niet verwerkt", "Verwerkt", "Betaald", "Nog te betalen", … */
  status: string | null;
  /** hier moet de gebruiker nog iets mee */
  attention: boolean;
  /** de bankrekening, of "privé betaald" / "contant" */
  paidVia: string | null;
  counterparty: string | null;
  booking: BookingInfo | null;
  /** bon of factuur aanwezig; null = niet van toepassing */
  evidence: boolean | null;
  /** automatisch verwerkt door de app (niet door jou bevestigd) */
  automatic: boolean;
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
    // ">" en "<" zijn exclusief, ">=" en "<=" inclusief
    if (op.startsWith('>')) filters.minAmount = op === '>' ? cents + 1 : cents;
    else filters.maxAmount = op === '<' ? cents - 1 : cents;
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
  constructor(private readonly db: Db) {
    this.evidence = new EvidenceLinks(db);
  }

  /** welke bon bij welke aankoop of betaling hoort: dezelfde koppeling als de rest van de app (#179) */
  private readonly evidence: EvidenceLinks;

  private booked: BookedInfo | null = null;
  setBookedInfo(booked: BookedInfo): void {
    this.booked = booked;
  }

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
    if (!match && f.minAmount === undefined && f.maxAmount === undefined && !f.from && !f.to && !f.jobId) return [];
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
      // met een klusfilter wordt pas na de koppelingen gefilterd: dan niet vooraf afkappen
      .all(...params, f.jobId ? -1 : limit * 3) as SearchHit[];
    const groups = new Map<string, SearchGroup>();
    for (const hit of rows) {
      const { key, links, jobId } = this.linksFor(hit);
      if (f.jobId && jobId !== f.jobId) continue;
      const g = groups.get(key) ?? { key, title: hit.title, date: hit.date, amount: hit.amount, hits: [], links, warranty: this.warrantyFor(key), info: this.infoFor(key) };
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
    // de bonnen bij een aankoop of betaling: het hoofdbewijsstuk eerst, daarna de andere bestanden
    const evidenceLinks = (target: LinkTarget) => {
      for (const f of this.evidence.forTarget(target)) links.push({ kind: 'document', id: f.document_id, label: f.is_primary ? 'bon/factuur' : `ook bewaard: ${f.original_name}` });
    };
    const bankLinks = (bid: number, b: { matched_journal_entry_id: number | null } | undefined) => {
      links.push({ kind: 'bank', id: bid, label: 'betaling' });
      if (b?.matched_journal_entry_id) links.push({ kind: 'boeking', id: b.matched_journal_entry_id, label: `boeking #${b.matched_journal_entry_id}` });
      evidenceLinks({ kind: 'bank', id: bid });
      const ev = b?.matched_journal_entry_id ? one<{ job_id: number | null }>('SELECT ev.job_id FROM journal_entries e JOIN events ev ON ev.id = e.event_id WHERE e.id = ?', b.matched_journal_entry_id) : undefined;
      return ev?.job_id ?? null;
    };
    const purchaseLinks = (pid: number) => {
      const p = one<{ id: number; document_id: number | null; journal_entry_id: number | null; job_id: number | null; description: string }>('SELECT id, document_id, journal_entry_id, job_id, description FROM purchase_invoices WHERE id = ?', pid);
      if (!p) return null;
      links.push({ kind: 'inkoop', id: p.id, label: p.description });
      evidenceLinks({ kind: 'aankoop', id: p.id });
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
        const target = this.evidence.forDocument(hit.id)?.target;
        if (target?.kind === 'aankoop') return { key: `inkoop:${target.id}`, jobId: purchaseLinks(target.id), links };
        if (target?.kind === 'bank') {
          // bewijs bij een betaling die rechtstreeks geboekt is: de bon hoort bij die betaling
          const b = one<{ matched_journal_entry_id: number | null }>('SELECT matched_journal_entry_id FROM bank_transactions WHERE id = ?', target.id);
          return { key: `bank:${target.id}`, jobId: bankLinks(target.id, b), links };
        }
        links.push({ kind: 'document', id: hit.id, label: 'bon/factuur' });
        return { key: `document:${hit.id}`, jobId: null, links };
      }
      case 'bank': {
        const b = one<{ matched_invoice_id: number | null; matched_purchase_invoice_id: number | null; matched_journal_entry_id: number | null }>('SELECT matched_invoice_id, matched_purchase_invoice_id, matched_journal_entry_id FROM bank_transactions WHERE id = ?', hit.id);
        if (b?.matched_purchase_invoice_id) return { key: `inkoop:${b.matched_purchase_invoice_id}`, jobId: purchaseLinks(b.matched_purchase_invoice_id), links };
        if (b?.matched_invoice_id) return { key: `factuur:${b.matched_invoice_id}`, jobId: invoiceLinks(b.matched_invoice_id), links };
        return { key: `bank:${hit.id}`, jobId: bankLinks(hit.id, b), links };
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

  /** Status, rekening, tegenpartij en boeking van een gebeurtenis (voor het zoekscherm). */
  infoFor(key: string): GroupInfo | null {
    const [kind, idText] = key.split(':');
    const id = Number(idText);
    const one = <T>(sql: string, ...p: unknown[]) => this.db.prepare(sql).get(...p) as T | undefined;
    const bankName = (bankAccountId: number) => one<{ name: string }>('SELECT name FROM bank_accounts WHERE id = ?', bankAccountId)?.name ?? null;
    const paidFromBank = (col: 'matched_purchase_invoice_id' | 'matched_invoice_id') =>
      one<{ bank_account_id: number }>(`SELECT bank_account_id FROM bank_transactions WHERE ${col} = ? ORDER BY transaction_date DESC LIMIT 1`, id);
    switch (kind) {
      case 'bank': {
        const t = one<{ status: string; bank_account_id: number; counter_name: string | null; matched_journal_entry_id: number | null; matched_purchase_invoice_id: number | null; matched_invoice_id: number | null }>('SELECT * FROM bank_transactions WHERE id = ?', id);
        if (!t) return null;
        const evidence = this.evidence.forTarget({ kind: 'bank', id }).length > 0;
        const automatic = !!one(`SELECT 1 FROM automation_log WHERE ref_id = ? AND kind IN ('bank-auto', 'bank-match', 'bank-own') AND status = 'auto'`, id);
        return {
          status: t.status === 'nieuw' ? 'Nog niet verwerkt' : t.status === 'genegeerd' ? 'Genegeerd' : 'Verwerkt',
          attention: t.status === 'nieuw',
          paidVia: bankName(t.bank_account_id),
          counterparty: t.counter_name,
          booking: this.booked?.entry(t.matched_journal_entry_id) ?? null,
          evidence: t.status === 'gematcht' && !t.matched_invoice_id ? evidence : null,
          automatic,
        };
      }
      case 'inkoop': {
        const p = one<{ status: string; total: number; amount_paid: number; journal_entry_id: number | null; attachment_path: string | null; document_id: number | null; relation_id: number | null }>('SELECT * FROM purchase_invoices WHERE id = ?', id);
        if (!p) return null;
        const bank = paidFromBank('matched_purchase_invoice_id');
        // niet via de bank betaald: privé of contant (de betaling staat tegen Privé-stortingen of Kas)
        const elsewhere = bank ? null : one<{ rgs_code: string }>(
          `SELECT a.rgs_code FROM journal_entries e JOIN journal_lines l ON l.journal_entry_id = e.id JOIN chart_of_accounts a ON a.id = l.account_id
            WHERE e.source_ref = ? AND e.status <> 'teruggedraaid' AND e.reverses_entry_id IS NULL AND a.rgs_code IN (?, ?) LIMIT 1`, `purchase:${id}`, ACCOUNTS.priveStortingen, ACCOUNTS.kas);
        return {
          status: p.status === 'betaald' ? 'Betaald' : p.amount_paid > 0 ? 'Deels betaald' : 'Nog te betalen',
          attention: p.status !== 'betaald',
          paidVia: bank ? bankName(bank.bank_account_id) : elsewhere ? (elsewhere.rgs_code === ACCOUNTS.kas ? 'contant' : 'privé betaald') : null,
          counterparty: p.relation_id ? one<{ name: string }>('SELECT name FROM relations WHERE id = ?', p.relation_id)?.name ?? null : null,
          booking: this.booked?.entry(p.journal_entry_id) ?? null,
          evidence: !!(p.attachment_path || p.document_id) || this.evidence.forTarget({ kind: 'aankoop', id }).length > 0,
          automatic: false,
        };
      }
      case 'factuur': {
        const i = one<{ status: string; journal_entry_id: number | null; relation_id: number }>('SELECT status, journal_entry_id, relation_id FROM invoices WHERE id = ?', id);
        if (!i) return null;
        const bank = paidFromBank('matched_invoice_id');
        return {
          status: i.status === 'concept' ? 'Concept' : i.status === 'betaald' ? 'Betaald' : 'Verstuurd, nog niet betaald',
          attention: i.status !== 'betaald',
          paidVia: bank ? bankName(bank.bank_account_id) : null,
          counterparty: one<{ name: string }>('SELECT name FROM relations WHERE id = ?', i.relation_id)?.name ?? null,
          booking: this.booked?.entry(i.journal_entry_id) ?? null,
          evidence: null,
          automatic: false,
        };
      }
      case 'document': {
        const d = one<{ id: number; status: string; duplicate_of_document_id: number | null; purchase_invoice_id: number | null; issues: string }>('SELECT id, status, duplicate_of_document_id, purchase_invoice_id, issues FROM documents WHERE id = ?', id);
        if (!d) return null;
        const status = DOCUMENT_OUTCOME_LABEL[this.evidence.outcome({ ...d, issues: JSON.parse(d.issues) as { field: string }[] })];
        return { status, attention: d.status === 'controle' || d.status === 'nieuw', paidVia: null, counterparty: null, booking: null, evidence: true, automatic: false };
      }
      default:
        return null;
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
    if (months !== null && (!Number.isFinite(months) || months < 0 || months > 600)) throw new ValidationError('Vul het aantal maanden garantie in als getal (bv. 24), of laat het leeg');
    this.db.prepare('UPDATE purchase_invoices SET warranty_months = ? WHERE id = ?').run(months && months > 0 ? Math.round(months) : null, purchaseId);
  }
}
