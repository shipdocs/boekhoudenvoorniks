import Papa from 'papaparse';
import { parseEuro, type Cents } from '../shared/money';
import { addDays, isIsoDate, type IsoDate } from '../shared/dates';
import { detectDateFormat, parseDate } from './csv';
import type { Workbook } from './xlsx';
import { XafError, type XafFile } from './xaf';

/**
 * Overzichten uit een vorig programma of uit Excel, zonder vaste vorm: een saldibalans (saldo per
 * rekening) en een lijst met openstaande posten (facturen die nog betaald moesten worden). Als CSV of
 * als Excel. De app zoekt zelf de kopregel en raadt welke kolom wat is; alleen wat hij echt niet vindt,
 * vraagt hij (maximaal drie vragen).
 */

export interface Table {
  sheet: string;
  /** regels boven de kop (titel, bedrijfsnaam, "per 31-12-2025") */
  title: string[];
  headers: string[];
  rows: string[][];
}

export type TableKind = 'saldibalans' | 'openstaande-posten';

/** Per veld het kolomnummer (0-based). */
export type ColumnMapping = Record<string, number>;

export interface ColumnQuestion {
  field: string;
  question: string;
  /** voorgestelde kolom, of null */
  suggested: number | null;
}

/** Per veld: kolomnamen in volgorde van voorkeur, en wat het zeker niet is. */
const FIELDS: Record<TableKind, { field: string; question: string; required: boolean; match: RegExp[]; exclude?: RegExp }[]> = {
  'openstaande-posten': [
    { field: 'number', question: 'In welke kolom staat het factuurnummer?', required: true, match: [/factuurn(umme)?r|factuur ?nr/i, /^factuur$/i, /invoice (no|number)|^nummer$|^nr\.?$/i, /referentie|kenmerk|boekstuk/i], exclude: /datum|date|verval|bedrag/i },
    { field: 'relation', question: 'In welke kolom staat de naam van de klant of leverancier?', required: true, match: [/(klant|debiteur|leverancier|crediteur|relatie)s?naam/i, /^naam$|^name$/i, /klant|debiteur|leverancier|crediteur|relatie|bedrijf|customer|supplier/i], exclude: /nummer|nr|code|id$/i },
    { field: 'amount', question: 'In welke kolom staat het bedrag dat nog open staat?', required: true, match: [/openstaand|^open$|restant|nog te/i, /te ontvangen|te betalen|saldo/i, /bedrag|totaal|amount/i], exclude: /datum|date/i },
    { field: 'dueDate', question: '', required: false, match: [/verval|due|uiterlijk|betalen voor/i] },
    { field: 'date', question: '', required: false, match: [/factuurdatum|invoice date/i, /^datum$|^date$|boekdatum/i] },
    { field: 'type', question: '', required: false, match: [/^(soort|type|d\/c)$/i] },
  ],
  saldibalans: [
    { field: 'account', question: 'In welke kolom staat het rekeningnummer?', required: true, match: [/rekening(nummer|nr)?$|grootboek(rekening|nummer)?$/i, /^nr\.?$|^nummer$|^code$|account/i, /rekening|grootboek/i], exclude: /omschrijving|naam|saldo/i },
    { field: 'name', question: '', required: false, match: [/omschrijving|description/i, /naam|^name$/i] },
    { field: 'balance', question: 'In welke kolom staat het saldo?', required: false, match: [/eindsaldo|^saldo$/i, /saldo|balans|balance/i] },
    { field: 'debit', question: '', required: false, match: [/^debet$|^debit$/i] },
    { field: 'credit', question: '', required: false, match: [/^credit$/i] },
    { field: 'type', question: '', required: false, match: [/^(soort|type|balans\/w&v|b\/p)$/i] },
  ],
};

// ---------- lezen ----------

const cell = (v: unknown) => String(v ?? '').trim();

/**
 * De kopregel: de eerste rij met kolomnamen die de app herkent; anders de eerste rij met minstens
 * twee tekstcellen. Titelregels erboven (bedrijfsnaam, periode) worden overgeslagen.
 */
function toTable(sheet: string, raw: string[][]): Table | null {
  const candidates: number[] = [];
  for (let r = 0; r < Math.min(raw.length, 25); r++) {
    const texts = (raw[r] ?? []).map(cell).filter((c) => c && !/^-?[\d.,]+$/.test(c));
    if (texts.length >= 2) candidates.push(r);
  }
  const make = (r: number): Table => {
    const row = (raw[r] ?? []).map(cell);
    const width = row.length;
    const rows = raw.slice(r + 1).map((x) => Array.from({ length: width }, (_, i) => cell(x?.[i]))).filter((x) => x.some(Boolean));
    return { sheet, title: raw.slice(0, r).flat().map(cell).filter(Boolean), headers: row, rows };
  };
  const tables = candidates.map(make);
  return tables.find((t) => detectKind(t) !== null) ?? tables[0] ?? null;
}

export function tablesFromCsv(text: string): Table[] {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const parsed = Papa.parse<string[]>(clean, { skipEmptyLines: 'greedy' });
  const t = toTable('CSV', parsed.data);
  return t ? [t] : [];
}

export function tablesFromWorkbook(wb: Workbook): Table[] {
  return wb.sheets.map((s) => toTable(s.name, s.rows)).filter((t): t is Table => t !== null);
}

// ---------- herkennen ----------

export function detectKind(t: Table): TableKind | null {
  const h = t.headers.join(' | ');
  const openAmount = /openstaand|open|saldo|bedrag|totaal|amount|te ontvangen|te betalen|restant/i;
  if (/factuur|invoice|faktuur/i.test(h) && openAmount.test(h)) return 'openstaande-posten';
  // zonder het woord "factuur": een relatie, een kenmerk en een openstaand bedrag
  if (/klant|debiteur|leverancier|crediteur|relatie|customer|supplier/i.test(h) && /referentie|kenmerk|boekstuk|^nummer$|^nr\.?$/im.test(t.headers.join('\n')) && openAmount.test(h)) return 'openstaande-posten';
  if (/saldo|debet|debit|credit|balans/i.test(h) && /rekening|grootboek|nr|nummer|code|account/i.test(h)) return 'saldibalans';
  return null;
}

/** Kolommen raden; wat ontbreekt, wordt een vraag. */
export function suggestColumns(kind: TableKind, t: Table): { mapping: ColumnMapping; questions: ColumnQuestion[] } {
  const mapping: ColumnMapping = {};
  const used = new Set<number>();
  for (const f of FIELDS[kind]) {
    // eerst de beste naam ("Factuurnummer"), dan iets wat erop lijkt
    for (const re of f.match) {
      const idx = t.headers.findIndex((h, i) => !used.has(i) && re.test(h) && !f.exclude?.test(h));
      if (idx >= 0) {
        mapping[f.field] = idx;
        used.add(idx);
        break;
      }
    }
  }
  const questions: ColumnQuestion[] = [];
  for (const f of FIELDS[kind]) {
    if (f.required && mapping[f.field] === undefined) questions.push({ field: f.field, question: f.question, suggested: null });
  }
  if (kind === 'saldibalans' && mapping.balance === undefined && (mapping.debit === undefined || mapping.credit === undefined)) {
    questions.push({ field: 'balance', question: 'In welke kolom staat het saldo?', suggested: null });
  }
  return { mapping, questions: questions.slice(0, 3) };
}

// ---------- waarden ----------

/** Bedrag uit een cel; leeg is 0, onleesbaar is null. */
function amount(v: string): Cents | null {
  if (!v.trim()) return 0;
  try {
    return parseEuro(v);
  } catch {
    return null;
  }
}

/** Datum uit een cel: 31-12-2025, 2025-12-31, 31/12/2025 of een Excel-datumgetal. */
export function cellDate(v: string): IsoDate | null {
  const s = v.trim();
  if (!s) return null;
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const n = Math.floor(Number(s));
    if (n > 20000 && n < 80000) return addDays('1899-12-30', n);
  }
  const fmt = detectDateFormat(s.slice(0, 10));
  if (!fmt) return null;
  try {
    return parseDate(s.slice(0, 10), fmt);
  } catch {
    return null;
  }
}

/** "per 31-12-2025" of "t/m 31-12-2025" in de titel: de laatste datum die er staat. */
export function titleDate(t: Table): IsoDate | null {
  const dates = t.title.flatMap((x) => [...x.matchAll(/(\d{1,2})[-/](\d{1,2})[-/](\d{4})/g)].map((m) => `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`)).filter(isIsoDate);
  return dates.at(-1) ?? null;
}

// ---------- saldibalans → dezelfde vorm als een auditfile ----------

export function saldibalansToXaf(t: Table, m: ColumnMapping, asOf: IsoDate): XafFile {
  const accounts: XafFile['accounts'] = [];
  const openingLines: XafFile['opening']['lines'] = [];
  const lines: XafFile['lines'] = [];
  const start = addDays(asOf, 1);
  for (const row of t.rows) {
    let id = row[m.account!] ?? '';
    let name = m.name !== undefined ? row[m.name] ?? '' : '';
    // "1002 Bank Knab" in één kolom
    const both = /^(\d{3,8})\s+(.+)$/.exec(id);
    if (both) [id, name] = [both[1]!, name || both[2]!];
    if (!/^\d{2,8}$/.test(id)) continue; // kopjes en totalen
    const read = (col: number) => {
      const v = amount(row[col] ?? '');
      if (v === null) throw new XafError(`Het saldo van rekening ${id} ("${row[col]}") kan de app niet lezen`);
      return v;
    };
    const value = m.balance !== undefined ? read(m.balance) : read(m.debit!) - Math.abs(read(m.credit!));
    const typeCell = m.type !== undefined ? (row[m.type] ?? '').toLowerCase() : '';
    const pl = typeCell ? /^(p|w|wv|w&v|winst|resultaat|verlies)/.test(typeCell) : /^[478]\d{2,}/.test(id) || (/^9\d{2,}/.test(id) && !/balans/i.test(name));
    accounts.push({ id, name: name.trim() || `Rekening ${id}`, type: pl ? 'P' : 'B', rgs: null });
    if (value === 0) continue;
    // balansrekeningen als beginbalans op de dag erna; winst-en-verlies als totaal op de datum zelf
    if (pl) lines.push({ journalId: 'saldi', journalType: 'G', journalIban: null, transactionNr: id, date: asOf, accountId: id, amount: value, relationId: null, invoiceRef: null, docRef: null, description: 'Saldo', vat: null });
    else openingLines.push({ accountId: id, amount: value });
  }
  if (accounts.length === 0) throw new XafError('In deze saldibalans staan geen rekeningen met een nummer');
  return {
    version: 'saldibalans',
    software: `Saldibalans (${t.sheet})`,
    fiscalYear: start.slice(0, 4),
    startDate: start,
    endDate: asOf,
    company: { name: t.title[0] ?? '', kvk: null, vatNumber: null },
    accounts,
    relations: [],
    opening: { date: start, lines: openingLines, items: [] },
    lines,
    warnings: [],
    totalsOnly: true,
  };
}

// ---------- openstaande posten ----------

export interface OpenItemRow {
  kind: 'klant' | 'leverancier';
  relationName: string;
  number: string;
  invoiceDate: IsoDate | null;
  dueDate: IsoDate | null;
  /** positief = nog te ontvangen (klant) of nog te betalen (leverancier) */
  amount: Cents;
}

/**
 * Regels van de lijst. Klant of leverancier: uit een kolom "soort", de kolomnaam of de titel/het
 * tabblad. Regels met een bedrag dat de app niet kan lezen, staan apart (om te melden).
 */
export function openItemRows(t: Table, m: ColumnMapping): { rows: OpenItemRow[]; unreadable: string[] } {
  const context = `${t.sheet} ${t.title.join(' ')} ${m.relation !== undefined ? t.headers[m.relation] : ''}`.toLowerCase();
  const defaultKind = /leverancier|crediteur|supplier|inkoop|te betalen/.test(context) ? 'leverancier' : 'klant';
  const out: OpenItemRow[] = [];
  const unreadable: string[] = [];
  for (const row of t.rows) {
    const name = (row[m.relation!] ?? '').trim();
    const number = (row[m.number!] ?? '').trim();
    const value = amount(row[m.amount!] ?? '');
    if (!name && !number) continue;
    if (/^(totaal|total|subtotaal)/i.test(name) || /^(totaal|total)/i.test(number)) continue;
    if (value === null) {
      unreadable.push(`${[name, number].filter(Boolean).join(' ')}: "${row[m.amount!]}"`);
      continue;
    }
    if (value === 0) continue;
    const typeCell = m.type !== undefined ? (row[m.type] ?? '').toLowerCase() : '';
    const kind = typeCell ? (/lev|cred|inkoop|^c$|^s$|supplier/.test(typeCell) ? 'leverancier' : 'klant') : defaultKind;
    out.push({
      kind,
      relationName: name || (kind === 'klant' ? 'Onbekende klant' : 'Onbekende leverancier'),
      number,
      invoiceDate: m.date !== undefined ? cellDate(row[m.date] ?? '') : null,
      dueDate: m.dueDate !== undefined ? cellDate(row[m.dueDate] ?? '') : null,
      amount: value,
    });
  }
  return { rows: out, unreadable };
}

/** Voorbeeldbestand om in te vullen (Excel opent CSV met puntkomma's goed). */
export const OPEN_ITEMS_TEMPLATE =
  'Naam;Soort;Factuurnummer;Datum;Vervaldatum;Bedrag\r\n' +
  'Bakker Bouw;klant;2025-042;15-12-2025;29-12-2025;1210,00\r\n' +
  'Gamma;leverancier;F-7781;20-12-2025;03-01-2026;363,00\r\n';
