import { describe, expect, it } from 'vitest';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import { setup } from './helpers';

const purchase = (s: ReturnType<typeof setup>['s'], date: string, amount: number) => s.purchases.create({
  invoiceDate: date, description: 'Machine',
  lines: [{ account: ACCOUNTS.inventaris, netAmount: amount, vatCode: 'hoog', vatAmount: Math.round(amount * 0.21) }],
});
const find = (s: ReturnType<typeof setup>['s'], period: string, key: string) => s.vat.checks(period).find((c) => c.key === key);

describe('Bijzondere investeringssituaties: beoordelingstaken', () => {
  it('KOR met een recent bedrijfsmiddel: vraag naar herziening; zonder KOR niet', () => {
    const { s } = setup();
    purchase(s, '2025-03-01', 500000);
    s.assets.sync('2025-03-02');
    expect(find(s, '2026-Q2', 'kor-herziening')).toBeUndefined();
    s.settings.update({ kor: true });
    expect(find(s, '2026-Q2', 'kor-herziening')).toMatchObject({ blocking: false, count: 1 });
  });
  it('een bedrijfsmiddel naar privé geeft een vraag over de btw op de onttrekking', () => {
    const { s } = setup();
    purchase(s, '2026-01-10', 500000);
    s.assets.sync('2026-01-11');
    const a = s.assets.list({}, '2026-05-01')[0]!;
    s.assets.dispose(a.id, '2026-05-01', 300000, 'prive');
    expect(find(s, '2026-Q2', 'investering-prive')).toMatchObject({ blocking: false, count: 1 });
    expect(find(s, '2026-Q1', 'investering-prive')).toBeUndefined();
  });
  it('een credit in een later jaar dan de aanschaf geeft een beoordelingstaak', () => {
    const { s } = setup();
    purchase(s, '2025-11-01', 500000);
    s.assets.sync('2025-11-02');
    purchase(s, '2026-02-01', -50000);
    s.assets.sync('2026-02-02');
    expect(find(s, '2026-Q1', 'investering-credit-later')).toMatchObject({ blocking: false, count: 1 });
    expect(find(s, '2025-Q4', 'investering-credit-later')).toBeUndefined();
  });
});
