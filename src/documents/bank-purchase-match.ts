import type { Db } from '../db/database';
import type { BankTransaction } from '../import/bank';
import type { DocumentResult } from '../intake/types';
import { ACCOUNTS } from '../core-ledger/accounts';
import { withinFx } from '../shared/currency';
import { addDays, diffDays, formatDateNl, type IsoDate } from '../shared/dates';
import { formatEuro, type Cents } from '../shared/money';
import { normalizeIban, ValidationError } from '../shared/validation';
import { supplierKey } from '../intake/supplier-memory';

/**
 * Eén gedeelde vergelijking "bank tegenover aankoop" (#221). Overal waar de app kijkt of een betaling en
 * een aankoop dezelfde uitgave zijn (vanzelf boeken, zelf indelen, de dubbel-controle en de vragen op
 * Vandaag) gelden de regels uit dit bestand: bedrag, leverancier en datumvenster zijn overal hetzelfde.
 * De matcher boekt nooit; hij leest en onthoudt alleen welke paren de gebruiker heeft afgewezen.
 */

/** De betaling staat tot zoveel dagen vóór de datum van de aankoop (betaald aan de kassa, factuur later)... */
export const BANK_DAYS_BEFORE = 10;
/** ...en tot zoveel dagen erna (een factuur in dollars wordt vaak pas later met de kaart betaald)... */
export const BANK_DAYS_AFTER = 20;
/** ...of tot zoveel dagen na de vervaldatum (een rekening die te laat betaald is). */
export const DUE_DAYS_AFTER = 14;
/** Zo dicht bij de datum is zeker genoeg: voor wat vanzelf mag, en voor de oude regel in euro's zonder naam. */
export const SURE_DAYS = 3;

/** Een betaling en een aankoop die misschien dezelfde uitgave zijn. */
export interface Pair {
  purchaseId: number;
  bankTransactionId: number;
}

/** De sleutel van de vraag "staat deze aankoop dubbel?"; een "nee" op dit paar staat zo in `task_skips`. */
export const pairKey = (p: Pair): string => `dubbel-${p.purchaseId}-${p.bankTransactionId}`;

/** Bewijs bij de boeking van een afschrijving waar een aankoop mee is samengevoegd (zie `markMerged`). */
const MERGED_NOTE = 'samengevoegd';

/**
 * Een aankoop gaat weg: wat de gebruiker over die aankoop afwees, gaat mee. Het nummer van een aankoop
 * wordt in de database opnieuw gebruikt; anders zou de volgende aankoop het "nee" van de vorige erven.
 */
export function forgetRejections(db: Db, purchaseId: number): void {
  db.prepare(`DELETE FROM task_skips WHERE task_key LIKE ?`).run(`dubbel-${purchaseId}-%`);
}

/** Wat de vergelijking van een aankoop nodig heeft. */
export interface PurchaseProbe {
  id: number;
  relation_id: number | null;
  relation_name: string | null;
  description: string;
  invoice_date: IsoDate;
  due_date: IsoDate | null;
  total: Cents;
  amount_paid: Cents;
  currency: string | null;
  foreign_total: Cents | null;
  status: 'open' | 'betaald';
  supplier_reference: string | null;
  is_opening: number;
  /** (een deel van) de aankoop staat op "weet ik nog niet" */
  question: boolean;
  /** het rekeningnummer op de factuur, anders dat van de leverancier (#227) */
  payee_iban?: string | null;
}

/** open = nog (deels) te betalen; elders = betaald met privégeld of contant (niet via de bank). */
export type PurchaseState = 'open' | 'elders';
/** gelijk = precies; koers = andere munt, binnen de koersmarge; ongeveer = euro's, een klein verschil. */
export type AmountFit = 'gelijk' | 'koers' | 'ongeveer';
/** onbekend = de aankoop heeft geen naam, of de bank noemt geen tegenpartij. */
export type SupplierFit = 'ja' | 'onbekend' | 'nee';
export type Debit = Pick<BankTransaction, 'amount' | 'transaction_date' | 'counter_name' | 'description' | 'reference'> & { counter_iban?: string | null };

export interface Fit {
  amount: AmountFit;
  supplier: SupplierFit;
  /** binnen het datumvenster, of het factuurnummer staat in de omschrijving van de bank */
  inWindow: boolean;
  /** dagen van de datum van de aankoop tot de betaling (negatief = eerder betaald) */
  days: number;
  /** sterk = bedrag, leverancier en datum passen; zwak = genoeg om niet vanzelf te boeken en het te vragen */
  strength: 'sterk' | 'zwak';
}

/** Een aankoop met hoe hij ervoor staat; `via` zegt bij "elders" hoe hij betaald is (null = gemengd). */
export interface PurchaseEntry {
  probe: PurchaseProbe;
  state: PurchaseState;
  via: 'prive' | 'kas' | null;
}

export interface PurchaseFit extends Fit {
  purchase: PurchaseProbe;
  state: PurchaseState;
  via: 'prive' | 'kas' | null;
}

/**
 * De vraag bij een nieuwe afschrijving. open/elders = één aankoop past (met één klik te koppelen);
 * kijken = meer aankopen passen, of het bedrag klopt maar ongeveer: de gebruiker kiest op het bankscherm.
 * `strong`: zolang de vraag niet beantwoord is, kan de betaling niet anders ingedeeld worden.
 */
export interface PaymentQuestion {
  kind: 'open' | 'elders' | 'kijken';
  strong: boolean;
  fit: PurchaseFit;
  others: PurchaseFit[];
}

/**
 * Geld dat binnenkomt tegenover een open creditnota van een leverancier (#227). `strong`: het bedrag is wat
 * er nog terug moet komen en de leverancier past (naam, nummer of rekeningnummer); dan eerst "Ja" of "Nee".
 */
export interface CreditFit {
  purchase: PurchaseProbe;
  /** wat er nog terug moet komen (boven nul) */
  open: Cents;
  sameAmount: boolean;
  sameSupplier: boolean;
  strong: boolean;
}

/** Alle aankopen die mee kunnen doen en de afgewezen paren: één keer laden per ronde. */
export interface PurchaseIndex {
  purchases: PurchaseEntry[];
  rejected: Set<string>;
}

function compact(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Staat dit (factuur)nummer in de tekst van de bank? Voor een eigen factuurnummer; ruim, over leestekens heen. */
export function mentionsNumber(haystack: string, number: string | null): boolean {
  if (!number) return false;
  const n = compact(number);
  if (n.length < 3) return false;
  const h = compact(haystack);
  if (h.includes(n)) return true;
  // "factuur 42" matcht "2026-0042": vergelijk ook het volgnummer zonder voorloopnullen
  const seq = /(\d+)$/.exec(number)?.[1]?.replace(/^0+/, '');
  const year = /(\d{4})/.exec(number)?.[1];
  if (seq && seq.length >= 2 && year) return new RegExp(`${year}\\D{0,3}0*${seq}(?!\\d)`).test(haystack.toLowerCase());
  return false;
}

/**
 * Staat het nummer van de bon of factuur van een leverancier in de tekst van de bank? Strenger dan bij een
 * eigen factuurnummer, want hier hangt aan of een betaling en een aankoop bij elkaar horen. Het nummer
 * moet er als los nummer staan: niet samengetrokken over leestekens heen ("14:21" is niet bon "1421") en
 * niet midden in een langer nummer. Alleen cijfers telt pas vanaf vijf: een kort bonnummer staat te vaak
 * toevallig in een omschrijving (een tijd, een pasnummer).
 */
export function mentionsReference(haystack: string, number: string | null): boolean {
  if (!number) return false;
  const parts = number.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const n = parts.join('');
  if (n.length < 3 || (/^\d+$/.test(n) && n.length < 5)) return false;
  const text = haystack.toLowerCase();
  // ervoor en erna geen teken van dezelfde soort: "NR2026-0042" telt, "12026-0042" en "2026-00421" niet
  const edge = (c: string) => (/\d/.test(c) ? '\\d' : '[a-z]');
  if (new RegExp(`(?<!${edge(n[0]!)})${parts.join('[^a-z0-9]{0,2}')}(?!${edge(n[n.length - 1]!)})`).test(text)) return true;
  // "2026-42" bij "2026-0042": ook het volgnummer zonder voorloopnullen, achter het jaar
  const seq = /(\d+)$/.exec(number)?.[1]?.replace(/^0+/, '');
  const year = /(\d{4})/.exec(number)?.[1];
  return Boolean(seq && seq.length >= 2 && year && new RegExp(`(?<!\\d)${year}\\D{0,3}0*${seq}(?!\\d)`).test(text));
}

/** De naam van de leverancier: de relatie, anders het deel na " — " in de omschrijving ("Software — Wolkendienst"). */
export function purchaseSupplierName(p: Pick<PurchaseProbe, 'relation_name' | 'description'>): string | null {
  if (p.relation_name?.trim()) return p.relation_name;
  const i = p.description.lastIndexOf(' — ');
  const name = i >= 0 ? p.description.slice(i + 3).trim() : '';
  return name || null;
}

/** Woorden die niets over de leverancier zeggen: daar begint de naam van te veel bedrijven mee. */
const STOP_WORDS = new Set(['de', 'het', 'van', 'een', 'the', 'studio', 'bureau', 'hotel', 'restaurant', 'garage', 'stichting', 'gemeente']);

/**
 * Zelfde leverancier, ook bij een andere schrijfwijze: "Wolkendienst Inc." op de factuur en "WOLKENDIENST"
 * op de bank, "wolkendienst.io" en "Wolkendienst IO". Gelijk op de genormaliseerde naam, of (vanaf vier
 * tekens) de ene naam begint met de andere, of het eerste woord is gelijk (minstens drie letters en geen
 * algemeen woord: "Studio Noord" is niet "Studio Zuid").
 */
export function sameSupplierName(a: string, b: string): boolean {
  const [ka, kb] = [supplierKey(a), supplierKey(b)];
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  const [ca, cb] = [ka.replace(/\s+/g, ''), kb.replace(/\s+/g, '')];
  if (Math.min(ca.length, cb.length) >= 4 && (ca.startsWith(cb) || cb.startsWith(ca))) return true;
  const first = ka.split(' ')[0]!;
  return first === kb.split(' ')[0] && first.length >= 3 && !STOP_WORDS.has(first);
}

/**
 * Alleen op de naam. Een afschrift van een kaart of betaaldienst zet de winkel vaak achter een
 * voorvoegsel of in de omschrijving ("Card Payment: Printhuis", "PAYPAL *MIRO"): dan telt het eerste woord
 * van de naam (minstens vier letters) als het als heel woord in de tekst van de bank staat.
 */
export function supplierNameFit(t: Pick<Debit, 'counter_name' | 'description'>, p: Pick<PurchaseProbe, 'relation_name' | 'description'>): SupplierFit {
  const name = purchaseSupplierName(p);
  if (!name) return 'onbekend';
  if (t.counter_name && sameSupplierName(name, t.counter_name)) return 'ja';
  const first = supplierKey(name).split(' ')[0] ?? '';
  if (first.length >= 4 && !STOP_WORDS.has(first)) {
    const words = `${t.counter_name ?? ''} ${t.description}`.toLowerCase().split(/[^a-z]+/);
    if (words.includes(first)) return 'ja';
  }
  return t.counter_name?.trim() ? 'nee' : 'onbekend';
}

/** Hetzelfde rekeningnummer, hoe het ook geschreven is (spaties, kleine letters); zonder nummer: nee. */
export function sameIban(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b) && normalizeIban(a!) === normalizeIban(b!);
}

/**
 * Past de leverancier? Het factuurnummer in de omschrijving of het kenmerk van de bank is ook genoeg, net
 * als het rekeningnummer van de factuur (#227): dan doet de naam op het afschrift er niet toe.
 */
export function supplierFit(t: Debit, p: Pick<PurchaseProbe, 'relation_name' | 'description' | 'supplier_reference' | 'payee_iban'>): SupplierFit {
  if (mentionsReference(`${t.description} ${t.reference ?? ''}`, p.supplier_reference)) return 'ja';
  if (sameIban(t.counter_iban, p.payee_iban)) return 'ja';
  return supplierNameFit(t, p);
}

/**
 * Past het bedrag van de bank bij wat de betaling moet dekken (`due`)? Een aankoop in een andere munt
 * (#74): de bank rekende een eigen koers, dus binnen de koersmarge (`withinFx`). In euro's is zo'n klein
 * verschil alleen "ongeveer": genoeg om te vragen, nooit om met één klik te koppelen.
 */
export function amountFit(bankEuro: Cents, due: Cents, currency: string | null): AmountFit | null {
  if (due <= 0 || bankEuro <= 0) return null;
  if (bankEuro === due) return 'gelijk';
  if (!withinFx(bankEuro, due)) return null;
  return currency && currency !== 'EUR' ? 'koers' : 'ongeveer';
}

/** Het venster waarin de betaling van deze aankoop hoort te staan. */
function paymentWindow(p: Pick<PurchaseProbe, 'invoice_date' | 'due_date'>): { from: IsoDate; to: IsoDate } {
  const after = addDays(p.invoice_date, BANK_DAYS_AFTER);
  const afterDue = p.due_date ? addDays(p.due_date, DUE_DAYS_AFTER) : after;
  return { from: addDays(p.invoice_date, -BANK_DAYS_BEFORE), to: afterDue > after ? afterDue : after };
}

/** Staat de betaling binnen het venster rond de datum van de aankoop (of kort na de vervaldatum)? */
export function dateFits(p: Pick<PurchaseProbe, 'invoice_date' | 'due_date'>, bankDate: IsoDate): boolean {
  const { from, to } = paymentWindow(p);
  return bankDate >= from && bankDate <= to;
}

/** Wat de betaling moet dekken: bij een open aankoop wat er nog open staat, anders het hele bedrag. */
export function dueOf(p: Pick<PurchaseProbe, 'total' | 'amount_paid'>, state: PurchaseState): Cents {
  return state === 'open' ? p.total - p.amount_paid : p.total;
}

/**
 * Een afschrijving tegenover een aankoop: hoe goed passen bedrag, leverancier en datum? null = past niet.
 * Een aankoop die al privé of contant betaald is, telt alleen mee als leverancier en datum passen (het
 * bedrag mag in euro's een klein beetje afwijken: dat is zwak, een vraag); een open aankoop ook bij minder
 * (zie `Fit.strength`). Staat het factuurnummer in de omschrijving, dan telt de datum als passend: dat
 * vangt een verkeerd gelezen datum op de bon.
 */
export function fitOf(t: Debit, p: PurchaseProbe, state: PurchaseState): Fit | null {
  if (t.amount >= 0 || p.total <= 0) return null;
  const amount = amountFit(-t.amount, dueOf(p, state), p.currency);
  if (!amount) return null;
  const supplier = supplierFit(t, p);
  const inWindow = mentionsReference(`${t.description} ${t.reference ?? ''}`, p.supplier_reference) || dateFits(p, t.transaction_date);
  const base = { amount, supplier, inWindow, days: diffDays(p.invoice_date, t.transaction_date) };
  if (amount !== 'ongeveer' && supplier === 'ja' && inWindow) return { ...base, strength: 'sterk' };
  // dezelfde leverancier rond de datum, het bedrag in euro's net anders (met de hand ingevoerd, de bank rekende
  // een eigen koers): ook naast een aankoop die al privé of contant betaald staat niet vanzelf als kosten (#222)
  const near = amount === 'ongeveer' && supplier === 'ja' && inWindow;
  if (state !== 'open') return near ? { ...base, strength: 'zwak' } : null;
  const weak =
    amount === 'gelijk' || // zoals het altijd al was: nooit vanzelf kosten boeken naast een open aankoop met dit bedrag
    (amount === 'koers' && supplier === 'ja') || // de datum is verkeerd gelezen, of het is veel later betaald
    // binnen de koers en rond de datum, ook met een andere naam op het afschrift (een betaaldienst): liever
    // een vraag te veel dan de betaling vanzelf als losse kosten naast de aankoop
    (amount === 'koers' && inWindow) ||
    near;
  return weak ? { ...base, strength: 'zwak' } : null;
}

/** Een gelezen bon of factuur als aankoop, om te vergelijken; null zonder totaal of datum. */
export function probeOfDocument(r: DocumentResult): PurchaseProbe | null {
  if (!r.total || !r.invoiceDate) return null;
  return {
    id: 0,
    relation_id: null,
    relation_name: r.supplier?.value ?? null,
    description: '',
    invoice_date: r.invoiceDate.value,
    due_date: r.dueDate?.value ?? null,
    total: r.total.value,
    amount_paid: 0,
    currency: r.foreign?.currency ?? null,
    foreign_total: r.foreign?.total ?? null,
    status: 'open',
    supplier_reference: r.invoiceNumber?.value ?? null,
    is_opening: 0,
    question: false,
    payee_iban: r.supplierIban?.value ?? null,
  };
}

/** "de aankoop bij Printhuis van 3 september 2026", voor in een vraag of melding. */
export function describePurchase(p: Pick<PurchaseProbe, 'relation_name' | 'description' | 'invoice_date'>): string {
  const name = purchaseSupplierName(p);
  return `de aankoop ${name ? `bij ${name}` : `"${p.description}"`} van ${formatDateNl(p.invoice_date)}`;
}

/**
 * Kan deze aankoop dubbel staan met een betaling die al los geboekt is? Alleen een aankoop waar nog
 * niets via de bank op betaald is, en niet een rekening uit de vorige administratie (die raakt de beginbalans).
 */
export function isDoubleCandidate(e: PurchaseEntry): boolean {
  return e.probe.is_opening === 0 && (e.state === 'elders' || e.probe.amount_paid === 0);
}

const PROBE_COLUMNS = `p.id, p.relation_id, r.name AS relation_name, p.description, p.invoice_date, p.due_date, p.total, p.amount_paid, p.currency, p.foreign_total, p.status, p.supplier_reference, p.is_opening,
       COALESCE(p.payee_iban, r.iban) AS payee_iban,
       EXISTS (SELECT 1 FROM purchase_invoice_lines l JOIN chart_of_accounts a ON a.id = l.account_id WHERE l.purchase_invoice_id = p.id AND a.rgs_code = @vraag) AS question,
       EXISTS (SELECT 1 FROM bank_transactions b WHERE b.matched_purchase_invoice_id = p.id) AS banked`;

/** Een afschrijving waar al een aankoop mee is samengevoegd: dat staat als bewijs bij de boeking ervan. */
const MERGED_SQL = `SELECT 1 FROM journal_entries je JOIN event_evidence ev ON ev.event_id = je.event_id WHERE je.id = bank_transactions.matched_journal_entry_id AND ev.kind = 'inkoop' AND ev.note = '${MERGED_NOTE}'`;

type ProbeRow = Omit<PurchaseProbe, 'question'> & { question: number; banked: number };
type ElsewherePayment = { id: number; amount: Cents; via: 'prive' | 'kas'; date: IsoDate };
/**
 * `question`: ook wat op "weet ik nog niet" staat; `skip`: betalingen die niet meedoen; `pool`/`rejected`:
 * al geladen, bij een lus over veel aankopen; `merged`: ook een betaling waar al een aankoop mee is
 * samengevoegd (voor een losse bon: die betaling heeft nog geen bon).
 */
type BookedOptions = { question?: boolean; skip?: (t: BankTransaction) => boolean; pool?: BankTransaction[]; rejected?: Set<string>; merged?: boolean };
/** `strong`: bedrag, leverancier en datum passen; `sure`: er is geen andere die ook past (alleen dan mag er iets vanzelf). */
export interface BookedMatch {
  transaction: BankTransaction;
  strong: boolean;
  sure: boolean;
}

const closest = <T extends { days: number }>(a: T, b: T) => Math.abs(a.days) - Math.abs(b.days);

/**
 * De gedeelde matcher. Zoekt bij een afschrijving de aankopen die erbij kunnen horen (open, of als privé
 * of contant betaald gezet), en bij een aankoop de afschrijvingen (nieuw, of al los geboekt als kosten of
 * op "weet ik nog niet").
 */
export class BankPurchaseMatcher {
  constructor(private readonly db: Db) {}

  /** Betalingen met privégeld of contant (geen bank) die nog gelden, per aankoop; of van één aankoop. */
  private elsewhere(purchaseId?: number): Map<number, ElsewherePayment[]> {
    const rows = this.db
      .prepare(
        `SELECT e.source_ref, e.id, e.entry_date AS date, SUM(l.debit) AS amount,
                CASE WHEN EXISTS (SELECT 1 FROM journal_lines k JOIN chart_of_accounts c ON c.id = k.account_id WHERE k.journal_entry_id = e.id AND c.rgs_code = @kas) THEN 'kas' ELSE 'prive' END AS via
           FROM journal_entries e
           JOIN journal_lines l ON l.journal_entry_id = e.id JOIN chart_of_accounts a ON a.id = l.account_id
          WHERE ${purchaseId === undefined ? `e.source_ref LIKE 'purchase:%'` : 'e.source_ref = @ref'} AND e.status <> 'teruggedraaid' AND e.reverses_entry_id IS NULL AND a.rgs_code = @crediteuren
            AND EXISTS (SELECT 1 FROM journal_lines m JOIN chart_of_accounts b ON b.id = m.account_id WHERE m.journal_entry_id = e.id AND b.rgs_code IN (@prive, @kas))
          GROUP BY e.id ORDER BY e.id`,
      )
      .all({ kas: ACCOUNTS.kas, crediteuren: ACCOUNTS.crediteuren, prive: ACCOUNTS.priveStortingen, ...(purchaseId === undefined ? {} : { ref: `purchase:${purchaseId}` }) }) as (ElsewherePayment & { source_ref: string })[];
    const out = new Map<number, ElsewherePayment[]>();
    for (const { source_ref, ...payment } of rows) {
      const id = Number(source_ref.slice('purchase:'.length));
      out.set(id, [...(out.get(id) ?? []), payment]);
    }
    return out;
  }

  /** Betalingen van deze aankoop met privégeld of contant (geen bank), die nog gelden. */
  elsewherePayments(purchaseId: number): ElsewherePayment[] {
    return this.elsewhere(purchaseId).get(purchaseId) ?? [];
  }

  /** Hoe staat deze aankoop ervoor: open, elders betaald, of al via de bank afgehandeld (null)? */
  private entryOf(row: ProbeRow, payments: ElsewherePayment[]): PurchaseEntry | null {
    const { banked, question, ...rest } = row;
    const probe: PurchaseProbe = { ...rest, question: Boolean(question) };
    if (probe.total <= 0) return null; // creditnota's doen niet mee
    if (probe.status === 'open') return { probe, state: 'open', via: null };
    if (probe.is_opening || banked || payments.length === 0) return null;
    return { probe, state: 'elders', via: payments.every((x) => x.via === 'prive') ? 'prive' : payments.every((x) => x.via === 'kas') ? 'kas' : null };
  }

  /** `window`: alleen aankopen met een factuur- of vervaldatum in deze periode (voor de controle per tijdvak). */
  private entries(window?: { from: IsoDate; to: IsoDate }): PurchaseEntry[] {
    const rows = this.db
      .prepare(
        `SELECT ${PROBE_COLUMNS}
           FROM purchase_invoices p LEFT JOIN relations r ON r.id = p.relation_id
          WHERE p.total > 0 AND (p.status = 'open' OR (p.is_opening = 0 AND p.amount_paid > 0))
            ${window ? 'AND (p.invoice_date BETWEEN @from AND @to OR p.due_date BETWEEN @from AND @to)' : ''}
          ORDER BY p.id`,
      )
      .all({ vraag: ACCOUNTS.vraagposten, ...(window ?? {}) }) as ProbeRow[];
    const payments = rows.some((r) => r.status === 'betaald') ? this.elsewhere() : new Map<number, ElsewherePayment[]>();
    return rows.map((r) => this.entryOf(r, payments.get(r.id) ?? [])).filter((e): e is PurchaseEntry => e !== null);
  }

  private rejections(): Set<string> {
    return new Set((this.db.prepare(`SELECT task_key FROM task_skips WHERE task_key LIKE 'dubbel-%' AND fingerprint = 'x'`).all() as { task_key: string }[]).map((r) => r.task_key));
  }

  /** Alle aankopen die mee kunnen doen, met hun staat, en de afgewezen paren. */
  index(): PurchaseIndex {
    return { purchases: this.entries(), rejected: this.rejections() };
  }

  private row(purchaseId: number): ProbeRow | undefined {
    return this.db
      .prepare(`SELECT ${PROBE_COLUMNS} FROM purchase_invoices p LEFT JOIN relations r ON r.id = p.relation_id WHERE p.id = @id`)
      .get({ vraag: ACCOUNTS.vraagposten, id: purchaseId }) as ProbeRow | undefined;
  }

  /** Eén aankoop met zijn staat; null als hij niet (meer) mee kan doen, bv. al via de bank betaald. */
  entry(purchaseId: number): PurchaseEntry | null {
    const row = this.row(purchaseId);
    return row ? this.entryOf(row, row.status === 'betaald' ? this.elsewherePayments(purchaseId) : []) : null;
  }

  /** De gegevens van één aankoop, voor de vergelijking. */
  probe(purchaseId: number): PurchaseProbe | null {
    const row = this.row(purchaseId);
    if (!row) return null;
    const { banked: _banked, question, ...rest } = row;
    return { ...rest, question: Boolean(question) };
  }

  /**
   * Aankopen die bij deze afschrijving kunnen horen: sterk eerst, dan de dichtstbijzijnde datum.
   * Afgewezen paren ("Nee, iets anders") tellen niet mee.
   */
  forTransaction(t: BankTransaction, index: PurchaseIndex = this.index()): PurchaseFit[] {
    if (t.amount >= 0) return [];
    const out: PurchaseFit[] = [];
    for (const e of index.purchases) {
      const fit = fitOf(t, e.probe, e.state);
      if (!fit || index.rejected.has(pairKey({ purchaseId: e.probe.id, bankTransactionId: t.id }))) continue;
      out.push({ ...fit, purchase: e.probe, state: e.state, via: e.via });
    }
    return out.sort((a, b) => Number(b.strength === 'sterk') - Number(a.strength === 'sterk') || closest(a, b) || a.purchase.id - b.purchase.id);
  }

  /** De vraag die bij deze afschrijving hoort, of null als er geen aankoop bij past. */
  question(t: BankTransaction, index?: PurchaseIndex): PaymentQuestion | null {
    const fits = this.forTransaction(t, index);
    if (fits.length === 0) return null;
    const strong = fits.filter((f) => f.strength === 'sterk');
    if (strong.length === 1) return { kind: strong[0]!.state, strong: true, fit: strong[0]!, others: [] };
    if (strong.length > 1) return { kind: 'kijken', strong: true, fit: strong[0]!, others: strong.slice(1) };
    // alleen zwakke: met één klik als er precies één is en het bedrag klopt (gelijk, of binnen de koers)
    const [first, ...others] = fits;
    return { kind: others.length === 0 && first!.amount !== 'ongeveer' ? 'open' : 'kijken', strong: false, fit: first!, others };
  }

  /** Mag de app deze afschrijving niet vanzelf als kosten boeken? Bij elke aankoop die erbij kan horen. */
  blocksAuto(t: BankTransaction, index?: PurchaseIndex): boolean {
    return this.question(t, index) !== null;
  }

  /**
   * Mag de app deze afschrijving vanzelf aan deze open aankoop koppelen? Alleen als de aankoop sterk past en
   * er niets anders is dat ook past: geen andere aankoop bij deze betaling (open, of op privé of contant
   * betaald gezet), en geen andere onverwerkte afschrijving met dit bedrag aan deze leverancier (`pool`).
   * Staat het factuurnummer in de omschrijving, dan telt alleen wat dat nummer ook noemt: een nummer wijst
   * één aankoop aan, een naam of rekeningnummer niet.
   */
  sure(t: BankTransaction, purchaseId: number, index: PurchaseIndex, pool: BankTransaction[]): boolean {
    const strong = this.forTransaction(t, index).filter((f) => f.strength === 'sterk');
    const own = strong.find((f) => f.purchase.id === purchaseId);
    if (!own || own.state !== 'open') return false;
    const numbered = (x: BankTransaction, p: PurchaseProbe) => mentionsReference(`${x.description} ${x.reference ?? ''}`, p.supplier_reference);
    const byNumber = numbered(t, own.purchase);
    if (strong.some((f) => f !== own && (!byNumber || numbered(t, f.purchase)))) return false;
    return !pool.some((x) => {
      if (x.id === t.id || x.status !== 'nieuw' || index.rejected.has(pairKey({ purchaseId, bankTransactionId: x.id }))) return false;
      const fit = fitOf(x, own.purchase, 'open');
      return !!fit && fit.amount !== 'ongeveer' && fit.supplier === 'ja' && (!byNumber || numbered(x, own.purchase));
    });
  }

  /**
   * De open creditnota's van leveranciers bij geld dat binnenkomt (#227): alle, om uit te kiezen op het scherm
   * van de betaling; wat sterk past eerst. Een creditnota waar de gebruiker bij dit geld "Nee" op zei, past
   * niet meer sterk (hij blijft wel te kiezen).
   */
  creditsFor(t: BankTransaction): CreditFit[] {
    if (t.amount <= 0) return [];
    const rows = this.db
      .prepare(`SELECT ${PROBE_COLUMNS} FROM purchase_invoices p LEFT JOIN relations r ON r.id = p.relation_id WHERE p.total < 0 AND p.status = 'open' AND p.amount_paid > p.total ORDER BY p.invoice_date, p.id`)
      .all({ vraag: ACCOUNTS.vraagposten }) as ProbeRow[];
    const rejected = this.rejections();
    return rows
      .map(({ banked: _banked, question, ...rest }): CreditFit => {
        const purchase: PurchaseProbe = { ...rest, question: Boolean(question) };
        const open = purchase.amount_paid - purchase.total;
        // in een andere munt rekent de bank een eigen koers: dan ook binnen de koersmarge
        const sameAmount = t.amount === open || Boolean(purchase.currency && purchase.currency !== 'EUR' && withinFx(t.amount, open));
        const sameSupplier = supplierFit(t, purchase) === 'ja';
        return { purchase, open, sameAmount, sameSupplier, strong: sameAmount && sameSupplier && !rejected.has(pairKey({ purchaseId: purchase.id, bankTransactionId: t.id })) };
      })
      .sort((a, b) => Number(b.strong) - Number(a.strong));
  }

  /**
   * Bij zelf indelen: past er een aankoop sterk bij, dan eerst "Ja" of "Nee, iets anders". Gaat de betaling
   * naar "weet ik nog niet" (`account`), dan ook bij een aankoop die zwakker past (een andere naam op het
   * afschrift, zoals bij een betaaldienst) maar zelf ook op "weet ik nog niet" staat, met dit bedrag rond
   * deze datum: anders staat hetzelfde bedrag daar twee keer en blijft de aankoop als schuld open (#223).
   * Geld dat binnenkomt en sterk bij een open creditnota van een leverancier past (#227): ook eerst die vraag,
   * anders wordt het omzet, of gaan de kosten een tweede keer omlaag, terwijl de creditnota open blijft.
   */
  assertAnswered(t: BankTransaction, account?: string): void {
    if (t.status !== 'nieuw') return;
    if (t.amount > 0) {
      const credit = this.creditsFor(t).find((c) => c.strong);
      if (!credit) return;
      const p = credit.purchase;
      const name = purchaseSupplierName(p);
      throw new ValidationError(
        `Dit geld lijkt het geld terug van de creditnota ${name ? `van ${name}` : `"${p.description}"`} van ${formatDateNl(p.invoice_date)} (${formatEuro(credit.open)}). Kies eerst "Ja" of "Nee, iets anders": geld terug van een leverancier is geen omzet, en de kosten zijn bij de creditnota al verlaagd.`,
      );
    }
    const q = this.question(t);
    if (!q) return;
    if (q.strong) {
      const p = q.fit.purchase;
      throw new ValidationError(`Deze betaling lijkt bij ${describePurchase(p)} (${formatEuro(p.total)}) te horen. Kies eerst "Ja" of "Nee, iets anders"; anders tellen de kosten twee keer.`);
    }
    if (account !== ACCOUNTS.vraagposten) return;
    const twice = [q.fit, ...q.others].find((f) => f.purchase.question && f.amount !== 'ongeveer' && f.inWindow)?.purchase;
    if (twice) throw new ValidationError(`Deze betaling kan bij ${describePurchase(twice)} (${formatEuro(twice.total)}) horen, en die staat ook op "weet ik nog niet". Kies eerst "Ja" of "Nee, iets anders"; anders staat het bedrag er twee keer.`);
  }

  /**
   * Afschrijvingen die los geboekt zijn als kosten, zonder factuur, aankoop of bon eraan (zoals een
   * abonnement dat de app vanzelf verwerkte). Met `question` ook wat op "weet ik nog niet" staat. Een
   * privé-opname, een eigen overboeking en een genegeerde of dubbele regel tellen niet. Een betaling waar
   * al een aankoop mee is samengevoegd ook niet (één betaling is één uitgave), behalve met `merged`.
   */
  bookedDebits(opts: { question?: boolean; from?: IsoDate; to?: IsoDate; merged?: boolean } = {}): BankTransaction[] {
    return this.db
      .prepare(
        `SELECT * FROM bank_transactions WHERE status = 'gematcht' AND amount < 0 AND matched_invoice_id IS NULL AND matched_purchase_invoice_id IS NULL
           ${opts.from ? 'AND transaction_date >= @from' : ''} ${opts.to ? 'AND transaction_date <= @to' : ''}
           AND NOT EXISTS (SELECT 1 FROM document_links k WHERE k.bank_transaction_id = bank_transactions.id)
           ${opts.merged ? '' : `AND NOT EXISTS (${MERGED_SQL})`}
           AND EXISTS (SELECT 1 FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id
                        WHERE l.journal_entry_id = bank_transactions.matched_journal_entry_id AND (a.category = 'kosten' OR a.rgs_code = @vraag))
         ORDER BY id`,
      )
      .all({ vraag: opts.question ? ACCOUNTS.vraagposten : '', ...(opts.from ? { from: opts.from } : {}), ...(opts.to ? { to: opts.to } : {}) }) as BankTransaction[];
  }

  /**
   * De afschrijvingen die sterk bij deze aankoop passen (bedrag, leverancier en datum), de dichtstbijzijnde
   * eerst: nog niet verwerkt (`nieuw`), of al los geboekt als kosten (`geboekt`; met `question` ook op
   * "weet ik nog niet"). Afgewezen paren en dubbele regels van de bank tellen niet mee.
   */
  transactionsFor(p: PurchaseProbe, state: PurchaseState, which: 'nieuw' | 'geboekt', opts: { question?: boolean } = {}): BankTransaction[] {
    // zonder factuurnummer kan alleen een betaling binnen het venster passen: dan niet alle betalingen ophalen
    const window = p.supplier_reference ? null : paymentWindow(p);
    const rows =
      which === 'geboekt'
        ? this.bookedDebits({ question: opts.question, ...(window ?? {}) })
        : (this.db
            .prepare(`SELECT * FROM bank_transactions WHERE status = 'nieuw' AND amount < 0 AND duplicate_of IS NULL ${window ? 'AND transaction_date BETWEEN @from AND @to' : ''} ORDER BY id`)
            .all(window ?? {}) as BankTransaction[]);
    const rejected = this.rejections();
    return rows
      .map((t) => ({ t, fit: fitOf(t, p, state) }))
      .filter((x): x is { t: BankTransaction; fit: Fit } => x.fit?.strength === 'sterk' && !rejected.has(pairKey({ purchaseId: p.id, bankTransactionId: x.t.id })))
      .sort((a, b) => closest(a.fit, b.fit) || a.t.id - b.t.id)
      .map((x) => x.t);
  }

  /** Is met deze los geboekte afschrijving al een aankoop samengevoegd? Dan kan er geen tweede bij. */
  merged(t: Pick<BankTransaction, 'id'>): boolean {
    return !!this.db.prepare(`SELECT 1 FROM bank_transactions WHERE id = ? AND EXISTS (${MERGED_SQL})`).get(t.id);
  }

  /**
   * Legt vast dat een aankoop is samengevoegd met deze afschrijving (de aankoop verviel, de betaling bleef
   * staan). Het staat als bewijs bij de boeking van de betaling: het gaat mee als de gebruiker een andere
   * categorie kiest, en vervalt als hij de verwerking ongedaan maakt.
   */
  markMerged(t: Pick<BankTransaction, 'matched_journal_entry_id'>): void {
    this.db
      .prepare(`INSERT INTO event_evidence (event_id, kind, ref_id, note) SELECT event_id, 'inkoop', NULL, ? FROM journal_entries WHERE id = ? AND event_id IS NOT NULL`)
      .run(MERGED_NOTE, t.matched_journal_entry_id);
  }

  /** Waar een los geboekte afschrijving op staat: kosten, "weet ik nog niet", of iets anders (null). */
  bookingOf(t: Pick<BankTransaction, 'matched_journal_entry_id'>): 'kosten' | 'vraag' | null {
    if (!t.matched_journal_entry_id) return null;
    const row = this.db
      .prepare(
        `SELECT MAX(a.category = 'kosten') AS kosten, MAX(a.rgs_code = ?) AS vraag
           FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id WHERE l.journal_entry_id = ?`,
      )
      .get(ACCOUNTS.vraagposten, t.matched_journal_entry_id) as { kosten: number | null; vraag: number | null };
    return row.kosten ? 'kosten' : row.vraag ? 'vraag' : null;
  }

  /**
   * De al los geboekte afschrijving die bij deze aankoop (of bon) hoort. Precies één sterke: die. Passen er
   * meer (elke week hetzelfde bedrag bij dezelfde winkel): de dichtstbijzijnde, als vraag. Geen sterke, in
   * euro's: precies één met hetzelfde bedrag binnen een paar dagen, ook zonder naam (zoals een
   * pinbetaling); twee is twijfel, dan niets. `sure`: de enige die past; alleen dan mag er iets vanzelf.
   */
  bookedMatch(p: PurchaseProbe, state: PurchaseState, opts: BookedOptions = {}): BookedMatch | null {
    if (p.total < 0) return this.bookedRefund(p, opts);
    const rejected = opts.rejected ?? this.rejections();
    // zonder factuurnummer kan alleen een betaling binnen het venster passen: dan niet alle betalingen ophalen
    const rows = (opts.pool ?? this.bookedDebits({ question: opts.question, merged: opts.merged, ...(p.supplier_reference ? {} : paymentWindow(p)) })).filter((t) => !opts.skip?.(t) && !rejected.has(pairKey({ purchaseId: p.id, bankTransactionId: t.id })));
    const strong = rows
      .map((t) => ({ t, fit: fitOf(t, p, state) }))
      .filter((x): x is { t: BankTransaction; fit: Fit } => x.fit?.strength === 'sterk')
      .sort((a, b) => closest(a.fit, b.fit) || a.t.id - b.t.id)
      .map((x) => x.t);
    // meer die passen: nooit zeker, maar wel een vraag (over de dichtstbijzijnde); na "nee" komt de volgende
    if (strong.length > 1) return { transaction: strong[0]!, strong: true, sure: false };
    const foreign = Boolean(p.currency && p.currency !== 'EUR');
    const due = dueOf(p, state);
    const near = foreign ? [] : rows.filter((t) => -t.amount === due && Math.abs(diffDays(p.invoice_date, t.transaction_date)) <= SURE_DAYS);
    if (strong.length === 1) return { transaction: strong[0]!, strong: true, sure: foreign || (near.length === 1 && near[0]!.id === strong[0]!.id) };
    return near.length === 1 ? { transaction: near[0]!, strong: false, sure: true } : null;
  }

  /**
   * Bij een creditnota: de terugbetaling die al los op een kostenrekening geboekt is, met precies dat
   * bedrag binnen een paar dagen en zonder bon eraan. Twee die passen is twijfel: dan niets.
   */
  private bookedRefund(p: PurchaseProbe, opts: BookedOptions): BookedMatch | null {
    const rejected = opts.rejected ?? this.rejections();
    const rows = (
      this.db
        .prepare(
          `SELECT * FROM bank_transactions WHERE status = 'gematcht' AND amount = @amount AND matched_invoice_id IS NULL AND matched_purchase_invoice_id IS NULL
             AND transaction_date BETWEEN @from AND @to
             AND NOT EXISTS (SELECT 1 FROM document_links k WHERE k.bank_transaction_id = bank_transactions.id)
             AND EXISTS (SELECT 1 FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id
                          WHERE l.journal_entry_id = bank_transactions.matched_journal_entry_id AND a.category = 'kosten')
           ORDER BY id`,
        )
        .all({ amount: -p.total, from: addDays(p.invoice_date, -SURE_DAYS), to: addDays(p.invoice_date, SURE_DAYS) }) as BankTransaction[]
    ).filter((t) => !opts.skip?.(t) && !rejected.has(pairKey({ purchaseId: p.id, bankTransactionId: t.id })));
    return rows.length === 1 ? { transaction: rows[0]!, strong: false, sure: false } : null;
  }

  /** Alleen de afschrijving uit `bookedMatch`, of null. */
  bookedFor(p: PurchaseProbe, state: PurchaseState, opts: BookedOptions = {}): BankTransaction | null {
    return this.bookedMatch(p, state, opts)?.transaction ?? null;
  }

  /** Is dit paar eerder met "Nee" afgewezen? */
  rejected(pair: Pair): boolean {
    return !!this.db.prepare(`SELECT 1 FROM task_skips WHERE task_key = ? AND fingerprint = 'x'`).get(pairKey(pair));
  }

  /** "Nee, dit hoort niet bij elkaar": dit paar komt nergens meer terug. */
  reject(pair: Pair): void {
    this.db.prepare(`INSERT INTO task_skips (task_key, fingerprint, reason) VALUES (?, 'x', 'nee') ON CONFLICT(task_key) DO UPDATE SET reason = excluded.reason`).run(pairKey(pair));
  }

  /**
   * "Nee, iets anders" bij een afschrijving: alle aankopen die er nu bij passen, komen er niet meer bij terug.
   * Bij geld dat binnenkomt: de creditnota's die er sterk bij passen.
   */
  rejectAll(t: BankTransaction): void {
    for (const f of this.forTransaction(t)) this.reject({ purchaseId: f.purchase.id, bankTransactionId: t.id });
    for (const c of this.creditsFor(t)) if (c.strong) this.reject({ purchaseId: c.purchase.id, bankTransactionId: t.id });
  }

  /**
   * Dubbele aankopen voor de btw-controle over een tijdvak: twee aankopen van dezelfde leverancier (ook
   * zonder relatie, of met een andere schrijfwijze van de naam) met hetzelfde bedrag rond dezelfde datum,
   * en een aankoop waarvan de betaling ook los als kosten of op "weet ik nog niet" op de bank staat.
   */
  doubles(start: IsoDate, end: IsoDate): { purchases: { a: PurchaseProbe; b: PurchaseProbe }[]; bank: { purchase: PurchaseProbe; transaction: BankTransaction }[] } {
    const near = (
      this.db
        .prepare(
          `SELECT ${PROBE_COLUMNS} FROM purchase_invoices p LEFT JOIN relations r ON r.id = p.relation_id
            WHERE p.total <> 0 AND p.is_opening = 0 AND p.invoice_date BETWEEN @from AND @to ORDER BY p.id`,
        )
        .all({ vraag: ACCOUNTS.vraagposten, from: addDays(start, -SURE_DAYS), to: addDays(end, SURE_DAYS) }) as ProbeRow[]
    ).map(({ banked: _banked, question, ...rest }): PurchaseProbe => ({ ...rest, question: Boolean(question) }));
    const purchases: { a: PurchaseProbe; b: PurchaseProbe }[] = [];
    for (const [j, b] of near.entries()) {
      for (const a of near.slice(0, j)) {
        if ((a.invoice_date < start || a.invoice_date > end) && (b.invoice_date < start || b.invoice_date > end)) continue;
        if (Math.abs(diffDays(a.invoice_date, b.invoice_date)) > SURE_DAYS || a.total > 0 !== b.total > 0) continue;
        // hetzelfde bedrag; in een andere munt mag het bedrag in euro's iets verschillen (andere koers)
        const foreign = (a.currency && a.currency !== 'EUR') || (b.currency && b.currency !== 'EUR');
        if (foreign ? !withinFx(a.total, b.total) : a.total !== b.total) continue;
        if (a.supplier_reference && b.supplier_reference && a.supplier_reference !== b.supplier_reference) continue;
        const [na, nb] = [purchaseSupplierName(a), purchaseSupplierName(b)];
        if ((a.relation_id !== null && a.relation_id === b.relation_id) || (na && nb && sameSupplierName(na, nb))) purchases.push({ a, b });
      }
    }
    const debits = this.bookedDebits({ question: true, from: start, to: end });
    const bank: { purchase: PurchaseProbe; transaction: BankTransaction }[] = [];
    if (debits.length > 0) {
      const rejected = this.rejections();
      const candidates = this.entries({ from: addDays(start, -(BANK_DAYS_AFTER + DUE_DAYS_AFTER)), to: addDays(end, BANK_DAYS_BEFORE) }).filter(isDoubleCandidate);
      for (const t of debits) {
        for (const e of candidates) {
          if (fitOf(t, e.probe, e.state)?.strength !== 'sterk' || rejected.has(pairKey({ purchaseId: e.probe.id, bankTransactionId: t.id }))) continue;
          bank.push({ purchase: e.probe, transaction: t });
        }
      }
    }
    return { purchases, bank };
  }
}
