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
    s.settings.update({ carUse: 'zakelijk', carPrivateUse: true, carVatDeducted: true, carVatMethod: 'forfait', carCatalogValue: 40000_00, carInUseSince: 2024 });
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
    s.settings.update({ carUse: 'zakelijk', carPrivateUse: true, carVatDeducted: true, carVatMethod: 'forfait', carCatalogValue: 40000_00, carInUseSince: 2024 });
    s.vat.bookCarPrivateUse('2026-Q4');
    s.settings.update({ carCatalogValue: 50000_00 });
    const check = s.vat.checks('2026-Q4').find((c) => c.key === 'auto-prive')!;
    expect(check.action?.label).toBe('Bedrag bijwerken');
    s.vat.bookCarPrivateUse('2026-Q4');
    expect(s.vat.calculate('2026-Q4').summary.btwPrive).toBe(1350_00);
  });

  it('vanaf het 5e jaar na ingebruikname 1,5%; per maand is december de laatste aangifte', () => {
    const { s } = withAccounts();
    s.settings.update({ vatPeriod: 'maand', carUse: 'zakelijk', carPrivateUse: true, carVatDeducted: true, carVatMethod: 'forfait', carCatalogValue: 40000_00, carInUseSince: 2021 });
    expect(s.vat.checks('2026-11').map((c) => c.key)).not.toContain('auto-prive');
    expect(s.vat.checks('2026-12').find((c) => c.key === 'auto-prive')?.title).toMatch(/600,00/);
  });

  it('geen privégebruik of KOR: geen correctie', () => {
    const { s, keys } = withAccounts();
    s.settings.update({ carUse: 'zakelijk', carPrivateUse: false });
    expect(keys('2026-Q4')).not.toContain('auto-prive');
    s.settings.update({ carPrivateUse: true, carVatDeducted: true, carVatMethod: 'forfait', carCatalogValue: 30000_00, kor: true });
    expect(keys('2026-Q4')).not.toContain('auto-prive');
  });

  it('in het jaaroverzicht staat een notitie voor de boekhouder', () => {
    const { s } = withAccounts();
    s.settings.update({ carUse: 'zakelijk', carPrivateUse: true, carVatDeducted: true, carVatMethod: 'forfait', carCatalogValue: 40000_00, carInUseSince: 2026 });
    // eerste jaar zonder maand: eerst vragen
    expect(s.vat.checks('2026-Q4').find((c) => c.key === 'auto-prive')?.screen).toBe('instellingen');
    s.settings.update({ carInUseMonth: 7 });
    expect(s.vat.checks('2026-Q4').find((c) => c.key === 'auto-prive')?.title).toMatch(/540,00/);
    const item = s.taxOverview.year(2026, '2026-12-31').items.find((i) => i.key === 'auto-prive')!;
    expect(item.forAccountant).toBe(true);
    expect(item.note).toMatch(/naar rato over 6 maanden/);
    expect(item.status).toBe('warn');
  });

  it('jaaroverzicht: "geboekt" alleen als de eigen correctie met het juiste bedrag er staat', () => {
    const { s } = withAccounts();
    s.settings.update({ carUse: 'zakelijk', carPrivateUse: true, carVatDeducted: true, carVatMethod: 'forfait', carCatalogValue: 40000_00, carInUseSince: 2024 });
    const status = () => s.taxOverview.year(2026, '2026-12-31').items.find((i) => i.key === 'auto-prive')!.status;
    // een losse boeking op dezelfde kostenrekening telt niet als de correctie
    s.ledger.post({ date: '2026-06-01', description: 'iets anders', source: 'handmatig', lines: [{ account: ACCOUNTS.btwPriveAuto, debit: 1080_00, credit: 0 }, { account: ACCOUNTS.priveStortingen, debit: 0, credit: 1080_00 }] });
    expect(status()).toBe('warn');
    s.vat.bookCarPrivateUse('2026-Q4');
    expect(status()).toBe('ok');
    s.settings.update({ carCatalogValue: 50000_00 });
    expect(status()).toBe('warn');
  });
});

describe('btw-berekening: waar komt een bedrag vandaan?', () => {
  it('omzet zonder factuur (van de bank) is terug te vinden en telt op tot het vak', () => {
    const { s, main, tx } = withAccounts();
    const t = tx(main.id, '2026-05-02', 12100, 'NL02ABNA0123456789');
    s.bank.bookToAccount(t.id, { account: ACCOUNTS.omzetHoog, vatCode: 'hoog', description: 'Contant/pin' });
    const r = s.vat.calculate('2026-Q2');
    const d = s.vat.rubriekDetails('2026-Q2', '1a');
    expect(d.omzet).toBe(r.rubrieken.find((x) => x.code === '1a')!.omzet);
    expect(d.btw).toBe(r.rubrieken.find((x) => x.code === '1a')!.btw);
    expect(d.lines).toHaveLength(1);
    expect(d.lines[0]).toMatchObject({ source: 'bank', bankTransactionId: t.id, invoiceId: null, omzet: 10000, btw: 2100 });
    expect(s.vat.rubriekDetails('2026-Q2', 'omzet').omzet).toBe(r.summary.omzet);
    // ongedaan maken: boeking en tegenboeking heffen elkaar op
    s.bank.unmatch(t.id, '2026-05-03');
    const after = s.vat.rubriekDetails('2026-Q2', '1a');
    expect(after.omzet).toBe(0);
    expect(after.lines.every((l) => l.reversed || l.reversal)).toBe(true);
    expect(() => s.vat.rubriekDetails('2026-Q2', 'x')).toThrow(/Onbekend vak/);
  });

  it('btw die naar jou is verlegd (2a + 4a + 4b) telt op tot de regel bovenaan', () => {
    const { s, main, tx } = withAccounts();
    const us = tx(main.id, '2026-05-06', -2000, 'NL02ABNA0123456789');
    s.bank.bookToAccount(us.id, { account: 'WBedKanSof', vatCode: 'buiten-eu' });
    const ie = tx(main.id, '2026-05-07', -1000, 'NL44RABO0123456789');
    s.bank.bookToAccount(ie.id, { account: 'WBedKanSof', vatCode: 'eu' });
    const r = s.vat.calculate('2026-Q2');
    const d = s.vat.rubriekDetails('2026-Q2', 'verlegd');
    expect(d.btw).toBe(r.summary.btwVerlegd);
    expect(d.btw).toBe(420 + 210);
    expect(d.omzet).toBe(3000); // de aankopen
    expect(d.lines.map((l) => l.bankTransactionId).sort()).toEqual([us.id, ie.id].sort());
  });

  it('factuur en voorbelasting', () => {
    const { s } = withAccounts();
    const klant = s.relations.list()[0]!;
    const inv = s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-05-10', lines: [{ description: 'Werk', quantity: 1, unitPrice: 10000, vatCode: 'hoog' }] }).id);
    expect(s.vat.rubriekDetails('2026-Q2', '1a').lines[0]).toMatchObject({ source: 'factuur', invoiceId: inv.id, counterparty: klant.name });
    s.quick.recordExpense({ date: '2026-05-02', supplierName: 'Gamma', description: '', categoryKey: 'materiaal', grossAmount: 12100, vatCode: 'hoog', paidWith: 'kas' });
    const v = s.vat.rubriekDetails('2026-Q2', '5b');
    expect(v.btw).toBe(s.vat.calculate('2026-Q2').summary.voorbelasting);
    expect(v.lines[0]!.purchaseId).not.toBeNull();
    // zonder foto of PDF: geen bon om te openen (dan gaat "Bekijken" naar de aankopen)
    expect(v.lines[0]!.attachmentPath).toBeNull();
    s.db.prepare('UPDATE purchase_invoices SET attachment_path = ? WHERE id = ?').run('/tmp/bon.pdf', v.lines[0]!.purchaseId);
    expect(s.vat.rubriekDetails('2026-Q2', '5b').lines[0]!.attachmentPath).toBe('/tmp/bon.pdf');
  });
});

describe('controle "weet ik nog niet": welke betalingen zijn het?', () => {
  it('de boekingen op de rekening tellen op tot het bedrag; opnieuw indelen haalt ze weg', () => {
    const { s, main, tx } = withAccounts();
    const a = tx(main.id, '2026-05-02', -12100, 'NL02ABNA0123456789');
    const b = tx(main.id, '2026-05-03', -5000, 'NL02ABNA0123456789');
    s.bank.bookToAccount(a.id, { account: ACCOUNTS.vraagposten });
    s.bank.bookToAccount(b.id, { account: ACCOUNTS.vraagposten });
    const check = s.vat.checks('2026-Q2').find((c) => c.key === 'vraagposten')!;
    expect(check.account).toEqual({ rgs: ACCOUNTS.vraagposten });
    const r = s.vat.accountLines(ACCOUNTS.vraagposten);
    expect(r.total).toBe(s.ledger.balance(ACCOUNTS.vraagposten));
    expect(r.lines.map((l) => l.bankTransactionId)).toEqual([a.id, b.id]);
    // de eerste terugdraaien en goed indelen: verdwijnt uit de lijst (boeking + tegenboeking tellen niet)
    s.bank.unmatch(a.id, '2026-05-10');
    s.inbox.answerBank(a.id, { business: true, categoryKey: 'materiaal' });
    const after = s.vat.accountLines(ACCOUNTS.vraagposten);
    expect(after.lines.map((l) => l.bankTransactionId)).toEqual([b.id]);
    expect(after.total).toBe(s.ledger.balance(ACCOUNTS.vraagposten));
  });

  it('geld onderweg: alleen tot het einde van de periode', () => {
    const { s, main, tx } = withAccounts();
    s.bank.bookToAccount(tx(main.id, '2026-06-30', -40000, SPAAR).id, { account: ACCOUNTS.kruisposten });
    s.bank.bookToAccount(tx(main.id, '2026-07-02', -1000, SPAAR).id, { account: ACCOUNTS.kruisposten });
    const check = s.vat.checks('2026-Q2').find((c) => c.key === 'onderweg')!;
    const r = s.vat.accountLines(check.account!.rgs, check.account!.upTo);
    expect(r.lines).toHaveLength(1);
    expect(r.total).toBe(40000);
  });
});
