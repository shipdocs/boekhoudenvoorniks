import { EU_COUNTRIES, countryCode } from './vat';

/** Landen voor de keuzelijst bij een klant: eerst Nederland, dan de EU, dan veelvoorkomende landen erbuiten. */
export const COUNTRIES: { code: string; name: string }[] = [
  { code: 'NL', name: 'Nederland' },
  { code: 'BE', name: 'België' },
  { code: 'DE', name: 'Duitsland' },
  { code: 'AT', name: 'Oostenrijk' },
  { code: 'BG', name: 'Bulgarije' },
  { code: 'CY', name: 'Cyprus' },
  { code: 'CZ', name: 'Tsjechië' },
  { code: 'DK', name: 'Denemarken' },
  { code: 'EE', name: 'Estland' },
  { code: 'ES', name: 'Spanje' },
  { code: 'FI', name: 'Finland' },
  { code: 'FR', name: 'Frankrijk' },
  { code: 'GR', name: 'Griekenland' },
  { code: 'HR', name: 'Kroatië' },
  { code: 'HU', name: 'Hongarije' },
  { code: 'IE', name: 'Ierland' },
  { code: 'IT', name: 'Italië' },
  { code: 'LT', name: 'Litouwen' },
  { code: 'LU', name: 'Luxemburg' },
  { code: 'LV', name: 'Letland' },
  { code: 'MT', name: 'Malta' },
  { code: 'PL', name: 'Polen' },
  { code: 'PT', name: 'Portugal' },
  { code: 'RO', name: 'Roemenië' },
  { code: 'SE', name: 'Zweden' },
  { code: 'SI', name: 'Slovenië' },
  { code: 'SK', name: 'Slowakije' },
  // buiten de EU
  { code: 'GB', name: 'Verenigd Koninkrijk' },
  { code: 'CH', name: 'Zwitserland' },
  { code: 'NO', name: 'Noorwegen' },
  { code: 'US', name: 'Verenigde Staten' },
  { code: 'CA', name: 'Canada' },
  { code: 'AU', name: 'Australië' },
  { code: 'TR', name: 'Turkije' },
  { code: 'MA', name: 'Marokko' },
  { code: 'SR', name: 'Suriname' },
  { code: 'CW', name: 'Curaçao' },
  { code: 'AW', name: 'Aruba' },
  { code: 'BQ', name: 'Bonaire, Sint Eustatius en Saba' },
  { code: 'AE', name: 'Verenigde Arabische Emiraten' },
  { code: 'CN', name: 'China' },
  { code: 'IN', name: 'India' },
  { code: 'JP', name: 'Japan' },
];

export function countryName(code: string | null | undefined): string {
  const c = countryCode(code);
  return COUNTRIES.find((x) => x.code === c)?.name ?? c ?? 'onbekend land';
}

export function isEuCountry(code: string | null | undefined): boolean {
  const c = countryCode(code);
  return !!c && EU_COUNTRIES.has(c);
}
