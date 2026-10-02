import type { Db } from '../db/database';
import { tx } from '../db/database';
import type { Ledger } from '../core-ledger/ledger';
import { signedLine } from '../core-ledger/ledger';
import { ACCOUNTS, SALES_ACCOUNTS } from '../core-ledger/accounts';
import type { PurchaseService, PurchaseInvoice } from '../documents/purchases';
import type { InvoiceService, Invoice } from '../documents/invoices';
import type { RelationsService } from '../relations/relations';
import { splitGross } from '../import/bank';
import type { CategoryLookup } from '../shared/categories';
import { PURCHASE_VAT_RATES, SALES_VAT_RATES, isPurchaseVatCode, isReverseCharge, type PurchaseVatCode, type SalesVatCode } from '../shared/vat';
import { assertIsoDate, type IsoDate } from '../shared/dates';
import { formatEuro, type Cents } from '../shared/money';
import { ValidationError } from '../shared/validation';
import type { BookedPayments } from '../documents/booked-payment';
import type { DuplicateMatch, ManualPurchase } from '../intake/intake';

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
  /** zakelijk deel in procenten (1–100); weglaten = wat eerder voor deze leverancier gold, anders 100 */
  businessPct?: number;
  /** "Toch toevoegen": de gebruiker zag dat er al een aankoop of bon staat die erop lijkt (#224) */
  allowDuplicate?: boolean;
}

/** De melding bij handmatige invoer naast een aankoop of bon die er al staat (#224). */
export const duplicateEntryMessage = (match: Pick<DuplicateMatch, 'label' | 'detail'>): string =>
  `Lijkt op ${match.label}.${match.detail ? ` ${match.detail}` : ''} Staat deze aankoop er al in? Kijk het eerst na; is het een andere aankoop, kies dan "Toch toevoegen".`;

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
    private readonly categories: CategoryLookup,
  ) {}

  private booked: BookedPayments | null = null;
  setBookedPayments(booked: BookedPayments): void {
    this.booked = booked;
  }

  private duplicates: ((entry: ManualPurchase) => DuplicateMatch | null) | null = null;
  /** de dubbel-controle van de bonnen, ook voor wat met de hand wordt ingevoerd (#224) */
  setDuplicateCheck(check: (entry: ManualPurchase) => DuplicateMatch | null): void {
    this.duplicates = check;
  }

  /**
   * Staat er al een aankoop of bon die lijkt op wat je met de hand invoert (#224)? Zelfde leverancier met
   * hetzelfde bedrag rond dezelfde datum, of met hetzelfde nummer. Zonder leverancier valt er niets te vergelijken.
   */
  duplicateOf(input: Pick<ExpenseInput, 'date' | 'supplierName' | 'supplierReference' | 'grossAmount'>): DuplicateMatch | null {
    if (!this.duplicates || !input.supplierName?.trim()) return null;
    return this.duplicates({ supplier: input.supplierName, total: input.grossAmount, date: input.date, number: input.supplierReference ?? null });
  }

  /**
   * Bonnetje / inkoopfactuur. Bij 'bank' blijft hij open tot de bankimport hem koppelt. Lijkt hij op een
   * aankoop of bon die er al staat, dan komt er niets bij tot de gebruiker "Toch toevoegen" kiest (`allowDuplicate`).
   */
  recordExpense(input: ExpenseInput): PurchaseInvoice {
    assertIsoDate(input.date);
    const category = this.categories.find(input.categoryKey);
    if (!category) throw new ValidationError('Kies waar de aankoop voor was');
    if (!isPurchaseVatCode(input.vatCode)) throw new ValidationError('Kies of er btw op de bon stond');
    if (!Number.isSafeInteger(input.grossAmount) || input.grossAmount === 0) throw new ValidationError('Vul een bedrag in');
    const duplicate = input.allowDuplicate ? null : this.duplicateOf(input);
    if (duplicate) throw new ValidationError(duplicateEntryMessage(duplicate));
    const { net, vat } = splitGross(input.grossAmount, PURCHASE_VAT_RATES[input.vatCode].percentage, isReverseCharge(input.vatCode));
    return tx(this.db, () => {
      const relationId = input.supplierName?.trim() ? this.relations.findOrCreateSupplier(input.supplierName).id : null;
      const purchase = this.purchases.create({
        relationId,
        supplierReference: input.supplierReference ?? null,
        invoiceDate: input.date,
        description: input.description.trim() || category.label,
        attachmentPath: input.attachmentPath ?? null,
        jobId: input.jobId ?? null,
        businessPct: input.businessPct,
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

  /**
   * Een open rekening is niet van de zakelijke rekening betaald, maar privé (privérekening,
   * telefoonrekening) of contant. Privé: Crediteuren aan Privé-stortingen; de kosten en btw blijven staan.
   * Met `always`: ook de andere open rekeningen van deze leverancier, en nieuwe rekeningen voortaan meteen.
   * Of de betaling al op een eigen rekening staat, vraagt het scherm eerst (`bookedPayment`); bij de
   * andere open rekeningen laat de app zo'n rekening open (`skipped`) en gaat de leverancier niet op privé.
   * Staat er een afschrijving die bij deze aankoop past nog onverwerkt op een eigen rekening (#222), dan
   * kan het alleen met `separate` ("Nee, apart betaald"): die afschrijving hoort dan niet bij deze aankoop.
   */
  payPurchaseWith(id: number, via: 'prive' | 'kas', opts: { always?: boolean; separate?: boolean } = {}): { paid: PurchaseInvoice[]; skipped: PurchaseInvoice[] } {
    return tx(this.db, () => {
      const p = this.purchases.get(id);
      if (p.status !== 'open' || p.open_amount <= 0) throw new ValidationError('Deze rekening staat al op betaald');
      const pending = this.booked?.findPending(p) ?? [];
      if (pending.length > 0 && !opts.separate) {
        const t = pending[0]!;
        throw new ValidationError(`Op je rekening staat een afschrijving van ${formatEuro(-t.amount)} aan ${t.counter_name ?? p.relation_name ?? p.description} die nog niet verwerkt is. Kies eerst of dat de betaling van deze aankoop is.`);
      }
      // apart betaald: de app vraagt bij die afschrijving niet meer of hij bij deze aankoop hoort
      for (const t of pending) this.booked!.reject(p.id, t.id);
      const all = opts.always && p.relation_id !== null;
      const others = all ? this.purchases.list({ status: 'open' }).filter((x) => x.id !== p.id && x.relation_id === p.relation_id && x.open_amount > 0) : [];
      // de betaling staat al op een eigen rekening, geboekt of nog niet verwerkt: die rekening blijft open
      const skipped = others.filter((x) => !!this.booked?.find(x) || (this.booked?.findPending(x).length ?? 0) > 0);
      const moneyAccount = via === 'kas' ? ACCOUNTS.kas : ACCOUNTS.priveStortingen;
      const paid = [p, ...others.filter((x) => !skipped.includes(x))].map((t) => this.purchases.registerPayment(t.id, { amount: t.open_amount, date: t.invoice_date, moneyAccount }));
      if (all && skipped.length === 0) this.relations.setPaidWith(p.relation_id!, via);
      return { paid, skipped };
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
    if (!rate) throw new ValidationError('Kies een btw-tarief');
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
