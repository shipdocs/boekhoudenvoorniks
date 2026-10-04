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

describe('saldocontrole bij een eigen overboeking waarvan één afschrift nog ontbreekt', () => {
  it('telt de overboeking mee voor de rekening die nog achterloopt', () => {
    const MAIN = 'NL91ABNA0417164300';
    const SPAAR = 'NL44RABO0123456789';
    const { s } = setup();
    s.settings.update({ onboardingDone: true, autopilot: 'normaal' });
    s.bank.updateAccount(s.bank.ensureDefaultAccount().id, { iban: MAIN });
    const main = s.bank.ensureDefaultAccount();
    const spaar = s.bank.addAccount('Spaarrekening', SPAAR);
    s.bank.setOpeningBalance(spaar.id, 50000, '2026-01-01');
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-03-02', amount: 50000, description: 'Overboeking', counterIban: SPAAR, counterName: 'Spaar' }] }, { bankAccountId: main.id });
    s.inbox.autoProcess('2026-03-05');

    const rows = s.inbox.balanceOverview();
    const spaarRow = rows.find((r) => r.bankAccountId === spaar.id)!;
    expect(spaarRow).toMatchObject({ ledger: 0, transactions: 50000, awaitingStatement: -50000, ledgerMatches: true });
    expect(rows.find((r) => r.bankAccountId === main.id)).toMatchObject({ awaitingStatement: 0, ledgerMatches: true });
  });
});
