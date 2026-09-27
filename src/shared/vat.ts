import { normalizeVatNumber } from './validation';

/**
 * BTW-codes per regel. Het percentage wordt per regel opgeslagen (niet hardcoded op de factuur),
 * zodat tariefwijzigingen historische documenten niet raken.
 *
 * LET OP: deze tabel is onderdeel van de BTW-rekenlogica en moet vóór livegang gereviewd worden
 * door een boekhouder/fiscalist (zie GitHub-issue "BTW-logica laten reviewen").
 */
/**
 * Buitenland (fiscale review): 'icp' = levering van goederen aan een bedrijf in een ander EU-land
 * (art. 138), 'icp-dienst' = dienst aan een bedrijf in een ander EU-land (art. 44/196, verlegd); beide
 * 3b, maar apart in de ICP-opgaaf. 'export' = uitvoer van goederen buiten de EU (3a).
 * 'dienst-buiten-eu' = dienst aan een bedrijf buiten de EU: niet in Nederland belast en niet in de aangifte.
 */
export type SalesVatCode = 'hoog' | 'laag' | 'nul' | 'verlegd' | 'vrijgesteld' | 'icp' | 'icp-dienst' | 'export' | 'dienst-buiten-eu';
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
  /** keuze in gewone taal in de app (het `label` komt op de factuur) */
  pickLabel?: string;
  /** Rubriek op de BTW-aangifte waar de omzet (en evt. btw) in valt. */
  rubriek: string;
}

export const SALES_VAT_RATES: Record<SalesVatCode, VatRateInfo> = {
  hoog: { code: 'hoog', label: '21% (hoog)', percentage: 21, rubriek: '1a' },
  laag: { code: 'laag', label: '9% (laag)', percentage: 9, rubriek: '1b' },
  nul: { code: 'nul', label: '0%', percentage: 0, rubriek: '1e' },
  verlegd: { code: 'verlegd', label: 'BTW verlegd', pickLabel: 'Btw verlegd (je werkt als onderaannemer; je klant regelt de btw)', percentage: 0, rubriek: '1e' },
  vrijgesteld: { code: 'vrijgesteld', label: 'Vrijgesteld / KOR', pickLabel: 'Geen btw (vrijgesteld of KOR)', percentage: 0, rubriek: '-' },
  icp: { code: 'icp', label: 'Intracommunautaire levering (0%)', pickLabel: 'Goederen naar een bedrijf in een ander EU-land (0%)', percentage: 0, rubriek: '3b' },
  'icp-dienst': { code: 'icp-dienst', label: 'Btw verlegd (dienst EU)', pickLabel: 'Dienst aan een bedrijf in een ander EU-land (btw verlegd)', percentage: 0, rubriek: '3b' },
  export: { code: 'export', label: 'Uitvoer goederen buiten de EU (0%)', pickLabel: 'Goederen naar een klant buiten de EU (0%)', percentage: 0, rubriek: '3a' },
  'dienst-buiten-eu': { code: 'dienst-buiten-eu', label: 'Niet belast in Nederland', pickLabel: 'Dienst aan een bedrijf buiten de EU (niet in de aangifte)', percentage: 0, rubriek: '-' },
};

export const PURCHASE_VAT_RATES: Record<PurchaseVatCode, VatRateInfo> = {
  hoog: { code: 'hoog', label: '21% (hoog)', percentage: 21, rubriek: '5b' },
  laag: { code: 'laag', label: '9% (laag)', percentage: 9, rubriek: '5b' },
  nul: { code: 'nul', label: '0%', percentage: 0, rubriek: '-' },
  verlegd: { code: 'verlegd', label: 'Btw verlegd naar mij (onderaannemer, geen btw op de factuur)', percentage: 21, rubriek: '2a' },
  eu: { code: 'eu', label: 'Buitenlandse leverancier in de EU, geen btw op de factuur (bv. Google, Meta)', percentage: 21, rubriek: '4b' },
  'buiten-eu': { code: 'buiten-eu', label: 'Leverancier buiten de EU, geen btw op de factuur', percentage: 21, rubriek: '4a' },
  geen: { code: 'geen', label: 'Geen btw', percentage: 0, rubriek: '-' },
};

export function isSalesVatCode(code: string): code is SalesVatCode {
  // hasOwn: 'toString' e.d. van het prototype tellen niet als btw-code
  return typeof code === 'string' && Object.hasOwn(SALES_VAT_RATES, code);
}

export function isPurchaseVatCode(code: string): code is PurchaseVatCode {
  return typeof code === 'string' && Object.hasOwn(PURCHASE_VAT_RATES, code);
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
  return code === 'verlegd' || isIcp(code);
}

/** Intracommunautaire prestatie (goederen of dienst): rubriek 3b en de ICP-opgaaf. */
export function isIcp(code: string): code is 'icp' | 'icp-dienst' {
  return code === 'icp' || code === 'icp-dienst';
}

/** Klant buiten de EU (goederen of dienst). */
export function isOutsideEu(code: string): code is 'export' | 'dienst-buiten-eu' {
  return code === 'export' || code === 'dienst-buiten-eu';
}

/** Drempel voor verkoop aan particulieren in andere EU-landen; daarboven btw van het land van de klant (OSS). */
export const EU_B2C_THRESHOLD = 10_000_00;

export type CustomerVatSituation = 'nl' | 'eu-bedrijf' | 'eu-particulier' | 'buiten-eu' | 'onbekend';

/** Waar een klant woont, voor de btw op de factuur. */
export function customerVatSituation(country: string | null | undefined, vatNumber: string | null | undefined): CustomerVatSituation {
  const c = countryCode(country ?? 'NL');
  if (!c) return 'onbekend';
  if (c === 'NL') return 'nl';
  if (EU_COUNTRIES.has(c)) return vatNumber && vatNumber.trim() ? 'eu-bedrijf' : 'eu-particulier';
  return 'buiten-eu';
}

/** Past een btw-nummer bij dit land? (het nummer begint met de landcode; Griekenland: EL) */
export function vatNumberMatchesCountry(vatNumber: string | null | undefined, country: string | null | undefined): boolean {
  const prefix = normalizeVatNumber(vatNumber ?? '').slice(0, 2);
  return !!prefix && countryCode(prefix) === countryCode(country ?? 'NL');
}

/**
 * Welke btw-keuze meestal hoort bij deze klant (null = gewoon Nederlandse btw). De doelgroep levert
 * vooral diensten; verkoop je goederen, dan kies je zelf de goederenvariant.
 */
export function suggestedSalesVat(situation: CustomerVatSituation): SalesVatCode | null {
  return situation === 'eu-bedrijf' ? 'icp-dienst' : situation === 'buiten-eu' ? 'dienst-buiten-eu' : null;
}

/** Wettelijke vermelding op de factuur bij een intracommunautaire levering van goederen. */
export const ICP_TEXT = 'Intracommunautaire levering, vrijgesteld van btw (art. 138 Btw-richtlijn)';
/** Wettelijke vermelding op de factuur bij een dienst aan een bedrijf in een ander EU-land. */
export const ICP_SERVICE_TEXT = 'Btw verlegd (reverse charge, art. 196 Btw-richtlijn)';
/** Vermelding bij een dienst aan een bedrijf buiten de EU. */
export const OUTSIDE_EU_SERVICE_TEXT = 'Dienst niet belast in Nederland (plaats van dienst buiten de EU)';

/** Wettelijke vermelding op de factuur bij verlegde btw. */
export const VERLEGD_TEXT = 'BTW verlegd';

/** Kort in gewone taal, voor een vraag als "net als vorige keer (…)?" */
export function saleVatText(code: SalesVatCode): string {
  return ({
    hoog: '21% btw',
    laag: '9% btw',
    nul: '0% btw',
    verlegd: 'btw verlegd',
    vrijgesteld: 'geen btw',
    icp: 'goederen naar een bedrijf in de EU, 0% btw',
    'icp-dienst': 'dienst aan een bedrijf in de EU, btw verlegd',
    export: 'goederen naar buiten de EU, 0% btw',
    'dienst-buiten-eu': 'dienst aan een bedrijf buiten de EU, geen Nederlandse btw',
  } as Record<SalesVatCode, string>)[code];
}
