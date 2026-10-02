import type { Db } from '../db/database';
import { tx } from '../db/database';
import type { Ledger, PostLine } from '../core-ledger/ledger';
import { signedLine } from '../core-ledger/ledger';
import { ACCOUNTS, REVERSE_CHARGE_ACCOUNTS } from '../core-ledger/accounts';
import { PURCHASE_VAT_RATES } from '../shared/vat';
import { formatEuro, roundHalfAwayFromZero } from '../shared/money';
import { NON_DEDUCTIBLE_VAT } from '../core-ledger/rules';
import { korActive } from '../settings/settings';
import type { InvoiceService } from '../documents/invoices';
import type { RelationsService } from '../relations/relations';
import type { SalesVatCode } from '../shared/vat';
import type { BankService } from '../import/bank';
import { computeTotals } from '../documents/totals';
import { detectOwnCustomer, type OwnIdentity } from '../intake/own-company';
import { ValidationError } from '../shared/validation';
import type { Cents } from '../shared/money';
import { WOOCOMMERCE, fetchWooOrders } from './woocommerce';
import { SHOPIFY, fetchShopifyOrders } from './shopify';
import { MOLLIE, MOLLIE_FACTUREN, fetchMollieSettlements, fetchMollieSalesInvoices } from './mollie';
import { STRIPE, fetchStripePayouts } from './stripe';
import type { ExternalOrder, ExternalPayout, FetchLike, IntegrationDefinition, SecretStore, SyncResult } from './types';

export const INTEGRATIONS: IntegrationDefinition[] = [WOOCOMMERCE, SHOPIFY, MOLLIE_FACTUREN, MOLLIE, STRIPE];

/**
 * Verlegde btw over buitenlandse transactiekosten: aangeven en tegelijk aftrekken (per saldo nul).
 * Onder de KOR geen aftrek: de btw komt dan bij de kosten.
 */
function reverseChargeLines(net: number, noVatDeduction = false): (PostLine | null)[] {
  const vat = roundHalfAwayFromZero((net * PURCHASE_VAT_RATES.eu.percentage) / 100);
  return [
    noVatDeduction ? signedLine(ACCOUNTS.bankkosten, vat, { vatCode: NON_DEDUCTIBLE_VAT, description: 'Niet-aftrekbare btw' }) : signedLine(ACCOUNTS.btwVoorbelasting, vat, { vatCode: 'eu' }),
    signedLine(REVERSE_CHARGE_ACCOUNTS.eu, -vat, { vatCode: 'eu' }),
  ];
}

export interface IntegrationState {
  definition: IntegrationDefinition;
  enabled: boolean;
  config: Record<string, string>;
  /** welke geheime velden zijn ingevuld (waarden worden nooit naar de UI gestuurd) */
  secretsSet: Record<string, boolean>;
  lastSyncAt: string | null;
  lastError: string | null;
}

function vatCodeFor(pct: number): SalesVatCode {
  if (pct === 21) return 'hoog';
  if (pct === 9) return 'laag';
  return 'nul';
}

/** De regels van een order zoals ze op de factuur komen. */
function invoiceLines(order: ExternalOrder) {
  return order.lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPriceExVat, vatCode: vatCodeFor(l.vatPercentage), vatPercentage: l.vatPercentage }));
}

/** Wat de gebruiker kiest bij een verkoop aan het eigen bedrijf (#231): geen omzet, of toch een gewone verkoop. */
export type SaleAnswer = 'neutraal' | 'verkoop';

/** Een verkoop uit een koppeling die nog niet geboekt is: eerst de keuze van de gebruiker (#231). */
export interface SaleQuestion {
  id: number;
  source: string;
  /** de koppeling in gewone woorden ("Mollie Facturen") */
  label: string;
  reason: 'eigen-bedrijf';
  order: ExternalOrder;
  /** het bedrag van de verkoop, inclusief btw */
  total: Cents;
  /** waarom de app het vraagt, in gewone woorden (voor "Waarom?") */
  signals: string[];
}

/**
 * Fase 3: webshop- en betaalproviderkoppelingen. Losstaand van de MVP: zonder configuratie
 * doet deze module niets. Orders worden gewone facturen; uitbetalingen gewone journaalposten.
 */
export class IntegrationService {
  constructor(
    private readonly db: Db,
    private readonly ledger: Ledger,
    private readonly invoices: InvoiceService,
    private readonly relations: RelationsService,
    private readonly secrets: SecretStore,
    private readonly fetchImpl: FetchLike,
  ) {}

  /** je eigen bedrijf, om een verkoop aan jezelf te herkennen, en de bank voor geld dat daar al op staat (#231) */
  private ownIdentity: () => OwnIdentity | null = () => null;
  private bank: BankService | null = null;
  setOwnCompany(identity: () => OwnIdentity | null, bank: BankService): void {
    this.ownIdentity = identity;
    this.bank = bank;
  }

  private definition(id: string): IntegrationDefinition {
    const def = INTEGRATIONS.find((d) => d.id === id);
    if (!def) throw new Error(`Onbekende koppeling: ${id}`);
    return def;
  }

  private row(id: string) {
    return this.db.prepare('SELECT * FROM integrations WHERE provider = ?').get(id) as
      | { provider: string; enabled: number; config: string; last_sync_at: string | null; last_error: string | null }
      | undefined;
  }

  list(): IntegrationState[] {
    return INTEGRATIONS.map((d) => this.state(d.id));
  }

  state(id: string): IntegrationState {
    const def = this.definition(id);
    const row = this.row(id);
    const config = row ? (JSON.parse(row.config) as Record<string, string>) : {};
    const secretsSet: Record<string, boolean> = {};
    for (const f of def.fields.filter((f) => f.type === 'secret')) secretsSet[f.key] = this.secrets.get(`integration:${id}:${f.key}`) !== null;
    return { definition: def, enabled: Boolean(row?.enabled), config, secretsSet, lastSyncAt: row?.last_sync_at ?? null, lastError: row?.last_error ?? null };
  }

  configure(id: string, values: Record<string, string>, enabled: boolean): IntegrationState {
    const def = this.definition(id);
    const current = this.state(id).config;
    const config: Record<string, string> = { ...current };
    for (const f of def.fields) {
      const v = values[f.key];
      if (v === undefined || v === '') continue;
      if (f.type === 'secret') this.secrets.set(`integration:${id}:${f.key}`, v.trim());
      else config[f.key] = v.trim();
    }
    this.db
      .prepare(
        `INSERT INTO integrations (provider, enabled, config) VALUES (?, ?, ?)
         ON CONFLICT(provider) DO UPDATE SET enabled = excluded.enabled, config = excluded.config`,
      )
      .run(id, enabled ? 1 : 0, JSON.stringify(config));
    return this.state(id);
  }

  disconnect(id: string): void {
    const def = this.definition(id);
    for (const f of def.fields.filter((f) => f.type === 'secret')) this.secrets.delete(`integration:${id}:${f.key}`);
    this.db.prepare('DELETE FROM integrations WHERE provider = ?').run(id);
  }

  private values(id: string): Record<string, string> {
    const def = this.definition(id);
    const s = this.state(id);
    const out: Record<string, string> = { ...s.config };
    for (const f of def.fields) {
      if (f.type === 'secret') out[f.key] = this.secrets.get(`integration:${id}:${f.key}`) ?? '';
      if (!out[f.key]) throw new Error(`${def.label}: "${f.label}" is niet ingevuld`);
    }
    return out;
  }

  async sync(id: string): Promise<SyncResult> {
    const def = this.definition(id);
    const started = new Date().toISOString();
    try {
      const cfg = this.values(id);
      const since = this.state(id).lastSyncAt;
      let result: SyncResult;
      if (id === 'woocommerce') {
        result = this.importOrders(id, await fetchWooOrders(this.fetchImpl, { url: cfg.url!, consumerKey: cfg.consumerKey!, consumerSecret: cfg.consumerSecret! }, since));
      } else if (id === 'shopify') {
        result = this.importOrders(id, await fetchShopifyOrders(this.fetchImpl, { shop: cfg.shop!, accessToken: cfg.accessToken! }, since));
      } else if (id === 'mollie-facturen') {
        result = this.importOrders(id, await fetchMollieSalesInvoices(this.fetchImpl, { apiKey: cfg.apiKey! }, this.knownOrders(id)));
      } else if (id === 'mollie') {
        result = this.importPayouts(id, await fetchMollieSettlements(this.fetchImpl, { apiKey: cfg.apiKey! }, this.knownPayouts(id)));
      } else {
        result = this.importPayouts(id, await fetchStripePayouts(this.fetchImpl, { apiKey: cfg.apiKey! }, this.knownPayouts(id)));
      }
      this.db.prepare('UPDATE integrations SET last_sync_at = ?, last_error = NULL WHERE provider = ?').run(started, id);
      return result;
    } catch (e) {
      this.db.prepare('UPDATE integrations SET last_error = ? WHERE provider = ?').run((e as Error).message, id);
      throw new Error(`${def.label}: ${(e as Error).message}`);
    }
  }

  async syncAllEnabled(): Promise<Record<string, SyncResult | { error: string }>> {
    const out: Record<string, SyncResult | { error: string }> = {};
    for (const s of this.list().filter((x) => x.enabled)) {
      try {
        out[s.definition.id] = await this.sync(s.definition.id);
      } catch (e) {
        out[s.definition.id] = { error: (e as Error).message };
      }
    }
    return out;
  }

  /**
   * Webshop-orders → definitieve facturen, betaald via de tussenrekening betaalprovider. Een verkoop aan je
   * eigen bedrijf (#231) wordt geen omzet: die wacht als vraag op Vandaag, en er is dan nog niets geboekt.
   */
  importOrders(source: string, orders: ExternalOrder[]): SyncResult {
    const result: SyncResult = { created: 0, skipped: 0, messages: [] };
    for (const order of orders) {
      if (!order.paid) {
        result.skipped++;
        continue;
      }
      if (order.currency !== 'EUR') {
        result.skipped++;
        result.messages.push(`Order ${order.number} overgeslagen: valuta ${order.currency} wordt niet ondersteund`);
        continue;
      }
      if (this.db.prepare('SELECT 1 FROM invoices WHERE external_source = ? AND external_id = ?').get(source, order.externalId)) {
        result.skipped++;
        continue;
      }
      // wacht al op een antwoord, of is al beantwoord (ook "geen omzet"): niet opnieuw
      if (this.db.prepare('SELECT 1 FROM integration_questions WHERE source = ? AND external_id = ?').get(source, order.externalId)) {
        result.skipped++;
        continue;
      }
      const own = this.ownIdentity();
      const ownSale = own ? detectOwnCustomer(order.customer, own) : null;
      if (ownSale) {
        this.db.prepare(`INSERT INTO integration_questions (source, external_id, reason, order_data, signals) VALUES (?, ?, 'eigen-bedrijf', ?, ?)`).run(source, order.externalId, JSON.stringify(order), JSON.stringify(ownSale.signals));
        result.skipped++;
        result.messages.push(`Order ${order.number}: de klant is je eigen bedrijf. Niet als omzet geboekt; kies op Vandaag wat het was.`);
        continue;
      }
      try {
        this.bookOrder(source, order, result.messages);
        result.created++;
      } catch (e) {
        result.messages.push(`Order ${order.number}: ${(e as Error).message}`);
      }
    }
    return result;
  }

  /** Eén order als definitieve, betaalde factuur: verrekend met de bankregel als die er al staat, anders via de tussenrekening. */
  private bookOrder(source: string, order: ExternalOrder, messages: string[]): void {
    tx(this.db, () => {
      const c = order.customer;
      const relation =
        (c.email ? this.relations.findByEmail(c.email) : undefined) ??
        this.relations.create({ name: c.name, email: c.email, address: c.address, postcode: c.postcode, city: c.city, country: c.country ?? 'NL', vat_number: c.vatNumber ?? undefined, type: 'klant' });
      if (c.country && c.country !== 'NL' && order.lines.some((l) => l.vatPercentage === 0)) {
        messages.push(`Order ${order.number}: buitenlandse klant met 0% BTW — controleer of dit ICP (rubriek 3b) of OSS is.`);
      }
      const draft = this.invoices.createDraft({
        relationId: relation.id,
        invoiceDate: order.date,
        dueDate: order.date,
        reference: `Webshoporder ${order.number}`,
        externalSource: source,
        externalId: order.externalId,
        lines: invoiceLines(order),
      });
      const inv = this.invoices.finalize(draft.id);
      const bank = this.bankPaymentFor(order, inv.total!)?.row;
      if (bank?.status === 'gematcht') {
        // rollback: deze order is al als omzet geboekt via de bank; een factuur erbij telt de omzet dubbel
        throw new Error(`overgeslagen: de bankbetaling van ${formatEuro(inv.total!)} (${bank.transaction_date}) is al als verkoop geboekt. Zet die boeking terug op 'nieuw' en lees de order daarna opnieuw in, dan wordt de factuur direct met de bank verrekend`);
      }
      if (bank) {
        this.invoices.registerPayment(inv.id, { amount: inv.total!, date: bank.transaction_date, moneyAccount: bank.rgs_code, bankTransactionId: bank.id, description: `Ontvangst ${bank.counter_name ?? ''} factuur`.replace(/\s+/g, ' ') });
      } else {
        this.invoices.registerPayment(inv.id, { amount: inv.total!, date: order.date, moneyAccount: ACCOUNTS.tussenrekeningPsp, description: `Betaling webshoporder ${order.number}` });
      }
    });
  }

  /** Verkopen die op een keuze wachten (#231), oudste eerst. Er is voor deze orders nog niets geboekt. */
  questions(): SaleQuestion[] {
    const rows = this.db.prepare(`SELECT id, source, order_data, signals FROM integration_questions WHERE answer IS NULL AND reason = 'eigen-bedrijf' ORDER BY id`).all() as { id: number; source: string; order_data: string; signals: string }[];
    return rows.map((r) => {
      const order = JSON.parse(r.order_data) as ExternalOrder;
      return { id: r.id, source: r.source, label: INTEGRATIONS.find((d) => d.id === r.source)?.label ?? r.source, reason: 'eigen-bedrijf', order, total: computeTotals(invoiceLines(order)).total, signals: JSON.parse(r.signals) as string[] };
    });
  }

  /**
   * De keuze bij een verkoop aan je eigen bedrijf (#231). 'verkoop': toch een gewone betaalde factuur, met
   * omzet en btw. 'neutraal': geen factuur, geen omzet en geen btw; het geld dat de betaaldienst ervoor
   * uitbetaalt telt als privé-storting. Dat staat op de tussenrekening, net als bij een gewone verkoop, zodat
   * de uitbetaling daarna aansluit. Staat het geld al op de bank (het ordernummer in de omschrijving), dan
   * gaat die bankregel naar privé-stortingen. Eén antwoord per order.
   */
  answerQuestion(id: number, answer: SaleAnswer): void {
    if (answer !== 'neutraal' && answer !== 'verkoop') throw new ValidationError('Kies "Geen omzet" of "Toch een echte verkoop"');
    tx(this.db, () => {
      const row = this.db.prepare('SELECT source, order_data, answer FROM integration_questions WHERE id = ?').get(Number(id)) as { source: string; order_data: string; answer: string | null } | undefined;
      if (!row) throw new ValidationError('Deze vraag bestaat niet (meer)');
      if (row.answer) throw new ValidationError('Deze vraag is al beantwoord. Kijk het opnieuw na.');
      const order = JSON.parse(row.order_data) as ExternalOrder;
      let entryId: number | null = null;
      if (answer === 'verkoop') this.bookOrder(row.source, order, []);
      else entryId = this.bookNeutral(row.source, order);
      this.db.prepare(`UPDATE integration_questions SET answer = ?, journal_entry_id = ?, answered_at = datetime('now') WHERE id = ?`).run(answer, entryId, Number(id));
    });
  }

  /** De verkoop aan je eigen bedrijf zonder omzet en btw: het geld telt als privé-storting. */
  private bookNeutral(source: string, order: ExternalOrder): number {
    const total = computeTotals(invoiceLines(order)).total;
    const description = `Verkoop aan je eigen bedrijf (${order.number}): geen omzet`;
    const found = this.bankPaymentFor(order, total);
    // alleen op het ordernummer: je eigen naam op het afschrift is net zo goed een overboeking tussen eigen rekeningen
    const bank = found?.by === 'nummer' ? found.row : null;
    if (bank?.status === 'gematcht') {
      throw new ValidationError(`De bankbetaling van ${formatEuro(total)} (${bank.transaction_date}) is al geboekt. Zet die boeking eerst terug op 'nieuw' en kies daarna opnieuw.`);
    }
    if (bank && this.bank) return this.bank.bookToAccount(bank.id, { account: ACCOUNTS.priveStortingen, description });
    return this.ledger.post({
      date: order.date,
      description,
      source: 'integratie',
      sourceRef: `eigen-verkoop:${source}:${order.externalId}`,
      lines: [signedLine(ACCOUNTS.tussenrekeningPsp, total)!, signedLine(ACCOUNTS.priveStortingen, -total)!],
    });
  }

  /**
   * Staat de betaling voor deze order al op de bank? Eerst op het ordernummer in de omschrijving of
   * referentie, anders op exact bedrag + naam van de klant binnen 10 dagen. Een bankregel die al aan
   * een factuur hangt telt niet; die hoort bij een andere order.
   */
  private bankPaymentFor(order: ExternalOrder, total: number) {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.transaction_date, t.counter_name, t.description, t.reference, t.status, a.rgs_code
         FROM bank_transactions t JOIN bank_accounts b ON b.id = t.bank_account_id JOIN chart_of_accounts a ON a.id = b.account_id
         WHERE t.amount = ? AND t.matched_invoice_id IS NULL AND t.matched_purchase_invoice_id IS NULL AND t.status != 'genegeerd'
         ORDER BY t.transaction_date, t.id`,
      )
      .all(total) as { id: number; transaction_date: string; counter_name: string | null; description: string | null; reference: string | null; status: string; rgs_code: string }[];
    const number = String(order.number).toLowerCase();
    const byNumber = rows.filter((r) => `${r.description ?? ''} ${r.reference ?? ''}`.toLowerCase().includes(number));
    const name = order.customer.name.trim().toLowerCase();
    const days = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
    const byName = rows.filter((r) => name && (r.counter_name ?? '').trim().toLowerCase() === name && days(r.transaction_date, order.date) <= 10);
    // liever een nog niet verwerkte bankregel; die verrekent de factuur zonder dubbele omzet
    const pick = (list: typeof rows) => list.find((r) => r.status !== 'gematcht') ?? list[0];
    const numbered = pick(byNumber);
    if (numbered) return { row: numbered, by: 'nummer' as const };
    const named = pick(byName);
    return named ? { row: named, by: 'naam' as const } : undefined;
  }

  /** Orders die er al zijn: als factuur, of als vraag aan de gebruiker (ook als die "geen omzet" koos). */
  private knownOrders(source: string): Set<string> {
    const rows = this.db.prepare(`SELECT external_id FROM invoices WHERE external_source = ? UNION SELECT external_id FROM integration_questions WHERE source = ?`).all(source, source) as { external_id: string }[];
    return new Set(rows.map((r) => r.external_id));
  }

  private knownPayouts(source: string): Set<string> {
    const rows = this.db.prepare(`SELECT source_ref FROM journal_entries WHERE source = 'integratie' AND source_ref LIKE ?`).all(`${source}:%`) as { source_ref: string }[];
    return new Set(rows.map((r) => r.source_ref.slice(source.length + 1)));
  }

  /**
   * Uitbetaling: tussenrekening (bruto ontvangen) → kruisposten (onderweg naar bank) + kosten.
   * De bijschrijving op de bank wordt daarna op 'kruisposten' geboekt en sluit daarmee aan.
   */
  importPayouts(source: string, payouts: ExternalPayout[]): SyncResult {
    const result: SyncResult = { created: 0, skipped: 0, messages: [] };
    const known = this.knownPayouts(source);
    for (const p of payouts) {
      if (known.has(p.externalId)) {
        result.skipped++;
        continue;
      }
      if (p.currency !== 'EUR' || !p.date) {
        result.skipped++;
        continue;
      }
      const kor = korActive(this.db);
      const lines = [
        signedLine(ACCOUNTS.kruisposten, p.amount),
        signedLine(ACCOUNTS.bankkosten, p.feesNet, { description: `${source} transactiekosten`, vatCode: p.feesReverseCharge ?? null }),
        ...(p.feesReverseCharge ? reverseChargeLines(p.feesNet, kor) : []),
        kor ? signedLine(ACCOUNTS.bankkosten, p.feesVat, { vatCode: NON_DEDUCTIBLE_VAT, description: 'Niet-aftrekbare btw' }) : signedLine(ACCOUNTS.btwVoorbelasting, p.feesVat, { vatCode: 'hoog' }),
        signedLine(ACCOUNTS.tussenrekeningPsp, -(p.amount + p.feesNet + p.feesVat)),
      ].filter((l): l is PostLine => l !== null);
      try {
        this.ledger.post({ date: p.date, description: `Uitbetaling ${source} ${p.reference}`, source: 'integratie', sourceRef: `${source}:${p.externalId}`, lines });
        result.created++;
      } catch (e) {
        result.messages.push(`Uitbetaling ${p.reference}: ${(e as Error).message}`);
      }
      if (p.gross !== p.amount + p.feesNet + p.feesVat) {
        result.messages.push(`Uitbetaling ${p.reference}: bruto (${p.gross}) wijkt af van uitbetaling + kosten; verschil blijft op de tussenrekening staan (bv. terugbetalingen).`);
      }
    }
    return result;
  }
}
