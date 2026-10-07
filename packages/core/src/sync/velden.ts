/**
 * Het klantveldschema van de sync: welke velden een telefoon in een klantwijziging mag meesturen, hoe
 * ze heten in de kolommen van de administratie en welke grenzen ze hebben. Puur schema en
 * vormcontrole, zonder Node of database; de inhoudelijke regels per veld (e-mail, IBAN, btw-nummer,
 * land, enzovoort) horen bij de administratie zelf.
 *
 * Elk veld wordt los gecontroleerd, nooit in samenhang met de rest van de wijziging of met de rij die
 * al bestaat. Zo hangt de uitkomst niet af van de volgorde waarin wijzigingen binnenkomen.
 */
import { WIJZIGING_LIMIETEN } from './changeset';

export type KlantVeldSoort = 'tekst' | 'getal' | 'vlag';

export interface KlantVeldDef {
  /** de kolom van de tabel relations waar dit veld naartoe gaat */
  kolom: string;
  soort: KlantVeldSoort;
  /** ten hoogste zoveel tekens (alleen bij tekst, nooit hoger dan WIJZIGING_LIMIETEN.maxTekens) */
  max?: number;
  /** een optioneel veld mag null zijn */
  optioneel: boolean;
}

/** De mapping van het Nederlandse veld in de wijziging naar de kolom, met type en grens. Alleen deze velden. */
export const KLANT_VELDEN = {
  naam: { kolom: 'name', soort: 'tekst', max: 200, optioneel: false },
  contactpersoon: { kolom: 'contact_name', soort: 'tekst', max: 200, optioneel: true },
  email: { kolom: 'email', soort: 'tekst', max: 200, optioneel: true },
  telefoon: { kolom: 'phone', soort: 'tekst', max: 200, optioneel: true },
  adres: { kolom: 'address', soort: 'tekst', max: 500, optioneel: true },
  postcode: { kolom: 'postcode', soort: 'tekst', max: 200, optioneel: true },
  plaats: { kolom: 'city', soort: 'tekst', max: 200, optioneel: true },
  land: { kolom: 'country', soort: 'tekst', max: 200, optioneel: true },
  btw_nummer: { kolom: 'vat_number', soort: 'tekst', max: 200, optioneel: true },
  kvk_nummer: { kolom: 'kvk_number', soort: 'tekst', max: 200, optioneel: true },
  iban: { kolom: 'iban', soort: 'tekst', max: 200, optioneel: true },
  betaaltermijn_dagen: { kolom: 'payment_term_days', soort: 'getal', optioneel: true },
  notities: { kolom: 'notes', soort: 'tekst', max: WIJZIGING_LIMIETEN.maxTekens, optioneel: true },
  gearchiveerd: { kolom: 'archived', soort: 'vlag', optioneel: false },
} as const satisfies Record<string, KlantVeldDef>;

export type KlantVeldNaam = keyof typeof KLANT_VELDEN;
export type KlantKolom = (typeof KLANT_VELDEN)[KlantVeldNaam]['kolom'];

/** Betaaltermijn in dagen: een geheel getal van 0 tot en met 365. */
export const BETAALTERMIJN_GRENZEN = { min: 0, max: 365 } as const;

/** Een gecontroleerde klantwijziging: de waarden per kolom, zonder prototype. */
export type KlantVelden = Record<string, string | number | null>;

export type LeesKlantVeldenResult = { ok: true; velden: KlantVelden } | { ok: false; veld: string; melding: string };

function fout(veld: string, melding: string): LeesKlantVeldenResult {
  return { ok: false, veld, melding };
}

/**
 * Controleert de velden van een klantwijziging tegen het schema. Geeft bij succes de waarden per kolom
 * terug in een object zonder prototype; bij een fout het eerste veld dat niet klopt, met een
 * Nederlandse melding waarin de veldnaam staat. Gooit nooit.
 *
 * Een veld buiten het schema (ook type, paid_with, id, uuid, revisie of een verboden sleutel als
 * __proto__) wordt geweigerd; sleutels worden alleen met Object.hasOwn herkend.
 */
export function leesKlantVelden(velden: unknown): LeesKlantVeldenResult {
  if (typeof velden !== 'object' || velden === null || Array.isArray(velden)) return fout('velden', 'De velden van een klantwijziging moeten een object zijn');
  const invoer = velden as Record<string, unknown>;
  const uit = Object.create(null) as KlantVelden;
  for (const veld of Object.keys(invoer)) {
    if (!Object.hasOwn(KLANT_VELDEN, veld)) return fout(veld, `Het veld ${veld} bestaat niet voor een klant en wordt niet bewaard`);
    const def: KlantVeldDef = KLANT_VELDEN[veld as KlantVeldNaam];
    const waarde = invoer[veld];
    if (waarde === null) {
      if (!def.optioneel) return fout(veld, `Het veld ${veld} mag niet leeg zijn`);
      uit[def.kolom] = null;
      continue;
    }
    if (def.soort === 'tekst') {
      if (typeof waarde !== 'string') return fout(veld, `Het veld ${veld} moet tekst zijn`);
      if (veld === 'naam' && waarde.trim() === '') return fout(veld, 'Het veld naam mag niet leeg zijn');
      if (waarde.length > (def.max ?? WIJZIGING_LIMIETEN.maxTekens)) return fout(veld, `Het veld ${veld} is te lang (hoogstens ${def.max} tekens)`);
    } else if (def.soort === 'getal') {
      if (typeof waarde !== 'number' || !Number.isInteger(waarde) || waarde < BETAALTERMIJN_GRENZEN.min || waarde > BETAALTERMIJN_GRENZEN.max) {
        return fout(veld, `Het veld ${veld} moet een geheel aantal dagen zijn van ${BETAALTERMIJN_GRENZEN.min} tot en met ${BETAALTERMIJN_GRENZEN.max}`);
      }
    } else if (waarde !== 0 && waarde !== 1) {
      return fout(veld, `Het veld ${veld} moet 0 of 1 zijn`);
    }
    uit[def.kolom] = waarde;
  }
  return { ok: true, velden: uit };
}
