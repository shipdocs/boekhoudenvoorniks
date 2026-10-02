import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import { createApi, type HostContext } from '../src/main/api';
import { supplierFit } from '../src/documents/bank-purchase-match';
import { PAYMENT_PROVIDERS, paymentProviderIn } from '../src/shared/payment-providers';
import { autoAfterConfirmations } from '../src/intake/supplier-memory';
import { formatEuro } from '../src/shared/money';

/**
 * Randgevallen bij koppelen (#227): geld terug bij een creditnota van een leverancier, betaaldiensten, het
 * rekeningnummer van de leverancier, te veel betalen en een vaste last. Alle namen en bedragen zijn verzonnen.
 */

type S = ReturnType<typeof setup>['s'];
const SOFTWARE = 'WBedKanSof';
const IBAN = 'NL91ABNA0417164300';

const world = () => {
  const ctx = setup();
  ctx.s.settings.update({ onboardingDone: true });
  const api = createApi(ctx.s, { appVersion: () => '0.0.0', hasSmtpPassword: () => false } as unknown as HostContext);
  return { ...ctx, api };
};

/** Een regel op de bank, nog niet verwerkt; een bedrag boven nul is geld dat binnenkomt. */
const line = (s: S, date: string, amount: number, counterName: string, extra: { description?: string; counterIban?: string } = {}) => {
  s.bank.import({ source: 'csv', warnings: [], transactions: [{ date, amount, description: extra.description ?? `${counterName} betaling`, counterName, counterIban: extra.counterIban }] });
  return s.bank.list().find((t) => t.transaction_date === date && t.amount === amount && t.counter_name === counterName)!;
};

/** Een open aankoop zonder btw (het totaal is het bedrag); een bedrag onder nul is een creditnota. */
const buy = (s: S, name: string, date: string, amount: number, extra: { reference?: string; payeeIban?: string } = {}) =>
  s.purchases.create({ relationId: s.relations.findOrCreateSupplier(name).id, supplierReference: extra.reference ?? null, payeeIban: extra.payeeIban ?? null, invoiceDate: date, description: `Software — ${name}`, lines: [{ account: SOFTWARE, netAmount: amount, vatCode: 'geen' }] });

const bankTasks = (s: S, txId: number) => s.inbox.tasks('2026-09-28').filter((t) => t.ref.bankTransactionId === txId && t.kind.startsWith('bank-'));
const revenue = (s: S) => s.ledger.balances().filter((b) => b.category === 'omzet').reduce((sum, b) => sum + b.balance, 0);

describe('geld terug van een leverancier bij een open creditnota', () => {
  it('de vraag op Vandaag gaat over de creditnota; "Klopt" sluit hem af zonder omzet', async () => {
    const { s, api } = world();
    buy(s, 'Kantoorhal', '2026-08-20', 12000);
    const credit = buy(s, 'Kantoorhal', '2026-09-01', -5000);
    expect(credit).toMatchObject({ status: 'open', open_amount: -5000 });
    const t = line(s, '2026-09-05', 5000, 'Kantoorhal', { description: 'Terugbetaling' });
    // de terugbetaling hoort bij de creditnota, niet bij de gewone aankoop die ook open staat
    const [first, ...rest] = s.matching.suggest(t).filter((x) => x.kind === 'inkoop');
    expect(first).toMatchObject({ kind: 'inkoop', purchaseId: credit.id });
    expect(first!.reasons).toEqual(['terugbetaald bedrag klopt', 'naam van de leverancier']);
    expect(rest).toEqual([]);
    // bedrag en naam is niet genoeg om vanzelf te koppelen: eerst de vraag
    expect(s.inbox.autoProcess('2026-09-28')).toEqual({ matched: 0, booked: 0 });
    const [task] = bankTasks(s, t.id);
    expect(task).toMatchObject({ kind: 'bank-purchase', ref: { bankTransactionId: t.id, purchaseId: credit.id } });
    expect(task!.title).toBe(`${formatEuro(5000)} ontvangen van Kantoorhal`);
    expect(task!.question).toBe(`Is dit het geld terug van de creditnota van Kantoorhal van 1 september 2026 (${formatEuro(5000)})? Geld terug van een leverancier is geen omzet.`);
    expect(task!.why).toBe('Omdat terugbetaald bedrag klopt, naam van de leverancier.');
    await api.home.act(task!, 'klopt');
    expect(s.purchases.get(credit.id)).toMatchObject({ status: 'betaald', open_amount: 0, amount_paid: -5000 });
    expect(s.bank.get(t.id)).toMatchObject({ status: 'gematcht', matched_purchase_invoice_id: credit.id });
    // Bank aan Crediteuren: geen omzet, en de kosten zijn alleen door de creditnota zelf verlaagd
    expect(revenue(s)).toBe(0);
    expect(s.ledger.balance(SOFTWARE)).toBe(12000 - 5000);
    expect(s.ledger.balance(ACCOUNTS.crediteuren)).toBe(-12000);
    expect(s.ledger.balance(ACCOUNTS.bank)).toBe(5000);
  });

  it('met het nummer van de creditnota in de omschrijving koppelt de app vanzelf', () => {
    const { s } = world();
    const credit = buy(s, 'Kantoorhal', '2026-09-01', -5000, { reference: 'CN-2026-0077' });
    const t = line(s, '2026-09-05', 5000, 'Kantoorhal', { description: 'Refund CN-2026-0077' });
    expect(s.inbox.autoProcess('2026-09-28').matched).toBe(1);
    expect(s.bank.get(t.id).matched_purchase_invoice_id).toBe(credit.id);
    expect(s.purchases.get(credit.id).status).toBe('betaald');
    expect(revenue(s)).toBe(0);
  });

  it('"Nee": de app stelt de creditnota niet meer voor bij dit geld', async () => {
    const { s, api } = world();
    const credit = buy(s, 'Kantoorhal', '2026-09-01', -5000);
    const t = line(s, '2026-09-05', 5000, 'Kantoorhal');
    await api.home.act(bankTasks(s, t.id)[0]!, 'nee');
    expect(s.matching.suggest(s.bank.get(t.id)).filter((x) => x.kind === 'inkoop')).toEqual([]);
    expect(bankTasks(s, t.id)).toMatchObject([{ kind: 'bank-income' }]);
    expect(s.purchases.get(credit.id).status).toBe('open');
  });

  it('een afschrijving hoort niet bij een creditnota, en geld dat binnenkomt niet bij een gewone aankoop', () => {
    const { s } = world();
    const credit = buy(s, 'Kantoorhal', '2026-09-01', -5000, { reference: 'CN-2026-0077' });
    const purchase = buy(s, 'Printhuis', '2026-09-01', 5000, { reference: 'PH-2026-0042' });
    const out = line(s, '2026-09-05', -5000, 'Kantoorhal', { description: 'CN-2026-0077' });
    const back = line(s, '2026-09-05', 5000, 'Printhuis', { description: 'PH-2026-0042' });
    expect(s.matching.suggest(out).filter((x) => x.kind === 'inkoop').map((x) => x.kind === 'inkoop' && x.purchaseId)).not.toContain(credit.id);
    expect(s.matching.suggest(back).filter((x) => x.kind === 'inkoop')).toEqual([]);
    expect(() => s.bank.matchPurchase(out.id, credit.id)).toThrow(/creditnota/);
    expect(() => s.bank.matchPurchase(back.id, purchase.id)).toThrow(/niets betaald/);
  });

  it('een deel terug: de creditnota blijft open voor de rest', () => {
    const { s } = world();
    const credit = buy(s, 'Kantoorhal', '2026-09-01', -5000);
    const t = line(s, '2026-09-05', 2000, 'Kantoorhal');
    s.bank.matchPurchase(t.id, credit.id);
    expect(s.purchases.get(credit.id)).toMatchObject({ status: 'open', open_amount: -3000 });
    expect(s.purchases.listOpen().map((p) => p.id)).toContain(credit.id);
  });
});

describe('betaaldiensten: één lijst', () => {
  it('ook PayPal, Adyen, SumUp en Klarna, als los woord', () => {
    expect([...PAYMENT_PROVIDERS]).toEqual(expect.arrayContaining(['Mollie', 'Stripe', 'PayPal', 'Adyen', 'SumUp', 'Klarna']));
    expect(paymentProviderIn('PAYPAL *WOLKENDIENST')).toBe('PayPal');
    expect(paymentProviderIn('Stichting Mollie Payments')).toBe('Mollie');
    expect(paymentProviderIn('SumUp_payout 2026-09')).toBe('SumUp');
    expect(paymentProviderIn('Adyen N.V. batch 12')).toBe('Adyen');
    expect(paymentProviderIn('Klarna Bank AB')).toBe('Klarna');
    expect(paymentProviderIn('Stripes Kleding')).toBeNull();
    expect(paymentProviderIn('Bakkerij De Zon')).toBeNull();
    expect(paymentProviderIn(null)).toBeNull();
  });

  it('geld van een betaaldienst: het voorstel "uitbetaling", bij elke dienst uit de lijst', () => {
    const { s } = world();
    for (const [i, name] of ['PayPal Europe', 'Adyen N.V.', 'SumUp Payments', 'Klarna Bank AB', 'Stripe Technology', 'Stichting Mollie Payments'].entries()) {
      const t = line(s, `2026-09-${String(10 + i).padStart(2, '0')}`, 25000 + i, name, { description: 'Uitbetaling' });
      expect(s.matching.suggest(t).find((x) => x.kind === 'rekening' && x.account === ACCOUNTS.kruisposten)).toMatchObject({ label: 'Uitbetaling betaalprovider', reasons: [`uitbetaling ${PAYMENT_PROVIDERS.find((p) => name.includes(p))}`] });
    }
    // een afschrijving aan een betaaldienst is geen uitbetaling
    const paid = line(s, '2026-09-20', -1500, 'PayPal Europe');
    expect(s.matching.suggest(paid).find((x) => x.kind === 'rekening' && x.account === ACCOUNTS.kruisposten)).toBeUndefined();
  });

  it('staan de verkopen al in de app (via de koppeling), dan geen "weer een verkoop" met één klik bij de uitbetaling', () => {
    const { s } = world();
    const payout = (date: string, amount: number) => line(s, date, amount, 'Stichting Mollie Payments', { description: `Uitbetaling ${date}`, counterIban: 'NL13DEUT0265262461' });
    const first = payout('2026-08-12', 50000);
    s.bank.bookSale(first.id, { vatCode: 'hoog', channel: 'Mollie' });
    // zonder koppeling blijft het zoals het was: net als vorige keer
    const second = payout('2026-08-26', 30000);
    expect(s.bank.previousSale(second.id)).toMatchObject({ channel: 'Mollie' });
    expect(bankTasks(s, second.id)).toMatchObject([{ kind: 'bank-sale' }]);
    s.bank.repeatSale(second.id);
    const before = revenue(s);
    // de koppeling leest een order in: de omzet staat er nu al, het geld wacht op de tussenrekening
    const r = s.integrations.importOrders('webshop', [{ externalId: 'o-1', number: '1001', date: '2026-09-10', paid: true, currency: 'EUR', customer: { name: 'Familie Bakker', email: 'bakker@example.nl', address: 'Molenweg 2', postcode: '3511 AA', city: 'Utrecht', country: 'NL', vatNumber: null }, lines: [{ description: 'Workshop', quantity: 1, unitPriceExVat: 10000, vatPercentage: 21 }] }]);
    expect(r).toMatchObject({ created: 1, messages: [] });
    expect(s.ledger.balance(ACCOUNTS.tussenrekeningPsp)).toBe(12100);
    const third = payout('2026-09-12', 12100);
    expect(s.bank.previousSale(third.id)).toBeNull();
    expect(() => s.bank.repeatSale(third.id)).toThrow(/geen eerdere verkoop/);
    const [task] = bankTasks(s, third.id);
    expect(task).toMatchObject({ kind: 'bank-income' });
    expect(task!.question).toContain('Mollie');
    expect(task!.question).toContain('twee keer');
    expect(revenue(s)).toBe(before + -10000);
    // las de koppeling ook de uitbetaling zelf al in, dan staat het geld "onderweg": nog steeds geen nieuwe verkoop
    s.integrations.importPayouts('mollie', [{ externalId: 'po-1', date: '2026-09-12', amount: 11800, gross: 12100, feesNet: 248, feesVat: 52, currency: 'EUR', reference: 'Uitbetaling 2026-09-12' }]);
    expect(s.ledger.balance(ACCOUNTS.tussenrekeningPsp)).toBe(0);
    expect(s.ledger.balance(ACCOUNTS.kruisposten)).toBe(11800);
    expect(s.bank.previousSale(third.id)).toBeNull();
    expect(s.bank.awaitedPayout(s.bank.get(third.id))).toBe('Mollie');
    // is de uitbetaling binnen en verrekend, dan wacht er niets meer
    s.bank.bookToAccount(line(s, '2026-09-13', 11800, 'Stichting Mollie Payments', { description: 'Uitbetaling 2026-09-13', counterIban: 'NL13DEUT0265262461' }).id, { account: ACCOUNTS.kruisposten });
    expect(s.ledger.balance(ACCOUNTS.kruisposten)).toBe(0);
    expect(s.bank.awaitedPayout(s.bank.get(third.id))).toBeNull();
  });
});

describe('het rekeningnummer van de leverancier', () => {
  it('telt bij een aankoop zoals bij een factuur: bedrag en rekeningnummer rond de datum is genoeg om vanzelf te koppelen', () => {
    const { s } = world();
    const p = buy(s, 'Printhuis', '2026-09-01', 4840, { payeeIban: IBAN });
    // de bank noemt een andere naam (een stichting derdengelden), maar het rekeningnummer is dat van de factuur
    const t = line(s, '2026-09-04', -4840, 'Stichting Derdengelden Betaalhuis', { description: 'order 991', counterIban: IBAN });
    const [best] = s.matching.suggest(t);
    expect(best).toMatchObject({ kind: 'inkoop', purchaseId: p.id, score: 100 });
    expect(best!.reasons).toEqual(['bedrag klopt', 'rekeningnummer van de leverancier']);
    expect(s.inbox.autoProcess('2026-09-28').matched).toBe(1);
    expect(s.purchases.get(p.id).status).toBe('betaald');
    expect(s.ledger.balance(SOFTWARE)).toBe(4840);
    expect(s.ledger.balance(ACCOUNTS.crediteuren)).toBe(0);
  });

  it('ver van de datum van de aankoop is het rekeningnummer niet genoeg: een vraag, niet vanzelf', () => {
    const { s } = world();
    const p = buy(s, 'Printhuis', '2026-03-01', 4840, { payeeIban: IBAN });
    const t = line(s, '2026-09-04', -4840, 'Stichting Derdengelden Betaalhuis', { description: 'order 991', counterIban: IBAN });
    expect(s.matching.suggest(t)[0]).toMatchObject({ kind: 'inkoop', purchaseId: p.id, score: 70 });
    expect(s.inbox.autoProcess('2026-09-28').matched).toBe(0);
    expect(bankTasks(s, t.id)).toMatchObject([{ kind: 'bank-purchase', ref: { purchaseId: p.id }, why: 'Omdat het bedrag klopt, het rekeningnummer van de leverancier klopt.' }]);
  });

  it('alleen het rekeningnummer, een ander bedrag: geen voorstel', () => {
    const { s } = world();
    buy(s, 'Printhuis', '2026-09-01', 4840, { payeeIban: IBAN });
    const t = line(s, '2026-09-04', -9900, 'Stichting Derdengelden Betaalhuis', { description: 'order 992', counterIban: IBAN });
    expect(s.matching.suggest(t).filter((x) => x.kind === 'inkoop')).toEqual([]);
  });

  it('ook het rekeningnummer dat bij de leverancier zelf staat, en in de gedeelde vergelijking', () => {
    const { s } = world();
    const lev = s.relations.findOrCreateSupplier('Printhuis', { iban: IBAN });
    const p = s.purchases.create({ relationId: lev.id, invoiceDate: '2026-09-01', description: 'Drukwerk', lines: [{ account: SOFTWARE, netAmount: 4840, vatCode: 'geen' }] });
    const t = line(s, '2026-09-04', -4840, 'Stichting Derdengelden Betaalhuis', { description: 'order 991', counterIban: 'NL91 ABNA 0417 1643 00' });
    expect(s.matching.suggest(t)[0]).toMatchObject({ kind: 'inkoop', purchaseId: p.id, score: 100 });
    // de naam past niet, het rekeningnummer wel: sterk, dus eerst deze vraag en niet vanzelf als losse kosten
    expect(supplierFit({ ...t, counter_iban: null }, { relation_name: 'Printhuis', description: 'Drukwerk', supplier_reference: null, payee_iban: IBAN })).toBe('nee');
    expect(supplierFit(t, { relation_name: 'Printhuis', description: 'Drukwerk', supplier_reference: null, payee_iban: IBAN })).toBe('ja');
    expect(s.bookedPayments.matcher.question(t)).toMatchObject({ kind: 'open', strong: true, fit: { supplier: 'ja', purchase: { id: p.id } } });
    expect(() => s.inbox.bookBank(t.id, { account: SOFTWARE, vatCode: 'geen' })).toThrow(/Kies eerst "Ja" of "Nee, iets anders"/);
  });
});

describe('niet meer betalen dan er open staat', () => {
  it('een betaling boven het open bedrag wordt geweigerd, ook buiten de bank om', () => {
    const { s } = world();
    const p = buy(s, 'Printhuis', '2026-09-01', 10000);
    expect(() => s.purchases.registerPayment(p.id, { amount: 15000, date: '2026-09-02', moneyAccount: ACCOUNTS.kas })).toThrow(`Deze betaling is hoger dan wat er bij deze aankoop nog open staat (${formatEuro(10000)}).`);
    s.purchases.registerPayment(p.id, { amount: 6000, date: '2026-09-02', moneyAccount: ACCOUNTS.kas });
    expect(() => s.purchases.registerPayment(p.id, { amount: 5000, date: '2026-09-03', moneyAccount: ACCOUNTS.kas })).toThrow(`nog open staat (${formatEuro(4000)})`);
    expect(s.purchases.get(p.id)).toMatchObject({ status: 'open', amount_paid: 6000 });
    expect(s.ledger.balance(ACCOUNTS.crediteuren)).toBe(-4000);
    s.purchases.registerPayment(p.id, { amount: 4000, date: '2026-09-03', moneyAccount: ACCOUNTS.kas });
    expect(s.purchases.get(p.id)).toMatchObject({ status: 'betaald', open_amount: 0 });
    // en op een aankoop die al betaald is komt niets meer bij
    expect(() => s.purchases.registerPayment(p.id, { amount: 100, date: '2026-09-04', moneyAccount: ACCOUNTS.kas })).toThrow('Deze aankoop staat al op betaald');
    expect(s.ledger.balance(ACCOUNTS.crediteuren)).toBe(0);
  });

  it('er kan niet meer terugkomen dan er betaald is, en bij een creditnota niet meer dan het bedrag ervan', () => {
    const { s } = world();
    const p = buy(s, 'Printhuis', '2026-09-01', 10000);
    expect(() => s.purchases.registerPayment(p.id, { amount: -3000, date: '2026-09-02' })).toThrow(/niets betaald/);
    const credit = buy(s, 'Kantoorhal', '2026-09-01', -5000);
    expect(() => s.purchases.registerPayment(credit.id, { amount: -6000, date: '2026-09-02' })).toThrow(`hoger dan wat er bij deze creditnota nog open staat (${formatEuro(5000)})`);
    expect(() => s.purchases.registerPayment(credit.id, { amount: 1000, date: '2026-09-02' })).toThrow(/creditnota/);
    s.purchases.registerPayment(credit.id, { amount: -5000, date: '2026-09-02' });
    expect(s.purchases.get(credit.id)).toMatchObject({ status: 'betaald', open_amount: 0 });
    expect(s.ledger.balance(ACCOUNTS.crediteuren)).toBe(-10000);
  });

  it('een aankoop in een andere munt: het koersverschil is geen te hoge betaling', () => {
    const { s } = world();
    const p = s.purchases.create({ relationId: s.relations.findOrCreateSupplier('Wolkendienst Inc.').id, invoiceDate: '2026-09-01', description: 'Software — Wolkendienst Inc.', lines: [{ account: SOFTWARE, netAmount: 1577, vatCode: 'buiten-eu' }], foreign: { currency: 'USD', total: 1800, rate: 1800 / 1577 } });
    const t = line(s, '2026-09-03', -1596, 'WOLKENDIENST');
    s.bank.matchPurchase(t.id, p.id);
    expect(s.purchases.get(p.id)).toMatchObject({ status: 'betaald', open_amount: 0 });
    expect(s.ledger.balance(ACCOUNTS.koersverschillen)).toBe(19);
  });
});

describe('een vaste last gaat pas vanzelf na dezelfde drempel als elders', () => {
  const months = ['2026-06-03', '2026-07-03', '2026-08-03'];
  const series = (s: S, confirmations: number) => {
    for (let i = 0; i < confirmations; i++) s.memory.learn('Belhuis BV', { categoryKey: 'telefoon', vatCode: 'hoog', business: true });
    for (const d of months) line(s, d, -6050, 'Belhuis BV', { description: 'Abonnement', counterIban: 'NL44RABO0123456789' });
    s.inbox.autoProcess('2026-08-05');
    return s.recurring.list('voorgesteld')[0]!;
  };

  it('één keer bevestigd als telefoonkosten: de vaste last staat aan, maar boeken blijft een vraag', async () => {
    const { s, api } = world();
    const found = series(s, 1);
    const task = s.inbox.tasks('2026-08-05').find((t) => t.kind === 'recurring-confirm')!;
    await api.home.act(task, 'ja');
    expect(s.recurring.get(found.id).status).toBe('actief');
    expect(s.memory.isAutomatic(s.memory.get('Belhuis BV'))).toBe(false);
    expect(s.inbox.autoProcess('2026-08-05').booked).toBe(0);
    expect(s.bank.list({ status: 'nieuw' })).toHaveLength(3);
  });

  it('drie keer bevestigd: bevestigen zet vanzelf boeken aan', () => {
    const { s } = world();
    const found = series(s, 3);
    s.recurring.confirm(found.id);
    expect(s.memory.isAutomatic(s.memory.get('Belhuis BV'))).toBe(true);
    expect(s.inbox.autoProcess('2026-08-05').booked).toBe(3);
  });

  it('niet na een correctie, niet na "blijf het vragen", en bij "voorzichtig" nooit', () => {
    expect([autoAfterConfirmations('voorzichtig'), autoAfterConfirmations('normaal'), autoAfterConfirmations('maximaal')]).toEqual([Number.POSITIVE_INFINITY, 3, 2]);
    const corrected = world().s;
    const a = series(corrected, 3);
    corrected.db.prepare('UPDATE supplier_rules SET corrections = 1').run();
    corrected.recurring.confirm(a.id);
    expect(corrected.memory.isAutomatic(corrected.memory.get('Belhuis BV'))).toBe(false);

    const asking = world().s;
    const b = series(asking, 3);
    asking.memory.setAutomatic(asking.memory.get('Belhuis BV')!.supplier_key, false);
    asking.recurring.confirm(b.id);
    expect(asking.memory.get('Belhuis BV')!.auto_approved).toBe(-1);

    const careful = world().s;
    const c = series(careful, 3);
    careful.recurring.confirm(c.id, { autoAfter: autoAfterConfirmations('voorzichtig') });
    expect(careful.memory.get('Belhuis BV')!.auto_approved).toBe(0);
    // met twee bevestigingen: alleen bij "maximaal"
    const max = world().s;
    const d = series(max, 2);
    max.recurring.confirm(d.id);
    expect(max.memory.get('Belhuis BV')!.auto_approved).toBe(0);
    max.recurring.confirm(d.id, { autoAfter: autoAfterConfirmations('maximaal') });
    expect(max.memory.get('Belhuis BV')!.auto_approved).toBe(1);
  });
});
