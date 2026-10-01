import { describe, expect, it } from 'vitest';
import { financialSnapshot, setup } from './helpers';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import { createApi, type HostContext } from '../src/main/api';
import { amountFit, dateFits, fitOf, sameSupplierName, supplierFit, type Debit, type PurchaseProbe } from '../src/documents/bank-purchase-match';
import type { DocumentResult } from '../src/intake/types';
import type { OcrProvider } from '../src/intake/ocr';
import { ValidationError } from '../src/shared/validation';
import { formatEuro } from '../src/shared/money';

/**
 * Bank tegenover aankoop (#221): één vergelijking voor vanzelf boeken, zelf indelen, de vraag op Vandaag
 * en de dubbel-controle. Alle leveranciers en bedragen zijn verzonnen.
 */

type S = ReturnType<typeof setup>['s'];
const SOFTWARE = 'WBedKanSof';

const world = () => {
  const ctx = setup();
  ctx.s.settings.update({ onboardingDone: true });
  const api = createApi(ctx.s, { appVersion: () => '0.0.0', hasSmtpPassword: () => false } as unknown as HostContext);
  return { ...ctx, api };
};

/** Een leverancier die de gebruiker vaak genoeg bevestigde en die voortaan vanzelf mag. */
const autoRule = (s: S, name: string) => {
  for (let i = 0; i < 3; i++) s.memory.learn(name, { categoryKey: 'software', vatCode: 'geen', business: true });
  s.memory.setAutomatic(s.memory.get(name)!.supplier_key, true);
};

/** Een afschrijving, nog niet verwerkt. */
const debit = (s: S, date: string, amount: number, counterName: string, description = `${counterName} betaling`) => {
  s.bank.import({ source: 'csv', warnings: [], transactions: [{ date, amount: -amount, description, counterName }] });
  return s.bank.list().find((t) => t.transaction_date === date && t.amount === -amount && t.counter_name === counterName)!;
};

/** Een open aankoop in euro's (zonder btw, zodat het totaal het bedrag is). */
const buy = (s: S, name: string, date: string, amount: number, extra: { reference?: string; dueDate?: string } = {}) =>
  s.purchases.create({ relationId: s.relations.findOrCreateSupplier(name).id, supplierReference: extra.reference ?? null, invoiceDate: date, dueDate: extra.dueDate ?? null, description: `Software — ${name}`, lines: [{ account: SOFTWARE, netAmount: amount, vatCode: 'geen' }] });

/** Een open aankoop in dollars: $ 18,00, geschat op € 15,77. */
const buyUsd = (s: S, name: string, date: string) =>
  s.purchases.create({ relationId: s.relations.findOrCreateSupplier(name).id, invoiceDate: date, description: `Software — ${name}`, lines: [{ account: SOFTWARE, netAmount: 1577, vatCode: 'buiten-eu' }], foreign: { currency: 'USD', total: 1800, rate: 1800 / 1577 } });

const bankTasks = (s: S, txId: number) => s.inbox.tasks('2026-09-28').filter((t) => t.ref.bankTransactionId === txId && t.kind.startsWith('bank-'));
const status = (s: S, txId: number) => s.bank.get(txId).status;

const probe = (p: Partial<PurchaseProbe>): PurchaseProbe => ({
  id: 1, relation_id: null, relation_name: 'Wolkendienst Inc.', description: 'Software — Wolkendienst Inc.', invoice_date: '2026-08-01', due_date: null, total: 1577, amount_paid: 0,
  currency: null, foreign_total: null, status: 'open', supplier_reference: null, is_opening: 0, question: false, ...p,
});
const line = (t: Partial<Debit>): Debit => ({ amount: -1577, transaction_date: '2026-08-03', counter_name: 'WOLKENDIENST', description: 'WOLKENDIENST abonnement', reference: null, ...t });

describe('de regels van de vergelijking', () => {
  it('bedrag: gelijk, binnen de koers, ongeveer in euro\'s, of niet', () => {
    expect(amountFit(1577, 1577, null)).toBe('gelijk');
    expect(amountFit(1577, 1577, 'USD')).toBe('gelijk');
    expect(amountFit(1596, 1577, 'USD')).toBe('koers');
    // in euro's is 19 cent verschil alleen "ongeveer": nooit met één klik
    expect(amountFit(1596, 1577, null)).toBe('ongeveer');
    expect(amountFit(1596, 1577, 'EUR')).toBe('ongeveer');
    expect(amountFit(1700, 1577, 'USD')).toBeNull();
    expect(amountFit(1700, 1577, null)).toBeNull();
    // van een deels betaalde aankoop telt wat er nog open staat
    const half = probe({ total: 10000, amount_paid: 6000 });
    expect(fitOf(line({ amount: -4000 }), half, 'open')?.amount).toBe('gelijk');
    expect(fitOf(line({ amount: -10000 }), half, 'open')).toBeNull();
  });

  it('leverancier: schrijfwijzen, een voorvoegsel van de kaart, het factuurnummer; geen algemene woorden', () => {
    expect(sameSupplierName('Wolkendienst Inc.', 'WOLKENDIENST')).toBe(true);
    expect(sameSupplierName('wolkendienst.io', 'Wolkendienst IO')).toBe(true);
    expect(sameSupplierName('De Hamer', 'De Kwast')).toBe(false);
    expect(sameSupplierName('Studio Noord', 'Studio Zuid')).toBe(false);
    const printhuis = { relation_name: 'Printhuis', description: 'Drukwerk', supplier_reference: 'PH-2026-0042' };
    expect(supplierFit(line({ counter_name: 'Card Payment: Printhuis', description: 'kaartbetaling' }), printhuis)).toBe('ja');
    expect(supplierFit(line({ counter_name: null, description: 'PRINTHUIS UTRECHT pas 123' }), printhuis)).toBe('ja');
    expect(supplierFit(line({ counter_name: 'Betaaldienst Snelpay', description: 'Factuur PH-2026-0042' }), printhuis)).toBe('ja');
    expect(supplierFit(line({ counter_name: 'Betaaldienst Snelpay', description: 'order 991' }), printhuis)).toBe('nee');
    expect(supplierFit(line({ counter_name: null, description: 'pinbetaling' }), printhuis)).toBe('onbekend');
    expect(supplierFit(line({}), { relation_name: null, description: 'Kantoorspullen', supplier_reference: null })).toBe('onbekend');
    // zonder relatie: de naam achter het streepje in de omschrijving
    expect(supplierFit(line({}), { relation_name: null, description: 'Software — Wolkendienst', supplier_reference: null })).toBe('ja');
  });

  it('datum: tien dagen ervoor tot twintig erna, of tot veertien dagen na de vervaldatum', () => {
    const p = { invoice_date: '2026-08-11', due_date: null };
    expect(dateFits(p, '2026-08-01')).toBe(true);
    expect(dateFits(p, '2026-07-31')).toBe(false);
    expect(dateFits(p, '2026-08-31')).toBe(true);
    expect(dateFits(p, '2026-09-01')).toBe(false);
    const late = { invoice_date: '2026-08-11', due_date: '2026-09-10' };
    expect(dateFits(late, '2026-09-24')).toBe(true);
    expect(dateFits(late, '2026-09-25')).toBe(false);
    // het factuurnummer in de omschrijving: de datum op de bon mag verkeerd gelezen zijn
    const misread = probe({ invoice_date: '2026-12-08', supplier_reference: 'WD-2026-0042', currency: 'USD' });
    expect(fitOf(line({ amount: -1596, description: 'WOLKENDIENST WD-2026-0042' }), misread, 'open')).toMatchObject({ strength: 'sterk', inWindow: true });
    expect(fitOf(line({ amount: -1596 }), misread, 'open')).toMatchObject({ strength: 'zwak', inWindow: false });
  });

  it('sterkte: alles past = sterk; een open aankoop met hetzelfde bedrag is altijd minstens zwak', () => {
    expect(fitOf(line({}), probe({}), 'open')).toMatchObject({ amount: 'gelijk', supplier: 'ja', strength: 'sterk' });
    expect(fitOf(line({ amount: -1596 }), probe({ currency: 'USD' }), 'open')).toMatchObject({ amount: 'koers', strength: 'sterk' });
    expect(fitOf(line({ counter_name: 'Betaaldienst Snelpay', description: 'order 12' }), probe({}), 'open')).toMatchObject({ supplier: 'nee', strength: 'zwak' });
    expect(fitOf(line({ amount: -1596, counter_name: 'Betaaldienst Snelpay', description: 'order 12' }), probe({ currency: 'USD' }), 'open')).toBeNull();
    expect(fitOf(line({ amount: -1596, counter_name: null, description: 'kaartbetaling' }), probe({ currency: 'USD' }), 'open')).toMatchObject({ supplier: 'onbekend', strength: 'zwak' });
    expect(fitOf(line({ amount: -1596 }), probe({}), 'open')).toMatchObject({ amount: 'ongeveer', strength: 'zwak' });
    // al privé of contant betaald: alleen als alles past
    expect(fitOf(line({}), probe({ status: 'betaald', amount_paid: 1577 }), 'elders')).toMatchObject({ strength: 'sterk' });
    expect(fitOf(line({ counter_name: null, description: 'pinbetaling' }), probe({ status: 'betaald', amount_paid: 1577 }), 'elders')).toBeNull();
    // een bijschrijving of creditnota doet niet mee
    expect(fitOf(line({ amount: 1577 }), probe({}), 'open')).toBeNull();
    expect(fitOf(line({ amount: 1577 }), probe({ total: -1577 }), 'open')).toBeNull();
  });
});

describe('vanzelf boeken: nooit losse kosten naast een aankoop die er al staat', () => {
  it('euro\'s, open aankoop met hetzelfde bedrag: niet geboekt, wel de vraag of ze bij elkaar horen', () => {
    const { s } = world();
    autoRule(s, 'WOLKENDIENST');
    const p = buy(s, 'Wolkendienst Inc.', '2026-09-01', 1500);
    const t = debit(s, '2026-09-03', 1500, 'WOLKENDIENST');
    expect(s.inbox.autoProcess('2026-09-28')).toEqual({ matched: 0, booked: 0 });
    expect(status(s, t.id)).toBe('nieuw');
    const [task] = bankTasks(s, t.id);
    expect(task).toMatchObject({ kind: 'bank-purchase', ref: { bankTransactionId: t.id, purchaseId: p.id }, group: { key: 'bank-purchase' } });
    expect(task!.actions.map((a) => a.id)).toEqual(['klopt', 'nee']);
    expect(task!.question).toBe(`Hoort dit bij de aankoop bij Wolkendienst Inc. van 1 september 2026 (${formatEuro(1500)})?`);
    expect(task!.why).toBe('Omdat het bedrag klopt, de naam van de leverancier past.');
  });

  it('aankoop in dollars en een afschrijving met een andere koers: niet geboekt; "Klopt" koppelt en boekt het koersverschil', async () => {
    const { s, api } = world();
    autoRule(s, 'WOLKENDIENST');
    const p = buyUsd(s, 'Wolkendienst Inc.', '2026-08-01');
    const t = debit(s, '2026-08-14', 1596, 'WOLKENDIENST');
    expect(s.inbox.autoProcess('2026-09-28')).toEqual({ matched: 0, booked: 0 });
    expect(status(s, t.id)).toBe('nieuw');
    const [task] = bankTasks(s, t.id);
    expect(task).toMatchObject({ kind: 'bank-purchase', ref: { purchaseId: p.id } });
    expect(task!.question).toBe(`Hoort dit bij de aankoop bij Wolkendienst Inc. van 1 augustus 2026 (${formatEuro(1577)}, $ 18,00)? De bank schreef ${formatEuro(1596)} af: een andere koers dan geschat. Het verschil van ${formatEuro(19)} boekt de app als koersverschil.`);
    await api.home.act(task!, 'klopt');
    expect(s.bank.get(t.id)).toMatchObject({ status: 'gematcht', matched_purchase_invoice_id: p.id });
    expect(s.purchases.get(p.id)).toMatchObject({ status: 'betaald', open_amount: 0 });
    expect(s.ledger.balance(ACCOUNTS.crediteuren)).toBe(0);
    expect(s.ledger.balance(ACCOUNTS.koersverschillen)).toBe(19);
    expect(s.ledger.balance(SOFTWARE)).toBe(1577); // de kosten één keer
  });

  it('deels betaalde aankoop en de restbetaling: niet geboekt', () => {
    const { s } = world();
    autoRule(s, 'Kantoorhal');
    const p = buy(s, 'Kantoorhal', '2026-09-01', 10000);
    s.purchases.registerPayment(p.id, { amount: 6000, date: '2026-09-02', moneyAccount: ACCOUNTS.kas });
    const t = debit(s, '2026-09-05', 4000, 'Kantoorhal');
    s.inbox.autoProcess('2026-09-28');
    expect(status(s, t.id)).toBe('nieuw');
    expect(bankTasks(s, t.id)[0]).toMatchObject({ kind: 'bank-purchase', ref: { purchaseId: p.id } });
  });

  it('een andere naam op het afschrift (betaaldienst) en precies het bedrag: niet geboekt, één vraag', () => {
    const { s } = world();
    autoRule(s, 'Betaaldienst Snelpay');
    const p = buy(s, 'Printhuis', '2026-09-03', 4840);
    const t = debit(s, '2026-09-04', 4840, 'Betaaldienst Snelpay', 'order 991');
    s.inbox.autoProcess('2026-09-28');
    expect(status(s, t.id)).toBe('nieuw');
    const [task] = bankTasks(s, t.id);
    expect(task).toMatchObject({ kind: 'bank-purchase', ref: { purchaseId: p.id } });
    expect(task!.actions.map((a) => a.id)).toEqual(['klopt', 'nee']);
    expect(task!.why).toBe('Omdat het bedrag klopt.');
  });

  it('zonder aankoop die erbij past: de leveranciersregel boekt gewoon', () => {
    const { s } = world();
    autoRule(s, 'WOLKENDIENST');
    buy(s, 'Printhuis', '2026-09-03', 4840);
    const t = debit(s, '2026-09-03', 1500, 'WOLKENDIENST');
    expect(s.inbox.autoProcess('2026-09-28')).toEqual({ matched: 0, booked: 1 });
    expect(status(s, t.id)).toBe('gematcht');
    expect(s.ledger.balance(SOFTWARE)).toBe(4840 + 1500);
  });

  it('een bon wacht nog op controle en heeft deze betaling als voorstel: niet geboekt', async () => {
    const lines = ['Kantoorhal', 'Datum: 10-09-2026', 'Ordners 100,00', 'BTW 21% 100,00 21,00', 'Totaal 121,00'];
    const ocr: OcrProvider = { id: 'test', label: 'Test OCR', available: async () => true, recognize: async () => ({ items: lines.map((text, i) => ({ text, page: 1, bbox: [10, 20 + i * 20, 300, 34 + i * 20] as [number, number, number, number], confidence: 0.97 })) }) };
    const ctx = setup({ ocr });
    const { s } = ctx;
    s.settings.update({ onboardingDone: true });
    autoRule(s, 'Snelpay Kassa');
    const d = await s.intake.add('bon.jpg', new Uint8Array([7]), '2026-09-10');
    const t = debit(s, '2026-09-11', 12100, 'Snelpay Kassa');
    expect(s.intake.get(d.id)).toMatchObject({ status: 'controle', bank_match: { id: t.id } });
    const before = financialSnapshot(ctx);
    expect(s.inbox.autoProcess('2026-09-28')).toEqual({ matched: 0, booked: 0 });
    expect(financialSnapshot(ctx)).toEqual(before);
  });
});

describe('de vraag bij een nieuwe afschrijving', () => {
  it('twee open aankopen met hetzelfde bedrag: alleen "Bekijken"; op het bankscherm kies je de aankoop', async () => {
    const { s, api } = world();
    const a = buy(s, 'Bouwmarkt De Hamer', '2026-09-01', 4840);
    const b = buy(s, 'Bouwmarkt De Hamer', '2026-09-03', 4840);
    const t = debit(s, '2026-09-04', 4840, 'Bouwmarkt De Hamer');
    s.inbox.autoProcess('2026-09-28');
    const [task] = bankTasks(s, t.id);
    expect(task).toMatchObject({ kind: 'bank-purchase', ref: { bankTransactionId: t.id } });
    expect(task!.group).toBeUndefined();
    expect(task!.actions.map((x) => x.id)).toEqual(['open', 'nee']);
    expect(task!.question).toBe(`Er staan 2 open aankopen bij Bouwmarkt De Hamer van ${formatEuro(4840)}. Bij welke hoort deze betaling?`);
    expect(await api.home.act(task!, 'open')).toEqual({ navigate: { screen: 'betaling', id: t.id } });
    const q = api.bank.purchaseQuestion(t.id)!;
    expect(q).toMatchObject({ strong: true, oneClick: false });
    expect(q.candidates.map((c) => c.purchaseId)).toEqual([b.id, a.id]); // de dichtstbijzijnde datum eerst
    api.bank.linkPurchase(t.id, a.id);
    expect(s.purchases.get(a.id).status).toBe('betaald');
    expect(s.purchases.get(b.id).status).toBe('open');
    expect(s.bank.get(t.id)).toMatchObject({ status: 'gematcht', matched_purchase_invoice_id: a.id });
    expect(s.ledger.balance(ACCOUNTS.crediteuren)).toBe(-4840);
    expect(s.ledger.balance(SOFTWARE)).toBe(2 * 4840);
  });

  it('bedrag in euro\'s dat net niet klopt: alleen "Bekijken", en koppelen met één klik kan niet', () => {
    const { s, api } = world();
    const p = buy(s, 'Printhuis', '2026-09-03', 4840);
    const t = debit(s, '2026-09-04', 4790, 'Printhuis');
    const [task] = bankTasks(s, t.id);
    expect(task!.actions.map((x) => x.id)).toEqual(['open', 'nee']);
    expect(task!.question).toBe(`Er staat nog een open aankoop bij Printhuis van 3 september 2026 van ${formatEuro(4840)}. Deze betaling is ${formatEuro(4790)}. Hoort die erbij?`);
    expect(api.bank.purchaseQuestion(t.id)).toMatchObject({ strong: false, oneClick: false, candidates: [{ purchaseId: p.id, amountFit: 'ongeveer' }] });
    expect(() => api.bank.linkPurchase(t.id, p.id)).toThrow(ValidationError);
    expect(status(s, t.id)).toBe('nieuw');
  });

  it('"Nee": het paar komt niet meer terug, ook niet als voorstel, en daarna mag de leveranciersregel boeken', async () => {
    const { s, api } = world();
    autoRule(s, 'WOLKENDIENST');
    const p = buy(s, 'Wolkendienst Inc.', '2026-09-01', 1500);
    const t = debit(s, '2026-09-03', 1500, 'WOLKENDIENST');
    s.inbox.autoProcess('2026-09-28');
    const [task] = bankTasks(s, t.id);
    expect(s.matching.suggest(s.bank.get(t.id)).some((x) => x.kind === 'inkoop')).toBe(true);
    expect(await api.home.act(task!, 'nee')).toEqual({ navigate: { screen: 'betaling', id: t.id } });
    expect(s.bookedPayments.matcher.rejected({ purchaseId: p.id, bankTransactionId: t.id })).toBe(true);
    expect(bankTasks(s, t.id).map((x) => x.kind)).toEqual(['bank-category']);
    expect(s.matching.suggest(s.bank.get(t.id)).some((x) => x.kind === 'inkoop')).toBe(false);
    expect(api.bank.purchaseQuestion(t.id)).toBeNull();
    expect(s.inbox.autoProcess('2026-09-28')).toEqual({ matched: 0, booked: 1 });
    expect(status(s, t.id)).toBe('gematcht');
    expect(s.purchases.get(p.id).status).toBe('open');
  });

  it('een "nee" van vóór deze versie (op de vraag "staat deze aankoop dubbel?") geldt nog', () => {
    const { s } = world();
    autoRule(s, 'WOLKENDIENST');
    const p = buy(s, 'Wolkendienst Inc.', '2026-09-01', 1500);
    const t = debit(s, '2026-09-03', 1500, 'WOLKENDIENST');
    s.inbox.skipTask(`dubbel-${p.id}-${t.id}`, 'nee');
    expect(s.bookedPayments.matcher.question(s.bank.get(t.id))).toBeNull();
    expect(s.inbox.autoProcess('2026-09-28')).toEqual({ matched: 0, booked: 1 });
  });

  it('zelf indelen terwijl er een aankoop sterk bij past: eerst kiezen; na "Nee" kan het', async () => {
    const ctx = world();
    const { s, api } = ctx;
    buy(s, 'Wolkendienst Inc.', '2026-09-01', 1500);
    const t = debit(s, '2026-09-03', 1500, 'WOLKENDIENST');
    const before = financialSnapshot(ctx);
    const melding = `Deze betaling lijkt bij de aankoop bij Wolkendienst Inc. van 1 september 2026 (${formatEuro(1500)}) te horen. Kies eerst "Ja" of "Nee, iets anders"; anders tellen de kosten twee keer.`;
    expect(() => s.inbox.answerBank(t.id, { business: true, categoryKey: 'software', vatCode: 'geen' })).toThrow(melding);
    expect(() => s.inbox.answerBank(t.id, { business: false })).toThrow(ValidationError);
    expect(() => s.inbox.bookBank(t.id, { account: ACCOUNTS.vraagposten, vatCode: 'geen' })).toThrow(ValidationError);
    expect(() => api.bank.book(t.id, { account: SOFTWARE, vatCode: 'geen' })).toThrow(melding);
    expect(financialSnapshot(ctx)).toEqual(before);
    expect(s.memory.get('WOLKENDIENST')).toBeNull(); // er is ook niets geleerd
    api.bank.rejectPurchases(t.id);
    s.inbox.answerBank(t.id, { business: true, categoryKey: 'software', vatCode: 'geen' });
    expect(status(s, t.id)).toBe('gematcht');
  });

  it('zelf indelen bij een zwakke kandidaat (andere naam, zelfde bedrag): geen blokkade', () => {
    const { s, api } = world();
    buy(s, 'Printhuis', '2026-09-03', 4840);
    const t = debit(s, '2026-09-04', 4840, 'Betaaldienst Snelpay', 'order 991');
    expect(api.bank.purchaseQuestion(t.id)).toMatchObject({ strong: false, oneClick: true });
    expect(api.bank.book(t.id, { account: SOFTWARE, vatCode: 'geen' })).toEqual(expect.any(Number));
    expect(status(s, t.id)).toBe('gematcht');
  });
});

describe('open aankoop naast een betaling die al als kosten geboekt is', () => {
  /** De bon is een aankoop geworden; de afschrijving is daarna los als kosten geboekt (zoals de leveranciersregel deed). */
  const double = async () => {
    const ctx = world();
    const { s } = ctx;
    const d = await s.intake.add('wolkendienst.jpg', new Uint8Array([3]), '2026-08-01');
    s.intake.confirm(d.id, { supplier: 'Wolkendienst Inc.', date: '2026-08-01', total: 1500, categoryKey: 'software', vatCode: 'geen', business: true, paidWith: 'later' });
    const p = s.purchases.get(s.intake.get(d.id).purchase_invoice_id!);
    const t = debit(s, '2026-08-14', 1500, 'WOLKENDIENST');
    s.bank.bookToAccount(t.id, { account: SOFTWARE, vatCode: 'geen' });
    return { ...ctx, d, p, t };
  };

  it('wordt een vraag, nooit vanzelf; "ja" laat de aankoop vervallen en maakt de bon het bewijs bij de betaling', async () => {
    const { s, api, d, p, t } = await double();
    expect(s.ledger.balance(SOFTWARE)).toBe(3000); // dubbel
    expect(s.bookedPayments.candidates()).toMatchObject([{ purchase: { id: p.id }, bankTransaction: { id: t.id }, certain: false, state: 'open', booking: 'kosten' }]);
    s.inbox.autoProcess('2026-09-28');
    expect(s.ledger.balance(SOFTWARE)).toBe(3000);
    const [task] = s.inbox.tasks('2026-09-28').filter((x) => x.kind === 'purchase-double');
    expect(task).toMatchObject({ key: `dubbel-${p.id}-${t.id}`, ref: { purchaseId: p.id, bankTransactionId: t.id } });
    expect(task!.question).toBe(`De bon van 1 augustus 2026 (${formatEuro(1500)}) staat nog open. Op ${s.bank.ensureDefaultAccount().name} staat op 14 augustus 2026 ook ${formatEuro(1500)} aan WOLKENDIENST, al geboekt als kosten. Is dat dezelfde betaling?`);
    expect(task!.actions.find((a) => a.id === 'ja')!.hint).toBe('De aankoop vervalt en de bon wordt het bewijsstuk bij de betaling op je rekening. Kosten en btw blijven zoals ze bij de betaling geboekt zijn.');
    await api.home.act(task!, 'ja');
    expect(s.purchases.list()).toEqual([]);
    expect(s.ledger.balance(SOFTWARE)).toBe(1500);
    expect(s.ledger.balance(ACCOUNTS.crediteuren)).toBe(0);
    expect(s.intake.get(d.id)).toMatchObject({ link: { target: { kind: 'bank', id: t.id } } });
    expect(s.inbox.tasks('2026-09-28').filter((x) => x.kind === 'purchase-double')).toEqual([]);
  });

  it('"nee" laat alles staan en de vraag komt niet terug', async () => {
    const ctx = await double();
    const { s, api, p } = ctx;
    const before = financialSnapshot(ctx);
    const [task] = s.inbox.tasks('2026-09-28').filter((x) => x.kind === 'purchase-double');
    await api.home.act(task!, 'nee');
    expect(financialSnapshot(ctx)).toEqual(before);
    expect(s.purchases.get(p.id).status).toBe('open');
    expect(s.bookedPayments.candidates()).toEqual([]);
    expect(s.inbox.tasks('2026-09-28').filter((x) => x.kind === 'purchase-double')).toEqual([]);
  });
});

describe('"Ja, dezelfde betaling": wat er geboekt wordt', () => {
  it('aankoop op privé betaald gezet en daarna toch de afschrijving: niet vanzelf en niet los als kosten; ja draait de privébetaling terug en koppelt', () => {
    const ctx = world();
    const { s, api } = ctx;
    autoRule(s, 'WOLKENDIENST');
    const p = buy(s, 'Wolkendienst Inc.', '2026-09-01', 1500);
    s.quick.payPurchaseWith(p.id, 'prive');
    expect(s.ledger.balance(ACCOUNTS.priveStortingen)).toBe(-1500);
    const t = debit(s, '2026-09-03', 1500, 'WOLKENDIENST');
    expect(s.inbox.autoProcess('2026-09-28')).toEqual({ matched: 0, booked: 0 });
    const [task] = bankTasks(s, t.id);
    expect(task).toMatchObject({ kind: 'bank-purchase', ref: { bankTransactionId: t.id, purchaseId: p.id } });
    expect(task!.actions.map((a) => a.id)).toEqual(['open', 'nee']);
    expect(task!.question).toBe(`De aankoop bij Wolkendienst Inc. van 1 september 2026 (${formatEuro(1500)}) staat op betaald met privégeld. Is dit dezelfde betaling? Verwerk je deze betaling als zakelijk, dan tellen de kosten en de btw twee keer.`);
    const before = financialSnapshot(ctx);
    expect(() => s.inbox.answerBank(t.id, { business: true, categoryKey: 'software', vatCode: 'geen' })).toThrow(ValidationError);
    expect(financialSnapshot(ctx)).toEqual(before);
    expect(api.bank.purchaseQuestion(t.id)).toMatchObject({ strong: true, oneClick: true, candidates: [{ purchaseId: p.id, state: 'elders', via: 'prive' }] });
    api.bank.linkPurchase(t.id, p.id);
    expect(s.bank.get(t.id)).toMatchObject({ status: 'gematcht', matched_purchase_invoice_id: p.id });
    expect(s.purchases.get(p.id)).toMatchObject({ status: 'betaald', open_amount: 0 });
    expect(s.ledger.balance(ACCOUNTS.priveStortingen)).toBe(0);
    expect(s.ledger.balance(ACCOUNTS.crediteuren)).toBe(0);
    expect(s.ledger.balance(SOFTWARE)).toBe(1500);
  });

  it('aankoop en betaling stonden allebei los op "weet ik nog niet": ja koppelt de betaling, het bedrag staat er nog één keer', async () => {
    const { s, api } = world();
    const p = s.purchases.create({ relationId: s.relations.findOrCreateSupplier('Printhuis').id, invoiceDate: '2026-09-03', description: 'Nog uitzoeken — Printhuis', lines: [{ account: ACCOUNTS.vraagposten, netAmount: 4840, vatCode: 'geen' }] });
    const t = debit(s, '2026-09-04', 4840, 'Printhuis');
    s.bank.bookToAccount(t.id, { account: ACCOUNTS.vraagposten, vatCode: 'geen' });
    expect(s.ledger.balance(ACCOUNTS.vraagposten)).toBe(2 * 4840);
    expect(s.bookedPayments.candidates()).toMatchObject([{ purchase: { id: p.id }, bankTransaction: { id: t.id }, certain: false, state: 'open', booking: 'vraag' }]);
    const [task] = s.inbox.tasks('2026-09-28').filter((x) => x.kind === 'purchase-double');
    expect(task!.question).toContain('al verwerkt als "weet ik nog niet". Is dat dezelfde betaling?');
    expect(task!.actions.find((a) => a.id === 'ja')!.hint).toBe('De betaling wordt aan de aankoop gekoppeld; die staat daarna als betaald. De losse post op "weet ik nog niet" vervalt.');
    await api.home.act(task!, 'ja');
    expect(s.ledger.balance(ACCOUNTS.vraagposten)).toBe(4840);
    expect(s.ledger.balance(ACCOUNTS.crediteuren)).toBe(0);
    expect(s.purchases.get(p.id)).toMatchObject({ status: 'betaald', open_amount: 0 });
    expect(s.bank.get(t.id)).toMatchObject({ status: 'gematcht', matched_purchase_invoice_id: p.id });
    expect(s.bookedPayments.candidates()).toEqual([]);
  });

  it('de betaling is intussen anders verwerkt: er wordt niets geboekt', () => {
    const ctx = world();
    const { s, api } = ctx;
    const p = buy(s, 'Wolkendienst Inc.', '2026-09-01', 1500);
    const t = debit(s, '2026-09-03', 1500, 'WOLKENDIENST');
    s.bank.bookToAccount(t.id, { account: ACCOUNTS.priveOpnamen });
    const before = financialSnapshot(ctx);
    expect(() => api.bank.linkPurchase(t.id, p.id)).toThrow(/intussen anders verwerkt/);
    expect(financialSnapshot(ctx)).toEqual(before);
  });
});

describe('een bon tegenover een nog niet verwerkte afschrijving (findBankMatch)', () => {
  const bon = (date: string, supplier: string | null): DocumentResult => ({ total: { value: 4840, confidence: 1, source: 'handmatig' }, invoiceDate: { value: date, confidence: 1, source: 'handmatig' }, supplier: supplier ? { value: supplier, confidence: 1, source: 'handmatig' } : null, supplierIban: null }) as unknown as DocumentResult;

  it('vijftien dagen later betaald: met de naam van de leverancier wel, zonder naam niet; binnen tien dagen altijd', () => {
    const { s } = world();
    const t = debit(s, '2026-09-18', 4840, 'Printhuis');
    expect(s.intake.findBankMatch(bon('2026-09-03', 'Printhuis'))?.id).toBe(t.id);
    expect(s.intake.findBankMatch(bon('2026-09-03', null))).toBeNull();
    expect(s.intake.findBankMatch(bon('2026-09-03', 'Kantoorhal'))).toBeNull();
    expect(s.intake.findBankMatch(bon('2026-09-08', null))?.id).toBe(t.id);
    expect(s.intake.findBankMatch(bon('2026-09-28', null))?.id).toBe(t.id);
    expect(s.intake.findBankMatch(bon('2026-09-29', 'Printhuis'))).toBeNull(); // meer dan tien dagen vóór de bon betaald
  });
});
