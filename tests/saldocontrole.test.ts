import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import type { NormalizedTransaction, ParseResult } from '../src/import/types';

const OWN = 'NL91ABNA0417164300';
const OPENING = 100000;

const result = (transactions: NormalizedTransaction[], extra: Partial<ParseResult> = {}): ParseResult => ({ source: 'camt', warnings: [], transactions, ...extra });
const tx = (date: string, amount: number, extra: Partial<NormalizedTransaction> = {}): NormalizedTransaction => ({ date, amount, description: 'betaling', ownIban: OWN, ...extra });

describe('saldocontrole per rekening', () => {
  it('grootboek, betalingen en afschrift komen overeen, ook met een nog te verwerken betaling', () => {
    const { s } = setup();
    const account = s.bank.ensureDefaultAccount(OWN);
    s.bank.setOpeningBalance(account.id, OPENING, '2026-09-01');
    s.bank.import(result([tx('2026-09-08', -1299, { counterName: 'Printhuis', description: 'Bon 4411', bankId: 'A' })], { balances: [{ ownIban: OWN, date: '2026-09-11', amount: OPENING - 1299 }] }));

    const [row] = s.inbox.balanceOverview();
    expect(row).toMatchObject({ bankAccountId: account.id, ledger: OPENING, pending: -1299, transactions: OPENING - 1299, ledgerMatches: true });
    expect(row!.statement).toMatchObject({ bank: OPENING - 1299, app: OPENING - 1299, matches: true });
  });

  it('meldt een afschrift waarvan het eindsaldo niet klopt', () => {
    const { s } = setup();
    const account = s.bank.ensureDefaultAccount(OWN);
    s.bank.setOpeningBalance(account.id, OPENING, '2026-09-01');
    s.bank.import(result([tx('2026-09-08', -1299, { counterName: 'Printhuis', description: 'Bon 4411', bankId: 'A' })], { balances: [{ ownIban: OWN, date: '2026-09-11', amount: OPENING - 5000 }] }));

    const [row] = s.inbox.balanceOverview();
    expect(row!.statement).toMatchObject({ matches: false, bank: OPENING - 5000, app: OPENING - 1299 });
  });
});

describe('saldocontrole na verwerken', () => {
  it('klopt ook nadat betalingen zijn geboekt of genegeerd', () => {
    const { s } = setup();
    const account = s.bank.ensureDefaultAccount(OWN);
    s.bank.setOpeningBalance(account.id, OPENING, '2026-09-01');
    s.bank.import(result([
      tx('2026-09-08', -1299, { counterName: 'Printhuis', description: 'Bon 4411', bankId: 'A' }),
      tx('2026-09-09', -500, { counterName: 'Bakker', description: 'Brood', bankId: 'B' }),
    ]));
    const [a, b] = s.bank.list();
    s.bank.ignore(a!.id);
    s.bank.ignore(b!.id);
    const [row] = s.inbox.balanceOverview();
    expect(row!.ledgerMatches).toBe(true);
  });
});
