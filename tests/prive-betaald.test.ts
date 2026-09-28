import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { ACCOUNTS } from '../src/core-ledger/accounts';

describe('rekening privé betaald (privérekening, telefoonrekening)', () => {
  const buy = (s: ReturnType<typeof setup>['s'], relationId: number, date: string) =>
    s.purchases.create({ relationId, invoiceDate: date, description: 'Overige kosten — DigiBoox', lines: [{ account: ACCOUNTS.inkoopMaterialen, netAmount: 1600, vatCode: 'hoog' }] });

  it('één rekening: Crediteuren aan Privé-stortingen, kosten en btw blijven staan', () => {
    const { s } = setup();
    const lev = s.relations.findOrCreateSupplier('Google');
    const p = buy(s, lev.id, '2026-09-27');
    const [paid] = s.quick.payPurchaseWith(p.id, 'prive');
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
    const paid = s.quick.payPurchaseWith(b.id, 'prive', { always: true });
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
