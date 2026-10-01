import { createHash } from 'node:crypto';
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
  /** kosten in een eigen kolom (bv. Revolut): een aparte regel, zodat ze als bankkosten te boeken zijn */
  fee?: string;
  /** alleen regels met een van deze waarden (bv. Revolut: State = COMPLETED); de rest is niet (of nog niet) afgeschreven */
  keep?: { column: string; values: string[] };
  /** saldo na de regel: het laatste wordt het eindsaldo, om te controleren of er een afschrift ontbreekt */
  balance?: string;
  /** valuta per regel: alleen euro's */
  currency?: string;
  /** naam van de bank, voor een bestand zonder eigen IBAN: dan komt het op de rekening met die naam */
  bank?: string;
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
    // Revolut (privé-export): geen IBAN in het bestand, kosten apart, ook teruggedraaide betalingen
    bank: 'Revolut',
    match: ['Type', 'Product', 'Started Date', 'Completed Date', 'Description', 'Amount', 'Fee', 'Currency', 'State', 'Balance'],
    mapping: {
      date: 'Completed Date',
      amount: 'Amount',
      fee: 'Fee',
      counterName: 'Description',
      description: ['Description'],
      keep: { column: 'State', values: ['COMPLETED'] },
      balance: 'Balance',
      currency: 'Currency',
      bank: 'Revolut',
      dateFormat: 'YYYY-MM-DD',
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
  const skipped = new Map<string, number>();
  let otherCurrency = 0;
  // het saldo na de laatste regel (op datum en tijd): het eindsaldo van het afschrift
  let closing: { at: string; date: string; amount: number } | null = null;
  parsed.data.forEach((row, i) => {
    try {
      const get = (col?: string) => (col ? (row[col] ?? '').trim() : '');
      if (mapping.keep && !mapping.keep.values.includes(get(mapping.keep.column))) {
        const value = get(mapping.keep.column) || 'leeg';
        skipped.set(value, (skipped.get(value) ?? 0) + 1);
        return;
      }
      if (mapping.currency && get(mapping.currency) && get(mapping.currency).toUpperCase() !== 'EUR') {
        otherCurrency++;
        return;
      }
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
      const date = parseDate(get(mapping.date), mapping.dateFormat);
      const ownIban = get(mapping.ownIban) ? normalizeIban(get(mapping.ownIban)) : null;
      transactions.push({
        date,
        amount,
        counterName: get(mapping.counterName) || null,
        counterIban: counterIban ? normalizeIban(counterIban) : null,
        description: description || get(mapping.counterName),
        reference: get(mapping.reference) || null,
        ownIban,
      });
      // kosten gaan van het saldo af (saldo = vorige + bedrag − kosten)
      const fee = get(mapping.fee) ? parseEuro(get(mapping.fee)) : 0;
      if (fee !== 0) {
        transactions.push({ date, amount: -fee, counterName: mapping.bank ?? null, counterIban: null, description: `Kosten: ${description || get(mapping.counterName)}`, reference: null, ownIban });
      }
      if (mapping.balance && get(mapping.balance)) {
        const at = get(mapping.date);
        if (!closing || at >= closing.at) closing = { at, date, amount: parseEuro(get(mapping.balance)) };
      }
    } catch (e) {
      warnings.push(`Regel ${i + 2}: ${(e as Error).message}`);
    }
  });
  if (otherCurrency > 0) warnings.push(`${otherCurrency} ${otherCurrency === 1 ? 'regel' : 'regels'} in een andere valuta overgeslagen: de app boekt alleen euro's`);
  const pending = [...skipped].filter(([v]) => /pending|behandeling/i.test(v)).reduce((n, [, c]) => n + c, 0);
  if (pending > 0) warnings.push(`${pending} ${pending === 1 ? 'betaling is' : 'betalingen zijn'} nog in behandeling: die komen mee met een volgende export`);
  const last = closing as { date: string; amount: number } | null;
  return {
    source: 'csv',
    transactions,
    warnings,
    ...(last ? { balances: [{ ownIban: transactions[0]?.ownIban ?? null, date: last.date, amount: last.amount }] } : {}),
    ...(mapping.bank ? { bank: mapping.bank } : {}),
    // dezelfde kolommen met dezelfde toewijzing lezen dezelfde betaling altijd hetzelfde
    layout: createHash('sha256').update(`${headerSignature((parsed.meta.fields ?? []).filter(Boolean))}\n${JSON.stringify(Object.entries(mapping).sort(([a], [b]) => a.localeCompare(b)))}`).digest('hex').slice(0, 16),
  };
}
