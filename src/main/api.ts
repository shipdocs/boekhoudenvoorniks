import type { RuntimeStatus } from '../ocr-runtime/runtime';
import { DOWNLOAD_SIZE, GLM_OCR, LLAMA_CPP, REQUIREMENTS } from '../ocr-runtime/manifest';
import type { Services } from '../services';
import type { AppSettings } from '../settings/settings';
import type { RelationInput } from '../relations/relations';
import type { InvoiceDraftInput, InvoiceDisplayStatus, PaymentInput } from '../documents/invoices';
import type { QuoteInput, QuoteStatus } from '../documents/quotes';
import type { DocumentTemplate, TemplateType } from '../documents/templates';
import { renderDocumentHtml, FONTS } from '../documents/templates';
import type { SendOptions } from '../documents/sending';
import type { PurchaseInvoiceInput } from '../documents/purchases';
import type { BookToAccountInput } from '../import/bank';
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
import { EXPENSE_CATEGORIES, OTHER_DESTINATIONS } from '../shared/categories';
import { PURCHASE_VAT_RATES, SALES_VAT_RATES } from '../shared/vat';
import { ACCOUNTS, type AccountCategory } from '../core-ledger/accounts';
import { TRADES } from '../shared/trades';
import type { Confirmation } from '../intake/intake';
import type { JobStatus } from '../jobs/jobs';
import type { LineInput } from '../documents/totals';
import type { Task } from '../inbox/inbox';
import type { EntrySource } from '../core-ledger/ledger';
import { today, type IsoDate } from '../shared/dates';
import type { Cents } from '../shared/money';

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
  testSmtp(): Promise<void>;
  backupNow(): Promise<string | null>;
  restoreBackup(password?: string): Promise<boolean>;
  exportEncrypted(password: string): Promise<string | null>;
  appVersion(): string;
  checkForUpdates(): Promise<string>;
  /** Administratie wissen (met veiligheidskopie bij echte gegevens) en eventueel de demo erin zetten. */
  resetData(withDemo: boolean): Promise<{ backup: string | null }>;
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
  const doAct = async (task: Task, actionId: string, payload?: { categoryKey?: string; vatCode?: string; jobId?: number }): Promise<{ navigate?: { screen: string; id?: number | string } } | void> => {
    const r = task.ref;
    switch (`${task.kind}:${actionId}`) {
      case 'bank-invoice:klopt':
        s.bank.matchInvoice(r.bankTransactionId!, r.invoiceId!);
        return;
      case 'bank-purchase:klopt':
        s.bank.matchPurchase(r.bankTransactionId!, r.purchaseId!);
        return;
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
          s.inbox.answerBank(r.bankTransactionId!, { business: true, categoryKey: payload.categoryKey, vatCode: payload.vatCode });
          return;
        }
        return { navigate: { screen: 'categorie', id: r.bankTransactionId } };
      case 'document-review:klopt': {
        const d = s.intake.get(r.documentId!);
        const res = d.result;
        if (!res?.supplier || !res.total || !res.invoiceDate || !d.classification) return { navigate: { screen: 'document', id: d.id } };
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
      case 'document-review:dubbel': {
        const issue = s.intake.get(r.documentId!).issues.find((i) => i.field === 'duplicate');
        const match = issue?.suggestion as { documentId: number | null; purchaseId: number | null } | undefined;
        if (!match) return { navigate: { screen: 'document', id: r.documentId } };
        s.intake.markDuplicate(r.documentId!, match);
        return;
      }
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
          'bank-invoice': ['bank', r.bankTransactionId],
          'bank-purchase': ['bank', r.bankTransactionId],
          'bank-income': ['bank', r.bankTransactionId],
          'document-review': ['document', r.documentId],
          'invoice-overdue': ['factuur', r.invoiceId],
          'invoice-concept': ['factuur', r.invoiceId],
          'vat-due': ['belasting', r.periodKey],
          'bank-stale': ['bank', undefined],
          'purchase-due': ['aankopen', r.purchaseId],
          'recurring-invoice': ['bewijs', r.bankTransactionId],
          'recurring-missing-payment': ['bank', undefined],
          'vat-suppletie': ['belasting', undefined],
        };
        const target = screens[task.kind];
        return target ? { navigate: { screen: target[0], id: target[1] } } : undefined;
      }
    }
  };

  return {
    app: {
      version: () => host.appVersion(),
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
      meta: () => ({
        expenseCategories: EXPENSE_CATEGORIES,
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
      get: () => ({ ...s.settings.get(), smtpPasswordSet: host.hasSmtpPassword() }),
      update: (patch: Partial<AppSettings>) => {
        const r = s.settings.update(patch);
        if (patch.ocr) host.reconfigureLocalAi();
        return r;
      },
      setSmtpPassword: (pw: string) => host.setSmtpPassword(pw),
      testSmtp: () => host.testSmtp(),
      counters: (year: number) => ({ factuur: s.settings.peekCounter(`factuur:${year}`), offerte: s.settings.peekCounter(`offerte:${year}`) }),
      setInvoiceCounter: (year: number, value: number) => s.settings.setCounter(`factuur:${year}`, value),
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
      act: async (task: Task, actionId: string, payload?: { categoryKey?: string; vatCode?: string; jobId?: number }): Promise<{ navigate?: { screen: string; id?: number | string } } | void> => {
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
      list: (status?: 'nieuw' | 'controle' | 'verwerkt' | 'genegeerd') => s.intake.list(status),
      get: (id: number) => s.intake.get(id),
      confirm: (id: number, c: Confirmation) => s.intake.confirm(id, c),
      ignore: (id: number) => s.intake.ignore(id),
      markDuplicate: (id: number, match: { documentId: number | null; purchaseId: number | null }) => s.intake.markDuplicate(id, match),
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
      list: (filter?: { status?: 'open' | 'betaald' }) => s.purchases.list(filter),
      create: (input: PurchaseInvoiceInput) => s.purchases.create(input),
      recordExpense: (input: ExpenseInput) => s.quick.recordExpense(input),
      attach: (name: string, data: Uint8Array) => host.storeAttachment(name, data),
      /**
       * Betaal-QR (EPC) voor een open inkoop (#25). Ander IBAN dan eerder bij deze leverancier:
       * eerst een waarschuwing, pas na bevestiging de QR.
       */
      paymentQr: (id: number, confirmNewIban = false) => purchasePaymentQr(s.purchases, id, confirmNewIban),
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
      addAccount: (name: string, iban: string) => s.bank.addAccount(name, iban),
      updateAccount: (id: number, patch: { name?: string; iban?: string | null }) => s.bank.updateAccount(id, patch),
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
      transactions: (filter?: { status?: 'nieuw' | 'gematcht' | 'genegeerd'; search?: string }) => s.bank.list(filter),
      suggestions: (txId: number) => s.matching.suggest(s.bank.get(txId)),
      matchInvoice: (txId: number, invoiceId: number) => s.bank.matchInvoice(txId, invoiceId),
      matchPurchase: (txId: number, purchaseId: number) => s.bank.matchPurchase(txId, purchaseId),
      book: (txId: number, input: BookToAccountInput) => s.bank.bookToAccount(txId, input),
      ignore: (txId: number) => s.bank.ignore(txId),
      /** Andere categorie voor een al geboekte betaling: tegenboeking + nieuwe boeking (#19), en leren. */
      reclassify: (txId: number, categoryKey: string, vatCode: string) => {
        const category = EXPENSE_CATEGORIES.find((c) => c.key === categoryKey);
        if (!category) throw new Error('Onbekende categorie');
        // boeken en leren in één transactie: nooit een gewijzigde boeking met een mislukte leerstap
        return tx(s.db, () => {
          const entryId = s.bank.reclassify(txId, { account: category.account, vatCode }, `categorie gewijzigd naar ${category.label.toLowerCase()}`);
          const t = s.bank.get(txId);
          if (t.counter_name && supplierKey(t.counter_name)) s.memory.learn(t.counter_name, { categoryKey, vatCode, business: true });
          return entryId;
        });
      },
      unmatch: (txId: number) => s.bank.unmatch(txId),
      autoMatch: () => s.matching.autoMatch(undefined, s.settings.get().autopilot),
    },
    incomeTax: {
      estimate: () => s.incomeTax.estimate(),
      /** "Voor je aangifte": KIA, bijtellingen, ondernemersaftrek, uren en kilometers van een jaar */
      overview: (year: number) => s.taxOverview.year(year),
    },
    assets: {
      list: () => s.assets.list(),
      update: (id: number, patch: { name?: string; lifetimeMonths?: number; residual?: Cents; kiaExcluded?: boolean; bookInApp?: boolean }) => s.assets.update(id, patch),
      dispose: (id: number, date: IsoDate, proceeds: Cents) => s.assets.dispose(id, date, proceeds),
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
      periods: (year: number) => s.vat.listPeriods(year),
      markSubmitted: (periodKey: string) => s.vat.markSubmitted(periodKey),
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
      query: (q: string, filters?: { from?: IsoDate; to?: IsoDate; minAmount?: Cents; maxAmount?: Cents; jobId?: number }) => s.search.search(q, filters),
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
      createAccount: (input: { code: string; rgs: string; rgsRef?: string | null; name: string; category: AccountCategory }) => s.ledger.createAccount(input),
      renameAccount: (id: number, name: string) => s.ledger.renameAccount(id, name),
      archiveAccount: (id: number) => s.ledger.archiveAccount(id),
      entries: (filter?: { from?: IsoDate; to?: IsoDate; source?: EntrySource; accountRgs?: string; limit?: number }) => s.ledger.listEntries(filter),
      balances: (from?: IsoDate, to?: IsoDate) => s.ledger.balances({ from, to }),
      manualEntry: (entry: { date: IsoDate; description: string; lines: { account: string; debit?: Cents; credit?: Cents }[] }) => s.ledger.post({ ...entry, source: 'handmatig' }),
      reverse: (id: number, date: IsoDate) => s.ledger.reverse(id, date),
      integrity: () => s.ledger.checkIntegrity(),
      /** "Waarom bestaat deze boeking?": de gebeurtenis met bewijs (#19). */
      origin: (entryId: number) => s.events.forEntry(entryId),
    },
    exports: {
      journal: (from: IsoDate, to: IsoDate) => host.saveFile(`journaal-${from}-${to}.csv`, s.exports.journalCsv(from, to), [{ name: 'CSV', extensions: ['csv'] }]),
      trialBalance: (from: IsoDate, to: IsoDate) => host.saveFile(`saldibalans-${from}-${to}.csv`, s.exports.trialBalanceCsv(from, to), [{ name: 'CSV', extensions: ['csv'] }]),
      auditfile: (from: IsoDate, to: IsoDate) =>
        host.saveFile(`auditfile-${from.slice(0, 4)}.xaf`, s.exports.auditfile(from, to, s.settings.get().company, host.appVersion()), [{ name: 'Auditfile', extensions: ['xaf'] }]),
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
