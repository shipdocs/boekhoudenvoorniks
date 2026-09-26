import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import { parseUbl } from '../src/intake/ubl';
import { parseDocumentText } from '../src/intake/text-parser';
import { suggestSplit, classifyLine } from '../src/intake/line-items';
import type { OcrProvider } from '../src/intake/ocr';

const items = (lines: string[]) => lines.map((text, i) => ({ text, page: 1, bbox: [10, 20 + i * 20, 300, 34 + i * 20] as [number, number, number, number], confidence: 0.97 }));

/** Testbonnen met gemengde categorieën (#23). */
const BONNEN = {
  gamma: ['GAMMA UTRECHT', 'Datum: 12-09-2026', 'Gipsplaat 12,5mm 2 x 8,95 17,90', 'Voegmiddel 5kg 12,50', 'Werkbroek Snickers 54,99', 'BTW 21% 70,57 14,82', 'Totaal 85,39', 'PIN 85,39'],
  praxis: ['PRAXIS NIEUWEGEIN', 'Datum: 14-09-2026', 'Muurverf wit 10L 49,95', 'Kwast set 12,99', 'Chips paprika 1,89', 'BTW 21% 53,58 11,25', 'Totaal 64,83'],
  hornbach: ['HORNBACH', 'Datum: 16-09-2026', 'Festool zaagmachine TS55 649,00', 'Zaagblad 48T 39,95', 'BTW 21% 569,38 119,57', 'Totaal 688,95'],
  klopt_niet: ['GAMMA UTRECHT', 'Datum: 12-09-2026', 'Gipsplaat 17,90', 'Werkbroek 54,99', 'BTW 21% 70,57 14,82', 'Totaal 90,00'],
};

describe('factuurregels (#23)', () => {
  it('UBL: alle regels met aantal, prijs, bedrag en tarief', () => {
    const { s, klant } = setup();
    const inv = s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-09-10', lines: [
      { description: 'Stucwerk', quantity: 24.5, unit: 'm²', unitPrice: 2250, vatCode: 'hoog' },
      { description: 'Arbeid', quantity: 6, unit: 'uur', unitPrice: 4800, vatCode: 'laag' },
      { description: 'Afvoer puin', quantity: 1, unitPrice: 7500, vatCode: 'hoog' },
    ] }).id);
    const doc = parseUbl(s.invoices.ublXml(inv.id));
    expect(doc.lines!.map((l) => l.value)).toEqual([
      { description: 'Stucwerk', quantity: 24.5, unitPrice: 2250, amount: 55125, vatRate: 21 },
      { description: 'Arbeid', quantity: 6, unitPrice: 4800, amount: 28800, vatRate: 9 },
      { description: 'Afvoer puin', quantity: 1, unitPrice: 7500, amount: 7500, vatRate: 21 },
    ]);
    expect(doc.linesBasis).toBe('excl');
    expect(doc.lines!.every((l) => l.confidence === 1)).toBe(true);
  });

  it('kassabonnen: regels herkend en per soort gesplitst', () => {
    const gamma = parseDocumentText(items(BONNEN.gamma), 'ocr:test');
    expect(gamma.lines!.map((l) => [l.value.description, l.value.quantity, l.value.unitPrice, l.value.amount])).toEqual([
      ['Gipsplaat 12,5mm', 2, 895, 1790],
      ['Voegmiddel 5kg', null, null, 1250],
      ['Werkbroek Snickers', null, null, 5499],
    ]);
    expect(gamma.linesBasis).toBe('incl');
    expect(suggestSplit(gamma)).toEqual([
      { categoryKey: 'werkkleding', gross: 5499, items: ['Werkbroek Snickers'] },
      { categoryKey: 'materiaal', gross: 3040, items: ['Gipsplaat 12,5mm', 'Voegmiddel 5kg'] },
    ]);
    const praxis = suggestSplit(parseDocumentText(items(BONNEN.praxis), 'ocr:test'))!;
    expect(Object.fromEntries(praxis.map((p) => [p.categoryKey, p.gross]))).toEqual({ materiaal: 4995, gereedschap: 1299, prive: 189 });
    const hornbach = suggestSplit(parseDocumentText(items(BONNEN.hornbach), 'ocr:test'))!;
    expect(Object.fromEntries(hornbach.map((p) => [p.categoryKey, p.gross]))).toEqual({ investering: 64900, gereedschap: 3995 });
    expect(classifyLine({ description: 'Boormachine Makita', quantity: 1, unitPrice: null, amount: 24200, vatRate: null }, 'incl')).toBe('gereedschap');
  });

  it('regels die niet optellen: geen splitsing, boeken op totaalniveau', () => {
    const doc = parseDocumentText(items(BONNEN.klopt_niet), 'ocr:test');
    expect(doc.linesBasis).toBeNull();
    expect(suggestSplit(doc)).toBeNull();
  });

  it('gemengde bon: niet automatisch, en na "apart boeken" per categorie in de boekhouding', async () => {
    const state = { lines: BONNEN.praxis };
    const ocr: OcrProvider = { id: 'test', label: 'Test', available: async () => true, recognize: async () => ({ items: items(state.lines) }) };
    const { s } = setup({ ocr });
    // leverancier al op automatisch: toch vragen, want de bon is gemengd
    for (let i = 0; i < 3; i++) s.memory.learn('Praxis', { categoryKey: 'materiaal', vatCode: 'hoog', business: true });
    s.memory.setAutomatic(s.memory.get('Praxis')!.supplier_key, true);
    const d = await s.intake.add('praxis.jpg', new Uint8Array([1]), '2026-09-25');
    expect(d.status).toBe('controle');
    const issue = d.issues.find((i) => i.field === 'lines')!;
    expect(issue.message).toMatch(/Deze bon bevat ook .*Kwast set.*Chips paprika/);
    const parts = issue.suggestion as { categoryKey: string; gross: number }[];
    s.intake.confirm(d.id, { supplier: 'Praxis', date: '2026-09-14', total: 6483, categoryKey: 'materiaal', vatCode: 'hoog', business: true, paidWith: 'kas', splits: parts.map(({ categoryKey, gross }) => ({ categoryKey, gross })) });
    expect(s.ledger.balance(ACCOUNTS.inkoopMaterialen)).toBe(4128); // 49,95 / 1,21
    expect(s.ledger.balance('WBedAlkGer')).toBe(1074); // 12,99 / 1,21
    expect(s.ledger.balance(ACCOUNTS.priveOpnamen)).toBe(189); // privé, geen btw terug
    expect(s.ledger.balance(ACCOUNTS.btwVoorbelasting)).toBe(867 + 225);
    expect(s.ledger.checkIntegrity().balanced).toBe(true);
    expect(() => s.intake.confirm(d.id, { supplier: 'Praxis', date: '2026-09-14', total: 6483, categoryKey: 'materiaal', vatCode: 'hoog', business: true, paidWith: 'kas', splits: [{ categoryKey: 'materiaal', gross: 100 }, { categoryKey: 'gereedschap', gross: 100 }] })).toThrow();
  });

  it('OCR-dienst mag regels zelf aanleveren (items in het contract)', async () => {
    const { HttpOcrProvider } = await import('../src/intake/ocr');
    const fetch = async () => ({ ok: true, status: 200, json: async () => ({ lines: [{ text: 'Totaal 51,80' }], items: [{ description: 'Knauf Goldband', quantity: 4, unit_price: 12.95, amount: 51.8, vat_rate: 21 }] }) });
    const p = new HttpOcrProvider('glm-ocr', 'http://127.0.0.1:8765', fetch as never);
    const out = await p.recognize({ data: new Uint8Array([1]), mimeType: 'image/jpeg', filename: 'x.jpg' });
    expect(out.structured?.lines?.[0]!.value).toEqual({ description: 'Knauf Goldband', quantity: 4, unitPrice: 1295, amount: 5180, vatRate: 21 });
  });
});
