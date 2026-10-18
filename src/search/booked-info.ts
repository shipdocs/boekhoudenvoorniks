import type { Db } from '../db/database';
import { ACCOUNTS } from '../core-ledger/accounts';
import { periodFor, type PeriodType } from '../shared/dates';
import type { Cents } from '../shared/money';

/** Btw-code in een paar woorden, met het vak van de aangifte waar het in telt. */
export const VAT_SHORT: Record<string, string> = {
  hoog: '21% btw',
  laag: '9% btw',
  nul: '0% btw',
  geen: 'geen btw',
  vrijgesteld: 'vrijgesteld',
  verlegd: 'btw verlegd (2a)',
  eu: 'btw verlegd, EU (4b)',
  'buiten-eu': 'btw verlegd, buiten EU (4a)',
  icp: 'ICP (3b)',
  'icp-dienst': 'dienst EU (3b)',
  export: 'export (3a)',
  'dienst-buiten-eu': 'niet belast in NL',
};

export interface BookedLine {
  account: string;
  /** positief = kosten/bezit (debet), negatief = omzet/privé-storting (credit) */
  amount: Cents;
  vat: string | null;
}

export interface BookingInfo {
  entryId: number;
  /** waar het op geboekt is: zonder geldrekeningen, debiteuren/crediteuren en btw-rekeningen */
  lines: BookedLine[];
  /** "Software & abonnementen · btw verlegd, buiten EU (4a)" */
  summary: string;
  /** de btw-aangifte waarin dit meetelt, als er btw in zit */
  vatPeriod: { key: string; label: string; filed: boolean } | null;
  reversed: boolean;
}

/**
 * Hoe een journaalpost in gewone taal geboekt staat: "waar staat dit op?". Voor zoeken en lijsten
 * (bank, aankopen), zodat je zonder de boekhouding te openen ziet wat er met een betaling gebeurd is.
 */
export class BookedInfo {
  constructor(
    private readonly db: Db,
    private readonly vatPeriodType: () => PeriodType,
  ) {}

  entry(entryId: number | null | undefined): BookingInfo | null {
    if (!entryId) return null;
    const e = this.db.prepare('SELECT id, entry_date, vat_date, status FROM journal_entries WHERE id = ?').get(entryId) as { id: number; entry_date: string; vat_date: string | null; status: string } | undefined;
    if (!e) return null;
    const rows = this.db
      .prepare(
        `SELECT a.name, a.rgs_code, a.category, l.vat_code, l.debit - l.credit AS amount,
                EXISTS (SELECT 1 FROM bank_accounts b WHERE b.account_id = a.id) AS is_money
           FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id WHERE l.journal_entry_id = ? ORDER BY l.id`,
      )
      .all(entryId) as { name: string; rgs_code: string; category: string; vat_code: string | null; amount: number; is_money: number }[];
    const skip = new Set<string>([ACCOUNTS.kas, ACCOUNTS.debiteuren, ACCOUNTS.crediteuren]);
    const lines = new Map<string, BookedLine>();
    for (const r of rows) {
      if (r.is_money || skip.has(r.rgs_code) || r.category === 'btw') continue;
      const vat = r.vat_code ? VAT_SHORT[r.vat_code] ?? r.vat_code : null;
      const key = `${r.name}|${vat}`;
      const line = lines.get(key) ?? { account: r.name, amount: 0, vat };
      line.amount += r.amount;
      lines.set(key, line);
    }
    // gemengd gebruik: het privédeel is geen aparte post, maar "40% zakelijk"
    const shared = this.db.prepare(`SELECT json_extract(ev.payload, '$.businessPct') AS pct FROM journal_entries e JOIN events ev ON ev.id = e.event_id WHERE e.id = ?`).get(entryId) as { pct: number | null } | undefined;
    const businessPct = shared?.pct ?? null;
    const privateName = this.db.prepare('SELECT name FROM chart_of_accounts WHERE rgs_code = ?').get(ACCOUNTS.priveOpnamen) as { name: string } | undefined;
    const list = [...lines.values()].filter((l) => l.amount !== 0 && !(businessPct !== null && l.account === privateName?.name));
    const summary = list.length === 0 ? '' : list.length === 1 ? [list[0]!.account, list[0]!.vat, businessPct !== null ? `${businessPct}% zakelijk` : null].filter(Boolean).join(' · ') : list.map((l) => l.account).join(' + ');
    const hasVat = rows.some((r) => r.category === 'btw');
    let vatPeriod: BookingInfo['vatPeriod'] = null;
    if (hasVat) {
      const p = periodFor(e.vat_date ?? e.entry_date, this.vatPeriodType());
      const filed = !!this.db.prepare(`SELECT 1 FROM vat_periods WHERE period_key = ? AND status = 'ingediend'`).get(p.key);
      vatPeriod = { key: p.key, label: p.label, filed };
    }
    return { entryId, lines: list, summary, vatPeriod, reversed: e.status === 'teruggedraaid' };
  }
}
