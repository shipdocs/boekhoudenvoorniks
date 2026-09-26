import type { Db } from '../db/database';
import { tx } from '../db/database';
import { Ledger, signedLine, type PostLine } from '../core-ledger/ledger';
import { ACCOUNTS, SALES_ACCOUNTS } from '../core-ledger/accounts';
import { EU_COUNTRIES, countryCode, needsCustomerVatNumber } from '../shared/vat';
import type { SettingsService } from '../settings/settings';
import type { RelationsService, Relation } from '../relations/relations';
import type { TemplateService } from './templates';
import { renderDocumentHtml, type RenderableParty } from './templates';
import { computeTotals, type DocumentTotals, type LineInput } from './totals';
import { normalizeLines, readLines, toLineInputs, writeLines, type DocLine } from './lines';
import { counterKey, formatDocumentNumber } from './numbering';
import { addDays, assertIsoDate, today, type IsoDate } from '../shared/dates';
import { assertCents, type Cents } from '../shared/money';
import { ValidationError } from '../shared/validation';

export type InvoiceStatus = 'concept' | 'verzonden' | 'betaald';
export type InvoiceDisplayStatus = 'concept' | 'openstaand' | 'vervallen' | 'betaald';

import { buildInvoiceUbl } from './ubl-out';

export interface InvoiceRow {
  id: number;
  relation_id: number;
  quote_id: number | null;
  credit_of_invoice_id: number | null;
  number: string | null;
  invoice_date: IsoDate;
  due_date: IsoDate;
  status: InvoiceStatus;
  template_id: number | null;
  reference: string | null;
  intro: string | null;
  notes: string | null;
  subtotal: Cents | null;
  vat_total: Cents | null;
  total: Cents | null;
  amount_paid: Cents;
  relation_snapshot: string | null;
  company_snapshot: string | null;
  journal_entry_id: number | null;
  sent_at: string | null;
  paid_at: string | null;
  reminder_count: number;
  last_reminder_at: string | null;
  external_source: string | null;
  external_id: string | null;
  created_at: string;
}

export interface Invoice extends InvoiceRow {
  relation_name: string;
  relation_email: string | null;
  lines: DocLine[];
  totals: DocumentTotals;
  open_amount: Cents;
  display_status: InvoiceDisplayStatus;
  days_overdue: number;
}

export interface InvoiceSummary {
  id: number;
  number: string | null;
  relation_id: number;
  relation_name: string;
  invoice_date: IsoDate;
  due_date: IsoDate;
  status: InvoiceStatus;
  display_status: InvoiceDisplayStatus;
  total: Cents;
  amount_paid: Cents;
  open_amount: Cents;
  sent_at: string | null;
  credit_of_invoice_id: number | null;
}

export interface InvoiceDraftInput {
  relationId: number;
  invoiceDate?: IsoDate;
  dueDate?: IsoDate;
  reference?: string | null;
  intro?: string | null;
  notes?: string | null;
  templateId?: number | null;
  quoteId?: number | null;
  lines: LineInput[];
  externalSource?: string | null;
  externalId?: string | null;
}

export interface PaymentInput {
  amount: Cents;
  date: IsoDate;
  /** RGS-code van de geldrekening; standaard de bank */
  moneyAccount?: string;
  bankTransactionId?: number | null;
  description?: string;
}

export class InvoiceService {
  constructor(
    private readonly db: Db,
    private readonly ledger: Ledger,
    private readonly settings: SettingsService,
    private readonly relations: RelationsService,
    private readonly templates: TemplateService,
  ) {}

  createDraft(input: InvoiceDraftInput): Invoice {
    const relation = this.relations.get(input.relationId);
    const s = this.settings.get();
    const date = input.invoiceDate ?? today();
    assertIsoDate(date, 'factuurdatum');
    const due = input.dueDate ?? addDays(date, relation.payment_term_days ?? s.paymentTermDays);
    assertIsoDate(due, 'vervaldatum');
    const lines = normalizeLines(input.lines);
    return tx(this.db, () => {
      const result = this.db
        .prepare(
          `INSERT INTO invoices (relation_id, quote_id, invoice_date, due_date, template_id, reference, intro, notes, external_source, external_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(relation.id, input.quoteId ?? null, date, due, input.templateId ?? null, input.reference ?? null, input.intro ?? null, input.notes ?? null, input.externalSource ?? null, input.externalId ?? null);
      const id = Number(result.lastInsertRowid);
      writeLines(this.db, 'invoice_lines', 'invoice_id', id, lines);
      return this.get(id);
    });
  }

  updateDraft(id: number, input: Partial<InvoiceDraftInput>): Invoice {
    const inv = this.row(id);
    if (inv.status !== 'concept') throw new ValidationError('Alleen concepten kunnen bewerkt worden. Maak een creditfactuur om een definitieve factuur te corrigeren.');
    const relationId = input.relationId ?? inv.relation_id;
    this.relations.get(relationId);
    const date = input.invoiceDate ?? inv.invoice_date;
    const due = input.dueDate ?? inv.due_date;
    assertIsoDate(date, 'factuurdatum');
    assertIsoDate(due, 'vervaldatum');
    const lines = input.lines ? normalizeLines(input.lines) : null;
    return tx(this.db, () => {
      this.db
        .prepare('UPDATE invoices SET relation_id = ?, invoice_date = ?, due_date = ?, template_id = ?, reference = ?, intro = ?, notes = ? WHERE id = ?')
        .run(
          relationId,
          date,
          due,
          input.templateId !== undefined ? input.templateId : inv.template_id,
          input.reference !== undefined ? input.reference : inv.reference,
          input.intro !== undefined ? input.intro : inv.intro,
          input.notes !== undefined ? input.notes : inv.notes,
          id,
        );
      if (lines) writeLines(this.db, 'invoice_lines', 'invoice_id', id, lines);
      return this.get(id);
    });
  }

  deleteDraft(id: number): void {
    const inv = this.row(id);
    if (inv.status !== 'concept') throw new ValidationError('Definitieve facturen kunnen niet verwijderd worden (bewaarplicht). Maak een creditfactuur.');
    tx(this.db, () => {
      this.db.prepare('UPDATE quotes SET status = ? WHERE id = ? AND status = ?').run('geaccepteerd', inv.quote_id, 'gefactureerd');
      // werkbonregels komen weer vrij, en de klus is weer "klaar" als er geen andere factuur meer is (#32)
      const jobId = (this.db.prepare('SELECT job_id FROM invoices WHERE id = ?').get(id) as { job_id: number | null } | undefined)?.job_id ?? null;
      this.db.prepare('UPDATE job_work_items SET invoice_id = NULL WHERE invoice_id = ?').run(id);
      this.db.prepare('DELETE FROM invoices WHERE id = ?').run(id);
      if (jobId) {
        this.db
          .prepare(`UPDATE jobs SET status = 'klaar' WHERE id = ? AND status = 'gefactureerd' AND NOT EXISTS (SELECT 1 FROM invoices WHERE job_id = ?)`)
          .run(jobId, jobId);
      }
    });
  }

  /**
   * Maakt een concept definitief: ken een doorlopend factuurnummer toe, bevries klant- en
   * bedrijfsgegevens en totalen, en boek automatisch de journaalpost. Alles in één transactie.
   */
  finalize(id: number): Invoice {
    return tx(this.db, () => {
      const inv = this.get(id);
      if (inv.status !== 'concept') throw new ValidationError(`Factuur ${inv.number} is al definitief`);
      const s = this.settings.get();
      const relation = this.relations.get(inv.relation_id);
      this.assertLegalRequirements(inv, relation, s.kor, s.company);

      const key = counterKey('factuur', s.invoiceNumberFormat, inv.invoice_date);
      const seq = this.settings.nextCounter(key);
      const number = formatDocumentNumber(s.invoiceNumberFormat, inv.invoice_date, seq);
      if (this.db.prepare('SELECT 1 FROM invoices WHERE number = ?').get(number)) {
        throw new ValidationError(`Factuurnummer ${number} bestaat al; pas de nummerinstellingen aan`);
      }
      const totals = inv.totals;
      const entryId = this.ledger.post({
        date: inv.invoice_date,
        description: `${totals.total < 0 ? 'Creditfactuur' : 'Factuur'} ${number} ${relation.name}`,
        source: 'factuur',
        sourceRef: `invoice:${id}`,
        lines: this.journalLines(totals, relation.id, number),
      });
      this.db
        .prepare(
          `UPDATE invoices SET number = ?, status = 'verzonden', subtotal = ?, vat_total = ?, total = ?,
             relation_snapshot = ?, company_snapshot = ?, journal_entry_id = ? WHERE id = ?`,
        )
        .run(number, totals.subtotal, totals.vatTotal, totals.total, JSON.stringify(relation), JSON.stringify(s.company), entryId, id);

      if (inv.credit_of_invoice_id) this.settleCreditAgainstOriginal(id, inv.credit_of_invoice_id);
      return this.get(id);
    });
  }

  private assertLegalRequirements(inv: Invoice, relation: Relation, kor: boolean, company: { name: string; address: string; city: string; kvkNumber: string; vatNumber: string }): void {
    const missing: string[] = [];
    if (!company.name) missing.push('bedrijfsnaam');
    if (!company.address || !company.city) missing.push('bedrijfsadres');
    if (!company.kvkNumber) missing.push('KvK-nummer');
    if (!kor && !company.vatNumber) missing.push('btw-nummer');
    if (missing.length) throw new ValidationError(`Vul eerst je bedrijfsgegevens aan bij Instellingen: ${missing.join(', ')}`);
    if (!relation.address || !relation.city) throw new ValidationError(`Adres van ${relation.name} ontbreekt (verplicht op een factuur)`);
    if (inv.lines.some((l) => needsCustomerVatNumber(l.vat_code)) && !relation.vat_number) {
      throw new ValidationError(`Bij verlegde BTW moet het btw-nummer van ${relation.name} op de factuur staan`);
    }
    const country = countryCode(relation.country);
    if (inv.lines.some((l) => l.vat_code === 'icp') && (!country || country === 'NL' || !EU_COUNTRIES.has(country))) {
      throw new ValidationError(`"Bedrijf in de EU (0%)" is alleen voor klanten in een ander EU-land. Vul bij ${relation.name} het land in (bv. DE of BE)`);
    }
    if (inv.lines.some((l) => l.vat_code === 'export') && (!country || EU_COUNTRIES.has(country))) {
      throw new ValidationError(`"Uitvoer buiten de EU (0%)" is alleen voor klanten buiten de EU. Vul bij ${relation.name} het land in (bv. CH of US)`);
    }
    if (kor && inv.lines.some((l) => l.vat_percentage > 0)) {
      throw new ValidationError('Je gebruikt de kleineondernemersregeling (KOR): factuurregels mogen geen BTW bevatten');
    }
  }

  private journalLines(totals: DocumentTotals, relationId: number, number: string): PostLine[] {
    const lines: (PostLine | null)[] = [signedLine(ACCOUNTS.debiteuren, totals.total, { relationId, description: number })];
    for (const g of totals.groups) {
      const accounts = SALES_ACCOUNTS[g.vatCode];
      if (!accounts) throw new Error(`Geen omzetrekening voor BTW-code ${g.vatCode}`);
      lines.push(signedLine(accounts.revenue, -g.net, { relationId, vatCode: g.vatCode }));
      if (g.vat !== 0) {
        if (!accounts.vat) throw new Error(`Geen BTW-rekening voor BTW-code ${g.vatCode}`);
        lines.push(signedLine(accounts.vat, -g.vat, { relationId, vatCode: g.vatCode }));
      }
    }
    return lines.filter((l): l is PostLine => l !== null);
  }

  /** Verrekent een creditfactuur met de openstaande originele factuur (zonder geldstroom). */
  private settleCreditAgainstOriginal(creditId: number, originalId: number): void {
    const credit = this.row(creditId);
    const original = this.row(originalId);
    if (original.status === 'concept' || original.total == null || credit.total == null) return;
    const originalOpen = original.total - original.amount_paid;
    const creditOpen = credit.total - credit.amount_paid; // negatief
    const settle = Math.min(originalOpen, -creditOpen);
    if (settle <= 0) return;
    this.applyPaymentAmount(originalId, settle, credit.invoice_date);
    this.applyPaymentAmount(creditId, -settle, credit.invoice_date);
  }

  private applyPaymentAmount(id: number, amount: Cents, date: IsoDate): void {
    const inv = this.row(id);
    const paid = inv.amount_paid + amount;
    const total = inv.total ?? 0;
    const fullyPaid = total >= 0 ? paid >= total : paid <= total;
    this.db
      .prepare(`UPDATE invoices SET amount_paid = ?, status = ?, paid_at = ? WHERE id = ?`)
      .run(paid, fullyPaid ? 'betaald' : 'verzonden', fullyPaid ? date : null, id);
  }

  /** Registreert een (deel)betaling: bank aan debiteuren. */
  registerPayment(id: number, payment: PaymentInput): Invoice {
    assertCents(payment.amount, 'betaald bedrag');
    assertIsoDate(payment.date, 'betaaldatum');
    if (payment.amount === 0) throw new ValidationError('Bedrag mag niet nul zijn');
    return tx(this.db, () => {
      const inv = this.row(id);
      if (inv.status === 'concept') throw new ValidationError('Maak de factuur eerst definitief');
      const entryId = this.ledger.post({
        date: payment.date,
        description: payment.description ?? `Betaling factuur ${inv.number}`,
        source: 'bank',
        sourceRef: `invoice:${id}`,
        lines: [
          signedLine(payment.moneyAccount ?? ACCOUNTS.bank, payment.amount)!,
          signedLine(ACCOUNTS.debiteuren, -payment.amount, { relationId: inv.relation_id, description: inv.number })!,
        ],
      });
      this.applyPaymentAmount(id, payment.amount, payment.date);
      if (payment.bankTransactionId) {
        this.db
          .prepare(`UPDATE bank_transactions SET status = 'gematcht', matched_journal_entry_id = ?, matched_invoice_id = ? WHERE id = ?`)
          .run(entryId, id, payment.bankTransactionId);
      }
      return this.get(id);
    });
  }

  /** Draait een eerder geregistreerde betaling terug (bv. bij het ontkoppelen van een banktransactie). */
  undoPayment(id: number, amount: Cents, journalEntryId: number, date: IsoDate = today()): Invoice {
    return tx(this.db, () => {
      this.ledger.reverse(journalEntryId, date);
      this.applyPaymentAmount(id, -amount, date);
      return this.get(id);
    });
  }

  /** Boekt een klein restverschil af (bv. klant betaalde € 0,02 te weinig). */
  writeOffRemainder(id: number, date: IsoDate = today()): Invoice {
    return tx(this.db, () => {
      const inv = this.get(id);
      if (inv.status !== 'verzonden') throw new ValidationError('Alleen openstaande facturen kunnen afgeboekt worden');
      const open = inv.open_amount;
      if (Math.abs(open) > 500) throw new ValidationError('Afboeken kan alleen voor verschillen tot € 5,00');
      this.ledger.post({
        date,
        description: `Betalingsverschil factuur ${inv.number}`,
        source: 'handmatig',
        sourceRef: `invoice:${id}`,
        lines: [signedLine(ACCOUNTS.betalingsverschillen, open)!, signedLine(ACCOUNTS.debiteuren, -open, { relationId: inv.relation_id })!],
      });
      this.applyPaymentAmount(id, open, date);
      return this.get(id);
    });
  }

  /** Maakt een concept-creditfactuur voor een definitieve factuur (alle regels negatief). */
  createCreditNote(id: number): Invoice {
    const inv = this.get(id);
    if (inv.status === 'concept') throw new ValidationError('Een concept kun je gewoon aanpassen of verwijderen');
    if (inv.credit_of_invoice_id) throw new ValidationError('Een creditfactuur kan niet gecrediteerd worden');
    const existing = this.db.prepare('SELECT id FROM invoices WHERE credit_of_invoice_id = ?').get(id) as { id: number } | undefined;
    if (existing) throw new ValidationError('Er bestaat al een creditfactuur voor deze factuur');
    const draft = this.createDraft({
      relationId: inv.relation_id,
      reference: `Creditering van factuur ${inv.number}`,
      templateId: inv.template_id,
      lines: toLineInputs(inv.lines).map((l) => ({ ...l, quantity: -l.quantity })),
    });
    this.db.prepare('UPDATE invoices SET credit_of_invoice_id = ? WHERE id = ?').run(id, draft.id);
    return this.get(draft.id);
  }

  markSent(id: number): void {
    this.db.prepare(`UPDATE invoices SET sent_at = datetime('now') WHERE id = ?`).run(id);
  }

  recordReminder(id: number): void {
    this.db.prepare(`UPDATE invoices SET reminder_count = reminder_count + 1, last_reminder_at = datetime('now') WHERE id = ?`).run(id);
  }

  private row(id: number): InvoiceRow {
    const row = this.db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) as InvoiceRow | undefined;
    if (!row) throw new ValidationError(`Factuur ${id} bestaat niet`);
    return row;
  }

  get(id: number, asOf: IsoDate = today()): Invoice {
    const row = this.row(id);
    const lines = readLines(this.db, 'invoice_lines', 'invoice_id', id);
    const totals = computeTotals(toLineInputs(lines));
    const snapshot = row.relation_snapshot ? (JSON.parse(row.relation_snapshot) as Relation) : null;
    const relation = snapshot ?? this.relations.get(row.relation_id);
    const total = row.total ?? totals.total;
    const open = row.status === 'concept' ? 0 : total - row.amount_paid;
    const display = displayStatus(row.status, row.due_date, open, asOf);
    return {
      ...row,
      relation_name: relation.name,
      relation_email: this.relations.get(row.relation_id).email ?? relation.email,
      lines,
      totals,
      open_amount: open,
      display_status: display,
      days_overdue: display === 'vervallen' ? Math.max(0, Math.round((Date.parse(asOf) - Date.parse(row.due_date)) / 86_400_000)) : 0,
    };
  }

  list(filter: { status?: InvoiceDisplayStatus; relationId?: number; search?: string; from?: IsoDate; to?: IsoDate } = {}, asOf: IsoDate = today()): InvoiceSummary[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.relationId) (where.push('i.relation_id = ?'), params.push(filter.relationId));
    if (filter.from) (where.push('i.invoice_date >= ?'), params.push(filter.from));
    if (filter.to) (where.push('i.invoice_date <= ?'), params.push(filter.to));
    if (filter.search) {
      where.push('(i.number LIKE ? OR r.name LIKE ? OR i.reference LIKE ?)');
      params.push(`%${filter.search}%`, `%${filter.search}%`, `%${filter.search}%`);
    }
    const rows = this.db
      .prepare(
        `SELECT i.id, i.number, i.relation_id, r.name AS relation_name, i.invoice_date, i.due_date, i.status, i.total,
                i.amount_paid, i.sent_at, i.credit_of_invoice_id
         FROM invoices i JOIN relations r ON r.id = i.relation_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY CASE WHEN i.status = 'concept' THEN 0 ELSE 1 END, i.invoice_date DESC, i.id DESC`,
      )
      .all(...params) as (Omit<InvoiceSummary, 'display_status' | 'open_amount' | 'total'> & { total: number | null })[];
    const result = rows.map((r) => {
      const total = r.total ?? (r.status === 'concept' ? this.get(r.id, asOf).totals.total : 0);
      const open = r.status === 'concept' ? 0 : total - r.amount_paid;
      return { ...r, total, open_amount: open, display_status: displayStatus(r.status, r.due_date, open, asOf) };
    });
    return filter.status ? result.filter((r) => r.display_status === filter.status) : result;
  }

  /** Openstaande (definitieve, niet volledig betaalde) facturen — voor matching en dashboard. */
  listOpen(asOf: IsoDate = today()): InvoiceSummary[] {
    return this.list({}, asOf).filter((i) => i.status === 'verzonden');
  }

  /** E-factuur (UBL, Peppol BIS 3.0) met de gegevens zoals ze op de definitieve factuur staan (#24). */
  ublXml(id: number): string {
    const inv = this.get(id);
    if (inv.status === 'concept') throw new ValidationError('Maak de factuur eerst definitief');
    const company = inv.company_snapshot ? { ...this.settings.get().company, ...JSON.parse(inv.company_snapshot) } : this.settings.get().company;
    const snap = inv.relation_snapshot ? (JSON.parse(inv.relation_snapshot) as Partial<Relation>) : {};
    const rel = { ...this.relations.get(inv.relation_id), ...snap };
    return buildInvoiceUbl(inv, company, { name: rel.name, address: rel.address ?? null, postcode: rel.postcode ?? null, city: rel.city ?? null, country: rel.country ?? 'NL', vat_number: rel.vat_number ?? null, kvk_number: rel.kvk_number ?? null, email: rel.email ?? null });
  }

  renderHtml(id: number): string {
    const inv = this.get(id);
    const template = inv.template_id ? this.templates.get(inv.template_id) : this.templates.getDefault('factuur');
    const s = this.settings.get();
    const company = inv.company_snapshot ? JSON.parse(inv.company_snapshot) : s.company;
    const customer: RenderableParty = inv.relation_snapshot ? JSON.parse(inv.relation_snapshot) : this.relations.get(inv.relation_id);
    const creditOf = inv.credit_of_invoice_id ? this.row(inv.credit_of_invoice_id).number : null;
    return renderDocumentHtml(
      {
        kind: 'factuur',
        number: inv.number,
        date: inv.invoice_date,
        dueDate: inv.due_date,
        reference: inv.reference,
        intro: inv.intro,
        notes: inv.notes,
        creditOf,
        lines: inv.lines,
      },
      customer,
      company,
      template,
      { kor: s.kor },
    );
  }
}

export function displayStatus(status: InvoiceStatus, dueDate: IsoDate, open: Cents, asOf: IsoDate): InvoiceDisplayStatus {
  if (status === 'concept') return 'concept';
  if (status === 'betaald') return 'betaald';
  return open > 0 && dueDate < asOf ? 'vervallen' : 'openstaand';
}
