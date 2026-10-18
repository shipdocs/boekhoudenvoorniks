import type { Db } from '../db/database';
import { SALES_VAT_RATES, type SalesVatCode } from '../shared/vat';
import { validateLines, type LineInput } from './totals';
import type { RenderableLine } from './templates';

export interface DocLine extends RenderableLine {
  id: number;
  position: number;
}

export function normalizeLines(lines: LineInput[]): LineInput[] {
  const clean = lines.map((l) => ({
    description: String(l.description ?? '').trim(),
    quantity: Math.round(Number(l.quantity) * 1000) / 1000,
    unit: l.unit?.trim() || null,
    unitPrice: Number(l.unitPrice),
    vatCode: l.vatCode,
    vatPercentage: l.vatPercentage ?? SALES_VAT_RATES[l.vatCode as SalesVatCode]?.percentage,
  }));
  validateLines(clean);
  return clean;
}

export function writeLines(db: Db, table: 'invoice_lines' | 'quote_lines', fk: 'invoice_id' | 'quote_id', docId: number, lines: LineInput[]): void {
  db.prepare(`DELETE FROM ${table} WHERE ${fk} = ?`).run(docId);
  const insert = db.prepare(
    `INSERT INTO ${table} (${fk}, position, description, quantity, unit, unit_price, vat_code, vat_percentage) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  lines.forEach((l, i) => insert.run(docId, i + 1, l.description, l.quantity, l.unit ?? null, l.unitPrice, l.vatCode, l.vatPercentage ?? SALES_VAT_RATES[l.vatCode].percentage));
}

export function readLines(db: Db, table: 'invoice_lines' | 'quote_lines', fk: 'invoice_id' | 'quote_id', docId: number): DocLine[] {
  return db.prepare(`SELECT id, position, description, quantity, unit, unit_price, vat_code, vat_percentage FROM ${table} WHERE ${fk} = ? ORDER BY position`).all(docId) as DocLine[];
}

export function toLineInputs(lines: RenderableLine[]): LineInput[] {
  return lines.map((l) => ({
    description: l.description,
    quantity: l.quantity,
    unit: l.unit,
    unitPrice: l.unit_price,
    vatCode: l.vat_code as SalesVatCode,
    vatPercentage: l.vat_percentage,
  }));
}
