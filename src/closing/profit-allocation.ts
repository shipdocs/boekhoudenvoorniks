import type { Db } from '../db/database';
import { MAX_PARTNERS, allocateCents, partnerAccounts, partnersActive, privateAccountsFor, shareBp, type Partner, type PrivateAccounts } from '../shared/partners';
import type { Cents } from '../shared/money';

/**
 * Winstverdeling van een vof of maatschap. Er is geen echte afsluitboeking (zie reports/opening-balance.ts): de
 * beginbalans van een jaar rekent het resultaat van elk eerder jaar uit en verdeelt het naar winstaandeel over de
 * kapitaalrekeningen van de vennoten. Is een jaar afgesloten (of ligt het bij de boekhouder), dan ligt de verdeling
 * van dat jaar vast in `vof_winstverdeling`: een latere wijziging van de vennoten verandert alleen open jaren.
 */

export interface VofSetup {
  partners: Partner[];
  /** vanaf dit boekjaar wordt de winst verdeeld; daarvóór gaat hij naar vennoot 1 */
  fromYear: number;
}

export interface PartnerShare {
  no: number;
  /** basispunten, samen 10000 */
  bp: number;
}

/** "verdelen vanaf" als er geen jaar is ingesteld: later dan elk boekjaar */
const NOT_ALLOCATED = 9999;

function setting<T>(db: Db, key: string, fallback: T): T {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : fallback;
}

/** De vennoten zoals ze in de administratie staan, of null (geen vof, of nog niet ingesteld). */
export function vofSetup(db: Db): VofSetup | null {
  const legalForm = setting<'eenmanszaak' | 'vof' | 'bv' | null>(db, 'legalForm', null);
  const partners = setting<Partner[]>(db, 'partners', []);
  if (!partnersActive({ legalForm, partners })) return null;
  // ontbreekt het jaar (de instellingen eisen het, maar een oude of bewerkte administratie kan het missen): niets
  // verdelen, alles blijft bij vennoot 1. Nooit de klok: dan zou een verdeling op 1 januari vanzelf verspringen.
  return { partners, fromYear: setting<number | null>(db, 'partnerAllocationFromYear', null) ?? NOT_ALLOCATED };
}

/**
 * Op welke privérekeningen een privéboeking komt, voor een service die alleen de database heeft. Vof met vennoten:
 * die van `partnerNo`; zonder keuze een fout (nooit stil de eerste vennoot). Anders de gewone.
 */
export function privateAccountsIn(db: Db, partnerNo?: number | null): PrivateAccounts {
  const setup = vofSetup(db);
  return privateAccountsFor(setup ? { legalForm: 'vof', partners: setup.partners } : { legalForm: null, partners: [] }, partnerNo);
}

function frozen(db: Db, year: number): PartnerShare[] {
  return (db.prepare('SELECT vennoot AS no, aandeel_bp AS bp FROM vof_winstverdeling WHERE jaar = ? ORDER BY vennoot').all(year) as PartnerShare[]);
}

/** De verdeling die voor `year` geldt: vastgelegd, of (open jaar) volgens de huidige vennoten. */
export function sharesForYear(db: Db, setup: VofSetup | null, year: number): PartnerShare[] {
  const fixed = frozen(db, year);
  if (fixed.length > 0) return fixed;
  if (!setup || year < setup.fromYear) return [{ no: 1, bp: 10000 }];
  return setup.partners.map((p) => ({ no: p.no, bp: shareBp(p.sharePct) }));
}

/** Verdeelt een resultaat (debet − credit, dus winst negatief) over de vennoten. */
export function allocateResult(amount: Cents, shares: PartnerShare[]): { no: number; amount: Cents }[] {
  const parts = allocateCents(amount, shares.map((s) => s.bp));
  return shares.map((s, i) => ({ no: s.no, amount: parts[i]! }));
}

/**
 * Legt de verdeling vast van elk boekjaar dat helemaal afgesloten is of bij de boekhouder ligt en nog geen vaste
 * verdeling heeft. Met `setup` = de vennoten van vóór een wijziging, zodat zo'n jaar niet met terugwerkende kracht
 * verandert. Zonder vennoten (`null`) gaat het hele resultaat naar vennoot 1, zoals het al stond.
 */
export function freezeClosedYears(db: Db, setup: VofSetup | null): void {
  const lastClosed = lastLockedYear(db);
  if (lastClosed === null) return;
  const first = (db.prepare('SELECT MIN(entry_date) AS d FROM journal_entries').get() as { d: string | null }).d;
  if (!first) return;
  const insert = db.prepare('INSERT OR IGNORE INTO vof_winstverdeling (jaar, vennoot, aandeel_bp) VALUES (?, ?, ?)');
  for (let year = Number(first.slice(0, 4)); year <= lastClosed; year++) {
    if (frozen(db, year).length > 0) continue;
    for (const s of sharesForYear(db, setup, year)) insert.run(year, s.no, s.bp);
  }
}

/** Het laatste boekjaar dat helemaal afgesloten is of bij de boekhouder ligt, of null. */
function lastLockedYear(db: Db): number | null {
  const lock = (db.prepare('SELECT MAX(until_date) AS d FROM ledger_locks').get() as { d: string | null }).d;
  if (!lock) return null;
  return lock.slice(5) === '12-31' ? Number(lock.slice(0, 4)) : Number(lock.slice(0, 4)) - 1;
}

/**
 * Na het afbreken van een uitwisseling: een jaar dat daardoor weer open is, volgt weer de huidige vennoten. Alleen
 * de vastlegging van jaren die nergens meer vastliggen verdwijnt; een afgesloten jaar blijft zoals het was.
 */
export function releaseOpenYears(db: Db): void {
  const lastClosed = lastLockedYear(db);
  if (lastClosed === null) db.prepare('DELETE FROM vof_winstverdeling').run();
  else db.prepare('DELETE FROM vof_winstverdeling WHERE jaar > ?').run(lastClosed);
}

/**
 * Heeft vennoot `no` al geschiedenis in de boeken: boekingen op zijn rekeningen, een vastgelegd aandeel in een
 * afgesloten jaar, of een aandeel in de winst van een open jaar met boekingen? Dan kan hij niet zomaar weg: zijn
 * vermogen zou ongemerkt bij een ander terechtkomen.
 */
export function partnerHasHistory(db: Db, no: number, setup: VofSetup | null): boolean {
  if (no < 1 || no > MAX_PARTNERS) return false;
  const a = partnerAccounts(no);
  const lines = db
    .prepare('SELECT 1 FROM journal_lines l JOIN chart_of_accounts c ON c.id = l.account_id WHERE c.rgs_code IN (?, ?, ?) LIMIT 1')
    .get(a.capital, a.drawings, a.contributions);
  if (lines) return true;
  if (db.prepare('SELECT 1 FROM vof_winstverdeling WHERE vennoot = ? AND aandeel_bp > 0 LIMIT 1').get(no)) return true;
  if (!setup) return false;
  const share = setup.partners.find((p) => p.no === no);
  if (!share || shareBp(share.sharePct) === 0) return false;
  const result = db
    .prepare(
      `SELECT 1 FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN chart_of_accounts c ON c.id = l.account_id
       WHERE c.category IN ('omzet', 'kosten') AND e.entry_date >= ? AND NOT EXISTS (SELECT 1 FROM vof_winstverdeling v WHERE v.jaar = CAST(substr(e.entry_date, 1, 4) AS INTEGER)) LIMIT 1`,
    )
    .get(`${setup.fromYear}-01-01`);
  return result !== undefined;
}
