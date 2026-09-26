import type { Db } from './db/database';
import { Ledger } from './core-ledger/ledger';
import { EventService } from './core-ledger/events';
import { RecurringService } from './import/recurring';
import { SettingsService } from './settings/settings';
import { RelationsService } from './relations/relations';
import { TemplateService } from './documents/templates';
import { InvoiceService } from './documents/invoices';
import { QuoteService } from './documents/quotes';
import { PurchaseService } from './documents/purchases';
import { DocumentSender, type Mailer, type PdfRenderer } from './documents/sending';
import { BankService } from './import/bank';
import { MatchingEngine } from './import/matching';
import { VatService } from './btw/btw';
import { DashboardService } from './dashboard/dashboard';
import { QuickActions } from './quick/quick';
import { IntegrationService } from './integrations/integrations';
import type { FetchLike, SecretStore } from './integrations/types';
import { AccountantExport } from './export/accountant';
import { SupplierMemory } from './intake/supplier-memory';
import { Classifier, type LlmClassifier } from './intake/classify';
import { IntakeService } from './intake/intake';
import type { OcrProvider } from './intake/ocr';
import { JobService } from './jobs/jobs';
import { InboxService } from './inbox/inbox';

export interface ServiceDeps {
  pdf: PdfRenderer;
  mailerFactory: () => Promise<Mailer>;
  secrets: SecretStore;
  fetch: FetchLike;
  /** slaat een bijlage/document op en geeft het pad terug */
  storeFile: (name: string, data: Uint8Array) => Promise<string>;
  ocr?: OcrProvider | null;
  llm?: LlmClassifier | null;
}

/** Composition root: bouwt alle modules op één database. */
export function createServices(db: Db, deps: ServiceDeps) {
  const ledger = new Ledger(db);
  const settings = new SettingsService(db);
  const relations = new RelationsService(db);
  const templates = new TemplateService(db);
  const invoices = new InvoiceService(db, ledger, settings, relations, templates);
  const quotes = new QuoteService(db, settings, relations, templates, invoices);
  const events = new EventService(db, ledger);
  const purchases = new PurchaseService(db, ledger, events);
  const sender = new DocumentSender(db, settings, invoices, quotes, deps.pdf, deps.mailerFactory);
  const bank = new BankService(db, ledger, invoices, purchases, relations, events);
  const matching = new MatchingEngine(bank, invoices, purchases, relations);
  const vat = new VatService(db, ledger, settings);
  const dashboard = new DashboardService(db, ledger, invoices, bank, vat);
  const quick = new QuickActions(db, ledger, purchases, invoices, relations);
  const integrations = new IntegrationService(db, ledger, invoices, relations, deps.secrets, deps.fetch);
  const exports = new AccountantExport(db, ledger);
  const memory = new SupplierMemory(db);
  const classifier = new Classifier(memory, deps.llm ?? null);
  const intake = new IntakeService(db, purchases, relations, bank, memory, classifier, deps.storeFile, deps.ocr ?? null, () => settings.get().autopilot);
  const recurring = new RecurringService(db, memory);
  const jobs = new JobService(db, quotes, invoices, relations);
  const inbox = new InboxService(db, ledger, settings, bank, matching, invoices, quotes, jobs, intake, memory, vat, purchases, recurring);

  ledger.seedDefaultAccounts();
  templates.seedDefaults();
  bank.ensureDefaultAccount();

  return { db, ledger, events, recurring, settings, relations, templates, invoices, quotes, purchases, sender, bank, matching, vat, dashboard, quick, integrations, exports, memory, classifier, intake, jobs, inbox };
}

export type Services = ReturnType<typeof createServices>;

export class MemorySecretStore implements SecretStore {
  private readonly map = new Map<string, string>();
  get(key: string) {
    return this.map.get(key) ?? null;
  }
  set(key: string, value: string) {
    this.map.set(key, value);
  }
  delete(key: string) {
    this.map.delete(key);
  }
}
