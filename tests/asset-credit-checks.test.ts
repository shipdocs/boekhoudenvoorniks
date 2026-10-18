import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { ACCOUNTS } from '../src/core-ledger/accounts';

const purchase = (s: ReturnType<typeof setup>['s'], date: string, amount: number) => s.purchases.create({
  invoiceDate: date, description: 'Investeringscreditcontrole',
  lines: [{ account: ACCOUNTS.inventaris, netAmount: amount, vatCode: 'geen' }],
});
const snapshot = (db: ReturnType<typeof setup>['db']) => ({
  assets: db.prepare('SELECT * FROM assets ORDER BY id').all(),
  allocations: db.prepare('SELECT * FROM asset_credit_allocations ORDER BY journal_line_id').all(),
  entries: db.prepare('SELECT * FROM journal_entries ORDER BY id').all(),
  lines: db.prepare('SELECT * FROM journal_lines ORDER BY id').all(),
});

describe('Investeringscredits: leescontrole houdt rekening met resterende kostprijs', () => {
  it.each([
    { amounts: [80000, 80000], pending: 1, cost: 20000 },
    { amounts: [80000, 20000], pending: 0, cost: 0 },
    { amounts: [80000, 30000, 20000], pending: 1, cost: 0 },
  ])('credits $amounts: $pending onopgelost, kostprijs na verwerking $cost', ({ amounts, pending, cost }) => {
    const { s, db } = setup();
    purchase(s, '2026-02-01', 100000);
    s.assets.sync('2026-02-02');
    amounts.forEach((amount, i) => purchase(s, `2026-02-0${i + 3}`, -amount));
    const before = snapshot(db);

    const planned = s.assets.pendingCredits();
    expect(planned).toHaveLength(pending);
    expect(planned.every(c => c.candidates.length === 0)).toBe(true);
    for (let i = 0; i < 2; i++) {
      const check = s.vat.checks('2026-Q1').find(c => c.key === 'investering-credit');
      if (pending) expect(check).toMatchObject({ blocking: true, count: pending });
      else expect(check).toBeUndefined();
      expect(snapshot(db)).toEqual(before);
    }

    s.assets.sync('2026-02-10');
    expect(s.assets.unassignedCredits(false).map(c => c.lineId)).toEqual(planned.map(c => c.lineId));
    expect(s.assets.get(1, '2026-02-10').cost).toBe(cost);
    expect(s.vat.checks('2026-Q1').find(c => c.key === 'investering-credit')?.count ?? 0).toBe(pending);
  });

  it('een eerdere unieke credit kan een volgende credit eenduidig maken', () => {
    const { s, db } = setup();
    purchase(s, '2026-02-01', 100000);
    purchase(s, '2026-02-01', 60000);
    s.assets.sync('2026-02-02');
    purchase(s, '2026-02-03', -80000);
    purchase(s, '2026-02-04', -50000);
    expect(s.assets.unassignedCredits(false).map(c => c.candidates.length)).toEqual([1, 2]);
    const before = snapshot(db);
    expect(s.vat.checks('2026-Q1').find(c => c.key === 'investering-credit')).toBeUndefined();
    expect(snapshot(db)).toEqual(before);
    s.assets.sync('2026-02-05');
    expect(s.assets.unassignedCredits(false)).toEqual([]);
    expect(s.assets.get(1, '2026-02-05').cost).toBe(20000);
    expect(s.assets.get(2, '2026-02-05').cost).toBe(10000);
  });

  it('onduidelijke credits blijven zichtbaar en reserveren geen willekeurig bedrijfsmiddel', () => {
    const { s, db } = setup();
    purchase(s, '2026-02-01', 100000);
    purchase(s, '2026-02-01', 100000);
    s.assets.sync('2026-02-02');
    purchase(s, '2026-02-03', -80000);
    purchase(s, '2026-02-04', -30000);
    const before = snapshot(db);
    const planned = s.assets.pendingCredits();
    expect(planned.map(c => c.candidates.length)).toEqual([2, 2]);
    expect(s.vat.checks('2026-Q1').find(c => c.key === 'investering-credit')).toMatchObject({ blocking: true, count: 2 });
    expect(snapshot(db)).toEqual(before);
    s.assets.sync('2026-02-05');
    expect(s.assets.unassignedCredits(false).map(c => c.lineId)).toEqual(planned.map(c => c.lineId));
  });

  it('beoordeelt een later ingevoerde credit op boekingsdatum en houdt de aangiftepeildatum aan', () => {
    const { s, db } = setup();
    purchase(s, '2026-02-01', 100000);
    s.assets.sync('2026-02-02');
    purchase(s, '2026-04-01', -80000);
    purchase(s, '2026-02-03', -80000);
    const before = snapshot(db);
    const planned = s.assets.pendingCredits();
    expect(planned.map(c => c.date)).toEqual(['2026-04-01']);
    expect(s.vat.checks('2026-Q1').find(c => c.key === 'investering-credit')).toBeUndefined();
    expect(s.vat.checks('2026-Q2').find(c => c.key === 'investering-credit')).toMatchObject({ blocking: true, count: 1 });
    expect(snapshot(db)).toEqual(before);
    s.assets.sync('2026-04-02');
    expect(s.assets.unassignedCredits(false).map(c => c.lineId)).toEqual(planned.map(c => c.lineId));
  });
});
