import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// Bewust via de OUDE paden geïmporteerd: die zijn dunne her-exports van packages/core.
import { centsToDecimalString, parseEuro, sum } from '../src/shared/money';
import { isValidIban, normalizeVatNumber } from '../src/shared/validation';
import { addMonths, formatDateNl } from '../src/shared/dates';
import { detectCurrency } from '../src/shared/currency';
import { computeTotals, lineNet } from '../src/documents/totals';
import { formatDocumentNumber } from '../src/documents/numbering';
import { renderTemplate } from '../src/documents/render';

const KERN_BRON = join(import.meta.dirname, '..', 'packages', 'core', 'src');

/** De kern mag niets weten van Node, Electron of de database: dan kan een Android-app haar letterlijk hergebruiken. */
const VERBODEN_IN_DE_KERN: RegExp[] = [
  /\bnode:/,
  /from\s+['"](fs|path|crypto|electron|better-sqlite3)['"]/,
  /\brequire\s*\(/,
  /\bBuffer\b/,
  /\bprocess\./,
  /\bDb\b/,
];

describe('gedeelde kern', () => {
  it('bevat geen Node-, Electron- of database-afhankelijkheden', () => {
    const bestanden = readdirSync(KERN_BRON, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'));
    expect(bestanden.length).toBeGreaterThan(0);
    const overtredingen: string[] = [];
    for (const bestand of bestanden) {
      const bron = readFileSync(join(KERN_BRON, bestand), 'utf8');
      for (const patroon of VERBODEN_IN_DE_KERN) {
        if (patroon.test(bron)) overtredingen.push(`${bestand}: ${patroon}`);
      }
    }
    expect(overtredingen).toEqual([]);
  });

  it('heeft zelf geen afhankelijkheden', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'packages', 'core', 'package.json'), 'utf8'));
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.devDependencies).toBeUndefined();
  });

  it('rekent via de oude importpaden nog hetzelfde', () => {
    expect(parseEuro('1.234,56')).toBe(123456);
    expect(parseEuro('€ -12,50')).toBe(-1250);
    expect(centsToDecimalString(-1250)).toBe('-12.50');
    expect(sum([100, 200, -50])).toBe(250);
    expect(lineNet({ quantity: 1.5, unitPrice: 1000 })).toBe(1500);

    const totalen = computeTotals([
      { description: 'a', quantity: 1, unitPrice: 1050, vatCode: 'hoog' },
      { description: 'b', quantity: 2, unitPrice: 500, vatCode: 'laag' },
    ]);
    expect(totalen.subtotal).toBe(2050);
    expect(totalen.vatTotal).toBe(311); // btw per groep: 21% over 1050 = 220,50 → 221; 9% over 1000 = 90
    expect(totalen.total).toBe(totalen.subtotal + totalen.vatTotal);

    expect(isValidIban('NL91 ABNA 0417 1643 00')).toBe(true);
    expect(isValidIban('NL91ABNA0417164301')).toBe(false);
    expect(normalizeVatNumber(' nl 123.456.789.b01 ')).toBe('NL123456789B01');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(formatDateNl('2026-03-07')).toBe('7 maart 2026');
    expect(formatDocumentNumber('F{JJJJ}{MM}-{NNNN}', '2026-03-07', 12)).toBe('F202603-0012');
    expect(renderTemplate('{{#regels}}{{omschrijving}}{{/regels}}', { regels: [{ omschrijving: '<a>' }] })).toBe('&lt;a&gt;');
    expect(detectCurrency('Totaal $ 90,00').code).toBe('USD');
  });
});
