import type { Db } from '../db/database';
import { tx } from '../db/database';
import type { PurchaseService, PurchaseInvoice } from './purchases';
import type { IntakeService } from '../intake/intake';
import type { BankService, BankTransaction } from '../import/bank';
import type { RelationsService } from '../relations/relations';
import { formatEuro } from '../shared/money';
import { diffDays, formatDateNl, type IsoDate } from '../shared/dates';
import { ValidationError } from '../shared/validation';
import { logAutomation } from '../inbox/automation-log';
import { explain } from '../automation/explain';
import { amountFit, BankPurchaseMatcher, BANK_DAYS_AFTER, describePurchase, dueOf, isDoubleCandidate, SURE_DAYS, type PurchaseState } from './bank-purchase-match';

export interface DoubleCandidate {
  purchase: PurchaseInvoice;
  bankTransaction: BankTransaction;
  /** zeker genoeg om vanzelf te herstellen */
  certain: boolean;
  /** open = de aankoop is nog niet betaald; elders = hij staat op privé of contant betaald */
  state: PurchaseState;
  /** waar de betaling los op geboekt is: kosten, of "weet ik nog niet" */
  booking: 'kosten' | 'vraag';
}

export interface BookedPaymentFix {
  purchaseId: number;
  bankTransactionId: number;
  supplier: string;
  amount: number;
  date: IsoDate;
}

const STALE = 'Deze betaling is intussen anders verwerkt. Kijk het opnieuw na.';
const TAKEN = 'Bij deze betaling hoort al een andere aankoop of een bon. Eén betaling kan niet bij twee aankopen horen.';

/**
 * Een aankoop en een afschrijving die dezelfde uitgave zijn, maar niet aan elkaar hangen. Bijvoorbeeld een
 * abonnement via een gemengde rekening: de betaling is al los als kosten geboekt en de bon werd een
 * aankoop, of de aankoop staat op privé betaald en de afschrijving komt toch op een eigen rekening binnen.
 * De vergelijking komt uit de gedeelde matcher; hier staat wat "Ja, dezelfde betaling" boekt. Alleen
 * vanzelf als het zeker is; anders vraagt de app het (het kunnen ook twee aankopen met hetzelfde bedrag zijn).
 */
export class BookedPayments {
  readonly matcher: BankPurchaseMatcher;

  constructor(
    private readonly db: Db,
    private readonly purchases: PurchaseService,
    private readonly intake: IntakeService,
    private readonly relations: RelationsService,
    private readonly bank: BankService,
  ) {
    this.matcher = new BankPurchaseMatcher(db);
  }

  /** De afschrijving die al los geboekt is (als kosten of op "weet ik nog niet") en bij deze aankoop hoort (precies één), of null. */
  find(p: PurchaseInvoice): BankTransaction | null {
    const e = this.matcher.entry(p.id);
    return e && isDoubleCandidate(e) ? this.matcher.bookedFor(e.probe, e.state, { question: true }) : null;
  }

  /** "Nee, apart betaald": deze afschrijving is niet de betaling van deze aankoop. Het paar komt nergens meer terug. */
  reject(purchaseId: number, bankTransactionId: number): void {
    this.purchases.get(purchaseId);
    this.matcher.reject({ purchaseId, bankTransactionId });
  }

  /**
   * Maakt de aankoop ongedaan ten gunste van de al geboekte betaling: een betaling met privégeld of
   * contant wordt teruggedraaid, de aankoop vervalt, de bon wordt het bewijsstuk. Eén betaling is één
   * uitgave: hoort er al een bon of een andere aankoop bij, dan niet nog een.
   */
  merge(purchaseId: number, bankTransactionId: number, date: IsoDate, provenance: 'gebruiker' | 'automatisch' = 'gebruiker'): void {
    tx(this.db, () => {
      this.purchases.get(purchaseId);
      const t = this.db.prepare('SELECT * FROM bank_transactions WHERE id = ?').get(bankTransactionId) as BankTransaction | undefined;
      if (!t || t.status !== 'gematcht' || t.matched_purchase_invoice_id || t.matched_invoice_id) throw new ValidationError(STALE);
      if (this.db.prepare('SELECT 1 FROM bank_transactions WHERE matched_purchase_invoice_id = ?').get(purchaseId)) throw new ValidationError('Deze aankoop is al aan een betaling op de bank gekoppeld');
      if (this.intake.links.forTarget({ kind: 'bank', id: t.id }).length > 0 || this.matcher.merged(t)) throw new ValidationError(TAKEN);
      for (const e of this.matcher.elsewherePayments(purchaseId)) this.purchases.undoPayment(purchaseId, e.amount, e.id, date);
      // alle bestanden van de aankoop (ook kopieën) gaan mee naar de betaling
      const files = this.intake.links.forTarget({ kind: 'aankoop', id: purchaseId });
      this.purchases.cancel(purchaseId, date);
      this.intake.moveToBank(files, t.id, provenance);
      this.matcher.markMerged(t);
    });
  }

  /**
   * Aankopen waar nog niets via de bank op betaald is (open, of op "privé/contant betaald" gezet), terwijl
   * er een afschrijving op een eigen rekening los geboekt is die er precies bij lijkt te horen. Kan dubbel
   * zijn, maar ook twee aankopen. Paren die de gebruiker afwees, tellen niet mee.
   */
  candidates(): DoubleCandidate[] {
    const pool = this.matcher.bookedDebits({ question: true });
    if (pool.length === 0) return [];
    const out: DoubleCandidate[] = [];
    const { purchases, rejected } = this.matcher.index();
    for (const e of purchases.filter(isDoubleCandidate)) {
      const match = this.matcher.bookedMatch(e.probe, e.state, { pool, rejected });
      const booking = match ? this.matcher.bookingOf(match.transaction) : null;
      if (!match || !booking) continue;
      const purchase = this.purchases.get(e.probe.id);
      const bankTransaction = match.transaction;
      const paidWith = purchase.relation_id !== null ? this.relations.get(purchase.relation_id).paid_with : null;
      const days = diffDays(purchase.invoice_date, bankTransaction.transaction_date);
      const foreign = Boolean(purchase.currency && purchase.currency !== 'EUR');
      // zeker dubbel: privé betaald gezet bij een leverancier die op "voortaan privé" staat (zo ging het in 0.6.4),
      // en de betaling staat toch als kosten op je rekening, kort erna en maar één keer. Contant is nooit zeker:
      // dat staat niet op de bank. Een open aankoop en een betaling op "weet ik nog niet" ook niet.
      const certain = e.state === 'elders' && paidWith === 'prive' && e.via === 'prive' && match.strong && match.sure && booking === 'kosten' && days >= -SURE_DAYS && days <= (foreign ? BANK_DAYS_AFTER : SURE_DAYS);
      out.push({ purchase, bankTransaction, certain, state: e.state, booking });
    }
    // twee aankopen bij dezelfde afschrijving: hooguit één ervan is die betaling, dus geen van beide vanzelf
    const perDebit = new Map<number, number>();
    for (const c of out) perDebit.set(c.bankTransaction.id, (perDebit.get(c.bankTransaction.id) ?? 0) + 1);
    return out.map((c) => (perDebit.get(c.bankTransaction.id)! > 1 ? { ...c, certain: false } : c));
  }

  /**
   * Herstelt vanzelf wat zeker dubbel staat (zie candidates); de rest wordt een vraag in Vandaag.
   * "Voortaan privé" gaat uit: deze leverancier betaal je van een eigen rekening. In het logboek.
   * Per afschrijving hooguit één aankoop: `candidates` maakt er dan geen zeker, en `merge` weigert een tweede.
   */
  repair(date: IsoDate): BookedPaymentFix[] {
    const fixes: BookedPaymentFix[] = [];
    for (const { purchase: p, bankTransaction: t } of this.candidates().filter((c) => c.certain)) {
      try {
        tx(this.db, () => {
          const fix = this.resolve(p.id, t.id, date, 'automatisch');
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

  /**
   * "Ja, dezelfde betaling": de aankoop en de afschrijving worden één uitgave, zonder dat kosten of btw
   * twee keer tellen. Een nieuwe afschrijving betaalt de aankoop (Crediteuren aan Bank; een betaling met
   * privégeld of contant gaat eerst terug). Een afschrijving die al als kosten geboekt is, blijft staan: de
   * aankoop vervalt en de bon wordt het bewijs erbij. Een afschrijving op "weet ik nog niet" wordt alsnog
   * de betaling van de aankoop. Deze leverancier staat daarna niet meer op "voortaan privé".
   */
  resolve(purchaseId: number, bankTransactionId: number, date: IsoDate, provenance: 'gebruiker' | 'automatisch' = 'gebruiker'): BookedPaymentFix {
    return tx(this.db, () => {
      const p = this.purchases.get(purchaseId);
      const t = this.bank.get(bankTransactionId);
      const fix = { purchaseId, bankTransactionId, supplier: p.relation_name ?? p.description, amount: -t.amount, date: t.transaction_date };
      const booking = t.status === 'gematcht' ? this.matcher.bookingOf(t) : null;
      if (booking === 'kosten') {
        this.merge(purchaseId, bankTransactionId, date, provenance);
        if (p.relation_id !== null) this.relations.setPaidWith(p.relation_id, null);
        return fix;
      }
      // de afschrijving wordt de betaling van de aankoop: alleen als het bedrag past (precies, of binnen de koers)
      const e = this.matcher.entry(purchaseId);
      const fits = e ? amountFit(-t.amount, dueOf(e.probe, e.state), e.probe.currency) : null;
      if (!e || t.amount >= 0 || t.duplicate_of || t.matched_invoice_id || t.matched_purchase_invoice_id || (t.status !== 'nieuw' && booking !== 'vraag')) throw new ValidationError(STALE);
      if (fits !== 'gelijk' && fits !== 'koers') throw new ValidationError('Het bedrag van deze betaling is anders dan dat van de aankoop. Klopt het bedrag van de aankoop niet? Pas dat eerst aan; daarna kun je de betaling koppelen.');
      if (e.state === 'elders') {
        for (const paid of this.matcher.elsewherePayments(purchaseId)) this.purchases.undoPayment(purchaseId, paid.amount, paid.id, t.transaction_date);
        if (p.relation_id !== null) this.relations.setPaidWith(p.relation_id, null);
      }
      // stond de afschrijving los op "weet ik nog niet": die post vervalt, de aankoop blijft zoals hij was
      if (booking === 'vraag') this.bank.unmatch(bankTransactionId, t.transaction_date);
      this.bank.matchPurchase(bankTransactionId, purchaseId);
      return fix;
    });
  }

  /**
   * Een al geboekte betaling anders indelen terwijl er een aankoop bij lijkt te horen: eerst de vraag
   * "staat deze aankoop dubbel?" beantwoorden.
   */
  assertNoDouble(bankTransactionId: number): void {
    const c = this.candidates().find((x) => x.bankTransaction.id === bankTransactionId);
    if (!c) return;
    throw new ValidationError(`Deze betaling lijkt bij ${describePurchase(c.purchase)} te horen. Beantwoord eerst de vraag "staat deze aankoop dubbel?" op Vandaag; anders tellen de kosten twee keer.`);
  }
}
