import { tx, type Db } from '../db/database';
import { ACCOUNTS } from '../core-ledger/accounts';
import type { PurchaseService } from '../documents/purchases';
import type { BankService } from '../import/bank';
import type { PurchaseLineInput } from '../core-ledger/rules';
import { addDays, today, type IsoDate } from '../shared/dates';
import type { Cents } from '../shared/money';
import { INVESTMENT_CANDIDATE_ACCOUNTS, INVESTMENT_THRESHOLD } from '../shared/investment';
import { ValidationError } from '../shared/validation';

export interface InvestmentCandidate {
  /** journaalregel met de kosten; stabiele sleutel voor de taak */
  lineId: number;
  date: IsoDate;
  amount: Cents;
  description: string;
  purchaseId: number | null;
  bankTransactionId: number | null;
}

/**
 * Vangnet: een aankoop van € 450 of meer (excl. btw) die als gewone kosten is geboekt, in een categorie
 * waar dat vaak eigenlijk een investering is (gereedschap, kantoor, telefoon, auto, overig). Op Vandaag
 * vraagt de app "Was dit een investering?"; bij ja wordt de boeking omgezet naar een bedrijfsmiddel.
 */
export class InvestmentCheck {
  constructor(
    private readonly db: Db,
    private readonly purchases: PurchaseService,
    private readonly bank: BankService,
  ) {}

  candidates(asOf: IsoDate = today()): InvestmentCandidate[] {
    const accounts = INVESTMENT_CANDIDATE_ACCOUNTS;
    const rows = this.db
      .prepare(
        `SELECT l.id AS lineId, e.entry_date AS date, l.debit AS amount, COALESCE(NULLIF(l.description, ''), e.description) AS description,
                (SELECT p.id FROM purchase_invoices p WHERE p.journal_entry_id = e.id) AS purchaseId,
                (SELECT t.id FROM bank_transactions t WHERE t.matched_journal_entry_id = e.id AND t.matched_invoice_id IS NULL AND t.matched_purchase_invoice_id IS NULL) AS bankTransactionId
         FROM journal_lines l
         JOIN journal_entries e ON e.id = l.journal_entry_id
         JOIN chart_of_accounts a ON a.id = l.account_id
         WHERE a.rgs_code IN (${accounts.map(() => '?').join(',')}) AND l.debit >= ?
           AND e.status = 'definitief' AND e.reverses_entry_id IS NULL AND e.entry_date BETWEEN ? AND ?
         ORDER BY e.entry_date DESC`,
      )
      .all(...accounts, INVESTMENT_THRESHOLD, addDays(asOf, -365), asOf) as InvestmentCandidate[];
    // alleen wat we ook echt kunnen omzetten
    return rows.filter((r) => r.purchaseId !== null || r.bankTransactionId !== null);
  }

  /** De kostenregel omzetten naar Inventaris; het bedrijfsmiddel verschijnt dan vanzelf in het register. */
  convert(c: Pick<InvestmentCandidate, 'lineId' | 'purchaseId' | 'bankTransactionId'>): void {
    tx(this.db, () => {
      if (c.purchaseId) {
        const line = this.db.prepare('SELECT a.rgs_code FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id WHERE l.id = ?').get(c.lineId) as { rgs_code: string } | undefined;
        const lines = this.db
          .prepare(
            `SELECT a.rgs_code AS account, pl.net_amount AS netAmount, pl.vat_code AS vatCode, pl.vat_amount AS vatAmount, pl.description
             FROM purchase_invoice_lines pl JOIN chart_of_accounts a ON a.id = pl.account_id WHERE pl.purchase_invoice_id = ? ORDER BY pl.id`,
          )
          .all(c.purchaseId) as (PurchaseLineInput & { account: string })[];
        if (!line || lines.length === 0) throw new ValidationError('Deze aankoop kan niet automatisch worden omgezet. Pas de soort kosten aan bij de aankoop en kies "Investering".');
        // de grootste regel op die kostenrekening wordt de investering
        const target = lines.filter((l) => l.account === line.rgs_code).sort((a, b) => b.netAmount - a.netAmount)[0];
        if (!target) throw new ValidationError('Deze aankoop kan niet automatisch worden omgezet. Pas de soort kosten aan bij de aankoop en kies "Investering".');
        this.purchases.reclassify(
          c.purchaseId,
          lines.map((l) => (l === target ? { ...l, account: ACCOUNTS.inventaris } : l)),
          'investering (bedrijfsmiddel)',
        );
      } else if (c.bankTransactionId) {
        this.bank.reclassify(c.bankTransactionId, { account: ACCOUNTS.inventaris }, 'investering (bedrijfsmiddel)');
      } else {
        throw new ValidationError('Deze aankoop kan niet automatisch worden omgezet. Pas de soort kosten aan bij de aankoop en kies "Investering".');
      }
    });
  }
}
