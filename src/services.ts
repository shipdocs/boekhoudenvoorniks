import type { Db } from './db/database';
import { Ledger } from './core-ledger/ledger';
import { EventService } from './core-ledger/events';
import { RecurringService } from './import/recurring';
import { IncomeTaxService } from './tax/income-tax';
import { AssetService } from './tax/assets';
import { HoursService, MileageService } from './tax/mileage';
import { TaxOverviewService } from './tax/overview';
import { InvestmentCheck } from './tax/investment-check';
import { SearchService } from './search/search';
import { SettingsService } from './settings/settings';
import { RelationsService } from './relations/relations';
import { TemplateService } from './documents/templates';
import { InvoiceService } from './documents/invoices';
import { QuoteService } from './documents/quotes';
import { PurchaseService } from './documents/purchases';
import { DocumentSender, type Mailer, type MailMessage, type PdfRenderer } from './documents/sending';
import { BankService } from './import/bank';
import { StatementFolder, type FolderAccess } from './import/statement-folder';
import { MatchingEngine } from './import/matching';
import { VatService } from './btw/btw';
import { DashboardService } from './dashboard/dashboard';
import { QuickActions } from './quick/quick';
import { IntegrationService } from './integrations/integrations';
import type { FetchLike, SecretStore } from './integrations/types';
import { PeriodCloseService } from './closing/period-close';
import { ExchangeService } from './exchange/exchange';
import { LicenseService } from './license/license';
import { AccountantExport } from './export/accountant';
import { AccountantPackage } from './export/accountant-package';
import { SupplierMemory } from './intake/supplier-memory';
import { BusinessShareService } from './intake/business-share';
import { LedgerReports } from './reports/ledger-reports';
import { Classifier, type LlmClassifier } from './intake/classify';
import { IntakeService } from './intake/intake';
import type { OcrProvider } from './intake/ocr';
import { JobService } from './jobs/jobs';
import { InboxService } from './inbox/inbox';
import { ChecklistService } from './onboarding/checklist';
import { SwitchoverService } from './onboarding/switchover';
import { XafImportService } from './onboarding/xaf-import';
import { CategoryService } from './settings/categories';
import { MailIntakeService } from './mail/mail-intake';
import { FxService } from './fx/fx';
import { FxRepair } from './fx/repair';
import { BookedPayments } from './documents/booked-payment';
import { BankPurchaseMatcher } from './documents/bank-purchase-match';
import { OwnCompanyPayments } from './documents/own-company';
import { BookedInfo } from './search/booked-info';

export interface ServiceDeps {
  pdf: PdfRenderer;
  mailerFactory: () => Promise<Mailer>;
  secrets: SecretStore;
  fetch: FetchLike;
  /** slaat een bijlage/document op en geeft het pad terug zoals het in de database komt: relatief aan de map van de administratie */
  storeFile: (name: string, data: Uint8Array) => Promise<string>;
  /** haalt een net bewaard bestand weer weg als het document toch niet vastgelegd kon worden (geen los bestand achterlaten) */
  removeFile?: (path: string) => void;
  ocr?: OcrProvider | null;
  llm?: LlmClassifier | null;
  /** lezen in de map met gedownloade afschriften (alleen in de app zelf); zonder kan de app daar niet kijken */
  statementFiles?: FolderAccess | null;
  /** publieke sleutel voor licenties (tests); standaard die van de licentie-Worker */
  licensePublicKey?: string;
}

/** Composition root: bouwt alle modules op één database. */
export function createServices(db: Db, deps: ServiceDeps) {
  const ledger = new Ledger(db);
  const settings = new SettingsService(db);
  const relations = new RelationsService(db);
  const categories = new CategoryService(db);
  const templates = new TemplateService(db);
  const invoices = new InvoiceService(db, ledger, settings, relations, templates);
  const quotes = new QuoteService(db, settings, relations, templates, invoices);
  const events = new EventService(db, ledger);
  const purchases = new PurchaseService(db, ledger, events);
  // in de demo gaat er nooit e-mail naar de (verzonnen) klanten, en in de kopie bij de boekhouder niet naar de echte
  const mailerFactory = async () => {
    if (settings.get().demoMode) throw new Error('In de demo worden geen e-mails verstuurd. Wis de demo om echt te beginnen.');
    if (settings.officeCopy()) throw new Error(settings.outboundBlocked()!);
    return deps.mailerFactory();
  };
  // koppelingen (webshop, Mollie, Stripe) halen in de kopie bij de boekhouder niets op: dat boekt de klant zelf
  const integrationFetch: FetchLike = (url, init) => {
    if (settings.officeCopy()) return Promise.reject(new Error(settings.outboundBlocked()!));
    return deps.fetch(url, init);
  };
  const sender = new DocumentSender(db, settings, invoices, quotes, deps.pdf, mailerFactory);
  const bank = new BankService(db, ledger, invoices, purchases, relations, events);
  // een betaling en een aankoop waarvan de gebruiker zei dat ze niet bij elkaar horen, stelt de app niet opnieuw voor
  const purchaseMatcher = new BankPurchaseMatcher(db);
  const matching = new MatchingEngine(bank, invoices, purchases, relations, purchaseMatcher);
  const vat = new VatService(db, ledger, settings);
  const dashboard = new DashboardService(db, ledger, invoices, bank, vat);
  const periods = new PeriodCloseService(db, ledger, bank);
  /** een losse e-mail met de instellingen van de gebruiker (bv. de export voor de boekhouder) */
  const sendMail = async (message: MailMessage) => (await mailerFactory()).send(message);
  const exchange = new ExchangeService(db, ledger, settings, periods, deps.secrets);
  const license = new LicenseService(db, settings, deps.licensePublicKey);
  const quick = new QuickActions(db, ledger, purchases, invoices, relations, categories);
  const integrations = new IntegrationService(db, ledger, invoices, relations, deps.secrets, integrationFetch);
  const exports = new AccountantExport(db, ledger);
  const accountantPackage = new AccountantPackage(db, ledger, exports, invoices, vat, settings, deps.pdf);
  const memory = new SupplierMemory(db);
  const businessShare = new BusinessShareService(db, bank, purchases, ledger);
  const ledgerReports = new LedgerReports(db);
  const classifier = new Classifier(memory, categories, deps.llm ?? null);
  const fx = new FxService(db, deps.fetch);
  const intake = new IntakeService(db, purchases, relations, bank, memory, classifier, categories, deps.storeFile, deps.ocr ?? null, () => settings.get().autopilot, () => settings.get().jobLocation, () => settings.get().carUse, () => settings.get().company.vatNumber);
  intake.setFx(fx);
  // handmatige invoer naast een aankoop of bon die er al staat: dezelfde dubbel-controle als bij een bon (#224)
  quick.setDuplicateCheck((entry) => intake.findDuplicateOfManual(entry));
  intake.setFileRemover(deps.removeFile ?? null);
  // je eigen bedrijf, om een factuur van jezelf en de betaling ervan te herkennen (#205)
  const ownIdentity = () => {
    const c = settings.get().company;
    return { name: c.name, vatNumber: c.vatNumber, kvkNumber: c.kvkNumber, ibans: [c.iban, ...bank.listAccounts().map((a) => a.iban ?? '')].filter(Boolean), email: c.email };
  };
  intake.setOwnIdentity(ownIdentity);
  // een verkoop aan je eigen bedrijf uit een koppeling wordt geen omzet, maar een vraag (#231)
  integrations.setOwnCompany(ownIdentity, bank);
  const ownCompany = new OwnCompanyPayments(db, bank, purchases, intake, ownIdentity);
  const recurring = new RecurringService(db, memory);
  const search = new SearchService(db);
  // "waar staat dit op?" bij zoekresultaten en in de lijsten
  const bookedInfo = new BookedInfo(db, () => settings.get().vatPeriod);
  search.setBookedInfo(bookedInfo);
  const assets = new AssetService(db, ledger);
  const mileage = new MileageService(db, ledger);
  const hours = new HoursService(db);
  const taxOverview = new TaxOverviewService(db, settings, assets, mileage, hours);
  const incomeTax = new IncomeTaxService(db, settings, { assets, overview: taxOverview });
  const jobs = new JobService(db, quotes, invoices, relations);
  const investments = new InvestmentCheck(db, purchases, bank);
  const mail = new MailIntakeService(db, settings, intake, async (html) => new Uint8Array(await deps.pdf(html)));
  const inbox = new InboxService(db, ledger, settings, bank, matching, invoices, quotes, jobs, intake, memory, vat, purchases, recurring, categories, investments, mail);
  // vreemde valuta in wat er al stond (#74): bonnen en aankopen van vóór 0.3.9 omrekenen
  const fxRepair = new FxRepair(db, fx, intake, purchases, bank);
  inbox.setFxRepair(fxRepair);
  // aankoop en afschrijving die dezelfde uitgave zijn (bv. de betaling al als kosten geboekt via een gemengde rekening)
  const bookedPayments = new BookedPayments(db, purchases, intake, relations, bank);
  quick.setBookedPayments(bookedPayments);
  inbox.setBookedPayments(bookedPayments);
  inbox.setOwnCompany(ownCompany);
  inbox.setIntegrations(integrations);
  // afschriften uit de downloadmap (#184): standaard uit; de vraag "Inlezen?" komt op Vandaag
  const statementFolder = new StatementFolder(db, settings, bank, deps.statementFiles ?? null);
  inbox.setStatementFolder(statementFolder);
  const checklist = new ChecklistService(db, settings);
  const switchover = new SwitchoverService(db, ledger, settings, relations, bank, vat);
  const xafImport = new XafImportService(db, settings, relations, bank, switchover);

  // alleen-lezen (koppeling voor Claude Code/Codex): niets aanvullen, de app deed dat al bij het openen
  if (!db.readonly) {
    ledger.seedDefaultAccounts();
    templates.seedDefaults();
    bank.ensureDefaultAccount();
  }

  return { db, ownCompany, statementFolder, periods, exchange, license, sendMail, fx, fxRepair, bookedPayments, bookedInfo, ledger, categories, mail, events, recurring, search, incomeTax, settings, relations, templates, invoices, quotes, purchases, sender, bank, matching, vat, dashboard, quick, integrations, exports, accountantPackage, memory, businessShare, ledgerReports, classifier, intake, jobs, inbox, checklist, switchover, xafImport, investments, assets, mileage, hours, taxOverview };
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
