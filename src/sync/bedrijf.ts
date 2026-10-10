import { createHash } from 'node:crypto';
import type { Db } from '../db/database';
import { BEDRIJF_GEGEVENS_SLEUTELS, BEDRIJF_LIMIETEN, leesBedrijf, type Bedrijf, type BedrijfFactuur, type BedrijfGegevens } from '@gratis-boekhouden/kern';
import { SettingsService } from '../settings/settings';
import { DEFAULT_COLORS, FONTS, TemplateService } from '../documents/templates';

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
 * Het blok wordt met dezelfde lezer gelezen als de telefoon gebruikt (leesBedrijf). Het bouwen is
 * veerkrachtig en gooit nooit: een bestaande administratie kan waarden hebben die de strengere lezer
 * afwijst (de instellingen en sjablonen van de pc zijn ruimer), en dat mag het antwoord met klanten en
 * projecten nooit laten mislukken. Per onderdeel valt het terug op de veiligste waarde en gaat door:
 *
 * - een tekst boven de grens wordt afgekapt op de grens (gegevens, tekstblokken);
 * - een ongeldige kleur wordt de standaardkleur, een ongeldig lettertype het eerste standaardlettertype;
 * - een logo of html-sjabloon dat niet voldoet (vorm of grootte) wordt null (de telefoon gebruikt dan de
 *   standaardopmaak);
 * - meer dan het toegestane aantal tekstblokken: de overtollige vallen weg;
 * - een betaaltermijn buiten 0 tot 365: 14;
 * - bij een onverwachte afwijzing: het hele onderdeel (gegevens of sjabloon) terug naar standaardwaarden,
 *   en lukt zelfs dat niet, het volledig standaard blok.
 *
 * Het blok zelf heeft hier geen veld voor (de telefoon merkt er niets van): de pc schrijft alleen een
 * regel in het eigen logboek met de korte codes van wat is aangepast, nooit met de inhoud.
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

const STANDAARD_TERMIJN = 14;

function standaardFactuur(): BedrijfFactuur {
  return { kleuren: { ...DEFAULT_COLORS }, lettertype: FONTS[0]!, logo: null, tekstblokken: [], html_template: null };
}

function standaardGegevens(): BedrijfGegevens {
  return Object.fromEntries(BEDRIJF_GEGEVENS_SLEUTELS.map((k) => [k, ''])) as BedrijfGegevens;
}

/** Kapt af op `max` tekens zonder een surrogaatpaar (bijvoorbeeld een emoji) doormidden te knippen. */
function kap(tekst: unknown, max: number): string {
  const t = typeof tekst === 'string' ? tekst : '';
  if (t.length <= max) return t;
  const eind = t.charCodeAt(max - 1);
  return t.slice(0, eind >= 0xd800 && eind <= 0xdbff ? max - 1 : max);
}

/**
 * Herstelt het onderdeel dat de lezer afwees (`veld`, zoals gemeld door leesBedrijf) naar de veiligste
 * waarde. Geeft de korte code van de aanpassing, of null als dit veld niet te herstellen is.
 */
function herstel(b: Bedrijf, veld: string): string | null {
  let m: RegExpExecArray | null;
  if ((m = /^gegevens\.(\w+)$/.exec(veld)) && (BEDRIJF_GEGEVENS_SLEUTELS as readonly string[]).includes(m[1]!)) {
    const sleutel = m[1] as keyof BedrijfGegevens;
    b.gegevens[sleutel] = kap(b.gegevens[sleutel], sleutel === 'adres' ? BEDRIJF_LIMIETEN.maxAdresTekens : BEDRIJF_LIMIETEN.maxTekens);
    return 'gegeven-afgekapt';
  }
  if ((m = /^factuur\.kleuren\.(primary|text|muted|accentBg)$/.exec(veld))) {
    b.factuur.kleuren[m[1] as keyof typeof DEFAULT_COLORS] = DEFAULT_COLORS[m[1] as keyof typeof DEFAULT_COLORS];
    return 'kleur-vervangen';
  }
  if (veld === 'factuur.lettertype') {
    b.factuur.lettertype = FONTS[0]!;
    return 'lettertype-vervangen';
  }
  if (veld === 'factuur.logo') {
    b.factuur.logo = null;
    return 'logo-genegeerd';
  }
  if (veld === 'factuur.html_template') {
    b.factuur.html_template = null;
    return 'sjabloon-genegeerd';
  }
  if (veld === 'factuur.tekstblokken') {
    b.factuur.tekstblokken = b.factuur.tekstblokken.slice(0, BEDRIJF_LIMIETEN.maxTekstblokken);
    return 'tekstblokken-afgekapt';
  }
  if ((m = /^factuur\.tekstblokken\[(\d+)\]\.(titel|tekst)$/.exec(veld))) {
    const blok = b.factuur.tekstblokken[Number(m[1])];
    if (!blok) return null;
    const soort = m[2] as 'titel' | 'tekst';
    blok[soort] = kap(blok[soort], soort === 'titel' ? BEDRIJF_LIMIETEN.maxTitelTekens : BEDRIJF_LIMIETEN.maxBlokTekens);
    return 'tekstblok-afgekapt';
  }
  if (veld === 'betaaltermijn_dagen') {
    b.betaaltermijn_dagen = STANDAARD_TERMIJN;
    return 'betaaltermijn-vervangen';
  }
  if (veld === 'kor') {
    b.kor = false;
    return 'kor-vervangen';
  }
  return null;
}

const LEEG_VERSIE = '0000000000000000';

/** Maakt van een kandidaat een geldig blok, of null als dat niet lukt. Wat is aangepast komt in `codes`. */
function maakGeldig(kandidaat: Bedrijf, codes: Set<string>): Bedrijf | null {
  for (let poging = 0; poging < 200; poging++) {
    const uitslag = leesBedrijf(kandidaat);
    if (uitslag.ok) {
      const { versie: _weg, ...inhoud } = uitslag.bedrijf;
      const klaar = { versie: bedrijfVersie(inhoud), ...inhoud };
      // de versie hoort bij de inhoud na herstel; de lezer bevestigt de vorm nog eens
      const nog = leesBedrijf(klaar);
      return nog.ok ? nog.bedrijf : null;
    }
    const code = herstel(kandidaat, uitslag.veld);
    if (code === null) {
      // niet te herstellen op veldniveau: het hele onderdeel terug naar standaardwaarden
      if (uitslag.veld.startsWith('gegevens')) (kandidaat.gegevens = standaardGegevens(), codes.add('gegevens-vervangen'));
      else if (uitslag.veld.startsWith('factuur')) (kandidaat.factuur = standaardFactuur(), codes.add('sjabloon-vervangen'));
      else return null;
    } else {
      codes.add(code);
    }
  }
  return null;
}

/**
 * Bouwt het blok bedrijf. Gooit nooit: wat niet past wordt aangepast (zie het docblok) en alleen de
 * korte codes daarvan gaan naar `log`, nooit de inhoud.
 */
export function bouwBedrijf(db: Db, log?: (melding: string) => void): Bedrijf {
  const codes = new Set<string>();
  let kandidaat: Bedrijf;
  try {
    const instellingen = new SettingsService(db).get();
    const gegevens = {} as BedrijfGegevens;
    for (const sleutel of BEDRIJF_GEGEVENS_SLEUTELS) {
      const waarde = instellingen.company[INSTELLING[sleutel]];
      gegevens[sleutel] = typeof waarde === 'string' ? waarde : '';
    }
    let factuur = standaardFactuur();
    try {
      const sjabloon = new TemplateService(db).getDefault('factuur');
      factuur = {
        kleuren: { primary: sjabloon.colors.primary, text: sjabloon.colors.text, muted: sjabloon.colors.muted, accentBg: sjabloon.colors.accentBg },
        lettertype: sjabloon.font,
        logo: sjabloon.logo,
        tekstblokken: sjabloon.text_blocks.map((b) => ({ titel: b.title, tekst: b.text })),
        html_template: sjabloon.html_template,
      };
    } catch {
      codes.add('sjabloon-vervangen');
    }
    const termijn = instellingen.paymentTermDays;
    kandidaat = { versie: LEEG_VERSIE, gegevens, kor: instellingen.kor === true, betaaltermijn_dagen: typeof termijn === 'number' ? termijn : STANDAARD_TERMIJN, factuur };
  } catch {
    codes.add('instellingen-vervangen');
    kandidaat = { versie: LEEG_VERSIE, gegevens: standaardGegevens(), kor: false, betaaltermijn_dagen: STANDAARD_TERMIJN, factuur: standaardFactuur() };
  }
  let bedrijf = maakGeldig(kandidaat, codes);
  if (!bedrijf) {
    // een programmeerfout: het volledig standaard blok is geldig per constructie
    codes.add('blok-vervangen');
    bedrijf = maakGeldig({ versie: LEEG_VERSIE, gegevens: standaardGegevens(), kor: false, betaaltermijn_dagen: STANDAARD_TERMIJN, factuur: standaardFactuur() }, new Set());
  }
  if (codes.size > 0) log?.(`Het blok bedrijf voor de telefoon is aangepast om binnen het protocol te passen: ${[...codes].sort().join(', ')}`);
  // maakGeldig slaagt op het standaard blok; deze regel is alleen voor de typechecker
  return bedrijf ?? { versie: LEEG_VERSIE, gegevens: standaardGegevens(), kor: false, betaaltermijn_dagen: STANDAARD_TERMIJN, factuur: standaardFactuur() };
}
