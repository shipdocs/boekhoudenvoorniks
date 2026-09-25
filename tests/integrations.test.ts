import { describe, expect, it } from 'vitest';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { setup } from './helpers';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import type { FetchLike } from '../src/integrations/types';

function mockFetch(routes: Record<string, unknown>, calls: string[] = []): FetchLike {
  return async (url, init) => {
    calls.push(`${url} ${JSON.stringify(init?.headers ?? {})}`);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' };
    return { ok: true, status: 200, json: async () => routes[key], text: async () => JSON.stringify(routes[key]) };
  };
}

const wooOrder = {
  id: 501,
  number: '501',
  status: 'completed',
  currency: 'EUR',
  date_paid: '2026-09-10T10:00:00',
  date_created: '2026-09-10T09:00:00',
  billing: { first_name: 'Anna', last_name: 'de Boer', company: '', address_1: 'Laan 1', address_2: '', postcode: '1000 AA', city: 'Amsterdam', country: 'NL', email: 'anna@example.nl' },
  line_items: [{ name: 'Stucmortel 25kg', quantity: 3, subtotal: '30.00', subtotal_tax: '6.30', total: '30.00', total_tax: '6.30' }],
  shipping_lines: [{ method_title: 'PostNL', total: '5.00', total_tax: '1.05' }],
  fee_lines: [],
};

describe('integraties (fase 3)', () => {
  it('WooCommerce-orders worden betaalde facturen via de tussenrekening', async () => {
    const calls: string[] = [];
    const { s } = setup({ fetch: mockFetch({ '/wp-json/wc/v3/orders': [wooOrder, { ...wooOrder, id: 502, status: 'pending' }] }, calls) });
    s.integrations.configure('woocommerce', { url: 'https://winkel.example.nl', consumerKey: 'ck_x', consumerSecret: 'cs_y' }, true);
    const state = s.integrations.state('woocommerce');
    expect(state.secretsSet).toEqual({ consumerKey: true, consumerSecret: true });
    expect(JSON.stringify(state)).not.toContain('cs_y');
    const r = await s.integrations.sync('woocommerce');
    expect(r).toMatchObject({ created: 1, skipped: 1 });
    expect(calls[0]).toContain('Basic ');
    const inv = s.invoices.list()[0]!;
    expect(inv).toMatchObject({ total: 4235, status: 'betaald' });
    expect(s.ledger.balance(ACCOUNTS.tussenrekeningPsp)).toBe(4235);
    // tweede sync maakt geen dubbele facturen
    expect((await s.integrations.sync('woocommerce')).created).toBe(0);
  });

  it('Shopify met prijzen inclusief BTW', async () => {
    const { s } = setup({
      fetch: mockFetch({
        '/admin/api/': {
          orders: [
            {
              id: 9001,
              name: '#1001',
              created_at: '2026-09-11T10:00:00Z',
              processed_at: '2026-09-11T10:00:00Z',
              currency: 'EUR',
              financial_status: 'paid',
              taxes_included: true,
              email: 'bob@example.nl',
              billing_address: { name: 'Bob', company: null, address1: 'Straat 2', address2: null, zip: '2000 BB', city: 'Haarlem', country_code: 'NL' },
              line_items: [{ title: 'Spaan', quantity: 1, price: '24.20', total_discount: '0.00', tax_lines: [{ rate: 0.21, price: '4.20' }] }],
              shipping_lines: [],
            },
          ],
        },
      }),
    });
    s.integrations.configure('shopify', { shop: 'winkel.myshopify.com', accessToken: 'shpat_x' }, true);
    expect((await s.integrations.sync('shopify')).created).toBe(1);
    expect(s.invoices.list()[0]!.total).toBe(2420);
  });

  it('Mollie-uitbetaling boekt kosten en voorbelasting; bank sluit aan via kruisposten', async () => {
    const settlement = {
      id: 'stl_1',
      reference: '1234567.2609.01',
      settledAt: '2026-09-15T00:00:00Z',
      status: 'paidout',
      amount: { value: '4150.00', currency: 'EUR' },
      periods: { '2026': { '09': { revenue: [{ amountGross: { value: '4235.00', currency: 'EUR' } }], costs: [{ amountNet: { value: '70.25', currency: 'EUR' }, amountVat: { value: '14.75', currency: 'EUR' }, amountGross: { value: '85.00', currency: 'EUR' } }] } } },
    };
    const { s } = setup({ fetch: mockFetch({ 'api.mollie.com/v2/settlements': { _embedded: { settlements: [settlement] }, _links: { next: null } } }) });
    s.integrations.configure('mollie', { apiKey: 'access_x' }, true);
    const r = await s.integrations.sync('mollie');
    expect(r.created).toBe(1);
    expect(s.ledger.balance(ACCOUNTS.kruisposten)).toBe(415000);
    expect(s.ledger.balance(ACCOUNTS.bankkosten)).toBe(7025);
    expect(s.ledger.balance(ACCOUNTS.btwVoorbelasting)).toBe(1475);
    expect((await s.integrations.sync('mollie')).created).toBe(0);
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-09-16', amount: 415000, description: 'Uitbetaling 1234567.2609.01', counterName: 'Stichting Mollie Payments' }] });
    const t = s.bank.list({ status: 'nieuw' })[0]!;
    const sug = s.matching.suggest(t).find((x) => x.kind === 'rekening')!;
    expect(sug).toMatchObject({ account: ACCOUNTS.kruisposten });
    s.bank.bookToAccount(t.id, { account: ACCOUNTS.kruisposten });
    expect(s.ledger.balance(ACCOUNTS.kruisposten)).toBe(0);
  });

  it('fouten worden bewaard en ontbrekende velden gemeld', async () => {
    const { s } = setup({ fetch: mockFetch({}) });
    s.integrations.configure('stripe', {}, true);
    await expect(s.integrations.sync('stripe')).rejects.toThrow(/niet ingevuld/);
    expect(s.integrations.state('stripe').lastError).toMatch(/niet ingevuld/);
  });
});

describe('exports & dashboard', () => {
  it('auditfile (XAF) is geldige XML en in balans', () => {
    const { s, klant } = setup();
    s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-03-01', lines: [{ description: 'x & y <z>', quantity: 1, unitPrice: 1000, vatCode: 'hoog' }] }).id);
    const xml = s.exports.auditfile('2026-01-01', '2026-12-31', s.settings.get().company, '0.1.0');
    expect(XMLValidator.validate(xml)).toBe(true);
    const doc = new XMLParser().parse(xml);
    const t = doc.auditfile.company.transactions;
    expect(t.totalDebit).toBe(t.totalCredit);
    expect(s.exports.journalCsv('2026-01-01', '2026-12-31')).toContain('WOmzNodOdh');
  });

  it('dashboard: omzet, openstaand, BTW-schuld', () => {
    const { s, klant } = setup();
    s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-09-01', lines: [{ description: 'x', quantity: 1, unitPrice: 100000, vatCode: 'hoog' }] }).id);
    s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-08-01', lines: [{ description: 'y', quantity: 1, unitPrice: 50000, vatCode: 'hoog' }] }).id);
    const d = s.dashboard.get('2026-09-10');
    expect(d.revenueThisMonth).toBe(100000);
    expect(d.revenueThisYear).toBe(150000);
    expect(d.openInvoices).toMatchObject({ count: 2, amount: 181500, overdueCount: 1, overdueAmount: 60500 });
    expect(d.vat).toMatchObject({ periodKey: '2026-Q3', toPay: 31500 });
    expect(d.revenueByMonth).toHaveLength(12);
    expect(d.revenueByMonth.at(-1)!.revenue).toBe(100000);
  });
});
