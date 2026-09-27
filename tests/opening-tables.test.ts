import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { makeXlsx } from './fixtures/xlsx';
import { OPEN_ITEMS_TEMPLATE, cellDate } from '../src/import/opening-tables';
import type { XafPlan } from '../src/onboarding/xaf-import';

/**
 * Overzichten zonder vaste vorm uit een vorig programma of Excel: saldibalans en openstaande posten.
 * Erop slepen → voorstel; alleen als een kolom echt niet te vinden is, een vraag.
 */

function overstapper(date = '2026-01-01') {
  const ctx = setup();
  ctx.s.settings.update({ onboardingDone: true });
  ctx.s.switchover.setMode('overstapper', date);
  return ctx;
}

const plan = (r: ReturnType<ReturnType<typeof setup>['s']['xafImport']['analyzeFile']>): XafPlan => {
  if (!('plan' in r)) throw new Error(`verwacht een voorstel, kreeg vragen: ${r.questions.map((q) => q.field).join(',')}`);
  return r.plan;
};
const all = (p: XafPlan) => ({ include: p.proposals.map((x) => x.key), banks: Object.fromEntries(p.banks.map((b) => [b.accountId, b.bankAccountId ?? ('nieuw' as const)])), relations: false });

const SALDIBALANS = [
  'Proef- en saldibalans per 31-12-2025',
  'Rekening;Omschrijving;Saldo',
  '0100;Bestelbus;5.000,00',
  '0110;Afschrijving bestelbus;-2.000,00',
  '0500;Eigen vermogen;-3.400,00',
  '1002;Bank Knab;1.500,00',
  '1400;Crediteuren;-1.000,00',
  '1800;Te betalen btw;-100,00',
  'Totaal balans;;0,00',
  '4000;Brandstof;300,00',
  '8000;Omzet;-300,00',
].join('\r\n');

const LIJST = [
  'Naam;Soort;Factuurnummer;Datum;Vervaldatum;Bedrag',
  'Bakker Bouw;klant;2025-042;15-12-2025;29-12-2025;1210,00',
  'De Vries;klant;2025-043;20-12-2025;;-50,00',
  'Gamma;leverancier;F-7781;20-12-2025;03-01-2026;363,00',
  'Totaal;;;;;1523,00',
].join('\r\n');

describe('saldibalans en openstaande posten inlezen', () => {
  it('saldibalans als CSV: herkend zonder vragen, saldo per de datum in de titel', () => {
    const { s } = overstapper();
    const r = s.xafImport.analyzeFile(SALDIBALANS);
    expect(r.kind).toBe('saldibalans');
    const p = plan(r);
    expect(p.meta.endDate).toBe('2025-12-31');
    expect(p.banks.map((b) => [b.name, b.amount])).toEqual([['Bank Knab', 150_000]]);
    const byKind = (k: string) => p.proposals.filter((x) => x.input.kind === k);
    expect(byKind('bezit')[0]!.input).toMatchObject({ cost: 500_000, bookValue: 300_000 });
    expect(byKind('btw')[0]!.input).toMatchObject({ direction: 'betalen', amount: 10_000 });
    // winst-en-verlies van vorig jaar telt niet als "omzet tot nu toe"
    expect(byKind('resultaat')).toEqual([]);
    expect(p.equity).toBe(340_000);
    const state = s.xafImport.apply(SALDIBALANS, all(p));
    expect(state.position!.eigenVermogen).toBe(340_000);
    expect(state.checks.find((c) => c.key === 'eigen-vermogen')).toBeUndefined();
  });

  it('saldibalans als Excel met debet en credit, titelregels erboven', () => {
    const { s } = overstapper();
    const xlsx = makeXlsx([
      {
        name: 'Saldibalans',
        rows: [
          ['Klusbedrijf Test'],
          ['Saldibalans t/m 31-12-2025'],
          [],
          ['Grootboekrekening', 'Omschrijving', 'Debet', 'Credit'],
          ['1002', 'Bank Knab', 1500, 0],
          ['1400', 'Crediteuren', 0, 1000],
          ['0500', 'Eigen vermogen', 0, 500],
        ],
      },
    ]);
    const p = plan(s.xafImport.analyzeFile(xlsx));
    expect(p.kind).toBe('saldibalans');
    expect(p.banks[0]!.amount).toBe(150_000);
    expect(p.equity).toBe(50_000);
  });

  it('lijst met openstaande posten: losse facturen in plaats van het totaal, betaling koppelt op nummer', () => {
    const { s } = overstapper();
    const sb = plan(s.xafImport.analyzeFile(SALDIBALANS));
    s.xafImport.apply(SALDIBALANS, all(sb));
    expect(s.switchover.list().filter((i) => i.kind === 'leverancier').map((i) => i.amount)).toEqual([-100_000]);

    const r = s.xafImport.analyzeFile(LIJST);
    expect(r.kind).toBe('openstaande-posten');
    const p = plan(r);
    expect(p.proposals.map((x) => [x.input.kind, x.amount])).toEqual([
      ['klant', 121_000],
      ['schuld', -5_000],
      ['leverancier', -36_300],
    ]);
    expect(p.check).toMatch(/volgens je startbalans .*1\.000,00 \(.*637,00 verschil\)/);
    const state = s.xafImport.apply(LIJST, all(p));
    // het totaal voor leveranciers is vervangen door de rekening van Gamma
    expect(state.items.filter((i) => i.kind === 'leverancier').map((i) => i.description)).toEqual(['Rekening F-7781 Gamma']);
    expect(state.items.filter((i) => i.kind === 'klant').map((i) => i.data.kind === 'klant' && i.data.number)).toEqual(['2025-042']);

    // betaling van Bakker koppelt op factuurnummer
    const bank = s.bank.ensureDefaultAccount();
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-01-10', amount: 121_000, description: 'Factuur 2025-042', counterName: 'Bakker Bouw' }] }, { bankAccountId: bank.id });
    s.inbox.autoProcess('2026-01-12');
    expect(s.invoices.list().find((i) => i.number === '2025-042')?.status).toBe('betaald');

    // de saldibalans opnieuw inlezen: de lijst gaat voor, geen totaal erbij
    const again = s.xafImport.apply(SALDIBALANS, all(sb));
    expect(again.items.filter((i) => i.kind === 'leverancier')).toHaveLength(1);
    expect(again.items.filter((i) => i.kind === 'klant')).toHaveLength(1);
    expect(s.ledger.checkIntegrity().balanced).toBe(true);
  });

  it('onbekende kolomnaam: één vraag, en de keuze wordt onthouden', () => {
    const { s } = overstapper();
    const csv = 'Wie;Factuur;Openstaand\r\nBakker Bouw;2025-042;1210,00\r\n';
    const r = s.xafImport.analyzeFile(csv);
    expect('questions' in r && r.questions.map((q) => q.field)).toEqual(['relation']);
    const p = plan(s.xafImport.analyzeFile(csv, { mapping: { relation: 0 } }));
    expect(p.proposals[0]!.input).toMatchObject({ relationName: 'Bakker Bouw', number: '2025-042', amount: 121_000 });
    // tweede keer: meteen het voorstel
    expect('plan' in s.xafImport.analyzeFile(csv)).toBe(true);
  });

  it('het voorbeeldbestand werkt meteen', () => {
    const { s } = overstapper();
    const p = plan(s.xafImport.analyzeFile(OPEN_ITEMS_TEMPLATE));
    expect(p.proposals.map((x) => x.input.kind)).toEqual(['klant', 'leverancier']);
  });

  it('niet te herkennen: duidelijke melding met het voorbeeldbestand', () => {
    const { s } = overstapper();
    expect(() => s.xafImport.analyzeFile('a;b\r\n1;2\r\n')).toThrow(/voorbeeldbestand/);
  });

  it('titelregels met twee tekstcellen boven de echte kolomnamen', () => {
    const { s } = overstapper();
    const xlsx = makeXlsx([
      {
        name: 'Blad1',
        rows: [
          ['Klusbedrijf Test', 'Utrecht'],
          ['Saldibalans', 'per 31-12-2025'],
          ['Rekening', 'Omschrijving', 'Saldo'],
          ['1002', 'Bank Knab', 1500],
          ['0500', 'Eigen vermogen', -1500],
        ],
      },
    ]);
    const p = plan(s.xafImport.analyzeFile(xlsx));
    expect(p.kind).toBe('saldibalans');
    expect(p.banks[0]!.amount).toBe(150_000);
  });

  it('lijst zonder het woord "factuur": relatie, kenmerk en openstaand bedrag', () => {
    const { s } = overstapper();
    const r = s.xafImport.analyzeFile('Debiteur;Kenmerk;Openstaand\r\nBakker Bouw;2025-042;1210,00\r\n');
    expect(r.kind).toBe('openstaande-posten');
    expect(plan(r).proposals[0]!.input).toMatchObject({ kind: 'klant', relationName: 'Bakker Bouw', number: '2025-042', amount: 121_000 });
  });

  it('een bedrag dat de app niet kan lezen, verdwijnt niet stilletjes', () => {
    const { s } = overstapper();
    const p = plan(s.xafImport.analyzeFile('Klant;Factuurnummer;Bedrag\r\nBakker Bouw;2025-042;1210,00\r\nDe Vries;2025-043;twaalf euro\r\n'));
    expect(p.proposals).toHaveLength(1);
    expect(p.warnings).toEqual([expect.stringMatching(/1 regel heeft een bedrag .*De Vries 2025-043: "twaalf euro"/)]);
    expect(() => s.xafImport.analyzeFile('Klant;Factuurnummer;Bedrag\r\nDe Vries;2025-043;twaalf euro\r\n')).toThrow(/niet lezen/);
    expect(() => s.xafImport.analyzeFile('Rekening;Omschrijving;Saldo\r\n1002;Bank;??\r\n')).toThrow(/rekening 1002 .*niet lezen/);
  });

  it('na een lijst: het totaal uit een overzicht niet, andere losse posten wel', () => {
    const { s } = overstapper();
    const lijst = 'Naam;Soort;Factuurnummer;Bedrag\r\nGamma;leverancier;F-7781;363,00\r\nDe Vries;klant;2025-043;-50,00\r\n';
    s.xafImport.apply(lijst, all(plan(s.xafImport.analyzeFile(lijst))));
    const sb = [
      'Saldibalans per 31-12-2025',
      'Rekening;Omschrijving;Saldo',
      '1002;Bank Knab;1.500,00',
      '1400;Crediteuren;-363,00',
      '1300;Debiteuren;500,00',
      '1900;Overige schulden;-200,00',
    ].join('\r\n');
    const state = s.xafImport.apply(sb, all(plan(s.xafImport.analyzeFile(sb))));
    // leveranciers: de lijst gaat voor het totaal
    expect(state.items.filter((i) => i.kind === 'leverancier').map((i) => i.description)).toEqual(['Rekening F-7781 Gamma']);
    // klanten staan niet op de lijst: het totaal komt er wel in, en een overige schuld ook
    expect(state.items.filter((i) => i.kind === 'klant')).toHaveLength(1);
    expect(state.items.filter((i) => i.kind === 'schuld').map((i) => i.amount).sort()).toEqual([-20_000, -5_000]);
  });

  it('datums uit een cel, ook als Excel-getal', () => {
    expect(cellDate('15-12-2025')).toBe('2025-12-15');
    expect(cellDate('2025-12-15')).toBe('2025-12-15');
    expect(cellDate('46006')).toBe('2025-12-15');
    expect(cellDate('31-02-2025')).toBeNull();
  });
});
