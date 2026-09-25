import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { makePdf } from './pdf';
import { parseDocumentText } from '../src/intake/text-parser';
import { validateDocument } from '../src/intake/validation';
import { parseUbl } from '../src/intake/ubl';
import { supplierKey } from '../src/intake/supplier-memory';
import { extractPdf } from '../src/intake/pdf-text';
import type { OcrProvider } from '../src/intake/ocr';
import { ACCOUNTS } from '../src/core-ledger/accounts';

const bon = [
  'TOOLSTATION AMSTERDAM',
  'Kassabon nr: 55123-889',
  'Datum: 24-09-2026 14:02',
  'Makita accuboormachine 242,00',
  'Subtotaal excl. BTW 200,00',
  'BTW 21% 200,00 42,00',
  'Totaal 242,00',
  'PIN 242,00',
];
const items = (lines: string[]) => lines.map((text, i) => ({ text, page: 1, bbox: [10, 20 + i * 20, 300, 34 + i * 20] as [number, number, number, number], confidence: 0.97 }));

describe('extractie', () => {
  it('parseert een kassabon uit tekst', () => {
    const r = parseDocumentText(items(bon), 'ocr:test');
    expect(r.supplier?.value).toBe('Toolstation');
    expect(r.invoiceDate?.value).toBe('2026-09-24');
    expect(r.invoiceNumber?.value).toBe('55123-889');
    expect(r.total).toMatchObject({ value: 24200, source: 'ocr:test', page: 1 });
    expect(r.total!.bbox).toEqual([10, 140, 300, 154]);
    expect(r.subtotal?.value).toBe(20000);
    expect(r.vat.value).toEqual([{ rate: 21, base: 20000, amount: 4200 }]);
    expect(r.lineDescriptions.join()).toContain('Makita');
  });

  it('UBL e-factuur heeft voorrang en is volledig zeker', () => {
    const r = parseUbl(readFileSync(join(__dirname, 'fixtures', 'ubl-invoice.xml'), 'utf8'));
    expect(r).toMatchObject({ supplier: { value: 'Bouwmaat Nederland B.V.', confidence: 1, source: 'ubl' }, invoiceNumber: { value: '2026018472' }, total: { value: 12100 }, subtotal: { value: 10000 } });
    expect(r.vat.value).toEqual([{ rate: 21, base: 10000, amount: 2100 }]);
    expect(r.supplierIban?.value).toBe('NL91ABNA0417164300');
  });

  it('leest de tekstlaag van een PDF met posities', async () => {
    const pdf = await extractPdf(makePdf(['Gamma Utrecht', 'Factuurdatum 03-09-2026', 'Totaal 30,25', 'BTW 21% 25,00 5,25']));
    expect(pdf.textLength).toBeGreaterThan(30);
    const r = parseDocumentText(pdf.items, 'pdf-text');
    expect(r.supplier?.value).toBe('Gamma');
    expect(r.total?.value).toBe(3025);
    expect(r.total?.bbox?.[1]).toBeGreaterThan(0);
  });
});

describe('validatie', () => {
  it('accepteert een consistent document', () => {
    expect(validateDocument(parseDocumentText(items(bon), 'ocr:x'), '2026-09-25').filter((i) => i.severity === 'fout')).toEqual([]);
  });
  it('vangt een verkeerd gelezen BTW-bedrag', () => {
    const bad = parseDocumentText(items(bon.map((l) => l.replace('42,00', '47,00'))), 'ocr:x');
    const issues = validateDocument(bad, '2026-09-25');
    expect(issues.find((i) => i.field === 'vat.0')).toMatchObject({ severity: 'fout', suggestion: 4200 });
  });
  it('normaliseert leveranciersnamen', () => {
    expect(supplierKey('GAMMA UTRECHT B.V. 1234')).toBe('gamma utrecht');
    expect(supplierKey('Bouwmaat Nederland B.V.')).toBe('bouwmaat');
  });
});

describe('documentinbox', () => {
  const ocr = (lines: string[]): OcrProvider => ({ id: 'test', label: 'Test OCR', available: async () => true, recognize: async () => ({ items: items(lines) }) });

  it('eerste keer: vraag; na bevestigingen: automatisch — en nooit dubbel boeken', async () => {
    const lines = ['Bouwmaat Utrecht', 'Datum: 23-09-2026', 'Gips 100,00', 'Subtotaal 100,00', 'BTW 21% 100,00 21,00', 'Totaal 121,00'];
    const { s } = setup({ ocr: ocr(lines) });
    const d1 = await s.intake.add('bon1.jpg', new Uint8Array([1]), '2026-09-25');
    expect(d1.status).toBe('controle');
    expect(d1.confidence).toBe('MEDIUM');
    expect(d1.classification).toMatchObject({ categoryKey: 'materiaal', vatCode: 'hoog', source: 'regel' });
    s.intake.confirm(d1.id, { supplier: 'Bouwmaat', date: '2026-09-23', total: 12100, categoryKey: 'materiaal', vatCode: 'hoog', business: true, paidWith: 'kas' });
    expect(s.ledger.balance('WKprInkMat')).toBe(10000);
    expect(s.ledger.balance(ACCOUNTS.btwVoorbelasting)).toBe(2100);

    const d2 = await s.intake.add('bon2.jpg', new Uint8Array([2]), '2026-09-25');
    expect(d2.classification).toMatchObject({ source: 'geheugen', automatic: false });
    s.intake.confirm(d2.id, { supplier: 'Bouwmaat', date: '2026-09-23', total: 12100, categoryKey: 'materiaal', vatCode: 'hoog', business: true, paidWith: 'kas' });

    const d3 = await s.intake.add('bon3.jpg', new Uint8Array([3]), '2026-09-25');
    expect(d3.confidence).toBe('HIGH');
    expect(d3.status).toBe('verwerkt');
    expect(s.ledger.balance('WKprInkMat')).toBe(30000);
    // zelfde bestand nogmaals = geen nieuwe boeking
    const again = await s.intake.add('bon3-kopie.jpg', new Uint8Array([3]), '2026-09-25');
    expect(again.id).toBe(d3.id);
    expect(s.ledger.balance('WKprInkMat')).toBe(30000);
  });

  it('inconsistent document wordt nooit stilletjes geboekt', async () => {
    const { s } = setup({ ocr: ocr(bon.map((l) => l.replace('42,00', '47,00'))) });
    s.memory.learn('Toolstation', { categoryKey: 'gereedschap', vatCode: 'hoog', business: true });
    s.memory.learn('Toolstation', { categoryKey: 'gereedschap', vatCode: 'hoog', business: true });
    const d = await s.intake.add('bon.jpg', new Uint8Array([9]), '2026-09-25');
    expect(d.confidence).toBe('LOW');
    expect(d.status).toBe('controle');
    expect(s.ledger.balance('WBedAlkGer')).toBe(0);
  });

  it('bank + document: koppelt de bon aan de betaling', async () => {
    const { s } = setup();
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-09-23', amount: -12100, description: 'Betaalautomaat', counterName: 'BOUWMAAT UTRECHT' }] });
    const d = await s.intake.add('factuur.xml', readFileSync(join(__dirname, 'fixtures', 'ubl-invoice.xml')), '2026-09-25');
    expect(d.bank_match?.amount).toBe(-12100);
    const done = s.intake.confirm(d.id, { supplier: 'Bouwmaat', date: '2026-09-23', total: 12100, invoiceNumber: '2026018472', categoryKey: 'materiaal', vatCode: 'hoog', business: true, paidWith: 'bank' });
    expect(done.status).toBe('verwerkt');
    expect(s.bank.list({ status: 'nieuw' })).toHaveLength(0);
    expect(s.ledger.balance(ACCOUNTS.crediteuren)).toBe(0);
    expect(s.ledger.balance(ACCOUNTS.bank)).toBe(-12100);
  });

  it('privé-bon: niet in de boekhouding, bankbetaling wordt privé-opname', async () => {
    const { s } = setup({ ocr: ocr(['Albert Heijn', 'Datum 20-09-2026', 'Totaal 54,20']) });
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-09-20', amount: -5420, description: 'AH', counterName: 'Albert Heijn' }] });
    const d = await s.intake.add('ah.jpg', new Uint8Array([4]), '2026-09-25');
    s.intake.confirm(d.id, { supplier: 'Albert Heijn', date: '2026-09-20', total: 5420, categoryKey: 'overig', vatCode: 'geen', business: false, paidWith: 'bank' });
    expect(s.intake.get(d.id).status).toBe('genegeerd');
    expect(s.ledger.balance(ACCOUNTS.priveOpnamen)).toBe(5420);
  });

  it('zonder OCR: vraagt de gebruiker om zelf in te vullen', async () => {
    const { s } = setup();
    const d = await s.intake.add('foto.jpg', new Uint8Array([5]), '2026-09-25');
    expect(d.confidence).toBe('LOW');
    expect(d.issues[0]!.message).toMatch(/OCR/);
  });
});
