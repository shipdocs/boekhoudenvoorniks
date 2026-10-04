import { describe, expect, it } from 'vitest';
import { setup } from './helpers';

type S = ReturnType<typeof setup>['s'];
const rub = (s: S, period: string) => Object.fromEntries(s.vat.calculate(period).rubrieken.map((x) => [x.code, x]));
function invoice(s: S, relationId: number, date: string, amount = 1000_00) {
  return s.invoices.finalize(s.invoices.createDraft({ relationId, invoiceDate: date, lines: [{ description: 'Werk', quantity: 1, unitPrice: amount, vatCode: 'hoog' }] }).id);
}

describe('Oninbare facturen', () => {
  it('omzet en btw gaan terug in het tijdvak van de afschrijving (voorbeeld Belastingdienst)', () => {
    const { s, klant } = setup();
    const inv = invoice(s, klant.id, '2026-02-01');
    expect(rub(s, '2026-Q1')['1a']).toMatchObject({ omzet: 100000, btw: 21000 });
    const w = s.invoices.writeOffBadDebt(inv.id, '2026-05-01');
    expect(w.open_amount).toBe(0);
    expect(w.status).toBe('betaald');
    expect(rub(s, '2026-Q1')['1a']).toMatchObject({ omzet: 100000, btw: 21000 }); // afgesloten tijdvak blijft staan
    expect(rub(s, '2026-Q2')['1a']).toMatchObject({ omzet: -100000, btw: -21000 });
  });
  it('een deel dat nog open staat: alleen dat deel gaat terug', () => {
    const { s, klant } = setup();
    const inv = invoice(s, klant.id, '2026-02-01', 1000_00); // totaal 1210
    s.invoices.registerPayment(inv.id, { amount: 60500, date: '2026-03-01' });
    s.invoices.writeOffBadDebt(inv.id, '2026-05-01');
    expect(rub(s, '2026-Q2')['1a']).toMatchObject({ omzet: -50000, btw: -10500 });
  });
  it('alsnog betaald: de btw over dat deel opnieuw aangeven in het tijdvak van de betaling', () => {
    const { s, klant } = setup();
    const inv = invoice(s, klant.id, '2026-02-01');
    s.invoices.writeOffBadDebt(inv.id, '2026-05-01');
    s.invoices.registerPayment(inv.id, { amount: 121000, date: '2026-08-10' });
    expect(rub(s, '2026-Q3')['1a']).toMatchObject({ omzet: 100000, btw: 21000 });
    expect(s.invoices.get(inv.id).open_amount).toBe(0);
    expect(() => s.invoices.writeOffBadDebt(inv.id, '2026-09-01')).toThrow();
  });
  it('een betaalde factuur kun je niet afboeken', () => {
    const { s, klant } = setup();
    const inv = invoice(s, klant.id, '2026-02-01');
    s.invoices.registerPayment(inv.id, { amount: 121000, date: '2026-03-01' });
    expect(() => s.invoices.writeOffBadDebt(inv.id, '2026-05-01')).toThrow(/openstaat/);
  });
});

describe('Controle oninbare facturen', () => {
  const check = (s: S, period: string) => s.vat.checks(period).find((c) => c.key === 'oninbaar');
  it('signaleert een factuur een jaar na de vervaldatum, en niet meer na het afboeken', () => {
    const { s, klant } = setup();
    const inv = invoice(s, klant.id, '2025-01-10'); // vervalt 2025-02-09
    expect(check(s, '2025-Q4')).toBeUndefined();
    expect(check(s, '2026-Q1')).toMatchObject({ blocking: false, count: 1 });
    s.invoices.writeOffBadDebt(inv.id, '2026-03-31');
    expect(check(s, '2026-Q1')).toBeUndefined();
  });
  it('een inkoop die ruim een jaar onbetaald staat geeft een vraag over de voorbelasting', () => {
    const { s } = setup();
    s.purchases.create({ invoiceDate: '2025-01-10', dueDate: '2025-02-09', description: 'Hout', lines: [{ account: 'WKprInkMat', netAmount: 10000, vatCode: 'hoog', vatAmount: 2100 }] });
    expect(s.vat.checks('2026-Q2').find((c) => c.key === 'oninbaar-inkoop')).toBeDefined();
  });
});

describe('Inkoop niet betaald: voorbelasting terugnemen', () => {
  const buy = (s: S) => s.purchases.create({ invoiceDate: '2025-01-10', dueDate: '2025-02-09', description: 'Hout', lines: [{ account: 'WKprInkMat', netAmount: 100000, vatCode: 'hoog', vatAmount: 21000 }] });
  const voorbelasting = (s: S, period: string) => s.vat.calculate(period).rubrieken.find((r) => r.code === '5b')!.btw;
  it('de btw wordt kosten en de voorbelasting daalt in het tijdvak van het terugnemen', () => {
    const { s } = setup();
    const p = buy(s);
    expect(voorbelasting(s, '2025-Q1')).toBe(21000);
    s.purchases.repayInputVat(p.id, '2026-03-31');
    expect(voorbelasting(s, '2026-Q1')).toBe(-21000);
    expect(() => s.purchases.repayInputVat(p.id, '2026-03-31')).toThrow(/al teruggenomen/);
    expect(s.purchases.get(p.id).open_amount).toBe(121000); // de schuld blijft staan
  });
  it('alsnog (deels) betaald: de btw over dat deel weer aftrekken in het tijdvak van de betaling', () => {
    const { s } = setup();
    const p = buy(s);
    s.purchases.repayInputVat(p.id, '2026-03-31');
    s.purchases.registerPayment(p.id, { amount: 60500, date: '2026-05-10' });
    expect(voorbelasting(s, '2026-Q2')).toBe(10500);
    s.purchases.registerPayment(p.id, { amount: 60500, date: '2026-08-10' });
    expect(voorbelasting(s, '2026-Q3')).toBe(10500);
  });
  it('een betaalde of KOR-inkoop kun je niet terugnemen', () => {
    const { s } = setup();
    const p = buy(s);
    s.purchases.registerPayment(p.id, { amount: 121000, date: '2025-03-01' });
    expect(() => s.purchases.repayInputVat(p.id, '2026-03-31')).toThrow(/openstaat/);
  });
});
