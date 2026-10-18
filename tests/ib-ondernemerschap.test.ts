import { describe, expect, it } from 'vitest';
import { setup } from './helpers';


describe('IB-schatting: ondernemerschap en rechtsvorm', () => {
  const sale = (s: ReturnType<typeof setup>['s'], klantId: number) => s.invoices.finalize(s.invoices.createDraft({ relationId: klantId, invoiceDate: '2026-03-01', lines: [{ description: 'Werk', quantity: 1, unitPrice: 4000000, vatCode: 'hoog' }] }).id);
  it('zonder bevestiging staat er een veronderstelling bij de schatting', () => {
    const { s, klant } = setup();
    sale(s, klant.id);
    const e = s.incomeTax.estimate('2026-06-30')!;
    expect(e.assumptions.join(' ')).toContain('ondernemer voor de inkomstenbelasting');
    expect(e.assumptions.join(' ')).toContain('rechtsvorm');
    s.settings.update({ ibConfirmed: true, legalForm: 'eenmanszaak' });
    expect(s.incomeTax.estimate('2026-06-30')!.assumptions).toEqual([]);
  });
  it('een bv krijgt geen schatting inkomstenbelasting', () => {
    const { s } = setup();
    s.settings.update({ legalForm: 'bv' });
    expect(s.incomeTax.estimate('2026-06-30')).toBeNull();
  });
  it('vof: de schatting rekent met jouw deel van de winst', () => {
    const { s, klant } = setup();
    sale(s, klant.id);
    s.settings.update({ ibConfirmed: true, legalForm: 'eenmanszaak' });
    const full = s.incomeTax.estimate('2026-06-30')!;
    s.settings.update({ legalForm: 'vof', profitSharePct: 50 });
    const half = s.incomeTax.estimate('2026-06-30')!;
    expect(half.profitToDate).toBe(Math.round(full.profitToDate / 2));
    expect(half.taxYear).toBeLessThan(full.taxYear);
    expect(half.assumptions.join(' ')).toContain('50%');
  });
});
