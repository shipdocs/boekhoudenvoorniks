import { accountOpenItems, assertQuestionNotSettled } from '../core-ledger/open-items';
import type { Db } from '../db/database';
import { tx } from '../db/database';
import { Ledger, signedLine, type PostLine } from '../core-ledger/ledger';
import { ACCOUNTS } from '../core-ledger/accounts';
import { PURCHASE_VAT_RATES, isReverseCharge, type PurchaseVatCode } from '../shared/vat';
import { assertIsoDate, type IsoDate } from '../shared/dates';
import { assertCents, formatEuro, roundHalfAwayFromZero, type Cents } from '../shared/money';
import { isValidIban, normalizeIban, ValidationError } from '../shared/validation';
import { korActive } from '../settings/settings';

export type { PurchaseLineInput } from '../core-ledger/rules';
export { expenseLines, purchaseVat } from '../core-ledger/rules';
import { businessPct, expenseLines, purchaseVat, type InkoopPayload, type PurchaseLineInput } from '../core-ledger/rules';
import { businessShareFor, setBusinessShare } from '../intake/business-share';
import type { EventService, Evidence } from '../core-ledger/events';
import { forgetRejections } from './bank-purchase-match';

export interface PurchaseInvoiceInput {
  relationId?: number | null;
  supplierReference?: string | null;
  invoiceDate: IsoDate;
  dueDate?: IsoDate | null;
  description: string;
  lines: PurchaseLineInput[];
  attachmentPath?: string | null;
  /**
   * Zakelijk deel in procenten (1–100). Weglaten = wat eerder voor deze leverancier is opgegeven, anders 100.
   * Het privédeel telt niet als kosten en de btw erover wordt niet afgetrokken.
   */
  businessPct?: number;
  jobId?: number | null;
  documentId?: number | null;
  externalSource?: string | null;
  externalId?: string | null;
  /** IBAN van de leverancier zoals op het document, voor betalen met QR en de fraudecontrole */
  payeeIban?: string | null;
  /** aankoop in een andere munt (#74): het origineel en de koers, als uitleg bij de boeking in euro's */
  foreign?: { currency: string; total: Cents; rate: number } | null;
}

export interface PurchaseInvoice {
  id: number;
  relation_id: number | null;
  relation_name: string | null;
  supplier_reference: string | null;
  invoice_date: IsoDate;
  due_date: IsoDate | null;
  description: string;
  subtotal: Cents;
  vat_total: Cents;
  total: Cents;
  amount_paid: Cents;
  status: 'open' | 'betaald';
  journal_entry_id: number | null;
  attachment_path: string | null;
  job_id: number | null;
  document_id: number | null;
  payee_iban: string | null;
  /** garantietermijn in maanden (gereedschap, machines) */
  warranty_months: number | null;
  /** andere munt (#74): bv. 'USD', het bedrag in die munt en de koers (vreemde munt per euro) */
  currency: string | null;
  foreign_total: Cents | null;
  fx_rate: number | null;
  /** 1 = uit de vorige administratie (overstap): alleen het openstaande bedrag */
  is_opening: number;
  /** "Al betaald, via je bank" (#239): de rekening en de dag waarop dat is aangegeven; nog niets geboekt */
  expected_on_bank_account_id: number | null;
  expected_on_bank_since: IsoDate | null;
  open_amount: Cents;
}

export class PurchaseService {
  constructor(
    private readonly db: Db,
    private readonly ledger: Ledger,
    private readonly events: EventService,
  ) {}

  create(input: PurchaseInvoiceInput): PurchaseInvoice {
    assertIsoDate(input.invoiceDate, 'factuurdatum');
    if (input.dueDate) assertIsoDate(input.dueDate, 'vervaldatum');
    if (!input.description?.trim()) throw new ValidationError('Omschrijving is verplicht');
    if (input.lines.length === 0) throw new ValidationError('Voeg minimaal één regel toe');
    return tx(this.db, () => {
      // KOR: geen aftrek van voorbelasting; vastgelegd in de gebeurtenis, zodat hercompileren hetzelfde blijft
      const noVatDeduction = korActive(this.db);
      // de factuur zelf blijft wat hij is; het zakelijke deel bepaalt alleen wat er als kosten en voorbelasting geboekt wordt
      const booking = expenseLines(input.lines, ACCOUNTS.crediteuren, input.relationId ?? null, input.supplierReference ?? undefined, { noVatDeduction });
      const supplier = input.relationId ? (this.db.prepare('SELECT name FROM relations WHERE id = ?').get(input.relationId) as { name: string } | undefined)?.name : undefined;
      if (input.businessPct !== undefined && supplier) setBusinessShare(this.db, supplier, input.businessPct);
      const pct = businessPct(input.businessPct ?? businessShareFor(this.db, supplier));
      const vatPaid = booking.payable - booking.net;
      const result = this.db
        .prepare(
          `INSERT INTO purchase_invoices (relation_id, supplier_reference, invoice_date, due_date, description, subtotal, vat_total, total, attachment_path, job_id, document_id, external_source, external_id, payee_iban, currency, foreign_total, fx_rate)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(input.relationId ?? null, input.supplierReference ?? null, input.invoiceDate, input.dueDate ?? null, input.description.trim(), booking.net, vatPaid, booking.payable, input.attachmentPath ?? null, input.jobId ?? null, input.documentId ?? null, input.externalSource ?? null, input.externalId ?? null, input.payeeIban ? normalizeIban(input.payeeIban) : null, input.foreign?.currency ?? null, input.foreign?.total ?? null, input.foreign?.rate ?? null);
      const id = Number(result.lastInsertRowid);
      const evidence: Evidence[] = [{ kind: 'inkoop', refId: id }];
      if (input.documentId) evidence.push({ kind: 'document', refId: input.documentId });
      const { entryId } = this.events.record(
        {
          type: 'inkoop',
          payload: { purchaseId: id, date: input.invoiceDate, description: input.description.trim(), relationId: input.relationId ?? null, supplierReference: input.supplierReference ?? null, lines: input.lines, ...(noVatDeduction ? { noVatDeduction } : {}), ...(pct < 100 || input.businessPct !== undefined ? { businessPct: pct } : {}) },
        },
        evidence,
        { jobId: input.jobId ?? null },
      );
      const insertLine = this.db.prepare('INSERT INTO purchase_invoice_lines (purchase_invoice_id, account_id, description, net_amount, vat_code, vat_amount) VALUES (?, ?, ?, ?, ?, ?)');
      for (const l of input.lines) insertLine.run(id, this.ledger.getAccount(l.account).id, l.description ?? null, l.netAmount, l.vatCode, purchaseVat(l));
      this.db.prepare('UPDATE purchase_invoices SET journal_entry_id = ? WHERE id = ?').run(entryId, id);
      return this.get(id);
    });
  }

  /**
   * Andere kostensoort of btw-keuze voor een geboekte inkoop (#19): de gebeurtenis wordt vervangen
   * (tegenboeking + nieuwe post). Het te betalen bedrag mag niet veranderen als er al betaald is.
   */
  reclassify(id: number, lines: PurchaseLineInput[], reason = 'andere categorie'): PurchaseInvoice {
    return this.rewrite(id, () => lines, reason, { samePayable: true });
  }

  /** Staat (een deel van) deze aankoop nog op Vraagposten ("weet ik nog niet")? */
  isQuestion(id: number): boolean {
    const question = this.db
      .prepare(`SELECT 1 FROM purchase_invoice_lines l JOIN chart_of_accounts a ON a.id = l.account_id WHERE l.purchase_invoice_id = ? AND a.rgs_code = ?`)
      .get(id, ACCOUNTS.vraagposten) !== undefined;
    if (!question) return false;
    const p = this.get(id);
    return !p.journal_entry_id || accountOpenItems(this.db, ACCOUNTS.vraagposten).some(item => item.id === p.journal_entry_id);
  }

  /**
   * Een aankoop van "weet ik nog niet" alsnog indelen: één regel met de gekozen rekening en btw over het
   * hele bedrag (tegenboeking + nieuwe post, zoals reclassify). De betaling blijft staan.
   */
  resolveQuestion(id: number, input: { account: string; vatCode: PurchaseVatCode; description: string }): PurchaseInvoice {
    if (!this.isQuestion(id)) throw new ValidationError('Deze aankoop staat niet (meer) bij "weet ik nog niet"');
    const p = this.get(id);
    const rate = PURCHASE_VAT_RATES[input.vatCode].percentage;
    const verlegd = isReverseCharge(input.vatCode);
    // verlegd: het totaal is het bedrag zonder btw; anders zit de btw in het totaal
    const vat = verlegd || rate === 0 ? 0 : Math.round((p.total * rate) / (100 + rate));
    const updated = this.reclassify(id, [{ account: input.account, netAmount: p.total - vat, vatCode: input.vatCode, ...(verlegd ? {} : { vatAmount: vat }), description: input.description }], 'ingedeeld (was: weet ik nog niet)');
    // "Nog uitzoeken — Winkel" wordt "Materiaal — Winkel"
    this.db.prepare('UPDATE purchase_invoices SET description = ? WHERE id = ?').run(updated.description.replace(/^Nog uitzoeken\b/, input.description), id);
    return this.get(id);
  }

  /** De inkoop-gebeurtenis achter een journaalpost (voor het zakelijke deel), of null bij een oudere boeking. */
  eventFor(journalEntryId: number): InkoopPayload | null {
    const event = this.events.forEntry(journalEntryId);
    return event && event.type === 'inkoop' ? (event.payload as InkoopPayload) : null;
  }

  /** Ander zakelijk deel voor een geboekte inkoop (gemengd gebruik): tegenboeking + nieuwe post. */
  setBusinessPct(id: number, pct: number, reason = 'zakelijk deel aangepast'): PurchaseInvoice {
    return this.rewrite(id, (old) => old, reason, { samePayable: true, businessPct: pct });
  }

  /**
   * Een aankoop die in een andere munt was maar als euro's is geboekt (van vóór #74, of zonder bon
   * ingevoerd): omrekenen naar het bedrag in euro's. Alle regels gaan naar verhouding mee (kosten en
   * btw); het afrondingsverschil komt op de laatste regel, zodat het totaal precies klopt.
   * Een betaling die er al bij hoort blijft staan; er mag alleen niet meer betaald zijn dan het nieuwe bedrag.
   */
  revalue(id: number, euroTotal: Cents, foreign: { currency: string; total: Cents }, reason = 'omgerekend naar euro\'s'): PurchaseInvoice {
    assertCents(euroTotal);
    assertCents(foreign.total);
    if (euroTotal <= 0 || foreign.total <= 0) throw new ValidationError('Vul beide bedragen in');
    if (!/^[A-Z]{3}$/.test(foreign.currency) || foreign.currency === 'EUR') throw new ValidationError('Kies de munt van de bon');
    return tx(this.db, () => {
      const before = this.get(id);
      if (before.amount_paid > euroTotal) throw new ValidationError('Er is al meer betaald dan het bedrag in euro\'s. Maak eerst de betaling ongedaan.');
      const p = before.total === euroTotal ? before : this.rewrite(id, (old) => scaleLines(old, before.total, euroTotal), reason, { samePayable: false });
      if (p.total !== euroTotal) throw new Error(`Omrekenen klopt niet: ${p.total} ≠ ${euroTotal}`);
      this.db.prepare('UPDATE purchase_invoices SET currency = ?, foreign_total = ?, fx_rate = ? WHERE id = ?').run(foreign.currency, foreign.total, foreign.total / euroTotal, id);
      return this.get(id);
    });
  }

  /** Vervangt de regels van een geboekte inkoop: tegenboeking + nieuwe post (#19). */
  private rewrite(id: number, next: (old: PurchaseLineInput[]) => PurchaseLineInput[], reason: string, opts: { samePayable: boolean; businessPct?: number }): PurchaseInvoice {
    return tx(this.db, () => {
      const p = this.get(id);
      if (p.is_opening) throw new ValidationError('Deze rekening komt uit je vorige administratie. Pas hem aan in de overstap-hulp');
      if (!p.journal_entry_id) throw new ValidationError('Deze aankoop kan niet aangepast worden');
      assertQuestionNotSettled(this.db, p.journal_entry_id);
      const event = this.events.forEntry(p.journal_entry_id);
      if (!event || event.type !== 'inkoop') throw new ValidationError('Deze aankoop is met een oudere versie van de app verwerkt en kan zo niet aangepast worden. Vraag je boekhouder.');
      const old = event.payload as InkoopPayload;
      const lines = next(old.lines);
      if (lines.length === 0) throw new ValidationError('Voeg minimaal één regel toe');
      const booking = expenseLines(lines, ACCOUNTS.crediteuren, p.relation_id, p.supplier_reference ?? undefined, { noVatDeduction: old.noVatDeduction });
      if (opts.samePayable && p.amount_paid !== 0 && booking.payable !== p.total) throw new ValidationError('Het te betalen bedrag verandert; maak eerst de betaling ongedaan');
      const payload: InkoopPayload = { ...old, lines };
      if (opts.businessPct !== undefined) {
        const pct = businessPct(opts.businessPct);
        if (pct < 100) payload.businessPct = pct;
        else payload.businessPct = pct;
      }
      const { entryId } = this.events.replace(event.id, { type: 'inkoop', payload }, reason);
      this.db
        .prepare('UPDATE purchase_invoices SET journal_entry_id = ?, subtotal = ?, vat_total = ?, total = ?, status = ? WHERE id = ?')
        .run(entryId, booking.net, booking.payable - booking.net, booking.payable, paidStatus(booking.payable, p.amount_paid), id);
      this.db.prepare('DELETE FROM purchase_invoice_lines WHERE purchase_invoice_id = ?').run(id);
      const insertLine = this.db.prepare('INSERT INTO purchase_invoice_lines (purchase_invoice_id, account_id, description, net_amount, vat_code, vat_amount) VALUES (?, ?, ?, ?, ?, ?)');
      for (const l of lines) insertLine.run(id, this.ledger.getAccount(l.account).id, l.description ?? null, l.netAmount, l.vatCode, purchaseVat(l));
      return this.get(id);
    });
  }

  /**
   * settleFx: aankoop in een andere munt (#74) waarvan de bank een iets ander bedrag afschreef dan
   * geschat. Dan is de aankoop helemaal betaald en gaat het verschil naar "Koersverschillen".
   * Bij een creditnota (bedrag onder nul) is de betaling het geld dat terugkomt: ook onder nul.
   */
  registerPayment(id: number, payment: { amount: Cents; date: IsoDate; moneyAccount?: string; bankTransactionId?: number | null; settleFx?: boolean }): PurchaseInvoice {
    assertCents(payment.amount);
    assertIsoDate(payment.date);
    return tx(this.db, () => {
      const p = this.get(id);
      const settled = payment.settleFx && p.currency ? p.open_amount : payment.amount;
      this.assertNotOverpaid(p, settled);
      const diff = settled - payment.amount; // positief: minder betaald dan geschat (winst), negatief: meer (verlies)
      const entryId = this.ledger.post({
        date: payment.date,
        description: `Betaling inkoop: ${p.description}`,
        source: 'bank',
        sourceRef: `purchase:${id}`,
        lines: [
          signedLine(ACCOUNTS.crediteuren, settled, { relationId: p.relation_id })!,
          signedLine(payment.moneyAccount ?? ACCOUNTS.bank, -payment.amount)!,
          diff !== 0 ? signedLine(ACCOUNTS.koersverschillen, -diff, { description: `Koersverschil ${p.currency}` })! : null,
        ].filter((l): l is NonNullable<typeof l> => l !== null),
      });
      const paid = p.amount_paid + settled;
      this.db.prepare('UPDATE purchase_invoices SET amount_paid = ?, status = ? WHERE id = ?').run(paid, paidStatus(p.total, paid), id);
      this.redeductAfterRepayment(id, p.description, p.relation_id, settled, payment.date);
      if (payment.bankTransactionId) {
        this.db
          .prepare(`UPDATE bank_transactions SET status = 'gematcht', matched_journal_entry_id = ?, matched_purchase_invoice_id = ? WHERE id = ?`)
          .run(entryId, id, payment.bankTransactionId);
      }
      return this.get(id);
    });
  }

  /**
   * Een inkoop die je niet betaalt: de voorbelasting over het openstaande deel moet je terugbetalen, uiterlijk 1 jaar na de
   * uiterste betaaldatum (art. 29 Wet OB; belastingdienst.nl, 2026-10-04). De btw wordt dan kosten (of onderdeel van de kostprijs).
   * Betaal je later alsnog, dan mag je die btw weer aftrekken (zie `redeductAfterRepayment`).
   */
  repayInputVat(id: number, date: IsoDate): PurchaseInvoice {
    assertIsoDate(date, 'datum');
    return tx(this.db, () => {
      const p = this.get(id);
      if (p.status !== 'open' || p.open_amount <= 0 || p.total <= 0) throw new ValidationError('Alleen bij een inkoop die nog (deels) openstaat kun je de btw terugnemen');
      if (korActive(this.db)) throw new ValidationError('Je gebruikt de KOR: je trok geen btw af, dus er is niets terug te nemen');
      if (!p.journal_entry_id) throw new ValidationError('Deze inkoop is nog niet geboekt');
      if (this.db.prepare('SELECT 1 FROM purchase_vat_repayments WHERE purchase_id = ? AND paid_since < basis').get(id)) throw new ValidationError('Voor deze inkoop is de btw al teruggenomen');
      const rows = this.db.prepare(`SELECT l.debit, l.credit, a.rgs_code, a.category FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id WHERE l.journal_entry_id = ?`).all(p.journal_entry_id) as { debit: Cents; credit: Cents; rgs_code: string; category: string }[];
      const deducted = rows.filter((r) => r.rgs_code === ACCOUNTS.btwVoorbelasting).reduce((n, r) => n + r.debit - r.credit, 0);
      if (deducted <= 0) throw new ValidationError('Op deze inkoop is geen btw afgetrokken');
      const base = rows.filter((r) => (r.category === 'kosten' || r.category === 'activa') && r.debit > 0);
      const baseTotal = base.reduce((n, r) => n + r.debit, 0);
      if (baseTotal <= 0) throw new ValidationError('Kon de kosten van deze inkoop niet bepalen');
      const vat = Math.round((deducted * p.open_amount) / p.total);
      if (vat <= 0) throw new ValidationError('Er is geen btw om terug te nemen over het openstaande bedrag');
      const debits = base.map((r) => ({ account: r.rgs_code, debit: Math.round((vat * r.debit) / baseTotal) }));
      debits[0]!.debit += vat - debits.reduce((n, d) => n + d.debit, 0);
      const entryId = this.ledger.post({
        date,
        description: `Btw terugnemen, inkoop niet betaald: ${p.description}`,
        source: 'handmatig',
        sourceRef: `purchase:${id}`,
        lines: [...debits.filter((d) => d.debit !== 0), { account: ACCOUNTS.btwVoorbelasting, credit: vat }],
      });
      this.db.prepare('INSERT INTO purchase_vat_repayments (purchase_id, journal_entry_id, vat_amount, basis, repaid_on) VALUES (?, ?, ?, ?, ?)').run(id, entryId, vat, p.open_amount, date);
      return this.get(id);
    });
  }

  /** Betaal je na het terugnemen van de btw alsnog, dan trek je de btw over dat deel weer af, in het tijdvak van de betaling. */
  private redeductAfterRepayment(id: number, description: string, relationId: number | null, settled: Cents, date: IsoDate): void {
    if (settled <= 0 || !this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'purchase_vat_repayments'").get()) return;
    const r = this.db.prepare('SELECT * FROM purchase_vat_repayments WHERE purchase_id = ? AND paid_since < basis ORDER BY id LIMIT 1').get(id) as
      | { id: number; journal_entry_id: number; vat_amount: Cents; basis: Cents; paid_since: Cents; rededucted: Cents }
      | undefined;
    if (!r) return;
    const part = Math.min(settled, r.basis - r.paid_since);
    const done = r.paid_since + part >= r.basis;
    const vat = done ? r.vat_amount - r.rededucted : Math.round((r.vat_amount * part) / r.basis);
    if (vat > 0) {
      const original = this.db.prepare(`SELECT l.debit, a.rgs_code FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id WHERE l.journal_entry_id = ? AND l.debit > 0`).all(r.journal_entry_id) as { debit: Cents; rgs_code: string }[];
      const total = original.reduce((n, o) => n + o.debit, 0);
      const credits = original.map((o) => ({ account: o.rgs_code, credit: Math.round((vat * o.debit) / total) }));
      credits[0]!.credit += vat - credits.reduce((n, c) => n + c.credit, 0);
      this.ledger.post({
        date,
        description: `Btw weer aftrekken, inkoop alsnog betaald: ${description}`,
        source: 'handmatig',
        sourceRef: `purchase:${id}`,
        lines: [{ account: ACCOUNTS.btwVoorbelasting, debit: vat }, ...credits.filter((c) => c.credit !== 0)],
      });
    }
    this.db.prepare('UPDATE purchase_vat_repayments SET paid_since = paid_since + ?, rededucted = rededucted + ? WHERE id = ?').run(part, vat > 0 ? vat : 0, r.id);
    void relationId;
  }

  /**
   * Nooit meer betalen dan er open staat (#221, #227): dat geeft een vordering op de leverancier die er
   * niet is. Er kan ook niet meer terugkomen dan er betaald is. Bij een creditnota is het andersom: daar
   * komt geld op terug, hooguit het bedrag ervan. Geldt voor elke betaling: bank, contant en privé.
   */
  private assertNotOverpaid(p: PurchaseInvoice, settled: Cents): void {
    if (settled === 0) return;
    const credit = p.total < 0;
    const paid = p.amount_paid + settled;
    // de andere kant op (geld terug op een aankoop, een betaling op een creditnota): hooguit wat er al op stond
    if (settled > 0 === credit) {
      if (credit ? paid <= 0 : paid >= 0) return;
      throw new ValidationError(
        credit
          ? 'Dit is een creditnota: daar komt geld op terug, er gaat geen betaling heen.'
          : p.amount_paid === 0
            ? 'Bij deze aankoop is nog niets betaald: er kan geen geld op terugkomen. Kreeg je geld terug van de leverancier? Voer dan de creditnota in, of kies "Geld terug van een aankoop".'
            : `Bij deze aankoop is ${formatEuro(p.amount_paid)} betaald: er kan niet meer op terugkomen.`,
      );
    }
    if (credit ? paid >= p.total : paid <= p.total) return;
    if (p.open_amount === 0) throw new ValidationError(credit ? 'Deze creditnota is al afgehandeld' : 'Deze aankoop staat al op betaald');
    throw new ValidationError(
      credit
        ? `Dit bedrag is hoger dan wat er bij deze creditnota nog open staat (${formatEuro(-p.open_amount)}).`
        : `Deze betaling is hoger dan wat er bij deze aankoop nog open staat (${formatEuro(p.open_amount)}). Klopt het bedrag van de aankoop niet? Pas dat eerst aan bij Aankopen.`,
    );
  }

  /**
   * "Al betaald, via je bank" (#239): onthoudt dat deze open aankoop al van die rekening betaald is, zonder iets
   * te boeken. De afschriftimport koppelt de betaling later (of vraagt of ze bij elkaar horen).
   */
  expectOnBank(id: number, bankAccountId: number, since: IsoDate): PurchaseInvoice {
    assertIsoDate(since);
    const p = this.get(id);
    if (p.status !== 'open' || p.open_amount <= 0) throw new ValidationError('Deze rekening staat al op betaald');
    this.db.prepare('UPDATE purchase_invoices SET expected_on_bank_account_id = ?, expected_on_bank_since = ? WHERE id = ?').run(bankAccountId, since, id);
    return this.get(id);
  }

  /** De markering "via bank betaald" weghalen: de aankoop telt weer als gewoon open. */
  clearExpectedOnBank(id: number): void {
    this.db.prepare('UPDATE purchase_invoices SET expected_on_bank_account_id = NULL, expected_on_bank_since = NULL WHERE id = ?').run(id);
  }

  undoPayment(id: number, amount: Cents, journalEntryId: number, date: IsoDate): PurchaseInvoice {
    return tx(this.db, () => {
      // wat deze betaling op de leverancier afboekte (bij een koersverschil meer dan het bankbedrag)
      const booked = this.db
        .prepare(`SELECT COALESCE(SUM(l.debit - l.credit), 0) AS s FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id WHERE l.journal_entry_id = ? AND a.rgs_code = ?`)
        .get(journalEntryId, ACCOUNTS.crediteuren) as { s: number };
      this.ledger.reverse(journalEntryId, date);
      const p = this.get(id);
      const paid = p.amount_paid - (booked.s !== 0 ? booked.s : amount);
      this.db.prepare('UPDATE purchase_invoices SET amount_paid = ?, status = ? WHERE id = ?').run(paid, paidStatus(p.total, paid), id);
      return this.get(id);
    });
  }

  /**
   * Draait een (nog onbetaalde) inkoop terug, bv. na "Klopt niet" op een automatische verwerking.
   * De journaalpost krijgt een tegenboeking; het document gaat terug naar controle en is nergens meer aan gekoppeld.
   */
  cancel(id: number, date: IsoDate): void {
    tx(this.db, () => {
      const p = this.get(id);
      if (p.amount_paid !== 0) throw new ValidationError('Maak eerst de betaling van deze aankoop ongedaan');
      if (p.journal_entry_id) this.ledger.reverse(p.journal_entry_id, date, `Teruggedraaid: ${p.description}`);
      // de bon hoort nergens meer bij (#179); een kopie blijft een kopie van het document dat terug naar controle gaat
      this.db.prepare('DELETE FROM document_links WHERE purchase_invoice_id = ?').run(id);
      this.db.prepare(`UPDATE documents SET purchase_invoice_id = NULL, status = CASE WHEN duplicate_of_document_id IS NOT NULL THEN 'genegeerd' ELSE 'controle' END WHERE purchase_invoice_id = ?`).run(id);
      this.db.prepare('DELETE FROM purchase_invoices WHERE id = ?').run(id);
      // het nummer van deze aankoop komt terug bij een volgende: die mag het "nee" van deze niet erven (#221)
      forgetRejections(this.db, id);
    });
  }

  /**
   * Betaalgegevens met fraudecontrole (#25): wijkt het IBAN af van wat we eerder van deze
   * leverancier kenden, dan eerst een waarschuwing en pas na bevestiging een betaal-QR.
   */
  paymentInfo(id: number): { purchase: PurchaseInvoice; iban: string | null; name: string; knownIbans: string[]; ibanChanged: boolean; ibanValid: boolean } {
    const p = this.get(id);
    const relation = p.relation_id
      ? (this.db.prepare('SELECT name, iban FROM relations WHERE id = ?').get(p.relation_id) as { name: string; iban: string | null } | undefined)
      : undefined;
    const earlier = p.relation_id
      ? (this.db.prepare('SELECT DISTINCT payee_iban FROM purchase_invoices WHERE relation_id = ? AND id < ? AND payee_iban IS NOT NULL').all(p.relation_id, id) as { payee_iban: string }[]).map((r) => r.payee_iban)
      : [];
    const known = [...new Set([...(relation?.iban ? [normalizeIban(relation.iban)] : []), ...earlier])];
    const iban = p.payee_iban ?? known[0] ?? null;
    return {
      purchase: p,
      iban,
      name: relation?.name ?? p.relation_name ?? p.description,
      knownIbans: known,
      ibanChanged: !!iban && known.length > 0 && !known.includes(iban),
      ibanValid: !!iban && isValidIban(iban),
    };
  }

  get(id: number): PurchaseInvoice {
    const row = this.db
      .prepare('SELECT p.*, r.name AS relation_name FROM purchase_invoices p LEFT JOIN relations r ON r.id = p.relation_id WHERE p.id = ?')
      .get(id) as Omit<PurchaseInvoice, 'open_amount'> | undefined;
    if (!row) throw new ValidationError('Deze aankoop bestaat niet (meer)');
    return { ...row, open_amount: row.total - row.amount_paid };
  }

  list(filter: { status?: 'open' | 'betaald' } = {}): PurchaseInvoice[] {
    const rows = this.db
      .prepare(`SELECT p.*, r.name AS relation_name FROM purchase_invoices p LEFT JOIN relations r ON r.id = p.relation_id ${filter.status ? 'WHERE p.status = ?' : ''} ORDER BY p.invoice_date DESC, p.id DESC`)
      .all(...(filter.status ? [filter.status] : [])) as Omit<PurchaseInvoice, 'open_amount'>[];
    return rows.map((r) => ({ ...r, open_amount: r.total - r.amount_paid }));
  }

  listOpen(): PurchaseInvoice[] {
    return this.list({ status: 'open' });
  }
}

/** Betaald als er niets meer open staat; bij een creditnota (bedrag onder nul) telt wat er terugkwam. */
function paidStatus(total: Cents, paid: Cents): 'open' | 'betaald' {
  return (total < 0 ? paid <= total : paid >= total) ? 'betaald' : 'open';
}

/**
 * Regels naar verhouding naar een nieuw totaal (te betalen bedrag). Btw gaat mee; bij verlegde btw
 * rekent de app die opnieuw uit over het nieuwe bedrag. Het restje van het afronden gaat op de
 * laatste regel, zodat het totaal precies het nieuwe bedrag is.
 */
export function scaleLines(lines: PurchaseLineInput[], fromTotal: Cents, toTotal: Cents): PurchaseLineInput[] {
  if (fromTotal <= 0) throw new ValidationError('Deze aankoop heeft geen bedrag om om te rekenen');
  const f = toTotal / fromTotal;
  const scaled = lines.map((l): PurchaseLineInput => {
    const { vatAmount: _vat, ...rest } = l;
    const netAmount = Math.round(l.netAmount * f);
    return isReverseCharge(l.vatCode) ? { ...rest, netAmount } : { ...rest, netAmount, vatAmount: Math.round(purchaseVat(l) * f) };
  });
  const payable = expenseLines(scaled, ACCOUNTS.crediteuren, null).payable;
  const last = scaled[scaled.length - 1]!;
  scaled[scaled.length - 1] = { ...last, netAmount: last.netAmount + (toTotal - payable) };
  return scaled;
}
