import { describe, expect, it } from 'vitest';
import { setup, financialSnapshot } from './helpers';
import type { ExternalOrder, FetchLike } from '../src/integrations/types';

const zwitsers = { name: 'Alpen Shipping AG', email: 'facturen@alpen.example', address: 'Bahnhofstrasse 1', postcode: '8001', city: 'Zürich', country: 'CH', vatNumber: 'CHE-123.456.789 MWST' };
const order = (id: string, extra: Partial<ExternalOrder> = {}): ExternalOrder => ({
  externalId: id,
  number: `I-${id}`,
  date: '2026-11-05',
  customer: zwitsers,
  lines: [{ description: 'Abonnement, 1 maand', quantity: 1, unitPriceExVat: 50000, vatPercentage: 0 }],
  paid: true,
  currency: 'EUR',
  total: 50000,
  ...extra,
});

describe('verkoop uit een koppeling aan een bedrijf buiten de EU', () => {
  it('wacht op de keuze dienst of goederen, boekt dan een betaalde factuur buiten de aangifte', () => {
    const ctx = setup();
    const { s } = ctx;
    const before = financialSnapshot(ctx);
    expect(s.integrations.importOrders('mollie-facturen', [order('a')])).toMatchObject({ created: 0, messages: [expect.stringContaining('buiten de EU')] });
    expect(financialSnapshot(ctx)).toEqual(before);
    const task = s.inbox.tasks().find((t) => t.kind === 'sale-outside-eu')!;
    expect(task.actions.map((a) => a.id)).toEqual(['dienst-buiten-eu', 'export', 'zelf']);

    s.integrations.answerQuestion(task.ref!.questionId!, 'dienst-buiten-eu');
    const inv = ctx.db.prepare(`SELECT id, status, total FROM invoices WHERE external_id = 'a'`).get() as { id: number; status: string; total: number };
    expect(inv).toMatchObject({ status: 'betaald', total: 50000 });
    expect(ctx.db.prepare('SELECT vat_code FROM invoice_lines WHERE invoice_id = ?').all(inv.id)).toEqual([{ vat_code: 'dienst-buiten-eu' }]);
    const vat = s.vat.calculate('2026-Q4');
    expect(vat.breakdown.find((b) => b.vatCode === 'dienst-buiten-eu')).toMatchObject({ omzet: 50000, btw: 0 });
    expect(vat.rubrieken.find((r) => r.code === '1e')).toMatchObject({ omzet: 0 });
    expect(s.inbox.tasks().some((t) => t.kind === 'sale-outside-eu')).toBe(false);
    expect(s.ledger.checkIntegrity().balanced).toBe(true);
  });

  it('een volgende order van dezelfde klant gaat vanzelf zoals de vorige keer', () => {
    const { s, db } = setup();
    s.integrations.importOrders('mollie-facturen', [order('a')]);
    s.integrations.answerQuestion(s.integrations.questions()[0]!.id, 'export');
    expect(s.integrations.importOrders('mollie-facturen', [order('b', { customer: { ...zwitsers, vatNumber: 'che123456789mwst' } })])).toMatchObject({ created: 1 });
    expect(db.prepare(`SELECT l.vat_code FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id WHERE i.external_id = 'b'`).all()).toEqual([{ vat_code: 'export' }]);
    // een andere klant buiten de EU: weer de vraag
    expect(s.integrations.importOrders('mollie-facturen', [order('c', { customer: { ...zwitsers, name: 'Ander AG', vatNumber: 'CHE-999.999.999 MWST' } })]).created).toBe(0);
    expect(s.integrations.questions().map((q) => q.reason)).toEqual(['buitenland']);
  });

  it.each([
    ['een particulier buiten de EU', { customer: { ...zwitsers, vatNumber: null } }],
    ['een order met btw', { lines: [{ description: 'Abonnement', quantity: 1, unitPriceExVat: 50000, vatPercentage: 21 }], total: 60500 }],
    ['een bedrijf in de EU', { customer: { ...zwitsers, country: 'DE', vatNumber: 'DE123456789' } }],
  ])('%s blijft een verkoop die je zelf boekt', (_, extra) => {
    const { s } = setup();
    s.integrations.importOrders('mollie-facturen', [order('a', extra as Partial<ExternalOrder>)]);
    expect(s.integrations.questions().map((q) => q.reason)).toEqual(['zelf']);
  });

  it('een eerder als "zelf boeken" klaargezette order wordt bij bijwerken alsnog de vraag', async () => {
    const empty: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ _embedded: { invoices: [] }, _links: { next: null } }), text: async () => '' }) as never;
    const { s, db } = setup({ fetch: empty });
    s.integrations.configure('mollie-facturen', { apiKey: 'test' }, true);
    db.prepare(`INSERT INTO integration_questions (source, external_id, reason, order_data, signals) VALUES ('mollie-facturen', 'a', 'zelf', ?, '["de klant zit buiten Nederland"]')`).run(JSON.stringify(order('a')));
    await s.integrations.sync('mollie-facturen');
    expect(s.integrations.questions().map((q) => q.reason)).toEqual(['buitenland']);
  });
});
