import type { Db } from '../db/database';
import { tx } from '../db/database';
import { Ledger, signedLine, type PostLine } from '../core-ledger/ledger';
import { ACCOUNTS } from '../core-ledger/accounts';
import type { SettingsService } from '../settings/settings';
import { centsToDecimalString, formatEuro, type Cents } from '../shared/money';
import { addDays, periodFor, periodFromKey, today, type IsoDate, type Period } from '../shared/dates';
import { runVatChecks, skipKey, type VatCheck } from './checks';
import { ValidationError } from '../shared/validation';

/**
 * BTW-engine. Leest uitsluitend uit journal_lines (via de BTW-code per regel en de
 * BTW-/omzetrekeningen) en vertaalt dat naar de rubrieken van de aangifte omzetbelasting.
 * De gebruiker ziet een simpele samenvatting; de rubrieken staan eronder om over te nemen.
 *
 * LET OP: laten reviewen door boekhouder/fiscalist vóór livegang (GitHub-issue).
 */

export interface Rubriek {
  code: string;
  label: string;
  /** grondslag (omzet), in centen; null als de rubriek geen omzetvak heeft */
  omzet: Cents | null;
  btw: Cents | null;
  /** zoals in te vullen in Mijn Belastingdienst Zakelijk (hele euro's, afgerond in uw voordeel) */
  omzetEuro: number | null;
  btwEuro: number | null;
}

export interface VatReport {
  period: Period;
  status: 'open' | 'concept' | 'ingediend';
  rubrieken: Rubriek[];
  /** Voor de gebruiker: de vier getallen die ertoe doen */
  summary: {
    omzet: Cents;
    /** btw over je eigen omzet (1a/1b) */
    btwOverOmzet: Cents;
    /** verlegde btw op inkoop (2a/4a/4b): aangegeven én als voorbelasting afgetrokken */
    btwVerlegd: Cents;
    voorbelasting: Cents;
    teBetalen: Cents;
    teBetalenEuro: number;
  };
  breakdown: { vatCode: string; label: string; omzet: Cents; btw: Cents }[];
  /** correcties op eerdere, al aangegeven periodes die in dit bedrag zitten */
  corrections: VatCorrection[];
  warnings: string[];
  submittedAt: string | null;
}

export interface IcpLine {
  relationId: number | null;
  name: string;
  /** landcode uit het btw-nummer (EL = Griekenland) */
  country: string;
  vatNumber: string;
  amount: Cents;
  amountEuro: number;
  problems: string[];
}

export interface IcpReport {
  period: Period;
  lines: IcpLine[];
  total: Cents;
}

export interface VatCorrection {
  /** de al aangegeven periode waar de correctie over gaat */
  periodKey: string;
  label: string;
  /** effect op het te betalen bedrag, in centen (positief = meer betalen) */
  btw: Cents;
  entries: number;
  /** hoogste journaalpost-id in deze correctie (voor het afhandelen via suppletie) */
  maxEntryId: number;
  /** boven de grens: een suppletie-aangifte is nodig in plaats van meenemen in de volgende aangifte */
  suppletie: boolean;
}

/** Correcties tot en met € 1.000 btw mag je meenemen in de volgende aangifte; daarboven een suppletie. */
export const SUPPLETIE_THRESHOLD: Cents = 100000;
export const SUPPLETIE_URL = 'https://www.belastingdienst.nl/wps/wcm/connect/nl/btw/content/btw-aangifte-corrigeren';

const safeLabel = (key: string) => {
  try {
    return periodFromKey(key).label;
  } catch {
    return key;
  }
};

/** #16: buitenland is gebouwd zonder fiscale review; altijd tonen als deze rubrieken gevuld zijn. */
export const BUITENLAND_DISCLAIMER =
  'Let op: verkoop en inkoop in het buitenland zijn in de app nog niet door een belastingexpert nagekeken. Laat die bedragen controleren voordat je de aangifte doet. Verkoop je via een webshop aan particulieren in andere EU-landen? Dat kan de app nog niet: vraag je boekhouder.';

export const PORTAL_URL = 'https://www.belastingdienst.nl/wps/wcm/connect/nl/btw/content/btw-aangifte-doen';

const floorEuro = (c: Cents) => Math.floor(c / 100);
const ceilEuro = (c: Cents) => Math.ceil(c / 100);

export class VatService {
  constructor(
    private readonly db: Db,
    private readonly ledger: Ledger,
    private readonly settings: SettingsService,
  ) {}

  /** Posten die al met een suppletie-aangifte zijn afgehandeld. */
  private static readonly SETTLED = `EXISTS (SELECT 1 FROM vat_suppleties s WHERE s.correction_period_key = e.vat_correction_of AND e.id <= s.max_entry_id)`;

  /**
   * Som van (credit − debet) per rekening/btw-code in een periode, exclusief afsluitboekingen,
   * correcties die via een suppletie lopen (of al gelopen hebben).
   */
  private sums(start: IsoDate, end: IsoDate, excludeCorrectionsOf: string[] = []) {
    const excl = excludeCorrectionsOf.length ? `AND (e.vat_correction_of IS NULL OR e.vat_correction_of NOT IN (${excludeCorrectionsOf.map(() => '?').join(',')}))` : '';
    return this.db
      .prepare(
        `SELECT a.rgs_code, a.category, l.vat_code, SUM(l.credit) - SUM(l.debit) AS net
         FROM journal_lines l
         JOIN journal_entries e ON e.id = l.journal_entry_id
         JOIN chart_of_accounts a ON a.id = l.account_id
         WHERE COALESCE(e.vat_date, e.entry_date) BETWEEN ? AND ? AND e.source <> 'btw'
           AND NOT ${VatService.SETTLED} ${excl}
         GROUP BY a.rgs_code, a.category, l.vat_code`,
      )
      .all(start, end, ...excludeCorrectionsOf) as { rgs_code: string; category: string; vat_code: string | null; net: number }[];
  }

  /**
   * Nog niet afgehandelde correcties op al aangegeven periodes (#27), per oorspronkelijke periode.
   * Zonder datumbereik: alle openstaande correcties (voor de inbox).
   * `btw` is het effect op het te betalen bedrag (positief = meer betalen).
   */
  corrections(start?: IsoDate, end?: IsoDate): VatCorrection[] {
    const range = start && end ? 'AND COALESCE(e.vat_date, e.entry_date) BETWEEN ? AND ?' : '';
    const rows = this.db
      .prepare(
        `SELECT e.vat_correction_of AS period_key, a.rgs_code, SUM(l.credit) - SUM(l.debit) AS net, MAX(e.id) AS max_id,
                COUNT(DISTINCT e.id) AS entries
         FROM journal_lines l
         JOIN journal_entries e ON e.id = l.journal_entry_id
         JOIN chart_of_accounts a ON a.id = l.account_id
         WHERE e.vat_correction_of IS NOT NULL AND e.source <> 'btw' AND NOT ${VatService.SETTLED} ${range}
         GROUP BY e.vat_correction_of, a.rgs_code`,
      )
      .all(...(start && end ? [start, end] : [])) as { period_key: string; rgs_code: string; net: number; max_id: number; entries: number }[];
    const vatAccounts = new Set<string>([ACCOUNTS.btwAfdragenHoog, ACCOUNTS.btwAfdragenLaag, ACCOUNTS.btwAfdragenVerlegd, ACCOUNTS.btwAfdragenEu, ACCOUNTS.btwAfdragenBuitenEu, ACCOUNTS.btwVoorbelasting]);
    const byPeriod = new Map<string, VatCorrection>();
    for (const r of rows) {
      const c = byPeriod.get(r.period_key) ?? { periodKey: r.period_key, label: safeLabel(r.period_key), btw: 0, entries: 0, maxEntryId: 0, suppletie: false };
      if (vatAccounts.has(r.rgs_code)) c.btw += r.net;
      c.entries = Math.max(c.entries, r.entries);
      c.maxEntryId = Math.max(c.maxEntryId, r.max_id);
      byPeriod.set(r.period_key, c);
    }
    const list = [...byPeriod.values()].filter((c) => c.btw !== 0).sort((a, b) => a.periodKey.localeCompare(b.periodKey));
    for (const c of list) c.suppletie = Math.abs(c.btw) > SUPPLETIE_THRESHOLD;
    return list;
  }

  /**
   * De gebruiker heeft de suppletie-aangifte voor een eerdere periode gedaan: boek het bedrag
   * over naar "af te dragen omzetbelasting" en haal de correcties uit de gewone aangifte.
   */
  markSuppletieSubmitted(correctionPeriodKey: string): VatCorrection {
    return tx(this.db, () => {
      const c = this.corrections().find((x) => x.periodKey === correctionPeriodKey);
      if (!c) throw new ValidationError(`Er staan geen correcties open voor ${safeLabel(correctionPeriodKey)}`);
      if (!c.suppletie) throw new ValidationError(`Het verschil over ${c.label} is € 1.000 of minder. Dat gaat vanzelf mee in je volgende aangifte`);
      const rows = this.db
        .prepare(
          `SELECT a.rgs_code, SUM(l.credit) - SUM(l.debit) AS net
           FROM journal_lines l
           JOIN journal_entries e ON e.id = l.journal_entry_id
           JOIN chart_of_accounts a ON a.id = l.account_id
           WHERE e.vat_correction_of = ? AND e.id <= ? AND e.source <> 'btw' AND NOT ${VatService.SETTLED}
           GROUP BY a.rgs_code`,
        )
        .all(correctionPeriodKey, c.maxEntryId) as { rgs_code: string; net: number }[];
      const net = (rgs: string) => rows.find((r) => r.rgs_code === rgs)?.net ?? 0;
      const lines = [
        signedLine(ACCOUNTS.btwAfdragenHoog, net(ACCOUNTS.btwAfdragenHoog)),
        signedLine(ACCOUNTS.btwAfdragenLaag, net(ACCOUNTS.btwAfdragenLaag)),
        signedLine(ACCOUNTS.btwAfdragenVerlegd, net(ACCOUNTS.btwAfdragenVerlegd)),
        signedLine(ACCOUNTS.btwAfdragenEu, net(ACCOUNTS.btwAfdragenEu)),
        signedLine(ACCOUNTS.btwAfdragenBuitenEu, net(ACCOUNTS.btwAfdragenBuitenEu)),
        signedLine(ACCOUNTS.btwVoorbelasting, net(ACCOUNTS.btwVoorbelasting)),
        signedLine(ACCOUNTS.btwAfrekening, -c.btw),
      ].filter((l): l is PostLine => l !== null);
      const entryId = this.ledger.post({ date: today(), description: `Suppletie btw ${c.label}`, source: 'btw', sourceRef: `suppletie:${c.periodKey}`, lines });
      this.db
        .prepare('INSERT INTO vat_suppleties (correction_period_key, btw, max_entry_id, journal_entry_id) VALUES (?, ?, ?, ?)')
        .run(c.periodKey, c.btw, c.maxEntryId, entryId);
      return c;
    });
  }

  calculate(periodKey: string): VatReport {
    const period = periodFromKey(periodKey);
    const corrections = this.corrections(period.start, period.end);
    const rows = this.sums(period.start, period.end, corrections.filter((c) => c.suppletie).map((c) => c.periodKey));
    const byAccount = (rgs: string) => rows.filter((r) => r.rgs_code === rgs).reduce((s, r) => s + r.net, 0);

    const omzetHoog = byAccount(ACCOUNTS.omzetHoog);
    const btwHoog = byAccount(ACCOUNTS.btwAfdragenHoog);
    const omzetLaag = byAccount(ACCOUNTS.omzetLaag);
    const btwLaag = byAccount(ACCOUNTS.btwAfdragenLaag);
    const omzetNul = byAccount(ACCOUNTS.omzetNul) + byAccount(ACCOUNTS.omzetVerlegd);
    const omzetVrijgesteld = byAccount(ACCOUNTS.omzetVrijgesteld);
    // 2a: grondslag = kosten/activa-regels met btw-code 'verlegd' (debet, dus −net)
    const inkoopGrondslag = (code: string) => 0 - rows.filter((r) => r.vat_code === code && (r.category === 'kosten' || r.category === 'activa')).reduce((s, r) => s + r.net, 0) || 0;
    const verlegdInkoop = inkoopGrondslag('verlegd');
    const btwVerlegd = byAccount(ACCOUNTS.btwAfdragenVerlegd);
    // buitenland (#16): 3a uitvoer, 3b EU-bedrijven (ICP), 4a/4b verlegde inkoop van buiten/binnen de EU
    const omzetExport = byAccount(ACCOUNTS.omzetExport);
    const omzetIcp = byAccount(ACCOUNTS.omzetIcp);
    const inkoopBuitenEu = inkoopGrondslag('buiten-eu');
    const btwBuitenEu = byAccount(ACCOUNTS.btwAfdragenBuitenEu);
    const inkoopEu = inkoopGrondslag('eu');
    const btwEu = byAccount(ACCOUNTS.btwAfdragenEu);
    const voorbelasting = -byAccount(ACCOUNTS.btwVoorbelasting);

    const btw5a = btwHoog + btwLaag + btwVerlegd + btwBuitenEu + btwEu;
    const rub = (code: string, label: string, omzet: Cents | null, btw: Cents | null, roundUpBtw = false): Rubriek => ({
      code,
      label,
      omzet,
      btw,
      omzetEuro: omzet === null ? null : floorEuro(omzet),
      btwEuro: btw === null ? null : roundUpBtw ? ceilEuro(btw) : floorEuro(btw),
    });
    const r1a = rub('1a', 'Leveringen/diensten belast met hoog tarief', omzetHoog, btwHoog);
    const r1b = rub('1b', 'Leveringen/diensten belast met laag tarief', omzetLaag, btwLaag);
    const r1e = rub('1e', 'Leveringen/diensten belast met 0% of niet bij u belast', omzetNul, null);
    const r2a = rub('2a', 'Leveringen/diensten waarbij de heffing van omzetbelasting naar u is verlegd', verlegdInkoop, btwVerlegd);
    const r3a = rub('3a', 'Leveringen naar landen buiten de EU (uitvoer)', omzetExport, null);
    const r3b = rub('3b', 'Leveringen naar of diensten in landen binnen de EU', omzetIcp, null);
    const r4a = rub('4a', 'Leveringen/diensten uit landen buiten de EU', inkoopBuitenEu, btwBuitenEu);
    const r4b = rub('4b', 'Leveringen/diensten uit landen binnen de EU', inkoopEu, btwEu);
    const r5a = rub('5a', 'Verschuldigde omzetbelasting (rubrieken 1a t/m 4b)', null, btw5a);
    const r5b = rub('5b', 'Voorbelasting', null, voorbelasting, true);
    const saldoEuro = (r1a.btwEuro ?? 0) + (r1b.btwEuro ?? 0) + (r2a.btwEuro ?? 0) + (r4a.btwEuro ?? 0) + (r4b.btwEuro ?? 0) - (r5b.btwEuro ?? 0);
    const r5c: Rubriek = { code: '5c', label: 'Subtotaal (5a min 5b)', omzet: null, btw: btw5a - voorbelasting, omzetEuro: null, btwEuro: saldoEuro };
    const r5g: Rubriek = { code: '5g', label: 'Totaal te betalen / terug te vragen', omzet: null, btw: btw5a - voorbelasting, omzetEuro: null, btwEuro: saldoEuro };

    const warnings: string[] = [];
    // onverwerkte banktransacties e.d.: zie checks() (#20)
    const drafts = (this.db.prepare(`SELECT COUNT(*) AS n FROM invoices WHERE status = 'concept' AND invoice_date BETWEEN ? AND ?`).get(period.start, period.end) as { n: number }).n;
    if (drafts > 0) warnings.push(`${drafts} ${drafts === 1 ? 'factuur is' : 'facturen zijn'} in deze periode nog niet verstuurd. Die tellen pas mee als je ze verstuurt of definitief maakt.`);
    if (this.settings.get().kor) warnings.push('Je gebruikt de kleineondernemersregeling (KOR): je rekent geen btw en hoeft in principe geen btw-aangifte te doen.');
    if (omzetVrijgesteld !== 0 && !this.settings.get().kor) warnings.push('Er staan factuurregels zonder btw ("Vrijgesteld / KOR"), maar je gebruikt de KOR niet. Kijk die facturen na.');
    for (const c of corrections) {
      if (c.suppletie) {
        warnings.push(`Er is ${formatEuro(Math.abs(c.btw))} btw gecorrigeerd over ${c.label}. Dat is meer dan € 1.000: dat verbeter je apart in Mijn Belastingdienst Zakelijk (een "suppletie"). Het zit niet in de bedragen hieronder.`);
      }
    }
    if (omzetExport !== 0 || omzetIcp !== 0 || btwBuitenEu !== 0 || btwEu !== 0) {
      warnings.push(BUITENLAND_DISCLAIMER);
    }
    if (omzetIcp !== 0) warnings.push('Je verkocht aan bedrijven in andere EU-landen. Dat geef je ook apart op (de "ICP-opgaaf"); het overzicht staat hieronder.');

    const stored = this.db.prepare('SELECT status, submitted_at FROM vat_periods WHERE period_key = ?').get(period.key) as { status: 'concept' | 'ingediend'; submitted_at: string | null } | undefined;
    return {
      period,
      status: stored?.status ?? 'open',
      rubrieken: [r1a, r1b, r1e, r2a, r3a, r3b, r4a, r4b, r5a, r5b, r5c, r5g],
      summary: {
        omzet: omzetHoog + omzetLaag + omzetNul + omzetVrijgesteld + omzetExport + omzetIcp,
        btwOverOmzet: btwHoog + btwLaag,
        btwVerlegd: btwVerlegd + btwBuitenEu + btwEu,
        voorbelasting,
        teBetalen: btw5a - voorbelasting,
        teBetalenEuro: saldoEuro,
      },
      breakdown: [
        { vatCode: 'hoog', label: '21%', omzet: omzetHoog, btw: btwHoog },
        { vatCode: 'laag', label: '9%', omzet: omzetLaag, btw: btwLaag },
        { vatCode: 'nul', label: '0% / verlegd', omzet: omzetNul, btw: 0 },
        { vatCode: 'vrijgesteld', label: 'Vrijgesteld / KOR', omzet: omzetVrijgesteld, btw: 0 },
        { vatCode: 'verlegd-inkoop', label: 'Inkoop btw verlegd', omzet: verlegdInkoop, btw: btwVerlegd },
        { vatCode: 'icp', label: 'Bedrijven in de EU (0%)', omzet: omzetIcp, btw: 0 },
        { vatCode: 'export', label: 'Uitvoer buiten de EU (0%)', omzet: omzetExport, btw: 0 },
        { vatCode: 'eu', label: 'Inkoop uit de EU, btw verlegd', omzet: inkoopEu, btw: btwEu },
        { vatCode: 'buiten-eu', label: 'Inkoop van buiten de EU, btw verlegd', omzet: inkoopBuitenEu, btw: btwBuitenEu },
      ],
      corrections,
      warnings,
      submittedAt: stored?.submitted_at ?? null,
    };
  }

  /**
   * Overzicht voor de opgaaf intracommunautaire prestaties (ICP, #16): per afnemer in een ander
   * EU-land het btw-nummer en het bedrag van rubriek 3b in deze periode. De opgaaf zelf doe je in
   * Mijn Belastingdienst Zakelijk; daar geef je ook aan of het om goederen of diensten gaat.
   */
  icp(periodKey: string): IcpReport {
    const period = periodFromKey(periodKey);
    const rows = this.db
      .prepare(
        `SELECT l.relation_id, r.name, r.country, r.vat_number, SUM(l.credit) - SUM(l.debit) AS net
         FROM journal_lines l
         JOIN journal_entries e ON e.id = l.journal_entry_id
         JOIN chart_of_accounts a ON a.id = l.account_id
         LEFT JOIN relations r ON r.id = l.relation_id
         WHERE a.rgs_code = ? AND COALESCE(e.vat_date, e.entry_date) BETWEEN ? AND ? AND e.source <> 'btw'
         GROUP BY l.relation_id
         HAVING net <> 0
         ORDER BY r.name`,
      )
      .all(ACCOUNTS.omzetIcp, period.start, period.end) as { relation_id: number | null; name: string | null; country: string | null; vat_number: string | null; net: number }[];
    const lines: IcpLine[] = rows.map((r) => {
      const vatNumber = (r.vat_number ?? '').replace(/[\s.]/g, '').toUpperCase();
      const problems: string[] = [];
      if (!vatNumber) problems.push('btw-nummer ontbreekt');
      else if (!/^[A-Z]{2}[0-9A-Z]{2,13}$/.test(vatNumber)) problems.push('btw-nummer lijkt niet geldig');
      else if (vatNumber.startsWith('NL')) problems.push('Dit is een Nederlands btw-nummer: kies bij deze factuur gewoon 21% of 9%');
      return {
        relationId: r.relation_id,
        name: r.name ?? 'Onbekende klant',
        country: (vatNumber.slice(0, 2) || r.country || '').toUpperCase(),
        vatNumber,
        amount: r.net,
        amountEuro: Math.round(r.net / 100),
        problems,
      };
    });
    return { period, lines, total: lines.reduce((s, l) => s + l.amount, 0) };
  }

  icpCsv(periodKey: string): string {
    const r = this.icp(periodKey);
    const out = ['Land;Btw-nummer;Klant;Bedrag;Bedrag (hele euro)'];
    for (const l of r.lines) out.push([l.country, l.vatNumber, `"${l.name.replace(/"/g, '""')}"`, centsToDecimalString(l.amount), l.amountEuro].join(';'));
    return out.join('\r\n') + '\r\n';
  }

  currentPeriod(date: IsoDate = today()): Period {
    return periodFor(date, this.settings.get().vatPeriod);
  }

  /** Alle periodes van een jaar met hun status. */
  listPeriods(year: number): { period: Period; status: 'open' | 'concept' | 'ingediend'; teBetalen: Cents }[] {
    const type = this.settings.get().vatPeriod;
    const count = type === 'maand' ? 12 : type === 'kwartaal' ? 4 : 1;
    const step = 12 / count;
    const periods: Period[] = [];
    for (let i = 0; i < count; i++) periods.push(periodFor(`${year}-${String(i * step + 1).padStart(2, '0')}-01`, type));
    return periods.map((p) => {
      const r = this.calculate(p.key);
      return { period: p, status: r.status, teBetalen: r.summary.teBetalen };
    });
  }

  /** Controles vóór de aangifte (#20). */
  checks(periodKey: string): VatCheck[] {
    const period = periodFromKey(periodKey);
    const current = this.calculate(periodKey).summary.teBetalen;
    const prevPeriod = periodFor(addDays(period.start, -1), this.settings.get().vatPeriod);
    const prev = this.calculate(prevPeriod.key);
    const hadActivity = prev.summary.omzet !== 0 || prev.summary.voorbelasting !== 0;
    return runVatChecks(this.db, this.ledger, period, { current, previous: hadActivity ? prev.summary.teBetalen : null });
  }

  /** Bewust overslaan; komt terug als de situatie verandert (andere fingerprint). */
  skipCheck(periodKey: string, checkKey: string, reason = ''): VatCheck[] {
    const check = this.checks(periodKey).find((c) => c.key === checkKey);
    if (!check) throw new ValidationError('Deze controle is al opgelost');
    this.db
      .prepare(
        `INSERT INTO task_skips (task_key, fingerprint, reason) VALUES (?, ?, ?)
         ON CONFLICT(task_key) DO UPDATE SET fingerprint = excluded.fingerprint, reason = excluded.reason, created_at = datetime('now')`,
      )
      .run(skipKey(periodKey, checkKey), check.fingerprint, reason.trim());
    return this.checks(periodKey);
  }

  /**
   * Markeert de aangifte als ingediend: boekt de BTW-rekeningen over naar
   * "af te dragen omzetbelasting" en sluit de periode af voor nieuwe boekingen.
   * Correcties daarna vallen automatisch in de volgende open periode.
   */
  markSubmitted(periodKey: string): VatReport {
    return tx(this.db, () => {
      const report = this.calculate(periodKey);
      if (report.status === 'ingediend') throw new ValidationError(`${report.period.label} is al ingediend`);
      const open = this.checks(periodKey).filter((c) => c.blocking && !c.skipped);
      if (open.length > 0) {
        throw new ValidationError(`Los eerst op of sla bewust over: ${open.map((c) => c.title.toLowerCase()).join('; ')}`);
      }
      const { period } = report;
      const lines: (PostLine | null)[] = [];
      const hoog = report.rubrieken.find((r) => r.code === '1a')!.btw ?? 0;
      const laag = report.rubrieken.find((r) => r.code === '1b')!.btw ?? 0;
      const verlegd = report.rubrieken.find((r) => r.code === '2a')!.btw ?? 0;
      const buitenEu = report.rubrieken.find((r) => r.code === '4a')!.btw ?? 0;
      const eu = report.rubrieken.find((r) => r.code === '4b')!.btw ?? 0;
      lines.push(signedLine(ACCOUNTS.btwAfdragenHoog, hoog));
      lines.push(signedLine(ACCOUNTS.btwAfdragenLaag, laag));
      lines.push(signedLine(ACCOUNTS.btwAfdragenVerlegd, verlegd));
      lines.push(signedLine(ACCOUNTS.btwAfdragenBuitenEu, buitenEu));
      lines.push(signedLine(ACCOUNTS.btwAfdragenEu, eu));
      lines.push(signedLine(ACCOUNTS.btwVoorbelasting, -report.summary.voorbelasting));
      lines.push(signedLine(ACCOUNTS.btwAfrekening, -report.summary.teBetalen));
      const clean = lines.filter((l): l is PostLine => l !== null);
      let entryId: number | null = null;
      if (clean.length >= 2) {
        entryId = this.ledger.post({ date: period.end, description: `BTW-aangifte ${period.label}`, source: 'btw', sourceRef: `vat:${period.key}`, lines: clean });
      }
      this.db
        .prepare(
          `INSERT INTO vat_periods (period_key, start_date, end_date, vat_payable, vat_receivable, balance, details, status, submitted_at, journal_entry_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'ingediend', datetime('now'), ?)
           ON CONFLICT(period_key) DO UPDATE SET vat_payable = excluded.vat_payable, vat_receivable = excluded.vat_receivable,
             balance = excluded.balance, details = excluded.details, status = 'ingediend', submitted_at = excluded.submitted_at,
             journal_entry_id = excluded.journal_entry_id`,
        )
        .run(period.key, period.start, period.end, report.summary.btwOverOmzet + report.summary.btwVerlegd, report.summary.voorbelasting, report.summary.teBetalen, JSON.stringify(report.rubrieken), entryId);
      return this.calculate(periodKey);
    });
  }

  /** Heropent een periode (bv. als de aangifte toch nog niet verstuurd was). */
  reopen(periodKey: string): VatReport {
    return tx(this.db, () => {
      const row = this.db.prepare('SELECT * FROM vat_periods WHERE period_key = ?').get(periodKey) as { journal_entry_id: number | null; end_date: string } | undefined;
      if (!row) throw new ValidationError('Deze periode is niet ingediend');
      this.db.prepare('DELETE FROM vat_periods WHERE period_key = ?').run(periodKey);
      if (row.journal_entry_id) this.ledger.reverse(row.journal_entry_id, row.end_date, `Heropening BTW-aangifte ${periodKey}`);
      return this.calculate(periodKey);
    });
  }

  /** Overzicht als CSV voor de boekhouder. */
  exportCsv(periodKey: string): string {
    const r = this.calculate(periodKey);
    const lines = ['Rubriek;Omschrijving;Omzet;BTW;Omzet (aangifte, hele euro);BTW (aangifte, hele euro)'];
    for (const x of r.rubrieken) {
      lines.push([x.code, `"${x.label}"`, x.omzet === null ? '' : centsToDecimalString(x.omzet), x.btw === null ? '' : centsToDecimalString(x.btw), x.omzetEuro ?? '', x.btwEuro ?? ''].join(';'));
    }
    return lines.join('\r\n') + '\r\n';
  }
}
