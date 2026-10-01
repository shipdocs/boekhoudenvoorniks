import type { DocumentResult } from './types';
import { supplierKey } from './supplier-memory';

/** Wat de app van je eigen bedrijf weet (Instellingen → Bedrijf, en je eigen bankrekeningen). */
export interface OwnIdentity {
  name: string;
  vatNumber: string;
  kvkNumber: string;
  /** het rekeningnummer op je facturen en je eigen bankrekeningen */
  ibans: string[];
}

/**
 * Een factuur van je eigen bedrijf (#205), bv. een proefabonnement op je eigen dienst: verkoper en
 * koper zijn dan hetzelfde bedrijf. 'zeker' = de app behandelt hem zo; 'waarschijnlijk' = eerst vragen.
 */
export interface OwnInvoice {
  level: 'zeker' | 'waarschijnlijk';
  /** waarom, in gewone woorden (voor "Waarom?") */
  signals: string[];
}

/** Afwijzing ("toch een gewone aankoop") in document_proposal_rejections. */
export const OWN_COMPANY_CANDIDATE = 'eigen-bedrijf';
/** Veld van de melding bij het document. */
export const OWN_COMPANY_ISSUE = 'own-company';

const compact = (s: string) => s.replace(/[\s.]/g, '').toUpperCase();
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Dezelfde naam, los van hoofdletters, leestekens en rechtsvorm ("ShipDocs", "SHIPDOCS B.V."). */
export function sameCompanyName(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = supplierKey(a ?? '').replace(/\s/g, '');
  const kb = supplierKey(b ?? '').replace(/\s/g, '');
  return ka.length >= 3 && ka === kb;
}

/**
 * Btw-nummers in de tekst, zonder spaties en punten: het Nederlandse formaat (NL123456789B01) en van
 * andere EU-landen de landcode met 7 tot 11 cijfers. Een rekeningnummer (IBAN) begint ook met een
 * landcode maar is langer of heeft letters na de eerste twee cijfers; dat telt niet mee.
 */
export function vatNumbers(text: string): string[] {
  const re = /\b(?:NL[ .]?\d{9}[ .]?B[ .]?\d{2}|(?:AT|BE|BG|CY|CZ|DE|DK|EE|EL|ES|FI|FR|HR|HU|IE|IT|LT|LU|LV|MT|PL|PT|RO|SE|SI|SK|GB|XI)[ .]?[A-Z]{0,2}\d(?:[ .]?\d){6,10}[A-Z]{0,2})(?![ .]?\d)(?![0-9A-Z])/g;
  return [...text.toUpperCase().matchAll(re)].map((m) => compact(m[0]));
}

/** KvK-nummers die als zodanig genoemd worden ("KvK 12345678", "Handelsregister: …"). */
function kvkNumbers(text: string): string[] {
  return [...text.matchAll(/(?:k\.?v\.?k\.?|kamer van koophandel|handelsregister|coc)[^0-9\n]{0,25}(\d{8})\b/gi)].map((m) => m[1]!);
}

/**
 * Is dit document een factuur van het eigen bedrijf? Een gewone inkoopfactuur noemt jou ook (naam,
 * adres, vaak je btw-nummer), maar dan als koper. Daarom telt alleen wat een verkoper op een factuur zet:
 *  - je KvK-nummer (dat van een koper staat er zelden op);
 *  - je btw-nummer twee keer of vaker (verkoper én koper);
 *  - je bedrijfsnaam als verkoper gelezen, of twee keer op één regel (kolom verkoper naast kolom koper);
 *  - je eigen rekeningnummer als rekening om naar te betalen;
 *  - een factuurnummer dat van je eigen facturen is.
 * Staat er een ander btw- of KvK-nummer op, dan is er een andere verkoper: geen factuur van jezelf (ook
 * niet bij een leverancier uit de EU die jouw btw-nummer noemt voor de verlegde btw). Zonder ander nummer:
 * twee of meer aanwijzingen = zeker, één = waarschijnlijk (vragen). Alleen je btw-nummer één keer, zonder
 * iets anders, zegt niets: zo ziet een factuur van buiten de EU aan jou er ook uit. Alleen je eigen
 * rekeningnummer ook niet ("wordt afgeschreven van rekening …").
 * Bij een e-factuur (UBL) staat de verkoper apart: is dat jouw btw-nummer, dan is het zeker.
 */
export function detectOwnInvoice(result: DocumentResult, own: OwnIdentity, isOwnInvoiceNumber: (number: string) => boolean = () => false): OwnInvoice | null {
  const ownVat = compact(own.vatNumber);
  const ownKvk = own.kvkNumber.replace(/\D/g, '');
  const ownNumber = !!result.invoiceNumber?.value && isOwnInvoiceNumber(result.invoiceNumber.value);
  const sellerName = sameCompanyName(result.supplier?.value, own.name);

  if (result.supplier?.source === 'ubl' || result.documentType.source === 'ubl') {
    // gestructureerd: de verkoper is een eigen veld, de koper staat er los van
    const sellerVat = result.supplierVatNumber ? compact(result.supplierVatNumber.value) : '';
    if (ownVat && sellerVat === ownVat) return { level: 'zeker', signals: ['je eigen btw-nummer staat als verkoper op de e-factuur'] };
    if (sellerVat) return null;
    if (sellerName) return ownNumber ? { level: 'zeker', signals: ['je eigen bedrijfsnaam staat als verkoper op de e-factuur', 'het factuurnummer is van een van je eigen facturen'] } : { level: 'waarschijnlijk', signals: ['je eigen bedrijfsnaam staat als verkoper op de e-factuur'] };
    return null;
  }

  const text = result.rawText ?? '';
  const vats = vatNumbers(text);
  const ownVatCount = ownVat ? vats.filter((v) => v === ownVat).length : 0;
  const otherVat = vats.some((v) => v !== ownVat);
  const ownKvkCount = ownKvk.length === 8 ? (text.match(new RegExp(`(?<!\\d)${ownKvk}(?!\\d)`, 'g')) ?? []).length : 0;
  const otherKvk = kvkNumbers(text).some((k) => k !== ownKvk);
  const nameTwice = own.name.trim().length >= 3 && text.split('\n').some((line) => (line.match(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(own.name.trim())}(?![\\p{L}\\p{N}])`, 'giu')) ?? []).length >= 2);
  const ownIbans = own.ibans.map(compact).filter(Boolean);
  const payee = !!result.supplierIban && ownIbans.includes(compact(result.supplierIban.value));

  const signals: string[] = [];
  if (ownKvkCount > 0) signals.push('je eigen KvK-nummer staat erop');
  if (ownVatCount >= 2) signals.push('je eigen btw-nummer staat er twee keer op (verkoper en koper)');
  if (sellerName || nameTwice) signals.push(sellerName ? 'je eigen bedrijfsnaam is de verkoper' : 'je eigen bedrijfsnaam staat als verkoper en als koper op dezelfde regel');
  if (payee) signals.push('het rekeningnummer om naar te betalen is van jou');
  if (ownNumber) signals.push('het factuurnummer is van een van je eigen facturen');

  if (otherVat || otherKvk) {
    // een andere verkoper; alleen je eigen factuurnummer maakt het nog de moeite van een vraag waard
    return ownNumber ? { level: 'waarschijnlijk', signals: ['het factuurnummer is van een van je eigen facturen'] } : null;
  }
  if (signals.length >= 2) return { level: 'zeker', signals };
  // alleen je eigen rekeningnummer zegt te weinig: dat staat er ook op bij "wordt afgeschreven van rekening …"
  if (signals.length === 1 && !payee) return { level: 'waarschijnlijk', signals };
  return null;
}
