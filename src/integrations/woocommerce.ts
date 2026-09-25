import { parseEuro } from '../shared/money';
import { basicAuth, getJson } from './http';
import type { ExternalOrder, FetchLike, IntegrationDefinition } from './types';

export const WOOCOMMERCE: IntegrationDefinition = {
  id: 'woocommerce',
  label: 'WooCommerce',
  kind: 'webshop',
  description: 'Haalt betaalde bestellingen op en maakt er automatisch facturen van.',
  fields: [
    { key: 'url', label: 'Webshop-adres', type: 'url', placeholder: 'https://mijnwinkel.nl' },
    { key: 'consumerKey', label: 'Consumer key', type: 'secret', help: 'WooCommerce → Instellingen → Geavanceerd → REST API (alleen-lezen)' },
    { key: 'consumerSecret', label: 'Consumer secret', type: 'secret' },
  ],
};

interface WooOrder {
  id: number;
  number: string;
  status: string;
  currency: string;
  date_paid: string | null;
  date_created: string;
  billing: { first_name: string; last_name: string; company: string; address_1: string; address_2: string; postcode: string; city: string; country: string; email: string };
  line_items: { name: string; quantity: number; subtotal: string; subtotal_tax: string; total: string; total_tax: string }[];
  shipping_lines: { method_title: string; total: string; total_tax: string }[];
  fee_lines: { name: string; total: string; total_tax: string }[];
  meta_data?: { key: string; value: unknown }[];
}

function vatPercentage(net: number, tax: number): number {
  if (net === 0 || tax === 0) return 0;
  const pct = (tax / net) * 100;
  // afronden naar het dichtstbijzijnde NL-tarief
  return [21, 9, 0].reduce((best, r) => (Math.abs(r - pct) < Math.abs(best - pct) ? r : best), 21);
}

export function mapWooOrder(o: WooOrder): ExternalOrder {
  const lines: ExternalOrder['lines'] = [];
  for (const li of o.line_items) {
    const net = parseEuro(li.total);
    const tax = parseEuro(li.total_tax);
    const perUnit = net / li.quantity;
    const whole = Number.isInteger(perUnit);
    lines.push({
      description: whole ? li.name : `${li.quantity} × ${li.name}`,
      quantity: whole ? li.quantity : 1,
      unitPriceExVat: whole ? perUnit : net,
      vatPercentage: vatPercentage(net, tax),
    });
  }
  for (const s of o.shipping_lines) {
    const net = parseEuro(s.total);
    if (net !== 0) lines.push({ description: `Verzending: ${s.method_title}`, quantity: 1, unitPriceExVat: net, vatPercentage: vatPercentage(net, parseEuro(s.total_tax)) });
  }
  for (const f of o.fee_lines) {
    const net = parseEuro(f.total);
    if (net !== 0) lines.push({ description: f.name, quantity: 1, unitPriceExVat: net, vatPercentage: vatPercentage(net, parseEuro(f.total_tax)) });
  }
  const b = o.billing;
  const vatMeta = o.meta_data?.find((m) => /vat.?number|btw/i.test(m.key));
  return {
    externalId: String(o.id),
    number: o.number,
    date: (o.date_paid ?? o.date_created).slice(0, 10),
    customer: {
      name: b.company || `${b.first_name} ${b.last_name}`.trim() || b.email,
      email: b.email || null,
      address: [b.address_1, b.address_2].filter(Boolean).join(' ') || null,
      postcode: b.postcode || null,
      city: b.city || null,
      country: b.country || null,
      vatNumber: typeof vatMeta?.value === 'string' ? vatMeta.value : null,
    },
    lines,
    paid: ['processing', 'completed'].includes(o.status),
    currency: o.currency,
  };
}

export async function fetchWooOrders(fetchImpl: FetchLike, cfg: { url: string; consumerKey: string; consumerSecret: string }, since: string | null): Promise<ExternalOrder[]> {
  const base = cfg.url.replace(/\/+$/, '');
  if (!/^https:\/\//.test(base)) throw new Error('Gebruik een https-adres voor de webshop');
  const orders: ExternalOrder[] = [];
  for (let page = 1; page < 50; page++) {
    const params = new URLSearchParams({ per_page: '100', page: String(page), status: 'processing,completed', orderby: 'date', order: 'asc' });
    if (since) params.set('after', since);
    const batch = await getJson<WooOrder[]>(fetchImpl, `${base}/wp-json/wc/v3/orders?${params}`, { Authorization: basicAuth(cfg.consumerKey, cfg.consumerSecret) });
    orders.push(...batch.map(mapWooOrder));
    if (batch.length < 100) break;
  }
  return orders;
}
