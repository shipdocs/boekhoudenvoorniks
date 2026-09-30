import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import brandIndex from '../src/intake/brand-index.json';
import { findBrand, normalizeBrand } from '../src/intake/brand-index';
import { findKnownSupplier } from '../src/intake/suppliers';
import type { DocumentResult } from '../src/intake/types';

/**
 * Bekende leveranciers: de handmatige lijst (wint altijd) en de winkelindex uit OpenStreetMap
 * (Name Suggestion Index, BSD-3-Clause). Een treffer is een voorstel, nooit automatisch.
 */

const doc = (supplier: string, lines: string[] = [], vat: { rate: number; amount: number }[] = [{ rate: 21, amount: 2100 }]): DocumentResult =>
  ({
    documentType: { value: 'bon', confidence: 1, source: 'test' },
    supplier: { value: supplier, confidence: 1, source: 'test' },
    supplierVatNumber: null,
    supplierIban: null,
    invoiceNumber: null,
    invoiceDate: { value: '2026-09-30', confidence: 1, source: 'test' },
    dueDate: null,
    currency: { value: 'EUR', confidence: 1, source: 'test' },
    subtotal: { value: 10000, confidence: 1, source: 'test' },
    vat: { value: vat.map((v) => ({ ...v, base: null })), confidence: 1, source: 'test' },
    total: { value: 12100, confidence: 1, source: 'test' },
    lineDescriptions: lines,
    reverseCharge: false,
    rawText: '',
  }) as unknown as DocumentResult;

describe('winkelindex (OpenStreetMap)', () => {
  it('bron en licentie gaan mee in de app', () => {
    const file = brandIndex as unknown as { bron: string; licentie: string; merken: unknown[] };
    expect(file.bron).toMatch(/osmlab\/name-suggestion-index .*commit [0-9a-f]{40}/);
    expect(file.licentie).toMatch(/BSD|Redistribution and use/);
    expect(file.merken.length).toBeGreaterThan(2000);
  });

  it('normaliseert namen van bonnen en bankafschriften', () => {
    expect(normalizeBrand('CCV*GAMMA UTRECHT')).toBe('gamma utrecht');
    expect(normalizeBrand('Kwik-Fit B.V. (Amersfoort)')).toBe('kwik fit amersfoort');
    expect(normalizeBrand('SumUp *Café Loetje')).toBe('cafe loetje');
    expect(normalizeBrand('Boels Verhuur Nederland BV')).toBe('boels verhuur');
  });

  it('vindt ketens op (het begin van) de naam, per soort winkel de juiste categorie', () => {
    expect(findBrand('Kwik Fit Amersfoort')).toMatchObject({ category: 'auto' });
    expect(findBrand('FEBO Utrecht Centrum')).toMatchObject({ category: 'representatie' });
    expect(findBrand('Boels Verhuur')).toMatchObject({ category: 'gereedschap' });
    expect(findBrand('Fastned')).toMatchObject({ category: 'brandstof' });
    expect(findBrand('CCV*CARGLASS')).toMatchObject({ category: 'auto' });
    expect(findBrand('Office Depot')).toMatchObject({ category: 'kantoor' });
  });

  it('geen treffer op een stukje midden in de naam, op algemene woorden of op ketens die hier iets anders zijn', () => {
    expect(findBrand('Houthandel Gamma-straat')).toBeNull();
    expect(findBrand('Jumbo Utrecht')).toBeNull(); // hier een supermarkt, in de index een bouwmarkt
    expect(findBrand('IKEA Delft')).toBeNull(); // in de index alleen het restaurant
    expect(findBrand('Carrefour Market')).toBeNull(); // supermarkt met tankstation
    expect(findBrand('Vattenfall')).toBeNull(); // energie, geen laadpaal
    expect(findBrand('Budget Verhuur Smit')).toBeNull();
    expect(findBrand('')).toBeNull();
    expect(findBrand(null)).toBeNull();
  });
});

describe('bekende leveranciers in de classificatie', () => {
  it('de handmatige lijst wint van de index; een treffer uit de index is een voorstel met lagere zekerheid', async () => {
    const { s } = setup();
    const gamma = await s.classifier.classify(doc('Gamma Utrecht'));
    expect(gamma).toMatchObject({ categoryKey: 'materiaal', source: 'regel', confidence: 0.75, automatic: false });
    expect(gamma.reasons.join(' ')).toContain('bekende leverancier');
    const carglass = await s.classifier.classify(doc('Carglass Nieuwegein'));
    expect(carglass).toMatchObject({ categoryKey: 'auto', vatCode: 'hoog', source: 'regel', proposedBy: 'regel', confidence: 0.65, automatic: false });
    expect(carglass.reasons.join(' ')).toContain('OpenStreetMap');
  });

  it('horeca uit de index: geen btw-aftrek, ook als er 9% op de bon staat', async () => {
    const { s } = setup();
    const c = await s.classifier.classify(doc('Loetje Amsterdam', ['Biefstuk', 'Cola'], [{ rate: 9, amount: 900 }]));
    expect(c).toMatchObject({ categoryKey: 'representatie', vatCode: 'geen' });
  });

  it('bouwmarkt uit de index met gereedschap op de bon: gereedschap, zoals bij de handmatige lijst', async () => {
    const { s } = setup();
    expect(await s.classifier.classify(doc('Bauhaus Venlo', ['Makita schroefmachine']))).toMatchObject({ categoryKey: 'gereedschap' });
  });

  it('handmatige aanvulling: software en verzekeraars met de juiste btw', () => {
    expect(findKnownSupplier('Adobe Systems Software Ireland Ltd')).toMatchObject({ category: 'software', vatCode: 'eu', source: 'lijst' });
    expect(findKnownSupplier('TransIP B.V.')).toMatchObject({ category: 'software', vatCode: 'hoog' });
    expect(findKnownSupplier('GitHub, Inc.')).toMatchObject({ category: 'software', vatCode: 'buiten-eu' });
    expect(findKnownSupplier('Interpolis')).toMatchObject({ category: 'verzekering', vatCode: 'geen' });
    expect(findKnownSupplier('Univé Schade')).toMatchObject({ category: 'verzekering' });
    expect(findKnownSupplier('Universiteit Utrecht')).toBeNull();
  });

  it('bankbetaling aan een keten: categorievoorstel op Vandaag, geen automatische boeking', () => {
    const { s } = setup();
    const inbox = s.inbox as unknown as { suggestionFor(t: { counter_name: string; description: string; amount: number; date: string }): unknown };
    expect(inbox.suggestionFor({ counter_name: 'CCV*KWIK FIT AMERSFOORT', description: 'Betaalpas', amount: -8900, date: '2026-09-30' })).toMatchObject({ categoryKey: 'auto', business: true, confident: false });
    expect(inbox.suggestionFor({ counter_name: 'J. de Vries', description: 'Betaalpas FEBO', amount: -500, date: '2026-09-30' })).toBeNull();
  });
});
