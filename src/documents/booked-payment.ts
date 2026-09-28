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

export interface DoubleCandidate {
  purchase: PurchaseInvoice;
  bankTransaction: BankTransaction;
  /** zeker genoeg om vanzelf te herstellen */
  certain: boolean;
}

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
 * hij vervalt en de bon wordt het bewijsstuk bij die betaling. Alleen vanzelf als het zeker is;
 * anders vraagt de app het (het kunnen ook twee aankopen met hetzelfde bedrag zijn).
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
   * Aankopen die op "privé/contant betaald" staan, terwijl er een afschrijving op een eigen rekening
   * als kosten geboekt is die er precies bij lijkt te horen. Kan dubbel zijn, maar ook twee aankopen.
   */
  candidates(): DoubleCandidate[] {
    const paidElsewhere = this.db
      .prepare(
        `SELECT p.id FROM purchase_invoices p WHERE p.is_opening = 0 AND p.amount_paid > 0
            AND NOT EXISTS (SELECT 1 FROM bank_transactions b WHERE b.matched_purchase_invoice_id = p.id)`,
      )
      .all() as { id: number }[];
    const out: DoubleCandidate[] = [];
    for (const { id } of paidElsewhere) {
      const payments = this.elsewherePayments(id);
      if (payments.length === 0) continue;
      const purchase = this.purchases.get(id);
      const bankTransaction = this.find(purchase);
      if (!bankTransaction) continue;
      const paidWith = purchase.relation_id !== null ? this.relations.get(purchase.relation_id).paid_with : null;
      // zeker dubbel: privé betaald gezet bij een leverancier die op "voortaan privé" staat (zo ging het in 0.6.4),
      // en de betaling staat toch als kosten op je rekening. Contant is nooit zeker: dat staat niet op de bank.
      const certain = paidWith === 'prive' && payments.every((x) => x.via === 'prive');
      out.push({ purchase, bankTransaction, certain });
    }
    return out;
  }

  /**
   * Herstelt vanzelf wat zeker dubbel staat (zie candidates); de rest wordt een vraag in Vandaag.
   * "Voortaan privé" gaat uit: deze leverancier betaal je van een eigen rekening. In het logboek.
   */
  repair(date: IsoDate): BookedPaymentFix[] {
    const fixes: BookedPaymentFix[] = [];
    for (const { purchase: p, bankTransaction: t } of this.candidates().filter((c) => c.certain)) {
      try {
        tx(this.db, () => {
          const fix = this.resolve(p.id, t.id, date);
          const explanation = explain([{ type: 'bankbetaling', label: `dezelfde betaling van ${formatEuro(-t.amount)} op ${formatDateNl(t.transaction_date)} al als kosten geboekt was`, value: 0.97 }]);
          logAutomation(this.db, {
            kind: 'dubbel-weg',
            ref_id: t.id,
            summary: `Aankoop ${fix.supplier} van ${formatDateNl(p.invoice_date)} stond dubbel: de bon is nu het bewijsstuk bij de betaling`,
            reason: explanation.sentence,
            details: explanation,
          });
          fixes.push(fix);
        });
      } catch {
        // bv. intussen anders verwerkt: laten staan
      }
    }
    return fixes;
  }

  /** "Ja, dubbel": samenvoegen, en deze leverancier niet meer voortaan privé. */
  resolve(purchaseId: number, bankTransactionId: number, date: IsoDate): BookedPaymentFix {
    return tx(this.db, () => {
      const p = this.purchases.get(purchaseId);
      const t = this.db.prepare('SELECT * FROM bank_transactions WHERE id = ?').get(bankTransactionId) as BankTransaction;
      this.merge(purchaseId, bankTransactionId, date);
      if (p.relation_id !== null) this.relations.setPaidWith(p.relation_id, null);
      return { purchaseId, bankTransactionId, supplier: p.relation_name ?? p.description, amount: -t.amount, date: t.transaction_date };
    });
  }

  /** Betalingen van deze aankoop met privégeld of contant (geen bank), die nog gelden. */
  private elsewherePayments(purchaseId: number): { id: number; amount: number; via: 'prive' | 'kas' }[] {
    return this.db
      .prepare(
        `SELECT e.id, SUM(l.debit) AS amount,
                CASE WHEN EXISTS (SELECT 1 FROM journal_lines k JOIN chart_of_accounts c ON c.id = k.account_id WHERE k.journal_entry_id = e.id AND c.rgs_code = ?) THEN 'kas' ELSE 'prive' END AS via
           FROM journal_entries e
           JOIN journal_lines l ON l.journal_entry_id = e.id JOIN chart_of_accounts a ON a.id = l.account_id
          WHERE e.source_ref = ? AND e.status <> 'teruggedraaid' AND e.reverses_entry_id IS NULL AND a.rgs_code = ?
            AND EXISTS (SELECT 1 FROM journal_lines m JOIN chart_of_accounts b ON b.id = m.account_id WHERE m.journal_entry_id = e.id AND b.rgs_code IN (?, ?))
          GROUP BY e.id`,
      )
      .all(ACCOUNTS.kas, `purchase:${purchaseId}`, ACCOUNTS.crediteuren, ACCOUNTS.priveStortingen, ACCOUNTS.kas) as { id: number; amount: number; via: 'prive' | 'kas' }[];
  }
}
