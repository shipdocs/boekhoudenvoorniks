import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import { AGING_BUCKETS } from '../src/documents/invoices';
import { makePdf } from './pdf';
import { amountOutlierIssue, median, OUTLIER_MIN_EXCESS } from '../src/intake/outliers';

type S = ReturnType<typeof setup>['s'];
function inv(s: S, relationId: number, date: string, amount: number, dueDate?: string) {
  return s.invoices.finalize(s.invoices.createDraft({ relationId, invoiceDate: date, dueDate, lines: [{ description: 'Werk', quantity: 1, unitPrice: amount, vatCode: 'hoog' }] }).id);
}
function bank(s: S, date: string, amount: number, name: string) {
  s.bank.import({ source: 'csv', warnings: [], transactions: [{ date, amount, description: name, counterName: name }] });
  return s.bank.list().find((t) => t.transaction_date === date && t.amount === amount && t.counter_name === name)!;
}

describe('#279 ouderdomsanalyse debiteuren', () => {
  const byKey = (s: S, asOf: string) => Object.fromEntries(s.invoices.aging(asOf).map((b) => [b.key, b]));
  it('verdeelt openstaande facturen naar dagen na de vervaldatum, op de grens precies', () => {
    const { s, klant } = setup();
    inv(s, klant.id, '2026-01-01', 10000, '2026-02-01'); // 31 dagen te laat op 5 maart? zie asOf
    inv(s, klant.id, '2026-01-02', 20000, '2026-02-02');
    inv(s, klant.id, '2026-01-03', 30000, '2026-02-03');
    inv(s, klant.id, '2026-01-04', 40000, '2026-02-04');
    inv(s, klant.id, '2026-01-05', 50000, '2026-04-30');
    const asOf = '2026-03-04'; // te laat: 31, 30, 29, 28 dagen; laatste nog niet vervallen
    const b = byKey(s, asOf);
    expect(b['31-60']!).toMatchObject({ count: 1, amount: 12100 });
    expect(b['1-30']!).toMatchObject({ count: 3, amount: (20000 + 30000 + 40000) * 1.21 });
    expect(b['op-tijd']!).toMatchObject({ count: 1, amount: 60500 });
    expect(b['61-90']!.count).toBe(0);
    expect(b['90+']!.count).toBe(0);
  });
  it('meer dan 90 dagen te laat telt apart; betaalde en tegengeboekte facturen niet', () => {
    const { s, klant } = setup();
    const a = inv(s, klant.id, '2026-01-01', 10000, '2026-01-15');
    const paid = inv(s, klant.id, '2026-01-01', 20000, '2026-01-15');
    s.invoices.registerPayment(paid.id, { amount: paid.total!, date: '2026-02-01' });
    const b = byKey(s, '2026-04-16'); // 91 dagen na 15 jan
    expect(b['90+']!).toMatchObject({ count: 1, amount: a.total });
    expect(AGING_BUCKETS.map((x) => x.key)).toEqual(['op-tijd', '1-30', '31-60', '61-90', '90+']);
  });
  it('komt mee in het dashboard', () => {
    const { s, klant } = setup();
    inv(s, klant.id, '2026-01-01', 10000, '2026-01-15');
    expect(s.dashboard.get('2026-02-20').openInvoices.aging.find((b) => b.key === '31-60')!.count).toBe(1);
  });
});

describe('#280 waarschuwing bij de factuurdatum', () => {
  it('een datum in de toekomst', () => {
    const { s } = setup();
    expect(s.invoices.dateWarnings('2026-10-05', undefined, '2026-10-04')).toHaveLength(1);
    expect(s.invoices.dateWarnings('2026-10-04', undefined, '2026-10-04')).toHaveLength(0);
  });
  it('een datum vóór de vorige definitieve factuur noemt die factuur', () => {
    const { s, klant } = setup();
    const first = inv(s, klant.id, '2026-04-01', 10000);
    const w = s.invoices.dateWarnings('2026-03-20', undefined, '2026-10-04');
    expect(w).toHaveLength(1);
    expect(w[0]).toContain(first.number!);
    expect(s.invoices.dateWarnings('2026-04-01', undefined, '2026-10-04')).toHaveLength(0);
  });
  it('de factuur zelf, een concept en een creditfactuur tellen niet als vorige', () => {
    const { s, klant } = setup();
    const first = inv(s, klant.id, '2026-04-01', 10000);
    s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-09-01', lines: [{ description: 'x', quantity: 1, unitPrice: 1, vatCode: 'hoog' }] });
    expect(s.invoices.dateWarnings('2026-03-20', first.id, '2026-10-04')).toHaveLength(0);
    expect(s.invoices.dateWarnings('2026-05-01', undefined, '2026-10-04')).toHaveLength(0);
  });
  it('een ongeldige datum geeft een fout', () => {
    const { s } = setup();
    expect(() => s.invoices.dateWarnings('2026-13-40')).toThrow();
  });
});

describe('#281 kosten tegenover vorig jaar', () => {
  const buy = (s: S, date: string, amount: number, account = 'WBedKanSof') =>
    s.purchases.create({ invoiceDate: date, description: 'Aankoop', lines: [{ account, netAmount: amount, vatCode: 'geen' }] });
  it('meldt een kostensoort die minstens de helft en € 250 afwijkt, en negeert de rest', () => {
    const { s } = setup();
    buy(s, '2025-03-01', 100000);
    buy(s, '2026-03-01', 180000); // +80% en +€ 800: opvallend
    buy(s, '2025-03-01', 100000, 'WBedAlkGer');
    buy(s, '2026-03-01', 110000, 'WBedAlkGer'); // +10%: niet
    buy(s, '2025-03-01', 5000, 'WBedAlkAdv');
    buy(s, '2026-03-01', 20000, 'WBedAlkAdv'); // +300%, maar € 150: niet
    const r = s.dashboard.costComparison('2026-06-30');
    expect(r.previousYear).toBe(2025);
    expect(r.rows.map((x) => x.rgs)).toEqual(['WBedKanSof']);
    expect(r.rows[0]).toMatchObject({ now: 180000, before: 100000, diff: 80000 });
  });
  it('vergelijkt met dezelfde dag vorig jaar, niet met het hele jaar', () => {
    const { s } = setup();
    buy(s, '2025-03-01', 100000);
    buy(s, '2025-11-01', 500000); // valt na 30 juni 2025: telt niet mee
    buy(s, '2026-03-01', 100000);
    expect(s.dashboard.costComparison('2026-06-30').rows).toHaveLength(0);
  });
  it('een nieuwe kostensoort zonder vorig jaar valt op', () => {
    const { s } = setup();
    buy(s, '2026-02-01', 90000);
    expect(s.dashboard.costComparison('2026-06-30').rows[0]).toMatchObject({ before: 0, now: 90000 });
  });
  it('29 februari rekent met 28 februari vorig jaar', () => {
    const { s } = setup();
    expect(() => s.dashboard.costComparison('2028-02-29')).not.toThrow();
  });
});

describe('#282 privé bij het afsluiten', () => {
  const prive = (s: S) => s.periods.checks('2026-09-30').find((c) => c.key === 'prive');
  it('zonder privéboekingen geen melding', () => {
    const { s } = setup();
    expect(prive(s)).toBeUndefined();
  });
  it('toont opnames, stortingen en het saldo, als ter kennisgeving', () => {
    const { s } = setup();
    s.bank.bookToAccount(bank(s, '2026-05-01', -50000, 'Privé opname').id, { account: ACCOUNTS.priveOpnamen });
    s.bank.bookToAccount(bank(s, '2026-06-01', 20000, 'Storting').id, { account: ACCOUNTS.priveStortingen });
    const c = prive(s)!;
    expect(c.level).toBe('info');
    expect(c.title).toContain('500,00');
    expect(c.title).toContain('200,00');
    expect(c.detail).toContain('300,00');
    expect(c.detail).not.toContain('Grote stortingen');
  });
  it('noemt een grote storting met de datum', () => {
    const { s } = setup();
    s.bank.bookToAccount(bank(s, '2026-06-01', 250000, 'Spaarrekening').id, { account: ACCOUNTS.priveStortingen });
    const c = prive(s)!;
    expect(c.detail).toContain('Grote stortingen');
    expect(c.detail).toContain('1 juni 2026');
    expect(c.detail).toContain('2.500,00');
  });
  it('een info-melding blokkeert het afsluiten niet', () => {
    const { s } = setup();
    s.bank.bookToAccount(bank(s, '2026-06-01', 250000, 'Spaarrekening').id, { account: ACCOUNTS.priveStortingen });
    const confirm = s.periods.checks('2026-09-30').filter((c) => c.level === 'bevestigen').map((c) => c.key);
    expect(s.periods.checks('2026-09-30').some((c) => c.level === 'blokkeert')).toBe(false);
    expect(() => s.periods.close('2026-09-30', confirm, '2026-10-04')).not.toThrow();
  });
});

describe('#283 afwijkend bedrag bij een leverancier', () => {
  it('mediaan', () => {
    expect(median([300, 100, 200])).toBe(200);
    expect(median([100, 200, 300, 400])).toBe(250);
  });
  it('te weinig geschiedenis: niets', () => {
    expect(amountOutlierIssue([10000, 10000], 500000)).toBeNull();
  });
  it('drie keer de mediaan en genoeg euro\'s erboven: waarschuwing met de gebruikelijke som', () => {
    const i = amountOutlierIssue([10000, 12000, 11000], 40000)!;
    expect(i).toMatchObject({ field: 'total', severity: 'waarschuwing', suggestion: 'afwijkend-bedrag' });
    expect(i.message).toContain('400,00');
    expect(i.message).toContain('110,00');
  });
  it('precies op de grens: factor 3 én € 100 boven de mediaan is een melding, net eronder niet', () => {
    const history = [10000, 10000, 10000];
    expect(amountOutlierIssue(history, 30000)).not.toBeNull();
    expect(amountOutlierIssue(history, 29999)).toBeNull();
    expect(amountOutlierIssue([1000, 1000, 1000], 3000)).toBeNull(); // 3x maar € 20 erboven
    expect(OUTLIER_MIN_EXCESS).toBe(10000);
  });
  it('een lager bedrag of een creditbedrag meldt niets', () => {
    expect(amountOutlierIssue([10000, 10000, 10000], 500)).toBeNull();
    expect(amountOutlierIssue([10000, 10000, 10000], -50000)).toBeNull();
  });
});

describe('#283 in de intake: een bon met een afwijkend bedrag wordt niet vanzelf geboekt', () => {
  const gamma = ['Gamma', 'Factuurnummer 77', 'Factuurdatum 01-09-2026', 'Materiaal 330,58', 'BTW 21% 330,58 69,42', 'Totaal 400,00'];
  it('met drie eerdere aankopen van € 100 krijgt € 400 de waarschuwing', async () => {
    const { s } = setup();
    const lev = s.relations.findOrCreateSupplier('Gamma');
    for (const d of ['2026-05-01', '2026-06-01', '2026-07-01']) {
      s.purchases.create({ relationId: lev.id, invoiceDate: d, description: 'Materiaal — Gamma', lines: [{ account: ACCOUNTS.inkoopMaterialen, netAmount: 8264, vatCode: 'hoog' }] });
    }
    const doc = await s.intake.add('gamma.pdf', makePdf(gamma), '2026-09-02');
    const issue = s.intake.get(doc.id).issues.find((i) => i.suggestion === 'afwijkend-bedrag');
    expect(issue?.message).toContain('400,00');
    expect(s.intake.get(doc.id).status).toBe('controle');
  });
  it('zonder eerdere aankopen geen waarschuwing', async () => {
    const { s } = setup();
    const doc = await s.intake.add('gamma.pdf', makePdf(gamma), '2026-09-02');
    expect(s.intake.get(doc.id).issues.some((i) => i.suggestion === 'afwijkend-bedrag')).toBe(false);
  });
});
