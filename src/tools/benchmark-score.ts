import type { DocumentResult } from '../intake/types';
import { supplierKey } from '../intake/supplier-memory';
import type { Truth } from './synthetic-receipts';

export type ScoreField = 'supplier' | 'date' | 'total' | 'vat';

/** Vergelijkt één herkend document met de juiste waarden; geeft per veld goed/fout en de afwijkingen. */
export function scoreDocument(r: DocumentResult, truth: Partial<Truth>): { fields: Partial<Record<ScoreField, boolean>>; diffs: string[] } {
  const fields: Partial<Record<ScoreField, boolean>> = {};
  const diffs: string[] = [];
  const check = (field: ScoreField, ok: boolean, got: unknown, want: unknown) => {
    fields[field] = ok;
    if (!ok) diffs.push(`${field}: kreeg ${JSON.stringify(got)}, verwacht ${JSON.stringify(want)}`);
  };
  if (truth.supplier) check('supplier', !!r.supplier && supplierKey(r.supplier.value).split(' ')[0] === supplierKey(truth.supplier).split(' ')[0], r.supplier?.value, truth.supplier);
  if (truth.date) check('date', r.invoiceDate?.value === truth.date, r.invoiceDate?.value, truth.date);
  if (truth.total !== undefined) check('total', r.total?.value === Math.round(truth.total * 100), r.total?.value, Math.round(truth.total * 100));
  if (truth.vat) {
    const want = truth.vat.map((v) => `${v.rate}:${Math.round(v.amount * 100)}`).sort().join(',');
    const got = r.vat.value.map((v) => `${v.rate}:${v.amount}`).sort().join(',');
    check('vat', want === got, got, want);
  }
  return { fields, diffs };
}
