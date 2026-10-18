/**
 * Het blok `bedrijf` op de eerste pagina van het stamgegevens-antwoord: de bedrijfsgegevens van de
 * administratie en het standaard factuursjabloon, zodat de telefoon een factuur-pdf kan opmaken zoals de
 * pc dat doet. Puur types en vormcontrole, zonder Node of database; de pc bouwt het blok uit zijn
 * instellingen en sjablonen en toetst het met dezelfde lezer als de telefoon.
 *
 * De lezer is streng: een onbekende of ontbrekende sleutel, een verkeerd type of een waarde buiten de
 * grenzen wordt afgewezen met een gewone Nederlandse melding. Hij gooit nooit.
 */
import { BETAALTERMIJN_GRENZEN } from './velden';

/** De grenzen van het blok. Allemaal in tekens (UTF-16), de data-URL van een logo is zuiver ASCII. */
export const BEDRIJF_LIMIETEN = {
  /** de bedrijfsnaam, en elk gegeven dat geen adres is */
  maxTekens: 200,
  maxAdresTekens: 500,
  /** Gelijk aan de grens waarmee de pc een logo opslaat (TemplateService); de pc gebruikt deze waarde zelf. */
  maxLogoBytes: 1_500_000,
  /**
   * Het eigen HTML-sjabloon heeft op de pc geen grens. 256 KiB is ruim voor een volledige factuurlay-out
   * (het standaardsjabloon is ongeveer 6 KiB) en houdt de eerste pagina ver onder maxBodyBytes (20 MiB):
   * zelfs met alleen vier-byte-tekens blijft het ruim onder 1,1 MiB.
   */
  maxHtmlTekens: 262_144,
  maxTekstblokken: 20,
  maxTitelTekens: 200,
  /** de tekst van een tekstblok: gelijk aan de grens voor vrije tekst in de sync */
  maxBlokTekens: 4000,
  maxLettertypeTekens: 200,
} as const;

/** De sleutels van `gegevens`, in vaste volgorde. Allemaal tekst; leeg is een lege tekst. */
export const BEDRIJF_GEGEVENS_SLEUTELS = ['naam', 'adres', 'postcode', 'plaats', 'land', 'email', 'telefoon', 'website', 'kvk_nummer', 'btw_nummer', 'iban', 'bic'] as const;
export type BedrijfGegevensSleutel = (typeof BEDRIJF_GEGEVENS_SLEUTELS)[number];
export type BedrijfGegevens = Record<BedrijfGegevensSleutel, string>;

const KLEUR_SLEUTELS = ['primary', 'text', 'muted', 'accentBg'] as const;
export interface BedrijfKleuren {
  primary: string;
  text: string;
  muted: string;
  accentBg: string;
}

export interface BedrijfTekstblok {
  titel: string;
  tekst: string;
}

/** Het standaard factuursjabloon van de pc. */
export interface BedrijfFactuur {
  kleuren: BedrijfKleuren;
  lettertype: string;
  /** data-URL (png, jpeg, svg of webp) of null */
  logo: string | null;
  tekstblokken: BedrijfTekstblok[];
  /** een eigen HTML-sjabloon, of null voor de standaardlay-out */
  html_template: string | null;
}

export interface Bedrijf {
  /** de eerste 16 hexcijfers van de sha256 over de canonieke JSON van de rest van het blok */
  versie: string;
  gegevens: BedrijfGegevens;
  /** geldt de kleineondernemersregeling (zoals de factuuropmaak die gebruikt) */
  kor: boolean;
  /** de standaard betaaltermijn voor nieuwe facturen, hele dagen */
  betaaltermijn_dagen: number;
  factuur: BedrijfFactuur;
}

export type LeesBedrijfResult = { ok: true; bedrijf: Bedrijf } | { ok: false; veld: string; melding: string };

const VERSIE = /^[0-9a-f]{16}$/;
const LOGO = /^data:image\/(png|jpeg|svg\+xml|webp);base64,[A-Za-z0-9+/=]+$/;
/** #rgb, #rgba, #rrggbb of #rrggbbaa */
const KLEUR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
/** dezelfde tekens als de pc voor een lettertype toelaat */
const LETTERTYPE = /^[\w\s",.-]+$/;

function fout(veld: string, melding: string): LeesBedrijfResult {
  return { ok: false, veld, melding };
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** Heeft het object precies deze sleutels (eigen sleutels, dus ook `__proto__` uit JSON telt mee)? Geeft de eerste fout. */
function sleutelFout(pad: string, obj: Record<string, unknown>, verwacht: readonly string[]): LeesBedrijfResult | null {
  const eigen = Object.keys(obj);
  for (const k of eigen) if (!verwacht.includes(k)) return fout(pad ? `${pad}.${k}` : k, `${pad ? `${pad}.${k}` : k} is onbekend`);
  for (const k of verwacht) if (!eigen.includes(k)) return fout(pad ? `${pad}.${k}` : k, `${pad ? `${pad}.${k}` : k} ontbreekt`);
  return null;
}

function tekstFout(veld: string, waarde: unknown, max: number): LeesBedrijfResult | null {
  if (typeof waarde !== 'string') return fout(veld, `${veld} moet een tekst zijn`);
  if (waarde.length > max) return fout(veld, `${veld} is te lang (hoogstens ${max} tekens)`);
  return null;
}

/**
 * Leest het blok `bedrijf` streng. Bij succes een nieuw object (de invoer wordt nooit doorgegeven), bij
 * een fout het eerste veld dat niet klopt met een Nederlandse melding. Gooit nooit.
 */
export function leesBedrijf(invoer: unknown): LeesBedrijfResult {
  if (!isObject(invoer)) return fout('bedrijf', 'bedrijf moet een object zijn');
  const top = sleutelFout('', invoer, ['versie', 'gegevens', 'kor', 'betaaltermijn_dagen', 'factuur']);
  if (top) return top;

  if (typeof invoer.versie !== 'string' || !VERSIE.test(invoer.versie)) return fout('versie', 'versie moet 16 hexcijfers zijn (kleine letters)');

  const g = invoer.gegevens;
  if (!isObject(g)) return fout('gegevens', 'gegevens moet een object zijn');
  const gf = sleutelFout('gegevens', g, BEDRIJF_GEGEVENS_SLEUTELS);
  if (gf) return gf;
  const gegevens = {} as BedrijfGegevens;
  for (const k of BEDRIJF_GEGEVENS_SLEUTELS) {
    const f = tekstFout(`gegevens.${k}`, g[k], k === 'adres' ? BEDRIJF_LIMIETEN.maxAdresTekens : BEDRIJF_LIMIETEN.maxTekens);
    if (f) return f;
    gegevens[k] = g[k] as string;
  }

  if (typeof invoer.kor !== 'boolean') return fout('kor', 'kor moet waar of onwaar zijn');
  const termijn = invoer.betaaltermijn_dagen;
  if (typeof termijn !== 'number' || !Number.isInteger(termijn) || termijn < BETAALTERMIJN_GRENZEN.min || termijn > BETAALTERMIJN_GRENZEN.max) {
    return fout('betaaltermijn_dagen', `betaaltermijn_dagen moet een geheel getal van ${BETAALTERMIJN_GRENZEN.min} tot en met ${BETAALTERMIJN_GRENZEN.max} zijn`);
  }

  const f = invoer.factuur;
  if (!isObject(f)) return fout('factuur', 'factuur moet een object zijn');
  const ff = sleutelFout('factuur', f, ['kleuren', 'lettertype', 'logo', 'tekstblokken', 'html_template']);
  if (ff) return ff;

  const k = f.kleuren;
  if (!isObject(k)) return fout('factuur.kleuren', 'factuur.kleuren moet een object zijn');
  const kf = sleutelFout('factuur.kleuren', k, KLEUR_SLEUTELS);
  if (kf) return kf;
  const kleuren = {} as BedrijfKleuren;
  for (const naam of KLEUR_SLEUTELS) {
    const v = k[naam];
    if (typeof v !== 'string' || !KLEUR.test(v)) return fout(`factuur.kleuren.${naam}`, `factuur.kleuren.${naam} moet een kleur zijn als #rgb, #rrggbb of #rrggbbaa`);
    kleuren[naam] = v;
  }

  const lettertype = f.lettertype;
  const lf = tekstFout('factuur.lettertype', lettertype, BEDRIJF_LIMIETEN.maxLettertypeTekens);
  if (lf) return lf;
  if (!LETTERTYPE.test(lettertype as string)) return fout('factuur.lettertype', 'factuur.lettertype bevat tekens die in een lettertype niet mogen');

  const logo = f.logo;
  if (logo !== null) {
    if (typeof logo !== 'string' || !LOGO.test(logo)) return fout('factuur.logo', 'factuur.logo moet null zijn of een PNG-, JPEG-, SVG- of WebP-afbeelding als data-URL (base64)');
    if (logo.length > BEDRIJF_LIMIETEN.maxLogoBytes) return fout('factuur.logo', 'factuur.logo is te groot');
  }

  const blokken = f.tekstblokken;
  if (!Array.isArray(blokken)) return fout('factuur.tekstblokken', 'factuur.tekstblokken moet een lijst zijn');
  if (blokken.length > BEDRIJF_LIMIETEN.maxTekstblokken) return fout('factuur.tekstblokken', `factuur.tekstblokken heeft hoogstens ${BEDRIJF_LIMIETEN.maxTekstblokken} blokken`);
  const tekstblokken: BedrijfTekstblok[] = [];
  for (let i = 0; i < blokken.length; i++) {
    const b: unknown = blokken[i];
    const pad = `factuur.tekstblokken[${i}]`;
    if (!isObject(b)) return fout(pad, `${pad} moet een object zijn`);
    const bf = sleutelFout(pad, b, ['titel', 'tekst']);
    if (bf) return bf;
    const tf = tekstFout(`${pad}.titel`, b.titel, BEDRIJF_LIMIETEN.maxTitelTekens) ?? tekstFout(`${pad}.tekst`, b.tekst, BEDRIJF_LIMIETEN.maxBlokTekens);
    if (tf) return tf;
    tekstblokken.push({ titel: b.titel as string, tekst: b.tekst as string });
  }

  const html = f.html_template;
  if (html !== null) {
    const hf = tekstFout('factuur.html_template', html, BEDRIJF_LIMIETEN.maxHtmlTekens);
    if (hf) return hf;
    if ((html as string).trim() === '') return fout('factuur.html_template', 'factuur.html_template is leeg; gebruik null voor de standaardlay-out');
  }

  return {
    ok: true,
    bedrijf: {
      versie: invoer.versie,
      gegevens,
      kor: invoer.kor,
      betaaltermijn_dagen: termijn,
      factuur: { kleuren, lettertype: lettertype as string, logo, tekstblokken, html_template: html as string | null },
    },
  };
}
