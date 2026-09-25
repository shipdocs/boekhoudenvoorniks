import { createHash } from 'node:crypto';
import type { Db } from '../db/database';
import { tx } from '../db/database';
import { Ledger, signedLine, type PostLine } from '../core-ledger/ledger';
import { ACCOUNTS, SALES_ACCOUNTS } from '../core-ledger/accounts';
import type { InvoiceService } from '../documents/invoices';
import type { PurchaseService } from '../documents/purchases';
import { expenseLines } from '../documents/purchases';
import type { RelationsService } from '../relations/relations';
import { PURCHASE_VAT_RATES, SALES_VAT_RATES, isPurchaseVatCode, isSalesVatCode } from '../shared/vat';
import { roundHalfAwayFromZero, type Cents } from '../shared/money';
import { today, type IsoDate } from '../shared/dates';
import { isValidIban, normalizeIban, ValidationError } from '../shared/validation';
import type { NormalizedTransaction, ParseResult } from './types';

export interface BankAccount {
  id: number;
  name: string;
  iban: string | null;
  account_id: number;
  rgs_code: string;
}

export interface BankTransaction {
  id: number;
  bank_account_id: number;
  transaction_date: IsoDate;
  amount: Cents;
  counter_iban: string | null;
  counter_name: string | null;
  description: string;
  reference: string | null;
  source: string;
  import_batch_id: number | null;
  status: 'nieuw' | 'gematcht' | 'genegeerd';
  matched_journal_entry_id: number | null;
  matched_invoice_id: number | null;
  matched_purchase_invoice_id: number | null;
}

export interface ImportSummary {
  batchId: number;
  imported: number;
  duplicates: number;
  warnings: string[];
  autoMatched: number;
}

export interface BookToAccountInput {
  /** RGS-code van de tegenrekening (kosten, omzet, privé, …) */
  account: string;
  vatCode?: string;
  description?: string;
  relationId?: number | null;
}

/**
 * Splitst een bruto bedrag (incl. BTW) in netto + BTW.
 * Bij verlegde btw is het betaalde bedrag al netto; de BTW wordt dan berekend over het netto bedrag.
 */
export function splitGross(gross: Cents, percentage: number, verlegd = false): { net: Cents; vat: Cents } {
  if (verlegd) return { net: gross, vat: roundHalfAwayFromZero((gross * percentage) / 100) };
  if (percentage === 0) return { net: gross, vat: 0 };
  const net = roundHalfAwayFromZero((gross * 100) / (100 + percentage));
  return { net, vat: gross - net };
}

export class BankService {
  constructor(
    private readonly db: Db,
    private readonly ledger: Ledger,
    private readonly invoices: InvoiceService,
    private readonly purchases: PurchaseService,
    private readonly relations: RelationsService,
  ) {}

  // ---------- bankrekeningen ----------

  listAccounts(): BankAccount[] {
    return this.db
      .prepare('SELECT b.*, a.rgs_code FROM bank_accounts b JOIN chart_of_accounts a ON a.id = b.account_id ORDER BY b.id')
      .all() as BankAccount[];
  }

  ensureDefaultAccount(iban?: string | null): BankAccount {
    const existing = this.listAccounts();
    if (existing.length > 0) return existing[0]!;
    const ledgerAccount = this.ledger.getAccount(ACCOUNTS.bank);
    this.db.prepare('INSERT INTO bank_accounts (name, iban, account_id) VALUES (?, ?, ?)').run('Zakelijke rekening', iban ? normalizeIban(iban) : null, ledgerAccount.id);
    return this.listAccounts()[0]!;
  }

  addAccount(name: string, iban: string): BankAccount {
    const clean = normalizeIban(iban);
    if (!isValidIban(clean)) throw new ValidationError(`Ongeldig IBAN: ${iban}`);
    return tx(this.db, () => {
      const n = this.listAccounts().length;
      // tweede en volgende rekeningen krijgen een eigen grootboekrekening
      const rgs = n === 0 ? ACCOUNTS.bank : `${ACCOUNTS.bank}${n + 1}`;
      const ledgerAccount = n === 0 ? this.ledger.getAccount(ACCOUNTS.bank) : this.ledger.createAccount({ code: String(1100 + n), rgs, name: `Bank ${name}`, category: 'activa' });
      this.db.prepare('INSERT INTO bank_accounts (name, iban, account_id) VALUES (?, ?, ?)').run(name, clean, ledgerAccount.id);
      return this.listAccounts().find((a) => a.iban === clean)!;
    });
  }

  updateAccount(id: number, patch: { name?: string; iban?: string | null }): void {
    const iban = patch.iban ? normalizeIban(patch.iban) : patch.iban;
    if (iban && !isValidIban(iban)) throw new ValidationError(`Ongeldig IBAN: ${patch.iban}`);
    const current = this.getAccount(id);
    this.db.prepare('UPDATE bank_accounts SET name = ?, iban = ? WHERE id = ?').run(patch.name ?? current.name, iban === undefined ? current.iban : iban, id);
  }

  getAccount(id: number): BankAccount {
    const a = this.listAccounts().find((x) => x.id === id);
    if (!a) throw new ValidationError(`Bankrekening ${id} bestaat niet`);
    return a;
  }

  private accountForIban(iban: string | null | undefined): BankAccount {
    const accounts = this.listAccounts();
    if (iban) {
      const match = accounts.find((a) => a.iban === iban);
      if (match) return match;
      const unassigned = accounts.find((a) => !a.iban);
      if (unassigned) {
        this.db.prepare('UPDATE bank_accounts SET iban = ? WHERE id = ?').run(iban, unassigned.id);
        return { ...unassigned, iban };
      }
      if (accounts.length === 0) return this.ensureDefaultAccount(iban);
      return this.addAccount(`Rekening ${iban.slice(-4)}`, iban);
    }
    return accounts[0] ?? this.ensureDefaultAccount();
  }

  /** Beginsaldo van de bank tegen eigen vermogen. */
  setOpeningBalance(bankAccountId: number, amount: Cents, date: IsoDate): number {
    const account = this.getAccount(bankAccountId);
    return this.ledger.post({
      date,
      description: `Beginsaldo ${account.name}`,
      source: 'opening',
      lines: [signedLine(account.rgs_code, amount)!, signedLine(ACCOUNTS.eigenVermogen, -amount)!],
    });
  }

  // ---------- import ----------

  static hash(t: NormalizedTransaction, ownIban: string | null, occurrence: number): string {
    const basis = t.bankId
      ? `id|${ownIban ?? ''}|${t.bankId}`
      : [ownIban ?? '', t.date, t.amount, t.counterIban ?? '', (t.description ?? '').replace(/\s+/g, ' ').trim().toLowerCase(), occurrence].join('|');
    return createHash('sha256').update(basis).digest('hex');
  }

  import(result: ParseResult, opts: { filename?: string; bankAccountId?: number } = {}): Omit<ImportSummary, 'autoMatched'> {
    return tx(this.db, () => {
      const batch = this.db.prepare('INSERT INTO import_batches (filename, source) VALUES (?, ?)').run(opts.filename ?? null, result.source);
      const batchId = Number(batch.lastInsertRowid);
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO bank_transactions (bank_account_id, transaction_date, amount, counter_iban, counter_name, description, reference, source, import_batch_id, dedup_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const seen = new Map<string, number>();
      let imported = 0;
      let duplicates = 0;
      for (const t of result.transactions) {
        const account = opts.bankAccountId ? this.getAccount(opts.bankAccountId) : this.accountForIban(t.ownIban);
        const key = [account.id, t.date, t.amount, t.counterIban, t.description].join('|');
        const occurrence = (seen.get(key) ?? 0) + 1;
        seen.set(key, occurrence);
        const hash = BankService.hash(t, account.iban, occurrence);
        const r = insert.run(account.id, t.date, t.amount, t.counterIban ?? null, t.counterName ?? null, t.description ?? '', t.reference ?? null, result.source, batchId, hash);
        if (r.changes > 0) imported++;
        else duplicates++;
      }
      this.db.prepare('UPDATE import_batches SET imported_count = ?, duplicate_count = ? WHERE id = ?').run(imported, duplicates, batchId);
      return { batchId, imported, duplicates, warnings: result.warnings };
    });
  }

  list(filter: { status?: BankTransaction['status']; bankAccountId?: number; search?: string; limit?: number } = {}): BankTransaction[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status) (where.push('status = ?'), params.push(filter.status));
    if (filter.bankAccountId) (where.push('bank_account_id = ?'), params.push(filter.bankAccountId));
    if (filter.search) {
      where.push('(description LIKE ? OR counter_name LIKE ? OR counter_iban LIKE ?)');
      params.push(`%${filter.search}%`, `%${filter.search}%`, `%${filter.search}%`);
    }
    params.push(filter.limit ?? 500);
    return this.db
      .prepare(`SELECT * FROM bank_transactions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY transaction_date DESC, id DESC LIMIT ?`)
      .all(...params) as BankTransaction[];
  }

  get(id: number): BankTransaction {
    const t = this.db.prepare('SELECT * FROM bank_transactions WHERE id = ?').get(id) as BankTransaction | undefined;
    if (!t) throw new ValidationError(`Banktransactie ${id} bestaat niet`);
    return t;
  }

  private assertOpen(t: BankTransaction): void {
    if (t.status === 'gematcht') throw new ValidationError('Deze transactie is al verwerkt');
  }

  // ---------- verwerken ----------

  matchInvoice(txId: number, invoiceId: number): void {
    const t = this.get(txId);
    this.assertOpen(t);
    const account = this.getAccount(t.bank_account_id);
    tx(this.db, () => {
      const inv = this.invoices.registerPayment(invoiceId, {
        amount: t.amount,
        date: t.transaction_date,
        moneyAccount: account.rgs_code,
        bankTransactionId: txId,
        description: `Ontvangst ${t.counter_name ?? ''} factuur`.replace(/\s+/g, ' '),
      });
      // leer het IBAN van de klant voor toekomstige matching
      if (t.counter_iban) {
        const rel = this.relations.get(inv.relation_id);
        if (!rel.iban && isValidIban(t.counter_iban)) this.relations.update(rel.id, { iban: t.counter_iban });
      }
    });
  }

  matchPurchase(txId: number, purchaseId: number): void {
    const t = this.get(txId);
    this.assertOpen(t);
    const account = this.getAccount(t.bank_account_id);
    this.purchases.registerPayment(purchaseId, { amount: -t.amount, date: t.transaction_date, moneyAccount: account.rgs_code, bankTransactionId: txId });
  }

  /**
   * Boekt een transactie direct op een grootboekrekening ("kantoorkosten", "privé", …),
   * inclusief BTW-splitsing. De gebruiker ziet alleen een categorie en een BTW-keuze.
   */
  bookToAccount(txId: number, input: BookToAccountInput): number {
    const t = this.get(txId);
    this.assertOpen(t);
    const bank = this.getAccount(t.bank_account_id);
    const target = this.ledger.getAccount(input.account);
    const description = input.description?.trim() || t.description || t.counter_name || 'Banktransactie';
    const relationId = input.relationId ?? (t.counter_iban ? this.relations.findByIban(t.counter_iban)?.id ?? null : null);
    let lines: PostLine[];
    const vatCode = input.vatCode ?? 'geen';

    if (target.category === 'kosten' || (target.category === 'activa' && t.amount < 0)) {
      if (!isPurchaseVatCode(vatCode)) throw new ValidationError(`Ongeldige BTW-keuze voor kosten: ${vatCode}`);
      const rate = PURCHASE_VAT_RATES[vatCode];
      // een negatieve transactie is een uitgave; een positieve op een kostenrekening is een terugbetaling
      const gross = -t.amount;
      const { net, vat } = splitGross(gross, rate.percentage, vatCode === 'verlegd');
      lines = expenseLines([{ account: target.rgs_code, netAmount: net, vatCode, vatAmount: vat, description }], bank.rgs_code, relationId, description).lines;
    } else if (target.category === 'omzet') {
      if (!isSalesVatCode(vatCode)) throw new ValidationError(`Ongeldige BTW-keuze voor omzet: ${vatCode}`);
      const { net, vat } = splitGross(t.amount, SALES_VAT_RATES[vatCode].percentage);
      const vatAccount = SALES_ACCOUNTS[vatCode]?.vat;
      lines = [
        signedLine(bank.rgs_code, t.amount),
        signedLine(target.rgs_code, -net, { relationId, vatCode }),
        vat !== 0 && vatAccount ? signedLine(vatAccount, -vat, { relationId, vatCode }) : null,
      ].filter((l): l is PostLine => l !== null);
    } else {
      // privé, btw-afdracht, kruisposten, leningen: geen BTW
      lines = [signedLine(bank.rgs_code, t.amount)!, signedLine(target.rgs_code, -t.amount, { relationId, description })!];
    }

    return tx(this.db, () => {
      const entryId = this.ledger.post({ date: t.transaction_date, description, source: 'bank', sourceRef: `bank:${txId}`, lines });
      this.db.prepare(`UPDATE bank_transactions SET status = 'gematcht', matched_journal_entry_id = ? WHERE id = ?`).run(entryId, txId);
      return entryId;
    });
  }

  ignore(txId: number): void {
    const t = this.get(txId);
    this.assertOpen(t);
    this.db.prepare(`UPDATE bank_transactions SET status = 'genegeerd' WHERE id = ?`).run(txId);
  }

  /** Maakt een verwerking ongedaan via een tegenboeking; de transactie komt weer op 'nieuw'. */
  unmatch(txId: number, date: IsoDate = today()): void {
    const t = this.get(txId);
    tx(this.db, () => {
      if (t.status === 'gematcht' && t.matched_journal_entry_id) {
        if (t.matched_invoice_id) this.invoices.undoPayment(t.matched_invoice_id, t.amount, t.matched_journal_entry_id, date);
        else if (t.matched_purchase_invoice_id) this.purchases.undoPayment(t.matched_purchase_invoice_id, -t.amount, t.matched_journal_entry_id, date);
        else this.ledger.reverse(t.matched_journal_entry_id, date);
      }
      this.db
        .prepare(`UPDATE bank_transactions SET status = 'nieuw', matched_journal_entry_id = NULL, matched_invoice_id = NULL, matched_purchase_invoice_id = NULL WHERE id = ?`)
        .run(txId);
    });
  }

  /** Vorige boeking van dezelfde tegenpartij — gebruikt om categorieën te leren. */
  previousBooking(t: BankTransaction): { account: string; vatCode: string | null } | null {
    if (!t.counter_iban && !t.counter_name) return null;
    const row = this.db
      .prepare(
        `SELECT a.rgs_code, l.vat_code FROM bank_transactions b
         JOIN journal_lines l ON l.journal_entry_id = b.matched_journal_entry_id
         JOIN chart_of_accounts a ON a.id = l.account_id
         WHERE b.status = 'gematcht' AND b.id <> ? AND b.matched_invoice_id IS NULL AND b.matched_purchase_invoice_id IS NULL
           AND ((? IS NOT NULL AND b.counter_iban = ?) OR (? IS NOT NULL AND b.counter_name = ?))
           AND a.category IN ('kosten','omzet','passiva','activa') AND a.id NOT IN (SELECT account_id FROM bank_accounts)
           AND a.rgs_code NOT IN (?, ?)
         ORDER BY b.transaction_date DESC, l.id LIMIT 1`,
      )
      .get(t.id, t.counter_iban, t.counter_iban, t.counter_name, t.counter_name, ACCOUNTS.btwVoorbelasting, ACCOUNTS.btwAfdragenVerlegd) as { rgs_code: string; vat_code: string | null } | undefined;
    return row ? { account: row.rgs_code, vatCode: row.vat_code } : null;
  }

  /** Saldo volgens de (geïmporteerde) bankafschriften, los van de boekhouding. */
  statementBalance(bankAccountId?: number): Cents {
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(amount), 0) AS s FROM bank_transactions ${bankAccountId ? 'WHERE bank_account_id = ?' : ''}`)
      .get(...(bankAccountId ? [bankAccountId] : [])) as { s: number };
    return row.s;
  }

  countUnprocessed(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM bank_transactions WHERE status = 'nieuw'`).get() as { n: number }).n;
  }
}
