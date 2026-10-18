import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { checkNumberFormat, guessNumberFormat, parseDocumentNumber } from '../src/documents/numbering';
import type { OcrProvider } from '../src/intake/ocr';

const regel = { description: 'Advies', quantity: 1, unitPrice: 10000, vatCode: 'hoog' as const };

describe('nummerformaat controleren, lezen en raden', () => {
  it('weigert een formaat zonder accolades of volgnummer met een uitleg', () => {
    expect(checkNumberFormat('{JJJJ}-{NNNN}')).toBeNull();
    expect(checkNumberFormat('{JJ}{NNN}')).toBeNull();
    expect(checkNumberFormat('INV{NNNN}')).toBeNull();
    expect(checkNumberFormat('ANN-{NNNN}')).toBeNull();
    expect(checkNumberFormat('JJ NNN')).toMatch(/accolades/);
    expect(checkNumberFormat('{JJJJ}-NNNN')).toMatch(/accolades/);
    expect(checkNumberFormat('{JJJJ}')).toMatch(/volgnummer/);
    expect(checkNumberFormat('{NN}{NNN}')).toMatch(/één volgnummer/);
    expect(checkNumberFormat('F{XX}{NNN}')).toMatch(/Onbekende code/);
    expect(checkNumberFormat('  ')).toMatch(/Vul een nummerformaat in/);
  });

  it('leest het volgnummer en jaar volgens het formaat, ook met minder cijfers', () => {
    expect(parseDocumentNumber('{JJJJ}-{NNNN}', '2026-037')).toEqual({ year: 2026, sequence: 37 });
    expect(parseDocumentNumber('{JJ}{NNN}', '26100')).toEqual({ year: 2026, sequence: 100 });
    expect(parseDocumentNumber('F{JJJJ}{MM}-{NNNN}', 'F202603-0012')).toEqual({ year: 2026, sequence: 12 });
    expect(parseDocumentNumber('{NNNN}', '0042')).toEqual({ year: null, sequence: 42 });
    expect(parseDocumentNumber('{JJJJ}-{NNNN}', '26100')).toBeNull();
    expect(parseDocumentNumber('{JJJJ}-{NNNN}', 'M1-2026-0001')).toBeNull();
    expect(parseDocumentNumber('JJ NNN', '26 100')).toBeNull();
  });

  it('raadt de opmaak van een nummer uit een vorig pakket', () => {
    expect(guessNumberFormat('26100', 2026)).toBe('{JJ}{NNN}');
    expect(guessNumberFormat('2026-037', 2026)).toBe('{JJJJ}-{NNN}');
    expect(guessNumberFormat('F26-0012', 2026)).toBe('F{JJ}-{NNNN}');
    expect(guessNumberFormat('2025-0099', 2026)).toBe('{JJJJ}-{NNNN}');
    expect(guessNumberFormat('0012', 2026)).toBe('{NNNN}');
    expect(guessNumberFormat('2026-03-0012', 2026)).toBe('{JJJJ}-{MM}-{NNNN}');
    expect(parseDocumentNumber('{JJJJ}-{MM}-{NNNN}', '2026-03-0012')).toEqual({ year: 2026, sequence: 12 });
    expect(guessNumberFormat('abc', 2026)).toBeNull();
  });
});

describe('volgende factuurnummer', () => {
  it('"2026-037" als laatste nummer geeft 2026-0038, niet 2026-6038', () => {
    const { s, klant } = setup();
    const last = parseDocumentNumber(s.settings.get().invoiceNumberFormat, '2026-037')!;
    s.invoices.setNextNumber(last.sequence + 1, '2026-01-01');
    const draft = s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-03-01', lines: [regel] });
    expect(s.invoices.nextNumber('2026-03-01').number).toBe('2026-0038');
    expect(s.invoices.finalize(draft.id).number).toBe('2026-0038');
  });

  it('eigen opmaak {JJ}{NNN}: na 26100 komt 26101', () => {
    const { s, klant } = setup();
    s.settings.update({ invoiceNumberFormat: '{JJ}{NNN}' });
    s.invoices.setNextNumber(101, '2026-01-01');
    const draft = s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-02-10', lines: [regel] });
    expect(s.invoices.finalize(draft.id).number).toBe('26101');
  });

  it('een onbruikbaar formaat wordt bij het opslaan geweigerd; een al opgeslagen fout formaat blokkeert ander opslaan niet', () => {
    const { s, db } = setup();
    expect(() => s.settings.update({ invoiceNumberFormat: 'JJ NNN' })).toThrow(/accolades/);
    expect(s.settings.get().invoiceNumberFormat).toBe('{JJJJ}-{NNNN}');
    // zoals een oudere versie het kon opslaan
    db.prepare(`INSERT INTO settings (key, value) VALUES ('invoiceNumberFormat', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify('JJ NNN'));
    expect(() => s.settings.update({ ...s.settings.get(), paymentTermDays: 30 })).not.toThrow();
    expect(s.settings.get().paymentTermDays).toBe(30);
  });

  it('het volgende nummer kan niet lager dan een nummer dat al bestaat', () => {
    const { s, klant } = setup();
    for (let i = 0; i < 3; i++) s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-04-01', lines: [regel] }).id);
    expect(() => s.invoices.setNextNumber(3, '2026-04-01')).toThrow(/2026-0003 bestaat al.*minstens 2026-0004/);
    expect(s.invoices.setNextNumber(10, '2026-04-01').number).toBe('2026-0010');
    expect(s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-04-02', lines: [regel] }).id).number).toBe('2026-0010');
    expect(() => s.invoices.setNextNumber(0)).toThrow(/heel getal/);
  });

  it('een teller per jaar: het nummer op het concept volgt de factuurdatum', () => {
    const { s, klant } = setup();
    s.invoices.setNextNumber(50, '2026-01-01');
    expect(s.invoices.nextNumber('2026-12-31').number).toBe('2026-0050');
    expect(s.invoices.nextNumber('2027-01-02').number).toBe('2027-0001');
    // een voorbeeld bij een ander (nog niet opgeslagen) formaat
    expect(s.invoices.nextNumber('2026-12-31', 'F{JJ}{NNN}').number).toBe('F26050');
    expect(s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2027-01-02', lines: [regel] }).id).number).toBe('2027-0001');
  });

  it('openstaande facturen uit de vorige administratie tellen mee: geen "bestaat al"', () => {
    const { s, klant } = setup();
    // overstap halverwege het jaar: de reeks van dit jaar loopt door
    s.switchover.setMode('overstapper', '2026-07-01');
    s.switchover.save({ kind: 'klant', relationName: 'Familie Jansen', number: '2026-0007', invoiceDate: '2026-06-05', amount: 121_000 });
    expect(s.invoices.nextNumber('2026-08-01').number).toBe('2026-0008');
    const inv = s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-08-01', lines: [regel] }).id);
    expect(inv.number).toBe('2026-0008');
    // nummers van vorig jaar of in een andere opmaak tellen niet mee
    s.switchover.save({ kind: 'klant', relationName: 'Bakker', number: '2025-0300', invoiceDate: '2025-12-20', amount: 10_000 });
    s.switchover.save({ kind: 'klant', relationName: 'Smit', number: 'OUD-12', invoiceDate: '2025-12-21', amount: 10_000 });
    expect(s.invoices.nextNumber('2026-08-02').number).toBe('2026-0009');
  });
});

describe('omschrijving bij een aankoop', () => {
  it('bonnetje zonder foto: de omschrijving komt in plaats van de categorie', () => {
    const { s } = setup();
    const p = s.quick.recordExpense({ date: '2026-05-01', supplierName: 'Bol.com', description: 'Kopieerpapier', categoryKey: 'kantoor', grossAmount: 2420, vatCode: 'hoog', paidWith: 'kas' });
    expect(p.description).toBe('Kopieerpapier');
  });

  it('bon uit de inbox: omschrijving plus leverancier, leeg blijft de categorie', async () => {
    const state = { lines: [] as string[] };
    const ocr: OcrProvider = { id: 'test', label: 'Test OCR', available: async () => true, recognize: async () => ({ items: state.lines.map((text, i) => ({ text, page: 1, bbox: [10, 20 + i * 20, 300, 34 + i * 20] as [number, number, number, number], confidence: 0.97 })) }) };
    const { s } = setup({ ocr });
    state.lines = ['Bol.com', 'Datum: 01-05-2026', 'Totaal 24,20'];
    const a = await s.intake.add('a.jpg', new Uint8Array([1]), '2026-05-02');
    s.intake.confirm(a.id, { supplier: 'Bol.com', description: ' Kopieerpapier ', date: '2026-05-01', total: 2420, categoryKey: 'kantoor', vatCode: 'hoog', business: true, paidWith: 'kas' });
    state.lines = ['Primera', 'Datum: 12-05-2026', 'Totaal 7,50'];
    const b = await s.intake.add('b.jpg', new Uint8Array([2]), '2026-05-13');
    s.intake.confirm(b.id, { supplier: 'Primera', date: '2026-05-12', total: 750, categoryKey: 'kantoor', vatCode: 'hoog', business: true, paidWith: 'kas' });
    expect(s.purchases.list().map((p) => p.description).sort()).toEqual(['Kantoorartikelen — Primera', 'Kopieerpapier — Bol.com']);
  });
});
