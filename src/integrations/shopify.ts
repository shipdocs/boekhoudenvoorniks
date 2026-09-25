import { parseEuro, roundHalfAwayFromZero } from '../shared/money';
import { getJson } from './http';
import type { ExternalOrder, FetchLike, IntegrationDefinition } from './types';

export const SHOPIFY: IntegrationDefinition = {
  id: 'shopify',
  label: 'Shopify',
  kind: 'webshop',
  description: 'Haalt betaalde bestellingen op en maakt er automatisch facturen van.',
  fields: [
    { key: 'shop', label: 'Winkeldomein', type: 'text', placeholder: 'mijnwinkel.myshopify.com' },
    { key: 'accessToken', label: 'Admin API access token', type: 'secret', help: 'Shopify admin → Apps → App ontwikkelen → read_orders' },
  ],
};

export const SHOPIFY_API_VERSION = '2025-07';

interface ShopifyOrder {
  id: number;
  name: string;
  created_at: string;
  processed_at: string | null;
  currency: string;
  financial_status: string;
  taxes_included: boolean;
  email: string | null;
  billing_address: { name: string; company: string | null; address1: string; address2: string | null; zip: string; city: string; country_code: string } | null;
  line_items: { title: string; quantity: number; price: string; total_discount: string; tax_lines: { rate: number; price: string }[] }[];
  shipping_lines: { title: string; price: string; tax_lines: { rate: number; price: string }[] }[];
}

function toNet(amount: number, rate: number, taxesIncluded: boolean): number {
  return taxesIncluded ? roundHalfAwayFromZero((amount * 100) / (100 + rate)) : amount;
}

function nlRate(rate: number): number {
  const pct = rate * 100;
  return [21, 9, 0].reduce((best, r) => (Math.abs(r - pct) < Math.abs(best - pct) ? r : best), 21);
}

export function mapShopifyOrder(o: ShopifyOrder): ExternalOrder {
  const lines: ExternalOrder['lines'] = [];
  for (const li of o.line_items) {
    const rate = nlRate(li.tax_lines[0]?.rate ?? 0);
    const gross = parseEuro(li.price) * li.quantity - parseEuro(li.total_discount);
    const net = toNet(gross, rate, o.taxes_included);
    const perUnit = net / li.quantity;
    const whole = Number.isInteger(perUnit);
    lines.push({ description: whole ? li.title : `${li.quantity} × ${li.title}`, quantity: whole ? li.quantity : 1, unitPriceExVat: whole ? perUnit : net, vatPercentage: rate });
  }
  for (const s of o.shipping_lines) {
    const rate = nlRate(s.tax_lines[0]?.rate ?? 0);
    const net = toNet(parseEuro(s.price), rate, o.taxes_included);
    if (net !== 0) lines.push({ description: `Verzending: ${s.title}`, quantity: 1, unitPriceExVat: net, vatPercentage: rate });
  }
  const b = o.billing_address;
  return {
    externalId: String(o.id),
    number: o.name,
    date: (o.processed_at ?? o.created_at).slice(0, 10),
    customer: {
      name: b?.company || b?.name || o.email || 'Webshopklant',
      email: o.email,
      address: b ? [b.address1, b.address2].filter(Boolean).join(' ') : null,
      postcode: b?.zip ?? null,
      city: b?.city ?? null,
      country: b?.country_code ?? null,
      vatNumber: null,
    },
    lines,
    paid: ['paid', 'partially_refunded'].includes(o.financial_status),
    currency: o.currency,
  };
}

export async function fetchShopifyOrders(fetchImpl: FetchLike, cfg: { shop: string; accessToken: string }, since: string | null): Promise<ExternalOrder[]> {
  const shop = cfg.shop.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!/^[\w-]+\.myshopify\.com$/.test(shop)) throw new Error('Winkeldomein moet eindigen op .myshopify.com');
  const params = new URLSearchParams({ status: 'any', financial_status: 'paid', limit: '250' });
  if (since) params.set('created_at_min', since);
  const data = await getJson<{ orders: ShopifyOrder[] }>(fetchImpl, `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/orders.json?${params}`, { 'X-Shopify-Access-Token': cfg.accessToken });
  return data.orders.map(mapShopifyOrder);
}
