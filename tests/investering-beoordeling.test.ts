import { describe, expect, it } from 'vitest';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import { setup } from './helpers';

const purchase = (s: ReturnType<typeof setup>['s'], date: string, amount: number) => s.purchases.create({
  invoiceDate: date, description: 'Machine',
  lines: [{ account: ACCOUNTS.inventaris, netAmount: amount, vatCode: 'hoog', vatAmount: Math.round(amount * 0.21) }],
});
const find = (s: ReturnType<typeof setup>['s'], period: string, key: string) => s.vat.checks(period).find((c) => c.key === key);

describe('Bijzondere investeringssituaties: beoordelingstaken', () => {
  it('KOR: een vijfde van de afgetrokken btw per jaar terug, pas vanaf € 500 (voorbeeld Belastingdienst)', () => {
    const { s } = setup();
    // auto in 2024 met € 4.500 btw (21% van € 21.428,57): 4.500 / 5 = 900 per jaar
    s.purchases.create({ invoiceDate: '2024-01-10', description: 'Bus', lines: [{ account: ACCOUNTS.vervoermiddelen, netAmount: 2142857, vatCode: 'hoog', vatAmount: 450000 }] });
    s.assets.sync('2024-01-11');
    expect(find(s, '2026-Q2', 'kor-herziening')).toBeUndefined(); // zonder KOR niets
    s.settings.update({ kor: true });
    const c = find(s, '2026-Q2', 'kor-herziening')!;
    expect(c.title).toMatch(/900,00/);
    expect(c.items![0]!.amount).toBe(450000);
  });
  it('KOR: onder € 500 per jaar geen herziening', () => {
    const { s } = setup();
    purchase(s, '2024-03-01', 500000); // btw € 1.050, een vijfde = € 210
    s.assets.sync('2024-03-02');
    s.settings.update({ kor: true });
    expect(find(s, '2026-Q2', 'kor-herziening')).toBeUndefined();
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
