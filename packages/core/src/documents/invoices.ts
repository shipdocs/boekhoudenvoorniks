import { ValidationError } from '../shared/validation';
import { EU_COUNTRIES, countryCode, isIcp, isOutsideEu, needsCustomerVatNumber } from '../shared/vat';

/** Alleen de factuurregels die de wettelijke controles nodig hebben (gewone data, geen database). */
export interface InvoiceRequirementsLine {
  vat_code: string;
  vat_percentage: number;
}

/** Alleen de klantgegevens die de wettelijke controles nodig hebben. */
export interface InvoiceRequirementsRelation {
  name: string;
  address: string | null;
  city: string | null;
  country: string;
  vat_number: string | null;
}

/** Alleen de bedrijfsgegevens die de wettelijke controles nodig hebben. */
export interface InvoiceRequirementsCompany {
  name: string;
  address: string;
  city: string;
  kvkNumber: string;
  vatNumber: string;
}

/**
 * Wettelijke controles vóór een factuur definitief wordt (zuivere functie: alleen gewone data,
 * geen database of klok). Gooit ValidationError bij de eerste overtreding, in vaste volgorde:
 * eerst de bedrijfsgegevens, dan het adres van de klant, dan KOR en verlegging, dan ICP en export.
 * De desktop-app en een latere Android-app gebruiken hiermee letterlijk dezelfde regels en meldingen.
 */
export function checkInvoiceRequirements(
  inv: { lines: InvoiceRequirementsLine[] },
  relation: InvoiceRequirementsRelation,
  kor: boolean,
  company: InvoiceRequirementsCompany,
): void {
  const missing: string[] = [];
  if (!company.name) missing.push('bedrijfsnaam');
  if (!company.address || !company.city) missing.push('bedrijfsadres');
  if (!company.kvkNumber) missing.push('KvK-nummer');
  if (!kor && !company.vatNumber) missing.push('btw-nummer');
  if (missing.length) throw new ValidationError(`Vul eerst je bedrijfsgegevens aan bij Instellingen: ${missing.join(', ')}`);
  if (!relation.address || !relation.city) throw new ValidationError(`Adres van ${relation.name} ontbreekt (verplicht op een factuur)`);
  // een KOR-gebruiker die een EU-dienst verlegt, vermeldt ook zijn eigen btw-identificatienummer
  if (kor && !company.vatNumber && inv.lines.some((l) => l.vat_code === 'icp-dienst')) {
    throw new ValidationError('Bij "btw verlegd" op een dienst aan een bedrijf in een ander EU-land moeten jouw btw-nummer én dat van de klant op de factuur. Vul het jouwe in bij Instellingen.');
  }
  if (inv.lines.some((l) => needsCustomerVatNumber(l.vat_code)) && !relation.vat_number) {
    throw new ValidationError(`Bij btw verlegd moet het btw-nummer van ${relation.name} op de factuur staan. Vul het in bij de klant.`);
  }
  const country = countryCode(relation.country);
  if (inv.lines.some((l) => isIcp(l.vat_code)) && (!country || country === 'NL' || !EU_COUNTRIES.has(country))) {
    throw new ValidationError(`"Bedrijf in een ander EU-land" is alleen voor klanten in een ander EU-land. Vul bij ${relation.name} het land in (bv. DE of BE)`);
  }
  if (inv.lines.some((l) => isOutsideEu(l.vat_code)) && (!country || EU_COUNTRIES.has(country))) {
    throw new ValidationError(`"Klant buiten de EU" is alleen voor klanten buiten de EU. Vul bij ${relation.name} het land in (bv. CH of US)`);
  }
  if (kor && inv.lines.some((l) => l.vat_percentage > 0)) {
    throw new ValidationError('Je gebruikt de kleineondernemersregeling (KOR): je rekent geen btw. Kies bij elke regel "Geen btw".');
  }
  // binnenlandse verlegging past niet bij de KOR: je levert vrijgesteld en vermeldt de KOR (belastingdienst.nl, factuureisen KOR, 2026-10-04)
  if (kor && inv.lines.some((l) => l.vat_code === 'verlegd')) {
    throw new ValidationError('Je gebruikt de kleineondernemersregeling (KOR): dan lever je vrijgesteld van btw en kies je geen "Btw verlegd". Kies bij elke regel "Geen btw (vrijgesteld of KOR)".');
  }
  // uitvoer is een Nederlandse prestatie en valt onder de KOR: de KOR-vrijstelling, niet de gewone 0%-uitvoer. Een dienst die elders belast is (EU-dienst met verlegging, klant buiten de EU) valt er niet onder en blijft mogelijk.
  if (kor && inv.lines.some((l) => l.vat_code === 'export')) {
    throw new ValidationError('Je gebruikt de kleineondernemersregeling (KOR): ook bij goederen naar een land buiten de EU kies je "Geen btw (vrijgesteld of KOR)". De factuur noemt dan de KOR.');
  }
  // goederen aan een EU-bedrijf: onder de KOR geen intracommunautaire levering, geen rubriek 3b en geen ICP-opgaaf; de omzet telt wel mee voor de KOR-grens (belastingdienst.nl, EU-KOR, 2026-10-04)
  if (kor && inv.lines.some((l) => l.vat_code === 'icp')) {
    throw new ValidationError('Je gebruikt de kleineondernemersregeling (KOR): ook bij goederen naar een bedrijf in een ander EU-land kies je "Geen btw (vrijgesteld of KOR)". De factuur noemt dan de KOR en je doet geen opgaaf ICP.');
  }
}
