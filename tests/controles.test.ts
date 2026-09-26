import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { ACCOUNTS } from '../src/core-ledger/accounts';

const MAIN = 'NL91ABNA0417164300';
const SPAAR = 'NL44RABO0123456789';

function withAccounts() {
  const { s } = setup();
  s.settings.update({ onboardingDone: true, autopilot: 'voorzichtig' });
  s.bank.updateAccount(s.bank.ensureDefaultAccount().id, { iban: MAIN });
  const main = s.bank.ensureDefaultAccount();
  const spaar = s.bank.addAccount('Spaarrekening', SPAAR);
  const tx = (accountId: number, date: string, amount: number, counterIban: string) => {
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date, amount, description: 'Overboeking', counterIban, counterName: 'Piet' }] }, { bankAccountId: accountId });
    return s.bank.list({ bankAccountId: accountId })[0]!;
  };
  const keys = (period: string) => s.vat.checks(period).map((c) => c.key);
  return { s, main, spaar, tx, keys };
}

describe('controles: tussenrekeningen en negatieve spaarrekening', () => {
  it('geld "onderweg" tussen eigen rekeningen wordt gemeld tot de andere kant er is', () => {
    const { s, main, spaar, tx, keys } = withAccounts();
    const a = tx(main.id, '2026-05-02', -40000, SPAAR);
    s.bank.bookToAccount(a.id, { account: ACCOUNTS.kruisposten });
    const check = s.vat.checks('2026-Q2').find((c) => c.key === 'onderweg')!;
    expect(check.blocking).toBe(false);
    expect(check.title).toMatch(/400,00 staat nog "onderweg"/);
    const b = tx(spaar.id, '2026-05-03', 40000, MAIN);
    s.bank.bookOwnTransfer(b.id);
    expect(keys('2026-Q2')).not.toContain('onderweg');
  });

  it('geld van de betaalprovider dat nog niet op de bank staat', () => {
    const { s, main, tx, keys } = withAccounts();
    const a = tx(main.id, '2026-05-02', 12100, 'NL02ABNA0123456789');
    s.bank.bookToAccount(a.id, { account: ACCOUNTS.tussenrekeningPsp });
    expect(keys('2026-Q2')).toContain('psp');
  });

  it('een spaarrekening onder nul: er mist een afschrift of beginsaldo', () => {
    const { s, spaar, tx, keys } = withAccounts();
    const b = tx(spaar.id, '2026-05-03', -25000, MAIN);
    s.bank.bookOwnTransfer(b.id);
    const check = s.vat.checks('2026-Q2').find((c) => c.key === `rekening-negatief-${spaar.id}`)!;
    expect(check.title).toMatch(/Spaarrekening staat op/);
    expect(check.blocking).toBe(false);
    s.bank.setOpeningBalance(spaar.id, 100000, '2026-01-01');
    expect(keys('2026-Q2')).not.toContain(`rekening-negatief-${spaar.id}`);
  });

  it('de gewone (eerste) rekening mag rood staan', () => {
    const { s, main, tx, keys } = withAccounts();
    const a = tx(main.id, '2026-05-02', -50000, SPAAR);
    s.bank.bookOwnTransfer(a.id);
    expect(keys('2026-Q2').filter((k) => k.startsWith('rekening-negatief'))).toEqual([]);
  });
});

describe('btw over privégebruik van de auto van de zaak', () => {
  it('alleen in de laatste aangifte van het jaar; eerst vragen als het nog niet is ingevuld', () => {
    const { s, keys } = withAccounts();
    s.settings.update({ carUse: 'zakelijk' });
    expect(keys('2026-Q3')).not.toContain('auto-prive');
    const check = s.vat.checks('2026-Q4').find((c) => c.key === 'auto-prive')!;
    expect(check.blocking).toBe(true);
    expect(check.screen).toBe('instellingen');
    expect(() => s.vat.bookCarPrivateUse('2026-Q4')).toThrow(/cataloguswaarde/);
  });

  it('2,7% van de cataloguswaarde in vak 1d; één knop neemt het op', () => {
    const { s } = withAccounts();
    s.settings.update({ carUse: 'zakelijk', carPrivateUse: true, carCatalogValue: 40000_00, carInUseSince: 2024 });
    const check = s.vat.checks('2026-Q4').find((c) => c.key === 'auto-prive')!;
    expect(check.title).toMatch(/1\.080,00/);
    expect(check.action?.id).toBe('auto-prive');
    const before = s.vat.calculate('2026-Q4').summary.teBetalen;
    const r = s.vat.bookCarPrivateUse('2026-Q4');
    expect(r.rubrieken.find((x) => x.code === '1d')).toMatchObject({ btw: 1080_00, btwEuro: 1080 });
    expect(r.summary.btwPrive).toBe(1080_00);
    expect(r.summary.teBetalen - before).toBe(1080_00);
    expect(s.vat.checks('2026-Q4').map((c) => c.key)).not.toContain('auto-prive');
    // kosten voor de winst, niet privé
    expect(s.ledger.balance(ACCOUNTS.btwPriveAuto)).toBe(1080_00);
    // aangifte indienen boekt 1d over naar "af te dragen"
    s.vat.markSubmitted('2026-Q4');
    expect(s.ledger.balance(ACCOUNTS.btwPriveGebruik)).toBe(0);
  });

  it('andere cataloguswaarde: opnieuw opnemen vervangt het oude bedrag', () => {
    const { s } = withAccounts();
    s.settings.update({ carUse: 'zakelijk', carPrivateUse: true, carCatalogValue: 40000_00, carInUseSince: 2024 });
    s.vat.bookCarPrivateUse('2026-Q4');
    s.settings.update({ carCatalogValue: 50000_00 });
    const check = s.vat.checks('2026-Q4').find((c) => c.key === 'auto-prive')!;
    expect(check.action?.label).toBe('Bedrag bijwerken');
    s.vat.bookCarPrivateUse('2026-Q4');
    expect(s.vat.calculate('2026-Q4').summary.btwPrive).toBe(1350_00);
  });

  it('vanaf het 5e jaar na ingebruikname 1,5%; per maand is december de laatste aangifte', () => {
    const { s } = withAccounts();
    s.settings.update({ vatPeriod: 'maand', carUse: 'zakelijk', carPrivateUse: true, carCatalogValue: 40000_00, carInUseSince: 2021 });
    expect(s.vat.checks('2026-11').map((c) => c.key)).not.toContain('auto-prive');
    expect(s.vat.checks('2026-12').find((c) => c.key === 'auto-prive')?.title).toMatch(/600,00/);
  });

  it('geen privégebruik of KOR: geen correctie', () => {
    const { s, keys } = withAccounts();
    s.settings.update({ carUse: 'zakelijk', carPrivateUse: false });
    expect(keys('2026-Q4')).not.toContain('auto-prive');
    s.settings.update({ carPrivateUse: true, carCatalogValue: 30000_00, kor: true });
    expect(keys('2026-Q4')).not.toContain('auto-prive');
  });

  it('in het jaaroverzicht staat een notitie voor de boekhouder', () => {
    const { s } = withAccounts();
    s.settings.update({ carUse: 'zakelijk', carPrivateUse: true, carCatalogValue: 40000_00, carInUseSince: 2026 });
    const item = s.taxOverview.year(2026, '2026-12-31').items.find((i) => i.key === 'auto-prive')!;
    expect(item.forAccountant).toBe(true);
    expect(item.note).toMatch(/naar rato/);
    expect(item.status).toBe('warn');
  });
});
