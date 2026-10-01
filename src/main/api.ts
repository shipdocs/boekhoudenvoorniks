import { ValidationError } from '../shared/validation';
import { isPurchaseVatCode } from '../shared/vat';
import { TERMS_VERSION } from '../shared/legal';
import type { RuntimeStatus } from '../ocr-runtime/runtime';
import type { CliKind } from '../intake/ocr-cli';
import { DOWNLOAD_SIZE, GLM_OCR, LLAMA_CPP, REQUIREMENTS } from '../ocr-runtime/manifest';
import type { Services } from '../services';
import type { AppSettings } from '../settings/settings';
import type { RelationInput } from '../relations/relations';
import type { InvoiceDraftInput, InvoiceDisplayStatus, PaymentInput } from '../documents/invoices';
import type { QuoteInput, QuoteStatus } from '../documents/quotes';
import type { DocumentTemplate, TemplateType } from '../documents/templates';
import { renderDocumentHtml, FONTS } from '../documents/templates';
import type { SendOptions } from '../documents/sending';
import { purchaseVat, type PurchaseInvoiceInput } from '../documents/purchases';
import { businessEffect } from '../shared/business-share';
import type { BookToAccountInput, SaleInput } from '../import/bank';
import { parseCsv, previewCsv, headerSignature, type CsvMapping } from '../import/csv';
import { parseMt940 } from '../import/mt940';
import { parseCamt053 } from '../import/camt053';
import { detectFormat } from '../import/detect';
import type { ParseResult } from '../import/types';
import { buildVatXbrl } from '../btw/xbrl';
import { PORTAL_URL, SUPPLETIE_URL } from '../btw/btw';
import { decisionStats } from '../inbox/automation-log';
import { purchasePaymentQr } from '../documents/epc-qr';
import { supplierKey } from '../intake/supplier-memory';
import { tx } from '../db/database';
import { hasRealData } from './reset';
import type { ExpenseInput, CashSaleInput } from '../quick/quick';
import { OTHER_DESTINATIONS } from '../shared/categories';
import { PURCHASE_VAT_RATES, SALES_VAT_RATES } from '../shared/vat';
import { ACCOUNTS, type AccountCategory } from '../core-ledger/accounts';
import { TRADES } from '../shared/trades';
import type { Confirmation } from '../intake/intake';
import type { LinkTarget } from '../documents/evidence-links';
import type { JobStatus } from '../jobs/jobs';
import type { LineInput } from '../documents/totals';
import { documentProposal, type Task } from '../inbox/inbox';
import { ONLINE_HELP } from '../shared/online-help';
import type { OpeningInput, SectionKey } from '../onboarding/switchover';
import type { XafApplyChoices } from '../onboarding/xaf-import';
import { OPEN_ITEMS_TEMPLATE, type ColumnMapping } from '../import/opening-tables';
import type { EntrySource } from '../core-ledger/ledger';
import { formatDateNl, today, type IsoDate } from '../shared/dates';
import type { Cents } from '../shared/money';
import type { PollResult } from '../mail/mail-intake';
import type { UpdateStatus } from './updates';
import type { FxApplyInput } from '../fx/repair';
import { ExchangeService, type OfficeProfile } from '../exchange/exchange';
import { checkCode, openOfficeKey, sealOfficeKey } from '../exchange/crypto';
import type { LicenseBilling } from '../license/license';
import { countryCode } from '../shared/vat';

/** Functies die alleen het Electron-hoofdproces kan leveren (dialogen, bestanden, geheimen). */

export interface HostContext {
  saveFile(defaultName: string, content: Buffer | string, filters: { name: string; extensions: string[] }[]): Promise<string | null>;
  storeAttachment(name: string, data: Uint8Array): Promise<string>;
  readAttachment(path: string): Buffer;
  reconfigureLocalAi(): void;
  openPath(path: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  setSmtpPassword(password: string): void;
  hasSmtpPassword(): boolean;
  /** test met de ingevulde (nog niet opgeslagen) gegevens en het ingetypte wachtwoord, anders het opgeslagen */
  testSmtp(smtp?: AppSettings['smtp'], password?: string): Promise<void>;
  backupNow(): Promise<string | null>;
  /** complete back-up in de back-upmap van de administratie, zonder te vragen (bv. vóór het afsluiten) */
  safetyBackup?(label: string): Promise<string | null>;
  restoreBackup(password?: string): Promise<boolean>;
  exportEncrypted(password: string): Promise<string | null>;
  /** uitwisseling met de boekhouder (alleen in de app zelf) */
  exchange?: {
    /** de open administratie als pakket: database zonder geheimen en mail- of koppelinginstellingen, met bijlagen */
    bundle(): Promise<Buffer>;
    /** het kantoor op deze computer (bij de boekhouder), of null */
    office(): OfficeProfile | null;
    /** waarom het kantoor niet te openen is (bv. sleutelhanger weg), of null */
    officeProblem?(): string | null;
    saveOffice(input: { office: string; email: string; newKey?: boolean; keys?: { publicKey: string; privateKey: string } }): OfficeProfile;
    /** export van een klant uitpakken als nieuwe administratie (de kopie) en die openen */
    openClientExport(data: Uint8Array): Promise<{ company: string; exchange: number; endDate: string }>;
  };
  /** de licentie-Worker (alleen in de app zelf): prijs en licentie ophalen */
  licenseApi?: {
    /** `bedrag` exclusief btw (`btw: 'exclusief'`); `proefMaanden`: gratis maanden bij een eerste abonnement */
    price(): Promise<{ bedrag: string; valuta: string; per: string; inclusiefBtw?: string; btw?: string; proefMaanden?: number } | null>;
    /** de ondertekende licentie voor deze administratie, of null als er (nog) geen betaald abonnement is */
    fetch(administrationId: string, managementKey: string): Promise<string | null>;
    /** eerste betaling bij Mollie klaarzetten; geeft de betaallink, of `al` als er al een abonnement loopt */
    start(input: { administratie: string; email: string; bedrijf: LicenseBilling; managementKey: string; voorwaarden: string; zakelijk: true }): Promise<{ checkout?: string; al?: boolean }>;
    /** het abonnement stoppen; de betaalde periode loopt af */
    cancel(administrationId: string, managementKey: string): Promise<{ betaaldTot: string; geldigTot: string }>;
  };
  /** meerdere administraties (alleen in de app zelf) */
  administrations?: {
    list(): { key: string; name: string; officeCopy: { office: string; exchange: number; endDate: string } | null; id: string | null; current: boolean }[];
    open(key: string): Promise<void>;
    create(name: string): Promise<string>;
  };
  appVersion(): string;
  checkForUpdates(): Promise<string>;
  /** Administratie wissen (met veiligheidskopie bij echte gegevens) en eventueel de demo erin zetten. */
  resetData(withDemo: boolean): Promise<{ backup: string | null }>;
  /** automatisch bijwerken; ontbreekt buiten Electron */
  updates?: {
    status(): UpdateStatus;
    install(): void;
    reconfigure(): void;
  };
  /** inkomende post (IMAP); ontbreekt buiten Electron */
  mail?: {
    setPassword(password: string): void;
    hasPassword(): boolean;
    /** test met de ingevulde gegevens en het ingetypte wachtwoord; geeft de mappen terug */
    test(cfg?: AppSettings['mailIn'], password?: string): Promise<{ folders: string[] }>;
    fetchNow(): Promise<PollResult>;
    /** "Toch als bon bewaren": de tekst van een mail die bleef liggen als PDF-bon */
    saveAsReceipt(id: number): Promise<unknown>;
  };
  /** zoeken waar Claude Code of Codex staat (alleen als de gebruiker daarom vraagt); null = niet gevonden */
  findCli?(kind: CliKind): string | null;
  /** bestaat dit programma (nog)? */
  programExists?(path: string): boolean;
  /** de gebruiker wijst het programma zelf aan */
  pickProgram?(title: string): Promise<string | null>;
  /** klein proefverzoek: start het, is de gebruiker ingelogd? */
  checkCli?(kind: CliKind, path: string): Promise<string>;
  /** terminal openen met het programma erin, om in te loggen */
  openLoginTerminal?(kind: CliKind, path: string): Promise<string>;
  /** hoe Claude Code/Codex de koppeling (alleen lezen) start: dit programma met --mcp */
  mcpCommand?(): { command: string; args: string[] };
  /** de koppeling toevoegen aan Claude Code of Codex (voert "claude/codex mcp add" uit) */
  connectMcp?(kind: CliKind, path: string): Promise<string>;
  /** ingebouwde tekstherkenning (#9): downloaden bij eerste gebruik */
  localOcr: {
    status(): RuntimeStatus;
    install(): RuntimeStatus;
    uninstall(): Promise<RuntimeStatus>;
  };
}

/**
 * Het complete API-oppervlak voor de renderer. Alleen wat hier staat is via IPC bereikbaar.
 * Alle argumenten komen uit de renderer en worden door de services zelf gevalideerd.
 */
export function createApi(s: Services, host: HostContext) {
  const linkTarget = (kind: string, id: number): LinkTarget => {
    if (kind !== 'aankoop' && kind !== 'bank') throw new ValidationError('Kies een aankoop of een betaling');
    return { kind, id: Number(id) };
  };
  const cliKind = (kind: string): CliKind => {
    if (kind !== 'claude-code' && kind !== 'codex') throw new Error('Onbekend programma');
    return kind;
  };
  /** het onthouden pad van Claude Code of Codex, als het programma er nog is */
  const storedCli = (kind: CliKind): string | null => {
    const ocr = s.settings.get().ocr;
    const path = kind === 'codex' ? ocr.codexPath : ocr.claudeCodePath;
    return path && (host.programExists?.(path) ?? true) ? path : null;
  };
  const parseBankFile = async (filename: string, content: string, mapping?: CsvMapping): Promise<ParseResult> => {
    const format = detectFormat(filename, content);
    if (format === 'camt') return parseCamt053(content);
    if (format === 'mt940') return parseMt940(Buffer.from(content, 'utf8'));
    if (format === 'csv') {
      const m = mapping ?? previewCsv(content).suggestedMapping;
      if (!m) throw new Error('Kolommen niet herkend; wijs ze handmatig aan');
      return parseCsv(content, m);
    }
    throw new Error('Dit bestand herkennen we niet. Download bij je bank een afschrift als CSV-, MT940- of CAMT-bestand.');
  };

  /** Voert een knop uit een inbox-taak uit. Retourneert optioneel een scherm om te openen. */
  const doAct = async (task: Task, actionId: string, payload?: { categoryKey?: string; vatCode?: string; jobId?: number; businessPct?: number }): Promise<{ navigate?: { screen: string; id?: number | string } } | void> => {
    const r = task.ref;
    switch (`${task.kind}:${actionId}`) {
      case 'bank-invoice:klopt':
        s.bank.matchInvoice(r.bankTransactionId!, r.invoiceId!);
        return;
      case 'bank-purchase:klopt':
        s.bank.matchPurchase(r.bankTransactionId!, r.purchaseId!);
        return;
      case 'vat-due:ingediend':
        s.vat.markSubmitted(r.periodKey!, { alreadyFiled: true });
        return;
      case 'bank-sale:klopt':
        s.bank.repeatSale(r.bankTransactionId!);
        return;
      case 'bank-sale:anders':
        return { navigate: { screen: 'categorie', id: r.bankTransactionId } };
      case 'bank-category:klopt':
        s.inbox.answerBank(r.bankTransactionId!, { business: true, categoryKey: r.categoryKey, vatCode: r.vatCode });
        return;
      case 'bank-business:prive':
        s.inbox.answerBank(r.bankTransactionId!, { business: false, categoryKey: r.categoryKey ?? 'overig', vatCode: 'geen' });
        return;
      case 'bank-business:zakelijk':
        if (!payload?.categoryKey && r.categoryKey) {
          // bekende leverancier: één klik is genoeg
          s.inbox.answerBank(r.bankTransactionId!, { business: true, categoryKey: r.categoryKey, vatCode: r.vatCode });
          return;
        }
      // falls through
      case 'bank-category:anders':
        if (payload?.categoryKey) {
          s.inbox.answerBank(r.bankTransactionId!, { business: true, categoryKey: payload.categoryKey, vatCode: payload.vatCode, businessPct: payload.businessPct });
          return;
        }
        return { navigate: { screen: 'categorie', id: r.bankTransactionId } };
      case 'document-review:klopt': {
        const d = s.intake.get(r.documentId!);
        const res = d.result;
        if (!res?.supplier || !res.total || !res.invoiceDate || !d.classification) return { navigate: { screen: 'document', id: d.id } };
        // alleen het voorstel dat de gebruiker zag: is het intussen veranderd (opnieuw gelezen, betaling gekoppeld), dan niet uitvoeren
        if (r.proposal !== undefined && r.proposal !== documentProposal(d)) throw new ValidationError('Het voorstel voor deze bon is intussen veranderd. Bekijk hem opnieuw.');
        if (d.status !== 'controle') throw new ValidationError('Deze bon is al verwerkt');
        s.intake.confirm(d.id, {
          supplier: res.supplier.value,
          date: res.invoiceDate.value,
          total: res.total.value,
          invoiceNumber: res.invoiceNumber?.value ?? null,
          categoryKey: d.classification.categoryKey,
          vatCode: d.classification.vatCode,
          business: d.classification.business,
          paidWith: d.bank_match ? 'bank' : 'later',
        });
        return;
      }
      case 'document-review:dubbel':
      case 'document-review:bewijs':
      case 'document-review:nee': {
        // alleen het voorstel dat de gebruiker zag (#179): is het intussen een ander, dan eerst opnieuw bekijken
        const pending = s.intake.pending(s.intake.get(r.documentId!));
        if (!pending || pending.kind !== (actionId === 'bewijs' ? 'evidence' : actionId === 'dubbel' ? 'duplicate' : pending.kind)) return { navigate: { screen: 'document', id: r.documentId } };
        await s.intake.decide(r.documentId!, actionId === 'nee' ? 'nee' : 'ja', r.candidate);
        return;
      }
      case 'document-notice:klaar':
        s.intake.dismissNotice(r.noticeId!);
        return;
      case 'document-notice:open':
        return r.documentId ? { navigate: { screen: 'document', id: r.documentId } } : { navigate: { screen: 'aankopen' } };
      case 'invoice-overdue:herinnering':
        await s.sender.sendReminder(r.invoiceId!);
        return;
      case 'job-done:factuur': {
        const inv = s.jobs.makeInvoice(r.jobId!);
        return { navigate: { screen: 'factuur', id: inv.id } };
      }
      case 'quote-expired:akkoord':
        s.jobs.acceptQuote(r.quoteId!);
        return;
      case 'supplier-auto:ja':
        s.memory.setAutomatic(r.supplierKey!, true);
        s.inbox.autoProcess();
        return;
      case 'supplier-auto:nee':
        s.memory.setAutomatic(r.supplierKey!, false);
        return;
      case 'job-link:ja':
      case 'job-link:anders': {
        const jobId = actionId === 'anders' ? payload?.jobId : r.jobId;
        if (!jobId) return { navigate: { screen: 'klus-kiezen' } };
        if (r.purchaseId) s.jobs.linkPurchase(r.purchaseId, jobId);
        else if (r.bankTransactionId) s.jobs.linkBankTransaction(r.bankTransactionId, jobId);
        return;
      }
      case 'job-link:algemeen':
        s.inbox.skipTask(task.key, 'algemeen');
        return;
      case 'bank-refund:klopt':
        s.bank.bookToAccount(r.bankTransactionId!, { account: ACCOUNTS.debiteuren, relationId: r.relationId!, description: 'Terugbetaling: klant had te veel betaald' });
        return;
      case 'bank-refund:anders':
        s.inbox.skipTask(`bank-refund-${r.bankTransactionId}`, 'geen terugbetaling');
        return { navigate: { screen: 'categorie', id: r.bankTransactionId } };
      case 'mail-online:klaar':
      case 'mail-customer:klaar':
        s.inbox.skipTask(task.key, 'gezien');
        return;
      case 'exchange-conflict:klaar':
        s.inbox.skipTask(task.key, 'afgehandeld');
        return;
      case 'mail-online:open':
        return { navigate: { screen: 'aankopen' } };
      case 'mail-online:bon':
        if (!host.mail) throw new Error('Mail ophalen kan alleen in de app');
        await host.mail.saveAsReceipt(r.mailId!);
        return;
      case 'mail-customer:open':
        return { navigate: { screen: 'klant', id: r.relationId } };
      case 'customer-overpaid:open':
        return { navigate: { screen: 'klant', id: r.relationId } };
      case 'customer-overpaid:klopt':
        s.inbox.skipTask(task.key, 'klopt zo');
        return;
      case 'bank-pot:klopt':
      case 'bank-own:klopt':
        s.bank.bookOwnTransfer(r.bankTransactionId!);
        return;
      case 'recurring-confirm:ja':
        s.recurring.confirm(r.seriesId!);
        s.inbox.autoProcess();
        return;
      case 'recurring-confirm:nee':
        s.recurring.setStatus(r.seriesId!, 'afgewezen');
        return;
      case 'recurring-stopped:ja':
        s.recurring.setStatus(r.seriesId!, 'gestopt');
        return;
      case 'purchase-double:ja':
        s.bookedPayments.resolve(r.purchaseId!, r.bankTransactionId!, s.purchases.get(r.purchaseId!).invoice_date);
        return;
      case 'purchase-double:nee':
      case 'recurring-stopped:nee':
      case 'recurring-missing-payment:ok':
      case 'recurring-invoice:geen':
        s.inbox.skipTask(task.key, actionId);
        return;
      case 'vat-check:overslaan':
        s.vat.skipCheck(r.periodKey!, r.checkKey!, 'overgeslagen vanuit Vandaag');
        return;
      case 'vat-check:open': {
        const check = s.vat.checks(r.periodKey!).find((c) => c.key === r.checkKey);
        const screen = check?.screen ?? 'belasting';
        return { navigate: { screen, id: screen === 'belasting' ? r.periodKey : undefined } };
      }
      case 'vat-suppletie:gedaan':
        s.vat.markSuppletieSubmitted(r.periodKey!);
        return;
      case 'investment-check:ja':
        s.investments.convert({ lineId: r.lineId!, purchaseId: r.purchaseId ?? null, bankTransactionId: r.bankTransactionId ?? null });
        return;
      case 'investment-check:nee':
        s.inbox.skipTask(task.key, 'gewone kosten');
        return;
      case 'quote-expired:afgewezen':
        s.quotes.setStatus(r.quoteId!, 'afgewezen');
        return;
      default: {
        const screens: Partial<Record<Task['kind'], [string, number | string | undefined]>> = {
          setup: ['welkom', undefined],
          // rechtstreeks naar het scherm waar je de betaling indeelt (niet de banklijst)
          'bank-invoice': ['betaling', r.bankTransactionId],
          'bank-purchase': ['betaling', r.bankTransactionId],
          'bank-income': ['betaling', r.bankTransactionId],
          'document-review': ['document', r.documentId],
          'invoice-overdue': ['factuur', r.invoiceId],
          'invoice-concept': ['factuur', r.invoiceId],
          'quote-expired': ['offerte', r.quoteId],
          'vat-due': ['belasting', r.periodKey],
          'bank-stale': ['bank', undefined],
          'bank-locked': ['bank', undefined],
          'purchase-due': ['aankopen', r.purchaseId],
          'exchange-conflict': r.invoiceId ? ['factuur', r.invoiceId] : ['aankopen', r.purchaseId],
          'fx-repair': ['aankopen', undefined],
          'recurring-invoice': ['bewijs', r.bankTransactionId],
          'recurring-missing-payment': ['bank', undefined],
          'vat-suppletie': ['belasting', undefined],
        };
        const target = screens[task.kind];
        return target ? { navigate: { screen: target[0], id: target[1] } } : undefined;
      }
    }
  };

  const hostExchange = () => {
    if (!host.exchange) throw new Error('De uitwisseling met de boekhouder kan alleen in de app zelf');
    return host.exchange;
  };
  const officeInfo = (p: OfficeProfile | null) => (p ? { office: p.office, email: p.email, code: checkCode(p.publicKey) } : null);
  const PACKAGE_FILTER = [{ name: 'Uitwisselingspakket', extensions: ['gbpakket'] }];
  /** mailservers weigeren vaak grotere bijlagen */
  const MAIL_LIMIT = 20 * 1024 * 1024;

  /** Vóór versturen: is er een geldige licentie? Zo niet, eerst proberen hem op te halen (net betaald of verlengd). */
  const ensureLicense = async () => {
    const st = s.license.status(today());
    if (st.state !== 'uit' && st.state !== 'actief' && host.licenseApi) {
      try {
        const token = await host.licenseApi.fetch(s.settings.administrationId(), s.license.managementKey());
        if (token) s.license.install(token, today());
      } catch {
        /* offline of nog niet betaald: dan de melding van requireActive */
      }
    }
    s.license.requireActive(today());
  };

  const admins = () => {
    if (!host.administrations) throw new Error('Meerdere administraties kan alleen in de app zelf');
    return host.administrations;
  };

  return {
    /** periodes afsluiten: afgewerkt is afgewerkt (docs/uitwisseling.md) */
    periods: {
      status: () => s.periods.status(),
      suggestedDates: () => s.periods.suggestedDates(),
      checks: (until: IsoDate) => s.periods.checks(String(until)),
      close: async (until: IsoDate, confirmed: string[]) => {
        const keys = Array.isArray(confirmed) ? confirmed.map(String) : [];
        // eerst controleren, dan de back-up, dan pas vast
        const blocking = s.periods.checks(String(until)).filter((c) => c.level === 'blokkeert');
        if (blocking.length === 0) await host.safetyBackup?.(`voor-afsluiten-tm-${String(until)}`);
        return s.periods.close(String(until), keys);
      },
    },
    /** uitwisseling met de boekhouder (docs/uitwisseling.md) */
    exchange: {
      status: () => ({
        partner: s.exchange.partner(),
        running: s.ledger.periodLock().exchange,
        last: s.exchange.lastAnswer(),
        copy: s.exchange.copyStatus(),
        office: officeInfo(host.exchange?.office() ?? null),
        officeProblem: host.exchange?.officeProblem?.() ?? null,
        canMail: Boolean(s.settings.get().smtp.host),
      }),
      // klant
      readInvite: (data: Uint8Array) => ExchangeService.readInvite(data),
      link: (data: Uint8Array) => s.exchange.link(data),
      unlink: () => s.exchange.unlink(),
      /** de periode t/m `until` naar de boekhouder: mailen, of als bestand bewaren om zelf te sturen */
      send: async (until: IsoDate, confirmed: string[], how: 'mail' | 'bestand') => {
        const keys = Array.isArray(confirmed) ? confirmed.map(String) : [];
        await ensureLicense();
        const r = await s.exchange.createExport(String(until), keys, host.appVersion(), () => hostExchange().bundle());
        let note: string | null = null;
        if (how === 'mail') {
          if (r.file.length > MAIL_LIMIT) note = `Het pakket is te groot om te mailen (${Math.round(r.file.length / 1024 / 1024)} MB). Bewaar het en stuur het via een gedeelde map of WeTransfer.`;
          else if (!r.partner.email) note = 'Er is geen e-mailadres van je boekhouder bekend. Bewaar het pakket en stuur het zelf.';
          else {
            try {
              const company = s.settings.get().company.name;
              await s.sendMail({
                to: r.partner.email,
                subject: `Administratie ${company} t/m ${formatDateNl(String(until))} (uitwisseling ${r.exchange})`,
                text: `Beste ${r.partner.office},\n\nIn de bijlage staat mijn administratie t/m ${formatDateNl(String(until))} (uitwisseling ${r.exchange}). Open hem in BoekhoudenVoorNiks via Instellingen > Administraties > Export van een klant inlezen.\n\nMet vriendelijke groet,\n${company}`,
                attachments: [{ filename: r.filename, content: r.file, contentType: 'application/octet-stream' }],
              });
              return { exchange: r.exchange, mailedTo: r.partner.email, path: null, note: null };
            } catch (e) {
              note = `Mailen lukte niet (${(e as Error).message}). Bewaar het pakket en stuur het zelf.`;
            }
          }
        }
        let path: string | null;
        try {
          path = await host.saveFile(r.filename, r.file, PACKAGE_FILTER);
        } catch (e) {
          s.exchange.abort(); // niet bewaard: de periode hoeft niet op slot
          throw e;
        }
        if (!path) {
          // niets verstuurd en niets bewaard: de periode hoeft niet op slot
          s.exchange.abort();
          return { exchange: null, mailedTo: null, path: null, note: note ?? 'Niet bewaard; er is niets verstuurd.' };
        }
        return { exchange: r.exchange, mailedTo: null, path, note };
      },
      abort: () => s.exchange.abort(),
      readAnswer: (data: Uint8Array) => s.exchange.readAnswer(data, host.appVersion()),
      // kantoor
      saveOffice: (office: string, email: string, newKey?: boolean) => officeInfo(hostExchange().saveOffice({ office: String(office), email: String(email), newKey: newKey === true })),
      invite: async () => {
        const profile = hostExchange().office();
        if (!profile) throw new Error('Vul eerst de naam van je kantoor in');
        const name = profile.office.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'kantoor';
        return host.saveFile(`uitnodiging-${name}.gbuitnodiging`, ExchangeService.invite(profile), [{ name: 'Uitnodiging', extensions: ['gbuitnodiging'] }]);
      },
      openExport: (data: Uint8Array) => hostExchange().openClientExport(data),
      /** de kantoorsleutel voor een collega, met een wachtwoord dat je apart doorgeeft */
      exportOfficeKey: async (password: string) => {
        const profile = hostExchange().office();
        if (!profile) throw new Error('Vul eerst de naam van je kantoor in');
        const name = profile.office.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'kantoor';
        return host.saveFile(`kantoorsleutel-${name}.gbkantoor`, sealOfficeKey(profile, String(password)), [{ name: 'Kantoorsleutel', extensions: ['gbkantoor'] }]);
      },
      importOfficeKey: (data: Uint8Array, password: string) => {
        const shared = openOfficeKey(data, String(password));
        return officeInfo(hostExchange().saveOffice({ office: shared.office, email: shared.email, keys: shared }));
      },
      actions: () => s.exchange.actions(),
      answer: async () => {
        const a = s.exchange.createAnswer(host.appVersion());
        // pas als het bestand er is, is het antwoord gemaakt (annuleren of een fout: gewoon verder werken)
        const path = await host.saveFile(a.filename, a.file, PACKAGE_FILTER);
        if (path) s.exchange.markAnswered();
        return { path, email: a.email, count: a.count };
      },
      reopenAnswer: () => s.exchange.reopenAnswer(),
    },
    /** abonnement voor de uitwisseling met de boekhouder */
    license: {
      status: () => s.license.status(today()),
      price: async () => {
        try {
          return (await host.licenseApi?.price()) ?? null;
        } catch {
          return null;
        }
      },
      /**
       * Afrekenen bij Mollie, in de browser. De bedrijfsgegevens gaan mee voor de factuur (in het verzoek,
       * niet in de URL). `al`: er loopt al een abonnement; dan de licentie ophalen.
       */
      checkout: async (email: string, accepted?: { terms: string; business: boolean }): Promise<{ al: boolean }> => {
        if (!host.licenseApi) throw new Error('Kan alleen in de app zelf');
        // artikel 8.2 en 8.3 van de voorwaarden: alleen voor je bedrijf, en akkoord met de huidige versie
        if (accepted?.terms !== TERMS_VERSION || accepted.business !== true) throw new ValidationError('Bevestig dat je het abonnement voor je bedrijf afsluit en ga akkoord met de voorwaarden');
        const mail = String(email ?? '').trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) throw new Error('Vul een geldig e-mailadres in');
        const company = s.settings.get().company;
        // zoals de Worker: alleen spaties telt als leeg
        const c = { name: company.name.trim(), address: company.address.trim(), postcode: company.postcode.trim(), city: company.city.trim(), kvk: company.kvkNumber.trim(), vat: company.vatNumber.trim() };
        const missing = [!c.name && 'bedrijfsnaam', !c.address && 'adres', !c.postcode && 'postcode', !c.city && 'plaats', !c.kvk && !c.vat && 'KvK- of btw-nummer'].filter(Boolean);
        if (missing.length > 0) throw new Error(`Voor de factuur ontbreekt nog: ${missing.join(', ')}. Vul dat aan bij Instellingen > Je bedrijf.`);
        const r = await host.licenseApi.start({
          administratie: s.settings.administrationId(),
          email: mail,
          bedrijf: { naam: c.name, adres: c.address, postcode: c.postcode, plaats: c.city, land: countryCode(company.country) ?? 'NL', kvk: c.kvk || undefined, btw: c.vat || undefined },
          managementKey: s.license.managementKey(),
          voorwaarden: TERMS_VERSION,
          zakelijk: true,
        });
        if (r.al) return { al: true };
        if (!r.checkout) throw new Error('De betaalpagina kon niet worden geopend; probeer het later opnieuw');
        await host.openExternal(r.checkout);
        return { al: false };
      },
      /** opzeggen: er wordt niets meer afgeschreven; versturen kan tot het eind van de betaalde periode */
      cancel: async () => {
        if (!host.licenseApi) throw new Error('Kan alleen in de app zelf');
        const managementKey = s.license.managementKey();
        await host.licenseApi.cancel(s.settings.administrationId(), managementKey);
        const token = await host.licenseApi.fetch(s.settings.administrationId(), managementKey);
        return token ? s.license.install(token, today()) : s.license.status(today());
      },
      /** na het betalen of verlengen: de licentie ophalen */
      refresh: async () => {
        if (!host.licenseApi) throw new Error('Kan alleen in de app zelf');
        const token = await host.licenseApi.fetch(s.settings.administrationId(), s.license.managementKey());
        if (!token) throw new Error('Nog geen betaald abonnement gevonden. Is de betaling net gedaan? Probeer het over een minuut opnieuw.');
        return s.license.install(token, today());
      },
    },
    /** meerdere administraties op deze computer (bv. bv en eenmanszaak, of een boekhouder met kopieën van klanten) */
    administrations: {
      list: () => (host.administrations ? host.administrations.list() : []),
      open: (key: string) => admins().open(String(key)),
      create: (name: string) => admins().create(String(name)),
    },
    app: {
      version: () => host.appVersion(),
      administrationId: () => s.settings.administrationId(),
      officeCopy: () => s.settings.officeCopy(),
      checkForUpdates: () => host.checkForUpdates(),
      openExternal: (url: string) => host.openExternal(url),
      openAttachment: (path: string) => host.openPath(path),
      backup: () => host.backupNow(),
      restore: (password?: string) => host.restoreBackup(password),
      exportEncrypted: (password: string) => host.exportEncrypted(password),
      /** Demo of echt? En staat er al iets in dat bewaard moet blijven? */
      dataStatus: () => ({ demo: s.settings.get().demoMode, hasData: hasRealData(s.db) }),
      /** Demo starten kan alleen in een lege administratie of vanuit de demo zelf. */
      startDemo: () => {
        if (hasRealData(s.db)) throw new Error('Je administratie bevat al gegevens. Wis die eerst als je de demo wilt bekijken.');
        return host.resetData(true);
      },
      /** Alles wissen en schoon beginnen (de onboarding start opnieuw). */
      clearData: () => host.resetData(false),
      /** automatisch bijwerken: staat er een nieuwe versie klaar? */
      updateStatus: (): UpdateStatus => host.updates?.status() ?? { state: 'uit', version: null, notes: null, percent: null, error: null },
      /** "Nu herstarten": de klaarstaande update installeren */
      installUpdate: () => host.updates?.install(),
      meta: () => ({
        expenseCategories: s.categories.list(),
        otherDestinations: OTHER_DESTINATIONS,
        salesVat: Object.values(SALES_VAT_RATES),
        purchaseVat: Object.values(PURCHASE_VAT_RATES),
        fonts: FONTS,
        trades: TRADES,
        vatPortalUrl: PORTAL_URL,
        vatSuppletieUrl: SUPPLETIE_URL,
      }),
    },
    onboarding: {
      /** "Aan de slag": afgeleid uit de administratie zelf, dus altijd actueel */
      checklist: () => s.checklist.items(),
    },
    settings: {
      get: () => {
        // de beheersleutel van het abonnement blijft in het hoofdproces; het scherm heeft hem niet nodig
        const { licenseManagementKey: _key, ...settings } = s.settings.get() as AppSettings & { licenseManagementKey?: string };
        return { ...settings, smtpPasswordSet: host.hasSmtpPassword() };
      },
      update: (patch: Partial<AppSettings>) => {
        // online hulp (JEV) hoort bij het abonnement: alleen aan te zetten met een actieve licentie (#132)
        if (patch.ocr?.onlineCategoryHelp === true && !s.settings.get().ocr.onlineCategoryHelp && !ONLINE_HELP.available) {
          throw new ValidationError('Online hulp bij het indelen van bonnen is nog niet beschikbaar.');
        }
        if (patch.ocr?.onlineCategoryHelp === true && !s.settings.get().ocr.onlineCategoryHelp && s.license.status(today()).state !== 'actief') {
          throw new ValidationError('Online hulp bij het indelen van bonnen is een extra functie van het abonnement. Neem eerst een abonnement.');
        }
        const r = s.settings.update(patch);
        if (patch.ocr) host.reconfigureLocalAi();
        if (patch.autoUpdate !== undefined) host.updates?.reconfigure();
        return r;
      },
      setSmtpPassword: (pw: string) => host.setSmtpPassword(pw),
      testSmtp: (smtp?: AppSettings['smtp'], password?: string) => host.testSmtp(smtp, password),
      counters: (year: number) => ({ factuur: s.settings.peekCounter(`factuur:${year}`), offerte: s.settings.peekCounter(`offerte:${year}`) }),
      setInvoiceCounter: (year: number, value: number) => s.settings.setCounter(`factuur:${year}`, value),
    },
    /** Kostencategorieën: eigen toevoegen, aanpassen, verbergen (nooit verwijderen). */
    categories: {
      all: () => ({ categories: s.categories.all(), groups: s.categories.groups() }),
      add: (input: { label: string; hint?: string; groupKey: string; defaultVat?: string }) => s.categories.add(input),
      update: (key: string, input: { label?: string; hint?: string; defaultVat?: string; groupKey?: string }) => s.categories.update(key, input),
      setHidden: (key: string, hidden: boolean) => s.categories.setHidden(key, hidden),
      reset: (key: string) => s.categories.reset(key),
      /** onboarding: kostenposten die bij je beroep horen toevoegen, wat je niet gebruikt verbergen */
      applyTrade: (tradeKey: string, choice: { add: string[]; hide: string[] }) => s.categories.applyTrade(tradeKey, choice),
    },
    /** Inkomende post: een apart mailadres voor de administratie. */
    mail: {
      summary: () => ({ ...s.mail.summary(), passwordSet: host.mail?.hasPassword() ?? false }),
      setPassword: (pw: string) => host.mail?.setPassword(pw),
      test: (cfg?: AppSettings['mailIn'], password?: string) => {
        if (!host.mail) throw new Error('Mail ophalen kan alleen in de app');
        return host.mail.test(cfg, password);
      },
      fetchNow: () => {
        if (!host.mail) throw new Error('Mail ophalen kan alleen in de app');
        if (s.settings.get().demoMode) throw new Error('In de demo wordt geen mail opgehaald. Wis de demo om echt te beginnen.');
        if (s.settings.officeCopy()) throw new Error(s.settings.outboundBlocked()!);
        return host.mail.fetchNow();
      },
      fromCustomer: (relationId: number) => s.mail.fromCustomer(relationId),
      saveAsReceipt: (id: number) => {
        if (!host.mail) throw new Error('Mail ophalen kan alleen in de app');
        return host.mail.saveAsReceipt(id);
      },
    },
    relations: {
      list: (filter?: { type?: 'klant' | 'leverancier'; search?: string }) => s.relations.list(filter),
      get: (id: number) => s.relations.get(id),
      create: (input: RelationInput) => s.relations.create(input),
      update: (id: number, input: Partial<RelationInput>) => s.relations.update(id, input),
      archive: (id: number) => s.relations.archive(id),
    },
    quotes: {
      list: (filter?: { status?: QuoteStatus; search?: string }) => s.quotes.list(filter),
      get: (id: number) => s.quotes.get(id),
      create: (input: QuoteInput) => s.quotes.create(input),
      update: (id: number, input: Partial<QuoteInput>) => s.quotes.update(id, input),
      delete: (id: number) => s.quotes.delete(id),
      setStatus: (id: number, status: 'geaccepteerd' | 'afgewezen' | 'verzonden') => s.quotes.setStatus(id, status),
      convertToInvoice: (id: number) => s.quotes.convertToInvoice(id),
      html: (id: number) => s.quotes.renderHtml(id),
      send: (id: number, opts?: SendOptions) => s.sender.sendQuote(id, opts),
      savePdf: async (id: number) => {
        const pdf = await s.sender.quotePdf(id);
        return host.saveFile(pdf.filename, pdf.content, [{ name: 'PDF', extensions: ['pdf'] }]);
      },
    },
    invoices: {
      list: (filter?: { status?: InvoiceDisplayStatus; search?: string; relationId?: number }) => s.invoices.list(filter),
      get: (id: number) => s.invoices.get(id),
      createDraft: (input: InvoiceDraftInput) => s.invoices.createDraft(input),
      updateDraft: (id: number, input: Partial<InvoiceDraftInput>) => s.invoices.updateDraft(id, input),
      deleteDraft: (id: number) => s.invoices.deleteDraft(id),
      finalize: (id: number) => s.invoices.finalize(id),
      creditNote: (id: number) => s.invoices.createCreditNote(id),
      registerPayment: (id: number, payment: PaymentInput) => s.invoices.registerPayment(id, payment),
      paidCash: (id: number, amount: Cents, date: IsoDate) => s.quick.customerPaidCash(id, amount, date),
      writeOff: (id: number) => s.invoices.writeOffRemainder(id),
      html: (id: number) => s.invoices.renderHtml(id),
      send: (id: number, opts?: SendOptions) => s.sender.sendInvoice(id, opts),
      sendReminder: (id: number, opts?: SendOptions) => s.sender.sendReminder(id, opts),
      emailLog: (id: number) => s.sender.emailLog('factuur', id),
      savePdf: async (id: number) => {
        const pdf = await s.sender.invoicePdf(id);
        return host.saveFile(pdf.filename, pdf.content, [{ name: 'PDF', extensions: ['pdf'] }]);
      },
      /** E-factuur (UBL, Peppol BIS 3.0) opslaan (#24). */
      saveUbl: (id: number) => {
        const inv = s.invoices.get(id);
        return host.saveFile(`factuur-${inv.number ?? id}.xml`, s.invoices.ublXml(id), [{ name: 'E-factuur (UBL)', extensions: ['xml'] }]);
      },
      dueReminders: () => s.sender.dueReminders().map((i) => ({ id: i.id, number: i.number, relation_name: i.relation_name, open_amount: i.open_amount, reminder_count: i.reminder_count })),
    },
    home: {
      get: () => s.inbox.home(),
      /** Voert een knop uit een inbox-taak uit. Retourneert optioneel een scherm om te openen. */
      act: async (task: Task, actionId: string, payload?: { categoryKey?: string; vatCode?: string; jobId?: number; businessPct?: number }): Promise<{ navigate?: { screen: string; id?: number | string } } | void> => {
        const result = await doAct(task, actionId, payload);
        if (!result?.navigate) s.inbox.recordUserAction(task, actionId);
        return result;
      },
      month: (month?: string) => s.inbox.month(month),
      /** "Klopt niet" op iets dat automatisch ging. */
      correct: (logId: number) => s.inbox.correctAutomation(logId),
      decisionStats: () => decisionStats(s.db),
      autoProcess: () => s.inbox.autoProcess(),
    },
    jobs: {
      list: (filter?: { status?: JobStatus; active?: boolean }) => s.jobs.list(filter),
      get: (id: number) => s.jobs.get(id),
      create: (input: { relationId: number; title: string; address?: string | null; startDate?: IsoDate | null; notes?: string | null }) => s.jobs.create(input),
      update: (id: number, patch: Partial<{ title: string; address: string | null; startDate: IsoDate | null; endDate: IsoDate | null; notes: string | null }>) => s.jobs.update(id, patch),
      setStatus: (id: number, status: JobStatus) => s.jobs.setStatus(id, status),
      acceptQuote: (quoteId: number) => s.jobs.acceptQuote(quoteId),
      makeInvoice: (id: number, lines?: LineInput[]) => s.jobs.makeInvoice(id, lines),
      result: (id: number) => s.jobs.result(id),
      results: (filter?: { relationId?: number }) => s.jobs.results(filter),
      suggestForDocument: (documentId: number) => {
        const d = s.intake.get(documentId);
        const gps = s.db.prepare('SELECT gps_lat, gps_lon FROM documents WHERE id = ?').get(documentId) as { gps_lat: number | null; gps_lon: number | null };
        return s.jobs.suggest({ date: d.result?.invoiceDate?.value ?? today(), supplier: d.result?.supplier?.value ?? null, gps: gps.gps_lat != null && gps.gps_lon != null ? { lat: gps.gps_lat, lon: gps.gps_lon } : null });
      },
      linkPurchase: (purchaseId: number, jobId: number | null) => s.jobs.linkPurchase(purchaseId, jobId),
      workItems: (id: number) => s.jobs.workItems(id),
      addWorkItem: (id: number, item: { date: IsoDate; description: string; quantity: number; unit?: string | null; unitPrice: Cents; vatCode: string }) => s.jobs.addWorkItem(id, item),
      removeWorkItem: (itemId: number) => s.jobs.removeWorkItem(itemId),
    },
    documents: {
      add: (name: string, data: Uint8Array) => s.intake.add(name, data),
      addEvidence: (name: string, data: Uint8Array, bankTransactionId: number) => s.intake.addEvidence(name, data, bankTransactionId),
      /** "Bon toevoegen" bij een aankoop zonder bon */
      addPurchaseEvidence: (name: string, data: Uint8Array, purchaseId: number) => s.intake.addPurchaseEvidence(name, data, purchaseId),
      list: (status?: 'nieuw' | 'controle' | 'verwerkt' | 'genegeerd') => s.intake.list(status),
      get: (id: number) => s.intake.get(id),
      /** De bon openen om te controleren; ontbrak de koers van een vreemde munt, dan nu nog een keer proberen. */
      open: (id: number) => s.intake.retryRate(Number(id)),
      confirm: (id: number, c: Confirmation) => s.intake.confirm(id, c),
      ignore: (id: number) => s.intake.ignore(id),
      /** Het antwoord op "dezelfde aankoop?" of "alleen als bewijs koppelen?" (#179): ja, nee of later. */
      decide: (id: number, answer: 'ja' | 'nee' | 'later', candidate?: string) => {
        if (answer !== 'ja' && answer !== 'nee' && answer !== 'later') throw new ValidationError('Kies ja, nee of later');
        return s.intake.decide(Number(id), answer, candidate === undefined ? undefined : String(candidate));
      },
      /** Het voorstel dat op een keuze wacht, met wat ernaast gelegd kan worden (het andere document, of de aankoop of betaling). */
      pending: (id: number) => s.intake.pending(s.intake.get(id)),
      /** Waar een document bij hoort, en welke bestanden daar nog meer bij horen (het hoofdbewijsstuk eerst). */
      linked: (id: number) => {
        const link = s.intake.links.forDocument(id);
        return link ? { link, target: s.intake.links.describe(link.target), files: s.intake.links.forTarget(link.target) } : null;
      },
      /** De bonnen bij een aankoop of bankbetaling (het hoofdbewijsstuk eerst). */
      forTarget: (kind: 'aankoop' | 'bank', id: number) => s.intake.links.forTarget(linkTarget(kind, id)),
      /** "Koppeling ongedaan maken": de bon gaat terug naar "Nog controleren"; de boeking blijft zoals hij is. */
      unlink: (id: number) => s.intake.unlink(Number(id)),
      /** Een document dat er al in staat en nog nergens bij hoort, zelf als bewijs koppelen (er wordt niets geboekt). */
      linkExisting: (id: number, kind: 'aankoop' | 'bank', targetId: number) => s.intake.linkExisting(Number(id), linkTarget(kind, targetId)),
      /** Bestand als data-URL voor de controle-weergave (document links, velden rechts). */
      file: (id: number) => {
        const d = s.intake.get(id);
        return { mimeType: d.mime_type, base64: host.readAttachment(d.file_path).toString('base64') };
      },
      suppliers: () => s.memory.list(),
      forgetSupplier: (key: string) => s.memory.forget(key),
      setSupplierAutomatic: (key: string, automatic: boolean) => s.memory.setAutomatic(key, automatic),
    },
    purchases: {
      /** met hoe hij betaald is: de bankrekening, "privé betaald" of "contant" */
      list: (filter?: { status?: 'open' | 'betaald' }) =>
        s.purchases.list(filter).map((p) => {
          // gemengd gebruik: welk deel is zakelijk, en wat blijft er dan aan kosten en btw-aftrek over
          const ev = p.journal_entry_id ? s.purchases.eventFor(p.journal_entry_id) : null;
          const pct = ev?.businessPct ?? 100;
          const eff = ev ? businessEffect(ev.lines.map((l) => ({ net: l.netAmount, vat: purchaseVat(l) })), pct, ev.noVatDeduction) : null;
          return {
            ...p,
            paid_via: p.amount_paid > 0 ? s.search.infoFor(`inkoop:${p.id}`)?.paidVia ?? null : null,
            business_pct: pct,
            /** btw die je terugkrijgt bij dit zakelijke deel (bij verlegde btw: niet apart getoond) */
            vat_deductible: eff && pct < 100 ? eff.btw : p.vat_total,
            business_amount: eff && pct < 100 ? eff.kosten + eff.btw : null,
            /** staat nog bij "weet ik nog niet" (Vraagposten): nog indelen */
            question: s.purchases.isQuestion(p.id),
          };
        }),
      /** Een aankoop van "weet ik nog niet" alsnog indelen (categorie en btw); de btw-aftrek komt er dan bij. */
      resolveQuestion: (id: number, categoryKey: string, vatCode: string) => {
        const category = s.categories.find(String(categoryKey));
        if (!category) throw new ValidationError('Kies waar de aankoop voor was');
        if (!isPurchaseVatCode(vatCode)) throw new ValidationError('Kies of er btw op de bon stond');
        return s.purchases.resolveQuestion(Number(id), { account: category.account, vatCode, description: category.label });
      },
      /** Zakelijk deel van één aankoop aanpassen; `remember`: voortaan ook voor deze leverancier. */
      setBusinessPct: (id: number, pct: number, remember?: boolean) => {
        const p = s.purchases.get(id);
        if (remember && p.relation_name) s.businessShare.set(p.relation_name, pct);
        return s.purchases.setBusinessPct(id, pct);
      },
      create: (input: PurchaseInvoiceInput) => s.purchases.create(input),
      recordExpense: (input: ExpenseInput) => s.quick.recordExpense(input),
      attach: (name: string, data: Uint8Array) => host.storeAttachment(name, data),
      /**
       * Betaal-QR (EPC) voor een open inkoop (#25). Ander IBAN dan eerder bij deze leverancier:
       * eerst een waarschuwing, pas na bevestiging de QR.
       */
      paymentQr: (id: number, confirmNewIban = false) => purchasePaymentQr(s.purchases, id, confirmNewIban),
      /** Niet van de zakelijke rekening betaald maar privé of contant; `always`: voortaan bij deze leverancier. */
      paidWith: (id: number, via: 'prive' | 'kas', opts?: { always?: boolean }) => s.quick.payPurchaseWith(id, via, opts),
      /** Een aankoop weghalen die er niet hoort (bv. per ongeluk toegevoegd); alleen zonder betaling. De bon blijft bewaard. */
      remove: (id: number) => {
        const p = s.purchases.get(id);
        if (p.amount_paid !== 0) throw new ValidationError('Deze aankoop is (deels) betaald. Maak eerst de betaling ongedaan.');
        // alle bestanden van deze aankoop (ook een kopie) blijven bewaard, maar komen niet terug als vraag
        const files = s.intake.links.forTarget({ kind: 'aankoop', id }).map((f) => f.document_id);
        s.purchases.cancel(id, p.invoice_date);
        for (const documentId of new Set([...files, ...(p.document_id ? [p.document_id] : [])])) s.db.prepare(`UPDATE documents SET status = 'genegeerd' WHERE id = ?`).run(documentId);
      },
      /** Staat de betaling van deze aankoop al als kosten op een van je rekeningen? (dan is hij dubbel) */
      bookedPayment: (id: number) => {
        const t = s.bookedPayments.find(s.purchases.get(id));
        return t ? { bankTransactionId: t.id, date: t.transaction_date, amount: -t.amount, counterName: t.counter_name, account: s.bank.getAccount(t.bank_account_id).name } : null;
      },
      /** "Ja, dezelfde betaling": de aankoop vervalt, de bon wordt het bewijsstuk bij die betaling. */
      mergeWithBooked: (id: number, bankTransactionId: number) => s.bookedPayments.resolve(id, bankTransactionId, s.purchases.get(id).invoice_date),
    },
    /** Vreemde valuta in wat er al stond (#74): nakijken en omrekenen. */
    valuta: {
      candidates: () => ({ purchases: s.fxRepair.candidates(), documents: s.fxRepair.pendingDocuments().length }),
      preview: (purchaseId: number, input?: { currency: string; foreignTotal: Cents }) => s.fxRepair.preview(purchaseId, input),
      apply: (purchaseId: number, input: FxApplyInput) => s.fxRepair.apply(purchaseId, input),
      fixAll: () => s.fxRepair.fixAll(),
    },
    quick: {
      cashSale: (input: CashSaleInput) => s.quick.recordCashSale(input),
      privateTransfer: (direction: 'opname' | 'storting', amount: Cents, date: IsoDate, via: 'kas' | 'bank') => s.quick.recordPrivate(direction, amount, date, via),
    },
    templates: {
      list: (type?: TemplateType) => s.templates.list(type),
      get: (id: number) => s.templates.get(id),
      create: (input: Partial<Omit<DocumentTemplate, 'id'>> & { name: string; type: TemplateType }) => s.templates.create(input),
      update: (id: number, patch: Partial<Omit<DocumentTemplate, 'id' | 'type'>>) => s.templates.update(id, patch),
      delete: (id: number) => s.templates.delete(id),
      setDefault: (id: number) => s.templates.setDefault(id),
      /** Live voorbeeld met voorbeelddata terwijl de gebruiker het template bewerkt. */
      preview: (template: DocumentTemplate) => {
        const sample = s.relations.list({ type: 'klant' })[0] ?? { name: 'Voorbeeldklant B.V.', address: 'Voorbeeldstraat 1', postcode: '1234 AB', city: 'Utrecht' };
        return renderDocumentHtml(
          {
            kind: template.type,
            number: template.type === 'factuur' ? '2026-0042' : 'OFF-2026-0042',
            date: '2026-09-25',
            dueDate: '2026-10-09',
            validUntil: '2026-10-25',
            intro: 'Hierbij ontvangt u de specificatie van de uitgevoerde werkzaamheden.',
            lines: [
              { description: 'Stucwerk wanden woonkamer (sausklaar)', quantity: 42.5, unit: 'm²', unit_price: 1850, vat_code: 'hoog', vat_percentage: 21 },
              { description: 'Plafond spuiten', quantity: 18, unit: 'm²', unit_price: 1250, vat_code: 'hoog', vat_percentage: 21 },
              { description: 'Voorrijkosten', quantity: 1, unit: null, unit_price: 3500, vat_code: 'hoog', vat_percentage: 21 },
            ],
          },
          sample,
          s.settings.get().company,
          template,
        );
      },
    },
    bank: {
      accounts: () => s.bank.listAccounts(),
      importStatus: () => s.bank.importStatus(),
      addAccount: (name: string, iban: string | null, opts?: { pot?: boolean }) => s.bank.addAccount(name, iban, opts),
      updateAccount: (id: number, patch: { name?: string; iban?: string | null; pot?: boolean }) => s.bank.updateAccount(id, patch),
      removableAccount: (id: number) => s.bank.removable(id),
      removeAccount: (id: number) => {
        s.bank.removeAccount(id);
        const st = s.settings.get();
        const patch: Record<string, unknown> = {};
        if (st.vatPotAccountId === id) patch.vatPotAccountId = null;
        if (st.switchover.xafBanks?.includes(id)) patch.switchover = { ...st.switchover, xafBanks: st.switchover.xafBanks.filter((x) => x !== id) };
        if (Object.keys(patch).length) s.settings.update(patch);
      },
      openingBalance: (bankAccountId: number, amount: Cents, date: IsoDate) => s.bank.setOpeningBalance(bankAccountId, amount, date),
      getOpeningBalance: (bankAccountId: number) => s.bank.openingBalance(bankAccountId),
      ownTransfer: (txId: number) => s.bank.ownTransferTarget(s.bank.get(txId)),
      bookOwnTransfer: (txId: number) => s.bank.bookOwnTransfer(txId),
      previewFile: (filename: string, content: string) => {
        const format = detectFormat(filename, content);
        if (format !== 'csv') return { format, csv: null, savedMapping: null };
        const csv = previewCsv(content);
        const saved = s.db.prepare('SELECT mapping FROM csv_mappings WHERE header_signature = ?').get(headerSignature(csv.headers)) as { mapping: string } | undefined;
        return { format, csv, savedMapping: saved ? (JSON.parse(saved.mapping) as CsvMapping) : null };
      },
      importFile: async (filename: string, content: string, mapping?: CsvMapping, bankAccountId?: number) => {
        const parsed = await parseBankFile(filename, content, mapping);
        if (mapping) {
          const sig = headerSignature(previewCsv(content).headers);
          s.db
            .prepare('INSERT INTO csv_mappings (name, header_signature, mapping) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET mapping = excluded.mapping, header_signature = excluded.header_signature')
            .run(`mapping-${sig.slice(0, 60)}`, sig, JSON.stringify(mapping));
        }
        const summary = s.bank.import(parsed, { filename, bankAccountId });
        const auto = s.inbox.autoProcess();
        return { ...summary, autoMatched: auto.matched + auto.booked };
      },
      /** betalingen, met "waar staat dit op?" en de naam van de rekening */
      transactions: (filter?: { status?: 'nieuw' | 'gematcht' | 'genegeerd'; search?: string }) => {
        const accounts = new Map(s.bank.listAccounts().map((a) => [a.id, a.name]));
        return s.bank.list(filter).map((t) => {
          const booking = s.bookedInfo.entry(t.matched_journal_entry_id);
          return { ...t, account_name: accounts.get(t.bank_account_id) ?? null, booked_as: booking?.summary || null, vat_period: booking?.vatPeriod ?? null };
        });
      },
      suggestions: (txId: number) => s.matching.suggest(s.bank.get(txId)),
      /** alle gegevens van één betaling, met eerdere betalingen aan dezelfde partij */
      details: (txId: number) => s.bank.details(txId),
      /** de factuur of aankoop die de app bij een betaling voorstelt, om te vergelijken */
      proposal: (ref: { invoiceId?: number; purchaseId?: number }) => {
        if (ref.invoiceId) {
          const i = s.invoices.get(ref.invoiceId);
          return { kind: 'factuur' as const, number: i.number, relation: i.relation_name, date: i.invoice_date, dueDate: i.due_date, total: i.total ?? 0, open: i.open_amount, attachmentPath: null };
        }
        if (ref.purchaseId) {
          const p = s.purchases.get(ref.purchaseId);
          return { kind: 'aankoop' as const, number: p.supplier_reference, relation: p.relation_name, date: p.invoice_date, dueDate: null, total: p.total, open: p.open_amount, attachmentPath: p.attachment_path, description: p.description };
        }
        return null;
      },
      matchInvoice: (txId: number, invoiceId: number) => s.bank.matchInvoice(txId, invoiceId),
      matchPurchase: (txId: number, purchaseId: number) => s.bank.matchPurchase(txId, purchaseId),
      book: (txId: number, input: BookToAccountInput) => s.bank.bookToAccount(txId, input),
      salesVatSuggestion: (txId: number) => s.bank.salesVatSuggestion(txId),
      /** verkoop via een ander systeem (Mollie, webshop, kassa, pin, contant) */
      bookSale: (txId: number, input: SaleInput) => s.bank.bookSale(txId, input),
      previousSale: (txId: number) => s.bank.previousSale(txId),
      repeatSale: (txId: number) => s.bank.repeatSale(txId),
      saleChannels: () => s.bank.saleChannels(),
      ignore: (txId: number) => s.bank.ignore(txId),
      /** Andere categorie voor een al geboekte betaling: tegenboeking + nieuwe boeking (#19), en leren. */
      reclassify: (txId: number, categoryKey: string, vatCode: string, businessPct?: number) => {
        const category = s.categories.find(categoryKey);
        if (!category) throw new Error('Onbekende categorie');
        // boeken en leren in één transactie: nooit een gewijzigde boeking met een mislukte leerstap
        return tx(s.db, () => {
          const entryId = s.bank.reclassify(txId, { account: category.account, vatCode, ...(businessPct !== undefined ? { businessPct } : {}) }, `categorie gewijzigd naar ${category.label.toLowerCase()}`);
          const t = s.bank.get(txId);
          if (t.counter_name && supplierKey(t.counter_name)) s.memory.learn(t.counter_name, { categoryKey, vatCode, business: true });
          return entryId;
        });
      },
      /** Zakelijk deel dat eerder voor de tegenpartij van deze betaling is opgegeven (100 = alles zakelijk). */
      businessShare: (txId: number) => {
        const t = s.bank.get(txId);
        return { name: t.counter_name, pct: s.businessShare.get(t.counter_name) };
      },
      unmatch: (txId: number) => s.bank.unmatch(txId),
      autoMatch: () => s.matching.autoMatch(undefined, s.settings.get().autopilot),
    },
    /** Overstappen met een lopende administratie: instapdatum, startbalans en controles. */
    /** Rapporten voor de boekhouder: kolommenbalans, grootboekkaarten, relatiekaarten, periodebalans. */
    reports: {
      trialBalance: (from: IsoDate, to: IsoDate) => s.ledgerReports.trialBalance(from, to),
      ledgerCard: (accountId: number, from: IsoDate, to: IsoDate) => s.ledgerReports.ledgerCard(accountId, from, to),
      relations: (to: IsoDate) => s.ledgerReports.relations(to),
      relationCard: (relationId: number, from: IsoDate, to: IsoDate) => s.ledgerReports.relationCard(relationId, from, to),
      periodBalance: (year: number, granularity: 'maand' | 'kwartaal') => s.ledgerReports.periodBalance(year, granularity),
    },
    /** Gemengd gebruik: zakelijk deel per leverancier (Dropbox 50%, Odido 75%, …). Geen regel = 100%. */
    businessShare: {
      list: () => s.businessShare.list(),
      get: (name: string) => s.businessShare.get(name),
      set: (name: string, pct: number, applyExisting?: boolean) => s.businessShare.set(name, pct, { applyExisting }),
      /** Alle geboekte uitgaven van een leverancier, om na te kijken. */
      lines: (name: string) => s.businessShare.lines(name),
      /** Past de gekozen boekingen aan (na jouw bevestiging in de lijst). */
      applyLines: (items: { kind: 'bank' | 'inkoop'; refId: number; pct: number }[]) => s.businessShare.applyLines(items),
    },
    switchover: {
      state: () => s.switchover.state(),
      setMode: (mode: 'nieuw' | 'overstapper', date?: IsoDate | null) => s.switchover.setMode(mode, date ?? null),
      save: (input: OpeningInput, id?: number) => (s.switchover.save(input, id), s.switchover.state()),
      remove: (id: number) => (s.switchover.remove(id), s.switchover.state()),
      setBankOpening: (bankAccountId: number, amount: Cents) => s.switchover.setBankOpening(bankAccountId, amount),
      setBankCheck: (bankAccountId: number, date: IsoDate, amount: Cents) => s.switchover.setBankCheck(bankAccountId, date, amount),
      ignoreBeforeDate: () => (s.switchover.ignoreBeforeDate(), s.switchover.state()),
      suggestions: () => s.switchover.suggestions(),
      acceptSuggestion: (txId: number, overrides?: { relationName?: string; number?: string; invoiceDate?: IsoDate }) => (s.switchover.acceptSuggestion(txId, overrides), s.switchover.state()),
      dismissSuggestion: (txId: number) => (s.switchover.dismissSuggestion(txId), s.switchover.state()),
      setAccountantEquity: (amount: Cents | null) => s.switchover.setAccountantEquity(amount),
      confirm: (opts?: { provisional?: boolean }) => s.switchover.confirm(opts),
      reopen: () => s.switchover.reopen(),
      skipSection: (key: SectionKey, skip?: boolean) => s.switchover.skipSection(key, skip),
      setBankUnused: (bankAccountId: number, unused?: boolean) => s.switchover.setBankUnused(bankAccountId, unused),
      /** auditfile (XAF) uit het vorige programma: eerst bekijken, dan overnemen wat aangevinkt is */
      /** alles wat de gebruiker erop sleept (auditfile, kolommen-/saldibalans, openstaande posten): voorstel of een paar vragen */
      analyzeXaf: (file: string | Uint8Array, mapping?: ColumnMapping) => s.xafImport.analyzeFile(file, { mapping }),
      applyXaf: (file: string | Uint8Array, choices: XafApplyChoices, mapping?: ColumnMapping) => s.xafImport.apply(file, choices, mapping),
      /** meerdere bestanden tegelijk (bv. een auditfile per jaar): de app kiest het bestand bij de instapdatum */
      analyzeXafFiles: (files: (string | Uint8Array)[], mapping?: ColumnMapping) => s.xafImport.analyzeFiles(files, mapping),
      applyXafFiles: (files: (string | Uint8Array)[], choices: XafApplyChoices, mapping?: ColumnMapping) => s.xafImport.applyFiles(files, choices, mapping),
      /** voorbeeldbestand voor openstaande posten, om in te vullen */
      saveTemplate: () => host.saveFile('openstaande-posten.csv', OPEN_ITEMS_TEMPLATE, [{ name: 'CSV', extensions: ['csv'] }]),
      /** openstaande verkoopfacturen als UBL (e-factuur) */
      addUblInvoices: (files: { name: string; xml: string }[]) => ({ ...s.switchover.saveFromUbl(files), state: s.switchover.state() }),
    },
    incomeTax: {
      estimate: () => s.incomeTax.estimate(),
      /** "Voor je aangifte": KIA, bijtellingen, ondernemersaftrek, uren en kilometers van een jaar */
      overview: (year: number) => s.taxOverview.year(year),
    },
    assets: {
      list: () => s.assets.list(),
      update: (id: number, patch: { name?: string; lifetimeMonths?: number; residual?: Cents; kiaExcluded?: boolean; bookInApp?: boolean; inUseOn?: IsoDate | null }) => s.assets.update(id, patch),
      dispose: (id: number, date: IsoDate, proceeds: Cents, kind?: 'verkocht' | 'prive') => s.assets.dispose(id, date, proceeds, kind),
      bookDue: () => s.assets.bookDue(),
    },
    mileage: {
      list: (year: number) => s.mileage.list(year),
      add: (input: { date: IsoDate; km: number; description: string; jobId?: number | null }) => s.mileage.add(input),
      remove: (id: number) => s.mileage.remove(id),
    },
    hours: {
      list: (year: number) => s.hours.list(year),
      totals: (year: number) => s.hours.totals(year),
      add: (input: { date: IsoDate; hours: number; description: string }) => s.hours.add(input),
      remove: (id: number) => s.hours.remove(id),
    },
    /**
     * Claude Code en Codex: de app installeert niets en zoekt pas als de gebruiker daarom vraagt.
     * Wat gevonden of gekozen is, wordt onthouden.
     */
    assistantTools: {
      search: () => {
        const ocr = s.settings.get().ocr;
        const claude = host.findCli?.('claude-code') ?? null;
        const codex = host.findCli?.('codex') ?? null;
        s.settings.update({ ocr: { ...ocr, claudeCodePath: claude ?? '', codexPath: codex ?? '', assistantsSearched: true } });
        host.reconfigureLocalAi();
        return { claudeCode: claude, codex };
      },
      pick: async (kind: string) => {
        const k = cliKind(kind);
        if (!host.pickProgram) throw new Error('Kan alleen in de app zelf');
        const path = await host.pickProgram(`Waar staat ${k === 'codex' ? 'Codex' : 'Claude Code'}?`);
        if (!path) return null;
        if (host.programExists && !host.programExists(path)) throw new Error('Dit is geen programma dat de app kan starten.');
        const ocr = s.settings.get().ocr;
        s.settings.update({ ocr: { ...ocr, [k === 'codex' ? 'codexPath' : 'claudeCodePath']: path, assistantsSearched: true } });
        host.reconfigureLocalAi();
        return path;
      },
      check: async (kind: string) => {
        const k = cliKind(kind);
        const cli = storedCli(k);
        if (!cli || !host.checkCli) throw new Error('Zoek eerst Claude Code of Codex op deze computer.');
        return host.checkCli(k, cli);
      },
      openLogin: async (kind: string) => {
        const k = cliKind(kind);
        const cli = storedCli(k);
        if (!cli || !host.openLoginTerminal) throw new Error('Zoek eerst Claude Code of Codex op deze computer.');
        return host.openLoginTerminal(k, cli);
      },
    },
    /**
     * Hoe mag de app bonnen lezen? Op deze computer (download), met de eigen Claude Code of Codex
     * (foto gaat naar Anthropic/OpenAI), of niet (zelf invullen). Gevraagd bij de eerste foto.
     */
    reader: {
      options: () => {
        const { ocr } = s.settings.get();
        const local = host.localOcr.status();
        return {
          current: ocr.engine === 'ingebouwd' || ocr.engine === 'claude-code' || ocr.engine === 'codex' ? ocr.engine : ocr.url ? 'eigen' : 'geen',
          asked: ocr.askedReader,
          local: { state: local.state, downloadSize: DOWNLOAD_SIZE, requirements: REQUIREMENTS },
          claudeCode: storedCli('claude-code'),
          codex: storedCli('codex'),
          searched: ocr.assistantsSearched,
          unread: s.intake.unread().length,
        };
      },
      choose: (choice: string) => {
        if (!['lokaal', 'claude-code', 'codex', 'zelf'].includes(choice)) throw new Error('Onbekende keuze');
        const ocr = s.settings.get().ocr;
        if (choice === 'claude-code' || choice === 'codex') {
          if (!storedCli(choice)) throw new Error(`${choice === 'codex' ? 'Codex' : 'Claude Code'} is (nog) niet gevonden. Klik eerst op "Zoek op deze computer" of "Kies zelf".`);
          s.settings.update({ ocr: { ...ocr, engine: choice, url: '', askedReader: true } });
        } else if (choice === 'lokaal') {
          s.settings.update({ ocr: { ...ocr, engine: 'ingebouwd', url: '', askedReader: true } });
          const st = host.localOcr.status();
          if (st.state === 'niet-geinstalleerd' || st.state === 'fout') host.localOcr.install();
        } else {
          // zelf invullen: elke manier van lezen uit, ook een eerder gekozen assistent of eigen dienst
          s.settings.update({ ocr: { ...ocr, engine: 'uit', url: '', askedReader: true } });
        }
        host.reconfigureLocalAi();
        return s.settings.get();
      },
      /** bonnen die nog niet uitgelezen zijn, nu (opnieuw) laten lezen */
      rereadPending: async () => {
        let read = 0;
        const docs = s.intake.unread();
        for (const d of docs) {
          // één bon die niet lukt (bv. bestand weg) houdt de rest niet tegen
          try {
            const after = await s.intake.reread(d.id, host.readAttachment(d.file_path));
            if (after.extraction_source !== 'geen') read++;
          } catch {
            /* telt als niet gelezen; de bon blijft staan om zelf in te vullen */
          }
        }
        return { read, total: docs.length };
      },
    },
    /** vragen stellen over je boekhouding vanuit Claude Code of Codex (alleen lezen) */
    assistant: {
      info: () => {
        const cmd = host.mcpCommand?.() ?? null;
        return { command: cmd, claudeCode: storedCli('claude-code'), codex: storedCli('codex'), searched: s.settings.get().ocr.assistantsSearched };
      },
      connect: async (kind: string) => {
        if (kind !== 'claude-code' && kind !== 'codex') throw new Error('Onbekend programma');
        if (!host.connectMcp) throw new Error('Kan alleen in de app zelf');
        const cli = storedCli(kind);
        if (!cli) throw new Error('Zoek eerst Claude Code of Codex op deze computer.');
        return host.connectMcp(kind, cli);
      },
    },
    localOcr: {
      status: () => host.localOcr.status(),
      info: () => ({ model: GLM_OCR.label, modelLicense: GLM_OCR.license, modelLicenseUrl: GLM_OCR.licenseUrl, runtime: LLAMA_CPP.label, runtimeLicense: LLAMA_CPP.license, runtimeLicenseUrl: LLAMA_CPP.licenseUrl, downloadSize: DOWNLOAD_SIZE, requirements: REQUIREMENTS }),
      install: () => host.localOcr.install(),
      uninstall: async () => {
        const st = await host.localOcr.uninstall();
        if (s.settings.get().ocr.engine === 'ingebouwd') s.settings.update({ ocr: { ...s.settings.get().ocr, engine: 'glm-ocr' } });
        host.reconfigureLocalAi();
        return st;
      },
      use: () => {
        s.settings.update({ ocr: { ...s.settings.get().ocr, engine: 'ingebouwd', url: '' } });
        host.reconfigureLocalAi();
        return s.settings.get();
      },
    },
    vat: {
      current: () => s.vat.currentPeriod(),
      calculate: (periodKey: string) => s.vat.calculate(periodKey),
      /** de boekingen achter één vak of regel van de berekening */
      details: (periodKey: string, code: string) => s.vat.rubriekDetails(periodKey, code),
      /** de boekingen die samen het saldo van een rekening vormen (bij een controle: "wat staat hier?") */
      accountLines: (rgs: string, upTo?: string) => s.vat.accountLines(rgs, upTo),
      periods: (year: number) => s.vat.listPeriods(year),
      korReverseCharge: (year: number) => s.vat.korReverseCharge(year),
      markSubmitted: (periodKey: string, alreadyFiled = false) => s.vat.markSubmitted(periodKey, { alreadyFiled: alreadyFiled === true }),
      reopen: (periodKey: string) => s.vat.reopen(periodKey),
      corrections: () => s.vat.corrections(),
      checks: (periodKey: string) => s.vat.checks(periodKey),
      skipCheck: (periodKey: string, checkKey: string, reason?: string) => s.vat.skipCheck(periodKey, checkKey, reason),
      bookCarPrivateUse: (periodKey: string) => s.vat.bookCarPrivateUse(periodKey),
      markSuppletieSubmitted: (periodKey: string) => s.vat.markSuppletieSubmitted(periodKey),
      exportCsv: (periodKey: string) => host.saveFile(`btw-aangifte-${periodKey}.csv`, s.vat.exportCsv(periodKey), [{ name: 'CSV', extensions: ['csv'] }]),
      icp: (periodKey: string) => s.vat.icp(periodKey),
      exportIcpCsv: (periodKey: string) => host.saveFile(`icp-opgaaf-${periodKey}.csv`, s.vat.icpCsv(periodKey), [{ name: 'CSV', extensions: ['csv'] }]),
      exportXbrl: (periodKey: string) => host.saveFile(`btw-aangifte-${periodKey}.xbrl`, buildVatXbrl(s.vat.calculate(periodKey), s.settings.get().company), [{ name: 'XBRL', extensions: ['xbrl', 'xml'] }]),
    },
    search: {
      /** Zoeken over alles (#26); filters: periode, bedrag, klus. */
      query: (q: string, filters?: { from?: IsoDate; to?: IsoDate; minAmount?: Cents; maxAmount?: Cents; jobId?: number }, limit?: number) => s.search.search(q, filters, Math.min(limit ?? 50, 500)),
      setWarranty: (purchaseId: number, months: number | null) => s.search.setWarranty(purchaseId, months),
      rebuild: () => s.search.rebuild(),
    },
    recurring: {
      /** Vaste lasten met hun stand (laatst gezien, volgende, per maand, prijsverschil) */
      list: () => s.recurring.list().filter((x) => x.status === 'actief').map((x) => s.recurring.state(x)),
      stop: (id: number) => s.recurring.setStatus(id, 'gestopt'),
      setExpectsInvoice: (id: number, expects: boolean) => s.recurring.setExpectsInvoice(id, expects),
    },
    dashboard: {
      get: () => s.dashboard.get(),
      reports: (from: IsoDate, to: IsoDate) => s.dashboard.reports(from, to),
    },
    ledger: {
      accounts: () => s.ledger.listAccounts(),
      // in de kopie bij de boekhouder gaan deze drie als handeling mee in het antwoord aan de klant
      createAccount: (input: { code: string; rgs: string; rgsRef?: string | null; name: string; category: AccountCategory }) => {
        if (!s.settings.officeCopy()) return s.ledger.createAccount(input);
        s.exchange.act({ kind: 'rekening', input });
        return s.ledger.getAccount(input.rgs);
      },
      renameAccount: (id: number, name: string) => s.ledger.renameAccount(id, name),
      archiveAccount: (id: number) => s.ledger.archiveAccount(id),
      entries: (filter?: { from?: IsoDate; to?: IsoDate; source?: EntrySource; accountRgs?: string; limit?: number }) => s.ledger.listEntries(filter),
      balances: (from?: IsoDate, to?: IsoDate) => s.ledger.balances({ from, to }),
      manualEntry: (entry: { date: IsoDate; description: string; lines: { account: string; debit?: Cents; credit?: Cents }[] }) =>
        s.settings.officeCopy() ? s.exchange.act({ kind: 'memoriaal', input: entry }).entryIds[0]! : s.ledger.post({ ...entry, source: 'handmatig' }),
      reverse: (id: number, date: IsoDate) => (s.settings.officeCopy() ? s.exchange.act({ kind: 'terugdraaien', input: { entryId: id, date } }).entryIds[0]! : s.ledger.reverse(id, date)),
      integrity: () => s.ledger.checkIntegrity(),
      /** "Waarom bestaat deze boeking?": de gebeurtenis met bewijs (#19). */
      origin: (entryId: number) => s.events.forEntry(entryId),
    },
    exports: {
      journal: (from: IsoDate, to: IsoDate) => host.saveFile(`journaal-${from}-${to}.csv`, s.exports.journalCsv(from, to), [{ name: 'CSV', extensions: ['csv'] }]),
      trialBalance: (from: IsoDate, to: IsoDate) => host.saveFile(`saldibalans-${from}-${to}.csv`, s.exports.trialBalanceCsv(from, to), [{ name: 'CSV', extensions: ['csv'] }]),
      auditfile: (from: IsoDate, to: IsoDate) =>
        host.saveFile(`auditfile-${from.slice(0, 4)}.xaf`, s.exports.auditfile(from, to, s.settings.get().company, host.appVersion()), [{ name: 'Auditfile', extensions: ['xaf'] }]),
      /** "Pakket voor mijn boekhouder": eerst de controles tonen, dan de ZIP maken */
      accountantPackagePreview: (year: number) => s.accountantPackage.preview(year, host.appVersion()),
      accountantPackage: async (year: number) => {
        const r = await s.accountantPackage.build(year, { softwareVersion: host.appVersion(), readAttachment: (path) => host.readAttachment(path) });
        const path = await host.saveFile(r.filename, r.zip, [{ name: 'ZIP', extensions: ['zip'] }]);
        return { path, files: r.files, summary: r.summary };
      },
    },
    integrations: {
      list: () => s.integrations.list(),
      configure: (id: string, values: Record<string, string>, enabled: boolean) => s.integrations.configure(id, values, enabled),
      disconnect: (id: string) => s.integrations.disconnect(id),
      sync: (id: string) => s.integrations.sync(id),
    },
  };
}

export type Api = ReturnType<typeof createApi>;
