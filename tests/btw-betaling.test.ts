import { describe, expect, it } from 'vitest';
import { setup } from './helpers';

describe('btw-aangifte: betalingskenmerk en bedrag vastleggen (#322)', () => {
  it('zonder kenmerk staat er niets; na het indienen kun je beide invullen en terugzien', () => {
    const { s } = setup();
    s.vat.markSubmitted('2026-Q3', { alreadyFiled: true });
    expect(s.vat.calculate('2026-Q3').payment).toBeNull();
    const r = s.vat.setPayment('2026-Q3', { reference: '1234 5678-9012 3456', amount: 12345 });
    expect(r.payment).toEqual({ reference: '1234567890123456', amount: 12345 });
    expect(s.vat.calculate('2026-Q3').payment).toEqual({ reference: '1234567890123456', amount: 12345 });
  });
  it('beide zijn optioneel en te wissen; alleen een bedrag of alleen een kenmerk mag', () => {
    const { s } = setup();
    s.vat.markSubmitted('2026-Q3', { alreadyFiled: true });
    expect(s.vat.setPayment('2026-Q3', { amount: 500 }).payment).toEqual({ reference: null, amount: 500 });
    expect(s.vat.setPayment('2026-Q3', { reference: '1234567890123456' }).payment).toEqual({ reference: '1234567890123456', amount: null });
    expect(s.vat.setPayment('2026-Q3', { reference: '', amount: null }).payment).toBeNull();
  });
  it('weigert een kenmerk dat geen 16 cijfers is en een negatief of kommagetal als bedrag', () => {
    const { s } = setup();
    s.vat.markSubmitted('2026-Q3', { alreadyFiled: true });
    expect(() => s.vat.setPayment('2026-Q3', { reference: '12345' })).toThrow(/16 cijfers/);
    expect(() => s.vat.setPayment('2026-Q3', { reference: '123456789012345A' })).toThrow(/16 cijfers/);
    expect(() => s.vat.setPayment('2026-Q3', { amount: -1 })).toThrow(/bedrag/);
    expect(() => s.vat.setPayment('2026-Q3', { amount: 10.5 })).toThrow(/bedrag/);
    expect(s.vat.calculate('2026-Q3').payment).toBeNull();
  });
  it('kan alleen bij een ingediende aangifte', () => {
    const { s } = setup();
    expect(() => s.vat.setPayment('2026-Q3', { reference: '1234567890123456' })).toThrow(/nadat je de aangifte/);
  });
  it('verandert niets aan de boekhouding: geen extra boeking', () => {
    const { s, db } = setup();
    s.vat.markSubmitted('2026-Q3', { alreadyFiled: true });
    const aantal = () => (db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get() as { n: number }).n;
    const voor = aantal();
    s.vat.setPayment('2026-Q3', { reference: '1234567890123456', amount: 100 });
    expect(aantal()).toBe(voor);
  });
  it('opnieuw openen van de periode wist het kenmerk', () => {
    const { s } = setup();
    s.vat.markSubmitted('2026-Q3', { alreadyFiled: true });
    s.vat.setPayment('2026-Q3', { reference: '1234567890123456', amount: 100 });
    s.vat.reopen('2026-Q3');
    expect(s.vat.calculate('2026-Q3').payment).toBeNull();
    s.vat.markSubmitted('2026-Q3', { alreadyFiled: true });
    expect(s.vat.calculate('2026-Q3').payment).toBeNull();
  });
});
