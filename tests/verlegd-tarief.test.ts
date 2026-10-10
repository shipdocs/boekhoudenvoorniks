import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { ACCOUNTS } from '../src/core-ledger/accounts';

const rub = (s: ReturnType<typeof setup>['s'], key: string) => Object.fromEntries(s.vat.calculate(key).rubrieken.map((x) => [x.code, x]));

describe('Verlegd tarief 9% of 21% (#316)', () => {
  it('EU-inkoop tegen 21% (standaard) en 9%: 4b en aftrek 5b volgen het tarief', () => {
    const { s } = setup();
    s.quick.recordExpense({ date: '2026-07-01', supplierName: 'Meta Platforms Ireland', description: 'Advertenties', categoryKey: 'reclame', grossAmount: 10000, vatCode: 'eu', paidWith: 'bank' });
    s.quick.recordExpense({ date: '2026-07-02', supplierName: 'Boekenleverancier BV', description: 'Vakboeken', categoryKey: 'software', grossAmount: 10000, vatCode: 'eu', vatRate: 9, paidWith: 'bank' });
    const r = rub(s, '2026-Q3');
    expect(r['4b']).toMatchObject({ omzet: 20000, btw: 2100 + 900 });
    expect(r['5b']!.btw).toBe(3000);
    expect(s.vat.calculate('2026-Q3').summary.teBetalen).toBe(0);
    expect(s.ledger.checkIntegrity().balanced).toBe(true);
  });

  it('buiten-EU en binnenlandse verlegging tegen 9%', () => {
    const { s } = setup();
    s.purchases.create({ invoiceDate: '2026-07-01', description: 'E-books', lines: [{ account: 'WBedKanSof', netAmount: 10000, vatCode: 'buiten-eu', vatRate: 9 }] });
    s.purchases.create({ invoiceDate: '2026-07-02', description: 'Verlegd', lines: [{ account: 'WBedKanSof', netAmount: 20000, vatCode: 'verlegd', vatRate: 9 }] });
    const r = rub(s, '2026-Q3');
    expect(r['4a']).toMatchObject({ omzet: 10000, btw: 900 });
    expect(r['2a']).toMatchObject({ omzet: 20000, btw: 1800 });
    expect(r['5b']!.btw).toBe(2700);
  });

  it('een tarief zonder verlegging of een ander tarief dan 9/21 wordt geweigerd', () => {
    const { s } = setup();
    expect(() => s.quick.recordExpense({ date: '2026-07-01', description: 'x', categoryKey: 'software', grossAmount: 10000, vatCode: 'hoog', vatRate: 9, paidWith: 'bank' })).toThrow(/verlegde/);
    expect(() => s.quick.recordExpense({ date: '2026-07-01', description: 'x', categoryKey: 'software', grossAmount: 10000, vatCode: 'eu', vatRate: 12, paidWith: 'bank' })).toThrow(/9% of 21%/);
  });

  it('KOR: verlegde btw blijft verschuldigd bij 9% en 21%, geen aftrek', () => {
    for (const vatRate of [9, 21]) {
      const { s } = setup(); s.settings.update({ kor: true });
      s.purchases.create({ invoiceDate: '2026-07-01', description: 'Dienst', lines: [{ account: 'WBedKanSof', netAmount: 10000, vatCode: 'eu', vatRate: vatRate as 9 | 21 }] });
      const r = s.vat.calculate('2026-Q3');
      expect(r.rubrieken.find((x) => x.code === '4b')).toMatchObject({ omzet: 10000, btw: vatRate * 100 });
      expect(r.summary.voorbelasting).toBe(0);
    }
  });

  it('bankboeking op een verlegde inkoop tegen 9%, en daarna terug naar 21%', () => {
    const { s } = setup();
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-07-03', amount: -10000, description: 'Boekendienst' }] });
    const t = s.bank.list()[0]!;
    s.bank.bookToAccount(t.id, { account: 'WBedKanSof', vatCode: 'eu', vatRate: 9 });
    expect(rub(s, '2026-Q3')['4b']).toMatchObject({ omzet: 10000, btw: 900 });
    s.bank.reclassify(t.id, { account: 'WBedKanSof', vatCode: 'eu', vatRate: 21 });
    expect(rub(s, '2026-Q3')['4b']).toMatchObject({ omzet: 10000, btw: 2100 });
    s.bank.reclassify(t.id, { account: 'WBedKanSof', vatCode: 'geen' });
    expect(rub(s, '2026-Q3')['4b']!.omzet).toBe(0);
  });

  it('de vraag op Vandaag (inbox) neemt het gekozen tarief mee naar de bankboeking', () => {
    const { s } = setup();
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-07-03', amount: -10000, description: 'Boekendienst' }] });
    const t = s.bank.list()[0]!;
    s.inbox.answerBank(t.id, { business: true, categoryKey: 'software', vatCode: 'eu', vatRate: 9 });
    expect(rub(s, '2026-Q3')['4b']).toMatchObject({ omzet: 10000, btw: 900 });
  });

  it('een aankoop zonder tarief blijft 21% (oude boekingen ongewijzigd)', () => {
    const { s } = setup();
    s.purchases.create({ invoiceDate: '2026-07-01', description: 'Oud', lines: [{ account: 'WBedKanSof', netAmount: 10000, vatCode: 'eu' }] });
    expect(rub(s, '2026-Q3')['4b']).toMatchObject({ btw: 2100 });
    expect(s.ledger.balance(ACCOUNTS.btwVoorbelasting)).toBe(2100);
  });
});
