import { randomUUID } from 'node:crypto';
import type { Db } from '../db/database';
import { tx } from '../db/database';
import { volgendeSyncSeq } from '../sync/teller';

/**
 * De administratie van een klus voor de sync, op databaseniveau zodat JobService en InvoiceService hem
 * allebei kunnen gebruiken (invoices.ts importeert JobService niet). Alles gaat in dezelfde transactie
 * als de schrijfactie zelf: revisie (een per echte wijziging), gewijzigd_op, sync_seq uit de globale
 * teller, de tijd per veld (job_field_rev) en een logregel per gewijzigd veld (job_changelog).
 *
 * Een schrijfactie zonder echte verandering schrijft niets, ook niet in de administratie. Een veld
 * zonder rij in job_field_rev (een klus van vóór de sync) heeft als tijd veldOndergrens(created_at) en
 * als bron pc; dat regelt de ontvangst, niet de migratie.
 */

/** Bron van een wijziging die op de pc zelf is gedaan (een telefoon heeft een apparaatcode, zoals M1). */
export const BRON_PC = 'pc';

/**
 * De ene vaste mapping van kolomnaam naar veldnaam in job_field_rev en job_changelog: de kolommen die
 * een gebruiker of telefoon kan zetten houden hun eigen naam, archived heet 'gearchiveerd'.
 * lat, lon en quote_id zijn geen telefoonvelden en staan hier dus niet in.
 */
export const JOB_VELD_MAPPING = {
  title: 'title',
  address: 'address',
  start_date: 'start_date',
  end_date: 'end_date',
  notes: 'notes',
  status: 'status',
  relation_id: 'relation_id',
  archived: 'gearchiveerd',
} as const;
export type JobKolom = keyof typeof JOB_VELD_MAPPING;
/** De kolommen in vaste volgorde. */
export const JOB_KOLOMMEN = Object.keys(JOB_VELD_MAPPING) as JobKolom[];
export type JobWaarde = string | number | null;

const naarTekst = (v: unknown) => (v == null ? null : String(v));

/** De tijd per veld (een rij per klus en veld) en een logregel; oud en nieuw als tekst, null blijft NULL. */
export function schrijfJobVeld(db: Db, jobId: number, revisie: number, veld: string, oud: unknown, nieuw: unknown, tijd: number, bron: string = BRON_PC): void {
  db.prepare(
    `INSERT INTO job_field_rev (job_id, veld, tijd, bron) VALUES (?, ?, ?, ?)
     ON CONFLICT(job_id, veld) DO UPDATE SET tijd = excluded.tijd, bron = excluded.bron`,
  ).run(jobId, veld, tijd, bron);
  db.prepare('INSERT INTO job_changelog (job_id, revisie, veld, oud, nieuw, tijd, bron) VALUES (?, ?, ?, ?, ?, ?, ?)').run(jobId, revisie, veld, naarTekst(oud), naarTekst(nieuw), tijd, bron);
}

/** Alleen een logregel, zonder iets aan de klus of de veldtijd te veranderen (een overgeslagen telefoonveld). */
export function logJobVeld(db: Db, jobId: number, revisie: number, veld: string, oud: unknown, nieuw: unknown, tijd: number, bron: string): void {
  db.prepare('INSERT INTO job_changelog (job_id, revisie, veld, oud, nieuw, tijd, bron) VALUES (?, ?, ?, ?, ?, ?, ?)').run(jobId, revisie, veld, naarTekst(oud), naarTekst(nieuw), tijd, bron);
}

/** Maakt een klus aan met de administratie: uuid, revisie 1, wijzigingsnummer en een veldrij per ingevuld veld (bron pc). */
export function maakJobAan(
  db: Db,
  input: { relationId: number; quoteId?: number | null; title: string; address?: string | null; startDate?: string | null; notes?: string | null },
  klok: () => number = Date.now,
): number {
  return tx(db, () => {
    const tijd = klok();
    const result = db
      .prepare('INSERT INTO jobs (relation_id, quote_id, title, address, start_date, notes, uuid, revisie, gewijzigd_op, sync_seq) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)')
      .run(input.relationId, input.quoteId ?? null, input.title, input.address ?? null, input.startDate ?? null, input.notes ?? null, randomUUID(), tijd, volgendeSyncSeq(db));
    const id = Number(result.lastInsertRowid);
    const ingevuld: [JobKolom, JobWaarde][] = [
      ['title', input.title],
      ['relation_id', input.relationId],
      ['status', 'gepland'],
      ['address', input.address ?? null],
      ['start_date', input.startDate ?? null],
      ['notes', input.notes ?? null],
    ];
    for (const [kolom, waarde] of ingevuld) if (waarde !== null) schrijfJobVeld(db, id, 1, JOB_VELD_MAPPING[kolom], null, waarde, tijd);
    return id;
  });
}

/**
 * Zet kolommen van een bestaande klus vanaf de pc. Alleen echt gewijzigde kolommen tellen: is er
 * niets veranderd, dan gebeurt er niets (geen revisie, geen wijzigingsnummer) en is het antwoord false.
 * Anders gaat de revisie een omhoog, krijgt de klus een nieuw wijzigingsnummer en gewijzigd_op de pc-klok,
 * en komt elk gewijzigd veld met bron pc in job_field_rev en job_changelog. Alles in een transactie.
 */
export function wijzigJob(db: Db, id: number, patch: Partial<Record<JobKolom, JobWaarde>>, klok: () => number = Date.now): boolean {
  return tx(db, () => {
    const rij = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!rij) return false;
    const gewijzigd = JOB_KOLOMMEN.filter((k) => Object.hasOwn(patch, k) && (rij[k] ?? null) !== (patch[k] ?? null));
    if (gewijzigd.length === 0) return false;
    const tijd = klok();
    const revisie = (rij.revisie as number) + 1;
    db.prepare(`UPDATE jobs SET ${gewijzigd.map((k) => `${k} = ?`).join(', ')}, revisie = ?, gewijzigd_op = ?, sync_seq = ? WHERE id = ?`).run(
      ...gewijzigd.map((k) => patch[k] ?? null),
      revisie,
      tijd,
      volgendeSyncSeq(db),
      id,
    );
    for (const kolom of gewijzigd) schrijfJobVeld(db, id, revisie, JOB_VELD_MAPPING[kolom], rij[kolom], patch[kolom], tijd);
    return true;
  });
}
