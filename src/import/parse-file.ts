import { parseCsv, previewCsv, type CsvMapping } from './csv';
import { parseMt940 } from './mt940';
import { parseCamt053 } from './camt053';
import { detectFormat } from './detect';
import type { ParseResult } from './types';

/**
 * Een bankafschrift (CAMT.053, MT940 of CSV) lezen. Eén route voor een bestand dat de gebruiker in de app
 * sleept en voor een afschrift uit de downloadmap. Bij CSV zonder toewijzing: de kolommen die de app zelf herkent.
 */
export async function parseBankFile(filename: string, content: string, mapping?: CsvMapping): Promise<ParseResult> {
  const format = detectFormat(filename, content);
  if (format === 'camt') return parseCamt053(content);
  if (format === 'mt940') return parseMt940(Buffer.from(content, 'utf8'));
  if (format === 'csv') {
    const m = mapping ?? previewCsv(content).suggestedMapping;
    if (!m) throw new Error('Kolommen niet herkend; wijs ze handmatig aan');
    return parseCsv(content, m);
  }
  throw new Error('Dit bestand herkennen we niet. Download bij je bank een afschrift als CSV-, MT940- of CAMT-bestand.');
}
