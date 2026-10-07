import { randomUUID } from 'node:crypto';
import type { Db } from '../db/database';
import { volgendeSyncSeq } from '../sync/teller';
import { isValidEmail, isValidForeignRegistration, isValidIban, isValidKvk, isValidVatNumber, normalizeIban, normalizeVatNumber, ValidationError } from '../shared/validation';
import { countryCode } from '../shared/vat';

export type RelationType = 'klant' | 'leverancier' | 'beide';

export interface Relation {
  id: number;
  type: RelationType;
  name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  postcode: string | null;
  city: string | null;
  country: string;
  vat_number: string | null;
  kvk_number: string | null;
  iban: string | null;
  payment_term_days: number | null;
  notes: string | null;
  /** hoe rekeningen van deze leverancier altijd betaald worden (null: van de zakelijke rekening) */
  paid_with: 'kas' | 'prive' | null;
  archived: number;
  created_at: string;
  /** sync-sleutel naast de interne id: willekeurige versie-4-uuid (NULL tot het herstel bij het openen) */
  uuid: string | null;
  /** pc-rij-revisie: begint op 1 en gaat een omhoog per echte wijziging (informatief) */
  revisie: number;
  /** bewerktijd van de laatste echte wijziging in milliseconden (informatief, nooit voor delta of sortering) */
  gewijzigd_op: number;
  /** wijzigingsnummer uit de globale teller; de enige basis voor delta-sync (0: nog niet genummerd) */
  sync_seq: number;
}

export type RelationInput = Partial<Omit<Relation, 'id' | 'archived' | 'created_at' | 'paid_with' | 'uuid' | 'revisie' | 'gewijzigd_op' | 'sync_seq'>> & { name: string; type?: RelationType };

const FIELDS = ['type', 'name', 'contact_name', 'email', 'phone', 'address', 'postcode', 'city', 'country', 'vat_number', 'kvk_number', 'iban', 'payment_term_days', 'notes'] as const;

/**
 * De ene vaste mapping van kolomnaam naar veldnaam in de sync (relation_field_rev, relation_changelog):
 * de FIELDS-kolommen houden hun eigen naam, archived heet 'gearchiveerd'. De mapping naar de namen in
 * het telefoonprotocol is niet hier maar bij het schrijfpad voor telefoonwijzigingen.
 */
export const RELATIE_VELD_MAPPING = {
  type: 'type',
  name: 'name',
  contact_name: 'contact_name',
  email: 'email',
  phone: 'phone',
  address: 'address',
  postcode: 'postcode',
  city: 'city',
  country: 'country',
  vat_number: 'vat_number',
  kvk_number: 'kvk_number',
  iban: 'iban',
  payment_term_days: 'payment_term_days',
  notes: 'notes',
  archived: 'gearchiveerd',
} as const satisfies Record<(typeof FIELDS)[number] | 'archived', string>;

/** Bron van een wijziging die op de pc zelf is gedaan (een telefoon heeft een apparaatcode, zoals M1). */
const BRON_PC = 'pc';

/**
 * Administratie voor sync, bijgehouden voor elke lokale wijziging in dezelfde transactie als de
 * schrijfactie zelf: uuid, revisie (een per echte wijziging), gewijzigd_op, sync_seq uit de globale
 * teller, de tijd per veld (relation_field_rev) en een logregel per gewijzigd veld (relation_changelog).
 * Regel voor velden zonder rij in relation_field_rev (bestaande klanten van vóór de migratie): tijd =
 * created_at van de klant in milliseconden en bron 'pc'; dus niet gewijzigd_op en niet 0.
 * Een schrijfactie zonder echte verandering schrijft niets, ook niet in de administratie.
 */
export class RelationsService {
  constructor(
    private readonly db: Db,
    private readonly klok: () => number = Date.now,
  ) {}

  list(filter: { type?: 'klant' | 'leverancier'; search?: string; includeArchived?: boolean } = {}): Relation[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (!filter.includeArchived) where.push('archived = 0');
    if (filter.type) (where.push(`type IN (?, 'beide')`), params.push(filter.type));
    if (filter.search) {
      where.push('(name LIKE ? OR email LIKE ? OR city LIKE ? OR contact_name LIKE ?)');
      const s = `%${filter.search}%`;
      params.push(s, s, s, s);
    }
    return this.db
      .prepare(`SELECT * FROM relations ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY name COLLATE NOCASE`)
      .all(...params) as Relation[];
  }

  get(id: number): Relation {
    const r = this.db.prepare('SELECT * FROM relations WHERE id = ?').get(id) as Relation | undefined;
    if (!r) throw new ValidationError('Deze klant of leverancier bestaat niet (meer)');
    return r;
  }

  findByIban(iban: string): Relation | undefined {
    return this.db.prepare('SELECT * FROM relations WHERE iban = ? AND archived = 0 LIMIT 1').get(normalizeIban(iban)) as Relation | undefined;
  }

  findByEmail(email: string): Relation | undefined {
    return this.db.prepare('SELECT * FROM relations WHERE lower(email) = lower(?) AND archived = 0 LIMIT 1').get(email.trim()) as Relation | undefined;
  }

  /** Zoekt een leverancier op naam of maakt hem aan (voor bonnetjes en inkoopfacturen). */
  findOrCreateSupplier(name: string, extra: Partial<RelationInput> = {}): Relation {
    const existing = this.db.prepare('SELECT * FROM relations WHERE lower(name) = lower(?) AND archived = 0 LIMIT 1').get(name.trim()) as Relation | undefined;
    if (existing) return existing;
    return this.create({ ...extra, name: name.trim(), type: 'leverancier' });
  }

  create(input: RelationInput): Relation {
    const clean = this.clean({ type: 'klant', country: 'NL', ...input });
    const cols = FIELDS.filter((f) => clean[f] !== undefined);
    const id = this.db.transaction(() => {
      const tijd = this.klok();
      const result = this.db
        .prepare(`INSERT INTO relations (${cols.join(', ')}, uuid, revisie, gewijzigd_op, sync_seq) VALUES (${cols.map(() => '?').join(', ')}, ?, 1, ?, ?)`)
        .run(...cols.map((c) => clean[c] ?? null), randomUUID(), tijd, volgendeSyncSeq(this.db));
      const nieuwId = Number(result.lastInsertRowid);
      for (const veld of cols) {
        if (clean[veld] == null) continue;
        this.schrijfVeld(nieuwId, 1, RELATIE_VELD_MAPPING[veld], null, clean[veld], tijd);
      }
      return nieuwId;
    })();
    return this.get(id);
  }

  /** "Deze betaal ik altijd privé/contant": nieuwe rekeningen van deze leverancier staan meteen op betaald. */
  setPaidWith(id: number, paidWith: 'kas' | 'prive' | null): Relation {
    this.get(id);
    this.db.prepare('UPDATE relations SET paid_with = ? WHERE id = ?').run(paidWith, id);
    return this.get(id);
  }

  update(id: number, input: Partial<RelationInput>): Relation {
    const existing = this.get(id);
    const clean = this.clean({ ...existing, ...input } as RelationInput);
    const gewijzigd = FIELDS.filter((f) => (existing[f] ?? null) !== (clean[f] ?? null));
    if (gewijzigd.length === 0) return existing;
    this.db.transaction(() => {
      const tijd = this.klok();
      const revisie = existing.revisie + 1;
      this.db
        .prepare(`UPDATE relations SET ${FIELDS.map((f) => `${f} = ?`).join(', ')}, revisie = ?, gewijzigd_op = ?, sync_seq = ? WHERE id = ?`)
        .run(...FIELDS.map((f) => clean[f] ?? null), revisie, tijd, volgendeSyncSeq(this.db), id);
      for (const veld of gewijzigd) this.schrijfVeld(id, revisie, RELATIE_VELD_MAPPING[veld], existing[veld], clean[veld], tijd);
    })();
    return this.get(id);
  }

  archive(id: number): void {
    const existing = this.db.prepare('SELECT * FROM relations WHERE id = ?').get(id) as Relation | undefined;
    // een onbekend id of een al gearchiveerde klant doet stilletjes niets
    if (!existing || existing.archived === 1) return;
    this.db.transaction(() => {
      const tijd = this.klok();
      const revisie = existing.revisie + 1;
      this.db
        .prepare('UPDATE relations SET archived = 1, revisie = ?, gewijzigd_op = ?, sync_seq = ? WHERE id = ?')
        .run(revisie, tijd, volgendeSyncSeq(this.db), id);
      this.schrijfVeld(id, revisie, RELATIE_VELD_MAPPING.archived, existing.archived, 1, tijd);
    })();
  }

  /** De tijd per veld (een rij per klant en veld) en een logregel; oud en nieuw als tekst, null blijft NULL. */
  private schrijfVeld(relationId: number, revisie: number, veld: string, oud: unknown, nieuw: unknown, tijd: number): void {
    this.db
      .prepare(
        `INSERT INTO relation_field_rev (relation_id, veld, tijd, bron) VALUES (?, ?, ?, ?)
         ON CONFLICT(relation_id, veld) DO UPDATE SET tijd = excluded.tijd, bron = excluded.bron`,
      )
      .run(relationId, veld, tijd, BRON_PC);
    const tekst = (v: unknown) => (v == null ? null : String(v));
    this.db
      .prepare('INSERT INTO relation_changelog (relation_id, revisie, veld, oud, nieuw, tijd, bron) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(relationId, revisie, veld, tekst(oud), tekst(nieuw), tijd, BRON_PC);
  }

  private clean(input: RelationInput): Record<(typeof FIELDS)[number], unknown> {
    const name = input.name?.trim();
    if (!name) throw new ValidationError('Naam is verplicht');
    const t = (v: unknown) => (typeof v === 'string' ? v.trim() || null : v ?? null);
    const email = t(input.email) as string | null;
    if (email && !isValidEmail(email)) throw new ValidationError(`Dit e-mailadres klopt niet: ${email}`);
    const iban = input.iban ? normalizeIban(input.iban) : null;
    if (iban && !isValidIban(iban)) throw new ValidationError(`Dit rekeningnummer klopt niet: ${input.iban}`);
    const vat = input.vat_number && input.vat_number.trim() ? normalizeVatNumber(input.vat_number) : null;
    if (vat && !isValidVatNumber(vat)) throw new ValidationError(`Dit btw-nummer klopt niet: ${input.vat_number}`);
    // KvK alleen bij een Nederlands bedrijf; een buitenlands bedrijf heeft een eigen handelsregisternummer
    const dutch = (countryCode(input.country && input.country.trim() ? input.country : 'NL') ?? 'NL') === 'NL';
    const kvk = input.kvk_number && input.kvk_number.trim() ? (dutch ? input.kvk_number.replace(/\s/g, '') : input.kvk_number.trim()) : null;
    if (kvk && dutch && !isValidKvk(kvk)) throw new ValidationError(`Dit KvK-nummer klopt niet (het heeft 8 cijfers): ${input.kvk_number}`);
    if (kvk && !dutch && !isValidForeignRegistration(kvk)) throw new ValidationError(`Dit handelsregisternummer klopt niet: ${input.kvk_number}`);
    const type = input.type ?? 'klant';
    if (!['klant', 'leverancier', 'beide'].includes(type)) throw new ValidationError('Kies klant, leverancier of allebei');
    const term = input.payment_term_days;
    if (term != null && (!Number.isInteger(term) || term < 0 || term > 365)) throw new ValidationError('Betaaltermijn moet tussen 0 en 365 dagen liggen');
    if (input.country && input.country.trim() && !countryCode(input.country)) throw new ValidationError(`Dit land kennen we niet: ${input.country}. Gebruik twee letters, bijvoorbeeld DE of US.`);
    return {
      type,
      name,
      contact_name: t(input.contact_name),
      email,
      phone: t(input.phone),
      address: t(input.address),
      postcode: input.postcode ? input.postcode.replace(/\s+/g, ' ').trim().toUpperCase() : null,
      city: t(input.city),
      country: (t(input.country) as string | null)?.toUpperCase() ?? 'NL',
      vat_number: vat,
      kvk_number: kvk,
      iban,
      payment_term_days: term ?? null,
      notes: t(input.notes),
    };
  }
}
