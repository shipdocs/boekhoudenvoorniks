/**
 * BTW-codes per regel. Het percentage wordt per regel opgeslagen (niet hardcoded op de factuur),
 * zodat tariefwijzigingen historische documenten niet raken.
 *
 * LET OP: deze tabel is onderdeel van de BTW-rekenlogica en moet vóór livegang gereviewd worden
 * door een boekhouder/fiscalist (zie GitHub-issue "BTW-logica laten reviewen").
 */
export type SalesVatCode = 'hoog' | 'laag' | 'nul' | 'verlegd' | 'vrijgesteld';
export type PurchaseVatCode = 'hoog' | 'laag' | 'nul' | 'verlegd' | 'geen';
export type VatCode = SalesVatCode | PurchaseVatCode;

export interface VatRateInfo {
  code: VatCode;
  label: string;
  percentage: number;
  /** Rubriek op de BTW-aangifte waar de omzet (en evt. btw) in valt. */
  rubriek: string;
}

export const SALES_VAT_RATES: Record<SalesVatCode, VatRateInfo> = {
  hoog: { code: 'hoog', label: '21% (hoog)', percentage: 21, rubriek: '1a' },
  laag: { code: 'laag', label: '9% (laag)', percentage: 9, rubriek: '1b' },
  nul: { code: 'nul', label: '0%', percentage: 0, rubriek: '1e' },
  verlegd: { code: 'verlegd', label: 'BTW verlegd', percentage: 0, rubriek: '1e' },
  vrijgesteld: { code: 'vrijgesteld', label: 'Vrijgesteld / KOR', percentage: 0, rubriek: '-' },
};

export const PURCHASE_VAT_RATES: Record<PurchaseVatCode, VatRateInfo> = {
  hoog: { code: 'hoog', label: '21% (hoog)', percentage: 21, rubriek: '5b' },
  laag: { code: 'laag', label: '9% (laag)', percentage: 9, rubriek: '5b' },
  nul: { code: 'nul', label: '0%', percentage: 0, rubriek: '-' },
  verlegd: { code: 'verlegd', label: 'BTW verlegd naar mij', percentage: 21, rubriek: '2a' },
  geen: { code: 'geen', label: 'Geen BTW', percentage: 0, rubriek: '-' },
};

export function isSalesVatCode(code: string): code is SalesVatCode {
  return code in SALES_VAT_RATES;
}

export function isPurchaseVatCode(code: string): code is PurchaseVatCode {
  return code in PURCHASE_VAT_RATES;
}

/** Wettelijke vermelding op de factuur bij verlegde btw. */
export const VERLEGD_TEXT = 'BTW verlegd';
