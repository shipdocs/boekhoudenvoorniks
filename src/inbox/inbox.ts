import type { Db } from '../db/database';
import { tx } from '../db/database';
import type { Ledger } from '../core-ledger/ledger';
import { ACCOUNTS } from '../core-ledger/accounts';
import type { BankService, BankTransaction } from '../import/bank';
import type { MatchingEngine } from '../import/matching';
import type { InvoiceService } from '../documents/invoices';
import type { QuoteService } from '../documents/quotes';
import type { JobService } from '../jobs/jobs';
import type { IntakeDocument, IntakeService } from '../intake/intake';
import { PROPOSED_BY_LABEL, type Classification } from '../intake/classify';
import { ASK_AUTO_AFTER_CONFIRMATIONS, supplierKey, type SupplierMemory } from '../intake/supplier-memory';
import type { PurchaseService } from '../documents/purchases';
import type { RecurringService } from '../import/recurring';
import { normalizeIban, ValidationError } from '../shared/validation';
import type { VatService } from '../btw/btw';
import type { SettingsService } from '../settings/settings';
import { PRIVATE_CAR_CATEGORIES, type CategoryLookup } from '../shared/categories';
import { KNOWN_SUPPLIERS } from '../intake/suppliers';
import { addDays, diffDays, formatDateNl, periodFor, today, vatDeadline, type IsoDate } from '../shared/dates';

/** Na zoveel dagen zonder nieuwe bankgegevens vragen we om een afschrift in te lezen. */
export const BANK_STALE_DAYS = 14;
/** Zoveel dagen vóór de vervaldatum herinneren we aan het betalen van een rekening. */
export const PAY_REMINDER_DAYS = 3;
import { formatEuro, type Cents } from '../shared/money';
import { saleVatText } from '../shared/vat';
import { automationForMonth, countDecision, getAutomation, logAutomation, markCorrected, recentAutomation, type AutomationEntry } from './automation-log';
import { explain } from '../automation/explain';
import type { InvestmentCheck } from '../tax/investment-check';
import type { MailIntakeService } from '../mail/mail-intake';
import type { BookedPayments } from '../documents/booked-payment';
import type { FxRepair } from '../fx/repair';


export type TaskKind =
  | 'setup'
  | 'bank-invoice'
  | 'bank-purchase'
  | 'bank-category'
  | 'bank-business'
  | 'bank-income'
  | 'bank-sale'
  | 'document-review'
  | 'invoice-overdue'
  | 'invoice-concept'
  | 'job-done'
  | 'quote-expired'
  | 'vat-due'
  | 'bank-stale'
  | 'bank-locked'
  | 'exchange-conflict'
  | 'vat-suppletie'
  | 'supplier-auto'
  | 'vat-check'
  | 'purchase-due'
  | 'bank-pot'
  | 'bank-own'
  | 'bank-refund'
  | 'customer-overpaid'
  | 'job-link'
  | 'recurring-confirm'
  | 'recurring-missing-payment'
  | 'recurring-stopped'
  | 'recurring-invoice'
  | 'investment-check'
  | 'fx-repair'
  | 'purchase-double'
  | 'mail-online'
  | 'mail-customer';

export interface TaskAction {
  id: string;
  label: string;
  primary?: boolean;
  /** wat deze keuze in je boekhouding doet, in gewone taal */
  hint?: string;
}

/** Eén ding dat de aandacht van de gebruiker nodig heeft, in mensentaal. */
/** Een factuur of inkoop die de boekhouder terugdraaide terwijl er al op betaald was (ExchangeService.readAnswer). */
export interface ExchangeConflict {
  kind: 'factuur' | 'inkoop';
  id: number;
  label: string;
  paid: Cents;
  exchange: number;
  office: string;
}

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
  ref: { relationId?: number; lineId?: number; seriesId?: number; checkKey?: string; bankAccountId?: number; bankTransactionId?: number; invoiceId?: number; purchaseId?: number; documentId?: number; mailId?: number; account?: string; upTo?: string; jobId?: number; quoteId?: number; periodKey?: string; supplierKey?: string; categoryKey?: string; vatCode?: string;
    /** het getoonde voorstel (bon): "Ja" voert alleen dit uit, niet een intussen gewijzigd voorstel (#132) */
    proposal?: string };
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
/** Waar een LLM-voorstel vandaan komt, in de vraag op Vandaag (regels en geheugen noemt "Waarom?" al). */
function proposalNote(c: Classification): string {
  return c.proposedBy === 'jev' || c.proposedBy === 'ollama' ? ` (voorstel van ${PROPOSED_BY_LABEL[c.proposedBy]})` : '';
}

/** Vingerafdruk van wat "Ja" bij een bon zal boeken: categorie, btw, zakelijk en de gekoppelde betaling. */
export function documentProposal(d: Pick<IntakeDocument, 'classification' | 'bank_match'>): string | undefined {
  const c = d.classification;
  return c ? [c.categoryKey, c.vatCode, c.business ? 'zakelijk' : 'prive', d.bank_match?.id ?? '-'].join('|') : undefined;
}

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
    private readonly categories: CategoryLookup,
    private readonly investments?: InvestmentCheck,
    private readonly mail?: MailIntakeService,
  ) {}

  private booked: BookedPayments | null = null;
  setBookedPayments(booked: BookedPayments): void {
    this.booked = booked;
  }

  private fxRepair: FxRepair | null = null;
  setFxRepair(repair: FxRepair): void {
    this.fxRepair = repair;
  }

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
    // de kopie bij de boekhouder boekt niets zelf
    if (this.settings.officeCopy()) return { matched: 0, booked: 0 };
    this.recurring.detect(); // vaste lasten herkennen (alleen voorstellen, niets boeken)
    const level = this.settings.get().autopilot;
    // dubbel geboekte aankopen herstellen: geen nieuwe beslissing, dus ook bij "voorzichtig"
    if (level === 'voorzichtig') return { matched: 0, booked: this.booked?.repair(asOf).length ?? 0 }; // alles blijft geel: de gebruiker bevestigt
    let booked = this.autoOwnTransfers();
    const auto = this.matching.autoMatch(asOf, level);
    const matched = auto.matched;
    for (const d of auto.details) {
      const explanation = explain([{ type: 'matching', label: d.reasons.join(', ') || 'bedrag en omschrijving overeenkwamen', value: d.confidence }]);
      logAutomation(this.db, { kind: 'bank-match', ref_id: d.txId, summary: `Betaling hoort bij ${d.label}`, reason: explanation.sentence, details: explanation });
      countDecision(this.db, 'bankkoppeling', 'automatic');
    }
    const firstOpen = this.ledger.firstOpenDate();
    for (const t of this.bank.list({ status: 'nieuw', limit: 5000 })) {
      if (t.amount >= 0 || !t.counter_name) continue;
      if (firstOpen && t.transaction_date < firstOpen) continue; // vergrendelde periode: niet boeken
      if (this.bank.ownTransferTarget(t)) continue; // eigen overboeking: nooit als kosten
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
          const label = rule!.business ? this.categories.label(rule!.category_key) : 'privé';
          const explanation = explain([
            { type: 'leveranciersregel', label: `je ${rule!.confirmations}× ${rule!.display_name} als ${label} hebt bevestigd en hebt gezegd dat dit voortaan automatisch mag`, value: 0.97 },
          ]);
          logAutomation(this.db, {
            kind: 'bank-auto',
            ref_id: t.id,
            summary: `${formatEuro(-t.amount)} aan ${rule!.display_name} verwerkt als ${label}`,
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
    // aankopen die privé betaald staan, terwijl de betaling al op een eigen rekening geboekt is
    booked += this.booked?.repair(asOf).length ?? 0;
    return { matched, booked };
  }

  /**
   * Overboekingen tussen eigen rekeningen: het rekeningnummer aan de andere kant is een van je eigen
   * rekeningen, dus dit is zeker geen omzet of kosten. Wat de gebruiker eerder terugdraaide
   * ("klopt niet"), blijft een vraag.
   */
  private autoOwnTransfers(): number {
    let n = 0;
    const firstOpen = this.ledger.firstOpenDate();
    for (const t of this.bank.list({ status: 'nieuw', limit: 5000 })) {
      if (firstOpen && t.transaction_date < firstOpen) continue; // vergrendelde periode: niet boeken
      const other = this.bank.ownTransferTarget(t);
      if (this.db.prepare(`SELECT 1 FROM automation_log WHERE kind = 'bank-own' AND ref_id = ? AND status = 'klopt_niet'`).get(t.id)) continue;
      if (!other) {
        // geen rekeningnummer, maar de andere kant boekte het al als overboeking naar deze rekening
        const linked = tx(this.db, () => {
          if (!this.bank.linkBookedOwnTransfer(t.id)) return false;
          const own = this.bank.getAccount(t.bank_account_id);
          const explanation = explain([{ type: 'bankbetaling', label: `dezelfde overboeking op je andere rekening al verwerkt is als geld ${t.amount < 0 ? 'van' : 'naar'} ${own.name}`, value: 0.97 }]);
          logAutomation(this.db, { kind: 'bank-own', ref_id: t.id, summary: `${formatEuro(Math.abs(t.amount))} tussen je eigen rekeningen: geen omzet of kosten`, reason: explanation.sentence, details: explanation });
          return true;
        });
        if (linked) n++;
        continue;
      }
      try {
        tx(this.db, () => {
          this.bank.bookOwnTransfer(t.id);
          const explanation = explain([{ type: 'bankbetaling', label: `het geld ${t.amount < 0 ? 'naar' : 'van'} je eigen rekening ${other.name} ging`, value: 0.99 }]);
          logAutomation(this.db, {
            kind: 'bank-own',
            ref_id: t.id,
            summary: `${formatEuro(Math.abs(t.amount))} ${t.amount < 0 ? 'naar' : 'van'} je rekening ${other.name}: geen omzet of kosten`,
            reason: explanation.sentence,
            details: explanation,
          });
        });
        n++;
      } catch {
        // bv. afgesloten periode: laat staan als vraag
      }
    }
    return n;
  }

  private bookCategory(t: BankTransaction, categoryKey: string, vatCode: string, business: boolean, learn: boolean, businessPct?: number): void {
    const name = t.counter_name ?? t.description;
    if (!business) {
      this.bank.bookToAccount(t.id, { account: t.amount < 0 ? ACCOUNTS.priveOpnamen : ACCOUNTS.priveStortingen, description: `Privé: ${name}` });
    } else {
      const category = this.categories.find(categoryKey);
      if (!category) throw new Error(`Onbekende categorie ${categoryKey}`);
      this.bank.bookToAccount(t.id, { account: category.account, vatCode, description: `${category.label} — ${name}`, ...(businessPct !== undefined ? { businessPct } : {}) });
    }
    if (learn && t.counter_name) this.memory.learn(t.counter_name, { categoryKey, vatCode, business });
  }

  /** De gebruiker beantwoordt een vraag uit de inbox. */
  answerBank(bankTransactionId: number, answer: { business: boolean; categoryKey?: string; vatCode?: string; businessPct?: number }): void {
    const t = this.bank.get(bankTransactionId);
    const category = answer.categoryKey ?? 'overig';
    const vatCode = answer.vatCode ?? this.categories.find(category)?.defaultVat ?? 'hoog';
    this.bookCategory(t, category, vatCode, answer.business, true, answer.businessPct);
  }

  /** Met een privéauto zijn autokosten (tanken, parkeren, onderhoud) privé: je krijgt een bedrag per zakelijke km. */
  private fuelIsPrivate(categoryKey: string): boolean {
    return PRIVATE_CAR_CATEGORIES.includes(categoryKey) && this.settings.get().carUse === 'prive';
  }

  private suggestionFor(t: BankTransaction): { categoryKey: string; vatCode: string; business: boolean; confident: boolean; why: string } | null {
    const sug = this.rawSuggestionFor(t);
    if (sug && sug.business && this.fuelIsPrivate(sug.categoryKey)) {
      return { ...sug, business: false, confident: false, why: 'Je rijdt met een privéauto: tanken, parkeren en onderhoud zijn dan privé. Zakelijke kilometers vul je in bij Belasting → Aftrek → Kilometers.' };
    }
    return sug;
  }

  private rawSuggestionFor(t: BankTransaction): { categoryKey: string; vatCode: string; business: boolean; confident: boolean; why: string } | null {
    const rule = t.counter_name ? this.memory.get(t.counter_name) : null;
    if (rule) {
      const label = this.categories.label(rule.category_key);
      return { categoryKey: rule.category_key, vatCode: rule.vat_code, business: Boolean(rule.business), confident: rule.confirmations >= 1, why: `Omdat je ${rule.display_name} eerder ${rule.confirmations}× als ${label} hebt bevestigd.` };
    }
    const known = KNOWN_SUPPLIERS.find((k) => k.pattern.test(`${t.counter_name ?? ''} ${t.description}`));
    if (known) return { categoryKey: known.category, vatCode: known.vatCode, business: true, confident: false, why: 'Omdat de naam lijkt op een bekende winkel.' };
    return null;
  }

  tasks(asOf: IsoDate = today()): Task[] {
    // in de kopie bij de boekhouder zijn de vragen van de klant niet aan hem; zijn werk staat in de balk
    if (this.settings.officeCopy()) return [];
    const tasks: Task[] = [];
    const s = this.settings.get();
    if (!s.onboardingDone || !s.company.name) {
      tasks.push({ key: 'setup', kind: 'setup', icon: '👋', title: 'Maak je bedrijf compleet', question: 'We hebben nog een paar gegevens nodig voor je facturen.', actions: [{ id: 'open', label: 'Afronden', primary: true }], ref: {} });
    }

    const overpaid = this.invoices.overpaidCustomers();
    // rekeningnummers van klanten met tegoed: het IBAN bij de klant én waarmee eerder facturen betaald zijn
    // (ook bij een gearchiveerde klant of een ander rekeningnummer)
    const refundIbans = new Map<string, number>();
    if (overpaid.length > 0) {
      const ids = overpaid.map((o) => o.relationId);
      const rows = this.db
        .prepare(
          `SELECT id AS relationId, iban FROM relations WHERE iban IS NOT NULL AND id IN (${ids.map(() => '?').join(',')})
           UNION SELECT i.relation_id, b.counter_iban FROM bank_transactions b JOIN invoices i ON i.id = b.matched_invoice_id
           WHERE b.counter_iban IS NOT NULL AND i.relation_id IN (${ids.map(() => '?').join(',')})`,
        )
        .all(...ids, ...ids) as { relationId: number; iban: string }[];
      for (const r of rows) refundIbans.set(normalizeIban(r.iban), r.relationId);
    }
    // betalingen in een vergrendelde periode kun je niet meer indelen: één melding in plaats van een vraag per betaling
    const firstOpen = this.ledger.firstOpenDate();
    const locked = { afgesloten: 0, uitwisseling: 0 };
    for (const t of this.bank.list({ status: 'nieuw', limit: 200 })) {
      if (firstOpen && t.transaction_date < firstOpen) {
        locked[this.ledger.periodLockFor(t.transaction_date)?.kind ?? 'afgesloten']++;
        continue;
      }
      const who = t.counter_name || t.description.slice(0, 40) || 'Onbekend';
      // terugbetaling aan een klant die te veel betaalde: geen kosten
      if (t.amount < 0 && t.counter_iban) {
        const relationId = refundIbans.get(normalizeIban(t.counter_iban));
        const credit = relationId ? overpaid.find((o) => o.relationId === relationId) : undefined;
        const rel = credit ? { id: credit.relationId, name: credit.name } : undefined;
        if (rel && credit && -t.amount <= credit.amount && !this.isSkipped(`bank-refund-${t.id}`)) {
          tasks.push({
            key: `bank-${t.id}`,
            kind: 'bank-refund',
            icon: '↩️',
            title: `${formatEuro(-t.amount)} terugbetaald aan ${rel.name}?`,
            question: `${rel.name} had ${formatEuro(credit.amount)} te veel betaald. Een terugbetaling is geen kosten.`,
            amount: t.amount,
            actions: [{ id: 'klopt', label: 'Klopt, terugbetaling', primary: true }, { id: 'anders', label: 'Nee, iets anders' }],
            ref: { bankTransactionId: t.id, relationId: rel.id },
          });
          continue;
        }
      }
      // overboeking tussen eigen rekeningen eerst: geld uit je spaarrekening of potje is geen omzet
      const other = this.bank.ownTransferTarget(t);
      if (other) {
        const potSide = s.vatPotAccountId === other.id ? 'naar' : s.vatPotAccountId === t.bank_account_id ? 'van' : null;
        if (potSide) {
          const intoPot = potSide === 'naar' ? t.amount < 0 : t.amount > 0;
          tasks.push({
            key: `bank-${t.id}`,
            kind: 'bank-pot',
            icon: '🐷',
            title: `${formatEuro(Math.abs(t.amount))} ${intoPot ? 'naar' : 'uit'} je belastingpotje`,
            question: intoPot ? 'Opzijgezet voor de btw. Dit telt niet als kosten.' : 'Terug van je belastingpotje (bv. om de btw te betalen). Dit is geen omzet.',
            amount: t.amount,
            actions: [{ id: 'klopt', label: 'Klopt', primary: true }],
            group: { key: 'bank-pot', label: 'Alle overboekingen met je potje' },
            ref: { bankTransactionId: t.id },
          });
        } else {
          tasks.push({
            key: `bank-${t.id}`,
            kind: 'bank-own',
            icon: '🔁',
            title: `${formatEuro(Math.abs(t.amount))} ${t.amount < 0 ? 'naar' : 'van'} je rekening ${other.name}`,
            question: 'Geld verplaatst tussen je eigen rekeningen. Dit is geen omzet en geen kosten.',
            amount: t.amount,
            actions: [{ id: 'klopt', label: 'Klopt', primary: true }],
            group: { key: 'bank-own', label: 'Alle overboekingen tussen je eigen rekeningen' },
            ref: { bankTransactionId: t.id },
          });
        }
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
          question: `Dit lijkt de betaling van ${inv.label.replace(/ — .*/, '').toLowerCase()}.`,
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
          question: `Hoort dit bij ${pur.label.replace(/^(Inkoop|Aankoop) /, '')}?`,
          amount: t.amount,
          actions: [{ id: 'klopt', label: 'Klopt', primary: true }, { id: 'nee', label: 'Nee' }],
          group: { key: 'bank-purchase', label: 'Alle betalingen koppelen' },
          why: `Omdat ${pur.reasons.join(', ')}.`,
          ref: { bankTransactionId: t.id, purchaseId: pur.purchaseId },
        });
        continue;
      }
      const sale = t.amount > 0 ? this.bank.previousSale(t.id) : null;
      if (sale) {
        tasks.push({
          key: `bank-${t.id}`,
          kind: 'bank-sale',
          icon: '💶',
          title: `${formatEuro(t.amount)} ontvangen van ${who}`,
          question: `Weer een verkoop${sale.channel ? ` via ${sale.channel}` : ''}, net als vorige keer (${saleVatText(sale.vatCode)})?`,
          amount: t.amount,
          actions: [{ id: 'klopt', label: 'Klopt', primary: true }, { id: 'anders', label: 'Iets anders' }],
          group: { key: `bank-sale:${t.counter_iban ?? supplierKey(who)}`, label: `Alle van ${who}: verkoop` },
          why: `Omdat je geld van ${who} op ${formatDateNl(sale.date)} ook als verkoop verwerkte.`,
          ref: { bankTransactionId: t.id },
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
        const label = this.categories.label(sug.categoryKey);
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
        const guess = sug ? this.categories.label(sug.categoryKey) : null;
        tasks.push({
          key: `bank-${t.id}`,
          kind: 'bank-business',
          icon: '🧾',
          title: `${who} ${formatEuro(-t.amount)}`,
          question: sug && !sug.business && this.fuelIsPrivate(sug.categoryKey) ? 'Autokosten van je privéauto tellen als privé; je zakelijke kilometers vul je apart in.' : guess ? `Was dit zakelijk (${guess}) of privé?` : 'Was dit zakelijk of privé?',
          amount: t.amount,
          actions: sug && !sug.business && this.fuelIsPrivate(sug.categoryKey)
            ? [{ id: 'prive', label: 'Privé', primary: true }, { id: 'zakelijk', label: 'Toch zakelijk' }]
            : [{ id: 'zakelijk', label: 'Zakelijk', primary: true }, { id: 'prive', label: 'Privé' }],
          why: sug && !sug.business && this.fuelIsPrivate(sug.categoryKey) ? sug.why : undefined,
          ref: { bankTransactionId: t.id, categoryKey: sug?.categoryKey, vatCode: sug?.vatCode },
        });
      }
    }

    // na het antwoord van de boekhouder: iets teruggedraaid waarop al betaald was
    const conflicts = this.db.prepare(`SELECT value FROM settings WHERE key = 'exchangeConflicts'`).get() as { value: string } | undefined;
    for (const c of conflicts ? (JSON.parse(conflicts.value) as ExchangeConflict[]) : []) {
      const key = `exchange-conflict-${c.exchange}-${c.kind}-${c.id}`;
      if (this.isSkipped(key)) continue;
      tasks.push({
        key,
        kind: 'exchange-conflict',
        icon: '⚠️',
        title: `${c.kind === 'factuur' ? 'Factuur' : 'Inkoop'} ${c.label}: teruggedraaid door ${c.office}`,
        question: `Je boekhouder heeft ${c.kind === 'factuur' ? 'deze factuur' : 'deze inkoop'} in uitwisseling ${c.exchange} teruggedraaid, maar er is ${formatEuro(c.paid)} op betaald. Vraag hem hoe je die betaling verwerkt, en vink dit daarna af.`,
        amount: c.paid,
        priority: 1,
        actions: [{ id: 'open', label: 'Bekijken', primary: true }, { id: 'klaar', label: 'Afgehandeld' }],
        ref: c.kind === 'factuur' ? { invoiceId: c.id } : { purchaseId: c.id },
      });
    }

    const lock = this.ledger.periodLock();
    for (const kind of ['afgesloten', 'uitwisseling'] as const) {
      const n = locked[kind];
      if (n === 0) continue;
      const until = kind === 'afgesloten' ? lock.closedUntil : lock.exchange?.until;
      tasks.push({
        key: `bank-locked-${kind}`,
        kind: 'bank-locked',
        icon: '🔒',
        title: `${n} ${n === 1 ? 'betaling' : 'betalingen'} in ${kind === 'afgesloten' ? 'de afgesloten periode' : 'de periode bij je boekhouder'}`,
        question: kind === 'afgesloten'
          ? `${n === 1 ? 'Deze betaling valt' : 'Deze betalingen vallen'} vóór ${until ? formatDateNl(addDays(until, 1)) : 'de eerste open dag'}, in een periode die al is afgesloten. Er ontbrak waarschijnlijk een afschrift. Vraag je boekhouder hoe je ${n === 1 ? 'hem' : 'ze'} verwerkt.`
          : `Je kunt ${n === 1 ? 'hem' : 'ze'} verwerken als het antwoord van je boekhouder is ingelezen.`,
        actions: [{ id: 'open', label: 'Bekijken', primary: true }],
        ref: {},
      });
    }

    if (s.onboardingDone && s.profile.hasBusinessAccount) {
      for (const st of this.bank.importStatus()) {
        const days = st.coverageTo ? diffDays(st.coverageTo, asOf) : null;
        if (days !== null && days < BANK_STALE_DAYS) continue;
        tasks.push({
          key: `bank-stale-${st.bankAccountId}`,
          kind: 'bank-stale',
          icon: '🏦',
          title: st.coverageTo ? `${st.name}: bank bijgewerkt tot ${formatDateNl(st.coverageTo)}` : `${st.name}: nog geen bankafschrift ingelezen`,
          question: st.coverageTo ? `Dat is ${days} dagen geleden. Download een nieuw afschrift bij je bank en sleep het in de app. Dan zoeken we uit wat bij welke factuur hoort.` : 'Lees een afschrift in, dan koppelen we betalingen automatisch aan je facturen en bonnetjes.',
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
        question: bad ? bad.message : d.classification ? `We denken: ${this.categories.label(d.classification!.categoryKey)}${d.classification.business ? '' : ' (privé)'}${proposalNote(d.classification)}. Alles klopt?` : 'Even controleren?',
        amount: d.result?.total?.value,
        actions: bad?.field === 'duplicate'
          ? [{ id: 'dubbel', label: 'Ja, zelfde', primary: true }, { id: 'open', label: 'Nee, bekijken' }]
          : bad ? [{ id: 'open', label: 'Bekijken', primary: true }] : [{ id: 'klopt', label: 'Ja', primary: true }, { id: 'open', label: 'Aanpassen' }],
        group: bad ? undefined : { key: 'document-klopt', label: 'Alle bonnetjes bevestigen' },
        why: d.classification ? `Omdat ${d.classification.reasons.map((x) => x.replace(/bewijsstuk bij banktransactie #\d+/, 'bon bij een betaling')).join(', ')}.` : undefined,
        ref: { documentId: d.id, categoryKey: d.classification?.business === false ? undefined : d.classification?.categoryKey, proposal: documentProposal(d) },
      });
    }

    // inkomende post: een factuur die online staat, of mail van een klant (die blijft ongelezen in je mailbox)
    for (const m of this.mail?.attention() ?? []) {
      const key = `mail-${m.id}`;
      if (this.isSkipped(key)) continue;
      const who = m.relation_name ?? m.from_name ?? m.from_address ?? 'Iemand';
      const subject = m.subject ? `"${m.subject}"` : 'Een bericht zonder onderwerp';
      // de inhoud van mail bewaart de app niet: afzender en datum, zodat je hem in je mailprogramma terugvindt
      const from = [m.from_address ? `van ${m.from_name ? `${m.from_name} <${m.from_address}>` : m.from_address}` : null, m.received_on ? `op ${formatDateNl(m.received_on)}` : null].filter(Boolean).join(', ');
      if (m.outcome === 'online-factuur') {
        tasks.push({
          key,
          kind: 'mail-online',
          icon: '📧',
          title: `${who}: factuur staat online`,
          question: `${subject}${from ? ` (${from})` : ''}. Er zat geen bijlage bij. Log in op ${m.link_domain} (typ het adres zelf in; klik bij twijfel niet op de link in de mail), download de factuur en zet hem bij Aankopen & bonnetjes. Staat de factuur in de mail zelf? Bewaar dan de mail als bon.`,
          actions: [{ id: 'open', label: 'Bonnetje toevoegen', primary: true }, { id: 'bon', label: 'Mail als bon bewaren' }, { id: 'klaar', label: 'Gedaan' }],
          priority: 2,
          ref: { mailId: m.id },
        });
      } else {
        tasks.push({
          key,
          kind: 'mail-customer',
          icon: '✉️',
          title: `Mail van ${who}`,
          question: `${subject}${from ? ` (${from})` : ''}. Staat in je administratie-mailbox; de app heeft hem niet aangeraakt. Beantwoord hem in je mailprogramma.`,
          actions: [{ id: 'klaar', label: 'Gezien', primary: true }, ...(m.relation_id ? [{ id: 'open', label: 'Bekijk klant' }] : [])],
          priority: 2,
          ref: { mailId: m.id, relationId: m.relation_id ?? undefined },
        });
      }
    }

    for (const o of this.invoices.overpaidCustomers()) {
      const key = `customer-overpaid-${o.relationId}-${o.amount}`;
      if (this.isSkipped(key)) continue;
      tasks.push({
        key,
        kind: 'customer-overpaid',
        icon: '💶',
        title: `${o.name} heeft ${formatEuro(o.amount)} te veel betaald`,
        question: 'Bijvoorbeeld een factuur twee keer betaald. Maak het terug over; zodra die betaling op je bankafschrift staat, koppelt de app hem aan deze klant. Spreek je af dat het van de volgende factuur afgaat? Vraag je boekhouder hoe je dat verwerkt.',
        amount: o.amount,
        actions: [{ id: 'open', label: 'Bekijk klant', primary: true }, { id: 'klopt', label: 'Klopt, laat staan' }],
        priority: 2,
        ref: { relationId: o.relationId },
      });
    }

    for (const inv of this.invoices.list({ status: 'vervallen' }, asOf)) {
      tasks.push({
        key: `overdue-${inv.id}`,
        kind: 'invoice-overdue',
        icon: '⏰',
        title: `${inv.relation_name} moet nog ${formatEuro(inv.open_amount)} betalen`,
        question: `Factuur ${inv.number} is te laat (had betaald moeten zijn op ${formatDateNl(inv.due_date)}).`,
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
        question: `Offerte ${q.number} van ${formatDateNl(q.quote_date)}${q.total ? `, ${formatEuro(q.total)}` : ''}, was geldig tot ${formatDateNl(q.valid_until)}. Heeft de klant ja gezegd?`,
        amount: q.total,
        actions: [{ id: 'akkoord', label: 'Ja, akkoord', primary: true }, { id: 'afgewezen', label: 'Nee' }, { id: 'open', label: 'Bekijken' }],
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
        const seen = this.recurring.state(series, asOf).payments.slice(-4).reverse();
        tasks.push({
          key: `recurring-${series.id}`,
          kind: 'recurring-confirm',
          icon: '🔁',
          title: `${series.counter_name} lijkt een vaste last`,
          question: `Ongeveer ${label}. Als vaste last letten we erop dat de factuur en de betaling elke keer binnenkomen.`,
          actions: [{ id: 'ja', label: 'Ja, vaste last', primary: true }, { id: 'nee', label: 'Nee' }],
          priority: 3,
          why: seen.length ? `Omdat we deze betalingen zagen: ${seen.map((p) => `${formatDateNl(p.transaction_date)} ${formatEuro(Math.abs(p.amount))}`).join(', ')}.` : undefined,
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
            question: `De laatste ${st.missed.length} verwachte betalingen (${label}) zijn niet van je rekening gegaan.${st.lastSeen ? ` De laatste betaling die we zagen was op ${formatDateNl(st.lastSeen)}.` : ''}`,
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
            title: `Betaling aan ${series.counter_name} niet gezien`,
            question: `Rond ${formatDateNl(due)} verwachtten we ongeveer ${formatEuro(series.amount)}. Heb je je nieuwste bankafschrift al ingelezen?`,
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
          question: `Er is ${formatEuro(-t.amount)} van je rekening gegaan op ${formatDateNl(t.transaction_date)}, maar we missen de factuur.`,
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
        const late = deadline < asOf;
        const amount = `${report.summary.teBetalen >= 0 ? 'betalen' : 'terugkrijgen'} ongeveer ${formatEuro(Math.abs(report.summary.teBetalen))}`;
        tasks.push({
          key: `vat-${previous.key}`,
          kind: 'vat-due',
          icon: '📮',
          title: late ? `Btw-aangifte ${previous.label}: had uiterlijk ${formatDateNl(deadline)} binnen moeten zijn` : `Btw-aangifte ${previous.label} doen`,
          question: late
            ? `Al gedaan, bijvoorbeeld via Mijn Belastingdienst of je boekhouder? Vink hem dan af. Nog niet? Doe hem zo snel mogelijk (${amount}).`
            : `Uiterlijk ${formatDateNl(deadline)}: ${amount}. Al gedaan buiten de app? Vink hem dan af.`,
          amount: report.summary.teBetalen,
          actions: late
            ? [{ id: 'ingediend', label: 'Al ingediend', primary: true }, { id: 'open', label: 'Aangifte bekijken' }]
            : [{ id: 'open', label: 'Aangifte bekijken', primary: true }, { id: 'ingediend', label: 'Al ingediend' }],
          priority: 1,
          ref: { periodKey: previous.key },
        });
        // Controles vóór de aangifte (#20): in dezelfde lijst, blokkerend tot opgelost of bewust overgeslagen.
        // Na de uiterste datum niet meer los: dan is de vraag eerst of de aangifte al gedaan is.
        for (const c of late ? [] : this.vat.checks(previous.key).filter((x) => !x.skipped)) {
          tasks.push({
            key: `vat-check-${previous.key}-${c.key}`,
            kind: 'vat-check',
            icon: c.blocking ? '⚠️' : '💡',
            title: c.title,
            question: `${c.detail}${c.blocking ? ` Nodig voor de btw-aangifte ${previous.label}.` : ''}`,
            actions: [{ id: 'open', label: 'Oplossen', primary: true }, { id: 'overslaan', label: c.blocking ? 'Bewust overslaan' : 'Klopt' }],
            priority: 1,
            ref: { periodKey: previous.key, checkKey: c.key, account: c.account?.rgs, upTo: c.account?.upTo },
          });
        }
      }
    }
    const askAfter = s.autopilot === 'voorzichtig' ? Number.POSITIVE_INFINITY : s.autopilot === 'maximaal' ? 2 : ASK_AUTO_AFTER_CONFIRMATIONS;
    for (const rule of Number.isFinite(askAfter) ? this.memory.pendingApprovals(askAfter) : []) {
      const label = rule.business ? this.categories.label(rule.category_key) : 'privé';
      tasks.push({
        key: `supplier-auto-${rule.supplier_key}`,
        kind: 'supplier-auto',
        icon: '🤖',
        title: `${rule.display_name} is bij jou altijd ${label}`,
        question: `Je koos dit al ${rule.confirmations} keer. Wil je dat de app dit voortaan zelf doet? Je ziet het terug op Vandaag en kunt het altijd terugdraaien.`,
        actions: [{ id: 'ja', label: 'Ja, voortaan automatisch', primary: true }, { id: 'nee', label: 'Nee, blijf het vragen' }],
        why: (() => {
          const recent = this.bank.list({ search: rule.display_name, limit: 5 }).filter((b) => b.status === 'gematcht');
          return recent.length ? `De laatste betalingen: ${recent.map((b) => `${formatDateNl(b.transaction_date)} ${formatEuro(Math.abs(b.amount))}`).join(', ')}. Zat daar iets privé tussen, kies dan "Nee".` : undefined;
        })(),
        ref: { supplierKey: rule.supplier_key },
      });
    }

    // vangnet: € 450+ als gewone kosten geboekt in een categorie waar dat vaak een investering is
    for (const c of this.investments?.candidates(asOf) ?? []) {
      const key = `investment-${c.lineId}`;
      if (this.isSkipped(key)) continue;
      tasks.push({
        key,
        kind: 'investment-check',
        icon: '🧰',
        title: `Was dit een investering? ${formatEuro(c.amount)} — ${c.description}`,
        question: 'Gaat dit langer dan een jaar mee (machine, laptop, telefoon, steiger)? Kies dan "Ja". Verder hoef je niets te doen.',
        amount: -c.amount,
        actions: [{ id: 'ja', label: 'Ja, investering', primary: true }, { id: 'nee', label: 'Nee, gewone kosten' }],
        why: 'Kost iets € 450 of meer (zonder btw) en gebruik je het jaren? Dan telt de app de kosten verdeeld over 5 jaar. De btw krijg je gewoon meteen terug, en je krijgt misschien 28% extra aftrek.',
        priority: 3,
        ref: { lineId: c.lineId, purchaseId: c.purchaseId ?? undefined, bankTransactionId: c.bankTransactionId ?? undefined },
      });
    }

    // privé/contant betaald gezet, en een afschrijving met hetzelfde bedrag staat al als kosten op je rekening
    for (const c of this.booked?.candidates().filter((x) => !x.certain) ?? []) {
      const key = `dubbel-${c.purchase.id}-${c.bankTransaction.id}`;
      if (this.isSkipped(key)) continue;
      const name = c.purchase.relation_name ?? c.purchase.description;
      const account = this.bank.getAccount(c.bankTransaction.bank_account_id).name;
      tasks.push({
        key,
        kind: 'purchase-double',
        icon: '👯',
        title: `${name}: staat deze aankoop dubbel?`,
        question: `De bon van ${formatDateNl(c.purchase.invoice_date)} (${formatEuro(c.purchase.total)}) staat op betaald met privégeld of contant. Op ${account} staat op ${formatDateNl(c.bankTransaction.transaction_date)} ook ${formatEuro(-c.bankTransaction.amount)} aan ${c.bankTransaction.counter_name ?? name}, al geboekt als kosten. Is dat dezelfde betaling?`,
        amount: -c.purchase.total,
        actions: [
          { id: 'ja', label: 'Ja, dezelfde betaling', primary: true },
          { id: 'nee', label: 'Nee, twee aankopen' },
        ],
        why: 'Anders tellen de kosten en de btw twee keer.',
        priority: 1,
        ref: { purchaseId: c.purchase.id, bankTransactionId: c.bankTransaction.id },
      });
    }

    // vangnet (#74): met een oudere versie als euro's geboekt, maar de bon is in bv. dollars
    const foreign = (this.fxRepair?.candidates().length ?? 0) + (this.fxRepair?.pendingDocuments().length ?? 0);
    if (foreign > 0) {
      tasks.push({
        key: 'fx-repair',
        kind: 'fx-repair',
        icon: '💱',
        title: foreign === 1 ? 'Een bon in dollars (of een andere munt) staat als euro\'s in je boekhouding' : `${foreign} bonnen in dollars (of een andere munt) staan als euro's in je boekhouding`,
        question: 'De app rekent ze om naar wat er echt van je rekening is afgeschreven. Je ziet eerst wat er verandert.',
        actions: [{ id: 'open', label: 'Nakijken', primary: true }],
        why: 'Oudere versies van de app lazen "$ 90,00" als € 90,00. Daardoor klopt het bedrag niet en koppelt de betaling op de bank niet.',
        // eerst: anders boek je de afschrijving misschien los als kosten, naast de aankoop (dubbel)
        priority: 1,
        ref: {},
      });
    }

    for (const c of this.vat.corrections().filter((x) => x.suppletie)) {
      tasks.push({
        key: `suppletie-${c.periodKey}`,
        kind: 'vat-suppletie',
        icon: '📮',
        title: `Btw ${c.label} verbeteren`,
        question: `Er is achteraf ${formatEuro(Math.abs(c.btw))} btw ${c.btw >= 0 ? 'bijgekomen' : 'afgegaan'}. Dat is meer dan € 1.000. Dat verbeter je apart in Mijn Belastingdienst Zakelijk (dat heet een "suppletie": een verbetering van een oude aangifte).`,
        amount: c.btw,
        actions: [{ id: 'gedaan', label: 'Verbetering is verstuurd', primary: true }, { id: 'open', label: 'Bekijken' }],
        priority: 1,
        ref: { periodKey: c.periodKey },
      });
    }
    // stabiel sorteren op prioriteit; binnen een prioriteit blijft de volgorde gelijk
    for (const t of tasks) this.explainActions(t);
    return tasks.map((t, i) => ({ t, i })).sort((a, b) => (a.t.priority ?? 2) - (b.t.priority ?? 2) || a.i - b.i).map((x) => x.t);
  }

  /** Bij elke knop: wat er in je boekhouding gebeurt als je hem kiest. */
  private explainActions(t: Task): void {
    const cat = t.ref.categoryKey ? this.categories.label(t.ref.categoryKey) : null;
    const vatBack = t.ref.vatCode && !['geen', 'vrijgesteld'].includes(t.ref.vatCode) && !this.settings.get().kor ? ', de btw krijg je terug' : '';
    const asCost = cat ? `Wordt geboekt als ${cat}: telt mee als kosten${vatBack}.` : 'Je kiest daarna wat voor kosten het waren en of er btw op stond.';
    const hints: Record<string, string> = {
      'bank-business:zakelijk': asCost,
      'bank-business:prive': 'Geen kosten en geen btw: de betaling telt als privé.',
      'purchase-double:ja': 'De aankoop vervalt en de bon wordt het bewijsstuk bij de betaling op je rekening. De privé- of contante betaling wordt teruggedraaid.',
      'purchase-double:nee': 'Er verandert niets: het zijn twee aankopen. De app vraagt het niet meer.',
      'bank-category:klopt': asCost,
      'bank-category:anders': 'Je kiest zelf wat het wel was (andere kosten, privé, overboeking, …).',
      'bank-invoice:klopt': 'De betaling wordt aan de factuur gekoppeld; die staat daarna als betaald. Geen nieuwe omzet: die telde al bij de factuur.',
      'bank-invoice:nee': 'Je deelt de betaling zelf in.',
      'bank-purchase:klopt': 'De betaling wordt aan de aankoop gekoppeld; die staat daarna als betaald. De kosten telden al bij de aankoop.',
      'bank-purchase:nee': 'Je deelt de betaling zelf in.',
      'bank-sale:klopt': 'Wordt geboekt als omzet, met dezelfde btw als de vorige keer.',
      'bank-sale:anders': 'Je deelt de betaling zelf in.',
      'bank-refund:klopt': 'Geen kosten: het geld ging terug naar je klant.',
      'bank-refund:anders': 'Je deelt de betaling zelf in.',
      'bank-pot:klopt': 'Geen omzet en geen kosten: geld verplaatst binnen je eigen bank.',
      'bank-own:klopt': 'Geen omzet en geen kosten: geld verplaatst tussen je eigen rekeningen.',
      'bank-income:open': 'Je kiest waar het geld voor was: een factuur, een verkoop, rente, een refund, privé, …',
      'document-review:klopt': cat ? `De bon wordt geboekt als ${cat}.` : 'De bon wordt geboekt zoals voorgesteld.',
      'document-review:dubbel': 'De bon wordt niet nog een keer geboekt.',
      'document-review:open': 'Je ziet de bon en past aan wat niet klopt.',
      'quote-expired:akkoord': 'Er komt een klus bij voor deze offerte; als het werk klaar is maak je de factuur.',
      'quote-expired:afgewezen': 'De offerte gaat naar afgewezen. In je boekhouding verandert niets.',
      'recurring-confirm:ja': 'De app let voortaan op of de factuur en de betaling elke keer binnenkomen. Er wordt niets extra geboekt.',
      'recurring-confirm:nee': 'De app vraagt er niet meer naar.',
      'recurring-stopped:ja': 'De app verwacht deze betaling niet meer.',
      'recurring-stopped:nee': 'De app blijft de betaling verwachten.',
      'supplier-auto:ja': 'Betalingen aan deze leverancier boekt de app voortaan zelf zo. Je ziet ze bij "Automatisch gedaan" en kunt ze altijd terugdraaien.',
      'supplier-auto:nee': 'De app blijft het je elke keer vragen.',
      'investment-check:ja': 'Wordt een bedrijfsmiddel: de kosten worden over minstens 5 jaar verdeeld, en je krijgt misschien extra aftrek (KIA).',
      'investment-check:nee': 'Blijft gewone kosten in dit jaar.',
      'vat-check:open': 'Je gaat naar de plek waar je het oplost.',
      'vat-check:overslaan': 'De controle verdwijnt; de aangifte gaat door zoals het nu is.',
      'customer-overpaid:klopt': 'Het te veel betaalde blijft als tegoed van de klant staan.',
      'job-link:ja': 'De kosten tellen mee bij deze klus.',
      'job-link:algemeen': 'Hoort niet bij een klus: gewone bedrijfskosten.',
      'mail-online:bon': 'De mail wordt als bon bewaard; je controleert hem daarna.',
      'recurring-invoice:geen': 'De app vraagt voor deze betaling niet meer om een factuur.',
    };
    for (const a of t.actions) a.hint ??= hints[`${t.kind}:${a.id}`];
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
    if (entry.kind === 'dubbel-weg') throw new ValidationError('Dit was een dubbele aankoop die de app heeft weggehaald. Klopt dat niet? Voeg de bon dan opnieuw toe.');
    tx(this.db, () => {
      if (entry.kind === 'bank-own') {
        const t = this.bank.get(entry.ref_id!);
        if (t.status === 'gematcht') this.bank.unmatch(t.id, date);
      } else if (entry.kind === 'bank-match' || entry.kind === 'bank-auto') {
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
      { label: 'Alle betalingen verwerkt', ok: ![...kinds].some((k) => k.startsWith('bank-') && k !== 'bank-stale') },
      { label: 'Alle bonnetjes verwerkt', ok: !kinds.has('document-review') },
      { label: 'Geen facturen te laat', ok: !kinds.has('invoice-overdue') },
      { label: 'Btw-aangifte op tijd', ok: !kinds.has('vat-due') },
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
