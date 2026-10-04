import type { Db } from '../db/database';
import { ACCOUNTS } from '../core-ledger/accounts';
import type { AppSettings, SettingsService } from '../settings/settings';
import { today, type IsoDate } from '../shared/dates';
import type { Cents } from '../shared/money';
import type { AssetService } from './assets';
import { ASSET_THRESHOLD } from './assets';
import type { HoursService, MileageService } from './mileage';
import { carPrivateUseFromLedger, carPrivateUseEntries } from '../btw/car';
import { estimateIncomeTax, kiaFor, profitBetween, representatieBijtelling, rulesFor, type IncomeTaxBreakdown } from './income-tax';

/** De startersaftrek is in 2027 nog € 10 en vervalt per 2028 (wetswijziging); tot die tijd max 3× in de eerste 5 jaar. */
const STARTERSAFTREK_ENDS = 2028;

export function isStarter(s: Pick<AppSettings, 'startYear' | 'startersaftrekUsed'> & Partial<Pick<AppSettings, 'startersaftrekYears'>>, year: number): boolean {
  if (!s.startYear || year < s.startYear || year - s.startYear >= 5 || year >= STARTERSAFTREK_ENDS) return false;
  // opgegeven per jaar (zoals in de aangiftes): dat telt
  if (s.startersaftrekYears) return s.startersaftrekYears.filter((y) => y < year).length < 3;
  // anders de aanname: sinds het moment van opgeven elk jaar gebruikt
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
  /**
   * IB-bijtelling privégebruik auto van de zaak (tot nu toe dit jaar): percentage van de cataloguswaarde, maximaal de autokosten.
   * 'onbekend' = er is wel een auto van de zaak maar de gegevens ontbreken: de schatting is dan te laag.
   */
  carPrivate: { state: 'bekend' | 'onbekend' | 'n.v.t.'; bijtelling: Cents; pct: number; costs: Cents };
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
  'Dit overzicht helpt je je aangifte voor te bereiden; het is geen advies. Jij blijft verantwoordelijk voor je aangifte.';

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

  /**
   * De KIA van een jaar. Voor een afgesloten jaar wordt die de eerste keer vastgelegd, zodat latere
   * wijzigingen in het register (verkopen, uitsluiten) het toegepaste percentage niet meer veranderen.
   */
  private kiaOf(year: number, asOf: IsoDate): { investments: Cents; kia: Cents } {
    const stored = this.db.prepare('SELECT investments, kia FROM kia_applied WHERE year = ?').get(year) as { investments: Cents; kia: Cents } | undefined;
    if (stored) return stored;
    const investments = this.investmentsIn(year);
    const kia = Math.round(kiaFor(investments / 100, rulesFor(year).rules.kia) * 100);
    if (year < Number(asOf.slice(0, 4))) this.db.prepare('INSERT OR IGNORE INTO kia_applied (year, investments, kia) VALUES (?, ?, ?)').run(year, investments, kia);
    return { investments, kia };
  }

  /** KIA-percentage zoals toegepast in het investeringsjaar (voor de desinvesteringsbijtelling). */
  private kiaRate(year: number, asOf: IsoDate): number {
    const { investments, kia } = this.kiaOf(year, asOf);
    return investments > 0 ? kia / investments : 0;
  }

  adjustments(year: number, asOf: IsoDate = today()): FiscalAdjustments {
    const s = this.settings.get();
    const { rules } = rulesFor(year);
    // afgesloten jaren zijn dan geboekt; wat overblijft is alleen het lopende jaar
    this.assets.bookDue(asOf);
    const { investments, kia } = this.kiaOf(year, asOf);

    // verkocht binnen 5 jaar na het begin van het investeringsjaar: (een deel van) de KIA terug
    const sold = this.db
      .prepare(`SELECT acquired_on, cost, proceeds FROM assets WHERE status = 'verkocht' AND kia_excluded = 0 AND cost >= ? AND substr(disposed_on, 1, 4) = ?`)
      .all(ASSET_THRESHOLD, String(year)) as { acquired_on: IsoDate; cost: Cents; proceeds: Cents | null }[];
    const within = sold.filter((a) => year < Number(a.acquired_on.slice(0, 4)) + 5);
    const soldTotal = within.reduce((t, a) => t + (a.proceeds ?? 0), 0);
    const desinvesteringsbijtelling =
      soldTotal > rules.desinvesteringDrempel * 100
        ? within.reduce((t, a) => {
            const rate = this.kiaRate(Number(a.acquired_on.slice(0, 4)), asOf);
            return t + Math.round(rate * Math.min(a.proceeds ?? 0, a.cost));
          }, 0)
        : 0;

    const running = year >= Number(asOf.slice(0, 4));
    const to = running ? asOf : `${year}-12-31`;
    const repr = this.costsOn(ACCOUNTS.representatie, `${year}-01-01`, to);
    // Een per boeking opgegeven zakelijk deel is al verwerkt in kosten en voorbelasting.
    // Ook de tegenboeking deelt dezelfde gebeurtenis; zo heffen correcties elkaar hier op.
    const phoneCosts = (this.db.prepare(`SELECT COALESCE(SUM(l.debit - l.credit), 0) AS s
      FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
      JOIN chart_of_accounts a ON a.id = l.account_id LEFT JOIN events v ON v.id = e.event_id
      WHERE a.rgs_code = 'WBedKanTel' AND e.entry_date BETWEEN ? AND ?
        AND json_extract(v.payload, '$.businessPct') IS NULL`).get(`${year}-01-01`, to) as { s: number }).s;
    const phoneVatBase = (this.db
      .prepare(
        `SELECT COALESCE(SUM(l.debit - l.credit), 0) AS s FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
         JOIN chart_of_accounts a ON a.id = l.account_id LEFT JOIN events v ON v.id = e.event_id WHERE json_extract(v.payload, '$.businessPct') IS NULL AND a.rgs_code = 'WBedKanTel' AND l.vat_code = 'hoog' AND e.entry_date BETWEEN ? AND ?`,
      )
      .get(`${year}-01-01`, to) as { s: number }).s;
    const privatePct = 100 - (s.phoneInternetBusinessPct ?? 100);
    const carPrivate = this.carPrivateIb(year, asOf, to, running);
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
        // KOR: er is geen btw afgetrokken, dus ook niets te corrigeren
        vat: s.kor ? 0 : Math.round((phoneVatBase * 0.21 * privatePct) / 100),
      },
      carPrivate,
      unbookedDepreciation,
      starter: isStarter(s, year),
    };
  }

  /**
   * Bijtelling privégebruik auto van de zaak (belastingdienst.nl, Winst uit onderneming 2026): 22% van de
   * cataloguswaarde, maximaal de autokosten in die periode. Niet meer dan 500 privékilometer: niets
   * (de gebruiker zet dan 'rijd je er ook privé mee' op nee).
   */
  private carPrivateIb(year: number, asOf: IsoDate, to: IsoDate, running: boolean): FiscalAdjustments['carPrivate'] {
    const s = this.settings.get();
    const none = { state: 'n.v.t.' as const, bijtelling: 0, pct: 0, costs: 0 };
    if (s.carUse !== 'zakelijk' || s.carPrivateUse === false) return none;
    if (s.carInUseSince !== null && s.carInUseSince > year) return none;
    if (s.carPrivateUse !== true || !s.carCatalogValue || s.carCatalogValue <= 0) return { ...none, state: 'onbekend' };
    const firstYear = s.carInUseSince === year;
    if (firstYear && !(s.carInUseMonth && s.carInUseMonth >= 1 && s.carInUseMonth <= 12)) return { ...none, state: 'onbekend' };
    const pct = s.carBijtellingPct ?? 22;
    const months = firstYear ? 13 - s.carInUseMonth! : 12;
    const annual = (s.carCatalogValue * pct * months) / 1200;
    const daysInYear = (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86400000;
    const elapsed = running ? Math.min(daysInYear, Math.max(1, (Date.parse(asOf) - Date.UTC(year, 0, 1)) / 86400000 + 1)) : daysInYear;
    const from = `${year}-01-01`;
    // autokosten: brandstof, onderhoud en afschrijving van de vervoermiddelen (de btw-correctie en kilometervergoeding horen er niet bij)
    const unbooked = year > Number(asOf.slice(0, 4)) ? 0 : this.assets.projected(year, running ? Number(asOf.slice(5, 7)) : 12, ACCOUNTS.afschrijvingVervoer);
    const costs = this.costsOn('WBedAutBra', from, to) + this.costsOn('WBedAutOnd', from, to) + this.costsOn(ACCOUNTS.afschrijvingVervoer, from, to) + unbooked;
    const bijtelling = Math.min(Math.round((annual * elapsed) / daysInYear), Math.max(0, costs));
    return { state: 'bekend', bijtelling, pct, costs };
  }

  year(year: number, asOf: IsoDate = today()): TaxYearOverview {
    const s = this.settings.get();
    const { rules, fallback } = rulesFor(year);
    const running = year >= Number(asOf.slice(0, 4));
    const to = running ? asOf : `${year}-12-31`;
    const adj = this.adjustments(year, asOf);
    const profitBooked = profitBetween(this.db, `${year}-01-01`, to);
    const share = s.legalForm === 'vof' ? Math.min(100, Math.max(0, s.profitSharePct)) / 100 : 1;
    const profit = Math.round((profitBooked - adj.unbookedDepreciation) * share);
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
      bijtellingen: (adj.representatie.bijtelling + adj.desinvesteringsbijtelling + adj.phonePrivate.bijtelling + adj.carPrivate.bijtelling) / 100,
      partnerHours: s.partnerHours,
      nietGerealiseerd: s.nietGerealiseerdeZelfstandigenaftrek,
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
    const credits = this.assets.unassignedCredits(false); // bookDue (sync) draaide hierboven al
    // Voor een personenauto bestaat geen investeringsaftrek. Een vervoermiddel dat toch meetelt, vraagt om een controle.
    const carsInKia = this.db
      .prepare(`SELECT COUNT(*) AS n FROM assets WHERE status != 'vervallen' AND kia_excluded = 0 AND account_rgs = ? AND cost >= ? AND substr(acquired_on, 1, 4) = ?`)
      .get(ACCOUNTS.vervoermiddelen, ASSET_THRESHOLD, String(year)) as { n: number };
    if (carsInKia.n > 0) {
      items.push({
        key: 'kia-auto',
        label: 'Telt je auto mee voor de investeringsaftrek?',
        amount: null,
        explain: 'Voor een personenauto krijg je geen investeringsaftrek (alleen voor bijvoorbeeld een bestelauto of taxi). Een auto die nu meetelt, kan de aftrek te hoog maken.',
        note: `${carsInKia.n} ${carsInKia.n === 1 ? 'vervoermiddel telt' : 'vervoermiddelen tellen'} mee. Bij Investeringen zet je "Dit is een personenauto" aan als het er een is.`,
        status: 'warn',
      });
    }
    if (credits.length) items.push({ key: 'investering-credit', label: 'Koppel creditnota’s aan je investeringen', amount: null, explain: 'Bij Investeringen kies je bij welke aankoop elke creditnota hoort. Tot die tijd kunnen afschrijving en investeringsaftrek afwijken.', note: `${credits.length} creditnota’s nog niet toegewezen.`, status: 'warn' });
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
            : adj.investments / 100 > rules.kia.phaseOutUpTo
              ? `Je kocht dit jaar voor ${eur(adj.investments)} aan dingen die jaren meegaan. Boven € ${rules.kia.phaseOutUpTo.toLocaleString('nl-NL')} per jaar is er geen extra aftrek meer.`
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
        note: `Desinvesteringsbijtelling (drempel € ${rules.desinvesteringDrempel.toLocaleString('nl-NL')} per jaar): KIA-percentage van het investeringsjaar × verkoopprijs, nooit meer dan de eerder gekregen KIA. Ook naar privé overgebracht telt als verkoop (tegen de waarde in het economisch verkeer).`,
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
        note: `Startersaftrek (ondernemersaftrek); ${s.startersaftrekYears ? `eerder gebruikt in: ${s.startersaftrekYears.join(', ') || 'geen jaren'}` : 'aanname: sinds opgave elk jaar gebruikt (per jaar opgeven bij Instellingen)'}. Bij recht op startersaftrek geldt de beperking van de zelfstandigenaftrek tot de winst niet. 2027: € 10, vanaf 2028 vervallen.`,
        status: adj.starter ? 'ok' : 'info',
      });
    }
    if (breakdown.zelfstandigenaftrekVerrekend > 0) {
      items.push({
        key: 'za-verrekend',
        label: 'Aftrek voor zelfstandigen uit eerdere jaren',
        amount: -Math.round(breakdown.zelfstandigenaftrekVerrekend * 100),
        explain: 'In eerdere jaren was je winst te laag voor de hele aftrek. Een deel daarvan mag je nu alsnog aftrekken.',
        note: `Verrekening niet-gerealiseerde zelfstandigenaftrek (opgegeven openstaand: € ${s.nietGerealiseerdeZelfstandigenaftrek.toLocaleString('nl-NL')}). Zelf bijhouden wat verrekend is.`,
        status: 'ok',
      });
    }
    if (breakdown.zelfstandigenaftrekNietGerealiseerd > 0) {
      items.push({
        key: 'za-niet-gerealiseerd',
        label: 'Aftrek voor zelfstandigen: past niet helemaal',
        amount: null,
        explain: `Je winst is te laag voor de hele aftrek. De rest (€ ${breakdown.zelfstandigenaftrekNietGerealiseerd.toLocaleString('nl-NL')}) mag je de komende 9 jaar alsnog aftrekken. Dat bedrag staat later op je aanslag.`,
        note: `Niet-gerealiseerde zelfstandigenaftrek € ${breakdown.zelfstandigenaftrekNietGerealiseerd.toLocaleString('nl-NL')}; 9 jaar verrekenbaar voor zover de winst hoger is dan de zelfstandigenaftrek van dat jaar.`,
        status: 'info',
      });
    }
    if (breakdown.meewerkaftrek > 0) {
      items.push({
        key: 'meewerkaftrek',
        label: 'Aftrek omdat je partner meewerkt',
        amount: -Math.round(breakdown.meewerkaftrek * 100),
        explain: `Je partner helpt ${s.partnerHours.toLocaleString('nl-NL')} uur per jaar mee zonder (veel) loon.`,
        note: 'Meewerkaftrek naar uren partner. Voorwaarden controleren: partner krijgt geen of een lage vergoeding (< € 5.000) en er is geen samenwerkingsverband.',
        status: 'ok',
      });
    }
    items.push({
      key: 'mkb',
      label: 'Korting voor kleine bedrijven',
      amount: -Math.round(breakdown.mkbWinstvrijstelling * 100),
      explain: `Over je winst hoef je ${(rules.mkbWinstvrijstelling * 100).toLocaleString('nl-NL')}% geen belasting te betalen. Dat gaat vanzelf.`,
      note: 'Mkb-winstvrijstelling over de winst na ondernemersaftrek (bij verlies: verkleint het verlies).',
    });
    if (breakdown.taxableProfit < 0) {
      items.push({
        key: 'verlies',
        label: 'Verlies',
        amount: null,
        explain: `Je maakt fiscaal verlies (€ ${(-breakdown.taxableProfit).toLocaleString('nl-NL')}). Dan betaal je over je bedrijf geen belasting, en dat verlies mag je verrekenen met ander inkomen of met andere jaren. Je boekhouder regelt dat.`,
        note: `Fiscaal verlies uit onderneming € ${(-breakdown.taxableProfit).toLocaleString('nl-NL')} (na ondernemersaftrek en mkb-winstvrijstelling). Verliesverrekening niet in de schatting.`,
        status: 'info',
      });
    }
    if (breakdown.tariefsaanpassing > 0) {
      items.push({
        key: 'tariefsaanpassing',
        label: 'Minder voordeel van je aftrek bij een hoog inkomen',
        amount: null,
        explain: `Omdat je winst in het hoogste tarief valt, leveren je aftrekposten minder op. Daardoor betaal je ongeveer € ${breakdown.tariefsaanpassing.toLocaleString('nl-NL')} meer. Dat zit al in de schatting.`,
        note: `Tariefsaanpassing ondernemersaftrek en mkb-winstvrijstelling (art. 2.10a Wet IB 2001): € ${breakdown.tariefsaanpassing.toLocaleString('nl-NL')}.`,
        status: 'info',
      });
    }
    if (s.carUse === 'prive' && fuel > 0) {
      items.push({
        key: 'brandstof',
        label: 'Controleer je autokosten',
        amount: null,
        explain: `Je rijdt met je eigen auto, maar er staat ${eur(fuel)} aan tanken, parkeren of onderhoud bij je zakelijke kosten. Dat mag niet: je krijgt al € ${(rules.kmRate / 100).toFixed(2).replace('.', ',')} per zakelijke kilometer. Zet die betalingen op "privé" en vul je kilometers in.`,
        note: 'Privéauto: kosten niet aftrekbaar voor de IB naast de kilometervergoeding. Btw op brandstof/onderhoud kan wel naar rato van zakelijk gebruik aftrekbaar zijn (app laat dit liggen).',
        status: 'warn',
      });
    }
    if (s.carUse === 'zakelijk' && s.carPrivateUse !== false) {
      const car = carPrivateUseFromLedger(this.db, s, year);
      // alleen de correctie die de app zelf boekte, en alleen als het bedrag nog klopt
      const bookedAmount = carPrivateUseEntries(this.db, year).reduce((sum, e) => sum + e.amount, 0);
      const booked = car.state === 'bekend' && bookedAmount === car.amount;
      items.push({
        key: 'auto-prive',
        label: 'Privégebruik van je auto van de zaak',
        amount: null,
        explain:
          car.state === 'bekend'
            ? `Over privégebruik betaal je btw: ${eur(car.amount)} dit jaar. De app zet dat klaar in je laatste btw-aangifte van het jaar${booked ? ' (al gedaan)' : ''}. Privégebruik telt ook mee voor de inkomstenbelasting (bijtelling); zie het onderdeel hierover.`
            : car.state === 'werkelijk'
              ? 'Je rekent de btw over privégebruik met je werkelijke privékilometers. Dat bedrag rekent je boekhouder uit. Privégebruik telt ook mee voor de inkomstenbelasting (bijtelling); zie het onderdeel hierover.'
              : car.state === 'n.v.t.'
                ? 'Je hebt geen btw teruggekregen op de auto of de kosten, dus je betaalt geen btw over het privégebruik. Privégebruik telt wel mee voor de inkomstenbelasting (bijtelling); zie het onderdeel hierover.'
                : 'Rijd je ook privé in je auto van de zaak? Vul dat in bij Instellingen → Btw. Dan betaal je misschien btw over het privégebruik en telt het mee voor de inkomstenbelasting (bijtelling).',
        note:
          car.state === 'bekend'
            ? `Auto van de zaak met privégebruik; btw afgetrokken, forfait gekozen. Btw-correctie ${(car.pct * 100).toLocaleString('nl-NL')}% van cataloguswaarde ${eur(car.catalogValue)} = ${eur(car.amount)}${booked ? ', geboekt in vak 1d' : ', nog niet geboekt'}${car.months < 12 ? `; naar rato over ${car.months} maanden (auto dit jaar in gebruik genomen)` : ''}. Controleren: eigen bijdrage, historie van de auto (bijv. marge-auto, aftrek alleen op kosten). IB-bijtelling: zie het onderdeel Bijtelling.`
            : car.state === 'werkelijk'
              ? 'Auto van de zaak: btw-correctie privégebruik op basis van werkelijk gebruik (rittenadministratie); bedrag niet door de app berekend of geboekt (1d).'
              : car.state === 'n.v.t.'
                ? 'Auto van de zaak: volgens de gebruiker geen btw afgetrokken op aanschaf of kosten, dus geen btw-correctie privégebruik. Controleren; IB-bijtelling: zie het onderdeel Bijtelling.'
                : 'Auto van de zaak: privégebruik, btw-aftrek of methode niet opgegeven. Btw-correctie (1d) en IB-bijtelling controleren.',
        forAccountant: true,
        status: car.state === 'bekend' && booked ? 'ok' : 'warn',
      });
    }
    if (adj.carPrivate.state === 'bekend') {
      const cp = adj.carPrivate;
      items.push({
        key: 'auto-bijtelling',
        label: 'Bijtelling privégebruik auto van de zaak',
        amount: cp.bijtelling,
        explain: `Je rijdt privé in je auto van de zaak. Daarvoor tel je ${cp.pct}% van de cataloguswaarde bij je winst, maar nooit meer dan de autokosten (${eur(cp.costs)} tot nu toe). Dat is ${eur(cp.bijtelling)} en zit in de schatting. Reed je niet meer dan 500 kilometer privé? Zet dat dan bij Instellingen op "alleen zakelijk" en bewaar je rittenregistratie.`,
        note: `Bijtelling privégebruik auto: ${cp.pct}% van cataloguswaarde, maximaal de autokosten (brandstof, onderhoud en verzekering, afschrijving: ${eur(cp.costs)}). Percentage is zo ingevuld of standaard 22%; controleren bij een zuinige auto, een auto ouder dan 16 jaar of meerdere auto's in het jaar.`,
        status: 'info',
      });
    } else if (adj.carPrivate.state === 'onbekend') {
      items.push({
        key: 'auto-bijtelling',
        label: 'Bijtelling auto van de zaak ontbreekt in de schatting',
        amount: null,
        explain: 'Je hebt een auto van de zaak, maar de gegevens voor de bijtelling (privégebruik, cataloguswaarde, sinds wanneer) zijn niet compleet. Daardoor is de schatting van je inkomstenbelasting te laag. Vul ze in bij Instellingen → Btw.',
        note: 'IB-bijtelling privégebruik auto niet berekend: gegevens ontbreken. Schatting en reserve te laag.',
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
            ? 'Een aparte werkruimte met eigen ingang kan aftrekbaar zijn. Dat hangt af van hoeveel je daar verdient. Je boekhouder rekent dat uit.'
            : 'Je kamer of werkhoek thuis zelf mag je niet aftrekken, ook de energie of huur niet. Spullen die je vooral voor je werk gebruikt, zoals een laptop of printer, kunnen wel zakelijk zijn. Twijfel je over de inrichting (bureau, stoel, kast)? Vraag het je boekhouder.',
        note:
          s.homeWorkspace === 'zelfstandig'
            ? 'Zelfstandige werkruimte opgegeven: toets inkomenseis (70%/30%) en bereken aftrek (niet door de app gedaan). Inrichting volgt die toets.'
            : 'Niet-zelfstandige werkruimte: kosten werkruimte niet aftrekbaar. Losse bedrijfsmiddelen en inrichting apart beoordelen op zakelijk gebruik.',
        status: 'info',
      });
    }
    items.push({
      key: 'aov',
      label: 'Arbeidsongeschiktheidsverzekering (AOV) en pensioen',
      amount: null,
      explain: 'Dit zijn geen bedrijfskosten: zet ze op "privé". Ze kunnen wel aftrekbaar zijn in je aangifte, als aan de voorwaarden is voldaan. Geef je boekhouder door hoeveel je betaalde.',
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
