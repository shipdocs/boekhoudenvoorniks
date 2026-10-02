import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import { createApi, type HostContext } from '../src/main/api';
import { mapMollieSalesInvoice } from '../src/integrations/mollie';
import { linesFromInclusive } from '../src/integrations/prices';
import { computeTotals } from '../src/documents/totals';
import type { ExternalOrder, FetchLike } from '../src/integrations/types';
import { formatEuro } from '../src/shared/money';

/**
 * Mollie Facturen met prijzen inclusief btw (#228): `vatMode` zegt of de prijs per regel met of zonder btw
 * is. Het totaal van de factuur in de app is wat de klant betaalde; bij een onbekende opgave raadt de app niet.
 */

function mockFetch(routes: Record<string, unknown>, calls: string[] = []): FetchLike {
  return async (url) => {
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' };
    return { ok: true, status: 200, json: async () => routes[key], text: async () => JSON.stringify(routes[key]) };
  };
}

const eur = (value: string) => ({ value, currency: 'EUR' });
const line = (unitPrice: string, vatRate = '21.00', quantity = 1, description = 'Abonnement') => ({ description, quantity, vatRate, unitPrice: eur(unitPrice) });

type MollieInvoice = Parameters<typeof mapMollieSalesInvoice>[0];
const invoice = (over: Record<string, unknown> = {}): MollieInvoice =>
  ({
    id: 'invoice_1',
    status: 'paid',
    invoiceNumber: 'I-0061',
    currency: 'EUR',
    vatScheme: 'standard',
    vatMode: 'inclusive',
    recipient: { type: 'business', organizationName: 'Rederij Voorbeeld', vatNumber: 'NL004455667B01', email: 'info@rederij.example', streetAndNumber: 'Kade 3', postalCode: '3000 AB', city: 'Rotterdam', country: 'NL' },
    lines: [line('10.89')],
    subtotalAmount: eur('9.00'),
    totalVatAmount: eur('1.89'),
    totalAmount: eur('10.89'),
    issuedAt: '2026-09-01T00:00:00Z',
    paidAt: '2026-09-03T00:00:00Z',
    createdAt: '2026-09-01T00:00:00Z',
    ...over,
  }) as MollieInvoice;

const totals = (order: ExternalOrder) => {
  const t = computeTotals(order.lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPriceExVat, vatCode: l.vatPercentage === 21 ? 'hoog' : l.vatPercentage === 9 ? 'laag' : 'nul', vatPercentage: l.vatPercentage })));
  return { subtotal: t.subtotal, vat: t.vatTotal, total: t.total };
};

function withMollie(invoices: unknown[], calls: string[] = []) {
  const ctx = setup({ fetch: mockFetch({ 'api.mollie.com/v2/sales-invoices': { _embedded: { invoices }, _links: { next: null } } }, calls) });
  ctx.s.settings.update({ onboardingDone: true });
  ctx.s.integrations.configure('mollie-facturen', { apiKey: 'access_x' }, true);
  const api = createApi(ctx.s, { appVersion: () => '0.0.0', hasSmtpPassword: () => false } as unknown as HostContext);
  const tasks = (kind: string) => ctx.s.inbox.tasks('2026-09-15').filter((t) => t.kind === kind);
  const books = () => ({
    omzet: ctx.s.dashboard.reports('2026-01-01', '2026-12-31').revenue,
    btw: 0 - ctx.s.ledger.balance(ACCOUNTS.btwAfdragenHoog),
    betaaldienst: ctx.s.ledger.balance(ACCOUNTS.tussenrekeningPsp),
    debiteuren: ctx.s.ledger.balance(ACCOUNTS.debiteuren),
  });
  return { ...ctx, api, tasks, books };
}

describe('prijzen inclusief btw terugrekenen', () => {
  const incl = (...prices: [number, number?, number?][]) => prices.map(([unitPriceExVat, vatPercentage = 21, quantity = 1], i) => ({ description: `Regel ${i + 1}`, quantity, unitPriceExVat, vatPercentage }));

  it('één regel: € 10,89 inclusief 21% is € 9,00 + € 1,89', () => {
    expect(linesFromInclusive(incl([1089]))).toEqual([{ description: 'Regel 1', quantity: 1, unitPriceExVat: 900, vatPercentage: 21 }]);
  });

  it('meer regels: los afronden per regel zou een cent schelen, het totaal blijft wat er betaald is', () => {
    // 3 × € 10,00 inclusief: per regel € 8,26 geeft € 24,78 + € 5,20 = € 29,98; het hoort € 24,79 + € 5,21 te zijn
    const lines = linesFromInclusive(incl([1000], [1000], [1000]));
    expect(lines.map((l) => l.unitPriceExVat).sort()).toEqual([826, 826, 827]);
    expect(totals({ lines } as ExternalOrder)).toEqual({ subtotal: 2479, vat: 521, total: 3000 });
  });

  it('een aantal dat niet in hele centen per stuk uitkomt, wordt één regel met het aantal in de omschrijving', () => {
    expect(linesFromInclusive(incl([1000, 21, 3]))).toEqual([{ description: '3 × Regel 1', quantity: 1, unitPriceExVat: 2479, vatPercentage: 21 }]);
    expect(linesFromInclusive(incl([1089, 21, 3]))).toEqual([{ description: 'Regel 1', quantity: 3, unitPriceExVat: 900, vatPercentage: 21 }]);
  });

  it('per btw-tarief apart, en 0% blijft wat het was', () => {
    const lines = linesFromInclusive(incl([1210, 21], [1090, 9], [500, 0]));
    expect(lines.map((l) => l.unitPriceExVat)).toEqual([1000, 1000, 500]);
    expect(totals({ lines } as ExternalOrder)).toEqual({ subtotal: 2500, vat: 300, total: 2800 });
  });

  it('voor elk bedrag van € 0,01 tot € 50,00: de btw is wat er in het bedrag zit, en het totaal wijkt hooguit één cent af', () => {
    let exact = 0;
    for (const rate of [21, 9]) {
      for (let gross = 1; gross <= 5000; gross++) {
        const t = totals({ lines: linesFromInclusive(incl([gross, rate])) } as ExternalOrder);
        expect(t.vat).toBe(gross - Math.round((gross * 100) / (100 + rate)));
        expect(Math.abs(t.total - gross)).toBeLessThanOrEqual(1);
        if (t.total === gross) exact++;
      }
    }
    // voor de meeste bedragen komt het precies uit; de rest is één cent, die de app als afrondingsverschil boekt
    expect(exact).toBeGreaterThan(8000);
  });
});

describe('Mollie Facturen: vatMode (#228)', () => {
  it('inclusive: de prijs per regel is inclusief btw, het totaal is wat de klant betaalde', () => {
    const order = mapMollieSalesInvoice(invoice());
    expect(order.lines).toEqual([{ description: 'Abonnement', quantity: 1, unitPriceExVat: 900, vatPercentage: 21 }]);
    expect(order.total).toBe(1089);
    expect(order.pricesUnknown).toBeUndefined();
    expect(totals(order)).toEqual({ subtotal: 900, vat: 189, total: 1089 });
  });

  it('exclusive, of niets opgegeven (de standaard bij Mollie): de btw komt erbovenop', () => {
    for (const vatMode of ['exclusive', undefined]) {
      const order = mapMollieSalesInvoice(invoice({ vatMode, lines: [line('9.00')] }));
      expect(order.lines).toEqual([{ description: 'Abonnement', quantity: 1, unitPriceExVat: 900, vatPercentage: 21 }]);
      expect(totals(order)).toEqual({ subtotal: 900, vat: 189, total: 1089 });
      expect(order.total).toBe(1089);
      expect(order.pricesUnknown).toBeUndefined();
    }
  });

  it('meer regels en twee tarieven inclusief btw: totaal en btw gelijk aan de factuur', () => {
    const order = mapMollieSalesInvoice(invoice({ lines: [line('10.00'), line('10.00'), line('10.00'), line('5.45', '9.00', 2, 'Boekje')], totalAmount: eur('40.90'), totalVatAmount: eur('6.11') }));
    expect(totals(order)).toEqual({ subtotal: 3479, vat: 611, total: 4090 });
    expect(order.total).toBe(4090);
  });

  it('ingelezen: € 9,00 omzet en € 1,89 btw, en € 10,89 bij de betaaldienst (niet € 13,18)', async () => {
    const { s, books } = withMollie([invoice()]);
    expect(await s.integrations.sync('mollie-facturen')).toMatchObject({ created: 1, messages: [] });
    expect(s.invoices.list()[0]).toMatchObject({ total: 1089, status: 'betaald', open_amount: 0 });
    expect(books()).toEqual({ omzet: 900, btw: 189, betaaldienst: 1089, debiteuren: 0 });
  });

  it('komt het netto + btw één cent anders uit dan het betaalde bedrag, dan is dat een afrondingsverschil en klopt het geld', async () => {
    // € 10,00 inclusief 21%: € 8,26 + € 1,74 op de factuur van Mollie; netto × 21% geeft hier € 1,73 of € 1,74 bij € 8,27
    const { s, books } = withMollie([invoice({ lines: [line('10.00')], totalAmount: eur('10.00'), totalVatAmount: eur('1.74'), subtotalAmount: eur('8.26') })]);
    expect(await s.integrations.sync('mollie-facturen')).toMatchObject({ created: 1, messages: [] });
    const inv = s.invoices.list()[0]!;
    expect(inv).toMatchObject({ total: 1001, status: 'betaald', open_amount: 0 });
    // de btw is die van de factuur, bij de betaaldienst staat wat er betaald is, en per saldo is de opbrengst € 8,26
    expect(books()).toEqual({ omzet: 827, btw: 174, betaaldienst: 1000, debiteuren: 0 });
    expect(s.ledger.balance(ACCOUNTS.betalingsverschillen)).toBe(1);
    expect(s.invoices.overpaidCustomers()).toEqual([]);
  });

  it('past het totaal niet bij de regels (bv. een korting), dan boekt de app niets en zegt hij waarom', async () => {
    const { s, books } = withMollie([invoice({ vatMode: 'exclusive', lines: [line('100.00')], totalAmount: eur('108.90') })]);
    const r = await s.integrations.sync('mollie-facturen');
    expect(r.created).toBe(0);
    expect(r.messages.join(' ')).toContain(formatEuro(12100));
    expect(r.messages.join(' ')).toContain(formatEuro(10890));
    expect(s.invoices.list()).toHaveLength(0);
    expect(s.relations.list().some((x) => x.name === 'Rederij Voorbeeld')).toBe(false);
    expect(books()).toEqual({ omzet: 0, btw: 0, betaaldienst: 0, debiteuren: 0 });
  });

  it('onbekende vatMode: niet raden maar een vraag op Vandaag; daarna ingelezen zoals jij zegt', async () => {
    for (const [answer, expected] of [['inclusief', { omzet: 900, btw: 189, betaaldienst: 1089, debiteuren: 0 }], ['exclusief', { omzet: 1089, btw: 229, betaaldienst: 1318, debiteuren: 0 }]] as const) {
      const { s, api, tasks, books } = withMollie([invoice({ vatMode: 'margin', totalAmount: answer === 'inclusief' ? eur('10.89') : eur('13.18') })]);
      const r = await s.integrations.sync('mollie-facturen');
      expect(r).toMatchObject({ created: 0, skipped: 1 });
      expect(r.messages.join(' ')).toContain('Vandaag');
      expect(s.invoices.list()).toHaveLength(0);
      expect(books()).toEqual({ omzet: 0, btw: 0, betaaldienst: 0, debiteuren: 0 });
      const [task] = tasks('sale-vat-mode');
      expect(task!.question).toContain('I-0061');
      expect(task!.question).toContain(formatEuro(1089));
      expect(task!.question).toContain(formatEuro(1318));
      expect(task!.actions.map((a) => a.id)).toEqual(['inclusief', 'exclusief']);
      // nog een keer bijwerken verandert niets
      expect(await s.integrations.sync('mollie-facturen')).toMatchObject({ created: 0 });
      expect(tasks('sale-vat-mode')).toHaveLength(1);
      await api.home.act(task!, answer);
      expect(tasks('sale-vat-mode')).toEqual([]);
      expect(books()).toEqual(expected);
      expect(await s.integrations.sync('mollie-facturen')).toMatchObject({ created: 0 });
      expect(s.invoices.list()).toHaveLength(1);
    }
  });

  it('geeft Mollie niets op terwijl het totaal alleen bij prijzen inclusief btw past, dan ook de vraag', async () => {
    const { s, api, tasks, books } = withMollie([invoice({ vatMode: undefined })]);
    expect(await s.integrations.sync('mollie-facturen')).toMatchObject({ created: 0, skipped: 1 });
    expect(books()).toEqual({ omzet: 0, btw: 0, betaaldienst: 0, debiteuren: 0 });
    await api.home.act(tasks('sale-vat-mode')[0]!, 'inclusief');
    expect(books()).toEqual({ omzet: 900, btw: 189, betaaldienst: 1089, debiteuren: 0 });
  });

  it('past jouw antwoord niet bij wat er betaald is, dan boekt de app niets en blijft de vraag staan', async () => {
    const { s, api, tasks, books } = withMollie([invoice({ vatMode: 'margin', totalAmount: eur('10.89') })]);
    await s.integrations.sync('mollie-facturen');
    await expect(api.home.act(tasks('sale-vat-mode')[0]!, 'exclusief')).rejects.toThrow(/betaald/);
    expect(books()).toEqual({ omzet: 0, btw: 0, betaaldienst: 0, debiteuren: 0 });
    expect(tasks('sale-vat-mode')).toHaveLength(1);
  });
});

describe('een factuur die te hoog is ingelezen verbeteren: terugdraaien en opnieuw inlezen (#228)', () => {
  /** zoals de vorige versie hem inlas: € 10,89 als prijs exclusief btw, dus € 13,18 */
  const teHoog = (): ExternalOrder => ({ ...mapMollieSalesInvoice(invoice({ vatMode: 'exclusive', totalAmount: undefined })), total: undefined });
  function oud(invoices: unknown[] = [invoice()], calls: string[] = []) {
    const ctx = withMollie(invoices, calls);
    expect(ctx.s.integrations.importOrders('mollie-facturen', [teHoog()])).toMatchObject({ created: 1 });
    const old = ctx.s.invoices.list()[0]!;
    expect(old.total).toBe(1318);
    return { ...ctx, old };
  }
  const reverse = (s: ReturnType<typeof setup>['s'], id: number) => s.invoices.finalize(s.invoices.createCreditNote(id).id);

  it('zonder terugdraaien verandert er niets: de factuur stond er al', async () => {
    const { s, tasks, books } = oud();
    expect(await s.integrations.sync('mollie-facturen')).toMatchObject({ created: 0, messages: [] });
    expect(tasks('sale-reread')).toEqual([]);
    expect(books()).toEqual({ omzet: 1089, btw: 229, betaaldienst: 1318, debiteuren: 0 });
  });

  it('een creditfactuur die nog een concept is, telt niet als teruggedraaid', async () => {
    const { s, tasks, old } = oud();
    s.invoices.createCreditNote(old.id);
    expect(await s.integrations.sync('mollie-facturen')).toMatchObject({ created: 0 });
    expect(tasks('sale-reread')).toEqual([]);
  });

  it('teruggedraaid: de app vraagt of hij hem opnieuw mag inlezen; "Ja" geeft één keer omzet, met het juiste bedrag', async () => {
    const { s, api, tasks, books, old } = oud();
    reverse(s, old.id);
    expect(books()).toMatchObject({ omzet: 0, btw: 0 });
    const r = await s.integrations.sync('mollie-facturen');
    expect(r).toMatchObject({ created: 0 });
    expect(r.messages.join(' ')).toContain('Vandaag');
    // nog niets geboekt: eerst de vraag
    expect(s.invoices.list()).toHaveLength(2);
    expect(books()).toMatchObject({ omzet: 0, btw: 0 });
    const [task] = tasks('sale-reread');
    expect(task!.question).toContain(old.number!);
    expect(task!.question).toContain(formatEuro(1318));
    expect(task!.question).toContain(formatEuro(1089));
    expect(task!.actions.map((a) => a.id)).toEqual(['opnieuw', 'niet']);
    await api.home.act(task!, 'opnieuw');
    expect(tasks('sale-reread')).toEqual([]);
    // de oude factuur en de creditfactuur blijven staan; de nieuwe is de enige met omzet
    expect(s.invoices.list()).toHaveLength(3);
    expect(s.invoices.list().every((i) => i.open_amount === 0)).toBe(true);
    expect(books()).toEqual({ omzet: 900, btw: 189, betaaldienst: 1089, debiteuren: 0 });
    // daarna is hij gewoon bekend
    expect(await s.integrations.sync('mollie-facturen')).toMatchObject({ created: 0, messages: [] });
    expect(s.invoices.list()).toHaveLength(3);
    expect(tasks('sale-reread')).toEqual([]);
  });

  it('"Nee": er verandert niets en de app vraagt het niet opnieuw (bv. als je hem zelf al opnieuw maakte)', async () => {
    const { s, api, tasks, books, old } = oud();
    reverse(s, old.id);
    await s.integrations.sync('mollie-facturen');
    const before = books();
    await api.home.act(tasks('sale-reread')[0]!, 'niet');
    expect(books()).toEqual(before);
    expect(await s.integrations.sync('mollie-facturen')).toMatchObject({ created: 0 });
    expect(tasks('sale-reread')).toEqual([]);
    expect(s.invoices.list()).toHaveLength(2);
  });

  it('een teruggedraaide factuur die nu hetzelfde gelezen wordt, komt niet terug', async () => {
    const { s, tasks, books } = withMollie([invoice()]);
    await s.integrations.sync('mollie-facturen');
    reverse(s, s.invoices.list()[0]!.id);
    expect(await s.integrations.sync('mollie-facturen')).toMatchObject({ created: 0 });
    expect(tasks('sale-reread')).toEqual([]);
    expect(books()).toMatchObject({ omzet: 0, btw: 0 });
  });

  it('was het een verkoop aan je eigen bedrijf, dan volgt na "Ja" de vraag of het omzet was; "Geen omzet" laat niets open staan', async () => {
    const eigen = { type: 'business', organizationName: 'Stukadoorsbedrijf Piet', vatNumber: null, email: 'administratie@voorbeeld.example', streetAndNumber: 'Kalkweg 1', postalCode: '1234 AB', city: 'Utrecht', country: 'NL' };
    const ctx = withMollie([invoice({ recipient: eigen })]);
    const { s, api, tasks, books } = ctx;
    // zoals de vorige versie: te hoog, en gewoon als omzet aan de klant "Stukadoorsbedrijf Piet"
    s.integrations.setOwnCompany(() => null, s.bank);
    s.integrations.importOrders('mollie-facturen', [{ ...mapMollieSalesInvoice(invoice({ vatMode: 'exclusive', totalAmount: undefined, recipient: eigen })), total: undefined }]);
    s.integrations.setOwnCompany(() => ({ name: 'Stukadoorsbedrijf Piet', vatNumber: 'NL123456789B01', kvkNumber: '12345678', ibans: [], email: 'piet@example.nl' }), s.bank);
    reverse(s, s.invoices.list()[0]!.id);
    await s.integrations.sync('mollie-facturen');
    await api.home.act(tasks('sale-reread')[0]!, 'opnieuw');
    expect(books()).toMatchObject({ omzet: 0, btw: 0, debiteuren: 0 });
    const [own] = tasks('sale-own-company');
    expect(own).toMatchObject({ amount: 1089 });
    await api.home.act(own!, 'neutraal');
    expect(books()).toEqual({ omzet: 0, btw: 0, betaaldienst: 1089, debiteuren: 0 });
    expect(s.ledger.balance(ACCOUNTS.priveStortingen)).toBe(-1089);
    expect(s.invoices.list()).toHaveLength(2);
  });

  it('staat de teruggedraaide factuur pas op een volgende pagina bij Mollie, dan leest de app door tot hij hem heeft', async () => {
    const calls: string[] = [];
    const page2 = 'https://api.mollie.com/v2/sales-invoices?from=invoice_1&limit=50';
    const nieuwer = invoice({ id: 'invoice_2', invoiceNumber: 'I-0062', lines: [line('12.10')], totalAmount: eur('12.10') });
    const ctx = setup({
      fetch: async (url) => {
        calls.push(url);
        const body = url.includes('from=invoice_1') ? { _embedded: { invoices: [invoice()] }, _links: { next: null } } : { _embedded: { invoices: [nieuwer] }, _links: { next: { href: page2 } } };
        return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
      },
    });
    const { s } = ctx;
    s.settings.update({ onboardingDone: true });
    s.integrations.configure('mollie-facturen', { apiKey: 'access_x' }, true);
    s.integrations.importOrders('mollie-facturen', [teHoog(), mapMollieSalesInvoice(nieuwer)]);
    // alles bekend: na de eerste pagina stoppen
    await s.integrations.sync('mollie-facturen');
    expect(calls).toHaveLength(1);
    reverse(s, s.invoices.list().find((i) => i.total === 1318)!.id);
    await s.integrations.sync('mollie-facturen');
    expect(calls).toHaveLength(3);
    expect(s.inbox.tasks('2026-09-15').filter((t) => t.kind === 'sale-reread')).toHaveLength(1);
  });
});
