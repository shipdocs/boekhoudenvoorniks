import { parseEuro, type Cents } from '../shared/money';
import { isIsoDate } from '../shared/dates';
import { isValidIban, normalizeIban } from '../shared/validation';
import type { LineItem, DocumentResult, ExtractionSource, Field, TextItem, VatLine } from './types';
import { KNOWN_SUPPLIERS } from './suppliers';
import { detectCurrency } from '../shared/currency';

/**
 * Haalt factuur-/bongegevens uit platte tekst met posities (PDF-tekstlaag of OCR-regels).
 * Dit is EXTRACTIE: wat staat er? Er worden hier geen fiscale beslissingen genomen.
 */
const AMOUNT_RE = /(?:€\s*)?(-?\d{1,3}(?:[.\s]\d{3})*[,.]\d{2}|-?\d+[,.]\d{2})(?!\d)/g;
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mrt: 3, maa: 3, mar: 3, apr: 4, mei: 5, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, okt: 10, oct: 10, nov: 11, dec: 12 };

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
    // stukjes die tegen elkaar aan staan (bv. "P6ARUBNL" "-" "0001") zijn één woord: geen spatie ertussen
    const text = items.reduce((t, it, i) => {
      if (i === 0) return it.text;
      const prev = items[i - 1]!;
      const gap = it.bbox![0] - prev.bbox![2];
      const h = Math.max(it.bbox![3] - it.bbox![1], prev.bbox![3] - prev.bbox![1]);
      return t + (gap < h * 0.15 ? '' : ' ') + it.text;
    }, '');
    return {
      text: text.replace(/\s+/g, ' ').trim(),
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

function parseDateText(text: string, opts: { loose?: boolean } = {}): string | null {
  let m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  if (m) return isIsoDate(`${m[1]}-${m[2]}-${m[3]}`) ? `${m[1]}-${m[2]}-${m[3]}` : null;
  // "30 09 2026" (streepjes weggevallen in de tekstlaag) en, alleen achter een kopje als "Datum", "30092026"
  m = /\b(\d{2}) (\d{2}) (20\d{2})\b/.exec(text) ?? (opts.loose ? /\b(\d{2})(\d{2})(20\d{2})\b/.exec(text) : null);
  if (m) {
    const iso = `${m[3]}-${m[2]}-${m[1]}`;
    if (isIsoDate(iso)) return iso;
  }
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
  // Engels: "May 6, 2026" of "September 12 2026"
  m = /\b([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/i.exec(text);
  if (m && MONTHS[m[1]!.toLowerCase()]) {
    const iso = `${m[3]}-${String(MONTHS[m[1]!.toLowerCase()]).padStart(2, '0')}-${m[2]!.padStart(2, '0')}`;
    return isIsoDate(iso) ? iso : null;
  }
  return null;
}

/** "(Includes VAT of € 1,73)", "incl. btw € 1,73" */
const INCL_VAT = /\b(?:includes|including|incl\.?|inclusief|inkl\.?)\s*(?:vat|btw|mwst|tax)\s*(?:of|van|von)?\s*:?\s*([€$£]?\s*\d[\d.,]*\d)/i;

/** Betaaldiensten: staan vaak op een factuur ("paid via Stripe"), maar zijn niet de leverancier. */
const PAYMENT_PROVIDERS = new Set(['Stripe', 'PayPal', 'Mollie', 'Adyen']);
const VIA_LINE = /\b(?:paid|betaald|bezahlt)\s+(?:via|with|met|mit)\b|\b(?:processed|powered|provided)\s+by\b/i;
/** "Cloudflare, Inc. @cloudflare Bill to": links de verkoper, rechts het kopje van de klant */
const BILL_TO = /^(.*?)\s*\b(?:bill(?:ed)?\s+to|invoice\s+to|factuur\s+aan|rechnung\s+an)\b/i;
/** Kopjes, geen naam van een leverancier */
const LABEL_LINE = /factuur|\bbon\b|kassabon|invoice|receipt|rechnung|datum|\bdate\b|nummer|number|\bdue\b|pagina|page|bill to|ship to|account\s*id|billing\s*period|company\s*name|team\s*name|customer|klantnummer|\b(?:vat|btw|gst|ein)\b|\b(?:betaald|paid|bezahlt)\s+(?:op|on|am)\b/i;

/** Naam van de verkoper links van "Bill to": zonder @handle; bij "X dba Y" de handelsnaam Y. */
function sellerName(raw: string): string | null {
  let name = raw.replace(/\(?@[\w.-]+\)?/g, ' ');
  const dba = /\bd\/?b\/?a\b\.?\s+(.+)$/i.exec(name);
  if (dba) name = dba[1]!;
  name = name.replace(/\s+/g, ' ').trim().replace(/[,;:]+$/, '');
  return /[a-z]{2,}/i.test(name) && !LABEL_LINE.test(name) ? name.slice(0, 80) : null;
}

/** Landen zoals ze in een adres staan → landcode (ISO). */
const COUNTRIES: [RegExp, string][] = [
  [/\bUnited States\b|\bUSA\b|\bU\.S\.A\b|\bVerenigde Staten\b/i, 'US'],
  [/\bUnited Kingdom\b|\bGreat Britain\b|\bVerenigd Koninkrijk\b/i, 'GB'],
  [/\bSingapore\b/i, 'SG'],
  [/\bCanada\b/i, 'CA'],
  [/\bAustralia\b|\bAustralië\b/i, 'AU'],
  [/\bSwitzerland\b|\bSchweiz\b|\bSuisse\b|\bZwitserland\b/i, 'CH'],
  [/\bIsrael\b/i, 'IL'],
  [/\bHong Kong\b/i, 'HK'],
  [/\bChina\b/i, 'CN'],
  [/\bJapan\b/i, 'JP'],
  [/\bIndia\b/i, 'IN'],
  [/\bNorway\b|\bNorwegen\b|\bNoorwegen\b/i, 'NO'],
  [/\bIreland\b|\bIerland\b/i, 'IE'],
  [/\bGermany\b|\bDeutschland\b|\bDuitsland\b/i, 'DE'],
  [/\bFrance\b|\bFrankrijk\b/i, 'FR'],
  [/\bBelgium\b|\bBelgië\b|\bBelgique\b/i, 'BE'],
  [/\bLuxembourg\b|\bLuxemburg\b/i, 'LU'],
  [/\bSweden\b|\bZweden\b/i, 'SE'],
  [/\bDenmark\b|\bDenemarken\b/i, 'DK'],
  [/\bSpain\b|\bSpanje\b/i, 'ES'],
  [/\bItaly\b|\bItalië\b/i, 'IT'],
  [/\bAustria\b|\bÖsterreich\b|\bOostenrijk\b/i, 'AT'],
  [/\bPoland\b|\bPolen\b/i, 'PL'],
  [/\bLithuania\b|\bLitouwen\b/i, 'LT'],
  [/\bEstonia\b|\bEstland\b/i, 'EE'],
  [/\bNetherlands\b|\bNederland\b/i, 'NL'],
];

export function parseDocumentText(items: TextItem[], source: ExtractionSource): DocumentResult {
  const lines = toLines(items);
  const rawText = lines.map((l) => l.text).join('\n');
  const field = <T>(value: T, line: Line, confidence: number): Field<T> => ({ value, confidence: confidence * line.confidence, source, page: line.page, bbox: line.bbox, raw: line.text });

  // Leverancier: 1. bekende naam; 2. "<verkoper> Bill to" (twee kolommen op één regel, bv. een
  // factuur van Stripe); 3. de eerste regel met letters; 4. desnoods een betaaldienst
  let supplier: Field<string> | null = null;
  let provider: Field<string> | null = null;
  for (const line of lines.slice(0, 40)) {
    // "(paid via Stripe)": de betaaldienst, niet de leverancier
    if (VIA_LINE.test(line.text)) continue;
    const known = KNOWN_SUPPLIERS.find((s) => s.pattern.test(line.text));
    if (!known) continue;
    if (PAYMENT_PROVIDERS.has(known.name)) {
      provider ??= field(known.name, line, 0.6);
      continue;
    }
    supplier = field(known.name, line, 0.95);
    break;
  }
  let supplierLine = supplier ? lines.findIndex((l) => l.text === supplier!.raw) : -1;
  if (!supplier) {
    const i = lines.slice(0, 40).findIndex((l) => BILL_TO.test(l.text));
    const name = i >= 0 ? sellerName(BILL_TO.exec(lines[i]!.text)![1]!) : null;
    if (name) {
      supplier = field(name, lines[i]!, 0.85);
      supplierLine = i;
    }
  }
  if (!supplier) {
    // de eerste regel met letters, maar geen kopje als "Factuur", "Date of issue" of "Account ID"
    const i = lines.findIndex((l) => /[a-z]{3,}/i.test(l.text) && !LABEL_LINE.test(l.text) && !VIA_LINE.test(l.text));
    if (i >= 0) {
      // "ShipDocs ShipDocs": twee kolommen (afzender en klant zijn hetzelfde bedrijf) op één regel
      const t = lines[i]!.text.replace(/^(.{2,40}?) \1$/, '$1');
      supplier = field(t.slice(0, 80), lines[i]!, 0.5);
      supplierLine = i;
    }
  }
  supplier ??= provider;

  // Datum: bij voorkeur een regel met "datum"
  let invoiceDate: Field<string> | null = null;
  // 1. regel met "datum"/"date"; 2. elke andere regel behalve een betaaldatum; 3. desnoods de betaaldatum
  // (een kassabon heeft de datum soms alleen bij "Betaald met pin")
  const isPayment = (t: string) => /payment|paid|betaal/i.test(t);
  for (const [pass, conf] of [['label', 0.95], ['geen-betaling', 0.75], ['alles', 0.6]] as const) {
    for (const line of lines) {
      if (pass === 'label' && !/datum|date/i.test(line.text)) continue;
      if (pass !== 'alles' && isPayment(line.text)) continue;
      if (/verval|due/i.test(line.text)) continue;
      const d = parseDateText(line.text, { loose: pass === 'label' });
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
    if (/te\s*betalen|totaal\s*incl|amount\s*(?:due|paid)|total\s*paid|te voldoen|betaald\s*bedrag/.test(t)) totalCandidates.push({ line, value: a[a.length - 1]!, conf: 0.95 });
    else if (/\btotaal\b|\btotal\b|^bedrag|pin(nen)?\b|betaald/.test(t)) totalCandidates.push({ line, value: a[a.length - 1]!, conf: 0.85 });
    // Stripe zet het bedrag ook bovenaan: "$5.00 USD due September 2, 2026"
    else if (/^[€$£]?\s*[\d.,]+\s*[a-z]{3}\s+due\b/.test(t)) totalCandidates.push({ line, value: a[0]!, conf: 0.9 });
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
  const VAT_WORD = /btw|vat|b\.t\.w|omzetbelasting/i;
  const candidates: { line: Line; vat: VatLine; word: boolean }[] = [];
  for (const [i, line] of lines.entries()) {
    const m = /(\d{1,2})(?:[.,]0+)?\s*%/.exec(line.text);
    if (!m) continue;
    const rate = Number(m[1]);
    if (![0, 9, 21, 6, 19].includes(rate)) continue;
    const a = amounts(line.text.replace(m[0], ' '));
    if (a.length === 0) continue;
    const word = VAT_WORD.test(line.text);
    // "VAT - Netherlands 21% on $5.00": dat bedrag is de grondslag; de btw staat op dezelfde regel of
    // vlak erboven/eronder (Stripe zet hem in een eigen kolom)
    const on = /%\s*(?:on|over|of|van|auf)\s*[€$£]?\s*(\d[\d.,]*\d)/i.exec(line.text);
    if (on && word) {
      const base = amounts(on[1]!)[0];
      if (base !== undefined) {
        const expected = Math.round((base * rate) / 100);
        const near = [line, lines[i - 1], lines[i + 1], lines[i - 2], lines[i + 2]].filter((l): l is Line => !!l);
        const amount = near.flatMap((l) => amounts(l === line ? line.text.replace(on[0], ' ') : l.text)).find((x) => Math.abs(x - expected) <= 2);
        if (amount !== undefined) {
          candidates.push({ line, vat: { rate, base, amount }, word });
          continue;
        }
      }
    }
    // zonder "btw" en met maar één bedrag: alleen een kale regel als "21%  14,74", geen artikelregel met tekst
    if (!word && a.length === 1 && /[a-z]{3,}/i.test(line.text)) continue;
    if (a.length >= 2) {
      const [x, y] = [a[a.length - 2]!, a[a.length - 1]!];
      // grondslag en btw: bij tarieven ≤ 21% is de grondslag altijd het grootste bedrag
      const base = Math.abs(x) >= Math.abs(y) ? x : y;
      const amount = base === x ? y : x;
      // zonder het woord "btw" moet het bedrag passen bij de grondslag (excl. of incl.), anders is het bv. een
      // artikelregel met een kolom "21%". Mét "btw" houden we de regel, zodat de validatie een leesfout vangt.
      const fits = Math.abs(amount - Math.round((base * rate) / 100)) <= 2 || Math.abs(amount - Math.round((base * rate) / (100 + rate))) <= 2;
      if (!fits && !word) continue;
      candidates.push({ line, vat: { rate, base, amount }, word });
    } else {
      candidates.push({ line, vat: { rate, base: null, amount: a[0]! }, word });
    }
  }
  // "(Includes VAT of € 1,73)" zonder percentage: het tarief volgt uit het bedrag en het totaal
  const inclLine = lines.find((l) => INCL_VAT.test(l.text));
  if (candidates.length === 0 && inclLine && total) {
    const vat = amounts(INCL_VAT.exec(inclLine.text)![1]!)[0];
    const base = vat === undefined ? 0 : total.value - vat;
    const rate = vat !== undefined && base > 0 ? [21, 9].find((r) => Math.abs(Math.round((base * r) / 100) - vat) <= 2) : undefined;
    if (rate !== undefined) candidates.push({ line: inclLine, vat: { rate, base, amount: vat! }, word: true });
  }
  // staan er regels met "btw" in, dan alleen die: losse "21%" is dan een kolom in de artikeltabel
  const chosen = candidates.some((c) => c.word) ? candidates.filter((c) => c.word) : candidates;
  for (const c of chosen) {
    vatLines.push(c.vat);
    vatConf = c.word ? 0.85 : 0.7;
    vatLine ??= c.line;
  }
  const reverseCharge = /btw\s*verlegd|verlegd|reverse\s*charge|vat\s*reverse/i.test(rawText);

  // Land van de leverancier: het eerste land onder de naam van de leverancier, vóór de artikelen.
  // Staat het adres van de klant ernaast (twee kolommen), dan het meest linkse.
  let supplierCountry: Field<string> | null = null;
  const tableStart = lines.findIndex((l) => /^(description|omschrijving|beschrijving|artikel)\b/i.test(l.text));
  for (const line of lines.slice(Math.max(0, supplierLine), tableStart > supplierLine ? tableStart : undefined)) {
    const hits = COUNTRIES.map(([re, code]) => ({ code, at: re.exec(line.text)?.index ?? -1 })).filter((h) => h.at >= 0).sort((x, y) => x.at - y.at);
    if (hits.length) {
      supplierCountry = field(hits[0]!.code, line, 0.8);
      break;
    }
  }

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
    // munt van het document (#74): $ en USD worden dollars, anders euro
    currency: (() => { const c = detectCurrency(rawText); return { value: c.code, confidence: c.confidence, source }; })(),
    subtotal,
    vat: vatLine ? field(vatLines, vatLine, vatConf) : { value: [], confidence: 0.3, source },
    total,
    lines: itemLines,
    linesBasis,
    lineDescriptions: lines.filter((l) => amounts(l.text).length === 1 && /[a-z]{4,}/i.test(l.text) && !/totaal|btw|subtotaal|pin|betaald|wisselgeld/i.test(l.text)).map((l) => l.text).slice(0, 30),
    reverseCharge,
    // een land alleen als er geen btw op het document staat: "incl. btw" is nooit verlegd
    supplierCountry: inclLine ? null : supplierCountry,
    rawText,
  };
}
