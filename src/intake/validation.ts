import type { DocumentResult, Issue } from './types';
import { isIsoDate, today, diffDays } from '../shared/dates';

/**
 * Controleert of een document intern consistent is. OCR-resultaten worden nooit blind vertrouwd:
 * bij inconsistentie wordt er niet stilletjes geboekt maar een vraag gesteld.
 */
export function validateDocument(doc: DocumentResult, asOf: string = today()): Issue[] {
  const issues: Issue[] = [];
  const total = doc.total?.value;
  const vatSum = doc.vat.value.reduce((s, v) => s + v.amount, 0);
  const baseSum = doc.vat.value.every((v) => v.base !== null) ? doc.vat.value.reduce((s, v) => s + (v.base ?? 0), 0) : null;
  const subtotal = doc.subtotal?.value ?? baseSum;

  if (total === undefined) issues.push({ field: 'total', severity: 'fout', message: 'We konden het totaalbedrag niet vinden.' });
  if (!doc.invoiceDate) issues.push({ field: 'invoiceDate', severity: 'fout', message: 'We konden de datum niet vinden.' });
  else if (!isIsoDate(doc.invoiceDate.value)) issues.push({ field: 'invoiceDate', severity: 'fout', message: 'De datum is ongeldig.' });
  else {
    const age = diffDays(doc.invoiceDate.value, asOf);
    if (age < -1) issues.push({ field: 'invoiceDate', severity: 'waarschuwing', message: 'De datum ligt in de toekomst.' });
    if (age > 400) issues.push({ field: 'invoiceDate', severity: 'waarschuwing', message: 'Dit document is ouder dan een jaar.' });
  }
  if (!doc.supplier) issues.push({ field: 'supplier', severity: 'waarschuwing', message: 'We weten niet van welke winkel of leverancier dit is.' });
  if (doc.currency.value !== 'EUR') issues.push({ field: 'currency', severity: 'fout', message: `Valuta ${doc.currency.value} wordt niet ondersteund.` });

  for (const [i, v] of doc.vat.value.entries()) {
    if (v.base !== null && v.rate > 0) {
      const expected = Math.round((v.base * v.rate) / 100);
      if (Math.abs(expected - v.amount) > 2) {
        issues.push({ field: `vat.${i}`, severity: 'fout', message: `${v.rate}% van ${(v.base / 100).toFixed(2)} is ${(expected / 100).toFixed(2)}, niet ${(v.amount / 100).toFixed(2)}.`, suggestion: expected });
      }
    }
  }
  if (total !== undefined && subtotal != null && doc.vat.value.length > 0 && !doc.reverseCharge) {
    if (Math.abs(subtotal + vatSum - total) > 2) {
      issues.push({ field: 'total', severity: 'fout', message: 'Netto + BTW komt niet uit op het totaal.', suggestion: subtotal + vatSum });
    }
  }
  if (total !== undefined && doc.vat.value.length === 1 && doc.vat.value[0]!.base === null && !doc.reverseCharge) {
    // alleen btw-bedrag bekend: controleer of het past bij totaal incl.
    const v = doc.vat.value[0]!;
    const expected = Math.round((total * v.rate) / (100 + v.rate));
    if (v.rate > 0 && Math.abs(expected - v.amount) > 2) {
      issues.push({ field: 'vat.0', severity: 'fout', message: `We zijn niet zeker van het BTW-bedrag. Bij ${v.rate}% verwachten we ${(expected / 100).toFixed(2)}.`, suggestion: expected });
    }
  }
  if (doc.vat.value.length === 0 && !doc.reverseCharge) {
    issues.push({ field: 'vat', severity: 'waarschuwing', message: 'Er staat geen BTW op dit document (of we konden het niet lezen).' });
  }
  return issues;
}

export function isConsistent(issues: Issue[]): boolean {
  return !issues.some((i) => i.severity === 'fout');
}
