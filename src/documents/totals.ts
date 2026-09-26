import { roundHalfAwayFromZero, type Cents } from '../shared/money';
import { SALES_VAT_RATES, type SalesVatCode } from '../shared/vat';

export interface LineInput {
  description: string;
  quantity: number;
  unit?: string | null;
  /** prijs per eenheid exclusief BTW, in centen */
  unitPrice: Cents;
  vatCode: SalesVatCode;
  /** optioneel: wordt anders afgeleid uit vatCode */
  vatPercentage?: number;
}

export interface VatGroup {
  vatCode: SalesVatCode;
  percentage: number;
  label: string;
  net: Cents;
  vat: Cents;
}

export interface DocumentTotals {
  lines: { net: Cents }[];
  groups: VatGroup[];
  subtotal: Cents;
  vatTotal: Cents;
  total: Cents;
}

export function lineNet(line: Pick<LineInput, 'quantity' | 'unitPrice'>): Cents {
  return roundHalfAwayFromZero(line.quantity * line.unitPrice);
}

/**
 * Berekent totalen. BTW wordt per tarief berekend over de som van de regelbedragen
 * (niet per regel afgerond en dan opgeteld) — zo ontstaan geen afrondingsverschillen
 * tussen factuur en aangifte.
 */
export function computeTotals(lines: LineInput[]): DocumentTotals {
  const groups = new Map<string, VatGroup>();
  const lineTotals = lines.map((l) => {
    const net = lineNet(l);
    const percentage = l.vatPercentage ?? SALES_VAT_RATES[l.vatCode].percentage;
    const key = `${l.vatCode}:${percentage}`;
    const g = groups.get(key) ?? { vatCode: l.vatCode, percentage, label: SALES_VAT_RATES[l.vatCode].label, net: 0, vat: 0 };
    g.net += net;
    groups.set(key, g);
    return { net };
  });
  for (const g of groups.values()) g.vat = roundHalfAwayFromZero((g.net * g.percentage) / 100);
  const sorted = [...groups.values()].sort((a, b) => b.percentage - a.percentage || a.vatCode.localeCompare(b.vatCode));
  const subtotal = sorted.reduce((s, g) => s + g.net, 0);
  const vatTotal = sorted.reduce((s, g) => s + g.vat, 0);
  return { lines: lineTotals, groups: sorted, subtotal, vatTotal, total: subtotal + vatTotal };
}

export function validateLines(lines: LineInput[]): void {
  if (lines.length === 0) throw new Error('Voeg minimaal één regel toe');
  for (const [i, l] of lines.entries()) {
    if (!l.description?.trim()) throw new Error(`Regel ${i + 1}: omschrijving ontbreekt`);
    if (!Number.isFinite(l.quantity) || l.quantity === 0) throw new Error(`Regel ${i + 1}: aantal is ongeldig`);
    if (!Number.isSafeInteger(l.unitPrice)) throw new Error(`Regel ${i + 1}: prijs is ongeldig`);
    if (!(l.vatCode in SALES_VAT_RATES)) throw new Error(`Regel ${i + 1}: kies een btw-tarief`);
  }
}
