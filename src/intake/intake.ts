import { createHash } from 'node:crypto';
import type { Db } from '../db/database';
import { tx } from '../db/database';
import type { PurchaseService, PurchaseLineInput } from '../documents/purchases';
import type { RelationsService } from '../relations/relations';
import type { BankService, BankTransaction } from '../import/bank';
import { ACCOUNTS } from '../core-ledger/accounts';
import { PRIVATE_CAR_CATEGORIES, type CategoryLookup } from '../shared/categories';
import { PURCHASE_VAT_RATES, isPurchaseVatCode, isReverseCharge, type PurchaseVatCode } from '../shared/vat';
import { diffDays, formatDateNl, today, type IsoDate } from '../shared/dates';
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
import type { FxService } from '../fx/fx';
import { toEuro } from '../fx/fx';
import { CURRENCY_NAMES, formatForeign, withinFx } from '../shared/currency';


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
  splits?: { categoryKey: string; gross: Cents; vatRate?: number }[] | null;
  /** het btw-bedrag zoals de gebruiker het invulde (staat op de bon); leeg = uitrekenen */
  vatAmount?: Cents | null;
  /** zakelijk deel in procenten (1–100); weglaten = wat eerder voor deze leverancier gold, anders 100 */
  businessPct?: number;
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
    private readonly categories: CategoryLookup,
    private readonly storeFile: (name: string, data: Uint8Array) => Promise<string>,
    private ocr: OcrProvider | null = null,
    private readonly autopilot: () => AutopilotLevel = () => 'normaal',
    private readonly locationEnabled: () => boolean = () => false,
    private readonly carUse: () => string = () => 'onbekend',
    /** je eigen btw-nummer: staat vaak bij "Bill to" op een buitenlandse factuur, maar is niet van de leverancier */
    private readonly ownVatNumber: () => string = () => '',
  ) {}

  setOcrProvider(provider: OcrProvider | null): void {
    this.ocr = provider;
  }

  private fx: FxService | null = null;
  setFx(fx: FxService | null): void {
    this.fx = fx;
  }

  /**
   * Vreemde munt (#74): alle bedragen naar euro's met de ECB-koers van de factuurdatum; het origineel
   * blijft bewaard. Later, als de betaling op de bank staat, wordt het bedrag van de bank gebruikt.
   * Geen koers (geen internet): dan geen bedrag in euro's gokken, maar de gebruiker laten invullen.
   */
  async toEuros(result: DocumentResult): Promise<Issue[]> {
    const cur = result.currency?.value;
    if (!cur || cur === 'EUR' || !result.total || result.foreign) return [];
    const foreignTotal = result.total.value;
    const fx = this.fx ? await this.fx.rateFor(cur, result.invoiceDate?.value ?? today()) : null;
    result.foreign = { currency: cur, total: foreignTotal, rate: fx?.rate ?? null, rateDate: fx?.date ?? null, source: fx ? 'ecb' : null };
    const name = CURRENCY_NAMES[cur]?.name ?? cur;
    if (!fx) {
      result.total = null;
      result.subtotal = null;
      result.vat = { ...result.vat, value: [] };
      result.lines = undefined;
      return [{ field: 'total', severity: 'waarschuwing', message: `Deze bon is in ${name} (${formatForeign(foreignTotal, cur)}). De koers kon niet opgehaald worden (geen internet?). Vul het bedrag in euro's in, zoals het van je rekening is afgeschreven.` }];
    }
    scaleMoney(result, (c) => toEuro(c, fx.rate));
    return [];
  }

  /** EXTRACTIE: wat staat er op het document? */
  /** Uitlezen, zonder je eigen btw-nummer als dat van de leverancier. */
  async extract(filename: string, data: Uint8Array): Promise<{ result: DocumentResult; source: string; issues: Issue[] }> {
    const out = await this.extractRaw(filename, data);
    const own = this.ownVatNumber().replace(/[\s.]/g, '').toUpperCase();
    if (own && out.result.supplierVatNumber?.value.replace(/[\s.]/g, '').toUpperCase() === own) out.result.supplierVatNumber = null;
    return out;
  }

  async extractRaw(filename: string, data: Uint8Array): Promise<{ result: DocumentResult; source: string; issues: Issue[] }> {
    const mime = mimeFor(filename);
    if (mime === 'application/xml') {
      const xml = Buffer.from(data).toString('utf8');
      if (!isUbl(xml)) throw new ValidationError('Dit bestand is geen e-factuur. Gebruik de PDF of een foto.');
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
        issues: [{ field: 'document', severity: 'fout', message: 'Deze bon is nog niet uitgelezen. Kies hoe de app bonnen mag lezen, of vul de gegevens zelf in.' }],
      };
    }
    let out;
    try {
      out = await this.ocr.recognize({ data, mimeType: mime, filename });
    } catch (e) {
      // herkenning mislukt: document blijft bewaard, de gebruiker vult zelf in
      return { result: emptyResult(), source: 'geen', issues: [{ field: 'document', severity: 'fout', message: (e as Error).message || 'Tekstherkenning mislukt. Vul de gegevens zelf in.' }] };
    }
    const result = { ...parseDocumentText(out.items, `ocr:${this.ocr.id}`), ...(out.structured ?? {}) } as DocumentResult;
    if (out.structured?.lines) result.linesBasis = computeLinesBasis(result);
    result.pageSizes = out.pageSizes;
    return { result, source: `ocr:${this.ocr.id}`, issues: [] };
  }

  /** Voegt een document toe en verwerkt het zo ver als verantwoord is. */
  async add(filename: string, data: Uint8Array, asOf: IsoDate = today(), opts: { autoConfirm?: boolean } = {}): Promise<IntakeDocument> {
    const sha = createHash('sha256').update(data).digest('hex');
    const existing = this.db.prepare('SELECT id FROM documents WHERE sha256 = ?').get(sha) as { id: number } | undefined;
    if (existing) return this.get(existing.id);
    const mime = mimeFor(filename);
    const path = await this.storeFile(filename, data);
    const { result, source, issues: extracted } = await this.extract(filename, data);
    const extractionIssues = [...extracted, ...(await this.toEuros(result))];
    const id = Number(
      this.db.prepare('INSERT INTO documents (file_path, original_name, mime_type, sha256, extraction_source, result) VALUES (?, ?, ?, ?, ?, ?)').run(path, filename, mime, sha, source, JSON.stringify(result)).lastInsertRowid,
    );
    // Locatie alleen na expliciete toestemming (#32), en alleen in de lokale database
    if (this.locationEnabled() && mime === 'image/jpeg') {
      const gps = readJpegGps(data);
      if (gps) this.db.prepare('UPDATE documents SET gps_lat = ?, gps_lon = ? WHERE id = ?').run(gps.lat, gps.lon, id);
    }
    await this.evaluate(id, extractionIssues, asOf, opts);
    return this.get(id);
  }

  /**
   * Een factuur als bewijsstuk bij een al bestaande afschrijving (vaste lasten, #25): niet opnieuw
   * boeken, alleen bewaren en koppelen. Een document dat al als aankoop verwerkt is, blijft zoals het is.
   */
  async addEvidence(filename: string, data: Uint8Array, bankTransactionId: number): Promise<IntakeDocument> {
    const tx = this.db.prepare('SELECT id FROM bank_transactions WHERE id = ?').get(bankTransactionId);
    if (!tx) throw new ValidationError('Deze betaling bestaat niet (meer)');
    const classification = JSON.stringify({ categoryKey: 'overig', vatCode: 'hoog', business: true, confidence: 1, source: 'geheugen', reasons: [`bewijsstuk bij banktransactie #${bankTransactionId}`], automatic: true });
    const sha = createHash('sha256').update(data).digest('hex');
    const existing = this.db.prepare('SELECT id, status FROM documents WHERE sha256 = ?').get(sha) as { id: number; status: string } | undefined;
    if (existing) {
      if (existing.status !== 'verwerkt') this.db.prepare(`UPDATE documents SET status = 'verwerkt', confidence = 'HIGH', issues = '[]', classification = ? WHERE id = ?`).run(classification, existing.id);
      return this.get(existing.id);
    }
    const mime = mimeFor(filename);
    const path = await this.storeFile(filename, data);
    const { result, source } = await this.extract(filename, data);
    const id = Number(
      this.db
        .prepare(`INSERT INTO documents (file_path, original_name, mime_type, sha256, extraction_source, result, status, confidence, issues, classification) VALUES (?, ?, ?, ?, ?, ?, 'verwerkt', 'HIGH', '[]', ?)`)
        .run(path, filename, mime, sha, source, JSON.stringify(result), classification).lastInsertRowid,
    );
    return this.get(id);
  }

  /** De instapdatum bij overstappen met een lopende administratie (daarvoor hoort alles bij de vorige). */
  private startDate(): IsoDate | null {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = 'switchover'`).get() as { value: string } | undefined;
    if (!row) return null;
    try {
      const s = JSON.parse(row.value) as { mode?: string; date?: string | null };
      return s.mode === 'overstapper' && s.date ? s.date : null;
    } catch {
      return null;
    }
  }

  /** Een bon of factuur als bijlage bij een aankoop die er nog geen had ("Bon toevoegen"). */
  async addPurchaseEvidence(filename: string, data: Uint8Array, purchaseId: number): Promise<IntakeDocument> {
    const p = this.db.prepare('SELECT id, document_id FROM purchase_invoices WHERE id = ?').get(purchaseId) as { id: number; document_id: number | null } | undefined;
    if (!p) throw new ValidationError('Deze aankoop bestaat niet (meer)');
    const sha = createHash('sha256').update(data).digest('hex');
    const existing = this.db.prepare('SELECT id FROM documents WHERE sha256 = ?').get(sha) as { id: number } | undefined;
    const path = existing ? null : await this.storeFile(filename, data);
    const { result, source } = existing ? { result: null, source: null } : await this.extract(filename, data);
    return tx(this.db, () => {
      const id = existing
        ? existing.id
        : Number(
            this.db
              .prepare(`INSERT INTO documents (file_path, original_name, mime_type, sha256, extraction_source, result, status, confidence, issues) VALUES (?, ?, ?, ?, ?, ?, 'verwerkt', 'HIGH', '[]')`)
              .run(path, filename, mimeFor(filename), sha, source, JSON.stringify(result)).lastInsertRowid,
          );
      const doc = this.get(id);
      this.db.prepare(`UPDATE documents SET status = 'verwerkt', purchase_invoice_id = ? WHERE id = ?`).run(purchaseId, id);
      this.db.prepare('UPDATE purchase_invoices SET attachment_path = ?, document_id = ? WHERE id = ?').run(doc.file_path, id, purchaseId);
      return this.get(id);
    });
  }

  /** Bonnen die nog niet uitgelezen konden worden (geen herkenning), nog niet verwerkt. */
  unread(): { id: number; file_path: string; original_name: string }[] {
    return this.db
      .prepare(`SELECT id, file_path, original_name FROM documents WHERE extraction_source = 'geen' AND status IN ('nieuw','controle') AND purchase_invoice_id IS NULL ORDER BY id`)
      .all() as { id: number; file_path: string; original_name: string }[];
  }

  /**
   * Opnieuw lezen, bv. nadat de gebruiker een manier koos om bonnen te laten lezen. Alleen voor een
   * bon die nog niet uitgelezen en niet verwerkt is; daarna altijd eerst controleren (nooit zelf boeken).
   */
  async reread(id: number, data: Uint8Array, asOf: IsoDate = today()): Promise<IntakeDocument> {
    const doc = this.get(id);
    if (doc.extraction_source !== 'geen' || doc.status === 'verwerkt' || doc.status === 'genegeerd') return doc;
    const { result, source, issues: extracted } = await this.extract(doc.original_name, data);
    const issues = [...extracted, ...(await this.toEuros(result))];
    if (source === 'geen') {
      // lukte weer niet: alleen de melding bijwerken
      this.db.prepare('UPDATE documents SET issues = ? WHERE id = ?').run(JSON.stringify(issues), id);
      return this.get(id);
    }
    this.db.prepare('UPDATE documents SET extraction_source = ?, result = ? WHERE id = ?').run(source, JSON.stringify(result), id);
    await this.evaluate(id, issues, asOf, { autoConfirm: false });
    return this.get(id);
  }

  /** CLASSIFICATIE + VALIDATIE + CONFIDENCE, en bij HIGH direct verwerken. */
  /** autoConfirm: false = nooit zelf boeken, altijd eerst laten controleren (bv. binnengekomen per e-mail) */
  async evaluate(id: number, extraIssues: Issue[] = [], asOf: IsoDate = today(), opts: { autoConfirm?: boolean } = {}): Promise<IntakeDocument> {
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
    let classification = await this.classifier.classify(result);
    if (PRIVATE_CAR_CATEGORIES.includes(classification.categoryKey) && classification.business && this.carUse() === 'prive') {
      // privéauto: bon van tanken/parkeren is privé (aftrek via de kilometers)
      classification = { ...classification, business: false, automatic: false, reasons: [...classification.reasons, 'privéauto: tanken, parkeren en onderhoud zijn privé; zakelijke km vul je apart in'] };
    }
    const issues = [...extraIssues, ...validateDocument(result, asOf)];
    if (duplicate) {
      issues.push({ field: 'duplicate', severity: 'fout', message: `Lijkt op ${duplicate.label}. Is dit dezelfde aankoop?`, suggestion: duplicate });
    }
    // van vóór de instapdatum: hoort bij de vorige administratie, niet als nieuwe (open) aankoop
    const start = this.startDate();
    if (start && result.invoiceDate && result.invoiceDate.value < start) {
      issues.push({ field: 'invoiceDate', severity: 'fout', message: `Deze factuur is van ${formatDateNl(result.invoiceDate.value)}, van vóór je instapdatum (${formatDateNl(start)}). Die hoort bij je vorige administratie. Zocht je de factuur bij een betaling van dit jaar? Kijk dan naar jaar en maand in het factuurnummer.` });
    }
    const bankMatch = this.findBankMatch(result);
    // vreemde munt: wat de bank afschreef is het echte bedrag in euro's (en daarmee de echte koers)
    if (bankMatch && result.foreign && result.total && -bankMatch.amount !== result.total.value) {
      const eur = -bankMatch.amount;
      const factor = eur / result.total.value;
      scaleMoney(result, (c) => Math.round(c * factor));
      result.total = { ...result.total!, value: eur, confidence: 0.99 };
      result.foreign = { ...result.foreign, rate: result.foreign.total / eur, rateDate: bankMatch.transaction_date, source: 'bank' };
      this.db.prepare('UPDATE documents SET result = ? WHERE id = ?').run(JSON.stringify(result), id);
    }
    // geschat met de dagkoers en nog geen betaling: niet vanzelf verwerken, eerst even laten kijken
    if (result.foreign && !bankMatch) issues.push({ field: 'total', severity: 'waarschuwing', message: `Omgerekend met de koers van de ECB. Komt de betaling later op de bank, dan rekent de app het verschil vanzelf af.` });
    const assessed = assessConfidence({ document: result, issues, classification, bankMatch: !!bankMatch });
    const rule = this.memory.get(result.supplier?.value);
    const { decisions, signals } = documentDecisions({ doc: result, issues, classification, bankMatch, rule, level: this.autopilot(), categoryLabel: this.categories.label(classification.categoryKey) });
    // HIGH alleen als álle velden en beslissingen boven hun drempel zitten (#21)
    // Gemengde bon (bv. materiaal + werkbroek): nooit automatisch, eerst vragen of we splitsen (#23)
    const split = suggestSplit(result);
    if (split) issues.push({ field: 'lines', severity: 'waarschuwing', message: splitQuestion(split, (k) => this.categories.label(k)), suggestion: split });
    const level: ConfidenceLevel = assessed.level === 'HIGH' && (!allCertain(decisions) || split) ? 'MEDIUM' : assessed.level;
    this.db
      .prepare(`UPDATE documents SET classification = ?, confidence = ?, issues = ?, decisions = ?, status = 'controle' WHERE id = ?`)
      .run(JSON.stringify(classification), level, JSON.stringify(issues), JSON.stringify(decisions), id);
    if (opts.autoConfirm !== false && level === 'HIGH' && allCertain(decisions) && result.supplier && result.total && result.invoiceDate) {
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
        summary: `${result.supplier.value} ${formatEuro(result.total.value)} verwerkt als ${this.categories.label(classification.categoryKey)}`,
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
    // vreemde munt (#74): ook hetzelfde bedrag in die munt, en een oudere boeking waarin dat bedrag als euro's staat
    const foreign = result.foreign ?? null;

    const purchases = this.db
      .prepare(
        `SELECT p.id, p.supplier_reference, p.invoice_date, p.document_id, r.name AS supplier
         FROM purchase_invoices p LEFT JOIN relations r ON r.id = p.relation_id
         WHERE p.total = ? OR (? IS NOT NULL AND ((p.currency = ? AND p.foreign_total = ?) OR (p.currency IS NULL AND p.total = ?)))`,
      )
      .all(total, foreign?.currency ?? null, foreign?.currency ?? null, foreign?.total ?? null, foreign?.total ?? null) as { id: number; supplier_reference: string | null; invoice_date: string; document_id: number | null; supplier: string | null }[];
    const sameAmount = (r: DocumentResult) =>
      r.total!.value === total || (!!foreign && (r.foreign ? r.foreign.currency === foreign.currency && r.foreign.total === foreign.total : r.total!.value === foreign.total));
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
      if (!r.total || !sameAmount(r) || !r.supplier || supplierKey(r.supplier.value) !== key) continue;
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
      if (doc.status === 'verwerkt') throw new ValidationError('Dit bonnetje is al verwerkt');
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
    const foreign = Boolean(result.foreign);
    // vreemde munt: de bank rekende een eigen koers, dus ongeveer hetzelfde bedrag
    const candidates = this.bank.list({ status: 'nieuw', limit: 2000 }).filter((t) => (foreign ? t.amount < 0 && withinFx(-t.amount, result.total!.value) : t.amount === -result.total!.value));
    const date = result.invoiceDate?.value;
    const scored = candidates
      .map((t) => {
        let score = 1;
        if (date) {
          const d = Math.abs(diffDays(date, t.transaction_date));
          if (d > 10) return null;
          score += d <= 3 ? 2 : 1;
        }
        const nameMatch = Boolean(result.supplier && t.counter_name && supplierKey(t.counter_name).split(' ')[0] === supplierKey(result.supplier.value).split(' ')[0]);
        if (nameMatch) score += 3;
        if (result.supplierIban && t.counter_iban === result.supplierIban.value) score += 3;
        // bij een omgerekend bedrag alleen met de naam van de winkel, of als het bedrag heel dicht bij ligt
        if (foreign && !nameMatch && Math.abs(-t.amount - result.total!.value) > Math.round(result.total!.value * 0.02)) return null;
        return { t, score };
      })
      .filter((x): x is { t: BankTransaction; score: number } => x !== null)
      .sort((a, b) => b.score - a.score);
    if (scored.length === 0) return null;
    if (scored.length > 1 && scored[0]!.score === scored[1]!.score) return null; // twijfel
    return scored[0]!.t;
  }

  /**
   * Een al (zonder document) verwerkte banktransactie met exact dit bedrag en datum ±3 dagen.
   * Vreemde munt (#74): de bank rekende een eigen koers, dus ongeveer dit bedrag, tot 7 dagen later
   * en alleen met de naam van de leverancier. Is er rond die datum (10 dagen vóór tot 20 dagen na) nog
   * een vergelijkbare afschrijving van die leverancier, dan is het te onzeker: dan niets aannemen.
   */
  findBookedBankTransaction(result: DocumentResult): BankTransaction | null {
    if (!result.total || !result.invoiceDate) return null;
    if (result.foreign) {
      const supplier = result.supplier ? supplierKey(result.supplier.value) : '';
      if (!supplier) return null;
      // "Eleven Labs Inc." op de factuur, "Elevenlabs" op de bank; "fireworks.ai" en "Fireworks AI"
      const compact = (k: string) => k.replace(/\s+/g, '');
      const same = (name: string) => {
        const k = supplierKey(name);
        const [a, b] = [compact(supplier), compact(k)];
        return k.split(' ')[0] === supplier.split(' ')[0] || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)));
      };
      const rows = (
        this.db
          .prepare(
            `SELECT * FROM bank_transactions WHERE status = 'gematcht' AND amount < 0 AND matched_invoice_id IS NULL AND matched_purchase_invoice_id IS NULL
               AND julianday(transaction_date) - julianday(?) BETWEEN -10 AND 20
               AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.classification LIKE '%banktransactie #' || bank_transactions.id || '"%')
               -- alleen als kosten geboekt: niet een privé-opname of eigen overboeking met toevallig hetzelfde bedrag
               AND EXISTS (SELECT 1 FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id
                            WHERE l.journal_entry_id = bank_transactions.matched_journal_entry_id AND a.category = 'kosten')`,
          )
          .all(result.invoiceDate.value) as BankTransaction[]
      ).filter((t) => withinFx(-t.amount, result.total!.value) && !!t.counter_name && same(t.counter_name));
      // een factuur in dollars wordt vaak pas later met de kaart betaald (bv. 1 aug gefactureerd, 14 aug betaald);
      // een abonnement komt maar eens per maand langs, dus binnen 20 dagen is het deze betaling
      const days = (t: BankTransaction) => diffDays(result.invoiceDate!.value, t.transaction_date);
      return rows.length === 1 && days(rows[0]!) >= -3 && days(rows[0]!) <= 20 ? rows[0]! : null;
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM bank_transactions WHERE status = 'gematcht' AND amount = ? AND matched_invoice_id IS NULL AND matched_purchase_invoice_id IS NULL
           AND ABS(julianday(transaction_date) - julianday(?)) <= 3
           AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.classification LIKE '%banktransactie #' || bank_transactions.id || '"%')
               -- alleen als kosten geboekt: niet een privé-opname of eigen overboeking met toevallig hetzelfde bedrag
               AND EXISTS (SELECT 1 FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id
                            WHERE l.journal_entry_id = bank_transactions.matched_journal_entry_id AND a.category = 'kosten')`,
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
    if (doc.status === 'verwerkt') throw new ValidationError('Dit bonnetje is al verwerkt');
    if (!c.supplier?.trim()) throw new ValidationError('Vul de winkel of leverancier in');
    if (!Number.isSafeInteger(c.total) || c.total === 0) throw new ValidationError('Vul het totaalbedrag in');
    const category = this.categories.find(c.categoryKey);
    if (!category) throw new ValidationError('Kies waar de aankoop voor was');
    if (!isPurchaseVatCode(c.vatCode)) throw new ValidationError('Kies of er btw op de bon stond');

    tx(this.db, () => {
      if (opts.learn !== false) this.memory.learn(c.supplier, { categoryKey: c.categoryKey, vatCode: c.vatCode, business: c.business });
      const bankTx = doc.bank_match && (doc.bank_match.amount === -c.total || (doc.result?.foreign && withinFx(-doc.bank_match.amount, c.total))) ? doc.bank_match : null;
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
        businessPct: c.businessPct,
        lines,
        foreign: doc.result?.foreign ? { currency: doc.result.foreign.currency, total: doc.result.foreign.total, rate: doc.result.foreign.total / c.total } : null,
      });
      if (bankTx && c.paidWith === 'bank') this.bank.matchPurchase(bankTx.id, purchase.id);
      else {
        // niet op de zakelijke rekening gevonden: leverancier die je altijd privé/contant betaalt → meteen betaald
        const paidWith = c.paidWith === 'later' ? relation.paid_with : c.paidWith === 'bank' ? null : c.paidWith;
        if (paidWith) this.purchases.registerPayment(purchase.id, { amount: purchase.total, date: c.date, moneyAccount: paidWith === 'kas' ? ACCOUNTS.kas : ACCOUNTS.priveStortingen });
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
      // een deel met een eigen tarief (van de bonregels) krijgt dat tarief; anders het tarief van de bon
      const codeFor = (r: number | undefined): PurchaseVatCode => (r === undefined || isReverseCharge(c.vatCode) ? c.vatCode : r === 21 ? 'hoog' : r === 9 ? 'laag' : r === 0 ? 'nul' : c.vatCode);
      return c.splits.map((sp) => {
        const vatCode = codeFor(sp.vatRate);
        const rate = PURCHASE_VAT_RATES[vatCode].percentage;
        if (sp.categoryKey === 'prive') return { account: ACCOUNTS.priveOpnamen, netAmount: sp.gross, vatCode: 'geen' as const, description: 'Privé-deel van de bon' };
        const cat = this.categories.find(sp.categoryKey);
        if (!cat) throw new ValidationError('Kies bij elk deel waar het voor was');
        const { net, vat } = splitGross(sp.gross, rate, isReverseCharge(vatCode));
        return { account: cat.account, netAmount: net, vatCode, vatAmount: vat, description: cat.label };
      });
    }
    // zelf ingevuld btw-bedrag: gaat voor wat de app las of uitrekende (niet bij verlegde btw: die reken je zelf uit)
    if (c.vatAmount !== undefined && c.vatAmount !== null && !isReverseCharge(c.vatCode)) {
      if (!Number.isInteger(c.vatAmount) || c.vatAmount < 0 || c.vatAmount > c.total) throw new ValidationError('Het btw-bedrag kan niet meer zijn dan het totaal');
      const pct = PURCHASE_VAT_RATES[c.vatCode].percentage;
      if (pct === 0 && c.vatAmount !== 0) throw new ValidationError('Bij "geen btw" of 0% hoort geen btw-bedrag');
      // nooit meer btw dan het tarief toelaat (een paar cent afronding per regel mag)
      const max = Math.round((c.total * pct) / (100 + pct));
      if (c.vatAmount > max + 2) throw new ValidationError(`Bij ${pct}% kan de btw hooguit ${(max / 100).toFixed(2).replace('.', ',')} zijn. Staat er meer op de bon? Dan klopt het tarief of het totaal niet.`);
      return [{ account, netAmount: c.total - c.vatAmount, vatCode: c.vatCode, vatAmount: c.vatAmount }];
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
    const { net, vat: vatAmount } = splitGross(c.total, rate, isReverseCharge(c.vatCode));
    // Gebruik het BTW-bedrag van het document als dat binnen 2 cent klopt (bonnen ronden soms per regel af)
    const docVat = vat.length === 1 ? vat[0]!.amount : null;
    const useDoc = docVat !== null && !isReverseCharge(c.vatCode) && Math.abs(docVat - vatAmount) <= 2;
    return [{ account, netAmount: useDoc ? c.total - docVat! : net, vatCode: c.vatCode, vatAmount: useDoc ? docVat! : vatAmount }];
  }

  ignore(id: number): void {
    this.db.prepare(`UPDATE documents SET status = 'genegeerd' WHERE id = ? AND status <> 'verwerkt'`).run(id);
  }

  get(id: number): IntakeDocument {
    const row = this.db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new ValidationError('Dit bonnetje bestaat niet (meer)');
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

/** Alle geldbedragen van een document omrekenen (vreemde munt → euro's). */
function scaleMoney(result: DocumentResult, f: (cents: number) => number): void {
  if (result.total) result.total = { ...result.total, value: f(result.total.value) };
  result.vat = { ...result.vat, value: result.vat.value.map((v) => ({ ...v, base: v.base === null ? null : f(v.base), amount: f(v.amount) })) };
  // los afronden kan een cent schelen: het subtotaal is wat overblijft, zodat subtotaal + btw = totaal blijft
  if (result.subtotal) {
    const vat = result.vat.value.reduce((s, v) => s + v.amount, 0);
    result.subtotal = { ...result.subtotal, value: result.total ? result.total.value - vat : f(result.subtotal.value) };
  }
  if (result.lines) result.lines = result.lines.map((l) => ({ ...l, value: { ...l.value, amount: f(l.value.amount), unitPrice: l.value.unitPrice === null ? null : f(l.value.unitPrice) } }));
}
