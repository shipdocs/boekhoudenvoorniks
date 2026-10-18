import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import { createApi, type HostContext } from '../src/main/api';
import { detectOwnCustomer, type OwnIdentity } from '../src/intake/own-company';
import type { ExternalOrder, FetchLike } from '../src/integrations/types';
import { formatEuro } from '../src/shared/money';

/**
 * Een verkoop aan je eigen bedrijf via een koppeling (#231), bv. een proefabonnement op je eigen dienst
 * dat je eigen bedrijf betaalt: geen omzet en geen btw vanzelf, maar eerst de vraag wat het was.
 */

function mockFetch(routes: Record<string, unknown>): FetchLike {
  return async (url) => {
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' };
    return { ok: true, status: 200, json: async () => routes[key], text: async () => JSON.stringify(routes[key]) };
  };
}

const OWN: OwnIdentity = { name: 'Stukadoorsbedrijf Piet', vatNumber: 'NL123456789B01', kvkNumber: '12345678', ibans: ['NL91ABNA0417164300'], email: 'piet@example.nl' };

/** een betaalde factuur uit Mollie Facturen aan het eigen bedrijf: € 9,00 + € 1,89 btw */
const mollieInvoice = (recipient: Record<string, unknown> = {}) => ({
  id: 'invoice_eigen',
  status: 'paid',
  invoiceNumber: 'I-0050',
  currency: 'EUR',
  recipient: { type: 'business', organizationName: 'Stukadoorsbedrijf Piet', vatNumber: null, email: 'administratie@voorbeeld.example', streetAndNumber: 'Kalkweg 1', postalCode: '1234 AB', city: 'Utrecht', country: 'NL', ...recipient },
  lines: [{ description: 'Proefabonnement', quantity: 1, vatRate: '21.00', unitPrice: { value: '9.00', currency: 'EUR' } }],
  issuedAt: '2026-09-10T00:00:00Z',
  paidAt: '2026-09-10T00:00:00Z',
  createdAt: '2026-09-10T00:00:00Z',
});

const settlement = {
  id: 'stl_eigen',
  reference: '7654321.2609.01',
  settledAt: '2026-09-12T00:00:00Z',
  status: 'paidout',
  amount: { value: '10.54', currency: 'EUR' },
  periods: { '2026': { '09': { revenue: [{ amountGross: { value: '10.89', currency: 'EUR' } }], costs: [{ amountNet: { value: '0.29', currency: 'EUR' }, amountVat: { value: '0.06', currency: 'EUR' }, amountGross: { value: '0.35', currency: 'EUR' } }] } } },
};

function withMollie(invoice: unknown = mollieInvoice()) {
  const ctx = setup({
    fetch: mockFetch({
      'api.mollie.com/v2/sales-invoices': { _embedded: { invoices: [invoice] }, _links: { next: null } },
      'api.mollie.com/v2/settlements': { _embedded: { settlements: [settlement] }, _links: { next: null } },
    }),
  });
  ctx.s.settings.update({ onboardingDone: true });
  ctx.s.integrations.configure('mollie-facturen', { apiKey: 'access_x' }, true);
  const api = createApi(ctx.s, { appVersion: () => '0.0.0', hasSmtpPassword: () => false } as unknown as HostContext);
  const question = () => ctx.s.inbox.tasks('2026-09-15').filter((t) => t.kind === 'sale-own-company');
  /** omzet, af te dragen btw en wat er bij de betaaldienst en op privé staat */
  const books = () => ({
    omzet: ctx.s.dashboard.reports('2026-01-01', '2026-12-31').revenue,
    btw: ctx.s.ledger.balance(ACCOUNTS.btwAfdragenHoog),
    betaaldienst: ctx.s.ledger.balance(ACCOUNTS.tussenrekeningPsp),
    priveStorting: ctx.s.ledger.balance(ACCOUNTS.priveStortingen),
  });
  return { ...ctx, api, question, books };
}

describe('herkennen: de klant is je eigen bedrijf', () => {
  const klant = (over: Partial<ExternalOrder['customer']> = {}) => ({ name: 'Familie Jansen', email: null, vatNumber: null, kvkNumber: null, ...over });

  it('je bedrijfsnaam, btw-nummer, KvK-nummer of e-mailadres uit Instellingen', () => {
    expect(detectOwnCustomer(klant({ name: 'STUKADOORSBEDRIJF PIET B.V.' }), OWN)?.signals).toEqual(['de klant heeft je eigen bedrijfsnaam']);
    expect(detectOwnCustomer(klant({ vatNumber: 'NL 1234.56.789.B01' }), OWN)?.signals).toEqual(['de klant heeft je eigen btw-nummer']);
    expect(detectOwnCustomer(klant({ kvkNumber: '12345678' }), OWN)?.signals).toEqual(['de klant heeft je eigen KvK-nummer']);
    expect(detectOwnCustomer(klant({ email: 'Piet@Example.nl' }), OWN)?.signals).toEqual(['de klant heeft het e-mailadres van je bedrijf']);
    expect(detectOwnCustomer(klant({ name: 'Stukadoorsbedrijf Piet', vatNumber: 'NL123456789B01' }), OWN)).toMatchObject({ level: 'zeker' });
    expect(detectOwnCustomer(klant({ name: 'Stukadoorsbedrijf Piet' }), OWN)).toMatchObject({ level: 'waarschijnlijk' });
  });

  it('een gewone klant niet, en ook niet een ander bedrijf met dezelfde naam maar een eigen btw- of KvK-nummer', () => {
    expect(detectOwnCustomer(klant(), OWN)).toBeNull();
    expect(detectOwnCustomer(klant({ name: 'Stukadoorsbedrijf Piet', vatNumber: 'NL999999999B01' }), OWN)).toBeNull();
    expect(detectOwnCustomer(klant({ name: 'Stukadoorsbedrijf Piet', kvkNumber: '87654321' }), OWN)).toBeNull();
    // zonder eigen gegevens in Instellingen valt er niets te herkennen
    expect(detectOwnCustomer(klant({ name: '', email: '' }), { name: '', vatNumber: '', kvkNumber: '', ibans: [], email: '' })).toBeNull();
  });
});

describe('verkoop aan je eigen bedrijf via een koppeling (#231)', () => {
  it('Mollie-factuur met de eigen bedrijfsnaam als ontvanger: een vraag op Vandaag, geen omzet', async () => {
    const { s, question, books } = withMollie();
    const r = await s.integrations.sync('mollie-facturen');
    expect(r).toMatchObject({ created: 0, skipped: 1 });
    expect(r.messages.join(' ')).toContain('je eigen bedrijf');
    // niets geboekt en geen factuur of klant erbij
    expect(s.invoices.list()).toHaveLength(0);
    expect(s.relations.list().some((x) => x.name === 'Stukadoorsbedrijf Piet')).toBe(false);
    expect(books()).toEqual({ omzet: 0, btw: 0, betaaldienst: 0, priveStorting: 0 });
    const [task] = question();
    expect(task).toMatchObject({ title: `Verkoop aan je eigen bedrijf: ${formatEuro(1089)}`, amount: 1089 });
    expect(task!.question).toContain('I-0050');
    expect(task!.actions.map((a) => a.id)).toEqual(['neutraal', 'verkoop']);
    expect(task!.actions.every((a) => a.hint)).toBe(true);
    expect(task!.why).toContain('de klant heeft je eigen bedrijfsnaam');
    // nog een keer bijwerken: dezelfde vraag, geen tweede en nog steeds niets geboekt
    expect(await s.integrations.sync('mollie-facturen')).toMatchObject({ created: 0 });
    expect(question()).toHaveLength(1);
    expect(books().omzet).toBe(0);
  });

  it('"Geen omzet": omzet noch btw, het geld bij de betaaldienst telt als privé-storting en de uitbetaling sluit aan', async () => {
    const { s, api, question, books } = withMollie();
    await s.integrations.sync('mollie-facturen');
    await api.home.act(question()[0]!, 'neutraal');
    expect(question()).toEqual([]);
    expect(s.invoices.list()).toHaveLength(0);
    expect(books()).toEqual({ omzet: 0, btw: 0, betaaldienst: 1089, priveStorting: -1089 });
    expect(s.vat.calculate('2026-Q3').summary).toMatchObject({ omzet: 0, teBetalen: 0 });
    // de factuur komt bij een volgende keer bijwerken niet terug, niet als vraag en niet als omzet
    expect(await s.integrations.sync('mollie-facturen')).toMatchObject({ created: 0 });
    expect(question()).toEqual([]);
    expect(books().omzet).toBe(0);
    // de uitbetaling van Mollie haalt het bedrag weer van de tussenrekening
    s.integrations.configure('mollie', { apiKey: 'access_y' }, true);
    await s.integrations.sync('mollie');
    expect(books()).toMatchObject({ omzet: 0, btw: 0, betaaldienst: 0, priveStorting: -1089 });
    expect(s.ledger.balance(ACCOUNTS.kruisposten)).toBe(1054);
  });

  it('"Toch een echte verkoop": een gewone betaalde factuur met omzet en btw', async () => {
    const { s, api, question, books } = withMollie();
    await s.integrations.sync('mollie-facturen');
    await api.home.act(question()[0]!, 'verkoop');
    expect(question()).toEqual([]);
    expect(s.invoices.list()).toMatchObject([{ total: 1089, status: 'betaald', relation_name: 'Stukadoorsbedrijf Piet' }]);
    expect(books()).toEqual({ omzet: 900, btw: -189, betaaldienst: 1089, priveStorting: 0 });
    // geen tweede factuur bij een volgende keer bijwerken
    expect(await s.integrations.sync('mollie-facturen')).toMatchObject({ created: 0 });
    expect(s.invoices.list()).toHaveLength(1);
  });

  it('een vraag beantwoord je één keer', async () => {
    const { s, api, question, books } = withMollie();
    await s.integrations.sync('mollie-facturen');
    const task = question()[0]!;
    await api.home.act(task, 'neutraal');
    await expect(api.home.act(task, 'verkoop')).rejects.toThrow(/al beantwoord/);
    await expect(api.home.act(task, 'neutraal')).rejects.toThrow(/al beantwoord/);
    expect(s.invoices.list()).toHaveLength(0);
    expect(books()).toEqual({ omzet: 0, btw: 0, betaaldienst: 1089, priveStorting: -1089 });
  });

  it('ook herkend aan je btw-nummer, KvK-nummer of e-mailadres; een ander bedrijf met dezelfde naam is gewoon omzet', async () => {
    for (const recipient of [
      { organizationName: 'Piet Holding', vatNumber: 'NL123456789B01' },
      { organizationName: 'Piet Holding', organizationNumber: '12345678' },
      { organizationName: 'Piet Holding', email: 'piet@example.nl' },
    ]) {
      const { s, question } = withMollie(mollieInvoice(recipient));
      expect(await s.integrations.sync('mollie-facturen')).toMatchObject({ created: 0 });
      expect(question()).toHaveLength(1);
      expect(s.invoices.list()).toHaveLength(0);
    }
    const { s, question, books } = withMollie(mollieInvoice({ vatNumber: 'NL999999999B01' }));
    expect(await s.integrations.sync('mollie-facturen')).toMatchObject({ created: 1 });
    expect(question()).toEqual([]);
    expect(books().omzet).toBe(900);
  });

  it('WooCommerce-bestelling op naam van je eigen bedrijf: dezelfde vraag', async () => {
    const order = {
      id: 77,
      number: '77',
      status: 'completed',
      currency: 'EUR',
      date_paid: '2026-09-10T10:00:00',
      date_created: '2026-09-10T09:00:00',
      billing: { first_name: 'Piet', last_name: 'Pleister', company: 'Stukadoorsbedrijf Piet', address_1: 'Kalkweg 1', address_2: '', postcode: '1234 AB', city: 'Utrecht', country: 'NL', email: 'piet@example.nl' },
      line_items: [{ name: 'Stucmortel 25kg', quantity: 1, subtotal: '10.00', subtotal_tax: '2.10', total: '10.00', total_tax: '2.10' }],
      shipping_lines: [],
      fee_lines: [],
    };
    const { s } = setup({ fetch: mockFetch({ '/wp-json/wc/v3/orders': [order] }) });
    s.settings.update({ onboardingDone: true });
    s.integrations.configure('woocommerce', { url: 'https://winkel.example.nl', consumerKey: 'ck_x', consumerSecret: 'cs_y' }, true);
    expect(await s.integrations.sync('woocommerce')).toMatchObject({ created: 0, skipped: 1 });
    expect(s.invoices.list()).toHaveLength(0);
    const [task] = s.inbox.tasks('2026-09-15').filter((t) => t.kind === 'sale-own-company');
    expect(task).toMatchObject({ amount: 1210 });
    expect(task!.question).toContain('WooCommerce');
    expect(task!.why).toContain('de klant heeft je eigen bedrijfsnaam');
    expect(task!.why).toContain('de klant heeft het e-mailadres van je bedrijf');
  });

  it('staat het geld al op de bank met het factuurnummer erbij, dan gaat "Geen omzet" over die bankregel en niet via de betaaldienst', async () => {
    const { s, api, question, books } = withMollie();
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-09-11', amount: 1089, description: 'Betaling I-0050', counterName: 'Stichting Derdengelden Voorbeeld' }] });
    const t = s.bank.list()[0]!;
    await s.integrations.sync('mollie-facturen');
    await api.home.act(question()[0]!, 'neutraal');
    expect(s.bank.get(t.id)).toMatchObject({ status: 'gematcht', matched_invoice_id: null });
    expect(books()).toEqual({ omzet: 0, btw: 0, betaaldienst: 0, priveStorting: -1089 });
  });

  it('staat er geld van je eigen naam op de bank zonder het nummer erbij, dan boekt "Geen omzet" niet stil via de betaaldienst: eerst de vraag of dat dit geld is', async () => {
    for (const keuze of ['neutraal-bank', 'neutraal-betaaldienst'] as const) {
      const { s, api, question, books } = withMollie();
      s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-09-11', amount: 1089, description: 'Abonnement', counterName: 'Stukadoorsbedrijf Piet' }] });
      const t = s.bank.list()[0]!;
      await s.integrations.sync('mollie-facturen');
      const [task] = question();
      expect(task!.actions.map((a) => a.id)).toEqual(['neutraal-bank', 'neutraal-betaaldienst', 'verkoop']);
      expect(task!.actions.every((a) => a.hint)).toBe(true);
      expect(task!.question).toContain('Op je bank staat');
      expect(task!.question).toContain('Abonnement');
      expect(task!.ref).toMatchObject({ bankTransactionId: t.id });
      // een oud scherm dat nog "Geen omzet" stuurt: niets geboekt, de vraag blijft staan
      await expect(api.home.act({ ...task!, actions: [] }, 'neutraal')).rejects.toThrow(/Op je bank staat/);
      expect(books()).toEqual({ omzet: 0, btw: 0, betaaldienst: 0, priveStorting: 0 });
      await api.home.act(task!, keuze);
      expect(question()).toEqual([]);
      if (keuze === 'neutraal-bank') {
        // de bankregel is de betaling: privé-storting, niets bij de betaaldienst en niets meer in te delen
        expect(s.bank.get(t.id)).toMatchObject({ status: 'gematcht', matched_invoice_id: null });
        expect(books()).toEqual({ omzet: 0, btw: 0, betaaldienst: 0, priveStorting: -1089 });
        expect(s.inbox.tasks('2026-09-15').filter((x) => x.ref.bankTransactionId === t.id)).toEqual([]);
      } else {
        // het geld komt nog van de betaaldienst; de bankregel is iets anders en blijft staan
        expect(s.bank.get(t.id)).toMatchObject({ status: 'nieuw' });
        expect(books()).toEqual({ omzet: 0, btw: 0, betaaldienst: 1089, priveStorting: -1089 });
      }
    }
  });

  it('had je die bankregel zelf al als privé-storting ingedeeld, dan boekt "dit is het geld op de bank" niets meer', async () => {
    const { s, api, question, books } = withMollie();
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-09-11', amount: 1089, description: 'Abonnement', counterName: 'Stukadoorsbedrijf Piet' }] });
    const t = s.bank.list()[0]!;
    await s.integrations.sync('mollie-facturen');
    s.bank.bookToAccount(t.id, { account: ACCOUNTS.priveStortingen, description: 'Privé gestort' });
    await api.home.act(question()[0]!, 'neutraal-bank');
    expect(question()).toEqual([]);
    expect(books()).toEqual({ omzet: 0, btw: 0, betaaldienst: 0, priveStorting: -1089 });
  });

  it('een kort ordernummer dat toevallig in een ander nummer op de bank zit, is niet de betaling: de ontvangst van een andere klant blijft staan', async () => {
    const order = (number: string) => ({
      id: 77,
      number,
      status: 'completed',
      currency: 'EUR',
      date_paid: '2026-09-10T10:00:00',
      date_created: '2026-09-10T09:00:00',
      billing: { first_name: 'Piet', last_name: 'Pleister', company: 'Stukadoorsbedrijf Piet', address_1: 'Kalkweg 1', address_2: '', postcode: '1234 AB', city: 'Utrecht', country: 'NL', email: 'piet@example.nl' },
      line_items: [{ name: 'Stucmortel 25kg', quantity: 1, subtotal: '10.00', subtotal_tax: '2.10', total: '10.00', total_tax: '2.10' }],
      shipping_lines: [],
      fee_lines: [],
    });
    const woo = (number: string, bank: { date: string; description: string; counterName: string }) => {
      const ctx = setup({ fetch: mockFetch({ '/wp-json/wc/v3/orders': [order(number)] }) });
      ctx.s.settings.update({ onboardingDone: true });
      ctx.s.integrations.configure('woocommerce', { url: 'https://winkel.example.nl', consumerKey: 'ck_x', consumerSecret: 'cs_y' }, true);
      ctx.s.bank.import({ source: 'csv', warnings: [], transactions: [{ amount: 1210, ...bank }] });
      const api = createApi(ctx.s, { appVersion: () => '0.0.0', hasSmtpPassword: () => false } as unknown as HostContext);
      const question = () => ctx.s.inbox.tasks('2026-09-15').filter((t) => t.kind === 'sale-own-company');
      return { ...ctx, api, question, t: ctx.s.bank.list()[0]! };
    };
    // "77" zit in het factuurnummer van een andere klant, weken eerder
    {
      const { s, api, question, t } = woo('77', { date: '2026-08-02', description: 'Factuur 2026-0177 Bouwbedrijf Voorbeeld', counterName: 'Bouwbedrijf Voorbeeld' });
      await s.integrations.sync('woocommerce');
      expect(question()[0]!.actions.map((a) => a.id)).toEqual(['neutraal', 'verkoop']);
      await api.home.act(question()[0]!, 'neutraal');
      expect(s.bank.get(t.id)).toMatchObject({ status: 'nieuw' });
      expect(s.ledger.balance(ACCOUNTS.tussenrekeningPsp)).toBe(1210);
      expect(s.ledger.balance(ACCOUNTS.priveStortingen)).toBe(-1210);
    }
    // het korte nummer staat er wel los in, maar dat is te weinig om er zeker van te zijn: de vraag
    {
      const { s, question, t } = woo('77', { date: '2026-09-11', description: 'Order 77', counterName: 'Bouwbedrijf Voorbeeld' });
      await s.integrations.sync('woocommerce');
      expect(question()[0]!.actions.map((a) => a.id)).toEqual(['neutraal-bank', 'neutraal-betaaldienst', 'verkoop']);
      expect(question()[0]!.ref).toMatchObject({ bankTransactionId: t.id });
    }
    // een lang nummer als heel woord, maar maanden eerder: ook de vraag
    {
      const { s, question } = woo('WC-20260077', { date: '2026-05-02', description: 'Betaling WC-20260077', counterName: 'Bouwbedrijf Voorbeeld' });
      await s.integrations.sync('woocommerce');
      expect(question()[0]!.actions.map((a) => a.id)).toEqual(['neutraal-bank', 'neutraal-betaaldienst', 'verkoop']);
    }
  });

  it('komt de uitbetaling op de bank terwijl de vraag nog open staat, dan waarschuwt de app en stelt hij geen nieuwe verkoop voor', async () => {
    const { s, api, question, books } = withMollie();
    await s.integrations.sync('mollie-facturen');
    expect(books().betaaldienst).toBe(0);
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-09-12', amount: 1054, description: 'Uitbetaling 7654321.2609.01', counterName: 'Stichting Mollie Payments' }] });
    const t = s.bank.list()[0]!;
    expect(s.bank.awaitedPayout(s.bank.get(t.id))).toBe('Mollie');
    const [income] = s.inbox.tasks('2026-09-15').filter((x) => x.ref.bankTransactionId === t.id);
    expect(income).toMatchObject({ kind: 'bank-income' });
    expect(income!.question).toContain('Mollie Facturen');
    expect(income!.question).toContain('beantwoord die eerst');
    expect(income!.question).toContain('geen nieuwe verkoop');
    // na het antwoord is het de gewone waarschuwing bij een uitbetaling
    await api.home.act(question()[0]!, 'neutraal');
    const [after] = s.inbox.tasks('2026-09-15').filter((x) => x.ref.bankTransactionId === t.id);
    expect(after!.question).not.toContain('beantwoord die eerst');
    expect(after!.question).toContain('geen nieuwe verkoop');
  });

  it('alleen dezelfde bedrijfsnaam: "Geen omzet" is dan niet de voorgestelde knop; bij meer aanwijzingen wel', async () => {
    const naam = withMollie();
    await naam.s.integrations.sync('mollie-facturen');
    expect(naam.question()[0]!.actions.filter((a) => a.primary)).toEqual([]);
    const meer = withMollie(mollieInvoice({ vatNumber: 'NL123456789B01' }));
    await meer.s.integrations.sync('mollie-facturen');
    expect(meer.question()[0]!.actions.filter((a) => a.primary).map((a) => a.id)).toEqual(['neutraal']);
    expect(meer.question()[0]!.actions[0]!.hint).toContain('draai');
  });

  it('verkeerd geklikt: draai je de boeking van "Geen omzet" terug, dan komt de vraag terug en kun je alsnog "Toch een echte verkoop" kiezen', async () => {
    const { s, db, api, question, books } = withMollie();
    await s.integrations.sync('mollie-facturen');
    await api.home.act(question()[0]!, 'neutraal');
    expect(question()).toEqual([]);
    const entry = (db.prepare('SELECT journal_entry_id AS id FROM integration_questions').get() as { id: number }).id;
    s.ledger.reverse(entry, '2026-09-15');
    expect(books()).toEqual({ omzet: 0, btw: 0, betaaldienst: 0, priveStorting: 0 });
    // de vraag staat er weer; bijwerken maakt er geen tweede van
    expect(await s.integrations.sync('mollie-facturen')).toMatchObject({ created: 0 });
    expect(question()).toHaveLength(1);
    await api.home.act(question()[0]!, 'verkoop');
    expect(question()).toEqual([]);
    expect(s.invoices.list()).toMatchObject([{ total: 1089, status: 'betaald' }]);
    expect(books()).toEqual({ omzet: 900, btw: -189, betaaldienst: 1089, priveStorting: 0 });
  });

  it('ook via de bank: zet je de bankregel terug op nieuw, dan komt de vraag terug', async () => {
    const { s, api, question, books } = withMollie();
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-09-11', amount: 1089, description: 'Betaling I-0050', counterName: 'Stichting Derdengelden Voorbeeld' }] });
    const t = s.bank.list()[0]!;
    await s.integrations.sync('mollie-facturen');
    expect(question()[0]!.question).toContain('Op je bank staat');
    await api.home.act(question()[0]!, 'neutraal');
    expect(question()).toEqual([]);
    s.bank.unmatch(t.id, '2026-09-15');
    expect(books()).toEqual({ omzet: 0, btw: 0, betaaldienst: 0, priveStorting: 0 });
    expect(question()).toHaveLength(1);
  });
});
