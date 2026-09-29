import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { ACCOUNTS } from '../src/core-ledger/accounts';

const bal = (s: ReturnType<typeof setup>['s'], rgs: string) => s.ledger.balance(rgs);

describe('zakelijk deel (gemengd gebruik)', () => {
  it('standaard is alles zakelijk: niets verandert', () => {
    const { s } = setup();
    const rel = s.relations.findOrCreateSupplier('Dropbox');
    const p = s.purchases.create({ relationId: rel.id, invoiceDate: '2026-02-01', description: 'Dropbox', lines: [{ account: 'WBedKanSof', netAmount: 10000, vatCode: 'hoog' }] });
    expect(p).toMatchObject({ subtotal: 10000, vat_total: 2100, total: 12100 });
    expect(bal(s, 'WBedKanSof')).toBe(10000);
    expect(bal(s, ACCOUNTS.btwVoorbelasting)).toBe(2100);
    expect(bal(s, ACCOUNTS.priveOpnamen)).toBe(0);
  });

  it('50% zakelijk: helft kosten en btw, andere helft naar privé; de factuur blijft compleet', () => {
    const { s } = setup();
    const rel = s.relations.findOrCreateSupplier('Dropbox');
    const p = s.purchases.create({ relationId: rel.id, invoiceDate: '2026-02-01', description: 'Dropbox', lines: [{ account: 'WBedKanSof', netAmount: 10000, vatCode: 'hoog' }], businessPct: 50 });
    expect(p).toMatchObject({ subtotal: 10000, vat_total: 2100, total: 12100 });
    expect(bal(s, 'WBedKanSof')).toBe(5000);
    expect(bal(s, ACCOUNTS.btwVoorbelasting)).toBe(1050);
    expect(bal(s, ACCOUNTS.priveOpnamen)).toBe(6050);
    expect(bal(s, ACCOUNTS.crediteuren)).toBe(-12100);
    expect(s.ledger.checkIntegrity()).toMatchObject({ balanced: true });
    expect(s.vat.calculate('2026-Q1').summary.voorbelasting).toBe(1050);
  });

  it('onthoudt het percentage per leverancier voor de volgende aankoop', () => {
    const { s } = setup();
    const rel = s.relations.findOrCreateSupplier('Dropbox');
    s.purchases.create({ relationId: rel.id, invoiceDate: '2026-02-01', description: 'Dropbox', lines: [{ account: 'WBedKanSof', netAmount: 10000, vatCode: 'hoog' }], businessPct: 50 });
    s.purchases.create({ relationId: rel.id, invoiceDate: '2026-03-01', description: 'Dropbox', lines: [{ account: 'WBedKanSof', netAmount: 10000, vatCode: 'hoog' }] });
    expect(bal(s, 'WBedKanSof')).toBe(10000);
    // 100% opgeven haalt de afspraak weer weg
    s.purchases.create({ relationId: rel.id, invoiceDate: '2026-04-01', description: 'Dropbox', lines: [{ account: 'WBedKanSof', netAmount: 10000, vatCode: 'hoog' }], businessPct: 100 });
    s.purchases.create({ relationId: rel.id, invoiceDate: '2026-05-01', description: 'Dropbox', lines: [{ account: 'WBedKanSof', netAmount: 10000, vatCode: 'hoog' }] });
    expect(bal(s, 'WBedKanSof')).toBe(5000 + 5000 + 10000 + 10000);
  });

  it('een betaling van de bank volgt hetzelfde: het privédeel gaat naar privé', () => {
    const { s } = setup();
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-02-01', amount: -12100, description: 'Card Payment: Dropbox', counterName: 'Dropbox' }] });
    const t = s.bank.list()[0]!;
    s.bank.bookToAccount(t.id, { account: 'WBedKanSof', vatCode: 'hoog', businessPct: 40 });
    expect(bal(s, 'WBedKanSof')).toBe(4000);
    expect(bal(s, ACCOUNTS.btwVoorbelasting)).toBe(840);
    expect(bal(s, ACCOUNTS.priveOpnamen)).toBe(12100 - 4840);
    expect(s.ledger.checkIntegrity()).toMatchObject({ balanced: true });
    // de volgende betaling van dezelfde partij krijgt het percentage vanzelf
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-03-01', amount: -12100, description: 'Card Payment: Dropbox', counterName: 'DROPBOX' }] });
    const t2 = s.bank.list().find((x) => x.status === 'nieuw')!;
    s.bank.bookToAccount(t2.id, { account: 'WBedKanSof', vatCode: 'hoog' });
    expect(bal(s, 'WBedKanSof')).toBe(8000);
  });

  it('verlegde btw: alleen het zakelijke deel wordt aangegeven en afgetrokken', () => {
    const { s } = setup();
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-02-01', amount: -10000, description: 'Anthropic', counterName: 'Anthropic' }] });
    const t = s.bank.list()[0]!;
    s.bank.bookToAccount(t.id, { account: 'WBedKanSof', vatCode: 'buiten-eu', businessPct: 50 });
    expect(bal(s, 'WBedKanSof')).toBe(5000);
    expect(bal(s, ACCOUNTS.priveOpnamen)).toBe(5000);
    const r = s.vat.calculate('2026-Q1');
    expect(r.summary).toMatchObject({ btwVerlegd: 1050, voorbelasting: 1050, teBetalen: 0 });
    expect(s.ledger.checkIntegrity()).toMatchObject({ balanced: true });
  });

  it('achteraf ander percentage: tegenboeking en nieuwe post, saldi kloppen', () => {
    const { s } = setup();
    const rel = s.relations.findOrCreateSupplier('Dropbox');
    const p = s.purchases.create({ relationId: rel.id, invoiceDate: '2026-02-01', description: 'Dropbox', lines: [{ account: 'WBedKanSof', netAmount: 10000, vatCode: 'hoog' }] });
    s.purchases.setBusinessPct(p.id, 25);
    expect(bal(s, 'WBedKanSof')).toBe(2500);
    expect(bal(s, ACCOUNTS.btwVoorbelasting)).toBe(525);
    expect(s.purchases.get(p.id)).toMatchObject({ total: 12100, vat_total: 2100 });
    s.purchases.setBusinessPct(p.id, 100);
    expect(bal(s, 'WBedKanSof')).toBe(10000);
    expect(bal(s, ACCOUNTS.priveOpnamen)).toBe(0);
  });

  it('weigert een onmogelijk percentage', () => {
    const { s } = setup();
    const rel = s.relations.findOrCreateSupplier('X');
    for (const bad of [0, 101, 12.5, -5]) {
      expect(() => s.purchases.create({ relationId: rel.id, invoiceDate: '2026-02-01', description: 'x', lines: [{ account: 'WBedKanSof', netAmount: 100, vatCode: 'hoog' }], businessPct: bad })).toThrow();
    }
  });
});

describe('zakelijk deel: toepassen en vragen', () => {
  it('"ook eerdere boekingen": bestaande uitgaven van deze leverancier worden opnieuw geboekt', () => {
    const { s } = setup();
    const rel = s.relations.findOrCreateSupplier('Dropbox');
    s.purchases.create({ relationId: rel.id, invoiceDate: '2026-02-01', description: 'Dropbox', lines: [{ account: 'WBedKanSof', netAmount: 10000, vatCode: 'hoog' }] });
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-03-01', amount: -12100, description: 'Card Payment: Dropbox', counterName: 'Dropbox' }] });
    s.bank.bookToAccount(s.bank.list()[0]!.id, { account: 'WBedKanSof', vatCode: 'hoog' });
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-03-02', amount: -5000, description: 'Ander', counterName: 'Gamma' }] });
    s.bank.bookToAccount(s.bank.list().find((t) => t.status === 'nieuw')!.id, { account: 'WBedKanSof', vatCode: 'hoog' });
    expect(bal(s, 'WBedKanSof')).toBe(10000 + 10000 + 4132);

    const r = s.businessShare.set('Dropbox', 50, { applyExisting: true });
    expect(r).toMatchObject({ pct: 50, changed: 2, skipped: 0 });
    // alleen Dropbox is de helft geworden; Gamma niet
    expect(bal(s, 'WBedKanSof')).toBe(5000 + 5000 + 4132);
    expect(s.ledger.checkIntegrity()).toMatchObject({ balanced: true });
    // nog een keer is niets nieuws
    expect(s.businessShare.apply('Dropbox')).toEqual({ changed: 0, skipped: 0 });
    // terug naar 100%
    expect(s.businessShare.set('Dropbox', 100, { applyExisting: true })).toMatchObject({ pct: 100, changed: 2 });
    expect(bal(s, 'WBedKanSof')).toBe(10000 + 10000 + 4132);
    expect(s.businessShare.list()).toEqual([]);
  });

  it('een al ingediende periode: het verschil komt als correctie in de volgende aangifte', () => {
    const { s } = setup();
    const rel = s.relations.findOrCreateSupplier('Dropbox');
    s.purchases.create({ relationId: rel.id, invoiceDate: '2026-02-01', description: 'Dropbox', lines: [{ account: 'WBedKanSof', netAmount: 10000, vatCode: 'hoog' }] });
    s.vat.markSubmitted('2026-Q1', { alreadyFiled: true });
    s.businessShare.set('Dropbox', 50, { applyExisting: true });
    expect(s.vat.corrections()).toMatchObject([{ periodKey: '2026-Q1', btw: 1050 }]);
  });

  it('de inbox-vraag geeft het percentage door aan de boeking', () => {
    const { s } = setup();
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-02-01', amount: -12100, description: 'Card Payment: Dropbox', counterName: 'Dropbox' }] });
    const t = s.bank.list()[0]!;
    s.inbox.answerBank(t.id, { business: true, categoryKey: 'software', vatCode: 'hoog', businessPct: 60 });
    expect(bal(s, 'WBedKanSof')).toBe(6000);
    expect(bal(s, ACCOUNTS.priveOpnamen)).toBe(12100 - 6000 - 1260);
    expect(s.businessShare.get('dropbox')).toBe(60);
  });
});
