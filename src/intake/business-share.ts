import type { Db } from '../db/database';
import { tx } from '../db/database';
import { businessPct, expenseLines, splitGross, type BankCategoriePayload, type InkoopPayload, type PurchaseLineInput } from '../core-ledger/rules';
import { storedExpenseLines, storedPurchaseVat, storedVatWarning } from '../core-ledger/stored-purchase';
import { PURCHASE_VAT_RATES, isPurchaseVatCode, isReverseCharge } from '../shared/vat';
import type { Cents } from '../shared/money';
import type { IsoDate } from '../shared/dates';
import type { Ledger } from '../core-ledger/ledger';
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
/** Eén geboekte uitgave van een leverancier, met wat het zakelijke deel ervan maakt. */
export interface BusinessShareLine {
  kind: 'bank' | 'inkoop';
  /** banktransactie- of inkoop-id */
  refId: number;
  date: IsoDate;
  description: string;
  /** wat er echt betaald is of op de factuur staat */
  gross: Cents;
  /** zakelijk deel nu (100 = alles) en het deel dat bij de leverancier hoort */
  currentPct: number;
  proposedPct: number;
  /** kosten en btw-aftrek nu; bij verlegde btw is `btw` geen echte aftrek (per saldo nul) */
  /** de bedragen per regel voor de weergave (kosten en btw voor het zakelijke deel bepaald) */
  parts: { net: Cents; vat: Cents }[];
  vatWarning?: string | null;
  noVatDeduction: boolean;
  now: { kosten: Cents; btw: Cents };
  reverseCharge: boolean;
  /** de periode is al ingediend: het verschil komt in de volgende aangifte */
  filedPeriod: string | null;
}

export interface BusinessShareResult {
  changed: number;
  skipped: number;
  errors: string[];
}

export class BusinessShareService {
  constructor(
    private readonly db: Db,
    private readonly bank: BankService,
    private readonly purchases: PurchaseService,
    private readonly ledger: Ledger,
  ) {}

  /** Kosten en btw-aftrek van een uitgave bij een zakelijk percentage (zelfde rekenregels als het boeken). */
  static effect(lines: PurchaseLineInput[], pct: number, noVatDeduction?: boolean): { kosten: Cents; btw: Cents; reverseCharge: boolean } {
    const calculate = storedVatWarning(lines) ? storedExpenseLines : expenseLines;
    const r = calculate(lines, 'X', null, undefined, { noVatDeduction, businessPct: pct });
    return { kosten: r.net, btw: r.vat, reverseCharge: lines.some((l) => isReverseCharge(l.vatCode)) };
  }

  /** Alle geboekte uitgaven van deze leverancier, om na te kijken en te bevestigen of aan te passen. */
  lines(name: string): BusinessShareLine[] {
    const key = supplierKey(name);
    const out: BusinessShareLine[] = [];
    if (!key) return out;
    const proposed = this.get(name);
    const filed = (date: IsoDate) => this.ledger.lockedPeriodFor(date)?.period_key ?? null;
    const bankEvents = this.db.prepare(`SELECT payload FROM events WHERE type = 'bank-categorie' AND status = 'actief' ORDER BY id`).all() as { payload: string }[];
    for (const e of bankEvents) {
      const p = JSON.parse(e.payload) as BankCategoriePayload;
      if (p.amount >= 0 || (p.accountCategory !== 'kosten' && p.accountCategory !== 'activa') || !isPurchaseVatCode(p.vatCode)) continue;
      const t = this.db.prepare('SELECT counter_name FROM bank_transactions WHERE id = ?').get(p.bankTransactionId) as { counter_name: string | null } | undefined;
      if (!t?.counter_name || supplierKey(t.counter_name) !== key) continue;
      const { net, vat } = splitGross(-p.amount, PURCHASE_VAT_RATES[p.vatCode].percentage, isReverseCharge(p.vatCode));
      const cur = p.businessPct ?? 100;
      const eff = BusinessShareService.effect([{ account: p.account, netAmount: net, vatCode: p.vatCode, vatAmount: vat }], cur, p.noVatDeduction);
      out.push({ kind: 'bank', refId: p.bankTransactionId, date: p.date, description: p.description, gross: -p.amount, currentPct: cur, proposedPct: proposed, parts: [{ net, vat }], noVatDeduction: Boolean(p.noVatDeduction), now: { kosten: eff.kosten, btw: eff.btw }, reverseCharge: eff.reverseCharge, filedPeriod: filed(p.date) });
    }
    const rows = this.db.prepare(`SELECT p.id FROM purchase_invoices p JOIN relations r ON r.id = p.relation_id WHERE p.is_opening = 0 AND p.journal_entry_id IS NOT NULL ORDER BY p.id`).all() as { id: number }[];
    for (const row of rows) {
      const p = this.purchases.get(row.id);
      if (!p.relation_name || supplierKey(p.relation_name) !== key || !p.journal_entry_id) continue;
      const event = this.purchases.eventFor(p.journal_entry_id);
      if (!event) continue;
      const cur = event.businessPct ?? 100;
      const eff = BusinessShareService.effect(event.lines, cur, event.noVatDeduction);
      out.push({ kind: 'inkoop', vatWarning: storedVatWarning(event.lines), refId: p.id, date: event.date, description: p.description, gross: p.total, currentPct: cur, proposedPct: proposed, parts: event.lines.map((l) => ({ net: l.netAmount, vat: storedPurchaseVat(l) })), noVatDeduction: Boolean(event.noVatDeduction), now: { kosten: eff.kosten, btw: eff.btw }, reverseCharge: eff.reverseCharge, filedPeriod: filed(event.date) });
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }

  /** Wat een boeking bij een ander percentage zou worden (voor de weergave in de lijst). */
  preview(line: Pick<BusinessShareLine, 'kind' | 'refId'>, pct: number): { kosten: Cents; btw: Cents } {
    const lines = this.linesOf(line);
    const eff = BusinessShareService.effect(lines.lines, businessPct(pct), lines.noVatDeduction);
    return { kosten: eff.kosten, btw: eff.btw };
  }

  private linesOf(line: Pick<BusinessShareLine, 'kind' | 'refId'>): { lines: PurchaseLineInput[]; noVatDeduction?: boolean } {
    if (line.kind === 'inkoop') {
      const p = this.purchases.get(line.refId);
      const ev = p.journal_entry_id ? this.purchases.eventFor(p.journal_entry_id) : null;
      if (!ev) throw new Error('Deze aankoop kan niet worden aangepast');
      return { lines: ev.lines, noVatDeduction: ev.noVatDeduction };
    }
    const ev = this.db.prepare(`SELECT payload FROM events WHERE type = 'bank-categorie' AND status = 'actief' AND json_extract(payload, '$.bankTransactionId') = ?`).get(line.refId) as { payload: string } | undefined;
    if (!ev) throw new Error('Deze betaling kan niet worden aangepast');
    const p = JSON.parse(ev.payload) as BankCategoriePayload;
    if (!isPurchaseVatCode(p.vatCode)) throw new Error('Deze betaling kan niet worden aangepast');
    const { net, vat } = splitGross(-p.amount, PURCHASE_VAT_RATES[p.vatCode].percentage, isReverseCharge(p.vatCode));
    return { lines: [{ account: p.account, netAmount: net, vatCode: p.vatCode, vatAmount: vat }], noVatDeduction: p.noVatDeduction };
  }

  /** Past de gekozen boekingen aan (tegenboeking + nieuwe post). Alles in één transactie: of alles, of niets. */
  applyLines(items: { kind: 'bank' | 'inkoop'; refId: number; pct: number }[]): BusinessShareResult {
    return tx(this.db, () => {
      const result: BusinessShareResult = { changed: 0, skipped: 0, errors: [] };
      for (const it of items) {
        const pct = businessPct(it.pct);
        if (it.kind === 'inkoop') {
          const p = this.purchases.get(it.refId);
          const ev = p.journal_entry_id ? this.purchases.eventFor(p.journal_entry_id) : null;
          if (!ev) {
            result.skipped++;
            result.errors.push(`${p.description}: kan niet worden aangepast`);
            continue;
          }
          if ((ev.businessPct ?? 100) === pct) continue;
          this.purchases.setBusinessPct(it.refId, pct);
        } else {
          const ev = this.db.prepare(`SELECT payload FROM events WHERE type = 'bank-categorie' AND status = 'actief' AND json_extract(payload, '$.bankTransactionId') = ?`).get(it.refId) as { payload: string } | undefined;
          if (!ev) {
            result.skipped++;
            result.errors.push(`Betaling ${it.refId}: kan niet worden aangepast`);
            continue;
          }
          const p = JSON.parse(ev.payload) as BankCategoriePayload;
          if ((p.businessPct ?? 100) === pct) continue;
          this.bank.reclassify(it.refId, { account: p.account, businessPct: pct }, 'zakelijk deel aangepast');
        }
        result.changed++;
      }
      return result;
    });
  }

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
