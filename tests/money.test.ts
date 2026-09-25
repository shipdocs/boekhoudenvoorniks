import { describe, expect, it } from 'vitest';
import { parseEuro, formatEuro, centsToDecimalString, roundHalfAwayFromZero } from '../src/shared/money';
import { isValidIban } from '../src/shared/validation';
import { periodFor, periodFromKey, addDays } from '../src/shared/dates';

describe('money', () => {
  it.each([
    ['12,50', 1250],
    ['1.234,56', 123456],
    ['1,234.56', 123456],
    ['-7,5', -750],
    ['€ 100', 10000],
    ['0.1', 10],
    ['25.00-', -2500],
    ['(3,00)', -300],
    ['+4,99', 499],
    ['1.000.000', 100000000],
    [12.345, 1235],
  ])('parseEuro(%s) = %i', (input, expected) => {
    expect(parseEuro(input as string)).toBe(expected);
  });

  it('weigert onzin', () => {
    expect(() => parseEuro('abc')).toThrow();
    expect(() => parseEuro('')).toThrow();
  });

  it('rondt commercieel af', () => {
    expect(roundHalfAwayFromZero(0.5)).toBe(1);
    expect(roundHalfAwayFromZero(-0.5)).toBe(-1);
    expect(roundHalfAwayFromZero(1.005 * 100)).toBe(101); // float-artefact 100.49999…
    expect(roundHalfAwayFromZero(100.4999)).toBe(100);
  });

  it('formatteert', () => {
    expect(centsToDecimalString(-5)).toBe('-0.05');
    expect(formatEuro(123456)).toMatch(/1\.234,56/);
  });

  it('controleert IBAN', () => {
    expect(isValidIban('NL91 ABNA 0417 1643 00')).toBe(true);
    expect(isValidIban('NL91ABNA0417164301')).toBe(false);
  });

  it('periodes', () => {
    expect(periodFor('2026-08-15', 'kwartaal')).toMatchObject({ key: '2026-Q3', start: '2026-07-01', end: '2026-09-30' });
    expect(periodFor('2024-02-10', 'maand').end).toBe('2024-02-29');
    expect(periodFromKey('2026-Q1').end).toBe('2026-03-31');
    expect(addDays('2026-12-25', 14)).toBe('2027-01-08');
  });
});
