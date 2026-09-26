import { parseEuro, type Cents } from '../shared/money';
import { isIsoDate } from '../shared/dates';
import { isValidIban, normalizeIban } from '../shared/validation';
import type { LineItem, DocumentResult, ExtractionSource, Field, TextItem, VatLine } from './types';
import { KNOWN_SUPPLIERS } from './suppliers';

/**
 * Haalt factuur-/bongegevens uit platte tekst met posities (PDF-tekstlaag of OCR-regels).
 * Dit is EXTRACTIE: wat staat er? Er worden hier geen fiscale beslissingen genomen.
 */
const AMOUNT_RE = /(?:€\s*)?(-?\d{1,3}(?:[.\s]\d{3})*[,.]\d{2}|-?\d+[,.]\d{2})(?!\d)/g;
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mrt: 3, maa: 3, apr: 4, mei: 5, jun: 6, jul: 7, aug: 8, sep: 9, okt: 10, oct: 10, nov: 11, dec: 12 };

interface Line {
  text: string;
  page: number;
  bbox?: [number, number, number, number];
  confidence: number;
}

/** Groepeert losse tekstfragmenten tot regels (op basis van verticale positie). */
export function toLines(items: TextItem[]): Line[] {
  if (items.every((i) => !i.bbox)) return items.flatMap((i) => i.text.split(/\r?\n/).map((text) => ({ text, page: i.page, confidence: i.confidence ?? 1 })));
  const sorted = [...items].filter((i) => i.text.trim()).sort((a, b) => a.page - b.page || a.bbox![1] - b.bbox![1] || a.bbox![0] - b.bbox![0]);
  const lines: (Line & { items: TextItem[] })[] = [];
  for (const it of sorted) {
    const last = lines[lines.length - 1];
    const h = it.bbox![3] - it.bbox![1];
    if (last && last.page === it.page && Math.abs(last.bbox![1] - it.bbox![1]) < Math.max(3, h * 0.5)) {
      last.items.push(it);
    } else {
      lines.push({ text: '', page: it.page, bbox: [...it.bbox!], confidence: 1, items: [it] });
    }
  }
  return lines.map((l) => {
    const items = l.items.sort((a, b) => a.bbox![0] - b.bbox![0]);
    return {
      text: items.map((i) => i.text).join(' ').replace(/\s+/g, ' ').trim(),
      page: l.page,
      bbox: [Math.min(...items.map((i) => i.bbox![0])), Math.min(...items.map((i) => i.bbox![1])), Math.max(...items.map((i) => i.bbox![2])), Math.max(...items.map((i) => i.bbox![3]))],
      confidence: Math.min(...items.map((i) => i.confidence ?? 1)),
    };
  });
}

/**
 * Bedragen op een artikelregel. Een spatie als duizendtalscheiding ("1 234,56") alleen als het getal
 * los staat: in "TS55 649,00" hoort 55 bij de artikelcode, dus is het bedrag 649,00.
 */
const ITEM_AMOUNT_RE = /(?<![\w.,])(-?\d{1,3}(?: \d{3})+,\d{2})(?!\d)|(?<![\d.,])(-?\d{1,3}(?:\.\d{3})+,\d{2}|-?\d+[.,]\d{2})(?!\d)/g;
/** Kortingsregel op een bon: hoort bij het artikel erboven, is zelf geen artikel. */
const DISCOUNT_RE = /\b(korting|discount|actiekorting|voordeel)\b/i;
function itemAmounts(text: string): Cents[] {
  return [...text.matchAll(ITEM_AMOUNT_RE)].map((m) => {
    try {
      return parseEuro((m[1] ?? m[2])!);
    } catch {
      return NaN;
    }
  }).filter((n) => Number.isFinite(n));
}

function amounts(text: string): Cents[] {
  return [...text.matchAll(AMOUNT_RE)].map((m) => {
    try {
      return parseEuro(m[1]!.replace(/\s/g, ''));
    } catch {
      return NaN;
    }
  }).filter((n) => Number.isFinite(n));
}

function parseDateText(text: string): string | null {
  let m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  if (m) return isIsoDate(`${m[1]}-${m[2]}-${m[3]}`) ? `${m[1]}-${m[2]}-${m[3]}` : null;
  m = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/.exec(text);
  if (m) {
    const y = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
    const iso = `${y}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
    return isIsoDate(iso) ? iso : null;
  }
  m = /\b(\d{1,2})\s+([a-z]{3})[a-z]*\.?\s+(\d{4})\b/i.exec(text);
  if (m && MONTHS[m[2]!.toLowerCase()]) {
    const iso = `${m[3]}-${String(MONTHS[m[2]!.toLowerCase()]).padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
    return isIsoDate(iso) ? iso : null;
  }
  return null;
}

export function parseDocumentText(items: TextItem[], source: ExtractionSource): DocumentResult {
  const lines = toLines(items);
  const rawText = lines.map((l) => l.text).join('\n');
  const field = <T>(value: T, line: Line, confidence: number): Field<T> => ({ value, confidence: confidence * line.confidence, source, page: line.page, bbox: line.bbox, raw: line.text });

  // Leverancier: bekende naam of eerste regel met letters
  let supplier: Field<string> | null = null;
  for (const line of lines.slice(0, 40)) {
    const known = KNOWN_SUPPLIERS.find((s) => s.pattern.test(line.text));
    if (known) {
      supplier = field(known.name, line, 0.95);
      break;
    }
  }
  if (!supplier) {
    const first = lines.find((l) => /[a-z]{3,}/i.test(l.text) && !/factuur|bon|kassabon|invoice|datum/i.test(l.text));
    if (first) supplier = field(first.text.slice(0, 80), first, 0.5);
  }

  // Datum: bij voorkeur een regel met "datum"
  let invoiceDate: Field<string> | null = null;
  for (const [preferred, conf] of [[true, 0.95], [false, 0.75]] as const) {
    for (const line of lines) {
      if (preferred && !/datum|date/i.test(line.text)) continue;
      if (/verval|due/i.test(line.text)) continue;
      const d = parseDateText(line.text);
      if (d) {
        invoiceDate = field(d, line, conf);
        break;
      }
    }
    if (invoiceDate) break;
  }
  let dueDate: Field<string> | null = null;
  const dueLine = lines.find((l) => /verval|uiterlijk|due/i.test(l.text) && parseDateText(l.text));
  if (dueLine) dueDate = field(parseDateText(dueLine.text)!, dueLine, 0.85);

  // Factuur-/bonnummer
  let invoiceNumber: Field<string> | null = null;
  for (const line of lines) {
    const m = /(?:factuur|invoice|bon|ticket|transactie|kassabon)\s*(?:nr|nummer|no|number|#)?\s*[.:]?\s*([A-Z0-9][A-Z0-9\-/.]{2,})/i.exec(line.text);
    if (m && /\d/.test(m[1]!)) {
      invoiceNumber = field(m[1]!.replace(/[.]$/, ''), line, 0.85);
      break;
    }
  }

  // Totaal: "te betalen" > "totaal" (niet subtotaal / totaal btw / excl)
  let total: Field<Cents> | null = null;
  const totalCandidates: { line: Line; value: Cents; conf: number }[] = [];
  for (const line of lines) {
    const t = line.text.toLowerCase();
    if (/sub\s*totaal|subtotal|excl|totaal\s*btw|btw\s*totaal|korting/.test(t)) continue;
    const a = amounts(line.text);
    if (a.length === 0) continue;
    if (/te\s*betalen|totaal\s*incl|amount\s*due|te voldoen/.test(t)) totalCandidates.push({ line, value: a[a.length - 1]!, conf: 0.95 });
    else if (/\btotaal\b|\btotal\b|^bedrag|pin(nen)?\b|betaald/.test(t)) totalCandidates.push({ line, value: a[a.length - 1]!, conf: 0.85 });
  }
  if (totalCandidates.length) {
    const best = totalCandidates.sort((a, b) => b.conf - a.conf || Math.abs(b.value) - Math.abs(a.value))[0]!;
    total = field(best.value, best.line, best.conf);
  }

  // Subtotaal / netto
  let subtotal: Field<Cents> | null = null;
  const subLine = lines.find((l) => /sub\s*totaal|subtotal|totaal\s*excl|netto|excl\.?\s*btw|bedrag\s*excl/i.test(l.text) && amounts(l.text).length);
  if (subLine) {
    const a = amounts(subLine.text);
    subtotal = field(a[a.length - 1]!, subLine, 0.85);
  }

  // BTW-regels: "21% ... [grondslag] ... btw" of "BTW 21% 21,00"
  const vatLines: VatLine[] = [];
  let vatConf = 0;
  let vatLine: Line | null = null;
  for (const line of lines) {
    const m = /(\d{1,2})(?:[.,]0+)?\s*%/.exec(line.text);
    if (!m || !/btw|vat|b\.t\.w|omzetbelasting|%/i.test(line.text)) continue;
    const rate = Number(m[1]);
    if (![0, 9, 21, 6, 19].includes(rate)) continue;
    const a = amounts(line.text.replace(m[0], ' '));
    if (a.length === 0) continue;
    if (a.length >= 2) {
      const [x, y] = [a[a.length - 2]!, a[a.length - 1]!];
      // grondslag en btw: bij tarieven ≤ 21% is de grondslag altijd het grootste bedrag
      const base = Math.abs(x) >= Math.abs(y) ? x : y;
      const amount = base === x ? y : x;
      vatLines.push({ rate, base, amount });
    } else {
      vatLines.push({ rate, base: null, amount: a[0]! });
    }
    vatConf = /btw|vat|omzetbelasting/i.test(line.text) ? 0.85 : 0.7;
    vatLine ??= line;
  }
  const reverseCharge = /btw\s*verlegd|verlegd|reverse\s*charge|vat\s*reverse/i.test(rawText);

  const ibanMatch = /\b([A-Z]{2}\d{2}\s?(?:[A-Z0-9]{4}\s?){2,7}[A-Z0-9]{1,4})\b/.exec(rawText);
  const iban = ibanMatch && isValidIban(ibanMatch[1]!) ? normalizeIban(ibanMatch[1]!) : null;
  const vatNr = /\b(NL\s?\d{9}\s?B\s?\d{2})\b/i.exec(rawText)?.[1]?.replace(/\s/g, '').toUpperCase() ?? null;
  const isInvoice = /factuur|invoice/i.test(rawText);
  const docLine = lines[0] ?? { text: '', page: 1, confidence: 1 };

  // Regels (#23): tekst + bedrag aan het eind, vóór de totalen. Alleen gebruiken als ze optellen.
  const NOT_ITEM = /totaal|total|btw|b\.t\.w|vat|subtotaal|pin|betaald|wisselgeld|contant|te betalen|iban|kvk|datum|factuur|bon\s*nr|kassa|korting totaal/i;
  const itemLines: Field<LineItem>[] = [];
  for (const line of lines) {
    if (NOT_ITEM.test(line.text) || !/[a-z]{3,}/i.test(line.text)) continue;
    const a = itemAmounts(line.text);
    if (a.length === 0 || a.length > 3) continue;
    const amount = a[a.length - 1]!;
    if (DISCOUNT_RE.test(line.text)) {
      // korting verlaagt het artikel erboven; zonder artikel erboven: negeren (dan klopt de som niet en splitsen we niet)
      const prev = itemLines[itemLines.length - 1];
      if (prev) {
        prev.value.amount -= Math.abs(amount);
        prev.value.unitPrice = null;
      }
      continue;
    }
    let quantity: number | null = null;
    let unitPrice: Cents | null = null;
    const qx = /(\d+(?:[.,]\d+)?)\s*(?:x|×|st\.?|stuks?)\s*(?:à\s*)?(?:€\s*)?(\d+[.,]\d{2})?/i.exec(line.text);
    if (qx) {
      quantity = Number(qx[1]!.replace(',', '.'));
      if (qx[2]) unitPrice = parseEuro(qx[2]);
      else if (a.length >= 2) unitPrice = a[a.length - 2]!;
    }
    const description = line.text.replace(ITEM_AMOUNT_RE, ' ').replace(/(\d+(?:[.,]\d+)?)\s*(?:x|×|st\.?|stuks?)\b/i, ' ').replace(/[€]/g, ' ').replace(/\s+/g, ' ').trim();
    if (description.length < 3) continue;
    itemLines.push(field({ description, quantity, unitPrice, amount, vatRate: null }, line, 0.8));
  }
  const itemSum = itemLines.reduce((sum, l) => sum + l.value.amount, 0);
  const linesBasis = itemLines.length === 0 ? null : total && itemSum === total.value ? ('incl' as const) : subtotal && itemSum === subtotal.value ? ('excl' as const) : null;

  return {
    documentType: field(/creditnota|credit\s*note|creditfactuur/i.test(rawText) ? 'credit_note' : isInvoice ? 'purchase_invoice' : 'receipt', docLine, 0.7),
    supplier,
    supplierVatNumber: vatNr ? { value: vatNr, confidence: 0.9, source } : null,
    supplierIban: iban ? { value: iban, confidence: 0.9, source } : null,
    invoiceNumber,
    invoiceDate,
    dueDate,
    currency: { value: 'EUR', confidence: /€|eur/i.test(rawText) ? 0.95 : 0.6, source },
    subtotal,
    vat: vatLine ? field(vatLines, vatLine, vatConf) : { value: [], confidence: 0.3, source },
    total,
    lines: itemLines,
    linesBasis,
    lineDescriptions: lines.filter((l) => amounts(l.text).length === 1 && /[a-z]{4,}/i.test(l.text) && !/totaal|btw|subtotaal|pin|betaald|wisselgeld/i.test(l.text)).map((l) => l.text).slice(0, 30),
    reverseCharge,
    rawText,
  };
}
