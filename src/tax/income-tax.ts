import type { Db } from '../db/database';
import type { SettingsService } from '../settings/settings';
import { periodFor, today, type IsoDate } from '../shared/dates';
import type { Cents } from '../shared/money';
import type { AssetService } from './assets';
import type { TaxOverviewService } from './overview';

/**
 * Schatting inkomstenbelasting (#33 fase 2). ALTIJD een schatting: de app kent alleen de winst uit
 * de onderneming. Partner, hypotheek, andere inkomsten, box 3, voorlopige aanslagen, startersaftrek,
 * FOR/investeringsaftrek en de precieze heffingskortingen zitten er niet in.
 *
 * De tarieven staan per jaar in een aparte, geversioneerde tabel. LET OP: deze tabel is nog niet door
 * een fiscalist gecontroleerd (zie het issue voor de fiscale review); `checked` staat daarom op false
 * en de app toont dat.
 */

export interface IncomeTaxRules {
  year: number;
  /** false = nog niet gecontroleerd tegen de publicaties van de Belastingdienst */
  checked: boolean;
  /** box 1 onder de AOW-leeftijd: [bovengrens in euro's of null, tarief] */
  brackets: [number | null, number][];
  zelfstandigenaftrek: number;
  mkbWinstvrijstelling: number;
  algemeneHeffingskorting: { max: number; phaseOutFrom: number; phaseOutRate: number };
  /** arbeidskorting: opbouwtraject [tot inkomen, percentage] + afbouw */
  arbeidskorting: { build: [number, number][]; max: number; phaseOutFrom: number; phaseOutRate: number };
  /** inkomensafhankelijke bijdrage Zvw voor ondernemers */
  zvw: { rate: number; maxIncome: number };
  /** startersaftrek (bovenop de zelfstandigenaftrek; max 3× in de eerste 5 jaar) */
  startersaftrek: number;
  /**
   * Kleinschaligheidsinvesteringsaftrek: tot `min` niets; tot `pctUpTo` een percentage; tot `fixedUpTo`
   * een vast bedrag; daarna afbouw met `phaseOutRate` tot `phaseOutUpTo`. Alleen bedrijfsmiddelen vanaf `minPerAsset`.
   */
  kia: { min: number; pct: number; pctUpTo: number; fixed: number; fixedUpTo: number; phaseOutRate: number; phaseOutUpTo: number; minPerAsset: number };
  /** desinvesteringsbijtelling alleen boven dit bedrag aan verkopen per jaar */
  desinvesteringDrempel: number;
  /** aftrek per zakelijke kilometer met een privévervoermiddel, in centen */
  kmRate: number;
  /** beperkt aftrekbare kosten (representatie): aftrekbaar deel, of een drempel */
  representatie: { deductible: number; drempel: number };
  /** uren per jaar voor het urencriterium */
  urencriterium: number;
  /** meewerkaftrek: [vanaf uren meewerken partner, percentage van de winst] */
  meewerkaftrek: [number, number][];
}

export const INCOME_TAX_RULES: IncomeTaxRules[] = [
  {
    year: 2025,
    checked: false,
    brackets: [[38441, 0.3582], [76817, 0.3748], [null, 0.495]],
    zelfstandigenaftrek: 2470,
    mkbWinstvrijstelling: 0.127,
    algemeneHeffingskorting: { max: 3068, phaseOutFrom: 28406, phaseOutRate: 0.06337 },
    arbeidskorting: { build: [[12169, 0.08053], [26288, 0.3003], [43071, 0.02258]], max: 5599, phaseOutFrom: 43071, phaseOutRate: 0.0651 },
    zvw: { rate: 0.0526, maxIncome: 75860 },
    startersaftrek: 2123,
    kia: { min: 2901, pct: 0.28, pctUpTo: 70602, fixed: 19769, fixedUpTo: 130744, phaseOutRate: 0.0756, phaseOutUpTo: 392230, minPerAsset: 450 },
    desinvesteringDrempel: 2500,
    kmRate: 23,
    representatie: { deductible: 0.8, drempel: 5600 },
    urencriterium: 1225,
    meewerkaftrek: [[525, 0.0125], [875, 0.02], [1225, 0.03], [1750, 0.04]],
  },
  {
    year: 2026,
    checked: false,
    brackets: [[38883, 0.3575], [78426, 0.3756], [null, 0.495]],
    zelfstandigenaftrek: 1200,
    mkbWinstvrijstelling: 0.127,
    algemeneHeffingskorting: { max: 3115, phaseOutFrom: 29736, phaseOutRate: 0.06398 },
    arbeidskorting: { build: [[11965, 0.08324], [25845, 0.31009], [45592, 0.0195]], max: 5685, phaseOutFrom: 45592, phaseOutRate: 0.0651 },
    zvw: { rate: 0.0485, maxIncome: 79409 },
    startersaftrek: 2123,
    kia: { min: 2901, pct: 0.28, pctUpTo: 71683, fixed: 20072, fixedUpTo: 132746, phaseOutRate: 0.0756, phaseOutUpTo: 398236, minPerAsset: 450 },
    desinvesteringDrempel: 2500,
    kmRate: 25,
    representatie: { deductible: 0.8, drempel: 5700 },
    urencriterium: 1225,
    meewerkaftrek: [[525, 0.0125], [875, 0.02], [1225, 0.03], [1750, 0.04]],
  },
];

/** De regels van dat jaar, of van het laatst bekende jaar ervoor (dan staat `fallback` aan). */
/**
 * Wat voor latere jaren al in de wet staat, terwijl de rest van de tabel nog niet bekend is:
 * de zelfstandigenaftrek daalt verder (2027: € 900) en de startersaftrek gaat naar € 10 (2027)
 * en verdwijnt per 2028.
 */
const KNOWN_LATER: Record<number, Partial<Pick<IncomeTaxRules, 'zelfstandigenaftrek' | 'startersaftrek'>>> = {
  2027: { zelfstandigenaftrek: 900, startersaftrek: 10 },
};

export function rulesFor(year: number): { rules: IncomeTaxRules; fallback: boolean } {
  const exact = INCOME_TAX_RULES.find((r) => r.year === year);
  if (exact) return { rules: exact, fallback: false };
  const earlier = INCOME_TAX_RULES.filter((r) => r.year < year).sort((a, b) => b.year - a.year)[0] ?? INCOME_TAX_RULES[0]!;
  // bekende latere wijzigingen gaan boven de bedragen van het laatst bekende jaar
  const later = Object.entries(KNOWN_LATER).filter(([y]) => Number(y) <= year).sort(([a], [b]) => Number(a) - Number(b));
  const patch = Object.assign({}, ...later.map(([, p]) => p), year >= 2028 ? { startersaftrek: 0 } : {});
  return { rules: { ...earlier, ...patch }, fallback: true };
}

/** Kleinschaligheidsinvesteringsaftrek over het totaal aan investeringen in een jaar (euro's). */
export function kiaFor(total: number, r: IncomeTaxRules['kia']): number {
  if (total < r.min || total > r.phaseOutUpTo) return 0;
  if (total <= r.pctUpTo) return Math.round(total * r.pct);
  if (total <= r.fixedUpTo) return r.fixed;
  return Math.max(0, Math.round(r.fixed - (total - r.fixedUpTo) * r.phaseOutRate));
}

/** Meewerkaftrek: percentage van de winst naar het aantal uren dat je partner onbetaald meewerkt. */
export function meewerkaftrekFor(profit: number, partnerHours: number, rules: IncomeTaxRules): number {
  if (profit <= 0) return 0;
  let pct = 0;
  for (const [from, p] of rules.meewerkaftrek) if (partnerHours >= from) pct = p;
  return profit * pct;
}

/** Niet-aftrekbaar deel van representatiekosten: 20%, of alles tot de drempel (wat gunstiger is). */
export function representatieBijtelling(total: number, r: IncomeTaxRules['representatie']): number {
  if (total <= 0) return 0;
  return Math.round(Math.min(total * (1 - r.deductible), Math.min(total, r.drempel)));
}

export interface IncomeTaxBreakdown {
  /** winst over het hele jaar (in euro's) waarover gerekend is */
  profit: number;
  /** + niet-aftrekbare kosten en desinvesteringsbijtelling */
  bijtellingen: number;
  /** − investeringsaftrek (KIA) */
  kia: number;
  zelfstandigenaftrek: number;
  startersaftrek: number;
  meewerkaftrek: number;
  mkbWinstvrijstelling: number;
  taxableIncome: number;
  box1: number;
  heffingskortingen: number;
  zvw: number;
  total: number;
}

const round = (n: number) => Math.round(n);

function arbeidskorting(income: number, r: IncomeTaxRules['arbeidskorting']): number {
  let k = 0;
  let prev = 0;
  for (const [upTo, rate] of r.build) {
    if (income <= prev) break;
    k += (Math.min(income, upTo) - prev) * rate;
    prev = upTo;
  }
  k = Math.min(k, r.max);
  if (income > r.phaseOutFrom) k -= (income - r.phaseOutFrom) * r.phaseOutRate;
  return Math.max(0, k);
}

/** Pure berekening over een jaarwinst in euro's. */
export function estimateIncomeTax(
  profit: number,
  rules: IncomeTaxRules,
  opts: { urencriterium: boolean; starter?: boolean; kia?: number; bijtellingen?: number; partnerHours?: number },
): IncomeTaxBreakdown {
  const bij = opts.bijtellingen ?? 0;
  const kia = opts.kia ?? 0;
  const fiscal = profit + bij - kia;
  if (fiscal <= 0) return { profit: round(profit), bijtellingen: round(bij), kia: round(kia), zelfstandigenaftrek: 0, startersaftrek: 0, meewerkaftrek: 0, mkbWinstvrijstelling: 0, taxableIncome: 0, box1: 0, heffingskortingen: 0, zvw: 0, total: 0 };
  // ondernemersaftrek niet groter dan de winst (vereenvoudiging: geen verliesverrekening)
  const za = opts.urencriterium ? Math.min(rules.zelfstandigenaftrek, fiscal) : 0;
  const sa = opts.urencriterium && opts.starter ? Math.min(rules.startersaftrek, fiscal - za) : 0;
  const mw = opts.urencriterium ? meewerkaftrekFor(fiscal, opts.partnerHours ?? 0, rules) : 0;
  const mkb = (fiscal - za - sa - mw) * rules.mkbWinstvrijstelling;
  const taxable = Math.max(0, fiscal - za - sa - mw - mkb);
  let box1 = 0;
  let prev = 0;
  for (const [upTo, rate] of rules.brackets) {
    const top = upTo ?? Infinity;
    if (taxable > prev) box1 += (Math.min(taxable, top) - prev) * rate;
    prev = top;
  }
  const ahk = rules.algemeneHeffingskorting;
  const algemeen = Math.max(0, ahk.max - Math.max(0, taxable - ahk.phaseOutFrom) * ahk.phaseOutRate);
  const kortingen = Math.min(box1, algemeen + arbeidskorting(taxable, rules.arbeidskorting));
  const zvw = Math.min(taxable, rules.zvw.maxIncome) * rules.zvw.rate;
  const total = box1 - kortingen + zvw;
  return {
    profit: round(profit),
    bijtellingen: round(bij),
    kia: round(kia),
    zelfstandigenaftrek: round(za),
    startersaftrek: round(sa),
    meewerkaftrek: round(mw),
    mkbWinstvrijstelling: round(mkb),
    taxableIncome: round(taxable),
    box1: round(box1),
    heffingskortingen: round(kortingen),
    zvw: round(zvw),
    total: round(total),
  };
}

export interface IncomeTaxEstimate {
  year: number;
  asOf: IsoDate;
  /** winst tot en met asOf, in centen */
  profitToDate: Cents;
  /** doorgetrokken naar het hele jaar, in centen */
  profitYear: Cents;
  /** geschatte IB + Zvw over het hele jaar, in centen */
  taxYear: Cents;
  /** naar rato van het verstreken deel van het jaar: wat je nu ongeveer opzij zou moeten hebben */
  reserveToDate: Cents;
  breakdown: IncomeTaxBreakdown;
  rulesYear: number;
  rulesChecked: boolean;
  /** tekst die ALTIJD bij de schatting getoond wordt */
  disclaimer: string;
  notIncluded: string[];
}

export const INCOME_TAX_DISCLAIMER =
  'Dit is een schatting, geen aanslag en geen advies. De app kent alleen de winst uit je onderneming en rekent met standaardaftrekposten; je werkelijke inkomstenbelasting kan flink anders zijn. Laat je aangifte altijd controleren door een boekhouder of accountant.';

export const NOT_INCLUDED = [
  'je partner, hypotheek en ander inkomen (loon, uitkering, spaargeld)',
  'belasting die je al vooruit betaalt (voorlopige aanslag)',
  'sommige bijzondere aftrekposten: je boekhouder weet welke'
];

/** Winst (omzet − kosten) volgens het grootboek tussen twee datums, in centen. */
export function profitBetween(db: Db, from: IsoDate, to: IsoDate): Cents {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN a.category = 'omzet' THEN l.credit - l.debit WHEN a.category = 'kosten' THEN l.credit - l.debit END), 0) AS p
       FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
       JOIN chart_of_accounts a ON a.id = l.account_id
       WHERE e.entry_date BETWEEN ? AND ?`,
    )
    .get(from, to) as { p: number };
  return row.p;
}

export class IncomeTaxService {
  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    /** optioneel: afschrijving, KIA, bijtellingen en startersaftrek meenemen */
    private readonly fiscal?: { assets: AssetService; overview: TaxOverviewService },
  ) {}

  private profit(from: IsoDate, to: IsoDate): Cents {
    return profitBetween(this.db, from, to);
  }


  /** null als de schatting uit staat (Instellingen). */
  estimate(asOf: IsoDate = today()): IncomeTaxEstimate | null {
    const s = this.settings.get();
    if (!s.incomeTaxEstimate) return null;
    const year = periodFor(asOf, 'jaar');
    const y = Number(asOf.slice(0, 4));
    const daysInYear = (Date.UTC(y + 1, 0, 1) - Date.UTC(y, 0, 1)) / 86400000;
    const elapsed = Math.min(daysInYear, Math.max(1, (Date.parse(asOf) - Date.UTC(y, 0, 1)) / 86400000 + 1));
    const profitToDate = this.profit(year.start, asOf);
    const adj = this.fiscal?.overview.adjustments(y, asOf);
    // afschrijving wordt pas na afloop van het jaar geboekt: de verwachting voor het hele jaar gaat er zo af
    const depreciation = this.fiscal ? this.fiscal.assets.projected(y, 12) : 0;
    const profitYear = Math.round((profitToDate * daysInYear) / elapsed) - depreciation;
    const { rules } = rulesFor(y);
    // representatie loopt door het jaar heen op: net als de winst doortrekken; KIA alleen over wat al gekocht is
    const reprYear = adj ? Math.round((adj.representatie.total * daysInYear) / elapsed) : 0;
    const phoneYear = adj ? Math.round((adj.phonePrivate.bijtelling * daysInYear) / elapsed) : 0;
    const bijtellingen = adj ? representatieBijtelling(reprYear / 100, rules.representatie) + (adj.desinvesteringsbijtelling + phoneYear) / 100 : 0;
    const breakdown = estimateIncomeTax(profitYear / 100, rules, { urencriterium: s.urencriterium, starter: adj?.starter, kia: adj ? adj.kia / 100 : 0, bijtellingen, partnerHours: s.partnerHours });
    const taxYear = breakdown.total * 100;
    return {
      year: y,
      asOf,
      profitToDate,
      profitYear,
      taxYear,
      reserveToDate: Math.round((taxYear * elapsed) / daysInYear),
      breakdown,
      rulesYear: rules.year,
      rulesChecked: rules.checked,
      disclaimer: INCOME_TAX_DISCLAIMER,
      notIncluded: [...NOT_INCLUDED, ...(s.urencriterium ? [] : ['zelfstandigenaftrek (je hebt aangegeven niet aan het urencriterium te voldoen)'])],
    };
  }
}
