import type { Db } from '../db/database';
import { tx } from '../db/database';
import type { Ledger } from '../core-ledger/ledger';
import { ACCOUNTS } from '../core-ledger/accounts';
import type { BankService, BankTransaction } from '../import/bank';
import type { MatchingEngine } from '../import/matching';
import type { InvoiceService } from '../documents/invoices';
import type { QuoteService } from '../documents/quotes';
import type { JobService } from '../jobs/jobs';
import type { IntakeService } from '../intake/intake';
import { ASK_AUTO_AFTER_CONFIRMATIONS, supplierKey, type SupplierMemory } from '../intake/supplier-memory';
import type { PurchaseService } from '../documents/purchases';
import type { RecurringService } from '../import/recurring';
import { normalizeIban, ValidationError } from '../shared/validation';
import type { VatService } from '../btw/btw';
import type { SettingsService } from '../settings/settings';
import { EXPENSE_CATEGORIES } from '../shared/categories';
import { KNOWN_SUPPLIERS } from '../intake/suppliers';
import { addDays, diffDays, formatDateNl, periodFor, today, vatDeadline, type IsoDate } from '../shared/dates';

/** Na zoveel dagen zonder nieuwe bankgegevens vragen we om een afschrift in te lezen. */
export const BANK_STALE_DAYS = 14;
/** Zoveel dagen vóór de vervaldatum herinneren we aan het betalen van een rekening. */
export const PAY_REMINDER_DAYS = 3;
import { formatEuro, type Cents } from '../shared/money';
import { automationForMonth, countDecision, getAutomation, logAutomation, markCorrected, recentAutomation, type AutomationEntry } from './automation-log';
import { explain } from '../automation/explain';

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
  | 'bank-stale'
  | 'vat-suppletie'
  | 'supplier-auto'
  | 'vat-check'
  | 'purchase-due'
  | 'bank-pot'
  | 'job-link'
  | 'recurring-confirm'
  | 'recurring-missing-payment'
  | 'recurring-stopped'
  | 'recurring-invoice';

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
  /** 1 = eerst (btw, deadlines), 2 = normaal, 3 = kan wachten */
  priority?: 1 | 2 | 3;
  /** taken met dezelfde groep kunnen in één keer bevestigd worden ("Alle 5 Shell: brandstof") */
  group?: { key: string; label: string };
  /** "Waarom?": waarom we dit voorstellen */
  why?: string;
  ref: { seriesId?: number; checkKey?: string; bankAccountId?: number; bankTransactionId?: number; invoiceId?: number; purchaseId?: number; documentId?: number; jobId?: number; quoteId?: number; periodKey?: string; supplierKey?: string; categoryKey?: string; vatCode?: string };
}

export interface HomeData {
  asOf: IsoDate;
  greeting: string;
  money: {
    bank: Cents;
    toReceive: Cents;
    toPay: Cents;
    /** te reserveren btw: lopende periode(s) + aangegeven maar nog niet betaald */
    vatReserve: Cents;
    /** belastingpotje (#33): wat er al opzij staat, en wat er nog bij moet (null = geen potje) */
    vatPot: { account: string; setAside: Cents; stillToReserve: Cents } | null;
    /** banksaldo − te reserveren btw − openstaande rekeningen */
    freeToSpend: Cents;
  };
  /** t/m welke datum de bankgegevens bijgewerkt zijn (laatste transactiedatum over alle rekeningen) */
  bankUpdatedTo: IsoDate | null;
  vat: { periodLabel: string; deadline: IsoDate; deadlineLabel: string; estimate: Cents };
  tasks: Task[];
  checklist: { label: string; ok: boolean }[];
  upToDate: boolean;
  processedToday: { bankChecked: number };
  /** wat de app de afgelopen week zelf heeft gedaan */
  automated: AutomationEntry[];
  /** deze maand: automatisch / door jou / nog aandacht (#29) */
  monthCounts: { automatic: number; byUser: number; attention: number };
}

function greeting(): string {
  const h = new Date().getHours();
  return h < 6 ? 'Goedenacht' : h < 12 ? 'Goedemorgen' : h < 18 ? 'Goedemiddag' : 'Goedenavond';
}

export { vatDeadline };

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
    private readonly purchases: PurchaseService,
    private readonly recurring: RecurringService,
  ) {}

  /** Een taak bewust overslaan; komt niet terug zolang de sleutel gelijk blijft. */
  skipTask(key: string, reason = ''): void {
    this.db
      .prepare(`INSERT INTO task_skips (task_key, fingerprint, reason) VALUES (?, 'x', ?) ON CONFLICT(task_key) DO UPDATE SET reason = excluded.reason`)
      .run(key, reason);
  }

  private isSkipped(key: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM task_skips WHERE task_key = ? AND fingerprint = 'x'`).get(key);
  }

  /**
   * Verwerkt wat zeker is: betalingen die bij een factuur horen, en betalingen aan leveranciers
   * die de gebruiker al vaak genoeg heeft bevestigd. Deterministisch, geen AI.
   */
  autoProcess(asOf: IsoDate = today()): { matched: number; booked: number } {
    this.recurring.detect(); // vaste lasten herkennen (alleen voorstellen, niets boeken)
    const level = this.settings.get().autopilot;
    if (level === 'voorzichtig') return { matched: 0, booked: 0 }; // alles blijft geel: de gebruiker bevestigt
    const auto = this.matching.autoMatch(asOf, level);
    const matched = auto.matched;
    for (const d of auto.details) {
      const explanation = explain([{ type: 'matching', label: d.reasons.join(', ') || 'bedrag en omschrijving overeenkwamen', value: d.confidence }]);
      logAutomation(this.db, { kind: 'bank-match', ref_id: d.txId, summary: `Betaling gekoppeld: ${d.label}`, reason: explanation.sentence, details: explanation });
      countDecision(this.db, 'bankkoppeling', 'automatic');
    }
    let booked = 0;
    for (const t of this.bank.list({ status: 'nieuw', limit: 5000 })) {
      if (t.amount >= 0 || !t.counter_name) continue;
      const rule = this.memory.get(t.counter_name);
      if (!this.memory.isAutomatic(rule)) continue;
      // privéauto: tanken en parkeren nooit automatisch als zakelijke kosten
      if (rule!.business && this.fuelIsPrivate(rule!.category_key)) continue;
      // Staat er een open bonnetje/inkoopfactuur met dit bedrag? Dan niet als losse kosten boeken.
      const openPurchase = this.db.prepare(`SELECT 1 FROM purchase_invoices WHERE status = 'open' AND total - amount_paid = ?`).get(-t.amount);
      if (openPurchase) continue;
      try {
        // boeken en vastleggen in één transactie: nooit een automatische boeking zonder logregel
        tx(this.db, () => {
          this.bookCategory(t, rule!.category_key, rule!.vat_code, Boolean(rule!.business), false);
          const label = rule!.business ? EXPENSE_CATEGORIES.find((c) => c.key === rule!.category_key)?.label.toLowerCase() ?? rule!.category_key : 'privé';
          const explanation = explain([
            { type: 'leveranciersregel', label: `je ${rule!.confirmations}× ${rule!.display_name} als ${label} hebt bevestigd en hebt gezegd dat dit voortaan automatisch mag`, value: 0.97 },
          ]);
          logAutomation(this.db, {
            kind: 'bank-auto',
            ref_id: t.id,
            summary: `${formatEuro(-t.amount)} aan ${rule!.display_name} geboekt als ${label}`,
            reason: explanation.sentence,
            details: explanation,
          });
          countDecision(this.db, 'categorie', 'automatic');
        });
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

  /** Met een privéauto is brandstof/parkeren privé: je krijgt een bedrag per zakelijke km. */
  private fuelIsPrivate(categoryKey: string): boolean {
    return categoryKey === 'brandstof' && this.settings.get().carUse === 'prive';
  }

  private suggestionFor(t: BankTransaction): { categoryKey: string; vatCode: string; business: boolean; confident: boolean; why: string } | null {
    const sug = this.rawSuggestionFor(t);
    if (sug && sug.business && this.fuelIsPrivate(sug.categoryKey)) {
      return { ...sug, business: false, confident: false, why: 'Je rijdt met een privéauto: tanken en parkeren zijn dan privé. Zakelijke kilometers vul je in bij Belasting → Kilometers.' };
    }
    return sug;
  }

  private rawSuggestionFor(t: BankTransaction): { categoryKey: string; vatCode: string; business: boolean; confident: boolean; why: string } | null {
    const rule = t.counter_name ? this.memory.get(t.counter_name) : null;
    if (rule) {
      const label = EXPENSE_CATEGORIES.find((c) => c.key === rule.category_key)?.label.toLowerCase() ?? rule.category_key;
      return { categoryKey: rule.category_key, vatCode: rule.vat_code, business: Boolean(rule.business), confident: rule.confirmations >= 1, why: `Omdat je ${rule.display_name} eerder ${rule.confirmations}× als ${label} hebt bevestigd.` };
    }
    const known = KNOWN_SUPPLIERS.find((k) => k.pattern.test(`${t.counter_name ?? ''} ${t.description}`));
    if (known) return { categoryKey: known.category, vatCode: known.vatCode, business: true, confident: false, why: 'Omdat de naam lijkt op een bekende winkel.' };
    return null;
  }

  tasks(asOf: IsoDate = today()): Task[] {
    const tasks: Task[] = [];
    const s = this.settings.get();
    if (!s.onboardingDone || !s.company.name) {
      tasks.push({ key: 'setup', kind: 'setup', icon: '👋', title: 'Maak je bedrijf compleet', question: 'We hebben nog een paar gegevens nodig voor je facturen.', actions: [{ id: 'open', label: 'Afronden', primary: true }], ref: {} });
    }

    const potAccount = s.vatPotAccountId ? this.bank.listAccounts().find((a) => a.id === s.vatPotAccountId) : undefined;
    for (const t of this.bank.list({ status: 'nieuw', limit: 200 })) {
      const who = t.counter_name || t.description.slice(0, 40) || 'Onbekend';
      // overboeking van/naar het belastingpotje eerst: een opname uit het potje is geen omzet
      if (potAccount && potAccount.id !== t.bank_account_id && potAccount.iban && t.counter_iban && normalizeIban(t.counter_iban) === normalizeIban(potAccount.iban)) {
        tasks.push({
          key: `bank-${t.id}`,
          kind: 'bank-pot',
          icon: '🐷',
          title: `${formatEuro(Math.abs(t.amount))} ${t.amount < 0 ? 'naar' : 'uit'} je belastingpotje`,
          question: t.amount < 0 ? 'Opzijgezet voor de btw. Dit telt niet als kosten.' : 'Terug van je belastingpotje (bv. om de btw te betalen).',
          amount: t.amount,
          actions: [{ id: 'klopt', label: 'Klopt', primary: true }],
          group: { key: 'bank-pot', label: 'Alle overboekingen met je potje' },
          ref: { bankTransactionId: t.id, bankAccountId: potAccount.id },
        });
        continue;
      }
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
          group: { key: 'bank-invoice', label: 'Alle betalingen koppelen' },
          why: `Omdat ${inv.reasons.join(', ')}.`,
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
          group: { key: 'bank-purchase', label: 'Alle betalingen koppelen' },
          why: `Omdat ${pur.reasons.join(', ')}.`,
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
          group: { key: `bank-category:${supplierKey(who)}:${sug.categoryKey}`, label: `Alle ${who}: ${label}` },
          why: sug.why,
          ref: { bankTransactionId: t.id, categoryKey: sug.categoryKey, vatCode: sug.vatCode },
        });
      } else {
        const guess = sug ? EXPENSE_CATEGORIES.find((c) => c.key === sug.categoryKey)?.label.toLowerCase() : null;
        tasks.push({
          key: `bank-${t.id}`,
          kind: 'bank-business',
          icon: '🧾',
          title: `${who} ${formatEuro(-t.amount)}`,
          question: sug && !sug.business && this.fuelIsPrivate(sug.categoryKey) ? 'Tanken of parkeren met je privéauto telt als privé; je zakelijke kilometers vul je apart in.' : guess ? `Was dit zakelijk (${guess}) of privé?` : 'Was dit zakelijk of privé?',
          amount: t.amount,
          actions: sug && !sug.business && this.fuelIsPrivate(sug.categoryKey)
            ? [{ id: 'prive', label: 'Privé', primary: true }, { id: 'zakelijk', label: 'Toch zakelijk' }]
            : [{ id: 'zakelijk', label: 'Zakelijk', primary: true }, { id: 'prive', label: 'Privé' }],
          why: sug && !sug.business && this.fuelIsPrivate(sug.categoryKey) ? sug.why : undefined,
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
        actions: bad?.field === 'duplicate'
          ? [{ id: 'dubbel', label: 'Ja, zelfde', primary: true }, { id: 'open', label: 'Nee, bekijken' }]
          : bad ? [{ id: 'open', label: 'Bekijken', primary: true }] : [{ id: 'klopt', label: 'Ja', primary: true }, { id: 'open', label: 'Aanpassen' }],
        group: bad ? undefined : { key: 'document-klopt', label: 'Alle bonnetjes bevestigen' },
        why: d.classification ? `Omdat ${d.classification.reasons.join(', ')}.` : undefined,
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

    // Aankopen voor een klus? (#32) Alleen materiaal/gereedschap van de laatste 30 dagen zonder klus.
    if (this.jobs.list({ active: true }).length > 0) {
      const JOB_ACCOUNTS = ['WKprInkMat', 'WBedAlkGer'];
      const recentPurchases = this.db
        .prepare(
          `SELECT p.id, p.invoice_date, p.total, r.name AS supplier, d.gps_lat, d.gps_lon FROM purchase_invoices p
           LEFT JOIN relations r ON r.id = p.relation_id LEFT JOIN documents d ON d.id = p.document_id
           WHERE p.job_id IS NULL AND p.invoice_date >= ? AND EXISTS (
             SELECT 1 FROM purchase_invoice_lines l JOIN chart_of_accounts a ON a.id = l.account_id WHERE l.purchase_invoice_id = p.id AND a.rgs_code IN ('WKprInkMat','WBedAlkGer'))`,
        )
        .all(addDays(asOf, -30)) as { id: number; invoice_date: string; total: number; supplier: string | null; gps_lat: number | null; gps_lon: number | null }[];
      const recentBank = (this.db
        .prepare(
          `SELECT b.id, b.transaction_date, b.amount, b.counter_name, ev.payload FROM bank_transactions b
           JOIN journal_entries e ON e.id = b.matched_journal_entry_id JOIN events ev ON ev.id = e.event_id
           WHERE ev.type = 'bank-categorie' AND ev.job_id IS NULL AND ev.status = 'actief' AND b.transaction_date >= ?`,
        )
        .all(addDays(asOf, -30)) as { id: number; transaction_date: string; amount: number; counter_name: string | null; payload: string }[]).filter((b) => JOB_ACCOUNTS.includes(JSON.parse(b.payload).account));
      const items = [
        ...recentPurchases.map((p) => ({ key: `job-link-p-${p.id}`, date: p.invoice_date, amount: p.total, supplier: p.supplier, gps: p.gps_lat != null && p.gps_lon != null ? { lat: p.gps_lat, lon: p.gps_lon } : null, ref: { purchaseId: p.id } })),
        ...recentBank.map((b) => ({ key: `job-link-b-${b.id}`, date: b.transaction_date, amount: -b.amount, supplier: b.counter_name, gps: null, ref: { bankTransactionId: b.id } })),
      ];
      for (const it of items) {
        if (this.isSkipped(it.key)) continue;
        const [best] = this.jobs.suggest({ date: it.date, supplier: it.supplier, gps: it.gps });
        if (!best) continue;
        tasks.push({
          key: it.key,
          kind: 'job-link',
          icon: '🔨',
          title: `${it.supplier ?? 'Aankoop'} ${formatEuro(it.amount)}`,
          question: `Was dit voor de klus bij ${best.job.relation_name} (${best.job.title})?`,
          why: `Omdat ${best.reason}.`,
          amount: -it.amount,
          actions: [{ id: 'ja', label: 'Ja', primary: true }, { id: 'anders', label: 'Andere klus' }, { id: 'algemeen', label: 'Algemeen' }],
          group: { key: `job-link-${best.job.id}`, label: `Allemaal voor ${best.job.relation_name} (${best.job.title})` },
          priority: 3,
          ref: { ...it.ref, jobId: best.job.id },
        });
      }
    }

    // Vaste lasten (#30)
    for (const series of this.recurring.list()) {
      const label = `${formatEuro(series.amount)} per ${series.interval}`;
      if (series.status === 'voorgesteld') {
        tasks.push({
          key: `recurring-${series.id}`,
          kind: 'recurring-confirm',
          icon: '🔁',
          title: `${series.counter_name} lijkt een vaste last`,
          question: `Ongeveer ${label}. Als vaste last houden we bij of de factuur en de afschrijving op tijd komen.`,
          actions: [{ id: 'ja', label: 'Ja, vaste last', primary: true }, { id: 'nee', label: 'Nee' }],
          priority: 3,
          ref: { seriesId: series.id },
        });
        continue;
      }
      if (series.status !== 'actief') continue;
      const st = this.recurring.state(series, asOf);
      if (st.missed.length >= 2) {
        const key = `recurring-stopped-${series.id}-${st.missed.length}`;
        if (!this.isSkipped(key)) {
          tasks.push({
            key,
            kind: 'recurring-stopped',
            icon: '🔁',
            title: `Is ${series.counter_name} gestopt?`,
            question: `De laatste ${st.missed.length} verwachte afschrijvingen (${label}) zijn niet gebeurd.`,
            actions: [{ id: 'ja', label: 'Ja, gestopt', primary: true }, { id: 'nee', label: 'Nee, loopt nog' }],
            ref: { seriesId: series.id },
          });
        }
      } else {
        // één gemiste aan het eind, of een gat tussen twee betalingen in
        for (const due of [...st.gaps, ...st.missed]) {
          const key = `recurring-pay-${series.id}-${due}`;
          if (this.isSkipped(key)) continue;
          tasks.push({
            key,
            kind: 'recurring-missing-payment',
            icon: '🔁',
            title: `Afschrijving ${series.counter_name} niet gezien`,
            question: `Rond ${formatDateNl(due)} verwachtten we ongeveer ${formatEuro(series.amount)}. Is je bankafschrift bijgewerkt?`,
            actions: [{ id: 'ok', label: 'Klopt, niets aan de hand', primary: true }, { id: 'open', label: 'Bank bekijken' }],
            priority: 3,
            ref: { seriesId: series.id },
          });
        }
      }
      for (const t of this.recurring.missingInvoices(series, asOf)) {
        const key = `recurring-invoice-${t.id}`;
        if (this.isSkipped(key)) continue;
        tasks.push({
          key,
          kind: 'recurring-invoice',
          icon: '🧾',
          title: `Factuur ${series.counter_name} ontbreekt`,
          question: `Er is ${formatEuro(-t.amount)} afgeschreven op ${formatDateNl(t.transaction_date)}, maar we missen de factuur.`,
          amount: t.amount,
          actions: [{ id: 'open', label: 'Factuur toevoegen', primary: true }, { id: 'geen', label: 'Geen factuur nodig' }],
          group: { key: `recurring-invoice-${series.id}`, label: `Facturen ${series.counter_name}` },
          ref: { seriesId: series.id, bankTransactionId: t.id },
        });
      }
    }

    // Rekeningen die binnenkort betaald moeten worden (#25)
    for (const p of this.purchases.listOpen().filter((x) => x.due_date && x.due_date <= addDays(asOf, PAY_REMINDER_DAYS) && x.open_amount > 0)) {
      tasks.push({
        key: `pay-${p.id}`,
        kind: 'purchase-due',
        icon: '💸',
        title: `${p.relation_name ?? p.description}: ${formatEuro(p.open_amount)} betalen`,
        question: p.due_date! < asOf ? `Dit had uiterlijk ${formatDateNl(p.due_date!)} betaald moeten zijn.` : `Betaal vóór ${formatDateNl(p.due_date!)}.`,
        amount: -p.open_amount,
        actions: [{ id: 'open', label: `Betaal ${formatEuro(p.open_amount)}`, primary: true }],
        priority: p.due_date! < asOf ? 1 : 2,
        ref: { purchaseId: p.id },
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
          priority: 1,
          ref: { periodKey: previous.key },
        });
        // Controles vóór de aangifte (#20): in dezelfde lijst, blokkerend tot opgelost of bewust overgeslagen
        for (const c of this.vat.checks(previous.key).filter((x) => !x.skipped)) {
          tasks.push({
            key: `vat-check-${previous.key}-${c.key}`,
            kind: 'vat-check',
            icon: c.blocking ? '⚠️' : '💡',
            title: c.title,
            question: `${c.detail}${c.blocking ? ` Nodig voor de btw-aangifte ${previous.label}.` : ''}`,
            actions: [{ id: 'open', label: 'Oplossen', primary: true }, { id: 'overslaan', label: c.blocking ? 'Bewust overslaan' : 'Klopt' }],
            priority: 1,
            ref: { periodKey: previous.key, checkKey: c.key },
          });
        }
      }
    }
    const askAfter = s.autopilot === 'voorzichtig' ? Number.POSITIVE_INFINITY : s.autopilot === 'maximaal' ? 2 : ASK_AUTO_AFTER_CONFIRMATIONS;
    for (const rule of Number.isFinite(askAfter) ? this.memory.pendingApprovals(askAfter) : []) {
      const label = rule.business ? EXPENSE_CATEGORIES.find((c) => c.key === rule.category_key)?.label.toLowerCase() ?? rule.category_key : 'privé';
      tasks.push({
        key: `supplier-auto-${rule.supplier_key}`,
        kind: 'supplier-auto',
        icon: '🤖',
        title: `${rule.display_name} is bij jou altijd ${label}`,
        question: `Je hebt dit ${rule.confirmations}× zo gekozen. Voortaan automatisch verwerken? Je ziet het terug onder "Automatisch gedaan" en kunt het altijd terugdraaien.`,
        actions: [{ id: 'ja', label: 'Ja, voortaan automatisch', primary: true }, { id: 'nee', label: 'Nee, blijf het vragen' }],
        ref: { supplierKey: rule.supplier_key },
      });
    }

    for (const c of this.vat.corrections().filter((x) => x.suppletie)) {
      tasks.push({
        key: `suppletie-${c.periodKey}`,
        kind: 'vat-suppletie',
        icon: '📮',
        title: `BTW ${c.label} verbeteren`,
        question: `Er is achteraf ${formatEuro(Math.abs(c.btw))} btw ${c.btw >= 0 ? 'bijgekomen' : 'afgegaan'}. Dat is meer dan € 1.000, dus dat doe je met een suppletie-aangifte in Mijn Belastingdienst Zakelijk.`,
        amount: c.btw,
        actions: [{ id: 'gedaan', label: 'Suppletie is gedaan', primary: true }, { id: 'open', label: 'Bekijken' }],
        priority: 1,
        ref: { periodKey: c.periodKey },
      });
    }
    // stabiel sorteren op prioriteit; binnen een prioriteit blijft de volgorde gelijk
    return tasks.map((t, i) => ({ t, i })).sort((a, b) => (a.t.priority ?? 2) - (b.t.priority ?? 2) || a.i - b.i).map((x) => x.t);
  }

  /** Legt vast dat de gebruiker een taak heeft afgehandeld (voor "door jou gecontroleerd", #29). */
  recordUserAction(task: Task, actionId: string): void {
    const action = task.actions.find((a) => a.id === actionId);
    if (!action || actionId === 'open' || actionId === 'anders') return; // alleen afgehandelde beslissingen tellen
    logAutomation(this.db, { kind: 'gebruiker', ref_id: null, summary: `${task.title}: ${action.label.toLowerCase()}`, reason: task.question, actor: 'gebruiker' });
  }

  /** Maandoverzicht (#29): wat ging automatisch, wat deed de gebruiker, wat staat nog open. */
  month(month: string = today().slice(0, 7), asOf: IsoDate = today()): { month: string; automatic: AutomationEntry[]; byUser: AutomationEntry[]; attention: number } {
    return {
      month,
      automatic: automationForMonth(this.db, month, 'systeem'),
      byUser: automationForMonth(this.db, month, 'gebruiker'),
      attention: this.tasks(asOf).length,
    };
  }

  /**
   * "Klopt niet" op iets dat automatisch ging: terugdraaien via tegenboekingen, weer vragen,
   * en tellen als correctie voor de drempels (#21, #29). Het item komt terug als taak.
   */
  correctAutomation(logId: number, date: IsoDate = today()): void {
    const entry = getAutomation(this.db, logId);
    if (!entry || entry.actor !== 'systeem') throw new ValidationError('Onbekende automatische verwerking');
    if (entry.status === 'klopt_niet') throw new ValidationError('Dit is al teruggedraaid');
    tx(this.db, () => {
      if (entry.kind === 'bank-match' || entry.kind === 'bank-auto') {
        const t = this.bank.get(entry.ref_id!);
        if (t.status === 'gematcht') this.bank.unmatch(t.id, date);
        if (entry.kind === 'bank-auto' && t.counter_name) this.memory.markCorrected(t.counter_name);
        countDecision(this.db, entry.kind === 'bank-match' ? 'bankkoppeling' : 'categorie', 'corrected');
      } else if (entry.kind === 'document-auto') {
        const doc = this.intake.get(entry.ref_id!);
        if (doc.purchase_invoice_id) {
          const paidBy = this.db.prepare('SELECT id FROM bank_transactions WHERE matched_purchase_invoice_id = ?').all(doc.purchase_invoice_id) as { id: number }[];
          for (const b of paidBy) this.bank.unmatch(b.id, date);
          this.purchases.cancel(doc.purchase_invoice_id, date);
        } else {
          // privé: geen inkoop, wel mogelijk een privé-opname op de bank
          const txId = entry.details?.refs?.bankTransactionId;
          if (txId && this.bank.get(txId).status === 'gematcht') this.bank.unmatch(txId, date);
          this.db.prepare(`UPDATE documents SET status = 'controle' WHERE id = ?`).run(doc.id);
        }
        if (doc.result?.supplier) this.memory.markCorrected(doc.result.supplier.value);
        for (const d of entry.details?.decisions ?? []) countDecision(this.db, d.kind, 'corrected');
      }
      markCorrected(this.db, logId);
    });
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
    const vatReserve = Math.max(0, -this.ledger.balances().filter((b) => b.category === 'btw').reduce((sum, b) => sum + b.balance, 0));
    const pot = s.vatPotAccountId ? bankAccounts.find((a) => a.id === s.vatPotAccountId) ?? null : null;
    const setAside = pot ? this.ledger.balance(pot.rgs_code) : 0;
    const vatPot = pot ? { account: pot.name, setAside, stillToReserve: Math.max(0, vatReserve - setAside) } : null;
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
      money: { bank: ledgerBank + pending, toReceive, toPay, vatReserve, vatPot, freeToSpend: ledgerBank + pending - vatReserve - toPay },
      bankUpdatedTo,
      vat: { periodLabel: current.label, deadline, deadlineLabel: formatDateNl(deadline), estimate: this.vat.calculate(current.key).summary.teBetalen },
      tasks,
      checklist,
      upToDate: tasks.length === 0,
      processedToday: { bankChecked: (this.db.prepare(`SELECT COUNT(*) AS n FROM bank_transactions WHERE date(created_at) = date('now')`).get() as { n: number }).n },
      automated: recentAutomation(this.db),
      monthCounts: {
        automatic: automationForMonth(this.db, asOf.slice(0, 7), 'systeem').filter((e) => e.status === 'auto').length,
        byUser: automationForMonth(this.db, asOf.slice(0, 7), 'gebruiker').length,
        attention: tasks.length,
      },
    };
  }
}
