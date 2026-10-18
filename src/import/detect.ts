import { isCsvName, isMt940Name } from '../shared/statement-files';

export type DetectedFormat = 'camt' | 'mt940' | 'csv' | 'onbekend';

export function detectFormat(filename: string, head: string): DetectedFormat {
  const h = head.trimStart().slice(0, 2000);
  if (h.startsWith('<?xml') || h.startsWith('<Document')) return h.includes('camt.053') || h.includes('BkToCstmrStmt') ? 'camt' : 'onbekend';
  if (/:20:/.test(h) && /:25:/.test(h) && /:61:/.test(h)) return 'mt940';
  if (/^\{1:/.test(h) || isMt940Name(filename)) return 'mt940';
  if (isCsvName(filename) || /[;,\t]/.test(h.split('\n')[0] ?? '')) return 'csv';
  return 'onbekend';
}
