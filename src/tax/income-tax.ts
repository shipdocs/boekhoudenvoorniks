import type { Db } from '../db/database';
import type { AppSettings, SettingsService } from '../settings/settings';
import { periodFor, today, type IsoDate } from '../shared/dates';
import type { Cents } from '../shared/money';
import type { AssetService } from './assets';
import type { TaxOverviewService } from './overview';

/**
 * Schatting inkomstenbelasting (#33 fase 2). ALTIJD een schatting: de app kent alleen de winst uit
 * de onderneming. Partner, hypotheek, andere inkomsten, box 3, voorlopige aanslagen en sommige
 * bijzondere aftrekposten zitten er niet in.
 *
 * De tarieven staan per jaar in een aparte tabel. `checked` betekent dat de parameters tegen
 * officiële bronnen zijn gecontroleerd (docs/fiscale-review-44.md), niet dat een fiscalist
 * de gehele applicatie heeft goedgekeurd.
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
  arbeidskorting: { build: [number, number][]; bases: number[]; max: number; phaseOutFrom: number; phaseOutRate: number };
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
    checked: true, // tariefparameters gecontroleerd, 2026-10-05; docs/fiscale-review-44.md
    brackets: [[38441, 0.3582], [76817, 0.3748], [null, 0.495]],
    zelfstandigenaftrek: 2470,
    mkbWinstvrijstelling: 0.127,
    algemeneHeffingskorting: { max: 3068, phaseOutFrom: 28406, phaseOutRate: 0.06337 },
    arbeidskorting: { build: [[12169, 0.08053], [26288, 0.3003], [43071, 0.02258]], bases: [0, 980, 5220], max: 5599, phaseOutFrom: 43071, phaseOutRate: 0.0651 },
    zvw: { rate: 0.0526, maxIncome: 75864 },
    startersaftrek: 2123,
    kia: { min: 2901, pct: 0.28, pctUpTo: 70602, fixed: 19769, fixedUpTo: 130744, phaseOutRate: 0.0756, phaseOutUpTo: 392230, minPerAsset: 450 },
    desinvesteringDrempel: 2900,
    kmRate: 23,
    representatie: { deductible: 0.8, drempel: 5700 },
    urencriterium: 1225,
    meewerkaftrek: [[525, 0.0125], [875, 0.02], [1225, 0.03], [1750, 0.04]],
  },
  {
    year: 2026,
    // alle bedragen nagelopen op belastingdienst.nl (box 1, heffingskortingen, Zvw, ondernemersaftrek, KIA, representatie, km) op 2026-10-04
    checked: true,
    brackets: [[38883, 0.3575], [78426, 0.3756], [null, 0.495]],
    zelfstandigenaftrek: 1200,
    mkbWinstvrijstelling: 0.127,
    algemeneHeffingskorting: { max: 3115, phaseOutFrom: 29736, phaseOutRate: 0.06398 },
    arbeidskorting: { build: [[11965, 0.08324], [25845, 0.31009], [45592, 0.0195]], bases: [0, 996, 5300], max: 5685, phaseOutFrom: 45592, phaseOutRate: 0.0651 },
    zvw: { rate: 0.0485, maxIncome: 79409 },
    startersaftrek: 2123,
    kia: { min: 2901, pct: 0.28, pctUpTo: 71683, fixed: 20072, fixedUpTo: 132746, phaseOutRate: 0.0756, phaseOutUpTo: 398236, minPerAsset: 450 },
    desinvesteringDrempel: 2900,
    kmRate: 25,
    representatie: { deductible: 0.8, drempel: 5700 },
    urencriterium: 1225,
    meewerkaftrek: [[525, 0.0125], [875, 0.02], [1225, 0.03], [1750, 0.04]],
  },
];

/** De regels van dat jaar, of van het laatst bekende jaar ervoor (dan staat `fallback` aan). */
/**
 * Wat voor latere jaren al bekend is, terwijl de rest van de tabel nog niet bekend is:
 * de zelfstandigenaftrek daalt verder (2027: € 900, staat in de wet). De startersaftrek naar € 10 (2027)
 * en € 0 (2028) is een voorstel in het Belastingplan 2027 en nog NIET aangenomen (Rijksoverheid, 2026-10-05);
 * het overzicht zegt dat erbij. Haal dit weg of corrigeer het zodra het voorstel is aangenomen of verworpen.
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
  /** fiscale winst vóór ondernemersaftrek: winst + bijtellingen − KIA */
  fiscalProfit: number;
  /** + niet-aftrekbare kosten en desinvesteringsbijtelling */
  bijtellingen: number;
  /** − investeringsaftrek (KIA) */
  kia: number;
  zelfstandigenaftrek: number;
  startersaftrek: number;
  /** niet-gerealiseerde zelfstandigenaftrek uit eerdere jaren die dit jaar verrekend wordt */
  zelfstandigenaftrekVerrekend: number;
  /** zelfstandigenaftrek die dit jaar niet past (winst te laag): 9 jaar te verrekenen */
  zelfstandigenaftrekNietGerealiseerd: number;
  meewerkaftrek: number;
  /** negatief bij verlies: de vrijstelling verkleint dan het verlies */
  mkbWinstvrijstelling: number;
  /** belastbare winst uit onderneming; negatief = verlies (verrekenbaar, niet in deze schatting) */
  taxableProfit: number;
  /** belastbaar inkomen box 1 (nooit negatief) */
  taxableIncome: number;
  box1: number;
  /** extra belasting doordat ondernemersaftrek en mkb-winstvrijstelling hooguit tegen het tarief van schijf 2 aftrekken */
  tariefsaanpassing: number;
  heffingskortingen: number;
  zvw: number;
  total: number;
}

const round = (n: number) => Math.round(n);

export function arbeidskorting(income: number, r: IncomeTaxRules['arbeidskorting']): number {
  let prev = 0;
  for (const [i, [upTo, rate]] of r.build.entries()) {
    if (income <= upTo) return Math.max(0, Math.min(r.max, r.bases[i]! + (income - prev) * rate));
    prev = upTo;
  }
  return Math.max(0, r.max - Math.max(0, income - r.phaseOutFrom) * r.phaseOutRate);
}

/**
 * Pure berekening over een jaarwinst in euro's.
 *
 * - Zelfstandigenaftrek: niet hoger dan de winst, behalve bij recht op startersaftrek; dan mogen
 *   zelfstandigen- en startersaftrek samen een verlies geven. Wat niet past, is niet-gerealiseerde
 *   zelfstandigenaftrek: de 9 jaar daarna te verrekenen voor zover de winst hoger is dan de
 *   zelfstandigenaftrek van dat jaar (`nietGerealiseerd` = wat daarvan nog openstaat).
 * - Mkb-winstvrijstelling over de winst na ondernemersaftrek; bij verlies verkleint ze het verlies.
 * - Tariefsaanpassing (art. 2.10a Wet IB 2001): ondernemersaftrek en mkb-winstvrijstelling leveren
 *   hooguit het tarief van de voorlaatste schijf op; voor het deel dat in de hoogste schijf valt,
 *   komt het verschil erbij.
 */
export function estimateIncomeTax(
  profit: number,
  rules: IncomeTaxRules,
  opts: { urencriterium: boolean; ondernemer?: boolean; starter?: boolean; kia?: number; bijtellingen?: number; partnerHours?: number; nietGerealiseerd?: number },
): IncomeTaxBreakdown {
  const bij = opts.bijtellingen ?? 0;
  const ondernemer = opts.ondernemer !== false;
  const kia = ondernemer ? opts.kia ?? 0 : 0;
  const fiscal = profit + bij - kia;
  const uren = ondernemer && opts.urencriterium;
  const starter = uren && !!opts.starter;
  // starter: geen beperking tot de winst; anders hooguit de (positieve) winst
  const za = uren ? (starter ? rules.zelfstandigenaftrek : Math.min(rules.zelfstandigenaftrek, Math.max(0, fiscal))) : 0;
  const sa = starter ? rules.startersaftrek : 0;
  const nietGerealiseerdNieuw = uren ? rules.zelfstandigenaftrek - za : 0;
  const verrekend = uren ? Math.min(Math.max(0, opts.nietGerealiseerd ?? 0), Math.max(0, fiscal - za - sa)) : 0;
  const mw = uren ? meewerkaftrekFor(fiscal, opts.partnerHours ?? 0, rules) : 0;
  const ondernemersaftrek = za + sa + verrekend + mw;
  const mkb = ondernemer ? (fiscal - ondernemersaftrek) * rules.mkbWinstvrijstelling : 0;
  const taxableProfit = fiscal - ondernemersaftrek - mkb;
  const taxable = Math.max(0, taxableProfit);
  let box1 = 0;
  let prev = 0;
  for (const [upTo, rate] of rules.brackets) {
    const top = upTo ?? Infinity;
    if (taxable > prev) box1 += (Math.min(taxable, top) - prev) * rate;
    prev = top;
  }
  const tariefsaanpassing = tariefsaanpassingFor(taxable, ondernemersaftrek + mkb, rules);
  const ahk = rules.algemeneHeffingskorting;
  const algemeen = Math.max(0, ahk.max - Math.max(0, taxable - ahk.phaseOutFrom) * ahk.phaseOutRate);
  // De arbeidskorting rekent met het arbeidsinkomen. Voor een ondernemer is dat hier de
  // fiscale winst vóór ondernemersaftrek en mkb-winstvrijstelling, niet het belastbaar
  // inkomen dat na die aftrekposten overblijft. KIA en bijtellingen horen al bij de
  // winstbepaling en zitten daarom wel in `fiscal`.
  const kortingen = Math.min(box1 + tariefsaanpassing, algemeen + arbeidskorting(Math.max(0, fiscal), rules.arbeidskorting));
  const zvw = Math.min(taxable, rules.zvw.maxIncome) * rules.zvw.rate;
  const total = box1 + tariefsaanpassing - kortingen + zvw;
  return {
    profit: round(profit),
    fiscalProfit: round(fiscal),
    bijtellingen: round(bij),
    kia: round(kia),
    zelfstandigenaftrek: round(za),
    startersaftrek: round(sa),
    zelfstandigenaftrekVerrekend: round(verrekend),
    zelfstandigenaftrekNietGerealiseerd: round(nietGerealiseerdNieuw),
    meewerkaftrek: round(mw),
    mkbWinstvrijstelling: round(mkb),
    taxableProfit: round(taxableProfit),
    taxableIncome: round(taxable),
    box1: round(box1),
    tariefsaanpassing: round(tariefsaanpassing),
    heffingskortingen: round(kortingen),
    zvw: round(zvw),
    total: round(total),
  };
}

/**
 * Tariefsaanpassing: aftrekposten `aftrek` leveren hooguit het tarief van de voorlaatste schijf op.
 * Het deel van de aftrek dat (zonder die aftrek) in de hoogste schijf valt, wordt belast tegen het
 * verschil tussen de hoogste en de voorlaatste schijf.
 */
export function tariefsaanpassingFor(taxable: number, aftrek: number, rules: IncomeTaxRules): number {
  if (aftrek <= 0 || rules.brackets.length < 2) return 0;
  const [topStart, prevRate] = rules.brackets[rules.brackets.length - 2]!;
  const topRate = rules.brackets[rules.brackets.length - 1]![1];
  if (topStart === null) return 0;
  const inTop = Math.min(aftrek, Math.max(0, taxable + aftrek - topStart));
  return inTop * (topRate - prevRate);
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
  /** wat de schatting veronderstelt en nog bevestigd moet worden (ondernemerschap, rechtsvorm, aftrekvoorwaarden) */
  assumptions: string[];
}

export const INCOME_TAX_DISCLAIMER =
  'Dit is een schatting voor iemand onder de AOW-leeftijd die het hele jaar in Nederland belasting en volksverzekeringen betaalt, met alleen deze ondernemingswinst. Ander inkomen, seizoenen en bijzondere omstandigheden kunnen de uitkomst flink veranderen. Dit is geen aanslag; controleer je aangifte met je boekhouder.';

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

/** Wat de schatting veronderstelt zolang de gebruiker het niet heeft bevestigd. */
export function assumptionsFor(s: Pick<AppSettings, 'legalForm' | 'ibConfirmed' | 'urencriterium' | 'ibHoursCondition' | 'profitSharePct'>): string[] {
  const out: string[] = [];
  if (!s.ibConfirmed) {
    out.push('Je hebt nog niet bevestigd dat je ondernemer voor de inkomstenbelasting bent. De schatting rekent daarom zonder ondernemersaftrek, mkb-winstvrijstelling en KIA. Het urencriterium is een aparte voorwaarde.');
  }
  if (s.urencriterium && !s.ibHoursCondition) out.push('Bevestig ook dat je meer dan de helft van je werktijd aan je onderneming besteedt, of dat de starteruitzondering geldt. Tot dan rekent de schatting zonder aftrek voor zelfstandigen.');
  if (s.legalForm === null) out.push('Je rechtsvorm is niet opgegeven; de schatting gaat uit van een eenmanszaak (of zzp zonder bv).');
  if (s.legalForm === 'vof') out.push(`Vof of maatschap: de schatting rekent met jouw deel van de winst (${s.profitSharePct}%). De aftrekposten (investeringen, bijtellingen) zijn niet verdeeld; laat je boekhouder dat nakijken.`);
  return out;
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
    // een bv betaalt vennootschapsbelasting over de winst; de schatting voor een ondernemer in de inkomstenbelasting past dan niet
    if (!s.incomeTaxEstimate || s.legalForm === 'bv') return null;
    const year = periodFor(asOf, 'jaar');
    const y = Number(asOf.slice(0, 4));
    const daysInYear = (Date.UTC(y + 1, 0, 1) - Date.UTC(y, 0, 1)) / 86400000;
    const elapsed = Math.min(daysInYear, Math.max(1, (Date.parse(asOf) - Date.UTC(y, 0, 1)) / 86400000 + 1));
    const share = s.legalForm === 'vof' ? Math.min(100, Math.max(0, s.profitSharePct)) / 100 : 1;
    const profitToDate = Math.round(this.profit(year.start, asOf) * share);
    const adj = this.fiscal?.overview.adjustments(y, asOf);
    // afschrijving wordt pas na afloop van het jaar geboekt: de verwachting voor het hele jaar gaat er zo af
    const depreciation = this.fiscal ? this.fiscal.assets.projected(y, 12) : 0;
    const profitYear = Math.round((profitToDate * daysInYear) / elapsed) - Math.round(depreciation * share);
    const { rules } = rulesFor(y);
    // representatie loopt door het jaar heen op: net als de winst doortrekken; KIA alleen over wat al gekocht is
    const reprYear = adj ? Math.round((adj.representatie.total * daysInYear) / elapsed) : 0;
    const phoneYear = adj ? Math.round((adj.phonePrivate.bijtelling * daysInYear) / elapsed) : 0;
    const carYear = adj ? Math.round((adj.carPrivate.bijtelling * daysInYear) / elapsed) : 0;
    const bijtellingen = adj ? representatieBijtelling(reprYear / 100, rules.representatie) + (adj.desinvesteringsbijtelling + phoneYear + carYear) / 100 : 0;
    const breakdown = estimateIncomeTax(profitYear / 100, rules, { ondernemer: s.ibConfirmed, urencriterium: s.urencriterium && s.ibHoursCondition !== null, starter: adj?.starter, kia: adj ? adj.kia / 100 : 0, bijtellingen, partnerHours: s.partnerHours, nietGerealiseerd: s.nietGerealiseerdeZelfstandigenaftrek });
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
      assumptions: assumptionsFor(s),
      notIncluded: [...NOT_INCLUDED, ...(adj?.carPrivate.state === 'onbekend' ? ['bijtelling privégebruik auto van de zaak (gegevens ontbreken: de schatting is te laag)'] : []), ...(s.urencriterium ? [] : ['zelfstandigenaftrek (je hebt aangegeven niet aan het urencriterium te voldoen)'])],
    };
  }
}
