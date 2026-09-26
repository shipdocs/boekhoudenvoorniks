import type { Db } from '../db/database';
import { tx } from '../db/database';
import { Ledger, signedLine, type PostLine } from '../core-ledger/ledger';
import { ACCOUNTS } from '../core-ledger/accounts';
import { PURCHASE_VAT_RATES, type PurchaseVatCode } from '../shared/vat';
import { assertIsoDate, type IsoDate } from '../shared/dates';
import { assertCents, roundHalfAwayFromZero, type Cents } from '../shared/money';
import { isValidIban, normalizeIban, ValidationError } from '../shared/validation';

export type { PurchaseLineInput } from '../core-ledger/rules';
export { expenseLines, purchaseVat } from '../core-ledger/rules';
import { expenseLines, purchaseVat, type InkoopPayload, type PurchaseLineInput } from '../core-ledger/rules';
import type { EventService, Evidence } from '../core-ledger/events';

export interface PurchaseInvoiceInput {
  relationId?: number | null;
  supplierReference?: string | null;
  invoiceDate: IsoDate;
  dueDate?: IsoDate | null;
  description: string;
  lines: PurchaseLineInput[];
  attachmentPath?: string | null;
  jobId?: number | null;
  documentId?: number | null;
  externalSource?: string | null;
  externalId?: string | null;
  /** IBAN van de leverancier zoals op het document, voor betalen met QR en de fraudecontrole */
  payeeIban?: string | null;
}

export interface PurchaseInvoice {
  id: number;
  relation_id: number | null;
  relation_name: string | null;
  supplier_reference: string | null;
  invoice_date: IsoDate;
  due_date: IsoDate | null;
  description: string;
  subtotal: Cents;
  vat_total: Cents;
  total: Cents;
  amount_paid: Cents;
  status: 'open' | 'betaald';
  journal_entry_id: number | null;
  attachment_path: string | null;
  job_id: number | null;
  document_id: number | null;
  payee_iban: string | null;
  /** garantietermijn in maanden (gereedschap, machines) */
  warranty_months: number | null;
  open_amount: Cents;
}

export class PurchaseService {
  constructor(
    private readonly db: Db,
    private readonly ledger: Ledger,
    private readonly events: EventService,
  ) {}

  create(input: PurchaseInvoiceInput): PurchaseInvoice {
    assertIsoDate(input.invoiceDate, 'factuurdatum');
    if (input.dueDate) assertIsoDate(input.dueDate, 'vervaldatum');
    if (!input.description?.trim()) throw new ValidationError('Omschrijving is verplicht');
    if (input.lines.length === 0) throw new ValidationError('Voeg minimaal één regel toe');
    return tx(this.db, () => {
      const booking = expenseLines(input.lines, ACCOUNTS.crediteuren, input.relationId ?? null, input.supplierReference ?? undefined);
      const vatPaid = booking.payable - booking.net;
      const result = this.db
        .prepare(
          `INSERT INTO purchase_invoices (relation_id, supplier_reference, invoice_date, due_date, description, subtotal, vat_total, total, attachment_path, job_id, document_id, external_source, external_id, payee_iban)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(input.relationId ?? null, input.supplierReference ?? null, input.invoiceDate, input.dueDate ?? null, input.description.trim(), booking.net, vatPaid, booking.payable, input.attachmentPath ?? null, input.jobId ?? null, input.documentId ?? null, input.externalSource ?? null, input.externalId ?? null, input.payeeIban ? normalizeIban(input.payeeIban) : null);
      const id = Number(result.lastInsertRowid);
      const evidence: Evidence[] = [{ kind: 'inkoop', refId: id }];
      if (input.documentId) evidence.push({ kind: 'document', refId: input.documentId });
      const { entryId } = this.events.record(
        {
          type: 'inkoop',
          payload: { purchaseId: id, date: input.invoiceDate, description: input.description.trim(), relationId: input.relationId ?? null, supplierReference: input.supplierReference ?? null, lines: input.lines },
        },
        evidence,
        { jobId: input.jobId ?? null },
      );
      const insertLine = this.db.prepare('INSERT INTO purchase_invoice_lines (purchase_invoice_id, account_id, description, net_amount, vat_code, vat_amount) VALUES (?, ?, ?, ?, ?, ?)');
      for (const l of input.lines) insertLine.run(id, this.ledger.getAccount(l.account).id, l.description ?? null, l.netAmount, l.vatCode, purchaseVat(l));
      this.db.prepare('UPDATE purchase_invoices SET journal_entry_id = ? WHERE id = ?').run(entryId, id);
      return this.get(id);
    });
  }

  /**
   * Andere kostensoort of btw-keuze voor een geboekte inkoop (#19): de gebeurtenis wordt vervangen
   * (tegenboeking + nieuwe post). Het te betalen bedrag mag niet veranderen als er al betaald is.
   */
  reclassify(id: number, lines: PurchaseLineInput[], reason = 'andere categorie'): PurchaseInvoice {
    if (lines.length === 0) throw new ValidationError('Voeg minimaal één regel toe');
    return tx(this.db, () => {
      const p = this.get(id);
      if (!p.journal_entry_id) throw new ValidationError('Deze aankoop kan niet aangepast worden');
      const event = this.events.forEntry(p.journal_entry_id);
      if (!event || event.type !== 'inkoop') throw new ValidationError('Deze aankoop is met een oudere versie van de app verwerkt en kan zo niet aangepast worden. Vraag je boekhouder.');
      const booking = expenseLines(lines, ACCOUNTS.crediteuren, p.relation_id, p.supplier_reference ?? undefined);
      if (p.amount_paid !== 0 && booking.payable !== p.total) throw new ValidationError('Het te betalen bedrag verandert; maak eerst de betaling ongedaan');
      const old = event.payload as InkoopPayload;
      const { entryId } = this.events.replace(event.id, { type: 'inkoop', payload: { ...old, lines } }, reason);
      this.db
        .prepare('UPDATE purchase_invoices SET journal_entry_id = ?, subtotal = ?, vat_total = ?, total = ?, status = ? WHERE id = ?')
        .run(entryId, booking.net, booking.payable - booking.net, booking.payable, p.amount_paid >= booking.payable ? 'betaald' : 'open', id);
      this.db.prepare('DELETE FROM purchase_invoice_lines WHERE purchase_invoice_id = ?').run(id);
      const insertLine = this.db.prepare('INSERT INTO purchase_invoice_lines (purchase_invoice_id, account_id, description, net_amount, vat_code, vat_amount) VALUES (?, ?, ?, ?, ?, ?)');
      for (const l of lines) insertLine.run(id, this.ledger.getAccount(l.account).id, l.description ?? null, l.netAmount, l.vatCode, purchaseVat(l));
      return this.get(id);
    });
  }

  registerPayment(id: number, payment: { amount: Cents; date: IsoDate; moneyAccount?: string; bankTransactionId?: number | null }): PurchaseInvoice {
    assertCents(payment.amount);
    assertIsoDate(payment.date);
    return tx(this.db, () => {
      const p = this.get(id);
      const entryId = this.ledger.post({
        date: payment.date,
        description: `Betaling inkoop: ${p.description}`,
        source: 'bank',
        sourceRef: `purchase:${id}`,
        lines: [signedLine(ACCOUNTS.crediteuren, payment.amount, { relationId: p.relation_id })!, signedLine(payment.moneyAccount ?? ACCOUNTS.bank, -payment.amount)!],
      });
      const paid = p.amount_paid + payment.amount;
      this.db.prepare('UPDATE purchase_invoices SET amount_paid = ?, status = ? WHERE id = ?').run(paid, paid >= p.total ? 'betaald' : 'open', id);
      if (payment.bankTransactionId) {
        this.db
          .prepare(`UPDATE bank_transactions SET status = 'gematcht', matched_journal_entry_id = ?, matched_purchase_invoice_id = ? WHERE id = ?`)
          .run(entryId, id, payment.bankTransactionId);
      }
      return this.get(id);
    });
  }

  undoPayment(id: number, amount: Cents, journalEntryId: number, date: IsoDate): PurchaseInvoice {
    return tx(this.db, () => {
      this.ledger.reverse(journalEntryId, date);
      const p = this.get(id);
      const paid = p.amount_paid - amount;
      this.db.prepare('UPDATE purchase_invoices SET amount_paid = ?, status = ? WHERE id = ?').run(paid, paid >= p.total ? 'betaald' : 'open', id);
      return this.get(id);
    });
  }

  /**
   * Draait een (nog onbetaalde) inkoop terug, bv. na "Klopt niet" op een automatische verwerking.
   * De journaalpost krijgt een tegenboeking; het document gaat terug naar controle.
   */
  cancel(id: number, date: IsoDate): void {
    tx(this.db, () => {
      const p = this.get(id);
      if (p.amount_paid !== 0) throw new ValidationError('Maak eerst de betaling van deze aankoop ongedaan');
      if (p.journal_entry_id) this.ledger.reverse(p.journal_entry_id, date, `Teruggedraaid: ${p.description}`);
      this.db.prepare(`UPDATE documents SET purchase_invoice_id = NULL, status = 'controle' WHERE purchase_invoice_id = ?`).run(id);
      this.db.prepare('DELETE FROM purchase_invoices WHERE id = ?').run(id);
    });
  }

  /**
   * Betaalgegevens met fraudecontrole (#25): wijkt het IBAN af van wat we eerder van deze
   * leverancier kenden, dan eerst een waarschuwing en pas na bevestiging een betaal-QR.
   */
  paymentInfo(id: number): { purchase: PurchaseInvoice; iban: string | null; name: string; knownIbans: string[]; ibanChanged: boolean; ibanValid: boolean } {
    const p = this.get(id);
    const relation = p.relation_id
      ? (this.db.prepare('SELECT name, iban FROM relations WHERE id = ?').get(p.relation_id) as { name: string; iban: string | null } | undefined)
      : undefined;
    const earlier = p.relation_id
      ? (this.db.prepare('SELECT DISTINCT payee_iban FROM purchase_invoices WHERE relation_id = ? AND id < ? AND payee_iban IS NOT NULL').all(p.relation_id, id) as { payee_iban: string }[]).map((r) => r.payee_iban)
      : [];
    const known = [...new Set([...(relation?.iban ? [normalizeIban(relation.iban)] : []), ...earlier])];
    const iban = p.payee_iban ?? known[0] ?? null;
    return {
      purchase: p,
      iban,
      name: relation?.name ?? p.relation_name ?? p.description,
      knownIbans: known,
      ibanChanged: !!iban && known.length > 0 && !known.includes(iban),
      ibanValid: !!iban && isValidIban(iban),
    };
  }

  get(id: number): PurchaseInvoice {
    const row = this.db
      .prepare('SELECT p.*, r.name AS relation_name FROM purchase_invoices p LEFT JOIN relations r ON r.id = p.relation_id WHERE p.id = ?')
      .get(id) as Omit<PurchaseInvoice, 'open_amount'> | undefined;
    if (!row) throw new ValidationError('Deze aankoop bestaat niet (meer)');
    return { ...row, open_amount: row.total - row.amount_paid };
  }

  list(filter: { status?: 'open' | 'betaald' } = {}): PurchaseInvoice[] {
    const rows = this.db
      .prepare(`SELECT p.*, r.name AS relation_name FROM purchase_invoices p LEFT JOIN relations r ON r.id = p.relation_id ${filter.status ? 'WHERE p.status = ?' : ''} ORDER BY p.invoice_date DESC, p.id DESC`)
      .all(...(filter.status ? [filter.status] : [])) as Omit<PurchaseInvoice, 'open_amount'>[];
    return rows.map((r) => ({ ...r, open_amount: r.total - r.amount_paid }));
  }

  listOpen(): PurchaseInvoice[] {
    return this.list({ status: 'open' });
  }
}

