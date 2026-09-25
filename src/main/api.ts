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
import { PORTAL_URL } from '../btw/btw';
import type { ExpenseInput, CashSaleInput } from '../quick/quick';
import { EXPENSE_CATEGORIES, OTHER_DESTINATIONS } from '../shared/categories';
import { PURCHASE_VAT_RATES, SALES_VAT_RATES } from '../shared/vat';
import type { AccountCategory } from '../core-ledger/accounts';
import { TRADES } from '../shared/trades';
import type { Confirmation } from '../intake/intake';
import type { JobStatus } from '../jobs/jobs';
import type { LineInput } from '../documents/totals';
import type { Task } from '../inbox/inbox';
import type { EntrySource } from '../core-ledger/ledger';
import type { IsoDate } from '../shared/dates';
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
  restoreBackup(): Promise<boolean>;
  appVersion(): string;
  checkForUpdates(): Promise<string>;
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
    throw new Error('Onbekend bestandsformaat. Gebruik CSV, MT940 of CAMT.053.');
  };

  return {
    app: {
      version: () => host.appVersion(),
      checkForUpdates: () => host.checkForUpdates(),
      openExternal: (url: string) => host.openExternal(url),
      openAttachment: (path: string) => host.openPath(path),
      backup: () => host.backupNow(),
      restore: () => host.restoreBackup(),
      meta: () => ({
        expenseCategories: EXPENSE_CATEGORIES,
        otherDestinations: OTHER_DESTINATIONS,
        salesVat: Object.values(SALES_VAT_RATES),
        purchaseVat: Object.values(PURCHASE_VAT_RATES),
        fonts: FONTS,
        trades: TRADES,
        vatPortalUrl: PORTAL_URL,
      }),
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
      dueReminders: () => s.sender.dueReminders().map((i) => ({ id: i.id, number: i.number, relation_name: i.relation_name, open_amount: i.open_amount, reminder_count: i.reminder_count })),
    },
    home: {
      get: () => s.inbox.home(),
      /** Voert een knop uit een inbox-taak uit. Retourneert optioneel een scherm om te openen. */
      act: async (task: Task, actionId: string, payload?: { categoryKey?: string; vatCode?: string }): Promise<{ navigate?: { screen: string; id?: number | string } } | void> => {
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
            };
            const target = screens[task.kind];
            return target ? { navigate: { screen: target[0], id: target[1] } } : undefined;
          }
        }
      },
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
    },
    documents: {
      add: (name: string, data: Uint8Array) => s.intake.add(name, data),
      list: (status?: 'nieuw' | 'controle' | 'verwerkt' | 'genegeerd') => s.intake.list(status),
      get: (id: number) => s.intake.get(id),
      confirm: (id: number, c: Confirmation) => s.intake.confirm(id, c),
      ignore: (id: number) => s.intake.ignore(id),
      /** Bestand als data-URL voor de controle-weergave (document links, velden rechts). */
      file: (id: number) => {
        const d = s.intake.get(id);
        return { mimeType: d.mime_type, base64: host.readAttachment(d.file_path).toString('base64') };
      },
      suppliers: () => s.memory.list(),
      forgetSupplier: (key: string) => s.memory.forget(key),
    },
    purchases: {
      list: (filter?: { status?: 'open' | 'betaald' }) => s.purchases.list(filter),
      create: (input: PurchaseInvoiceInput) => s.purchases.create(input),
      recordExpense: (input: ExpenseInput) => s.quick.recordExpense(input),
      attach: (name: string, data: Uint8Array) => host.storeAttachment(name, data),
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
      addAccount: (name: string, iban: string) => s.bank.addAccount(name, iban),
      updateAccount: (id: number, patch: { name?: string; iban?: string | null }) => s.bank.updateAccount(id, patch),
      openingBalance: (bankAccountId: number, amount: Cents, date: IsoDate) => s.bank.setOpeningBalance(bankAccountId, amount, date),
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
      unmatch: (txId: number) => s.bank.unmatch(txId),
      autoMatch: () => s.matching.autoMatch(),
    },
    vat: {
      current: () => s.vat.currentPeriod(),
      calculate: (periodKey: string) => s.vat.calculate(periodKey),
      periods: (year: number) => s.vat.listPeriods(year),
      markSubmitted: (periodKey: string) => s.vat.markSubmitted(periodKey),
      reopen: (periodKey: string) => s.vat.reopen(periodKey),
      exportCsv: (periodKey: string) => host.saveFile(`btw-aangifte-${periodKey}.csv`, s.vat.exportCsv(periodKey), [{ name: 'CSV', extensions: ['csv'] }]),
      exportXbrl: (periodKey: string) => host.saveFile(`btw-aangifte-${periodKey}.xbrl`, buildVatXbrl(s.vat.calculate(periodKey), s.settings.get().company), [{ name: 'XBRL', extensions: ['xbrl', 'xml'] }]),
    },
    dashboard: {
      get: () => s.dashboard.get(),
      reports: (from: IsoDate, to: IsoDate) => s.dashboard.reports(from, to),
    },
    ledger: {
      accounts: () => s.ledger.listAccounts(),
      createAccount: (input: { code: string; rgs: string; name: string; category: AccountCategory }) => s.ledger.createAccount(input),
      renameAccount: (id: number, name: string) => s.ledger.renameAccount(id, name),
      archiveAccount: (id: number) => s.ledger.archiveAccount(id),
      entries: (filter?: { from?: IsoDate; to?: IsoDate; source?: EntrySource; accountRgs?: string; limit?: number }) => s.ledger.listEntries(filter),
      balances: (from?: IsoDate, to?: IsoDate) => s.ledger.balances({ from, to }),
      manualEntry: (entry: { date: IsoDate; description: string; lines: { account: string; debit?: Cents; credit?: Cents }[] }) => s.ledger.post({ ...entry, source: 'handmatig' }),
      reverse: (id: number, date: IsoDate) => s.ledger.reverse(id, date),
      integrity: () => s.ledger.checkIntegrity(),
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
