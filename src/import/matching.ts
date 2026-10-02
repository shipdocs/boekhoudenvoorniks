import type { BankService, BankTransaction } from './bank';
import type { InvoiceService, InvoiceSummary } from '../documents/invoices';
import type { PurchaseService, PurchaseInvoice } from '../documents/purchases';
import type { RelationsService } from '../relations/relations';
import { ACCOUNTS } from '../core-ledger/accounts';
import { formatDateNl, today, type IsoDate } from '../shared/dates';
import { formatEuro } from '../shared/money';
import { withinFx } from '../shared/currency';
import { THRESHOLDS, thresholdFor, type AutopilotLevel } from '../automation/decisions';
import { dateFits, mentionsNumber, mentionsReference, sameIban, supplierNameFit, type Pair } from '../documents/bank-purchase-match';
import { paymentProviderIn } from '../shared/payment-providers';

export type Suggestion =
  | { kind: 'factuur'; invoiceId: number; label: string; score: number; reasons: string[] }
  | { kind: 'inkoop'; purchaseId: number; label: string; score: number; reasons: string[] }
  | { kind: 'rekening'; account: string; vatCode: string | null; label: string; score: number; reasons: string[] };

/** Score vanaf waar automatisch gekoppeld wordt (bedrag + factuurnummer, of bedrag + IBAN). */
export const AUTO_MATCH_THRESHOLD = 100;
/** Een tweede kandidaat binnen deze marge = twijfel: dan beslist de gebruiker. */
export const DOUBT_MARGIN = 30;

/**
 * Score → zekerheid 0..1 (#21). Gekalibreerd zodat de oude drempel (100) precies op de
 * standaarddrempel voor bankkoppelingen (0,9) valt. Twijfel halveert de zekerheid.
 */
export function matchConfidence(best: number, second?: number): { confidence: number; doubt: boolean } {
  const doubt = second !== undefined && second >= best - DOUBT_MARGIN;
  const base = Math.min(1, Math.max(0, (best / AUTO_MATCH_THRESHOLD) * THRESHOLDS.bankkoppeling));
  return { confidence: doubt ? base / 2 : base, doubt };
}

function nameSimilar(a: string | null, b: string | null): boolean {
  const compact = (s: string | null) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const x = compact(a);
  const y = compact(b);
  if (x.length < 3 || y.length < 3) return false;
  return x.includes(y) || y.includes(x);
}

/**
 * Matching-engine: koppelt banktransacties aan openstaande facturen op bedrag + referentie,
 * met als fallback een voorstel voor een grootboekrekening op basis van eerdere boekingen.
 */
export class MatchingEngine {
  constructor(
    private readonly bank: BankService,
    private readonly invoices: InvoiceService,
    private readonly purchases: PurchaseService,
    private readonly relations: RelationsService,
    /** een paar dat de gebruiker afwees ("Nee, iets anders") stelt de app niet opnieuw voor */
    private readonly rejected: (pair: Pair) => boolean = () => false,
  ) {}

  /**
   * `withRejected`: ook een aankoop waar de gebruiker bij deze betaling eerder "Nee" op zei. Alleen voor
   * het scherm van de betaling zelf: daar kan hij hem alsnog kiezen (een vergissing, of eerst willen
   * kijken). Vanzelf koppelen en de vragen op Vandaag slaan zo'n paar altijd over.
   */
  suggest(t: BankTransaction, openInvoices?: InvoiceSummary[], openPurchases?: PurchaseInvoice[], opts: { withRejected?: boolean } = {}): Suggestion[] {
    const text = `${t.description} ${t.reference ?? ''}`;
    const out: Suggestion[] = [];

    if (t.amount > 0) {
      for (const inv of openInvoices ?? this.invoices.listOpen()) {
        const reasons: string[] = [];
        let score = 0;
        if (inv.open_amount === t.amount) (score += 50, reasons.push('bedrag klopt'));
        else if (inv.total === t.amount) (score += 35, reasons.push('bedrag is gelijk aan het totaal van de factuur'));
        else if (t.amount < inv.open_amount && mentionsNumber(text, inv.number)) (score += 10, reasons.push('deel van het bedrag'));
        if (mentionsNumber(text, inv.number)) (score += 60, reasons.push(`factuurnummer ${inv.number} staat in de omschrijving`));
        const rel = this.relations.get(inv.relation_id);
        if (t.counter_iban && rel.iban && t.counter_iban === rel.iban) (score += 50, reasons.push('rekeningnummer van de klant'));
        else if (nameSimilar(t.counter_name, inv.relation_name)) (score += 15, reasons.push('naam lijkt op klant'));
        if (score >= 40) out.push({ kind: 'factuur', invoiceId: inv.id, label: `Factuur ${inv.number} — ${inv.relation_name} · ${formatEuro(inv.open_amount)} open, factuurdatum ${formatDateNl(inv.invoice_date)}`, score, reasons });
      }
    } else {
      for (const inv of openInvoices ?? this.invoices.listOpen()) {
        if (inv.open_amount >= 0 || !inv.credit_of_invoice_id) continue;
        const reasons: string[] = [];
        let score = 0;
        if (inv.open_amount === t.amount) (score += 50, reasons.push('terugbetaald bedrag klopt'));
        if (mentionsNumber(text, inv.number)) (score += 60, reasons.push(`creditnummer ${inv.number} staat in de omschrijving`));
        const rel = this.relations.get(inv.relation_id);
        if (t.counter_iban && rel.iban && t.counter_iban === rel.iban) (score += 50, reasons.push('rekeningnummer van de klant'));
        else if (nameSimilar(t.counter_name, inv.relation_name)) (score += 15, reasons.push('naam lijkt op klant'));
        if (score >= 40) out.push({ kind: 'factuur', invoiceId: inv.id, label: `Terugbetaling credit ${inv.number} — ${inv.relation_name} · ${formatEuro(-inv.open_amount)}`, score, reasons });
      }
    }
    // Een afschrijving bij een open aankoop; geld dat binnenkomt bij een open creditnota van een leverancier
    // (#227): dat is geen omzet, het sluit de creditnota af.
    const refund = t.amount > 0;
    for (const p of openPurchases ?? this.purchases.listOpen()) {
      if (refund ? p.open_amount >= 0 : p.open_amount <= 0) continue;
      const reasons: string[] = [];
      let score = 0;
      if (p.open_amount === -t.amount) (score += 50, reasons.push(refund ? 'terugbetaald bedrag klopt' : 'bedrag klopt'));
      // andere munt (#74): de bank rekende een eigen koers, dus ongeveer hetzelfde bedrag
      else if (p.currency && p.currency !== 'EUR' && withinFx(-t.amount, p.open_amount)) (score += 40, reasons.push(`bedrag klopt ongeveer (${p.currency}, andere koers)`));
      const amountFits = score > 0;
      if (p.supplier_reference && mentionsReference(text, p.supplier_reference)) (score += 60, reasons.push(refund ? 'nummer van de creditnota staat in de omschrijving' : 'factuurnummer staat in de omschrijving'));
      // Het rekeningnummer van de factuur (anders dat van de leverancier) telt zoals bij een klant, maar alleen
      // naast het bedrag en rond de datum van de aankoop. Daarbuiten weegt het als de naam: een oude open
      // aankoop met toevallig hetzelfde bedrag blijft een vraag.
      const sameAccount = Boolean(t.counter_iban) && sameIban(t.counter_iban, p.payee_iban ?? (p.relation_id ? this.relations.get(p.relation_id).iban : null));
      if (sameAccount && amountFits && dateFits(p, t.transaction_date)) (score += 50, reasons.push('rekeningnummer van de leverancier'));
      else if (sameAccount || supplierNameFit(t, p) === 'ja') (score += 20, reasons.push(sameAccount ? 'rekeningnummer van de leverancier' : 'naam van de leverancier'));
      // geld dat binnenkomt met alleen hetzelfde bedrag als een creditnota is te weinig: dat kan net zo goed
      // van een klant zijn
      if (score < (refund ? 60 : 50)) continue;
      if (this.rejected({ purchaseId: p.id, bankTransactionId: t.id })) {
        if (!opts.withRejected) continue;
        reasons.push('je koos eerder "Nee"');
      }
      const label = refund
        ? `Creditnota ${p.description}${p.relation_name ? ' — ' + p.relation_name : ''} · ${formatEuro(-p.open_amount)} terug te krijgen, ${formatDateNl(p.invoice_date)}`
        : `Aankoop ${p.description}${p.relation_name ? ' — ' + p.relation_name : ''} · ${formatEuro(p.open_amount)} open, ${formatDateNl(p.invoice_date)}`;
      out.push({ kind: 'inkoop', purchaseId: p.id, label, score, reasons });
    }

    const previous = this.bank.previousBooking(t);
    if (previous) out.push({ kind: 'rekening', account: previous.account, vatCode: previous.vatCode, label: 'Zelfde als vorige keer', score: 45, reasons: ['eerder zo gedaan'] });
    if (/belastingdienst/i.test(t.counter_name ?? '') || /omzetbelasting|btw/i.test(t.description)) {
      out.push({ kind: 'rekening', account: ACCOUNTS.btwAfrekening, vatCode: null, label: 'Btw betaald aan / terug van de Belastingdienst', score: 40, reasons: ['Belastingdienst'] });
    }
    const provider = t.amount > 0 ? paymentProviderIn(`${t.counter_name ?? ''} ${t.description}`) : null;
    if (provider) out.push({ kind: 'rekening', account: ACCOUNTS.kruisposten, vatCode: null, label: 'Uitbetaling betaalprovider', score: 60, reasons: [`uitbetaling ${provider}`] });
    if (/kosten.*(rekening|betaalpakket)|abonnementskosten|bankkosten|pakketkosten/i.test(t.description)) {
      out.push({ kind: 'rekening', account: ACCOUNTS.bankkosten, vatCode: 'geen', label: 'Bankkosten', score: 40, reasons: ['lijkt op bankkosten'] });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  /** Koppelt nieuwe transacties automatisch als er één duidelijke kandidaat is. */
  autoMatch(asOf: IsoDate = today(), level: AutopilotLevel = 'normaal'): { matched: number; details: { txId: number; label: string; reasons: string[]; confidence: number }[] } {
    const details: { txId: number; label: string; reasons: string[]; confidence: number }[] = [];
    const threshold = thresholdFor('bankkoppeling', level);
    // waarschijnlijk dezelfde betaling als een regel die er al staat (#225): niet vanzelf, eerst de melding
    const held = this.bank.heldAsDouble();
    for (const t of this.bank.list({ status: 'nieuw', limit: 5000 }).reverse()) {
      if (held.has(t.id)) continue;
      if (this.bank.ownTransferTarget(t)) continue; // eigen overboeking: nooit een factuur
      const suggestions = this.suggest(t, this.invoices.listOpen(asOf), this.purchases.listOpen()).filter((s) => s.kind !== 'rekening');
      const [best, second] = suggestions;
      if (!best) continue;
      const { confidence } = matchConfidence(best.score, second?.score);
      if (confidence < threshold) continue; // te weinig zeker of twijfel → gebruiker beslist
      try {
        if (best.kind === 'factuur') this.bank.matchInvoice(t.id, best.invoiceId);
        else if (best.kind === 'inkoop') this.bank.matchPurchase(t.id, best.purchaseId);
        details.push({ txId: t.id, label: best.label, reasons: best.reasons, confidence });
      } catch {
        // bv. periode afgesloten — laat staan voor handmatige verwerking
      }
    }
    return { matched: details.length, details };
  }
}
