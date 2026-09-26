import type { Db } from '../db/database';
import type { SettingsService } from '../settings/settings';
import { periodFor, today, type IsoDate } from '../shared/dates';
import type { Cents } from '../shared/money';

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
  },
];

/** De regels van dat jaar, of van het laatst bekende jaar ervoor (dan staat `fallback` aan). */
export function rulesFor(year: number): { rules: IncomeTaxRules; fallback: boolean } {
  const exact = INCOME_TAX_RULES.find((r) => r.year === year);
  if (exact) return { rules: exact, fallback: false };
  const earlier = INCOME_TAX_RULES.filter((r) => r.year < year).sort((a, b) => b.year - a.year)[0];
  return { rules: earlier ?? INCOME_TAX_RULES[0]!, fallback: true };
}

export interface IncomeTaxBreakdown {
  /** winst over het hele jaar (in euro's) waarover gerekend is */
  profit: number;
  zelfstandigenaftrek: number;
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
export function estimateIncomeTax(profit: number, rules: IncomeTaxRules, opts: { urencriterium: boolean }): IncomeTaxBreakdown {
  if (profit <= 0) return { profit, zelfstandigenaftrek: 0, mkbWinstvrijstelling: 0, taxableIncome: 0, box1: 0, heffingskortingen: 0, zvw: 0, total: 0 };
  const za = opts.urencriterium ? Math.min(rules.zelfstandigenaftrek, profit) : 0;
  const mkb = (profit - za) * rules.mkbWinstvrijstelling;
  const taxable = Math.max(0, profit - za - mkb);
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
    zelfstandigenaftrek: round(za),
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
  'Dit is een schatting, geen aanslag. De app kent alleen de winst uit je onderneming en rekent met standaardaftrekposten. Je werkelijke inkomstenbelasting kan flink anders zijn.';

export const NOT_INCLUDED = [
  'fiscaal partner, hypotheekrente en andere aftrekposten',
  'ander inkomen (loon, uitkering) en box 2/3',
  'voorlopige aanslagen die je al betaalt',
  'startersaftrek, FOR-afbouw, kleinschaligheidsinvesteringsaftrek en afschrijvingen die nog niet geboekt zijn',
  'precieze heffingskortingen (die hangen af van je hele inkomen)',
];

export class IncomeTaxService {
  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
  ) {}

  private profit(from: IsoDate, to: IsoDate): Cents {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN a.category = 'omzet' THEN l.credit - l.debit WHEN a.category = 'kosten' THEN l.credit - l.debit END), 0) AS p
         FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
         JOIN chart_of_accounts a ON a.id = l.account_id
         WHERE e.entry_date BETWEEN ? AND ?`,
      )
      .get(from, to) as { p: number };
    return row.p;
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
    const profitYear = Math.round((profitToDate * daysInYear) / elapsed);
    const { rules } = rulesFor(y);
    const breakdown = estimateIncomeTax(profitYear / 100, rules, { urencriterium: s.urencriterium });
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
