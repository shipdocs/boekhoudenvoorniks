import { createHash } from 'node:crypto';
import type { Db } from '../db/database';
import { tx } from '../db/database';
import type { PurchaseService, PurchaseLineInput } from '../documents/purchases';
import type { RelationsService } from '../relations/relations';
import type { BankService, BankTransaction } from '../import/bank';
import { ACCOUNTS } from '../core-ledger/accounts';
import { EXPENSE_CATEGORIES } from '../shared/categories';
import { PURCHASE_VAT_RATES, type PurchaseVatCode } from '../shared/vat';
import { diffDays, today, type IsoDate } from '../shared/dates';
import type { Cents } from '../shared/money';
import { ValidationError } from '../shared/validation';
import { isUbl, parseUbl, findEmbeddedUbl } from './ubl';
import { extractPdf } from './pdf-text';
import { parseDocumentText } from './text-parser';
import { validateDocument } from './validation';
import { assessConfidence } from './confidence';
import type { Classifier, Classification } from './classify';
import type { SupplierMemory } from './supplier-memory';
import { supplierKey } from './supplier-memory';
import type { OcrProvider } from './ocr';
import type { ConfidenceLevel, DocumentResult, Issue } from './types';
import { splitGross } from '../import/bank';

export interface IntakeDocument {
  id: number;
  file_path: string;
  original_name: string;
  mime_type: string;
  status: 'nieuw' | 'controle' | 'verwerkt' | 'genegeerd';
  extraction_source: string | null;
  result: DocumentResult | null;
  classification: Classification | null;
  confidence: ConfidenceLevel | null;
  issues: Issue[];
  purchase_invoice_id: number | null;
  created_at: string;
  bank_match: BankTransaction | null;
}

export interface Confirmation {
  supplier: string;
  date: IsoDate;
  total: Cents;
  invoiceNumber?: string | null;
  categoryKey: string;
  vatCode: PurchaseVatCode;
  /** false = privé-uitgave: niet in de zakelijke boekhouding */
  business: boolean;
  paidWith: 'bank' | 'kas' | 'prive' | 'later';
  jobId?: number | null;
}

type Row = Omit<IntakeDocument, 'result' | 'classification' | 'issues' | 'bank_match'> & { result: string | null; classification: string | null; issues: string };

const MIME: Record<string, string> = { pdf: 'application/pdf', xml: 'application/xml', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic' };

export function mimeFor(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  const mime = MIME[ext];
  if (!mime) throw new ValidationError('Alleen PDF, XML (e-factuur) of foto (jpg, png, webp, heic)');
  return mime;
}

function emptyResult(): DocumentResult {
  return {
    documentType: { value: 'unknown', confidence: 0, source: 'gebruiker' },
    supplier: null,
    supplierVatNumber: null,
    supplierIban: null,
    invoiceNumber: null,
    invoiceDate: null,
    dueDate: null,
    currency: { value: 'EUR', confidence: 0.5, source: 'gebruiker' },
    subtotal: null,
    vat: { value: [], confidence: 0, source: 'gebruiker' },
    total: null,
    lineDescriptions: [],
    reverseCharge: false,
    rawText: '',
  };
}

/**
 * Documentinbox: bonnetjes en inkoopfacturen → (extractie → classificatie → validatie → confidence)
 * → bij HIGH automatisch verwerkt, anders één vraag of controle. De boeking zelf gebeurt altijd
 * door de deterministische PurchaseService.
 *
 * Pipeline: UBL/XML → PDF-tekstlaag (incl. ingesloten UBL) → lokale OCR.
 */
export class IntakeService {
  constructor(
    private readonly db: Db,
    private readonly purchases: PurchaseService,
    private readonly relations: RelationsService,
    private readonly bank: BankService,
    private readonly memory: SupplierMemory,
    private readonly classifier: Classifier,
    private readonly storeFile: (name: string, data: Uint8Array) => Promise<string>,
    private ocr: OcrProvider | null = null,
  ) {}

  setOcrProvider(provider: OcrProvider | null): void {
    this.ocr = provider;
  }

  /** EXTRACTIE: wat staat er op het document? */
  async extract(filename: string, data: Uint8Array): Promise<{ result: DocumentResult; source: string; issues: Issue[] }> {
    const mime = mimeFor(filename);
    if (mime === 'application/xml') {
      const xml = Buffer.from(data).toString('utf8');
      if (!isUbl(xml)) throw new ValidationError('Dit XML-bestand is geen UBL e-factuur');
      return { result: parseUbl(xml), source: 'ubl', issues: [] };
    }
    if (mime === 'application/pdf') {
      const pdf = await extractPdf(data);
      const ubl = findEmbeddedUbl(pdf.attachments);
      if (ubl) return { result: parseUbl(ubl), source: 'ubl', issues: [] };
      if (pdf.textLength > 30) {
        const result = parseDocumentText(pdf.items, 'pdf-text');
        result.pageSizes = pdf.pageSizes;
        return { result, source: 'pdf-text', issues: [] };
      }
    }
    if (!this.ocr || !(await this.ocr.available())) {
      return {
        result: emptyResult(),
        source: 'geen',
        issues: [{ field: 'document', severity: 'fout', message: 'Tekstherkenning (OCR) is nog niet ingesteld. Vul de gegevens zelf in.' }],
      };
    }
    const out = await this.ocr.recognize({ data, mimeType: mime, filename });
    const result = { ...parseDocumentText(out.items, `ocr:${this.ocr.id}`), ...(out.structured ?? {}) } as DocumentResult;
    result.pageSizes = out.pageSizes;
    return { result, source: `ocr:${this.ocr.id}`, issues: [] };
  }

  /** Voegt een document toe en verwerkt het zo ver als verantwoord is. */
  async add(filename: string, data: Uint8Array, asOf: IsoDate = today()): Promise<IntakeDocument> {
    const sha = createHash('sha256').update(data).digest('hex');
    const existing = this.db.prepare('SELECT id FROM documents WHERE sha256 = ?').get(sha) as { id: number } | undefined;
    if (existing) return this.get(existing.id);
    const mime = mimeFor(filename);
    const path = await this.storeFile(filename, data);
    const { result, source, issues: extractionIssues } = await this.extract(filename, data);
    const id = Number(
      this.db.prepare('INSERT INTO documents (file_path, original_name, mime_type, sha256, extraction_source, result) VALUES (?, ?, ?, ?, ?, ?)').run(path, filename, mime, sha, source, JSON.stringify(result)).lastInsertRowid,
    );
    await this.evaluate(id, extractionIssues, asOf);
    return this.get(id);
  }

  /** CLASSIFICATIE + VALIDATIE + CONFIDENCE, en bij HIGH direct verwerken. */
  async evaluate(id: number, extraIssues: Issue[] = [], asOf: IsoDate = today()): Promise<IntakeDocument> {
    const doc = this.get(id);
    const result = doc.result ?? emptyResult();
    const alreadyBooked = this.findBookedBankTransaction(result);
    if (alreadyBooked) {
      // De betaling is al rechtstreeks als kosten geboekt (bv. automatisch herkende leverancier):
      // het document is dan alleen het bewijsstuk — niet nógmaals boeken.
      this.db
        .prepare(`UPDATE documents SET status = 'verwerkt', confidence = 'HIGH', issues = ?, classification = ? WHERE id = ?`)
        .run('[]', JSON.stringify({ categoryKey: 'overig', vatCode: 'hoog', business: true, confidence: 1, source: 'geheugen', reasons: [`bewijsstuk bij banktransactie #${alreadyBooked.id}`], automatic: true }), id);
      return this.get(id);
    }
    const classification = await this.classifier.classify(result);
    const issues = [...extraIssues, ...validateDocument(result, asOf)];
    const bankMatch = this.findBankMatch(result);
    const confidence = assessConfidence({ document: result, issues, classification, bankMatch: !!bankMatch });
    this.db
      .prepare(`UPDATE documents SET classification = ?, confidence = ?, issues = ?, status = 'controle' WHERE id = ?`)
      .run(JSON.stringify(classification), confidence.level, JSON.stringify(issues), id);
    if (confidence.level === 'HIGH' && result.supplier && result.total && result.invoiceDate) {
      this.confirm(id, {
        supplier: result.supplier.value,
        date: result.invoiceDate.value,
        total: result.total.value,
        invoiceNumber: result.invoiceNumber?.value ?? null,
        categoryKey: classification.categoryKey,
        vatCode: classification.vatCode,
        business: classification.business,
        paidWith: bankMatch ? 'bank' : 'later',
      }, { learn: false });
    }
    return this.get(id);
  }

  /** Zoekt een onverwerkte banktransactie met hetzelfde bedrag rond dezelfde datum. */
  findBankMatch(result: DocumentResult): BankTransaction | null {
    if (!result.total) return null;
    const candidates = this.bank.list({ status: 'nieuw', limit: 2000 }).filter((t) => t.amount === -result.total!.value);
    const date = result.invoiceDate?.value;
    const scored = candidates
      .map((t) => {
        let score = 1;
        if (date) {
          const d = Math.abs(diffDays(date, t.transaction_date));
          if (d > 10) return null;
          score += d <= 3 ? 2 : 1;
        }
        if (result.supplier && t.counter_name && supplierKey(t.counter_name).split(' ')[0] === supplierKey(result.supplier.value).split(' ')[0]) score += 3;
        if (result.supplierIban && t.counter_iban === result.supplierIban.value) score += 3;
        return { t, score };
      })
      .filter((x): x is { t: BankTransaction; score: number } => x !== null)
      .sort((a, b) => b.score - a.score);
    if (scored.length === 0) return null;
    if (scored.length > 1 && scored[0]!.score === scored[1]!.score) return null; // twijfel
    return scored[0]!.t;
  }

  /** Een al (zonder document) verwerkte banktransactie met exact dit bedrag en datum ±3 dagen. */
  private findBookedBankTransaction(result: DocumentResult): BankTransaction | null {
    if (!result.total || !result.invoiceDate) return null;
    const rows = this.db
      .prepare(
        `SELECT * FROM bank_transactions WHERE status = 'gematcht' AND amount = ? AND matched_invoice_id IS NULL AND matched_purchase_invoice_id IS NULL
           AND ABS(julianday(transaction_date) - julianday(?)) <= 3
           AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.classification LIKE '%banktransactie #' || bank_transactions.id || '"%')`,
      )
      .all(-result.total.value, result.invoiceDate.value) as BankTransaction[];
    return rows.length === 1 ? rows[0]! : null;
  }

  /**
   * BOEKHOUDING (deterministisch): verwerkt het document met de (bevestigde) gegevens.
   * Leert de leverancier alleen als de gebruiker zelf bevestigde.
   */
  confirm(id: number, c: Confirmation, opts: { learn?: boolean } = {}): IntakeDocument {
    const doc = this.get(id);
    if (doc.status === 'verwerkt') throw new ValidationError('Dit document is al verwerkt');
    if (!c.supplier?.trim()) throw new ValidationError('Vul de winkel of leverancier in');
    if (!Number.isSafeInteger(c.total) || c.total === 0) throw new ValidationError('Vul het totaalbedrag in');
    const category = EXPENSE_CATEGORIES.find((x) => x.key === c.categoryKey);
    if (!category) throw new ValidationError('Kies waar de aankoop voor was');
    if (!(c.vatCode in PURCHASE_VAT_RATES)) throw new ValidationError('Onbekende BTW-keuze');

    tx(this.db, () => {
      if (opts.learn !== false) this.memory.learn(c.supplier, { categoryKey: c.categoryKey, vatCode: c.vatCode, business: c.business });
      const bankTx = doc.bank_match && doc.bank_match.amount === -c.total ? doc.bank_match : null;
      if (!c.business) {
        // privé: niet in de boekhouding; als het van de zakelijke rekening betaald is → privé-opname
        if (bankTx) this.bank.bookToAccount(bankTx.id, { account: ACCOUNTS.priveOpnamen, description: `Privé: ${c.supplier}` });
        this.db.prepare(`UPDATE documents SET status = 'genegeerd' WHERE id = ?`).run(id);
        return;
      }
      const relation = this.relations.findOrCreateSupplier(c.supplier, doc.result?.supplierIban ? { iban: doc.result.supplierIban.value } : {});
      const lines = this.purchaseLines(doc.result, c, category.account);
      const purchase = this.purchases.create({
        relationId: relation.id,
        supplierReference: c.invoiceNumber ?? null,
        invoiceDate: c.date,
        dueDate: doc.result?.dueDate?.value ?? null,
        description: `${category.label} — ${c.supplier}`,
        attachmentPath: doc.file_path,
        jobId: c.jobId ?? null,
        documentId: id,
        lines,
      });
      if (bankTx && c.paidWith === 'bank') this.bank.matchPurchase(bankTx.id, purchase.id);
      else if (c.paidWith === 'kas' || c.paidWith === 'prive') {
        this.purchases.registerPayment(purchase.id, { amount: purchase.total, date: c.date, moneyAccount: c.paidWith === 'kas' ? ACCOUNTS.kas : ACCOUNTS.priveStortingen });
      }
      this.db.prepare(`UPDATE documents SET status = 'verwerkt', purchase_invoice_id = ? WHERE id = ?`).run(purchase.id, id);
    });
    return this.get(id);
  }

  /** Splitst per BTW-tarief als het document dat laat zien en het klopt met het totaal; anders één regel. */
  private purchaseLines(result: DocumentResult | null, c: Confirmation, account: string): PurchaseLineInput[] {
    const vat = result?.vat.value ?? [];
    const complete = vat.length > 1 && vat.every((v) => v.base !== null) && vat.reduce((s, v) => s + (v.base ?? 0) + v.amount, 0) === c.total;
    if (complete) {
      return vat.map((v) => ({
        account,
        netAmount: v.base!,
        vatCode: v.rate === 21 ? 'hoog' : v.rate === 9 ? 'laag' : 'nul',
        vatAmount: v.amount,
        description: `${v.rate}%`,
      }));
    }
    const rate = PURCHASE_VAT_RATES[c.vatCode].percentage;
    const { net, vat: vatAmount } = splitGross(c.total, rate, c.vatCode === 'verlegd');
    // Gebruik het BTW-bedrag van het document als dat binnen 2 cent klopt (bonnen ronden soms per regel af)
    const docVat = vat.length === 1 ? vat[0]!.amount : null;
    const useDoc = docVat !== null && c.vatCode !== 'verlegd' && Math.abs(docVat - vatAmount) <= 2;
    return [{ account, netAmount: useDoc ? c.total - docVat! : net, vatCode: c.vatCode, vatAmount: useDoc ? docVat! : vatAmount }];
  }

  ignore(id: number): void {
    this.db.prepare(`UPDATE documents SET status = 'genegeerd' WHERE id = ? AND status <> 'verwerkt'`).run(id);
  }

  get(id: number): IntakeDocument {
    const row = this.db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new ValidationError(`Document ${id} bestaat niet`);
    const result = row.result ? (JSON.parse(row.result) as DocumentResult) : null;
    return {
      ...row,
      result,
      classification: row.classification ? JSON.parse(row.classification) : null,
      issues: JSON.parse(row.issues),
      bank_match: row.status === 'verwerkt' || !result ? null : this.findBankMatch(result),
    };
  }

  list(status?: IntakeDocument['status']): IntakeDocument[] {
    const rows = this.db.prepare(`SELECT id FROM documents ${status ? 'WHERE status = ?' : ''} ORDER BY id DESC LIMIT 500`).all(...(status ? [status] : [])) as { id: number }[];
    return rows.map((r) => this.get(r.id));
  }
}
