import type { Db } from '../db/database';
import { tx } from '../db/database';
import type { Ledger } from './ledger';
import { compile, type CompiledEntry, type DomainEvent } from './rules';
import { RULES_VERSION } from './rules-version';
import { ValidationError } from '../shared/validation';

/** Bewijs of herkomst van een gebeurtenis: document, banktransactie, factuur, antwoord van de gebruiker. */
export interface Evidence {
  kind: 'document' | 'bank' | 'factuur' | 'inkoop' | 'antwoord' | 'bron';
  refId?: number | null;
  note?: string | null;
  confidence?: number | null;
}

export interface StoredEvent {
  id: number;
  type: DomainEvent['type'];
  event_date: string;
  payload: DomainEvent['payload'];
  status: 'actief' | 'vervangen';
  rules_version: string;
  supersedes_event_id: number | null;
  created_at: string;
  evidence: (Evidence & { id: number })[];
  entryIds: number[];
}

/**
 * Gebeurtenissen als bron van waarheid (#19): vastleggen wat er gebeurd is, met bewijs, en daar
 * met de regels (rules.ts) de boeking van maken. Corrigeren = nieuwe gebeurtenis die de oude
 * vervangt: de oude post krijgt een tegenboeking, de nieuwe wordt opnieuw gecompileerd. Een al
 * aangegeven btw-periode verandert daarbij nooit (zie Ledger.vatDateFor).
 */
export class EventService {
  constructor(private readonly db: Db, private readonly ledger: Ledger) {}

  record(event: DomainEvent, evidence: Evidence[] = [], opts: { supersedes?: number | null } = {}): { eventId: number; entryId: number } {
    return tx(this.db, () => {
      const compiled = compile(event);
      const eventId = Number(
        this.db
          .prepare('INSERT INTO events (type, event_date, payload, rules_version, supersedes_event_id) VALUES (?, ?, ?, ?, ?)')
          .run(event.type, compiled.date, JSON.stringify(event.payload), RULES_VERSION, opts.supersedes ?? null).lastInsertRowid,
      );
      const insert = this.db.prepare('INSERT INTO event_evidence (event_id, kind, ref_id, note, confidence) VALUES (?, ?, ?, ?, ?)');
      for (const e of evidence) insert.run(eventId, e.kind, e.refId ?? null, e.note ?? null, e.confidence ?? null);
      const entryId = this.ledger.post({ ...compiled, eventId });
      return { eventId, entryId };
    });
  }

  get(id: number): StoredEvent {
    const row = this.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as (Omit<StoredEvent, 'payload' | 'evidence' | 'entryIds'> & { payload: string }) | undefined;
    if (!row) throw new ValidationError(`Gebeurtenis ${id} bestaat niet`);
    const evidence = (this.db.prepare('SELECT id, kind, ref_id, note, confidence FROM event_evidence WHERE event_id = ? ORDER BY id').all(id) as {
      id: number; kind: Evidence['kind']; ref_id: number | null; note: string | null; confidence: number | null;
    }[]).map((e) => ({ id: e.id, kind: e.kind, refId: e.ref_id, note: e.note, confidence: e.confidence }));
    const entryIds = (this.db.prepare('SELECT id FROM journal_entries WHERE event_id = ? ORDER BY id').all(id) as { id: number }[]).map((r) => r.id);
    return { ...row, payload: JSON.parse(row.payload), evidence, entryIds };
  }

  /** De gebeurtenis achter een journaalpost ("waarom bestaat deze boeking?"). */
  forEntry(entryId: number): StoredEvent | null {
    const row = this.db.prepare('SELECT event_id FROM journal_entries WHERE id = ?').get(entryId) as { event_id: number | null } | undefined;
    return row?.event_id ? this.get(row.event_id) : null;
  }

  /** Opnieuw compileren uit de opgeslagen gebeurtenis (puur; boekt niets). */
  recompile(id: number): CompiledEntry {
    const e = this.get(id);
    return compile({ type: e.type, payload: e.payload } as DomainEvent);
  }

  /**
   * Vervangt een gebeurtenis door een gecorrigeerde versie: tegenboeking van de huidige post(en),
   * nieuwe gebeurtenis, nieuwe post. Bestaande posten worden nooit stil herschreven.
   */
  replace(id: number, next: DomainEvent, reason: string, date?: string): { eventId: number; entryId: number } {
    return tx(this.db, () => {
      const old = this.get(id);
      if (old.status !== 'actief') throw new ValidationError('Deze gebeurtenis is al vervangen');
      if (old.type !== next.type) throw new ValidationError('Een gebeurtenis kan alleen door eenzelfde soort vervangen worden');
      const live = this.db
        .prepare(`SELECT id FROM journal_entries WHERE event_id = ? AND status = 'definitief' AND reverses_entry_id IS NULL`)
        .all(id) as { id: number }[];
      for (const e of live) this.ledger.reverse(e.id, date ?? old.event_date, `Correctie: ${reason}`);
      this.db.prepare(`UPDATE events SET status = 'vervangen' WHERE id = ?`).run(id);
      const evidence: Evidence[] = [...old.evidence.map(({ id: _id, ...e }) => e), { kind: 'antwoord', note: reason }];
      return this.record(next, evidence, { supersedes: id });
    });
  }
}
