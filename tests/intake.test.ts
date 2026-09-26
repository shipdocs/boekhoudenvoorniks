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

  const bouwmaat = (day: number, total = '121,00', nr?: string) => [
    'Bouwmaat Utrecht',
    ...(nr ? [`Factuurnummer: ${nr}`] : []),
    `Datum: ${String(day).padStart(2, '0')}-09-2026`,
    'Gips 100,00',
    'Subtotaal 100,00',
    'BTW 21% 100,00 21,00',
    `Totaal ${total}`,
  ];
  const varOcr = () => {
    const state = { lines: [] as string[] };
    const provider: OcrProvider = { id: 'test', label: 'Test OCR', available: async () => true, recognize: async () => ({ items: items(state.lines) }) };
    return { state, provider };
  };
  const confirmBouwmaat = (s: ReturnType<typeof setup>['s'], id: number, date: string) =>
    s.intake.confirm(id, { supplier: 'Bouwmaat', date, total: 12100, categoryKey: 'materiaal', vatCode: 'hoog', business: true, paidWith: 'kas' });

  it('eerste keer: vraag; na bevestigingen: pas automatisch na jouw ja (#22) — en nooit dubbel boeken', async () => {
    const { state, provider } = varOcr();
    const { s } = setup({ ocr: provider });
    s.settings.update({ onboardingDone: true });
    state.lines = bouwmaat(1);
    const d1 = await s.intake.add('bon1.jpg', new Uint8Array([1]), '2026-09-25');
    expect(d1.status).toBe('controle');
    expect(d1.confidence).toBe('MEDIUM');
    expect(d1.classification).toMatchObject({ categoryKey: 'materiaal', vatCode: 'hoog', source: 'regel' });
    confirmBouwmaat(s, d1.id, '2026-09-01');
    expect(s.ledger.balance('WKprInkMat')).toBe(10000);
    expect(s.ledger.balance(ACCOUNTS.btwVoorbelasting)).toBe(2100);

    for (const [i, day] of [[2, 8], [3, 15]] as const) {
      state.lines = bouwmaat(day);
      const d = await s.intake.add(`bon${i}.jpg`, new Uint8Array([i]), '2026-09-25');
      expect(d.classification).toMatchObject({ source: 'geheugen', automatic: false });
      expect(d.status).toBe('controle');
      confirmBouwmaat(s, d.id, `2026-09-${String(day).padStart(2, "0")}`);
    }
    // Na 3× hetzelfde: de app vraagt het, maar doet het nog niet zelf
    const ask = s.inbox.tasks('2026-09-25').find((t) => t.kind === 'supplier-auto')!;
    expect(ask.title).toContain('Bouwmaat');
    state.lines = bouwmaat(20);
    const d4 = await s.intake.add('bon4.jpg', new Uint8Array([4]), '2026-09-25');
    expect(d4.status).toBe('controle');
    confirmBouwmaat(s, d4.id, '2026-09-20');

    s.memory.setAutomatic(ask.ref.supplierKey!, true);
    expect(s.inbox.tasks('2026-09-25').some((t) => t.kind === 'supplier-auto')).toBe(false);
    state.lines = bouwmaat(24);
    const d5 = await s.intake.add('bon5.jpg', new Uint8Array([5]), '2026-09-25');
    expect(d5.confidence).toBe('HIGH');
    expect(d5.status).toBe('verwerkt');
    expect(s.ledger.balance('WKprInkMat')).toBe(50000);
    expect(s.inbox.home('2026-09-25').automated[0]).toMatchObject({ kind: 'document-auto' });
    // zelfde bestand nogmaals = geen nieuwe boeking
    const again = await s.intake.add('bon5-kopie.jpg', new Uint8Array([5]), '2026-09-25');
    expect(again.id).toBe(d5.id);
    expect(s.ledger.balance('WKprInkMat')).toBe(50000);

    // een correctie zet automatisch weer uit
    s.memory.learn('Bouwmaat', { categoryKey: 'gereedschap', vatCode: 'hoog', business: true });
    expect(s.memory.isAutomatic(s.memory.get('Bouwmaat'))).toBe(false);
  });

  it('dubbele documenten: zeker dubbel wordt niet geboekt, beste bewijs blijft bewaard (#31)', async () => {
    const { state, provider } = varOcr();
    const { s } = setup({ ocr: provider });
    state.lines = bouwmaat(10, '121,00', 'F-2026-001');
    const foto = await s.intake.add('foto.jpg', new Uint8Array([1]), '2026-09-25');
    const done = confirmBouwmaat(s, foto.id, '2026-09-10');
    expect(done.status).toBe('verwerkt');

    // dezelfde factuur komt later als PDF-mail binnen (ander bestand, zelfde nummer + bedrag)
    const pdf = makePdf(bouwmaat(10, '121,00', 'F2026001'));
    const kopie = await s.intake.add('factuur.pdf', pdf, '2026-09-25');
    expect(kopie.status).toBe('genegeerd');
    expect(kopie.duplicate_of_document_id).toBe(foto.id);
    expect(s.ledger.balance('WKprInkMat')).toBe(10000);
    // de PDF-tekst is beter bewijs dan de foto: die wordt de bijlage
    const purchase = s.purchases.list()[0]!;
    expect(purchase.document_id).toBe(kopie.id);
    expect(purchase.attachment_path).toBe(kopie.file_path);
  });

  it('dubbele documenten: mogelijk dubbel wordt gevraagd, niet automatisch geboekt (#31)', async () => {
    const { state, provider } = varOcr();
    const { s } = setup({ ocr: provider });
    s.settings.update({ onboardingDone: true });
    state.lines = bouwmaat(10);
    const a = await s.intake.add('a.jpg', new Uint8Array([1]), '2026-09-25');
    confirmBouwmaat(s, a.id, '2026-09-10');
    state.lines = bouwmaat(11);
    const b = await s.intake.add('b.jpg', new Uint8Array([2]), '2026-09-25');
    expect(b.status).toBe('controle');
    expect(b.confidence).toBe('LOW');
    const task = s.inbox.tasks('2026-09-25').find((t) => t.ref.documentId === b.id)!;
    expect(task.actions[0]!.id).toBe('dubbel');
    const issue = b.issues.find((i) => i.field === 'duplicate')!;
    s.intake.markDuplicate(b.id, issue.suggestion as { documentId: number | null; purchaseId: number | null });
    expect(s.intake.get(b.id).status).toBe('genegeerd');
    expect(s.ledger.balance('WKprInkMat')).toBe(10000);

    // een week later, zelfde bedrag = gewoon een nieuwe aankoop
    state.lines = bouwmaat(20);
    const c = await s.intake.add('c.jpg', new Uint8Array([3]), '2026-09-25');
    expect(c.issues.some((i) => i.field === 'duplicate')).toBe(false);
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
    expect(d.issues[0]!.message).toMatch(/herkenning/);
  });
});
