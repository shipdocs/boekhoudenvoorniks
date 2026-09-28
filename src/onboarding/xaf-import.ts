import { tx, type Db } from '../db/database';
import type { BankService } from '../import/bank';
import type { RelationsService } from '../relations/relations';
import type { SettingsService } from '../settings/settings';
import { parseXaf, XafError, type XafAccount, type XafFile, type XafLine, type XafRelation } from '../import/xaf';
import { readXlsx } from '../import/xlsx';
import { isTrialBalance, parseTrialBalance } from '../import/trial-balance';
import {
  detectKind, openItemRows, saldibalansToXaf, suggestColumns, tablesFromCsv, tablesFromWorkbook, titleDate,
  type ColumnMapping, type ColumnQuestion, type Table, type TableKind,
} from '../import/opening-tables';
import { headerSignature } from '../import/csv';
import { addDays, formatDateNl, periodFor, today, type IsoDate } from '../shared/dates';
import { formatEuro, type Cents } from '../shared/money';
import { ACCOUNTS } from '../core-ledger/accounts';
import { ValidationError } from '../shared/validation';
import type { OpeningInput, SwitchoverService, SwitchoverState } from './switchover';

/**
 * Overstappen met een auditfile (XAF) uit je vorige programma: de app rekent uit wat er op de dag vóór
 * de instapdatum op elke rekening stond en maakt daar voorstellen van voor de overstap-hulp.
 *
 *  - rekeningen herkennen: eerst de RGS-code die het pakket meegeeft, anders de naam (en B/P)
 *  - openstaande facturen per klant/leverancier uit de openingsbalans en de boekingen (factuurnummer),
 *    anders per klant het saldo; het totaal sluit altijd aan op de rekening Debiteuren/Crediteuren
 *  - bus en gereedschap: per groep de boekwaarde (aanschaf min afschrijving)
 *  - midden in het jaar: omzet en kosten van 1 januari tot de instapdatum (zonder afschrijving)
 *  - midden in een btw-periode: omzet en btw van dat stuk (uit de btw-gegevens op de regels)
 *  - het eigen vermogen volgens de auditfile, om de startbalans mee te vergelijken
 *
 * Alles is een voorstel: de gebruiker vinkt aan wat hij overneemt. Wat de app niet herkent, staat er
 * apart bij (standaard uit).
 */

export type XafClass =
  | 'bank' | 'kas' | 'debiteuren' | 'crediteuren' | 'bezit' | 'afschrijving-cum' | 'btw' | 'lening' | 'vordering' | 'schuld'
  | 'eigen-vermogen' | 'omzet' | 'materiaal' | 'auto' | 'afschrijving' | 'kosten' | 'onbekend';

export interface XafProposal {
  key: string;
  input: OpeningInput;
  label: string;
  /** positief = bezit/tegoed, negatief = schuld (zoals in de startbalans) */
  amount: Cents;
  /** standaard aangevinkt? */
  include: boolean;
  note: string | null;
}

export interface XafBank {
  accountId: string;
  name: string;
  iban: string | null;
  amount: Cents;
  /** bestaande rekening in de app die erbij lijkt te horen, of null (dan nieuw aanmaken) */
  bankAccountId: number | null;
}

/** Wat voor bestand het was. */
export type ImportKind = 'auditfile' | 'kolommenbalans' | TableKind;

/** Rol van één bestand als er meerdere tegelijk zijn neergezet (bv. een auditfile per jaar). */
export interface ImportFileRole {
  index: number;
  startDate: IsoDate;
  endDate: IsoDate;
  role: 'gebruikt' | 'eerder' | 'later' | 'dubbel';
  /** uitleg in gewone taal */
  reason: string;
}

/** Meerdere bestanden: het voorstel voor het bestand dat bij de instapdatum hoort, plus wat er met de rest gebeurt. */
export type MultiImportAnalysis =
  | (ImportAnalysis & {
      files: ImportFileRole[];
      /** index van het bestand waarmee de startstand is berekend */
      chosen: number;
      /** een latere instapdatum waarmee je het jongste bestand helemaal gebruikt (niets opnieuw inboeken), of null */
      alternativeDate: IsoDate | null;
    })
  | DateAdvice;

/**
 * De auditfiles beginnen op of na de instapdatum: er is dan geen stand óp de instapdatum over te nemen.
 * De app stelt een instapdatum voor waarmee alles tot en met de laatste boeking wordt overgenomen.
 */
export interface DateAdvice {
  kind: 'instapdatum';
  /** de huidige instapdatum */
  date: IsoDate;
  /** voorgestelde instapdatum: de dag na de laatste boeking (of na het laatste afgesloten jaar) */
  suggestedDate: IsoDate;
  firstDate: IsoDate;
  lastBooking: IsoDate;
  /** begint een bestand precies op de instapdatum zonder beginbalans: dan begon het bedrijf toen waarschijnlijk */
  startedOnDate: boolean;
}

/** Het voorstel, of (alleen als de app een kolom echt niet vindt) een paar vragen. */
export type ImportAnalysis =
  | { kind: ImportKind; plan: XafPlan }
  | { kind: TableKind; questions: ColumnQuestion[]; headers: string[]; sample: string[][]; mapping: ColumnMapping };

export interface XafPlan {
  kind: ImportKind;
  meta: { software: string; version: string; fiscalYear: string; startDate: IsoDate; endDate: IsoDate; company: string; accounts: number; lines: number };
  /** de instapdatum waarvoor gerekend is */
  date: IsoDate;
  /** voorgestelde instapdatum: de dag na het einde van de auditfile */
  suggestedDate: IsoDate;
  banks: XafBank[];
  proposals: XafProposal[];
  relations: { total: number; fresh: number };
  /** wat er van jou in de zaak zat volgens de auditfile (bezittingen min schulden); null bij een lijst met openstaande posten */
  equity: Cents | null;
  /** bij openstaande posten: sluit het totaal aan op de startbalans? */
  check?: string | null;
  accounts: { id: string; name: string; rgs: string | null; class: XafClass; balance: Cents }[];
  warnings: string[];
}

export interface XafApplyChoices {
  /** keys van de voorstellen die de gebruiker overneemt */
  include: string[];
  /** per bankrekening in de auditfile: bestaande rekening in de app, 'nieuw', of null (overslaan) */
  banks: Record<string, number | 'nieuw' | null>;
  relations: boolean;
}

// ---------- rekeningen herkennen ----------

const has = (s: string, re: RegExp) => re.test(s.toLowerCase());

/** Soort rekening uit de RGS-code (officieel, of een code die daarop lijkt). */
function classByRgs(rgs: string): XafClass | null {
  const r = rgs;
  if (r.startsWith('BLimBan') || r.startsWith('BLiqBan')) return 'bank';
  if (r.startsWith('BLimKas') || r.startsWith('BLiqKas')) return 'kas';
  if (r.startsWith('BVorDeb')) return 'debiteuren';
  if (r.startsWith('BSchCre')) return 'crediteuren';
  if (r.startsWith('BMva') || r.startsWith('BIva')) return /Cae|Cua|Cuh|Afs|Cum/.test(r.slice(7)) ? 'afschrijving-cum' : 'bezit';
  // officieel BSchBepBtw…; sommige pakketten (bv. DigiBoox) gebruiken BSchBtw
  if (/^BSch\w*Btw/.test(r)) return 'btw';
  if (r.startsWith('BEiv')) return 'eigen-vermogen';
  if (r.startsWith('BLas') || r.startsWith('BSchAos') || r.startsWith('BSchSkk')) return 'lening';
  if (r.startsWith('BVor') || r.startsWith('BFva') || r.startsWith('BLimKru') || r.startsWith('BLiqKru')) return 'vordering';
  if (r.startsWith('BSch') || r.startsWith('BVrz')) return 'schuld';
  if (r.startsWith('WOmz')) return 'omzet';
  if (r.startsWith('WKpr')) return 'materiaal';
  if (r.startsWith('WBedAut')) return 'auto';
  if (r.startsWith('WAfs')) return 'afschrijving';
  if (r.startsWith('W')) return 'kosten';
  return null;
}

/** Zonder RGS: op de naam (en het soort rekening B/P). */
function classByName(a: XafAccount): XafClass {
  const n = a.name;
  const pl = a.type === 'P' || /^[48]\d{3}/.test(a.id) || /^7\d{3}/.test(a.id);
  if (pl) {
    // technische rekening die de winst naar het eigen vermogen boekt (bv. "Overboekingsrekening winst")
    if (has(n, /overboeking|winstreserve|resultaat(verdeling|bestemming)?$/)) return 'eigen-vermogen';
    if (has(n, /omzet|opbrengst|verkoop|verkopen|revenue|sales/)) return 'omzet';
    if (has(n, /afschrijving/)) return 'afschrijving';
    if (has(n, /inkoop|materiaal|kostprijs|uitbesteed|onderaanneming|grondstof/)) return 'materiaal';
    if (has(n, /auto|brandstof|benzine|diesel|vervoer|bus\b|lease|parkeer|kilometer/)) return 'auto';
    // decimaal rekeningschema: 7xxx inkoop, 8xxx omzet
    if (/^7\d{3}/.test(a.id)) return 'materiaal';
    if (/^8\d{3}/.test(a.id)) return 'omzet';
    return 'kosten';
  }
  // eerst de specifieke soorten: "Lening Rabobank" is een lening, "Voorbelasting" geen bank
  if (has(n, /afschrijving/)) return 'afschrijving-cum';
  if (has(n, /btw|omzetbelasting|voorbelasting|\bob\b/)) return 'btw';
  if (has(n, /debiteur/)) return 'debiteuren';
  if (has(n, /crediteur/)) return 'crediteuren';
  if (has(n, /lening|hypothe|financiering|krediet/)) return 'lening';
  if (has(n, /eigen vermogen|kapitaal|priv[eé]|onttrekking|storting|resultaat|winst/)) return 'eigen-vermogen';
  // tussenrekeningen vóór de bank: "Kruisposten / Spaartransactie" is geen spaarrekening
  if (has(n, /kruispost|tussenrekening|vraagpost|spaartransactie/)) return 'vordering';
  if (has(n, /\bkas\b|kasgeld|contant/)) return 'kas';
  // betaalprovider: geld dat nog uitbetaald wordt
  if (has(n, /mollie|stripe|paypal|sumup|adyen|zettle|tikkie/)) return 'vordering';
  if (has(n, /\bbank|rabo|\bing\b|abn|knab|bunq|triodos|\bsns\b|\basn\b|regiobank|spaar|betaalrekening|revolut|\bwise\b|\bn26\b|moneyou/)) return 'bank';
  if (has(n, /machine|inventaris|gereedschap|auto|bus\b|vervoer|computer|installatie|verbouwing|bedrijfsmiddel|materieel/)) return 'bezit';
  if (has(n, /vooruitbetaald|borg|waarborg|te ontvangen|vordering|voorschot|kruispost|tussenrekening|vraagpost/)) return 'vordering';
  if (has(n, /te betalen|schuld|loonheffing|nog te/)) return 'schuld';
  return 'onbekend';
}

export function classify(a: XafAccount): XafClass {
  // een resultaatrekening (P) met een balanscode is tegenstrijdig, bv. DigiBoox' "Overboekingsrekening
  // winst" met BLimKru: dan telt het soort rekening, en herkent de app hem op de naam
  const rgs = a.rgs && !(a.type === 'P' && a.rgs.startsWith('B')) ? a.rgs : null;
  return (rgs ? classByRgs(rgs) : null) ?? classByName(a);
}

/**
 * Opeenvolgende jaren als één bestand. Sommige pakketten (bv. DigiBoox) zetten geen beginbalans in de
 * auditfile: dan is de stand op een dag de optelsom van alle jaren tot en met die dag.
 */
export function mergeYears(files: XafFile[]): XafFile {
  const first = files[0]!;
  const last = files.at(-1)!;
  const accounts = new Map<string, XafAccount>();
  const relations = new Map<string, XafRelation>();
  for (const f of files) {
    for (const a of f.accounts) accounts.set(a.id, a);
    for (const r of f.relations) relations.set(r.id, r);
  }
  return {
    ...last,
    startDate: first.startDate,
    accounts: [...accounts.values()],
    relations: [...relations.values()],
    opening: first.opening,
    lines: files.flatMap((f) => f.lines),
    warnings: [...new Set(files.flatMap((f) => f.warnings))],
  };
}

/** Btw-rekening: hoog, laag, voorbelasting of anders (af te dragen / afrekening). */
function vatKind(a: XafAccount): 'hoog' | 'laag' | 'voor' | 'anders' {
  const r = a.rgs ?? '';
  const n = a.name.toLowerCase();
  if (/BtwVoo|Voorbelasting/i.test(r) || /voorbelasting|te vorderen|input/.test(n)) return 'voor';
  if (/BtwOlt|BtwAfdLaa|BtwLaa/.test(r) || /laag|9\s?%|6\s?%/.test(n)) return 'laag';
  if (/BtwOla|BtwAfdHoo|BtwHoo/.test(r) || /hoog|21\s?%/.test(n)) return 'hoog';
  return 'anders';
}

// ---------- de analyse ----------

export class XafImportService {
  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly relations: RelationsService,
    private readonly bank: BankService,
    private readonly switchover: SwitchoverService,
  ) {}

  /** Wat de auditfile of kolommenbalans betekent voor de startbalans op `date` (standaard: de gekozen instapdatum). */
  analyze(file: string | Uint8Array, date?: IsoDate): XafPlan {
    const r = this.analyzeFile(file, { date });
    if (!('plan' in r)) throw new ValidationError(r.questions[0]?.question ?? 'Kies eerst welke kolom wat is');
    return r.plan;
  }

  /**
   * Eén ingang voor alles wat de gebruiker erop sleept: auditfile, kolommenbalans, saldibalans of een
   * lijst met openstaande posten (Excel of CSV). De app bepaalt zelf wat het is.
   */
  analyzeFile(file: string | Uint8Array, opts: { date?: IsoDate; mapping?: ColumnMapping } = {}): ImportAnalysis {
    const src = this.source(file, opts.mapping);
    if (src.type === 'xaf') return { kind: src.kind, plan: this.plan(src.xaf, opts.date) };
    if (src.questions.length > 0) return { kind: src.kind, questions: src.questions, headers: src.table.headers, sample: src.table.rows.slice(0, 3), mapping: src.mapping };
    if (src.kind === 'saldibalans') return { kind: src.kind, plan: this.plan(this.saldibalans(src.table, src.mapping), opts.date) };
    return { kind: src.kind, plan: this.planOpenItems(src.table, src.mapping) };
  }

  /**
   * Meerdere bestanden tegelijk, bv. een auditfile per jaar (2024, 2025, 2026). De app kiest het bestand
   * dat tot de instapdatum loopt en rekent daarmee de startstand uit. Oudere jaren zitten al in je
   * vorige administratie; daaruit haalt de app alleen de aankoopdatums van bus en gereedschap. Een jaar
   * dat na de instapdatum begint, is voor de startstand niet nodig.
   */
  analyzeFiles(files: (string | Uint8Array)[], mapping?: ColumnMapping): MultiImportAnalysis {
    const advice = this.dateAdvice(files);
    if (advice) return advice;
    if (files.length === 1) {
      const r = this.analyzeFile(files[0]!, { mapping });
      const period = 'plan' in r ? { startDate: r.plan.meta.startDate, endDate: r.plan.meta.endDate } : { startDate: '', endDate: '' };
      return { ...r, files: [{ index: 0, ...period, role: 'gebruikt', reason: '' }], chosen: 0, alternativeDate: null };
    }
    const pick = this.pickFile(files);
    return { kind: pick.chosenKind, plan: this.plan(pick.xaf, undefined, pick.history), files: pick.roles, chosen: pick.chosen, alternativeDate: pick.alternativeDate };
  }

  /** Overnemen uit meerdere bestanden: de startstand uit het gekozen bestand, aankoopdatums uit alle. */
  applyFiles(files: (string | Uint8Array)[], choices: XafApplyChoices, mapping?: ColumnMapping): SwitchoverState {
    if (files.length === 1) return this.apply(files[0]!, choices, mapping);
    const pick = this.pickFile(files);
    return this.applyXaf(pick.xaf, choices, pick.history);
  }

  /** Alleen voor auditfiles: beginnen ze allemaal op of na de instapdatum, dan een betere instapdatum. */
  private dateAdvice(files: (string | Uint8Array)[]): DateAdvice | null {
    const s = this.settings.get();
    if (s.switchover.mode !== 'overstapper' || !s.switchover.date) return null;
    const date = s.switchover.date;
    let xafs: XafFile[];
    try {
      const sources = files.map((f) => this.source(f));
      if (sources.some((x) => x.type !== 'xaf')) return null;
      xafs = sources.map((x) => (x as Extract<typeof x, { type: 'xaf' }>).xaf).filter((x) => !x.totalsOnly);
    } catch {
      // onleesbaar bestand: de gewone analyse geeft de juiste foutmelding
      return null;
    }
    if (xafs.length === 0 || xafs.some((x) => x.startDate < date || (x.startDate === date && x.opening.lines.length > 0))) return null;
    const lastBooking = xafs.flatMap((x) => x.lines.map((l) => l.date)).sort().at(-1);
    if (!lastBooking) return null;
    const now = today();
    // een afgesloten jaar: de dag erna; anders de dag na de laatste boeking (niet in de toekomst)
    const closed = xafs.map((x) => x.endDate).filter((e) => e < now).sort().at(-1);
    const afterLast = addDays(lastBooking, 1);
    const suggestedDate = [closed && closed >= lastBooking ? addDays(closed, 1) : afterLast, now].sort()[0]!;
    const firstDate = xafs.map((x) => x.startDate).sort()[0]!;
    return { kind: 'instapdatum', date, suggestedDate, firstDate, lastBooking, startedOnDate: firstDate === date };
  }

  private pickFile(files: (string | Uint8Array)[]) {
    const s = this.settings.get();
    if (s.switchover.mode !== 'overstapper' || !s.switchover.date) throw new ValidationError('Kies eerst een instapdatum');
    const date = s.switchover.date;
    const until = addDays(date, -1);
    const sources = files.map((f) => this.source(f));
    if (sources.some((x) => x.type !== 'xaf')) {
      throw new ValidationError('Meerdere bestanden tegelijk kan alleen met auditfiles (.xaf) of kolommenbalansen. Zet een lijst met openstaande facturen of een saldibalans er apart op.');
    }
    const xafs = sources.map((x) => (x as Extract<typeof x, { type: 'xaf' }>).xaf);
    const kinds = sources.map((x) => x.kind);
    const idx = xafs.map((_, i) => i);
    // 1. loopt door tot de dag vóór de instapdatum: met losse boekingen (en facturen) het beste
    const covering = idx.filter((i) => xafs[i]!.startDate <= until && xafs[i]!.endDate >= until).sort((a, b) => Number(!!xafs[a]!.totalsOnly) - Number(!!xafs[b]!.totalsOnly) || xafs[a]!.endDate.localeCompare(xafs[b]!.endDate));
    // 2. begint precies op de instapdatum, met een beginbalans
    const startsOn = idx.filter((i) => xafs[i]!.startDate === date && xafs[i]!.opening.lines.length > 0);
    // 3. anders het jongste bestand dat vóór de instapdatum eindigt (de app waarschuwt voor het gat)
    const before = idx.filter((i) => xafs[i]!.endDate < until).sort((a, b) => xafs[b]!.endDate.localeCompare(xafs[a]!.endDate));
    const chosen = covering[0] ?? startsOn[0] ?? before[0];
    if (chosen === undefined) {
      throw new ValidationError(`Alle bestanden beginnen na je instapdatum (${formatDateNl(date)}). Zet ook het jaar ervoor erbij, of kies een latere instapdatum.`);
    }
    const c = xafs[chosen]!;
    // geen beginbalans in het gekozen jaar (bv. DigiBoox): de jaren ervoor die er direct op aansluiten
    // tellen mee, tot en met een jaar dat wél een beginbalans heeft (of het eerste jaar)
    const chain: number[] = [];
    if (c.opening.lines.length === 0 && !c.totalsOnly) {
      let cur = c;
      for (;;) {
        const prev = idx.find((i) => i !== chosen && !chain.includes(i) && !xafs[i]!.totalsOnly && addDays(xafs[i]!.endDate, 1) === cur.startDate);
        if (prev === undefined) break;
        chain.unshift(prev);
        cur = xafs[prev]!;
        if (cur.opening.lines.length > 0) break;
      }
    }
    const year = (x: XafFile) => (x.startDate.slice(0, 4) === x.endDate.slice(0, 4) ? x.startDate.slice(0, 4) : `${formatDateNl(x.startDate)} t/m ${formatDateNl(x.endDate)}`);
    const roles: ImportFileRole[] = idx.map((i) => {
      const x = xafs[i]!;
      const base = { index: i, startDate: x.startDate, endDate: x.endDate };
      if (i === chosen) return { ...base, role: 'gebruikt', reason: `Hiermee rekent de app uit wat er op ${formatDateNl(until)} op elke rekening stond.` };
      if (chain.includes(i)) return { ...base, role: 'gebruikt', reason: `Telt mee voor de startstand: in je auditfiles staat geen beginbalans, dus de app telt ${year(x)} erbij op.` };
      if (x.startDate === c.startDate && x.endDate === c.endDate) return { ...base, role: 'dubbel', reason: 'Zelfde periode als het gebruikte bestand: niet nodig.' };
      if (x.endDate < c.startDate || x.endDate < until) return { ...base, role: 'eerder', reason: `${year(x)} zit al in je vorige administratie. De app haalt er alleen de aankoopdatums van je bus en gereedschap uit.` };
      return { ...base, role: 'later', reason: `Loopt na je instapdatum. Voor de startstand niet nodig: die periode lees je in met je bankafschriften.` };
    });
    // een jonger bestand: met de dag erna als instapdatum hoef je die periode niet opnieuw in te boeken
    const latest = idx.filter((i) => roles[i]!.role === 'later' && !xafs[i]!.totalsOnly).sort((a, b) => xafs[b]!.endDate.localeCompare(xafs[a]!.endDate))[0];
    const alternativeDate = latest !== undefined ? addDays(xafs[latest]!.endDate, 1) : null;
    const history = idx.filter((i) => i !== chosen && roles[i]!.role !== 'dubbel').map((i) => xafs[i]!);
    const xaf = chain.length > 0 ? mergeYears([...chain.map((i) => xafs[i]!), c]) : c;
    return { xaf, chosen, chosenKind: kinds[chosen]!, roles, alternativeDate, history };
  }

  private source(file: string | Uint8Array, given?: ColumnMapping):
    | { type: 'xaf'; kind: ImportKind; xaf: XafFile }
    | { type: 'table'; kind: TableKind; table: Table; mapping: ColumnMapping; questions: ColumnQuestion[] } {
    let tables: Table[];
    if (typeof file === 'string') {
      if (/<([\w-]+:)?auditfile[\s>]/i.test(file.slice(0, 3000))) return { type: 'xaf', kind: 'auditfile', xaf: parseXaf(file) };
      tables = tablesFromCsv(file);
    } else {
      let wb;
      try {
        wb = readXlsx(file);
      } catch {
        throw new XafError('Dit bestand kunnen we niet lezen. Gebruik een auditfile (.xaf), of een overzicht als Excel (.xlsx) of CSV.');
      }
      if (isTrialBalance(wb)) return { type: 'xaf', kind: 'kolommenbalans', xaf: parseTrialBalance(wb) };
      tables = tablesFromWorkbook(wb);
    }
    const found = tables.map((t) => ({ t, kind: detectKind(t) })).find((x) => x.kind !== null);
    if (!found) {
      throw new XafError(
        typeof file === 'string'
          ? 'Dit bestand herkennen we niet. Een auditfile (.xaf), een saldibalans of een lijst met openstaande facturen werkt. Of download het voorbeeldbestand en zet je facturen daarin.'
          : 'In dit Excel-bestand staat geen kolommenbalans, saldibalans of lijst met openstaande facturen. Of download het voorbeeldbestand en zet je facturen daarin.',
      );
    }
    const kind = found.kind!;
    const table = found.t;
    const key = `overstap-${kind}-${headerSignature(table.headers)}`.slice(0, 200);
    const guess = suggestColumns(kind, table);
    let mapping = guess.mapping;
    if (given) {
      mapping = { ...mapping, ...given };
      // onthouden: de volgende keer hetzelfde soort bestand zonder vragen
      this.db
        .prepare('INSERT INTO csv_mappings (name, header_signature, mapping) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET mapping = excluded.mapping')
        .run(key, headerSignature(table.headers), JSON.stringify(mapping));
    } else {
      const saved = this.db.prepare('SELECT mapping FROM csv_mappings WHERE name = ?').get(key) as { mapping: string } | undefined;
      if (saved) mapping = { ...mapping, ...(JSON.parse(saved.mapping) as ColumnMapping) };
    }
    const questions = guess.questions.filter((q) => mapping[q.field] === undefined && !(q.field === 'balance' && mapping.debit !== undefined && mapping.credit !== undefined));
    return { type: 'table', kind, table, mapping, questions };
  }

  private saldibalans(table: Table, mapping: ColumnMapping): XafFile {
    const s = this.settings.get().switchover;
    // saldo per: de datum in de titel, anders de dag vóór de instapdatum
    const asOf = titleDate(table) ?? (s.mode === 'overstapper' && s.date ? addDays(s.date, -1) : `${new Date().getFullYear() - 1}-12-31`);
    return saldibalansToXaf(table, mapping, asOf);
  }

  /** Lijst met openstaande posten → losse facturen en rekeningen, met een controle op de startbalans. */
  private planOpenItems(table: Table, mapping: ColumnMapping): XafPlan {
    const s = this.settings.get().switchover;
    if (s.mode !== 'overstapper' || !s.date) throw new ValidationError('Kies eerst een instapdatum');
    const date = s.date;
    const until = addDays(date, -1);
    const { rows, unreadable } = openItemRows(table, mapping);
    if (rows.length === 0 && unreadable.length > 0) throw new ValidationError(`De bedragen in deze lijst kan de app niet lezen, bv. ${unreadable[0]}`);
    if (rows.length === 0) throw new ValidationError('In deze lijst staan geen openstaande bedragen');
    const proposals: XafProposal[] = [];
    rows.forEach((r, i) => {
      const invoiceDate = r.invoiceDate && r.invoiceDate < date ? r.invoiceDate : until;
      if (r.amount > 0) {
        const input: OpeningInput =
          r.kind === 'klant'
            ? { kind: 'klant', relationName: r.relationName, number: r.number || `ZONDER-NR-${i + 1}`, invoiceDate, dueDate: r.dueDate, amount: r.amount, bron: 'lijst' }
            : { kind: 'leverancier', relationName: r.relationName, reference: r.number || null, invoiceDate, dueDate: r.dueDate, amount: r.amount, bron: 'lijst' };
        proposals.push({
          key: `lijst:${r.kind}:${r.relationName}:${r.number}:${i}`,
          label: `${r.kind === 'klant' ? 'Factuur' : 'Rekening'} ${r.number || '(zonder nummer)'} ${r.relationName}`,
          input,
          amount: r.kind === 'klant' ? r.amount : -r.amount,
          include: true,
          note: r.number ? null : 'geen factuurnummer: dan koppelt de app de betaling niet vanzelf',
        });
      } else {
        // klant betaalde vooruit / je hebt tegoed bij een leverancier
        const input: OpeningInput =
          r.kind === 'klant' ? { kind: 'schuld', description: `Vooruit ontvangen van ${r.relationName}`, amount: -r.amount, bron: 'lijst' } : { kind: 'vordering', description: `Tegoed bij ${r.relationName}`, amount: -r.amount, bron: 'lijst' };
        proposals.push({ key: `lijst-min:${r.kind}:${r.relationName}:${r.number}:${i}`, label: input.description, input, amount: r.kind === 'klant' ? r.amount : -r.amount, include: true, note: null });
      }
    });
    // controle: sluit de lijst aan op wat de startbalans nu zegt?
    const position = this.switchover.position();
    const net = (key: string) => (position?.bezittingen.find((l) => l.key === key)?.amount ?? 0) - (position?.schulden.find((l) => l.key === key)?.amount ?? 0);
    const parts: string[] = [];
    for (const kind of ['klant', 'leverancier'] as const) {
      if (!rows.some((r) => r.kind === kind)) continue;
      const list = rows.filter((r) => r.kind === kind).reduce((t, r) => t + r.amount, 0);
      const now = kind === 'klant' ? net(ACCOUNTS.debiteuren) : -net(ACCOUNTS.crediteuren);
      const who = kind === 'klant' ? 'klanten nog moesten betalen' : 'jij nog moest betalen';
      if (now === 0) parts.push(`Samen ${formatEuro(list)} wat ${who}.`);
      else if (now === list) parts.push(`Samen ${formatEuro(list)}: gelijk aan wat ${who} volgens je startbalans ✓`);
      else parts.push(`Samen ${formatEuro(list)} wat ${who}; volgens je startbalans ${formatEuro(now)} (${formatEuro(Math.abs(list - now))} verschil).`);
    }
    return {
      kind: 'openstaande-posten',
      meta: { software: `Openstaande posten (${table.sheet})`, version: 'openstaande-posten', fiscalYear: date.slice(0, 4), startDate: until, endDate: until, company: table.title[0] ?? '', accounts: 0, lines: rows.length },
      date,
      suggestedDate: date,
      banks: [],
      proposals,
      relations: { total: 0, fresh: 0 },
      equity: null,
      check: parts.join(' '),
      accounts: [],
      warnings: unreadable.length ? [`${unreadable.length} ${unreadable.length === 1 ? 'regel heeft een bedrag' : 'regels hebben een bedrag'} dat de app niet kan lezen; die staan hieronder niet: ${unreadable.slice(0, 3).join(', ')}${unreadable.length > 3 ? ', …' : ''}`] : [],
    };
  }


  private plan(xaf: XafFile, requested?: IsoDate, history: XafFile[] = []): XafPlan {
    const s = this.settings.get();
    // alleen totalen (kolommenbalans): het liefst instappen op de begindatum, met de beginbalans
    const suggestedDate = xaf.totalsOnly ? xaf.startDate : addDays(xaf.endDate, 1);
    const date = requested ?? (s.switchover.mode === 'overstapper' && s.switchover.date ? s.switchover.date : suggestedDate);
    const until = addDays(date, -1);
    const warnings = [...xaf.warnings];
    if (xaf.totalsOnly && date > xaf.startDate && until < xaf.endDate) {
      throw new ValidationError(
        `In dit overzicht staan alleen totalen, geen losse boekingen. Daarmee kan de app instappen op ${formatDateNl(xaf.startDate)} (met de beginbalans) of na ${formatDateNl(xaf.endDate)} (met de eindbalans), niet op ${formatDateNl(date)}. Kies een van die datums als instapdatum, of vraag een auditfile (.xaf) aan.`,
      );
    }
    if (xaf.totalsOnly) warnings.push('In dit overzicht staan geen losse facturen: wat klanten nog moesten betalen en wat jij nog moest betalen, komt als één totaal. Vervang dat bij "Klanten" en "Rekeningen" door de losse facturen, dan koppelt de app de betalingen eraan.');
    if (xaf.startDate > date) throw new ValidationError(`Deze auditfile begint op ${formatDateNl(xaf.startDate)}, na je instapdatum (${formatDateNl(date)}). Exporteer het jaar ervoor, of kies een latere instapdatum.`);
    if (xaf.endDate < until) {
      warnings.push(`De auditfile loopt tot ${formatDateNl(xaf.endDate)}. Boekingen van ${formatDateNl(addDays(xaf.endDate, 1))} tot ${formatDateNl(date)} ontbreken: exporteer tot en met ${formatDateNl(until)}, of kies ${formatDateNl(suggestedDate)} als instapdatum.`);
    }

    if (!xaf.totalsOnly && xaf.opening.lines.length === 0 && xaf.startDate < date) {
      warnings.push(`In de auditfile staat geen beginbalans: de app rekent vanaf ${formatDateNl(xaf.startDate)} met € 0 op elke rekening. Liep je bedrijf al eerder? Zet dan ook de auditfiles van de jaren ervoor erbij; dat kan tegelijk.`);
    }
    const byId = new Map(xaf.accounts.map((a) => [a.id, a]));
    const cls = new Map(xaf.accounts.map((a) => [a.id, classify(a)]));
    const lines = xaf.lines.filter((l) => l.date <= until);
    const balance = new Map<string, Cents>();
    const add = (id: string, amount: Cents) => balance.set(id, (balance.get(id) ?? 0) + amount);
    // de openingsbalans hoort bij de begindatum van het bestand (tenzij die ná de instapdatum ligt)
    if (!xaf.opening.date || xaf.opening.date <= date) for (const l of xaf.opening.lines) add(l.accountId, l.amount);
    for (const l of lines) add(l.accountId, l.amount);
    const of = (c: XafClass) => xaf.accounts.filter((a) => cls.get(a.id) === c);
    const sum = (accs: XafAccount[]) => accs.reduce((t, a) => t + (balance.get(a.id) ?? 0), 0);

    const isBalance = (c: XafClass) => !['omzet', 'materiaal', 'auto', 'afschrijving', 'kosten'].includes(c);
    const yearStart = `${date.slice(0, 4)}-01-01`;
    // resultaat van vorige jaren zit in het eigen vermogen; alleen de P-rekeningen van dit jaar tellen als "tot nu toe"
    const ytd = (accs: XafAccount[]) =>
      accs.reduce((t, a) => t + lines.filter((l) => l.accountId === a.id && l.date >= yearStart).reduce((x, l) => x + l.amount, 0) + (xaf.opening.date && xaf.opening.date >= yearStart ? xaf.opening.lines.filter((l) => l.accountId === a.id).reduce((x, l) => x + l.amount, 0) : 0), 0);

    const relName = new Map(xaf.relations.map((r) => [r.id, r.name]));
    const proposals: XafProposal[] = [];
    const push = (p: Omit<XafProposal, 'amount' | 'include' | 'note'> & Partial<Pick<XafProposal, 'include' | 'note'>>, amount: Cents) =>
      proposals.push({ include: true, note: null, ...p, amount });

    // --- bank
    const appBanks = this.bank.listAccounts();
    // een rekening in de app zonder nummer en zonder afschriften of saldo is nog vrij (bv. de standaardrekening)
    const free = appBanks.filter((b) => !b.iban && !b.is_pot && !this.db.prepare('SELECT 1 FROM bank_transactions WHERE bank_account_id = ?').get(b.id) && this.bank.openingBalance(b.id).amount === 0);
    const banks: XafBank[] = of('bank')
      .filter((a) => (balance.get(a.id) ?? 0) !== 0 || lines.some((l) => l.accountId === a.id))
      .map((a) => {
        const iban = xaf.lines.find((l) => l.accountId === a.id && l.journalIban)?.journalIban ?? null;
        // één rekening aan beide kanten: dezelfde, tenzij de rekeningnummers verschillen
        const only = of('bank').length === 1 && appBanks.length === 1 && (!iban || !appBanks[0]!.iban) ? appBanks[0] : undefined;
        const match = appBanks.find((b) => (iban && b.iban === iban) || b.name.toLowerCase() === a.name.toLowerCase()) ?? only;
        return { accountId: a.id, name: a.name, iban, amount: balance.get(a.id) ?? 0, bankAccountId: match?.id ?? null };
      });
    for (const b of banks) {
      if (b.bankAccountId !== null) continue;
      const spare = free.find((f) => !banks.some((x) => x.bankAccountId === f.id));
      if (spare) b.bankAccountId = spare.id;
    }

    // --- kas
    for (const a of of('kas')) {
      const amount = balance.get(a.id) ?? 0;
      if (amount > 0) push({ key: `kas:${a.id}`, label: a.name.toLowerCase() === 'kas' ? 'Kas' : `Kas: ${a.name}`, input: { kind: 'vordering', description: a.name, amount, account: 'kas', bron: 'xaf' } }, amount);
      else if (amount < 0) warnings.push(`Negatief kassaldo op ${a.name} (${formatEuro(amount)}): dat kan niet, kijk het na in je vorige programma`);
    }

    // --- openstaande posten per klant/leverancier
    const openItems = (kind: 'klant' | 'leverancier', accs: XafAccount[]) => {
      const ids = new Set(accs.map((a) => a.id));
      const total = sum(accs);
      if (total === 0 && accs.length === 0) return;
      const sign = kind === 'klant' ? 1 : -1;
      type Group = { relationId: string | null; ref: string | null; amount: Cents; date: IsoDate | null; due: IsoDate | null };
      const groups = new Map<string, Group>();
      const addGroup = (relationId: string | null, ref: string | null, amount: Cents, d: IsoDate | null, due: IsoDate | null) => {
        const key = `${relationId ?? ''}|${ref ?? ''}`;
        const g = groups.get(key) ?? { relationId, ref, amount: 0, date: d, due };
        g.amount += amount;
        if (d && (!g.date || d < g.date)) g.date = d;
        if (due && !g.due) g.due = due;
        groups.set(key, g);
      };
      const itemsOnAccounts = xaf.opening.items.filter((i) => !i.accountId || ids.has(i.accountId));
      const openingOnAccounts = xaf.opening.lines.filter((l) => ids.has(l.accountId)).reduce((t, l) => t + l.amount, 0);
      const itemsTotal = itemsOnAccounts.reduce((t, i) => t + i.amount, 0);
      // openingsbalans per factuur als die aansluit, anders het totaal als één post zonder klant
      if (itemsOnAccounts.length > 0 && itemsTotal === openingOnAccounts) for (const i of itemsOnAccounts) addGroup(i.relationId, i.invoiceRef, i.amount, i.invoiceDate, i.dueDate);
      else if (openingOnAccounts !== 0 && (!xaf.opening.date || xaf.opening.date <= date)) addGroup(null, null, openingOnAccounts, xaf.opening.date, null);
      for (const l of lines.filter((x) => ids.has(x.accountId))) addGroup(l.relationId, l.invoiceRef, l.amount, l.date, null);

      let perInvoice = [...groups.values()].filter((g) => g.amount !== 0);
      // betalingen zonder factuurnummer: dan per klant het saldo
      if (perInvoice.some((g) => sign * g.amount < 0 || !g.ref)) {
        const perRel = new Map<string, Group>();
        for (const g of groups.values()) {
          const k = g.relationId ?? '';
          const r = perRel.get(k) ?? { relationId: g.relationId, ref: null, amount: 0, date: g.date, due: null };
          r.amount += g.amount;
          if (g.date && (!r.date || g.date < r.date)) r.date = g.date;
          perRel.set(k, r);
        }
        perInvoice = [...perRel.values()].filter((g) => g.amount !== 0);
        if (groups.size > 0 && !xaf.totalsOnly) warnings.push(`${kind === 'klant' ? 'Debiteuren' : 'Crediteuren'}: niet elke betaling had een factuurnummer; de app neemt per ${kind} het openstaande saldo over`);
      }
      for (const g of perInvoice) {
        const name = (g.relationId && relName.get(g.relationId)) || (kind === 'klant' ? 'Onbekende klant' : 'Onbekende leverancier');
        const amount = sign * g.amount;
        const invoiceDate = g.date && g.date <= until ? g.date : until;
        const ref = g.ref ?? `SALDO-${g.relationId ?? 'onbekend'}`;
        if (amount > 0) {
          const input: OpeningInput =
            kind === 'klant'
              ? { kind, relationName: name, number: ref, invoiceDate, dueDate: g.due, amount, bron: 'xaf' }
              : { kind, relationName: name, reference: g.ref, invoiceDate, dueDate: g.due, amount, bron: 'xaf' };
          push({ key: `${kind}:${g.relationId ?? ''}:${ref}`, label: `${kind === 'klant' ? 'Factuur' : 'Rekening'} ${g.ref ?? '(saldo)'} ${name}`, input, note: g.ref ? null : 'openstaand saldo, geen factuurnummer' }, sign * amount);
        } else {
          // klant betaalde vooruit / je hebt tegoed bij een leverancier
          const other: OpeningInput = kind === 'klant' ? { kind: 'schuld', description: `Vooruit ontvangen van ${name}`, amount: -amount, bron: 'xaf' } : { kind: 'vordering', description: `Tegoed bij ${name}`, amount: -amount, bron: 'xaf' };
          push({ key: `${kind}-min:${g.relationId ?? ''}:${g.ref ?? ''}`, label: other.kind === 'schuld' ? other.description : `Tegoed bij ${name}`, input: other }, kind === 'klant' ? amount : -amount);
        }
      }
    };
    openItems('klant', of('debiteuren'));
    openItems('leverancier', of('crediteuren'));

    // --- bus en gereedschap: per groep (RGS-prefix of naam) de boekwaarde
    const assetGroups = new Map<string, { name: string; cost: Cents; depr: Cents; type: 'vervoer' | 'inventaris'; ids: string[] }>();
    const groupKey = (a: XafAccount) => (a.rgs ? a.rgs.slice(0, 7) : a.name.toLowerCase().replace(/afschrijving(en)?|cumulatie(f|ve)|\(.*?\)/g, '').trim());
    for (const a of [...of('bezit'), ...of('afschrijving-cum')]) {
      const k = groupKey(a);
      const g = assetGroups.get(k) ?? { name: a.name, cost: 0, depr: 0, type: /Tev|Tra|Vvm|auto|bus|vervoer|wagen/i.test(`${a.rgs ?? ''} ${a.name}`) ? 'vervoer' : 'inventaris', ids: [] };
      if (cls.get(a.id) === 'bezit') {
        g.cost += balance.get(a.id) ?? 0;
        g.name = a.name;
        g.ids.push(a.id);
      } else g.depr += balance.get(a.id) ?? 0;
      assetGroups.set(k, g);
    }
    for (const [k, g] of assetGroups) {
      const value = g.cost + g.depr;
      if (value <= 0 && g.cost <= 0) continue;
      const cost = Math.max(g.cost, value);
      // 20% per jaar van de aanschaf: zoveel jaar is er nog over (minstens 1)
      const remainingYears = Math.max(1, Math.min(5, Math.round((value / Math.max(1, cost)) * 5)));
      const acquired = acquisitionDate([...history, xaf], g.ids, until);
      push(
        {
          key: `bezit:${k}`,
          label: g.name,
          input: { kind: 'bezit', name: g.name, type: g.type, acquiredOn: acquired ?? `${Number(date.slice(0, 4)) - 1}-01-01`, cost, bookValue: Math.max(0, value), remainingYears, bron: 'xaf' },
          note: acquired ? `aankoopdatum uit je auditfile (${formatDateNl(acquired)}); resterende jaren zijn geschat: kijk ze na` : 'aankoopdatum en resterende jaren zijn geschat: kijk ze na',
        },
        Math.max(0, value),
      );
    }

    // --- btw-periode (instapdatum midden in een periode) en btw-saldo
    const vatAccs = of('btw');
    const vatTotal = sum(vatAccs);
    const split = !s.kor && periodFor(date, s.vatPeriod).start !== date ? periodFor(date, s.vatPeriod) : null;
    let splitVat = 0;
    if (split) {
      const inWindow = (l: XafLine) => l.date >= split.start && l.date <= until;
      const win = lines.filter(inWindow);
      const withVat = win.filter((l) => l.vat && l.vat.amount !== 0);
      const revenueLines = win.filter((l) => cls.get(l.accountId) === 'omzet');
      // btw per regel alleen gebruiken als élke omzetregel die heeft; anders zou omzet zonder btw-gegevens als 0% tellen
      const perLine = withVat.length > 0 && revenueLines.every((l) => l.vat !== null);
      let omzetHoog = 0, btwHoog = 0, omzetLaag = 0, btwLaag = 0, omzetNul = 0, voorbelasting = 0;
      const revenue = (l: XafLine) => cls.get(l.accountId) === 'omzet';
      if (perLine) {
        for (const l of win.filter(revenue)) {
          const pct = l.vat?.percentage ?? 0;
          if (pct >= 20) omzetHoog -= l.amount;
          else if (pct > 0) omzetLaag -= l.amount;
          else omzetNul -= l.amount;
        }
        for (const l of withVat) {
          if (revenue(l)) {
            if ((l.vat!.percentage ?? 21) >= 20) btwHoog -= l.vat!.amount;
            else btwLaag -= l.vat!.amount;
          } else if (!isBalance(cls.get(l.accountId) ?? 'onbekend') || cls.get(l.accountId) === 'bezit') voorbelasting += l.vat!.amount;
        }
        // btw-bedragen staan soms positief op de regel: altijd als bedrag nemen
        btwHoog = Math.abs(btwHoog);
        btwLaag = Math.abs(btwLaag);
        voorbelasting = Math.abs(voorbelasting);
      } else {
        // geen btw per regel: uit de btw-rekeningen (let op: aangifteboekingen in deze dagen verstoren dit)
        for (const a of vatAccs) {
          const mov = win.filter((l) => l.accountId === a.id).reduce((t, l) => t + l.amount, 0);
          const k = vatKind(a);
          if (k === 'hoog') btwHoog -= mov;
          else if (k === 'laag') btwLaag -= mov;
          else if (k === 'voor') voorbelasting += mov;
        }
        const omzet = -win.filter(revenue).reduce((t, l) => t + l.amount, 0);
        omzetHoog = Math.max(0, Math.round(btwHoog / 0.21));
        omzetLaag = Math.max(0, Math.round(btwLaag / 0.09));
        omzetNul = Math.max(0, omzet - omzetHoog - omzetLaag);
      }
      const clamp = (v: number) => Math.max(0, v);
      const input: OpeningInput = { kind: 'btw-periode', omzetHoog: clamp(omzetHoog), btwHoog: clamp(btwHoog), omzetLaag: clamp(omzetLaag), btwLaag: clamp(btwLaag), omzetNul: clamp(omzetNul), voorbelasting: clamp(voorbelasting), bron: 'xaf' };
      splitVat = input.voorbelasting - input.btwHoog - input.btwLaag;
      push({ key: 'btw-periode', label: `Omzet en btw van ${formatDateNl(split.start)} tot ${formatDateNl(date)}`, input, note: perLine ? 'uit de btw op de boekingsregels: vergelijk met je btw-overzicht' : 'uit de btw-rekeningen berekend: vergelijk met je btw-overzicht' }, splitVat);
    }
    if (!s.kor) {
      // wat er op de btw-rekeningen staat, min het stuk dat hierboven apart geboekt wordt
      const rest = vatTotal - splitVat;
      const input: OpeningInput = rest === 0 ? { kind: 'btw', direction: 'betalen', amount: 0, bron: 'xaf' } : { kind: 'btw', direction: rest > 0 ? 'terug' : 'betalen', amount: Math.abs(rest), bron: 'xaf' };
      push({ key: 'btw', label: rest === 0 ? 'Btw: niets meer open' : rest > 0 ? 'Btw die je nog terugkrijgt' : 'Btw die je nog moet betalen', input }, rest);
    } else if (vatTotal !== 0) warnings.push(`Er staat ${formatEuro(vatTotal)} op btw-rekeningen, maar je gebruikt de KOR. Kijk het na met je boekhouder.`);

    // --- leningen, overige vorderingen en schulden: per rekening
    for (const c of ['lening', 'vordering', 'schuld'] as const) {
      for (const a of of(c)) {
        const amount = balance.get(a.id) ?? 0;
        if (amount === 0) continue;
        const kind = c === 'vordering' ? (amount > 0 ? 'vordering' : 'schuld') : amount < 0 ? c : 'vordering';
        // tussenrekeningen horen op nul te staan: niet zomaar overnemen
        const suspense = has(a.name, /kruispost|tussenrekening|vraagpost|spaartransactie/);
        push(
          {
            key: `${c}:${a.id}`,
            label: a.name,
            input: { kind, description: a.name, amount: Math.abs(amount), bron: 'xaf' },
            include: !suspense,
            note: suspense ? (has(a.name, /vraagpost/) ? 'nog uit te zoeken in je vorige administratie: neem alleen over als je weet wat het is' : 'hoort op nul te staan: ontbreekt er een (spaar)rekening, of een boeking in je vorige administratie?') : null,
          },
          amount,
        );
      }
    }

    // --- omzet en kosten tot de instapdatum
    if (!date.endsWith('-01-01')) {
      const omzet = -ytd(of('omzet'));
      const materiaal = ytd(of('materiaal'));
      const auto = ytd(of('auto'));
      const overig = ytd(of('kosten'));
      if (omzet < 0 || materiaal < 0 || auto < 0 || overig < 0) warnings.push('Een van de totalen van omzet of kosten tot nu toe is negatief; de app zet dat op 0. Kijk de bedragen na.');
      push(
        {
          key: 'resultaat',
          label: `Omzet en kosten van 1 januari tot ${formatDateNl(date)}`,
          input: { kind: 'resultaat', omzet: Math.max(0, omzet), materiaal: Math.max(0, materiaal), auto: Math.max(0, auto), overig: Math.max(0, overig), bron: 'xaf' },
          note: ytd(of('afschrijving')) !== 0 ? 'zonder afschrijving: die rekent de app voor het hele jaar' : null,
        },
        omzet - materiaal - auto - overig,
      );
    }

    // --- niet herkend: apart, standaard uit
    for (const a of of('onbekend')) {
      const amount = balance.get(a.id) ?? 0;
      if (amount === 0) continue;
      push({ key: `onbekend:${a.id}`, label: `${a.id} ${a.name}`, input: { kind: amount > 0 ? 'vordering' : 'schuld', description: a.name, amount: Math.abs(amount), bron: 'xaf' }, include: false, note: 'niet herkend: neem over als het iets is wat je had of nog moest betalen' }, amount);
    }

    const equity = xaf.accounts.filter((a) => isBalance(cls.get(a.id)!) && cls.get(a.id) !== 'eigen-vermogen').reduce((t, a) => t + (balance.get(a.id) ?? 0), 0);
    const known = new Set(this.relations.list({ includeArchived: true }).map((r) => r.name.toLowerCase()));
    return {
      kind: xaf.version === 'kolommenbalans' || xaf.version === 'saldibalans' ? xaf.version : 'auditfile',
      meta: { software: xaf.software, version: xaf.version, fiscalYear: xaf.fiscalYear, startDate: xaf.startDate, endDate: xaf.endDate, company: xaf.company.name, accounts: xaf.accounts.length, lines: xaf.lines.length },
      date,
      suggestedDate,
      banks,
      proposals,
      relations: { total: xaf.relations.length, fresh: xaf.relations.filter((r) => !known.has(r.name.toLowerCase())).length },
      equity,
      accounts: xaf.accounts.map((a) => ({ id: a.id, name: a.name, rgs: a.rgs, class: cls.get(a.id)!, balance: balance.get(a.id) ?? 0 })).filter((a) => a.balance !== 0),
      warnings,
    };
  }

  /**
   * Overnemen wat de gebruiker aanvinkte. Eerder uit een auditfile overgenomen onderdelen worden
   * eerst weggehaald (niet als ze al betaald of afgeschreven zijn), zodat opnieuw inlezen niets dubbelt.
   */
  apply(file: string | Uint8Array, choices: XafApplyChoices, mapping?: ColumnMapping): SwitchoverState {
    const s = this.settings.get();
    if (s.switchover.mode !== 'overstapper' || !s.switchover.date) throw new ValidationError('Kies eerst een instapdatum');
    const src = this.source(file, mapping);
    if (src.type === 'table' && src.questions.length > 0) throw new ValidationError(src.questions[0]!.question);
    if (src.type === 'table' && src.kind === 'openstaande-posten') return this.applyOpenItems(this.planOpenItems(src.table, src.mapping), choices);
    const xaf = src.type === 'xaf' ? src.xaf : this.saldibalans(src.table, src.mapping);
    return this.applyXaf(xaf, choices);
  }

  private applyXaf(xaf: XafFile, choices: XafApplyChoices, history: XafFile[] = []): SwitchoverState {
    const s = this.settings.get();
    if (s.switchover.mode !== 'overstapper' || !s.switchover.date) throw new ValidationError('Kies eerst een instapdatum');
    const plan = this.plan(xaf, s.switchover.date, history);
    const same = (a: OpeningInput, b: OpeningInput) =>
      a.kind === b.kind &&
      ((a.kind === 'klant' && b.kind === 'klant' && a.number === b.number) ||
        (a.kind === 'leverancier' && b.kind === 'leverancier' && a.relationName === b.relationName && (a.reference ?? null) === (b.reference ?? null)) ||
        (a.kind === 'bezit' && b.kind === 'bezit' && a.name === b.name));
    // staat er al een lijst met losse facturen, dan gaat die voor: geen totaal voor die soort erbij, en
    // geen factuur die al op de lijst staat. Andere losse facturen uit de auditfile komen er gewoon bij.
    const listed = this.switchover.list().filter((i) => i.data.bron === 'lijst').map((i) => i.data);
    const isTotal = (p: OpeningInput) => (p.kind === 'klant' && p.number.startsWith('SALDO-')) || (p.kind === 'leverancier' && !p.reference);
    const covered = (p: OpeningInput) => listed.some((l) => same(l, p)) || (isTotal(p) && listed.some((l) => l.kind === p.kind));
    const include = new Set(choices.include);
    tx(this.db, () => {
      if (choices.relations) this.importRelations(xaf);
      // wat al betaald of afgeschreven is, blijft staan; dezelfde post uit de nieuwe export slaan we dan over
      const kept: OpeningInput[] = [];
      for (const item of this.switchover.list()) {
        if ((item.data as { bron?: string }).bron !== 'xaf') continue;
        if (item.locked) kept.push(item.data);
        else this.switchover.remove(item.id);
      }
      // beginsaldi van een vorige keer inlezen eerst terug op nul (misschien koppel je nu aan een andere rekening)
      for (const id of s.switchover.xafBanks ?? []) {
        if (this.bank.listAccounts().some((b) => b.id === id)) this.bank.setOpeningBalance(id, 0, plan.date);
      }
      const used: number[] = [];
      for (const b of plan.banks) {
        const target = choices.banks[b.accountId];
        if (target === null || target === undefined) continue;
        const id = target === 'nieuw' ? this.bank.addAccount(b.name, b.iban && !this.bank.listAccounts().some((x) => x.iban === b.iban) ? b.iban : null).id : target;
        this.switchover.setBankOpening(id, b.amount);
        used.push(id);
      }
      this.settings.update({ switchover: { ...this.settings.get().switchover, xafBanks: used } });
      // eerst de btw-periode: de omzet tot nu toe rekent daarmee
      const ordered = [...plan.proposals.filter((p) => p.input.kind === 'btw-periode'), ...plan.proposals.filter((p) => p.input.kind !== 'btw-periode')];
      for (const p of ordered) {
        if (!include.has(p.key) || kept.some((k) => same(k, p.input)) || covered(p.input)) continue;
        const existing = p.input.kind === 'btw' ? this.switchover.list().find((i) => i.kind === 'btw') : undefined;
        this.switchover.save(p.input, existing?.id);
      }
      this.switchover.setAccountantEquity(plan.equity);
    });
    return this.switchover.state();
  }

  /**
   * Lijst met openstaande posten overnemen. Wat er voor die soort (klanten of leveranciers) uit een
   * overzicht of een vorige lijst stond, gaat eruit (behalve wat al betaald is); de lijst komt ervoor in de plaats.
   */
  private applyOpenItems(plan: XafPlan, choices: XafApplyChoices): SwitchoverState {
    const include = new Set(choices.include);
    const kinds = new Set(plan.proposals.map((p) => (p.key.split(':')[1] === 'leverancier' ? 'leverancier' : 'klant')));
    tx(this.db, () => {
      const kept: OpeningInput[] = [];
      for (const item of this.switchover.list()) {
        if (!item.data.bron || !(item.kind === 'klant' || item.kind === 'leverancier' || item.data.bron === 'lijst') || !kinds.has(item.kind === 'leverancier' ? 'leverancier' : 'klant')) continue;
        if (item.locked) kept.push(item.data);
        else this.switchover.remove(item.id);
      }
      for (const p of plan.proposals) {
        if (!include.has(p.key)) continue;
        const i = p.input;
        // al betaald (blijft staan) of het nummer bestaat al in de app: niet nog een keer
        if (kept.some((k) => k.kind === i.kind && ((k.kind === 'klant' && i.kind === 'klant' && k.number === i.number) || (k.kind === 'leverancier' && i.kind === 'leverancier' && k.relationName === i.relationName && k.reference === i.reference)))) continue;
        if (i.kind === 'klant' && this.db.prepare('SELECT 1 FROM invoices WHERE number = ?').get(i.number)) continue;
        this.switchover.save(i);
      }
    });
    return this.switchover.state();
  }

  /** Klanten en leveranciers overnemen die de app nog niet kent (op naam); lege velden aanvullen. */
  private importRelations(xaf: XafFile): void {
    // alleen actieve relaties: een gearchiveerde zou naast een nieuwe met dezelfde naam komen te staan
    const existing = this.relations.list();
    for (const r of xaf.relations) {
      const type = r.type === 'S' ? 'leverancier' : r.type === 'B' ? 'beide' : 'klant';
      const match = existing.find((e) => e.name.toLowerCase() === r.name.toLowerCase() || (r.kvk && e.kvk_number === r.kvk) || (r.iban && e.iban === r.iban));
      const full = { name: r.name, type, email: r.email, phone: r.phone, address: r.address, postcode: r.postcode, city: r.city, country: r.country ?? 'NL', vat_number: r.vatNumber, kvk_number: r.kvk, iban: r.iban } as const;
      try {
        if (match) {
          const patch = Object.fromEntries(Object.entries(full).filter(([k, v]) => v && k !== 'name' && k !== 'type' && !(match as unknown as Record<string, unknown>)[k]));
          if (Object.keys(patch).length > 0) this.relations.update(match.id, patch);
        } else existing.push(this.relations.create(full));
      } catch {
        // een ongeldig btw-nummer of IBAN in de oude administratie: dan alleen de naam
        if (!match) existing.push(this.relations.create({ name: r.name, type }));
      }
    }
  }
}

/**
 * Wanneer een bus of gereedschap gekocht is: de eerste debetboeking op die rekening(en) in de
 * auditfiles, als het oudste bestand dat de rekening kent er nog geen beginsaldo op had (anders is
 * hij van vóór alle bestanden en weet de app het niet). Null als het niet vast te stellen is.
 */
export function acquisitionDate(files: XafFile[], accountIds: string[], until: IsoDate): IsoDate | null {
  if (accountIds.length === 0) return null;
  const ids = new Set(accountIds);
  const knowing = files.filter((f) => f.accounts.some((a) => ids.has(a.id))).sort((a, b) => a.startDate.localeCompare(b.startDate));
  const oldest = knowing[0];
  if (!oldest || oldest.totalsOnly) return null;
  if (oldest.opening.lines.some((l) => ids.has(l.accountId) && l.amount !== 0)) return null;
  const debits = knowing.flatMap((f) => f.lines).filter((l) => ids.has(l.accountId) && l.amount > 0 && l.date <= until).map((l) => l.date).sort();
  return debits[0] ?? null;
}
