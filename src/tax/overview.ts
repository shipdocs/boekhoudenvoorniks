import type { Db } from '../db/database';
import { ACCOUNTS } from '../core-ledger/accounts';
import type { AppSettings, SettingsService } from '../settings/settings';
import { today, type IsoDate } from '../shared/dates';
import type { Cents } from '../shared/money';
import type { AssetService } from './assets';
import { ASSET_THRESHOLD } from './assets';
import type { HoursService, MileageService } from './mileage';
import { estimateIncomeTax, kiaFor, profitBetween, representatieBijtelling, rulesFor, type IncomeTaxBreakdown } from './income-tax';

/** De startersaftrek vervalt per 2028 (wetswijziging); tot die tijd max 3× in de eerste 5 jaar. */
const STARTERSAFTREK_ENDS = 2028;

export function isStarter(s: Pick<AppSettings, 'startYear' | 'startersaftrekUsed'>, year: number): boolean {
  if (!s.startYear || year < s.startYear || year - s.startYear >= 5 || year >= STARTERSAFTREK_ENDS) return false;
  // aanname: sinds het moment van opgeven elk jaar gebruikt
  const since = Math.max(s.startersaftrekUsed.asOfYear || s.startYear, s.startYear);
  const usedBefore = s.startersaftrekUsed.count + Math.max(0, year - since);
  return usedBefore < 3;
}

export interface FiscalAdjustments {
  /** investeringen dit jaar die meetellen voor de KIA (centen) */
  investments: Cents;
  kia: Cents;
  desinvesteringsbijtelling: Cents;
  representatie: { total: Cents; bijtelling: Cents };
  /** nog niet geboekte afschrijving (lopend jaar: tot en met `untilMonth`) */
  unbookedDepreciation: Cents;
  starter: boolean;
}

export interface OverviewItem {
  key: string;
  label: string;
  /** effect op de fiscale winst in centen: + bijtelling, − aftrek; null = alleen informatie */
  amount: Cents | null;
  explain: string;
  /** waar het in de aangifte hoort */
  where?: string;
  status?: 'ok' | 'warn' | 'info';
}

export interface TaxYearOverview {
  year: number;
  asOf: IsoDate;
  /** jaar nog bezig: bedragen zijn tot nu toe */
  running: boolean;
  profitBooked: Cents;
  items: OverviewItem[];
  breakdown: IncomeTaxBreakdown;
  hours: { total: number; workOrders: number; other: number; target: number; projected: number };
  km: { km: number; amount: Cents; trips: number; rate: Cents };
  rulesYear: number;
  rulesChecked: boolean;
  disclaimer: string;
}

export const OVERVIEW_DISCLAIMER =
  'Dit overzicht helpt je bij de aangifte inkomstenbelasting. Het is geen advies: controleer de bedragen (of laat je boekhouder dat doen). Jij blijft verantwoordelijk voor je aangifte.';

/**
 * Wat er in de aangifte inkomstenbelasting bij de winst komt, bovenop de boekhouding: de KIA,
 * bijtellingen (representatie, verkoop binnen 5 jaar), ondernemersaftrek en mkb-winstvrijstelling.
 * Die bedragen zijn fiscaal, geen boekingen; afschrijving en kilometers zijn wél geboekt.
 */
export class TaxOverviewService {
  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly assets: AssetService,
    private readonly mileage: MileageService,
    private readonly hours: HoursService,
  ) {}

  private costsOn(account: string, from: IsoDate, to: IsoDate): Cents {
    const r = this.db
      .prepare(
        `SELECT COALESCE(SUM(l.debit - l.credit), 0) AS s FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
         JOIN chart_of_accounts a ON a.id = l.account_id WHERE a.rgs_code = ? AND e.entry_date BETWEEN ? AND ?`,
      )
      .get(account, from, to) as { s: number };
    return r.s;
  }

  /** Investeringen die meetellen voor de KIA in een jaar: per stuk ≥ € 450, niet uitgesloten, niet teruggedraaid. */
  private investmentsIn(year: number): Cents {
    const r = this.db
      .prepare(`SELECT COALESCE(SUM(cost), 0) AS s FROM assets WHERE status != 'vervallen' AND kia_excluded = 0 AND cost >= ? AND substr(acquired_on, 1, 4) = ?`)
      .get(ASSET_THRESHOLD, String(year)) as { s: number };
    return r.s;
  }

  /** Effectief KIA-percentage van een jaar (voor de desinvesteringsbijtelling). */
  private kiaRate(year: number): number {
    const inv = this.investmentsIn(year);
    if (inv <= 0) return 0;
    return kiaFor(inv / 100, rulesFor(year).rules.kia) / (inv / 100);
  }

  adjustments(year: number, asOf: IsoDate = today()): FiscalAdjustments {
    const s = this.settings.get();
    const { rules } = rulesFor(year);
    // afgesloten jaren zijn dan geboekt; wat overblijft is alleen het lopende jaar
    this.assets.bookDue(asOf);
    const investments = this.investmentsIn(year);
    const kia = Math.round(kiaFor(investments / 100, rules.kia) * 100);

    // verkocht binnen 5 jaar na het begin van het investeringsjaar: (een deel van) de KIA terug
    const sold = this.db
      .prepare(`SELECT acquired_on, cost, proceeds FROM assets WHERE status = 'verkocht' AND kia_excluded = 0 AND cost >= ? AND substr(disposed_on, 1, 4) = ?`)
      .all(ASSET_THRESHOLD, String(year)) as { acquired_on: IsoDate; cost: Cents; proceeds: Cents | null }[];
    const within = sold.filter((a) => year < Number(a.acquired_on.slice(0, 4)) + 5);
    const soldTotal = within.reduce((t, a) => t + (a.proceeds ?? 0), 0);
    const desinvesteringsbijtelling =
      soldTotal > rules.desinvesteringDrempel * 100
        ? within.reduce((t, a) => {
            const rate = this.kiaRate(Number(a.acquired_on.slice(0, 4)));
            return t + Math.round(rate * Math.min(a.proceeds ?? 0, a.cost));
          }, 0)
        : 0;

    const running = year >= Number(asOf.slice(0, 4));
    const to = running ? asOf : `${year}-12-31`;
    const repr = this.costsOn(ACCOUNTS.representatie, `${year}-01-01`, to);
    const unbookedDepreciation = year > Number(asOf.slice(0, 4)) ? 0 : this.assets.projected(year, running ? Number(asOf.slice(5, 7)) : 12);
    return {
      investments,
      kia,
      desinvesteringsbijtelling,
      representatie: { total: repr, bijtelling: Math.round(representatieBijtelling(repr / 100, rules.representatie) * 100) },
      unbookedDepreciation,
      starter: isStarter(s, year),
    };
  }

  year(year: number, asOf: IsoDate = today()): TaxYearOverview {
    const s = this.settings.get();
    const { rules, fallback } = rulesFor(year);
    const running = year >= Number(asOf.slice(0, 4));
    const to = running ? asOf : `${year}-12-31`;
    const adj = this.adjustments(year, asOf);
    const profitBooked = profitBetween(this.db, `${year}-01-01`, to);
    const profit = profitBooked - adj.unbookedDepreciation;
    const km = { ...this.mileage.totals(year), rate: rules.kmRate };
    const h = this.hours.totals(year);
    const y = year;
    const daysInYear = (Date.UTC(y + 1, 0, 1) - Date.UTC(y, 0, 1)) / 86400000;
    const elapsed = running ? Math.min(daysInYear, Math.max(1, (Date.parse(asOf) - Date.UTC(y, 0, 1)) / 86400000 + 1)) : daysInYear;
    const projectedHours = Math.round((h.total * daysInYear) / elapsed);

    const breakdown = estimateIncomeTax(profit / 100, rules, {
      urencriterium: s.urencriterium,
      starter: adj.starter,
      kia: adj.kia / 100,
      bijtellingen: (adj.representatie.bijtelling + adj.desinvesteringsbijtelling) / 100,
    });
    const fuel = this.costsOn('WBedAutBra', `${year}-01-01`, to);
    const items: OverviewItem[] = [];
    items.push({
      key: 'winst',
      label: 'Winst volgens je boekhouding',
      amount: profit,
      explain: adj.unbookedDepreciation > 0
        ? `Inclusief € ${(adj.unbookedDepreciation / 100).toFixed(2).replace('.', ',')} afschrijving ${running ? 'tot nu toe; die boekt de app na afloop van het jaar' : 'die nog niet geboekt is'}.`
        : 'Omzet min kosten, inclusief afschrijving en kilometers.',
      where: 'Winst uit onderneming → winst- en verliesrekening',
    });
    if (adj.representatie.total > 0) {
      items.push({
        key: 'representatie',
        label: 'Bijtelling etentjes, borrels en relatiegeschenken',
        amount: adj.representatie.bijtelling,
        explain: `Deze kosten zijn beperkt aftrekbaar: 20% telt weer bij de winst (of alles tot € ${rules.representatie.drempel.toLocaleString('nl-NL')}, als dat minder is). Je had € ${(adj.representatie.total / 100).toFixed(2).replace('.', ',')} aan zulke kosten.`,
        where: 'Winst uit onderneming → niet-aftrekbare kosten',
      });
    }
    if (adj.investments > 0) {
      items.push({
        key: 'kia',
        label: 'Kleinschaligheidsinvesteringsaftrek (KIA)',
        amount: -adj.kia,
        explain:
          adj.kia > 0
            ? `Je investeerde € ${(adj.investments / 100).toLocaleString('nl-NL')} in bedrijfsmiddelen van minstens € 450 per stuk. Daarover krijg je extra aftrek.`
            : `Je investeerde € ${(adj.investments / 100).toLocaleString('nl-NL')}. De KIA geldt vanaf € ${rules.kia.min.toLocaleString('nl-NL')} per jaar${running ? '; investeringen later dit jaar tellen mee' : ''}.`,
        where: 'Winst uit onderneming → investeringsaftrek',
        status: adj.kia > 0 ? 'ok' : 'info',
      });
    }
    if (adj.desinvesteringsbijtelling > 0) {
      items.push({
        key: 'desinvestering',
        label: 'Desinvesteringsbijtelling',
        amount: adj.desinvesteringsbijtelling,
        explain: 'Je verkocht een bedrijfsmiddel binnen 5 jaar na de investering; een deel van de KIA van toen telt weer bij de winst.',
        where: 'Winst uit onderneming → investeringsaftrek (desinvestering)',
      });
    }
    items.push({
      key: 'zelfstandigenaftrek',
      label: 'Zelfstandigenaftrek',
      amount: -Math.round(breakdown.zelfstandigenaftrek * 100),
      explain: s.urencriterium
        ? `Omdat je aan het urencriterium voldoet (${rules.urencriterium.toLocaleString('nl-NL')} uur per jaar).`
        : `Je hebt aangegeven niet aan het urencriterium (${rules.urencriterium.toLocaleString('nl-NL')} uur) te voldoen, dus geen zelfstandigenaftrek.`,
      where: 'Ondernemersaftrek',
      status: s.urencriterium ? 'ok' : 'info',
    });
    if (adj.starter || (s.startYear && year - s.startYear < 5)) {
      items.push({
        key: 'startersaftrek',
        label: 'Startersaftrek',
        amount: -Math.round(breakdown.startersaftrek * 100),
        explain: adj.starter
          ? 'Je bent gestart in de afgelopen 5 jaar en gebruikte de startersaftrek nog geen 3 keer.'
          : 'Je hebt de startersaftrek al 3 keer gebruikt, of hij geldt niet meer (vervalt per 2028).',
        where: 'Ondernemersaftrek',
        status: adj.starter ? 'ok' : 'info',
      });
    }
    items.push({
      key: 'mkb',
      label: `Mkb-winstvrijstelling (${(rules.mkbWinstvrijstelling * 100).toLocaleString('nl-NL')}%)`,
      amount: -Math.round(breakdown.mkbWinstvrijstelling * 100),
      explain: 'Over de winst na ondernemersaftrek. Die rekent de aangifte zelf uit.',
      where: 'Mkb-winstvrijstelling',
    });
    if (s.carUse === 'prive' && fuel > 0) {
      items.push({
        key: 'brandstof',
        label: 'Let op: brandstof als kosten geboekt',
        amount: null,
        explain: `Je rijdt met een privéauto, maar er staat € ${(fuel / 100).toFixed(2).replace('.', ',')} aan brandstof/parkeren als kosten. Met een privéauto is alleen € ${(rules.kmRate / 100).toFixed(2).replace('.', ',')} per zakelijke km aftrekbaar: zet die betalingen op "privé" en vul je kilometers in.`,
        status: 'warn',
      });
    }
    if (s.carUse === 'prive' || km.trips > 0) {
      items.push({
        key: 'km',
        label: 'Zakelijke kilometers (privéauto)',
        amount: null,
        explain: `${km.km.toLocaleString('nl-NL')} km × € ${(rules.kmRate / 100).toFixed(2).replace('.', ',')} = € ${(km.amount / 100).toFixed(2).replace('.', ',')}; zit al in de winst.`,
        status: km.trips > 0 ? 'ok' : 'info',
      });
    }
    for (const a of this.assets.list({}, asOf).filter((x) => x.energyHint)) {
      items.push({
        key: `energie-${a.id}`,
        label: `Mogelijk energie- of milieu-aftrek: ${a.name}`,
        amount: null,
        explain: `Staat dit op de Energielijst of Milieulijst (EIA 40%, MIA tot 45%, Vamil)? Dan moet je het binnen 3 maanden na de opdracht melden bij RVO — uiterlijk rond ${a.energyHint!.deadline.split('-').reverse().join('-')}. De app kan dat niet voor je doen.`,
        status: 'warn',
      });
    }
    if (fallback) {
      items.push({ key: 'regels', label: `Bedragen van ${rules.year}`, amount: null, explain: `De bedragen voor ${year} zijn nog niet bekend in de app; gerekend met die van ${rules.year}.`, status: 'warn' });
    }
    return {
      year,
      asOf,
      running,
      profitBooked,
      items,
      breakdown,
      hours: { ...h, target: rules.urencriterium, projected: projectedHours },
      km,
      rulesYear: rules.year,
      rulesChecked: rules.checked,
      disclaimer: OVERVIEW_DISCLAIMER,
    };
  }
}
