import type { Db } from '../db/database';
import type { SettingsService, AppSettings } from '../settings/settings';
import type { InvoiceService, Invoice } from './invoices';
import type { QuoteService } from './quotes';
import { formatEuro } from '../shared/money';
import { addDays, formatDateNl, today, type IsoDate } from '../shared/dates';
import { formatIban, isValidEmail, ValidationError } from '../shared/validation';

export type PdfRenderer = (html: string) => Promise<Buffer>;

export interface MailMessage {
  to: string;
  bcc?: string;
  subject: string;
  text: string;
  attachments: { filename: string; content: Buffer; contentType?: string }[];
}

export interface Mailer {
  send(message: MailMessage): Promise<{ messageId: string }>;
}

export interface SendOptions {
  to?: string;
  subject?: string;
  body?: string;
}

export function fillPlaceholders(text: string, values: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (m, key: string) => (key in values ? values[key]! : m));
}

export function safeFilename(name: string): string {
  return name.replace(/[^\w.-]+/g, '_');
}

export interface EmailLogEntry {
  id: number;
  document_type: 'factuur' | 'offerte' | 'herinnering';
  document_id: number;
  recipient: string;
  subject: string;
  status: 'verzonden' | 'mislukt';
  error: string | null;
  sent_at: string;
}

export class DocumentSender {
  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly invoices: InvoiceService,
    private readonly quotes: QuoteService,
    private readonly pdf: PdfRenderer,
    private readonly mailerFactory: () => Promise<Mailer>,
  ) {}

  async invoicePdf(id: number): Promise<{ filename: string; content: Buffer }> {
    const inv = this.invoices.get(id);
    const content = await this.pdf(this.invoices.renderHtml(id));
    return { filename: safeFilename(`Factuur ${inv.number ?? 'concept'} ${inv.relation_name}.pdf`), content };
  }

  async quotePdf(id: number): Promise<{ filename: string; content: Buffer }> {
    const q = this.quotes.get(id);
    const content = await this.pdf(this.quotes.renderHtml(id));
    return { filename: safeFilename(`Offerte ${q.number} ${q.relation_name}.pdf`), content };
  }

  private invoiceValues(inv: Invoice, s: AppSettings): Record<string, string> {
    return {
      nummer: inv.number ?? '',
      klant: inv.relation_name,
      bedrag: formatEuro(inv.total ?? inv.totals.total),
      openstaand: formatEuro(inv.open_amount),
      vervaldatum: formatDateNl(inv.due_date),
      bedrijf: s.company.name,
      iban: s.company.iban ? formatIban(s.company.iban) : '',
    };
  }

  /** Maakt de factuur zo nodig definitief, genereert de PDF en mailt hem naar de klant. */
  async sendInvoice(id: number, opts: SendOptions = {}): Promise<Invoice> {
    let inv = this.invoices.get(id);
    const to = (opts.to ?? inv.relation_email ?? '').trim();
    if (!isValidEmail(to)) throw new ValidationError(`Geen geldig e-mailadres voor ${inv.relation_name}`);
    const mailer = await this.mailerFactory(); // faalt vroeg als SMTP niet is ingesteld
    if (inv.status === 'concept') inv = this.invoices.finalize(id);
    const s = this.settings.get();
    const values = this.invoiceValues(inv, s);
    const subject = fillPlaceholders(opts.subject ?? s.invoiceEmailSubject, values);
    const text = fillPlaceholders(opts.body ?? s.invoiceEmailBody, values);
    const attachment = await this.invoicePdf(id);
    await this.deliver(mailer, 'factuur', id, { to, bcc: s.smtp.bcc || undefined, subject, text, attachments: [{ ...attachment, contentType: 'application/pdf' }] });
    this.invoices.markSent(id);
    return this.invoices.get(id);
  }

  async sendQuote(id: number, opts: SendOptions = {}) {
    const q = this.quotes.get(id);
    const to = (opts.to ?? q.relation_email ?? '').trim();
    if (!isValidEmail(to)) throw new ValidationError(`Geen geldig e-mailadres voor ${q.relation_name}`);
    const mailer = await this.mailerFactory();
    const s = this.settings.get();
    const values = {
      nummer: q.number,
      klant: q.relation_name,
      bedrag: formatEuro(q.totals.total),
      geldig_tot: formatDateNl(q.valid_until),
      bedrijf: s.company.name,
    };
    const attachment = await this.quotePdf(id);
    await this.deliver(mailer, 'offerte', id, {
      to,
      bcc: s.smtp.bcc || undefined,
      subject: fillPlaceholders(opts.subject ?? s.quoteEmailSubject, values),
      text: fillPlaceholders(opts.body ?? s.quoteEmailBody, values),
      attachments: [{ ...attachment, contentType: 'application/pdf' }],
    });
    return this.quotes.markSent(id);
  }

  async sendReminder(invoiceId: number, opts: SendOptions = {}): Promise<Invoice> {
    const inv = this.invoices.get(invoiceId);
    if (inv.status !== 'verzonden' || inv.open_amount <= 0) throw new ValidationError('Deze factuur staat niet open');
    const to = (opts.to ?? inv.relation_email ?? '').trim();
    if (!isValidEmail(to)) throw new ValidationError(`Geen geldig e-mailadres voor ${inv.relation_name}`);
    const mailer = await this.mailerFactory();
    const s = this.settings.get();
    const values = this.invoiceValues(inv, s);
    const attachment = await this.invoicePdf(invoiceId);
    await this.deliver(mailer, 'herinnering', invoiceId, {
      to,
      bcc: s.smtp.bcc || undefined,
      subject: fillPlaceholders(opts.subject ?? s.reminderEmailSubject, values),
      text: fillPlaceholders(opts.body ?? s.reminderEmailBody, values),
      attachments: [{ ...attachment, contentType: 'application/pdf' }],
    });
    this.invoices.recordReminder(invoiceId);
    return this.invoices.get(invoiceId);
  }

  /** Facturen waarvoor volgens de instellingen vandaag een herinnering uit moet. */
  dueReminders(asOf: IsoDate = today()): Invoice[] {
    const s = this.settings.get();
    const schedule = [...s.reminderDays].filter((d) => Number.isInteger(d) && d >= 0).sort((a, b) => a - b);
    return this.invoices
      .listOpen(asOf)
      .map((summary) => this.invoices.get(summary.id, asOf))
      .filter((inv) => {
        if (inv.open_amount <= 0 || inv.credit_of_invoice_id) return false;
        const nextDays = schedule[inv.reminder_count];
        if (nextDays === undefined) return false;
        if (addDays(inv.due_date, nextDays) > asOf) return false;
        // nooit twee herinneringen op dezelfde dag
        return !inv.last_reminder_at || inv.last_reminder_at.slice(0, 10) < asOf;
      });
  }

  /** Automatische aanmaningen: verstuurt alle verschuldigde herinneringen. */
  async runAutomaticReminders(asOf: IsoDate = today()): Promise<{ sent: number; failed: { invoiceId: number; error: string }[] }> {
    if (!this.settings.get().remindersEnabled) return { sent: 0, failed: [] };
    let sent = 0;
    const failed: { invoiceId: number; error: string }[] = [];
    for (const inv of this.dueReminders(asOf)) {
      try {
        await this.sendReminder(inv.id);
        sent++;
      } catch (e) {
        failed.push({ invoiceId: inv.id, error: (e as Error).message });
      }
    }
    return { sent, failed };
  }

  emailLog(documentType?: string, documentId?: number): EmailLogEntry[] {
    if (documentType && documentId) {
      const types = documentType === 'factuur' ? ['factuur', 'herinnering'] : [documentType];
      return this.db
        .prepare(`SELECT * FROM email_log WHERE document_type IN (${types.map(() => '?').join(',')}) AND document_id = ? ORDER BY id DESC`)
        .all(...types, documentId) as EmailLogEntry[];
    }
    return this.db.prepare('SELECT * FROM email_log ORDER BY id DESC LIMIT 200').all() as EmailLogEntry[];
  }

  private async deliver(mailer: Mailer, type: 'factuur' | 'offerte' | 'herinnering', id: number, message: MailMessage): Promise<void> {
    const log = this.db.prepare('INSERT INTO email_log (document_type, document_id, recipient, subject, status, error, message_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
    try {
      const result = await mailer.send(message);
      log.run(type, id, message.to, message.subject, 'verzonden', null, result.messageId);
    } catch (e) {
      log.run(type, id, message.to, message.subject, 'mislukt', (e as Error).message, null);
      throw new Error(`Versturen mislukt: ${(e as Error).message}`);
    }
  }
}
