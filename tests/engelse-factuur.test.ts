import { describe, expect, it } from 'vitest';
import { parseDocumentText } from '../src/intake/text-parser';
import { setup } from './helpers';
import { makePdf } from './pdf';

const lines = [
  'Invoice',
  'Invoice number ABCD1234-0005',
  'Date of issue May 6, 2026',
  'Date due May 6, 2026',
  'Anthropic, PBC',
  '548 Market Street',
  'San Francisco, California 94104',
  'Bill to',
  'Shipdocs',
  '€90.00 due May 6, 2026',
  'Description Qty Unit price Tax Amount',
  'Max plan - 5x 1 €90.00 0% €90.00',
  'Subtotal €90.00',
  'Total €90.00',
  'Amount due €90.00',
  '[1] Tax to be paid on reverse charge basis',
];

describe('Engelstalige factuur (bv. Anthropic)', () => {
  it('leverancier, datum, totaal en btw verlegd', () => {
    const r = parseDocumentText(lines.map((text) => ({ text, page: 1 })), 'pdf-text');
    expect(r.supplier?.value).toBe('Anthropic');
    expect(r.invoiceDate?.value).toBe('2026-05-06');
    expect(r.total?.value).toBe(9000);
    expect(r.reverseCharge).toBe(true);
  });

  it('zonder bekende naam: geen kopje als "Date of issue" als leverancier', () => {
    const r = parseDocumentText(lines.map((text) => ({ text: text.replace(/Anthropic/, 'Voorbeeld'), page: 1 })), 'pdf-text');
    expect(r.supplier?.value).toBe('Voorbeeld, PBC');
  });
});

describe('bon controleren: alles is aan te passen', () => {
  it('eigen btw-bedrag en factuurnummer gaan voor wat de app las', async () => {
    const { s } = setup();
    const doc = await s.intake.add('bon.pdf', makePdf(['Bouwmarkt Jansen', 'Datum 12-09-2026', 'Totaal 121,00', 'BTW 21% 21,00']), '2026-09-20', { autoConfirm: false });
    s.intake.confirm(doc.id, { supplier: 'Bouwmarkt Jansen', date: '2026-09-12', total: 12100, invoiceNumber: 'B-77', categoryKey: 'materiaal', vatCode: 'hoog', business: true, paidWith: 'later', vatAmount: 2000 });
    expect(s.purchases.list().some((x) => x.supplier_reference === 'B-77')).toBe(true);
    expect(s.vat.calculate('2026-Q3').summary.voorbelasting).toBe(2000);
    const other = await s.intake.add('bon2.pdf', makePdf(['Winkel Pietersen', 'Datum 13-09-2026', 'Totaal 10,00']), '2026-09-20', { autoConfirm: false });
    expect(() => s.intake.confirm(other.id, { supplier: 'Winkel', date: '2026-09-13', total: 1000, categoryKey: 'materiaal', vatCode: 'hoog', business: true, paidWith: 'later', vatAmount: 5000 })).toThrow(/niet meer zijn dan het totaal/);
  });
});

describe('review-punten', () => {
  it('btw-bedrag hooguit wat het tarief toelaat', async () => {
    const { s } = setup();
    const doc = await s.intake.add('bon3.pdf', makePdf(['Bouwmarkt Kees', 'Datum 12-09-2026', 'Totaal 121,00']), '2026-09-20', { autoConfirm: false });
    expect(() => s.intake.confirm(doc.id, { supplier: 'Bouwmarkt Kees', date: '2026-09-12', total: 12100, categoryKey: 'materiaal', vatCode: 'hoog', business: true, paidWith: 'later', vatAmount: 10000 })).toThrow(/hooguit 21,00/);
    s.intake.confirm(doc.id, { supplier: 'Bouwmarkt Kees', date: '2026-09-12', total: 12100, categoryKey: 'materiaal', vatCode: 'hoog', business: true, paidWith: 'later', vatAmount: 2102 });
  });

  it('"Payment date" is niet de factuurdatum', () => {
    const r = parseDocumentText(['Invoice', 'Payment date May 20, 2026', 'Date of issue May 6, 2026', 'Total €90.00'].map((text) => ({ text, page: 1 })), 'pdf-text');
    expect(r.invoiceDate?.value).toBe('2026-05-06');
  });
});
