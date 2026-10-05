import { createHash } from 'node:crypto';
import type { Db } from '../db/database';
import { tx } from '../db/database';
import type { PurchaseService, PurchaseLineInput } from '../documents/purchases';
import type { RelationsService } from '../relations/relations';
import type { BankService, BankTransaction } from '../import/bank';
import { ACCOUNTS } from '../core-ledger/accounts';
import { PRIVATE_CAR_CATEGORIES, type CategoryLookup } from '../shared/categories';
import { PURCHASE_VAT_RATES, isPurchaseVatCode, isReverseCharge, reverseChargeRate, type PurchaseVatCode } from '../shared/vat';
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
import { amountOutlierIssue } from './outliers';
import { assessConfidence } from './confidence';
import { PROPOSED_BY_LABEL, type Classifier, type Classification } from './classify';
import type { SupplierMemory } from './supplier-memory';
import { supplierKey } from './supplier-memory';
import type { OcrProvider } from './ocr';
import type { ConfidenceLevel, DocumentResult, Issue } from './types';
import { splitGross } from '../import/bank';
import type { FxService } from '../fx/fx';
import { toEuro } from '../fx/fx';
import { CURRENCY_NAMES, formatForeign, withinFx } from '../shared/currency';
import { EvidenceLinks, sameTarget, targetKey, type DocumentLink, type LinkOrigin, type LinkProvenance, type LinkTarget, type TargetInfo } from '../documents/evidence-links';
import type { DocumentOutcome } from '../shared/document-outcome';
import { detectOwnInvoice, sameCompanyName, OWN_COMPANY_CANDIDATE, OWN_COMPANY_ISSUE, type OwnIdentity, type OwnInvoice } from './own-company';
import type { PaidWith } from '../shared/paid-with';
import { BankPurchaseMatcher, BANK_DAYS_BEFORE, SURE_DAYS, dateFits, fitOf, probeOfDocument, sameSupplierName } from '../documents/bank-purchase-match';


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
  /** notitie die op de telefoon bij de bon is getypt (bonnenscanner, #48) */
  note: string | null;
  /** betaalwijze die op de telefoon is gekozen: het voorstel bij het bevestigen (#48) */
  proposed_paid_with: PaidWith | null;
  created_at: string;
  bank_match: BankTransaction | null;
  /**
   * Past die betaling ook op leverancier en datum, niet alleen op het bedrag (de gedeelde vergelijking, #221)?
   * Alleen dan wijkt de betaalwijze van de telefoon ervoor (#222): de aankoop blijft open tot de vraag bij de betaling.
   */
  bank_match_strong: boolean;
  /** de aankoop of bankbetaling waar dit document bij hoort (#179); null = nergens aan gekoppeld */
  link: DocumentLink | null;
  /** wat er met het document gebeurd is: geboekt, alleen bewijs, dubbel, of nog controleren */
  outcome: DocumentOutcome;
}

/**
 * Wat er bij het toevoegen van een bestand gebeurde. `already_present`: exact dit bestand stond er
 * al in; dan is er niets bijgekomen of veranderd en is dit het bestaande document.
 */
export interface UploadResult extends IntakeDocument {
  already_present: boolean;
  /** "Bon toevoegen" bij een ander doel dan waar dit document (of dezelfde factuur) al bij hoort: niets gekoppeld */
  blocked: { existing: TargetInfo; requested: TargetInfo } | null;
  /** het bestaande document hoort nog nergens bij: je kunt het alsnog zelf aan dit doel koppelen */
  linkable: boolean;
}

/** Een voorstel dat op een keuze wacht: "is dit dezelfde aankoop?" of "alleen als bewijs koppelen?". */
export interface PendingProposal {
  kind: 'duplicate' | 'evidence';
  /** 'aankoop:5', 'bank:7' of 'document:3': waar het voorstel over gaat */
  candidate: string;
  /** het bestaande document om ernaast te leggen, als dat er is */
  documentId: number | null;
  /** de aankoop of betaling waar het om gaat (leverancier, datum, bedrag, kenmerk), als die er is */
  target: TargetInfo | null;
}

/** "Dit document stond er al in": een bijlage uit de mail die er al was (exact hetzelfde bestand, of dezelfde factuur). */
export interface DocumentNotice {
  id: number;
  kind: 'stond-er-al' | 'dubbel';
  original_name: string;
  source: string;
  sender: string | null;
  existing_document_id: number | null;
  purchase_invoice_id: number | null;
  created_at: string;
}

/** Vraag bij een bon waarvan de betaling al rechtstreeks als kosten geboekt is (#179). */
export const EVIDENCE_QUESTION = 'Deze betaling is al geboekt. Wil je deze bon alleen als bewijsstuk koppelen?';

/** Categorie voor "weet ik nog niet (vraag mijn boekhouder)": boekt op Vraagposten (1690). */
export const QUESTION_CATEGORY = 'onbekend';

export interface Confirmation {
  supplier: string;
  date: IsoDate;
  total: Cents;
  invoiceNumber?: string | null;
  categoryKey: string;
  vatCode: PurchaseVatCode;
  /** verlegde inkoop: 9 als de prestatie onder het lage tarief valt; weglaten = 21% (#316) */
  vatRate?: number;
  /** false = privé-uitgave: niet in de zakelijke boekhouding */
  business: boolean;
  paidWith: PaidWith;
  jobId?: number | null;
  /** bon splitsen over categorieën (#23); bedragen incl. btw, som = totaal. 'prive' = niet zakelijk. */
  splits?: { categoryKey: string; gross: Cents; vatRate?: number }[] | null;
  /** het btw-bedrag zoals de gebruiker het invulde (staat op de bon); leeg = uitrekenen */
  vatAmount?: Cents | null;
  /** zakelijk deel in procenten (1–100); weglaten = wat eerder voor deze leverancier gold, anders 100 */
  businessPct?: number;
  /** "Toch boeken": de gebruiker zag dat er al een aankoop of bon staat die lijkt op wat hij hier heeft verbeterd (#224) */
  allowDuplicate?: boolean;
}

type Row = Omit<IntakeDocument, 'result' | 'classification' | 'issues' | 'bank_match' | 'bank_match_strong' | 'decisions' | 'link' | 'outcome'> & { result: string | null; classification: string | null; issues: string; decisions: string | null };

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
 * Hoe betrouwbaar zijn de gelezen gegevens? Van twee kopieën die nog niet geboekt zijn, gaat de app
 * verder met de best gelezen (e-factuur boven PDF-tekst boven een foto). Welk bestand het
 * hoofdbewijsstuk wordt, is iets anders: zie primaryRank.
 */
export function evidenceRank(source: string | null): number {
  if (source === 'ubl') return 3;
  if (source === 'pdf-text') return 2;
  if (source?.startsWith('ocr')) return 1;
  return 0;
}

const normalizeInvoiceNumber = (n: string) => n.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^0+/, '');

/** Een gelezen factuur- of bonnummer telt pas als bewijs vanaf deze zekerheid (en minstens 3 tekens). */
export const RELIABLE_NUMBER_CONFIDENCE = 0.8;

export interface DuplicateMatch {
  /**
   * zeker: zelfde leverancier, bedrag en betrouwbaar factuur- of bonnummer, geen andere datum en
   * dezelfde soort (factuur of creditnota). Al het andere dat erop lijkt is "mogelijk": dan vraagt de app het.
   */
  strength: 'zeker' | 'mogelijk';
  documentId: number | null;
  purchaseId: number | null;
  /** het bestaande document is het bewijs bij deze bankbetaling */
  bankTransactionId?: number | null;
  label: string;
  /** waarom het niet zeker is; bedrag = zelfde nummer maar een ander bedrag, leverancier = de naam is net anders geschreven */
  reason?: 'datum' | 'nummer' | 'soort' | 'bedrag' | 'leverancier';
  /** bij een ander bedrag: beide bedragen in een zin, voor in de vraag */
  detail?: string;
}

/** De vraag bij een mogelijke kopie: waar hij op lijkt, en bij een ander bedrag welke bedragen het zijn. */
export const duplicateLead = (match: Pick<DuplicateMatch, 'label' | 'detail'>): string => `Lijkt op ${match.label}.${match.detail ? ` ${match.detail}` : ''}`;

/** Wat er van een document of aankoop nodig is om te zien of het hetzelfde is. */
export interface DuplicateProbe {
  /** genormaliseerd factuur- of bonnummer, of null */
  number: string | null;
  /** het nummer is goed genoeg gelezen (of door de gebruiker bevestigd) om op te vertrouwen */
  reliable: boolean;
  date: IsoDate | null;
  /** creditnota (of negatief bedrag) */
  credit: boolean;
}

/**
 * Vergelijkt twee documenten van dezelfde leverancier met hetzelfde bedrag. Zeker dubbel alleen met
 * hetzelfde betrouwbare nummer, zonder andere datum en van dezelfde soort; twee verschillende
 * nummers zijn twee facturen. Zonder nummer telt alleen een datum binnen 3 dagen, en dan als "mogelijk".
 */
export function compareDuplicate(a: DuplicateProbe, b: DuplicateProbe): Pick<DuplicateMatch, 'strength' | 'reason'> | null {
  if (a.number && b.number) {
    if (a.number !== b.number) return null;
    if (a.credit !== b.credit) return { strength: 'mogelijk', reason: 'soort' };
    if (!a.reliable || !b.reliable) return { strength: 'mogelijk', reason: 'nummer' };
    if (a.date && b.date && a.date !== b.date) return { strength: 'mogelijk', reason: 'datum' };
    return { strength: 'zeker' };
  }
  return a.date && b.date && Math.abs(diffDays(a.date, b.date)) <= 3 ? { strength: 'mogelijk', reason: a.credit !== b.credit ? 'soort' : 'nummer' } : null;
}

function probeOf(r: DocumentResult): DuplicateProbe {
  const number = r.invoiceNumber?.value ? normalizeInvoiceNumber(r.invoiceNumber.value) : '';
  return {
    number: number || null,
    reliable: number.length >= MIN_NUMBER_LENGTH && (r.invoiceNumber?.confidence ?? 0) >= RELIABLE_NUMBER_CONFIDENCE,
    date: r.invoiceDate?.value ?? null,
    credit: r.documentType?.value === 'credit_note' || (r.total?.value ?? 0) < 0,
  };
}

/**
 * Vingerafdruk van wat een document is: leverancier, datum, bedrag en nummer. Een afgewezen voorstel
 * ("Nee, andere aankoop") geldt alleen zolang deze gelijk blijft.
 */
export function documentFingerprint(r: DocumentResult | null): string {
  return JSON.stringify([
    r?.supplier ? supplierKey(r.supplier.value) : null,
    r?.invoiceDate?.value ?? null,
    r?.total?.value ?? null,
    r?.invoiceNumber?.value ? normalizeInvoiceNumber(r.invoiceNumber.value) : null,
  ]);
}

/** Wat de dubbel-controle nodig heeft van een bon die binnenkomt of een aankoop die met de hand wordt ingevoerd. */
interface DuplicateSubject {
  supplier: string;
  total: Cents;
  /** het bedrag in de vreemde munt van het document (#74), of null */
  foreign: { currency: string; total: Cents } | null;
  probe: DuplicateProbe;
}

/** Een aankoop die met de hand wordt ingevoerd, zonder document (#224). */
export interface ManualPurchase {
  supplier: string;
  total: Cents;
  date: IsoDate;
  number?: string | null;
}

/** Een nummer zegt pas iets vanaf drie tekens: een korter nummer komt bij de volgende bon zo weer terug. */
const MIN_NUMBER_LENGTH = 3;

const candidateOf = (m: Pick<DuplicateMatch, 'documentId' | 'purchaseId' | 'bankTransactionId'>): string =>
  m.purchaseId ? `aankoop:${m.purchaseId}` : m.bankTransactionId ? `bank:${m.bankTransactionId}` : `document:${m.documentId}`;

/** Wat de gebruiker ziet bij een factuur van het eigen bedrijf (#205). */
export const OWN_INVOICE_NOTE =
  'Dit is een factuur van je eigen bedrijf: verkoper en koper zijn hetzelfde. Dat is geen gewone aankoop, dus de app boekt hem niet als kosten en trekt de btw niet af.';
export const OWN_INVOICE_QUESTION = 'Dit lijkt een factuur van je eigen bedrijf: verkoper en koper lijken hetzelfde. Klopt dat?';

/** Melding bij een bon die bij het bijwerken van zijn oude tekstkoppeling af is gehaald (zie de migratie). */
const MIGRATION_ISSUE = 'evidence-migration';

const DUPLICATE_NOTE: Issue = { field: 'duplicate', severity: 'waarschuwing', message: 'Dubbel: dit document hadden we al. Niet opnieuw geboekt.' };

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
  ) {
    this.links = new EvidenceLinks(db);
    this.matcher = new BankPurchaseMatcher(db);
  }

  /** de koppeling tussen een document en de aankoop of bankbetaling waar het bij hoort (#179) */
  readonly links: EvidenceLinks;
  /** de gedeelde vergelijking van een betaling met een aankoop of bon (#221) */
  private readonly matcher: BankPurchaseMatcher;
  /** per bestand één toevoeging tegelijk (zie exclusive) */
  private readonly busy = new Map<string, Promise<unknown>>();
  /** een bewaard bestand weer weghalen als het document toch niet vastgelegd kon worden */
  private removeFile: ((path: string) => void) | null = null;
  setFileRemover(remove: ((path: string) => void) | null): void {
    this.removeFile = remove;
  }

  /** je eigen bedrijf (naam, btw- en KvK-nummer, rekeningnummers): om een factuur van jezelf te herkennen (#205) */
  private ownIdentity: () => OwnIdentity | null = () => null;
  setOwnIdentity(identity: () => OwnIdentity | null): void {
    this.ownIdentity = identity;
  }

  /** Is dit document (zoals bewaard) een factuur van het eigen bedrijf? Ook voor wat met een oudere versie gelezen is. */
  isOwnInvoice(result: DocumentResult | null): boolean {
    return !!result && (result.ownCompany === undefined ? this.detectOwn(result) : result.ownCompany) !== null;
  }

  /** Is dit gelezen document een factuur van het eigen bedrijf? Kijkt naar het document zoals het gelezen is. */
  private detectOwn(result: DocumentResult): OwnInvoice | null {
    const own = this.ownIdentity();
    if (!own || !(own.name.trim() || own.vatNumber.trim() || own.kvkNumber.trim())) return null;
    const ownNumber = (number: string) => !!this.db.prepare('SELECT 1 FROM invoices WHERE number = ? OR (external_id IS NOT NULL AND external_id = ?)').get(number, number);
    return detectOwnInvoice(result, own, ownNumber);
  }

  /**
   * De afschrijving die bij een factuur van het eigen bedrijf hoort: zelfde bedrag, je eigen bedrijfsnaam
   * als tegenpartij (geen eigen rekening: dat is een overboeking), binnen twee weken. `settled`: al door
   * jou op privé of "weet ik nog niet" gezet (dan is de factuur alleen nog het bewijs erbij); anders nog open.
   */
  findOwnPayment(result: DocumentResult, settled = false): BankTransaction | null {
    const own = this.ownIdentity();
    if (!own || !result.total || result.total.value <= 0) return null;
    const date = result.invoiceDate?.value ?? null;
    const rows = (this.db
      .prepare(
        settled
          ? `SELECT b.* FROM bank_transactions b WHERE b.status = 'gematcht' AND b.amount = ? AND b.matched_invoice_id IS NULL AND b.matched_purchase_invoice_id IS NULL
               AND NOT EXISTS (SELECT 1 FROM document_links k WHERE k.bank_transaction_id = b.id)
               AND EXISTS (SELECT 1 FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id WHERE l.journal_entry_id = b.matched_journal_entry_id AND a.rgs_code IN (?, ?))`
          : `SELECT b.* FROM bank_transactions b WHERE b.status = 'nieuw' AND b.amount = ?`,
      )
      .all(...(settled ? [-result.total.value, ACCOUNTS.priveOpnamen, ACCOUNTS.vraagposten] : [-result.total.value])) as BankTransaction[])
      .filter((t) => sameCompanyName(t.counter_name, own.name) && !this.bank.ownTransferTarget(t) && (!date || Math.abs(diffDays(date, t.transaction_date)) <= 14))
      .sort((a, b) => (date ? Math.abs(diffDays(date, a.transaction_date)) - Math.abs(diffDays(date, b.transaction_date)) : 0) || a.id - b.id);
    return rows[0] ?? null;
  }

  /** De melding "factuur van je eigen bedrijf" bij dit document, of null. */
  ownIssue(doc: Pick<IntakeDocument, 'issues'>): (Issue & { suggestion: OwnInvoice }) | null {
    return (doc.issues.find((i) => i.field === OWN_COMPANY_ISSUE) as (Issue & { suggestion: OwnInvoice }) | undefined) ?? null;
  }

  /**
   * Antwoord op "is dit een factuur van je eigen bedrijf?". Ja: voortaan zo behandeld (alleen privé of
   * "weet ik nog niet"). Nee ("toch een gewone aankoop"): de gewone controle, zolang leverancier, datum,
   * bedrag en nummer gelijk blijven. Er wordt hier niets geboekt.
   */
  async decideOwn(id: number, answer: 'ja' | 'nee', asOf: IsoDate = today()): Promise<IntakeDocument> {
    const doc = this.get(id);
    const issue = this.ownIssue(doc);
    if (!issue || !doc.result || (doc.status !== 'controle' && doc.status !== 'nieuw')) throw new ValidationError('Bij deze bon staat die vraag niet (meer). Bekijk hem opnieuw.');
    if (answer === 'nee') this.reject(id, OWN_COMPANY_CANDIDATE, doc.result);
    else {
      const result: DocumentResult = { ...doc.result, ownCompany: { level: 'zeker', signals: [...issue.suggestion.signals, 'je hebt het zelf bevestigd'] } };
      this.db.prepare('UPDATE documents SET result = ? WHERE id = ?').run(JSON.stringify(result), id);
    }
    return this.evaluate(id, this.carriedIssues(doc), asOf, { autoConfirm: false, ask: true });
  }

  /**
   * Een factuur van je eigen bedrijf afhandelen met wat er gelezen is: privé, of op "weet ik nog niet"
   * (Vraagposten, zonder btw-aftrek). Hoort er een afschrijving bij, dan gaat die in dezelfde keuze mee.
   * Ontbreekt het bedrag of de datum, dan null: de gebruiker vult dat eerst zelf in.
   */
  settleOwn(id: number, choice: 'prive' | 'vraag', bankTransactionId?: number): IntakeDocument | null {
    const doc = this.get(id);
    if (!this.ownIssue(doc)) throw new ValidationError('Deze bon is intussen anders beoordeeld. Bekijk hem opnieuw.');
    const r = doc.result;
    if (!r?.total || !r.invoiceDate) return null;
    const supplier = this.ownIdentity()?.name.trim() || r.supplier?.value || doc.original_name;
    return this.confirm(
      id,
      { supplier, date: r.invoiceDate.value, total: r.total.value, invoiceNumber: r.invoiceNumber?.value ?? null, categoryKey: choice === 'vraag' ? QUESTION_CATEGORY : 'overig', vatCode: 'geen', business: choice === 'vraag', paidWith: 'bank' },
      { bankTransactionId },
    );
  }

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
    const fx = this.fx ? await this.fx.rateFor(cur, rateDate(result)) : null;
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

  /**
   * Een bon in een vreemde munt die binnenkwam toen de koers niet op te halen was (#177): nog een keer
   * proberen, bv. bij het openen van de bon. Lukt het, dan staat het bedrag in euro's er alsnog; lukt
   * het niet (of duurt het te lang), dan verandert er niets en vult de gebruiker het bedrag zelf in.
   */
  async retryRate(id: number, asOf: IsoDate = today(), timeoutMs = 4000): Promise<IntakeDocument> {
    const doc = this.get(id);
    const result = doc.result;
    if (!this.fx || !result?.foreign || result.foreign.rate !== null || result.total || doc.status === 'verwerkt' || doc.status === 'genegeerd') return doc;
    const fx = await Promise.race([
      this.fx.rateFor(result.foreign.currency, rateDate(result)),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    if (!fx) return doc;
    result.total = { value: toEuro(result.foreign.total, fx.rate), confidence: 0.9, source: result.currency?.source ?? 'gebruiker' };
    result.foreign = { ...result.foreign, rate: fx.rate, rateDate: fx.date, source: 'ecb' };
    this.db.prepare('UPDATE documents SET result = ? WHERE id = ?').run(JSON.stringify(result), id);
    // de melding "koers kon niet opgehaald worden" vervalt; de rest opnieuw beoordelen, nooit zelf boeken
    return this.evaluate(id, this.carriedIssues(this.get(id)), asOf, { autoConfirm: false });
  }

  /** EXTRACTIE: wat staat er op het document? */
  /** Uitlezen, zonder je eigen btw-nummer als dat van de leverancier. */
  async extract(filename: string, data: Uint8Array): Promise<{ result: DocumentResult; source: string; issues: Issue[] }> {
    const out = await this.extractRaw(filename, data);
    // factuur van het eigen bedrijf (#205): vastleggen vóórdat het eigen btw-nummer als leveranciersnummer vervalt
    if (out.source !== 'geen') out.result.ownCompany = this.detectOwn(out.result);
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

  /** Per bestand één toevoeging tegelijk: twee keer hetzelfde bestand (ook tegelijk) wordt één document. */
  private async exclusive<T>(data: Uint8Array, fn: (sha: string) => Promise<T>): Promise<T> {
    const sha = createHash('sha256').update(data).digest('hex');
    const before = this.busy.get(sha) ?? Promise.resolve();
    const run = before.catch(() => undefined).then(() => fn(sha));
    this.busy.set(sha, run);
    try {
      return await run;
    } finally {
      if (this.busy.get(sha) === run) this.busy.delete(sha);
    }
  }

  private bySha(sha: string): number | null {
    return (this.db.prepare('SELECT id FROM documents WHERE sha256 = ?').get(sha) as { id: number } | undefined)?.id ?? null;
  }

  /**
   * Exact dit bestand stond er al in: er komt niets bij en er verandert niets. Met `requested`
   * ("Bon toevoegen" bij een aankoop of betaling): hoort het bestaande document al bij iets anders, dan
   * staan beide erbij, zodat je het zelf kunt rechtzetten.
   */
  private alreadyPresent(id: number, requested: LinkTarget | null): UploadResult {
    const doc = this.get(id);
    const blocked = requested && doc.link && !sameTarget(doc.link.target, requested) ? { existing: this.links.describe(doc.link.target)!, requested: this.links.describe(requested)! } : null;
    return { ...doc, already_present: true, blocked, linkable: !!requested && !doc.link && doc.status !== 'verwerkt' && doc.duplicate_of_document_id === null };
  }

  /**
   * Leest het bestand, bewaart het en legt het document vast (nog niet beoordeeld). `existed`: het
   * document kwam er intussen langs een andere weg al in; dan is dat het document en blijft er geen
   * tweede bestand staan.
   */
  private async ingest(filename: string, data: Uint8Array, sha: string): Promise<{ id: number; issues: Issue[]; existed: boolean }> {
    const mime = mimeFor(filename);
    // eerst lezen, dan pas bewaren: kan het bestand niet (bv. geen e-factuur), dan blijft er geen los bestand achter
    const { result, source, issues: extracted } = await this.extract(filename, data);
    const issues = [...extracted, ...(await this.toEuros(result))];
    const path = await this.storeFile(filename, data);
    let id: number;
    try {
      id = Number(
        this.db.prepare('INSERT INTO documents (file_path, original_name, mime_type, sha256, extraction_source, result) VALUES (?, ?, ?, ?, ?, ?)').run(path, filename, mime, sha, source, JSON.stringify(result)).lastInsertRowid,
      );
    } catch (e) {
      // niet vastgelegd: dan hoort het bestand ook niet te blijven staan
      this.removeFile?.(path);
      const existing = this.bySha(sha);
      if (existing === null) throw e;
      return { id: existing, issues: [], existed: true };
    }
    // Locatie alleen na expliciete toestemming (#32), en alleen in de lokale database
    if (this.locationEnabled() && mime === 'image/jpeg') {
      const gps = readJpegGps(data);
      if (gps) this.db.prepare('UPDATE documents SET gps_lat = ?, gps_lon = ? WHERE id = ?').run(gps.lat, gps.lon, id);
    }
    return { id, issues, existed: false };
  }

  /** Voegt een document toe en verwerkt het zo ver als verantwoord is. */
  async add(filename: string, data: Uint8Array, asOf: IsoDate = today(), opts: { autoConfirm?: boolean } = {}): Promise<UploadResult> {
    return this.exclusive(data, async (sha) => {
      const existing = this.bySha(sha);
      if (existing !== null) return this.alreadyPresent(existing, null);
      const { id, issues, existed } = await this.ingest(filename, data, sha);
      if (existed) return this.alreadyPresent(id, null);
      await this.evaluate(id, issues, asOf, opts);
      return { ...this.get(id), already_present: false, blocked: null, linkable: false };
    });
  }

  /**
   * Een factuur als bewijsstuk bij een al bestaande afschrijving (vaste lasten, #25): niet opnieuw
   * boeken, alleen bewaren en koppelen. Je kiest de betaling zelf, dus dat is de toestemming.
   */
  async addEvidence(filename: string, data: Uint8Array, bankTransactionId: number): Promise<UploadResult> {
    if (!this.db.prepare('SELECT id FROM bank_transactions WHERE id = ?').get(bankTransactionId)) throw new ValidationError('Deze betaling bestaat niet (meer)');
    return this.attachEvidence(filename, data, { kind: 'bank', id: bankTransactionId });
  }

  /** Een bon of factuur als bijlage bij een aankoop die er nog geen had ("Bon toevoegen"). */
  async addPurchaseEvidence(filename: string, data: Uint8Array, purchaseId: number): Promise<UploadResult> {
    if (!this.db.prepare('SELECT id FROM purchase_invoices WHERE id = ?').get(purchaseId)) throw new ValidationError('Deze aankoop bestaat niet (meer)');
    return this.attachEvidence(filename, data, { kind: 'aankoop', id: purchaseId });
  }

  /**
   * "Bon toevoegen": het bestand bewaren en als bewijs koppelen, zonder iets te boeken. Dezelfde regels
   * als bij gewoon toevoegen: exact hetzelfde bestand wordt geweigerd, en hoort dezelfde factuur al bij
   * iets anders, dan wordt er niets gekoppeld en komt de bon bij "Nog controleren".
   */
  private attachEvidence(filename: string, data: Uint8Array, requested: LinkTarget): Promise<UploadResult> {
    return this.exclusive(data, async (sha) => {
      const existing = this.bySha(sha);
      if (existing !== null) return this.alreadyPresent(existing, requested);
      const { id, existed } = await this.ingest(filename, data, sha);
      if (existed) return this.alreadyPresent(id, requested);
      const duplicate = this.findDuplicate(id, this.get(id).result ?? emptyResult());
      const certain = duplicate?.strength === 'zeker' ? duplicate : null;
      const elsewhere = certain ? this.targetOf(certain) : null;
      if (certain && elsewhere && !sameTarget(elsewhere, requested)) {
        const issue: Issue = { field: 'duplicate', severity: 'fout', message: `Lijkt op ${certain.label}. Is dit dezelfde aankoop?`, suggestion: certain };
        this.db.prepare(`UPDATE documents SET status = 'controle', confidence = 'LOW', issues = ? WHERE id = ?`).run(JSON.stringify([issue]), id);
        return { ...this.get(id), already_present: false, blocked: { existing: this.links.describe(elsewhere)!, requested: this.links.describe(requested)! }, linkable: false };
      }
      tx(this.db, () => {
        if (certain?.documentId && elsewhere) {
          // hetzelfde document zit hier al bij (ander bestand): dit is een kopie; het beste wordt het hoofdbewijsstuk
          this.links.link(id, requested, 'dubbel');
          this.db.prepare(`UPDATE documents SET status = 'genegeerd', duplicate_of_document_id = ?, issues = ? WHERE id = ?`).run(certain.documentId, JSON.stringify([DUPLICATE_NOTE]), id);
          return;
        }
        this.links.link(id, requested, 'bewijs');
        this.db.prepare(`UPDATE documents SET status = 'verwerkt', confidence = 'HIGH', issues = '[]' WHERE id = ?`).run(id);
        // lag dezelfde factuur nog te wachten op controle, dan is dat een kopie van deze: niet ook nog boeken
        if (certain?.documentId && this.get(certain.documentId).status !== 'verwerkt') {
          this.markDuplicate(certain.documentId, { documentId: id, purchaseId: requested.kind === 'aankoop' ? requested.id : null, bankTransactionId: requested.kind === 'bank' ? requested.id : null }, 'automatisch');
        }
      });
      return { ...this.get(id), already_present: false, blocked: null, linkable: false };
    });
  }

  /**
   * Een document dat al in de app staat en nog nergens bij hoort, zelf als bewijs aan een aankoop of
   * betaling koppelen. Er wordt niets geboekt.
   */
  linkExisting(id: number, target: LinkTarget): IntakeDocument {
    return tx(this.db, () => {
      const doc = this.get(id);
      if (doc.link && sameTarget(doc.link.target, target)) return doc;
      if (!doc.link && doc.status === 'verwerkt') throw new ValidationError('Dit bonnetje is al verwerkt');
      this.links.link(id, target, 'bewijs');
      this.db.prepare(`UPDATE documents SET status = 'verwerkt', duplicate_of_document_id = NULL, issues = '[]' WHERE id = ?`).run(id);
      return this.get(id);
    });
  }

  /**
   * Na het vervallen van een aankoop (de betaling stond al als kosten geboekt): de bestanden die bij
   * de aankoop hoorden worden het bewijs bij die betaling. Er wordt hier niets geboekt.
   */
  moveToBank(files: { document_id: number; origin: LinkOrigin }[], bankTransactionId: number, provenance: LinkProvenance): void {
    tx(this.db, () => {
      for (const f of files) {
        const copy = f.origin === 'dubbel';
        this.links.unlink(f.document_id);
        this.links.link(f.document_id, { kind: 'bank', id: bankTransactionId }, copy ? 'dubbel' : 'bewijs', provenance);
        if (copy) this.db.prepare(`UPDATE documents SET status = 'genegeerd' WHERE id = ?`).run(f.document_id);
        else this.db.prepare(`UPDATE documents SET status = 'verwerkt', confidence = 'HIGH', issues = '[]' WHERE id = ?`).run(f.document_id);
      }
    });
  }

  /**
   * "Koppeling ongedaan maken": de bon hoort nergens meer bij en gaat terug naar "Nog controleren". De
   * aankoop of de geboekte betaling zelf blijft precies zoals hij is. Hetzelfde doel wordt daarna niet
   * meteen opnieuw voorgesteld, en er wordt niets vanzelf opnieuw gekoppeld of geboekt.
   */
  async unlink(id: number, asOf: IsoDate = today()): Promise<IntakeDocument> {
    const doc = this.get(id);
    // een kopie van een document dat zelf nog niet geboekt is: "toch geen kopie"
    const copyOf = !doc.link && doc.status === 'genegeerd' ? doc.duplicate_of_document_id : null;
    if (!doc.link && copyOf === null) throw new ValidationError('Deze bon is nergens aan gekoppeld');
    if (doc.link?.origin === 'geboekt') {
      throw new ValidationError('Deze aankoop is uit deze bon geboekt. Klopt de aankoop niet? Haal hem dan weg bij Aankopen (knop "Weghalen"); de bon komt daarna terug bij "Nog controleren".');
    }
    tx(this.db, () => {
      this.links.unlink(id);
      this.reject(id, doc.link ? targetKey(doc.link.target) : `document:${copyOf}`, doc.result);
      this.db.prepare(`UPDATE documents SET status = 'controle', duplicate_of_document_id = NULL WHERE id = ?`).run(id);
    });
    return this.evaluate(id, this.carriedIssues(doc), asOf, { autoConfirm: false, ask: true });
  }

  /**
   * Melding voor Vandaag: een document dat zonder jou binnenkwam (e-mail) stond er al in. `existing`
   * is het document dat er al was; er is niets geboekt of gekoppeld.
   */
  notify(notice: { kind: 'stond-er-al' | 'dubbel'; originalName: string; source: string; sender?: string | null; existingDocumentId: number | null; purchaseId?: number | null }): void {
    this.db
      .prepare('INSERT INTO document_notices (kind, original_name, source, sender, existing_document_id, purchase_invoice_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(notice.kind, notice.originalName.slice(0, 200), notice.source, notice.sender?.slice(0, 200) ?? null, notice.existingDocumentId, notice.purchaseId ?? null);
  }

  /** Meldingen die de gebruiker nog niet heeft gezien. */
  notices(): DocumentNotice[] {
    return this.db.prepare('SELECT id, kind, original_name, source, sender, existing_document_id, purchase_invoice_id, created_at FROM document_notices WHERE seen_at IS NULL ORDER BY id').all() as DocumentNotice[];
  }

  dismissNotice(id: number): void {
    this.db.prepare(`UPDATE document_notices SET seen_at = datetime('now') WHERE id = ? AND seen_at IS NULL`).run(id);
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

  /** Meldingen die bij het bestand zelf horen (niet uitgelezen, geen koers) en bij opnieuw beoordelen blijven staan. */
  private carriedIssues(doc: IntakeDocument): Issue[] {
    return doc.issues.filter((i) => i.field === 'document' || i.field === MIGRATION_ISSUE || (i.field === 'total' && !!doc.result?.foreign && doc.result.foreign.rate === null));
  }

  /**
   * Staat deze bon op controle omdat zijn oude tekstkoppeling ("bewijsstuk bij banktransactie #...")
   * niet zeker om te zetten was, en is hij daarna nog niet opnieuw beoordeeld? Dan is hij nog niet te boeken.
   */
  awaitsReassessment(doc: Pick<IntakeDocument, 'id' | 'issues'>): boolean {
    if (!doc.issues.some((i) => i.field === MIGRATION_ISSUE)) return false;
    return !!this.db.prepare(`SELECT 1 FROM document_link_migration WHERE document_id = ? AND result IN ('onzeker','conflict') AND reassessed_at IS NULL`).get(doc.id);
  }

  private reassessing: Promise<number> | null = null;

  /**
   * Bonnen die bij het bijwerken van hun oude tekstkoppeling af zijn gehaald, alsnog beoordelen zoals
   * een bon die net binnenkomt (#179): hoort hij bij een betaling die al als kosten geboekt is, of bij
   * een aankoop die er al staat, dan komt daar de gewone vraag over. Er wordt hier nooit iets geboekt of
   * gekoppeld, ook een zekere kopie niet. Elke bon één keer; mislukt het, dan de volgende keer opnieuw.
   * Wordt aangeroepen bij het openen van Vandaag, de bonnenlijst en een bon. Geeft terug hoeveel er beoordeeld zijn.
   */
  reassessMigrated(asOf: IsoDate = today()): Promise<number> {
    this.reassessing ??= (async () => {
      const rows = this.db
        .prepare(
          `SELECT m.document_id AS id FROM document_link_migration m JOIN documents d ON d.id = m.document_id
            WHERE m.reassessed_at IS NULL AND m.result IN ('onzeker','conflict') AND d.status IN ('nieuw','controle') ORDER BY m.document_id`,
        )
        .all() as { id: number }[];
      let n = 0;
      for (const { id } of rows) {
        const doc = this.get(id);
        if (!this.awaitsReassessment(doc)) continue;
        // welke betalingen noemde de oude tekst? Alleen bewaard om er een vraag over te kunnen stellen
        const named = [...new Set((doc.classification?.reasons ?? []).map((r) => /^bewijsstuk bij banktransactie #(\d+)$/.exec(String(r))?.[1]).filter((x): x is string => !!x).map(Number))];
        this.db.prepare('UPDATE document_link_migration SET named_payments = ? WHERE document_id = ? AND named_payments IS NULL').run(JSON.stringify(named), id);
        try {
          await this.evaluate(id, this.carriedIssues(doc), asOf, { autoConfirm: false, ask: true });
        } catch {
          continue; // bv. de herkenning is even niet bereikbaar: de bon blijft niet te boeken tot het lukt
        }
        this.db.prepare(`UPDATE document_link_migration SET reassessed_at = datetime('now') WHERE document_id = ?`).run(id);
        n++;
      }
      return n;
    })().finally(() => {
      this.reassessing = null;
    });
    return this.reassessing;
  }

  /**
   * De betalingen die de oude tekst bij deze bon noemde en die er nu nog toe doen: nog rechtstreeks als
   * kosten geboekt (dan is de bon hooguit bewijs), of intussen de betaling van een aankoop (dan staat
   * die aankoop er al). Dit is nooit een koppeling: het levert alleen een vraag op.
   */
  private legacyHints(id: number): { payments: BankTransaction[]; purchases: number[] } {
    const row = this.db.prepare('SELECT named_payments FROM document_link_migration WHERE document_id = ?').get(id) as { named_payments: string | null } | undefined;
    const out = { payments: [] as BankTransaction[], purchases: [] as number[] };
    for (const bankId of row?.named_payments ? (JSON.parse(row.named_payments) as number[]) : []) {
      const t = this.db.prepare('SELECT * FROM bank_transactions WHERE id = ?').get(bankId) as BankTransaction | undefined;
      if (!t || t.status !== 'gematcht' || t.matched_invoice_id) continue;
      if (t.matched_purchase_invoice_id) out.purchases.push(t.matched_purchase_invoice_id);
      else if (
        this.db
          .prepare(`SELECT 1 FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id WHERE l.journal_entry_id = ? AND a.category = 'kosten'`)
          .get(t.matched_journal_entry_id)
      ) out.payments.push(t);
    }
    return out;
  }

  /** Het voorstel dat bij dit document op een keuze wacht, of null. */
  pending(doc: IntakeDocument): PendingProposal | null {
    if (doc.status !== 'controle' && doc.status !== 'nieuw') return null;
    const evidence = doc.issues.find((i) => i.field === 'evidence')?.suggestion as { bankTransactionId: number } | undefined;
    if (evidence) return { kind: 'evidence', candidate: `bank:${evidence.bankTransactionId}`, documentId: null, target: this.links.describe({ kind: 'bank', id: evidence.bankTransactionId }) };
    const issue = doc.issues.find((i) => i.field === 'duplicate' && i.severity === 'fout');
    const match = issue?.suggestion as DuplicateMatch | undefined;
    if (!match) return null;
    const target = this.targetOf(match);
    // het voorstel is achterhaald: de aankoop is weg, of het andere document is intussen weggelegd
    if (target ? !this.links.describe(target) : !this.db.prepare(`SELECT 1 FROM documents WHERE id = ? AND status <> 'genegeerd'`).get(match.documentId)) return null;
    return { kind: 'duplicate', candidate: candidateOf(match), documentId: match.documentId, target: target ? this.links.describe(target) : null };
  }

  /** Legt vast dat dit voorstel is afgewezen, voor het document zoals het nu gelezen is. */
  private reject(id: number, candidate: string, result: DocumentResult | null): void {
    this.db
      .prepare(`INSERT INTO document_proposal_rejections (document_id, candidate, fingerprint) VALUES (?, ?, ?)
        ON CONFLICT(document_id, candidate) DO UPDATE SET fingerprint = excluded.fingerprint, created_at = datetime('now')`)
      .run(id, candidate, documentFingerprint(result));
  }

  /** Voorstellen die voor dit document zijn afgewezen en nog gelden (de gegevens zijn niet veranderd). */
  private rejected(id: number, result: DocumentResult): Set<string> {
    const rows = this.db.prepare('SELECT candidate FROM document_proposal_rejections WHERE document_id = ? AND fingerprint = ?').all(id, documentFingerprint(result)) as { candidate: string }[];
    return new Set(rows.map((r) => r.candidate));
  }

  /**
   * Het antwoord op een voorstel. Ja: de bon wordt bewijs of kopie, er wordt niets geboekt. Nee: dit
   * voorstel vervalt en de gewone controle gaat verder. Later: er verandert niets.
   * `candidate`: het voorstel dat de gebruiker zag; is het intussen een ander, dan gebeurt er niets.
   */
  async decide(id: number, answer: 'ja' | 'nee' | 'later', candidate?: string, asOf: IsoDate = today()): Promise<IntakeDocument> {
    const doc = this.get(id);
    if (answer === 'later') return doc;
    const pending = this.pending(doc);
    if (!pending) throw new ValidationError('Bij deze bon staat geen voorstel (meer). Bekijk hem opnieuw.');
    if (candidate !== undefined && candidate !== pending.candidate) throw new ValidationError('Het voorstel voor deze bon is intussen veranderd. Bekijk hem opnieuw.');
    if (answer === 'nee') {
      this.reject(id, pending.candidate, doc.result);
      return this.evaluate(id, this.carriedIssues(doc), asOf, { autoConfirm: false, ask: true });
    }
    if (pending.kind === 'duplicate') return this.markDuplicate(id, doc.issues.find((i) => i.field === 'duplicate')!.suggestion as DuplicateMatch);
    const bankId = Number(pending.candidate.slice(5));
    return tx(this.db, () => {
      const t = this.db.prepare('SELECT * FROM bank_transactions WHERE id = ?').get(bankId) as BankTransaction | undefined;
      if (!t || t.status !== 'gematcht' || t.matched_purchase_invoice_id || t.matched_invoice_id) throw new ValidationError('Deze betaling is intussen anders verwerkt. Kijk het opnieuw na.');
      this.links.link(id, { kind: 'bank', id: bankId }, 'bewijs');
      this.db.prepare(`UPDATE documents SET status = 'verwerkt', confidence = 'HIGH', issues = '[]' WHERE id = ?`).run(id);
      return this.get(id);
    });
  }

  /** CLASSIFICATIE + VALIDATIE + CONFIDENCE, en bij HIGH direct verwerken. */
  /**
   * autoConfirm: false = nooit zelf boeken, altijd eerst laten controleren (bv. binnengekomen per e-mail).
   * ask: true = ook een zekere kopie eerst vragen (na een keuze van de gebruiker gebeurt er niets vanzelf).
   */
  async evaluate(id: number, extraIssues: Issue[] = [], asOf: IsoDate = today(), opts: { autoConfirm?: boolean; ask?: boolean } = {}): Promise<IntakeDocument> {
    const doc = this.get(id);
    const result = doc.result ?? emptyResult();
    // Een bon die bij het bijwerken van zijn oude tekstkoppeling af is gehaald: die melding blijft staan
    // tot hij ergens bij hoort of geboekt is, en de betalingen die de tekst noemde tellen mee als vraag.
    const migrated = doc.issues.find((i) => i.field === MIGRATION_ISSUE);
    if (migrated && !extraIssues.some((i) => i.field === MIGRATION_ISSUE)) extraIssues = [...extraIssues, migrated];
    const legacy = migrated ? this.legacyHints(id) : null;
    // Eerst: hebben we dit al? Hetzelfde document komt vaak twee keer binnen (mail + foto, PDF + e-factuur).
    let duplicate = this.findDuplicate(id, result);
    if (duplicate?.strength === 'zeker' && !opts.ask) {
      const original = duplicate.documentId ? this.get(duplicate.documentId) : null;
      if (original && original.status !== 'verwerkt' && !this.targetOf(duplicate) && evidenceRank(doc.extraction_source) > evidenceRank(original.extraction_source)) {
        // geen van beide is geboekt en het nieuwe is beter gelezen: daarmee gaat de app verder, het oude wordt de kopie
        this.markDuplicate(original.id, { documentId: id, purchaseId: null }, 'automatisch');
        duplicate = null;
      } else {
        this.markDuplicate(id, duplicate, 'automatisch');
        return this.get(id);
      }
    }
    const rejected = this.rejected(id, result);
    // Factuur van je eigen bedrijf (#205): nooit vanzelf boeken, en alleen privé of "weet ik nog niet".
    // Gelezen met een oudere versie: nu alsnog kijken.
    const own = rejected.has(OWN_COMPANY_CANDIDATE) ? null : result.ownCompany === undefined ? this.detectOwn(result) : result.ownCompany;
    if (own) extraIssues = [...extraIssues.filter((i) => i.field !== OWN_COMPANY_ISSUE), { field: OWN_COMPANY_ISSUE, severity: 'fout', message: own.level === 'zeker' ? OWN_INVOICE_NOTE : OWN_INVOICE_QUESTION, suggestion: own }];
    // de afschrijving is al door jou op privé of "weet ik nog niet" gezet: dan is de factuur het bewijs daarbij
    const ownSettled = own ? [this.findOwnPayment(result, true)].find((t) => t && !rejected.has(`bank:${t.id}`)) ?? null : null;
    const alreadyBooked = this.findBookedBankTransaction(result, rejected) ?? ownSettled ?? legacy?.payments.find((t) => !rejected.has(`bank:${t.id}`)) ?? null;
    if (alreadyBooked) {
      // De betaling is al rechtstreeks als kosten geboekt (bv. automatisch herkende leverancier): het
      // document is dan hooguit het bewijsstuk. Nooit stil koppelen en nooit nog een keer boeken: eerst vragen.
      const label = `${formatEuro(-alreadyBooked.amount)} op ${formatDateNl(alreadyBooked.transaction_date)}${alreadyBooked.counter_name ? ` aan ${alreadyBooked.counter_name}` : ''}`;
      const issue: Issue = { field: 'evidence', severity: 'fout', message: EVIDENCE_QUESTION, suggestion: { bankTransactionId: alreadyBooked.id, label } };
      this.db
        .prepare(`UPDATE documents SET status = 'controle', confidence = 'LOW', issues = ?, classification = NULL, decisions = NULL WHERE id = ?`)
        .run(JSON.stringify([...extraIssues, issue]), id);
      return this.get(id);
    }
    let classification = await this.classifier.classify(result);
    if (PRIVATE_CAR_CATEGORIES.includes(classification.categoryKey) && classification.business && this.carUse() === 'prive') {
      // privéauto: bon van tanken/parkeren is privé (aftrek via de kilometers)
      classification = { ...classification, business: false, automatic: false, reasons: [...classification.reasons, 'privéauto: tanken, parkeren en onderhoud zijn privé; zakelijke km vul je apart in'] };
    }
    const issues = [...extraIssues, ...validateDocument(result, asOf)];
    const outlier = this.amountOutlier(result);
    if (outlier) issues.push(outlier);
    if (duplicate) {
      issues.push({ field: 'duplicate', severity: 'fout', message: `${duplicateLead(duplicate)} Is dit dezelfde aankoop?`, suggestion: duplicate });
    } else {
      // de betaling waar deze bon vroeger bij stond, hoort intussen bij een aankoop: die aankoop is er dus al
      const purchase = legacy?.purchases.map((p) => this.links.describe({ kind: 'aankoop', id: p })).find((p) => p && !rejected.has(`aankoop:${p.id}`));
      if (purchase) {
        const match: DuplicateMatch = { strength: 'mogelijk', documentId: this.links.forTarget({ kind: 'aankoop', id: purchase.id })[0]?.document_id ?? null, purchaseId: purchase.id, label: purchase.label, reason: 'nummer' };
        issues.push({ field: 'duplicate', severity: 'fout', message: `De betaling waar deze bon bij stond, hoort nu bij ${purchase.label}. Is dit dezelfde aankoop?`, suggestion: match });
      }
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

  /** De aankoop of betaling waar een gevonden kopie bij hoort; null als die nog nergens bij hoort. */
  private targetOf(match: Pick<DuplicateMatch, 'documentId' | 'purchaseId' | 'bankTransactionId'>): LinkTarget | null {
    if (match.purchaseId) return { kind: 'aankoop', id: match.purchaseId };
    if (match.bankTransactionId) return { kind: 'bank', id: match.bankTransactionId };
    return match.documentId ? this.links.forDocument(match.documentId)?.target ?? null : null;
  }

  /**
   * Zoekt of dit document al eerder binnenkwam of al geboekt is. Een voorstel dat voor dit document is
   * afgewezen, komt niet terug zolang leverancier, datum, bedrag en nummer gelijk blijven.
   */
  findDuplicate(id: number, result: DocumentResult): DuplicateMatch | null {
    if (!result.total || !result.supplier) return null;
    const subject: DuplicateSubject = { supplier: result.supplier.value, total: result.total.value, foreign: result.foreign ?? null, probe: probeOf(result) };
    return this.duplicateOf(subject, id, this.rejected(id, result));
  }

  /**
   * Staat er al een aankoop of een bon die lijkt op wat de gebruiker met de hand invoert (#224)? Het
   * ingetypte nummer telt als betrouwbaar. Er wordt hier niets vastgelegd: het is alleen de vraag vooraf.
   */
  findDuplicateOfManual(entry: ManualPurchase): DuplicateMatch | null {
    if (!entry.supplier.trim() || !entry.total) return null;
    const number = entry.number ? normalizeInvoiceNumber(entry.number) : '';
    const probe: DuplicateProbe = { number: number || null, reliable: number.length >= MIN_NUMBER_LENGTH, date: entry.date, credit: entry.total < 0 };
    return this.duplicateOf({ supplier: entry.supplier, total: entry.total, foreign: null, probe }, null, new Set());
  }

  /** Een bedrag dat ver boven het gebruikelijke bedrag bij dezelfde leverancier ligt (#283). */
  private amountOutlier(result: DocumentResult): Issue | null {
    const name = result.supplier?.value;
    const total = result.total?.value;
    if (!name || total === undefined || result.foreign) return null;
    const key = supplierKey(name);
    if (!key) return null;
    const rows = this.db
      .prepare(`SELECT p.total, r.name FROM purchase_invoices p JOIN relations r ON r.id = p.relation_id WHERE p.total > 0 AND (p.currency IS NULL OR p.currency = 'EUR')`)
      .all() as { total: number; name: string }[];
    return amountOutlierIssue(rows.filter((r) => supplierKey(r.name) === key).map((r) => r.total), total);
  }

  /**
   * De dubbel-controle zelf. Dezelfde leverancier (ook net anders geschreven: "Pakketreus EU" en
   * "Pakketreus") en dan:
   *  - hetzelfde bedrag: compareDuplicate (zeker of mogelijk);
   *  - een andere munt aan één kant en het bedrag binnen de koersmarge (`withinFx`): hooguit mogelijk;
   *  - een ander bedrag maar hetzelfde nummer (minstens drie tekens): mogelijk, want een bon en de factuur
   *    van dezelfde aankoop verschillen soms een paar cent (koers, afronding) (#224). Niet als dat nummer bij
   *    deze leverancier al bij meer dan één aankoop staat: dan is het geen factuurnummer maar een klant- of
   *    contractnummer, en zou elke nieuwe factuur de vraag krijgen tegen elke eerdere.
   * Zeker is het alleen bij precies dezelfde leverancier en precies hetzelfde bedrag; al het andere is een vraag.
   */
  private duplicateOf(subject: DuplicateSubject, id: number | null, rejected: Set<string>): DuplicateMatch | null {
    const key = supplierKey(subject.supplier);
    if (!key) return null;
    const { probe, total, foreign } = subject;
    const supplierFit = (name: string | null | undefined): 'gelijk' | 'variant' | null =>
      !name ? null : supplierKey(name) === key ? 'gelijk' : sameSupplierName(name, subject.supplier) ? 'variant' : null;
    // vreemde munt (#74): ook hetzelfde bedrag in die munt, en een oudere boeking waarin dat bedrag als euro's staat
    const amountFit = (other: { total: Cents; currency: string | null; foreignTotal: Cents | null }): 'gelijk' | 'koers' | null => {
      if (other.total === total) return 'gelijk';
      const otherForeign = !!other.currency && other.currency !== 'EUR';
      if (foreign && (otherForeign ? other.currency === foreign.currency && other.foreignTotal === foreign.total : other.total === foreign.total)) return 'gelijk';
      // één kant in een andere munt: de bank of de kaart rekende een eigen koers. Staan beide in dezelfde
      // vreemde munt, dan zijn de bedragen in die munt te vergelijken en is een ander bedrag een andere aankoop.
      const sameCurrency = !!foreign && otherForeign && other.currency === foreign.currency;
      return (foreign || otherForeign) && !sameCurrency && withinFx(other.total, total) ? 'koers' : null;
    };
    const compare = (supplier: 'gelijk' | 'variant', amount: 'gelijk' | 'koers' | null, other: DuplicateProbe): Pick<DuplicateMatch, 'strength' | 'reason'> | null => {
      if (!amount) {
        // een ander bedrag: alleen hetzelfde nummer is dan nog een reden om het te vragen, en alleen als dat
        // nummer bij deze leverancier niet vaker voorkomt
        if (!probe.number || probe.number.length < MIN_NUMBER_LENGTH || probe.number !== other.number || sameNumber.size > 1) return null;
        return { strength: 'mogelijk', reason: probe.credit !== other.credit ? 'soort' : 'bedrag' };
      }
      const found = compareDuplicate(probe, other);
      if (found?.strength !== 'zeker') return found;
      if (amount === 'koers') return { strength: 'mogelijk', reason: 'bedrag' };
      return supplier === 'variant' ? { strength: 'mogelijk', reason: 'leverancier' } : found;
    };

    const purchases = this.db
      .prepare(
        `SELECT p.id, p.supplier_reference, p.invoice_date, p.total, p.currency, p.foreign_total, r.name AS supplier,
                (SELECT k.document_id FROM document_links k WHERE k.purchase_invoice_id = p.id AND k.is_primary = 1) AS document_id
         FROM purchase_invoices p JOIN relations r ON r.id = p.relation_id ORDER BY p.id`,
      )
      .all() as { id: number; supplier_reference: string | null; invoice_date: string; total: number; currency: string | null; foreign_total: number | null; document_id: number | null; supplier: string }[];
    const docs = this.db
      .prepare(
        `SELECT d.id, d.result, k.purchase_invoice_id, k.bank_transaction_id FROM documents d LEFT JOIN document_links k ON k.document_id = d.id
          WHERE d.id IS NOT ? AND d.status IN ('nieuw','controle','verwerkt') AND d.result IS NOT NULL AND (? IS NULL OR d.duplicate_of_document_id IS NOT ?) ORDER BY d.id`,
      )
      .all(id, id, id) as { id: number; result: string; purchase_invoice_id: number | null; bank_transaction_id: number | null }[];

    // alles van deze leverancier wat er al staat: eerst de aankopen, dan de documenten
    type Candidate = { supplier: 'gelijk' | 'variant'; total: Cents; currency: string | null; foreignTotal: Cents | null; other: DuplicateProbe; match: Omit<DuplicateMatch, 'strength' | 'reason'> };
    const candidates: Candidate[] = [];
    for (const p of purchases) {
      const supplier = supplierFit(p.supplier);
      if (!supplier) continue;
      const number = p.supplier_reference ? normalizeInvoiceNumber(p.supplier_reference) : '';
      // een bevestigde aankoop: het nummer is nagekeken, of het document waar het uit komt telt hieronder mee
      const other: DuplicateProbe = { number: number || null, reliable: number.length >= MIN_NUMBER_LENGTH, date: p.invoice_date, credit: p.total < 0 };
      candidates.push({ supplier, total: p.total, currency: p.currency, foreignTotal: p.foreign_total, other, match: { documentId: p.document_id, purchaseId: p.id, label: `de aankoop bij ${p.supplier} van ${formatDateNl(p.invoice_date)}` } });
    }
    for (const d of docs) {
      const r = JSON.parse(d.result) as DocumentResult;
      const supplier = r.total ? supplierFit(r.supplier?.value) : null;
      if (!r.total || !supplier) continue;
      const label = `het document van ${r.supplier!.value}${r.invoiceDate ? ` van ${formatDateNl(r.invoiceDate.value)}` : ''}`;
      candidates.push({ supplier, total: r.total.value, currency: r.foreign?.currency ?? null, foreignTotal: r.foreign?.total ?? null, other: probeOf(r), match: { documentId: d.id, purchaseId: d.purchase_invoice_id, bankTransactionId: d.bank_transaction_id, label } });
    }
    // Bij hoeveel aankopen van deze leverancier staat dit nummer al? Alleen wat geboekt is telt: een bon die nog
    // op controle wacht kan zelf de kopie zijn.
    const sameNumber = new Set(candidates.filter((c) => c.match.purchaseId && !!probe.number && c.other.number === probe.number).map((c) => c.match.purchaseId));

    let weak: DuplicateMatch | null = null;
    for (const c of candidates) {
      const found = compare(c.supplier, amountFit(c), c.other);
      if (!found || rejected.has(candidateOf(c.match))) continue;
      if (found.strength === 'zeker') return { ...c.match, ...found };
      // een ander bedrag: beide bedragen erbij, zodat te zien is of het dezelfde aankoop kan zijn
      weak ??= { ...c.match, ...found, ...(found.reason === 'bedrag' && c.total !== total ? { detail: `Het nummer is hetzelfde, het bedrag niet: daar ${formatEuro(c.total)}, hier ${formatEuro(total)}.` } : {}) };
    }
    return weak;
  }

  /**
   * Legt vast dat een document een kopie is ("Ja, dezelfde aankoop", of vanzelf bij een zekere kopie).
   * Beide bestanden blijven bewaard. Hoort het origineel bij een aankoop of betaling, dan komt de kopie
   * daar ook bij en wordt het best leesbare bestand het hoofdbewijsstuk; er wordt nooit iets geboekt.
   */
  markDuplicate(id: number, match: Pick<DuplicateMatch, 'documentId' | 'purchaseId' | 'bankTransactionId'>, provenance: LinkProvenance = 'gebruiker'): IntakeDocument {
    tx(this.db, () => {
      const doc = this.get(id);
      if (doc.status === 'verwerkt' || doc.link) throw new ValidationError('Dit bonnetje is al verwerkt');
      if (match.documentId && !this.db.prepare('SELECT 1 FROM documents WHERE id = ?').get(match.documentId)) throw new ValidationError('Het voorstel voor deze bon is intussen veranderd. Bekijk hem opnieuw.');
      const target = this.targetOf(match);
      if (target && !this.links.describe(target)) throw new ValidationError('Het voorstel voor deze bon is intussen veranderd. Bekijk hem opnieuw.');
      this.db
        .prepare(`UPDATE documents SET status = 'genegeerd', duplicate_of_document_id = ?, issues = ? WHERE id = ?`)
        .run(match.documentId, JSON.stringify([DUPLICATE_NOTE]), id);
      if (target) this.links.link(id, target, 'dubbel', provenance);
    });
    return this.get(id);
  }

  /**
   * Zoekt een onverwerkte banktransactie met hetzelfde bedrag rond dezelfde datum: tot tien dagen ervoor of
   * erna. Past de naam of het rekeningnummer van de leverancier, dan mag de betaling tot twintig dagen na
   * de bon liggen (hetzelfde venster als overal waar de app een betaling en een aankoop vergelijkt).
   * Een regel die als waarschijnlijke dubbel wordt vastgehouden, telt niet mee.
   */
  findBankMatch(result: DocumentResult): BankTransaction | null {
    if (!result.total) return null;
    const foreign = Boolean(result.foreign);
    // vreemde munt: de bank rekende een eigen koers, dus ongeveer hetzelfde bedrag
    const amountFits = this.bank.list({ status: 'nieuw', limit: 2000 }).filter((t) => (foreign ? t.amount < 0 && withinFx(-t.amount, result.total!.value) : t.amount === -result.total!.value));
    if (amountFits.length === 0) return null;
    // een regel die waarschijnlijk dezelfde betaling is als een regel die er al staat (#225), is geen kandidaat:
    // eerst het antwoord bij die melding
    const held = this.bank.heldAsDouble();
    const candidates = amountFits.filter((t) => !held.has(t.id));
    const date = result.invoiceDate?.value;
    const scored = candidates
      .map((t) => {
        let score = 1;
        const nameMatch = Boolean(result.supplier && t.counter_name && sameSupplierName(result.supplier.value, t.counter_name));
        const ibanMatch = Boolean(result.supplierIban && t.counter_iban === result.supplierIban.value);
        if (date) {
          const d = Math.abs(diffDays(date, t.transaction_date));
          if (nameMatch || ibanMatch ? !dateFits({ invoice_date: date, due_date: null }, t.transaction_date) : d > BANK_DAYS_BEFORE) return null;
          score += d <= SURE_DAYS ? 2 : 1;
        }
        if (nameMatch) score += 3;
        if (ibanMatch) score += 3;
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
   * Een al (zonder document) als kosten geboekte afschrijving die bij deze bon hoort: bedrag, leverancier en
   * datum passen (de gedeelde vergelijking; in een andere munt mag het bedrag binnen de koers afwijken). In
   * euro's ook zonder naam: precies dit bedrag binnen een paar dagen. Passen er meer van dezelfde
   * leverancier (elke week hetzelfde bedrag), dan de dichtstbijzijnde: de gebruiker krijgt het als vraag.
   * Met `sure` alleen als er maar één past (voor wat zonder vraag verder gaat). Bij een creditnota: de
   * terugbetaling die al geboekt is. Met `forPurchase` (de bon is al een aankoop) telt een betaling waar al
   * een andere aankoop mee is samengevoegd niet mee; voor een losse bon wel, want die betaling heeft nog geen bon.
   */
  findBookedBankTransaction(result: DocumentResult, rejected: Set<string> = new Set(), opts: { sure?: boolean; forPurchase?: boolean } = {}): BankTransaction | null {
    const probe = probeOfDocument(result);
    if (!probe) return null;
    // een betaling waarbij deze bon is afgewezen ("Nee, andere aankoop") stellen we niet opnieuw voor
    const match = this.matcher.bookedMatch(probe, 'open', { skip: (t) => rejected.has(`bank:${t.id}`), merged: !opts.forPurchase });
    return match && (match.sure || !opts.sure) ? match.transaction : null;
  }

  /** Staat er een nog niet verwerkte afschrijving op een eigen rekening die bij deze (open) aankoop past? */
  private awaitsDebit(purchaseId: number): boolean {
    const probe = this.matcher.probe(purchaseId);
    return !!probe && this.matcher.transactionsFor(probe, 'open', 'nieuw').length > 0;
  }

  /**
   * De gebruiker verbeterde op het controlescherm de leverancier, het nummer, het bedrag of de datum (#224):
   * staat er met die gegevens al een aankoop of bon die erop lijkt? Bij het inlezen is alleen vergeleken met
   * wat toen gelezen was. Het ingevulde nummer telt als betrouwbaar, zoals bij handmatige invoer. Een voorstel
   * waar bij deze bon al "Nee" op is gezegd, komt niet terug. null = niets gevonden, er is niets veranderd, of
   * de bon is privé (dan wordt er geen aankoop geboekt). Er wordt hier niets vastgelegd.
   */
  duplicateOfConfirmation(id: number, c: Pick<Confirmation, 'supplier' | 'date' | 'total' | 'invoiceNumber' | 'business'>): DuplicateMatch | null {
    if (!c.business || !c.supplier?.trim() || !c.total) return null;
    const doc = this.get(id);
    const number = c.invoiceNumber ? normalizeInvoiceNumber(c.invoiceNumber) : '';
    if (JSON.stringify([supplierKey(c.supplier), c.date, c.total, number || null]) === documentFingerprint(doc.result)) return null;
    const read = doc.result;
    const probe: DuplicateProbe = { number: number || null, reliable: number.length >= MIN_NUMBER_LENGTH, date: c.date, credit: c.total < 0 || read?.documentType?.value === 'credit_note' };
    // het bedrag in de vreemde munt geldt alleen nog als het bedrag in euro's niet is aangepast
    const foreign = read?.foreign && read.total?.value === c.total ? read.foreign : null;
    return this.duplicateOf({ supplier: c.supplier, total: c.total, foreign, probe }, id, read ? this.rejected(id, read) : new Set());
  }

  /**
   * BOEKHOUDING (deterministisch): verwerkt het document met de (bevestigde) gegevens.
   * Leert de leverancier alleen als de gebruiker zelf bevestigde.
   */
  confirm(id: number, c: Confirmation, opts: { learn?: boolean; bankTransactionId?: number } = {}): IntakeDocument {
    const doc = this.get(id);
    // factuur van je eigen bedrijf (#205): alleen privé of "weet ik nog niet", en de leverancier niet onthouden
    const ownInvoice = this.ownIssue(doc) !== null;
    if (ownInvoice && c.business && c.categoryKey !== QUESTION_CATEGORY) {
      throw new ValidationError('Dit is een factuur van je eigen bedrijf. Kies "Privé" of "Weet ik nog niet: vraag mijn boekhouder". Is het toch een gewone aankoop? Kies dat dan eerst bij de bon.');
    }
    if (ownInvoice) opts = { ...opts, learn: false };
    if (doc.status === 'verwerkt' || doc.link) throw new ValidationError('Dit bonnetje is al verwerkt');
    if (doc.status === 'genegeerd' && doc.duplicate_of_document_id !== null) throw new ValidationError('Dit is een kopie van een bon die er al in staat. Verwerk die andere bon, of kies eerst "Toch geen kopie".');
    // stond als bewijs bij een betaling (oude tekstkoppeling) en is nog niet opnieuw bekeken: eerst kijken of hij al ergens bij hoort
    if (this.awaitsReassessment(doc)) throw new ValidationError('Deze bon stond eerder als bewijs bij een betaling. Open hem eerst: dan kijkt de app of hij bij iets hoort dat er al staat.');
    // eerst de vraag beantwoorden ("dezelfde aankoop?", "alleen als bewijs?"): anders staat het zo dubbel
    if (this.pending(doc)) throw new ValidationError('Kies eerst of deze bon bij iets hoort dat er al staat. Daarna kun je hem verwerken.');
    if (!c.supplier?.trim()) throw new ValidationError('Vul de winkel of leverancier in');
    if (!Number.isSafeInteger(c.total) || c.total === 0) throw new ValidationError('Vul het totaalbedrag in');
    // de leverancier, het nummer, het bedrag of de datum verbeterd: staat de aankoop er met die gegevens al? (#224)
    const again = ownInvoice || c.allowDuplicate ? null : this.duplicateOfConfirmation(id, c);
    if (again) throw new ValidationError(`${duplicateLead(again)} Staat deze aankoop er al in? Kijk het eerst na; is het een andere aankoop, kies dan "Toch boeken".`);
    // "Weet ik nog niet (vraag mijn boekhouder)": apart op Vraagposten, zonder btw-aftrek en zonder iets te
    // leren; de btw-controle en het pakket voor de boekhouder melden hem tot hij is ingedeeld
    if (c.categoryKey === QUESTION_CATEGORY) c = { ...c, vatCode: 'geen', vatAmount: null, splits: null, business: true, businessPct: undefined };
    const category = c.categoryKey === QUESTION_CATEGORY ? { key: QUESTION_CATEGORY, label: 'Nog uitzoeken', account: ACCOUNTS.vraagposten } : this.categories.find(c.categoryKey);
    if (!category) throw new ValidationError('Kies waar de aankoop voor was');
    if (!isPurchaseVatCode(c.vatCode)) throw new ValidationError('Kies of er btw op de bon stond');

    tx(this.db, () => {
      if (opts.learn !== false && c.categoryKey !== QUESTION_CATEGORY) {
        // de eindkeuze van de gebruiker is de leerbron, wie het voorstel ook deed (#132)
        this.memory.learn(c.supplier, { categoryKey: c.categoryKey, vatCode: c.vatCode, business: c.business });
        this.recordProposalOutcome(doc, c);
      }
      // de afschrijving die de gebruiker erbij zag (eigen bedrijf), anders de betaling die de app zelf vond
      const chosen = opts.bankTransactionId ? this.bank.get(opts.bankTransactionId) : null;
      if (chosen && (chosen.status !== 'nieuw' || chosen.amount !== -c.total)) throw new ValidationError('Deze betaling is intussen anders verwerkt. Kijk het opnieuw na.');
      const found = chosen ?? doc.bank_match;
      const bankTx = found && (found.amount === -c.total || (doc.result?.foreign && withinFx(-found.amount, c.total))) ? found : null;
      if (!c.business) {
        // privé: niet in de boekhouding; als het van de zakelijke rekening betaald is → privé-opname
        if (bankTx) this.bank.bookToAccount(bankTx.id, { account: ACCOUNTS.priveOpnamen, description: `Privé: ${c.supplier}` });
        this.db.prepare(`UPDATE documents SET status = 'genegeerd' WHERE id = ?`).run(id);
        // factuur van je eigen bedrijf: hij blijft als bewijs bij de betaling staan, zodat ze samen terug te vinden zijn
        if (ownInvoice && bankTx) {
          this.links.link(id, { kind: 'bank', id: bankTx.id }, 'bewijs');
          this.db.prepare(`UPDATE documents SET status = 'verwerkt', issues = '[]' WHERE id = ?`).run(id);
        }
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
        // niet op de zakelijke rekening gevonden: leverancier die je altijd privé/contant betaalt → meteen betaald.
        // Staat er toch een afschrijving die erbij past (bedrag, leverancier en datum) op een eigen rekening te
        // wachten (#222), dan blijft de aankoop open: bij die betaling vraagt de app of ze bij elkaar horen.
        const usual = c.paidWith === 'later' && relation.paid_with && !this.awaitsDebit(purchase.id) ? relation.paid_with : null;
        const paidWith = c.paidWith === 'later' ? usual : c.paidWith === 'bank' ? null : c.paidWith;
        if (paidWith) this.purchases.registerPayment(purchase.id, { amount: purchase.total, date: c.date, moneyAccount: paidWith === 'kas' ? ACCOUNTS.kas : ACCOUNTS.priveStortingen });
      }
      // de aankoop is uit dit document geboekt; kopieën die erop wachtten horen er nu ook bij (niets extra geboekt)
      const target: LinkTarget = { kind: 'aankoop', id: purchase.id };
      this.links.link(id, target, 'geboekt', opts.learn === false ? 'automatisch' : 'gebruiker');
      const copies = this.db
        .prepare(`SELECT d.id FROM documents d WHERE d.duplicate_of_document_id = ? AND d.status = 'genegeerd' AND NOT EXISTS (SELECT 1 FROM document_links k WHERE k.document_id = d.id) ORDER BY d.id`)
        .all(id) as { id: number }[];
      for (const copy of copies) this.links.link(copy.id, target, 'dubbel', 'automatisch');
      this.db.prepare(`UPDATE documents SET status = 'verwerkt' WHERE id = ?`).run(id);
      if (c.jobId) {
        // eerste foto met locatie bij een klus zonder locatie wordt de kluslocatie (alleen als opt-in de locatie heeft opgeslagen)
        this.db.prepare('UPDATE jobs SET lat = (SELECT gps_lat FROM documents WHERE id = ?), lon = (SELECT gps_lon FROM documents WHERE id = ?) WHERE id = ? AND lat IS NULL AND (SELECT gps_lat FROM documents WHERE id = ?) IS NOT NULL').run(id, id, c.jobId, id);
      }
    });
    return this.get(id);
  }

  /**
   * Audit en evaluatie (#132): wie deed het voorstel (`proposedBy`), en wat koos de gebruiker uiteindelijk
   * (`accepted`)? Een afwijkende categorie telt als correctie van dat voorstel. Geen inhoud, alleen tellers.
   */
  private recordProposalOutcome(doc: IntakeDocument, c: Confirmation): void {
    const proposal = doc.classification;
    if (!proposal) return;
    const proposedBy = proposal.proposedBy ?? (proposal.source === 'llm' ? 'ollama' : proposal.source);
    const corrected = proposal.categoryKey !== c.categoryKey || proposal.business !== c.business;
    const accepted = { categoryKey: c.categoryKey, vatCode: c.vatCode, business: c.business, corrected };
    this.db.prepare('UPDATE documents SET classification = ? WHERE id = ?').run(JSON.stringify({ ...proposal, proposedBy, accepted }), doc.id);
    this.db
      .prepare(`INSERT INTO proposal_stats (proposed_by, model, ${corrected ? 'corrected' : 'accepted'}) VALUES (?, ?, 1)
        ON CONFLICT(proposed_by, model) DO UPDATE SET ${corrected ? 'corrected = corrected' : 'accepted = accepted'} + 1`)
      .run(proposedBy, proposal.model ?? '');
    if (corrected && (proposedBy === 'jev' || proposedBy === 'ollama')) {
      // "Ja" op Vandaag staat al in het logboek; een aangepast AI-voorstel hier, zodat terug te zien is wie wat koos
      logAutomation(this.db, {
        kind: 'gebruiker',
        ref_id: doc.id,
        summary: `${c.supplier}: voorstel van ${PROPOSED_BY_LABEL[proposedBy]} aangepast`,
        reason: `${PROPOSED_BY_LABEL[proposedBy]} stelde ${this.categories.label(proposal.categoryKey)} voor; jij koos ${c.business ? this.categories.label(c.categoryKey) : 'privé'}.`,
        actor: 'gebruiker',
      });
    }
  }

  /** Splitst per BTW-tarief als het document dat laat zien en het klopt met het totaal; anders één regel. */
  private purchaseLines(result: DocumentResult | null, c: Confirmation, account: string): PurchaseLineInput[] {
    const vatRate = reverseChargeRate(c.vatCode, c.vatRate);
    const rateField = vatRate ? { vatRate } : {};
    if (c.splits && c.splits.length > 1) {
      if (c.splits.reduce((s, x) => s + x.gross, 0) !== c.total) throw new ValidationError('De delen tellen niet op tot het totaal');
      // een deel met een eigen tarief (van de bonregels) krijgt dat tarief; anders het tarief van de bon
      const codeFor = (r: number | undefined): PurchaseVatCode => (r === undefined || isReverseCharge(c.vatCode) ? c.vatCode : r === 21 ? 'hoog' : r === 9 ? 'laag' : r === 0 ? 'nul' : c.vatCode);
      return c.splits.map((sp) => {
        const vatCode = codeFor(sp.vatRate);
        const rate = (isReverseCharge(vatCode) ? vatRate : undefined) ?? PURCHASE_VAT_RATES[vatCode].percentage;
        if (sp.categoryKey === 'prive') return { account: ACCOUNTS.priveOpnamen, netAmount: sp.gross, vatCode: 'geen' as const, description: 'Privé-deel van de bon' };
        const cat = this.categories.find(sp.categoryKey);
        if (!cat) throw new ValidationError('Kies bij elk deel waar het voor was');
        const { net, vat } = splitGross(sp.gross, rate, isReverseCharge(vatCode));
        return { account: cat.account, netAmount: net, vatCode, vatAmount: vat, ...(isReverseCharge(vatCode) ? rateField : {}), description: cat.label };
      });
    }
    // zelf ingevuld btw-bedrag: gaat voor wat de app las of uitrekende (niet bij verlegde btw: die reken je zelf uit)
    if (c.vatAmount !== undefined && c.vatAmount !== null && !isReverseCharge(c.vatCode)) {
      if (!Number.isSafeInteger(c.vatAmount) || Math.abs(c.vatAmount) > Math.abs(c.total) || (c.total >= 0 && c.vatAmount < 0) || (c.total <= 0 && c.vatAmount > 0)) throw new ValidationError('Het btw-bedrag kan niet meer zijn dan het totaal');
      const pct = PURCHASE_VAT_RATES[c.vatCode].percentage;
      if (pct === 0 && c.vatAmount !== 0) throw new ValidationError('Bij "geen btw" of 0% hoort geen btw-bedrag');
      // nooit meer btw dan het tarief toelaat (een paar cent afronding per regel mag)
      const max = Math.round((Math.abs(c.total) * pct) / (100 + pct));
      if (Math.abs(c.vatAmount) > max + 2) throw new ValidationError(`Bij ${pct}% kan de btw hooguit ${(max / 100).toFixed(2).replace('.', ',')} zijn. Staat er meer op de bon? Dan klopt het tarief of het totaal niet.`);
      return [{ account, netAmount: c.total - c.vatAmount, vatCode: c.vatCode, vatAmount: c.vatAmount }];
    }
    const vat = result?.vat.value ?? [];
    const complete = vat.length > 1 && vat.every((v) => v.base !== null) && vat.reduce((s, v) => s + (v.base ?? 0) + v.amount, 0) === c.total;
    if (complete && vat.some(v => ![0, 9, 21].includes(v.rate))) {
      throw new ValidationError('Op deze bon is een niet-ondersteund btw-tarief herkend. Controleer het tarief en vul het btw-bedrag zelf in.');
    }
    if (complete) {
      return vat.map((v) => ({
        account,
        netAmount: v.base!,
        vatCode: v.rate === 21 ? 'hoog' : v.rate === 9 ? 'laag' : 'nul',
        vatAmount: v.amount,
        description: `${v.rate}%`,
      }));
    }
    const rate = vatRate ?? PURCHASE_VAT_RATES[c.vatCode].percentage;
    const { net, vat: vatAmount } = splitGross(c.total, rate, isReverseCharge(c.vatCode));
    // Gebruik het BTW-bedrag van het document als dat binnen 2 cent klopt (bonnen ronden soms per regel af)
    const docVat = vat.length === 1 ? vat[0]!.amount : null;
    const useDoc = docVat !== null && !isReverseCharge(c.vatCode) && Math.abs(docVat - vatAmount) <= 2;
    return [{ account, netAmount: useDoc ? c.total - docVat! : net, vatCode: c.vatCode, vatAmount: useDoc ? docVat! : vatAmount, ...rateField }];
  }

  ignore(id: number): void {
    this.db.prepare(`UPDATE documents SET status = 'genegeerd' WHERE id = ? AND status <> 'verwerkt'`).run(id);
  }

  get(id: number): IntakeDocument {
    const row = this.db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new ValidationError('Dit bonnetje bestaat niet (meer)');
    const result = row.result ? (JSON.parse(row.result) as DocumentResult) : null;
    const issues = JSON.parse(row.issues) as Issue[];
    const link = this.links.forDocument(id);
    const bankMatch = row.status === 'verwerkt' || !result ? null : (issues.some((i) => i.field === OWN_COMPANY_ISSUE) ? this.findOwnPayment(result) : null) ?? this.findBankMatch(result);
    const probe = bankMatch && result ? probeOfDocument(result) : null;
    return {
      ...row,
      result,
      classification: row.classification ? JSON.parse(row.classification) : null,
      issues,
      decisions: row.decisions ? (JSON.parse(row.decisions) as Decision[]) : null,
      bank_match: bankMatch,
      // dezelfde maatstaf als `awaitsDebit` bij het boeken: bedrag, leverancier en datum
      bank_match_strong: Boolean(bankMatch && probe && fitOf(bankMatch, probe, 'open')?.strength === 'sterk'),
      link,
      outcome: this.links.outcome({ ...row, issues }, link),
    };
  }

  list(status?: IntakeDocument['status']): IntakeDocument[] {
    const rows = this.db.prepare(`SELECT id FROM documents ${status ? 'WHERE status = ?' : ''} ORDER BY id DESC LIMIT 500`).all(...(status ? [status] : [])) as { id: number }[];
    return rows.map((r) => this.get(r.id));
  }
}

/** Alle geldbedragen van een document omrekenen (vreemde munt → euro's). */
/**
 * De datum voor de koers: de factuurdatum, maar nooit in de toekomst. Een verkeerd gelezen datum
 * (bv. een Amerikaanse 12/10/2026) mag het omrekenen niet tegenhouden: voor morgen bestaat geen koers.
 */
function rateDate(result: DocumentResult): IsoDate {
  const date = result.invoiceDate?.value;
  return date && date <= today() ? date : today();
}

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
