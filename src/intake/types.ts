import type { Cents } from '../shared/money';

/** Waar een veld vandaan komt. */
export type ExtractionSource = 'ubl' | 'pdf-text' | 'ocr' | `ocr:${string}` | 'gebruiker';

/** Eén herkend veld mét herkomst, zodat elke beslissing later te controleren is. */
export interface Field<T> {
  value: T;
  /** 0..1 — zekerheid van de extractie van dít veld */
  confidence: number;
  source: ExtractionSource;
  page?: number;
  /** [x1, y1, x2, y2] in pixels (afbeelding) of PDF-punten van de pagina */
  bbox?: [number, number, number, number];
  raw?: string;
}

export interface VatLine {
  rate: number;
  base: Cents | null;
  amount: Cents;
}

export type DocumentType = 'purchase_invoice' | 'receipt' | 'credit_note' | 'unknown';

/**
 * Uniform resultaat, ongeacht de bron (UBL, PDF-tekst of welk OCR-model dan ook).
 * Bedragen in centen. De rest van het systeem kent alleen dit formaat.
 */
export interface DocumentResult {
  documentType: Field<DocumentType>;
  supplier: Field<string> | null;
  supplierVatNumber: Field<string> | null;
  supplierIban: Field<string> | null;
  invoiceNumber: Field<string> | null;
  invoiceDate: Field<string> | null;
  dueDate: Field<string> | null;
  currency: Field<string>;
  subtotal: Field<Cents> | null;
  vat: Field<VatLine[]>;
  total: Field<Cents> | null;
  /** omschrijvingen van regels/artikelen — input voor classificatie */
  lineDescriptions: string[];
  /** "btw verlegd" op het document */
  reverseCharge: boolean;
  /** ruwe tekst voor debugging en classificatie */
  rawText: string;
  pageSizes?: { width: number; height: number }[];
}

/** Tekstfragment met positie, zoals een PDF-parser of OCR-engine het oplevert. */
export interface TextItem {
  text: string;
  page: number;
  bbox?: [number, number, number, number];
  confidence?: number;
}

export type ConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW';

export interface Issue {
  field: string;
  severity: 'fout' | 'waarschuwing';
  message: string;
  /** voorstel voor de juiste waarde, als we die kunnen afleiden */
  suggestion?: unknown;
}
