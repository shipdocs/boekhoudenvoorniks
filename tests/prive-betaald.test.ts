import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { ACCOUNTS } from '../src/core-ledger/accounts';

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
