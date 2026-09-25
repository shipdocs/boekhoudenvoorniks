import type { BankService, BankTransaction } from './bank';
import type { InvoiceService, InvoiceSummary } from '../documents/invoices';
import type { PurchaseService, PurchaseInvoice } from '../documents/purchases';
import type { RelationsService } from '../relations/relations';
import { ACCOUNTS } from '../core-ledger/accounts';
import { today, type IsoDate } from '../shared/dates';

export type Suggestion =
  | { kind: 'factuur'; invoiceId: number; label: string; score: number; reasons: string[] }
  | { kind: 'inkoop'; purchaseId: number; label: string; score: number; reasons: string[] }
  | { kind: 'rekening'; account: string; vatCode: string | null; label: string; score: number; reasons: string[] };

/** Score vanaf waar automatisch gekoppeld wordt (bedrag + factuurnummer, of bedrag + IBAN). */
export const AUTO_MATCH_THRESHOLD = 100;

function compact(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function mentions(haystack: string, number: string | null): boolean {
  if (!number) return false;
  const n = compact(number);
  if (n.length < 3) return false;
  const h = compact(haystack);
  if (h.includes(n)) return true;
  // "factuur 42" matcht "2026-0042": vergelijk ook het volgnummer zonder voorloopnullen
  const seq = /(\d+)$/.exec(number)?.[1]?.replace(/^0+/, '');
  const year = /(\d{4})/.exec(number)?.[1];
  if (seq && seq.length >= 2 && year) return new RegExp(`${year}\\D{0,3}0*${seq}(?!\\d)`).test(haystack.toLowerCase());
  return false;
}

function nameSimilar(a: string | null, b: string | null): boolean {
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
  ) {}

  suggest(t: BankTransaction, openInvoices?: InvoiceSummary[], openPurchases?: PurchaseInvoice[]): Suggestion[] {
    const text = `${t.description} ${t.reference ?? ''}`;
    const out: Suggestion[] = [];

    if (t.amount > 0) {
      for (const inv of openInvoices ?? this.invoices.listOpen()) {
        const reasons: string[] = [];
        let score = 0;
        if (inv.open_amount === t.amount) (score += 50, reasons.push('bedrag klopt'));
        else if (inv.total === t.amount) (score += 35, reasons.push('bedrag gelijk aan factuurtotaal'));
        else if (t.amount < inv.open_amount && mentions(text, inv.number)) (score += 10, reasons.push('deelbetaling'));
        if (mentions(text, inv.number)) (score += 60, reasons.push(`factuurnummer ${inv.number} in omschrijving`));
        const rel = this.relations.get(inv.relation_id);
        if (t.counter_iban && rel.iban && t.counter_iban === rel.iban) (score += 50, reasons.push('IBAN van klant'));
        else if (nameSimilar(t.counter_name, inv.relation_name)) (score += 15, reasons.push('naam lijkt op klant'));
        if (score >= 40) out.push({ kind: 'factuur', invoiceId: inv.id, label: `Factuur ${inv.number} — ${inv.relation_name}`, score, reasons });
      }
    } else {
      for (const p of openPurchases ?? this.purchases.listOpen()) {
        const reasons: string[] = [];
        let score = 0;
        if (p.open_amount === -t.amount) (score += 50, reasons.push('bedrag klopt'));
        if (p.supplier_reference && mentions(text, p.supplier_reference)) (score += 60, reasons.push('factuurnummer leverancier in omschrijving'));
        if (p.relation_name && nameSimilar(t.counter_name, p.relation_name)) (score += 20, reasons.push('naam leverancier'));
        if (score >= 50) out.push({ kind: 'inkoop', purchaseId: p.id, label: `Inkoop ${p.description}${p.relation_name ? ' — ' + p.relation_name : ''}`, score, reasons });
      }
    }

    const previous = this.bank.previousBooking(t);
    if (previous) out.push({ kind: 'rekening', account: previous.account, vatCode: previous.vatCode, label: 'Zelfde als vorige keer', score: 45, reasons: ['eerder zo geboekt'] });
    if (/belastingdienst/i.test(t.counter_name ?? '') || /omzetbelasting|btw/i.test(t.description)) {
      out.push({ kind: 'rekening', account: ACCOUNTS.btwAfrekening, vatCode: null, label: 'BTW-afdracht / teruggave', score: 40, reasons: ['Belastingdienst'] });
    }
    if (/mollie|stripe/i.test(`${t.counter_name ?? ''} ${t.description}`) && t.amount > 0) {
      out.push({ kind: 'rekening', account: ACCOUNTS.kruisposten, vatCode: null, label: 'Uitbetaling betaalprovider', score: 60, reasons: ['uitbetaling Mollie/Stripe'] });
    }
    if (/kosten.*(rekening|betaalpakket)|abonnementskosten|bankkosten|pakketkosten/i.test(t.description)) {
      out.push({ kind: 'rekening', account: ACCOUNTS.bankkosten, vatCode: 'geen', label: 'Bankkosten', score: 40, reasons: ['lijkt op bankkosten'] });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  /** Koppelt nieuwe transacties automatisch als er één duidelijke kandidaat is. */
  autoMatch(asOf: IsoDate = today()): { matched: number; details: { txId: number; label: string }[] } {
    const details: { txId: number; label: string }[] = [];
    for (const t of this.bank.list({ status: 'nieuw', limit: 5000 }).reverse()) {
      const suggestions = this.suggest(t, this.invoices.listOpen(asOf), this.purchases.listOpen()).filter((s) => s.kind !== 'rekening');
      const [best, second] = suggestions;
      if (!best || best.score < AUTO_MATCH_THRESHOLD) continue;
      if (second && second.score >= best.score - 30) continue; // twijfel → gebruiker beslist
      try {
        if (best.kind === 'factuur') this.bank.matchInvoice(t.id, best.invoiceId);
        else if (best.kind === 'inkoop') this.bank.matchPurchase(t.id, best.purchaseId);
        details.push({ txId: t.id, label: best.label });
      } catch {
        // bv. periode afgesloten — laat staan voor handmatige verwerking
      }
    }
    return { matched: details.length, details };
  }
}
