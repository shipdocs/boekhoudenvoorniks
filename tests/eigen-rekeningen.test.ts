import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { ACCOUNTS } from '../src/core-ledger/accounts';

const MAIN = 'NL91ABNA0417164300';
const SPAAR = 'NL44RABO0123456789';

function twoAccounts(autopilot: 'voorzichtig' | 'normaal' = 'normaal') {
  const { s } = setup();
  s.settings.update({ onboardingDone: true, autopilot });
  s.bank.updateAccount(s.bank.ensureDefaultAccount().id, { iban: MAIN });
  const main = s.bank.ensureDefaultAccount();
  const spaar = s.bank.addAccount('Spaarrekening', SPAAR);
  const tx = (accountId: number, date: string, amount: number, counterIban: string) =>
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date, amount, description: 'Overboeking', counterIban, counterName: 'Piet' }] }, { bankAccountId: accountId });
  const profit = () => s.ledger.balances().filter((b) => b.category === 'omzet' || b.category === 'kosten').reduce((x, b) => x + b.balance, 0);
  return { s, main, spaar, tx, profit };
}

describe('eigen rekeningen', () => {
  it('rekening toevoegen: naam verplicht, geen dubbele IBAN', () => {
    const { s } = twoAccounts();
    expect(() => s.bank.addAccount('Nog een', SPAAR)).toThrow(/staat er al in/);
    expect(() => s.bank.addAccount('  ', 'NL02ABNA0123456789')).toThrow(/naam/);
    const main = s.bank.listAccounts()[0]!;
    expect(() => s.bank.updateAccount(main.id, { iban: SPAAR })).toThrow(/staat er al in/);
    s.bank.updateAccount(main.id, { name: 'Zakelijk ING' });
    expect(s.bank.getAccount(main.id).name).toBe('Zakelijk ING');
  });

  it('beginsaldo per rekening; opnieuw invoeren vervangt het oude bedrag', () => {
    const { s, spaar } = twoAccounts();
    s.bank.setOpeningBalance(spaar.id, 100000, '2026-01-01');
    s.bank.setOpeningBalance(spaar.id, 250000, '2026-01-01');
    expect(s.ledger.balance(spaar.rgs_code)).toBe(250000);
    expect(s.bank.openingBalance(spaar.id)).toEqual({ amount: 250000, date: '2026-01-01' });
    expect(s.ledger.balance(ACCOUNTS.bank)).toBe(0);
  });

  it('overboeking met beide afschriften ingelezen wordt één keer geboekt, zonder vraag', () => {
    const { s, main, spaar, tx, profit } = twoAccounts();
    tx(main.id, '2026-03-02', -50000, SPAAR);
    tx(spaar.id, '2026-03-03', 50000, MAIN);
    s.inbox.autoProcess('2026-03-05');
    const [a, b] = [s.bank.list({ bankAccountId: main.id })[0]!, s.bank.list({ bankAccountId: spaar.id })[0]!];
    expect(a.status).toBe('gematcht');
    expect(b.status).toBe('gematcht');
    expect(a.matched_journal_entry_id).toBe(b.matched_journal_entry_id);
    expect(s.ledger.balance(spaar.rgs_code)).toBe(50000);
    expect(s.ledger.balance(main.rgs_code)).toBe(-50000);
    expect(profit()).toBe(0);
    expect(s.inbox.tasks('2026-03-05').filter((t) => t.kind.startsWith('bank-') && t.kind !== 'bank-stale')).toEqual([]);
  });

  it('ook als de spaarkant eerst binnenkomt', () => {
    const { s, main, spaar, tx } = twoAccounts();
    tx(spaar.id, '2026-03-03', 50000, MAIN);
    s.inbox.autoProcess('2026-03-05');
    tx(main.id, '2026-03-02', -50000, SPAAR);
    s.inbox.autoProcess('2026-03-05');
    expect(s.ledger.balance(spaar.rgs_code)).toBe(50000);
    expect(s.ledger.balance(main.rgs_code)).toBe(-50000);
  });

  it('ongedaan maken draait beide kanten terug', () => {
    const { s, main, spaar, tx } = twoAccounts();
    tx(main.id, '2026-03-02', -50000, SPAAR);
    tx(spaar.id, '2026-03-02', 50000, MAIN);
    s.inbox.autoProcess('2026-03-05');
    const b = s.bank.list({ bankAccountId: spaar.id })[0]!;
    expect(() => s.bank.reclassify(b.id, { account: ACCOUNTS.priveOpnamen })).toThrow(/eigen rekeningen/);
    s.bank.unmatch(b.id, '2026-03-05');
    expect(s.bank.list({ status: 'nieuw' })).toHaveLength(2);
    expect(s.ledger.balance(spaar.rgs_code)).toBe(0);
    expect(s.ledger.balance(main.rgs_code)).toBe(0);
  });

  it('voorzichtig: een vraag op Vandaag, met één klik goed', () => {
    const { s, main, spaar, tx, profit } = twoAccounts('voorzichtig');
    tx(spaar.id, '2026-03-02', -20000, MAIN);
    s.inbox.autoProcess('2026-03-05');
    const task = s.inbox.tasks('2026-03-05').find((t) => t.kind === 'bank-own')!;
    expect(task.title).toMatch(/naar je rekening Zakelijke rekening/);
    s.bank.bookOwnTransfer(task.ref.bankTransactionId!);
    expect(s.ledger.balance(spaar.rgs_code)).toBe(-20000);
    expect(s.ledger.balance(main.rgs_code)).toBe(20000);
    expect(profit()).toBe(0);
  });

  it('btw-potje: beide kanten heten "belastingpotje" en tellen één keer mee', () => {
    const { s, main, spaar, tx } = twoAccounts('voorzichtig');
    s.settings.update({ vatPotAccountId: spaar.id });
    tx(main.id, '2026-03-02', -30000, SPAAR);
    tx(spaar.id, '2026-03-02', 30000, MAIN);
    const tasks = s.inbox.tasks('2026-03-05').filter((t) => t.kind === 'bank-pot');
    expect(tasks).toHaveLength(2);
    for (const t of tasks) expect(t.title).toMatch(/300,00 naar je belastingpotje$/);
    for (const t of tasks) s.bank.bookOwnTransfer(t.ref.bankTransactionId!);
    expect(s.inbox.home('2026-03-05').money.vatPot).toMatchObject({ setAside: 30000 });
  });

  it('als de andere kant al als "overboeking" (kruisposten) geboekt stond, gaat het daar weer af', () => {
    const { s, main, spaar, tx } = twoAccounts('voorzichtig');
    tx(main.id, '2026-03-02', -40000, SPAAR);
    s.bank.bookToAccount(s.bank.list({ bankAccountId: main.id })[0]!.id, { account: ACCOUNTS.kruisposten });
    tx(spaar.id, '2026-03-02', 40000, MAIN);
    s.bank.bookOwnTransfer(s.bank.list({ bankAccountId: spaar.id })[0]!.id);
    expect(s.ledger.balance(ACCOUNTS.kruisposten)).toBe(0);
    expect(s.ledger.balance(spaar.rgs_code)).toBe(40000);
    expect(s.ledger.balance(main.rgs_code)).toBe(-40000);
  });

  it('"klopt niet" op een automatische overboeking: terug als vraag, niet opnieuw automatisch', () => {
    const { s, main, tx } = twoAccounts();
    tx(main.id, '2026-03-02', -50000, SPAAR);
    s.inbox.autoProcess('2026-03-05');
    const log = s.db.prepare(`SELECT id FROM automation_log WHERE kind = 'bank-own'`).get() as { id: number };
    s.inbox.correctAutomation(log.id, '2026-03-05');
    s.inbox.autoProcess('2026-03-06');
    expect(s.bank.list({ status: 'nieuw' })).toHaveLength(1);
    expect(s.inbox.tasks('2026-03-06').some((t) => t.kind === 'bank-own')).toBe(true);
  });
});
