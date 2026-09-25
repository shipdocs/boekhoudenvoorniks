import type { Db } from '../db/database';
import type { Ledger } from '../core-ledger/ledger';
import { ACCOUNTS } from '../core-ledger/accounts';
import type { InvoiceService } from '../documents/invoices';
import type { BankService } from '../import/bank';
import type { VatService } from '../btw/btw';
import { periodFor, today, type IsoDate } from '../shared/dates';
import type { Cents } from '../shared/money';

export interface DashboardData {
  asOf: IsoDate;
  revenueThisMonth: Cents;
  revenueThisYear: Cents;
  profitThisYear: Cents;
  revenueByMonth: { month: string; label: string; revenue: Cents; costs: Cents }[];
  openInvoices: { count: number; amount: Cents; overdueCount: number; overdueAmount: Cents; items: { id: number; number: string | null; relation: string; open: Cents; dueDate: IsoDate; overdue: boolean }[] };
  bank: { ledgerBalance: Cents; statementBalance: Cents; unprocessed: number };
  vat: { periodKey: string; periodLabel: string; toPay: Cents; periodEnd: IsoDate };
  concepts: number;
}

const MONTH_LABELS = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];

/** Read-only overzichten bovenop core-ledger. */
export class DashboardService {
  constructor(
    private readonly db: Db,
    private readonly ledger: Ledger,
    private readonly invoices: InvoiceService,
    private readonly bank: BankService,
    private readonly vat: VatService,
  ) {}

  /** Omzet = credit − debet op omzetrekeningen; kosten = debet − credit op kostenrekeningen. */
  private revenueAndCosts(from: IsoDate, to: IsoDate): { revenue: Cents; costs: Cents } {
    const row = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN a.category = 'omzet' THEN l.credit - l.debit END), 0) AS revenue,
           COALESCE(SUM(CASE WHEN a.category = 'kosten' THEN l.debit - l.credit END), 0) AS costs
         FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
         JOIN chart_of_accounts a ON a.id = l.account_id
         WHERE e.entry_date BETWEEN ? AND ?`,
      )
      .get(from, to) as { revenue: number; costs: number };
    return row;
  }

  get(asOf: IsoDate = today()): DashboardData {
    const month = periodFor(asOf, 'maand');
    const year = periodFor(asOf, 'jaar');
    const ytd = this.revenueAndCosts(year.start, asOf);
    const byMonth: DashboardData['revenueByMonth'] = [];
    const [y, m] = [Number(asOf.slice(0, 4)), Number(asOf.slice(5, 7))];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(Date.UTC(y, m - 1 - i, 1));
      const p = periodFor(d.toISOString().slice(0, 10), 'maand');
      const rc = this.revenueAndCosts(p.start, p.end);
      byMonth.push({ month: p.key, label: `${MONTH_LABELS[d.getUTCMonth()]}${d.getUTCMonth() === 0 || i === 11 ? ' ' + String(d.getUTCFullYear()).slice(2) : ''}`, revenue: rc.revenue, costs: rc.costs });
    }
    const open = this.invoices.listOpen(asOf).filter((i) => i.open_amount > 0);
    const overdue = open.filter((i) => i.display_status === 'vervallen');
    const vatPeriod = this.vat.currentPeriod(asOf);
    const vatReport = this.vat.calculate(vatPeriod.key);
    const bankAccounts = this.bank.listAccounts();
    const ledgerBalance = bankAccounts.length
      ? bankAccounts.reduce((s, a) => s + this.ledger.balance(a.rgs_code), 0)
      : this.ledger.balance(ACCOUNTS.bank);
    return {
      asOf,
      revenueThisMonth: this.revenueAndCosts(month.start, month.end).revenue,
      revenueThisYear: ytd.revenue,
      profitThisYear: ytd.revenue - ytd.costs,
      revenueByMonth: byMonth,
      openInvoices: {
        count: open.length,
        amount: open.reduce((s, i) => s + i.open_amount, 0),
        overdueCount: overdue.length,
        overdueAmount: overdue.reduce((s, i) => s + i.open_amount, 0),
        items: open
          .sort((a, b) => a.due_date.localeCompare(b.due_date))
          .slice(0, 8)
          .map((i) => ({ id: i.id, number: i.number, relation: i.relation_name, open: i.open_amount, dueDate: i.due_date, overdue: i.display_status === 'vervallen' })),
      },
      bank: { ledgerBalance, statementBalance: this.bank.statementBalance(), unprocessed: this.bank.countUnprocessed() },
      vat: { periodKey: vatPeriod.key, periodLabel: vatPeriod.label, toPay: vatReport.summary.teBetalen, periodEnd: vatPeriod.end },
      concepts: (this.db.prepare(`SELECT COUNT(*) AS n FROM invoices WHERE status = 'concept'`).get() as { n: number }).n,
    };
  }

  /** Winst-en-verliesrekening en balans voor de boekhouder (geavanceerde modus). */
  reports(from: IsoDate, to: IsoDate) {
    const pnl = this.ledger.balances({ from, to }).filter((b) => b.category === 'omzet' || b.category === 'kosten');
    const balance = this.ledger.balances({ to }).filter((b) => !(b.category === 'omzet' || b.category === 'kosten'));
    const revenue = pnl.filter((b) => b.category === 'omzet').reduce((s, b) => s - b.balance, 0);
    const costs = pnl.filter((b) => b.category === 'kosten').reduce((s, b) => s + b.balance, 0);
    return { pnl, balance, revenue, costs, profit: revenue - costs };
  }
}
