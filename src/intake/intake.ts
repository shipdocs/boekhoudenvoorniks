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
import { formatEuro, type Cents } from '../shared/money';
import { countDecision, logAutomation } from '../inbox/automation-log';
import { allCertain, type AutopilotLevel, type Decision } from '../automation/decisions';
import { explain } from '../automation/explain';
import { documentDecisions } from './decisions';
import { computeLinesBasis, splitQuestion, suggestSplit } from './line-items';
import { readJpegGps } from './exif';
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
  /** zekerheid per veld en per beslissing (#21) */
  decisions: Decision[] | null;
  /** dit document is een kopie van een eerder document (#31) */
  duplicate_of_document_id: number | null;
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
  /** bon splitsen over categorieën (#23); bedragen incl. btw, som = totaal. 'prive' = niet zakelijk. */
  splits?: { categoryKey: string; gross: Cents }[] | null;
}

type Row = Omit<IntakeDocument, 'result' | 'classification' | 'issues' | 'bank_match' | 'decisions'> & { result: string | null; classification: string | null; issues: string; decisions: string | null };

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

/** Hoe betrouwbaar is de bron? Bij dubbele documenten bewaren we het beste bewijs. */
export function evidenceRank(source: string | null): number {
  if (source === 'ubl') return 3;
  if (source === 'pdf-text') return 2;
  if (source?.startsWith('ocr')) return 1;
  return 0;
}

const normalizeInvoiceNumber = (n: string) => n.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^0+/, '');

export interface DuplicateMatch {
  /** zeker: zelfde leverancier, factuurnummer en bedrag. Mogelijk: zelfde leverancier en bedrag rond dezelfde datum. */
  strength: 'zeker' | 'mogelijk';
  documentId: number | null;
  purchaseId: number | null;
  label: string;
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
    private readonly autopilot: () => AutopilotLevel = () => 'normaal',
    private readonly locationEnabled: () => boolean = () => false,
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
    if (out.structured?.lines) result.linesBasis = computeLinesBasis(result);
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
    // Locatie alleen na expliciete toestemming (#32), en alleen in de lokale database
    if (this.locationEnabled() && mime === 'image/jpeg') {
      const gps = readJpegGps(data);
      if (gps) this.db.prepare('UPDATE documents SET gps_lat = ?, gps_lon = ? WHERE id = ?').run(gps.lat, gps.lon, id);
    }
    await this.evaluate(id, extractionIssues, asOf);
    return this.get(id);
  }

  /** CLASSIFICATIE + VALIDATIE + CONFIDENCE, en bij HIGH direct verwerken. */
  async evaluate(id: number, extraIssues: Issue[] = [], asOf: IsoDate = today()): Promise<IntakeDocument> {
    const doc = this.get(id);
    const result = doc.result ?? emptyResult();
    // Eerst: hebben we dit al? Hetzelfde document komt vaak twee keer binnen (mail + foto, PDF + e-factuur).
    let duplicate = this.findDuplicate(id, result);
    if (duplicate?.strength === 'zeker') {
      const original = duplicate.documentId ? this.get(duplicate.documentId) : null;
      if (original && original.status !== 'verwerkt' && evidenceRank(doc.extraction_source) > evidenceRank(original.extraction_source)) {
        // het nieuwe document is beter bewijs en het oude is nog niet geboekt: het oude wordt de kopie
        this.markDuplicate(original.id, { documentId: id, purchaseId: null });
        duplicate = null;
      } else {
        this.markDuplicate(id, duplicate);
        return this.get(id);
      }
    }
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
    if (duplicate) {
      issues.push({ field: 'duplicate', severity: 'fout', message: `Lijkt op ${duplicate.label}. Is dit dezelfde aankoop?`, suggestion: duplicate });
    }
    const bankMatch = this.findBankMatch(result);
    const assessed = assessConfidence({ document: result, issues, classification, bankMatch: !!bankMatch });
    const rule = this.memory.get(result.supplier?.value);
    const { decisions, signals } = documentDecisions({ doc: result, issues, classification, bankMatch, rule, level: this.autopilot() });
    // HIGH alleen als álle velden en beslissingen boven hun drempel zitten (#21)
    // Gemengde bon (bv. materiaal + werkbroek): nooit automatisch, eerst vragen of we splitsen (#23)
    const split = suggestSplit(result);
    if (split) issues.push({ field: 'lines', severity: 'waarschuwing', message: splitQuestion(split), suggestion: split });
    const level: ConfidenceLevel = assessed.level === 'HIGH' && (!allCertain(decisions) || split) ? 'MEDIUM' : assessed.level;
    this.db
      .prepare(`UPDATE documents SET classification = ?, confidence = ?, issues = ?, decisions = ?, status = 'controle' WHERE id = ?`)
      .run(JSON.stringify(classification), level, JSON.stringify(issues), JSON.stringify(decisions), id);
    if (level === 'HIGH' && allCertain(decisions) && result.supplier && result.total && result.invoiceDate) {
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
      const explanation = { ...explain(signals, decisions), refs: bankMatch ? { bankTransactionId: bankMatch.id } : undefined };
      logAutomation(this.db, {
        kind: 'document-auto',
        ref_id: id,
        summary: `${result.supplier.value} ${formatEuro(result.total.value)} verwerkt als ${EXPENSE_CATEGORIES.find((c) => c.key === classification.categoryKey)?.label.toLowerCase() ?? classification.categoryKey}`,
        reason: explanation.sentence,
        details: explanation,
      });
      for (const d of decisions) countDecision(this.db, d.kind, 'automatic');
    }
    return this.get(id);
  }

  /**
   * Zoekt of dit document al eerder binnenkwam of al geboekt is.
   * Zeker = zelfde leverancier + factuurnummer + totaal. Mogelijk = zelfde leverancier + totaal, datum ±3 dagen.
   */
  findDuplicate(id: number, result: DocumentResult): DuplicateMatch | null {
    if (!result.total || !result.supplier) return null;
    const key = supplierKey(result.supplier.value);
    if (!key) return null;
    const number = result.invoiceNumber?.value ? normalizeInvoiceNumber(result.invoiceNumber.value) : null;
    const date = result.invoiceDate?.value ?? null;
    const total = result.total.value;

    const purchases = this.db
      .prepare(
        `SELECT p.id, p.supplier_reference, p.invoice_date, p.document_id, r.name AS supplier
         FROM purchase_invoices p LEFT JOIN relations r ON r.id = p.relation_id WHERE p.total = ?`,
      )
      .all(total) as { id: number; supplier_reference: string | null; invoice_date: string; document_id: number | null; supplier: string | null }[];
    const docs = this.db
      .prepare(`SELECT id, result, status, purchase_invoice_id FROM documents WHERE id < ? AND status IN ('nieuw','controle','verwerkt') AND result IS NOT NULL`)
      .all(id) as { id: number; result: string; status: string; purchase_invoice_id: number | null }[];

    let weak: DuplicateMatch | null = null;
    const near = (d: string | null) => !!date && !!d && Math.abs(diffDays(date, d)) <= 3;
    for (const p of purchases) {
      if (!p.supplier || supplierKey(p.supplier) !== key) continue;
      const label = `de aankoop bij ${p.supplier} van ${p.invoice_date}`;
      if (number && p.supplier_reference && normalizeInvoiceNumber(p.supplier_reference) === number) {
        return { strength: 'zeker', documentId: p.document_id, purchaseId: p.id, label };
      }
      if (!weak && near(p.invoice_date) && !(number && p.supplier_reference)) weak = { strength: 'mogelijk', documentId: p.document_id, purchaseId: p.id, label };
    }
    for (const d of docs) {
      const r = JSON.parse(d.result) as DocumentResult;
      if (!r.total || r.total.value !== total || !r.supplier || supplierKey(r.supplier.value) !== key) continue;
      const label = `het document van ${r.supplier.value}${r.invoiceDate ? ` van ${r.invoiceDate.value}` : ''}`;
      const otherNumber = r.invoiceNumber?.value ? normalizeInvoiceNumber(r.invoiceNumber.value) : null;
      if (number && otherNumber === number) return { strength: 'zeker', documentId: d.id, purchaseId: d.purchase_invoice_id, label };
      if (!weak && near(r.invoiceDate?.value ?? null) && !(number && otherNumber)) weak = { strength: 'mogelijk', documentId: d.id, purchaseId: d.purchase_invoice_id, label };
    }
    return weak;
  }

  /**
   * Legt vast dat een document een kopie is. Is de kopie beter bewijs (bv. e-factuur i.p.v. foto),
   * dan wordt die de bijlage van de aankoop; er wordt nooit iets dubbel geboekt.
   */
  markDuplicate(id: number, match: Pick<DuplicateMatch, 'documentId' | 'purchaseId'>): IntakeDocument {
    tx(this.db, () => {
      const doc = this.get(id);
      if (doc.status === 'verwerkt') throw new ValidationError('Dit document is al verwerkt');
      const original = match.documentId ? this.get(match.documentId) : null;
      const purchaseId = match.purchaseId ?? original?.purchase_invoice_id ?? null;
      if (purchaseId) {
        const current = this.db.prepare('SELECT document_id FROM purchase_invoices WHERE id = ?').get(purchaseId) as { document_id: number | null } | undefined;
        const currentDoc = current?.document_id ? this.get(current.document_id) : null;
        if (current && evidenceRank(doc.extraction_source) > evidenceRank(currentDoc?.extraction_source ?? null)) {
          this.db.prepare('UPDATE purchase_invoices SET attachment_path = ?, document_id = ? WHERE id = ?').run(doc.file_path, id, purchaseId);
        }
      }
      this.db
        .prepare(`UPDATE documents SET status = 'genegeerd', duplicate_of_document_id = ?, purchase_invoice_id = ?, issues = ? WHERE id = ?`)
        .run(match.documentId, purchaseId, JSON.stringify([{ field: 'duplicate', severity: 'waarschuwing', message: 'Dubbel: dit document hadden we al. Niet opnieuw geboekt.' }]), id);
    });
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
        payeeIban: doc.result?.supplierIban?.value ?? null,
        lines,
      });
      if (bankTx && c.paidWith === 'bank') this.bank.matchPurchase(bankTx.id, purchase.id);
      else if (c.paidWith === 'kas' || c.paidWith === 'prive') {
        this.purchases.registerPayment(purchase.id, { amount: purchase.total, date: c.date, moneyAccount: c.paidWith === 'kas' ? ACCOUNTS.kas : ACCOUNTS.priveStortingen });
      }
      this.db.prepare(`UPDATE documents SET status = 'verwerkt', purchase_invoice_id = ? WHERE id = ?`).run(purchase.id, id);
      if (c.jobId) {
        // eerste foto met locatie bij een klus zonder locatie wordt de kluslocatie (alleen als opt-in de locatie heeft opgeslagen)
        this.db.prepare('UPDATE jobs SET lat = (SELECT gps_lat FROM documents WHERE id = ?), lon = (SELECT gps_lon FROM documents WHERE id = ?) WHERE id = ? AND lat IS NULL AND (SELECT gps_lat FROM documents WHERE id = ?) IS NOT NULL').run(id, id, c.jobId, id);
      }
    });
    return this.get(id);
  }

  /** Splitst per BTW-tarief als het document dat laat zien en het klopt met het totaal; anders één regel. */
  private purchaseLines(result: DocumentResult | null, c: Confirmation, account: string): PurchaseLineInput[] {
    if (c.splits && c.splits.length > 1) {
      if (c.splits.reduce((s, x) => s + x.gross, 0) !== c.total) throw new ValidationError('De delen tellen niet op tot het totaal');
      const rate = PURCHASE_VAT_RATES[c.vatCode].percentage;
      return c.splits.map((sp) => {
        if (sp.categoryKey === 'prive') return { account: ACCOUNTS.priveOpnamen, netAmount: sp.gross, vatCode: 'geen' as const, description: 'Privé-deel van de bon' };
        const cat = EXPENSE_CATEGORIES.find((x) => x.key === sp.categoryKey);
        if (!cat) throw new ValidationError(`Onbekende categorie ${sp.categoryKey}`);
        const { net, vat } = splitGross(sp.gross, rate, c.vatCode === 'verlegd');
        return { account: cat.account, netAmount: net, vatCode: c.vatCode, vatAmount: vat, description: cat.label };
      });
    }
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
      decisions: row.decisions ? (JSON.parse(row.decisions) as Decision[]) : null,
      bank_match: row.status === 'verwerkt' || !result ? null : this.findBankMatch(result),
    };
  }

  list(status?: IntakeDocument['status']): IntakeDocument[] {
    const rows = this.db.prepare(`SELECT id FROM documents ${status ? 'WHERE status = ?' : ''} ORDER BY id DESC LIMIT 500`).all(...(status ? [status] : [])) as { id: number }[];
    return rows.map((r) => this.get(r.id));
  }
}
