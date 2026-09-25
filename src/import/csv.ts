import Papa from 'papaparse';
import { parseEuro } from '../shared/money';
import { isIsoDate } from '../shared/dates';
import { normalizeIban } from '../shared/validation';
import type { NormalizedTransaction, ParseResult } from './types';

/**
 * Kolomtoewijzing voor een CSV-bankexport. De gebruiker kiest bij een onbekend formaat zelf
 * welke kolom wat is; de mapping wordt onthouden op basis van de kolomkoppen.
 */
export interface CsvMapping {
  date: string;
  /** Eén bedragkolom met teken… */
  amount?: string;
  /** …of een bedragkolom plus een Af/Bij (D/C) kolom */
  debitCredit?: string;
  /** óf aparte kolommen voor af en bij */
  amountDebit?: string;
  amountCredit?: string;
  description?: string[];
  counterName?: string;
  counterIban?: string;
  reference?: string;
  ownIban?: string;
  /** datumformaat, bv. 'YYYYMMDD', 'DD-MM-YYYY', 'YYYY-MM-DD', 'DD/MM/YYYY' */
  dateFormat: string;
}

export interface CsvPreview {
  headers: string[];
  rows: Record<string, string>[];
  delimiter: string;
  suggestedMapping: CsvMapping | null;
  detectedBank: string | null;
}

/** Bekende exportformaten van Nederlandse banken (kolomnamen zoals de bank ze exporteert). */
export const KNOWN_FORMATS: { bank: string; match: string[]; mapping: CsvMapping }[] = [
  {
    bank: 'ING',
    match: ['Datum', 'Naam / Omschrijving', 'Rekening', 'Tegenrekening', 'Af Bij', 'Bedrag (EUR)'],
    mapping: {
      date: 'Datum',
      amount: 'Bedrag (EUR)',
      debitCredit: 'Af Bij',
      counterName: 'Naam / Omschrijving',
      counterIban: 'Tegenrekening',
      ownIban: 'Rekening',
      description: ['Mededelingen'],
      dateFormat: 'YYYYMMDD',
    },
  },
  {
    bank: 'Rabobank',
    match: ['IBAN/BBAN', 'Datum', 'Bedrag', 'Tegenrekening IBAN/BBAN', 'Naam tegenpartij'],
    mapping: {
      date: 'Datum',
      amount: 'Bedrag',
      counterName: 'Naam tegenpartij',
      counterIban: 'Tegenrekening IBAN/BBAN',
      ownIban: 'IBAN/BBAN',
      reference: 'Betalingskenmerk',
      description: ['Omschrijving-1', 'Omschrijving-2', 'Omschrijving-3'],
      dateFormat: 'YYYY-MM-DD',
    },
  },
  {
    bank: 'ABN AMRO',
    match: ['accountNumber', 'transactiondate', 'amount', 'description'],
    mapping: { date: 'transactiondate', amount: 'amount', ownIban: 'accountNumber', description: ['description'], dateFormat: 'YYYYMMDD' },
  },
  {
    bank: 'bunq',
    match: ['Date', 'Amount', 'Account', 'Counterparty', 'Name', 'Description'],
    mapping: { date: 'Date', amount: 'Amount', ownIban: 'Account', counterIban: 'Counterparty', counterName: 'Name', description: ['Description'], dateFormat: 'YYYY-MM-DD' },
  },
  {
    bank: 'Knab',
    match: ['Rekeningnummer', 'Transactiedatum', 'Valutacode', 'CreditDebet', 'Bedrag', 'Tegenrekeningnummer', 'Tegenrekeninghouder', 'Omschrijving'],
    mapping: {
      date: 'Transactiedatum',
      amount: 'Bedrag',
      debitCredit: 'CreditDebet',
      counterIban: 'Tegenrekeningnummer',
      counterName: 'Tegenrekeninghouder',
      ownIban: 'Rekeningnummer',
      reference: 'Betalingskenmerk',
      description: ['Omschrijving'],
      dateFormat: 'DD-MM-YYYY',
    },
  },
  {
    bank: 'Triodos',
    match: ['Datum', 'Rekeningnummer', 'Bedrag', 'Debet/Credit', 'Naam tegenrekening', 'Tegenrekening', 'Omschrijving'],
    mapping: {
      date: 'Datum',
      amount: 'Bedrag',
      debitCredit: 'Debet/Credit',
      counterName: 'Naam tegenrekening',
      counterIban: 'Tegenrekening',
      ownIban: 'Rekeningnummer',
      description: ['Omschrijving'],
      dateFormat: 'DD-MM-YYYY',
    },
  },
];

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function headerSignature(headers: string[]): string {
  return headers.map((h) => h.trim().toLowerCase()).join('|');
}

export function previewCsv(text: string, maxRows = 10): CsvPreview {
  const parsed = Papa.parse<Record<string, string>>(stripBom(text), { header: true, skipEmptyLines: 'greedy', transformHeader: (h) => h.trim() });
  const headers = (parsed.meta.fields ?? []).filter(Boolean);
  const known = KNOWN_FORMATS.find((f) => f.match.every((m) => headers.includes(m)));
  return {
    headers,
    rows: parsed.data.slice(0, maxRows),
    delimiter: parsed.meta.delimiter,
    suggestedMapping: known?.mapping ?? guessMapping(headers, parsed.data.slice(0, 20)),
    detectedBank: known?.bank ?? null,
  };
}

function guessMapping(headers: string[], rows: Record<string, string>[]): CsvMapping | null {
  const find = (...patterns: RegExp[]) => headers.find((h) => patterns.some((p) => p.test(h)));
  const date = find(/^(transactie)?datum$/i, /date/i, /datum/i);
  const amount = find(/^bedrag/i, /amount/i);
  if (!date || !amount) return null;
  const sample = rows.map((r) => r[date] ?? '').find(Boolean) ?? '';
  return {
    date,
    amount,
    debitCredit: find(/af.?bij/i, /debet.?credit/i, /credit.?debet/i, /^d\/?c$/i),
    counterName: find(/naam/i, /name/i, /tegenpartij/i),
    counterIban: find(/tegenrekening/i, /counterparty/i, /iban.*tegen/i),
    reference: find(/kenmerk/i, /reference/i),
    description: headers.filter((h) => /omschrijving|description|mededeling/i.test(h)),
    dateFormat: detectDateFormat(sample) ?? 'YYYY-MM-DD',
  };
}

export function detectDateFormat(sample: string): string | null {
  const s = sample.trim();
  if (/^\d{8}$/.test(s)) return 'YYYYMMDD';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return 'YYYY-MM-DD';
  if (/^\d{2}-\d{2}-\d{4}$/.test(s)) return 'DD-MM-YYYY';
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return 'DD/MM/YYYY';
  if (/^\d{1,2}-\d{1,2}-\d{4}$/.test(s)) return 'D-M-YYYY';
  return null;
}

export function parseDate(value: string, format: string): string {
  const v = value.trim();
  let y: string | undefined, m: string | undefined, d: string | undefined;
  switch (format) {
    case 'YYYYMMDD':
      [y, m, d] = [v.slice(0, 4), v.slice(4, 6), v.slice(6, 8)];
      break;
    case 'YYYY-MM-DD':
      [y, m, d] = v.slice(0, 10).split('-');
      break;
    case 'DD-MM-YYYY':
    case 'D-M-YYYY':
      [d, m, y] = v.split('-');
      break;
    case 'DD/MM/YYYY':
      [d, m, y] = v.split('/');
      break;
    default:
      throw new Error(`Onbekend datumformaat: ${format}`);
  }
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  if (!isIsoDate(iso)) throw new Error(`Ongeldige datum "${value}" (verwacht ${format})`);
  return iso;
}

function isDebitMarker(value: string): boolean {
  return /^(af|d|debet|debit|dbit)$/i.test(value.trim());
}

export function parseCsv(text: string, mapping: CsvMapping): ParseResult {
  const parsed = Papa.parse<Record<string, string>>(stripBom(text), { header: true, skipEmptyLines: 'greedy', transformHeader: (h) => h.trim() });
  const transactions: NormalizedTransaction[] = [];
  const warnings: string[] = [];
  parsed.data.forEach((row, i) => {
    try {
      const get = (col?: string) => (col ? (row[col] ?? '').trim() : '');
      let amount: number;
      if (mapping.amountDebit || mapping.amountCredit) {
        const debit = get(mapping.amountDebit);
        const credit = get(mapping.amountCredit);
        amount = (credit ? parseEuro(credit) : 0) - (debit ? Math.abs(parseEuro(debit)) : 0);
      } else {
        amount = parseEuro(get(mapping.amount));
        if (mapping.debitCredit && isDebitMarker(get(mapping.debitCredit))) amount = -Math.abs(amount);
        else if (mapping.debitCredit) amount = Math.abs(amount);
      }
      const description = (mapping.description ?? []).map(get).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      const counterIban = get(mapping.counterIban);
      transactions.push({
        date: parseDate(get(mapping.date), mapping.dateFormat),
        amount,
        counterName: get(mapping.counterName) || null,
        counterIban: counterIban ? normalizeIban(counterIban) : null,
        description: description || get(mapping.counterName),
        reference: get(mapping.reference) || null,
        ownIban: get(mapping.ownIban) ? normalizeIban(get(mapping.ownIban)) : null,
      });
    } catch (e) {
      warnings.push(`Regel ${i + 2}: ${(e as Error).message}`);
    }
  });
  return { source: 'csv', transactions, warnings };
}
