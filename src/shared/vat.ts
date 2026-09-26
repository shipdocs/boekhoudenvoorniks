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

/** EU-lidstaten (landcode zoals in adressen en IBAN; Griekenland = GR, in btw-nummers EL). */
export const EU_COUNTRIES = new Set(['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK']);

/** Genormaliseerde landcode (2 letters, hoofdletters) of null als het geen geldige code is. */
export function countryCode(input: string | null | undefined): string | null {
  const c = (input ?? '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(c) ? (c === 'EL' ? 'GR' : c) : null;
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
