import { ValidationError } from './validation';
/**
 * Vennoten van een vof of maatschap: per vennoot een eigen kapitaalrekening met privé-opnamen en
 * -stortingen, en een winstaandeel. Puur (geen database), zodat het scherm en de boekhouding dezelfde
 * regels gebruiken.
 *
 * RGS (taxonomie 20251210, zie core-ledger/rgs-codes.json): firmant 1 is het gewone eigen vermogen van een
 * onderneming van natuurlijke personen (BEivKap…); firmant 2 t/m 5 hebben eigen codes (BEivKa2… t/m BEivKa5…).
 * RGS kent er niet meer dan vijf; een BEivKa1 bestaat niet. Daarom blijven de bestaande rekeningen Eigen
 * vermogen, Privé-opnamen en Privé-stortingen van vennoot 1: er hoeft bij het instellen niets omgeboekt te worden.
 */

/** RGS verbijzondert het eigen vermogen voor hooguit vijf firmanten. */
export const MAX_PARTNERS = 5;
export const MIN_PARTNERS = 2;

export interface Partner {
  /** 1 t/m 5: het firmantnummer in RGS, vast zodra er op zijn rekeningen geboekt is */
  no: number;
  name: string;
  /** winstaandeel in procenten, hooguit twee decimalen; samen precies 100 */
  sharePct: number;
}

export interface PartnerAccountKeys {
  /** interne sleutel (rgs_code) van de kapitaalrekening */
  capital: string;
  drawings: string;
  contributions: string;
  /** officiële RGS-referentiecodes */
  capitalRef: string;
  drawingsRef: string;
  contributionsRef: string;
  /** voorgesteld rekeningnummer */
  capitalCode: string;
  drawingsCode: string;
  contributionsCode: string;
}

/**
 * De rekeningen van vennoot `no`. Vennoot 1 gebruikt de bestaande rekeningen (interne sleutels BEivKap,
 * BEivPriPrv en BEivPriStr, officieel BEivKapOnd, BEivKapProOvp en BEivKapPrsOps). Voor vennoot 2 t/m 5 is de
 * interne sleutel gelijk aan de officiële code, net als bij de bv-rekeningen.
 */
export function partnerAccounts(no: number): PartnerAccountKeys {
  if (!Number.isInteger(no) || no < 1 || no > MAX_PARTNERS) throw new RangeError(`Vennoot ${no} bestaat niet (1 t/m ${MAX_PARTNERS})`);
  if (no === 1) {
    return {
      capital: 'BEivKap', drawings: 'BEivPriPrv', contributions: 'BEivPriStr',
      capitalRef: 'BEivKapOnd', drawingsRef: 'BEivKapProOvp', contributionsRef: 'BEivKapPrsOps',
      capitalCode: '0500', drawingsCode: '0510', contributionsCode: '0520',
    };
  }
  const p = `BEivKa${no}`;
  return {
    capital: `${p}Ond`, drawings: `${p}ProOvp`, contributions: `${p}PrsOps`,
    capitalRef: `${p}Ond`, drawingsRef: `${p}ProOvp`, contributionsRef: `${p}PrsOps`,
    capitalCode: `050${no}`, drawingsCode: `051${no}`, contributionsCode: `052${no}`,
  };
}

/** Alle interne sleutels van privé-opnamen en -stortingen, met de vennoot erbij. */
export function allPartnerPrivateKeys(): { no: number; key: string }[] {
  const out: { no: number; key: string }[] = [];
  for (let no = 1; no <= MAX_PARTNERS; no++) {
    const a = partnerAccounts(no);
    out.push({ no, key: a.drawings }, { no, key: a.contributions });
  }
  return out;
}

/** Namen van de rekeningen van een vennoot (zonder naam: zoals bij een eenmanszaak). */
export function partnerAccountNames(name: string): { capital: string; drawings: string; contributions: string } {
  const n = name.trim();
  return n
    ? { capital: `Eigen vermogen ${n}`, drawings: `Privé-opnamen ${n}`, contributions: `Privé-stortingen ${n}` }
    : { capital: 'Eigen vermogen', drawings: 'Privé-opnamen', contributions: 'Privé-stortingen' };
}

/** Winstaandeel in basispunten (1% = 100), zodat er met hele getallen gerekend wordt. */
export function shareBp(pct: number): number {
  return Math.round(pct * 100);
}

/** Wat er niet klopt aan de vennoten, of null. */
export function partnersProblem(partners: Partner[]): string | null {
  if (!Array.isArray(partners)) return 'Ongeldige lijst met vennoten';
  if (partners.length < MIN_PARTNERS) return `Een vof of maatschap heeft minstens ${MIN_PARTNERS} vennoten`;
  if (partners.length > MAX_PARTNERS) return `De app kan hooguit ${MAX_PARTNERS} vennoten bijhouden (zoveel kent het RGS-rekeningschema)`;
  for (const [i, p] of partners.entries()) {
    if (p.no !== i + 1) return 'De vennoten moeten genummerd zijn van 1 tot en met het aantal vennoten';
    if (typeof p.name !== 'string' || !p.name.trim()) return `Vul de naam van vennoot ${p.no} in`;
    if (p.name.trim().length > 80) return `De naam van vennoot ${p.no} is te lang`;
    if (typeof p.sharePct !== 'number' || !Number.isFinite(p.sharePct) || p.sharePct < 0 || p.sharePct > 100) return `Het winstaandeel van ${p.name.trim()} moet tussen 0 en 100% liggen`;
    if (Math.abs(p.sharePct * 100 - shareBp(p.sharePct)) > 1e-6) return `Het winstaandeel van ${p.name.trim()} mag hooguit twee decimalen hebben`;
  }
  const names = partners.map((p) => p.name.trim().toLowerCase());
  if (new Set(names).size !== names.length) return 'Twee vennoten hebben dezelfde naam; maak ze verschillend (bijvoorbeeld met een voorletter)';
  const total = partners.reduce((t, p) => t + shareBp(p.sharePct), 0);
  if (total !== 10000) return `De winstaandelen zijn samen ${(total / 100).toLocaleString('nl-NL')}%; dat moet precies 100% zijn`;
  return null;
}

/** Een voorstel bij het instellen: het oude veld "jouw deel van de winst" wordt vennoot 1, de rest vennoot 2. */
export function defaultPartners(s: { profitSharePct: number; profile?: { firstName?: string } }): Partner[] {
  const own = Math.min(100, Math.max(0, Math.round((Number(s.profitSharePct) || 0) * 100) / 100));
  const mine = own > 0 && own < 100 ? own : 50;
  return [
    { no: 1, name: s.profile?.firstName?.trim() || 'Vennoot 1', sharePct: mine },
    { no: 2, name: 'Vennoot 2', sharePct: Math.round((100 - mine) * 100) / 100 },
  ];
}

/** Verdeelt een bedrag in centen naar aandeel (basispunten, samen 10000): grootste rest, gelijke rest naar de laagste vennoot. Het totaal klopt altijd op de cent. */
export function allocateCents(amount: number, bps: number[]): number[] {
  if (!Number.isSafeInteger(amount)) throw new RangeError('Bedrag in hele centen');
  const total = bps.reduce((t, b) => t + b, 0);
  if (total !== 10000) throw new RangeError('De aandelen zijn samen geen 100%');
  const sign = amount < 0 ? -1 : 1;
  const abs = Math.abs(amount);
  const base = bps.map((b) => Math.floor((abs * b) / 10000));
  const rest = bps.map((b, i) => ({ i, r: (abs * b) % 10000 }));
  let left = abs - base.reduce((t, x) => t + x, 0);
  rest.sort((a, b) => b.r - a.r || a.i - b.i);
  for (const { i } of rest) {
    if (left <= 0) break;
    base[i]! += 1;
    left--;
  }
  return base.map((x) => (x === 0 ? 0 : x * sign));
}

/** Instellingen waarmee de vennoten meetellen. */
export interface PartnerSettings {
  legalForm: 'eenmanszaak' | 'vof' | 'bv' | null;
  partners: Partner[];
  partnerAllocationFromYear: number | null;
  ibPartnerNo: number;
  profitSharePct: number;
}

/** Zijn de vennoten ingesteld (vof met een geldige verdeling)? Anders werkt alles zoals bij één eigen vermogen. */
export function partnersActive(s: Pick<PartnerSettings, 'legalForm' | 'partners'>): boolean {
  return s.legalForm === 'vof' && Array.isArray(s.partners) && s.partners.length >= MIN_PARTNERS;
}

/** Het winstaandeel (procenten) waarmee de schatting van de inkomstenbelasting rekent. */
export function ownProfitSharePct(s: PartnerSettings): number {
  if (s.legalForm !== 'vof') return 100;
  if (partnersActive(s)) {
    const me = s.partners.find((p) => p.no === s.ibPartnerNo) ?? s.partners[0]!;
    return me.sharePct;
  }
  return Math.min(100, Math.max(0, s.profitSharePct));
}

/** De melding als een privéboeking bij een vof met vennoten geen vennoot heeft. */
export const PARTNER_REQUIRED = 'Kies van welke vennoot dit privé is';

/** De privérekeningen voor een privéboeking (opnamen, stortingen) en de naam van de vennoot. */
export interface PrivateAccounts {
  drawings: string;
  contributions: string;
  /** de vennoot; null zonder vennoten */
  partnerNo: number | null;
  name: string | null;
}

/**
 * Op welke privérekeningen een privéboeking komt. Zonder vennoten: de gewone privé-opnamen en -stortingen.
 * Vof of maatschap met vennoten: die van de gekozen vennoot. Zonder (geldige) keuze een fout, nooit stil de
 * eerste vennoot: dan kwam het privé van de een op het vermogen van de ander.
 */
export function privateAccountsFor(s: Pick<PartnerSettings, 'legalForm' | 'partners'>, partnerNo?: number | null): PrivateAccounts {
  if (!partnersActive(s)) return { drawings: 'BEivPriPrv', contributions: 'BEivPriStr', partnerNo: null, name: null };
  const partner = s.partners.find((p) => p.no === partnerNo);
  if (!partner) throw new ValidationError(PARTNER_REQUIRED);
  const a = partnerAccounts(partner.no);
  return { drawings: a.drawings, contributions: a.contributions, partnerNo: partner.no, name: partner.name };
}

/** Interne sleutels van de privé-opnamen van alle vennoten (ook van vennoot 1: de gewone). */
export function allDrawingsKeys(): string[] {
  return Array.from({ length: MAX_PARTNERS }, (_, i) => partnerAccounts(i + 1).drawings);
}

/** Interne sleutels van de privé-stortingen van alle vennoten (ook van vennoot 1: de gewone). */
export function allContributionsKeys(): string[] {
  return Array.from({ length: MAX_PARTNERS }, (_, i) => partnerAccounts(i + 1).contributions);
}

/** Bij welke vennoot hoort deze privérekening (opnamen of stortingen)? null: geen privérekening. */
export function partnerOfPrivateKey(key: string): number | null {
  return allPartnerPrivateKeys().find((p) => p.key === key)?.no ?? null;
}
