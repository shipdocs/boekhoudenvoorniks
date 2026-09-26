import type { Db } from '../db/database';
import { ACCOUNTS } from '../core-ledger/accounts';
import type { AppSettings, SettingsService } from '../settings/settings';
import { today, type IsoDate } from '../shared/dates';
import type { Cents } from '../shared/money';
import type { AssetService } from './assets';
import { ASSET_THRESHOLD } from './assets';
import type { HoursService, MileageService } from './mileage';
import { estimateIncomeTax, kiaFor, profitBetween, representatieBijtelling, rulesFor, type IncomeTaxBreakdown } from './income-tax';

/** De startersaftrek is in 2027 nog € 10 en vervalt per 2028 (wetswijziging); tot die tijd max 3× in de eerste 5 jaar. */
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
  /** privédeel van telefoon & internet: bijtelling en de btw die je dan niet mag aftrekken */
  phonePrivate: { costs: Cents; pct: number; bijtelling: Cents; vat: Cents };
  /** nog niet geboekte afschrijving (lopend jaar: tot en met `untilMonth`) */
  unbookedDepreciation: Cents;
  starter: boolean;
}

export interface OverviewItem {
  key: string;
  label: string;
  /** effect op de fiscale winst in centen: + bijtelling, − aftrek; null = alleen informatie */
  amount: Cents | null;
  /** uitleg in gewone taal, voor de gebruiker */
  explain: string;
  /** vaktaal en details voor de boekhouder (fiscale term, waar in de aangifte); niet in beeld, wel in "Kopieer voor je boekhouder" */
  note?: string;
  /** te technisch voor de gebruiker: alleen als notitie voor de boekhouder (het bedrag telt wel mee) */
  forAccountant?: boolean;
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
  'Dit overzicht is een hulpmiddel om je aangifte voor te bereiden, geen advies. Laat het altijd controleren door een boekhouder of accountant voordat je iets indient: de regels veranderen, de software kan fouten maken en de app kent je hele situatie niet. Jij blijft verantwoordelijk voor je aangifte.';

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
    const phoneCosts = this.costsOn('WBedKanTel', `${year}-01-01`, to);
    const phoneVatBase = (this.db
      .prepare(
        `SELECT COALESCE(SUM(l.debit - l.credit), 0) AS s FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
         JOIN chart_of_accounts a ON a.id = l.account_id WHERE a.rgs_code = 'WBedKanTel' AND l.vat_code = 'hoog' AND e.entry_date BETWEEN ? AND ?`,
      )
      .get(`${year}-01-01`, to) as { s: number }).s;
    const privatePct = 100 - (s.phoneInternetBusinessPct ?? 100);
    const unbookedDepreciation = year > Number(asOf.slice(0, 4)) ? 0 : this.assets.projected(year, running ? Number(asOf.slice(5, 7)) : 12);
    return {
      investments,
      kia,
      desinvesteringsbijtelling,
      representatie: { total: repr, bijtelling: Math.round(representatieBijtelling(repr / 100, rules.representatie) * 100) },
      phonePrivate: {
        costs: phoneCosts,
        pct: privatePct,
        bijtelling: Math.round((phoneCosts * privatePct) / 100),
        vat: Math.round((phoneVatBase * 0.21 * privatePct) / 100),
      },
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
      bijtellingen: (adj.representatie.bijtelling + adj.desinvesteringsbijtelling + adj.phonePrivate.bijtelling) / 100,
      partnerHours: s.partnerHours,
    });
    const fuel = this.costsOn('WBedAutBra', `${year}-01-01`, to) + this.costsOn('WBedAutOnd', `${year}-01-01`, to);
    const eur = (c: number) => `€ ${(c / 100).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const items: OverviewItem[] = [];
    items.push({
      key: 'winst',
      label: 'Je winst',
      amount: profit,
      explain: 'Wat je verdiende min je zakelijke kosten. Ook de kilometers en het deel van je investeringen voor dit jaar zijn er al af.',
      note: `Winst uit onderneming volgens de boekhouding${adj.unbookedDepreciation > 0 ? `, inclusief ${eur(adj.unbookedDepreciation)} afschrijving ${running ? 'tot nu toe (wordt na afloop van het jaar geboekt)' : 'die nog niet geboekt is'}` : ''}.`,
    });
    if (adj.representatie.total > 0) {
      items.push({
        key: 'representatie',
        label: 'Etentjes, borrels en relatiegeschenken',
        amount: adj.representatie.bijtelling,
        explain: `Deze kosten (${eur(adj.representatie.total)}) mag je niet helemaal aftrekken. Een klein deel telt daarom weer mee als winst. De app rekent dat voor je uit.`,
        note: `Beperkt aftrekbare kosten (representatie): bijtelling = min(20%, drempel € ${rules.representatie.drempel.toLocaleString('nl-NL')}). Aangifte: winst uit onderneming → niet-aftrekbare kosten.`,
      });
    }
    if (adj.phonePrivate.bijtelling > 0) {
      items.push({
        key: 'telefoon-prive',
        label: 'Telefoon en internet: privédeel',
        amount: adj.phonePrivate.bijtelling,
        explain: `Je gebruikt je telefoon en internet voor ${adj.phonePrivate.pct}% privé. Dat deel telt niet als zakelijke kosten.`,
        note: `Privégebruik ${adj.phonePrivate.pct}% van ${eur(adj.phonePrivate.costs)} (WBedKanTel) bijgeteld.${adj.phonePrivate.vat > 0 ? ` Btw-correctie privégebruik ± ${eur(adj.phonePrivate.vat)}: minder voorbelasting (5b) in de laatste aangifte van het jaar; nog niet geboekt.` : ''}`,
      });
    }
    if (adj.investments > 0) {
      items.push({
        key: 'kia',
        label: 'Extra aftrek voor je investeringen',
        amount: -adj.kia,
        explain:
          adj.kia > 0
            ? `Je kocht dit jaar voor ${eur(adj.investments)} aan dingen die jaren meegaan (vanaf € 450 per stuk). Daarvoor krijg je extra aftrek.`
            : `Je kocht dit jaar voor ${eur(adj.investments)} aan dingen die jaren meegaan. Extra aftrek krijg je pas vanaf € ${rules.kia.min.toLocaleString('nl-NL')} per jaar${running ? '; wat je later dit jaar nog koopt, telt mee' : ''}.`,
        note: `Kleinschaligheidsinvesteringsaftrek (KIA) over ${eur(adj.investments)} investeringen. Aangifte: winst uit onderneming → investeringsaftrek.`,
        status: adj.kia > 0 ? 'ok' : 'info',
      });
    }
    if (adj.desinvesteringsbijtelling > 0) {
      items.push({
        key: 'desinvestering',
        label: 'Verkocht binnen 5 jaar: deel van de extra aftrek terug',
        amount: adj.desinvesteringsbijtelling,
        explain: 'Je verkocht iets dat je minder dan 5 jaar geleden kocht. Een deel van de extra aftrek van toen moet je terugbetalen.',
        note: 'Desinvesteringsbijtelling: effectief KIA-percentage van het investeringsjaar × verkoopprijs (max. over aanschafprijs).',
        forAccountant: true,
      });
    }
    items.push({
      key: 'zelfstandigenaftrek',
      label: 'Aftrek voor zelfstandigen',
      amount: -Math.round(breakdown.zelfstandigenaftrek * 100),
      explain: s.urencriterium
        ? `Omdat je minstens ${rules.urencriterium.toLocaleString('nl-NL')} uur per jaar aan je bedrijf werkt.`
        : `Die krijg je alleen als je minstens ${rules.urencriterium.toLocaleString('nl-NL')} uur per jaar aan je bedrijf werkt. Je hebt aangegeven dat je dat niet haalt.`,
      note: 'Zelfstandigenaftrek (ondernemersaftrek), met urencriterium.',
      status: s.urencriterium ? 'ok' : 'info',
    });
    if (adj.starter || (s.startYear && year - s.startYear < 5)) {
      items.push({
        key: 'startersaftrek',
        label: 'Extra aftrek voor starters',
        amount: -Math.round(breakdown.startersaftrek * 100),
        explain: adj.starter
          ? 'Omdat je bedrijf nog geen 5 jaar bestaat. Je krijgt deze aftrek hooguit 3 keer, en na 2027 bestaat hij niet meer.'
          : 'Deze aftrek heb je al 3 keer gehad, of hij bestaat niet meer (na 2027 afgeschaft).',
        note: 'Startersaftrek (ondernemersaftrek); aanname: sinds opgave elk jaar gebruikt. 2027: € 10, vanaf 2028 vervallen.',
        status: adj.starter ? 'ok' : 'info',
      });
    }
    if (breakdown.meewerkaftrek > 0) {
      items.push({
        key: 'meewerkaftrek',
        label: 'Aftrek omdat je partner meewerkt',
        amount: -Math.round(breakdown.meewerkaftrek * 100),
        explain: `Je partner helpt ${s.partnerHours.toLocaleString('nl-NL')} uur per jaar mee zonder (veel) loon.`,
        note: 'Meewerkaftrek naar uren partner; aanname: vergoeding partner < € 5.000.',
        status: 'ok',
      });
    }
    items.push({
      key: 'mkb',
      label: 'Korting voor kleine bedrijven',
      amount: -Math.round(breakdown.mkbWinstvrijstelling * 100),
      explain: `Over je winst hoef je ${(rules.mkbWinstvrijstelling * 100).toLocaleString('nl-NL')}% geen belasting te betalen. Dat gaat vanzelf.`,
      note: 'Mkb-winstvrijstelling over de winst na ondernemersaftrek.',
    });
    if (s.carUse === 'prive' && fuel > 0) {
      items.push({
        key: 'brandstof',
        label: 'Controleer je autokosten',
        amount: null,
        explain: `Je rijdt met je eigen auto, maar er staat ${eur(fuel)} aan tanken, parkeren of onderhoud bij je zakelijke kosten. Dat mag niet: je krijgt al € ${(rules.kmRate / 100).toFixed(2).replace('.', ',')} per zakelijke kilometer. Zet die betalingen op "privé" en vul je kilometers in.`,
        status: 'warn',
      });
    }
    if (s.carUse === 'prive' || km.trips > 0) {
      items.push({
        key: 'km',
        label: 'Kilometers met je eigen auto',
        amount: null,
        explain: `${km.km.toLocaleString('nl-NL')} km × € ${(rules.kmRate / 100).toFixed(2).replace('.', ',')} = ${eur(km.amount)}. Dat zit al in je winst.`,
        status: km.trips > 0 ? 'ok' : 'info',
      });
    }
    for (const a of this.assets.list({}, asOf).filter((x) => x.energyHint)) {
      const deadline = a.energyHint!.deadline.split('-').reverse().join('-');
      items.push({
        key: `energie-${a.id}`,
        label: `Misschien extra aftrek: ${a.name}`,
        amount: null,
        explain: `Voor sommige energiezuinige of milieuvriendelijke aankopen krijg je veel extra aftrek. Dat moet je wel snel aanvragen. Vraag je boekhouder vóór ${deadline} of dit meetelt.`,
        note: `Mogelijk EIA/MIA/Vamil (Energielijst/Milieulijst). Melden bij RVO binnen 3 maanden na opdracht; aankoopdatum ${a.acquired_on}.`,
        status: 'warn',
      });
    }
    if (s.homeWorkspace === 'thuis' || s.homeWorkspace === 'zelfstandig') {
      items.push({
        key: 'werkruimte',
        label: 'Werkplek thuis',
        amount: null,
        explain:
          s.homeWorkspace === 'zelfstandig'
            ? 'Een aparte werkruimte met eigen ingang kan aftrekbaar zijn. Dat hangt af van hoeveel je daar verdient. Je boekhouder rekent dat uit. Je bureau, stoel en kast mag je altijd aftrekken.'
            : 'Je kamer of werkhoek thuis zelf mag je niet aftrekken, ook de energie of huur niet. Je bureau, stoel, kast en apparaten wel.',
        note: s.homeWorkspace === 'zelfstandig' ? 'Zelfstandige werkruimte opgegeven: toets inkomenseis (70%/30%) en bereken aftrek (niet door de app gedaan).' : undefined,
        status: 'info',
      });
    }
    items.push({
      key: 'aov',
      label: 'Arbeidsongeschiktheidsverzekering (AOV) en pensioen',
      amount: null,
      explain: 'Dit zijn geen bedrijfskosten: zet ze op "privé". Je mag ze wel aftrekken in je aangifte. Geef je boekhouder door hoeveel je betaalde.',
      note: 'AOV: uitgaven voor inkomensvoorzieningen. Lijfrente/pensioen: binnen jaarruimte/reserveringsruimte.',
      status: 'info',
    });
    if (fallback) {
      items.push({ key: 'regels', label: `Bedragen van ${rules.year}`, amount: null, explain: `Voor ${year} kent de app nog niet alle bedragen.`, note: `Gerekend met de tabel van ${rules.year} (plus bekende wijzigingen); controleren.`, forAccountant: true, status: 'warn' });
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
