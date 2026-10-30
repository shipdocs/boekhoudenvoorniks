import { describe, expect, it } from 'vitest';
import { TRADES, presetVatCode, workVatCodes } from '../src/shared/trades';

// Bron: Belastingdienst, "Btw-tarief schilderen" en "Btw-tarief stukadoren" (woningen ouder dan 2 jaar):
// 9% geldt ook voor de gebruikte materialen, het voorbereiden en de voorbehandeling.
const trade = (key: string) => TRADES.find((t) => t.key === key)!;
const voorrijkosten = () => {
  const item = trade('stukadoor').items.find((i) => i.description === 'Voorrijkosten');
  if (!item) throw new Error('stukadoor heeft geen voorstelregel Voorrijkosten meer');
  return item;
};

describe('btw-voorstellen voor schilders en stukadoors', () => {
  it.each(['schilder', 'stukadoor'])('%s: alle voorstelregels staan op 9%%, materiaal en voorrijkosten ook', (key) => {
    for (const item of trade(key).items) expect(item.vatCode, `${key}: ${item.description}`).toBe('laag');
  });

  it.each(['schilder', 'stukadoor'])('%s: de uitleg zegt dat materiaal onder 9%% valt en niet dat het 21%% is', (key) => {
    const notes = [...new Set(trade(key).items.map((i) => i.note))];
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/ook over de gebruikte materialen/);
    expect(notes[0]).not.toMatch(/materiaal is 21%/);
    expect(notes[0]).toMatch(/ramen, deuren en kozijnen/);
    expect(notes[0]).toMatch(/Voorrijkosten/);
  });

  it('andere vakken blijven op 21% voor alles', () => {
    for (const key of ['timmerman', 'loodgieter', 'elektricien', 'klusbedrijf']) {
      for (const item of trade(key).items) expect(item.vatCode).toBe('hoog');
    }
  });

  it('voorrijkosten nemen het tarief over van het werk op de factuur', () => {
    const stuc = trade('stukadoor');
    const voorrij = voorrijkosten();
    expect(presetVatCode(stuc, voorrij, [])).toBe('laag');
    expect(presetVatCode(stuc, voorrij, [{ description: 'Stucwerk wanden (arbeid)', vatCode: 'laag' }])).toBe('laag');
    // werk dat 21% is (te ver van stukadoren): voorrijkosten volgen
    expect(presetVatCode(stuc, voorrij, [{ description: 'Gipswand plaatsen', vatCode: 'hoog' }])).toBe('hoog');
    // een eerdere voorrijkostenregel telt niet als werk
    expect(presetVatCode(stuc, voorrij, [{ description: 'Voorrijkosten', vatCode: 'hoog' }, { description: 'Stucwerk', vatCode: 'laag' }])).toBe('laag');
    // gewone regels houden hun eigen tarief
    const materiaal = stuc.items.find((i) => i.description === 'Materiaal')!;
    expect(presetVatCode(stuc, materiaal, [{ description: 'Gipswand plaatsen', vatCode: 'hoog' }])).toBe('laag');
  });

  it.each(['laag', 'hoog', 'verlegd', 'vrijgesteld'] as const)('voorrijkosten behouden %s bij meerdere regels met hetzelfde tarief', (vatCode) => {
    const stuc = trade('stukadoor');
    const regels = [{ description: 'Werk wanden', vatCode }, { description: 'Werk plafond', vatCode }];
    expect(presetVatCode(stuc, voorrijkosten(), regels)).toBe(vatCode);
    expect(presetVatCode(stuc, voorrijkosten(), [...regels].reverse())).toBe(vatCode);
  });

  // Bron: Belastingdienst, "Combinatie van goederen en/of diensten": bij verschillende tarieven de
  // vergoeding splitsen, of 21% over het geheel. Daarom kiest de app bij gemengd werk zelf niets.
  it('voorrijkosten bij gemengde tarieven nemen niets over en hangen niet af van de volgorde', () => {
    const stuc = trade('stukadoor');
    const regels = [
      { description: 'Stucwerk wanden', vatCode: 'laag' },
      { description: 'Gipswand plaatsen', vatCode: 'hoog' },
    ];
    expect(workVatCodes(stuc, regels).sort()).toEqual(['hoog', 'laag']);
    expect(presetVatCode(stuc, voorrijkosten(), regels)).toBe('laag');
    expect(presetVatCode(stuc, voorrijkosten(), [...regels].reverse())).toBe('laag');
  });

  it('een eerdere voorrijkostenregel maakt de tarieven niet gemengd', () => {
    const regels = [{ description: 'Voorrijkosten', vatCode: 'hoog' }, { description: 'Stucwerk', vatCode: 'laag' }];
    expect(workVatCodes(trade('stukadoor'), regels)).toEqual(['laag']);
  });
});
