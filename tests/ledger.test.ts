import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { ACCOUNTS } from '../src/core-ledger/accounts';

describe('core-ledger', () => {
  it('boekt een post in balans en berekent saldi', () => {
    const { s } = setup();
    s.ledger.post({
      date: '2026-01-02',
      description: 'Inbreng',
      source: 'opening',
      lines: [
        { account: ACCOUNTS.bank, debit: 100000 },
        { account: ACCOUNTS.eigenVermogen, credit: 100000 },
      ],
    });
    expect(s.ledger.balance(ACCOUNTS.bank)).toBe(100000);
    expect(s.ledger.balance(ACCOUNTS.eigenVermogen)).toBe(-100000);
    expect(s.ledger.checkIntegrity().balanced).toBe(true);
  });

  it('weigert posten die niet in balans zijn', () => {
    const { s } = setup();
    expect(() =>
      s.ledger.post({ date: '2026-01-02', description: 'x', source: 'handmatig', lines: [{ account: ACCOUNTS.bank, debit: 100 }, { account: ACCOUNTS.kas, credit: 99 }] }),
    ).toThrow(/niet in balans/);
  });

  it('weigert negatieve, dubbele, nul- en float-bedragen en onbekende rekeningen', () => {
    const { s } = setup();
    const base = { date: '2026-01-02', description: 'x', source: 'handmatig' as const };
    expect(() => s.ledger.post({ ...base, lines: [{ account: ACCOUNTS.bank, debit: -1 }, { account: ACCOUNTS.kas, credit: -1 }] })).toThrow();
    expect(() => s.ledger.post({ ...base, lines: [{ account: ACCOUNTS.bank, debit: 1, credit: 1 }, { account: ACCOUNTS.kas, credit: 0 }] })).toThrow();
    expect(() => s.ledger.post({ ...base, lines: [{ account: ACCOUNTS.bank, debit: 1.5 }, { account: ACCOUNTS.kas, credit: 1.5 }] })).toThrow();
    expect(() => s.ledger.post({ ...base, lines: [{ account: 'BESTAATNIET', debit: 1 }, { account: ACCOUNTS.kas, credit: 1 }] })).toThrow(/Onbekende/);
    expect(() => s.ledger.post({ ...base, lines: [{ account: ACCOUNTS.bank, debit: 1 }] })).toThrow(/twee regels/);
    expect(() => s.ledger.post({ ...base, date: '2026-02-30', lines: [{ account: ACCOUNTS.bank, debit: 1 }, { account: ACCOUNTS.kas, credit: 1 }] })).toThrow();
  });

  it('journaalregels zijn onveranderlijk in de database', () => {
    const { s, db } = setup();
    const id = s.ledger.post({ date: '2026-01-02', description: 'x', source: 'handmatig', lines: [{ account: ACCOUNTS.bank, debit: 5 }, { account: ACCOUNTS.kas, credit: 5 }] });
    expect(() => db.prepare('UPDATE journal_lines SET debit = 6 WHERE journal_entry_id = ?').run(id)).toThrow(/onveranderlijk/);
    expect(() => db.prepare('DELETE FROM journal_lines WHERE journal_entry_id = ?').run(id)).toThrow(/onveranderlijk/);
    expect(() => db.prepare('DELETE FROM journal_entries WHERE id = ?').run(id)).toThrow();
    expect(() => db.prepare(`UPDATE journal_entries SET description = 'y' WHERE id = ?`).run(id)).toThrow();
  });

  it('tegenboeking draait een post terug', () => {
    const { s } = setup();
    const id = s.ledger.post({ date: '2026-01-02', description: 'foutje', source: 'handmatig', lines: [{ account: ACCOUNTS.bank, debit: 500 }, { account: ACCOUNTS.kas, credit: 500 }] });
    const rev = s.ledger.reverse(id, '2026-01-03');
    expect(s.ledger.balance(ACCOUNTS.bank)).toBe(0);
    expect(s.ledger.getEntry(id).status).toBe('teruggedraaid');
    expect(s.ledger.getEntry(rev).reverses_entry_id).toBe(id);
    expect(() => s.ledger.reverse(id, '2026-01-04')).toThrow(/al teruggedraaid/);
  });

  it('saldo per periode', () => {
    const { s } = setup();
    const post = (date: string, amount: number) =>
      s.ledger.post({ date, description: 'x', source: 'handmatig', lines: [{ account: ACCOUNTS.bank, debit: amount }, { account: ACCOUNTS.kas, credit: amount }] });
    post('2026-01-15', 100);
    post('2026-02-15', 200);
    post('2026-03-15', 300);
    expect(s.ledger.balance(ACCOUNTS.bank, { from: '2026-02-01', to: '2026-02-28' })).toBe(200);
    expect(s.ledger.balance(ACCOUNTS.bank, { to: '2026-02-28' })).toBe(300);
    const tb = s.ledger.balances();
    expect(tb.reduce((sum, b) => sum + b.balance, 0)).toBe(0);
  });
});
