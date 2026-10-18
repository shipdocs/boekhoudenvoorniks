import type { Db } from '../db/database';
import { tx } from '../db/database';
import type { Ledger, PostLine } from '../core-ledger/ledger';
import { signedLine } from '../core-ledger/ledger';
import { ACCOUNTS, REVERSE_CHARGE_ACCOUNTS } from '../core-ledger/accounts';
import { PURCHASE_VAT_RATES } from '../shared/vat';
import { formatEuro, roundHalfAwayFromZero } from '../shared/money';
import { diffDays } from '../shared/dates';
import { NON_DEDUCTIBLE_VAT } from '../core-ledger/rules';
import { korActive } from '../settings/settings';
import type { InvoiceService } from '../documents/invoices';
import type { RelationsService } from '../relations/relations';
import type { SalesVatCode } from '../shared/vat';
import type { BankService } from '../import/bank';
import { computeTotals } from '../documents/totals';
import { detectOwnCustomer, sameCompanyName, type OwnIdentity } from '../intake/own-company';
import { ValidationError } from '../shared/validation';
import type { Cents } from '../shared/money';
import { WOOCOMMERCE, fetchWooOrders } from './woocommerce';
import { SHOPIFY, fetchShopifyOrders } from './shopify';
import { MOLLIE, MOLLIE_FACTUREN, fetchMollieSettlements, fetchMollieSalesInvoices } from './mollie';
import { linesFromInclusive, linesTotal } from './prices';
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

function foreignOrderIssue(order: ExternalOrder): string | null {
  return order.customer.country && order.customer.country.toUpperCase() !== 'NL'
    ? 'de klant zit buiten Nederland. Controleer de plaats van levering en het btw-tarief en boek deze verkoop zelf. Buitenlandse btw en OSS verwerkt deze koppeling niet'
    : null;
}

/** De regels van een order zoals ze op de factuur komen. */
function invoiceLines(order: ExternalOrder) {
  return order.lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPriceExVat, vatCode: vatCodeFor(l.vatPercentage), vatPercentage: l.vatPercentage }));
}

/** Het totaal van de factuur die de app van deze order maakt. */
function invoiceTotal(order: ExternalOrder): Cents {
  return computeTotals(invoiceLines(order)).total;
}

/** Wat er voor deze order betaald is: het totaal dat de bron opgeeft, anders dat van de factuur. */
function paidTotal(order: ExternalOrder): Cents {
  return order.total ?? invoiceTotal(order);
}

/** De order nu de gebruiker zei of de prijzen inclusief of exclusief btw zijn (#228). */
function withPrices(order: ExternalOrder, mode: 'inclusief' | 'exclusief'): ExternalOrder {
  const known: ExternalOrder = { ...order };
  delete known.pricesUnknown;
  return mode === 'exclusief' ? known : { ...known, lines: linesFromInclusive(order.lines), total: order.total ?? linesTotal(order.lines) };
}

/** Past dit totaal bij wat er betaald is? Een cent per regel is afronden; meer niet (bv. een korting die de app niet las). */
function fitsPaid(order: ExternalOrder, total: Cents): boolean {
  return order.total === undefined || Math.abs(total - order.total) <= order.lines.length;
}

/** Bij onbekend of de prijzen inclusief btw zijn: welk antwoord past bij wat er betaald is? Zonder opgegeven totaal allebei. */
function priceFits(order: ExternalOrder): { inclusief: boolean; exclusief: boolean } {
  return { inclusief: fitsPaid(order, invoiceTotal(withPrices(order, 'inclusief'))), exclusief: fitsPaid(order, invoiceTotal(order)) };
}

/**
 * Waarom een verkoop uit een koppeling op een antwoord wacht, in de volgorde waarin de app het vraagt:
 * 'opnieuw' = de factuur is in de app teruggedraaid en wordt nu anders gelezen (#228), 'btw' = onbekend of
 * de prijzen inclusief btw zijn (#228), 'eigen-bedrijf' = de klant is je eigen bedrijf (#231), 'zelf' = de app
 * kan de verkoop niet betrouwbaar inlezen (het totaal past niet bij de regels, of een btw-tarief of korting is
 * niet te lezen): de gebruiker boekt hem zelf en sluit de melding af (#228).
 */
export type SaleReason = 'opnieuw' | 'btw' | 'eigen-bedrijf' | 'zelf';
/**
 * De antwoorden, per vraag: opnieuw inlezen of niet, prijzen inclusief of exclusief btw, geen omzet of toch een
 * gewone verkoop. Bij "geen omzet" met geld op de bank dat de betaling kan zijn, zegt de gebruiker erbij of dat
 * dit geld is ('neutraal-bank') of dat het nog van de betaaldienst komt ('neutraal-betaaldienst'). 'zelf': de
 * gebruiker boekt de verkoop zelf; de app leest hem niet in en vraagt er niet meer naar.
 */
export type SaleAnswer = 'opnieuw' | 'niet' | 'inclusief' | 'exclusief' | 'neutraal' | 'neutraal-bank' | 'neutraal-betaaldienst' | 'verkoop' | 'zelf';
type NeutralAnswer = Extract<SaleAnswer, `neutraal${string}`>;
const ANSWERS: Record<SaleReason, SaleAnswer[]> = { opnieuw: ['opnieuw', 'niet'], btw: ['inclusief', 'exclusief', 'zelf'], 'eigen-bedrijf': ['neutraal', 'neutraal-bank', 'neutraal-betaaldienst', 'verkoop'], zelf: ['zelf'] };

/**
 * Een vraag is open zolang er geen antwoord is, en opnieuw als de boeking van "geen omzet" is teruggedraaid
 * (#231): zo is een verkeerde klik te herstellen en komt de keuze terug.
 */
const OPEN_QUESTION = `(answer IS NULL OR (answer LIKE 'neutraal%' AND journal_entry_id IN (SELECT id FROM journal_entries WHERE status = 'teruggedraaid')))`;

/** Zoveel dagen mag geld op de bank van de datum van de order af liggen om er zonder vraag bij te horen. */
const BANK_WINDOW_DAYS = 10;

/** Een bankregel die de betaling van een order kan zijn. */
interface BankCandidate {
  id: number;
  transaction_date: string;
  counter_name: string | null;
  counter_iban: string | null;
  description: string | null;
  reference: string | null;
  status: string;
  matched_journal_entry_id: number | null;
  rgs_code: string;
}

/** Een verkoop uit een koppeling die nog niet geboekt is: eerst de keuze van de gebruiker (#228, #231). */
export interface SaleQuestion {
  id: number;
  source: string;
  /** de koppeling in gewone woorden ("Mollie Facturen") */
  label: string;
  reason: SaleReason;
  order: ExternalOrder;
  /** wat er voor de verkoop betaald is, inclusief btw; null als de bron dat niet opgaf en niet vaststaat of de prijzen inclusief btw zijn */
  total: Cents | null;
  /** bij 'btw': het totaal als de prijzen inclusief btw zijn, en als ze exclusief btw zijn */
  totals: { inclusief: Cents; exclusief: Cents } | null;
  /** bij 'btw': welk antwoord past bij wat er betaald is (zonder opgegeven totaal allebei) */
  fits: { inclusief: boolean; exclusief: boolean } | null;
  /** bij 'opnieuw': de factuur die is teruggedraaid */
  previous: { number: string; total: Cents } | null;
  /** waarom de app het vraagt (bij 'zelf': waarom hij de verkoop niet kan inlezen), in gewone woorden */
  signals: string[];
  /**
   * bij 'eigen-bedrijf': geld op de bank dat de betaling van deze verkoop kan zijn. `sure`: het ordernummer staat
   * erbij, dus "geen omzet" gaat over die bankregel; anders kiest de gebruiker zelf of dat dit geld is.
   */
  bank: { id: number; date: string; counterName: string | null; description: string | null; sure: boolean } | null;
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
      if (f.type === 'select' && !f.options?.some((o) => o.value === v)) throw new ValidationError(`Ongeldige keuze bij ${f.label}`);
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
      if (!out[f.key] && f.type !== 'select') throw new Error(`${def.label}: "${f.label}" is niet ingevuld`);
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
        // een teruggedraaide factuur is niet "bekend": die leest de app opnieuw, ook als hij verder terug staat
        const reversed = this.reversedOrders(id);
        const known = new Set([...this.knownOrders(id)].filter((x) => !reversed.has(x)));
        result = this.importOrders(id, await fetchMollieSalesInvoices(this.fetchImpl, { apiKey: cfg.apiKey! }, known, reversed));
      } else if (id === 'mollie') {
        result = this.importPayouts(id, await fetchMollieSettlements(this.fetchImpl, { apiKey: cfg.apiKey! }, this.knownPayouts(id)));
      } else {
        const payouts = await fetchStripePayouts(this.fetchImpl, { apiKey: cfg.apiKey!, feesTax: cfg.feesTax }, this.knownPayouts(id));
        if (payouts.some((p) => p.feesTaxUnconfirmed)) throw new ValidationError('Controleer eerst de btw op je Stripe-kosten bij Instellingen → Koppelingen. Gemengde of onbekende kosten: verwerk de uitbetaling en kosten zelf, met de kostenfactuur. Er is niets automatisch geboekt.');
        result = this.importPayouts(id, payouts);
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
   * Webshop-orders → definitieve facturen, betaald via de tussenrekening betaalprovider. Niet vanzelf als de
   * app iets niet zeker weet: een verkoop aan je eigen bedrijf (#231), prijzen waarvan niet vaststaat of ze
   * inclusief btw zijn, een teruggedraaide factuur die nu anders gelezen wordt, of een order die de app niet
   * betrouwbaar kan inlezen, bv. doordat het totaal niet bij de regels past (#228). Die wachten als vraag of
   * melding op Vandaag, en er is dan nog niets geboekt. Zo ziet de gebruiker het ook als de app vanzelf bijwerkt.
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
      // wacht al op een antwoord, of is al beantwoord (ook "geen omzet" of "laat zo"): niet opnieuw
      if (this.db.prepare('SELECT 1 FROM integration_questions WHERE source = ? AND external_id = ?').get(source, order.externalId)) {
        result.skipped++;
        continue;
      }
      const existing = this.db.prepare('SELECT id, total FROM invoices WHERE external_source = ? AND external_id = ?').get(source, order.externalId) as { id: number; total: Cents | null } | undefined;
      if (existing) {
        result.skipped++;
        // teruggedraaid en nu anders gelezen: eerst vragen, want je kunt de factuur intussen zelf opnieuw gemaakt hebben
        const changes = this.rereadChanges(existing, order);
        if (changes) {
          this.hold(source, order, 'opnieuw', changes);
          result.messages.push(`Order ${order.number}: de factuur is teruggedraaid en wordt nu anders gelezen. Kies op Vandaag of de app hem opnieuw inleest.`);
        }
        continue;
      }
      try {
        const outcome = this.process(source, order, result.messages);
        if (outcome === 'geboekt') {
          result.created++;
          continue;
        }
        result.skipped++;
        result.messages.push(
          outcome === 'btw'
            ? `Order ${order.number}: de app weet niet of de prijzen inclusief of exclusief btw zijn. Niets geboekt; kies het op Vandaag.`
            : outcome === 'zelf'
              ? `Order ${order.number}: niet ingelezen. Niets geboekt; op Vandaag staat waarom en wat je kunt doen.`
              : `Order ${order.number}: de klant is je eigen bedrijf. Niet als omzet geboekt; kies op Vandaag wat het was.`,
        );
      } catch (e) {
        result.messages.push(`Order ${order.number}: ${(e as Error).message}`);
      }
    }
    return result;
  }

  /**
   * De volgende stap voor een order: een vraag aan de gebruiker (dan is er niets geboekt), of de factuur.
   * `questionId`: de vraag waar de gebruiker net op antwoordde; een volgende vraag komt op dezelfde regel.
   */
  private process(source: string, order: ExternalOrder, messages: string[], questionId?: number): 'geboekt' | SaleReason {
    const manual = (why: string) => {
      this.hold(source, order, 'zelf', [why], questionId);
      return 'zelf' as const;
    };
    if (order.unreadable) return manual(order.unreadable);
    const foreignIssue = foreignOrderIssue(order);
    if (foreignIssue) return manual(foreignIssue);
    if (order.pricesUnknown) {
      // past wat er betaald is bij geen van beide antwoorden, dan valt er niets te kiezen
      const fits = priceFits(order);
      if (!fits.inclusief && !fits.exclusief) {
        return manual(`met prijzen inclusief btw komt het totaal op ${formatEuro(linesTotal(order.lines))} en exclusief btw op ${formatEuro(invoiceTotal(order))}, maar er is ${formatEuro(order.total!)} betaald`);
      }
      this.hold(source, order, 'btw', [], questionId);
      return 'btw';
    }
    const ownSale = this.ownSale(order);
    if (ownSale) {
      this.hold(source, order, 'eigen-bedrijf', ownSale.signals, questionId);
      return 'eigen-bedrijf';
    }
    return this.bookOrManual(source, order, messages, questionId);
  }

  /**
   * De factuur boeken, tenzij het totaal niet bij de regels past (bv. een korting die de app niet las): dan
   * niets boeken, maar de melding op Vandaag dat de gebruiker deze verkoop zelf boekt (#228).
   */
  private bookOrManual(source: string, order: ExternalOrder, messages: string[], questionId?: number): 'geboekt' | 'zelf' {
    // Ook vragen die vóór deze controle zijn opgeslagen moeten de fiscale controle doorlopen.
    const foreignIssue = foreignOrderIssue(order);
    if (foreignIssue) {
      this.hold(source, order, 'zelf', [foreignIssue], questionId);
      return 'zelf';
    }
    if (!fitsPaid(order, invoiceTotal(order))) {
      this.hold(source, order, 'zelf', [`de regels tellen op tot ${formatEuro(invoiceTotal(order))}, maar er is ${formatEuro(order.total!)} betaald (bijvoorbeeld door een korting)`], questionId);
      return 'zelf';
    }
    this.bookOrder(source, order, messages);
    return 'geboekt';
  }

  private ownSale(order: ExternalOrder) {
    const own = this.ownIdentity();
    return own ? detectOwnCustomer(order.customer, own) : null;
  }

  /** De order bewaren met de vraag waar hij op wacht. */
  private hold(source: string, order: ExternalOrder, reason: SaleReason, signals: string[], questionId?: number): void {
    if (questionId !== undefined) {
      this.db.prepare('UPDATE integration_questions SET reason = ?, order_data = ?, signals = ? WHERE id = ?').run(reason, JSON.stringify(order), JSON.stringify(signals), questionId);
    } else {
      this.db.prepare('INSERT INTO integration_questions (source, external_id, reason, order_data, signals) VALUES (?, ?, ?, ?, ?)').run(source, order.externalId, reason, JSON.stringify(order), JSON.stringify(signals));
    }
  }

  /**
   * Een factuur uit een koppeling die in de app helemaal is teruggedraaid (definitieve creditfactuur voor het
   * hele bedrag) en die de app nu anders leest dan toen (#228), bv. doordat de prijzen inclusief btw waren:
   * wat er anders is, in gewone woorden. Null als er niets is teruggedraaid, als hij nu hetzelfde gelezen
   * wordt (dan draaide je hem om een andere reden terug), of als er echt geld op de bank aan gekoppeld is.
   */
  private rereadChanges(existing: { id: number; total: Cents | null }, order: ExternalOrder): string[] | null {
    const credit = this.db.prepare(`SELECT id, total FROM invoices WHERE credit_of_invoice_id = ? AND status != 'concept'`).get(existing.id) as { id: number; total: Cents | null } | undefined;
    if (!credit || existing.total === null || credit.total !== -existing.total) return null;
    if (this.db.prepare('SELECT 1 FROM bank_transactions WHERE matched_invoice_id IN (?, ?)').get(existing.id, credit.id)) return null;
    const changes: string[] = [];
    if (order.pricesUnknown) changes.push('de app weet niet zeker of de prijzen inclusief btw zijn');
    else if (invoiceTotal(order) !== existing.total) changes.push(`het bedrag is nu ${formatEuro(paidTotal(order))} in plaats van ${formatEuro(existing.total)}`);
    if (this.ownSale(order)) changes.push('de klant is je eigen bedrijf');
    return changes.length > 0 ? changes : null;
  }

  /**
   * De teruggedraaide factuur loslaten, zodat de order opnieuw gelezen kan worden (#228). De betaling van toen
   * stond bij de betaaldienst: die gaat er met de creditfactuur weer af, zodat daar alleen de nieuwe verkoop
   * nog staat. Was er bij het inlezen een cent afrondingsverschil geboekt, dan gaat die cent op dezelfde
   * rekening terug en van de betaaldienst precies wat erop was gezet. De oude factuur en de creditfactuur
   * blijven staan.
   */
  private releaseReversed(source: string, order: ExternalOrder): void {
    const old = this.db.prepare('SELECT id, number FROM invoices WHERE external_source = ? AND external_id = ?').get(source, order.externalId) as { id: number; number: string } | undefined;
    if (!old) return;
    const credit = this.db.prepare(`SELECT id, total, amount_paid, invoice_date FROM invoices WHERE credit_of_invoice_id = ? AND status != 'concept'`).get(old.id) as { id: number; total: Cents; amount_paid: Cents; invoice_date: string } | undefined;
    if (!credit) throw new ValidationError(`Factuur ${old.number} is niet (meer) teruggedraaid. Kijk het opnieuw na.`);
    let open = credit.total - credit.amount_paid;
    // wat er bij het inlezen als afrondingsverschil op de oude factuur is geboekt
    const rounding = (this.db
      .prepare(
        `SELECT COALESCE(SUM(l.debit - l.credit), 0) AS amount FROM journal_entries e JOIN journal_lines l ON l.journal_entry_id = e.id JOIN chart_of_accounts a ON a.id = l.account_id
         WHERE e.source_ref = ? AND e.source = 'bank' AND e.status = 'definitief' AND e.reverses_entry_id IS NULL AND a.rgs_code = ?`,
      )
      .get(`invoice:${old.id}`, ACCOUNTS.betalingsverschillen) as { amount: Cents }).amount;
    if (rounding !== 0 && Math.abs(rounding) < Math.abs(open)) {
      this.invoices.registerPayment(credit.id, { amount: -rounding, date: credit.invoice_date, moneyAccount: ACCOUNTS.betalingsverschillen, description: `Teruggedraaid: afrondingsverschil webshoporder ${order.number}` });
      open += rounding;
    }
    if (open !== 0) {
      this.invoices.registerPayment(credit.id, { amount: open, date: credit.invoice_date, moneyAccount: ACCOUNTS.tussenrekeningPsp, description: `Teruggedraaid: betaling webshoporder ${order.number}` });
    }
    this.db.prepare('UPDATE invoices SET external_source = ? WHERE id = ?').run(`${source}#teruggedraaid-${old.id}`, old.id);
  }

  /**
   * Eén order als definitieve, betaalde factuur: verrekend met de bankregel als die er al staat, anders via
   * de tussenrekening. Geeft de bron zelf op wat er betaald is (#228), dan is dat het bedrag van de betaling:
   * een cent verschil met de factuur door afronden wordt een afrondingsverschil; bij meer boekt de app niets.
   */
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
      const paid = order.total ?? inv.total!;
      const difference = inv.total! - paid;
      // meer dan een cent per regel is geen afronden meer (bv. een korting die de app niet las): niet raden
      if (Math.abs(difference) > order.lines.length) {
        throw new Error(`overgeslagen: de regels tellen op tot ${formatEuro(inv.total!)}, maar er is ${formatEuro(paid)} betaald (bijvoorbeeld door een korting). De app raadt niet: boek deze verkoop zelf`);
      }
      const bank = this.bankPaymentFor(order, paid)?.row;
      if (bank?.status === 'gematcht') {
        // rollback: deze order is al als omzet geboekt via de bank; een factuur erbij telt de omzet dubbel
        throw new Error(`overgeslagen: de bankbetaling van ${formatEuro(paid)} (${bank.transaction_date}) is al als verkoop geboekt. Zet die boeking terug op 'nieuw' en lees de order daarna opnieuw in, dan wordt de factuur direct met de bank verrekend`);
      }
      const date = bank ? bank.transaction_date : order.date;
      if (bank) {
        this.invoices.registerPayment(inv.id, { amount: paid, date, moneyAccount: bank.rgs_code, bankTransactionId: bank.id, description: `Ontvangst ${bank.counter_name ?? ''} factuur`.replace(/\s+/g, ' ') });
      } else {
        this.invoices.registerPayment(inv.id, { amount: paid, date, moneyAccount: ACCOUNTS.tussenrekeningPsp, description: `Betaling webshoporder ${order.number}` });
      }
      if (difference !== 0) {
        this.invoices.registerPayment(inv.id, { amount: difference, date, moneyAccount: ACCOUNTS.betalingsverschillen, description: `Afrondingsverschil webshoporder ${order.number}` });
      }
    });
  }

  /** Wacht er een verkoop uit een koppeling op een keuze? Dan is er voor die verkoop nog niets geboekt. */
  hasQuestions(): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM integration_questions WHERE ${OPEN_QUESTION} LIMIT 1`).get());
  }

  /** Verkopen die op een keuze wachten (#228, #231), oudste eerst. Er is voor deze orders nog niets geboekt. */
  questions(): SaleQuestion[] {
    const rows = this.db.prepare(`SELECT id, source, external_id, reason, order_data, signals FROM integration_questions WHERE ${OPEN_QUESTION} ORDER BY id`).all() as { id: number; source: string; external_id: string; reason: SaleReason; order_data: string; signals: string }[];
    return rows.map((r) => {
      const order = JSON.parse(r.order_data) as ExternalOrder;
      const previous = r.reason === 'opnieuw' ? ((this.db.prepare('SELECT number, total FROM invoices WHERE external_source = ? AND external_id = ?').get(r.source, r.external_id) as { number: string; total: Cents } | undefined) ?? null) : null;
      return {
        id: r.id,
        source: r.source,
        label: INTEGRATIONS.find((d) => d.id === r.source)?.label ?? r.source,
        reason: r.reason,
        order,
        total: order.total ?? (order.pricesUnknown ? null : invoiceTotal(order)),
        totals: r.reason === 'btw' ? { inclusief: linesTotal(order.lines), exclusief: invoiceTotal(order) } : null,
        fits: r.reason === 'btw' ? priceFits(order) : null,
        previous,
        signals: JSON.parse(r.signals) as string[],
        bank: r.reason === 'eigen-bedrijf' ? this.neutralBank(order) : null,
      };
    });
  }

  /**
   * Het antwoord op een vraag bij een verkoop uit een koppeling. Na "opnieuw inlezen" of de keuze voor
   * inclusief of exclusief btw kan de volgende vraag komen (zelfde order); anders wordt de order nu geboekt.
   *  - 'opnieuw' / 'niet' (#228): de teruggedraaide factuur opnieuw inlezen, of laten zoals het is.
   *  - 'inclusief' / 'exclusief' (#228): hoe de prijzen per regel bedoeld zijn. Past dat niet bij wat er
   *    betaald is, dan een melding in gewone taal en blijft de vraag staan.
   *  - 'zelf' (#228): de gebruiker boekt de verkoop zelf; de app boekt niets en vraagt er niet meer naar.
   *  - 'verkoop' / 'neutraal' (#231), bij een verkoop aan je eigen bedrijf. 'verkoop': toch een gewone betaalde
   *    factuur, met omzet en btw. 'neutraal': geen factuur, geen omzet en geen btw; het geld dat de betaaldienst
   *    ervoor uitbetaalt telt als privé-storting. Dat staat op de tussenrekening, net als bij een gewone
   *    verkoop, zodat de uitbetaling daarna aansluit. Staat het geld al op de bank met het ordernummer erbij,
   *    dan gaat die bankregel naar privé-stortingen. Staat er geld op de bank dat de betaling kan zijn maar
   *    waar de app niet zeker van is, dan zegt de gebruiker het erbij: 'neutraal-bank' (dit is het geld;
   *    `bankTransactionId` is de bankregel die hij zag) of 'neutraal-betaaldienst' (het komt nog van de
   *    betaaldienst). Wordt de boeking later teruggedraaid, dan komt de vraag terug.
   */
  answerQuestion(id: number, answer: SaleAnswer, bankTransactionId?: number): void {
    tx(this.db, () => {
      const row = this.db.prepare(`SELECT source, reason, order_data, answer, ${OPEN_QUESTION} AS open FROM integration_questions WHERE id = ?`).get(Number(id)) as { source: string; reason: SaleReason; order_data: string; answer: string | null; open: number } | undefined;
      if (!row) throw new ValidationError('Deze vraag bestaat niet (meer)');
      if (!row.open) throw new ValidationError('Deze vraag is al beantwoord. Kijk het opnieuw na.');
      if (!ANSWERS[row.reason]?.includes(answer)) throw new ValidationError('Deze vraag is intussen veranderd. Kijk het opnieuw na.');
      const done = (entryId: number | null = null) =>
        void this.db.prepare(`UPDATE integration_questions SET answer = ?, journal_entry_id = ?, answered_at = datetime('now') WHERE id = ?`).run(answer, entryId, Number(id));
      let order = JSON.parse(row.order_data) as ExternalOrder;
      if (answer === 'niet' || answer === 'zelf') return done();
      if (answer === 'neutraal' || answer === 'neutraal-bank' || answer === 'neutraal-betaaldienst') return done(this.bookNeutral(row.source, order, answer, bankTransactionId));
      if (answer === 'verkoop') {
        if (this.bookOrManual(row.source, order, [], Number(id)) === 'geboekt') done();
        return;
      }
      if (answer === 'opnieuw') this.releaseReversed(row.source, order);
      else {
        if (!priceFits(order)[answer]) {
          const total = answer === 'inclusief' ? linesTotal(order.lines) : invoiceTotal(order);
          throw new ValidationError(`Met prijzen ${answer} btw komt de factuur op ${formatEuro(total)}, maar er is ${formatEuro(order.total!)} betaald. Kies de andere knop of boek deze verkoop zelf.`);
        }
        order = withPrices(order, answer);
      }
      if (this.process(row.source, order, [], Number(id)) === 'geboekt') done();
    });
  }

  /**
   * De verkoop aan je eigen bedrijf zonder omzet en btw: het geld telt als privé-storting. Via de bankregel als
   * die de betaling is (zeker, of omdat de gebruiker dat zegt), anders via de tussenrekening van de betaaldienst.
   * Nooit stil via de tussenrekening als er geld op de bank staat dat de betaling kan zijn: dan bleef die
   * bankregel open staan en kwam het geld er een tweede keer in.
   */
  private bookNeutral(source: string, order: ExternalOrder, answer: NeutralAnswer, bankTransactionId?: number): number {
    const total = paidTotal(order);
    const description = `Verkoop aan je eigen bedrijf (${order.number}): geen omzet`;
    const found = this.neutralBankRow(order);
    let bank: BankCandidate | null = null;
    if (answer === 'neutraal') {
      if (found && !found.sure) {
        throw new ValidationError(`Op je bank staat ${formatEuro(total)}${found.row.counter_name ? ` van ${found.row.counter_name}` : ''} (${found.row.transaction_date}) dat de betaling van deze verkoop kan zijn. Kijk het opnieuw na en kies of dat dit geld is.`);
      }
      bank = found?.row ?? null;
    } else if (answer === 'neutraal-bank') {
      if (!found || (bankTransactionId !== undefined && Number(bankTransactionId) !== found.row.id)) throw new ValidationError('De betaling op je bank is intussen veranderd. Kijk het opnieuw na.');
      bank = found.row;
    }
    if (bank?.status === 'gematcht') {
      // zelf al als privé-storting ingedeeld: dan is er niets meer te boeken
      const asPrivate = this.db
        .prepare('SELECT 1 FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id WHERE l.journal_entry_id = ? AND a.rgs_code = ?')
        .get(bank.matched_journal_entry_id, ACCOUNTS.priveStortingen);
      if (asPrivate && bank.matched_journal_entry_id) return bank.matched_journal_entry_id;
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

  /** Bankregels met precies dit bedrag die nog niet aan een factuur of aankoop hangen, oudste eerst. */
  private bankRows(total: number): BankCandidate[] {
    return this.db
      .prepare(
        `SELECT t.id, t.transaction_date, t.counter_name, t.counter_iban, t.description, t.reference, t.status, t.matched_journal_entry_id, a.rgs_code
         FROM bank_transactions t JOIN bank_accounts b ON b.id = t.bank_account_id JOIN chart_of_accounts a ON a.id = b.account_id
         WHERE t.amount = ? AND t.matched_invoice_id IS NULL AND t.matched_purchase_invoice_id IS NULL AND t.status != 'genegeerd' AND t.duplicate_of IS NULL
         ORDER BY t.transaction_date, t.id`,
      )
      .all(total) as BankCandidate[];
  }

  /**
   * Geld op de bank dat de betaling van een verkoop aan je eigen bedrijf kan zijn (#231). "Geen omzet" maakt
   * van zo'n bankregel een privé-storting zonder dat er een factuur aan hangt, dus de app is hier strenger
   * dan bij een gewone order. Zeker (`sure`) alleen als het ordernummer als heel woord in de omschrijving
   * staat, het nummer lang genoeg is om geen toeval te zijn, de betaling binnen tien dagen van de order ligt,
   * er maar één zo'n regel is en het geld niet van een andere klant komt. Anders is het een kandidaat waar de
   * gebruiker zelf over beslist: het nummer staat er wel in maar de rest klopt niet, of het is geld van de
   * klant zelf binnen tien dagen. Een nummer dat alleen in een langer nummer zit ("77" in "2026-0177"), telt niet.
   */
  private neutralBankRow(order: ExternalOrder): { row: BankCandidate; sure: boolean } | null {
    const rows = this.bankRows(paidTotal(order));
    const number = String(order.number).trim();
    const word = number ? new RegExp(`(^|[^\\w-])${number.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w-]|$)`, 'i') : null;
    const near = (r: BankCandidate) => Math.abs(diffDays(order.date, r.transaction_date)) <= BANK_WINDOW_DAYS;
    const byNumber = rows.filter((r) => word?.test(`${r.description ?? ''} ${r.reference ?? ''}`));
    const only = byNumber.length === 1 ? byNumber[0]! : null;
    if (only && number.replace(/[^a-z0-9]/gi, '').length >= 4 && near(only) && !this.fromOtherCustomer(only)) return { row: only, sure: true };
    const name = order.customer.name.trim().toLowerCase();
    const byName = rows.filter((r) => name && (r.counter_name ?? '').trim().toLowerCase() === name && near(r));
    const candidates = [...byNumber, ...byName];
    // liever een bankregel die nog niet verwerkt is
    const row = candidates.find((r) => r.status !== 'gematcht') ?? candidates[0];
    return row ? { row, sure: false } : null;
  }

  private neutralBank(order: ExternalOrder): SaleQuestion['bank'] {
    const found = this.neutralBankRow(order);
    return found ? { id: found.row.id, date: found.row.transaction_date, counterName: found.row.counter_name, description: found.row.description, sure: found.sure } : null;
  }

  /** Komt dit geld van een klant die in de app staat (rekeningnummer of naam) en die niet je eigen bedrijf is? */
  private fromOtherCustomer(r: BankCandidate): boolean {
    const own = this.ownIdentity();
    if (own && sameCompanyName(r.counter_name, own.name)) return false;
    const byIban = r.counter_iban ? this.relations.findByIban(r.counter_iban) : undefined;
    if (byIban && byIban.type !== 'leverancier') return true;
    const name = (r.counter_name ?? '').trim();
    return Boolean(name && this.db.prepare(`SELECT 1 FROM relations WHERE archived = 0 AND type != 'leverancier' AND lower(trim(name)) = lower(?)`).get(name));
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

  /**
   * Facturen uit deze koppeling die in de app helemaal zijn teruggedraaid en waar nog geen vraag over is
   * gesteld (#228): die bekijkt de app opnieuw, voor het geval hij ze nu anders leest.
   */
  private reversedOrders(source: string): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT i.external_id FROM invoices i JOIN invoices c ON c.credit_of_invoice_id = i.id AND c.status != 'concept' AND c.total = -i.total
         WHERE i.external_source = ? AND NOT EXISTS (SELECT 1 FROM integration_questions q WHERE q.source = i.external_source AND q.external_id = i.external_id)`,
      )
      .all(source) as { external_id: string }[];
    return new Set(rows.map((r) => r.external_id));
  }

  /**
   * Facturen uit een koppeling die helemaal zijn teruggedraaid terwijl ze via de betaaldienst betaald waren,
   * en waarvan de creditfactuur nog open staat (#228). In de boeken heeft de klant dan "te veel betaald", maar
   * meestal draaide de gebruiker de factuur terug omdat hij verkeerd was ingelezen. `asked`: de vraag "opnieuw
   * inlezen?" staat al op Vandaag; anders kan die bij het volgende bijwerken nog komen. Na het antwoord (ook
   * "Nee, laat zo") of met geld op de bank eraan gekoppeld telt de factuur hier niet meer mee.
   */
  reversedUnsettled(): { relationId: number; number: string; label: string; asked: boolean }[] {
    const rows = this.db
      .prepare(
        `SELECT i.relation_id AS relationId, i.number, i.external_source AS source, q.id AS question, q.answer
         FROM invoices i JOIN invoices c ON c.credit_of_invoice_id = i.id AND c.status != 'concept' AND c.total = -i.total AND c.amount_paid != c.total
         LEFT JOIN integration_questions q ON q.source = i.external_source AND q.external_id = i.external_id
         WHERE i.external_source IN (${INTEGRATIONS.map(() => '?').join(',')})
           AND NOT EXISTS (SELECT 1 FROM bank_transactions b WHERE b.matched_invoice_id IN (i.id, c.id))`,
      )
      .all(...INTEGRATIONS.map((d) => d.id)) as { relationId: number; number: string; source: string; question: number | null; answer: string | null }[];
    return rows
      .filter((r) => r.question === null || r.answer === null)
      .map((r) => ({ relationId: r.relationId, number: r.number, label: INTEGRATIONS.find((d) => d.id === r.source)?.label ?? r.source, asked: r.question !== null }));
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
      if (p.feesTaxUnconfirmed || (source === 'stripe' && p.feesNet !== 0 && !p.feesReverseCharge && this.state(source).config.feesTax !== 'vrijgesteld')) {
        result.skipped++;
        result.messages.push(`Uitbetaling ${p.reference}: controleer eerst de btw op de Stripe-kosten; nog niet geboekt.`);
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
