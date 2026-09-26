/**
 * BTW-codes per regel. Het percentage wordt per regel opgeslagen (niet hardcoded op de factuur),
 * zodat tariefwijzigingen historische documenten niet raken.
 *
 * LET OP: deze tabel is onderdeel van de BTW-rekenlogica en moet vóór livegang gereviewd worden
 * door een boekhouder/fiscalist (zie GitHub-issue "BTW-logica laten reviewen").
 */
export type SalesVatCode = 'hoog' | 'laag' | 'nul' | 'verlegd' | 'vrijgesteld' | 'icp' | 'export';
/**
 * Inkoop. Verlegd = de btw wordt naar jou verlegd: je rekent zelf 21% uit, geeft die aan en trekt
 * hem tegelijk weer af (#16). 'verlegd' = Nederlandse leverancier (2a), 'eu' = leverancier in een
 * ander EU-land (4b, bv. Stripe, Google, Meta in Ierland), 'buiten-eu' = leverancier buiten de EU (4a).
 */
export type PurchaseVatCode = 'hoog' | 'laag' | 'nul' | 'verlegd' | 'eu' | 'buiten-eu' | 'geen';
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
  icp: { code: 'icp', label: 'Bedrijf in de EU (0%, ICP)', percentage: 0, rubriek: '3b' },
  export: { code: 'export', label: 'Uitvoer buiten de EU (0%)', percentage: 0, rubriek: '3a' },
};

export const PURCHASE_VAT_RATES: Record<PurchaseVatCode, VatRateInfo> = {
  hoog: { code: 'hoog', label: '21% (hoog)', percentage: 21, rubriek: '5b' },
  laag: { code: 'laag', label: '9% (laag)', percentage: 9, rubriek: '5b' },
  nul: { code: 'nul', label: '0%', percentage: 0, rubriek: '-' },
  verlegd: { code: 'verlegd', label: 'BTW verlegd naar mij', percentage: 21, rubriek: '2a' },
  eu: { code: 'eu', label: 'Verlegd, leverancier in de EU', percentage: 21, rubriek: '4b' },
  'buiten-eu': { code: 'buiten-eu', label: 'Verlegd, leverancier buiten de EU', percentage: 21, rubriek: '4a' },
  geen: { code: 'geen', label: 'Geen BTW', percentage: 0, rubriek: '-' },
};

export function isSalesVatCode(code: string): code is SalesVatCode {
  return code in SALES_VAT_RATES;
}

export function isPurchaseVatCode(code: string): code is PurchaseVatCode {
  return code in PURCHASE_VAT_RATES;
}

/** Verlegde inkoop: je betaalt de leverancier alleen netto en rekent de btw zelf af. */
export function isReverseCharge(code: string): code is 'verlegd' | 'eu' | 'buiten-eu' {
  return code === 'verlegd' || code === 'eu' || code === 'buiten-eu';
}

/** Verkoop waarbij het btw-nummer van de klant op de factuur moet staan. */
export function needsCustomerVatNumber(code: string): boolean {
  return code === 'verlegd' || code === 'icp';
}

/** Wettelijke vermelding op de factuur bij een intracommunautaire levering/dienst. */
export const ICP_TEXT = 'Intracommunautaire levering/dienst, btw verlegd (art. 138 / art. 196 Btw-richtlijn)';

/** Wettelijke vermelding op de factuur bij verlegde btw. */
export const VERLEGD_TEXT = 'BTW verlegd';
