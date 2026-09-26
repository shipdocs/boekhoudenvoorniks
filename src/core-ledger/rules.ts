import { ACCOUNTS, REVERSE_CHARGE_ACCOUNTS, SALES_ACCOUNTS } from './accounts';
import { signedLine, type EntrySource, type PostLine } from './ledger';
import { PURCHASE_VAT_RATES, SALES_VAT_RATES, isPurchaseVatCode, isReverseCharge, isSalesVatCode, type PurchaseVatCode } from '../shared/vat';
import { assertCents, roundHalfAwayFromZero, type Cents } from '../shared/money';
import type { IsoDate } from '../shared/dates';
import { ValidationError } from '../shared/validation';
import type { AccountCategory } from './accounts';

/**
 * Boekingsregels (#19): van gebeurtenis naar journaalregels. Puur (geen database), deterministisch
 * en geversioneerd (RULES_VERSION). Dezelfde gebeurtenis levert met dezelfde versie altijd
 * exact dezelfde regels op; daardoor kan een gecorrigeerde gebeurtenis opnieuw "gecompileerd"
 * worden (tegenboeking van de oude post + nieuwe post).
 */

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

/** Berekent de BTW op een inkoopregel. Bij verlegd is de BTW wel te berekenen maar niet te betalen aan de leverancier. */
export function purchaseVat(line: PurchaseLineInput): Cents {
  if (line.vatAmount !== undefined) return line.vatAmount;
  return roundHalfAwayFromZero((line.netAmount * PURCHASE_VAT_RATES[line.vatCode].percentage) / 100);
}

/**
 * Journaalregels voor kosten met BTW. Wordt ook gebruikt voor het direct boeken van
 * banktransacties op een kostenrekening.
 *   - hoog/laag: kosten (netto) + voorbelasting aan crediteur/bank (bruto)
 *   - verlegd/eu/buiten-eu: kosten (netto) + voorbelasting aan af te dragen btw verlegd; crediteur/bank alleen netto
 *   - nul/geen:  alleen kosten
 * Retourneert de regels en het bedrag dat daadwerkelijk betaald wordt.
 */
export function expenseLines(lines: PurchaseLineInput[], counterAccount: string, relationId: number | null, description?: string): { lines: PostLine[]; payable: Cents; vat: Cents; net: Cents } {
  const out: (PostLine | null)[] = [];
  let payable = 0;
  let vatTotal = 0;
  let netTotal = 0;
  for (const l of lines) {
    assertCents(l.netAmount, 'bedrag');
    if (!(l.vatCode in PURCHASE_VAT_RATES)) throw new ValidationError(`Onbekende BTW-code ${l.vatCode}`);
    const vat = purchaseVat(l);
    netTotal += l.netAmount;
    out.push(signedLine(l.account, l.netAmount, { relationId, vatCode: l.vatCode, description: l.description ?? null }));
    if (vat !== 0) {
      out.push(signedLine(ACCOUNTS.btwVoorbelasting, vat, { relationId, vatCode: l.vatCode }));
      vatTotal += vat;
      if (isReverseCharge(l.vatCode)) {
        out.push(signedLine(REVERSE_CHARGE_ACCOUNTS[l.vatCode], -vat, { relationId, vatCode: l.vatCode }));
      }
    }
    payable += l.netAmount + (isReverseCharge(l.vatCode) ? 0 : vat);
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
}

/** Een inkoopfactuur of bonnetje. */
export interface InkoopPayload {
  purchaseId: number;
  date: IsoDate;
  description: string;
  relationId: number | null;
  supplierReference: string | null;
  lines: PurchaseLineInput[];
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

export function compile(event: DomainEvent): CompiledEntry {
  switch (event.type) {
    case 'boeking': {
      const p = event.payload;
      return { date: p.date, description: p.description, source: p.source, sourceRef: p.sourceRef ?? null, lines: p.lines };
    }
    case 'inkoop': {
      const p = event.payload;
      const booking = expenseLines(p.lines, ACCOUNTS.crediteuren, p.relationId, p.supplierReference ?? undefined);
      return { date: p.date, description: `Inkoop: ${p.description.trim()}`, source: 'inkoop', sourceRef: `purchase:${p.purchaseId}`, lines: booking.lines };
    }
    case 'bank-categorie':
      return { date: event.payload.date, description: event.payload.description, source: 'bank', sourceRef: `bank:${event.payload.bankTransactionId}`, lines: bankCategoryLines(event.payload) };
  }
}

/** Banktransactie direct op een rekening, inclusief btw-splitsing. */
export function bankCategoryLines(p: BankCategoriePayload): PostLine[] {
  const vatCode = p.vatCode;
  if (p.accountCategory === 'kosten' || (p.accountCategory === 'activa' && p.amount < 0)) {
    if (!isPurchaseVatCode(vatCode)) throw new ValidationError(`Ongeldige BTW-keuze voor kosten: ${vatCode}`);
    const rate = PURCHASE_VAT_RATES[vatCode];
    // een negatieve transactie is een uitgave; een positieve op een kostenrekening is een terugbetaling
    const gross = -p.amount;
    const { net, vat } = splitGross(gross, rate.percentage, isReverseCharge(vatCode));
    return expenseLines([{ account: p.account, netAmount: net, vatCode, vatAmount: vat, description: p.description }], p.bankAccount, p.relationId, p.description).lines;
  }
  if (p.accountCategory === 'omzet') {
    if (!isSalesVatCode(vatCode)) throw new ValidationError(`Ongeldige BTW-keuze voor omzet: ${vatCode}`);
    const { net, vat } = splitGross(p.amount, SALES_VAT_RATES[vatCode].percentage);
    const vatAccount = SALES_ACCOUNTS[vatCode]?.vat;
    return [
      signedLine(p.bankAccount, p.amount),
      signedLine(p.account, -net, { relationId: p.relationId, vatCode }),
      vat !== 0 && vatAccount ? signedLine(vatAccount, -vat, { relationId: p.relationId, vatCode }) : null,
    ].filter((l): l is PostLine => l !== null);
  }
  // privé, btw-afdracht, kruisposten, leningen: geen BTW
  return [signedLine(p.bankAccount, p.amount)!, signedLine(p.account, -p.amount, { relationId: p.relationId, description: p.description })!];
}
