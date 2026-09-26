import { describe, expect, it } from 'vitest';
import { generateDocs, htmlToLines } from '../src/tools/synthetic-receipts';
import { scoreDocument } from '../src/tools/benchmark-score';
import { parseDocumentText } from '../src/intake/text-parser';

const items = (lines: string[]) => lines.map((text, i) => ({ text, page: 1, bbox: [10, 20 + i * 20, 400, 34 + i * 20] as [number, number, number, number], confidence: 0.95 }));

describe('synthetische benchmarkset (#8)', () => {
  it('is reproduceerbaar en de juiste waarden kloppen onderling', () => {
    const a = generateDocs(40, 7);
    expect(generateDocs(40, 7).map((d) => d.html)).toEqual(a.map((d) => d.html));
    expect(generateDocs(40, 8).map((d) => d.html)).not.toEqual(a.map((d) => d.html));
    for (const d of a) {
      const lineSum = d.truth.lines!.reduce((s, l) => s + Math.round(l.amount * 100), 0);
      expect(lineSum).toBe(Math.round(d.truth.total * 100));
      expect(d.truth.vat.length).toBeGreaterThan(0);
      expect(d.truth.date).toMatch(/^2026-\d{2}-\d{2}$/);
    }
    // variatie: bonnen en facturen, meerdere vervormingen, ook 9%
    expect(new Set(a.map((d) => d.kind)).size).toBe(2);
    expect(new Set(a.map((d) => d.distortion)).size).toBeGreaterThan(3);
  });

  it('basislijn: met perfect gelezen tekst haalt de parser (bijna) alles', () => {
    const docs = generateDocs(200);
    const score = { supplier: [0, 0], date: [0, 0], total: [0, 0], vat: [0, 0] } as Record<string, [number, number]>;
    const fails: string[] = [];
    for (const d of docs) {
      const r = parseDocumentText(items(htmlToLines(d.html)), 'ocr:test');
      const { fields, diffs } = scoreDocument(r, d.truth);
      for (const [k, ok] of Object.entries(fields)) {
        score[k]![1]++;
        if (ok) score[k]![0]++;
      }
      if (diffs.length) fails.push(`${d.id}: ${diffs.join('; ')}`);
    }
    const pct = (k: string) => score[k]![0] / score[k]![1];
    if (pct('total') < 0.99 || pct('date') < 0.99 || pct('vat') < 0.95 || pct('supplier') < 0.95) console.log(fails.slice(0, 15).join('\n'));
    expect(pct('total')).toBeGreaterThanOrEqual(0.99);
    expect(pct('date')).toBeGreaterThanOrEqual(0.99);
    expect(pct('vat')).toBeGreaterThanOrEqual(0.95);
    expect(pct('supplier')).toBeGreaterThanOrEqual(0.95);
  });
});
