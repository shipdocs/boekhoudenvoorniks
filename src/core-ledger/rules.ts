import { compile as compileLegacy } from './rules-2026-2';
import { RULES_VERSION } from './rules-version';
import { ACCOUNTS, REVERSE_CHARGE_ACCOUNTS, SALES_ACCOUNTS } from './accounts';
import { signedLine, type EntrySource, type PostLine } from './ledger';
import { PURCHASE_VAT_RATES, SALES_VAT_RATES, isPurchaseVatCode, isReverseCharge, isSalesVatCode, type PurchaseVatCode } from '../shared/vat';
import { assertCents, roundHalfAwayFromZero, type Cents } from '../shared/money';
import { shareOf } from '../shared/business-share';
import type { IsoDate } from '../shared/dates';
import { ValidationError } from '../shared/validation';
import type { AccountCategory } from './accounts';

/**
 * Boekingsregels (#19): van gebeurtenis naar journaalregels. Puur (geen database), deterministisch
 * en geversioneerd (RULES_VERSION). Dezelfde gebeurtenis levert met dezelfde versie altijd
 * exact dezelfde regels op; daardoor kan een gecorrigeerde gebeurtenis opnieuw "gecompileerd"
 * worden (tegenboeking van de oude post + nieuwe post).
 */

/**
 * Btw-code op de kostenregel met niet-aftrekbare btw (KOR). Staat direct na de regel waar hij bij
 * hoort; telt niet mee in de grondslag van een rubriek, wel in de kostprijs van een bedrijfsmiddel.
 */
export const NON_DEDUCTIBLE_VAT = 'niet-aftrekbaar';

export interface PurchaseLineInput {
  /** RGS-code van de kostenrekening (of activa bij investering) */
  account: string;
  description?: string | null;
  /** bedrag exclusief BTW */
  netAmount: Cents;
  vatCode: PurchaseVatCode;
  /** optioneel afwijkend BTW-bedrag (zoals op de bon); anders berekend */
  vatAmount?: Cents;
}

/**
 * Zakelijk deel van een uitgave in procenten. Leeg of 100 = alles zakelijk (standaard). Het privédeel
 * van een uitgave telt niet als kosten en de btw daarover mag je niet aftrekken.
 */
export function businessPct(pct: number | null | undefined): number {
  if (pct === undefined || pct === null) return 100;
  if (!Number.isInteger(pct) || pct < 1 || pct > 100) throw new ValidationError('Het zakelijke deel moet een heel percentage tussen 1 en 100 zijn');
  return pct;
}

/** Berekent de BTW op een inkoopregel. Bij verlegd is de BTW wel te berekenen maar niet te betalen aan de leverancier. */
export function purchaseVat(line: PurchaseLineInput): Cents {
  if (!isPurchaseVatCode(line.vatCode)) throw new ValidationError('Kies een btw-tarief');
  if (line.vatAmount !== undefined) {
    assertCents(line.vatAmount, 'btw-bedrag');
    if (PURCHASE_VAT_RATES[line.vatCode].percentage === 0 && line.vatAmount !== 0) throw new ValidationError('Bij geen btw of 0% hoort geen btw-bedrag');
    if ((line.netAmount >= 0 && line.vatAmount < 0) || (line.netAmount <= 0 && line.vatAmount > 0)) throw new ValidationError('Het btw-bedrag moet hetzelfde teken hebben als het bedrag exclusief btw');
    const max = roundHalfAwayFromZero(Math.abs(line.netAmount) * PURCHASE_VAT_RATES[line.vatCode].percentage / 100);
    if (Math.abs(line.vatAmount) > max + 2) throw new ValidationError('Het btw-bedrag is hoger dan het gekozen tarief toelaat');
    return line.vatAmount;
  }
  return roundHalfAwayFromZero((line.netAmount * PURCHASE_VAT_RATES[line.vatCode].percentage) / 100);
}

/**
 * Journaalregels voor kosten met BTW. Wordt ook gebruikt voor het direct boeken van
 * banktransacties op een kostenrekening.
 *   - hoog/laag: kosten (netto) + voorbelasting aan crediteur/bank (bruto)
 *   - verlegd/eu/buiten-eu: kosten (netto) + voorbelasting aan af te dragen btw verlegd; crediteur/bank alleen netto
 *   - nul/geen:  alleen kosten
 *
 * `noVatDeduction` (KOR): geen recht op aftrek. De btw komt dan niet op voorbelasting maar bij de
 * kosten of de kostprijs van het bedrijfsmiddel (aparte regel zonder btw-code, zodat de grondslag
 * van 2a/4a/4b netto blijft). Verlegde btw blijft verschuldigd.
 * Retourneert de regels en het bedrag dat daadwerkelijk betaald wordt.
 */
export function expenseLines(lines: PurchaseLineInput[], counterAccount: string, relationId: number | null, description?: string, opts: { noVatDeduction?: boolean; businessPct?: number } = {}): { lines: PostLine[]; payable: Cents; vat: Cents; net: Cents } {
  const out: (PostLine | null)[] = [];
  let payable = 0;
  let vatTotal = 0;
  let netTotal = 0;
  const pct = businessPct(opts.businessPct);
  // zakelijk deel van een bedrag; 100% laat het bedrag ongemoeid
  const biz = (n: Cents): Cents => shareOf(n, pct);
  for (const l of lines) {
    assertCents(l.netAmount, 'bedrag');
    if (!isPurchaseVatCode(l.vatCode)) throw new ValidationError('Kies een btw-tarief');
    const fullVat = purchaseVat(l);
    const netBiz = biz(l.netAmount);
    const vat = biz(fullVat);
    // het privédeel telt niet als kosten en heeft geen btw-aftrek: het gaat naar de privé-opnamen
    const privateShare = l.netAmount - netBiz + (isReverseCharge(l.vatCode) ? 0 : fullVat - vat);
    netTotal += netBiz;
    out.push(signedLine(l.account, netBiz, { relationId, vatCode: l.vatCode, description: l.description ?? null }));
    if (privateShare !== 0) {
      out.push(signedLine(ACCOUNTS.priveOpnamen, privateShare, { relationId, ...(isReverseCharge(l.vatCode) ? { vatCode: l.vatCode } : {}), description: `Privédeel (${100 - pct}%)${l.description ? `: ${l.description}` : ''}` }));
      payable += privateShare;
    }
    if (vat !== 0) {
      out.push(
        opts.noVatDeduction
          ? signedLine(l.account, vat, { relationId, vatCode: NON_DEDUCTIBLE_VAT, description: `Niet-aftrekbare btw${l.description ? `: ${l.description}` : ''}` })
          : signedLine(ACCOUNTS.btwVoorbelasting, vat, { relationId, vatCode: l.vatCode }),
      );
      vatTotal += vat;
    }
    if (isReverseCharge(l.vatCode) && fullVat !== vat) out.push(signedLine(ACCOUNTS.priveOpnamen, fullVat - vat, { relationId, description: 'Niet-aftrekbare verlegde btw privédeel' }));
    if (isReverseCharge(l.vatCode) && fullVat !== 0) out.push(signedLine(REVERSE_CHARGE_ACCOUNTS[l.vatCode], -fullVat, { relationId, vatCode: l.vatCode }));
    payable += netBiz + (isReverseCharge(l.vatCode) ? 0 : vat);
  }
  out.push(signedLine(counterAccount, -payable, { relationId, description: description ?? null }));
  return { lines: out.filter((l): l is PostLine => l !== null), payable, vat: vatTotal, net: netTotal };
}


/**
 * Splitst een bruto bedrag (incl. BTW) in netto + BTW.
 * Bij verlegde btw is het betaalde bedrag al netto; de BTW wordt dan berekend over het netto bedrag.
 */
export function splitGross(gross: Cents, percentage: number, verlegd = false): { net: Cents; vat: Cents } {
  if (verlegd) return { net: gross, vat: roundHalfAwayFromZero((gross * percentage) / 100) };
  if (percentage === 0) return { net: gross, vat: 0 };
  const net = roundHalfAwayFromZero((gross * 100) / (100 + percentage));
  return { net, vat: gross - net };
}

/** Een expliciete boeking (handmatig, of uit de backfill van vóór het gebeurtenissenmodel). */
export interface BoekingPayload {
  date: IsoDate;
  description: string;
  source: EntrySource;
  sourceRef?: string | null;
  lines: PostLine[];
}

/** Een banktransactie die rechtstreeks op een categorie is geboekt ("Shell → brandstof"). */
export interface BankCategoriePayload {
  bankTransactionId: number;
  date: IsoDate;
  /** bedrag van de transactie: negatief = uitgave */
  amount: Cents;
  /** interne sleutel van de bankrekening in het grootboek */
  bankAccount: string;
  /** interne sleutel en soort van de rekening waarop geboekt wordt */
  account: string;
  accountCategory: AccountCategory;
  vatCode: string;
  relationId: number | null;
  description: string;
  /** verkoop via een ander systeem: de naam die de gebruiker gaf, bv. "Mollie" of "webshop" */
  channel?: string | null;
  /** geen recht op aftrek van voorbelasting (KOR) op het moment van boeken */
  noVatDeduction?: boolean;
  /** zakelijk deel in procenten (1–99); ontbreekt = 100. De rest gaat naar privé. */
  businessPct?: number;
}

/** Een inkoopfactuur of bonnetje. */
export interface InkoopPayload {
  purchaseId: number;
  date: IsoDate;
  description: string;
  relationId: number | null;
  supplierReference: string | null;
  lines: PurchaseLineInput[];
  /** geen recht op aftrek van voorbelasting (KOR) op het moment van boeken */
  noVatDeduction?: boolean;
  /** zakelijk deel in procenten (1–99); ontbreekt = 100. De rest gaat naar privé. */
  businessPct?: number;
}

export type DomainEvent =
  | { type: 'boeking'; payload: BoekingPayload }
  | { type: 'bank-categorie'; payload: BankCategoriePayload }
  | { type: 'inkoop'; payload: InkoopPayload };

export interface CompiledEntry {
  date: IsoDate;
  description: string;
  source: EntrySource;
  sourceRef: string | null;
  lines: PostLine[];
}

export function compile(event: DomainEvent, version = RULES_VERSION): CompiledEntry {
  if (version === '2026.1' || version === '2026.2') return compileLegacy(event);
  if (version !== RULES_VERSION && event.type !== 'boeking') throw new ValidationError('Onbekende versie van de boekingsregels');
  switch (event.type) {
    case 'boeking': {
      const p = event.payload;
      return { date: p.date, description: p.description, source: p.source, sourceRef: p.sourceRef ?? null, lines: p.lines };
    }
    case 'inkoop': {
      const p = event.payload;
      const booking = expenseLines(p.lines, ACCOUNTS.crediteuren, p.relationId, p.supplierReference ?? undefined, { noVatDeduction: p.noVatDeduction, businessPct: p.businessPct });
      return { date: p.date, description: `Inkoop: ${p.description.trim()}`, source: 'inkoop', sourceRef: `purchase:${p.purchaseId}`, lines: booking.lines };
    }
    case 'bank-categorie':
      return { date: event.payload.date, description: event.payload.description, source: 'bank', sourceRef: `bank:${event.payload.bankTransactionId}`, lines: bankCategoryLines(event.payload) };
  }
}

/** Banktransactie direct op een rekening, inclusief btw-splitsing. */
export function bankCategoryLines(p: BankCategoriePayload): PostLine[] {
  const vatCode = p.vatCode;
  if (p.accountCategory === 'kosten' || (p.accountCategory === 'activa' && (p.amount < 0 || p.account === ACCOUNTS.inventaris || p.account === ACCOUNTS.vervoermiddelen))) {
    if (!isPurchaseVatCode(vatCode)) throw new ValidationError('Kies een ander btw-tarief');
    const rate = PURCHASE_VAT_RATES[vatCode];
    // een negatieve transactie is een uitgave; een positieve op een kostenrekening is een terugbetaling
    const gross = -p.amount;
    const { net, vat } = splitGross(gross, rate.percentage, isReverseCharge(vatCode));
    return expenseLines([{ account: p.account, netAmount: net, vatCode, vatAmount: vat, description: p.description }], p.bankAccount, p.relationId, p.description, { noVatDeduction: p.noVatDeduction, businessPct: p.businessPct }).lines;
  }
  if (p.accountCategory === 'omzet') {
    if (!isSalesVatCode(vatCode)) throw new ValidationError('Kies een ander btw-tarief');
    const { net, vat } = splitGross(p.amount, SALES_VAT_RATES[vatCode].percentage);
    const vatAccount = SALES_ACCOUNTS[vatCode]?.vat;
    return [
      signedLine(p.bankAccount, p.amount),
      signedLine(SALES_ACCOUNTS[vatCode]?.revenue ?? p.account, -net, { relationId: p.relationId, vatCode }),
      vat !== 0 && vatAccount ? signedLine(vatAccount, -vat, { relationId: p.relationId, vatCode }) : null,
    ].filter((l): l is PostLine => l !== null);
  }
  // privé, btw-afdracht, kruisposten, leningen: geen BTW
  return [signedLine(p.bankAccount, p.amount)!, signedLine(p.account, -p.amount, { relationId: p.relationId, description: p.description })!];
}
