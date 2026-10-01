import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { migrate, openDatabase } from '../src/db/database';
import { saveAttachment } from '../src/main/attachments';
import { createServices, MemorySecretStore } from '../src/services';
import type { Mailer, MailMessage } from '../src/documents/sending';
import type { FetchLike } from '../src/integrations/types';
import type { OcrProvider } from '../src/intake/ocr';
import type { FolderAccess } from '../src/import/statement-folder';

export function setup(opts: { fetch?: FetchLike; ocr?: OcrProvider; mailer?: Mailer; licensePublicKey?: string; /** een bestaande database (bv. opgebouwd in een oudere vorm) */ db?: Database.Database; /** lezen in de map met gedownloade afschriften */ statementFiles?: FolderAccess } = {}) {
  const db = opts.db ?? new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  const sent: MailMessage[] = [];
  // welke bestanden bewaard (en weer weggehaald) zijn: zo is een los bestand zonder document te zien
  const stored: string[] = [];
  const removed: string[] = [];
  const mailer: Mailer = {
    async send(m) {
      sent.push(m);
      return { messageId: `<test-${sent.length}@local>` };
    },
  };
  const secrets = new MemorySecretStore();
  const s = createServices(db, {
    pdf: async (html) => Buffer.from(`PDF:${html.length}`),
    mailerFactory: async () => opts.mailer ?? mailer,
    secrets,
    fetch: opts.fetch ?? (async () => { throw new Error('geen netwerk in tests'); }),
    storeFile: async (name) => {
      const path = `/tmp/test-bijlagen/${stored.length + 1}-${name}`;
      stored.push(path);
      return path;
    },
    removeFile: (path) => void removed.push(path),
    ocr: opts.ocr ?? null,
    statementFiles: opts.statementFiles ?? null,
    // licenties standaard uit in tests (de app heeft sinds 0.7.0 een echte sleutel); aan met een eigen testsleutel
    licensePublicKey: opts.licensePublicKey ?? '',
  });
  s.settings.update({
    company: {
      name: 'Stukadoorsbedrijf Piet',
      address: 'Kalkweg 1',
      postcode: '1234 AB',
      city: 'Utrecht',
      country: 'NL',
      email: 'piet@example.nl',
      phone: '',
      website: '',
      kvkNumber: '12345678',
      vatNumber: 'NL123456789B01',
      iban: 'NL91ABNA0417164300',
      bic: '',
    },
  });
  const klant = s.relations.create({ name: 'Familie Jansen', email: 'jansen@example.nl', address: 'Dorpsstraat 5', postcode: '3511 AA', city: 'Utrecht', iban: 'NL44RABO0123456789' });
  const aannemer = s.relations.create({ name: 'Bouwbedrijf De Vries BV', email: 'info@devries.example', address: 'Industrieweg 9', postcode: '3500 BB', city: 'Utrecht', vat_number: 'NL999999999B01' });
  return { db, s, sent, klant, aannemer, stored, removed, secrets };
}

/**
 * Alles wat een dubbele bon, een bewijskoppeling, een afwijzing, uitstel, de migratie of ontkoppelen
 * nooit mag veranderen (#179): journaalposten en -regels, gebeurtenissen, aankopen met hun regels, wat
 * er op de bank gekoppeld is, alle saldi en de btw-aangifte. Van een aankoop tellen `document_id` en
 * `attachment_path` niet mee: dat is de verwijzing naar het hoofdbewijsstuk, en die mag juist wel
 * veranderen als er een bon bij komt of af gaat. Met `evidence: true` tellen ook die verwijzing, alle
 * documenten en alle koppelingen mee (voor routes die helemaal niets mogen veranderen).
 */
export function financialSnapshot(ctx: { db: Database.Database; s: ReturnType<typeof createServices> }, opts: { evidence?: boolean; vatPeriods?: string[] } = {}) {
  const all = (sql: string) => ctx.db.prepare(sql).all();
  return {
    journal_entries: all('SELECT * FROM journal_entries ORDER BY id'),
    journal_lines: all('SELECT * FROM journal_lines ORDER BY id'),
    events: all('SELECT * FROM events ORDER BY id'),
    event_evidence: all('SELECT * FROM event_evidence ORDER BY id'),
    purchase_invoices: all(
      `SELECT id, relation_id, supplier_reference, invoice_date, due_date, description, subtotal, vat_total, total, amount_paid, status, journal_entry_id,
              job_id, payee_iban, currency, foreign_total, fx_rate, is_opening, warranty_months, external_source, external_id${opts.evidence ? ', document_id, attachment_path' : ''}
         FROM purchase_invoices ORDER BY id`,
    ),
    purchase_invoice_lines: all('SELECT * FROM purchase_invoice_lines ORDER BY id'),
    bank_transactions: all('SELECT id, amount, transaction_date, status, matched_journal_entry_id, matched_invoice_id, matched_purchase_invoice_id FROM bank_transactions ORDER BY id'),
    balances: ctx.s.ledger.balances(),
    vat: (opts.vatPeriods ?? ['2026-Q3']).map((key) => ctx.s.vat.calculate(key)),
    ...(opts.evidence
      ? {
          documents: all('SELECT id, file_path, sha256, status, result, classification, confidence, issues, decisions, purchase_invoice_id, duplicate_of_document_id FROM documents ORDER BY id'),
          document_links: all('SELECT document_id, purchase_invoice_id, bank_transaction_id, is_primary, origin FROM document_links ORDER BY document_id'),
        }
      : {}),
  };
}

/**
 * Een administratie op schijf zoals de app hem nu maakt: een aankoop met een bon en een ingelezen
 * document, de bestanden in `bijlagen/<jaar>/` en relatieve paden in de database. Geeft die paden terug.
 */
export async function administrationOnDisk(dir: string, label: string): Promise<{ bon: string; scan: string }> {
  mkdirSync(dir, { recursive: true });
  const s = createServices(openDatabase(join(dir, 'boekhouding.sqlite')), {
    pdf: async () => Buffer.from('PDF'),
    mailerFactory: async () => ({ send: async () => ({ messageId: '<x@local>' }) }),
    secrets: new MemorySecretStore(),
    fetch: async () => { throw new Error('geen netwerk in tests'); },
    storeFile: async (name, data) => saveAttachment(dir, name, data),
    licensePublicKey: '',
  });
  // zoals het scherm Aankopen: eerst de bon bewaren, dan de aankoop met het pad dat terugkwam
  const bon = saveAttachment(dir, `bon-${label}.pdf`, Buffer.from(`bewijs ${label}`));
  s.purchases.create({ invoiceDate: '2026-09-20', description: `bon ${label}`, attachmentPath: bon, lines: [{ account: 'WBedAlkOvr', netAmount: 1000, vatCode: 'geen', vatAmount: 0 }] });
  const scan = (await s.intake.add(`scan-${label}.jpg`, Buffer.from(`scan ${label}`), '2026-09-21')).file_path;
  s.db.close();
  return { bon, scan };
}
