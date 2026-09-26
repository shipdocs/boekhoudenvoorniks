import type { Db } from '../db/database';
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
  archived: number;
  created_at: string;
}

export type RelationInput = Partial<Omit<Relation, 'id' | 'archived' | 'created_at'>> & { name: string; type?: RelationType };

const FIELDS = ['type', 'name', 'contact_name', 'email', 'phone', 'address', 'postcode', 'city', 'country', 'vat_number', 'kvk_number', 'iban', 'payment_term_days', 'notes'] as const;

export class RelationsService {
  constructor(private readonly db: Db) {}

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
    const result = this.db
      .prepare(`INSERT INTO relations (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .run(...cols.map((c) => clean[c] ?? null));
    return this.get(Number(result.lastInsertRowid));
  }

  update(id: number, input: Partial<RelationInput>): Relation {
    const existing = this.get(id);
    const clean = this.clean({ ...existing, ...input } as RelationInput);
    this.db.prepare(`UPDATE relations SET ${FIELDS.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`).run(...FIELDS.map((f) => clean[f] ?? null), id);
    return this.get(id);
  }

  archive(id: number): void {
    this.db.prepare('UPDATE relations SET archived = 1 WHERE id = ?').run(id);
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
