import { describe, expect, it } from 'vitest';
import { financialSnapshot, setup } from './helpers';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import { createApi, type HostContext } from '../src/main/api';
import { paidWithNote, proposedPaidWith } from '../src/shared/paid-with';
import { formatEuro } from '../src/shared/money';
import { ValidationError } from '../src/shared/validation';
import type { OcrProvider } from '../src/intake/ocr';

type S = ReturnType<typeof setup>['s'];

const buy = (s: S, relationId: number, date: string) =>
  s.purchases.create({ relationId, invoiceDate: date, description: 'Overige kosten — DigiBoox', lines: [{ account: ACCOUNTS.inkoopMaterialen, netAmount: 1600, vatCode: 'hoog' }] });

/** Een factuur in dollars ($ 19,00, geschat € 16,66), zoals van Moonshot via Stripe. */
const buyUsd = (s: S, name: string, date: string) =>
  s.purchases.create({ relationId: s.relations.findOrCreateSupplier(name).id, invoiceDate: date, description: `Software — ${name}`, lines: [{ account: 'WBedKanSof', netAmount: 1666, vatCode: 'buiten-eu' }], foreign: { currency: 'USD', total: 1900, rate: 1900 / 1666 } });

/** De afschrijving op een eigen rekening (bv. Revolut), al rechtstreeks als kosten geboekt. */
function bookedDebit(s: S, name: string, date: string, amount: number): number {
  s.bank.import({ source: 'csv', warnings: [], transactions: [{ date, amount: -amount, description: `${name.toUpperCase()} USD 19,00`, counterName: name }] });
  const t = s.bank.list({ status: 'nieuw' }).find((x) => x.counter_name === name)!;
  s.bank.bookToAccount(t.id, { account: 'WBedKanSof', vatCode: 'buiten-eu' });
  return t.id;
}

const software = (s: S) => s.ledger.balance('WBedKanSof');

describe('rekening privé betaald (privérekening, telefoonrekening)', () => {
  it('één rekening: Crediteuren aan Privé-stortingen, kosten en btw blijven staan', () => {
    const { s } = setup();
    const lev = s.relations.findOrCreateSupplier('Google');
    const p = buy(s, lev.id, '2026-09-27');
    const { paid: [paid], skipped } = s.quick.payPurchaseWith(p.id, 'prive');
    expect(skipped).toEqual([]);
    expect(paid).toMatchObject({ status: 'betaald', open_amount: 0 });
    expect(s.ledger.balance(ACCOUNTS.crediteuren)).toBe(0);
    expect(s.ledger.balance(ACCOUNTS.priveStortingen)).toBe(-p.total);
    expect(s.ledger.balance(ACCOUNTS.bank)).toBe(0);
    expect(s.relations.get(lev.id).paid_with).toBeNull();
    expect(() => s.quick.payPurchaseWith(p.id, 'prive')).toThrow(/al op betaald/);
  });

  it('voortaan altijd: ook de andere open rekeningen, en nieuwe bonnen staan meteen op betaald', async () => {
    const { s } = setup();
    const lev = s.relations.findOrCreateSupplier('DigiBoox');
    const andere = s.relations.findOrCreateSupplier('Bouwmaat');
    const a = buy(s, lev.id, '2026-08-19');
    const b = buy(s, lev.id, '2026-09-19');
    const c = buy(s, andere.id, '2026-09-19');
    const { paid } = s.quick.payPurchaseWith(b.id, 'prive', { always: true });
    expect(paid.map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
    expect(s.purchases.get(a.id).status).toBe('betaald');
    expect(s.purchases.get(c.id).status).toBe('open');
    expect(s.relations.get(lev.id).paid_with).toBe('prive');

    const d = await s.intake.add('digiboox-okt.jpg', new Uint8Array([1]), '2026-10-19');
    s.intake.confirm(d.id, { supplier: 'DigiBoox', date: '2026-10-19', total: 1936, categoryKey: 'materiaal', vatCode: 'hoog', business: true, paidWith: 'later' });
    const nieuw = s.purchases.get(s.intake.get(d.id).purchase_invoice_id!);
    expect(nieuw).toMatchObject({ status: 'betaald', open_amount: 0 });
    expect(s.ledger.balance(ACCOUNTS.priveStortingen)).toBe(-(a.total + b.total + 1936));
  });
});

describe('betaling al geboekt op een eigen rekening (gemengde rekening zoals Revolut)', () => {
  it('"Al betaald" vraagt eerst: ja = de aankoop vervalt, niet privé en niet voortaan privé', () => {
    const { s } = setup();
    const txId = bookedDebit(s, 'Moonshot AI', '2026-07-20', 1728);
    const p = buyUsd(s, 'Moonshot AI', '2026-07-15');
    const before = software(s);
    expect(s.bookedPayments.find(p)?.id).toBe(txId);
    s.bookedPayments.resolve(p.id, txId, p.invoice_date);
    expect(s.purchases.list().find((x) => x.id === p.id)).toBeUndefined();
    expect(software(s)).toBe(before - 1666); // alleen de afschrijving telt nog
    expect(s.ledger.balance(ACCOUNTS.priveStortingen)).toBe(0);
    expect(s.ledger.balance(ACCOUNTS.crediteuren)).toBe(0);
    expect(s.relations.get(p.relation_id!).paid_with).toBeNull();
  });

  it('voortaan altijd: een andere open rekening waarvan de betaling al op de bank staat, blijft open', () => {
    const { s } = setup();
    const txId = bookedDebit(s, 'Vercel', '2026-08-09', 1675);
    const aug = buyUsd(s, 'Vercel', '2026-08-05');
    const sep = buyUsd(s, 'Vercel', '2026-09-05');
    const r = s.quick.payPurchaseWith(sep.id, 'prive', { always: true });
    expect(r.paid.map((x) => x.id)).toEqual([sep.id]);
    expect(r.skipped.map((x) => x.id)).toEqual([aug.id]);
    expect(s.purchases.get(aug.id).status).toBe('open');
    expect(s.relations.get(sep.relation_id!).paid_with).toBeNull();
    expect(s.bookedPayments.find(s.purchases.get(aug.id))?.id).toBe(txId);
  });

  it('zeker dubbel (0.6.4: voortaan privé, en toch op de bank als kosten): de app herstelt het vanzelf', () => {
    const { s } = setup();
    const p = buyUsd(s, 'Render', '2026-05-05');
    s.quick.payPurchaseWith(p.id, 'prive', { always: true });
    const txId = bookedDebit(s, 'Render', '2026-05-07', 1675);
    const onlyBank = software(s) - 1666;
    s.inbox.autoProcess('2026-09-28');
    expect(s.purchases.list().find((x) => x.id === p.id)).toBeUndefined();
    expect(software(s)).toBe(onlyBank);
    expect(s.ledger.balance(ACCOUNTS.priveStortingen)).toBe(0);
    expect(s.ledger.balance(ACCOUNTS.crediteuren)).toBe(0);
    expect(s.relations.get(p.relation_id!).paid_with).toBeNull();
    const log = s.db.prepare(`SELECT * FROM automation_log WHERE kind = 'dubbel-weg'`).all() as { ref_id: number; summary: string }[];
    expect(log).toEqual([expect.objectContaining({ ref_id: txId, summary: expect.stringMatching(/Render .* dubbel/) })]);
    s.inbox.autoProcess('2026-09-28');
    expect(s.db.prepare(`SELECT COUNT(*) AS n FROM automation_log WHERE kind = 'dubbel-weg'`).get()).toEqual({ n: 1 });
    expect(s.inbox.tasks('2026-09-28').filter((t) => t.kind === 'purchase-double')).toEqual([]);
  });

  it('niet zeker (privé betaald zonder "voortaan privé"): niets vanzelf, wel een vraag; "nee" laat alles staan', () => {
    const { s } = setup();
    const p = buyUsd(s, 'Hetzner', '2026-06-01');
    s.quick.payPurchaseWith(p.id, 'prive');
    const txId = bookedDebit(s, 'Hetzner', '2026-06-03', 1675);
    s.inbox.autoProcess('2026-09-28');
    expect(s.purchases.get(p.id).status).toBe('betaald');
    const [task] = s.inbox.tasks('2026-09-28').filter((t) => t.kind === 'purchase-double');
    expect(task).toMatchObject({ ref: { purchaseId: p.id, bankTransactionId: txId }, actions: [expect.objectContaining({ id: 'ja' }), expect.objectContaining({ id: 'nee' })] });
    s.inbox.skipTask(task!.key, 'nee');
    expect(s.inbox.tasks('2026-09-28').filter((t) => t.kind === 'purchase-double')).toEqual([]);
    expect(s.purchases.get(p.id).status).toBe('betaald');
  });

  it('contant bij Gamma en een dag later hetzelfde bedrag gepind: nooit vanzelf weg, ook niet met voortaan contant', () => {
    const { s } = setup();
    const lev = s.relations.findOrCreateSupplier('Gamma');
    const p = s.purchases.create({ relationId: lev.id, invoiceDate: '2026-09-10', description: 'Materiaal — Gamma', lines: [{ account: ACCOUNTS.inkoopMaterialen, netAmount: 4132, vatCode: 'hoog', vatAmount: 868 }] });
    s.quick.payPurchaseWith(p.id, 'kas', { always: true });
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-09-11', amount: -5000, description: 'GAMMA UTRECHT', counterName: 'Gamma' }] });
    s.bank.bookToAccount(s.bank.list({ status: 'nieuw' })[0]!.id, { account: ACCOUNTS.inkoopMaterialen, vatCode: 'hoog' });
    s.inbox.autoProcess('2026-09-28');
    expect(s.purchases.get(p.id).status).toBe('betaald');
    expect(s.inbox.tasks('2026-09-28').filter((t) => t.kind === 'purchase-double')).toHaveLength(1);
  });

  it('voortaan privé, maar in dezelfde dagen staan twee afschrijvingen van dat bedrag als kosten: niet vanzelf, wel een vraag (#221)', () => {
    const { s } = setup();
    const lev = s.relations.findOrCreateSupplier('Kantoorhal');
    const p = s.purchases.create({ relationId: lev.id, invoiceDate: '2026-09-10', description: 'Kantoor — Kantoorhal', lines: [{ account: 'WBedKanKan', netAmount: 2500, vatCode: 'geen' }] });
    s.quick.payPurchaseWith(p.id, 'prive', { always: true });
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-09-11', amount: -2500, description: 'KANTOORHAL UTRECHT', counterName: 'Kantoorhal' }, { date: '2026-09-12', amount: -2500, description: 'pinbetaling 991', counterName: 'Snelpay Kassa' }] });
    for (const t of s.bank.list({ status: 'nieuw' })) s.bank.bookToAccount(t.id, { account: 'WBedKanKan', vatCode: 'geen' });
    const kantoorhal = s.bank.list().find((t) => t.counter_name === 'Kantoorhal')!;
    s.inbox.autoProcess('2026-09-28');
    expect(s.purchases.get(p.id).status).toBe('betaald');
    expect(s.relations.get(lev.id).paid_with).toBe('prive');
    expect(s.bookedPayments.candidates()).toMatchObject([{ purchase: { id: p.id }, bankTransaction: { id: kantoorhal.id }, certain: false, state: 'elders', booking: 'kosten' }]);
    expect(s.inbox.tasks('2026-09-28').filter((t) => t.kind === 'purchase-double')).toHaveLength(1);
  });

  it('een privé-opname met hetzelfde bedrag telt niet als "al geboekt"', () => {
    const { s } = setup();
    const lev = s.relations.findOrCreateSupplier('Google');
    const p = s.purchases.create({ relationId: lev.id, invoiceDate: '2026-09-27', description: 'Software — Google', lines: [{ account: 'WBedKanSof', netAmount: 826, vatCode: 'hoog', vatAmount: 173 }] });
    s.quick.payPurchaseWith(p.id, 'prive', { always: true });
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-09-27', amount: -999, description: 'GOOGLE PLAY', counterName: 'Google' }] });
    s.bank.bookToAccount(s.bank.list({ status: 'nieuw' })[0]!.id, { account: ACCOUNTS.priveOpnamen });
    expect(s.bookedPayments.find(s.purchases.get(p.id))).toBeNull();
    s.inbox.autoProcess('2026-09-28');
    expect(s.purchases.get(p.id).status).toBe('betaald');
    expect(s.relations.get(lev.id).paid_with).toBe('prive');
  });

  it('laat staan wat echt privé betaald is: geen afschrijving op een eigen rekening', () => {
    const { s } = setup();
    const p = buyUsd(s, 'Cloudflare', '2026-09-02');
    s.quick.payPurchaseWith(p.id, 'prive', { always: true });
    bookedDebit(s, 'Vercel', '2026-09-04', 1675); // andere leverancier
    s.inbox.autoProcess('2026-09-28');
    expect(s.purchases.get(p.id).status).toBe('betaald');
    expect(s.relations.get(p.relation_id!).paid_with).toBe('prive');
  });
});

describe('één afschrijving, meer aankopen die erbij passen (#221)', () => {
  const doubles = (s: S) => s.inbox.tasks('2026-09-28').filter((t) => t.kind === 'purchase-double');

  it('twee aankopen met hetzelfde bedrag en één afschrijving: nooit vanzelf samen, en "ja" kan maar bij één van de twee', () => {
    const { s } = setup();
    const lev = s.relations.findOrCreateSupplier('Parkeerhuis');
    const park = (date: string) => s.purchases.create({ relationId: lev.id, invoiceDate: date, description: 'Parkeren — Parkeerhuis', lines: [{ account: 'WBedKanKan', netAmount: 1000, vatCode: 'geen' }] });
    const a = park('2026-09-01');
    const b = park('2026-09-03');
    s.quick.payPurchaseWith(a.id, 'prive', { always: true });
    expect(s.purchases.get(b.id).status).toBe('betaald');
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-09-02', amount: -1000, description: 'PARKEERHUIS UTRECHT', counterName: 'Parkeerhuis' }] });
    const t = s.bank.list({ status: 'nieuw' })[0]!;
    s.bank.bookToAccount(t.id, { account: 'WBedKanKan', vatCode: 'geen' });
    expect(s.ledger.balance('WBedKanKan')).toBe(3000);
    expect(s.bookedPayments.candidates().map((c) => [c.purchase.id, c.bankTransaction.id, c.certain])).toEqual([[a.id, t.id, false], [b.id, t.id, false]]);
    expect(s.inbox.autoProcess('2026-09-28')).toEqual({ matched: 0, booked: 0 });
    expect(s.purchases.list()).toHaveLength(2);
    expect(s.ledger.balance('WBedKanKan')).toBe(3000);
    expect(doubles(s)).toHaveLength(2);
    // "ja" bij de eerste: die vervalt; de tweede is een echte aankoop en blijft staan
    s.bookedPayments.resolve(a.id, t.id, a.invoice_date);
    expect(s.ledger.balance('WBedKanKan')).toBe(2000);
    expect(doubles(s)).toEqual([]);
    expect(s.bookedPayments.find(s.purchases.get(b.id))).toBeNull();
    expect(() => s.bookedPayments.resolve(b.id, t.id, b.invoice_date)).toThrow('Bij deze betaling hoort al een andere aankoop of een bon. Eén betaling kan niet bij twee aankopen horen.');
    expect(s.purchases.get(b.id).status).toBe('betaald');
    expect(s.ledger.balance('WBedKanKan')).toBe(2000);
    // een andere categorie voor de betaling verandert daar niets aan
    s.bank.reclassify(t.id, { account: 'WBedKanSof', vatCode: 'geen' });
    expect(s.bookedPayments.candidates()).toEqual([]);
    // de verwerking ongedaan gemaakt en opnieuw geboekt: een nieuwe boeking, de vraag komt terug
    s.bank.unmatch(t.id, '2026-09-28');
    s.bank.bookToAccount(t.id, { account: 'WBedKanKan', vatCode: 'geen' });
    expect(s.bookedPayments.candidates()).toMatchObject([{ purchase: { id: b.id }, bankTransaction: { id: t.id } }]);
  });

  it('voortaan privé, en van die leverancier staan twee afschrijvingen van dat bedrag als kosten (elke week): niet vanzelf, wel een vraag', () => {
    const { s } = setup();
    const lev = s.relations.findOrCreateSupplier('Kantoorhal');
    const p = s.purchases.create({ relationId: lev.id, invoiceDate: '2026-09-10', description: 'Kantoor — Kantoorhal', lines: [{ account: 'WBedKanKan', netAmount: 2500, vatCode: 'geen' }] });
    s.quick.payPurchaseWith(p.id, 'prive', { always: true });
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-09-04', amount: -2500, description: 'KANTOORHAL UTRECHT week 36', counterName: 'Kantoorhal' }, { date: '2026-09-11', amount: -2500, description: 'KANTOORHAL UTRECHT week 37', counterName: 'Kantoorhal' }] });
    for (const t of s.bank.list({ status: 'nieuw' })) s.bank.bookToAccount(t.id, { account: 'WBedKanKan', vatCode: 'geen' });
    const second = s.bank.list().find((t) => t.transaction_date === '2026-09-11')!;
    expect(s.inbox.autoProcess('2026-09-28')).toEqual({ matched: 0, booked: 0 });
    expect(s.purchases.get(p.id).status).toBe('betaald');
    expect(s.bookedPayments.candidates()).toMatchObject([{ purchase: { id: p.id }, bankTransaction: { id: second.id }, certain: false }]);
    expect(doubles(s)).toHaveLength(1);
  });
});

describe('privé of contant betaald, en daarna staat de afschrijving toch op je rekening (#222)', () => {
  const world = () => {
    const ctx = setup();
    ctx.s.settings.update({ onboardingDone: true });
    const api = createApi(ctx.s, { appVersion: () => '0.0.0', hasSmtpPassword: () => false } as unknown as HostContext);
    return { ...ctx, api };
  };
  /** Een open aankoop in euro's, zonder btw (het totaal is het bedrag). */
  const order = (s: S, name: string, date: string, amount: number) =>
    s.purchases.create({ relationId: s.relations.findOrCreateSupplier(name).id, invoiceDate: date, description: `Software — ${name}`, lines: [{ account: 'WBedKanSof', netAmount: amount, vatCode: 'geen' }] });
  /** Een afschrijving, nog niet verwerkt. */
  const debit = (s: S, date: string, amount: number, counterName: string) => {
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date, amount: -amount, description: `${counterName} betaling`, counterName }] });
    return s.bank.list().find((t) => t.transaction_date === date && t.amount === -amount && t.counter_name === counterName)!;
  };
  /** De leverancier mag voortaan vanzelf als kosten geboekt worden. */
  const autoRule = (s: S, name: string) => {
    for (let i = 0; i < 3; i++) s.memory.learn(name, { categoryKey: 'software', vatCode: 'geen', business: true });
    s.memory.setAutomatic(s.memory.get(name)!.supplier_key, true);
  };
  const bankTasks = (s: S, txId: number) => s.inbox.tasks('2026-09-28').filter((t) => t.ref.bankTransactionId === txId && t.kind.startsWith('bank-'));
  const WHY = 'Omdat het bedrag, de naam en de datum bij elkaar passen. Verwerk je deze betaling als zakelijk, dan tellen de kosten en de btw twee keer.';

  it('privé betaald, daarna de afschrijving: eerst de vraag; "ja" koppelt de betaling en draait de privébetaling terug', async () => {
    const ctx = world();
    const { s, api } = ctx;
    const p = order(s, 'Wolkendienst', '2026-09-01', 1500);
    s.quick.payPurchaseWith(p.id, 'prive');
    const t = debit(s, '2026-09-03', 1500, 'WOLKENDIENST');
    expect(s.inbox.autoProcess('2026-09-28')).toEqual({ matched: 0, booked: 0 });
    const tasks = bankTasks(s, t.id);
    expect(tasks).toHaveLength(1);
    const task = tasks[0]!;
    expect(task).toMatchObject({ key: `bank-${t.id}`, kind: 'bank-purchase-paid', priority: 1, amount: -1500, ref: { bankTransactionId: t.id, purchaseId: p.id } });
    expect(task.title).toBe(`${formatEuro(1500)} betaald aan WOLKENDIENST: dezelfde betaling als je bon?`);
    expect(task.question).toBe(`De aankoop bij Wolkendienst van 1 september 2026 (${formatEuro(1500)}) staat op betaald met privégeld. Op Zakelijke rekening staat op 3 september 2026 ${formatEuro(1500)} aan WOLKENDIENST, nog niet verwerkt. Is dat dezelfde betaling?`);
    expect(task.why).toBe(WHY);
    expect(task.group).toBeUndefined();
    expect(task.actions.map((a) => [a.id, a.label, a.primary ?? false])).toEqual([['ja', 'Ja, dezelfde betaling', true], ['nee', 'Nee, iets anders', false], ['open', 'Bekijken', false]]);
    expect(task.actions[0]!.hint).toBe('De betaling op je rekening wordt aan de aankoop gekoppeld en de betaling met privégeld wordt teruggedraaid. Kosten en btw tellen één keer.');
    expect(task.actions[1]!.hint).toBe('Er verandert niets aan de aankoop. Je deelt deze betaling daarna zelf in; de app vraagt dit niet meer.');
    // de betaling is nog niet verwerkt: dat telt mee in "Ben ik bij?"
    expect(s.inbox.home('2026-09-28').checklist.find((c) => c.label === 'Alle betalingen verwerkt')).toMatchObject({ ok: false });
    // "Bekijken" gaat naar de betaling zelf
    expect(await api.home.act(task, 'open')).toEqual({ navigate: { screen: 'betaling', id: t.id } });
    // zakelijk of privé kiezen zonder antwoord kan niet: anders tellen de kosten twee keer
    const before = financialSnapshot(ctx);
    expect(() => s.inbox.answerBank(t.id, { business: true, categoryKey: 'software', vatCode: 'geen' })).toThrow(ValidationError);
    expect(() => api.bank.book(t.id, { account: 'WBedKanSof', vatCode: 'geen' })).toThrow(/Kies eerst "Ja" of "Nee, iets anders"/);
    expect(financialSnapshot(ctx)).toEqual(before);

    await api.home.act(task, 'ja');
    expect(s.bank.get(t.id)).toMatchObject({ status: 'gematcht', matched_purchase_invoice_id: p.id });
    expect(s.purchases.get(p.id)).toMatchObject({ status: 'betaald', open_amount: 0 });
    expect(s.ledger.balance(ACCOUNTS.priveStortingen)).toBe(0);
    expect(s.ledger.balance(ACCOUNTS.crediteuren)).toBe(0);
    expect(s.ledger.balance(ACCOUNTS.bank)).toBe(-1500);
    expect(s.ledger.balance('WBedKanSof')).toBe(1500); // de kosten één keer
    expect(bankTasks(s, t.id)).toEqual([]);
    expect(s.bookedPayments.candidates()).toEqual([]);
  });

  it('"voortaan privé" bij die leverancier: de leveranciersregel boekt de afschrijving niet vanzelf; na "ja" staat voortaan privé uit', async () => {
    const { s, api } = world();
    autoRule(s, 'WOLKENDIENST');
    const p = order(s, 'Wolkendienst', '2026-09-01', 1500);
    s.quick.payPurchaseWith(p.id, 'prive', { always: true });
    expect(s.relations.get(p.relation_id!).paid_with).toBe('prive');
    const t = debit(s, '2026-09-03', 1500, 'WOLKENDIENST');
    expect(s.inbox.autoProcess('2026-09-28')).toEqual({ matched: 0, booked: 0 });
    expect(s.bank.get(t.id).status).toBe('nieuw');
    const [task] = bankTasks(s, t.id);
    expect(task).toMatchObject({ kind: 'bank-purchase-paid' });
    expect(task!.question).toMatch(/Is dat dezelfde betaling\? Je hebt bij Wolkendienst "voortaan privé" aangezet\.$/);
    expect(task!.actions[0]!.hint).toBe('De betaling op je rekening wordt aan de aankoop gekoppeld en de betaling met privégeld wordt teruggedraaid. Kosten en btw tellen één keer. "Voortaan privé" gaat uit voor Wolkendienst.');
    await api.home.act(task!, 'ja');
    expect(s.relations.get(p.relation_id!).paid_with).toBeNull();
    expect(s.bank.get(t.id).matched_purchase_invoice_id).toBe(p.id);
    expect(s.ledger.balance(ACCOUNTS.priveStortingen)).toBe(0);
    expect(s.ledger.balance(ACCOUNTS.crediteuren)).toBe(0);
    expect(s.ledger.balance('WBedKanSof')).toBe(1500);
  });

  it('in dollars, en de bank rekende een andere koers: "ja" boekt het koersverschil', async () => {
    const { s, api } = world();
    const p = buyUsd(s, 'Wolkendienst', '2026-08-01');
    s.quick.payPurchaseWith(p.id, 'prive');
    const t = debit(s, '2026-08-14', 1675, 'WOLKENDIENST');
    expect(s.inbox.autoProcess('2026-09-28')).toEqual({ matched: 0, booked: 0 });
    const [task] = bankTasks(s, t.id);
    expect(task).toMatchObject({ kind: 'bank-purchase-paid', ref: { purchaseId: p.id } });
    expect(task!.question).toBe(`De aankoop bij Wolkendienst van 1 augustus 2026 (${formatEuro(1666)}) staat op betaald met privégeld. Op Zakelijke rekening staat op 14 augustus 2026 ${formatEuro(1675)} aan WOLKENDIENST, nog niet verwerkt. Is dat dezelfde betaling?`);
    await api.home.act(task!, 'ja');
    expect(s.purchases.get(p.id)).toMatchObject({ status: 'betaald', open_amount: 0 });
    expect(s.ledger.balance(ACCOUNTS.priveStortingen)).toBe(0);
    expect(s.ledger.balance(ACCOUNTS.crediteuren)).toBe(0);
    expect(s.ledger.balance(ACCOUNTS.koersverschillen)).toBe(9);
    expect(s.ledger.balance(ACCOUNTS.bank)).toBe(-1675);
    expect(software(s)).toBe(1666);
  });

  it('in euro\'s privé betaald en de afschrijving is een paar cent anders, met de leveranciersregel aan: niet vanzelf als kosten, wel een vraag', async () => {
    const ctx = world();
    const { s, api } = ctx;
    autoRule(s, 'WOLKENDIENST');
    // met de hand in euro's ingevoerd (geen vreemde munt), terwijl de bank later een eigen koers rekende
    const p = order(s, 'Wolkendienst', '2026-09-01', 1577);
    s.quick.payPurchaseWith(p.id, 'prive', { always: true });
    const t = debit(s, '2026-09-03', 1596, 'WOLKENDIENST');
    const before = financialSnapshot(ctx);
    expect(s.inbox.autoProcess('2026-09-28')).toEqual({ matched: 0, booked: 0 });
    expect(financialSnapshot(ctx)).toEqual(before);
    expect(s.bank.get(t.id).status).toBe('nieuw');
    expect(software(s)).toBe(1577);
    const tasks = bankTasks(s, t.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ kind: 'bank-purchase', ref: { bankTransactionId: t.id, purchaseId: p.id } });
    expect(tasks[0]!.question).toBe(`De aankoop bij Wolkendienst van 1 september 2026 (${formatEuro(1577)}) staat op betaald met privégeld. Deze betaling is ${formatEuro(1596)}. Is dat dezelfde betaling?`);
    expect(tasks[0]!.actions.map((a) => [a.id, a.primary ?? false])).toEqual([['open', true], ['nee', false]]);
    expect(tasks[0]!.group).toBeUndefined();
    // op het bankscherm staat de aankoop erbij, zonder "Ja": het bedrag is anders
    expect(api.bank.purchaseQuestion(t.id)).toMatchObject({ strong: false, oneClick: false, candidates: [{ purchaseId: p.id, state: 'elders', via: 'prive', amountFit: 'ongeveer' }] });
    expect(() => api.bank.linkPurchase(t.id, p.id)).toThrow(/Het bedrag van deze betaling is anders dan dat van de aankoop/);
    expect(financialSnapshot(ctx)).toEqual(before);
    // "Nee, iets anders": een andere uitgave; daarna geldt de leveranciersregel weer
    await api.home.act(tasks[0]!, 'nee');
    expect(s.inbox.autoProcess('2026-09-28')).toEqual({ matched: 0, booked: 1 });
    expect(software(s)).toBe(1577 + 1596);
    expect(s.purchases.get(p.id).status).toBe('betaald');

    // een andere leverancier met bijna dat bedrag, of ver buiten de datum: geen vraag
    const other = world();
    const q = order(other.s, 'Wolkendienst', '2026-09-01', 1577);
    other.s.quick.payPurchaseWith(q.id, 'prive');
    const elders = debit(other.s, '2026-09-03', 1596, 'Printhuis');
    const laat = debit(other.s, '2026-11-20', 1596, 'WOLKENDIENST');
    expect(other.api.bank.purchaseQuestion(elders.id)).toBeNull();
    expect(other.api.bank.purchaseQuestion(laat.id)).toBeNull();
  });

  it('contant betaald en hetzelfde bedrag gepind: de vraag zonder voorkeur; "ja" draait de kasbetaling terug', async () => {
    const { s, api } = world();
    const p = order(s, 'Bouwmarkt De Hamer', '2026-09-10', 4840);
    s.quick.payPurchaseWith(p.id, 'kas');
    expect(s.ledger.balance(ACCOUNTS.kas)).toBe(-4840);
    const t = debit(s, '2026-09-11', 4840, 'Bouwmarkt De Hamer');
    s.inbox.autoProcess('2026-09-28');
    const [task] = bankTasks(s, t.id);
    expect(task).toMatchObject({ kind: 'bank-purchase-paid' });
    expect(task!.question).toContain('staat op contant betaald. ');
    // contant staat niet op de bank: het kunnen net zo goed twee aankopen zijn, dus geen voorgestelde keuze
    expect(task!.actions.filter((a) => a.primary)).toEqual([]);
    expect(task!.actions[0]!.hint).toBe('De betaling op je rekening wordt aan de aankoop gekoppeld en de contante betaling wordt teruggedraaid. Kosten en btw tellen één keer.');
    await api.home.act(task!, 'ja');
    expect(s.ledger.balance(ACCOUNTS.kas)).toBe(0);
    expect(s.ledger.balance(ACCOUNTS.crediteuren)).toBe(0);
    expect(s.bank.get(t.id).matched_purchase_invoice_id).toBe(p.id);
    expect(s.ledger.balance('WBedKanSof')).toBe(4840);
  });

  it('de afschrijving staat vóór de privébetaling (in december van je rekening, de factuur is van januari): de privébetaling gaat terug op haar eigen datum', async () => {
    const { s, api } = world();
    const p = order(s, 'Wolkendienst', '2027-01-02', 1500);
    s.quick.payPurchaseWith(p.id, 'prive');
    expect(s.ledger.balance(ACCOUNTS.priveStortingen, { to: '2026-12-31' })).toBe(0);
    const t = debit(s, '2026-12-28', 1500, 'WOLKENDIENST');
    const [task] = bankTasks(s, t.id);
    expect(task).toMatchObject({ kind: 'bank-purchase-paid', ref: { purchaseId: p.id } });
    await api.home.act(task!, 'ja');
    // per 31 december: betaald van je rekening, de factuur komt nog (vooruitbetaald); niets op privé
    expect(s.ledger.balance(ACCOUNTS.bank, { to: '2026-12-31' })).toBe(-1500);
    expect(s.ledger.balance(ACCOUNTS.crediteuren, { to: '2026-12-31' })).toBe(1500);
    expect(s.ledger.balance(ACCOUNTS.priveStortingen, { to: '2026-12-31' })).toBe(0);
    // en daarna loopt het glad
    expect(s.ledger.balance(ACCOUNTS.priveStortingen)).toBe(0);
    expect(s.ledger.balance(ACCOUNTS.crediteuren)).toBe(0);
    expect(s.ledger.balance('WBedKanSof')).toBe(1500);
    expect(s.purchases.get(p.id)).toMatchObject({ status: 'betaald', open_amount: 0 });

    // een afschrijving ná de privébetaling: de tegenboeking staat op de datum van de afschrijving, zoals het was
    const q = order(s, 'Printhuis', '2026-09-01', 4840);
    s.quick.payPurchaseWith(q.id, 'prive');
    const u = debit(s, '2026-09-03', 4840, 'Printhuis');
    api.bank.linkPurchase(u.id, q.id);
    expect(s.ledger.balance(ACCOUNTS.priveStortingen, { to: '2026-09-02' })).toBe(-4840);
    expect(s.ledger.balance(ACCOUNTS.priveStortingen, { to: '2026-09-03' })).toBe(0);
  });

  it('"Nee, iets anders": de aankoop blijft betaald, de vraag komt niet terug en je deelt de betaling zelf in', async () => {
    const ctx = world();
    const { s, api } = ctx;
    const p = order(s, 'Wolkendienst', '2026-09-01', 1500);
    s.quick.payPurchaseWith(p.id, 'prive');
    const t = debit(s, '2026-09-03', 1500, 'WOLKENDIENST');
    const before = financialSnapshot(ctx);
    const [task] = bankTasks(s, t.id);
    expect(await api.home.act(task!, 'nee')).toEqual({ navigate: { screen: 'betaling', id: t.id } });
    expect(financialSnapshot(ctx)).toEqual(before);
    expect(s.purchases.get(p.id).status).toBe('betaald');
    expect(bankTasks(s, t.id).map((x) => x.kind)).toEqual(['bank-business']);
    expect(api.bank.purchaseQuestion(t.id)).toBeNull();
    s.inbox.answerBank(t.id, { business: true, categoryKey: 'software', vatCode: 'geen' });
    expect(s.bank.get(t.id).status).toBe('gematcht');
    expect(s.ledger.balance('WBedKanSof')).toBe(3000); // twee aankopen
    expect(s.ledger.balance(ACCOUNTS.priveStortingen)).toBe(-1500);
  });

  it('twee afschrijvingen die bij één privé betaalde aankoop passen: bij allebei de vraag, dichtstbij eerst', () => {
    const { s } = world();
    const p = order(s, 'Wolkendienst', '2026-09-01', 1500);
    s.quick.payPurchaseWith(p.id, 'prive', { always: true });
    const later = debit(s, '2026-09-09', 1500, 'WOLKENDIENST');
    const sooner = debit(s, '2026-09-02', 1500, 'WOLKENDIENST');
    expect(s.bookedPayments.findPending(s.purchases.get(p.id)).map((t) => t.id)).toEqual([sooner.id, later.id]);
    expect(s.inbox.autoProcess('2026-09-28')).toEqual({ matched: 0, booked: 0 });
    expect(bankTasks(s, sooner.id).map((x) => x.kind)).toEqual(['bank-purchase-paid']);
    expect(bankTasks(s, later.id).map((x) => x.kind)).toEqual(['bank-purchase-paid']);
    // een afschrijving van een andere leverancier, of buiten het venster, hoort er niet bij
    debit(s, '2026-09-03', 1500, 'Printhuis');
    debit(s, '2026-11-03', 1500, 'WOLKENDIENST');
    expect(s.bookedPayments.findPending(s.purchases.get(p.id)).map((t) => t.id)).toEqual([sooner.id, later.id]);
  });

  it('"Al betaald" terwijl de afschrijving nog onverwerkt op je rekening staat: eerst vragen; "ja" koppelt, "nee, apart betaald" onthoudt het', () => {
    const ctx = world();
    const { s, api } = ctx;
    const p = order(s, 'Wolkendienst', '2026-09-01', 1500);
    const t = debit(s, '2026-09-03', 1500, 'WOLKENDIENST');
    expect(api.purchases.bookedPayment(p.id)).toEqual({ bankTransactionId: t.id, date: '2026-09-03', amount: 1500, counterName: 'WOLKENDIENST', account: 'Zakelijke rekening', status: 'nieuw', booking: null });
    const before = financialSnapshot(ctx);
    expect(() => api.purchases.paidWith(p.id, 'prive')).toThrow(`Op je rekening staat een afschrijving van ${formatEuro(1500)} aan WOLKENDIENST die nog niet verwerkt is. Kies eerst of dat de betaling van deze aankoop is.`);
    expect(() => api.purchases.paidWith(p.id, 'kas', { always: true })).toThrow(ValidationError);
    expect(financialSnapshot(ctx)).toEqual(before);
    expect(s.relations.get(p.relation_id!).paid_with).toBeNull();
    // "Ja, dat is hem": de afschrijving betaalt de aankoop
    api.purchases.mergeWithBooked(p.id, t.id);
    expect(s.bank.get(t.id)).toMatchObject({ status: 'gematcht', matched_purchase_invoice_id: p.id });
    expect(s.purchases.get(p.id).status).toBe('betaald');
    expect(s.ledger.balance(ACCOUNTS.crediteuren)).toBe(0);
    expect(s.ledger.balance(ACCOUNTS.priveStortingen)).toBe(0);

    // "Nee, apart betaald": privé betaald, en de app vraagt bij die afschrijving niet meer naar deze aankoop
    const q = order(s, 'Printhuis', '2026-09-10', 4840);
    const u = debit(s, '2026-09-11', 4840, 'Printhuis');
    const { paid, skipped } = api.purchases.paidWith(q.id, 'prive', { separate: true });
    expect(paid.map((x) => x.id)).toEqual([q.id]);
    expect(skipped).toEqual([]);
    expect(s.purchases.get(q.id).status).toBe('betaald');
    expect(s.ledger.balance(ACCOUNTS.priveStortingen)).toBe(-4840);
    expect(s.bookedPayments.matcher.rejected({ purchaseId: q.id, bankTransactionId: u.id })).toBe(true);
    expect(api.purchases.bookedPayment(q.id)).toBeNull();
    expect(bankTasks(s, u.id).map((x) => x.kind)).toEqual(['bank-business']);
    s.inbox.answerBank(u.id, { business: true, categoryKey: 'software', vatCode: 'geen' });
    expect(s.bank.get(u.id).status).toBe('gematcht');
  });

  it('voortaan altijd: een andere open rekening waarvan de afschrijving nog onverwerkt op je rekening staat, blijft open', () => {
    const { s } = world();
    const juli = order(s, 'Wolkendienst', '2026-07-01', 1500);
    const sep = order(s, 'Wolkendienst', '2026-09-01', 1500);
    const t = debit(s, '2026-07-03', 1500, 'WOLKENDIENST');
    const r = s.quick.payPurchaseWith(sep.id, 'prive', { always: true });
    expect(r.paid.map((x) => x.id)).toEqual([sep.id]);
    expect(r.skipped.map((x) => x.id)).toEqual([juli.id]);
    expect(s.purchases.get(juli.id).status).toBe('open');
    // niet "voortaan privé": deze leverancier betaal je (ook) van een eigen rekening
    expect(s.relations.get(sep.relation_id!).paid_with).toBeNull();
    expect(s.bookedPayments.findPending(s.purchases.get(juli.id)).map((x) => x.id)).toEqual([t.id]);
  });

  it('een nieuwe bon van een leverancier op "voortaan privé", terwijl de afschrijving op je rekening wacht: de aankoop blijft open', async () => {
    const { s, api } = world();
    const lev = s.relations.findOrCreateSupplier('Wolkendienst');
    s.relations.setPaidWith(lev.id, 'prive');
    const t = debit(s, '2026-09-03', 1936, 'WOLKENDIENST');
    const d = await s.intake.add('wolkendienst-sep.jpg', new Uint8Array([1]), '2026-09-05');
    s.intake.confirm(d.id, { supplier: 'Wolkendienst', date: '2026-09-01', total: 1936, categoryKey: 'software', vatCode: 'hoog', business: true, paidWith: 'later' });
    const p = s.purchases.get(s.intake.get(d.id).purchase_invoice_id!);
    expect(p).toMatchObject({ status: 'open', open_amount: 1936 });
    expect(s.ledger.balance(ACCOUNTS.priveStortingen)).toBe(0);
    // de vraag bij de betaling handelt het af: koppelen, geen tweede kostenpost
    const [task] = bankTasks(s, t.id);
    expect(task).toMatchObject({ kind: 'bank-purchase', ref: { purchaseId: p.id } });
    await api.home.act(task!, 'klopt');
    expect(s.purchases.get(p.id).status).toBe('betaald');
    expect(s.ledger.balance(ACCOUNTS.crediteuren)).toBe(0);

    // zonder afschrijving op je rekening blijft het zoals het was: meteen op privé betaald
    const e = await s.intake.add('wolkendienst-nov.jpg', new Uint8Array([2]), '2026-11-05');
    s.intake.confirm(e.id, { supplier: 'Wolkendienst', date: '2026-11-01', total: 1936, categoryKey: 'software', vatCode: 'hoog', business: true, paidWith: 'later' });
    expect(s.purchases.get(s.intake.get(e.id).purchase_invoice_id!)).toMatchObject({ status: 'betaald', open_amount: 0 });
    expect(s.ledger.balance(ACCOUNTS.priveStortingen)).toBe(-1936);
  });

  it('zelf privé gekozen bij de bon terwijl er een afschrijving bij past: uitgevoerd, en daarna de vraag bij de betaling', async () => {
    const { s } = world();
    const t = debit(s, '2026-09-03', 1936, 'WOLKENDIENST');
    const d = await s.intake.add('wolkendienst-sep.jpg', new Uint8Array([1]), '2026-09-05');
    s.intake.confirm(d.id, { supplier: 'Wolkendienst', date: '2026-09-01', total: 1936, categoryKey: 'software', vatCode: 'hoog', business: true, paidWith: 'prive' });
    expect(s.purchases.get(s.intake.get(d.id).purchase_invoice_id!).status).toBe('betaald');
    expect(bankTasks(s, t.id).map((x) => x.kind)).toEqual(['bank-purchase-paid']);
  });

  it('het voorstel "Hoe betaald?": contant of privé van de telefoon, maar er staat een afschrijving die erbij past (bedrag, leverancier en datum): de aankoop blijft open', () => {
    const match = { id: 7 };
    const fits = { bank_match: match, bank_match_strong: true };
    // alleen het bedrag past (een andere naam op het afschrift): de keuze van de telefoon blijft staan
    const amountOnly = { bank_match: match, bank_match_strong: false };
    expect(proposedPaidWith({ proposed_paid_with: 'prive', ...fits })).toBe('later');
    expect(proposedPaidWith({ proposed_paid_with: 'kas', ...fits })).toBe('later');
    expect(proposedPaidWith({ proposed_paid_with: 'prive', ...amountOnly })).toBe('prive');
    expect(proposedPaidWith({ proposed_paid_with: 'kas', ...amountOnly })).toBe('kas');
    expect(proposedPaidWith({ proposed_paid_with: 'kas', bank_match: match })).toBe('kas');
    expect(proposedPaidWith({ proposed_paid_with: 'prive', bank_match: null })).toBe('prive');
    expect(proposedPaidWith({ proposed_paid_with: 'kas' })).toBe('kas');
    expect(proposedPaidWith({ proposed_paid_with: 'bank', ...fits })).toBe('bank');
    expect(proposedPaidWith({ proposed_paid_with: null, ...fits })).toBe('bank');
    expect(proposedPaidWith({ proposed_paid_with: null, ...amountOnly })).toBe('bank');
    expect(proposedPaidWith({ proposed_paid_with: 'later', bank_match: null })).toBe('later');
    expect(paidWithNote({ proposed_paid_with: 'kas', bank_match: null })).toBe(' Contant betaald.');
    expect(paidWithNote({ proposed_paid_with: 'prive' })).toBe(' Met privégeld betaald.');
    expect(paidWithNote({ proposed_paid_with: 'kas', ...amountOnly })).toBe(' Contant betaald.');
    expect(paidWithNote({ proposed_paid_with: 'prive', ...amountOnly })).toBe(' Met privégeld betaald.');
    expect(paidWithNote({ proposed_paid_with: 'kas', ...fits })).toBe(' Op je telefoon koos je contant, maar op je rekening staat ook een afschrijving van dit bedrag. De aankoop blijft open; bij de betaling vraagt de app of die erbij hoort.');
    expect(paidWithNote({ proposed_paid_with: 'prive', ...fits })).toBe(' Op je telefoon koos je privégeld, maar op je rekening staat ook een afschrijving van dit bedrag. De aankoop blijft open; bij de betaling vraagt de app of die erbij hoort.');
    expect(paidWithNote({ proposed_paid_with: 'bank', ...fits })).toBe('');
  });

  describe('een bon van de telefoon met "contant" of "privé", en een afschrijving van hetzelfde bedrag op je rekening', () => {
    const lines = ['Bouwmarkt De Hamer', 'Datum: 05-09-2026', 'Schroeven 16,53', 'BTW 21% 16,53 3,47', 'Totaal 20,00'];
    const ocr: OcrProvider = { id: 'test', label: 'Test OCR', available: async () => true, recognize: async () => ({ items: lines.map((text, i) => ({ text, page: 1, bbox: [10, 20 + i * 20, 300, 34 + i * 20] as [number, number, number, number], confidence: 0.97 })) }) };
    /** De bon van € 20,00 van 5 september, met de betaalwijze die op de telefoon is gekozen; de afschrijving staat er al. */
    const scanned = async (phone: 'kas' | 'prive', counterName: string, usual: 'kas' | 'prive' | null = null) => {
      const ctx = setup({ ocr });
      const { s } = ctx;
      s.settings.update({ onboardingDone: true });
      const api = createApi(s, { appVersion: () => '0.0.0', hasSmtpPassword: () => false } as unknown as HostContext);
      if (usual) s.relations.setPaidWith(s.relations.findOrCreateSupplier('Bouwmarkt De Hamer').id, usual);
      const t = debit(s, '2026-09-08', 2000, counterName);
      const added = await s.intake.add('bon.jpg', new Uint8Array([7]), '2026-09-05');
      s.db.prepare('UPDATE documents SET proposed_paid_with = ? WHERE id = ?').run(phone, added.id);
      const review = () => s.inbox.tasks('2026-09-28').find((x) => x.kind === 'document-review' && x.ref.documentId === added.id)!;
      return { ...ctx, api, t, d: s.intake.get(added.id), review };
    };

    it('de afschrijving is van een andere tegenpartij: de keuze van de telefoon geldt, de bon is meteen contant betaald', async () => {
      const { s, api, t, d, review } = await scanned('kas', 'Parkeergarage Centrum');
      // de app vindt de afschrijving op het bedrag, maar de naam past niet
      expect(d).toMatchObject({ status: 'controle', bank_match: { id: t.id }, bank_match_strong: false, proposed_paid_with: 'kas' });
      expect(proposedPaidWith(d)).toBe('kas');
      expect(review().question).toContain(' Contant betaald. ');
      expect(review().question).not.toContain('blijft open');
      await api.home.act(review(), 'klopt');
      const p = s.purchases.get(s.intake.get(d.id).purchase_invoice_id!);
      expect(p).toMatchObject({ status: 'betaald', open_amount: 0 });
      expect(s.ledger.balance(ACCOUNTS.kas)).toBe(-2000);
      expect(s.ledger.balance(ACCOUNTS.crediteuren)).toBe(0);
      // de parkeerbetaling is een andere uitgave: geen vraag over de bon, en hij staat nog gewoon te wachten
      expect(s.bank.get(t.id).status).toBe('nieuw');
      expect(api.bank.purchaseQuestion(t.id)).toBeNull();
      expect(bankTasks(s, t.id).map((x) => x.kind)).toEqual(['bank-business']);
    });

    for (const [phone, account, note] of [['kas', ACCOUNTS.kas, ' Contant betaald. '], ['prive', ACCOUNTS.priveStortingen, ' Met privégeld betaald. ']] as const) {
      it(`de leverancier staat op "voortaan ${phone === 'kas' ? 'contant' : 'privé'}" en de afschrijving heeft de naam van een betaalautomaat: voorstel, melding en boeking zeggen hetzelfde`, async () => {
        const { s, api, t, d, review } = await scanned(phone, 'CCV*KIOSK 12', phone);
        expect(d).toMatchObject({ bank_match: { id: t.id }, bank_match_strong: false });
        expect(proposedPaidWith(d)).toBe(phone);
        // geen belofte dat de aankoop open blijft: hij wordt betaald zoals op de telefoon gekozen
        expect(review().question).toContain(note);
        expect(review().question).not.toContain('blijft open');
        await api.home.act(review(), 'klopt');
        expect(s.purchases.get(s.intake.get(d.id).purchase_invoice_id!)).toMatchObject({ status: 'betaald', open_amount: 0 });
        expect(s.ledger.balance(account)).toBe(-2000);
        expect(s.bank.get(t.id).status).toBe('nieuw');
      });
    }

    it('de afschrijving is van dezelfde leverancier: de aankoop blijft open en bij de betaling komt de vraag', async () => {
      const { s, api, t, d, review } = await scanned('kas', 'BOUWMARKT DE HAMER');
      expect(d).toMatchObject({ bank_match: { id: t.id }, bank_match_strong: true });
      expect(proposedPaidWith(d)).toBe('later');
      expect(review().question).toContain(' Op je telefoon koos je contant, maar op je rekening staat ook een afschrijving van dit bedrag. De aankoop blijft open; bij de betaling vraagt de app of die erbij hoort. ');
      await api.home.act(review(), 'klopt');
      const p = s.purchases.get(s.intake.get(d.id).purchase_invoice_id!);
      expect(p).toMatchObject({ status: 'open', open_amount: 2000 });
      expect(s.ledger.balance(ACCOUNTS.kas)).toBe(0);
      const [task] = bankTasks(s, t.id);
      expect(task).toMatchObject({ kind: 'bank-purchase', ref: { purchaseId: p.id } });
      await api.home.act(task!, 'klopt');
      expect(s.purchases.get(p.id)).toMatchObject({ status: 'betaald', open_amount: 0 });
      expect(s.ledger.balance(ACCOUNTS.crediteuren)).toBe(0);
      expect(s.ledger.balance(ACCOUNTS.bank)).toBe(-2000);
    });
  });
});
