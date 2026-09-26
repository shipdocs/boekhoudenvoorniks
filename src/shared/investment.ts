import type { Cents } from './money';
import { PURCHASE_VAT_RATES, type PurchaseVatCode } from './vat';

/**
 * Wanneer is een aankoop een investering (bedrijfsmiddel)? Vanaf € 450 excl. btw per stuk, als het
 * langer dan een jaar meegaat. Alleen voorgesteld bij categorieën waar dat vaak gebeurt; de gebruiker
 * beslist altijd zelf. Gedeeld tussen scherm (hint bij invoer) en server (taak op Vandaag).
 */
export const INVESTMENT_THRESHOLD: Cents = 450_00;

/** Categorieën waarin een aankoop ≥ € 450 vaak eigenlijk een investering is. */
export const INVESTMENT_CANDIDATES = ['gereedschap', 'kantoor', 'telefoon', 'auto', 'overig'];

/** Grootboekrekeningen van die categorieën (voor de controle achteraf). */
export const INVESTMENT_CANDIDATE_ACCOUNTS = ['WBedAlkGer', 'WBedKanKan', 'WBedKanTel', 'WBedAutOnd', 'WBedAlkOvr'];

/** Bedrag excl. btw uit een bedrag zoals op de bon. */
export function netAmount(gross: Cents, vatCode: string): Cents {
  const rate = PURCHASE_VAT_RATES[vatCode as PurchaseVatCode];
  if (!rate || ['verlegd', 'eu', 'buiten-eu', 'geen'].includes(vatCode)) return gross;
  return Math.round((gross * 100) / (100 + rate.percentage));
}

/** Zou deze aankoop een investering kunnen zijn? (voor de hint "gaat dit langer dan een jaar mee?") */
export function mightBeInvestment(categoryKey: string, gross: Cents | null | undefined, vatCode: string): boolean {
  if (!gross || gross <= 0 || !INVESTMENT_CANDIDATES.includes(categoryKey)) return false;
  return netAmount(gross, vatCode) >= INVESTMENT_THRESHOLD;
}
