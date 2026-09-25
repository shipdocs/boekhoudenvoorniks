import type { Db } from '../db/database';
import type { Ledger } from '../core-ledger/ledger';
import { ACCOUNTS } from '../core-ledger/accounts';
import type { BankService, BankTransaction } from '../import/bank';
import type { MatchingEngine } from '../import/matching';
import type { InvoiceService } from '../documents/invoices';
import type { QuoteService } from '../documents/quotes';
import type { JobService } from '../jobs/jobs';
import type { IntakeService } from '../intake/intake';
import type { SupplierMemory } from '../intake/supplier-memory';
import type { VatService } from '../btw/btw';
import type { SettingsService } from '../settings/settings';
import { EXPENSE_CATEGORIES } from '../shared/categories';
import { KNOWN_SUPPLIERS } from '../intake/suppliers';
import { addDays, diffDays, formatDateNl, periodFor, today, type IsoDate } from '../shared/dates';

/** Na zoveel dagen zonder nieuwe bankgegevens vragen we om een afschrift in te lezen. */
export const BANK_STALE_DAYS = 14;
import { formatEuro, type Cents } from '../shared/money';

export type TaskKind =
  | 'setup'
  | 'bank-invoice'
  | 'bank-purchase'
  | 'bank-category'
  | 'bank-business'
  | 'bank-income'
  | 'document-review'
  | 'invoice-overdue'
  | 'invoice-concept'
  | 'job-done'
  | 'quote-expired'
  | 'vat-due'
  | 'bank-stale';

export interface TaskAction {
  id: string;
  label: string;
  primary?: boolean;
}

/** Eén ding dat de aandacht van de gebruiker nodig heeft, in mensentaal. */
export interface Task {
  key: string;
  kind: TaskKind;
  icon: string;
  title: string;
  question: string;
  amount?: Cents;
  actions: TaskAction[];
  ref: { bankAccountId?: number; bankTransactionId?: number; invoiceId?: number; purchaseId?: number; documentId?: number; jobId?: number; quoteId?: number; periodKey?: string; categoryKey?: string; vatCode?: string };
}

export interface HomeData {
  asOf: IsoDate;
  greeting: string;
  money: { bank: Cents; toReceive: Cents; toPay: Cents; vatReserve: Cents };
  /** t/m welke datum de bankgegevens bijgewerkt zijn (laatste transactiedatum over alle rekeningen) */
  bankUpdatedTo: IsoDate | null;
  vat: { periodLabel: string; deadline: IsoDate; deadlineLabel: string; estimate: Cents };
  tasks: Task[];
  checklist: { label: string; ok: boolean }[];
  upToDate: boolean;
  processedToday: { bankChecked: number };
}

function greeting(): string {
  const h = new Date().getHours();
  return h < 6 ? 'Goedenacht' : h < 12 ? 'Goedemorgen' : h < 18 ? 'Goedemiddag' : 'Goedenavond';
}

/** Uiterste aangiftedatum: einde van de maand na het tijdvak (kwartaal/maand), 31 maart bij jaar. */
export function vatDeadline(periodEnd: IsoDate, type: 'maand' | 'kwartaal' | 'jaar'): IsoDate {
  if (type === 'jaar') return `${Number(periodEnd.slice(0, 4)) + 1}-03-31`;
  return periodFor(addDays(periodEnd, 1), 'maand').end;
}

/**
 * "Wat is er gebeurd?" en "Ben ik bij?" — de administratie als inbox die leeg kan.
 * De software doet het werk en vraagt alleen om uitzonderingen.
 */
export class InboxService {
  constructor(
    private readonly db: Db,
    private readonly ledger: Ledger,
    private readonly settings: SettingsService,
    private readonly bank: BankService,
    private readonly matching: MatchingEngine,
    private readonly invoices: InvoiceService,
    private readonly quotes: QuoteService,
    private readonly jobs: JobService,
    private readonly intake: IntakeService,
    private readonly memory: SupplierMemory,
    private readonly vat: VatService,
  ) {}

  /**
   * Verwerkt wat zeker is: betalingen die bij een factuur horen, en betalingen aan leveranciers
   * die de gebruiker al vaak genoeg heeft bevestigd. Deterministisch, geen AI.
   */
  autoProcess(asOf: IsoDate = today()): { matched: number; booked: number } {
    const matched = this.matching.autoMatch(asOf).matched;
    let booked = 0;
    for (const t of this.bank.list({ status: 'nieuw', limit: 5000 })) {
      if (t.amount >= 0 || !t.counter_name) continue;
      const rule = this.memory.get(t.counter_name);
      if (!this.memory.isAutomatic(rule)) continue;
      // Staat er een open bonnetje/inkoopfactuur met dit bedrag? Dan niet als losse kosten boeken.
      const openPurchase = this.db.prepare(`SELECT 1 FROM purchase_invoices WHERE status = 'open' AND total - amount_paid = ?`).get(-t.amount);
      if (openPurchase) continue;
      try {
        this.bookCategory(t, rule!.category_key, rule!.vat_code, Boolean(rule!.business), false);
        booked++;
      } catch {
        // bv. afgesloten periode: laat staan
      }
    }
    return { matched, booked };
  }

  private bookCategory(t: BankTransaction, categoryKey: string, vatCode: string, business: boolean, learn: boolean): void {
    const name = t.counter_name ?? t.description;
    if (!business) {
      this.bank.bookToAccount(t.id, { account: t.amount < 0 ? ACCOUNTS.priveOpnamen : ACCOUNTS.priveStortingen, description: `Privé: ${name}` });
    } else {
      const category = EXPENSE_CATEGORIES.find((c) => c.key === categoryKey);
      if (!category) throw new Error(`Onbekende categorie ${categoryKey}`);
      this.bank.bookToAccount(t.id, { account: category.account, vatCode, description: `${category.label} — ${name}` });
    }
    if (learn && t.counter_name) this.memory.learn(t.counter_name, { categoryKey, vatCode, business });
  }

  /** De gebruiker beantwoordt een vraag uit de inbox. */
  answerBank(bankTransactionId: number, answer: { business: boolean; categoryKey?: string; vatCode?: string }): void {
    const t = this.bank.get(bankTransactionId);
    const category = answer.categoryKey ?? 'overig';
    const vatCode = answer.vatCode ?? EXPENSE_CATEGORIES.find((c) => c.key === category)?.defaultVat ?? 'hoog';
    this.bookCategory(t, category, vatCode, answer.business, true);
  }

  private suggestionFor(t: BankTransaction): { categoryKey: string; vatCode: string; business: boolean; confident: boolean } | null {
    const rule = t.counter_name ? this.memory.get(t.counter_name) : null;
    if (rule) return { categoryKey: rule.category_key, vatCode: rule.vat_code, business: Boolean(rule.business), confident: rule.confirmations >= 1 };
    const known = KNOWN_SUPPLIERS.find((k) => k.pattern.test(`${t.counter_name ?? ''} ${t.description}`));
    if (known) return { categoryKey: known.category, vatCode: known.vatCode, business: true, confident: false };
    return null;
  }

  tasks(asOf: IsoDate = today()): Task[] {
    const tasks: Task[] = [];
    const s = this.settings.get();
    if (!s.onboardingDone || !s.company.name) {
      tasks.push({ key: 'setup', kind: 'setup', icon: '👋', title: 'Maak je bedrijf compleet', question: 'We hebben nog een paar gegevens nodig voor je facturen.', actions: [{ id: 'open', label: 'Afronden', primary: true }], ref: {} });
    }

    for (const t of this.bank.list({ status: 'nieuw', limit: 200 })) {
      const who = t.counter_name || t.description.slice(0, 40) || 'Onbekend';
      const suggestions = this.matching.suggest(t);
      const inv = suggestions.find((x) => x.kind === 'factuur');
      const pur = suggestions.find((x) => x.kind === 'inkoop');
      if (inv && inv.kind === 'factuur' && inv.score >= 50) {
        tasks.push({
          key: `bank-${t.id}`,
          kind: 'bank-invoice',
          icon: '💳',
          title: `${formatEuro(t.amount)} ontvangen van ${who}`,
          question: `Dit lijkt betaling van ${inv.label.replace(/ — .*/, '').toLowerCase()}.`,
          amount: t.amount,
          actions: [{ id: 'klopt', label: 'Klopt', primary: true }, { id: 'nee', label: 'Nee' }],
          ref: { bankTransactionId: t.id, invoiceId: inv.invoiceId },
        });
        continue;
      }
      if (pur && pur.kind === 'inkoop' && pur.score >= 50) {
        tasks.push({
          key: `bank-${t.id}`,
          kind: 'bank-purchase',
          icon: '🧾',
          title: `${formatEuro(-t.amount)} betaald aan ${who}`,
          question: `Hoort dit bij ${pur.label.replace(/^Inkoop /, '')}?`,
          amount: t.amount,
          actions: [{ id: 'klopt', label: 'Klopt', primary: true }, { id: 'nee', label: 'Nee' }],
          ref: { bankTransactionId: t.id, purchaseId: pur.purchaseId },
        });
        continue;
      }
      if (t.amount > 0) {
        tasks.push({
          key: `bank-${t.id}`,
          kind: 'bank-income',
          icon: '💶',
          title: `${formatEuro(t.amount)} ontvangen van ${who}`,
          question: 'Waar is dit geld voor?',
          amount: t.amount,
          actions: [{ id: 'open', label: 'Uitzoeken', primary: true }],
          ref: { bankTransactionId: t.id },
        });
        continue;
      }
      const sug = this.suggestionFor(t);
      if (sug?.confident && sug.business) {
        const label = EXPENSE_CATEGORIES.find((c) => c.key === sug.categoryKey)?.label.toLowerCase() ?? sug.categoryKey;
        tasks.push({
          key: `bank-${t.id}`,
          kind: 'bank-category',
          icon: '🧾',
          title: `${who} ${formatEuro(-t.amount)}`,
          question: `We denken dat dit ${label} is.`,
          amount: t.amount,
          actions: [{ id: 'klopt', label: 'Klopt', primary: true }, { id: 'anders', label: 'Iets anders' }],
          ref: { bankTransactionId: t.id, categoryKey: sug.categoryKey, vatCode: sug.vatCode },
        });
      } else {
        const guess = sug ? EXPENSE_CATEGORIES.find((c) => c.key === sug.categoryKey)?.label.toLowerCase() : null;
        tasks.push({
          key: `bank-${t.id}`,
          kind: 'bank-business',
          icon: '🧾',
          title: `${who} ${formatEuro(-t.amount)}`,
          question: guess ? `Was dit zakelijk (${guess}) of privé?` : 'Was dit zakelijk of privé?',
          amount: t.amount,
          actions: [{ id: 'zakelijk', label: 'Zakelijk', primary: true }, { id: 'prive', label: 'Privé' }],
          ref: { bankTransactionId: t.id, categoryKey: sug?.categoryKey, vatCode: sug?.vatCode },
        });
      }
    }

    if (s.onboardingDone && s.profile.hasBusinessAccount) {
      for (const st of this.bank.importStatus()) {
        const days = st.coverageTo ? diffDays(st.coverageTo, asOf) : null;
        if (days !== null && days < BANK_STALE_DAYS) continue;
        tasks.push({
          key: `bank-stale-${st.bankAccountId}`,
          kind: 'bank-stale',
          icon: '🏦',
          title: st.coverageTo ? `${st.name}: bankgegevens lopen t/m ${formatDateNl(st.coverageTo)}` : `${st.name}: nog geen bankafschrift ingelezen`,
          question: st.coverageTo ? `Dat is ${days} dagen geleden. Lees een nieuw afschrift in, dan kunnen we betalingen koppelen.` : 'Lees een afschrift in, dan koppelen we betalingen automatisch aan je facturen en bonnetjes.',
          actions: [{ id: 'open', label: 'Afschrift inlezen', primary: true }],
          ref: { bankAccountId: st.bankAccountId },
        });
      }
    }

    for (const d of this.intake.list('controle')) {
      const bad = d.issues.find((i) => i.severity === 'fout');
      const name = d.result?.supplier?.value ?? d.original_name;
      tasks.push({
        key: `doc-${d.id}`,
        kind: 'document-review',
        icon: '📷',
        title: `${name}${d.result?.total ? ' ' + formatEuro(d.result.total.value) : ''}`,
        question: bad ? bad.message : d.classification ? `We denken: ${EXPENSE_CATEGORIES.find((c) => c.key === d.classification!.categoryKey)?.label.toLowerCase()}. Alles klopt?` : 'Even controleren?',
        amount: d.result?.total?.value,
        actions: bad ? [{ id: 'open', label: 'Bekijken', primary: true }] : [{ id: 'klopt', label: 'Ja', primary: true }, { id: 'open', label: 'Aanpassen' }],
        ref: { documentId: d.id },
      });
    }

    for (const inv of this.invoices.list({ status: 'vervallen' }, asOf)) {
      tasks.push({
        key: `overdue-${inv.id}`,
        kind: 'invoice-overdue',
        icon: '⏰',
        title: `${inv.relation_name} moet nog ${formatEuro(inv.open_amount)} betalen`,
        question: `Factuur ${inv.number} is te laat (vervaldatum ${formatDateNl(inv.due_date)}).`,
        amount: inv.open_amount,
        actions: [{ id: 'herinnering', label: 'Herinnering sturen', primary: true }, { id: 'open', label: 'Bekijken' }],
        ref: { invoiceId: inv.id },
      });
    }

    for (const job of this.jobs.list({ status: 'klaar' })) {
      tasks.push({
        key: `job-${job.id}`,
        kind: 'job-done',
        icon: '🔨',
        title: `Klus ${job.relation_name} is klaar`,
        question: job.title,
        actions: [{ id: 'factuur', label: 'Factuur maken', primary: true }],
        ref: { jobId: job.id },
      });
    }

    for (const q of this.quotes.list({ status: 'verzonden' }, asOf).filter((q) => q.expired)) {
      tasks.push({
        key: `quote-${q.id}`,
        kind: 'quote-expired',
        icon: '📄',
        title: `Offerte ${q.relation_name} is verlopen`,
        question: 'Heeft de klant ja gezegd?',
        amount: q.total,
        actions: [{ id: 'akkoord', label: 'Ja, akkoord', primary: true }, { id: 'afgewezen', label: 'Nee' }],
        ref: { quoteId: q.id },
      });
    }

    const drafts = this.invoices.list({ status: 'concept' }, asOf).filter((i) => i.invoice_date <= addDays(asOf, -2));
    for (const d of drafts) {
      tasks.push({
        key: `concept-${d.id}`,
        kind: 'invoice-concept',
        icon: '✏️',
        title: `Factuur voor ${d.relation_name} is nog niet verstuurd`,
        question: `${formatEuro(d.total)} — nog versturen?`,
        amount: d.total,
        actions: [{ id: 'open', label: 'Bekijken', primary: true }],
        ref: { invoiceId: d.id },
      });
    }

    if (!s.kor) {
      const previous = periodFor(addDays(this.vat.currentPeriod(asOf).start, -1), s.vatPeriod);
      const report = this.vat.calculate(previous.key);
      const hasActivity = report.summary.omzet !== 0 || report.summary.voorbelasting !== 0;
      if (report.status !== 'ingediend' && hasActivity) {
        const deadline = vatDeadline(previous.end, s.vatPeriod);
        tasks.push({
          key: `vat-${previous.key}`,
          kind: 'vat-due',
          icon: '📮',
          title: `BTW ${previous.label} aangeven`,
          question: `Uiterlijk ${formatDateNl(deadline)}: ${report.summary.teBetalen >= 0 ? 'betalen' : 'terugkrijgen'} ongeveer ${formatEuro(Math.abs(report.summary.teBetalen))}.`,
          amount: report.summary.teBetalen,
          actions: [{ id: 'open', label: 'Aangifte bekijken', primary: true }],
          ref: { periodKey: previous.key },
        });
      }
    }
    return tasks;
  }

  home(asOf: IsoDate = today()): HomeData {
    const s = this.settings.get();
    const tasks = this.tasks(asOf);
    const bankAccounts = this.bank.listAccounts();
    const ledgerBank = bankAccounts.reduce((sum, a) => sum + this.ledger.balance(a.rgs_code), 0);
    const pending = (this.db.prepare(`SELECT COALESCE(SUM(amount), 0) AS s FROM bank_transactions WHERE status = 'nieuw'`).get() as { s: number }).s;
    const toReceive = this.invoices.listOpen(asOf).reduce((sum, i) => sum + Math.max(0, i.open_amount), 0);
    const toPay = (this.db.prepare(`SELECT COALESCE(SUM(total - amount_paid), 0) AS s FROM purchase_invoices WHERE status = 'open'`).get() as { s: number }).s;
    // Alles wat op BTW-rekeningen staat (lopend kwartaal + nog niet betaalde aangiftes)
    const vatReserve = -this.ledger.balances().filter((b) => b.category === 'btw').reduce((sum, b) => sum + b.balance, 0);
    const current = this.vat.currentPeriod(asOf);
    const deadline = vatDeadline(current.end, s.vatPeriod);
    const kinds = new Set(tasks.map((t) => t.kind));
    const status = this.bank.importStatus();
    const bankUpdatedTo = status.map((st) => st.coverageTo).filter((d): d is string => !!d).sort().at(-1) ?? null;
    const checklist = [
      { label: 'Bankgegevens bijgewerkt', ok: !kinds.has('bank-stale') },
      { label: 'Alle banktransacties verwerkt', ok: ![...kinds].some((k) => k.startsWith('bank-') && k !== 'bank-stale') },
      { label: 'Alle bonnetjes verwerkt', ok: !kinds.has('document-review') },
      { label: 'Geen facturen te laat', ok: !kinds.has('invoice-overdue') },
      { label: 'BTW bijgewerkt', ok: !kinds.has('vat-due') },
    ];
    return {
      asOf,
      greeting: greeting(),
      money: { bank: ledgerBank + pending, toReceive, toPay, vatReserve: Math.max(0, vatReserve) },
      bankUpdatedTo,
      vat: { periodLabel: current.label, deadline, deadlineLabel: formatDateNl(deadline), estimate: this.vat.calculate(current.key).summary.teBetalen },
      tasks,
      checklist,
      upToDate: tasks.length === 0,
      processedToday: { bankChecked: (this.db.prepare(`SELECT COUNT(*) AS n FROM bank_transactions WHERE date(created_at) = date('now')`).get() as { n: number }).n },
    };
  }
}
