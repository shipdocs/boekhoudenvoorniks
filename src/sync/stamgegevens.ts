import type { Db } from '../db/database';
import { KLANT_VELDEN, PROJECT_VELDEN } from '@gratis-boekhouden/kern';
import { JOB_VELD_MAPPING, BRON_PC, type JobKolom } from '../jobs/revisie';
import { RELATIE_VELD_MAPPING } from '../relations/relations';
import { veldOndergrens } from './ondergrens';

/**
 * De stamgegevens die de pc aan een gekoppelde telefoon teruggeeft: klanten en projecten, plus de
 * aliassen van samengevoegde klanten. Dit is het eerste bericht waarmee gegevens UIT de administratie
 * naar de telefoon gaan, dus:
 *
 * - Whitelist boven blacklist. Elk item wordt veld voor veld opgebouwd uit KLANT_VELDEN en
 *   PROJECT_VELDEN (de kern) plus uuid, seq, pc_revisie en gearchiveerd; er wordt nooit een
 *   databaserij doorgegeven. Leveranciers, integer-id's, type, paid_with, boekingen, facturen,
 *   bankgegevens van de administratie zelf en instellingen komen er niet in.
 * - Alleen lezen. Deze module bevat geen schrijfopdracht; de enige leesbron is de database zelf, in
 *   een leestransactie zodat een pagina uit één momentopname komt.
 * - Delta op de pc-teller. `sinds` is een sync_seq en levert items met een strikt groter nummer; de
 *   bewerktijd (tijd per veld) speelt bij het kiezen van items nooit mee, anders ging een late
 *   telefoonwijziging aan een andere telefoon voorbij.
 * - Keyset-paginering op (sync_seq, uuid), eerst alle klanten, dan alle projecten, dan de verbergmeldingen. De cursor is geen
 *   SQL maar een gecontroleerd tupel dat alleen als parameter wordt gebruikt.
 * - Een ronde heeft een vaste bovengrens. De eerste pagina (zonder cursor) legt `tot` vast: de stand van
 *   de globale teller sync_teller 'wijziging'. Elk wijzigingsnummer is ooit uit die teller gekomen en
 *   elk nieuw nummer is groter dan de stand van dat moment, dus 'tot' is een veilige bovengrens (de teller
 *   en niet MAX(sync_seq): die ligt nooit lager, en weerspiegelt ook een teruggezette back-up). Alleen items
 *   met sinds < seq <= tot horen bij de ronde, ook op vervolgpagina's. Een wijziging tijdens de ronde krijgt
 *   een nummer boven `tot` en komt in de volgende ronde. De telefoon bewaart na de laatste pagina `tot`
 *   (veld `nieuwe_sinds`), niet het hoogste nummer van de ontvangen items.
 * - Een item dat niet meer zichtbaar is (klant die leverancier werd, met zijn projecten) komt als
 *   verbergmelding { uuid, seq, soort } in `verborgen`, zie leesStamgegevens. Daarna is het item uit
 *   klanten/projecten verdwenen; de pc verwijdert nooit iets.
 * - Een project heeft een effectief nummer: het grootste van zijn eigen sync_seq en dat van zijn klant.
 *   Verandert de klant (ook van type: leverancier naar beide), dan komen zijn projecten mee in de delta.
 *
 * Kolomnamen in de SQL komen uitsluitend uit de vaste lijsten van de kern (KLANT_VELDEN en
 * PROJECT_VELDEN), nooit uit het verzoek.
 */

/** Het grootste aantal items (klanten en projecten samen) in één antwoord. */
export const STAMGEGEVENS_PAGINA = 100;
/** De langste cursor (tekens); een langere is verknoeid. */
export const CURSOR_MAX_TEKENS = 200;

/** k: klant, p: project, v: verbergmelding (na alle klanten en projecten) */
export type Soort = 'k' | 'p' | 'v';

/** De positie in de stroom: het laatste item van de vorige pagina. */
export interface Cursor {
  /** k: klant, p: project, v: verbergmelding */
  s: Soort;
  /** de sync_seq van dat item */
  t: number;
  /** de uuid van dat item */
  u: string;
  /** de bovengrens (tot) van deze ronde: de stand van de pc-teller bij de eerste pagina */
  b: number;
}

export interface StamgegevensVraag {
  /** alleen items met een sync_seq strikt groter dan dit (0: alles) */
  sinds: number;
  /** de cursor uit het vorige antwoord, of null voor de eerste pagina */
  na: Cursor | null;
}

export interface VeldWaarde {
  waarde: string | number | null;
  tijd: number;
  bron: string;
}

export interface StamItem {
  uuid: string;
  seq: number;
  pc_revisie: number;
  gearchiveerd: boolean;
  velden: Record<string, VeldWaarde>;
}

export interface StamAlias {
  alias_uuid: string;
  klant: string;
}

/**
 * Een item dat voor de telefoon niet meer zichtbaar is: uitsluitend uuid, seq en soort. Geen naam, type
 * of veld: de telefoon verbergt het lokaal, de pc verwijdert nooit iets.
 */
export interface VerborgenItem {
  uuid: string;
  seq: number;
  soort: 'klant' | 'project';
}

export interface StamgegevensAntwoord {
  klanten: StamItem[];
  projecten: StamItem[];
  aliassen: StamAlias[];
  /** items die de telefoon moet verbergen (alleen bij een delta, sinds > 0); zie het docblok */
  verborgen: VerborgenItem[];
  volgende: string | null;
  /**
   * De bovengrens van deze ronde (`tot`). Na de laatste pagina (volgende: null) bewaart de telefoon
   * dit getal als nieuwe `sinds`, nooit het hoogste `seq` van de ontvangen items. Staat `sinds` boven
   * de stand van de teller (een teruggezette back-up), dan is het antwoord leeg en is dit het lagere nummer.
   */
  nieuwe_sinds: number;
}

/** De cursor wijst naar niets wat deze pc kan hebben gemaakt (bijvoorbeeld een bovengrens boven de teller). */
export class OngeldigeCursor extends Error {
  constructor() {
    super('ongeldige cursor');
  }
}

const UUID_KLEIN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** De cursor als tekst: base64url van JSON met precies de sleutels s, t, u en b (in die volgorde). */
export function maakCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify({ s: cursor.s, t: cursor.t, u: cursor.u, b: cursor.b }), 'utf8').toString('base64url');
}

/**
 * Leest een cursor streng terug. Null bij alles wat niet exact zo gemaakt is door maakCursor: te
 * lang, geen strikte base64url, geen JSON, geen object met precies s, t, u en b, een verkeerd type of
 * bereik, of een andere schrijfwijze van dezelfde inhoud. Gooit nooit.
 */
export function leesCursor(tekst: unknown): Cursor | null {
  if (typeof tekst !== 'string' || tekst.length === 0 || tekst.length > CURSOR_MAX_TEKENS || !/^[A-Za-z0-9_-]+$/.test(tekst)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(tekst, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const sleutels = Object.keys(raw);
  if (sleutels.length !== 4 || !['s', 't', 'u', 'b'].every((k) => sleutels.includes(k))) return null;
  const { s, t, u, b } = raw as { s: unknown; t: unknown; u: unknown; b: unknown };
  if (s !== 'k' && s !== 'p' && s !== 'v') return null;
  if (typeof t !== 'number' || !Number.isSafeInteger(t) || t < 0) return null;
  if (typeof u !== 'string' || !UUID_KLEIN.test(u)) return null;
  // de bovengrens van de ronde ligt nooit onder het laatste item
  if (typeof b !== 'number' || !Number.isSafeInteger(b) || b < t) return null;
  const cursor: Cursor = { s, t, u, b };
  // alleen de canonieke schrijfwijze: een gewijzigde of aangevulde cursor wijst naar niets
  return maakCursor(cursor) === tekst ? cursor : null;
}

// ---------- de vaste lijsten waaruit de SQL en de items worden opgebouwd ----------

const KLANT_NAMEN = Object.keys(KLANT_VELDEN) as (keyof typeof KLANT_VELDEN)[];
const PROJECT_NAMEN = Object.keys(PROJECT_VELDEN) as (keyof typeof PROJECT_VELDEN)[];
const KLANT_KOLOMMEN = KLANT_NAMEN.map((n) => KLANT_VELDEN[n].kolom);
const PROJECT_KOLOMMEN = PROJECT_NAMEN.map((n) => PROJECT_VELDEN[n].kolom);

const KLANT_SQL = `SELECT r.id, r.uuid, r.sync_seq, r.revisie, r.created_at, ${KLANT_KOLOMMEN.map((k) => `r.${k} AS ${k}`).join(', ')}
  FROM relations r
  WHERE r.type IN ('klant', 'beide') AND r.uuid IS NOT NULL AND r.sync_seq > 0
    AND r.sync_seq > ? AND r.sync_seq <= ? AND (r.sync_seq > ? OR (r.sync_seq = ? AND r.uuid > ?))
  ORDER BY r.sync_seq, r.uuid
  LIMIT ?`;

// Een project dat aan een leverancier hangt wordt niet geleverd; een project zonder bekende relatie wel.
// Het effectieve nummer (eff) is het grootste van het project en zijn klant: selectie, volgorde en cursor
// gebruiken alleen eff, en eff is ook het `seq` in het antwoord.
const PROJECT_SQL = `SELECT * FROM (
  SELECT j.id, j.uuid, MAX(j.sync_seq, COALESCE(k.sync_seq, 0)) AS sync_seq, j.revisie, j.created_at, k.uuid AS klant_uuid, ${PROJECT_KOLOMMEN.filter((k) => k !== 'relation_id')
    .map((k) => `j.${k} AS ${k}`)
    .join(', ')}
  FROM jobs j
  LEFT JOIN relations k ON k.id = j.relation_id
  WHERE (k.id IS NULL OR k.type IN ('klant', 'beide')) AND j.uuid IS NOT NULL AND j.sync_seq > 0
) p
  WHERE p.sync_seq > ? AND p.sync_seq <= ? AND (p.sync_seq > ? OR (p.sync_seq = ? AND p.uuid > ?))
  ORDER BY p.sync_seq, p.uuid
  LIMIT ?`;

// Verbergmeldingen: relaties die nu leverancier zijn maar ooit klant of beide waren, en hun projecten.
// De bron is relation_changelog (veld 'type'): RelationsService.update() schrijft bij elke typewijziging
// een regel met het oude type. Een relatie die nu leverancier is en ooit zichtbaar was, heeft dus een regel
// met oud klant/beide; een relatie die altijd leverancier was heeft die regel nooit. Het huidige type alleen
// is niet genoeg (verraadt de leverancier) en gewijzigd_op/sync_seq zeggen niets over het vorige type.
// Het begintype staat niet altijd in de log (telefoon-klanten en klanten van voor de migratie), maar elke
// latere verandering wel, en alleen die telt voor wie nu leverancier is.
const WAS_ZICHTBAAR = `EXISTS (SELECT 1 FROM relation_changelog c WHERE c.relation_id = k.id AND c.veld = 'type'
    AND (c.oud IN ('klant', 'beide') OR c.nieuw IN ('klant', 'beide')))`;
const VERBORGEN_SQL = `SELECT * FROM (
  SELECT k.uuid AS uuid, k.sync_seq AS sync_seq, 'klant' AS soort
  FROM relations k
  WHERE k.type = 'leverancier' AND k.uuid IS NOT NULL AND k.sync_seq > 0 AND ${WAS_ZICHTBAAR}
  UNION ALL
  SELECT j.uuid AS uuid, MAX(j.sync_seq, k.sync_seq) AS sync_seq, 'project' AS soort
  FROM jobs j JOIN relations k ON k.id = j.relation_id
  WHERE k.type = 'leverancier' AND j.uuid IS NOT NULL AND j.sync_seq > 0 AND ${WAS_ZICHTBAAR}
) v
  WHERE v.sync_seq > ? AND v.sync_seq <= ? AND (v.sync_seq > ? OR (v.sync_seq = ? AND v.uuid > ?))
  ORDER BY v.sync_seq, v.uuid
  LIMIT ?`;

const ALIAS_SQL = `SELECT a.alias_uuid AS alias_uuid, r.uuid AS klant
  FROM relation_aliases a JOIN relations r ON r.id = a.relation_id
  WHERE r.type IN ('klant', 'beide') AND r.uuid IS NOT NULL
  ORDER BY a.alias_uuid`;

interface Rij {
  id: number;
  uuid: string;
  sync_seq: number;
  revisie: number;
  created_at: string;
  klant_uuid?: string | null;
  [kolom: string]: unknown;
}

interface VeldRij {
  eigenaar: number;
  veld: string;
  tijd: number;
  bron: string;
}

type Tijden = Map<number, Map<string, { tijd: number; bron: string }>>;

/** De opgeslagen tijd en bron per veld voor deze rijen; rijen zonder veldrij blijven buiten de map. */
function leesTijden(db: Db, tabel: 'relation_field_rev' | 'job_field_rev', ids: number[]): Tijden {
  const uit: Tijden = new Map();
  if (ids.length === 0) return uit;
  const eigenaar = tabel === 'relation_field_rev' ? 'relation_id' : 'job_id';
  const rijen = db.prepare(`SELECT ${eigenaar} AS eigenaar, veld, tijd, bron FROM ${tabel} WHERE ${eigenaar} IN (${ids.map(() => '?').join(', ')})`).all(...ids) as VeldRij[];
  for (const r of rijen) {
    const perVeld = uit.get(r.eigenaar) ?? new Map<string, { tijd: number; bron: string }>();
    perVeld.set(r.veld, { tijd: r.tijd, bron: r.bron });
    uit.set(r.eigenaar, perVeld);
  }
  return uit;
}

/** Een veld zonder rij heeft als tijd de ondergrens uit created_at (UTC) en als bron pc (contract R9). */
function veldTijd(tijden: Tijden, id: number, veld: string, createdAt: string): { tijd: number; bron: string } {
  return tijden.get(id)?.get(veld) ?? { tijd: veldOndergrens(createdAt), bron: BRON_PC };
}

function bouwKlant(rij: Rij, tijden: Tijden): StamItem {
  const velden: Record<string, VeldWaarde> = {};
  for (const naam of KLANT_NAMEN) {
    const kolom = KLANT_VELDEN[naam].kolom;
    const waarde = rij[kolom] as string | number | null;
    velden[naam] = { waarde: waarde ?? null, ...veldTijd(tijden, rij.id, RELATIE_VELD_MAPPING[kolom], rij.created_at) };
  }
  return { uuid: rij.uuid, seq: rij.sync_seq, pc_revisie: rij.revisie, gearchiveerd: rij.archived === 1, velden };
}

function bouwProject(rij: Rij, tijden: Tijden): StamItem {
  const velden: Record<string, VeldWaarde> = {};
  for (const naam of PROJECT_NAMEN) {
    const kolom = PROJECT_VELDEN[naam].kolom;
    // de klant gaat als uuid mee, nooit als integer-id
    const waarde = kolom === 'relation_id' ? (rij.klant_uuid ?? null) : (rij[kolom] as string | number | null);
    velden[naam] = { waarde: waarde ?? null, ...veldTijd(tijden, rij.id, JOB_VELD_MAPPING[kolom as JobKolom], rij.created_at) };
  }
  return { uuid: rij.uuid, seq: rij.sync_seq, pc_revisie: rij.revisie, gearchiveerd: rij.archived === 1, velden };
}

function cursorVan(soort: Soort, item: { seq: number; uuid: string }, tot: number): string {
  return maakCursor({ s: soort, t: item.seq, u: item.uuid, b: tot });
}

/**
 * Eén pagina van de stroom. Alleen lezen. Eerst klanten, dan projecten, dan (alleen bij een delta)
 * verbergmeldingen, samen hoogstens STAMGEGEVENS_PAGINA items; `volgende` is de cursor van het laatste item
 * als er nog meer volgt, anders null. `nieuwe_sinds` is de bovengrens van de ronde. De aliassen staan alleen
 * op de eerste pagina (zonder cursor), onafhankelijk van `sinds`.
 *
 * Verbergmeldingen (`verborgen`): een klant die nu leverancier is en ooit klant of beide was, en elk project
 * van zo'n klant, krijgt { uuid, seq, soort } met hetzelfde effectieve nummer als in de klanten/projecten-
 * stroom, zodat de melding in de delta valt op het moment van de typewijziging. Een item staat nooit
 * tegelijk in klanten/projecten en in verborgen (het huidige type beslist), en een relatie die altijd
 * leverancier was komt er nooit in. Bij `sinds` 0 is de lijst leeg: de telefoon begint dan leeg en wist
 * zijn lokale stamgegevens eerst; een verborgen item komt in de volledige export gewoon niet voor.
 */
export function leesStamgegevens(db: Db, vraag: StamgegevensVraag): StamgegevensAntwoord {
  return db
    .transaction((): StamgegevensAntwoord => {
      const cursor = vraag.na;
      const teller = (db.prepare(`SELECT waarde FROM sync_teller WHERE naam = 'wijziging'`).get() as { waarde: number } | undefined)?.waarde;
      if (teller === undefined) throw new Error('De wijzigingsteller ontbreekt in deze administratie');
      // Eerste pagina: de bovengrens van de ronde is de stand van de teller nu. Vervolgpagina: die uit de
      // cursor, die niet boven de teller kan liggen en niet onder `sinds` (dat kan deze pc niet gemaakt hebben).
      if (cursor && (cursor.b > teller || cursor.b < vraag.sinds)) throw new OngeldigeCursor();
      // verbergmeldingen bestaan alleen bij een delta; bij sinds 0 kan geen pagina van die soort bestaan
      if (cursor && cursor.s === 'v' && vraag.sinds === 0) throw new OngeldigeCursor();
      const tot = cursor ? cursor.b : teller;
      const grens = STAMGEGEVENS_PAGINA + 1; // een extra item om te weten of er nog meer volgt
      const nulpunt = { t: 0, u: '' };

      let klanten: StamItem[] = [];
      if (!cursor || cursor.s === 'k') {
        const van = cursor ?? nulpunt;
        const rijen = db.prepare(KLANT_SQL).all(vraag.sinds, tot, van.t, van.t, van.u, grens) as Rij[];
        const tijden = leesTijden(db, 'relation_field_rev', rijen.map((r) => r.id));
        klanten = rijen.map((r) => bouwKlant(r, tijden));
      }

      let projecten: StamItem[] = [];
      const overProjecten = grens - klanten.length;
      if (overProjecten > 0 && (!cursor || cursor.s !== 'v')) {
        const van = cursor && cursor.s === 'p' ? cursor : nulpunt;
        const rijen = db.prepare(PROJECT_SQL).all(vraag.sinds, tot, van.t, van.t, van.u, overProjecten) as Rij[];
        const tijden = leesTijden(db, 'job_field_rev', rijen.map((r) => r.id));
        projecten = rijen.map((r) => bouwProject(r, tijden));
      }

      let verborgen: VerborgenItem[] = [];
      const overVerborgen = grens - klanten.length - projecten.length;
      if (overVerborgen > 0 && vraag.sinds > 0) {
        const van = cursor && cursor.s === 'v' ? cursor : nulpunt;
        const rijen = db.prepare(VERBORGEN_SQL).all(vraag.sinds, tot, van.t, van.t, van.u, overVerborgen) as { uuid: string; sync_seq: number; soort: 'klant' | 'project' }[];
        // alleen deze drie sleutels verlaten de pc, nooit een databaserij
        verborgen = rijen.map((r) => ({ uuid: r.uuid, seq: r.sync_seq, soort: r.soort }));
      }

      // Eén stroom in vaste volgorde; de eerste STAMGEGEVENS_PAGINA items vormen de pagina.
      let volgende: string | null = null;
      if (klanten.length + projecten.length + verborgen.length > STAMGEGEVENS_PAGINA) {
        const stroom = [
          ...klanten.map((i) => ({ s: 'k' as const, i })),
          ...projecten.map((i) => ({ s: 'p' as const, i })),
          ...verborgen.map((i) => ({ s: 'v' as const, i })),
        ].slice(0, STAMGEGEVENS_PAGINA);
        const laatste = stroom[stroom.length - 1]!;
        volgende = cursorVan(laatste.s, laatste.i, tot);
        klanten = klanten.slice(0, STAMGEGEVENS_PAGINA);
        projecten = projecten.slice(0, Math.max(0, STAMGEGEVENS_PAGINA - klanten.length));
        verborgen = verborgen.slice(0, Math.max(0, STAMGEGEVENS_PAGINA - klanten.length - projecten.length));
      }

      const aliassen = cursor ? [] : (db.prepare(ALIAS_SQL).all() as StamAlias[]).map((a) => ({ alias_uuid: a.alias_uuid, klant: a.klant }));
      return { klanten, projecten, aliassen, verborgen, volgende, nieuwe_sinds: tot };
    })
    .deferred();
}
