import type { Db } from '../db/database';
import { tx } from '../db/database';
import { Ledger, signedLine, type PostLine } from '../core-ledger/ledger';
import { ACCOUNTS } from '../core-ledger/accounts';
import type { SettingsService } from '../settings/settings';
import { centsToDecimalString, type Cents } from '../shared/money';
import { periodFor, periodFromKey, today, type IsoDate, type Period } from '../shared/dates';
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
    btwOverOmzet: Cents;
    voorbelasting: Cents;
    teBetalen: Cents;
    teBetalenEuro: number;
  };
  breakdown: { vatCode: string; label: string; omzet: Cents; btw: Cents }[];
  warnings: string[];
  submittedAt: string | null;
}

export const PORTAL_URL = 'https://www.belastingdienst.nl/wps/wcm/connect/nl/btw/content/btw-aangifte-doen';

const floorEuro = (c: Cents) => Math.floor(c / 100);
const ceilEuro = (c: Cents) => Math.ceil(c / 100);

export class VatService {
  constructor(
    private readonly db: Db,
    private readonly ledger: Ledger,
    private readonly settings: SettingsService,
  ) {}

  /** Som van (credit − debet) per rekening/btw-code in een periode, exclusief afsluitboekingen. */
  private sums(start: IsoDate, end: IsoDate) {
    return this.db
      .prepare(
        `SELECT a.rgs_code, a.category, l.vat_code, SUM(l.credit) - SUM(l.debit) AS net
         FROM journal_lines l
         JOIN journal_entries e ON e.id = l.journal_entry_id
         JOIN chart_of_accounts a ON a.id = l.account_id
         WHERE e.entry_date BETWEEN ? AND ? AND e.source <> 'btw'
         GROUP BY a.rgs_code, a.category, l.vat_code`,
      )
      .all(start, end) as { rgs_code: string; category: string; vat_code: string | null; net: number }[];
  }

  calculate(periodKey: string): VatReport {
    const period = periodFromKey(periodKey);
    const rows = this.sums(period.start, period.end);
    const byAccount = (rgs: string) => rows.filter((r) => r.rgs_code === rgs).reduce((s, r) => s + r.net, 0);

    const omzetHoog = byAccount(ACCOUNTS.omzetHoog);
    const btwHoog = byAccount(ACCOUNTS.btwAfdragenHoog);
    const omzetLaag = byAccount(ACCOUNTS.omzetLaag);
    const btwLaag = byAccount(ACCOUNTS.btwAfdragenLaag);
    const omzetNul = byAccount(ACCOUNTS.omzetNul) + byAccount(ACCOUNTS.omzetVerlegd);
    const omzetVrijgesteld = byAccount(ACCOUNTS.omzetVrijgesteld);
    // 2a: grondslag = kosten/activa-regels met btw-code 'verlegd' (debet, dus −net)
    const verlegdInkoop = -rows.filter((r) => r.vat_code === 'verlegd' && (r.category === 'kosten' || r.category === 'activa')).reduce((s, r) => s + r.net, 0);
    const btwVerlegd = byAccount(ACCOUNTS.btwAfdragenVerlegd);
    const voorbelasting = -byAccount(ACCOUNTS.btwVoorbelasting);

    const btw5a = btwHoog + btwLaag + btwVerlegd;
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
    const r5a = rub('5a', 'Verschuldigde omzetbelasting (rubrieken 1a t/m 4b)', null, btw5a);
    const r5b = rub('5b', 'Voorbelasting', null, voorbelasting, true);
    const saldoEuro = (r1a.btwEuro ?? 0) + (r1b.btwEuro ?? 0) + (r2a.btwEuro ?? 0) - (r5b.btwEuro ?? 0);
    const r5c: Rubriek = { code: '5c', label: 'Subtotaal (5a min 5b)', omzet: null, btw: btw5a - voorbelasting, omzetEuro: null, btwEuro: saldoEuro };
    const r5g: Rubriek = { code: '5g', label: 'Totaal te betalen / terug te vragen', omzet: null, btw: btw5a - voorbelasting, omzetEuro: null, btwEuro: saldoEuro };

    const warnings: string[] = [];
    const unprocessed = (this.db
      .prepare(`SELECT COUNT(*) AS n FROM bank_transactions WHERE status = 'nieuw' AND transaction_date BETWEEN ? AND ?`)
      .get(period.start, period.end) as { n: number }).n;
    if (unprocessed > 0) warnings.push(`Er zijn nog ${unprocessed} banktransacties in deze periode niet verwerkt. Verwerk ze eerst, anders mis je mogelijk voorbelasting.`);
    const drafts = (this.db.prepare(`SELECT COUNT(*) AS n FROM invoices WHERE status = 'concept' AND invoice_date BETWEEN ? AND ?`).get(period.start, period.end) as { n: number }).n;
    if (drafts > 0) warnings.push(`Er staan nog ${drafts} conceptfacturen in deze periode. Die tellen pas mee als ze definitief zijn.`);
    if (this.settings.get().kor) warnings.push('Je gebruikt de kleineondernemersregeling (KOR): je hoeft in principe geen BTW-aangifte te doen.');
    if (omzetVrijgesteld !== 0 && !this.settings.get().kor) warnings.push('Er is omzet geboekt als vrijgesteld/KOR terwijl KOR niet aan staat. Controleer dit.');
    const rounding = btwHoog - (r1a.btwEuro ?? 0) * 100;
    if (Math.abs(rounding) > 100) warnings.push('Controleer de afronding van rubriek 1a.');

    const stored = this.db.prepare('SELECT status, submitted_at FROM vat_periods WHERE period_key = ?').get(period.key) as { status: 'concept' | 'ingediend'; submitted_at: string | null } | undefined;
    return {
      period,
      status: stored?.status ?? 'open',
      rubrieken: [r1a, r1b, r1e, r2a, r5a, r5b, r5c, r5g],
      summary: {
        omzet: omzetHoog + omzetLaag + omzetNul + omzetVrijgesteld,
        btwOverOmzet: btw5a,
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
      ],
      warnings,
      submittedAt: stored?.submitted_at ?? null,
    };
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

  /**
   * Markeert de aangifte als ingediend: boekt de BTW-rekeningen over naar
   * "af te dragen omzetbelasting" en sluit de periode af voor nieuwe boekingen.
   * Correcties daarna vallen automatisch in de volgende open periode.
   */
  markSubmitted(periodKey: string): VatReport {
    return tx(this.db, () => {
      const report = this.calculate(periodKey);
      if (report.status === 'ingediend') throw new ValidationError(`${report.period.label} is al ingediend`);
      const { period } = report;
      const lines: (PostLine | null)[] = [];
      const hoog = report.rubrieken.find((r) => r.code === '1a')!.btw ?? 0;
      const laag = report.rubrieken.find((r) => r.code === '1b')!.btw ?? 0;
      const verlegd = report.rubrieken.find((r) => r.code === '2a')!.btw ?? 0;
      lines.push(signedLine(ACCOUNTS.btwAfdragenHoog, hoog));
      lines.push(signedLine(ACCOUNTS.btwAfdragenLaag, laag));
      lines.push(signedLine(ACCOUNTS.btwAfdragenVerlegd, verlegd));
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
        .run(period.key, period.start, period.end, report.summary.btwOverOmzet, report.summary.voorbelasting, report.summary.teBetalen, JSON.stringify(report.rubrieken), entryId);
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
