import { createHash } from 'node:crypto';
import type { Db } from '../db/database';
import { BEDRIJF_GEGEVENS_SLEUTELS, leesBedrijf, type Bedrijf, type BedrijfGegevens } from '@gratis-boekhouden/kern';
import { SettingsService } from '../settings/settings';
import { TemplateService } from '../documents/templates';

/**
 * Het blok `bedrijf` op de eerste pagina van het stamgegevens-antwoord: de bedrijfsgegevens van de
 * administratie en het standaard factuursjabloon, zodat de telefoon een factuur-pdf kan opmaken.
 *
 * Whitelist boven blacklist, net als bij klanten en projecten. De gegevens worden veld voor veld uit
 * de bedrijfsinstellingen gekozen (BEDRIJF_GEGEVENS_SLEUTELS); er wordt nooit een heel instellingenobject
 * doorgegeven. Wat de instellingen verder bevatten (mail, koppelingen, licentie, het omzetbelastingnummer
 * voor contact met de Belastingdienst, enzovoort) verlaat de pc niet. Het IBAN staat er wel in: het staat
 * op elke factuur. Er is geen tweede bron van waarheid: de waarden komen uit SettingsService en
 * TemplateService, dezelfde als waarmee de pc zelf een factuur opmaakt.
 *
 * - kor: `settings.kor`, precies wat de factuuropmaak als `opts.kor` meegeeft (InvoiceService.renderHtml).
 * - betaaltermijn_dagen: `settings.paymentTermDays`, waarmee de pc de vervaldatum van een nieuwe factuur
 *   berekent (een klant met een eigen termijn gaat daarvoor, dat is een klantveld).
 * - factuur: het standaard factuursjabloon (type factuur, is_default = 1). Geen offerte, geen andere sjablonen.
 * - versie: de eerste 16 hexcijfers van de sha256 over de canonieke JSON (gesorteerde sleutels) van
 *   gegevens, kor, betaaltermijn en factuur. Dezelfde inhoud geeft dezelfde versie; elke wijziging een andere.
 *
 * Het blok wordt met dezelfde lezer gelezen als de telefoon gebruikt (leesBedrijf). Past het niet binnen de
 * grenzen (bijvoorbeeld een bedrijfsnaam van meer dan 200 tekens), dan gooit dit een duidelijke fout.
 */

/** Canonieke JSON: sleutels gesorteerd, zodat de volgorde van opschrijven niet uitmaakt. */
function canoniek(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canoniek).join(',')}]`;
  if (x && typeof x === 'object') {
    return `{${Object.keys(x)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canoniek((x as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(x);
}

/** De versie van de inhoud van het blok (alles behalve `versie` zelf). */
export function bedrijfVersie(inhoud: Omit<Bedrijf, 'versie'>): string {
  return createHash('sha256').update(canoniek(inhoud), 'utf8').digest('hex').slice(0, 16);
}

/** Bedrijfsinstelling naar sleutel van het blok (alleen deze twaalf). */
const INSTELLING: Record<keyof BedrijfGegevens, 'name' | 'address' | 'postcode' | 'city' | 'country' | 'email' | 'phone' | 'website' | 'kvkNumber' | 'vatNumber' | 'iban' | 'bic'> = {
  naam: 'name',
  adres: 'address',
  postcode: 'postcode',
  plaats: 'city',
  land: 'country',
  email: 'email',
  telefoon: 'phone',
  website: 'website',
  kvk_nummer: 'kvkNumber',
  btw_nummer: 'vatNumber',
  iban: 'iban',
  bic: 'bic',
};

export function bouwBedrijf(db: Db): Bedrijf {
  const instellingen = new SettingsService(db).get();
  const sjabloon = new TemplateService(db).getDefault('factuur');
  const gegevens = {} as BedrijfGegevens;
  for (const sleutel of BEDRIJF_GEGEVENS_SLEUTELS) gegevens[sleutel] = String(instellingen.company[INSTELLING[sleutel]] ?? '');
  const inhoud: Omit<Bedrijf, 'versie'> = {
    gegevens,
    kor: instellingen.kor === true,
    betaaltermijn_dagen: instellingen.paymentTermDays,
    factuur: {
      kleuren: { primary: sjabloon.colors.primary, text: sjabloon.colors.text, muted: sjabloon.colors.muted, accentBg: sjabloon.colors.accentBg },
      lettertype: sjabloon.font,
      logo: sjabloon.logo,
      tekstblokken: sjabloon.text_blocks.map((b) => ({ titel: b.title, tekst: b.text })),
      html_template: sjabloon.html_template,
    },
  };
  const uitslag = leesBedrijf({ versie: bedrijfVersie(inhoud), ...inhoud });
  if (!uitslag.ok) throw new Error(`Het blok bedrijf past niet in het protocol: ${uitslag.melding}`);
  return uitslag.bedrijf;
}
