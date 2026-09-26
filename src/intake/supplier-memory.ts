import type { Db } from '../db/database';

export interface SupplierRule {
  supplier_key: string;
  display_name: string;
  category_key: string;
  vat_code: string;
  business: number;
  confirmations: number;
  corrections: number;
  /** 0 = nog niet gevraagd, 1 = gebruiker wil automatisch, -1 = gebruiker wil blijven kiezen */
  auto_approved: number;
}

/** Na zoveel gelijke bevestigingen vragen we of de leverancier voortaan automatisch mag. */
export const ASK_AUTO_AFTER_CONFIRMATIONS = 3;

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
 *   ≥ 3, geen correcties → de gebruiker vragen of het voortaan automatisch mag
 *   alleen na "ja" → automatisch verwerken (#22). Een correctie zet dat weer uit.
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
    return !!rule && rule.auto_approved === 1 && rule.corrections === 0;
  }

  /** Leveranciers waarvoor we kunnen voorstellen om ze voortaan automatisch te verwerken. */
  pendingApprovals(minConfirmations = ASK_AUTO_AFTER_CONFIRMATIONS): SupplierRule[] {
    return this.db
      .prepare('SELECT * FROM supplier_rules WHERE auto_approved = 0 AND corrections = 0 AND confirmations >= ? ORDER BY display_name')
      .all(minConfirmations) as SupplierRule[];
  }

  /** "Klopt niet" op een automatische verwerking: opnieuw leren en weer vragen. */
  markCorrected(name: string): void {
    const key = supplierKey(name);
    this.db
      .prepare(
        `UPDATE supplier_rules SET corrections = corrections + 1, confirmations = 0,
           auto_approved = CASE WHEN auto_approved = -1 THEN -1 ELSE 0 END, updated_at = datetime('now') WHERE supplier_key = ?`,
      )
      .run(key);
  }

  /** De keuze van de gebruiker: true = voortaan automatisch, false = blijf het vragen. */
  setAutomatic(key: string, automatic: boolean): void {
    this.db.prepare(`UPDATE supplier_rules SET auto_approved = ?, updated_at = datetime('now') WHERE supplier_key = ?`).run(automatic ? 1 : -1, key);
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
             auto_approved = CASE WHEN ? OR auto_approved = -1 THEN auto_approved ELSE 0 END,
             updated_at = datetime('now') WHERE supplier_key = ?`,
        )
        .run(decision.categoryKey, decision.vatCode, decision.business ? 1 : 0, same ? 1 : 0, same ? 1 : 0, same ? 1 : 0, key);
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
