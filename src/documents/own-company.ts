import type { Db } from '../db/database';
import { tx } from '../db/database';
import type { BankService, BankTransaction } from '../import/bank';
import type { PurchaseInvoice, PurchaseService } from './purchases';
import type { IntakeDocument, IntakeService } from '../intake/intake';
import { sameCompanyName, type OwnIdentity } from '../intake/own-company';
import type { DocumentResult } from '../intake/types';
import { ACCOUNTS } from '../core-ledger/accounts';
import { diffDays } from '../shared/dates';
import { ValidationError } from '../shared/validation';
import { BankPurchaseMatcher, type PurchaseIndex } from './bank-purchase-match';

/** Privé, of apart op "weet ik nog niet" (Vraagposten, zonder btw-aftrek): de twee keuzes bij iets van je eigen bedrijf. */
export type OwnCompanyChoice = 'prive' | 'vraag';

/** Een afschrijving naar je eigen bedrijf, met wat er in de app bij hoort. */
export interface OwnPaymentMatch {
  transaction: BankTransaction;
  /** de factuur van je eigen bedrijf die nog op een keuze wacht */
  document: IntakeDocument | null;
  /** de aankoop bij je eigen bedrijf die al op "weet ik nog niet" staat en nog niet betaald is */
  purchase: PurchaseInvoice | null;
  /** de factuur die je eerder al op privé zette (wordt het bewijs bij deze betaling) */
  settledDocumentId: number | null;
  /**
   * Er past een aankoop sterk bij deze betaling die niet in de keuze hierboven meegaat: een gewone aankoop
   * bij je eigen bedrijf (kosten met btw-aftrek), of een die al op privé of contant betaald staat. Eerst de
   * vraag of ze bij elkaar horen ("Ja" of "Nee, iets anders"), daarna pas privé of "weet ik nog niet".
   */
  mustAnswer: boolean;
}

/**
 * Betalingen aan je eigen bedrijf (#205), bv. een proefabonnement op je eigen dienst: de tegenpartij op
 * het afschrift is je eigen bedrijfsnaam, maar het is geen overboeking naar een eigen rekening. Zo'n
 * betaling en de factuur ervan horen bij elkaar en krijgen samen één keuze: privé, of "weet ik nog
 * niet". Nooit gewone kosten met btw-aftrek, en nooit vanzelf: er gebeurt alleen iets in `settle`.
 */
export class OwnCompanyPayments {
  constructor(
    private readonly db: Db,
    private readonly bank: BankService,
    private readonly purchases: PurchaseService,
    private readonly intake: IntakeService,
    private readonly identity: () => OwnIdentity | null,
  ) {
    this.matcher = new BankPurchaseMatcher(db);
  }

  /** de gedeelde vergelijking van een betaling met een aankoop die er al staat (#221) */
  private readonly matcher: BankPurchaseMatcher;

  /** Nog niet verwerkte afschrijving met je eigen bedrijfsnaam als tegenpartij (geen eigen rekening). */
  isOwnPayment(t: BankTransaction): boolean {
    const own = this.identity();
    return !!own && t.status === 'nieuw' && t.amount < 0 && sameCompanyName(t.counter_name, own.name) && !this.bank.ownTransferTarget(t);
  }

  /**
   * Wat er bij deze betaling hoort: eerst een factuur die nog wacht, dan een aankoop op "weet ik nog niet".
   * Die aankoop mag een maand van de betaling af liggen, of verder als hij volgens de gedeelde vergelijking
   * sterk past (betaald kort na de vervaldatum, of het factuurnummer staat in de omschrijving). Past er een
   * andere aankoop sterk bij, dan gaat die vraag voor (`mustAnswer`). `index`: al geladen, bij een lus.
   */
  match(t: BankTransaction, index?: PurchaseIndex): OwnPaymentMatch | null {
    if (!this.isOwnPayment(t)) return null;
    const own = this.identity()!;
    const strong = this.matcher.forTransaction(t, index).filter((f) => f.strength === 'sterk');
    const fits = new Set(strong.filter((f) => f.state === 'open').map((f) => f.purchase.id));
    const document =
      this.intake
        .list('controle')
        .filter((d) => this.intake.ownIssue(d) && !this.intake.pending(d) && d.result?.total?.value === -t.amount && this.intake.findOwnPayment(d.result)?.id === t.id)
        .sort((a, b) => a.id - b.id)[0] ?? null;
    const near = (date: string, days: number) => Math.abs(diffDays(date, t.transaction_date)) <= days;
    const purchase = document
      ? null
      : this.purchases
          .listOpen()
          .filter((p) => p.total === -t.amount && p.amount_paid === 0 && (near(p.invoice_date, 31) || fits.has(p.id)) && this.purchases.isQuestion(p.id))
          .filter((p) => sameCompanyName(p.relation_name, own.name) || (p.document_id !== null && this.intake.isOwnInvoice(this.intake.get(p.document_id).result)))
          .sort((a, b) => Math.abs(diffDays(a.invoice_date, t.transaction_date)) - Math.abs(diffDays(b.invoice_date, t.transaction_date)) || a.id - b.id)[0] ?? null;
    const settled = document || purchase
      ? null
      : (this.db
          .prepare(
            `SELECT d.id, d.result FROM documents d WHERE d.status = 'genegeerd' AND d.duplicate_of_document_id IS NULL AND d.result IS NOT NULL
               AND json_extract(d.result, '$.total.value') = ? AND json_extract(d.result, '$.ownCompany.level') IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM document_links k WHERE k.document_id = d.id) ORDER BY d.id`,
          )
          .all(-t.amount) as { id: number; result: string }[]).find((d) => {
          const date = (JSON.parse(d.result) as DocumentResult).invoiceDate?.value;
          return !date || near(date, 14);
        }) ?? null;
    return { transaction: t, document, purchase, settledDocumentId: settled?.id ?? null, mustAnswer: strong.some((f) => f.purchase.id !== purchase?.id) };
  }

  /**
   * De keuze van de gebruiker, voor de betaling en wat erbij hoort samen. Privé: de betaling wordt een
   * privé-opname; een aankoop die op "weet ik nog niet" stond vervalt (tegenboeking). Weet ik nog niet:
   * de factuur gaat (of blijft) op Vraagposten zonder btw-aftrek en de betaling wordt daaraan gekoppeld;
   * zonder factuur gaat de betaling zelf naar Vraagposten. De factuur blijft altijd bewaard. Past er een
   * andere aankoop sterk bij deze betaling, dan eerst die vraag: anders komt de betaling er los naast (#230).
   */
  settle(bankTransactionId: number, choice: OwnCompanyChoice): void {
    if (choice !== 'prive' && choice !== 'vraag') throw new ValidationError('Kies "Privé" of "Weet ik nog niet"');
    tx(this.db, () => {
      const m = this.match(this.bank.get(bankTransactionId));
      if (!m) throw new ValidationError('Deze betaling is intussen anders verwerkt. Kijk het opnieuw na.');
      if (m.mustAnswer) this.matcher.assertAnswered(m.transaction);
      const name = this.identity()!.name.trim();
      if (m.document) {
        if (!this.intake.settleOwn(m.document.id, choice, bankTransactionId)) throw new ValidationError('Bij de factuur ontbreekt het bedrag of de datum. Open de factuur en vul dat eerst in.');
        return;
      }
      if (m.purchase) {
        if (choice === 'vraag') return this.bank.matchPurchase(bankTransactionId, m.purchase.id);
        // toch privé: de aankoop op "weet ik nog niet" vervalt en de factuur wordt het bewijs bij de betaling
        const files = this.intake.links.forTarget({ kind: 'aankoop', id: m.purchase.id });
        this.purchases.cancel(m.purchase.id, m.purchase.invoice_date);
        this.bank.bookToAccount(bankTransactionId, { account: ACCOUNTS.priveOpnamen, description: `Privé: ${name}` });
        this.intake.moveToBank(files, bankTransactionId, 'gebruiker');
        return;
      }
      this.bank.bookToAccount(
        bankTransactionId,
        choice === 'prive' ? { account: ACCOUNTS.priveOpnamen, description: `Privé: ${name}` } : { account: ACCOUNTS.vraagposten, vatCode: 'geen', description: `Nog uitzoeken — ${name}` },
      );
      if (m.settledDocumentId !== null) this.intake.linkExisting(m.settledDocumentId, { kind: 'bank', id: bankTransactionId });
    });
  }
}
