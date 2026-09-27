import { tx, type Db } from '../db/database';
import { ACCOUNTS } from '../core-ledger/accounts';
import { signedLine, type Ledger, type PostLine } from '../core-ledger/ledger';
import type { SettingsService, SwitchoverSettings } from '../settings/settings';
import type { RelationsService } from '../relations/relations';
import type { BankService } from '../import/bank';
import type { VatService } from '../btw/btw';
import { addDays, assertIsoDate, diffDays, formatDateNl, periodFor, today, type IsoDate } from '../shared/dates';
import { formatEuro, type Cents } from '../shared/money';
import { ValidationError } from '../shared/validation';
import { parseUblSalesInvoice } from '../intake/ubl';
import { SKIPPABLE_SECTIONS } from '../shared/switchover';

/**
 * Overstappen met een lopende administratie.
 *
 * De gebruiker kiest een instapdatum D. Vanaf D boekt de app alles zelf (bankafschriften vanaf D,
 * facturen, bonnetjes). Wat er op D al was, komt erin als startbalans: elk onderdeel is een eigen
 * boeking met `source: 'opening'` tegen eigen vermogen. Eigen vermogen is zo het sluitstuk dat de app
 * zelf uitrekent: de vakman hoeft het niet te kennen.
 *
 *  - klanten die nog moesten betalen → echte facturen (is_opening) op Debiteuren, zonder omzet en btw
 *    (die zaten in de vorige administratie). Een betaling na D koppelt daar gewoon aan.
 *  - rekeningen die nog betaald moesten worden → inkoopfacturen (is_opening) op Crediteuren
 *  - bus en gereedschap → een bedrijfsmiddel met de boekwaarde op 1 januari als startwaarde;
 *    de app schrijft het hele jaar van D af (dus afschrijving niet meetellen in de kosten tot D)
 *  - btw die nog betaald moest worden of terugkwam → btw-afrekening
 *  - lening, borg of voorschot, andere schulden
 *  - D niet op 1 januari: de omzet en kosten van 1 januari tot D (anders klopt het jaaroverzicht
 *    voor de inkomstenbelasting niet)
 *  - D midden in een btw-periode: omzet en btw van het begin van die periode tot D. Die boeking telt
 *    wél mee in de btw-aangifte (`source: 'handmatig'`), zodat de eerste aangifte uit de app compleet is.
 *
 * Beginbalansboekingen tellen niet mee in de btw (VatService sluit `source = 'opening'` uit) en zijn
 * geen nieuwe investeringen (AssetService.sync slaat ze over). Aanpassen = terugdraaien en opnieuw.
 */

export type OpeningKind = 'klant' | 'leverancier' | 'bezit' | 'btw' | 'lening' | 'vordering' | 'schuld' | 'resultaat' | 'btw-periode';

export type OpeningInput = (
  | { kind: 'klant'; relationName: string; number: string; invoiceDate: IsoDate; dueDate?: IsoDate | null; amount: Cents }
  | { kind: 'leverancier'; relationName: string; reference?: string | null; invoiceDate: IsoDate; dueDate?: IsoDate | null; amount: Cents }
  | {
      kind: 'bezit';
      name: string;
      type: 'vervoer' | 'inventaris';
      acquiredOn: IsoDate;
      /** wat je er destijds voor betaalde (excl. btw) */
      cost: Cents;
      /** boekwaarde op 1 januari van het jaar van de instapdatum; bij een aankoop in dat jaar gelijk aan de prijs */
      bookValue: Cents;
      /** hoeveel jaar je het nog gebruikt */
      remainingYears: number;
    }
  | { kind: 'btw'; direction: 'betalen' | 'terug'; amount: Cents; description?: string }
  /** account 'kas': contant geld in de kas in plaats van een overige vordering */
  | { kind: 'lening' | 'vordering' | 'schuld'; description: string; amount: Cents; account?: 'kas' }
  | { kind: 'resultaat'; omzet: Cents; materiaal: Cents; auto: Cents; overig: Cents }
  | { kind: 'btw-periode'; omzetHoog: Cents; btwHoog: Cents; omzetLaag: Cents; btwLaag: Cents; omzetNul: Cents; voorbelasting: Cents }
) & {
  /** 'xaf': uit een auditfile, kolommen- of saldibalans; 'lijst': uit een lijst met openstaande posten (opnieuw inlezen vervangt het) */
  bron?: 'xaf' | 'lijst';
};

export interface OpeningItem {
  id: number;
  kind: OpeningKind;
  description: string;
  /** positief = iets van jou of wat je nog krijgt; negatief = wat je nog moet betalen; bij resultaat de winst */
  amount: Cents;
  data: OpeningInput;
  journal_entry_id: number | null;
  invoice_id: number | null;
  purchase_invoice_id: number | null;
  asset_id: number | null;
  /** al (deels) betaald of afgeschreven: niet meer aan te passen */
  locked: boolean;
  /** voor facturen en rekeningen: wat er nog open staat */
  open: Cents | null;
}

export interface PositionLine {
  key: string;
  label: string;
  amount: Cents;
}

export interface OpeningPosition {
  date: IsoDate;
  /** wat je had (bank, klanten die nog moeten betalen, bus, …) */
  bezittingen: PositionLine[];
  /** wat je nog moest betalen */
  schulden: PositionLine[];
  /** winst van 1 januari tot de instapdatum (null als je op 1 januari instapt) */
  winstTotNu: Cents | null;
  /** wat er van jou in de zaak zit: bezittingen min schulden */
  eigenVermogen: Cents;
}

export interface BankStatus {
  bankAccountId: number;
  name: string;
  iban: string | null;
  isPot: boolean;
  /** beginsaldo op de instapdatum, of null als nog niet opgegeven */
  opening: Cents | null;
  /** voorstel uit een afschrift met eindsaldo */
  suggestedOpening: { amount: Cents; basis: string } | null;
  coverageFrom: IsoDate | null;
  coverageTo: IsoDate | null;
  /** betalingen van vóór de instapdatum die nog niet overgeslagen zijn (horen bij de vorige administratie) */
  beforeDate: number;
  /** controle: saldo volgens de bank tegen saldo volgens de ingelezen afschriften */
  balanceCheck: { date: IsoDate; bank: Cents; computed: Cents; source: 'afschrift' | 'opgegeven' } | null;
  /** de gebruiker zei: deze rekening gebruik ik niet (meer) */
  unused: boolean;
}

export interface SwitchoverCheck {
  key: string;
  level: 'ok' | 'let-op' | 'probleem';
  title: string;
  detail: string;
  /** hoofdstuk in de wizard waar je het oplost */
  section: SectionKey;
}

export type SectionKey = 'papieren' | 'import' | 'bank' | 'klanten' | 'leveranciers' | 'bezit' | 'btw' | 'resultaat' | 'overig' | 'klaar';


export interface Requirement {
  key: string;
  label: string;
  hint: string;
  optional: boolean;
}

export interface OpeningSuggestion {
  txId: number;
  kind: 'klant' | 'leverancier' | 'btw';
  date: IsoDate;
  /** positief bedrag */
  amount: Cents;
  name: string;
  description: string;
  /** factuurnummer als dat in de omschrijving lijkt te staan */
  number: string | null;
  question: string;
}

export interface SwitchoverState {
  settings: SwitchoverSettings;
  kor: boolean;
  /** begint de instapdatum op 1 januari? */
  startOfYear: boolean;
  /** de btw-periode waar de instapdatum midden in valt (null: op een periodegrens of KOR) */
  splitPeriod: { key: string; label: string; start: IsoDate } | null;
  sections: { key: SectionKey; title: string; done: boolean; needed: boolean }[];
  items: OpeningItem[];
  banks: BankStatus[];
  position: OpeningPosition | null;
  checks: SwitchoverCheck[];
  requirements: Requirement[];
}

interface ItemRow {
  id: number;
  kind: OpeningKind;
  description: string;
  amount: Cents;
  data: string;
  journal_entry_id: number | null;
  invoice_id: number | null;
  purchase_invoice_id: number | null;
  asset_id: number | null;
}

/** Een post van vóór de overstap die na zoveel dagen nog open staat, is het navragen waard. */
const STALE_DAYS = 90;
/** Hoe lang na de instapdatum we betalingen bekijken voor voorstellen. */
const SUGGEST_DAYS = 120;
/** Zoveel voorstellen tegelijk; de rest komt als deze zijn afgehandeld. */
const MAX_SUGGESTIONS = 25;

const ASSET_ACCOUNT = { vervoer: ACCOUNTS.vervoermiddelen, inventaris: ACCOUNTS.inventaris } as const;
const OTHER_ACCOUNT = { lening: ACCOUNTS.leningen, vordering: ACCOUNTS.overigeVorderingen, schuld: ACCOUNTS.overigeSchulden } as const;
/** Kosten tot de instapdatum per eenvoudige groep. */
const RESULT_ACCOUNTS = { omzet: ACCOUNTS.omzetHoog, materiaal: ACCOUNTS.inkoopMaterialen, auto: 'WBedAutOnd', overig: 'WBedAlkOvr' } as const;

const nonNegative = (v: number, label: string) => {
  if (!Number.isSafeInteger(v) || v < 0) throw new ValidationError(`Vul bij ${label} een bedrag in (0 als er niets is)`);
};
const positive = (v: number, label: string) => {
  if (!Number.isSafeInteger(v) || v <= 0) throw new ValidationError(`Vul ${label} in`);
};

/** Een factuurnummer uit een betalingsomschrijving, als het er duidelijk in staat. */
export function guessInvoiceNumber(text: string): string | null {
  const labelled = /(?:factuur|fact\.?|nota|invoice|inv\.?)\s*(?:nr\.?|nummer|no\.?)?\s*[:#.]?\s*([A-Z]{0,4}[-/]?\d[\w\-/]{1,20})/i.exec(text);
  if (labelled) return labelled[1]!.replace(/[.,;]+$/, '');
  const yearNumber = /\b((?:19|20)\d{2}[-/.]\d{2,6})\b/.exec(text);
  return yearNumber ? yearNumber[1]! : null;
}

export class SwitchoverService {
  constructor(
    private readonly db: Db,
    private readonly ledger: Ledger,
    private readonly settings: SettingsService,
    private readonly relations: RelationsService,
    private readonly bank: BankService,
    private readonly vat: VatService,
  ) {}

  // ---------- instellingen ----------

  private cfg(): SwitchoverSettings {
    return this.settings.get().switchover;
  }

  private date(): IsoDate {
    const d = this.cfg().date;
    if (this.cfg().mode !== 'overstapper' || !d) throw new ValidationError('Kies eerst vanaf welke datum de app je administratie bijhoudt');
    return d;
  }

  private update(patch: Partial<SwitchoverSettings>): void {
    this.settings.update({ switchover: { ...this.cfg(), ...patch } });
  }

  /** De btw-periode waar D midden in valt; null bij KOR of als D op het begin van een periode valt. */
  private splitPeriod(date: IsoDate): { key: string; label: string; start: IsoDate } | null {
    const s = this.settings.get();
    if (s.kor) return null;
    const p = periodFor(date, s.vatPeriod);
    return p.start === date ? null : { key: p.key, label: p.label, start: p.start };
  }

  /**
   * Begin je net, of had je al een administratie? Bij overstappen: vanaf welke datum. Een andere datum
   * kiezen mag ook later: alles wat al is ingevuld, wordt dan opnieuw geboekt op de nieuwe datum.
   */
  setMode(mode: 'nieuw' | 'overstapper', date: IsoDate | null = null): SwitchoverState {
    if (mode === 'nieuw') {
      if (this.db.prepare('SELECT 1 FROM opening_items LIMIT 1').get()) {
        throw new ValidationError('Je hebt al een startbalans ingevuld. Haal die eerst weg in de overstap-hulp');
      }
      tx(this.db, () => {
        this.reopenFiledElsewhere();
        this.update({ mode: 'nieuw', date: null, filedElsewhere: [] });
      });
      return this.state();
    }
    if (!date) throw new ValidationError('Kies vanaf welke datum de app je administratie bijhoudt');
    assertIsoDate(date, 'instapdatum');
    if (date > today()) throw new ValidationError('De instapdatum kan niet in de toekomst liggen');
    if (date < '2000-01-01') throw new ValidationError('Kies een recentere instapdatum');
    tx(this.db, () => {
      const old = this.cfg().mode === 'overstapper' ? this.cfg().date : null;
      this.update({ mode: 'overstapper', date, status: 'concept' });
      if (old && old !== date) this.redate(old, date);
      this.reopenFiledElsewhere();
      this.markFiledElsewhere(date);
    });
    return this.state();
  }

  /**
   * Btw-periodes die helemaal vóór de instapdatum liggen, zijn al aangegeven (in de vorige
   * administratie). De app markeert ze zo, zodat hij er niet om vraagt en ze vastliggen.
   */
  private markFiledElsewhere(date: IsoDate): void {
    const s = this.settings.get();
    if (s.kor) return;
    const marked: string[] = [];
    const year = Number(date.slice(0, 4));
    for (const p of this.vat.listPeriods(year)) {
      if (p.period.end >= date || p.status === 'ingediend') continue;
      this.vat.markSubmitted(p.period.key, { alreadyFiled: true });
      marked.push(p.period.key);
    }
    this.update({ filedElsewhere: marked });
  }

  private reopenFiledElsewhere(): void {
    for (const key of this.cfg().filedElsewhere) {
      const row = this.db.prepare(`SELECT journal_entry_id FROM vat_periods WHERE period_key = ? AND status = 'ingediend'`).get(key) as { journal_entry_id: number | null } | undefined;
      // alleen wat de app zelf markeerde en waar niets op geboekt is
      if (row && row.journal_entry_id === null) this.vat.reopen(key);
    }
    this.update({ filedElsewhere: [] });
  }

  /** Alles wat al is ingevuld opnieuw boeken op een andere instapdatum. */
  private redate(from: IsoDate, to: IsoDate): void {
    for (const b of this.bank.listAccounts()) {
      const o = this.bank.openingBalance(b.id);
      if (o.date === from && o.amount !== 0) this.bank.setOpeningBalance(b.id, o.amount, to);
    }
    const split = this.splitPeriod(to);
    const startOfYear = to.endsWith('-01-01');
    for (const row of this.rows()) {
      const item = this.hydrate(row);
      // horen niet meer bij de nieuwe datum: weg
      if ((item.kind === 'resultaat' && startOfYear) || (item.kind === 'btw-periode' && !split)) {
        this.remove(item.id);
        continue;
      }
      this.save(item.data, item.id);
    }
  }

  confirm(opts: { provisional?: boolean } = {}): SwitchoverState {
    const blocking = this.checks().filter((c) => c.level === 'probleem');
    if (blocking.length > 0) throw new ValidationError(`Nog op te lossen: ${blocking.map((c) => c.title.toLowerCase()).join('; ')}`);
    this.update({ status: 'klaar', provisional: !!opts.provisional });
    return this.state();
  }

  reopen(): SwitchoverState {
    this.update({ status: 'concept' });
    return this.state();
  }

  /**
   * "Had ik niet": een hoofdstuk zonder iets in te vullen afvinken (geen boekhoudprogramma, geen
   * openstaande facturen, geen bus). Met `skip = false` weer openzetten.
   */
  skipSection(key: SectionKey, skip = true): SwitchoverState {
    if (!(SKIPPABLE_SECTIONS as readonly string[]).includes(key)) throw new ValidationError('Dit onderdeel kun je niet overslaan');
    const skipped = new Set(this.cfg().skipped ?? []);
    if (skip) skipped.add(key);
    else skipped.delete(key);
    this.update({ skipped: [...skipped] });
    return this.state();
  }

  /**
   * Een rekening die je vanaf de instapdatum niet meer gebruikt (bv. de rekening die je bij het
   * instellen opgaf, terwijl je vorige programma een andere had): beginsaldo € 0, geen afschriften nodig.
   */
  setBankUnused(bankAccountId: number, unused = true): SwitchoverState {
    const date = this.date();
    const b = this.bankStatus(date).find((x) => x.bankAccountId === bankAccountId);
    if (!b) throw new ValidationError('Deze rekening bestaat niet (meer)');
    if (unused && b.coverageTo && b.coverageTo >= date) throw new ValidationError(`Er staan al betalingen van ${b.name} vanaf de instapdatum in. Die rekening gebruik je dus nog.`);
    tx(this.db, () => {
      const set = new Set(this.cfg().unusedBanks ?? []);
      if (unused) {
        set.add(bankAccountId);
        this.update({ unusedBanks: [...set] });
        this.setBankOpening(bankAccountId, 0);
      } else {
        set.delete(bankAccountId);
        this.update({ unusedBanks: [...set] });
      }
    });
    return this.state();
  }

  setAccountantEquity(amount: Cents | null): SwitchoverState {
    if (amount !== null && !Number.isSafeInteger(amount)) throw new ValidationError('Vul het eigen vermogen in als bedrag');
    this.update({ accountantEquity: amount });
    return this.state();
  }

  // ---------- bank ----------

  /** Beginsaldo van een rekening op de instapdatum (ook € 0 telt als ingevuld). */
  setBankOpening(bankAccountId: number, amount: Cents): SwitchoverState {
    const date = this.date();
    if (!Number.isSafeInteger(amount)) throw new ValidationError('Vul het saldo in');
    tx(this.db, () => {
      this.bank.setOpeningBalance(bankAccountId, amount, date);
      const confirmed = new Set(this.cfg().bankConfirmed);
      confirmed.add(bankAccountId);
      this.update({ bankConfirmed: [...confirmed] });
    });
    return this.state();
  }

  /** Het saldo volgens de bank op een datum, om te controleren of alle afschriften erin zitten. */
  setBankCheck(bankAccountId: number, date: IsoDate, amount: Cents): SwitchoverState {
    assertIsoDate(date);
    const start = this.date();
    if (date < start || date > today()) throw new ValidationError(`Kies een datum tussen ${formatDateNl(start)} en vandaag`);
    if (!Number.isSafeInteger(amount)) throw new ValidationError('Vul het saldo in');
    this.bank.getAccount(bankAccountId);
    this.update({ bankChecks: { ...this.cfg().bankChecks, [String(bankAccountId)]: { date, amount } } });
    return this.state();
  }

  /**
   * Betalingen van vóór de instapdatum horen bij de vorige administratie: niet (nog eens) verwerken.
   * Wat de app er al mee deed (bv. automatisch verwerkt na het inlezen), wordt teruggedraaid.
   */
  ignoreBeforeDate(): number {
    const date = this.date();
    return tx(this.db, () => {
      const done = this.db.prepare(`SELECT id FROM bank_transactions WHERE status = 'gematcht' AND transaction_date < ?`).all(date) as { id: number }[];
      for (const t of done) if (this.bank.get(t.id).status === 'gematcht') this.bank.unmatch(t.id, date);
      return this.db.prepare(`UPDATE bank_transactions SET status = 'genegeerd' WHERE status = 'nieuw' AND transaction_date < ?`).run(date).changes;
    });
  }

  private bankStatus(date: IsoDate): BankStatus[] {
    const status = new Map(this.bank.importStatus().map((s) => [s.bankAccountId, s]));
    const confirmed = new Set(this.cfg().bankConfirmed);
    const unused = new Set(this.cfg().unusedBanks ?? []);
    return this.bank.listAccounts().map((a) => {
      const o = this.bank.openingBalance(a.id);
      const opening = o.date === date ? o.amount : o.date === null && confirmed.has(a.id) ? 0 : null;
      const sumSince = (to: IsoDate) =>
        (this.db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM bank_transactions WHERE bank_account_id = ? AND transaction_date >= ? AND transaction_date <= ?').get(a.id, date, to) as { s: number }).s;
      // eindsaldo uit een afschrift (het laatste op of na D)
      const closing = this.db
        .prepare('SELECT closing_balance AS amount, closing_date AS date FROM import_batch_accounts WHERE bank_account_id = ? AND closing_date >= ? AND closing_balance IS NOT NULL ORDER BY closing_date DESC, batch_id DESC LIMIT 1')
        .get(a.id, date) as { amount: Cents; date: IsoDate } | undefined;
      const given = this.cfg().bankChecks[String(a.id)];
      const reference = given && (!closing || given.date >= closing.date) ? { ...given, source: 'opgegeven' as const } : closing ? { ...closing, source: 'afschrift' as const } : null;
      // eerste afschrift met eindsaldo na D: saldo op D = dat eindsaldo min wat er sindsdien bij en af ging
      const first = this.db
        .prepare('SELECT closing_balance AS amount, closing_date AS date FROM import_batch_accounts WHERE bank_account_id = ? AND closing_date >= ? AND closing_balance IS NOT NULL ORDER BY closing_date, batch_id LIMIT 1')
        .get(a.id, date) as { amount: Cents; date: IsoDate } | undefined;
      const st = status.get(a.id);
      return {
        bankAccountId: a.id,
        name: a.name,
        iban: a.iban,
        isPot: !!a.is_pot,
        opening,
        suggestedOpening: first ? { amount: first.amount - sumSince(first.date), basis: `berekend uit het eindsaldo van ${formatDateNl(first.date)} op je afschrift` } : null,
        coverageFrom: st?.coverageFrom ?? null,
        coverageTo: st?.coverageTo ?? null,
        beforeDate: (this.db.prepare(`SELECT COUNT(*) AS n FROM bank_transactions WHERE bank_account_id = ? AND status <> 'genegeerd' AND transaction_date < ?`).get(a.id, date) as { n: number }).n,
        balanceCheck: reference && opening !== null ? { date: reference.date, bank: reference.amount, computed: opening + sumSince(reference.date), source: reference.source } : null,
        unused: unused.has(a.id),
      };
    });
  }

  // ---------- startbalans ----------

  private rows(): ItemRow[] {
    return this.db.prepare('SELECT * FROM opening_items ORDER BY kind, id').all() as ItemRow[];
  }

  private row(id: number): ItemRow {
    const r = this.db.prepare('SELECT * FROM opening_items WHERE id = ?').get(id) as ItemRow | undefined;
    if (!r) throw new ValidationError('Dit onderdeel bestaat niet (meer)');
    return r;
  }

  private hydrate(r: ItemRow): OpeningItem {
    let locked = false;
    let open: Cents | null = null;
    if (r.invoice_id) {
      const inv = this.db.prepare('SELECT total, amount_paid FROM invoices WHERE id = ?').get(r.invoice_id) as { total: number; amount_paid: number } | undefined;
      locked = !!inv && inv.amount_paid !== 0;
      open = inv ? inv.total - inv.amount_paid : null;
    }
    if (r.purchase_invoice_id) {
      const p = this.db.prepare('SELECT total, amount_paid FROM purchase_invoices WHERE id = ?').get(r.purchase_invoice_id) as { total: number; amount_paid: number } | undefined;
      locked = !!p && p.amount_paid !== 0;
      open = p ? p.total - p.amount_paid : null;
    }
    if (r.asset_id) locked = !!this.db.prepare('SELECT 1 FROM asset_depreciation WHERE asset_id = ?').get(r.asset_id) || !!this.db.prepare(`SELECT 1 FROM assets WHERE id = ? AND status <> 'actief'`).get(r.asset_id);
    return { ...r, data: JSON.parse(r.data) as OpeningInput, locked, open };
  }

  list(): OpeningItem[] {
    return this.rows().map((r) => this.hydrate(r));
  }

  private validate(input: OpeningInput, date: IsoDate): void {
    switch (input.kind) {
      case 'klant':
      case 'leverancier':
        if (!input.relationName?.trim()) throw new ValidationError(input.kind === 'klant' ? 'Vul de naam van de klant in' : 'Vul de naam van de leverancier in');
        assertIsoDate(input.invoiceDate, 'factuurdatum');
        if (input.invoiceDate >= date) throw new ValidationError(`De factuur moet van vóór ${formatDateNl(date)} zijn. Een latere factuur voer je gewoon in de app in`);
        if (input.dueDate) assertIsoDate(input.dueDate, 'vervaldatum');
        if (!Number.isSafeInteger(input.amount) || input.amount <= 0) throw new ValidationError('Vul het bedrag in dat nog open staat (inclusief btw)');
        if (input.kind === 'klant' && !input.number?.trim()) throw new ValidationError('Vul het factuurnummer in; dan herkent de app de betaling');
        return;
      case 'bezit': {
        if (!input.name?.trim()) throw new ValidationError('Wat is het? Bijvoorbeeld "Bus Ford Transit"');
        if (!(input.type in ASSET_ACCOUNT)) throw new ValidationError('Kies bus/auto of gereedschap');
        assertIsoDate(input.acquiredOn, 'aankoopdatum');
        if (input.acquiredOn >= date) throw new ValidationError(`Gekocht op of na ${formatDateNl(date)}? Dan voer je de aankoop gewoon in de app in`);
        positive(input.cost, 'wat je ervoor betaalde');
        nonNegative(input.bookValue, 'de boekwaarde');
        if (input.bookValue > input.cost) throw new ValidationError('De boekwaarde kan niet hoger zijn dan wat je ervoor betaalde');
        if (!Number.isFinite(input.remainingYears) || input.remainingYears < 1 || input.remainingYears > 50) throw new ValidationError('Hoeveel jaar gebruik je het nog? Vul 1 tot 50 in');
        return;
      }
      case 'btw':
        // 0 = er stond niets meer open (dan is het ook beantwoord)
        nonNegative(input.amount, 'het btw-bedrag');
        if (input.direction !== 'betalen' && input.direction !== 'terug') throw new ValidationError('Moet je btw betalen of krijg je terug?');
        return;
      case 'lening':
      case 'vordering':
      case 'schuld':
        if (!input.description?.trim()) throw new ValidationError('Omschrijf het kort, bijvoorbeeld "Lening bus bij de bank"');
        positive(input.amount, 'het bedrag');
        return;
      case 'resultaat':
        if (date.endsWith('-01-01')) throw new ValidationError('Je begint op 1 januari: dan zijn er nog geen omzet en kosten van dit jaar');
        nonNegative(input.omzet, 'omzet');
        nonNegative(input.materiaal, 'materiaal en inkoop');
        nonNegative(input.auto, 'autokosten');
        nonNegative(input.overig, 'overige kosten');
        return;
      case 'btw-periode': {
        if (!this.splitPeriod(date)) throw new ValidationError('De instapdatum valt op het begin van een btw-periode: dan is dit niet nodig');
        for (const [k, label] of [['omzetHoog', 'omzet 21%'], ['btwHoog', 'btw 21%'], ['omzetLaag', 'omzet 9%'], ['btwLaag', 'btw 9%'], ['omzetNul', 'omzet zonder btw'], ['voorbelasting', 'btw op je inkopen']] as const) {
          nonNegative(input[k], label);
        }
        return;
      }
      default:
        throw new ValidationError('Onbekend onderdeel van de startbalans');
    }
  }

  /**
   * Een onderdeel van de startbalans toevoegen of aanpassen. Aanpassen draait de oude boeking terug en
   * boekt opnieuw. Omzet tot nu toe en de btw-periode zijn er maar één keer.
   */
  save(input: OpeningInput, id?: number): OpeningItem {
    const date = this.date();
    this.validate(input, date);
    return tx(this.db, () => {
      let prev = id ? this.hydrate(this.row(id)) : null;
      if (!prev && (input.kind === 'resultaat' || input.kind === 'btw-periode')) {
        const single = this.rows().find((r) => r.kind === input.kind);
        prev = single ? this.hydrate(single) : null;
      }
      if (prev && prev.kind !== input.kind) throw new ValidationError('Dit onderdeel is van een andere soort');
      if (prev) this.unbook(prev, false);
      const itemId = prev?.id ?? Number(this.db.prepare(`INSERT INTO opening_items (kind, description, amount) VALUES (?, '', 0)`).run(input.kind).lastInsertRowid);
      this.book(itemId, input, date, prev);
      // de omzet in de btw-periode zit ook in de omzet tot nu toe: die boeking hangt ervan af
      if (input.kind === 'btw-periode') {
        const result = this.rows().find((r) => r.kind === 'resultaat');
        if (result) {
          const item = this.hydrate(result);
          this.unbook(item, false);
          this.book(item.id, item.data, date, item);
        }
      }
      return this.hydrate(this.row(itemId));
    });
  }

  /**
   * Openstaande facturen als UBL (e-factuur) uit het vorige programma: elk bestand wordt een factuur
   * die nog open staat. Al (deels) betaald? Dan past de gebruiker het bedrag daarna aan.
   */
  saveFromUbl(files: { name: string; xml: string }[]): { added: number; skipped: string[] } {
    const skipped: string[] = [];
    let added = 0;
    // elk bestand apart (save heeft een eigen transactie): één fout bestand houdt de rest niet tegen
    {
      for (const f of files) {
        try {
          const u = parseUblSalesInvoice(f.xml);
          if (u.amount <= 0) throw new ValidationError('creditnota of factuur zonder bedrag');
          if (this.db.prepare('SELECT 1 FROM invoices WHERE number = ?').get(u.number)) throw new ValidationError(`factuur ${u.number} staat er al in`);
          this.save({ kind: 'klant', relationName: u.customer || 'Onbekende klant', number: u.number, invoiceDate: u.invoiceDate, dueDate: u.dueDate, amount: u.amount });
          added++;
        } catch (e) {
          skipped.push(`${f.name}: ${(e as Error).message}`);
        }
      }
    }
    return { added, skipped };
  }

  remove(id: number): void {
    tx(this.db, () => {
      const item = this.hydrate(this.row(id));
      this.unbook(item, true);
      this.db.prepare('DELETE FROM opening_items WHERE id = ?').run(id);
      if (item.kind === 'btw-periode') {
        const result = this.rows().find((r) => r.kind === 'resultaat');
        if (result) {
          const r = this.hydrate(result);
          this.unbook(r, false);
          this.book(r.id, r.data, this.date(), r);
        }
      }
    });
  }

  /** De boeking van een onderdeel terugdraaien; `removeDocs` haalt ook de factuur/het bedrijfsmiddel weg. */
  private unbook(item: OpeningItem, removeDocs: boolean): void {
    if (item.locked) {
      throw new ValidationError(
        item.kind === 'bezit'
          ? 'Hierop is al afgeschreven (of het is verkocht). Pas het aan bij Belasting → investeringen'
          : 'Deze factuur is al (deels) betaald. Maak eerst de koppeling met de betaling ongedaan bij Bank',
      );
    }
    if (item.journal_entry_id) {
      const e = this.db.prepare('SELECT entry_date, status FROM journal_entries WHERE id = ?').get(item.journal_entry_id) as { entry_date: IsoDate; status: string } | undefined;
      if (e && e.status === 'definitief') this.ledger.reverse(item.journal_entry_id, e.entry_date, `Startbalans aangepast: ${item.description}`);
    }
    if (!removeDocs) return;
    if (item.invoice_id) {
      this.db.prepare('UPDATE opening_items SET invoice_id = NULL WHERE id = ?').run(item.id);
      this.db.prepare('DELETE FROM invoices WHERE id = ? AND is_opening = 1').run(item.invoice_id);
    }
    if (item.purchase_invoice_id) {
      this.db.prepare('UPDATE opening_items SET purchase_invoice_id = NULL WHERE id = ?').run(item.id);
      this.db.prepare('DELETE FROM purchase_invoices WHERE id = ? AND is_opening = 1').run(item.purchase_invoice_id);
    }
    if (item.asset_id) {
      this.db.prepare('UPDATE opening_items SET asset_id = NULL WHERE id = ?').run(item.id);
      this.db.prepare('DELETE FROM assets WHERE id = ? AND is_opening = 1').run(item.asset_id);
    }
  }

  private post(description: string, date: IsoDate, lines: (PostLine | null)[], opts: { source?: 'opening' | 'handmatig'; sourceRef?: string } = {}): number {
    const clean = lines.filter((l): l is PostLine => l !== null);
    // alles tegen eigen vermogen: dat is het sluitstuk
    const net = clean.reduce((s, l) => s + (l.debit ?? 0) - (l.credit ?? 0), 0);
    const ev = signedLine(ACCOUNTS.eigenVermogen, -net);
    if (ev) clean.push(ev);
    return this.ledger.post({ date, description, source: opts.source ?? 'opening', sourceRef: opts.sourceRef ?? null, lines: clean });
  }

  private book(itemId: number, input: OpeningInput, date: IsoDate, prev: OpeningItem | null): void {
    const set = (description: string, amount: Cents, entryId: number | null, refs: { invoice_id?: number | null; purchase_invoice_id?: number | null; asset_id?: number | null } = {}) =>
      this.db
        .prepare('UPDATE opening_items SET description = ?, amount = ?, data = ?, journal_entry_id = ?, invoice_id = COALESCE(?, invoice_id), purchase_invoice_id = COALESCE(?, purchase_invoice_id), asset_id = COALESCE(?, asset_id) WHERE id = ?')
        .run(description, amount, JSON.stringify(input), entryId, refs.invoice_id ?? null, refs.purchase_invoice_id ?? null, refs.asset_id ?? null, itemId);

    switch (input.kind) {
      case 'klant': {
        const relation = this.findOrCreateCustomer(input.relationName);
        const number = input.number.trim();
        const due = input.dueDate || input.invoiceDate;
        const clash = this.db.prepare('SELECT id FROM invoices WHERE number = ?').get(number) as { id: number } | undefined;
        if (clash && clash.id !== prev?.invoice_id) throw new ValidationError(`Factuurnummer ${number} bestaat al in de app`);
        let invoiceId = prev?.invoice_id ?? null;
        if (invoiceId) {
          this.db
            .prepare(`UPDATE invoices SET relation_id = ?, number = ?, invoice_date = ?, due_date = ?, subtotal = ?, vat_total = 0, total = ?, relation_snapshot = ? WHERE id = ?`)
            .run(relation.id, number, input.invoiceDate, due, input.amount, input.amount, JSON.stringify(relation), invoiceId);
        } else {
          invoiceId = Number(
            this.db
              .prepare(
                `INSERT INTO invoices (relation_id, number, invoice_date, due_date, status, subtotal, vat_total, total, relation_snapshot, company_snapshot, notes, is_opening)
                 VALUES (?, ?, ?, ?, 'verzonden', ?, 0, ?, ?, ?, ?, 1)`,
              )
              .run(relation.id, number, input.invoiceDate, due, input.amount, input.amount, JSON.stringify(relation), JSON.stringify(this.settings.get().company), 'Uit de vorige administratie (startbalans)').lastInsertRowid,
          );
        }
        // één regel voor het totaal: de omzet en btw staan in de vorige administratie
        this.db.prepare('DELETE FROM invoice_lines WHERE invoice_id = ?').run(invoiceId);
        this.db
          .prepare(`INSERT INTO invoice_lines (invoice_id, position, description, quantity, unit, unit_price, vat_code, vat_percentage) VALUES (?, 1, ?, 1, NULL, ?, 'nul', 0)`)
          .run(invoiceId, `Factuur ${number} (nog open op ${formatDateNl(date)})`, input.amount);
        const description = `Factuur ${number} ${relation.name}`;
        const entryId = this.post(`Startbalans: ${description} nog te ontvangen`, date, [signedLine(ACCOUNTS.debiteuren, input.amount, { relationId: relation.id, description: number })], { sourceRef: `invoice:${invoiceId}` });
        this.db.prepare('UPDATE invoices SET journal_entry_id = ? WHERE id = ?').run(entryId, invoiceId);
        set(description, input.amount, entryId, { invoice_id: invoiceId });
        return;
      }
      case 'leverancier': {
        const relation = this.relations.findOrCreateSupplier(input.relationName);
        const description = `${input.reference?.trim() ? `Rekening ${input.reference.trim()}` : 'Rekening'} ${relation.name}`;
        let purchaseId = prev?.purchase_invoice_id ?? null;
        if (purchaseId) {
          this.db
            .prepare('UPDATE purchase_invoices SET relation_id = ?, supplier_reference = ?, invoice_date = ?, due_date = ?, description = ?, subtotal = ?, vat_total = 0, total = ? WHERE id = ?')
            .run(relation.id, input.reference?.trim() || null, input.invoiceDate, input.dueDate || null, description, input.amount, input.amount, purchaseId);
        } else {
          purchaseId = Number(
            this.db
              .prepare(
                `INSERT INTO purchase_invoices (relation_id, supplier_reference, invoice_date, due_date, description, subtotal, vat_total, total, is_opening)
                 VALUES (?, ?, ?, ?, ?, ?, 0, ?, 1)`,
              )
              .run(relation.id, input.reference?.trim() || null, input.invoiceDate, input.dueDate || null, description, input.amount, input.amount).lastInsertRowid,
          );
        }
        const entryId = this.post(`Startbalans: ${description} nog te betalen`, date, [signedLine(ACCOUNTS.crediteuren, -input.amount, { relationId: relation.id, description: input.reference?.trim() || null })], { sourceRef: `purchase:${purchaseId}` });
        this.db.prepare('UPDATE purchase_invoices SET journal_entry_id = ? WHERE id = ?').run(entryId, purchaseId);
        set(description, -input.amount, entryId, { purchase_invoice_id: purchaseId });
        return;
      }
      case 'bezit': {
        const account = ASSET_ACCOUNT[input.type];
        const yearStart = `${date.slice(0, 4)}-01-01`;
        // dit jaar gekocht (vóór D): een gewone investering van dit jaar (telt mee voor de investeringsaftrek)
        const thisYear = input.acquiredOn >= yearStart;
        const value = thisYear ? input.cost : input.bookValue;
        const name = input.name.trim();
        let assetId = prev?.asset_id ?? null;
        let entryId: number | null = null;
        let lineId: number | null = null;
        if (value > 0) {
          entryId = this.post(`Startbalans: ${name}`, date, [{ account, debit: value, description: name }]);
          lineId = (this.db.prepare('SELECT l.id FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id WHERE l.journal_entry_id = ? AND a.rgs_code = ? AND l.debit > 0').get(entryId, account) as { id: number }).id;
        }
        const acquired = thisYear ? input.acquiredOn : yearStart;
        const months = thisYear ? Math.max(60, Math.round(input.remainingYears * 12)) : Math.round(input.remainingYears * 12);
        if (lineId === null) {
          // helemaal afgeschreven: niets meer op de balans en niets meer af te schrijven
          if (assetId) this.db.prepare('DELETE FROM assets WHERE id = ? AND is_opening = 1').run(assetId);
          this.db.prepare('UPDATE opening_items SET asset_id = NULL WHERE id = ?').run(itemId);
          set(name, 0, null);
          return;
        }
        if (assetId) {
          this.db
            .prepare(`UPDATE assets SET journal_line_id = ?, account_rgs = ?, name = ?, acquired_on = ?, cost = ?, lifetime_months = ?, kia_excluded = ? WHERE id = ?`)
            .run(lineId, account, name, acquired, value, months, thisYear ? 0 : 1, assetId);
        } else {
          assetId = Number(
            this.db
              .prepare(`INSERT INTO assets (journal_line_id, account_rgs, name, acquired_on, cost, lifetime_months, kia_excluded, is_opening) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`)
              .run(lineId, account, name, acquired, value, months, thisYear ? 0 : 1).lastInsertRowid,
          );
        }
        set(name, value, entryId, { asset_id: assetId });
        return;
      }
      case 'btw': {
        const amount = input.direction === 'terug' ? input.amount : -input.amount;
        const description = input.description?.trim() || (amount === 0 ? 'Btw: niets meer open' : amount > 0 ? 'Btw die je nog terugkrijgt' : 'Btw die je nog moet betalen');
        const entryId = amount === 0 ? null : this.post(`Startbalans: ${description}`, date, [signedLine(ACCOUNTS.btwAfrekening, amount)]);
        set(description, amount, entryId);
        return;
      }
      case 'lening':
      case 'vordering':
      case 'schuld': {
        const amount = input.kind === 'vordering' ? input.amount : -input.amount;
        const description = input.description.trim();
        const account = input.kind === 'vordering' && input.account === 'kas' ? ACCOUNTS.kas : OTHER_ACCOUNT[input.kind];
        const entryId = this.post(`Startbalans: ${description}`, date, [signedLine(account, amount, { description })]);
        set(description, amount, entryId);
        return;
      }
      case 'resultaat': {
        // de omzet in de btw-periode vóór D wordt apart geboekt (met btw); hier de rest
        const split = this.rows().find((r) => r.kind === 'btw-periode');
        const splitOmzet = split ? (() => {
          const d = JSON.parse(split.data) as Extract<OpeningInput, { kind: 'btw-periode' }>;
          return d.omzetHoog + d.omzetLaag + d.omzetNul;
        })() : 0;
        const omzet = input.omzet - splitOmzet;
        if (omzet < 0) throw new ValidationError(`De omzet van dit jaar (${formatEuro(input.omzet)}) is lager dan de omzet in de btw-periode (${formatEuro(splitOmzet)}). Kijk beide bedragen na`);
        const winst = input.omzet - input.materiaal - input.auto - input.overig;
        const description = `Omzet en kosten tot ${formatDateNl(date)}`;
        const lines = [
          signedLine(RESULT_ACCOUNTS.omzet, -omzet, { description: 'Omzet (vorige administratie)' }),
          signedLine(RESULT_ACCOUNTS.materiaal, input.materiaal, { description: 'Materiaal en inkoop (vorige administratie)' }),
          signedLine(RESULT_ACCOUNTS.auto, input.auto, { description: 'Autokosten (vorige administratie)' }),
          signedLine(RESULT_ACCOUNTS.overig, input.overig, { description: 'Overige kosten (vorige administratie)' }),
        ];
        const entryId = lines.some((l) => l) ? this.post(`Startbalans: ${description}`, addDays(date, -1), lines) : null;
        set(description, winst, entryId);
        return;
      }
      case 'btw-periode': {
        const split = this.splitPeriod(date)!;
        const description = `Omzet en btw van ${formatDateNl(split.start)} tot ${formatDateNl(date)}`;
        const lines = [
          signedLine(ACCOUNTS.omzetHoog, -input.omzetHoog, { vatCode: 'hoog' }),
          signedLine(ACCOUNTS.btwAfdragenHoog, -input.btwHoog, { vatCode: 'hoog' }),
          signedLine(ACCOUNTS.omzetLaag, -input.omzetLaag, { vatCode: 'laag' }),
          signedLine(ACCOUNTS.btwAfdragenLaag, -input.btwLaag, { vatCode: 'laag' }),
          signedLine(ACCOUNTS.omzetNul, -input.omzetNul, { vatCode: 'nul' }),
          signedLine(ACCOUNTS.btwVoorbelasting, input.voorbelasting, { vatCode: 'voorbelasting' }),
        ];
        // telt wél mee in de btw-aangifte van deze periode: geen 'opening'
        const entryId = lines.some((l) => l) ? this.post(description, addDays(date, -1), lines, { source: 'handmatig', sourceRef: `overstap:${split.key}` }) : null;
        set(description, input.voorbelasting - input.btwHoog - input.btwLaag, entryId);
        return;
      }
    }
  }

  private findOrCreateCustomer(name: string) {
    const existing = this.db.prepare(`SELECT id FROM relations WHERE lower(name) = lower(?) AND archived = 0 LIMIT 1`).get(name.trim()) as { id: number } | undefined;
    if (existing) {
      const r = this.relations.get(existing.id);
      if (r.type === 'leverancier') this.relations.update(r.id, { type: 'beide' });
      return this.relations.get(r.id);
    }
    return this.relations.create({ name: name.trim(), type: 'klant' });
  }

  // ---------- overzicht ----------

  /** De startpositie op de instapdatum, uit de beginbalansboekingen zelf. */
  position(): OpeningPosition | null {
    const s = this.cfg();
    if (s.mode !== 'overstapper' || !s.date) return null;
    const date = s.date;
    const rows = this.db
      .prepare(
        `SELECT a.rgs_code, a.name, a.category, SUM(l.debit - l.credit) AS balance
         FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN chart_of_accounts a ON a.id = l.account_id
         WHERE (e.source = 'opening' OR e.source_ref LIKE 'overstap:%') AND e.entry_date <= ?
         GROUP BY a.id HAVING balance <> 0`,
      )
      .all(date) as { rgs_code: string; name: string; category: string; balance: Cents }[];
    const banks = new Map(this.bank.listAccounts().map((b) => [b.rgs_code, b.name]));
    const labels: Record<string, string> = {
      [ACCOUNTS.debiteuren]: 'Klanten die nog moeten betalen',
      [ACCOUNTS.vervoermiddelen]: 'Bus en auto',
      [ACCOUNTS.inventaris]: 'Gereedschap en inventaris',
      [ACCOUNTS.overigeVorderingen]: 'Borg, voorschot en andere tegoeden',
      [ACCOUNTS.crediteuren]: 'Rekeningen die je nog moet betalen',
      [ACCOUNTS.leningen]: 'Leningen',
      [ACCOUNTS.overigeSchulden]: 'Andere schulden',
    };
    const bezittingen: PositionLine[] = [];
    const schulden: PositionLine[] = [];
    let btw = 0;
    let winst = 0;
    for (const r of rows) {
      if (r.rgs_code === ACCOUNTS.eigenVermogen) continue;
      if (r.category === 'omzet' || r.category === 'kosten') {
        winst -= r.balance;
        continue;
      }
      if (r.category === 'btw') {
        btw += r.balance;
        continue;
      }
      const label = banks.has(r.rgs_code) ? `Bank: ${banks.get(r.rgs_code)}` : (labels[r.rgs_code] ?? r.name);
      if (r.balance > 0) bezittingen.push({ key: r.rgs_code, label, amount: r.balance });
      else schulden.push({ key: r.rgs_code, label: banks.has(r.rgs_code) ? `Rood staan: ${banks.get(r.rgs_code)}` : label, amount: -r.balance });
    }
    if (btw > 0) bezittingen.push({ key: 'btw', label: 'Btw die je nog terugkrijgt', amount: btw });
    if (btw < 0) schulden.push({ key: 'btw', label: 'Btw die je nog moet betalen', amount: -btw });
    const total = (l: PositionLine[]) => l.reduce((s2, x) => s2 + x.amount, 0);
    return {
      date,
      bezittingen,
      schulden,
      winstTotNu: date.endsWith('-01-01') ? null : winst,
      eigenVermogen: total(bezittingen) - total(schulden),
    };
  }

  requirements(): Requirement[] {
    const s = this.settings.get();
    const date = s.switchover.date ?? today();
    const day = formatDateNl(date);
    const before = formatDateNl(addDays(date, -1));
    const year = Number(date.slice(0, 4));
    const startOfYear = date.endsWith('-01-01');
    const split = this.splitPeriod(date);
    const list: Requirement[] = [
      { key: 'auditfile', label: `Een auditfile (.xaf) uit je vorige boekhoudprogramma, tot en met ${before}`, hint: 'Heb je een programma gebruikt (Exact, e-Boekhouden, Moneybird, SnelStart, Jortt, …)? Exporteer daar een "auditfile". Dan vult de app bijna alles hieronder zelf in.', optional: true },
      { key: 'bank', label: `Bankafschriften vanaf ${day}`, hint: 'Van al je zakelijke rekeningen, ook je spaarrekening en creditcard. Download ze bij je bank als CAMT.053 (XML) of MT940: daar staat ook het saldo in. CSV kan ook.', optional: false },
      { key: 'saldo', label: `Het saldo van elke rekening op ${before}`, hint: 'Staat op je afschrift of in je internetbankieren. Uit een CAMT- of MT940-bestand rekent de app het zelf uit.', optional: false },
      { key: 'klanten', label: `Facturen die klanten op ${before} nog niet hadden betaald`, hint: 'Nummer, klant, datum en bedrag (inclusief btw). Uit je vorige programma of je eigen lijstje.', optional: false },
      { key: 'leveranciers', label: `Rekeningen die jij op ${before} nog moest betalen`, hint: 'Van leveranciers, onderaannemers en dergelijke.', optional: false },
      { key: 'bezit', label: 'Je bus, auto en gereedschap van meer dan € 450', hint: `Aankoopdatum en prijs. De boekwaarde op 1 januari ${year} staat op de balans van je boekhouder; heb je die niet, dan rekent de app hem uit.`, optional: false },
    ];
    if (!s.kor) list.push({ key: 'btw', label: 'Je laatste btw-aangifte', hint: `Moest je op ${before} nog btw betalen, of kreeg je nog iets terug?`, optional: false });
    if (!startOfYear) list.push({ key: 'resultaat', label: `Je omzet en kosten van 1 januari tot ${day}`, hint: 'Uit je vorige boekhoudprogramma (de winst-en-verliesrekening) of van je boekhouder. Zonder deze cijfers klopt je jaaroverzicht voor de inkomstenbelasting niet.', optional: false });
    if (split) list.push({ key: 'btw-periode', label: `Omzet en btw van ${formatDateNl(split.start)} tot ${day}`, hint: `Je stapt midden in ${split.label} over. Dan heeft de app deze bedragen nodig om de aangifte over die periode compleet te maken.`, optional: false });
    list.push({ key: 'lening', label: 'Leningen en andere afspraken', hint: 'Bijvoorbeeld een lening voor je bus, of een borg die je hebt betaald.', optional: true });
    list.push({ key: 'balans', label: startOfYear ? `De balans per 31 december ${year - 1} van je boekhouder` : 'De laatste balans van je boekhouder of vorige programma', hint: 'Niet verplicht, wel handig: dan controleert de app of alles klopt.', optional: true });
    return list;
  }

  checks(): SwitchoverCheck[] {
    const s = this.settings.get();
    const date = this.date();
    const out: SwitchoverCheck[] = [];
    const now = today();
    for (const b of this.bankStatus(date)) {
      const name = b.name;
      if (b.opening === null) {
        out.push({ key: `bank-saldo-${b.bankAccountId}`, level: 'probleem', title: `Beginsaldo van ${name} ontbreekt`, detail: `Vul in wat er aan het begin van ${formatDateNl(date)} op de rekening stond (ook als dat € 0 is).`, section: 'bank' });
      }
      if (b.isPot || (b.unused && (!b.coverageTo || b.coverageTo < date) && b.beforeDate === 0)) continue;
      if (!b.coverageTo || b.coverageTo < date) {
        // net overgestapt: dan zijn er nog geen afschriften, dat is geen fout
        out.push({ key: `bank-afschrift-${b.bankAccountId}`, level: diffDays(date, now) > 14 ? 'probleem' : 'let-op', title: `Nog geen afschriften van ${name} vanaf ${formatDateNl(date)}`, detail: 'Lees de afschriften vanaf de instapdatum in. Gebruik je deze rekening niet meer? Kies dan bij Bankrekeningen "Deze rekening gebruik ik niet".', section: 'bank' });
      } else {
        const firstAfter = (this.db.prepare('SELECT MIN(transaction_date) AS d FROM bank_transactions WHERE bank_account_id = ? AND transaction_date >= ?').get(b.bankAccountId, date) as { d: IsoDate | null }).d;
        if (firstAfter && diffDays(date, firstAfter) > 31) {
          out.push({ key: `bank-begin-${b.bankAccountId}`, level: 'let-op', title: `${name}: de eerste betaling is pas van ${formatDateNl(firstAfter)}`, detail: `Mist er een afschrift tussen ${formatDateNl(date)} en ${formatDateNl(firstAfter)}? Was het echt stil op de rekening, dan is het goed.`, section: 'bank' });
        }
        if (diffDays(b.coverageTo, now) > 45) {
          out.push({ key: `bank-recent-${b.bankAccountId}`, level: 'let-op', title: `${name}: afschriften tot ${formatDateNl(b.coverageTo)}`, detail: 'Lees ook de nieuwere afschriften in, dan is je administratie bij.', section: 'bank' });
        }
      }
      if (b.beforeDate > 0) {
        // anders tellen ze dubbel: eerst overslaan, dan pas klaarzetten
        out.push({ key: `bank-voor-${b.bankAccountId}`, level: 'probleem', title: `${b.beforeDate} ${b.beforeDate === 1 ? 'betaling' : 'betalingen'} van vóór ${formatDateNl(date)} op ${name}`, detail: 'Die zitten al in je vorige administratie. Laat de app ze overslaan, anders tellen ze dubbel.', section: 'bank' });
      }
      if (b.balanceCheck) {
        const diff = b.balanceCheck.bank - b.balanceCheck.computed;
        if (diff !== 0) {
          out.push({
            key: `bank-controle-${b.bankAccountId}`,
            level: 'probleem',
            title: `${name}: saldo klopt niet (${formatEuro(Math.abs(diff))} verschil)`,
            detail: `Volgens ${b.balanceCheck.source === 'afschrift' ? 'je afschrift' : 'jou'} stond er op ${formatDateNl(b.balanceCheck.date)} ${formatEuro(b.balanceCheck.bank)} op de rekening. Beginsaldo plus alle ingelezen betalingen geeft ${formatEuro(b.balanceCheck.computed)}. Ontbreekt er een afschrift, of klopt het beginsaldo niet?`,
            section: 'bank',
          });
        }
      } else if (b.opening !== null && b.coverageTo) {
        out.push({ key: `bank-controle-${b.bankAccountId}`, level: 'let-op', title: `${name}: nog niet gecontroleerd`, detail: `Vul in wat er volgens je bank op ${formatDateNl(b.coverageTo)} op de rekening stond. Dan weet je zeker dat er geen afschrift ontbreekt.`, section: 'bank' });
      }
    }
    const kinds = new Set(this.rows().map((r) => r.kind));
    if (!date.endsWith('-01-01') && !kinds.has('resultaat')) {
      out.push({ key: 'resultaat', level: 'probleem', title: `Omzet en kosten tot ${formatDateNl(date)} ontbreken`, detail: 'Zonder deze cijfers klopt je jaaroverzicht voor de inkomstenbelasting niet.', section: 'resultaat' });
    }
    const split = this.splitPeriod(date);
    if (split && !kinds.has('btw-periode')) {
      out.push({ key: 'btw-periode', level: 'probleem', title: `Omzet en btw van ${formatDateNl(split.start)} tot ${formatDateNl(date)} ontbreken`, detail: `Anders is de btw-aangifte over ${split.label} niet compleet.`, section: 'btw' });
    }
    if (!s.kor && !kinds.has('btw')) {
      out.push({ key: 'btw', level: 'let-op', title: 'Btw van de vorige aangifte nog niet ingevuld', detail: `Moest je op ${formatDateNl(addDays(date, -1))} nog btw betalen of kreeg je nog iets terug? Vul het in, of 0 als alles al betaald was.`, section: 'btw' });
    }
    const position = this.position();
    const equity = s.switchover.accountantEquity;
    if (position && equity !== null && position.eigenVermogen !== equity) {
      out.push({
        key: 'eigen-vermogen',
        level: 'let-op',
        title: `Verschil met je vorige administratie: ${formatEuro(Math.abs(position.eigenVermogen - equity))}`,
        detail: `Volgens de app zit er ${formatEuro(position.eigenVermogen)} van jou in de zaak, volgens je vorige administratie ${formatEuro(equity)}. Kijk of er een rekening, factuur of bezitting ontbreekt of dubbel staat.`,
        section: 'klaar',
      });
    }
    const stale = this.list().filter((i) => (i.kind === 'klant' || i.kind === 'leverancier') && i.open !== null && i.open !== 0 && diffDays(date, now) > STALE_DAYS);
    if (stale.length > 0) {
      out.push({
        key: 'oude-posten',
        level: 'let-op',
        title: `${stale.length} ${stale.length === 1 ? 'factuur' : 'facturen'} van vóór de overstap nog open`,
        detail: `Meer dan ${STALE_DAYS} dagen na de overstap: ${stale.slice(0, 3).map((i) => i.description).join(', ')}${stale.length > 3 ? ', …' : ''}. Is het toch al betaald? Koppel de betaling bij Bank.`,
        section: stale[0]!.kind === 'klant' ? 'klanten' : 'leveranciers',
      });
    }
    const suggestions = this.suggestions().length;
    if (suggestions > 0) {
      out.push({ key: 'voorstellen', level: 'let-op', title: `${suggestions} ${suggestions === 1 ? 'betaling' : 'betalingen'} die bij de vorige administratie lijken te horen`, detail: 'Bekijk de voorstellen bij klanten, leveranciers en btw.', section: 'klanten' });
    }
    return out;
  }

  // ---------- voorstellen uit de bankgegevens ----------

  /**
   * Betalingen kort na de instapdatum die bij iets van vóór de overstap lijken te horen: een klant die
   * een oude factuur betaalt, een oude rekening die jij betaalt, of de btw van de vorige aangifte.
   * Alleen voorstellen: de gebruiker beslist.
   */
  suggestions(): OpeningSuggestion[] {
    const s = this.cfg();
    if (s.mode !== 'overstapper' || !s.date) return [];
    const date = s.date;
    const dismissed = new Set(s.dismissed);
    const own = new Set(this.bank.listAccounts().map((b) => b.iban).filter(Boolean));
    const openInvoiceAmounts = new Set((this.db.prepare(`SELECT total - amount_paid AS open FROM invoices WHERE status = 'verzonden' AND is_opening = 0`).all() as { open: number }[]).map((r) => r.open));
    const openPurchaseAmounts = new Set((this.db.prepare(`SELECT total - amount_paid AS open FROM purchase_invoices WHERE status = 'open' AND is_opening = 0`).all() as { open: number }[]).map((r) => r.open));
    const hasBtw = !!this.db.prepare(`SELECT 1 FROM opening_items WHERE kind = 'btw'`).get();
    const rows = this.db
      .prepare(`SELECT * FROM bank_transactions WHERE status = 'nieuw' AND transaction_date >= ? AND transaction_date <= ? ORDER BY transaction_date, id`)
      .all(date, addDays(date, SUGGEST_DAYS)) as { id: number; transaction_date: IsoDate; amount: Cents; counter_iban: string | null; counter_name: string | null; description: string; reference: string | null }[];
    const out: OpeningSuggestion[] = [];
    for (const t of rows) {
      if (dismissed.has(t.id) || (t.counter_iban && own.has(t.counter_iban))) continue;
      const text = `${t.description} ${t.reference ?? ''}`;
      const name = t.counter_name?.trim() || 'Onbekend';
      if (/belastingdienst/i.test(name) || /omzetbelasting/i.test(text)) {
        if (hasBtw || this.settings.get().kor) continue;
        const pays = t.amount < 0;
        out.push({ txId: t.id, kind: 'btw', date: t.transaction_date, amount: Math.abs(t.amount), name, description: t.description, number: null, question: pays ? `Was dit de btw die je op ${formatDateNl(addDays(date, -1))} nog moest betalen?` : 'Kreeg je hiermee btw terug van een aangifte van vóór de overstap?' });
        continue;
      }
      const number = guessInvoiceNumber(text);
      if (out.length >= MAX_SUGGESTIONS) break;
      if (t.amount > 0) {
        if (openInvoiceAmounts.has(t.amount) && !number) continue;
        // zonder factuurnummer alleen de eerste twee maanden: later is het eerder nieuw werk
        if (!number && diffDays(date, t.transaction_date) > 60) continue;
        if (number && this.db.prepare('SELECT 1 FROM invoices WHERE number = ?').get(number)) continue;
        out.push({ txId: t.id, kind: 'klant', date: t.transaction_date, amount: t.amount, name, description: t.description, number, question: `Betaalde ${name} hiermee een factuur van vóór ${formatDateNl(date)}?` });
      } else if (t.amount < 0 && (number || /factuur|nota|invoice|rekening/i.test(text)) && diffDays(date, t.transaction_date) <= 60) {
        if (openPurchaseAmounts.has(-t.amount)) continue;
        out.push({ txId: t.id, kind: 'leverancier', date: t.transaction_date, amount: -t.amount, name, description: t.description, number, question: `Betaalde je hiermee een rekening van ${name} van vóór ${formatDateNl(date)}?` });
      }
    }
    return out;
  }

  /**
   * "Ja, dat klopt": het onderdeel van de startbalans maken en de betaling er meteen aan koppelen.
   * Bij de btw wordt de betaling geboekt op de btw-afrekening.
   */
  acceptSuggestion(txId: number, overrides: { relationName?: string; number?: string; invoiceDate?: IsoDate } = {}): OpeningItem {
    const date = this.date();
    const sug = this.suggestions().find((x) => x.txId === txId);
    if (!sug) throw new ValidationError('Deze betaling is al verwerkt of hoort er niet (meer) bij');
    return tx(this.db, () => {
      const invoiceDate = overrides.invoiceDate ?? addDays(date, -1);
      const relationName = overrides.relationName?.trim() || sug.name;
      if (sug.kind === 'klant') {
        const item = this.save({ kind: 'klant', relationName, number: overrides.number?.trim() || sug.number || `Vóór-${txId}`, invoiceDate, amount: sug.amount });
        this.bank.matchInvoice(txId, item.invoice_id!);
        return this.hydrate(this.row(item.id));
      }
      if (sug.kind === 'leverancier') {
        const item = this.save({ kind: 'leverancier', relationName, reference: overrides.number?.trim() || sug.number, invoiceDate, amount: sug.amount });
        this.bank.matchPurchase(txId, item.purchase_invoice_id!);
        return this.hydrate(this.row(item.id));
      }
      const t = this.bank.get(txId);
      const item = this.save({ kind: 'btw', direction: t.amount < 0 ? 'betalen' : 'terug', amount: sug.amount });
      this.bank.bookToAccount(txId, { account: ACCOUNTS.btwAfrekening, description: 'Btw vorige aangifte' });
      return item;
    });
  }

  dismissSuggestion(txId: number): void {
    const dismissed = new Set(this.cfg().dismissed);
    dismissed.add(txId);
    this.update({ dismissed: [...dismissed] });
  }

  // ---------- alles samen voor het scherm ----------

  state(): SwitchoverState {
    const s = this.settings.get();
    const cfg = s.switchover;
    const date = cfg.mode === 'overstapper' ? cfg.date : null;
    const items = date ? this.list() : [];
    const banks = date ? this.bankStatus(date) : [];
    const checks = date ? this.checks() : [];
    const kinds = new Set(items.map((i) => i.kind));
    const bad = (section: SectionKey) => checks.some((c) => c.section === section && c.level === 'probleem');
    const split = date ? this.splitPeriod(date) : null;
    const startOfYear = !!date?.endsWith('-01-01');
    const skipped = new Set(cfg.skipped ?? []);
    const sections: SwitchoverState['sections'] = [
      // klaar zodra er een route gekozen is: iets ingelezen of ingevuld, of "ik vul het zelf in"
      { key: 'papieren', title: 'Hoe stap je over?', done: !!date && (items.length > 0 || skipped.has('import')), needed: true },
      { key: 'import', title: 'Uit je vorige programma', done: items.some((i) => !!i.data.bron) || skipped.has('import'), needed: true },
      { key: 'bank', title: 'Bankrekeningen', done: !!date && banks.length > 0 && !bad('bank'), needed: true },
      { key: 'klanten', title: 'Klanten die nog moeten betalen', done: kinds.has('klant') || skipped.has('klanten') || cfg.status === 'klaar', needed: true },
      { key: 'leveranciers', title: 'Rekeningen die jij nog moet betalen', done: kinds.has('leverancier') || skipped.has('leveranciers') || cfg.status === 'klaar', needed: true },
      { key: 'bezit', title: 'Bus, auto en gereedschap', done: kinds.has('bezit') || skipped.has('bezit') || cfg.status === 'klaar', needed: true },
      { key: 'btw', title: 'Btw', done: s.kor || ((kinds.has('btw') || cfg.status === 'klaar') && !bad('btw')), needed: !s.kor },
      { key: 'resultaat', title: 'Omzet en kosten tot nu toe', done: kinds.has('resultaat'), needed: !!date && !startOfYear },
      { key: 'overig', title: 'Leningen en overig', done: kinds.has('lening') || kinds.has('vordering') || kinds.has('schuld') || skipped.has('overig') || cfg.status === 'klaar', needed: true },
      { key: 'klaar', title: 'Je startpositie', done: cfg.status === 'klaar', needed: true },
    ];
    return {
      settings: cfg,
      kor: s.kor,
      startOfYear,
      splitPeriod: split,
      sections,
      items,
      banks,
      position: date ? this.position() : null,
      checks,
      requirements: this.requirements(),
    };
  }
}
