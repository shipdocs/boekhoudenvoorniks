import { randomUUID } from 'node:crypto';
import type { Db } from '../db/database';
import { veldOndergrens } from '../sync/ondergrens';
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
 * De regels per veld van een klant of leverancier, los van de rest van de rij. clean() roept ze aan in
 * de oude volgorde (de meldingen zijn woordelijk gelijk gebleven) en het schrijfpad voor
 * telefoonwijzigingen gebruikt dezelfde functies, zodat een veld op beide plekken hetzelfde wordt beoordeeld.
 */
const tekst = (v: unknown) => (typeof v === 'string' ? v.trim() || null : v ?? null);

export function controleerEmail(raw: string | null | undefined): string | null {
  const email = tekst(raw) as string | null;
  if (email && !isValidEmail(email)) throw new ValidationError(`Dit e-mailadres klopt niet: ${email}`);
  return email;
}

export function controleerIban(raw: string | null | undefined): string | null {
  const iban = raw ? normalizeIban(raw) : null;
  if (iban && !isValidIban(iban)) throw new ValidationError(`Dit rekeningnummer klopt niet: ${raw}`);
  return iban;
}

export function controleerBtwNummer(raw: string | null | undefined): string | null {
  const vat = raw && raw.trim() ? normalizeVatNumber(raw) : null;
  if (vat && !isValidVatNumber(vat)) throw new ValidationError(`Dit btw-nummer klopt niet: ${raw}`);
  return vat;
}

export function controleerBetaaltermijn(term: number | null | undefined): number | null {
  if (term != null && (!Number.isInteger(term) || term < 0 || term > 365)) throw new ValidationError('Betaaltermijn moet tussen 0 en 365 dagen liggen');
  return term ?? null;
}

/** Een land als twee letters in hoofdletters; leeg wordt NL. */
export function controleerLand(raw: string | null | undefined): string {
  if (raw && raw.trim() && !countryCode(raw)) throw new ValidationError(`Dit land kennen we niet: ${raw}. Gebruik twee letters, bijvoorbeeld DE of US.`);
  return (tekst(raw) as string | null)?.toUpperCase() ?? 'NL';
}

export function schoonPostcode(raw: string | null | undefined): string | null {
  return raw ? raw.replace(/\s+/g, ' ').trim().toUpperCase() : null;
}

/**
 * De ene regel voor KvK en land, voor de pc (clean) en voor de telefoon (maakVanSync en pasVeldenToe):
 * bij Nederland (een leeg of ontbrekend land telt als NL) precies 8 cijfers, spaties worden weggehaald;
 * bij een buitenlands land een geldig handelsregisternummer. Geeft het bewaarde nummer terug (leeg wordt null).
 */
export function controleerKvkBijLand(kvkNummer: string | null | undefined, land: string | null | undefined): string | null {
  if (!kvkNummer || !kvkNummer.trim()) return null;
  const dutch = (countryCode(land && land.trim() ? land : 'NL') ?? 'NL') === 'NL';
  const kvk = dutch ? kvkNummer.replace(/\s/g, '') : kvkNummer.trim();
  if (dutch && !isValidKvk(kvk)) throw new ValidationError(`Dit KvK-nummer klopt niet (het heeft 8 cijfers): ${kvkNummer}`);
  if (!dutch && !isValidForeignRegistration(kvk)) throw new ValidationError(`Dit handelsregisternummer klopt niet: ${kvkNummer}`);
  return kvk;
}

/**
 * Het KvK-nummer van een telefoonwijziging, los van het land (dat kan in een andere wijziging staan):
 * alleen opschonen. Of het nummer klopt hangt van het land af en wordt bij het toepassen gecontroleerd
 * op de uiteindelijke combinatie, met controleerKvkBijLand.
 */
function schoonKvkVoorSync(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  const zonderSpaties = raw.replace(/\s/g, '');
  return /^\d{8}$/.test(zonderSpaties) ? zonderSpaties : raw.trim();
}

/**
 * Controleert de combinatie van land en KvK-nummer zoals die na een telefoonwijziging in de klant zou
 * staan, met dezelfde regel als de pc. Gooit een KlantVeldFout met kvk_number als dat veld in de
 * wijziging zit, anders met country (het land is dan de oorzaak).
 */
function controleerKvkLandCombinatie(kvk: unknown, land: unknown, kvkInWijziging: boolean): void {
  try {
    controleerKvkBijLand(kvk as string | null, land as string | null);
  } catch (e) {
    if (!(e instanceof ValidationError)) throw e;
    if (kvkInWijziging) throw new KlantVeldFout('kvk_number', e.message);
    throw new KlantVeldFout('country', `Het land past niet bij het KvK-nummer van deze klant (${kvk}). ${e.message}`);
  }
}

/** Een klantveld van een telefoonwijziging dat niet klopt, met de kolom waar het om gaat. */
export class KlantVeldFout extends ValidationError {
  constructor(
    readonly kolom: string,
    message: string,
  ) {
    super(message);
  }
}

/** De kolommen die een telefoon mag zetten, in vaste volgorde (type en paid_with niet). */
const SYNC_KOLOMMEN = ['name', 'contact_name', 'email', 'phone', 'address', 'postcode', 'city', 'country', 'vat_number', 'kvk_number', 'iban', 'payment_term_days', 'notes', 'archived'] as const;
type SyncKolom = (typeof SYNC_KOLOMMEN)[number];
export type SyncWaarde = string | number | null;

function normaliseerSyncVeld(kolom: SyncKolom, waarde: unknown): SyncWaarde {
  const w = waarde as string | null;
  switch (kolom) {
    case 'name': {
      const naam = typeof waarde === 'string' ? waarde.trim() : '';
      if (!naam) throw new ValidationError('Naam is verplicht');
      return naam;
    }
    case 'email':
      return controleerEmail(w);
    case 'iban':
      return controleerIban(w);
    case 'vat_number':
      return controleerBtwNummer(w);
    case 'kvk_number':
      return schoonKvkVoorSync(w);
    case 'postcode':
      return schoonPostcode(w);
    case 'country':
      return controleerLand(w);
    case 'payment_term_days':
      return controleerBetaaltermijn(waarde as number | null);
    case 'archived':
      if (waarde !== 0 && waarde !== 1) throw new ValidationError('Gearchiveerd is 0 of 1');
      return waarde;
    default:
      return tekst(waarde) as string | null;
  }
}

/**
 * Controleert en normaliseert de velden (per kolom) van een telefoonwijziging, ieder los van de rest.
 * Gooit een KlantVeldFout met de kolom bij het eerste veld dat niet klopt. De uitkomst is een nieuw
 * object zonder prototype.
 */
export function normaliseerSyncVelden(velden: Record<string, unknown>): Record<string, SyncWaarde> {
  const uit = Object.create(null) as Record<string, SyncWaarde>;
  for (const kolom of Object.keys(velden)) {
    if (!(SYNC_KOLOMMEN as readonly string[]).includes(kolom)) throw new KlantVeldFout(kolom, 'Dit veld mag een telefoon niet wijzigen');
    try {
      uit[kolom] = normaliseerSyncVeld(kolom as SyncKolom, velden[kolom]);
    } catch (e) {
      if (e instanceof ValidationError) throw new KlantVeldFout(kolom, e.message);
      throw e;
    }
  }
  return uit;
}

/**
 * Wint een nieuwe veldwaarde van de huidige? De nieuwste tijd wint; bij gelijke tijd de lexicografisch
 * grootste bron (pc wint van M1); bij gelijke tijd en bron de grootste waarde als tekst. Zo geeft elke
 * volgorde van aankomst dezelfde eindtoestand.
 */
export function wintVeld(nieuw: { tijd: number; bron: string; waarde: unknown }, huidig: { tijd: number; bron: string; waarde: unknown }): boolean {
  if (nieuw.tijd !== huidig.tijd) return nieuw.tijd > huidig.tijd;
  if (nieuw.bron !== huidig.bron) return nieuw.bron > huidig.bron;
  const als = (v: unknown) => (v == null ? '' : String(v));
  return als(nieuw.waarde) > als(huidig.waarde);
}

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

  /**
   * Zoekt een klant op de uuid van de sync: eerst in relation_aliases, daarna direct in relations.uuid (alleen lezen).
   * De alias gaat voor: na het samenvoegen houdt de gearchiveerde bron zijn eigen uuid, maar de telefoon moet dan
   * bij het doel uitkomen en niet bij de bron. Een uuid die geen alias is, wordt zoals altijd direct gevonden.
   */
  vindOpSyncUuid(uuid: string): Relation | undefined {
    const viaAlias = this.db
      .prepare('SELECT r.* FROM relation_aliases a JOIN relations r ON r.id = a.relation_id WHERE a.alias_uuid = ?')
      .get(uuid) as Relation | undefined;
    if (viaAlias) return viaAlias;
    return this.db.prepare('SELECT * FROM relations WHERE uuid = ?').get(uuid) as Relation | undefined;
  }

  /**
   * Schrijft een alias: de uuid die de telefoon kent wijst naar een klant van de pc. Een alias wordt alleen
   * toegevoegd of naar een ander doel verlegd, nooit verwijderd. Bestaat de alias al met hetzelfde doel, dan
   * verandert er niets. Geeft true als er een rij is toegevoegd of verlegd.
   */
  schrijfAlias(aliasUuid: string, relationId: number, tijd: number = this.klok()): boolean {
    return (
      this.db
        .prepare(
          `INSERT INTO relation_aliases (alias_uuid, relation_id, aangemaakt_op) VALUES (?, ?, ?)
           ON CONFLICT(alias_uuid) DO UPDATE SET relation_id = excluded.relation_id WHERE relation_aliases.relation_id <> excluded.relation_id`,
        )
        .run(aliasUuid, relationId, tijd).changes === 1
    );
  }

  /**
   * Voegt twee klanten samen na een expliciete keuze van de gebruiker (deze methode beslist niets zelf): de bron wordt
   * gearchiveerd via archive() (revisie, nieuw wijzigingsnummer, tijd per veld en logregel), krijgt een extra logregel met
   * de reden, en de uuid van de bron wordt een alias van het doel zodat de telefoon voortaan naar het doel wijst. Aliassen
   * die al naar de bron wezen gaan naar het doel. Het doel krijgt een nieuw wijzigingsnummer, zodat de delta van een
   * telefoon het doel en de alias meeneemt. Facturen, offertes, klussen, betalingen en documenten van de bron blijven
   * bij de bron: er verhuist en verdwijnt niets. Alles in een transactie; bij een weigering is niets gewijzigd.
   */
  voegSamen(bronId: number, doelId: number, reden: string = 'samengevoegd'): { aliasGeschreven: boolean } {
    if (!Number.isInteger(bronId) || bronId <= 0 || !Number.isInteger(doelId) || doelId <= 0) throw new ValidationError('Kies twee klanten om samen te voegen');
    if (bronId === doelId) throw new ValidationError('Een klant kun je niet met zichzelf samenvoegen');
    return this.db.transaction(() => {
      const bron = this.get(bronId);
      const doel = this.get(doelId);
      for (const k of [bron, doel]) {
        if (k.type === 'leverancier') throw new ValidationError(`${k.name} is een leverancier en geen klant; leveranciers voeg je niet samen`);
        if (k.archived === 1) throw new ValidationError(`${k.name} is al gearchiveerd; een gearchiveerde klant voeg je niet samen`);
      }
      if (bron.uuid) {
        const bestaand = this.db.prepare('SELECT relation_id FROM relation_aliases WHERE alias_uuid = ?').get(bron.uuid) as { relation_id: number } | undefined;
        if (bestaand?.relation_id === doel.id) throw new ValidationError(`${bron.name} is al samengevoegd met ${doel.name}`);
      }
      this.archive(bron.id);
      const tijd = this.klok();
      const gearchiveerd = this.get(bron.id);
      this.db
        .prepare('INSERT INTO relation_changelog (relation_id, revisie, veld, oud, nieuw, tijd, bron) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(bron.id, gearchiveerd.revisie, 'samengevoegd', null, `klant ${doel.id}: ${reden}`, tijd, BRON_PC);
      this.db.prepare('UPDATE relation_aliases SET relation_id = ? WHERE relation_id = ?').run(doel.id, bron.id);
      const aliasGeschreven = bron.uuid ? this.schrijfAlias(bron.uuid, doel.id, tijd) : false;
      this.db.prepare('UPDATE relations SET sync_seq = ? WHERE id = ?').run(volgendeSyncSeq(this.db), doel.id);
      return { aliasGeschreven };
    })();
  }

  /**
   * Maakt een nieuwe klant van een telefoonwijziging: type klant en land NL tenzij opgegeven, de uuid
   * van de telefoon, revisie 1, een nieuw wijzigingsnummer, en per meegestuurd veld een tijdrij en een
   * logregel met de apparaatcode als bron en de bewerktijd als tijd. Alles in een transactie. De
   * velden zijn per kolom (zie KLANT_VELDEN); naam is verplicht.
   *
   * De velden die de telefoon niet meestuurt krijgen een tijdrij met tijd 0 en een lege bron (zonder
   * logregel): niemand heeft ze nog gezet, dus elke latere wijziging wint, ook een oudere revisie die
   * pas na deze komt. Zonder die rijen zou de ondergrens uit created_at (het moment van aankomst op de pc)
   * zo'n latere wijziging ten onrechte afwijzen, en hing de eindtoestand van de volgorde af.
   */
  maakVanSync(uuid: string, velden: Record<string, unknown>, tijd: number, bron: string): Relation {
    const schoon = normaliseerSyncVelden(velden);
    if (typeof schoon.name !== 'string') throw new KlantVeldFout('name', 'Naam is verplicht voor een nieuwe klant');
    if (schoon.kvk_number) controleerKvkLandCombinatie(schoon.kvk_number, schoon.country ?? 'NL', true);
    const kolommen = SYNC_KOLOMMEN.filter((k) => Object.hasOwn(schoon, k));
    const id = this.db.transaction(() => {
      const result = this.db
        .prepare(`INSERT INTO relations (type, ${kolommen.join(', ')}, uuid, revisie, gewijzigd_op, sync_seq) VALUES ('klant', ${kolommen.map(() => '?').join(', ')}, ?, 1, ?, ?)`)
        .run(...kolommen.map((k) => schoon[k] ?? null), uuid, tijd, volgendeSyncSeq(this.db));
      const nieuwId = Number(result.lastInsertRowid);
      for (const kolom of kolommen) this.schrijfVeld(nieuwId, 1, RELATIE_VELD_MAPPING[kolom], null, schoon[kolom], tijd, bron);
      const nogLeeg = this.db.prepare('INSERT INTO relation_field_rev (relation_id, veld, tijd, bron) VALUES (?, ?, 0, \'\') ON CONFLICT(relation_id, veld) DO NOTHING');
      for (const kolom of SYNC_KOLOMMEN) if (!kolommen.includes(kolom)) nogLeeg.run(nieuwId, RELATIE_VELD_MAPPING[kolom]);
      return nieuwId;
    })();
    return this.get(id);
  }

  /**
   * Past velden van een telefoonwijziging toe op een bestaande klant, per veld op (tijd, bron): de
   * nieuwste wint, bij gelijke tijd de lexicografisch grootste bron, en een veld met een oudere tijd
   * wordt overgeslagen zonder logregel. Een veld zonder rij in relation_field_rev heeft als tijd de
   * ondergrens uit created_at en als bron pc. Is minstens één veld toegepast, dan gaat de revisie met één
   * omhoog, krijgt de klant een nieuw wijzigingsnummer en wordt gewijzigd_op de hoogste van de oude
   * waarde en de toegepaste veldtijden; elk toegepast veld komt in relation_field_rev en relation_changelog.
   * Een veld dat wint wordt ook toegepast als de waarde gelijk is: de veldtijd moet het resultaat
   * bepalen, anders hangt de eindtoestand af van de volgorde. Met `viaAlias` (de wijziging was voor een andere uuid dan
   * die van deze klant) blijft het veld archived buiten beschouwing. Alles in een transactie.
   */
  pasVeldenToe(id: number, velden: Record<string, unknown>, tijd: number, bron: string, opties: { viaAlias?: boolean } = {}): { toegepast: string[]; overgeslagen: string[] } {
    const schoon = normaliseerSyncVelden(velden);
    return this.db.transaction(() => {
      const bestaand = this.get(id);
      const rij = bestaand as unknown as Record<string, unknown>;
      const ondergrens = veldOndergrens(bestaand.created_at);
      const revisie = bestaand.revisie + 1;
      const toegepast: string[] = [];
      const overgeslagen: string[] = [];
      const zetten: SyncKolom[] = [];
      for (const kolom of SYNC_KOLOMMEN) {
        if (!Object.hasOwn(schoon, kolom)) continue;
        // een wijziging die via een alias op het doel landt (de telefoon kent de samengevoegde bron) archiveert het doel nooit
        if (opties.viaAlias && kolom === 'archived') continue;
        const veld = RELATIE_VELD_MAPPING[kolom];
        const opgeslagen = this.db.prepare('SELECT tijd, bron FROM relation_field_rev WHERE relation_id = ? AND veld = ?').get(id, veld) as { tijd: number; bron: string } | undefined;
        const huidig = { ...(opgeslagen ?? { tijd: ondergrens, bron: BRON_PC }), waarde: rij[kolom] };
        if (!wintVeld({ tijd, bron, waarde: schoon[kolom] }, huidig)) {
          overgeslagen.push(veld);
          continue;
        }
        toegepast.push(veld);
        zetten.push(kolom);
        this.schrijfVeld(id, revisie, veld, rij[kolom], schoon[kolom], tijd, bron);
      }
      if (zetten.length === 0) return { toegepast, overgeslagen };
      // de telefoon bewaart nooit een combinatie die update() zou weigeren: de uiteindelijke stand telt
      if (zetten.includes('kvk_number') || zetten.includes('country')) {
        const eind = (k: SyncKolom) => (zetten.includes(k) ? schoon[k] : rij[k]);
        controleerKvkLandCombinatie(eind('kvk_number'), eind('country'), zetten.includes('kvk_number'));
      }
      this.db
        .prepare(`UPDATE relations SET ${zetten.map((k) => `${k} = ?`).join(', ')}, revisie = ?, gewijzigd_op = ?, sync_seq = ? WHERE id = ?`)
        .run(...zetten.map((k) => schoon[k] ?? null), revisie, Math.max(bestaand.gewijzigd_op, tijd), volgendeSyncSeq(this.db), id);
      return { toegepast, overgeslagen };
    })();
  }

  /** De tijd per veld (een rij per klant en veld) en een logregel; oud en nieuw als tekst, null blijft NULL. */
  private schrijfVeld(relationId: number, revisie: number, veld: string, oud: unknown, nieuw: unknown, tijd: number, bron: string = BRON_PC): void {
    this.db
      .prepare(
        `INSERT INTO relation_field_rev (relation_id, veld, tijd, bron) VALUES (?, ?, ?, ?)
         ON CONFLICT(relation_id, veld) DO UPDATE SET tijd = excluded.tijd, bron = excluded.bron`,
      )
      .run(relationId, veld, tijd, bron);
    const naarTekst = (v: unknown) => (v == null ? null : String(v));
    this.db
      .prepare('INSERT INTO relation_changelog (relation_id, revisie, veld, oud, nieuw, tijd, bron) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(relationId, revisie, veld, naarTekst(oud), naarTekst(nieuw), tijd, bron);
  }

  private clean(input: RelationInput): Record<(typeof FIELDS)[number], unknown> {
    const name = input.name?.trim();
    if (!name) throw new ValidationError('Naam is verplicht');
    const t = tekst;
    const email = controleerEmail(input.email);
    const iban = controleerIban(input.iban);
    const vat = controleerBtwNummer(input.vat_number);
    // KvK alleen bij een Nederlands bedrijf; een buitenlands bedrijf heeft een eigen handelsregisternummer (dezelfde regel als de telefoon)
    const kvk = controleerKvkBijLand(input.kvk_number, input.country);
    const type = input.type ?? 'klant';
    if (!['klant', 'leverancier', 'beide'].includes(type)) throw new ValidationError('Kies klant, leverancier of allebei');
    const term = controleerBetaaltermijn(input.payment_term_days);
    const country = controleerLand(input.country);
    return {
      type,
      name,
      contact_name: t(input.contact_name),
      email,
      phone: t(input.phone),
      address: t(input.address),
      postcode: schoonPostcode(input.postcode),
      city: t(input.city),
      country,
      vat_number: vat,
      kvk_number: kvk,
      iban,
      payment_term_days: term,
      notes: t(input.notes),
    };
  }
}
