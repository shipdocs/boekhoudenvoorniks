import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { ACCOUNTS } from '../src/core-ledger/accounts';

describe('btw-aangifte na de uiterste datum', () => {
  function withQ2Activity() {
    const { s, klant } = setup();
    s.settings.update({ onboardingDone: true, vatPeriod: 'kwartaal', kor: false });
    s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-05-10', lines: [{ description: 'Werk', quantity: 1, unitPrice: 10000, vatCode: 'hoog' }] }).id);
    return s;
  }

  it('vóór de uiterste datum: aangifte doen, met "Al ingediend" als tweede keuze', () => {
    const s = withQ2Activity();
    const task = s.inbox.tasks('2026-07-10').find((t) => t.kind === 'vat-due')!;
    expect(task.title).toBe('Btw-aangifte 2e kwartaal 2026 doen');
    expect(task.actions.map((a) => a.id)).toEqual(['open', 'ingediend']);
  });

  it('na de uiterste datum: eerst vragen of hij al gedaan is; afvinken kan ook met open controles', () => {
    const s = withQ2Activity();
    // een blokkerende controle in Q2 (vraagpost), zoals bij de gebruiker
    s.ledger.post({ date: '2026-06-01', description: 'onbekend', source: 'handmatig', lines: [{ account: ACCOUNTS.kas, debit: 5000, credit: 0 }, { account: 'BSchOvsVrp', debit: 0, credit: 5000 }] });
    const tasks = s.inbox.tasks('2026-09-27');
    const task = tasks.find((t) => t.kind === 'vat-due')!;
    expect(task.title).toMatch(/2e kwartaal 2026: had uiterlijk 31 juli 2026 binnen moeten zijn/);
    expect(task.actions[0]).toMatchObject({ id: 'ingediend', label: 'Al ingediend' });
    expect(tasks.some((t) => t.kind === 'vat-check')).toBe(false);
    expect(() => s.vat.markSubmitted('2026-Q2')).toThrow(/Los eerst op/);
    s.vat.markSubmitted('2026-Q2', { alreadyFiled: true });
    expect(s.vat.calculate('2026-Q2').status).toBe('ingediend');
    expect(s.inbox.tasks('2026-09-27').some((t) => t.kind === 'vat-due')).toBe(false);
  });
});

describe('potje zonder eigen rekeningnummer (bv. Knab)', () => {
  it('toevoegen zonder IBAN en geld erheen boeken: geen kosten, niets "onderweg"', () => {
    const { s } = setup();
    const pot = s.bank.addAccount('Btw-potje', null);
    expect(pot.iban).toBeNull();
    expect(() => s.bank.addAccount('btw-potje', '')).toThrow(/al een rekening met deze naam/);
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-09-01', amount: -32408, description: 'Naar potje BTW', counterName: 'Knab potje' }] });
    const t = s.bank.list({ status: 'nieuw' })[0]!;
    s.bank.bookToAccount(t.id, { account: pot.rgs_code, description: 'Naar potje Btw-potje' });
    expect(s.ledger.balance(pot.rgs_code)).toBe(32408);
    expect(s.ledger.balance(ACCOUNTS.kruisposten)).toBe(0);
    const profit = s.ledger.balances().filter((b) => b.category === 'omzet' || b.category === 'kosten').reduce((x, b) => x + b.balance, 0);
    expect(profit === 0).toBe(true);
    expect(s.vat.calculate('2026-Q3').summary.voorbelasting === 0).toBe(true);
  });
});

describe('potje en gewone rekening zonder IBAN uit elkaar houden', () => {
  it('een afschrift met een onbekend IBAN komt nooit op een potje; hernoemen naar een bestaande naam kan niet', () => {
    const { s } = setup();
    const pot = s.bank.addAccount('Knab-potje', null);
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-09-01', amount: 100, description: 'x', counterName: 'y', ownIban: 'NL02ABNA0123456789' }] });
    expect(s.bank.getAccount(pot.id).iban).toBeNull();
    // de gewone rekening zonder nummer krijgt het nummer, niet het potje
    expect(s.bank.listAccounts().find((a) => a.iban === 'NL02ABNA0123456789')?.is_pot).toBe(0);
    const other = s.bank.addAccount('Spaarrekening', 'NL91ABNA0417164300');
    expect(() => s.bank.updateAccount(other.id, { name: 'knab-potje' })).toThrow(/al een rekening met deze naam/);
  });
});
