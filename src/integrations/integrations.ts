import type { Db } from '../db/database';
import { tx } from '../db/database';
import type { Ledger, PostLine } from '../core-ledger/ledger';
import { signedLine } from '../core-ledger/ledger';
import { ACCOUNTS, REVERSE_CHARGE_ACCOUNTS } from '../core-ledger/accounts';
import { PURCHASE_VAT_RATES } from '../shared/vat';
import { roundHalfAwayFromZero } from '../shared/money';
import type { InvoiceService } from '../documents/invoices';
import type { RelationsService } from '../relations/relations';
import type { SalesVatCode } from '../shared/vat';
import { WOOCOMMERCE, fetchWooOrders } from './woocommerce';
import { SHOPIFY, fetchShopifyOrders } from './shopify';
import { MOLLIE, fetchMollieSettlements } from './mollie';
import { STRIPE, fetchStripePayouts } from './stripe';
import type { ExternalOrder, ExternalPayout, FetchLike, IntegrationDefinition, SecretStore, SyncResult } from './types';

export const INTEGRATIONS: IntegrationDefinition[] = [WOOCOMMERCE, SHOPIFY, MOLLIE, STRIPE];

/** Verlegde btw over buitenlandse transactiekosten: aangeven en tegelijk aftrekken (per saldo nul). */
function reverseChargeLines(net: number): (PostLine | null)[] {
  const vat = roundHalfAwayFromZero((net * PURCHASE_VAT_RATES.eu.percentage) / 100);
  return [signedLine(ACCOUNTS.btwVoorbelasting, vat, { vatCode: 'eu' }), signedLine(REVERSE_CHARGE_ACCOUNTS.eu, -vat, { vatCode: 'eu' })];
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

  /** Webshop-orders → definitieve facturen, betaald via de tussenrekening betaalprovider. */
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
      try {
        tx(this.db, () => {
          const c = order.customer;
          const relation =
            (c.email ? this.relations.findByEmail(c.email) : undefined) ??
            this.relations.create({ name: c.name, email: c.email, address: c.address, postcode: c.postcode, city: c.city, country: c.country ?? 'NL', type: 'klant' });
          if (c.country && c.country !== 'NL' && order.lines.some((l) => l.vatPercentage === 0)) {
            result.messages.push(`Order ${order.number}: buitenlandse klant met 0% BTW — controleer of dit ICP (rubriek 3b) of OSS is.`);
          }
          const draft = this.invoices.createDraft({
            relationId: relation.id,
            invoiceDate: order.date,
            dueDate: order.date,
            reference: `Webshoporder ${order.number}`,
            externalSource: source,
            externalId: order.externalId,
            lines: order.lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPriceExVat, vatCode: vatCodeFor(l.vatPercentage), vatPercentage: l.vatPercentage })),
          });
          const inv = this.invoices.finalize(draft.id);
          this.invoices.registerPayment(inv.id, { amount: inv.total!, date: order.date, moneyAccount: ACCOUNTS.tussenrekeningPsp, description: `Betaling webshoporder ${order.number}` });
        });
        result.created++;
      } catch (e) {
        result.messages.push(`Order ${order.number}: ${(e as Error).message}`);
      }
    }
    return result;
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
      const lines = [
        signedLine(ACCOUNTS.kruisposten, p.amount),
        signedLine(ACCOUNTS.bankkosten, p.feesNet, { description: `${source} transactiekosten`, vatCode: p.feesReverseCharge ?? null }),
        ...(p.feesReverseCharge ? reverseChargeLines(p.feesNet) : []),
        signedLine(ACCOUNTS.btwVoorbelasting, p.feesVat, { vatCode: 'hoog' }),
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
