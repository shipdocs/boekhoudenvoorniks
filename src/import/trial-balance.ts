import { roundHalfAwayFromZero, type Cents } from '../shared/money';
import { today, type IsoDate } from '../shared/dates';
import type { Workbook } from './xlsx';
import { XafError, type XafFile } from './xaf';

/**
 * Een kolommenbalans (proef- en saldibalans) uit een spreadsheet, zoals DigiBoox die als Excel geeft:
 * per rekening "nummer naam" met de kolommen Beginbalans, Mutaties, winst-en-verlies en Eindbalans
 * (elk debet en credit). Dat zetten we om naar dezelfde vorm als een auditfile, zodat de overstap-hulp
 * er hetzelfde mee werkt. Er staan alleen totalen in, geen losse boekingen: instappen kan dus op de
 * begindatum (beginbalans) of na de datum van de export (eindbalans, met omzet en kosten tot dan).
 */

const num = (s: string | undefined): Cents => {
  const v = (s ?? '').trim();
  if (!v) return 0;
  const n = Number(v.includes(',') && !v.includes('.') ? v.replace(',', '.') : v.replace(/,/g, ''));
  return Number.isFinite(n) ? roundHalfAwayFromZero(n * 100) : 0;
};

/** "01-01-2026" → "2026-01-01" */
function nlDate(s: string): IsoDate | null {
  const m = /(\d{1,2})-(\d{1,2})-(\d{4})/.exec(s);
  return m ? `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}` : null;
}

interface Pair {
  label: string;
  debit: number;
  credit: number;
}

/** Zoekt de kopregels: een rij met Debet/Credit-paren, en daarboven de namen van de groepen. */
function findLayout(rows: string[][]): { headerRow: number; nameCol: number; pairs: Pair[] } | null {
  for (let r = 0; r < Math.min(rows.length, 20); r++) {
    const row = rows[r] ?? [];
    const pairs: Pair[] = [];
    for (let c = 0; c < row.length - 1; c++) {
      if (/^debet$/i.test(row[c] ?? '') && /^credit$/i.test(row[c + 1] ?? '')) {
        // de groepsnaam staat in de rij erboven, boven het debet (of leeg bij de winst-en-verliesrekening)
        pairs.push({ label: (rows[r - 1]?.[c] ?? '').toLowerCase(), debit: c, credit: c + 1 });
        c++;
      }
    }
    if (pairs.length >= 2) {
      const nameCol = row.findIndex((v) => /categorie|rekening|grootboek|omschrijving/i.test(v ?? ''));
      return { headerRow: r, nameCol: nameCol >= 0 ? nameCol : Math.max(0, pairs[0]!.debit - 1), pairs };
    }
  }
  return null;
}

export function isTrialBalance(wb: Workbook): boolean {
  return wb.sheets.some((s) => findLayout(s.rows)?.pairs.some((p) => p.label.includes('begin')));
}

export function parseTrialBalance(wb: Workbook, opts: { asOf?: IsoDate } = {}): XafFile {
  const sheet = wb.sheets.find((s) => findLayout(s.rows)?.pairs.some((p) => p.label.includes('begin')));
  if (!sheet) throw new XafError('In dit Excel-bestand staat geen kolommenbalans (met Beginbalans en Eindbalans). Exporteer de kolommenbalans of een auditfile (.xaf).');
  const layout = findLayout(sheet.rows)!;
  const pair = (re: RegExp) => layout.pairs.find((p) => re.test(p.label));
  const begin = pair(/begin/)!;
  const end = pair(/eind/);
  // winst-en-verlies: het paar zonder naam (of met "winst"/"resultaat")
  const pl = layout.pairs.find((p) => !p.label || /winst|resultaat|verlies/.test(p.label));
  if (!end) throw new XafError('In deze kolommenbalans ontbreekt de eindbalans');

  // kop: bedrijfsnaam en periode ("01-01-2026 - 31-12-2026")
  const head = sheet.rows.slice(0, layout.headerRow).flat().filter(Boolean);
  const period = head.map((h) => /(\d{1,2}-\d{1,2}-\d{4})\s*-\s*(\d{1,2}-\d{1,2}-\d{4})/.exec(h)).find(Boolean);
  const startDate = (period && nlDate(period[1]!)) ?? `${today().slice(0, 4)}-01-01`;
  const periodEnd = (period && nlDate(period[2]!)) ?? today();
  // de eindbalans is zo ver als de administratie bijgewerkt was: de dag van de export (of het einde van de periode)
  const exported = wb.created?.slice(0, 10) ?? null;
  const asOf = opts.asOf ?? [exported, periodEnd, today()].filter((d): d is string => !!d).sort()[0]!;

  const accounts: XafFile['accounts'] = [];
  const openingLines: XafFile['opening']['lines'] = [];
  const lines: XafFile['lines'] = [];
  for (const row of sheet.rows.slice(layout.headerRow + 1)) {
    const label = (row[layout.nameCol] ?? '').trim();
    const m = /^(\d{3,8})\s+(.+)$/.exec(label);
    if (!m) continue;
    const [, id, name] = m as unknown as [string, string, string];
    const beginAmount = num(row[begin.debit]) - num(row[begin.credit]);
    const endAmount = num(row[end.debit]) - num(row[end.credit]);
    const plAmount = pl ? num(row[pl.debit]) - num(row[pl.credit]) : 0;
    const balanceMoves = layout.pairs.filter((p) => p !== begin && p !== end && p !== pl).some((p) => num(row[p.debit]) !== 0 || num(row[p.credit]) !== 0);
    const isPl = plAmount !== 0 && beginAmount === 0 && !balanceMoves;
    accounts.push({ id, name: name.trim(), type: isPl ? 'P' : 'B', rgs: null });
    if (beginAmount !== 0 && !isPl) openingLines.push({ accountId: id, amount: beginAmount });
    // alle mutaties samen als één regel op de exportdatum
    const move = isPl ? plAmount : endAmount - beginAmount;
    if (move !== 0) {
      lines.push({ journalId: 'totaal', journalType: 'G', journalIban: null, transactionNr: id, date: asOf, accountId: id, amount: move, relationId: null, invoiceRef: null, docRef: null, description: 'Mutaties (totaal)', vat: null });
    }
  }
  if (accounts.length === 0) throw new XafError('In deze kolommenbalans staan geen rekeningen met een nummer');
  const company = String(sheet.rows.find((r) => r?.some(Boolean))?.find(Boolean) ?? '');
  return {
    version: 'kolommenbalans',
    software: `Kolommenbalans (${sheet.name})`,
    fiscalYear: startDate.slice(0, 4),
    startDate,
    endDate: asOf,
    company: { name: company, kvk: null, vatNumber: null },
    accounts,
    relations: [],
    opening: { date: startDate, lines: openingLines, items: [] },
    lines,
    warnings: [],
    totalsOnly: true,
  };
}
