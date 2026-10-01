import type { Db } from '../db/database';
import { rgsLabel, RGS_VERSION, type Ledger } from '../core-ledger/ledger';
import { ACCOUNTS } from '../core-ledger/accounts';
import type { AccountantExport } from './accountant';
import type { InvoiceService } from '../documents/invoices';
import type { PdfRenderer } from '../documents/sending';
import type { SettingsService } from '../settings/settings';
import type { VatService } from '../btw/btw';
import { escapeHtml } from '../documents/render';
import { centsToDecimalString, type Cents } from '../shared/money';
import { formatDateNl, periodFor, today, type IsoDate } from '../shared/dates';
import { createZip, type ZipEntry } from '../shared/zip';
import { createXlsx } from '../shared/xlsx';
import { OPENING_ON_FROM } from '../reports/opening-balance';

/**
 * "Pakket voor mijn boekhouder": één ZIP per boekjaar met alles wat een boekhouder in zijn eigen
 * werkwijze nodig heeft. De ondernemer boekt hier; de boekhouder leest het in zijn eigen pakket in.
 *
 *  - auditfile (XAF 3.2) voor samenstellen/controle (Caseware, AFAS, Visionplanner, …)
 *  - kolommenbalans, grootboekkaarten, journaalposten en openstaande posten als CSV (Excel, NL)
 *  - RGS-brugstaat: welke eigen rekening bij welke officiële RGS-code hoort
 *  - relaties en btw-overzicht, voor een overstap of de aansluiting met de aangiftes
 *  - facturen en bonnen als losse bestanden, met een index naar het boekstuk
 *  - lees-mij (PDF en tekst): periode, aansluiting, controles en hoe je het inleest
 *
 * Alle bedragen komen uit dezelfde selectie als de auditfile (beginbalans op dag één apart, daarna
 * de mutaties), zodat beginbalans + mutaties = eindsaldo in elk bestand gelijk uitkomt.
 *
 * Dit is een overdracht, geen back-up: instellingen, koppelingen en sjablonen gaan niet mee.
 */

export const XAF_VERSION = '3.2';
export const FEEDBACK_URL = 'info@shipdocs.app';

/** SnelStart: nummer van het memoriaaldagboek; staat per administratie anders, zie importprofielen/LEES-MIJ.txt */
const SNELSTART_MEMORIAAL = 90;

const IMPORT_README = (year: number) => `IMPORTPROFIELEN — bestanden in het formaat dat het pakket zelf voorschrijft
==========================================================================

Deze bestanden volgen de importdocumentatie van elk pakket, zodat je geen kolommen hoeft te koppelen.
Ze zijn nog niet in elk pakket proefgedraaid: controleer na het inlezen de saldi met kolommenbalans.csv
en mail afwijkingen naar ${FEEDBACK_URL}

SNELSTART 12 (snelstart/)
  SnelStart leest geen auditfile. Importeer via Bestand > Importeren:
  - klanten.xlsx en leveranciers.xlsx: relatiecode = relatiecode in de auditfile.
  - boekingen.xlsx: alle boekingen van ${year} als memoriaal, plus de beginbalans als één boeking op 1 januari
    (SnelStart kent geen aparte import voor beginbalans of openstaande posten).
    LET OP: kolom FldDagboek staat op ${SNELSTART_MEMORIAAL}. Vervang dit door het nummer van het memoriaaldagboek
    in jouw administratie, en maak de grootboekrekeningen eerst aan (zie rgs-brugstaat.csv).
  - Datums dd-mm-jjjj, bedragen met decimaalkomma, zoals SnelStart vraagt.

YUKI (yuki/)
  Import-wizard > historische gegevens. Makkelijkst is de auditfile (Yuki leest XAF vanaf 3.0).
  Of via CSV (puntkomma, geen kopregel, dd-mm-jjjj, decimaalkomma):
  - historische-mutaties.csv: grootboekcode; grootboekomschrijving; datum; referentie; bedrag (debet positief,
    credit negatief); omschrijving; relatienaam; relatiecode.
  - openstaande-posten.csv: grootboekcode; grootboekomschrijving; factuurdatum; openstaand bedrag; omschrijving;
    referentie; vervaldatum; relatienaam; relatiecode; rekeningnummer. Debiteuren positief, crediteuren negatief.

AFAS (afas/)
  Financieel project: lees de auditfile in (AFAS leest XAF versie 3). Of importeer saldibalans.csv:
  Grootboekrekening; Cumulatief debet (zonder beginbalans); Cumulatief credit (zonder beginbalans); Saldo (met
  beginbalans). Puntkomma, decimaalkomma, met kopregel. Kies bij de importdefinitie komma als decimaalteken.

TWINFIELD
  Gebruik de auditfile in de conversietool. De beginbalans komt in periode 0. Klanten en leveranciers
  delen hier één nummerreeks; een relatie die klant én leverancier is, krijgt in Twinfield mogelijk een nieuw
  nummer. Openstaande posten staan ook los in openstaande-debiteuren.csv en -crediteuren.csv (en in de werkmap).

EXACT ONLINE
  Exact Online leest geen auditfile. Importeer journaalposten.csv via Import > CSV/Excel > Memoriaalboekingen
  en maak daarbij eenmalig een importdefinitie (kolommen koppelen); relaties.csv op dezelfde manier.

CASEWARE en VISIONPLANNER
  Lees de auditfile in (Caseware: XAF 3.1 of 3.2; Caseware vraagt bij het inlezen
  een RGS-versie: de gebruikte release staat in rgs-brugstaat.csv). Visionplanner adviseert XAF 3.1; lukt 3.2 niet, meld het.
`.replace(/\n/g, '\r\n');

export interface PackageCheck {
  ok: boolean;
  label: string;
  detail?: string;
}

export interface MissingDocument {
  kind: 'inkoop' | 'verkoop' | 'bon';
  date: IsoDate;
  description: string;
  relation: string | null;
  total: Cents;
  entryId: number | null;
  reason: string;
  /** bij een inkoop: de aankoop, zodat de app de bon erbij kan laten zoeken */
  purchaseId?: number;
}

export interface VatPeriodSummary {
  periodKey: string;
  label: string;
  status: 'open' | 'concept' | 'ingediend';
  omzet: Cents;
  btwOverOmzet: Cents;
  voorbelasting: Cents;
  teBetalen: Cents;
}

export interface PackageSummary {
  year: number;
  from: IsoDate;
  to: IsoDate;
  company: { name: string; kvkNumber: string; vatNumber: string };
  softwareVersion: string;
  xafVersion: string;
  rgsVersion: string;
  createdAt: IsoDate;
  counts: { entries: number; lines: number; accounts: number; relations: number; invoices: number; purchases: number; documents: number };
  totals: {
    openingDebit: Cents;
    openingCredit: Cents;
    mutationDebit: Cents;
    mutationCredit: Cents;
    closingDebit: Cents;
    closingCredit: Cents;
    /** winst (positief) of verlies (negatief) over het jaar */
    result: Cents;
  };
  openReceivables: Cents;
  openPayables: Cents;
  vat: VatPeriodSummary[];
  missingRgs: { code: string; name: string }[];
  missingDocuments: MissingDocument[];
  checks: PackageCheck[];
}

export interface PackageResult {
  filename: string;
  zip: Buffer;
  files: string[];
  summary: PackageSummary;
}

interface Row {
  code: string;
  name: string;
  rgsRef: string | null;
  kind: 'balans' | 'resultaat';
  opening: Cents;
  debit: Cents;
  credit: Cents;
  closing: Cents;
}

interface MutationLine {
  lineId: number;
  entryId: number;
  date: IsoDate;
  source: string;
  entryDescription: string;
  lineDescription: string | null;
  status: string;
  reverses: number | null;
  code: string;
  accountName: string;
  rgsRef: string | null;
  debit: Cents;
  credit: Cents;
  vatCode: string | null;
  relationId: number | null;
  relation: string | null;
}

interface OpenItem {
  relationId: number | null;
  relation: string;
  reference: string;
  date: IsoDate | null;
  dueDate: IsoDate | null;
  description: string;
  total: Cents | null;
  open: Cents;
}

interface IndexedDocument {
  path: string;
  kind: 'verkoopfactuur' | 'inkoopfactuur' | 'bon';
  reference: string;
  date: IsoDate;
  relation: string;
  total: Cents | null;
  entryIds: number[];
}

const JOURNAL: Record<string, string> = { factuur: 'Verkoop', inkoop: 'Inkoop', bank: 'Bank', handmatig: 'Memoriaal', btw: 'Btw', opening: 'Beginbalans', integratie: 'Koppeling' };

/** Bedrag zoals Excel in het Nederlands het leest: komma als decimaalteken, geen duizendtallen. */
export const nl = (c: Cents): string => centsToDecimalString(c).replace('.', ',');

/** Bedrag voor mensen (lees-mij, controles): € 19.623,33 */
const euro = (c: Cents): string => `€ ${nl(c).replace(/\B(?=(\d{3})+(?!\d))(?=\d*,)/g, '.')}`;

function csvCell(v: unknown): string {
  const s = String(v ?? '');
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Een bedrag in een tabel: in CSV als 1234,56, in Excel als getal met twee decimalen. */
export interface Money { cents: Cents }
export type Cell = string | number | Money | null | undefined;
export interface Table { header: string[]; rows: Cell[][] }
const money = (c: Cents): Money => ({ cents: c });
const table = (header: string[], rows: Cell[][]): Table => ({ header, rows });

/** CSV met puntkomma en BOM, zodat Excel (NL) de kolommen en accenten goed opent. */
export function toCsv(t: Table): string {
  const cell = (v: Cell) => csvCell(v !== null && typeof v === 'object' ? nl(v.cents) : v);
  return '\uFEFF' + [t.header.map(cell), ...t.rows.map((r) => r.map(cell))].map((r) => r.join(';')).join('\r\n') + '\r\n';
}

function safeName(s: string, max = 70): string {
  const clean = s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim();
  return (clean || 'document').slice(0, max).trim();
}

function extOf(path: string, fallback: string): string {
  const m = /\.([a-z0-9]{1,5})$/i.exec(path);
  return m ? `.${m[1]!.toLowerCase()}` : fallback;
}

export class AccountantPackage {
  constructor(
    private readonly db: Db,
    private readonly ledger: Ledger,
    private readonly exports: AccountantExport,
    private readonly invoices: InvoiceService,
    private readonly vat: VatService,
    private readonly settings: SettingsService,
    private readonly pdf: PdfRenderer,
  ) {}

  private range(year: number): { from: IsoDate; to: IsoDate } {
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new Error('Kies een geldig boekjaar');
    return { from: `${year}-01-01`, to: `${year}-12-31` };
  }

  /** De mutaties zoals ze in de auditfile staan: de beginbalansboeking op dag één telt als beginbalans. */
  private mutations(from: IsoDate, to: IsoDate): MutationLine[] {
    return this.db
      .prepare(
        `SELECT l.id AS lineId, e.id AS entryId, e.entry_date AS date, e.source, e.description AS entryDescription, l.description AS lineDescription,
                e.status, e.reverses_entry_id AS reverses, a.code, a.name AS accountName, a.rgs_ref AS rgsRef, l.debit, l.credit, l.vat_code AS vatCode,
                l.relation_id AS relationId, r.name AS relation
         FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
         JOIN chart_of_accounts a ON a.id = l.account_id LEFT JOIN relations r ON r.id = l.relation_id
         WHERE e.entry_date BETWEEN ? AND ? AND NOT ${OPENING_ON_FROM}
         ORDER BY e.entry_date, e.id, l.id`,
      )
      .all(from, to, from) as MutationLine[];
  }

  /** Kolommenbalans die precies aansluit op de auditfile: beginbalans (resultaat vorige jaren in het eigen vermogen) + mutaties. */
  private rows(from: IsoDate, mutations: MutationLine[]): Row[] {
    const accounts = this.ledger.listAccounts(true);
    const opening = new Map(this.exports.openingBalance(from).map((o) => [o.code, o.amount]));
    const moves = new Map<string, { debit: number; credit: number }>();
    for (const m of mutations) {
      const x = moves.get(m.code) ?? { debit: 0, credit: 0 };
      x.debit += m.debit;
      x.credit += m.credit;
      moves.set(m.code, x);
    }
    return accounts
      .map((a) => {
        const kind: Row['kind'] = a.category === 'omzet' || a.category === 'kosten' ? 'resultaat' : 'balans';
        const o = opening.get(a.code) ?? 0;
        const mv = moves.get(a.code) ?? { debit: 0, credit: 0 };
        return { code: a.code, name: a.name, rgsRef: a.rgs_ref, kind, opening: o, debit: mv.debit, credit: mv.credit, closing: o + mv.debit - mv.credit };
      })
      .filter((r) => r.opening !== 0 || r.debit !== 0 || r.credit !== 0);
  }

  /** Stand van een rekening t/m een datum (alles, ook de beginbalansboeking). */
  private balanceAt(rgsCode: string, to: IsoDate): Cents {
    return (this.db
      .prepare('SELECT COALESCE(SUM(l.debit - l.credit), 0) AS s FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN chart_of_accounts a ON a.id = l.account_id WHERE a.rgs_code = ? AND e.entry_date <= ?')
      .get(rgsCode, to) as { s: number }).s;
  }

  /** Openstaande posten per factuur op een datum, uit het grootboek (debiteuren of crediteuren). */
  private openItems(kind: 'debiteuren' | 'crediteuren', to: IsoDate): OpenItem[] {
    const rgs = kind === 'debiteuren' ? ACCOUNTS.debiteuren : ACCOUNTS.crediteuren;
    const rows = this.db
      .prepare(
        `SELECT l.relation_id AS relationId, r.name AS relation, e.source_ref AS sourceRef, MIN(e.entry_date) AS firstDate, MIN(e.description) AS description, SUM(l.debit - l.credit) AS open
         FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN chart_of_accounts a ON a.id = l.account_id
         LEFT JOIN relations r ON r.id = l.relation_id
         WHERE a.rgs_code = ? AND e.entry_date <= ?
         GROUP BY l.relation_id, COALESCE(e.source_ref, 'post:' || e.id)
         HAVING SUM(l.debit - l.credit) <> 0
         ORDER BY r.name COLLATE NOCASE, MIN(e.entry_date)`,
      )
      .all(rgs, to) as { relationId: number | null; relation: string | null; sourceRef: string | null; firstDate: string; description: string; open: number }[];
    return rows.map((r) => {
      const open = kind === 'debiteuren' ? r.open : -r.open;
      const base = { relationId: r.relationId, relation: r.relation ?? '(zonder relatie)', open };
      if (r.sourceRef?.startsWith('invoice:')) {
        const inv = this.db.prepare('SELECT number, invoice_date, due_date, total, reference FROM invoices WHERE id = ?').get(Number(r.sourceRef.slice(8))) as { number: string | null; invoice_date: string; due_date: string; total: number; reference: string | null } | undefined;
        if (inv) return { ...base, reference: inv.number ?? '', date: inv.invoice_date, dueDate: inv.due_date, description: inv.reference ?? r.description, total: inv.total };
      }
      if (r.sourceRef?.startsWith('purchase:')) {
        const p = this.db.prepare('SELECT supplier_reference, invoice_date, due_date, total, description FROM purchase_invoices WHERE id = ?').get(Number(r.sourceRef.slice(9))) as { supplier_reference: string | null; invoice_date: string; due_date: string | null; total: number; description: string } | undefined;
        if (p) return { ...base, reference: p.supplier_reference ?? `inkoop ${r.sourceRef.slice(9)}`, date: p.invoice_date, dueDate: p.due_date, description: p.description, total: p.total };
      }
      return { ...base, reference: r.sourceRef ?? '', date: r.firstDate, dueDate: null, description: r.description, total: null };
    });
  }

  private vatPeriods(year: number): VatPeriodSummary[] {
    const type = this.settings.get().vatPeriod;
    const starts = type === 'maand' ? Array.from({ length: 12 }, (_, i) => i + 1) : type === 'kwartaal' ? [1, 4, 7, 10] : [1];
    return starts.map((m) => {
      const p = periodFor(`${year}-${String(m).padStart(2, '0')}-01`, type);
      const r = this.vat.calculate(p.key);
      return { periodKey: p.key, label: p.label, status: r.status, omzet: r.summary.omzet, btwOverOmzet: r.summary.btwOverOmzet + r.summary.btwVerlegd + r.summary.btwPrive, voorbelasting: r.summary.voorbelasting, teBetalen: r.summary.teBetalen };
    });
  }

  /** Welke documenten horen bij welke boeking (verkoopfacturen, inkoopfacturen, bonnen bij bankboekingen). */
  private documentSources(from: IsoDate, to: IsoDate) {
    const sales = this.db
      .prepare(
        `SELECT i.id, i.number, i.invoice_date AS date, i.total, i.journal_entry_id AS entryId, r.name AS relation
         FROM invoices i JOIN relations r ON r.id = i.relation_id
         WHERE i.status <> 'concept' AND i.is_opening = 0 AND i.invoice_date BETWEEN ? AND ? ORDER BY i.invoice_date, i.number`,
      )
      .all(from, to) as { id: number; number: string | null; date: string; total: number; entryId: number | null; relation: string }[];
    const purchases = this.db
      .prepare(
        `SELECT p.id, p.supplier_reference AS reference, p.invoice_date AS date, p.total, p.description, p.journal_entry_id AS entryId, r.name AS relation,
                -- alleen het hoofdbewijsstuk (#179); andere bestanden van dezelfde aankoop blijven in de app
                COALESCE((SELECT h.file_path FROM document_links k JOIN documents h ON h.id = k.document_id WHERE k.purchase_invoice_id = p.id AND k.is_primary = 1),
                         p.attachment_path, d.file_path) AS path
         FROM purchase_invoices p LEFT JOIN relations r ON r.id = p.relation_id LEFT JOIN documents d ON d.id = p.document_id
         WHERE p.invoice_date BETWEEN ? AND ? ORDER BY p.invoice_date, p.id`,
      )
      .all(from, to) as { id: number; reference: string | null; date: string; total: number; description: string; entryId: number | null; relation: string | null; path: string | null }[];
    // bonnen die als bewijs aan een bankboeking hangen (zonder aparte inkoopfactuur): het hoofdbewijsstuk
    // van de betaling (#179), en de bon van een teruggedraaide aankoop die nergens meer bij hoort
    const receipts = this.db
      .prepare(
        `SELECT d.id, d.file_path AS path, d.original_name AS name, j.id AS entryId, j.entry_date AS date, j.description
           FROM document_links k JOIN documents d ON d.id = k.document_id
           JOIN bank_transactions b ON b.id = k.bank_transaction_id
           JOIN journal_entries j ON j.id = b.matched_journal_entry_id
          WHERE k.is_primary = 1 AND j.entry_date BETWEEN ? AND ?
         UNION
         SELECT d.id, d.file_path, d.original_name, j.id, j.entry_date, j.description
           FROM documents d JOIN event_evidence ev ON ev.kind = 'document' AND ev.ref_id = d.id
           JOIN journal_entries j ON j.event_id = ev.event_id
          WHERE j.entry_date BETWEEN ? AND ? AND d.purchase_invoice_id IS NULL AND j.reverses_entry_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM document_links k WHERE k.document_id = d.id)
          ORDER BY 5, 4`,
      )
      .all(from, to, from, to) as { id: number; path: string; name: string; entryId: number; date: string; description: string }[];
    return { sales, purchases, receipts };
  }

  /** Samenvatting en controles, zonder bestanden te maken (voor het scherm vóór het downloaden). */
  preview(year: number, softwareVersion = ''): PackageSummary {
    const { from, to } = this.range(year);
    const mutations = this.mutations(from, to);
    const rows = this.rows(from, mutations);
    const docs = this.documentSources(from, to);
    const missing: MissingDocument[] = docs.purchases
      .filter((p) => !p.path)
      .map((p) => ({ kind: 'inkoop' as const, date: p.date, description: p.description, relation: p.relation, total: p.total, entryId: p.entryId, reason: 'geen bon of factuur bewaard', purchaseId: p.id }));
    return this.summarize(year, from, to, rows, mutations, missing, docs.sales.length + docs.purchases.filter((p) => p.path).length + docs.receipts.length, softwareVersion);
  }

  private summarize(year: number, from: IsoDate, to: IsoDate, rows: Row[], mutations: MutationLine[], missingDocuments: MissingDocument[], documents: number, softwareVersion: string): PackageSummary {
    const company = this.settings.get().company;
    const pos = (xs: number[]) => xs.filter((x) => x > 0).reduce((s, x) => s + x, 0);
    const neg = (xs: number[]) => -xs.filter((x) => x < 0).reduce((s, x) => s + x, 0);
    const totals = {
      openingDebit: pos(rows.map((r) => r.opening)),
      openingCredit: neg(rows.map((r) => r.opening)),
      mutationDebit: mutations.reduce((s, m) => s + m.debit, 0),
      mutationCredit: mutations.reduce((s, m) => s + m.credit, 0),
      closingDebit: pos(rows.map((r) => r.closing)),
      closingCredit: neg(rows.map((r) => r.closing)),
      result: -rows.filter((r) => r.kind === 'resultaat').reduce((s, r) => s + r.closing, 0),
    };
    const receivables = this.openItems('debiteuren', to);
    const payables = this.openItems('crediteuren', to);
    const openReceivables = receivables.reduce((s, r) => s + r.open, 0);
    const openPayables = payables.reduce((s, r) => s + r.open, 0);
    const missingRgs = rows.filter((r) => !r.rgsRef || !rgsLabel(r.rgsRef)).map((r) => ({ code: r.code, name: r.name }));
    const entryIds = new Set(mutations.map((m) => m.entryId));
    const unbalanced = [...entryIds].filter((id) => {
      const ls = mutations.filter((m) => m.entryId === id);
      return ls.reduce((s, m) => s + m.debit - m.credit, 0) !== 0;
    });
    const vat = this.vatPeriods(year);
    const vatOpen = vat.filter((v) => v.status !== 'ingediend' && (v.omzet !== 0 || v.voorbelasting !== 0 || v.teBetalen !== 0) && v.periodKey < periodFor(today(), this.settings.get().vatPeriod).key);
    const eur = euro;
    const checks: PackageCheck[] = [
      { ok: totals.openingDebit === totals.openingCredit, label: 'Beginbalans is in evenwicht', detail: `debet ${eur(totals.openingDebit)}, credit ${eur(totals.openingCredit)}` },
      { ok: totals.mutationDebit === totals.mutationCredit && unbalanced.length === 0, label: 'Alle journaalposten zijn in evenwicht', detail: unbalanced.length ? `niet in evenwicht: boekstuk ${unbalanced.slice(0, 10).join(', ')}` : `${entryIds.size} boekingen, debet = credit = ${eur(totals.mutationDebit)}` },
      { ok: totals.closingDebit === totals.closingCredit, label: 'Beginbalans + mutaties = eindbalans', detail: `eindbalans debet ${eur(totals.closingDebit)}, credit ${eur(totals.closingCredit)}` },
      { ok: openReceivables === this.balanceAt(ACCOUNTS.debiteuren, to), label: 'Openstaande debiteuren sluiten aan op het grootboek', detail: `${receivables.length} posten, ${eur(openReceivables)}` },
      { ok: openPayables === -this.balanceAt(ACCOUNTS.crediteuren, to), label: 'Openstaande crediteuren sluiten aan op het grootboek', detail: `${payables.length} posten, ${eur(openPayables)}` },
      { ok: missingRgs.length === 0, label: 'Elke gebruikte rekening heeft een RGS-code', detail: missingRgs.length ? `zonder RGS-code: ${missingRgs.map((m) => `${m.code} ${m.name}`).join(', ')}` : `RGS ${RGS_VERSION}` },
      { ok: missingDocuments.length === 0, label: 'Bij elke inkoop zit een bon of factuur', detail: missingDocuments.length ? `${missingDocuments.length} zonder document; in het pakket staan ze in documenten/index.csv` : undefined },
      { ok: this.balanceAt(ACCOUNTS.vraagposten, to) === 0, label: 'Niets meer bij "weet ik nog niet"', detail: this.balanceAt(ACCOUNTS.vraagposten, to) !== 0 ? `${eur(Math.abs(this.balanceAt(ACCOUNTS.vraagposten, to)))} op vraagposten (rekening 1690): nog in te delen, door jou of je boekhouder` : undefined },
      { ok: vatOpen.length === 0, label: 'Btw-aangiftes van afgelopen periodes zijn ingediend', detail: vatOpen.length ? `nog niet ingediend: ${vatOpen.map((v) => v.label).join(', ')}` : undefined },
    ];
    return {
      year,
      from,
      to,
      company: { name: company.name, kvkNumber: company.kvkNumber, vatNumber: company.vatNumber },
      softwareVersion,
      xafVersion: XAF_VERSION,
      rgsVersion: RGS_VERSION,
      createdAt: today(),
      counts: {
        entries: entryIds.size,
        lines: mutations.length,
        accounts: rows.length,
        relations: (this.db.prepare('SELECT COUNT(*) AS n FROM relations').get() as { n: number }).n,
        invoices: (this.db.prepare(`SELECT COUNT(*) AS n FROM invoices WHERE status <> 'concept' AND is_opening = 0 AND invoice_date BETWEEN ? AND ?`).get(from, to) as { n: number }).n,
        purchases: (this.db.prepare('SELECT COUNT(*) AS n FROM purchase_invoices WHERE invoice_date BETWEEN ? AND ?').get(from, to) as { n: number }).n,
        documents,
      },
      totals,
      openReceivables,
      openPayables,
      vat,
      missingRgs,
      missingDocuments,
      checks,
    };
  }

  /**
   * Bouwt het complete pakket. `readAttachment` leest een bewaarde bijlage (null of een fout als die er niet meer is).
   */
  async build(year: number, opts: { softwareVersion: string; readAttachment: (path: string) => Buffer | null }): Promise<PackageResult> {
    const { from, to } = this.range(year);
    const company = this.settings.get().company;
    const mutations = this.mutations(from, to);
    const rows = this.rows(from, mutations);
    const files: ZipEntry[] = [];
    const add = (path: string, data: Buffer | string) => files.push({ path, data });

    // documenten: eerst verzamelen, zodat de CSV's per boeking naar het bestand kunnen verwijzen
    const src = this.documentSources(from, to);
    const indexed: IndexedDocument[] = [];
    const missing: MissingDocument[] = [];
    const docFiles: ZipEntry[] = [];
    const taken = new Set<string>();
    const unique = (path: string) => {
      let p = path;
      for (let i = 2; taken.has(p); i++) p = path.replace(/(\.[a-z0-9]+)$/i, ` (${i})$1`);
      taken.add(p);
      return p;
    };
    for (const inv of src.sales) {
      try {
        const data = await this.pdf(this.invoices.renderHtml(inv.id));
        const path = unique(`documenten/verkoopfacturen/${safeName(`${inv.number ?? `factuur-${inv.id}`} ${inv.relation}`)}.pdf`);
        docFiles.push({ path, data });
        indexed.push({ path, kind: 'verkoopfactuur', reference: inv.number ?? '', date: inv.date, relation: inv.relation, total: inv.total, entryIds: inv.entryId ? [inv.entryId] : [] });
      } catch (e) {
        missing.push({ kind: 'verkoop', date: inv.date, description: `Factuur ${inv.number ?? inv.id}`, relation: inv.relation, total: inv.total, entryId: inv.entryId, reason: `PDF maken lukte niet (${(e as Error).message})` });
      }
    }
    const byPath = new Map<string, IndexedDocument>();
    const attach = (sourcePath: string, kind: IndexedDocument['kind'], folder: string, label: string, meta: Omit<IndexedDocument, 'path' | 'kind' | 'entryIds'>, entryId: number | null, onMissing: () => void) => {
      const known = byPath.get(sourcePath);
      if (known) {
        if (entryId && !known.entryIds.includes(entryId)) known.entryIds.push(entryId);
        return;
      }
      let data: Buffer | null = null;
      try {
        data = opts.readAttachment(sourcePath);
      } catch {
        data = null;
      }
      if (!data) return onMissing();
      const path = unique(`documenten/${folder}/${safeName(label)}${extOf(sourcePath, '.pdf')}`);
      docFiles.push({ path, data });
      const doc: IndexedDocument = { path, kind, ...meta, entryIds: entryId ? [entryId] : [] };
      byPath.set(sourcePath, doc);
      indexed.push(doc);
    };
    for (const p of src.purchases) {
      const missingDoc = (reason: string) => missing.push({ kind: 'inkoop', date: p.date, description: p.description, relation: p.relation, total: p.total, entryId: p.entryId, reason, purchaseId: p.id });
      if (!p.path) {
        missingDoc('geen bon of factuur bewaard');
        continue;
      }
      attach(p.path, 'inkoopfactuur', 'inkoop', `${p.date} ${p.relation ?? p.description}${p.entryId ? ` (boekstuk ${p.entryId})` : ''}`, { reference: p.reference ?? '', date: p.date, relation: p.relation ?? '', total: p.total }, p.entryId, () => missingDoc('bestand niet meer gevonden'));
    }
    for (const r of src.receipts) {
      attach(r.path, 'bon', 'bonnen', `${r.date} ${r.description} (boekstuk ${r.entryId})`, { reference: r.name, date: r.date, relation: '', total: null }, r.entryId, () =>
        missing.push({ kind: 'bon', date: r.date, description: r.description, relation: null, total: 0, entryId: r.entryId, reason: 'bestand niet meer gevonden' }),
      );
    }
    const docForEntry = new Map<number, string>();
    for (const d of indexed) for (const id of d.entryIds) if (!docForEntry.has(id)) docForEntry.set(id, d.path);

    const summary = this.summarize(year, from, to, rows, mutations, missing, indexed.length, opts.softwareVersion);
    const xafName = `auditfile-${year}-xaf32.xaf`;

    add(xafName, this.exports.auditfile(from, to, company, opts.softwareVersion));
    const tables: [string, string, Table][] = [
      ['kolommenbalans', 'Kolommenbalans', this.trialBalanceTable(rows)],
      ['grootboekkaarten', 'Grootboekkaarten', this.cardsTable(rows, mutations, docForEntry)],
      ['journaalposten', 'Journaalposten', this.journalTable(mutations, docForEntry)],
      ['openstaande-debiteuren', 'Openstaande debiteuren', this.openItemsTable(this.openItems('debiteuren', to))],
      ['openstaande-crediteuren', 'Openstaande crediteuren', this.openItemsTable(this.openItems('crediteuren', to))],
      ['rgs-brugstaat', 'RGS-brugstaat', this.rgsTable(rows)],
      ['btw-overzicht', 'Btw', this.vatTable(summary.vat)],
      ['relaties', 'Relaties', this.relationsTable()],
    ];
    for (const [name, , t] of tables) add(`${name}.csv`, toCsv(t));
    // dezelfde tabellen als één Excel-werkmap, met echte getallen en datums
    add(`rapporten-${year}.xlsx`, createXlsx(tables.map(([, sheet, t]) => ({ name: sheet, ...t }))));
    add('documenten/index.csv', toCsv(this.documentIndexTable(indexed, missing)));
    for (const [path, data] of this.importProfiles(year, from, to, rows, mutations)) add(path, data);
    for (const f of docFiles) files.push(f);

    const fileList = [...files.map((f) => f.path), 'LEES-MIJ.pdf', 'lees-mij.txt'];
    const html = this.readmeHtml(summary, xafName, docFiles.length);
    add('lees-mij.txt', this.readmeText(summary, xafName, docFiles.length));
    try {
      add('LEES-MIJ.pdf', await this.pdf(html));
    } catch {
      // zonder PDF-motor (bv. buiten de app) blijft de tekstversie over
      add('LEES-MIJ.html', html);
      fileList.splice(fileList.indexOf('LEES-MIJ.pdf'), 1, 'LEES-MIJ.html');
    }
    // lees-mij bovenaan in de lijst
    files.sort((a, b) => Number(/lees-mij/i.test(b.path)) - Number(/lees-mij/i.test(a.path)));
    const filename = `overdracht-boekhouder-${safeName(company.name || 'administratie', 40).replace(/\s+/g, '-').toLowerCase()}-${year}.zip`;
    return { filename, zip: createZip(files), files: fileList, summary };
  }

  // ---- de losse bestanden ----

  private trialBalanceTable(rows: Row[]): Table {
    const out = rows.map((r) => {
      const d = r.closing > 0 ? money(r.closing) : '';
      const c = r.closing < 0 ? money(-r.closing) : '';
      return [r.code, r.name, r.rgsRef ?? '', (r.rgsRef && rgsLabel(r.rgsRef)) ?? '', r.kind === 'balans' ? 'Balans' : 'W&V', money(r.opening), money(r.debit), money(r.credit), money(r.closing), r.kind === 'balans' ? d : '', r.kind === 'balans' ? c : '', r.kind === 'resultaat' ? d : '', r.kind === 'resultaat' ? c : ''];
    });
    const sum = (f: (r: Row) => number) => rows.reduce((s, r) => s + f(r), 0);
    const part = (kind: Row['kind'], sign: 1 | -1) => rows.filter((r) => r.kind === kind && r.closing * sign > 0).reduce((s, r) => s + Math.abs(r.closing), 0);
    const result = -rows.filter((r) => r.kind === 'resultaat').reduce((s, r) => s + r.closing, 0);
    out.push(['', 'Totaal', '', '', '', money(sum((r) => r.opening)), money(sum((r) => r.debit)), money(sum((r) => r.credit)), money(sum((r) => r.closing)), money(part('balans', 1)), money(part('balans', -1)), money(part('resultaat', 1)), money(part('resultaat', -1))]);
    out.push(['', result >= 0 ? 'Resultaat (winst)' : 'Resultaat (verlies)', '', '', '', '', '', '', '', result < 0 ? money(-result) : '', result >= 0 ? money(result) : '', result >= 0 ? money(result) : '', result < 0 ? money(-result) : '']);
    return table(['Rekening', 'Omschrijving', 'RGS-code', 'RGS-omschrijving', 'Soort', 'Beginbalans', 'Mutaties debet', 'Mutaties credit', 'Eindsaldo', 'Balans debet', 'Balans credit', 'W&V debet', 'W&V credit'], out);
  }

  private cardsTable(rows: Row[], mutations: MutationLine[], docs: Map<number, string>): Table {
    const out: Cell[][] = [];
    for (const r of rows) {
      let saldo = r.opening;
      out.push([r.code, r.name, r.rgsRef ?? '', '', '', '', 'Beginsaldo', '', '', '', money(saldo), '']);
      for (const m of mutations.filter((x) => x.code === r.code)) {
        saldo += m.debit - m.credit;
        out.push([r.code, r.name, r.rgsRef ?? '', m.date, m.entryId, JOURNAL[m.source] ?? m.source, m.lineDescription ?? m.entryDescription, m.relation ?? '', m.debit ? money(m.debit) : '', m.credit ? money(m.credit) : '', money(saldo), docs.get(m.entryId) ?? '']);
      }
    }
    return table(['Rekening', 'Rekeningnaam', 'RGS-code', 'Datum', 'Boekstuk', 'Dagboek', 'Omschrijving', 'Relatie', 'Debet', 'Credit', 'Saldo', 'Document'], out);
  }

  private journalTable(mutations: MutationLine[], docs: Map<number, string>): Table {
    return table(
      ['Boekstuk', 'Datum', 'Periode', 'Dagboek', 'Omschrijving', 'Rekening', 'Rekeningnaam', 'RGS-code', 'Debet', 'Credit', 'Btw-code', 'Relatiecode', 'Relatie', 'Tegenboeking van', 'Document'],
      mutations.map((m) => [m.entryId, m.date, Number(m.date.slice(5, 7)), JOURNAL[m.source] ?? m.source, m.lineDescription ?? m.entryDescription, m.code, m.accountName, m.rgsRef ?? '', m.debit ? money(m.debit) : '', m.credit ? money(m.credit) : '', m.vatCode ?? '', m.relationId ?? '', m.relation ?? '', m.reverses ?? '', docs.get(m.entryId) ?? '']),
    );
  }

  private openItemsTable(items: OpenItem[]): Table {
    return table(
      ['Relatiecode', 'Relatie', 'Factuurnummer', 'Factuurdatum', 'Vervaldatum', 'Omschrijving', 'Factuurbedrag', 'Openstaand'],
      items.map((i) => [i.relationId ?? '', i.relation, i.reference, i.date ?? '', i.dueDate ?? '', i.description, i.total === null ? '' : money(i.total), money(i.open)]),
    );
  }

  private rgsTable(rows: Row[]): Table {
    const used = new Map(rows.map((r) => [r.code, r]));
    return table(
      ['Rekening', 'Rekeningnaam', 'Categorie', 'Soort', 'RGS-code', 'RGS-omschrijving', 'RGS-versie', 'Gebruikt dit jaar', 'Eindsaldo', 'Status'],
      this.ledger
        .listAccounts(true)
        .filter((a) => !a.archived || used.has(a.code))
        .map((a) => {
          const label = a.rgs_ref ? rgsLabel(a.rgs_ref) : undefined;
          const r = used.get(a.code);
          return [a.code, a.name, a.category, a.category === 'omzet' || a.category === 'kosten' ? 'W&V' : 'Balans', a.rgs_ref ?? '', label ?? '', RGS_VERSION, r ? 'ja' : 'nee', r ? money(r.closing) : '', !a.rgs_ref ? 'ontbreekt' : label ? 'gekoppeld' : 'onbekende code'];
        }),
    );
  }

  private vatTable(vat: VatPeriodSummary[]): Table {
    return table(
      ['Periode', 'Omschrijving', 'Status', 'Omzet', 'Btw verschuldigd', 'Voorbelasting', 'Te betalen (terug: negatief)'],
      vat.map((v) => [v.periodKey, v.label, v.status, money(v.omzet), money(v.btwOverOmzet), money(v.voorbelasting), money(v.teBetalen)]),
    );
  }

  private relationsTable(): Table {
    const rows = this.db.prepare('SELECT * FROM relations ORDER BY id').all() as { id: number; type: string; name: string; contact_name: string | null; email: string | null; phone: string | null; address: string | null; postcode: string | null; city: string | null; country: string; vat_number: string | null; kvk_number: string | null; iban: string | null; payment_term_days: number | null; archived: number }[];
    return table(
      ['Relatiecode', 'Naam', 'Soort', 'Contactpersoon', 'E-mail', 'Telefoon', 'Adres', 'Postcode', 'Plaats', 'Land', 'Btw-nummer', 'KvK-nummer', 'IBAN', 'Betaaltermijn (dagen)', 'Gearchiveerd'],
      rows.map((r) => [r.id, r.name, { klant: 'Klant', leverancier: 'Leverancier', beide: 'Klant en leverancier' }[r.type] ?? r.type, r.contact_name ?? '', r.email ?? '', r.phone ?? '', r.address ?? '', r.postcode ?? '', r.city ?? '', r.country, r.vat_number ?? '', r.kvk_number ?? '', r.iban ?? '', r.payment_term_days ?? '', r.archived ? 'ja' : 'nee']),
    );
  }

  private documentIndexTable(docs: IndexedDocument[], missing: MissingDocument[]): Table {
    const kind = { verkoopfactuur: 'Verkoopfactuur', inkoopfactuur: 'Inkoopfactuur', bon: 'Bon' };
    return table(
      ['Bestand', 'Soort', 'Nummer / referentie', 'Datum', 'Relatie', 'Bedrag incl. btw', 'Boekstuk', 'Opmerking'],
      [
        ...docs.map((d) => [d.path.replace(/^documenten\//, ''), kind[d.kind], d.reference, d.date, d.relation, d.total === null ? '' : money(d.total), d.entryIds.join(' '), '']),
        ...missing.map((m) => ['', { inkoop: 'Inkoopfactuur', verkoop: 'Verkoopfactuur', bon: 'Bon' }[m.kind], '', m.date, m.relation ?? '', m.total ? money(m.total) : '', m.entryId ?? '', `ONTBREEKT: ${m.reason} — ${m.description}`]),
      ],
    );
  }

  // ---- importprofielen: bestanden in precies het formaat dat een pakket zonder kolomkoppeling inleest ----

  /**
   * Per ontvangend pakket, volgens de eigen importdocumentatie van dat pakket (zie docs/boekhouders.md):
   *  - SnelStart 12: Excel met de Fld…-koppen (boekingen, klanten, leveranciers). Leest geen XAF en heeft
   *    geen import voor beginbalans of openstaande posten, dus die gaan mee als memoriaalboeking.
   *  - Yuki: historische mutaties (8 kolommen) en openstaande posten (10 kolommen), puntkomma, dd-mm-jjjj.
   *  - AFAS: saldibalans (rekening; cumulatief debet en credit zonder beginbalans; saldo met beginbalans).
   */
  private importProfiles(year: number, from: IsoDate, to: IsoDate, rows: Row[], mutations: MutationLine[]): [string, Buffer | string][] {
    const dmy = (d: IsoDate) => `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}`;
    const plain = (t: Table) => toCsv(t).replace(/^\uFEFF/, '');
    const noHeader = (t: Table) => plain(t).split('\r\n').slice(1).join('\r\n');
    const relations = this.db.prepare('SELECT * FROM relations ORDER BY id').all() as { id: number; type: string; name: string; contact_name: string | null; email: string | null; address: string | null; postcode: string | null; city: string | null; country: string; iban: string | null; payment_term_days: number | null }[];
    const opening = rows.filter((r) => r.opening !== 0);
    const openingCode = Math.max(0, ...mutations.map((m) => m.entryId)) + 1;
    const out: [string, Buffer | string][] = [];

    // SnelStart
    const ssBoekingen = table(
      ['FldDagboek', 'FldBoekingcode', 'FldDatum', 'FldGrootboeknummer', 'FldDebet', 'FldCredit', 'FldOmschrijving', 'FldBoekstuk'],
      [
        ...opening.map((r): Cell[] => [SNELSTART_MEMORIAAL, openingCode, dmy(from), r.code, money(Math.max(r.opening, 0)), money(Math.max(-r.opening, 0)), `Beginbalans ${year}`, 'BEGINBALANS']),
        ...mutations.map((m): Cell[] => [SNELSTART_MEMORIAAL, m.entryId, dmy(m.date), m.code, money(m.debit), money(m.credit), (m.lineDescription ?? m.entryDescription).slice(0, 60), String(m.entryId)]),
      ],
    );
    const ssRelatie = (types: string[]) =>
      table(
        ['FldRelatiecode', 'FldNaam', 'FldAdres', 'FldPostcode', 'FldPlaats', 'FldLandID', 'FldContactpersoon', 'FldEmail', 'FldIban', 'FldKrediettermijn'],
        relations.filter((r) => types.includes(r.type)).map((r) => [r.id, r.name, r.address ?? '', r.postcode ?? '', r.city ?? '', r.country, r.contact_name ?? '', r.email ?? '', r.iban ?? '', r.payment_term_days ?? '']),
      );
    const ss = (name: string, t: Table) => out.push([`importprofielen/snelstart/${name}.xlsx`, createXlsx([{ name, ...t }])]);
    ss('boekingen', ssBoekingen);
    ss('klanten', ssRelatie(['klant', 'beide']));
    ss('leveranciers', ssRelatie(['leverancier', 'beide']));

    // Yuki
    const yMutations = table(
      ['grootboekcode', 'grootboekomschrijving', 'datum', 'referentie', 'bedrag', 'omschrijving', 'relatienaam', 'relatiecode'],
      mutations.map((m) => [m.code, m.accountName, dmy(m.date), String(m.entryId), money(m.debit - m.credit), m.lineDescription ?? m.entryDescription, m.relation ?? '', m.relationId ?? '']),
    );
    out.push(['importprofielen/yuki/historische-mutaties.csv', noHeader(yMutations)]);
    const openRows = (['debiteuren', 'crediteuren'] as const).flatMap((kind) => {
      const acc = this.ledger.getAccount(kind === 'debiteuren' ? ACCOUNTS.debiteuren : ACCOUNTS.crediteuren);
      return this.openItems(kind, to).map((i): Cell[] => [acc.code, acc.name, i.date ? dmy(i.date) : '', money(kind === 'debiteuren' ? i.open : -i.open), i.description, i.reference || String(i.relationId ?? ''), i.dueDate ? dmy(i.dueDate) : '', i.relation, i.relationId ?? '', '']);
    });
    out.push(['importprofielen/yuki/openstaande-posten.csv', noHeader(table(['grootboekcode', 'grootboekomschrijving', 'factuurdatum', 'openstaand bedrag', 'omschrijving', 'referentie', 'vervaldatum', 'relatienaam', 'relatiecode', 'rekeningnummer'], openRows))]);

    // AFAS
    out.push(['importprofielen/afas/saldibalans.csv', plain(table(['Grootboekrekening', 'Cumulatief debet', 'Cumulatief credit', 'Saldo'], rows.map((r) => [r.code, money(r.debit), money(r.credit), money(r.closing)])))]);

    out.push(['importprofielen/LEES-MIJ.txt', IMPORT_README(year)]);
    return out;
  }

  // ---- lees-mij ----

  private readmeSections(s: PackageSummary, xafName: string, docCount: number) {
    const eur = euro;
    const files: [string, string][] = [
      [xafName, `XML Auditfile Financieel ${XAF_VERSION}: grootboek, relaties, beginbalans en alle journaalposten van ${s.year}. Gecontroleerd tegen het officiële XAF ${XAF_VERSION}-schema.`],
      ['kolommenbalans.csv', 'Per rekening: beginbalans, mutaties debet/credit, eindsaldo, uitgesplitst naar balans en winst-en-verlies, met RGS-code. Bruikbaar als saldibalans.'],
      [`rapporten-${s.year}.xlsx`, 'Dezelfde overzichten als Excel-werkmap: één tabblad per overzicht, bedragen als getal en datums als datum.'],
      ['grootboekkaarten.csv', 'Elke boeking per rekening met beginsaldo en oplopend saldo, en het bijbehorende document.'],
      ['journaalposten.csv', 'Alle boekingsregels van het jaar (zelfde boekstuknummers als in de auditfile).'],
      ['openstaande-debiteuren.csv', `Openstaande verkoopfacturen per ${formatDateNl(s.to)}, per factuur.`],
      ['openstaande-crediteuren.csv', `Openstaande inkoopfacturen per ${formatDateNl(s.to)}, per factuur.`],
      ['rgs-brugstaat.csv', `Koppeling van elke grootboekrekening aan de officiële RGS-code (RGS ${s.rgsVersion}).`],
      ['btw-overzicht.csv', 'Btw per aangifteperiode: omzet, verschuldigd, voorbelasting, te betalen en of de aangifte is ingediend.'],
      ['relaties.csv', 'Klanten en leveranciers met adres, KvK, btw-nummer en IBAN (relatiecode = code in de auditfile).'],
      ['importprofielen/', 'Bestanden in het eigen importformaat van SnelStart, Yuki en AFAS (zonder kolommen koppelen), met uitleg per pakket.'],
      ['documenten/', `${docCount} facturen en bonnen als losse bestanden; documenten/index.csv koppelt elk bestand aan het boekstuk.`],
    ];
    const totals: [string, string, string][] = [
      ['Beginbalans', eur(s.totals.openingDebit), eur(s.totals.openingCredit)],
      ['Mutaties', eur(s.totals.mutationDebit), eur(s.totals.mutationCredit)],
      ['Eindbalans (saldi)', eur(s.totals.closingDebit), eur(s.totals.closingCredit)],
    ];
    const routes: [string, string][] = [
      ['Caseware', `Lees ${xafName} in als XAF ${XAF_VERSION} (Caseware ondersteunt 3.1 en 3.2) en kies de RGS-versie; de release staat in rgs-brugstaat.csv.`],
      ['AFAS (verslaglegging)', `Lees de auditfile in als financieel project, of importeer importprofielen/afas/saldibalans.csv als saldibalans. Controleer daarna de beginbalans: die gaat niet bij elke route vanzelf mee. De kolom Beginbalans in kolommenbalans.csv is de referentie.`],
      ['Visionplanner', 'Lees de auditfile in (saldi en transacties); de RGS-codes staan per rekening in de auditfile (leadReference) en in rgs-brugstaat.csv.'],
      ['Twinfield', 'Gebruik de XAF-conversie (beginbalans komt in periode 0) en vergelijk daarna de eindsaldi met kolommenbalans.csv. Openstaande posten staan los in de CSV-bestanden.'],
      ['Exact Online', 'Exact Online leest geen auditfile. Importeer journaalposten.csv als memoriaalboekingen en relaties.csv als relaties, met eenmalig een importdefinitie; koppel de rekeningen met rgs-brugstaat.csv.'],
      ['Yuki', 'Import-wizard historische gegevens met de auditfile (XAF 3.0 en hoger), of de CSV-bestanden in importprofielen/yuki (mutaties en openstaande posten in Yuki-formaat).'],
      ['SnelStart', 'SnelStart leest geen auditfile. Importeer de Excel-bestanden in importprofielen/snelstart (klanten, leveranciers, boekingen inclusief beginbalans); zet eerst het nummer van je memoriaaldagboek goed.'],
    ];
    return { files, totals, routes };
  }

  readmeText(s: PackageSummary, xafName: string, docCount: number): string {
    const { files, totals, routes } = this.readmeSections(s, xafName, docCount);
    const eur = euro;
    const L: string[] = [];
    L.push(`OVERDRACHT AAN DE BOEKHOUDER — BOEKJAAR ${s.year}`, '');
    L.push(`${s.company.name}${s.company.kvkNumber ? ` · KvK ${s.company.kvkNumber}` : ''}${s.company.vatNumber ? ` · btw ${s.company.vatNumber}` : ''}`);
    L.push(`Periode ${formatDateNl(s.from)} t/m ${formatDateNl(s.to)} · gemaakt op ${formatDateNl(s.createdAt)} met BoekhoudenVoorNiks ${s.softwareVersion}`, '');
    L.push('Let op: dit is een export voor overdracht, geen back-up. Instellingen, koppelingen en sjablonen zitten er niet in;', 'de ondernemer houdt daarvoor een eigen back-up in de app.', '');
    L.push('INHOUD');
    for (const [f, d] of files) L.push(`  ${f}`, `      ${d}`);
    L.push('', 'AANSLUITING                       debet            credit');
    for (const [l, d, c] of totals) L.push(`  ${l.padEnd(28)} ${d.padStart(16)} ${c.padStart(16)}`);
    L.push(`  ${(s.totals.result >= 0 ? 'Resultaat (winst)' : 'Resultaat (verlies)').padEnd(28)} ${eur(Math.abs(s.totals.result)).padStart(16)}`);
    L.push(`  ${'Openstaande debiteuren'.padEnd(28)} ${eur(s.openReceivables).padStart(16)}`);
    L.push(`  ${'Openstaande crediteuren'.padEnd(28)} ${eur(s.openPayables).padStart(16)}`);
    L.push(`  ${s.counts.entries} boekingen, ${s.counts.lines} boekingsregels, ${s.counts.accounts} rekeningen, ${s.counts.relations} relaties, ${s.counts.invoices} verkoopfacturen, ${s.counts.purchases} inkopen.`);
    L.push('', 'CONTROLES');
    for (const c of s.checks) L.push(`  [${c.ok ? 'OK' : '!!'}] ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
    L.push('', 'BTW PER AANGIFTEPERIODE');
    for (const v of s.vat) L.push(`  ${v.label.padEnd(20)} omzet ${eur(v.omzet).padStart(14)}  verschuldigd ${eur(v.btwOverOmzet).padStart(12)}  voorbelasting ${eur(v.voorbelasting).padStart(12)}  te betalen ${eur(v.teBetalen).padStart(12)}  (${v.status})`);
    if (s.missingRgs.length) {
      L.push('', 'REKENINGEN ZONDER RGS-CODE');
      for (const m of s.missingRgs) L.push(`  ${m.code} ${m.name}`);
    }
    if (s.missingDocuments.length) {
      L.push('', `ONTBREKENDE DOCUMENTEN (${s.missingDocuments.length})`);
      for (const m of s.missingDocuments) L.push(`  ${m.date}  ${m.description}${m.relation ? ` (${m.relation})` : ''}  ${m.total ? eur(m.total) : ''}  — ${m.reason}${m.entryId ? `, boekstuk ${m.entryId}` : ''}`);
    }
    L.push('', 'INLEZEN IN JE EIGEN PAKKET');
    for (const [p, r] of routes) L.push(`  ${p}: ${r}`);
    L.push('', '  Controleer na het inlezen of beginbalans, mutaties, eindsaldi, btw en openstaande posten gelijk zijn aan dit overzicht.');
    L.push(`  Sluit iets niet aan of mist er een importformaat voor jouw pakket? Mail het naar ${FEEDBACK_URL}`);
    L.push('', 'FORMAAT', '  CSV: puntkomma als scheidingsteken, komma als decimaalteken, UTF-8 met BOM (opent direct in Excel).', '  Datums als JJJJ-MM-DD. Saldo: debet positief, credit negatief. Boekstuk = transactienummer in de auditfile.');
    return L.join('\r\n') + '\r\n';
  }

  readmeHtml(s: PackageSummary, xafName: string, docCount: number): string {
    const x = escapeHtml;
    const { files, totals, routes } = this.readmeSections(s, xafName, docCount);
    const eur = (c: number) => euro(c).replace(' ', '&nbsp;');
    const missingDocs = s.missingDocuments.slice(0, 25);
    return `<!doctype html><html lang="nl"><head><meta charset="utf-8"><title>Lees mij — overdracht ${s.year}</title><style>
@page { size: A4; margin: 16mm 14mm; }
body { font: 10pt/1.4 system-ui, -apple-system, 'Segoe UI', sans-serif; color: #1c1c1c; }
h1 { font-size: 17pt; margin: 0 0 2mm; } h2 { font-size: 11.5pt; margin: 6mm 0 2mm; border-bottom: 1px solid #ccc; padding-bottom: 1mm; }
.meta { color: #555; } .label { background: #fff4d6; border: 1px solid #e6c46a; padding: 2.5mm 3mm; border-radius: 2mm; margin: 4mm 0; }
table { border-collapse: collapse; width: 100%; } td, th { padding: 1.2mm 2mm; vertical-align: top; text-align: left; border-bottom: 1px solid #eee; }
th { font-weight: 600; background: #f5f5f5; } .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
code { font-size: 9pt; } .ok { color: #1a7f37; font-weight: 700; } .bad { color: #b3261e; font-weight: 700; } .small { font-size: 8.5pt; color: #555; }
</style></head><body>
<h1>Overdracht aan de boekhouder — boekjaar ${s.year}</h1>
<div class="meta"><strong>${x(s.company.name)}</strong>${s.company.kvkNumber ? ` · KvK ${x(s.company.kvkNumber)}` : ''}${s.company.vatNumber ? ` · btw ${x(s.company.vatNumber)}` : ''}<br>
Periode ${formatDateNl(s.from)} t/m ${formatDateNl(s.to)} · gemaakt op ${formatDateNl(s.createdAt)} met BoekhoudenVoorNiks ${x(s.softwareVersion)} · XAF ${s.xafVersion} · RGS ${x(s.rgsVersion)}</div>
<div class="label"><strong>Export voor overdracht, geen back-up.</strong> Dit pakket is gemaakt om in te lezen in het eigen pakket van de boekhouder. Instellingen, koppelingen en sjablonen zitten er niet in; de ondernemer houdt daarvoor een eigen back-up in de app.</div>
<h2>Inhoud</h2>
<table>${files.map(([f, d]) => `<tr><td><code>${x(f)}</code></td><td>${x(d)}</td></tr>`).join('')}</table>
<h2>Aansluiting</h2>
<table><tr><th></th><th class="num">Debet</th><th class="num">Credit</th></tr>
${totals.map(([l, d, c]) => `<tr><td>${l}</td><td class="num">${d.replace(' ', '&nbsp;')}</td><td class="num">${c.replace(' ', '&nbsp;')}</td></tr>`).join('')}
<tr><td><strong>${s.totals.result >= 0 ? 'Resultaat (winst)' : 'Resultaat (verlies)'}</strong></td><td class="num" colspan="2"><strong>${eur(Math.abs(s.totals.result))}</strong></td></tr>
<tr><td>Openstaande debiteuren per ${formatDateNl(s.to)}</td><td class="num" colspan="2">${eur(s.openReceivables)}</td></tr>
<tr><td>Openstaande crediteuren per ${formatDateNl(s.to)}</td><td class="num" colspan="2">${eur(s.openPayables)}</td></tr></table>
<p class="small">${s.counts.entries} boekingen, ${s.counts.lines} boekingsregels, ${s.counts.accounts} rekeningen, ${s.counts.relations} relaties, ${s.counts.invoices} verkoopfacturen, ${s.counts.purchases} inkopen, ${docCount} documenten.</p>
<h2>Controles</h2>
<table>${s.checks.map((c) => `<tr><td class="${c.ok ? 'ok' : 'bad'}">${c.ok ? '✓' : '!'}</td><td>${x(c.label)}${c.detail ? `<div class="small">${x(c.detail)}</div>` : ''}</td></tr>`).join('')}</table>
<h2>Btw per aangifteperiode</h2>
<table><tr><th>Periode</th><th class="num">Omzet</th><th class="num">Verschuldigd</th><th class="num">Voorbelasting</th><th class="num">Te betalen</th><th>Status</th></tr>
${s.vat.map((v) => `<tr><td>${x(v.label)}</td><td class="num">${eur(v.omzet)}</td><td class="num">${eur(v.btwOverOmzet)}</td><td class="num">${eur(v.voorbelasting)}</td><td class="num">${eur(v.teBetalen)}</td><td>${v.status}</td></tr>`).join('')}</table>
${s.missingRgs.length ? `<h2>Rekeningen zonder RGS-code</h2><p>${s.missingRgs.map((m) => `${x(m.code)} ${x(m.name)}`).join(', ')}</p>` : ''}
${missingDocs.length ? `<h2>Ontbrekende documenten (${s.missingDocuments.length})</h2><table>${missingDocs.map((m) => `<tr><td>${m.date}</td><td>${x(m.description)}${m.relation ? ` <span class="small">${x(m.relation)}</span>` : ''}</td><td class="num">${m.total ? eur(m.total) : ''}</td><td class="small">${x(m.reason)}${m.entryId ? `, boekstuk ${m.entryId}` : ''}</td></tr>`).join('')}</table>${s.missingDocuments.length > missingDocs.length ? `<p class="small">De volledige lijst staat in documenten/index.csv.</p>` : ''}` : ''}
<h2>Inlezen in je eigen pakket</h2>
<table>${routes.map(([p, r]) => `<tr><td><strong>${x(p)}</strong></td><td>${x(r)}</td></tr>`).join('')}</table>
<p>Controleer na het inlezen of beginbalans, mutaties, eindsaldi, btw en openstaande posten gelijk zijn aan dit overzicht. Sluit iets niet aan of mist er een importformaat voor jouw pakket? Mail het naar <strong>${FEEDBACK_URL}</strong>.</p>
<p class="small">CSV: puntkomma als scheidingsteken, komma als decimaalteken, UTF-8 met BOM (opent direct in Excel). Datums als JJJJ-MM-DD. Saldo: debet positief, credit negatief. Boekstuk = transactienummer in de auditfile.</p>
</body></html>`;
  }
}
