import { describe, expect, it } from 'vitest';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import { setup } from './helpers';

type S = ReturnType<typeof setup>['s'];
const saldo = (s: S, rgs: string, from: string, to: string) =>
  (s.db.prepare(`SELECT COALESCE(SUM(l.debit - l.credit), 0) AS b FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN chart_of_accounts a ON a.id = l.account_id WHERE a.rgs_code = ? AND e.entry_date BETWEEN ? AND ?`).get(rgs, from, to) as { b: number }).b;
const winst = (s: S, from: string, to: string) => s.taxOverview.year(Number(from.slice(0, 4)), to).profitBooked;

describe('Jaarafsluiting: overlopende posten, voorraad en onderhanden werk', () => {
  it('vooruitbetaalde kosten: kosten van dit jaar omlaag, in januari weer terug', () => {
    const { s } = setup();
    s.yearEnd.add({ year: 2026, kind: 'vooruitbetaald', description: 'verzekering 2027', amount: 60000, costAccount: 'WBedAutOnd' });
    expect(saldo(s, ACCOUNTS.vooruitbetaaldeKosten, '2026-12-31', '2026-12-31')).toBe(60000);
    expect(saldo(s, 'WBedAutOnd', '2026-01-01', '2026-12-31')).toBe(-60000);
    expect(saldo(s, ACCOUNTS.vooruitbetaaldeKosten, '2026-01-01', '2027-01-01')).toBe(0);
    expect(saldo(s, 'WBedAutOnd', '2027-01-01', '2027-01-01')).toBe(60000);
  });
  it('nog te betalen kosten: extra kosten dit jaar, schuld op de balans, omgekeerd in januari', () => {
    const { s } = setup();
    s.yearEnd.add({ year: 2026, kind: 'nog-te-betalen', description: 'energie december', amount: 25000, costAccount: 'WBedAutOnd' });
    expect(saldo(s, 'WBedAutOnd', '2026-01-01', '2026-12-31')).toBe(25000);
    expect(saldo(s, ACCOUNTS.nogTeBetalenKosten, '2026-12-31', '2026-12-31')).toBe(-25000);
    expect(saldo(s, ACCOUNTS.nogTeBetalenKosten, '2026-01-01', '2027-01-01')).toBe(0);
  });
  it('voorraad en onderhanden werk verhogen de winst van dit jaar', () => {
    const { s } = setup();
    const before = winst(s, '2026-01-01', '2026-12-31');
    s.yearEnd.add({ year: 2026, kind: 'voorraad', description: 'tegels', amount: 400000 });
    s.yearEnd.add({ year: 2026, kind: 'onderhanden-werk', description: 'project Jansen', amount: 1000000 });
    expect(winst(s, '2026-01-01', '2026-12-31') - before).toBe(1400000);
    expect(saldo(s, ACCOUNTS.voorraad, '2026-01-01', '2027-01-01')).toBe(0);
  });
  it('de controle vraagt bij 31 december om bevestiging, en toont daarna de verwerkte posten', () => {
    const { s } = setup();
    expect(s.periods.checks('2026-12-31').find((c) => c.key === 'jaarafsluiting')).toMatchObject({ level: 'bevestigen' });
    expect(s.periods.checks('2026-09-30').find((c) => c.key === 'jaarafsluiting')).toBeUndefined();
    s.yearEnd.add({ year: 2026, kind: 'voorraad', description: 'tegels', amount: 100000 });
    expect(s.periods.checks('2026-12-31').find((c) => c.key === 'jaarafsluiting')).toMatchObject({ level: 'info' });
  });
  it('een post verwijderen draait beide boekingen terug; verkeerde invoer wordt geweigerd', () => {
    const { s } = setup();
    const i = s.yearEnd.add({ year: 2026, kind: 'voorraad', description: 'tegels', amount: 100000 });
    s.yearEnd.remove(i.id, '2027-02-01');
    expect(s.yearEnd.list(2026)).toHaveLength(0);
    expect(() => s.yearEnd.add({ year: 2026, kind: 'vooruitbetaald', description: 'x', amount: 100 })).toThrow(/kostensoort/);
    expect(() => s.yearEnd.add({ year: 2026, kind: 'voorraad', description: 'x', amount: 0 })).toThrow(/bedrag/);
  });
});
