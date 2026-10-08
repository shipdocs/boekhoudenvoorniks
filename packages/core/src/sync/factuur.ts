/**
 * Het factuurschema van de sync: wat een telefoon in een wijziging van de entiteit `factuur` mag
 * meesturen voor een definitieve factuur. Puur schema en controle, zonder Node of database; het
 * overnemen op de pc is een ander stuk.
 *
 * De factuur wordt hier echt doorgerekend en gecontroleerd met dezelfde kernfuncties als op de pc
 * (computeTotals en checkInvoiceRequirements), met de momentopnamen en de KOR uit de payload zelf,
 * nooit met live instellingen: wat de telefoon op het moment van verzenden vastlegde, is leidend.
 */
import { checkInvoiceRequirements } from '../documents/invoices';
import { computeTotals, lineNet, type LineInput } from '../documents/totals';
import { isSalesVatCode, SALES_VAT_RATES, type SalesVatCode } from '../shared/vat';
import { ValidationError } from '../shared/validation';
import { isIsoDatum } from './velden';

/** De grenzen van een factuurwijziging. */
export const FACTUUR_LIMIETEN = {
  minRegels: 1,
  maxRegels: 200,
  /** omschrijving van een regel, en elk tekstveld in een momentopname */
  maxTekst: 200,
  maxEenheid: 50,
  maxReferentie: 200,
  maxRegeltabelVersie: 64,
  /** intro en opmerking */
  maxLangeTekst: 2000,
  maxNummer: 40,
} as const;

/** Nummer van de telefoon: M<n>-<jaar>-<volgnummer>, bijvoorbeeld M1-2026-0001. */
export const FACTUUR_NUMMER_PATROON = /^M[1-9][0-9]*-[0-9]{4}-[0-9]{4,}$/;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TIJDSTIP = /^(\d{4}-\d{2}-\d{2})[T ]([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,3})?)?(Z)?$/;

export interface FactuurNummer {
  /** M1, M2, ... */
  apparaat_code: string;
  reeks_jaar: number;
  reeks_volgnr: number;
}

export type LeesFactuurNummerResult = ({ ok: true } & FactuurNummer) | { ok: false; melding: string };

/**
 * Haalt apparaatcode, reeksjaar en volgnummer uit een nummer als M1-2026-0001. Het volgnummer moet
 * canoniek zijn (minstens 4 cijfers, geen overbodige voorloopnullen, vanaf 1): M1-2026-00001 is ongeldig.
 * Gooit nooit.
 */
export function leesFactuurNummer(nummer: unknown): LeesFactuurNummerResult {
  if (typeof nummer !== 'string' || nummer.length > FACTUUR_LIMIETEN.maxNummer || !FACTUUR_NUMMER_PATROON.test(nummer)) {
    return { ok: false, melding: 'Het factuurnummer moet de vorm apparaatcode-jaar-volgnummer hebben, bijvoorbeeld M1-2026-0001' };
  }
  const [apparaat_code, jaar, volgnummer] = nummer.split('-') as [string, string, string];
  const reeks_volgnr = Number(volgnummer);
  if (!Number.isSafeInteger(reeks_volgnr) || reeks_volgnr < 1 || String(reeks_volgnr).padStart(4, '0') !== volgnummer) {
    return { ok: false, melding: 'Het volgnummer in het factuurnummer moet vanaf 1 lopen en uit precies 4 cijfers bestaan (of meer, zonder voorloopnullen)' };
  }
  return { ok: true, apparaat_code, reeks_jaar: Number(jaar), reeks_volgnr };
}

/** Een momentopname van de klant zoals die op de factuur kwam. */
export interface FactuurKlant {
  name: string;
  address: string | null;
  city: string | null;
  country: string;
  vat_number: string | null;
  kvk_number: string | null;
  email: string | null;
  contact_name: string | null;
  phone: string | null;
  postcode: string | null;
  iban: string | null;
}

/** Een momentopname van het bedrijf zoals dat op de factuur kwam. */
export interface FactuurBedrijf {
  name: string;
  address: string;
  city: string;
  kvkNumber: string;
  vatNumber: string;
  kor: boolean;
  postcode: string;
  country: string;
  email: string;
  phone: string;
  website: string;
  omzetbelastingNumber: string;
  iban: string;
  bic: string;
}

export interface FactuurRegel {
  omschrijving: string;
  hoeveelheid: number;
  /** prijs per eenheid exclusief btw, in centen */
  prijs: number;
  btw_soort: SalesVatCode;
  /** altijd ingevuld: het meegestuurde percentage, anders dat van de btw-soort */
  btw_percentage: number;
  eenheid: string | null;
}

export interface FactuurTotalen {
  subtotaal: number;
  btw: number;
  totaal: number;
}

/** Een gecontroleerde telefoonfactuur. De objecten hebben geen prototype. */
export interface FactuurVelden {
  nummer: string;
  apparaat_code: string;
  reeks_jaar: number;
  reeks_volgnr: number;
  datum: string;
  vervaldatum: string;
  klant_uuid: string;
  klant_momentopname: FactuurKlant;
  bedrijf_momentopname: FactuurBedrijf;
  regels: FactuurRegel[];
  totalen: FactuurTotalen;
  verzonden_op: string;
  regeltabel_versie: string;
  leverdatum: string | null;
  leverdatum_tot: string | null;
  referentie: string | null;
  intro: string | null;
  opmerking: string | null;
  creditnota_van: string | null;
  project_uuid: string | null;
}

export type LeesFactuurVeldenResult = { ok: true; factuur: FactuurVelden } | { ok: false; veld: string; melding: string };

const TOP_VERPLICHT = ['nummer', 'datum', 'vervaldatum', 'klant_uuid', 'klant_momentopname', 'bedrijf_momentopname', 'regels', 'totalen', 'verzonden_op', 'regeltabel_versie'] as const;
const TOP_OPTIONEEL = ['leverdatum', 'leverdatum_tot', 'referentie', 'intro', 'opmerking', 'creditnota_van', 'project_uuid'] as const;
const KLANT_VERPLICHT = ['name', 'address', 'city', 'country', 'vat_number', 'kvk_number', 'email'] as const;
const KLANT_OPTIONEEL = ['contact_name', 'phone', 'postcode', 'iban'] as const;
const BEDRIJF_VERPLICHT = ['name', 'address', 'city', 'kvkNumber', 'vatNumber', 'kor'] as const;
const BEDRIJF_OPTIONEEL = ['postcode', 'country', 'email', 'phone', 'website', 'omzetbelastingNumber', 'iban', 'bic'] as const;
const REGEL_VERPLICHT = ['omschrijving', 'hoeveelheid', 'prijs', 'btw_soort'] as const;
const REGEL_OPTIONEEL = ['btw_percentage', 'eenheid'] as const;
const TOTALEN_VELDEN = ['subtotaal', 'btw', 'totaal'] as const;

class Afwijzing {
  constructor(
    readonly veld: string,
    readonly melding: string,
  ) {}
}

function afwijzen(veld: string, melding: string): never {
  throw new Afwijzing(veld, melding);
}

function isObject(waarde: unknown): waarde is Record<string, unknown> {
  return typeof waarde === 'object' && waarde !== null && !Array.isArray(waarde);
}

/** Controleert dat het object precies de verplichte en eventueel de optionele sleutels heeft (eigen sleutels). */
function controleerSleutels(pad: string, o: Record<string, unknown>, verplicht: readonly string[], optioneel: readonly string[], wat: string): void {
  const toegestaan = new Set<string>([...verplicht, ...optioneel]);
  for (const sleutel of Object.keys(o)) {
    if (!toegestaan.has(sleutel)) afwijzen(pad + sleutel, `Het veld ${pad}${sleutel} bestaat niet voor ${wat} en wordt niet bewaard`);
  }
  for (const sleutel of verplicht) {
    if (!Object.hasOwn(o, sleutel)) afwijzen(pad + sleutel, `Het veld ${pad}${sleutel} ontbreekt`);
  }
}

function tekst(veld: string, waarde: unknown, max: number, leegToegestaan: boolean): string {
  if (typeof waarde !== 'string') return afwijzen(veld, `Het veld ${veld} moet tekst zijn`);
  if (!leegToegestaan && waarde.trim() === '') return afwijzen(veld, `Het veld ${veld} mag niet leeg zijn`);
  if (waarde.length > max) return afwijzen(veld, `Het veld ${veld} is te lang (hoogstens ${max} tekens)`);
  return waarde;
}

function tekstOfNull(veld: string, waarde: unknown, max: number): string | null {
  return waarde === null ? null : tekst(veld, waarde, max, true);
}

function datum(veld: string, waarde: unknown): string {
  if (typeof waarde !== 'string' || !isIsoDatum(waarde)) return afwijzen(veld, `Het veld ${veld} moet een bestaande datum zijn in de vorm JJJJ-MM-DD`);
  return waarde;
}

function uuidV4(veld: string, waarde: unknown): string {
  if (typeof waarde !== 'string' || !UUID_V4.test(waarde)) return afwijzen(veld, `Het veld ${veld} moet een uuid (versie 4, kleine letters) zijn`);
  return waarde;
}

function bedrag(veld: string, waarde: unknown): number {
  if (typeof waarde !== 'number' || !Number.isSafeInteger(waarde)) return afwijzen(veld, `Het veld ${veld} moet een geheel bedrag in centen zijn`);
  return waarde;
}

function leesKlant(raw: unknown): FactuurKlant {
  const pad = 'klant_momentopname';
  if (!isObject(raw)) return afwijzen(pad, `Het veld ${pad} moet een object zijn`);
  controleerSleutels(`${pad}.`, raw, KLANT_VERPLICHT, KLANT_OPTIONEEL, 'een klantmomentopname');
  const max = FACTUUR_LIMIETEN.maxTekst;
  const uit = Object.create(null) as FactuurKlant;
  uit.name = tekst(`${pad}.name`, raw.name, max, false);
  uit.country = tekst(`${pad}.country`, raw.country, max, true);
  for (const sleutel of ['address', 'city', 'vat_number', 'kvk_number', 'email'] as const) uit[sleutel] = tekstOfNull(`${pad}.${sleutel}`, raw[sleutel], max);
  for (const sleutel of KLANT_OPTIONEEL) uit[sleutel] = Object.hasOwn(raw, sleutel) ? tekstOfNull(`${pad}.${sleutel}`, raw[sleutel], max) : null;
  return uit;
}

function leesBedrijf(raw: unknown): FactuurBedrijf {
  const pad = 'bedrijf_momentopname';
  if (!isObject(raw)) return afwijzen(pad, `Het veld ${pad} moet een object zijn`);
  controleerSleutels(`${pad}.`, raw, BEDRIJF_VERPLICHT, BEDRIJF_OPTIONEEL, 'een bedrijfsmomentopname');
  const max = FACTUUR_LIMIETEN.maxTekst;
  if (typeof raw.kor !== 'boolean') afwijzen(`${pad}.kor`, `Het veld ${pad}.kor moet waar of onwaar zijn`);
  const uit = Object.create(null) as FactuurBedrijf;
  uit.kor = raw.kor as boolean;
  uit.name = tekst(`${pad}.name`, raw.name, max, true);
  uit.address = tekst(`${pad}.address`, raw.address, max, true);
  uit.city = tekst(`${pad}.city`, raw.city, max, true);
  uit.kvkNumber = tekst(`${pad}.kvkNumber`, raw.kvkNumber, max, true);
  uit.vatNumber = tekst(`${pad}.vatNumber`, raw.vatNumber, max, true);
  for (const sleutel of BEDRIJF_OPTIONEEL) uit[sleutel] = Object.hasOwn(raw, sleutel) ? tekst(`${pad}.${sleutel}`, raw[sleutel], max, true) : '';
  return uit;
}

function leesRegel(raw: unknown, index: number): FactuurRegel {
  const pad = `regels[${index}]`;
  if (!isObject(raw)) return afwijzen(pad, `Het veld ${pad} moet een object zijn`);
  controleerSleutels(`${pad}.`, raw, REGEL_VERPLICHT, REGEL_OPTIONEEL, 'een factuurregel');
  const omschrijving = tekst(`${pad}.omschrijving`, raw.omschrijving, FACTUUR_LIMIETEN.maxTekst, false);
  const hoeveelheid = raw.hoeveelheid;
  if (typeof hoeveelheid !== 'number' || !Number.isFinite(hoeveelheid) || hoeveelheid === 0) {
    return afwijzen(`${pad}.hoeveelheid`, `Het veld ${pad}.hoeveelheid moet een getal zijn dat niet 0 is`);
  }
  const prijs = bedrag(`${pad}.prijs`, raw.prijs);
  if (typeof raw.btw_soort !== 'string' || !isSalesVatCode(raw.btw_soort)) return afwijzen(`${pad}.btw_soort`, `Het veld ${pad}.btw_soort is geen bekende btw-soort`);
  const btw_soort = raw.btw_soort;
  const standaard = SALES_VAT_RATES[btw_soort].percentage;
  let btw_percentage = standaard;
  if (Object.hasOwn(raw, 'btw_percentage') && raw.btw_percentage !== null) {
    const p = raw.btw_percentage;
    const kanAfwijken = btw_soort === 'hoog' || btw_soort === 'laag';
    if (typeof p !== 'number' || !Number.isInteger(p) || p < 0 || p > 100 || (!kanAfwijken && p !== 0)) {
      return afwijzen(`${pad}.btw_percentage`, `Het veld ${pad}.btw_percentage past niet bij de btw-soort ${btw_soort}`);
    }
    btw_percentage = p;
  }
  const net = lineNet({ quantity: hoeveelheid, unitPrice: prijs });
  if (!Number.isSafeInteger(net)) return afwijzen(`${pad}.prijs`, `Het bedrag van ${pad} is te groot`);
  const eenheid = Object.hasOwn(raw, 'eenheid') ? tekstOfNull(`${pad}.eenheid`, raw.eenheid, FACTUUR_LIMIETEN.maxEenheid) : null;
  const uit = Object.create(null) as FactuurRegel;
  Object.assign(uit, { omschrijving, hoeveelheid, prijs, btw_soort, btw_percentage, eenheid });
  return uit;
}

function leesTotalen(raw: unknown): FactuurTotalen {
  if (!isObject(raw)) return afwijzen('totalen', 'Het veld totalen moet een object zijn');
  controleerSleutels('totalen.', raw, TOTALEN_VELDEN, [], 'de totalen');
  const uit = Object.create(null) as FactuurTotalen;
  for (const sleutel of TOTALEN_VELDEN) uit[sleutel] = bedrag(`totalen.${sleutel}`, raw[sleutel]);
  return uit;
}

function leesTijdstip(veld: string, waarde: unknown): string {
  if (typeof waarde !== 'string') return afwijzen(veld, `Het veld ${veld} moet een tijdstip zijn (JJJJ-MM-DD UU:MM)`);
  const m = TIJDSTIP.exec(waarde);
  if (!m || !isIsoDatum(m[1] as string)) return afwijzen(veld, `Het veld ${veld} moet een bestaand tijdstip zijn (JJJJ-MM-DD UU:MM)`);
  return waarde;
}

function lees(raw: unknown): FactuurVelden {
  if (!isObject(raw)) return afwijzen('velden', 'De velden van een factuurwijziging moeten een object zijn');
  controleerSleutels('', raw, TOP_VERPLICHT, TOP_OPTIONEEL, 'een factuur');

  const nummerTekst = tekst('nummer', raw.nummer, FACTUUR_LIMIETEN.maxNummer, false);
  const nummer = leesFactuurNummer(nummerTekst);
  if (!nummer.ok) return afwijzen('nummer', nummer.melding);
  const factuurDatum = datum('datum', raw.datum);
  if (Number(factuurDatum.slice(0, 4)) !== nummer.reeks_jaar) return afwijzen('nummer', 'Het jaar in het factuurnummer moet gelijk zijn aan het jaar van de factuurdatum');
  const vervaldatum = datum('vervaldatum', raw.vervaldatum);
  if (vervaldatum < factuurDatum) return afwijzen('vervaldatum', 'De vervaldatum mag niet voor de factuurdatum liggen');
  const klant_uuid = uuidV4('klant_uuid', raw.klant_uuid);
  const klant = leesKlant(raw.klant_momentopname);
  const bedrijf = leesBedrijf(raw.bedrijf_momentopname);

  if (!Array.isArray(raw.regels)) return afwijzen('regels', 'Het veld regels moet een lijst zijn');
  if (raw.regels.length < FACTUUR_LIMIETEN.minRegels) return afwijzen('regels', 'Een factuur heeft minstens één regel');
  if (raw.regels.length > FACTUUR_LIMIETEN.maxRegels) return afwijzen('regels', `Een factuur heeft hoogstens ${FACTUUR_LIMIETEN.maxRegels} regels`);
  const regels = raw.regels.map((r, i) => leesRegel(r, i));

  const totalen = leesTotalen(raw.totalen);
  const verzonden_op = leesTijdstip('verzonden_op', raw.verzonden_op);
  const regeltabel_versie = tekst('regeltabel_versie', raw.regeltabel_versie, FACTUUR_LIMIETEN.maxRegeltabelVersie, false);

  const leverdatum = Object.hasOwn(raw, 'leverdatum') && raw.leverdatum !== null ? datum('leverdatum', raw.leverdatum) : null;
  const leverdatum_tot = Object.hasOwn(raw, 'leverdatum_tot') && raw.leverdatum_tot !== null ? datum('leverdatum_tot', raw.leverdatum_tot) : null;
  if (leverdatum && leverdatum_tot && leverdatum_tot < leverdatum) return afwijzen('leverdatum_tot', 'De leverdatum tot mag niet voor de leverdatum liggen');
  const optioneleTekst = (veld: string, max: number): string | null => (Object.hasOwn(raw, veld) ? tekstOfNull(veld, raw[veld], max) : null);
  const referentie = optioneleTekst('referentie', FACTUUR_LIMIETEN.maxReferentie);
  const intro = optioneleTekst('intro', FACTUUR_LIMIETEN.maxLangeTekst);
  const opmerking = optioneleTekst('opmerking', FACTUUR_LIMIETEN.maxLangeTekst);
  const creditnota_van = Object.hasOwn(raw, 'creditnota_van') && raw.creditnota_van !== null ? uuidV4('creditnota_van', raw.creditnota_van) : null;
  const project_uuid = Object.hasOwn(raw, 'project_uuid') && raw.project_uuid !== null ? uuidV4('project_uuid', raw.project_uuid) : null;

  // echt doorrekenen en controleren, met de momentopnamen uit de payload (nooit live instellingen)
  const invoer: LineInput[] = regels.map((r) => ({
    description: r.omschrijving,
    quantity: r.hoeveelheid,
    unit: r.eenheid,
    unitPrice: r.prijs,
    vatCode: r.btw_soort,
    vatPercentage: r.btw_percentage,
  }));
  const berekend = computeTotals(invoer);
  if (!Number.isSafeInteger(berekend.subtotal) || !Number.isSafeInteger(berekend.vatTotal) || !Number.isSafeInteger(berekend.total)) {
    return afwijzen('totalen', 'De bedragen van de factuur zijn te groot');
  }
  if (totalen.subtotaal !== berekend.subtotal || totalen.btw !== berekend.vatTotal || totalen.totaal !== berekend.total) {
    return afwijzen('totalen', 'De totalen kloppen niet met de regels van de factuur');
  }
  try {
    checkInvoiceRequirements({ lines: regels.map((r) => ({ vat_code: r.btw_soort, vat_percentage: r.btw_percentage })) }, klant, bedrijf.kor, bedrijf);
  } catch (e) {
    if (e instanceof ValidationError) return afwijzen('factuur', e.message);
    throw e;
  }

  const factuur = Object.create(null) as FactuurVelden;
  Object.assign(factuur, {
    nummer: nummerTekst,
    apparaat_code: nummer.apparaat_code,
    reeks_jaar: nummer.reeks_jaar,
    reeks_volgnr: nummer.reeks_volgnr,
    datum: factuurDatum,
    vervaldatum,
    klant_uuid,
    klant_momentopname: klant,
    bedrijf_momentopname: bedrijf,
    regels,
    totalen,
    verzonden_op,
    regeltabel_versie,
    leverdatum,
    leverdatum_tot,
    referentie,
    intro,
    opmerking,
    creditnota_van,
    project_uuid,
  });
  return factuur;
}

/**
 * Controleert de velden van een factuurwijziging tegen het schema en rekent de factuur door. Geeft bij
 * succes de gecontroleerde factuur (objecten zonder prototype); bij een fout het eerste veld dat niet
 * klopt, met een Nederlandse melding. Gooit nooit. De meldingen van checkInvoiceRequirements komen
 * woordelijk terug in `melding`, met veld `factuur`.
 *
 * Streng: alleen de bekende velden, op elk niveau (ook __proto__, constructor en prototype zijn dus
 * geweigerd); sleutels worden alleen als eigen sleutel herkend.
 */
export function leesFactuurVelden(velden: unknown): LeesFactuurVeldenResult {
  try {
    return { ok: true, factuur: lees(velden) };
  } catch (e) {
    if (e instanceof Afwijzing) return { ok: false, veld: e.veld, melding: e.melding };
    throw e;
  }
}
