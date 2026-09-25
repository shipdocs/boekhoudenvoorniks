import type { Db } from '../db/database';
import { tx } from '../db/database';
import type { Ledger } from '../core-ledger/ledger';
import { signedLine } from '../core-ledger/ledger';
import { ACCOUNTS, SALES_ACCOUNTS } from '../core-ledger/accounts';
import type { PurchaseService, PurchaseInvoice } from '../documents/purchases';
import type { InvoiceService, Invoice } from '../documents/invoices';
import type { RelationsService } from '../relations/relations';
import { splitGross } from '../import/bank';
import { EXPENSE_CATEGORIES } from '../shared/categories';
import { PURCHASE_VAT_RATES, SALES_VAT_RATES, type PurchaseVatCode, type SalesVatCode } from '../shared/vat';
import { assertIsoDate, type IsoDate } from '../shared/dates';
import type { Cents } from '../shared/money';
import { ValidationError } from '../shared/validation';

export type PaidWith = 'bank' | 'kas' | 'prive';

export interface ExpenseInput {
  date: IsoDate;
  supplierName?: string | null;
  supplierReference?: string | null;
  description: string;
  categoryKey: string;
  /** bedrag zoals op de bon (inclusief BTW; bij verlegd: het betaalde bedrag) */
  grossAmount: Cents;
  vatCode: PurchaseVatCode;
  paidWith: PaidWith;
  attachmentPath?: string | null;
  jobId?: number | null;
}

export interface CashSaleInput {
  date: IsoDate;
  description: string;
  grossAmount: Cents;
  vatCode: SalesVatCode;
  receivedWith: 'kas' | 'bank';
}

/**
 * "Wat heb je gedaan?" — vertaalt alledaagse handelingen naar correcte boekingen.
 * De gebruiker kiest een categorie en een bedrag; journaalposten worden automatisch gemaakt.
 */
export class QuickActions {
  constructor(
    private readonly db: Db,
    private readonly ledger: Ledger,
    private readonly purchases: PurchaseService,
    private readonly invoices: InvoiceService,
    private readonly relations: RelationsService,
  ) {}

  /** Bonnetje / inkoopfactuur. Bij 'bank' blijft hij open tot de bankimport hem koppelt. */
  recordExpense(input: ExpenseInput): PurchaseInvoice {
    assertIsoDate(input.date);
    const category = EXPENSE_CATEGORIES.find((c) => c.key === input.categoryKey);
    if (!category) throw new ValidationError(`Onbekende categorie: ${input.categoryKey}`);
    if (!(input.vatCode in PURCHASE_VAT_RATES)) throw new ValidationError(`Onbekende BTW-keuze: ${input.vatCode}`);
    if (!Number.isSafeInteger(input.grossAmount) || input.grossAmount === 0) throw new ValidationError('Vul een bedrag in');
    const { net, vat } = splitGross(input.grossAmount, PURCHASE_VAT_RATES[input.vatCode].percentage, input.vatCode === 'verlegd');
    return tx(this.db, () => {
      const relationId = input.supplierName?.trim() ? this.relations.findOrCreateSupplier(input.supplierName).id : null;
      const purchase = this.purchases.create({
        relationId,
        supplierReference: input.supplierReference ?? null,
        invoiceDate: input.date,
        description: input.description.trim() || category.label,
        attachmentPath: input.attachmentPath ?? null,
        jobId: input.jobId ?? null,
        lines: [{ account: category.account, netAmount: net, vatCode: input.vatCode, vatAmount: vat, description: input.description }],
      });
      if (input.paidWith !== 'bank') {
        this.purchases.registerPayment(purchase.id, {
          amount: purchase.total,
          date: input.date,
          moneyAccount: input.paidWith === 'kas' ? ACCOUNTS.kas : ACCOUNTS.priveStortingen,
        });
      }
      return this.purchases.get(purchase.id);
    });
  }

  /** Klant heeft contant/pin betaald voor een bestaande factuur. */
  customerPaidCash(invoiceId: number, amount: Cents, date: IsoDate): Invoice {
    return this.invoices.registerPayment(invoiceId, { amount, date, moneyAccount: ACCOUNTS.kas, description: 'Contante betaling' });
  }

  /** Verkoop zonder factuur (bv. contant aan particulier). */
  recordCashSale(input: CashSaleInput): number {
    assertIsoDate(input.date);
    const rate = SALES_VAT_RATES[input.vatCode];
    if (!rate) throw new ValidationError(`Onbekende BTW-code ${input.vatCode}`);
    const { net, vat } = splitGross(input.grossAmount, rate.percentage);
    const accounts = SALES_ACCOUNTS[input.vatCode]!;
    const lines = [
      signedLine(input.receivedWith === 'kas' ? ACCOUNTS.kas : ACCOUNTS.bank, input.grossAmount),
      signedLine(accounts.revenue, -net, { vatCode: input.vatCode }),
      accounts.vat ? signedLine(accounts.vat, -vat, { vatCode: input.vatCode }) : null,
    ].filter((l) => l !== null);
    return this.ledger.post({ date: input.date, description: `Verkoop: ${input.description}`, source: 'handmatig', lines });
  }

  /** Geld van de zakelijke kas privé opgenomen, of privé geld in de zaak gestopt. */
  recordPrivate(direction: 'opname' | 'storting', amount: Cents, date: IsoDate, via: 'kas' | 'bank' = 'kas'): number {
    const money = via === 'kas' ? ACCOUNTS.kas : ACCOUNTS.bank;
    const signed = direction === 'storting' ? amount : -amount;
    return this.ledger.post({
      date,
      description: direction === 'opname' ? 'Privé-opname' : 'Privé-storting',
      source: 'handmatig',
      lines: [signedLine(money, signed)!, signedLine(direction === 'opname' ? ACCOUNTS.priveOpnamen : ACCOUNTS.priveStortingen, -signed)!],
    });
  }
}
