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
    const { paid: [paid], alreadyBooked } = s.quick.payPurchaseWith(p.id, 'prive');
    expect(alreadyBooked).toEqual([]);
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
  it('"Al betaald" ziet de geboekte afschrijving: de aankoop vervalt, niet privé en niet voortaan privé', () => {
    const { s } = setup();
    const txId = bookedDebit(s, 'Moonshot AI', '2026-07-20', 1728);
    const p = buyUsd(s, 'Moonshot AI', '2026-07-15');
    const before = software(s);
    const r = s.quick.payPurchaseWith(p.id, 'prive', { always: true });
    expect(r.paid).toEqual([]);
    expect(r.alreadyBooked).toEqual([expect.objectContaining({ purchaseId: p.id, bankTransactionId: txId, amount: 1728 })]);
    expect(s.purchases.list().find((x) => x.id === p.id)).toBeUndefined();
    expect(software(s)).toBe(before - 1666); // alleen de afschrijving telt nog
    expect(s.ledger.balance(ACCOUNTS.priveStortingen)).toBe(0);
    expect(s.ledger.balance(ACCOUNTS.crediteuren)).toBe(0);
    expect(s.relations.get(p.relation_id!).paid_with).toBeNull();
  });

  it('wat al dubbel stond, herstelt de app vanzelf: privé-betaling terug, aankoop weg, voortaan privé uit, in het logboek', () => {
    const { s } = setup();
    const p = buyUsd(s, 'Render', '2026-05-05');
    // zo ging het in 0.6.4: eerst privé betaald gezet (voortaan altijd), daarna kwam de afschrijving en werd die als kosten geboekt
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
    // nog een keer: niets meer te doen
    s.inbox.autoProcess('2026-09-28');
    expect(s.db.prepare(`SELECT COUNT(*) AS n FROM automation_log WHERE kind = 'dubbel-weg'`).get()).toEqual({ n: 1 });
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
