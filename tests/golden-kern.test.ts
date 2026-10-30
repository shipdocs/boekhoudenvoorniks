import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeTotals } from '../src/documents/totals';

// De golden vectoren zijn de afspraak tussen de desktop-app en andere gebruikers van
// packages/core (zoals een latere Android-app). `npm run test:golden` draait ze los;
// deze test zet dezelfde vectoren in de gewone testronde, zodat `npm test`,
// `npm run controle` en CI bij drift meteen falen.

interface Vector {
  id: string;
  categorie: string;
  omschrijving: string;
  invoer: { lines: Parameters<typeof computeTotals>[0] };
  verwacht: unknown;
}

const bestand = join(import.meta.dirname, '..', 'packages', 'core', 'golden', 'vectors.json');
const data = JSON.parse(readFileSync(bestand, 'utf8')) as { vectors: Vector[] };

/** Zelfde strikte vergelijking als scripts/golden-kern.mjs: eerst sleutels sorteren. */
function canoniek(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canoniek);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canoniek((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

describe('golden vectoren gedeelde rekenkern', () => {
  it('het vectorbestand bevat vectoren', () => {
    expect(Array.isArray(data.vectors)).toBe(true);
    expect(data.vectors.length).toBeGreaterThan(0);
    expect(new Set(data.vectors.map((v) => v.id)).size).toBe(data.vectors.length);
  });

  for (const vector of data.vectors) {
    it(`${vector.id} (${vector.categorie}): ${vector.omschrijving}`, () => {
      const werkelijk = computeTotals(vector.invoer.lines);
      expect(canoniek(werkelijk)).toEqual(canoniek(vector.verwacht));
    });
  }
});
