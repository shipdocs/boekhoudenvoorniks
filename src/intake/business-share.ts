import type { Db } from '../db/database';
import { tx } from '../db/database';
import { businessPct, type BankCategoriePayload } from '../core-ledger/rules';
import type { BankService } from '../import/bank';
import type { PurchaseService } from '../documents/purchases';
import { supplierKey } from './supplier-memory';

export interface BusinessShare {
  supplier_key: string;
  display_name: string;
  /** zakelijk deel in procenten (1–99) */
  pct: number;
}

/** Zakelijk deel van een leverancier of tegenpartij, of 100 (alles zakelijk) als er niets is opgegeven. */
export function businessShareFor(db: Db, name: string | null | undefined): number {
  const key = name ? supplierKey(name) : '';
  if (!key) return 100;
  const row = db.prepare('SELECT pct FROM supplier_business_share WHERE supplier_key = ?').get(key) as { pct: number } | undefined;
  return row?.pct ?? 100;
}

/** Legt het zakelijke deel van een leverancier vast; 100 haalt de regel weg (standaard). */
export function setBusinessShare(db: Db, name: string, pct: number): void {
  const key = supplierKey(name);
  if (!key) return;
  const p = businessPct(pct);
  if (p === 100) {
    db.prepare('DELETE FROM supplier_business_share WHERE supplier_key = ?').run(key);
    return;
  }
  db.prepare(
    `INSERT INTO supplier_business_share (supplier_key, display_name, pct) VALUES (?, ?, ?)
     ON CONFLICT(supplier_key) DO UPDATE SET pct = excluded.pct, display_name = excluded.display_name, updated_at = datetime('now')`,
  ).run(key, name.trim(), p);
}

export function listBusinessShares(db: Db): BusinessShare[] {
  return db.prepare('SELECT supplier_key, display_name, pct FROM supplier_business_share ORDER BY display_name COLLATE NOCASE').all() as BusinessShare[];
}

/**
 * Zakelijk deel per leverancier (gemengd gebruik), voor de instellingen en voor "toepassen op eerdere
 * boekingen". Niets opgegeven = 100% zakelijk.
 */
export class BusinessShareService {
  constructor(
    private readonly db: Db,
    private readonly bank: BankService,
    private readonly purchases: PurchaseService,
  ) {}

  get(name: string | null | undefined): number {
    return businessShareFor(this.db, name);
  }

  list(): BusinessShare[] {
    return listBusinessShares(this.db);
  }

  /** Legt het percentage vast; met `applyExisting` gaan ook de al geboekte uitgaven van deze leverancier mee. */
  set(name: string, pct: number, opts: { applyExisting?: boolean } = {}): { pct: number; changed: number; skipped: number } {
    return tx(this.db, () => {
      setBusinessShare(this.db, name, pct);
      return { pct: this.get(name), ...(opts.applyExisting ? this.apply(name) : { changed: 0, skipped: 0 }) };
    });
  }

  /**
   * Boekt de al geboekte uitgaven van deze leverancier opnieuw met het vastgelegde percentage
   * (tegenboeking + nieuwe post, zoals bij elke correctie). Boekingen die de app niet kan herschrijven
   * (oudere versie, overstapposten) blijven staan en worden geteld als overgeslagen.
   */
  apply(name: string): { changed: number; skipped: number } {
    const key = supplierKey(name);
    const pct = this.get(name);
    let changed = 0;
    let skipped = 0;
    if (!key) return { changed, skipped };
    const bankEvents = this.db.prepare(`SELECT id, payload FROM events WHERE type = 'bank-categorie' AND status = 'actief' ORDER BY id`).all() as { id: number; payload: string }[];
    for (const e of bankEvents) {
      const p = JSON.parse(e.payload) as BankCategoriePayload;
      if (p.amount >= 0 || (p.accountCategory !== 'kosten' && p.accountCategory !== 'activa')) continue;
      const t = this.db.prepare('SELECT counter_name FROM bank_transactions WHERE id = ?').get(p.bankTransactionId) as { counter_name: string | null } | undefined;
      if (!t?.counter_name || supplierKey(t.counter_name) !== key) continue;
      if ((p.businessPct ?? 100) === pct) continue;
      try {
        this.bank.reclassify(p.bankTransactionId, { account: p.account, businessPct: pct }, 'zakelijk deel aangepast');
        changed++;
      } catch {
        skipped++;
      }
    }
    const purchases = this.db
      .prepare(`SELECT p.id FROM purchase_invoices p JOIN relations r ON r.id = p.relation_id WHERE p.is_opening = 0 AND p.journal_entry_id IS NOT NULL ORDER BY p.id`)
      .all() as { id: number }[];
    for (const row of purchases) {
      const p = this.purchases.get(row.id);
      if (!p.relation_name || supplierKey(p.relation_name) !== key) continue;
      const event = p.journal_entry_id ? this.purchases.eventFor(p.journal_entry_id) : null;
      if (!event) {
        skipped++;
        continue;
      }
      if ((event.businessPct ?? 100) === pct) continue;
      try {
        this.purchases.setBusinessPct(row.id, pct);
        changed++;
      } catch {
        skipped++;
      }
    }
    return { changed, skipped };
  }
}
