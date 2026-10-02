import { describe, expect, it } from 'vitest';
import { financialSnapshot, setup } from './helpers';
import { migrations } from '../src/db/migrations';
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
    const { s, api } = world();
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
    // is de uitbetaling binnen en verrekend (de keuze "uitbetaling" op het scherm van de betaling), dan wacht er niets meer
    api.bank.bookPayout(line(s, '2026-09-13', 11800, 'Stichting Mollie Payments', { description: 'Uitbetaling 2026-09-13', counterIban: 'NL13DEUT0265262461' }).id);
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

describe('na de review: vanzelf koppelen alleen als er niets anders bij past', () => {
  const X = 'NL44RABO0123456789';

  it('een aankoop die op privé betaald staat en een open aankoop met hetzelfde bedrag en rekeningnummer: een vraag, niets vanzelf', () => {
    const { s } = world();
    const paid = buy(s, 'Wolkendienst', '2026-09-18', 2500, { payeeIban: X });
    s.quick.payPurchaseWith(paid.id, 'prive');
    const open = buy(s, 'Wolkendienst', '2026-09-20', 2500, { payeeIban: X });
    const t = line(s, '2026-09-21', -2500, 'Wolkendienst', { counterIban: X });
    // de gedeelde vergelijking ziet twee aankopen die sterk passen: de gebruiker kiest
    expect(s.bookedPayments.matcher.question(t)).toMatchObject({ kind: 'kijken', strong: true });
    expect(s.inbox.autoProcess('2026-09-28')).toEqual({ matched: 0, booked: 0 });
    expect(s.bank.get(t.id).status).toBe('nieuw');
    expect(s.purchases.get(open.id).status).toBe('open');
    const [task] = bankTasks(s, t.id);
    expect(task).toMatchObject({ kind: 'bank-purchase' });
    expect(task!.question).toContain('Er staan 2 aankopen bij Wolkendienst');
    expect(task!.actions.map((a) => a.id)).toEqual(['open', 'nee']);
  });

  it('twee afschrijvingen die bij dezelfde open aankoop passen: geen van beide vanzelf', () => {
    const { s } = world();
    const p = buy(s, 'Wolkendienst', '2026-09-01', 2500, { payeeIban: X });
    // een abonnement per maand: de factuur van augustus ontbreekt, welke betaling hoort bij die van september?
    const august = line(s, '2026-08-28', -2500, 'Wolkendienst', { counterIban: X });
    const september = line(s, '2026-09-27', -2500, 'Wolkendienst', { counterIban: X });
    expect(s.inbox.autoProcess('2026-10-05')).toEqual({ matched: 0, booked: 0 });
    expect(s.purchases.get(p.id).status).toBe('open');
    expect([august, september].map((t) => s.bank.get(t.id).status)).toEqual(['nieuw', 'nieuw']);
    const tasks = s.inbox.tasks('2026-10-05');
    for (const t of [august, september]) expect(tasks.find((x) => x.ref.bankTransactionId === t.id)).toMatchObject({ kind: 'bank-purchase', ref: { purchaseId: p.id } });
    // zegt de gebruiker bij de ene "Nee", dan is de andere de enige en koppelt de app hem alsnog zelf
    s.bookedPayments.matcher.reject({ purchaseId: p.id, bankTransactionId: september.id });
    s.inbox.answerBank(september.id, { business: true, categoryKey: 'software', vatCode: 'geen' });
    expect(s.inbox.autoProcess('2026-10-05').matched).toBe(1);
    expect(s.bank.get(august.id).matched_purchase_invoice_id).toBe(p.id);
  });

  it('het factuurnummer in de omschrijving wijst één aankoop en één betaling aan: dat gaat nog steeds vanzelf', () => {
    const { s } = world();
    const paid = buy(s, 'Wolkendienst', '2026-09-18', 2500, { reference: 'WD-2026-0911' });
    s.quick.payPurchaseWith(paid.id, 'prive');
    const open = buy(s, 'Wolkendienst', '2026-09-20', 2500, { reference: 'WD-2026-0912' });
    const other = line(s, '2026-09-19', -2500, 'Wolkendienst', { description: 'abonnement' });
    const t = line(s, '2026-09-21', -2500, 'Wolkendienst', { description: 'factuur WD-2026-0912' });
    expect(s.inbox.autoProcess('2026-09-28').matched).toBe(1);
    expect(s.bank.get(t.id).matched_purchase_invoice_id).toBe(open.id);
    expect(s.bank.get(other.id).status).toBe('nieuw');
  });
});

describe('na de review: geld terug bij een open creditnota op het scherm van de betaling', () => {
  it('een terugbetaling met een andere naam is op het bankscherm aan de creditnota te koppelen', () => {
    const { s, api } = world();
    const credit = buy(s, 'Kantoorhal', '2026-09-01', -5000);
    const t = line(s, '2026-09-05', 5000, 'Stichting Derdengelden Betaalhuis', { description: 'Refund order 88412' });
    // alleen het bedrag past: geen vraag op Vandaag en niets vanzelf
    expect(bankTasks(s, t.id)).toMatchObject([{ kind: 'bank-income' }]);
    expect(s.inbox.autoProcess('2026-09-28')).toEqual({ matched: 0, booked: 0 });
    // op het scherm van de betaling staat de creditnota wel als keuze
    expect(api.bank.creditNotes(t.id)).toEqual([{ purchaseId: credit.id, supplier: 'Kantoorhal', description: 'Software — Kantoorhal', date: '2026-09-01', open: 5000, sameAmount: true, sameSupplier: false, strong: false }]);
    api.bank.matchPurchase(t.id, credit.id);
    expect(s.purchases.get(credit.id)).toMatchObject({ status: 'betaald', open_amount: 0 });
    // de kosten zijn één keer verlaagd (door de creditnota), en er staat niets meer open bij de leverancier
    expect(s.ledger.balance(SOFTWARE)).toBe(-5000);
    expect(s.ledger.balance(ACCOUNTS.crediteuren)).toBe(0);
    expect(revenue(s)).toBe(0);
    expect(api.bank.creditNotes(t.id)).toEqual([]);
  });

  it('een deel terug van de leverancier zelf: via het scherm te koppelen, de creditnota blijft open voor de rest', () => {
    const { s, api } = world();
    const credit = buy(s, 'Kantoorhal', '2026-09-01', -5000);
    const t = line(s, '2026-09-05', 4850, 'Kantoorhal', { description: 'Terugbetaling' });
    expect(bankTasks(s, t.id)).toMatchObject([{ kind: 'bank-income' }]);
    expect(api.bank.creditNotes(t.id)).toMatchObject([{ purchaseId: credit.id, open: 5000, sameAmount: false, sameSupplier: true, strong: false }]);
    api.bank.matchPurchase(t.id, credit.id);
    expect(s.purchases.get(credit.id)).toMatchObject({ status: 'open', open_amount: -150 });
    // een afschrijving heeft geen creditnota's om uit te kiezen
    expect(api.bank.creditNotes(line(s, '2026-09-06', -150, 'Kantoorhal').id)).toEqual([]);
  });

  it('past de creditnota sterk (bedrag en leverancier), dan eerst "Ja" of "Nee" voordat het omzet of een refund kan worden', async () => {
    const { s, api } = world();
    const credit = buy(s, 'Kantoorhal', '2026-09-01', -5000);
    const t = line(s, '2026-09-05', 5000, 'Kantoorhal', { description: 'Terugbetaling' });
    expect(api.bank.creditNotes(t.id)).toMatchObject([{ purchaseId: credit.id, strong: true }]);
    const refused = /lijkt het geld terug van de creditnota van Kantoorhal van 1 september 2026 .* Kies eerst "Ja" of "Nee, iets anders"/;
    expect(() => api.bank.bookSale(t.id, { vatCode: 'hoog' })).toThrow(refused);
    expect(() => api.bank.book(t.id, { account: ACCOUNTS.omzetHoog, vatCode: 'hoog' })).toThrow(refused);
    // "Geld terug van een aankoop (refund)" op het bankscherm: de kosten zouden een tweede keer omlaag gaan
    const pick = { key: '', kind: 'bank-business' as const, icon: '', title: '', question: '', actions: [], ref: { bankTransactionId: t.id } };
    await expect(api.home.act(pick, 'zakelijk', { categoryKey: 'software', vatCode: 'geen' })).rejects.toThrow(refused);
    await expect(api.home.act(pick, 'prive')).rejects.toThrow(refused);
    expect(s.bank.get(t.id).status).toBe('nieuw');
    expect(revenue(s)).toBe(0);
    // "Nee, iets anders": daarna deelt de gebruiker het geld zelf in
    api.bank.rejectPurchases(t.id);
    expect(api.bank.creditNotes(t.id)).toMatchObject([{ purchaseId: credit.id, strong: false }]);
    api.bank.bookSale(t.id, { vatCode: 'hoog' });
    expect(s.bank.get(t.id).status).toBe('gematcht');
    expect(s.purchases.get(credit.id).status).toBe('open');
  });

  it('"Ja" bij een sterk passende creditnota koppelt het geld zonder omzet', () => {
    const { s, api } = world();
    const credit = buy(s, 'Kantoorhal', '2026-09-01', -5000, { payeeIban: IBAN });
    // een andere naam op het afschrift, maar het rekeningnummer van de creditnota
    const t = line(s, '2026-09-05', 5000, 'Stichting Derdengelden Betaalhuis', { counterIban: IBAN });
    expect(api.bank.creditNotes(t.id)).toMatchObject([{ purchaseId: credit.id, sameSupplier: true, strong: true }]);
    api.bank.matchPurchase(t.id, credit.id);
    expect(s.purchases.get(credit.id).status).toBe('betaald');
    expect(revenue(s)).toBe(0);
  });
});

describe('na de review: de uitbetaling van een betaaldienst op het scherm van de betaling', () => {
  it('wachten er verkopen op hun geld, dan is er de keuze "uitbetaling": geen nieuwe verkoop', () => {
    const { s, api } = world();
    const payout = (date: string, amount: number) => line(s, date, amount, 'Stichting Mollie Payments', { description: `Uitbetaling ${date}`, counterIban: 'NL13DEUT0265262461' });
    // zonder verkopen in de app is geld van een betaaldienst gewoon een verkoop via een ander systeem
    const loose = payout('2026-09-01', 30000);
    expect(api.bank.awaitedPayout(loose.id)).toBeNull();
    expect(() => api.bank.bookPayout(loose.id)).toThrow(/geen verkopen/);
    api.bank.bookSale(loose.id, { vatCode: 'hoog', channel: 'Mollie' });
    const before = revenue(s);
    s.integrations.importOrders('webshop', [{ externalId: 'o-1', number: '1001', date: '2026-09-10', paid: true, currency: 'EUR', customer: { name: 'Familie Bakker', email: 'bakker@example.nl', address: 'Molenweg 2', postcode: '3511 AA', city: 'Utrecht', country: 'NL', vatNumber: null }, lines: [{ description: 'Workshop', quantity: 1, unitPriceExVat: 10000, vatPercentage: 21 }] }]);
    s.integrations.importPayouts('mollie', [{ externalId: 'po-1', date: '2026-09-12', amount: 11800, gross: 12100, feesNet: 248, feesVat: 52, currency: 'EUR', reference: 'Uitbetaling 2026-09-12' }]);
    const t = payout('2026-09-12', 11800);
    expect(api.bank.awaitedPayout(t.id)).toBe('Mollie');
    api.bank.bookPayout(t.id);
    expect(s.bank.get(t.id).status).toBe('gematcht');
    // het geld dat onderweg was is binnen: geen tweede keer omzet
    expect(s.ledger.balance(ACCOUNTS.kruisposten)).toBe(0);
    expect(revenue(s)).toBe(before + -10000);
    // een afschrijving aan een betaaldienst is geen uitbetaling
    expect(api.bank.awaitedPayout(line(s, '2026-09-20', -1500, 'Stichting Mollie Payments').id)).toBeNull();
  });
});

describe('na de review: creditnota\'s uit een eerdere versie', () => {
  it('een creditnota die na een aanpassing op "betaald" kwam te staan terwijl er niets terugkwam, staat weer open', () => {
    const { db, s } = world();
    const credit = buy(s, 'Kantoorhal', '2026-09-01', -5000);
    const part = buy(s, 'Printhuis', '2026-09-01', -8000);
    s.purchases.registerPayment(part.id, { amount: -3000, date: '2026-09-02' });
    const done = buy(s, 'Belhuis', '2026-09-01', -2000);
    s.purchases.registerPayment(done.id, { amount: -2000, date: '2026-09-02' });
    const purchase = buy(s, 'Wolkendienst', '2026-09-01', 4000);
    s.purchases.registerPayment(purchase.id, { amount: 4000, date: '2026-09-02', moneyAccount: ACCOUNTS.kas });
    // zo schreef de vorige versie het weg: bij een bedrag onder nul was "betaald >= totaal" altijd waar
    db.prepare(`UPDATE purchase_invoices SET status = 'betaald' WHERE id IN (?, ?)`).run(credit.id, part.id);
    const index = migrations.findIndex((m) => m.includes(`SET status = 'open' WHERE total < 0`));
    expect(index).toBeGreaterThan(0);
    db.pragma(`user_version = ${index}`);
    const before = financialSnapshot({ db, s });
    const after = setup({ db }).s;
    expect(db.pragma('user_version', { simple: true })).toBe(migrations.length);
    expect(after.purchases.get(credit.id)).toMatchObject({ status: 'open', open_amount: -5000 });
    expect(after.purchases.get(part.id)).toMatchObject({ status: 'open', open_amount: -5000 });
    // wat echt afgehandeld is, blijft zo; de boekingen veranderen niet
    expect(after.purchases.get(done.id).status).toBe('betaald');
    expect(after.purchases.get(purchase.id).status).toBe('betaald');
    const snapshot = financialSnapshot({ db, s: after });
    expect({ ...snapshot, purchase_invoices: null }).toEqual({ ...before, purchase_invoices: null });
    // de terugbetaling vindt de creditnota nu wel
    after.settings.update({ onboardingDone: true });
    const t = line(after, '2026-09-05', 5000, 'Kantoorhal', { description: 'Terugbetaling' });
    expect(bankTasks(after, t.id)).toMatchObject([{ kind: 'bank-purchase', ref: { purchaseId: credit.id } }]);
  });
});

describe('na de review: de uitleg bij "Ja, vaste last" zegt wat er gebeurt', () => {
  const months = ['2026-06-03', '2026-07-03', '2026-08-03'];
  const series = (s: S, confirmations: number) => {
    for (let i = 0; i < confirmations; i++) s.memory.learn('Belhuis BV', { categoryKey: 'telefoon', vatCode: 'hoog', business: true });
    for (const d of months) line(s, d, -6050, 'Belhuis BV', { description: 'Abonnement', counterIban: 'NL44RABO0123456789' });
    s.inbox.autoProcess('2026-08-05');
    return s.inbox.tasks('2026-08-05').find((t) => t.kind === 'recurring-confirm')!;
  };

  it('gaat vanzelf boeken aan, dan staat dat in de uitleg en in het logboek', async () => {
    const { s, api } = world();
    const task = series(s, 3);
    const hint = task.actions.find((a) => a.id === 'ja')!.hint!;
    expect(hint).toBe('De app let voortaan op of de factuur en de betaling elke keer binnenkomen, en boekt betalingen aan Belhuis BV voortaan zelf als telefoon & internet: zo heb je ze al 3 keer ingedeeld. Je ziet ze bij "Automatisch gedaan" en kunt ze altijd terugdraaien.');
    await api.home.act(task, 'ja');
    expect(s.bank.list({ status: 'nieuw' })).toHaveLength(0);
    const log = s.inbox.home('2026-08-05').automated.filter((a) => a.kind === 'bank-auto');
    expect(log).toHaveLength(3);
    for (const entry of log) {
      expect(entry.reason).toContain('als vaste last hebt bevestigd');
      expect(entry.reason).not.toContain('automatisch mag');
    }
  });

  it('blijft boeken een vraag, dan wordt er niets extra geboekt', async () => {
    const { s, api } = world();
    const task = series(s, 1);
    expect(task.actions.find((a) => a.id === 'ja')!.hint).toBe('De app let voortaan op of de factuur en de betaling elke keer binnenkomen. Er wordt niets extra geboekt.');
    await api.home.act(task, 'ja');
    expect(s.bank.list({ status: 'nieuw' })).toHaveLength(3);
  });

  it('zei de gebruiker zelf "voortaan automatisch", dan staat dat in het logboek', () => {
    const { s } = world();
    for (let i = 0; i < 3; i++) s.memory.learn('Belhuis BV', { categoryKey: 'telefoon', vatCode: 'hoog', business: true });
    s.memory.setAutomatic(s.memory.get('Belhuis BV')!.supplier_key, true);
    line(s, '2026-08-03', -6050, 'Belhuis BV', { description: 'Abonnement' });
    expect(s.inbox.autoProcess('2026-08-05').booked).toBe(1);
    expect(s.inbox.home('2026-08-05').automated.find((a) => a.kind === 'bank-auto')!.reason).toContain('hebt gezegd dat dit voortaan automatisch mag');
  });
});
