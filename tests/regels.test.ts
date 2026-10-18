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
    expect(issue.message).toMatch(/Op deze bon staat ook: .*Kwast set.*Chips paprika/);
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

describe('review-bevindingen #42', () => {
  it('spatie als duizendtalscheiding alleen bij een los getal; artikelcode blijft buiten het bedrag', () => {
    const doc = parseDocumentText(items(['BOUWMAAT', 'Datum: 12-09-2026', 'Steigerhuur week 1 234,56', 'Festool zaagmachine TS55 649,00', 'Totaal 1 883,56']), 'ocr:test');
    expect(doc.lines!.map((l) => l.value.amount)).toEqual([123456, 64900]);
  });

  it('een kortingsregel verlaagt het artikel erboven en is zelf geen artikel', () => {
    const doc = parseDocumentText(items(['PRAXIS', 'Datum: 14-09-2026', 'Muurverf wit 10L 49,95', 'Korting -10,00', 'Chips paprika 1,89', 'Totaal 41,84']), 'ocr:test');
    expect(doc.lines!.map((l) => [l.value.description, l.value.amount])).toEqual([['Muurverf wit 10L', 3995], ['Chips paprika', 189]]);
    expect(doc.linesBasis).toBe('incl');
  });

  it('UBL: prijs per BaseQuantity wordt omgerekend naar per stuk', () => {
    const xml = `<?xml version="1.0"?><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
<cbc:ID>F1</cbc:ID><cbc:IssueDate>2026-09-01</cbc:IssueDate>
<cac:AccountingSupplierParty><cac:Party><cac:PartyName><cbc:Name>Wasco</cbc:Name></cac:PartyName></cac:Party></cac:AccountingSupplierParty>
<cac:LegalMonetaryTotal><cbc:TaxExclusiveAmount currencyID="EUR">50.00</cbc:TaxExclusiveAmount><cbc:PayableAmount currencyID="EUR">60.50</cbc:PayableAmount></cac:LegalMonetaryTotal>
<cac:InvoiceLine><cbc:ID>1</cbc:ID><cbc:InvoicedQuantity unitCode="H87">200</cbc:InvoicedQuantity><cbc:LineExtensionAmount currencyID="EUR">50.00</cbc:LineExtensionAmount><cac:Item><cbc:Name>Schroeven</cbc:Name></cac:Item><cac:Price><cbc:PriceAmount currencyID="EUR">25.00</cbc:PriceAmount><cbc:BaseQuantity unitCode="H87">100</cbc:BaseQuantity></cac:Price></cac:InvoiceLine>
</Invoice>`;
    expect(parseUbl(xml).lines![0]!.value).toMatchObject({ quantity: 200, unitPrice: 25, amount: 5000 });
  });

  it('delen met een eigen btw-tarief worden met dat tarief geboekt; investeringsgrens met het regeltarief', async () => {
    const f = (description: string, amount: number, vatRate: number) => ({ value: { description, quantity: null, unitPrice: null, amount, vatRate }, confidence: 1, source: 'ubl' as const });
    const doc = { ...parseDocumentText(items(['X', 'Totaal 30,00']), 'ocr:test'), linesBasis: 'excl' as const, total: { value: 2300, confidence: 1, source: 'ubl' as const }, lines: [f('Gipsplaat', 1000, 21), f('Werkbroek', 1000, 9)] };
    const parts = suggestSplit(doc as never)!;
    expect(parts.map((p) => [p.categoryKey, p.vatRate])).toEqual(expect.arrayContaining([['materiaal', 21], ['werkkleding', 9]]));
    // € 500 incl. 9% = € 458,72 excl.: boven de grens; met 21% zou het € 413,22 zijn (eronder)
    expect(classifyLine({ description: 'Boormachine', quantity: 1, unitPrice: null, amount: 50000, vatRate: 9 }, 'incl')).toBe('investering');
    expect(classifyLine({ description: 'Boormachine', quantity: 1, unitPrice: null, amount: 50000, vatRate: null }, 'incl')).toBe('gereedschap');

    const ocr: OcrProvider = { id: 'test', label: 'Test', available: async () => true, recognize: async () => ({ items: items(BONNEN.praxis) }) };
    const { s } = setup({ ocr });
    const d = await s.intake.add('praxis.jpg', new Uint8Array([1]), '2026-09-25');
    s.intake.confirm(d.id, { supplier: 'Praxis', date: '2026-09-14', total: 6483, categoryKey: 'materiaal', vatCode: 'hoog', business: true, paidWith: 'kas', splits: [
      { categoryKey: 'materiaal', gross: 4995, vatRate: 21 },
      { categoryKey: 'gereedschap', gross: 1299, vatRate: 9 },
      { categoryKey: 'prive', gross: 189 },
    ] });
    expect(s.ledger.balance('WBedAlkGer')).toBe(1192); // 12,99 / 1,09
    expect(s.ledger.balance(ACCOUNTS.btwVoorbelasting)).toBe(867 + 107);
    expect(s.ledger.checkIntegrity().balanced).toBe(true);
  });
});
