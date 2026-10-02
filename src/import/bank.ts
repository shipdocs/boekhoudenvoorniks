import { sameBankName } from '../shared/bank-name';
import { createHash } from 'node:crypto';
import { sameCounterparty, sameTextVariant } from './same-payment';
import type { Db } from '../db/database';
import { tx } from '../db/database';
import { Ledger, signedLine, type PostLine } from '../core-ledger/ledger';
import { ACCOUNTS, SALES_ACCOUNTS } from '../core-ledger/accounts';
import type { InvoiceService } from '../documents/invoices';
import type { PurchaseService } from '../documents/purchases';
import { businessPct, type BankCategoriePayload } from '../core-ledger/rules';
import { businessShareFor, setBusinessShare } from '../intake/business-share';
import type { EventService } from '../core-ledger/events';
import type { RelationsService } from '../relations/relations';
import { EU_COUNTRIES, PURCHASE_VAT_RATES, SALES_VAT_RATES, countryCode, customerVatSituation, isPurchaseVatCode, isSalesVatCode, suggestedSalesVat, vatNumberMatchesCountry, type SalesVatCode } from '../shared/vat';
import { formatEuro, roundHalfAwayFromZero, type Cents } from '../shared/money';
import { addDays, diffDays, formatDateNl, today, workdaysBetween, type IsoDate } from '../shared/dates';
import { isValidIban, normalizeIban, ValidationError } from '../shared/validation';
import { korActive } from '../settings/settings';
import type { NormalizedTransaction, ParseResult } from './types';
import { referenceIn } from '../shared/references';
import { withinFx } from '../shared/currency';
import { paymentProviderIn } from '../shared/payment-providers';

export interface BankAccount {
  id: number;
  name: string;
  iban: string | null;
  account_id: number;
  rgs_code: string;
  /** 1 = potje binnen de bank zonder eigen rekeningnummer (bv. Knab); daar komen geen afschriften van */
  is_pot: number;
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
  /** de id die de bank zelf gaf; null bij een afschrift zonder id's en bij alles van vóór deze kolom */
  bank_id: string | null;
  /** deelpost van een verzamelboeking (CAMT): de id van die boeking en haar totaal */
  batch_ref: string | null;
  batch_total: Cents | null;
  /** uit de boekhouding gehaald omdat dit bedrag er dubbel in stond: de betaling die bleef */
  duplicate_of: number | null;
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
  /**
   * t/m welke dag de bankgegevens compleet zijn (#226). Een dag telt pas als het afschrift ná die dag is
   * ingelezen: een export van vandaag mist wat er later vandaag nog bij komt.
   */
  completeTo: string | null;
  totalTransactions: number;
  /** regels die zijn overgeslagen omdat de betaling er al stond (en niet alsnog toegevoegd), of die als dubbel uit de boekhouding zijn gehaald */
  skipped: number;
}

export interface ImportSummary {
  batchId: number;
  /** per bankrekening de periode die het afschrift besloeg */
  periods: { bankAccountId: number; from: string; to: string }[];
  imported: number;
  /** stonden er al: dezelfde regel opnieuw, of dezelfde betaling uit een ander soort afschrift */
  duplicates: number;
  /** daarvan niet toegevoegd omdat dezelfde betaling er al stond uit een ander soort afschrift; te bekijken en alsnog toe te voegen */
  skipped: number;
  /** van de nieuwe: in dagen die een eerder afschrift al besloeg (dat afschrift miste ze waarschijnlijk) */
  addedInKnownPeriod: number;
  /** de periodes van de eerdere afschriften waar de betalingen die er al stonden uit kwamen */
  knownFrom: { from: string; to: string }[];
  warnings: string[];
  autoMatched: number;
}

/** Hooguit zoveel werkdagen mag de datum van dezelfde betaling in twee soorten afschrift verschillen. */
export const SAME_PAYMENT_WORKDAYS = 3;

/** Zoveel werkdagen mogen één regel en de deelposten van hetzelfde bedrag uit elkaar liggen voor de melding "staat er twee keer in". */
export const BATCH_WARN_WORKDAYS = 5;

/** Eén kant van een bedrag dat er twee keer in staat: een betaling zoals hij in de boeken staat. */
export interface DoubleSide {
  id: number;
  date: IsoDate;
  amount: Cents;
  counterName: string | null;
  description: string;
  status: BankTransaction['status'];
  filename: string | null;
}

/**
 * Een verzamelbetaling die er twee keer in staat: als één regel (CSV, MT940) én als losse deelposten (CAMT).
 * Eén kant moet eruit; wat al verwerkt is, haalt de app er niet zelf uit.
 */
export interface BatchDouble {
  /** de ene regel en de eerste deelpost: samen de sleutel van deze melding */
  lineId: number;
  firstPartId: number;
  bankAccountId: number;
  accountName: string;
  total: Cents;
  line: DoubleSide;
  parts: DoubleSide[];
  /** de ene regel is nog niet verwerkt, dus die mag eruit */
  canRemoveLine: boolean;
  /** geen van de deelposten is verwerkt, dus die mogen eruit */
  canRemoveParts: boolean;
}

/**
 * Twee losse regels die dezelfde betaling lijken (#225): dezelfde rekening, hetzelfde bedrag en bijna dezelfde
 * tegenpartij, uit verschillende imports, op dezelfde dag of (uit twee soorten afschrift) een paar werkdagen
 * uit elkaar. Eén van de twee moet eruit; wat al verwerkt is, haalt de app er niet zelf uit.
 */
export interface PaymentDouble {
  /** de regel die er het eerst stond en de regel die er later bij kwam: samen de sleutel van deze melding */
  firstId: number;
  secondId: number;
  bankAccountId: number;
  accountName: string;
  amount: Cents;
  first: DoubleSide;
  second: DoubleSide;
}

/** Een betaling die uit de boekhouding is gehaald omdat het bedrag er dubbel in stond; terug te zetten. */
export interface RemovedDuplicate extends DoubleSide {
  bankAccountId: number;
  accountName: string;
  /** de betaling die bleef */
  kept: { id: number; date: IsoDate; counterName: string | null; description: string };
}

/** Een regel uit een afschrift die niet is toegevoegd omdat de betaling er al stond, met die betaling ernaast. */
export interface SkippedRow {
  id: number;
  batchId: number;
  bankAccountId: number;
  accountName: string;
  date: IsoDate;
  amount: Cents;
  counterName: string | null;
  counterIban: string | null;
  description: string;
  source: string;
  /** de betaling die er al stond */
  existing: { id: number; date: IsoDate; amount: Cents; counterName: string | null; description: string; source: string; filename: string | null };
  /**
   * Verzamelbetaling: 'deelpost' = deze deelpost is overgeslagen omdat het totaal er al als één regel stond
   * (Toch toevoegen voegt alle deelposten toe); 'totaal' = deze ene regel is overgeslagen omdat de deelposten
   * er al stonden (`parts` deelposten, samen dit bedrag).
   */
  batch: { kind: 'deelpost' | 'totaal'; parts: number; total: Cents } | null;
  /** alsnog toegevoegd met "Toch toevoegen" */
  added: boolean;
}

/** Vergelijking van het laatste eindsaldo van de bank met wat de app heeft, vanaf het beginsaldo. */
export interface BalanceCheck {
  bankAccountId: number;
  /** de dag van het eindsaldo */
  date: IsoDate;
  bank: Cents;
  app: Cents;
  /** bank − app: positief = er mist geld dat binnenkwam (of een afschrijving staat dubbel) */
  difference: Cents;
  /** een overgeslagen regel van precies dit bedrag: de eerste kandidaat */
  candidate: { skippedId: number; date: IsoDate; amount: Cents; counterName: string | null; description: string } | null;
}

export interface BookToAccountInput {
  /** RGS-code van de tegenrekening (kosten, omzet, privé, …) */
  account: string;
  vatCode?: string;
  description?: string;
  relationId?: number | null;
  /** klus waar deze uitgave bij hoort (#32) */
  jobId?: number | null;
  /** verkoop via een ander systeem (Mollie, webshop, kassa) */
  channel?: string | null;
  /**
   * Zakelijk deel van een uitgave in procenten (1–100). Weglaten = wat eerder voor deze tegenpartij
   * is opgegeven, anders 100. Wordt onthouden voor deze tegenpartij.
   */
  businessPct?: number;
}

export interface SaleInput {
  vatCode: SalesVatCode;
  relationId?: number | null;
  /** bv. "Mollie", "webshop"; mag leeg */
  channel?: string | null;
  /** nummer van de factuur of bon; mag leeg */
  reference?: string | null;
}

/** Een eerdere verkoop via een ander systeem van dezelfde betaler: om met één klik te herhalen. */
export interface PreviousSale {
  vatCode: SalesVatCode;
  channel: string | null;
  relationId: number | null;
  date: IsoDate;
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

  /**
   * Zonder IBAN: een potje binnen je bank zonder eigen rekeningnummer (bv. een Knab-potje voor de
   * btw). Daar komen geen afschriften van; geld erheen of eruit kies je bij de betaling zelf.
   */
  /**
   * Nieuwe rekening. Zonder rekeningnummer is het standaard een potje binnen je bank (bv. Knab), tenzij
   * `pot: false`: een echte rekening waarvan het nummer nog niet bekend is (bv. uit een auditfile).
   */
  addAccount(name: string, iban: string | null, opts: { pot?: boolean } = {}): BankAccount {
    const clean = iban?.trim() ? normalizeIban(iban) : null;
    if (clean && !isValidIban(clean)) throw new ValidationError(`Dit rekeningnummer klopt niet: ${iban}`);
    if (!name.trim()) throw new ValidationError('Geef de rekening een naam, bijvoorbeeld "Spaarrekening"');
    if (clean && this.listAccounts().some((a) => a.iban === clean)) throw new ValidationError('Deze rekening staat er al in');
    if (!clean && this.listAccounts().some((a) => a.name.toLowerCase() === name.trim().toLowerCase())) throw new ValidationError('Er is al een rekening met deze naam');
    name = name.trim();
    return tx(this.db, () => {
      let n = this.listAccounts().length;
      // een weggehaalde rekening laat zijn (verborgen) grootboekrekening achter: het eerstvolgende vrije nummer
      const taken = (k: number) => this.db.prepare('SELECT 1 FROM chart_of_accounts WHERE rgs_code = ? OR code = ?').get(`${ACCOUNTS.bank}${k + 1}`, String(1100 + k));
      if (n > 0) while (taken(n)) n++;
      // tweede en volgende rekeningen krijgen een eigen grootboekrekening
      const rgs = n === 0 ? ACCOUNTS.bank : `${ACCOUNTS.bank}${n + 1}`;
      // RGS: 'Rekening-courant bank - Naam A..E' (BLimBanRbb..f) voor extra rekeningen
      const rgsRef = n >= 1 && n <= 5 ? `BLimBanRb${String.fromCharCode(97 + n)}` : null;
      const ledgerAccount = n === 0 ? this.ledger.getAccount(ACCOUNTS.bank) : this.ledger.createAccount({ code: String(1100 + n), rgs, rgsRef, name: `Bank ${name}`, category: 'activa' });
      const id = Number(this.db.prepare('INSERT INTO bank_accounts (name, iban, account_id, is_pot) VALUES (?, ?, ?, ?)').run(name, clean, ledgerAccount.id, clean ? 0 : opts.pot === false ? 0 : 1).lastInsertRowid);
      return this.getAccount(id);
    });
  }

  updateAccount(id: number, patch: { name?: string; iban?: string | null; pot?: boolean }): void {
    const iban = patch.iban ? normalizeIban(patch.iban) : patch.iban;
    if (iban && !isValidIban(iban)) throw new ValidationError(`Dit rekeningnummer klopt niet: ${patch.iban}`);
    const current = this.getAccount(id);
    if (patch.name !== undefined && !patch.name.trim()) throw new ValidationError('Geef de rekening een naam');
    if (iban && this.listAccounts().some((a) => a.id !== id && a.iban === iban)) throw new ValidationError('Deze rekening staat er al in');
    if (patch.name !== undefined) patch = { ...patch, name: patch.name.trim() };
    const name = patch.name ?? current.name;
    if (this.listAccounts().some((a) => a.id !== id && a.name.toLowerCase() === name.toLowerCase())) throw new ValidationError('Er is al een rekening met deze naam');
    const nextIban = iban === undefined ? current.iban : iban;
    // krijgt een potje toch een rekeningnummer, dan is het een gewone rekening
    const pot = nextIban ? 0 : patch.pot === undefined ? current.is_pot : patch.pot ? 1 : 0;
    this.db.prepare('UPDATE bank_accounts SET name = ?, iban = ?, is_pot = ? WHERE id = ?').run(name, nextIban, pot, id);
  }

  /** Kan deze rekening weg? Alleen als er niets op staat: geen afschriften, geen boekingen, saldo 0. */
  removable(id: number): { ok: boolean; reason: string | null } {
    const account = this.getAccount(id);
    if (this.listAccounts().length === 1) return { ok: false, reason: 'Je hebt minstens één rekening nodig' };
    if (account.rgs_code === ACCOUNTS.bank) return { ok: false, reason: 'Dit is je hoofdrekening; die kan niet weg' };
    if (this.db.prepare('SELECT 1 FROM bank_transactions WHERE bank_account_id = ?').get(id)) return { ok: false, reason: 'Er zijn afschriften van deze rekening ingelezen' };
    const used = this.db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(l.debit), 0) - COALESCE(SUM(l.credit), 0) AS balance FROM journal_lines l
         JOIN journal_entries e ON e.id = l.journal_entry_id WHERE l.account_id = ? AND e.source <> 'opening'`,
      )
      .get(account.account_id) as { n: number; balance: number };
    if (used.n > 0) return { ok: false, reason: 'Er staan boekingen op deze rekening' };
    if (this.openingBalance(id).amount !== 0) return { ok: false, reason: 'Er staat nog een beginsaldo op; zet dat eerst op € 0' };
    return { ok: true, reason: null };
  }

  /** Een lege rekening weghalen (bv. dubbel aangemaakt bij het inlezen van een auditfile). */
  removeAccount(id: number): void {
    const check = this.removable(id);
    if (!check.ok) throw new ValidationError(check.reason!);
    const account = this.getAccount(id);
    tx(this.db, () => {
      this.db.prepare('DELETE FROM import_batch_accounts WHERE bank_account_id = ?').run(id);
      this.db.prepare('DELETE FROM bank_accounts WHERE id = ?').run(id);
      // de grootboekrekening blijft bestaan (er kunnen teruggedraaide beginsaldi op staan), maar verborgen
      this.db.prepare('UPDATE chart_of_accounts SET archived = 1 WHERE id = ?').run(account.account_id);
    });
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
      const unassigned = accounts.find((a) => !a.iban && !a.is_pot);
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
   * Een bestand zonder eigen IBAN, maar wel van een bekende bank (bv. Revolut): de rekening met die
   * naam, anders een nieuwe. Nooit zomaar de eerste rekening: dan komt Revolut op je Knab terecht.
   * De lege standaardrekening van een nieuwe administratie wordt hergebruikt.
   */
  private accountForBank(bank: string): BankAccount {
    const accounts = this.listAccounts();
    const named = accounts.find((a) => !a.is_pot && sameBankName(a.name, bank));
    if (named) return named;
    const fresh = accounts.length === 1 && !accounts[0]!.iban && !accounts[0]!.is_pot && accounts[0]!.name === 'Zakelijke rekening'
      && !this.db.prepare('SELECT 1 FROM bank_transactions WHERE bank_account_id = ? LIMIT 1').get(accounts[0]!.id);
    if (fresh) {
      this.db.prepare('UPDATE bank_accounts SET name = ? WHERE id = ?').run(bank, accounts[0]!.id);
      return { ...accounts[0]!, name: bank };
    }
    if (accounts.length === 0) {
      const created = this.ensureDefaultAccount();
      this.db.prepare('UPDATE bank_accounts SET name = ? WHERE id = ?').run(bank, created.id);
      return { ...created, name: bank };
    }
    return this.addAccount(bank, null, { pot: false });
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
    const entryId = this.bookToAccount(txId, { account, description: `${t.amount < 0 ? 'Naar' : 'Van'} ${other.name} (eigen rekening)` });
    // de andere kant staat er al (nog open), maar zonder rekeningnummer (bv. Knab → spaarrekening:
    // alleen het korte nummer) en kan zichzelf dus niet herkennen: meteen aan dezelfde boeking
    // koppelen, anders blijft die als vraag staan en telt hij bij "zakelijk" dubbel
    if (account === other.rgs_code) {
      const open = this.db
        .prepare(
          `SELECT id FROM bank_transactions
           WHERE bank_account_id = ? AND amount = ? AND status = 'nieuw' AND counter_iban IS NULL
             AND ABS(julianday(transaction_date) - julianday(?)) <= 5
           ORDER BY ABS(julianday(transaction_date) - julianday(?)), id LIMIT 1`,
        )
        .get(other.id, -t.amount, t.transaction_date, t.transaction_date) as { id: number } | undefined;
      if (open) this.db.prepare(`UPDATE bank_transactions SET status = 'gematcht', matched_journal_entry_id = ? WHERE id = ?`).run(entryId, open.id);
    }
    return entryId;
  }

  /**
   * Een open betaling zonder (herkenbaar) rekeningnummer, waarvan de andere kant al als eigen
   * overboeking naar deze rekening geboekt is: aan die boeking koppelen. Bv. "BTW sparen" op Knab,
   * terwijl de spaarrekening de overboeking van Knab al verwerkte. Geeft de boeking, of null.
   */
  linkBookedOwnTransfer(txId: number): number | null {
    const t = this.get(txId);
    if (t.status !== 'nieuw' || t.counter_iban) return null;
    const own = this.getAccount(t.bank_account_id);
    if (!own.iban) return null;
    const c = this.db
      .prepare(
        `SELECT c.matched_journal_entry_id AS entryId FROM bank_transactions c
         WHERE c.bank_account_id != ? AND c.amount = ? AND c.status = 'gematcht' AND c.matched_journal_entry_id IS NOT NULL
           AND c.matched_invoice_id IS NULL AND c.matched_purchase_invoice_id IS NULL AND c.counter_iban = ?
           AND ABS(julianday(c.transaction_date) - julianday(?)) <= 5
           AND EXISTS (SELECT 1 FROM journal_lines l WHERE l.journal_entry_id = c.matched_journal_entry_id AND l.account_id = ?)
           AND (SELECT COUNT(*) FROM bank_transactions x WHERE x.matched_journal_entry_id = c.matched_journal_entry_id) = 1
         ORDER BY ABS(julianday(c.transaction_date) - julianday(?)), c.id LIMIT 1`,
      )
      .get(own.id, -t.amount, own.iban, t.transaction_date, own.account_id, t.transaction_date) as { entryId: number } | undefined;
    if (!c) return null;
    this.db.prepare(`UPDATE bank_transactions SET status = 'gematcht', matched_journal_entry_id = ? WHERE id = ?`).run(c.entryId, txId);
    return c.entryId;
  }

  // ---------- import ----------

  static hash(t: NormalizedTransaction, ownIban: string | null, occurrence: number): string {
    const basis = t.bankId
      ? `id|${ownIban ?? ''}|${t.bankId}`
      : [ownIban ?? '', t.date, t.amount, t.counterIban ?? '', (t.description ?? '').replace(/\s+/g, ' ').trim().toLowerCase(), occurrence].join('|');
    return createHash('sha256').update(basis).digest('hex');
  }

  /**
   * Leest een afschrift in. Een betaling die er al staat, komt er niet nog een keer in (#184):
   * 1. zelfde hash als een bestaande betaling of een eerder overgeslagen regel: overslaan;
   * 2. valt de datum in dagen die een eerder afschrift al besloeg, dan zoeken we de tegenhanger (zelfde
   *    rekening en bedrag, zelfde tegenrekening als beide er een hebben, hooguit 3 werkdagen ertussen).
   *    Gevonden: niet toevoegen, wel bewaren in import_skipped. Niet gevonden: toevoegen, want dan miste
   *    het eerdere afschrift hem waarschijnlijk;
   * 3. daarbuiten: gewoon toevoegen.
   * Elke bestaande betaling telt per soort afschrift maar één keer als tegenhanger, zodat twee echte
   * gelijke betalingen er allebei in blijven en een derde soort afschrift dezelfde betaling toch herkent.
   * Het soort afschrift is de bron plus, bij CSV, de indeling. Daarbij:
   * - betalingen uit hetzelfde soort afschrift zijn geen tegenhanger: daar beslist de hash, zoals altijd
   *   (twee keer hetzelfde soort met een dag overlap blijft dus werken zoals het deed);
   * - stap 2 geldt ook hooguit 3 werkdagen vóór of na een eerder afschrift van een ander soort (alleen
   *   tegen betalingen van dat andere soort): daar verschuift de datum over de rand van de periode.
   */
  import(result: ParseResult, opts: { filename?: string; bankAccountId?: number; /** hash van de inhoud van het bestand, om hetzelfde afschrift in de downloadmap te herkennen */ contentHash?: string } = {}): Omit<ImportSummary, 'autoMatched'> {
    return tx(this.db, () => {
      // alleen betalingen van vóór deze import kunnen een tegenhanger zijn
      const lastBefore = (this.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM bank_transactions').get() as { id: number }).id;
      // het soort afschrift: de bron, en bij CSV ook de indeling
      const kind = result.layout ? `${result.source}:${result.layout}` : result.source;
      const batch = this.db.prepare('INSERT INTO import_batches (filename, source, kind, content_hash) VALUES (?, ?, ?, ?)').run(opts.filename ?? null, result.source, kind, opts.contentHash ?? null);
      const batchId = Number(batch.lastInsertRowid);
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO bank_transactions (bank_account_id, transaction_date, amount, counter_iban, counter_name, description, reference, source, import_batch_id, dedup_hash, bank_id, batch_ref, batch_total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const byHash = this.db.prepare('SELECT id, bank_id, batch_ref, import_batch_id AS batch, bank_account_id AS account, amount, transaction_date AS date FROM bank_transactions WHERE dedup_hash = ?');
      const skippedByHash = this.db.prepare(
        `SELECT k.matched_transaction_id AS matched, t.import_batch_id AS batch, t.bank_account_id AS account, k.amount, k.transaction_date AS date
         FROM import_skipped k JOIN bank_transactions t ON t.id = k.matched_transaction_id WHERE k.dedup_hash = ?`,
      );
      // een import met alleen een saldo (geen betalingen) besloeg geen dagen
      const inKnownPeriod = this.db.prepare('SELECT 1 FROM import_batch_accounts WHERE bank_account_id = ? AND batch_id <> ? AND transactions > 0 AND period_from <= ? AND period_to >= ? LIMIT 1');
      // eerdere afschriften van een ander soort rond deze dag (van een oude import is alleen de bron bekend)
      const nearOtherKind = this.db.prepare(
        `SELECT s.period_from AS "from", s.period_to AS "to" FROM import_batch_accounts s JOIN import_batches b ON b.id = s.batch_id
         WHERE s.bank_account_id = ? AND s.batch_id <> ? AND (CASE WHEN b.kind IS NULL THEN b.source <> ? ELSE b.kind <> ? END) AND s.period_from <= ? AND s.period_to >= ?`,
      );
      // kandidaten voor de tegenhanger, met het soort afschrift waar ze uit kwamen
      const candidates = this.db.prepare(
        `SELECT c.id, c.transaction_date AS date, c.counter_iban AS iban, c.counter_name AS name, c.description, c.source, c.bank_id AS bankId, c.import_batch_id AS batch, b.kind, c.batch_ref AS batchRef, c.duplicate_of AS removed
         FROM bank_transactions c LEFT JOIN import_batches b ON b.id = c.import_batch_id
         WHERE c.bank_account_id = ? AND c.amount = ? AND c.id <= ? AND c.transaction_date BETWEEN ? AND ?`,
      );
      // Verzamelboekingen die al als losse deelposten in de boeken staan (compleet: samen het totaal van de
      // boeking), met dit totaal. Een regel met dat bedrag uit een ander soort afschrift is hetzelfde geld.
      const groupsWithTotal = this.db.prepare(
        `SELECT g.batch_ref AS ref, g.transaction_date AS date, MIN(g.id) AS first, group_concat(g.id) AS ids, MIN(g.source) AS source, MIN(g.import_batch_id) AS batch, MIN(b.kind) AS kind
         FROM bank_transactions g LEFT JOIN import_batches b ON b.id = g.import_batch_id
         WHERE g.bank_account_id = ? AND g.batch_total = ? AND g.batch_ref IS NOT NULL AND g.duplicate_of IS NULL AND g.id <= ? AND g.transaction_date BETWEEN ? AND ?
         GROUP BY g.batch_ref, g.transaction_date HAVING SUM(g.amount) = g.batch_total AND COUNT(*) >= 2`,
      );
      // Wie al tegenhanger is van een overgeslagen regel uit dit soort afschrift, blijft dat, ook in latere
      // imports: een nieuwe regel uit hetzelfde soort is dan een andere betaling. Een ander soort afschrift
      // mag dezelfde betaling wel weer als tegenhanger vinden (het is daar dezelfde betaling).
      const occupied = this.db.prepare(
        `SELECT 1 FROM import_skipped k JOIN import_batches b ON b.id = k.batch_id
         WHERE k.matched_transaction_id = ? AND k.added_transaction_id IS NULL AND COALESCE(b.kind, b.source) = ? LIMIT 1`,
      );
      const insertSkipped = this.db.prepare(
        `INSERT INTO import_skipped (batch_id, bank_account_id, transaction_date, amount, counter_iban, counter_name, description, reference, source, bank_id, dedup_hash, matched_transaction_id, batch_ref, batch_total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const seen = new Map<string, number>();
      /** de regels van dit bestand per hash, met bedrag en datum */
      const hashesInFile = new Map<string, { amount: Cents; date: IsoDate }>();
      // Dezelfde id van de bank is alleen dezelfde betaling als ook het bedrag gelijk is en de datum hooguit
      // een paar werkdagen scheelt. Anders hergebruikte de bank de id voor een andere betaling.
      const samePayment = (a: { amount: Cents; date: IsoDate }, b: { amount: Cents; date: IsoDate }) => a.amount === b.amount && workdaysBetween(a.date, b.date) <= SAME_PAYMENT_WORKDAYS;
      /** betalingen die in deze import al terugkwamen (stap 1) of al als tegenhanger dienen (stap 2) */
      const taken = new Set<number>();
      /** de eerdere imports (per rekening) waar de betalingen die er al stonden uit kwamen */
      const knownBatches = new Set<string>();
      const known = (batch: number | null, account: number) => {
        if (batch !== null) knownBatches.add(`${batch}|${account}`);
      };
      /** per eerdere import (en rekening): de betalingen die in dit bestand met dezelfde hash terugkwamen */
      const returned = new Map<string, Set<number>>();
      let imported = 0;
      let duplicates = 0;
      let skipped = 0;
      let addedInKnownPeriod = 0;
      let byBank: BankAccount | undefined;
      const perAccount = new Map<number, { from: string; to: string; transactions: number; imported: number; duplicates: number }>();
      const pending: { t: NormalizedTransaction; account: BankAccount; hash: string; bankId: string | null }[] = [];

      // stap 1 voor alle regels eerst: wat via zijn hash terugkomt, kan daarna geen tegenhanger meer zijn
      for (const t of result.transactions) {
        const account = opts.bankAccountId ? this.getAccount(opts.bankAccountId) : !t.ownIban && result.bank ? (byBank ??= this.accountForBank(result.bank)) : this.accountForIban(t.ownIban);
        const stat = perAccount.get(account.id) ?? { from: t.date, to: t.date, transactions: 0, imported: 0, duplicates: 0 };
        if (t.date < stat.from) stat.from = t.date;
        if (t.date > stat.to) stat.to = t.date;
        stat.transactions++;
        perAccount.set(account.id, stat);
        const key = [account.id, t.date, t.amount, t.counterIban, t.description].join('|');
        const occurrence = (seen.get(key) ?? 0) + 1;
        seen.set(key, occurrence);
        type Known = { id: number; bank_id: string | null; batch_ref: string | null; batch: number | null; account: number; amount: Cents; date: IsoDate };
        type Skipped = { matched: number; batch: number | null; account: number; amount: Cents; date: IsoDate };
        let bankId = t.bankId || null;
        let hash = BankService.hash({ ...t, bankId }, account.iban, occurrence);
        let existing = byHash.get(hash) as Known | undefined;
        let again = existing ? undefined : (skippedByHash.get(hash) as Skipped | undefined);
        // De id van de bank wijst naar een andere betaling (ander bedrag, of dagen later): de bank hergebruikt
        // die id, dus hij zegt hier niets. Deze regel telt dan als een regel zonder id (hash op de inhoud);
        // anders zou hij stil wegvallen als "al bekend".
        const sameId = bankId ? (existing ?? again ?? hashesInFile.get(hash)) : undefined;
        if (sameId && !samePayment(sameId, t)) {
          bankId = null;
          hash = BankService.hash({ ...t, bankId: null }, account.iban, occurrence);
          existing = byHash.get(hash) as Known | undefined;
          again = existing ? undefined : (skippedByHash.get(hash) as Skipped | undefined);
        }
        // Ingelezen toen de rekening nog geen rekeningnummer had: de hash is toen zonder dat nummer gemaakt.
        if (!existing && !again && account.iban) {
          const old = byHash.get(BankService.hash({ ...t, bankId }, null, occurrence)) as Known | undefined;
          if (old && old.account === account.id) existing = old;
        }
        if (existing) {
          taken.add(existing.id);
          known(existing.batch, existing.account);
          if (existing.batch !== null) returned.set(`${existing.batch}|${existing.account}`, (returned.get(`${existing.batch}|${existing.account}`) ?? new Set()).add(existing.id));
          // de hash bewijst dat dit dezelfde id van de bank is: bij een oude regel alsnog vastleggen
          if (bankId && !existing.bank_id) this.db.prepare('UPDATE bank_transactions SET bank_id = ? WHERE id = ? AND bank_id IS NULL').run(bankId, existing.id);
          // net zo: van welke verzamelboeking deze deelpost er een is (stond er nog niet bij een oude regel)
          if (t.batch && bankId && !existing.batch_ref) this.db.prepare('UPDATE bank_transactions SET batch_ref = ?, batch_total = ? WHERE id = ? AND batch_ref IS NULL').run(t.batch.ref, t.batch.total, existing.id);
        } else if (again) {
          // eerder overgeslagen: weer tegen dezelfde tegenhanger
          known(again.batch, again.account);
        }
        if (existing || again || hashesInFile.has(hash)) {
          duplicates++;
          stat.duplicates++;
          continue;
        }
        hashesInFile.set(hash, { amount: t.amount, date: t.date });
        pending.push({ t, account, hash, bankId });
      }

      // Van een import van vóór #184 is het soort afschrift niet vastgelegd. Die is "hetzelfde soort" als
      // alles wat hij had in de dagen van dit bestand met dezelfde hash terugkwam. Dan zou dezelfde betaling
      // ook dezelfde hash hebben: een regel met een andere hash is een andere betaling, en de rest van die
      // import (de dagen ervoor) is geen tegenhanger. Zo blijft twee keer hetzelfde soort afschrift met een
      // dag overlap werken zoals het altijd deed.
      const sameKind = new Set<string>();
      const inWindow = this.db.prepare('SELECT id FROM bank_transactions WHERE import_batch_id = ? AND bank_account_id = ? AND transaction_date BETWEEN ? AND ?');
      for (const [key, ids] of returned) {
        const [b, a] = key.split('|').map(Number) as [number, number];
        const window = perAccount.get(a);
        if (window && (inWindow.all(b, a, window.from, window.to) as { id: number }[]).every((r) => ids.has(r.id))) sameKind.add(key);
      }

      // Valt deze dag in dagen die een eerder afschrift al besloeg (stap 2), of net buiten een eerder afschrift
      // van een ander soort? Daar kan dezelfde betaling een andere datum hebben (kaartbetaling van vrijdag,
      // geboekt op maandag); dan vergelijken we alleen met dat andere soort.
      const scope = (account: BankAccount, date: IsoDate): { overlap: boolean; edge: boolean } => {
        const overlap = Boolean(inKnownPeriod.get(account.id, batchId, date, date));
        const edge = !overlap && (nearOtherKind.all(account.id, batchId, result.source, kind, addDays(date, 7), addDays(date, -7)) as { from: IsoDate; to: IsoDate }[])
          .some((p) => (date > p.to ? workdaysBetween(p.to, date) : workdaysBetween(date, p.from)) <= SAME_PAYMENT_WORKDAYS);
        return { overlap, edge };
      };
      /** Komt een bestaande betaling (of verzamelboeking) uit hetzelfde soort afschrift als dit bestand? */
      const fromSameKind = (c: { source: string; batch: number | null; kind: string | null }, account: BankAccount, overlap: boolean): boolean => {
        if (c.kind === kind || (c.batch !== null && sameKind.has(`${c.batch}|${account.id}`))) return true;
        // CAMT, MT940 en de koppeling hebben geen indelingen: een oude import uit dezelfde bron is hetzelfde soort
        if (c.kind === null && c.source === result.source && result.source !== 'csv') return true;
        return !overlap && c.kind === null && c.source === result.source;
      };
      /** Kan een bestaande betaling (of verzamelboeking) uit een ander soort afschrift de tegenhanger zijn? */
      const otherKind = (c: { id: number; source: string; batch: number | null; kind: string | null }, account: BankAccount, overlap: boolean): boolean =>
        // uit hetzelfde soort afschrift: daar beslist de hash (stap 1), en die was anders
        !fromSameKind(c, account, overlap) && !occupied.get(c.id, kind);
      type Candidate = { id: number; date: IsoDate; iban: string | null; name: string | null; description: string; source: string; bankId: string | null; batch: number | null; kind: string | null; batchRef: string | null; removed: number | null };
      const counterpart = new Map<number, { id: number; batch: number | null }>();
      const overlaps: boolean[] = pending.map(() => false);

      // Een verzamelboeking in dit bestand (CAMT: losse deelposten) waarvan het totaal er al als één regel staat
      // uit een ander soort afschrift: dat is hetzelfde geld. De regel die er staat blijft staan; de deelposten
      // komen er niet naast, wel in import_skipped (samen terug te zetten met "Toch toevoegen").
      const batches = new Map<string, number[]>();
      for (const [row, { t, account }] of pending.entries()) {
        if (t.batch) batches.set(`${account.id}|${t.batch.ref}|${t.date}`, [...(batches.get(`${account.id}|${t.batch.ref}|${t.date}`) ?? []), row]);
      }
      for (const rows of batches.values()) {
        const { t, account, bankId } = pending[rows[0]!]!;
        const total = t.batch!.total;
        // alleen een complete boeking: alle deelposten nieuw, samen precies het totaal
        if (rows.length < 2 || rows.reduce((n, r) => n + pending[r]!.t.amount, 0) !== total) continue;
        const { overlap, edge } = scope(account, t.date);
        if (!overlap && !edge) continue;
        const line = (candidates.all(account.id, total, lastBefore, addDays(t.date, -7), addDays(t.date, 7)) as Candidate[])
          // (een regel die zelf al als dubbel uit de boekhouding is gehaald, staat niet voor dit geld)
          .filter((c) => !taken.has(c.id) && !c.batchRef && !c.removed && otherKind(c, account, overlap) && !(bankId && c.bankId && c.source === result.source))
          .map((c) => ({ ...c, workdays: workdaysBetween(c.date, t.date), days: Math.abs(diffDays(c.date, t.date)) }))
          .filter((c) => c.workdays <= SAME_PAYMENT_WORKDAYS)
          .sort((x, y) => x.workdays - y.workdays || x.days - y.days || x.id - y.id)[0];
        if (!line) continue;
        taken.add(line.id);
        for (const r of rows) counterpart.set(r, { id: line.id, batch: line.batch });
      }

      // stap 2: voor elke regel in dagen die een eerder afschrift al besloeg, de mogelijke tegenhangers
      const pairs: { row: number; id: number; batch: number | null; workdays: number; days: number; otherIban: number; otherParty: number }[] = [];
      for (const [row, { t, account, bankId }] of pending.entries()) {
        if (counterpart.has(row)) continue;
        const { overlap, edge } = scope(account, t.date);
        overlaps[row] = overlap;
        if (!overlap && !edge) continue;
        const iban = t.counterIban ? normalizeIban(t.counterIban) : null;
        const party = { counter_iban: t.counterIban ?? null, counter_name: t.counterName ?? null, description: t.description ?? '' };
        for (const c of candidates.all(account.id, t.amount, lastBefore, addDays(t.date, -7), addDays(t.date, 7)) as Candidate[]) {
          if (taken.has(c.id)) continue;
          const other = { counter_iban: c.iban, counter_name: c.name, description: c.description };
          if (fromSameKind(c, account, overlap)) {
            // Hetzelfde soort afschrift: daar beslist de hash. Alleen als dezelfde regel anders is opgeschreven
            // ("Card Payment: Printhuis" tegenover "Printhuis", #225), op dezelfde dag, is het dezelfde betaling.
            if (c.date !== t.date || c.batchRef || c.removed || !sameTextVariant(other, party) || occupied.get(c.id, kind)) continue;
          } else if (!otherKind(c, account, overlap)) continue;
          // allebei een tegenrekening: dan moet die gelijk zijn
          if (iban && c.iban && normalizeIban(c.iban) !== iban) continue;
          // twee verschillende id's uit dezelfde bron zijn per definitie twee betalingen
          if (bankId && c.bankId && c.source === result.source) continue;
          const workdays = workdaysBetween(c.date, t.date);
          if (workdays > SAME_PAYMENT_WORKDAYS) continue;
          pairs.push({ row, id: c.id, batch: c.batch, workdays, days: Math.abs(diffDays(c.date, t.date)), otherIban: iban && c.iban ? 0 : 1, otherParty: sameCounterparty(other, party) ? 0 : 1 });
        }
      }
      // Eerst wie dezelfde tegenrekening heeft, dan de dichtstbijzijnde datum, over alle regels heen: zo krijgt
      // elke regel zijn eigen tegenhanger en niet die van een andere betaling van hetzelfde bedrag een dag later.
      // Zijn er dan nog meer kandidaten (twee winkels, zelfde bedrag, zelfde dag), dan die met dezelfde tegenpartij.
      pairs.sort((x, y) => x.otherIban - y.otherIban || x.workdays - y.workdays || x.days - y.days || x.otherParty - y.otherParty || x.row - y.row || x.id - y.id);
      for (const p of pairs) {
        if (counterpart.has(p.row) || taken.has(p.id)) continue;
        counterpart.set(p.row, { id: p.id, batch: p.batch });
        taken.add(p.id);
      }

      // Andersom: één regel in dit bestand (CSV, MT940) met het totaal van een verzamelboeking waarvan de
      // deelposten er al compleet staan uit een ander soort afschrift. De deelposten blijven staan; de regel
      // komt er niet naast en staat in import_skipped tegenover de eerste deelpost.
      for (const [row, { t, account }] of pending.entries()) {
        if (counterpart.has(row) || t.batch) continue;
        const { overlap, edge } = scope(account, t.date);
        if (!overlap && !edge) continue;
        const group = (groupsWithTotal.all(account.id, t.amount, lastBefore, addDays(t.date, -7), addDays(t.date, 7)) as { ref: string; date: IsoDate; first: number; ids: string; source: string; batch: number | null; kind: string | null }[])
          .map((g) => ({ ...g, members: g.ids.split(',').map(Number), workdays: workdaysBetween(g.date, t.date), days: Math.abs(diffDays(g.date, t.date)) }))
          .filter((g) => g.workdays <= SAME_PAYMENT_WORKDAYS && g.members.every((id) => !taken.has(id)) && otherKind({ id: g.first, source: g.source, batch: g.batch, kind: g.kind }, account, overlap))
          .sort((x, y) => x.workdays - y.workdays || x.days - y.days || x.first - y.first)[0];
        if (!group) continue;
        for (const id of group.members) taken.add(id);
        counterpart.set(row, { id: group.first, batch: group.batch });
      }
      for (const [row, { t, account, hash, bankId }] of pending.entries()) {
        const stat = perAccount.get(account.id)!;
        const match = counterpart.get(row);
        if (match) {
          // stond er al: niet toevoegen, wel bewaren met de tegenhanger erbij
          insertSkipped.run(batchId, account.id, t.date, t.amount, t.counterIban ?? null, t.counterName ?? null, t.description ?? '', t.reference ?? null, result.source, bankId, hash, match.id, t.batch?.ref ?? null, t.batch?.total ?? null);
          known(match.batch, account.id);
          duplicates++;
          skipped++;
          stat.duplicates++;
          continue;
        }
        // geen tegenhanger (dan miste het eerdere afschrift hem waarschijnlijk), of nieuwe dagen (stap 3)
        const r = insert.run(account.id, t.date, t.amount, t.counterIban ?? null, t.counterName ?? null, t.description ?? '', t.reference ?? null, result.source, batchId, hash, bankId, t.batch?.ref ?? null, t.batch?.total ?? null);
        if (r.changes > 0) {
          imported++;
          stat.imported++;
          if (overlaps[row]) addedInKnownPeriod++;
        } else (duplicates++, stat.duplicates++);
      }
      // eindsaldo volgens het afschrift (het laatste per rekening), om later te controleren of er iets ontbreekt
      const closing = new Map<number, { date: IsoDate; amount: Cents }>();
      for (const b of result.balances ?? []) {
        // de saldocontrole rekent in euro's: een saldo in een andere valuta bewaren we niet
        if (b.currency && b.currency !== 'EUR') continue;
        const account = opts.bankAccountId ? this.getAccount(opts.bankAccountId) : !b.ownIban && result.bank ? (byBank ??= this.accountForBank(result.bank)) : this.accountForIban(b.ownIban);
        const prev = closing.get(account.id);
        if (!prev || b.date >= prev.date) closing.set(account.id, { date: b.date, amount: b.amount });
        // een afschrift zonder betalingen (alleen een saldo) telt ook: dat saldo is juist nuttig
        if (!perAccount.has(account.id)) perAccount.set(account.id, { from: b.date, to: b.date, transactions: 0, imported: 0, duplicates: 0 });
      }
      const insertStat = this.db.prepare(
        'INSERT INTO import_batch_accounts (batch_id, bank_account_id, period_from, period_to, transactions, imported, duplicates, closing_balance, closing_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      for (const [accountId, s] of perAccount) {
        const c = closing.get(accountId);
        insertStat.run(batchId, accountId, s.from, s.to, s.transactions, s.imported, s.duplicates, c?.amount ?? null, c?.date ?? null);
      }
      this.db.prepare('UPDATE import_batches SET imported_count = ?, duplicate_count = ? WHERE id = ?').run(imported, duplicates, batchId);
      const periods = [...perAccount].map(([bankAccountId, s]) => ({ bankAccountId, from: s.from, to: s.to }));
      const period = this.db.prepare('SELECT period_from AS "from", period_to AS "to" FROM import_batch_accounts WHERE batch_id = ? AND bank_account_id = ?');
      const knownFrom = [...knownBatches]
        .map((k) => period.get(...k.split('|').map(Number)) as { from: string; to: string } | undefined)
        .filter((p): p is { from: string; to: string } => !!p)
        .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
      return { batchId, periods, imported, duplicates, skipped, addedInKnownPeriod, knownFrom, warnings: result.warnings };
    });
  }

  /**
   * De regels die bij het inlezen zijn overgeslagen omdat de betaling er al stond, met die betaling
   * ernaast. Per import (na het inlezen) of per rekening (bij een saldo dat niet klopt).
   */
  skippedRows(filter: { batchId?: number; bankAccountId?: number } = {}): SkippedRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.batchId) (where.push('k.batch_id = ?'), params.push(filter.batchId));
    if (filter.bankAccountId) (where.push('k.bank_account_id = ?'), params.push(filter.bankAccountId));
    const rows = this.db
      .prepare(
        `SELECT k.*, a.name AS account_name, t.transaction_date AS e_date, t.amount AS e_amount, t.counter_name AS e_name, t.description AS e_description, t.source AS e_source, b.filename AS e_filename,
                t.batch_ref AS e_batch_ref, t.batch_total AS e_batch_total,
                (SELECT COUNT(*) FROM import_skipped x WHERE x.batch_id = k.batch_id AND x.bank_account_id = k.bank_account_id AND x.batch_ref = k.batch_ref AND x.matched_transaction_id = k.matched_transaction_id) AS k_parts,
                (SELECT COUNT(*) FROM bank_transactions x WHERE x.bank_account_id = t.bank_account_id AND x.batch_ref = t.batch_ref AND x.transaction_date = t.transaction_date AND x.duplicate_of IS NULL) AS e_parts
         FROM import_skipped k
         JOIN bank_accounts a ON a.id = k.bank_account_id
         JOIN bank_transactions t ON t.id = k.matched_transaction_id
         LEFT JOIN import_batches b ON b.id = t.import_batch_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY k.transaction_date DESC, k.id DESC LIMIT 500`,
      )
      .all(...params) as (Record<string, unknown> & { id: number })[];
    return rows.map((r) => ({
      id: r.id,
      batchId: r.batch_id as number,
      bankAccountId: r.bank_account_id as number,
      accountName: r.account_name as string,
      date: r.transaction_date as IsoDate,
      amount: r.amount as Cents,
      counterName: r.counter_name as string | null,
      counterIban: r.counter_iban as string | null,
      description: r.description as string,
      source: r.source as string,
      existing: { id: r.matched_transaction_id as number, date: r.e_date as IsoDate, amount: r.e_amount as Cents, counterName: r.e_name as string | null, description: r.e_description as string, source: r.e_source as string, filename: r.e_filename as string | null },
      added: r.added_transaction_id !== null,
      batch:
        r.batch_ref !== null && r.batch_total === r.e_amount
          ? { kind: 'deelpost' as const, parts: r.k_parts as number, total: r.batch_total as Cents }
          : r.batch_ref === null && r.e_batch_ref !== null && r.e_batch_total === r.amount && r.e_amount !== r.amount
            ? { kind: 'totaal' as const, parts: r.e_parts as number, total: r.amount as Cents }
            : null,
    }));
  }

  /** De betalingen uit deze import die nieuw waren in dagen die een eerder afschrift al besloeg. */
  addedInKnownPeriod(batchId: number): BankTransaction[] {
    return this.db
      .prepare(
        `SELECT t.* FROM bank_transactions t
         WHERE t.import_batch_id = ? AND EXISTS (
           SELECT 1 FROM import_batch_accounts s WHERE s.bank_account_id = t.bank_account_id AND s.batch_id < t.import_batch_id
             AND s.period_from <= t.transaction_date AND s.period_to >= t.transaction_date)
           AND NOT EXISTS (SELECT 1 FROM import_skipped k WHERE k.added_transaction_id = t.id)
         ORDER BY t.transaction_date DESC, t.id DESC`,
      )
      .all(batchId) as BankTransaction[];
  }

  /**
   * "Toch toevoegen": een overgeslagen regel was wel een eigen betaling. Hij komt er alsnog in, met de
   * hash die hij bij het inlezen had (opnieuw inlezen geeft hem dus niet dubbel); de betaling die er al
   * stond is daarna weer vrij als tegenhanger.
   */
  addSkipped(skippedId: number): number {
    type Row = { id: number; batch_id: number; bank_account_id: number; transaction_date: IsoDate; amount: Cents; counter_iban: string | null; counter_name: string | null; description: string; reference: string | null; source: string; bank_id: string | null; dedup_hash: string; added_transaction_id: number | null; matched_transaction_id: number; batch_ref: string | null; batch_total: Cents | null };
    const k = this.db.prepare('SELECT * FROM import_skipped WHERE id = ?').get(skippedId) as Row | undefined;
    if (!k) throw new ValidationError('Deze regel bestaat niet (meer)');
    if (k.added_transaction_id) throw new ValidationError('Deze betaling is al toegevoegd');
    // Deelposten van een verzamelboeking die samen zijn overgeslagen tegen één regel met het totaal: ze komen
    // er ook samen in, anders staat er een deel van het bedrag naast het hele bedrag.
    const whole = k.batch_ref !== null && (this.db.prepare('SELECT amount FROM bank_transactions WHERE id = ?').get(k.matched_transaction_id) as { amount: Cents }).amount === k.batch_total;
    const rows = whole
      ? (this.db
          .prepare('SELECT * FROM import_skipped WHERE batch_id = ? AND bank_account_id = ? AND batch_ref = ? AND matched_transaction_id = ? AND added_transaction_id IS NULL ORDER BY id')
          .all(k.batch_id, k.bank_account_id, k.batch_ref, k.matched_transaction_id) as Row[])
      : [k];
    return tx(this.db, () => {
      let first = 0;
      for (const r of rows) {
        const id = Number(
          this.db
            .prepare(
              `INSERT INTO bank_transactions (bank_account_id, transaction_date, amount, counter_iban, counter_name, description, reference, source, import_batch_id, dedup_hash, bank_id, batch_ref, batch_total)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(r.bank_account_id, r.transaction_date, r.amount, r.counter_iban, r.counter_name, r.description, r.reference, r.source, r.batch_id, r.dedup_hash, r.bank_id, r.batch_ref, r.batch_total).lastInsertRowid,
        );
        if (r.id === k.id) first = id;
        this.db.prepare('UPDATE import_skipped SET added_transaction_id = ? WHERE id = ?').run(id, r.id);
        // de tellingen van die import kloppen daarna weer met wat er in staat
        this.db.prepare('UPDATE import_batches SET imported_count = imported_count + 1, duplicate_count = duplicate_count - 1 WHERE id = ?').run(r.batch_id);
        this.db.prepare('UPDATE import_batch_accounts SET imported = imported + 1, duplicates = duplicates - 1 WHERE batch_id = ? AND bank_account_id = ?').run(r.batch_id, r.bank_account_id);
      }
      return first;
    });
  }

  // ---------- verzamelbetaling die er twee keer in staat ----------

  /**
   * Verzamelbetalingen die er twee keer in staan: als één regel met het totaal (CSV, MT940) én als losse
   * deelposten (CAMT), op dezelfde rekening en hooguit een paar werkdagen uit elkaar. Bij het inlezen
   * voorkomt de app dit waar het zeker is; dit vindt wat er toch in kwam, ook uit eerdere versies.
   * Wat de gebruiker "twee verschillende betalingen" noemde, komt niet terug.
   */
  batchDoubles(bankAccountId?: number): BatchDouble[] {
    const groups = this.db
      .prepare(
        `SELECT g.bank_account_id AS account, a.name AS accountName, g.batch_ref AS ref, g.batch_total AS total, g.transaction_date AS date, MIN(g.id) AS first, MIN(g.source) AS source
         FROM bank_transactions g JOIN bank_accounts a ON a.id = g.bank_account_id
         WHERE g.batch_ref IS NOT NULL AND g.duplicate_of IS NULL ${bankAccountId ? 'AND g.bank_account_id = ?' : ''}
         GROUP BY g.bank_account_id, g.batch_ref, g.transaction_date HAVING SUM(g.amount) = g.batch_total AND COUNT(*) >= 2
         ORDER BY g.transaction_date DESC, first DESC`,
      )
      .all(...(bankAccountId ? [bankAccountId] : [])) as { account: number; accountName: string; ref: string; total: Cents; date: IsoDate; first: number; source: string }[];
    const side = `t.id, t.transaction_date AS date, t.amount, t.counter_name AS counterName, t.description, t.status, b.filename`;
    const lines = this.db.prepare(
      `SELECT ${side}, t.source FROM bank_transactions t LEFT JOIN import_batches b ON b.id = t.import_batch_id
       WHERE t.bank_account_id = ? AND t.amount = ? AND t.batch_ref IS NULL AND t.duplicate_of IS NULL AND t.source <> ? AND t.transaction_date BETWEEN ? AND ?`,
    );
    const parts = this.db.prepare(
      `SELECT ${side} FROM bank_transactions t LEFT JOIN import_batches b ON b.id = t.import_batch_id
       WHERE t.bank_account_id = ? AND t.batch_ref = ? AND t.transaction_date = ? AND t.duplicate_of IS NULL ORDER BY t.id`,
    );
    const dismissed = this.db.prepare(`SELECT 1 FROM task_skips WHERE task_key = ?`);
    const used = new Set<number>();
    const doubles: BatchDouble[] = [];
    for (const g of groups) {
      const line = (lines.all(g.account, g.total, g.source, addDays(g.date, -10), addDays(g.date, 10)) as (DoubleSide & { source: string })[])
        .filter((l) => !used.has(l.id) && !dismissed.get(BankService.doubleKey(l.id, g.first)))
        .map((l) => ({ ...l, workdays: workdaysBetween(l.date, g.date), days: Math.abs(diffDays(l.date, g.date)) }))
        .filter((l) => l.workdays <= BATCH_WARN_WORKDAYS)
        .sort((x, y) => x.workdays - y.workdays || x.days - y.days || x.id - y.id)[0];
      if (!line) continue;
      used.add(line.id);
      const members = parts.all(g.account, g.ref, g.date) as DoubleSide[];
      doubles.push({
        lineId: line.id,
        firstPartId: g.first,
        bankAccountId: g.account,
        accountName: g.accountName,
        total: g.total,
        line: { id: line.id, date: line.date, amount: line.amount, counterName: line.counterName, description: line.description, status: line.status, filename: line.filename },
        parts: members,
        canRemoveLine: line.status !== 'gematcht',
        canRemoveParts: members.every((m) => m.status !== 'gematcht'),
      });
    }
    return doubles;
  }

  private static doubleKey(lineId: number, firstPartId: number): string {
    return `bank-double-${lineId}-${firstPartId}`;
  }

  private findDouble(lineId: number, firstPartId: number): BatchDouble {
    const d = this.batchDoubles().find((x) => x.lineId === lineId && x.firstPartId === firstPartId);
    if (!d) throw new ValidationError('Dit staat er niet (meer) dubbel in');
    return d;
  }

  /**
   * Eén kant van een dubbel bedrag uit de boekhouding halen: 'regel' = de ene regel met het totaal,
   * 'deelposten' = de losse deelposten. De betalingen blijven bestaan (status 'genegeerd', met de betaling
   * die blijft erbij), tellen niet meer mee in het saldo en zijn terug te zetten. Wat al verwerkt is, haalt
   * de app er niet uit: eerst die verwerking ongedaan maken, of de andere kant kiezen.
   */
  resolveDouble(lineId: number, firstPartId: number, remove: 'regel' | 'deelposten'): void {
    const d = this.findDouble(lineId, firstPartId);
    if (remove !== 'regel' && remove !== 'deelposten') throw new ValidationError('Kies welke kant eruit gaat');
    if (remove === 'regel' && !d.canRemoveLine) throw new ValidationError('De ene regel is al verwerkt. Maak die verwerking eerst ongedaan (open de betaling en kies "Ongedaan maken"), of haal de deelposten eruit.');
    if (remove === 'deelposten' && !d.canRemoveParts) throw new ValidationError('Een of meer deelposten zijn al verwerkt. Maak die verwerking eerst ongedaan (open de betaling en kies "Ongedaan maken"), of haal de ene regel eruit.');
    const out = remove === 'regel' ? [d.line.id] : d.parts.map((p) => p.id);
    const kept = remove === 'regel' ? d.firstPartId : d.line.id;
    tx(this.db, () => {
      for (const id of out) {
        const r = this.db.prepare(`UPDATE bank_transactions SET status = 'genegeerd', duplicate_of = ? WHERE id = ? AND status <> 'gematcht'`).run(kept, id);
        if (r.changes !== 1) throw new ValidationError('Deze betaling is intussen verwerkt. Bekijk het opnieuw.');
      }
    });
  }

  /** "Het zijn twee verschillende betalingen": de melding voor dit paar komt niet meer terug. */
  dismissDouble(lineId: number, firstPartId: number): void {
    this.findDouble(lineId, firstPartId);
    this.db.prepare(`INSERT INTO task_skips (task_key, fingerprint, reason) VALUES (?, 'x', 'twee betalingen') ON CONFLICT(task_key) DO NOTHING`).run(BankService.doubleKey(lineId, firstPartId));
  }

  // ---------- dezelfde betaling in twee losse regels ----------

  private static sameKey(a: number, b: number): string {
    return `bank-same-${Math.min(a, b)}-${Math.max(a, b)}`;
  }

  /** Onthoudt dat een regel al genegeerd was toen hij als dubbel werd gekoppeld: bij terugzetten is hij dat weer. */
  private static ignoredKey(txId: number): string {
    return `bank-same-genegeerd-${txId}`;
  }

  /**
   * Twee losse regels die dezelfde betaling lijken (#225): dezelfde rekening, hetzelfde bedrag en bijna
   * dezelfde tegenpartij, uit verschillende imports. Op dezelfde dag, of uit twee soorten afschrift met hooguit
   * een paar werkdagen ertussen (het ene heeft de dag van de betaling, het andere de boekdatum). Bij het
   * inlezen voorkomt de app dit waar het zeker is; dit vindt wat er toch in kwam, ook uit eerdere versies en
   * ook als beide al verwerkt zijn. Geen dubbel:
   * - twee regels uit dezelfde bron met elk een eigen id van de bank, of met letterlijk dezelfde tekst uit
   *   hetzelfde soort afschrift (daar besliste de hash: twee keer koffie op één dag);
   * - twee regels uit hetzelfde soort afschrift op verschillende dagen;
   * - een regel waarvan de tegenhanger uit die andere import al is overgeslagen, of die de gebruiker met
   *   "Toch toevoegen" naast de andere zette;
   * - wat de gebruiker "twee verschillende betalingen" noemde of terugzette.
   * Met `only` alleen de regels met dat bedrag op die rekening (voor de vraag over één betaling).
   */
  paymentDoubles(bankAccountId?: number, only?: { amount: Cents }): PaymentDouble[] {
    type Row = DoubleSide & { account: number; counter_iban: string | null; counter_name: string | null; source: string; bankId: string | null; batch: number | null; kind: string | null; accountName: string };
    const scope = `t.duplicate_of IS NULL AND t.batch_ref IS NULL ${bankAccountId ? 'AND t.bank_account_id = @account' : ''} ${only ? 'AND t.amount = @amount' : ''}`;
    // alleen bedragen die op één rekening uit meer dan één import komen
    const rows = this.db
      .prepare(
        `SELECT t.id, t.transaction_date AS date, t.amount, t.counter_name AS counterName, t.description, t.status, b.filename, t.bank_account_id AS account,
                t.counter_iban, t.counter_name, t.source, t.bank_id AS bankId, t.import_batch_id AS batch, b.kind, a.name AS accountName
         FROM bank_transactions t JOIN bank_accounts a ON a.id = t.bank_account_id LEFT JOIN import_batches b ON b.id = t.import_batch_id
         WHERE ${scope} AND (t.bank_account_id, t.amount) IN (
           SELECT t.bank_account_id, t.amount FROM bank_transactions t WHERE ${scope}
           GROUP BY t.bank_account_id, t.amount HAVING COUNT(DISTINCT t.import_batch_id) >= 2)
         ORDER BY t.bank_account_id, t.amount, t.transaction_date, t.id`,
      )
      .all({ ...(bankAccountId ? { account: bankAccountId } : {}), ...(only ? { amount: only.amount } : {}) }) as Row[];
    if (rows.length === 0) return [];
    const dismissed = this.db.prepare(`SELECT 1 FROM task_skips WHERE task_key = ?`);
    // de tegenhanger uit de import van de ander is al overgeslagen, of de gebruiker voegde hem bewust toe
    const settled = this.db.prepare(`SELECT 1 FROM import_skipped k WHERE k.matched_transaction_id = ? AND (k.added_transaction_id = ? OR (k.added_transaction_id IS NULL AND k.batch_id = ?)) LIMIT 1`);
    const looksSame = (a: Row, b: Row): boolean => {
      if (a.batch === null || b.batch === null || a.batch === b.batch) return false;
      const sameSource = a.source === b.source;
      if (sameSource && a.bankId && b.bankId) return false;
      // hetzelfde soort afschrift (of een oude import waarvan het soort niet is vastgelegd): alleen op dezelfde
      // dag, en alleen anders opgeschreven
      const sameKind = sameSource && (a.kind === b.kind || a.kind === null || b.kind === null);
      if (a.date !== b.date && (sameKind || workdaysBetween(a.date, b.date) > SAME_PAYMENT_WORKDAYS)) return false;
      if (!(sameKind ? sameTextVariant(a, b) : sameCounterparty(a, b))) return false;
      return !settled.get(a.id, b.id, b.batch) && !settled.get(b.id, a.id, a.batch);
    };
    const side = (r: Row): DoubleSide => ({ id: r.id, date: r.date, amount: r.amount, counterName: r.counterName, description: r.description, status: r.status, filename: r.filename });
    // alle paren die dezelfde betaling lijken; daarna krijgt elke regel hooguit één tegenhanger: eerst dezelfde
    // dag, dan de dichtstbijzijnde datum, en bij gelijke stand de regel die er het eerst stond
    const pairs: { a: Row; b: Row; workdays: number; days: number }[] = [];
    for (const [i, x] of rows.entries()) {
      for (let j = i + 1; j < rows.length; j++) {
        const y = rows[j]!;
        if (y.account !== x.account || y.amount !== x.amount || diffDays(x.date, y.date) > 7) break;
        const [a, b] = x.id < y.id ? [x, y] : [y, x];
        if (looksSame(a, b) && !dismissed.get(BankService.sameKey(a.id, b.id))) pairs.push({ a, b, workdays: workdaysBetween(a.date, b.date), days: Math.abs(diffDays(a.date, b.date)) });
      }
    }
    pairs.sort((x, y) => x.workdays - y.workdays || x.days - y.days || x.a.id - y.a.id || x.b.id - y.b.id);
    const used = new Set<number>();
    const doubles: PaymentDouble[] = [];
    for (const { a, b } of pairs) {
      if (used.has(a.id) || used.has(b.id)) continue;
      used.add(a.id).add(b.id);
      doubles.push({ firstId: a.id, secondId: b.id, bankAccountId: a.account, accountName: a.accountName, amount: a.amount, first: side(a), second: side(b) });
    }
    // de nieuwste bovenaan
    return doubles.sort((x, y) => y.first.date.localeCompare(x.first.date) || y.firstId - x.firstId);
  }

  /**
   * De regels die de app niet vanzelf verwerkt omdat ze waarschijnlijk dezelfde betaling zijn als een regel
   * die er al staat: van zo'n paar de regel die nog niet verwerkt is (zijn beide nog open, dan de tweede).
   * Zo komt dezelfde betaling niet twee keer vanzelf in de boeken; de gebruiker beslist bij de melding.
   */
  heldAsDouble(doubles: PaymentDouble[] = this.paymentDoubles()): Set<number> {
    const held = new Set<number>();
    for (const d of doubles) {
      if (d.second.status === 'nieuw') held.add(d.secondId);
      else if (d.first.status === 'nieuw') held.add(d.firstId);
    }
    return held;
  }

  /**
   * Eerst de vraag "dezelfde betaling?" (#225): een regel die als waarschijnlijke dubbel wordt vastgehouden,
   * deelt de gebruiker pas in na zijn antwoord bij de melding. Anders staat de betaling er zo twee keer in.
   * Voor wat de gebruiker zelf doet (Vandaag, het bankscherm); de app zelf slaat zo'n regel over.
   */
  assertNotHeld(t: BankTransaction): void {
    if (t.status !== 'nieuw' || t.duplicate_of || t.batch_ref) return;
    const double = this.paymentDoubles(t.bank_account_id, { amount: t.amount }).find((d) => this.heldAsDouble([d]).has(t.id));
    if (!double) return;
    const other = double.firstId === t.id ? double.second : double.first;
    throw new ValidationError(
      `Deze regel staat er waarschijnlijk twee keer in: op ${formatDateNl(other.date)} staat dezelfde betaling${other.status === 'gematcht' ? ', en die is al verwerkt' : ''}. Kies eerst bij de melding op het bankscherm of het dezelfde betaling is; anders telt hij dubbel.`,
    );
  }

  private findPaymentDouble(a: number, b: number): PaymentDouble {
    const d = this.paymentDoubles().find((x) => x.firstId === Math.min(a, b) && x.secondId === Math.max(a, b));
    if (!d) throw new ValidationError('Dit staat er niet (meer) dubbel in');
    return d;
  }

  /**
   * "Dit is dezelfde betaling": `removeId` gaat uit de boekhouding, `keepId` blijft. Wat al verwerkt is, haalt
   * de app er niet uit: eerst die verwerking ongedaan maken, of de andere regel kiezen.
   */
  resolvePaymentDouble(keepId: number, removeId: number): void {
    this.findPaymentDouble(keepId, removeId);
    this.markDuplicate(removeId, keepId);
  }

  /** "Het zijn twee verschillende betalingen": de melding voor dit paar komt niet meer terug. */
  dismissPaymentDouble(a: number, b: number): void {
    this.findPaymentDouble(a, b);
    this.db.prepare(`INSERT INTO task_skips (task_key, fingerprint, reason) VALUES (?, 'x', 'twee betalingen') ON CONFLICT(task_key) DO NOTHING`).run(BankService.sameKey(a, b));
  }

  /**
   * De betalingen waar deze regel een dubbel van kan zijn: dezelfde rekening en hetzelfde bedrag, hooguit een
   * paar werkdagen ertussen (het ene soort afschrift heeft de dag van de betaling, het andere de boekdatum).
   * De dichtstbijzijnde eerst. Voor de vraag bij "Negeren": is dit dezelfde betaling als deze?
   */
  duplicateCandidates(txId: number): BankTransaction[] {
    const t = this.get(txId);
    return (this.db
      .prepare('SELECT * FROM bank_transactions WHERE bank_account_id = ? AND amount = ? AND id <> ? AND duplicate_of IS NULL AND transaction_date BETWEEN ? AND ?')
      .all(t.bank_account_id, t.amount, t.id, addDays(t.transaction_date, -7), addDays(t.transaction_date, 7)) as BankTransaction[])
      .map((c) => ({ c, workdays: workdaysBetween(c.transaction_date, t.transaction_date), days: Math.abs(diffDays(c.transaction_date, t.transaction_date)) }))
      .filter((x) => x.workdays <= SAME_PAYMENT_WORKDAYS)
      .sort((x, y) => x.workdays - y.workdays || x.days - y.days || x.c.id - y.c.id)
      .map((x) => x.c);
  }

  /**
   * Een regel als dubbel aan de betaling koppelen die blijft (#225): hij gaat uit de boekhouding (status
   * 'genegeerd'), telt niet meer mee in het saldo en is terug te zetten. Ook voor een regel die al genegeerd
   * was. Alleen bij dezelfde rekening en hetzelfde bedrag, hooguit een paar werkdagen ertussen; een regel die
   * al verwerkt is, haalt de app er niet uit.
   * Was de regel die blijft zelf genegeerd (zonder koppeling), dan komt die terug als nog te verwerken: anders
   * staat de betaling nergens meer in de boekhouding en vraagt niemand er nog naar.
   */
  markDuplicate(txId: number, keptId: number): void {
    const t = this.get(txId);
    if (txId === keptId) throw new ValidationError('Een betaling kan geen dubbel van zichzelf zijn. Kies de andere regel.');
    if (t.duplicate_of) throw new ValidationError('Deze regel is al als dubbel uit je boekhouding gehaald');
    if (!this.duplicateCandidates(txId).some((c) => c.id === keptId)) {
      throw new ValidationError('Dat is niet dezelfde betaling: een dubbele regel staat op dezelfde rekening, met hetzelfde bedrag en hooguit een paar werkdagen ertussen.');
    }
    if (t.status === 'gematcht') throw new ValidationError('Deze betaling is al verwerkt. Maak die verwerking eerst ongedaan (open de betaling en kies "Ongedaan maken"), of haal de andere regel eruit.');
    tx(this.db, () => {
      const r = this.db.prepare(`UPDATE bank_transactions SET status = 'genegeerd', duplicate_of = ? WHERE id = ? AND status <> 'gematcht'`).run(keptId, txId);
      if (r.changes !== 1) throw new ValidationError('Deze betaling is intussen verwerkt. Bekijk het opnieuw.');
      // was hij al genegeerd, dan is hij dat na terugzetten weer
      if (t.status === 'genegeerd') this.db.prepare(`INSERT INTO task_skips (task_key, fingerprint, reason) VALUES (?, 'x', 'was genegeerd') ON CONFLICT(task_key) DO NOTHING`).run(BankService.ignoredKey(txId));
      this.db.prepare(`UPDATE bank_transactions SET status = 'nieuw' WHERE id = ? AND status = 'genegeerd' AND duplicate_of IS NULL`).run(keptId);
    });
  }

  /** Wat uit de boekhouding is gehaald omdat het bedrag er dubbel in stond, met de betaling die bleef. */
  removedDuplicates(bankAccountId?: number): RemovedDuplicate[] {
    return (this.db
      .prepare(
        `SELECT t.id, t.transaction_date AS date, t.amount, t.counter_name AS counterName, t.description, t.status, b.filename, t.bank_account_id AS bankAccountId, a.name AS accountName,
                k.id AS k_id, k.transaction_date AS k_date, k.counter_name AS k_name, k.description AS k_description
         FROM bank_transactions t JOIN bank_accounts a ON a.id = t.bank_account_id JOIN bank_transactions k ON k.id = t.duplicate_of
         LEFT JOIN import_batches b ON b.id = t.import_batch_id
         WHERE t.duplicate_of IS NOT NULL ${bankAccountId ? 'AND t.bank_account_id = ?' : ''} ORDER BY t.transaction_date DESC, t.id DESC LIMIT 500`,
      )
      .all(...(bankAccountId ? [bankAccountId] : [])) as (Omit<RemovedDuplicate, 'kept'> & { k_id: number; k_date: IsoDate; k_name: string | null; k_description: string })[])
      .map(({ k_id, k_date, k_name, k_description, ...t }) => ({ ...t, kept: { id: k_id, date: k_date, counterName: k_name, description: k_description } }));
  }

  /**
   * Terugzetten wat als dubbel uit de boekhouding was gehaald: het waren toch twee betalingen. Alles wat
   * tegelijk voor dezelfde betaling is weggehaald (alle deelposten) komt samen terug, als nog te verwerken.
   * Een losse regel die al genegeerd was voordat hij als dubbel werd gekoppeld, is daarna weer genegeerd:
   * dat had de gebruiker zelf gekozen, dus de app verwerkt hem niet alsnog vanzelf.
   */
  restoreDuplicate(txId: number): void {
    const t = this.get(txId);
    if (!t.duplicate_of) throw new ValidationError('Deze betaling is niet als dubbel uit je boekhouding gehaald');
    tx(this.db, () => {
      // één losse regel tegenover één losse regel (#225): alleen deze komt terug, en de app meldt dit paar niet opnieuw
      if (!t.batch_ref && !this.get(t.duplicate_of!).batch_ref) {
        const ignored = this.db.prepare(`DELETE FROM task_skips WHERE task_key = ?`).run(BankService.ignoredKey(t.id)).changes > 0;
        this.db.prepare(`UPDATE bank_transactions SET status = ?, duplicate_of = NULL WHERE id = ?`).run(ignored ? 'genegeerd' : 'nieuw', t.id);
        this.db.prepare(`INSERT INTO task_skips (task_key, fingerprint, reason) VALUES (?, 'x', 'teruggezet') ON CONFLICT(task_key) DO NOTHING`).run(BankService.sameKey(t.id, t.duplicate_of!));
        return;
      }
      // de melding hoort bij de regel en de eerste deelpost: zoek welke van de twee kanten dit was
      const siblings = this.db.prepare('SELECT id, batch_ref FROM bank_transactions WHERE duplicate_of = ? ORDER BY id').all(t.duplicate_of) as { id: number; batch_ref: string | null }[];
      this.db.prepare(`UPDATE bank_transactions SET status = 'nieuw', duplicate_of = NULL WHERE duplicate_of = ?`).run(t.duplicate_of);
      // een losse regel die al genegeerd was toen hij hieraan werd gekoppeld, is dat weer
      for (const sib of siblings) {
        if (this.db.prepare(`DELETE FROM task_skips WHERE task_key = ?`).run(BankService.ignoredKey(sib.id)).changes > 0) this.db.prepare(`UPDATE bank_transactions SET status = 'genegeerd' WHERE id = ?`).run(sib.id);
      }
      const [lineId, firstPartId] = siblings[0]!.batch_ref ? [t.duplicate_of!, siblings[0]!.id] : [siblings[0]!.id, t.duplicate_of!];
      this.db.prepare(`INSERT INTO task_skips (task_key, fingerprint, reason) VALUES (?, 'x', 'teruggezet') ON CONFLICT(task_key) DO NOTHING`).run(BankService.doubleKey(lineId, firstPartId));
    });
  }

  /**
   * Klopt het saldo? Het laatste eindsaldo uit een afschrift tegenover het beginsaldo plus alle
   * betalingen vanaf de datum van het beginsaldo t/m de saldodatum, met elke status (ook een
   * overgeslagen privébetaling ging van de rekening af). Niet `statementBalance`: die telt alles, zonder
   * datumgrens. Zonder beginsaldo of zonder eindsaldo valt er niets te vergelijken (null).
   * `zeroOpeningDate`: de rekening begon op die dag bevestigd met € 0 (dan staat er geen beginsaldo geboekt).
   */
  balanceCheck(bankAccountId: number, zeroOpeningDate: IsoDate | null = null): BalanceCheck | null {
    const booked = this.openingBalance(bankAccountId);
    const opening = booked.date ? { amount: booked.amount, date: booked.date } : zeroOpeningDate ? { amount: 0, date: zeroOpeningDate } : null;
    if (!opening) return null;
    const closing = this.db
      .prepare('SELECT closing_balance AS amount, closing_date AS date, batch_id AS batch FROM import_batch_accounts WHERE bank_account_id = ? AND closing_balance IS NOT NULL AND closing_date >= ? ORDER BY closing_date DESC, batch_id DESC LIMIT 1')
      .get(bankAccountId, opening.date) as { amount: Cents; date: IsoDate; batch: number } | undefined;
    if (!closing) return null;
    // Het saldo hoort bij de datums van dát afschrift. Stond een betaling er al uit een ander soort afschrift
    // (met een dag verschil), dan telt de datum die het afschrift met het saldo eraan gaf: van de regel die
    // bij het inlezen is overgeslagen, of van de regel uit dat afschrift die als dubbel aan haar is gekoppeld (#225).
    const sum = (this.db
      .prepare(
        // (een betaling kan tegenover meer overgeslagen regels staan, bv. alle deelposten van een verzamelboeking:
        // hij telt één keer. Wat als dubbel uit de boekhouding is gehaald, telt niet.)
        `SELECT COALESCE(SUM(amount), 0) AS s FROM (
           SELECT t.amount, COALESCE(
             (SELECT MIN(k.transaction_date) FROM import_skipped k WHERE k.matched_transaction_id = t.id AND k.batch_id = ? AND k.added_transaction_id IS NULL),
             (SELECT MIN(d.transaction_date) FROM bank_transactions d WHERE d.duplicate_of = t.id AND d.import_batch_id = ?),
             t.transaction_date) AS date
           FROM bank_transactions t WHERE t.bank_account_id = ? AND t.duplicate_of IS NULL)
         WHERE date >= ? AND date <= ?`,
      )
      .get(closing.batch, closing.batch, bankAccountId, opening.date, closing.date) as { s: number }).s;
    const app = opening.amount + sum;
    const difference = closing.amount - app;
    // Kandidaat: een overgeslagen regel van precies het verschil, waarvan de betaling die er al stond wél is
    // meegeteld. (Is die niet meegeteld, dan verklaart een datumverschil het en zou toevoegen hem dubbel maken.)
    const candidate = difference === 0 ? undefined : (this.db
      .prepare(
        `SELECT k.id AS skippedId, k.transaction_date AS date, k.amount, k.counter_name AS counterName, k.description FROM import_skipped k
         JOIN bank_transactions t ON t.id = k.matched_transaction_id
         WHERE k.bank_account_id = ? AND k.added_transaction_id IS NULL AND k.amount = ? AND k.transaction_date >= ? AND k.transaction_date <= ?
           AND t.transaction_date >= ? AND t.transaction_date <= ?
         ORDER BY k.transaction_date DESC, k.id DESC LIMIT 1`,
      )
      .get(bankAccountId, difference, opening.date, closing.date, opening.date, closing.date) as BalanceCheck['candidate'] | undefined);
    return { bankAccountId, date: closing.date, bank: closing.amount, app, difference, candidate: candidate ?? null };
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
      // per afschrift: de laatste dag ervan, maar hooguit de dag vóór het inlezen; een betaling zonder afschrift
      // (met de hand toegevoegd) telt vanaf de dag nadat hij erin kwam
      const complete = this.db
        .prepare(
          `SELECT MAX(d) AS d FROM (
             SELECT MIN(s.period_to, date(b.imported_at, 'localtime', '-1 day')) AS d
               FROM import_batch_accounts s JOIN import_batches b ON b.id = s.batch_id WHERE s.bank_account_id = @id
             UNION ALL
             SELECT MIN(transaction_date, date(created_at, 'localtime', '-1 day')) FROM bank_transactions WHERE bank_account_id = @id AND import_batch_id IS NULL)`,
        )
        .get({ id: a.id }) as { d: string | null };
      return {
        bankAccountId: a.id,
        name: a.name,
        iban: a.iban,
        lastImport: last
          ? { at: last.imported_at, filename: last.filename, source: last.source, from: last.period_from, to: last.period_to, transactions: last.transactions, imported: last.imported, duplicates: last.duplicates }
          : null,
        coverageFrom: coverage.f,
        coverageTo: coverage.t,
        completeTo: complete.d,
        totalTransactions: coverage.n,
        skipped:
          (this.db.prepare('SELECT COUNT(*) AS n FROM import_skipped WHERE bank_account_id = ? AND added_transaction_id IS NULL').get(a.id) as { n: number }).n +
          (this.db.prepare('SELECT COUNT(*) AS n FROM bank_transactions WHERE bank_account_id = ? AND duplicate_of IS NOT NULL').get(a.id) as { n: number }).n,
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

  /**
   * Alles wat je nodig hebt om een betaling te beoordelen: de regel zoals de bank hem gaf, en eerdere
   * betalingen aan of van dezelfde partij met hoe die verwerkt zijn.
   */
  details(txId: number): {
    transaction: BankTransaction;
    account: { name: string; iban: string | null };
    history: { id: number; date: IsoDate; amount: Cents; description: string; how: string }[];
  } {
    const t = this.get(txId);
    const account = this.getAccount(t.bank_account_id);
    const same = t.counter_iban
      ? { sql: 'counter_iban = ?', value: t.counter_iban }
      : t.counter_name
        ? { sql: 'counter_iban IS NULL AND lower(counter_name) = lower(?)', value: t.counter_name }
        : null;
    const rows = same
      ? (this.db.prepare(`SELECT * FROM bank_transactions WHERE ${same.sql} AND id <> ? ORDER BY transaction_date DESC, id DESC LIMIT 8`).all(same.value, t.id) as BankTransaction[])
      : [];
    const bookedTo = this.db.prepare(
      `SELECT DISTINCT a.name FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id
       WHERE l.journal_entry_id = ? AND l.account_id NOT IN (SELECT account_id FROM bank_accounts) AND a.category <> 'btw'`,
    );
    const how = (h: BankTransaction): string => {
      if (h.status === 'nieuw') return 'nog niet verwerkt';
      if (h.status === 'genegeerd') return 'overgeslagen';
      if (h.matched_invoice_id) return 'betaling van een factuur';
      if (h.matched_purchase_invoice_id) return 'betaling van een aankoop';
      if (!h.matched_journal_entry_id) return 'verwerkt';
      const names = (bookedTo.all(h.matched_journal_entry_id) as { name: string }[]).map((r) => r.name);
      return names.length > 0 ? names.join(', ') : 'verwerkt';
    };
    return {
      transaction: t,
      account: { name: account.name, iban: account.iban },
      history: rows.map((h) => ({ id: h.id, date: h.transaction_date, amount: h.amount, description: h.description, how: how(h) })),
    };
  }

  private assertOpen(t: BankTransaction): void {
    if (t.status === 'gematcht') throw new ValidationError('Deze betaling is al verwerkt');
    if (t.duplicate_of) throw new ValidationError('Deze regel is uit je boekhouding gehaald omdat het bedrag er dubbel in stond. Zet hem eerst terug: open hem en kies "Ongedaan maken".');
  }

  // ---------- verwerken ----------

  matchInvoice(txId: number, invoiceId: number): void {
    const t = this.get(txId);
    this.assertOpen(t);
    const invoice = this.invoices.get(invoiceId);
    if (t.amount < 0 && (!invoice.credit_of_invoice_id || invoice.open_amount >= 0)) {
      throw new ValidationError('Deze betaling kan alleen aan een open creditfactuur worden gekoppeld');
    }
    // Een positieve tweede betaling op een gewone factuur is toegestaan: v0.4 signaleert die
    // bewust als te veel betaald en begeleidt daarna de terugbetaling aan de klant.
    if (t.amount > 0 && invoice.credit_of_invoice_id) throw new ValidationError('Deze ontvangst kan niet aan een creditfactuur worden gekoppeld');
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
    // andere munt (#74): de bank rekende een eigen koers; een klein verschil is een koersverschil
    const p = this.purchases.get(purchaseId);
    const settleFx = Boolean(p.currency && p.currency !== 'EUR' && -t.amount !== p.open_amount && withinFx(-t.amount, p.open_amount));
    // nooit meer betalen dan er open staat (#221): een aankoop die intussen betaald is, krijgt er geen tweede
    // betaling bij; dat zou een vordering op de leverancier geven die er niet is. Het bedrag zelf bewaakt
    // `registerPayment` (#227), voor elke betaling
    if (p.status !== 'open' || p.open_amount === 0) throw new ValidationError(p.total < 0 ? 'Deze creditnota is al afgehandeld' : 'Deze aankoop staat al op betaald');
    this.purchases.registerPayment(purchaseId, { amount: -t.amount, date: t.transaction_date, moneyAccount: account.rgs_code, bankTransactionId: txId, settleFx });
  }

  /**
   * Welke btw meestal hoort bij geld dat binnenkomt zonder factuur in de app (bv. via Mollie of een
   * webshop). Eerst de klant (op IBAN of naam), anders het land van de IBAN. Alleen een voorstel.
   */
  salesVatSuggestion(txId: number): { vatCode: SalesVatCode; relationId: number | null; reason: string } {
    const t = this.get(txId);
    const iban = t.counter_iban ? this.relations.findByIban(t.counter_iban) : undefined;
    const byIban = iban && iban.type !== 'leverancier' ? iban : undefined;
    // op naam: de klantnaam als hele woorden in de naam van de betaler; de langste wint, bij gelijkspel geen voorstel
    const name = ` ${(t.counter_name ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
    const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const hits = byIban ? [] : this.relations
      .list({ type: 'klant' })
      .filter((r) => words(r.name).length >= 4 && name.includes(` ${words(r.name)} `))
      .sort((a, b) => words(b.name).length - words(a.name).length);
    const byName = byIban ?? (hits.length > 0 && (hits.length === 1 || words(hits[0]!.name).length > words(hits[1]!.name).length) ? hits[0] : undefined);
    if (byName) {
      // een btw-nummer dat niet bij het land past, telt niet als bedrijf in de EU
      const vatNumber = vatNumberMatchesCountry(byName.vat_number, byName.country) ? byName.vat_number : null;
      const code = suggestedSalesVat(customerVatSituation(byName.country, vatNumber));
      if (code) return { vatCode: code, relationId: byName.id, reason: `${byName.name} zit in het buitenland (${byName.country})` };
      return { vatCode: 'hoog', relationId: byName.id, reason: `${byName.name} is een klant in Nederland` };
    }
    const land = countryCode(t.counter_iban?.slice(0, 2));
    if (land && land !== 'NL' && !EU_COUNTRIES.has(land)) return { vatCode: suggestedSalesVat('buiten-eu')!, relationId: null, reason: `het geld komt van een rekening buiten de EU (${land})` };
    return { vatCode: 'hoog', relationId: null, reason: '' };
  }

  /**
   * "Verkoop via een ander systeem": geld van een klant zonder factuur uit deze app (Mollie,
   * webshop, kassa, pin, contant). De omschrijving noemt het systeem en het nummer, zodat de
   * boekhouder de factuur of bon daar terugvindt.
   */
  bookSale(txId: number, input: SaleInput): number {
    const t = this.get(txId);
    if (t.amount <= 0) throw new ValidationError('Een verkoop is geld dat binnenkomt');
    if (!isSalesVatCode(input.vatCode)) throw new ValidationError('Kies een btw-tarief');
    const channel = input.channel?.trim() || null;
    const reference = input.reference?.trim() || null;
    const who = t.counter_name?.trim() || null;
    const description = [`Verkoop${channel ? ` via ${channel}` : ''}`, reference && `factuur/bon ${reference}`, who].filter(Boolean).join(' · ').slice(0, 200);
    return this.bookToAccount(txId, { account: ACCOUNTS.omzetHoog, vatCode: input.vatCode, relationId: input.relationId ?? null, description, channel });
  }

  /**
   * De laatste keer dat geld van deze betaler (zelfde IBAN, of zonder IBAN dezelfde naam) als
   * verkoop is verwerkt. Alleen boekingen die nog gelden (niet teruggedraaid). Geen voorstel als dit geld de
   * uitbetaling kan zijn van verkopen die al in de app staan (`awaitedPayout`).
   */
  previousSale(txId: number): PreviousSale | null {
    const t = this.get(txId);
    const sale = this.lastSale(t);
    return sale && !this.awaitedPayout(t, sale) ? sale : null;
  }

  /**
   * Geld van een betaaldienst (de naam staat op het afschrift, of de vorige verkoop van deze betaler ging
   * via zo'n dienst) terwijl er verkopen op de tussenrekening wachten: een koppeling boekte die omzet al.
   * Dan is dit waarschijnlijk de uitbetaling daarvan en geen nieuwe verkoop (#227): "net als vorige keer"
   * zou de omzet twee keer tellen. Geeft de naam van de betaaldienst, of null.
   */
  awaitedPayout(t: BankTransaction, sale: PreviousSale | null = this.lastSale(t)): string | null {
    if (t.amount <= 0) return null;
    const provider = paymentProviderIn(`${t.counter_name ?? ''} ${t.description}`) ?? paymentProviderIn(sale?.channel);
    if (!provider) return null;
    if (this.ledger.balance(ACCOUNTS.tussenrekeningPsp) > 0) return provider;
    // las de koppeling ook de uitbetaling al in, dan staat het geld "onderweg" tot het op de bank binnen is
    const synced = this.db.prepare(`SELECT 1 FROM journal_entries WHERE source = 'integratie' LIMIT 1`).get();
    return synced && this.ledger.balance(ACCOUNTS.kruisposten) > 0 ? provider : null;
  }

  private lastSale(t: BankTransaction): PreviousSale | null {
    if (t.amount <= 0 || (!t.counter_iban && !t.counter_name)) return null;
    const rows = this.db
      .prepare(
        `SELECT b.matched_journal_entry_id AS entry, b.transaction_date AS date FROM bank_transactions b
         WHERE b.status = 'gematcht' AND b.id <> ? AND b.amount > 0 AND b.matched_invoice_id IS NULL AND b.matched_journal_entry_id IS NOT NULL
           AND (CASE WHEN ? IS NOT NULL THEN b.counter_iban = ? ELSE b.counter_iban IS NULL AND b.counter_name = ? END)
         ORDER BY b.transaction_date DESC, b.id DESC LIMIT 20`,
      )
      .all(t.id, t.counter_iban, t.counter_iban, t.counter_name) as { entry: number; date: IsoDate }[];
    for (const r of rows) {
      const e = this.events.forEntry(r.entry);
      if (!e || e.type !== 'bank-categorie' || e.status !== 'actief') continue;
      const p = e.payload as BankCategoriePayload;
      // de laatste keer was geen verkoop (bv. privé gestort): dan geen voorstel
      if (p.accountCategory !== 'omzet' || !isSalesVatCode(p.vatCode)) return null;
      return { vatCode: p.vatCode, channel: p.channel ?? null, relationId: p.relationId, date: r.date };
    }
    return null;
  }

  /** Net als vorige keer: zelfde btw, systeem en klant; het nummer uit de omschrijving van de bank. */
  repeatSale(txId: number): number {
    const prev = this.previousSale(txId);
    if (!prev) throw new ValidationError('Er is geen eerdere verkoop van deze betaler om te herhalen');
    const t = this.get(txId);
    return this.bookSale(txId, { vatCode: prev.vatCode, channel: prev.channel, relationId: prev.relationId, reference: referenceIn(t.description) });
  }

  /** Namen van systemen die de gebruiker eerder gaf (Mollie, webshop, …), voor de keuzelijst. */
  saleChannels(): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT json_extract(payload, '$.channel') AS c FROM events WHERE type = 'bank-categorie' AND status = 'actief' AND json_extract(payload, '$.channel') IS NOT NULL ORDER BY id DESC LIMIT 20`)
      .all() as { c: string }[];
    return rows.map((r) => r.c);
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
    // omzet komt op de omzetrekening die bij de btw hoort (21%, 0% buiten de EU, …): zo belandt het in de juiste rubriek
    const account = target.category === 'omzet' && isSalesVatCode(vatCode) ? SALES_ACCOUNTS[vatCode]?.revenue ?? target.rgs_code : target.rgs_code;
    // gemengd gebruik: alleen bij een uitgave op kosten of een bedrijfsmiddel
    const expense = t.amount < 0 && (target.category === 'kosten' || target.category === 'activa');
    if (input.businessPct !== undefined && expense && t.counter_name) setBusinessShare(this.db, t.counter_name, input.businessPct);
    const pct = expense ? businessPct(input.businessPct ?? businessShareFor(this.db, t.counter_name)) : 100;
    const payload: BankCategoriePayload = {
      bankTransactionId: txId,
      date: t.transaction_date,
      amount: t.amount,
      bankAccount: bank.rgs_code,
      account,
      accountCategory: target.category,
      vatCode,
      relationId,
      description,
      ...(pct < 100 ? { businessPct: pct } : {}),
      ...(input.channel?.trim() ? { channel: input.channel.trim().slice(0, 60) } : {}),
      // KOR: geen aftrek van voorbelasting op kosten
      ...(target.category !== 'omzet' && korActive(this.db) ? { noVatDeduction: true } : {}),
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
  reclassify(txId: number, change: { account: string; vatCode?: string; description?: string; businessPct?: number }, reason = 'andere categorie'): number {
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
    if (change.businessPct !== undefined) {
      const pct = businessPct(change.businessPct);
      if (pct < 100) payload.businessPct = pct;
      else delete payload.businessPct;
    }
    return tx(this.db, () => {
      const { entryId } = this.events.replace(event.id, { type: 'bank-categorie', payload }, reason);
      this.db.prepare('UPDATE bank_transactions SET matched_journal_entry_id = ? WHERE id = ?').run(entryId, txId);
      return entryId;
    });
  }

  /**
   * Negeren: de regel telt niet mee in de boekhouding, wel in het saldo (het geld ging van de rekening af).
   * Met `duplicateOf` is het een dubbele regel van die betaling (#225): dan telt hij ook in het saldo niet mee.
   */
  ignore(txId: number, duplicateOf?: number | null): void {
    if (duplicateOf) return this.markDuplicate(txId, duplicateOf);
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
    // als dubbel uit de boekhouding gehaald: terugzetten, samen met wat er tegelijk uit ging
    if (t.duplicate_of) return this.restoreDuplicate(txId);
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
      .prepare(`SELECT COALESCE(SUM(amount), 0) AS s FROM bank_transactions WHERE duplicate_of IS NULL ${bankAccountId ? 'AND bank_account_id = ?' : ''}`)
      .get(...(bankAccountId ? [bankAccountId] : [])) as { s: number };
    return row.s;
  }

  countUnprocessed(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM bank_transactions WHERE status = 'nieuw'`).get() as { n: number }).n;
  }
}
