import type { Db } from '../db/database';

export interface SupplierRule {
  supplier_key: string;
  display_name: string;
  category_key: string;
  vat_code: string;
  business: number;
  confirmations: number;
  corrections: number;
}

/** Na zoveel bevestigingen zonder correctie verwerken we een leverancier automatisch. */
export const AUTO_AFTER_CONFIRMATIONS = 2;

/** Normaliseert een leveranciers-/tegenpartijnaam: "GAMMA UTRECHT B.V. 1234" → "gamma utrecht". */
export function supplierKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(b\.?v\.?|n\.?v\.?|v\.?o\.?f\.?|holding|nederland|nl)\b/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 2)
    .join(' ');
}

/**
 * Deterministisch leveranciersgeheugen. AI hoeft niet iedere keer opnieuw dezelfde beslissing
 * te nemen: bevestigingen van de gebruiker worden hier vastgelegd.
 *   0 bevestigingen → vragen
 *   1 bevestiging   → voorstellen ("We denken dat dit materiaal is")
 *   ≥ 2, geen correcties sinds → automatisch verwerken
 */
export class SupplierMemory {
  constructor(private readonly db: Db) {}

  get(name: string | null | undefined): SupplierRule | null {
    if (!name) return null;
    const key = supplierKey(name);
    if (!key) return null;
    return (this.db.prepare('SELECT * FROM supplier_rules WHERE supplier_key = ?').get(key) as SupplierRule | undefined) ?? null;
  }

  isAutomatic(rule: SupplierRule | null): boolean {
    return !!rule && rule.confirmations >= AUTO_AFTER_CONFIRMATIONS && rule.corrections === 0;
  }

  /** Legt een beslissing van de gebruiker vast. Afwijkend van het vorige voorstel = correctie. */
  learn(name: string, decision: { categoryKey: string; vatCode: string; business: boolean }): SupplierRule {
    const key = supplierKey(name);
    if (!key) throw new Error('Lege leveranciersnaam');
    const existing = this.get(name);
    if (!existing) {
      this.db
        .prepare('INSERT INTO supplier_rules (supplier_key, display_name, category_key, vat_code, business, confirmations) VALUES (?, ?, ?, ?, ?, 1)')
        .run(key, name.trim(), decision.categoryKey, decision.vatCode, decision.business ? 1 : 0);
    } else {
      const same = existing.category_key === decision.categoryKey && existing.vat_code === decision.vatCode && Boolean(existing.business) === decision.business;
      this.db
        .prepare(
          `UPDATE supplier_rules SET category_key = ?, vat_code = ?, business = ?,
             confirmations = CASE WHEN ? THEN confirmations + 1 ELSE 1 END,
             corrections = CASE WHEN ? THEN 0 ELSE corrections + 1 END,
             updated_at = datetime('now') WHERE supplier_key = ?`,
        )
        .run(decision.categoryKey, decision.vatCode, decision.business ? 1 : 0, same ? 1 : 0, same ? 1 : 0, key);
    }
    return this.get(name)!;
  }

  list(): SupplierRule[] {
    return this.db.prepare('SELECT * FROM supplier_rules ORDER BY display_name').all() as SupplierRule[];
  }

  forget(key: string): void {
    this.db.prepare('DELETE FROM supplier_rules WHERE supplier_key = ?').run(key);
  }
}
