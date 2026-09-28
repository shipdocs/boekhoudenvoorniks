import type { Db } from '../db/database';
import { tx } from '../db/database';
import type { PurchaseService, PurchaseInvoice } from './purchases';
import type { IntakeService } from '../intake/intake';
import type { BankTransaction } from '../import/bank';
import type { RelationsService } from '../relations/relations';
import type { DocumentResult } from '../intake/types';
import { ACCOUNTS } from '../core-ledger/accounts';
import { formatEuro } from '../shared/money';
import { formatDateNl, type IsoDate } from '../shared/dates';
import { ValidationError } from '../shared/validation';
import { logAutomation } from '../inbox/automation-log';
import { explain } from '../automation/explain';

export interface BookedPaymentFix {
  purchaseId: number;
  bankTransactionId: number;
  supplier: string;
  amount: number;
  date: IsoDate;
}

/**
 * Een aankoop waarvan de betaling al op een van je eigen rekeningen als kosten geboekt is (bv. een
 * abonnement via een gemengde rekening als Revolut, automatisch verwerkt). Dan is de aankoop dubbel:
 * hij vervalt en de bon wordt het bewijsstuk bij die betaling. Nooit "privé betaald" zetten.
 */
export class BookedPayments {
  constructor(
    private readonly db: Db,
    private readonly purchases: PurchaseService,
    private readonly intake: IntakeService,
    private readonly relations: RelationsService,
  ) {}

  /** De afschrijving die al als kosten geboekt is en bij deze aankoop hoort (precies één), of null. */
  find(p: PurchaseInvoice): BankTransaction | null {
    if (!p.relation_name || p.total <= 0) return null;
    const probe = {
      total: { value: p.total, confidence: 1, source: 'handmatig' },
      invoiceDate: { value: p.invoice_date, confidence: 1, source: 'handmatig' },
      supplier: { value: p.relation_name, confidence: 1, source: 'handmatig' },
      supplierIban: null,
      foreign: p.currency && p.foreign_total !== null ? { currency: p.currency, total: p.foreign_total, rate: p.foreign_total / p.total, rateDate: p.invoice_date, source: 'bank' } : null,
    } as unknown as DocumentResult;
    return this.intake.findBookedBankTransaction(probe);
  }

  /**
   * Maakt de aankoop ongedaan ten gunste van de al geboekte betaling: een betaling met privégeld of
   * contant wordt teruggedraaid, de aankoop vervalt, de bon wordt het bewijsstuk.
   */
  merge(purchaseId: number, bankTransactionId: number, date: IsoDate): void {
    tx(this.db, () => {
      const p = this.purchases.get(purchaseId);
      const t = this.db.prepare('SELECT * FROM bank_transactions WHERE id = ?').get(bankTransactionId) as BankTransaction | undefined;
      if (!t || t.status !== 'gematcht' || t.matched_purchase_invoice_id || t.matched_invoice_id) throw new ValidationError('Deze betaling is intussen anders verwerkt. Kijk het opnieuw na.');
      if (this.db.prepare('SELECT 1 FROM bank_transactions WHERE matched_purchase_invoice_id = ?').get(purchaseId)) throw new ValidationError('Deze aankoop is al aan een betaling op de bank gekoppeld');
      for (const e of this.elsewherePayments(purchaseId)) this.purchases.undoPayment(purchaseId, e.amount, e.id, date);
      this.purchases.cancel(purchaseId, date);
      if (p.document_id) {
        this.db
          .prepare(`UPDATE documents SET status = 'verwerkt', confidence = 'HIGH', issues = '[]', classification = ? WHERE id = ?`)
          .run(JSON.stringify({ categoryKey: 'overig', vatCode: 'hoog', business: true, confidence: 1, source: 'geheugen', reasons: [`bewijsstuk bij banktransactie #${t.id}`], automatic: true }), p.document_id);
      }
    });
  }

  /**
   * Herstelt wat al dubbel staat: aankopen die op "privé/contant betaald" staan, terwijl dezelfde
   * betaling op een eigen rekening al als kosten geboekt is. Zo'n leverancier betaal je dus niet
   * privé: "voortaan privé" gaat uit. Wordt vastgelegd in het logboek van automatische verwerking.
   */
  repair(date: IsoDate): BookedPaymentFix[] {
    const fixes: BookedPaymentFix[] = [];
    const paidElsewhere = this.db
      .prepare(
        `SELECT p.id FROM purchase_invoices p WHERE p.is_opening = 0 AND p.amount_paid > 0
            AND NOT EXISTS (SELECT 1 FROM bank_transactions b WHERE b.matched_purchase_invoice_id = p.id)`,
      )
      .all() as { id: number }[];
    for (const { id } of paidElsewhere) {
      if (this.elsewherePayments(id).length === 0) continue;
      const p = this.purchases.get(id);
      const t = this.find(p);
      if (!t) continue;
      try {
        tx(this.db, () => {
          this.merge(id, t.id, date);
          if (p.relation_id !== null) this.relations.setPaidWith(p.relation_id, null);
          const supplier = p.relation_name ?? p.description;
          const explanation = explain([{ type: 'bankbetaling', label: `dezelfde betaling van ${formatEuro(-t.amount)} op ${formatDateNl(t.transaction_date)} al als kosten geboekt was`, value: 0.97 }]);
          logAutomation(this.db, {
            kind: 'dubbel-weg',
            ref_id: t.id,
            summary: `Aankoop ${supplier} van ${formatDateNl(p.invoice_date)} stond dubbel: de bon is nu het bewijsstuk bij de betaling`,
            reason: explanation.sentence,
            details: explanation,
          });
          fixes.push({ purchaseId: id, bankTransactionId: t.id, supplier, amount: -t.amount, date: t.transaction_date });
        });
      } catch {
        // bv. intussen anders verwerkt: laten staan
      }
    }
    return fixes;
  }

  /** Betalingen van deze aankoop met privégeld of contant (geen bank), die nog gelden. */
  private elsewherePayments(purchaseId: number): { id: number; amount: number }[] {
    return this.db
      .prepare(
        `SELECT e.id, SUM(l.debit) AS amount FROM journal_entries e
           JOIN journal_lines l ON l.journal_entry_id = e.id JOIN chart_of_accounts a ON a.id = l.account_id
          WHERE e.source_ref = ? AND e.status <> 'teruggedraaid' AND e.reverses_entry_id IS NULL AND a.rgs_code = ?
            AND EXISTS (SELECT 1 FROM journal_lines m JOIN chart_of_accounts b ON b.id = m.account_id WHERE m.journal_entry_id = e.id AND b.rgs_code IN (?, ?))
          GROUP BY e.id`,
      )
      .all(`purchase:${purchaseId}`, ACCOUNTS.crediteuren, ACCOUNTS.priveStortingen, ACCOUNTS.kas) as { id: number; amount: number }[];
  }
}
