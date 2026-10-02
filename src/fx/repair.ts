import type { Db } from '../db/database';
import { tx } from '../db/database';
import type { FxService } from './fx';
import { toEuro } from './fx';
import type { IntakeService } from '../intake/intake';
import type { PurchaseService } from '../documents/purchases';
import type { BankService, BankTransaction } from '../import/bank';
import { supplierKey } from '../intake/supplier-memory';
import type { DocumentResult } from '../intake/types';
import { detectCurrency } from '../shared/currency';
import { today, type IsoDate } from '../shared/dates';
import type { Cents } from '../shared/money';
import { ValidationError } from '../shared/validation';
import { BankPurchaseMatcher } from '../documents/bank-purchase-match';

/**
 * Vreemde valuta voor wat er al in de administratie stond (#74). Vóór versie 0.3.9 las de app elke
 * bon als euro's: "$ 90,00" werd € 90,00. Dit zoekt die bonnen en aankopen op en rekent ze om:
 *  - een bon die nog gecontroleerd moet worden: gewoon opnieuw beoordelen (er is nog niets geboekt);
 *  - een geboekte aankoop: omrekenen naar het bedrag dat de bank afschreef (of de ECB-koers als er
 *    nog geen betaling is), via een tegenboeking en een nieuwe boeking;
 *  - staat de betaling al rechtstreeks als kosten geboekt, dan is de aankoop dubbel: die vervalt en
 *    de bon wordt het bewijsstuk bij de betaling.
 * Alleen aankopen waarin precies het bedrag van de bon als euro's staat, komen vanzelf in de lijst;
 * een ander bedrag heeft de gebruiker zelf ingevuld. Die kan per aankoop met de hand omgerekend worden.
 */

export interface FxCandidate {
  purchaseId: number;
  documentId: number | null;
  supplier: string | null;
  description: string;
  date: IsoDate;
  /** wat nu in de boekhouding staat */
  bookedTotal: Cents;
  currency: string;
  foreignTotal: Cents;
}

export interface FxProposal extends FxCandidate {
  /** het bedrag in euro's dat in de boekhouding komt; null = niet bekend (geen betaling, geen internet) */
  euroTotal: Cents | null;
  /** 'bank' = wat er is afgeschreven, 'ecb' = geschat met de dagkoers */
  source: 'bank' | 'ecb' | null;
  /** vreemde munt per euro */
  rate: number | null;
  /** afschrijving die nog niet verwerkt is en na het omrekenen aan de aankoop gekoppeld wordt */
  bankTransactionId: number | null;
  /** de betaling hing al aan deze aankoop */
  linkedPayment: boolean;
  /** de betaling staat al rechtstreeks als kosten geboekt: deze aankoop is dan dubbel */
  alreadyBooked: { bankTransactionId: number; amount: Cents; date: IsoDate } | null;
  /** waarom het (nog) niet kan */
  blocker: string | null;
}

export interface FxApplyInput {
  currency: string;
  foreignTotal: Cents;
  euroTotal: Cents;
  bankTransactionId?: number | null;
  alreadyBookedBankTransactionId?: number | null;
}

export interface FxRepairSummary {
  documents: number;
  purchases: number;
  duplicates: number;
  /** nog niet gelukt, met de reden (bv. geen internet voor de koers) */
  open: { purchaseId: number; label: string; reason: string }[];
}

/** Welke munt en welk bedrag op een (met een oudere versie gelezen) document staan; null = euro. */
export function detectForeign(result: DocumentResult | null): { currency: string; total: Cents } | null {
  if (!result || result.foreign || !result.total || result.total.value <= 0) return null;
  const stated = result.currency?.value;
  const currency = stated && stated !== 'EUR' ? stated : detectCurrency(result.rawText ?? '').code;
  if (currency === 'EUR' || !/^[A-Z]{3}$/.test(currency)) return null;
  return { currency, total: result.total.value };
}

export class FxRepair {
  constructor(
    private readonly db: Db,
    private readonly fx: FxService,
    private readonly intake: IntakeService,
    private readonly purchases: PurchaseService,
    private readonly bank: BankService,
  ) {}

  /** Bonnen die nog gecontroleerd moeten worden en met een oudere versie als euro's gelezen zijn. */
  pendingDocuments(): number[] {
    const rows = this.db
      .prepare(`SELECT id, result FROM documents WHERE status IN ('nieuw','controle') AND purchase_invoice_id IS NULL AND result IS NOT NULL ORDER BY id`)
      .all() as { id: number; result: string }[];
    return rows.filter((r) => detectForeign(JSON.parse(r.result) as DocumentResult)).map((r) => r.id);
  }

  /** Geboekte aankopen waarin het bedrag van een bon in een andere munt als euro's staat. */
  candidates(): FxCandidate[] {
    const rows = this.db
      .prepare(
        `SELECT p.id, p.document_id, p.description, p.invoice_date, p.total, r.name AS supplier, d.result
         FROM purchase_invoices p
         JOIN documents d ON d.id = p.document_id
         LEFT JOIN relations r ON r.id = p.relation_id
         WHERE p.currency IS NULL AND d.result IS NOT NULL
         ORDER BY p.invoice_date, p.id`,
      )
      .all() as { id: number; document_id: number; description: string; invoice_date: IsoDate; total: Cents; supplier: string | null; result: string }[];
    const out: FxCandidate[] = [];
    for (const r of rows) {
      const found = detectForeign(JSON.parse(r.result) as DocumentResult);
      // alleen als precies het bedrag van de bon als euro's geboekt is
      if (!found || found.total !== r.total) continue;
      out.push({ purchaseId: r.id, documentId: r.document_id, supplier: r.supplier, description: r.description, date: r.invoice_date, bookedTotal: r.total, currency: found.currency, foreignTotal: found.total });
    }
    return out;
  }

  /**
   * Opnieuw beoordelen van bonnen die nog niet geboekt zijn: omrekenen en weer laten controleren.
   * needRate: alleen als de koers er is (op de achtergrond); anders blijft de bon staan tot er internet
   * is, in plaats van meteen het bedrag in euro's te vragen.
   */
  async fixDocuments(asOf: IsoDate = today(), opts: { needRate?: boolean } = {}): Promise<number> {
    let n = 0;
    for (const id of this.pendingDocuments()) {
      const doc = this.intake.get(id);
      const found = detectForeign(doc.result);
      if (!doc.result || !found) continue;
      if (opts.needRate && !(await this.fx.rateFor(found.currency, doc.result.invoiceDate?.value ?? asOf))) continue;
      const result: DocumentResult = { ...doc.result, currency: { value: found.currency, confidence: 0.9, source: doc.result.currency?.source ?? 'pdf-text' } };
      const issues = await this.intake.toEuros(result);
      this.db.prepare('UPDATE documents SET result = ? WHERE id = ?').run(JSON.stringify(result), id);
      await this.intake.evaluate(id, issues, asOf, { autoConfirm: false });
      n++;
    }
    return n;
  }

  /**
   * Voorstel voor één aankoop: welk bedrag in euro's, en waarom. Zonder `input` wat de app van de bon
   * las; met `input` wat de gebruiker invulde (bv. een aankoop zonder bon).
   */
  async preview(purchaseId: number, input?: { currency: string; foreignTotal: Cents }): Promise<FxProposal> {
    const p = this.purchases.get(purchaseId);
    if (p.currency) throw new ValidationError(`Deze aankoop is al omgerekend (${p.currency})`);
    const fromDoc = input ? null : this.candidates().find((c) => c.purchaseId === purchaseId);
    const currency = input ? input.currency.toUpperCase() : fromDoc?.currency;
    const foreignTotal = input ? input.foreignTotal : fromDoc?.foreignTotal;
    if (!currency || foreignTotal === undefined) throw new ValidationError('Vul de munt en het bedrag op de bon in');
    if (!/^[A-Z]{3}$/.test(currency) || currency === 'EUR') throw new ValidationError('Kies de munt van de bon');
    if (!Number.isSafeInteger(foreignTotal) || foreignTotal <= 0) throw new ValidationError('Vul het bedrag op de bon in');
    const base: FxProposal = {
      purchaseId,
      documentId: p.document_id,
      supplier: p.relation_name ?? null,
      description: p.description,
      date: p.invoice_date,
      bookedTotal: p.total,
      currency,
      foreignTotal,
      euroTotal: null,
      source: null,
      rate: null,
      bankTransactionId: null,
      linkedPayment: false,
      alreadyBooked: null,
      blocker: null,
    };
    const withBlocker = (x: FxProposal): FxProposal =>
      x.euroTotal !== null && p.amount_paid > x.euroTotal && !x.alreadyBooked
        ? { ...x, blocker: 'Er is al meer betaald dan het bedrag in euro\'s. Maak eerst de betaling ongedaan (bij Bank).' }
        : x.alreadyBooked && p.amount_paid !== 0
          ? { ...x, blocker: 'Deze aankoop is al (deels) betaald. Maak eerst de betaling ongedaan (bij Bank).' }
          : x;

    // 1. de betaling hangt al aan deze aankoop (vaak als "deels betaald"): dat bedrag is het echte bedrag
    const linked = this.db
      .prepare(`SELECT COALESCE(SUM(-amount), 0) AS s, COUNT(*) AS n FROM bank_transactions WHERE matched_purchase_invoice_id = ? AND status = 'gematcht'`)
      .get(purchaseId) as { s: number; n: number };
    if (linked.n > 0 && linked.s > 0) {
      return withBlocker({ ...base, euroTotal: linked.s, source: 'bank', rate: foreignTotal / linked.s, linkedPayment: true });
    }

    // 2. geschat met de ECB-koers, en daarmee de afschrijving zoeken (nog open, of al als kosten geboekt)
    const fx = await this.fx.rateFor(currency, p.invoice_date);
    if (!fx) {
      // geen koers (geen internet): wel een afschrijving van dezelfde leverancier rond die datum, als het er precies één is
      const nearby = this.openDebitsFrom(p.relation_name, p.invoice_date);
      if (nearby.length === 1) return withBlocker({ ...base, euroTotal: -nearby[0]!.amount, source: 'bank', rate: foreignTotal / -nearby[0]!.amount, bankTransactionId: nearby[0]!.id });
      return withBlocker({ ...base, blocker: 'De koers kon niet opgehaald worden (geen internet?). Vul het bedrag in euro\'s in, zoals het van je rekening is afgeschreven.' });
    }
    const estimate = toEuro(foreignTotal, fx.rate);
    const probe = {
      total: { value: estimate, confidence: 1, source: 'handmatig' },
      invoiceDate: { value: p.invoice_date, confidence: 1, source: 'handmatig' },
      supplier: p.relation_name ? { value: p.relation_name, confidence: 1, source: 'handmatig' } : null,
      supplierIban: null,
      foreign: { currency, total: foreignTotal, rate: fx.rate, rateDate: fx.date, source: 'ecb' },
    } as unknown as DocumentResult;
    // alleen als er maar één afschrijving past: `fixAll` voert dit voorstel zonder vraag uit
    const booked = p.relation_name ? this.intake.findBookedBankTransaction(probe, new Set(), { sure: true, forPurchase: true }) : null;
    if (booked) {
      return withBlocker({ ...base, euroTotal: -booked.amount, source: 'bank', rate: foreignTotal / -booked.amount, alreadyBooked: { bankTransactionId: booked.id, amount: -booked.amount, date: booked.transaction_date } });
    }
    const open = this.intake.findBankMatch(probe);
    if (open) return withBlocker({ ...base, euroTotal: -open.amount, source: 'bank', rate: foreignTotal / -open.amount, bankTransactionId: open.id });
    return withBlocker({ ...base, euroTotal: estimate, source: 'ecb', rate: fx.rate });
  }

  /** Nog niet verwerkte afschrijvingen van deze leverancier, van 3 dagen vóór tot 10 dagen na de factuurdatum. */
  private openDebitsFrom(supplier: string | null, date: IsoDate): BankTransaction[] {
    const key = supplier ? supplierKey(supplier).split(' ')[0] : '';
    if (!key) return [];
    return (
      this.db
        .prepare(`SELECT * FROM bank_transactions WHERE status = 'nieuw' AND amount < 0 AND julianday(transaction_date) - julianday(?) BETWEEN -3 AND 10`)
        .all(date) as BankTransaction[]
    ).filter((t) => !!t.counter_name && supplierKey(t.counter_name).split(' ')[0] === key);
  }

  /** Voert het (eventueel aangepaste) voorstel uit. */
  apply(purchaseId: number, input: FxApplyInput): { kind: 'omgerekend' | 'dubbel' } {
    const currency = input.currency.toUpperCase();
    return tx(this.db, () => {
      const p = this.purchases.get(purchaseId);
      if (input.alreadyBookedBankTransactionId) {
        const t = this.bank.get(input.alreadyBookedBankTransactionId);
        if (t.status !== 'gematcht' || t.matched_purchase_invoice_id || t.matched_invoice_id) throw new ValidationError('Deze betaling is intussen anders verwerkt. Kijk het opnieuw na.');
        // één betaling is één uitgave (#221): hoort er al een andere aankoop bij, dan niet nog een
        const matcher = new BankPurchaseMatcher(this.db);
        if (matcher.merged(t)) throw new ValidationError('Bij deze betaling hoort al een andere aankoop. Eén betaling kan niet bij twee aankopen horen.');
        // de betaling staat al als kosten geboekt: de aankoop vervalt, de bon wordt het bewijsstuk
        const files = this.intake.links.forTarget({ kind: 'aankoop', id: purchaseId });
        this.purchases.cancel(purchaseId, p.invoice_date);
        if (p.document_id) this.markForeign(p.document_id, currency, input.foreignTotal, -t.amount, 'bank', t.transaction_date);
        this.intake.moveToBank(files, t.id, 'gebruiker');
        matcher.markMerged(t);
        return { kind: 'dubbel' as const };
      }
      // de afschrijving uit het voorstel kan intussen anders verwerkt of genegeerd zijn: dan niet dat bedrag gebruiken
      const t = input.bankTransactionId ? this.bank.get(input.bankTransactionId) : null;
      if (t && t.status !== 'nieuw') throw new ValidationError('Deze betaling is intussen anders verwerkt. Kijk het opnieuw na.');
      this.purchases.revalue(purchaseId, input.euroTotal, { currency, total: input.foreignTotal });
      if (t) this.bank.matchPurchase(t.id, purchaseId);
      const source: 'bank' | 'ecb' = t || p.amount_paid > 0 ? 'bank' : 'ecb';
      if (p.document_id) this.markForeign(p.document_id, currency, input.foreignTotal, input.euroTotal, source, p.invoice_date);
      return { kind: 'omgerekend' as const };
    });
  }

  /** Alles wat de app zelf kan omrekenen in één keer; wat een bedrag van de gebruiker nodig heeft blijft staan. */
  async fixAll(asOf: IsoDate = today()): Promise<FxRepairSummary> {
    const summary: FxRepairSummary = { documents: await this.fixDocuments(asOf), purchases: 0, duplicates: 0, open: [] };
    for (const c of this.candidates()) {
      const label = `${c.supplier ?? c.description} van ${c.date}`;
      try {
        const pr = await this.preview(c.purchaseId);
        if (pr.blocker || pr.euroTotal === null) {
          summary.open.push({ purchaseId: c.purchaseId, label, reason: pr.blocker ?? 'Bedrag in euro\'s onbekend' });
          continue;
        }
        const r = this.apply(c.purchaseId, { currency: pr.currency, foreignTotal: pr.foreignTotal, euroTotal: pr.euroTotal, bankTransactionId: pr.bankTransactionId, alreadyBookedBankTransactionId: pr.alreadyBooked?.bankTransactionId ?? null });
        if (r.kind === 'dubbel') summary.duplicates++;
        else summary.purchases++;
      } catch (e) {
        summary.open.push({ purchaseId: c.purchaseId, label, reason: (e as Error).message });
      }
    }
    return summary;
  }

  /** Het document krijgt de munt en het bedrag in euro's, zodat het bij de bon goed getoond wordt. */
  private markForeign(documentId: number, currency: string, foreignTotal: Cents, euroTotal: Cents, source: 'bank' | 'ecb', rateDate: IsoDate): void {
    const doc = this.intake.get(documentId);
    if (!doc.result) return;
    const result: DocumentResult = {
      ...doc.result,
      currency: { ...doc.result.currency, value: currency },
      total: doc.result.total ? { ...doc.result.total, value: euroTotal } : doc.result.total,
      foreign: { currency, total: foreignTotal, rate: foreignTotal / euroTotal, rateDate, source },
    };
    this.db.prepare('UPDATE documents SET result = ? WHERE id = ?').run(JSON.stringify(result), documentId);
  }
}
