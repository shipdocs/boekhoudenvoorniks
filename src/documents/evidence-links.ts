import type { Db } from '../db/database';
import { tx } from '../db/database';
import { ValidationError } from '../shared/validation';
import { formatDateNl, type IsoDate } from '../shared/dates';
import { formatEuro, type Cents } from '../shared/money';
import type { DocumentOutcome } from '../shared/document-outcome';

/** Waar een document bij hoort: een aankoop of een bankbetaling. */
export type LinkTarget = { kind: 'aankoop'; id: number } | { kind: 'bank'; id: number };

/** 'geboekt' = de aankoop is uit dit document geboekt; 'bewijs' = alleen als bewijs erbij; 'dubbel' = kopie. */
export type LinkOrigin = 'geboekt' | 'bewijs' | 'dubbel';
export type LinkProvenance = 'gebruiker' | 'automatisch' | 'migratie';

export interface DocumentLink {
  id: number;
  document_id: number;
  target: LinkTarget;
  /** het hoofdbewijsstuk van de aankoop of betaling (precies één per doel) */
  is_primary: boolean;
  origin: LinkOrigin;
  provenance: LinkProvenance;
  created_at: string;
}

/** Een bestand dat bij een aankoop of betaling hoort. */
export interface LinkedFile extends DocumentLink {
  original_name: string;
  file_path: string;
  mime_type: string;
  extraction_source: string | null;
}

/** Het doel in gewone woorden, om naast een document te laten zien (ook als er geen ander document is). */
export interface TargetInfo {
  kind: LinkTarget['kind'];
  id: number;
  supplier: string | null;
  date: IsoDate;
  /** wat er betaald is of moet worden, als positief bedrag */
  amount: Cents;
  reference: string | null;
  /** "de aankoop bij Gamma van 1 augustus 2026 (€ 242,00)" */
  label: string;
}

type Row = { id: number; document_id: number; purchase_invoice_id: number | null; bank_transaction_id: number | null; is_primary: number; origin: LinkOrigin; provenance: LinkProvenance; created_at: string };

const toLink = (r: Row): DocumentLink => ({
  id: r.id,
  document_id: r.document_id,
  target: r.purchase_invoice_id !== null ? { kind: 'aankoop', id: r.purchase_invoice_id } : { kind: 'bank', id: r.bank_transaction_id! },
  is_primary: r.is_primary === 1,
  origin: r.origin,
  provenance: r.provenance,
  created_at: r.created_at,
});

export const sameTarget = (a: LinkTarget, b: LinkTarget): boolean => a.kind === b.kind && a.id === b.id;
export const targetKey = (t: LinkTarget): string => `${t.kind}:${t.id}`;

/**
 * Welk bestand is het beste om te laten zien en mee te geven aan de boekhouder? Een PDF met de
 * e-factuur erin is het mooist, dan een PDF met tekst, een gescande PDF, een foto, en als laatste een
 * losse e-factuur (XML): die kan een mens niet lezen. De losse e-factuur blijft wel bewaard.
 */
export function primaryRank(doc: { mime_type: string; extraction_source: string | null }): number {
  if (doc.mime_type === 'application/pdf') return doc.extraction_source === 'ubl' ? 5 : doc.extraction_source === 'pdf-text' ? 4 : 3;
  return doc.mime_type === 'application/xml' ? 1 : 2;
}

/**
 * De koppeling tussen een document en de aankoop of bankbetaling waar het bij hoort (#179). Dit is de
 * enige plek die deze koppeling schrijft. `documents.purchase_invoice_id` en de bijlage van de aankoop
 * (`document_id`, `attachment_path`) worden hier bijgehouden als afgeleide van de koppeling.
 * Er wordt hier nooit iets geboekt: geen journaalpost, bedrag, btw of bankkoppeling verandert.
 */
export class EvidenceLinks {
  constructor(private readonly db: Db) {}

  forDocument(documentId: number): DocumentLink | null {
    const row = this.db.prepare('SELECT * FROM document_links WHERE document_id = ?').get(documentId) as Row | undefined;
    return row ? toLink(row) : null;
  }

  /** Alle bestanden bij een aankoop of betaling; het hoofdbewijsstuk eerst. */
  forTarget(target: LinkTarget): LinkedFile[] {
    const rows = this.db
      .prepare(
        `SELECT k.*, d.original_name, d.file_path, d.mime_type, d.extraction_source
           FROM document_links k JOIN documents d ON d.id = k.document_id
          WHERE ${target.kind === 'aankoop' ? 'k.purchase_invoice_id' : 'k.bank_transaction_id'} = ?
          ORDER BY k.is_primary DESC, k.document_id`,
      )
      .all(target.id) as (Row & { original_name: string; file_path: string; mime_type: string; extraction_source: string | null })[];
    return rows.map((r) => ({ ...toLink(r), original_name: r.original_name, file_path: r.file_path, mime_type: r.mime_type, extraction_source: r.extraction_source }));
  }

  /**
   * Koppelt een document. Hoort het al bij iets anders, dan gebeurt er niets en volgt een fout: eerst
   * daar de koppeling ongedaan maken. Hoort het al bij dit doel, dan blijft alles zoals het is.
   */
  link(documentId: number, target: LinkTarget, origin: LinkOrigin, provenance: LinkProvenance = 'gebruiker'): DocumentLink {
    return tx(this.db, () => {
      const existing = this.forDocument(documentId);
      if (existing) {
        if (sameTarget(existing.target, target)) return existing;
        throw new ValidationError(`Deze bon hoort al bij ${this.describe(existing.target)?.label ?? 'iets anders'}. Maak daar eerst de koppeling ongedaan.`);
      }
      if (!this.describe(target)) throw new ValidationError(target.kind === 'aankoop' ? 'Deze aankoop bestaat niet (meer)' : 'Deze betaling bestaat niet (meer)');
      this.db
        .prepare('INSERT INTO document_links (document_id, purchase_invoice_id, bank_transaction_id, origin, provenance) VALUES (?, ?, ?, ?, ?)')
        .run(documentId, target.kind === 'aankoop' ? target.id : null, target.kind === 'bank' ? target.id : null, origin, provenance);
      this.db.prepare('UPDATE documents SET purchase_invoice_id = ? WHERE id = ?').run(target.kind === 'aankoop' ? target.id : null, documentId);
      this.refresh(target);
      return this.forDocument(documentId)!;
    });
  }

  /** Haalt de koppeling weg; het doel houdt zijn andere bestanden, waarvan het beste het hoofdbewijsstuk wordt. */
  unlink(documentId: number): DocumentLink | null {
    return tx(this.db, () => {
      const link = this.forDocument(documentId);
      if (!link) return null;
      const doc = this.db.prepare('SELECT file_path FROM documents WHERE id = ?').get(documentId) as { file_path: string };
      this.db.prepare('DELETE FROM document_links WHERE id = ?').run(link.id);
      this.db.prepare('UPDATE documents SET purchase_invoice_id = NULL WHERE id = ?').run(documentId);
      this.refresh(link.target, doc.file_path);
      return link;
    });
  }

  /**
   * Kiest het hoofdbewijsstuk (best leesbaar, bij gelijke stand het oudste) en zet bij een aankoop de
   * bijlage daarop. `removedPath`: het bestand dat net is losgekoppeld; was dat de bijlage, dan vervalt die.
   */
  private refresh(target: LinkTarget, removedPath?: string): void {
    const files = this.forTarget(target);
    const best = [...files].sort((a, b) => primaryRank(b) - primaryRank(a) || a.document_id - b.document_id)[0] ?? null;
    const column = target.kind === 'aankoop' ? 'purchase_invoice_id' : 'bank_transaction_id';
    // eerst alles uit, dan één aan: de database staat nooit twee hoofdbewijsstukken toe
    this.db.prepare(`UPDATE document_links SET is_primary = 0 WHERE ${column} = ? AND is_primary = 1 AND id <> ?`).run(target.id, best?.id ?? 0);
    if (best) this.db.prepare('UPDATE document_links SET is_primary = 1 WHERE id = ? AND is_primary = 0').run(best.id);
    if (target.kind !== 'aankoop') return;
    if (best) {
      this.db.prepare('UPDATE purchase_invoices SET document_id = ?, attachment_path = ? WHERE id = ?').run(best.document_id, best.file_path, target.id);
    } else {
      this.db.prepare('UPDATE purchase_invoices SET document_id = NULL, attachment_path = CASE WHEN attachment_path = ? THEN NULL ELSE attachment_path END WHERE id = ?').run(removedPath ?? '', target.id);
    }
  }

  /** Leverancier, datum, bedrag en kenmerk van een aankoop of betaling; null als die niet (meer) bestaat. */
  describe(target: LinkTarget): TargetInfo | null {
    if (target.kind === 'aankoop') {
      const p = this.db
        .prepare('SELECT p.id, p.invoice_date, p.total, p.supplier_reference, p.description, r.name AS supplier FROM purchase_invoices p LEFT JOIN relations r ON r.id = p.relation_id WHERE p.id = ?')
        .get(target.id) as { id: number; invoice_date: IsoDate; total: Cents; supplier_reference: string | null; description: string; supplier: string | null } | undefined;
      if (!p) return null;
      return { kind: 'aankoop', id: p.id, supplier: p.supplier ?? p.description, date: p.invoice_date, amount: p.total, reference: p.supplier_reference, label: `de aankoop bij ${p.supplier ?? p.description} van ${formatDateNl(p.invoice_date)} (${formatEuro(p.total)})` };
    }
    const b = this.db.prepare('SELECT id, transaction_date, amount, counter_name, description FROM bank_transactions WHERE id = ?').get(target.id) as
      | { id: number; transaction_date: IsoDate; amount: Cents; counter_name: string | null; description: string }
      | undefined;
    if (!b) return null;
    const who = b.counter_name ?? (b.description.slice(0, 40) || 'onbekend');
    return { kind: 'bank', id: b.id, supplier: who, date: b.transaction_date, amount: -b.amount, reference: b.description || null, label: `de betaling aan ${who} van ${formatDateNl(b.transaction_date)} (${formatEuro(-b.amount)})` };
  }

  /** Wat er met een document gebeurd is, voor de schermen (in plaats van het algemene "verwerkt"). */
  outcome(doc: { id: number; status: string; duplicate_of_document_id: number | null; purchase_invoice_id: number | null; issues?: { field: string }[] }, link: DocumentLink | null = this.forDocument(doc.id)): DocumentOutcome {
    if (doc.status === 'nieuw' || doc.status === 'controle') return 'controle';
    if (link) return link.origin === 'geboekt' ? 'nieuwe-aankoop' : link.origin === 'bewijs' ? 'bewijs-gekoppeld' : 'dubbel';
    if (doc.status === 'genegeerd') return doc.duplicate_of_document_id !== null || doc.issues?.some((i) => i.field === 'duplicate') ? 'dubbel' : 'niet-geboekt';
    return doc.purchase_invoice_id !== null ? 'nieuwe-aankoop' : 'niet-geboekt';
  }
}
