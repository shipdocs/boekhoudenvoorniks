import { describe, expect, it } from 'vitest';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import { setup } from './helpers';

const rub = (s: ReturnType<typeof setup>['s']) => Object.fromEntries(s.vat.calculate('2026-Q2').rubrieken.map((x) => [x.code, x]));

describe('Memoriaalboeking met btw-code (verlegde inkoop)', () => {
  it('de code op de kostenregel vult de grondslag in 2a en de btw in 2a/5b', () => {
    const { s } = setup();
    s.ledger.post({ date: '2026-04-15', description: 'Correctie: inhuur Klaas', source: 'handmatig', lines: [
      { account: 'WKprInkMat', debit: 100000, vatCode: 'verlegd' },
      { account: ACCOUNTS.btwVoorbelasting, debit: 21000 },
      { account: ACCOUNTS.btwAfdragenVerlegd, credit: 21000 },
      { account: ACCOUNTS.crediteuren, credit: 100000 },
    ] });
    expect(rub(s)['2a']).toMatchObject({ omzet: 100000, btw: 21000 });
    expect(rub(s)['5b']!.btw).toBe(21000);
  });
  it('zonder btw-code blijft de grondslag leeg (gedrag van vóór de wijziging)', () => {
    const { s } = setup();
    s.ledger.post({ date: '2026-04-15', description: 'Zonder code', source: 'handmatig', lines: [
      { account: 'WKprInkMat', debit: 100000 }, { account: ACCOUNTS.btwAfdragenVerlegd, debit: 0 + 21000 }, { account: ACCOUNTS.crediteuren, credit: 121000 },
    ] });
    expect(rub(s)['2a']!.omzet ?? 0).toBe(0);
  });
  it('een verlegde code zonder de verschuldigde btw wordt geweigerd', () => {
    const { s } = setup();
    expect(() => s.ledger.post({ date: '2026-04-15', description: 'Mist btw', source: 'handmatig', lines: [
      { account: 'WKprInkMat', debit: 100000, vatCode: 'verlegd' }, { account: ACCOUNTS.crediteuren, credit: 100000 },
    ] })).toThrow(/verschuldigde btw/);
  });
  it('een btw-code op een andere regel dan kosten of activa wordt geweigerd', () => {
    const { s } = setup();
    expect(() => s.ledger.post({ date: '2026-04-15', description: 'Fout', source: 'handmatig', lines: [
      { account: ACCOUNTS.crediteuren, debit: 100000, vatCode: 'verlegd' }, { account: ACCOUNTS.bank, credit: 100000 },
    ] })).toThrow(/grondslag/);
  });
  it('buiten-eu met 21% naar 4a en alleen verlegde codes zijn toegestaan', () => {
    const { s } = setup();
    expect(() => s.ledger.post({ date: '2026-04-15', description: 'x', source: 'handmatig', lines: [{ account: 'WKprInkMat', debit: 100, vatCode: 'hoog' }, { account: ACCOUNTS.crediteuren, credit: 100 }] })).toThrow(/Btw-code/);
    s.ledger.post({ date: '2026-04-15', description: 'Abonnement VS', source: 'handmatig', lines: [
      { account: 'WKprInkMat', debit: 10000, vatCode: 'buiten-eu' }, { account: ACCOUNTS.btwVoorbelasting, debit: 2100 }, { account: ACCOUNTS.btwAfdragenBuitenEu, credit: 2100 }, { account: ACCOUNTS.crediteuren, credit: 10000 },
    ] });
    expect(rub(s)['4a']).toMatchObject({ omzet: 10000, btw: 2100 });
  });
});
