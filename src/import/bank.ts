import { createHash } from 'node:crypto';
import type { Db } from '../db/database';
import { tx } from '../db/database';
import { Ledger, signedLine, type PostLine } from '../core-ledger/ledger';
import { ACCOUNTS, SALES_ACCOUNTS } from '../core-ledger/accounts';
import type { InvoiceService } from '../documents/invoices';
import type { PurchaseService } from '../documents/purchases';
import { type BankCategoriePayload } from '../core-ledger/rules';
import type { EventService } from '../core-ledger/events';
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

export interface BankImportStatus {
  bankAccountId: number;
  name: string;
  iban: string | null;
  /** laatste import voor deze rekening; `at` is het moment van inlezen (UTC, SQLite-formaat) */
  lastImport: { at: string; filename: string | null; source: string; from: string; to: string; transactions: number; imported: number; duplicates: number } | null;
  /** eerste en laatste transactiedatum van alle ingelezen afschriften samen */
  coverageFrom: string | null;
  coverageTo: string | null;
  totalTransactions: number;
}

export interface ImportSummary {
  batchId: number;
  /** per bankrekening de periode die het afschrift besloeg */
  periods: { bankAccountId: number; from: string; to: string }[];
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
  /** klus waar deze uitgave bij hoort (#32) */
  jobId?: number | null;
}

export { splitGross } from '../core-ledger/rules';

export class BankService {
  constructor(
    private readonly db: Db,
    private readonly ledger: Ledger,
    private readonly invoices: InvoiceService,
    private readonly purchases: PurchaseService,
    private readonly relations: RelationsService,
    private readonly events: EventService,
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
    if (!isValidIban(clean)) throw new ValidationError(`Dit rekeningnummer klopt niet: ${iban}`);
    if (!name.trim()) throw new ValidationError('Geef de rekening een naam, bijvoorbeeld "Spaarrekening"');
    if (this.listAccounts().some((a) => a.iban === clean)) throw new ValidationError('Deze rekening staat er al in');
    name = name.trim();
    return tx(this.db, () => {
      const n = this.listAccounts().length;
      // tweede en volgende rekeningen krijgen een eigen grootboekrekening
      const rgs = n === 0 ? ACCOUNTS.bank : `${ACCOUNTS.bank}${n + 1}`;
      // RGS: 'Rekening-courant bank - Naam A..E' (BLimBanRbb..f) voor extra rekeningen
      const rgsRef = n >= 1 && n <= 5 ? `BLimBanRb${String.fromCharCode(97 + n)}` : null;
      const ledgerAccount = n === 0 ? this.ledger.getAccount(ACCOUNTS.bank) : this.ledger.createAccount({ code: String(1100 + n), rgs, rgsRef, name: `Bank ${name}`, category: 'activa' });
      this.db.prepare('INSERT INTO bank_accounts (name, iban, account_id) VALUES (?, ?, ?)').run(name, clean, ledgerAccount.id);
      return this.listAccounts().find((a) => a.iban === clean)!;
    });
  }

  updateAccount(id: number, patch: { name?: string; iban?: string | null }): void {
    const iban = patch.iban ? normalizeIban(patch.iban) : patch.iban;
    if (iban && !isValidIban(iban)) throw new ValidationError(`Dit rekeningnummer klopt niet: ${patch.iban}`);
    const current = this.getAccount(id);
    if (patch.name !== undefined && !patch.name.trim()) throw new ValidationError('Geef de rekening een naam');
    if (iban && this.listAccounts().some((a) => a.id !== id && a.iban === iban)) throw new ValidationError('Deze rekening staat er al in');
    if (patch.name !== undefined) patch = { ...patch, name: patch.name.trim() };
    this.db.prepare('UPDATE bank_accounts SET name = ?, iban = ? WHERE id = ?').run(patch.name ?? current.name, iban === undefined ? current.iban : iban, id);
  }

  getAccount(id: number): BankAccount {
    const a = this.listAccounts().find((x) => x.id === id);
    if (!a) throw new ValidationError('Deze bankrekening bestaat niet (meer)');
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

  /**
   * Beginsaldo van een bankrekening tegen eigen vermogen. Een eerder beginsaldo van dezelfde rekening
   * wordt eerst teruggedraaid, zodat opnieuw invoeren het saldo vervangt in plaats van optelt.
   */
  setOpeningBalance(bankAccountId: number, amount: Cents, date: IsoDate): number {
    if (!Number.isSafeInteger(amount)) throw new ValidationError('Vul het saldo in');
    const account = this.getAccount(bankAccountId);
    return tx(this.db, () => {
      for (const e of this.openingEntries(account)) this.ledger.reverse(e.id, e.entry_date, `Beginsaldo ${account.name} vervangen`);
      if (amount === 0) return 0;
      return this.ledger.post({
        date,
        description: `Beginsaldo ${account.name}`,
        source: 'opening',
        lines: [signedLine(account.rgs_code, amount)!, signedLine(ACCOUNTS.eigenVermogen, -amount)!],
      });
    });
  }

  /** Het huidige beginsaldo van een rekening (0 als er geen is). */
  openingBalance(bankAccountId: number): { amount: Cents; date: IsoDate | null } {
    const account = this.getAccount(bankAccountId);
    const entries = this.openingEntries(account);
    const amount = entries.reduce((sum, e) => sum + e.amount, 0);
    return { amount, date: entries.at(-1)?.entry_date ?? null };
  }

  private openingEntries(account: BankAccount): { id: number; entry_date: IsoDate; amount: Cents }[] {
    return this.db
      .prepare(
        `SELECT e.id, e.entry_date, SUM(l.debit - l.credit) AS amount FROM journal_entries e
         JOIN journal_lines l ON l.journal_entry_id = e.id
         WHERE e.source = 'opening' AND l.account_id = ? AND e.reverses_entry_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id = e.id)
         GROUP BY e.id ORDER BY e.id`,
      )
      .all(account.account_id) as { id: number; entry_date: IsoDate; amount: Cents }[];
  }

  // ---------- overboekingen tussen eigen rekeningen ----------

  /** De eigen rekening aan de andere kant van deze betaling, of null als het geld van/naar iemand anders ging. */
  ownTransferTarget(t: Pick<BankTransaction, 'bank_account_id' | 'counter_iban'>): BankAccount | null {
    if (!t.counter_iban) return null;
    const iban = normalizeIban(t.counter_iban);
    return this.listAccounts().find((a) => a.id !== t.bank_account_id && a.iban === iban) ?? null;
  }

  /**
   * Overboeking tussen eigen rekeningen: telt niet als omzet of kosten. Staat dezelfde overboeking
   * al verwerkt op de andere rekening (die kant is eerder ingelezen), dan wordt deze kant daaraan
   * gekoppeld zonder nieuwe boeking; anders boekt de app van de ene bankrekening naar de andere.
   */
  bookOwnTransfer(txId: number): number {
    const t = this.get(txId);
    this.assertOpen(t);
    const other = this.ownTransferTarget(t);
    if (!other) throw new ValidationError('Het rekeningnummer van de andere kant is niet een van je eigen rekeningen');
    const own = this.getAccount(t.bank_account_id);
    const counterpart = this.db
      .prepare(
        `SELECT c.id, c.matched_journal_entry_id AS entryId,
                EXISTS (SELECT 1 FROM journal_lines l WHERE l.journal_entry_id = c.matched_journal_entry_id AND l.account_id = ?) AS toThis,
                EXISTS (SELECT 1 FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id WHERE l.journal_entry_id = c.matched_journal_entry_id AND a.rgs_code = ?) AS viaKruis
         FROM bank_transactions c
         WHERE c.bank_account_id = ? AND c.amount = ? AND c.status = 'gematcht' AND c.matched_journal_entry_id IS NOT NULL
           AND c.matched_invoice_id IS NULL AND c.matched_purchase_invoice_id IS NULL
           AND ABS(julianday(c.transaction_date) - julianday(?)) <= 5
           AND (SELECT COUNT(*) FROM bank_transactions x WHERE x.matched_journal_entry_id = c.matched_journal_entry_id) = 1
         ORDER BY ABS(julianday(c.transaction_date) - julianday(?)), c.id`,
      )
      .all(own.account_id, ACCOUNTS.kruisposten, other.id, -t.amount, t.transaction_date, t.transaction_date) as { id: number; entryId: number; toThis: number; viaKruis: number }[];
    const linked = counterpart.find((c) => c.toThis);
    if (linked) {
      // de andere kant boekte al naar deze rekening: alleen koppelen, niets dubbel boeken
      this.db.prepare(`UPDATE bank_transactions SET status = 'gematcht', matched_journal_entry_id = ? WHERE id = ?`).run(linked.entryId, txId);
      return linked.entryId;
    }
    // de andere kant staat op "overboeking" (kruisposten): deze kant haalt het daar weer af
    const account = counterpart.some((c) => c.viaKruis) ? ACCOUNTS.kruisposten : other.rgs_code;
    return this.bookToAccount(txId, { account, description: `${t.amount < 0 ? 'Naar' : 'Van'} ${other.name} (eigen rekening)` });
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
      const perAccount = new Map<number, { from: string; to: string; transactions: number; imported: number; duplicates: number }>();
      for (const t of result.transactions) {
        const account = opts.bankAccountId ? this.getAccount(opts.bankAccountId) : this.accountForIban(t.ownIban);
        const stat = perAccount.get(account.id) ?? { from: t.date, to: t.date, transactions: 0, imported: 0, duplicates: 0 };
        if (t.date < stat.from) stat.from = t.date;
        if (t.date > stat.to) stat.to = t.date;
        stat.transactions++;
        perAccount.set(account.id, stat);
        const key = [account.id, t.date, t.amount, t.counterIban, t.description].join('|');
        const occurrence = (seen.get(key) ?? 0) + 1;
        seen.set(key, occurrence);
        const hash = BankService.hash(t, account.iban, occurrence);
        const r = insert.run(account.id, t.date, t.amount, t.counterIban ?? null, t.counterName ?? null, t.description ?? '', t.reference ?? null, result.source, batchId, hash);
        if (r.changes > 0) (imported++, stat.imported++);
        else (duplicates++, stat.duplicates++);
      }
      const insertStat = this.db.prepare(
        'INSERT INTO import_batch_accounts (batch_id, bank_account_id, period_from, period_to, transactions, imported, duplicates) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      for (const [accountId, s] of perAccount) insertStat.run(batchId, accountId, s.from, s.to, s.transactions, s.imported, s.duplicates);
      this.db.prepare('UPDATE import_batches SET imported_count = ?, duplicate_count = ? WHERE id = ?').run(imported, duplicates, batchId);
      const periods = [...perAccount].map(([bankAccountId, s]) => ({ bankAccountId, from: s.from, to: s.to }));
      return { batchId, periods, imported, duplicates, warnings: result.warnings };
    });
  }

  /**
   * Per bankrekening: wanneer is er voor het laatst een afschrift ingelezen, welke periode besloeg
   * dat afschrift, en t/m welke datum zijn de bankgegevens in totaal bijgewerkt.
   */
  importStatus(): BankImportStatus[] {
    return this.listAccounts().map((a) => {
      const last = this.db
        .prepare(
          `SELECT b.imported_at, b.filename, b.source, s.period_from, s.period_to, s.transactions, s.imported, s.duplicates
           FROM import_batch_accounts s JOIN import_batches b ON b.id = s.batch_id
           WHERE s.bank_account_id = ? ORDER BY b.imported_at DESC, b.id DESC LIMIT 1`,
        )
        .get(a.id) as { imported_at: string; filename: string | null; source: string; period_from: string; period_to: string; transactions: number; imported: number; duplicates: number } | undefined;
      const coverage = this.db
        .prepare('SELECT MIN(transaction_date) AS f, MAX(transaction_date) AS t, COUNT(*) AS n FROM bank_transactions WHERE bank_account_id = ?')
        .get(a.id) as { f: string | null; t: string | null; n: number };
      return {
        bankAccountId: a.id,
        name: a.name,
        iban: a.iban,
        lastImport: last
          ? { at: last.imported_at, filename: last.filename, source: last.source, from: last.period_from, to: last.period_to, transactions: last.transactions, imported: last.imported, duplicates: last.duplicates }
          : null,
        coverageFrom: coverage.f,
        coverageTo: coverage.t,
        totalTransactions: coverage.n,
      };
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
    if (!t) throw new ValidationError('Deze betaling bestaat niet (meer)');
    return t;
  }

  private assertOpen(t: BankTransaction): void {
    if (t.status === 'gematcht') throw new ValidationError('Deze betaling is al verwerkt');
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
    const vatCode = input.vatCode ?? 'geen';
    const payload: BankCategoriePayload = {
      bankTransactionId: txId,
      date: t.transaction_date,
      amount: t.amount,
      bankAccount: bank.rgs_code,
      account: target.rgs_code,
      accountCategory: target.category,
      vatCode,
      relationId,
      description,
    };
    return tx(this.db, () => {
      const { entryId } = this.events.record({ type: 'bank-categorie', payload }, [{ kind: 'bank', refId: txId }], { jobId: input.jobId ?? null });
      this.db.prepare(`UPDATE bank_transactions SET status = 'gematcht', matched_journal_entry_id = ? WHERE id = ?`).run(entryId, txId);
      return entryId;
    });
  }

  /**
   * Andere categorie of btw-keuze voor een al geboekte transactie (#19): de gebeurtenis wordt
   * vervangen, de oude post krijgt een tegenboeking en de nieuwe wordt opnieuw gecompileerd.
   */
  reclassify(txId: number, change: { account: string; vatCode?: string; description?: string }, reason = 'andere categorie'): number {
    const t = this.get(txId);
    if (t.status !== 'gematcht' || !t.matched_journal_entry_id || t.matched_invoice_id || t.matched_purchase_invoice_id) {
      throw new ValidationError('Alleen een betaling waar je zelf een soort kosten bij koos, kun je zo aanpassen');
    }
    if (this.sharedWith(t).length > 0) throw new ValidationError('Dit is een overboeking tussen je eigen rekeningen. Klopt dat niet? Maak het dan ongedaan.');
    const event = this.events.forEntry(t.matched_journal_entry_id);
    if (!event || event.type !== 'bank-categorie') throw new ValidationError('Deze betaling is met een oudere versie van de app verwerkt. Maak de verwerking ongedaan en doe het opnieuw.');
    const target = this.ledger.getAccount(change.account);
    const old = event.payload as BankCategoriePayload;
    const payload: BankCategoriePayload = {
      ...old,
      account: target.rgs_code,
      accountCategory: target.category,
      vatCode: change.vatCode ?? old.vatCode,
      description: change.description?.trim() || old.description,
    };
    return tx(this.db, () => {
      const { entryId } = this.events.replace(event.id, { type: 'bank-categorie', payload }, reason);
      this.db.prepare('UPDATE bank_transactions SET matched_journal_entry_id = ? WHERE id = ?').run(entryId, txId);
      return entryId;
    });
  }

  ignore(txId: number): void {
    const t = this.get(txId);
    this.assertOpen(t);
    this.db.prepare(`UPDATE bank_transactions SET status = 'genegeerd' WHERE id = ?`).run(txId);
  }

  /** Andere bankregels die aan dezelfde boeking gekoppeld zijn (de andere kant van een eigen overboeking). */
  private sharedWith(t: BankTransaction): number[] {
    if (!t.matched_journal_entry_id) return [];
    return (this.db.prepare('SELECT id FROM bank_transactions WHERE matched_journal_entry_id = ? AND id <> ?').all(t.matched_journal_entry_id, t.id) as { id: number }[]).map((r) => r.id);
  }

  /**
   * Maakt een verwerking ongedaan via een tegenboeking; de transactie komt weer op 'nieuw'.
   * Bij een overboeking tussen eigen rekeningen gaan beide kanten terug.
   */
  unmatch(txId: number, date: IsoDate = today()): void {
    const t = this.get(txId);
    const shared = this.sharedWith(t);
    tx(this.db, () => {
      if (t.status === 'gematcht' && t.matched_journal_entry_id) {
        if (t.matched_invoice_id) this.invoices.undoPayment(t.matched_invoice_id, t.amount, t.matched_journal_entry_id, date);
        else if (t.matched_purchase_invoice_id) this.purchases.undoPayment(t.matched_purchase_invoice_id, -t.amount, t.matched_journal_entry_id, date);
        else this.ledger.reverse(t.matched_journal_entry_id, date);
      }
      this.db
        .prepare(`UPDATE bank_transactions SET status = 'nieuw', matched_journal_entry_id = NULL, matched_invoice_id = NULL, matched_purchase_invoice_id = NULL WHERE id = ?`)
        .run(txId);
      for (const id of shared) {
        this.db
          .prepare(`UPDATE bank_transactions SET status = 'nieuw', matched_journal_entry_id = NULL WHERE id = ?`)
          .run(id);
      }
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
