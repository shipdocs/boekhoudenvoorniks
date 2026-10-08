import type { Db } from '../db/database';
import { ValidationError } from '../shared/validation';
import type { RelationsService } from './relations';

/**
 * Dubbele klanten: de pc zoekt klanten die dezelfde lijken te zijn (vooral een klant die de telefoon aanmaakte terwijl
 * de pc hem al kende), bewaart per paar een voorstel en voert een samenvoeging alleen uit na een expliciete keuze van de
 * gebruiker. Niets wordt ooit stil samengevoegd: het zoeken schrijft alleen voorstellen, en alleen voegVoorstelSamen
 * (vanaf de knop op Vandaag of in de api) roept RelationsService.voegSamen aan.
 *
 * Een voorstel staat in klant_dubbel_voorstellen, hoogstens een keer per paar (relation_a is het kleinste id). Een
 * samengevoegd of afgewezen paar komt nooit terug, ook niet als een klant daarna verandert. Voorstellen worden nooit gewist.
 */

/** Hoeveel nieuwe voorstellen een zoekronde hoogstens bewaart; een volgende ronde gaat verder met de rest. */
export const MAX_NIEUWE_VOORSTELLEN = 200;
/** Hoeveel voorstellen er hoogstens tegelijk op Vandaag en in de lijst staan; de rest komt als telling. */
export const MAX_ZICHTBARE_VOORSTELLEN = 50;

/** Namen die geen klant onderscheiden: alleen op zo'n woord (zonder hoofdletters, spaties en leestekens) matcht een naam niet. */
const ALGEMENE_NAMEN = ['particulier', 'particulieren', 'klant', 'klanten', 'bedrijf', 'onbekend', 'diversen', 'divers', 'overig', 'overige', 'anoniem', 'contant', 'kas', 'consument', 'gast', 'nvt', 'test', 'naam', 'noname'];

/** Leestekens en witruimte die bij het vergelijken van een naam wegvallen. */
const NAAM_TEKENS = [' ', '.', ',', ';', ':', '!', '?', "'", '"', '`', '´', '’', '‘', '“', '”', '(', ')', '[', ']', '{', '}', '<', '>', '/', '\\', '|', '-', '_', '+', '*', '&', '@', '#', '%', '^', '~', '='];
const sqlTekst = (t: string) => `'${t.replace(/'/g, "''")}'`;

/** De genormaliseerde naam in SQL: kleine letters, zonder spaties en leestekens. */
const NAAM_SQL = ['char(9)', 'char(10)', 'char(13)', ...NAAM_TEKENS.map(sqlTekst)].reduce((uitdrukking, teken) => `replace(${uitdrukking}, ${teken}, '')`, 'lower(name)');
/** Het genormaliseerde btw-nummer in SQL: hoofdletters zonder spaties, punten en streepjes (zoals normalizeVatNumber). */
const BTW_SQL = `upper(replace(replace(replace(trim(vat_number), ' ', ''), '.', ''), '-', ''))`;

const SOORTEN: Record<string, { volgorde: number; tekst: string }> = {
  kvk: { volgorde: 1, tekst: 'KvK-nummer' },
  btw: { volgorde: 2, tekst: 'btw-nummer' },
  email: { volgorde: 3, tekst: 'e-mailadres' },
  naam: { volgorde: 4, tekst: 'naam' },
};

/**
 * Alle nog niet beslagen en nog niet bewaarde paren, met de soorten overeenkomst. Per soort een gelijke sleutel
 * (self-join op de sleutel), alleen klanten van type klant of beide die niet gearchiveerd zijn en een niet-lege sleutel
 * hebben. Paren die al een voorstel hebben (welke status ook) vallen in de query zelf weg, dus vóór de grens.
 */
const ZOEK_SQL = `
WITH k AS (
  SELECT id, trim(kvk_number) AS kvk, ${BTW_SQL} AS btw, lower(trim(email)) AS mail, ${NAAM_SQL} AS naam
  FROM relations
  WHERE archived = 0 AND type IN ('klant', 'beide')
), s AS (
  SELECT id, 'kvk' AS soort, kvk AS sleutel FROM k WHERE kvk <> ''
  UNION ALL SELECT id, 'btw', btw FROM k WHERE btw <> ''
  UNION ALL SELECT id, 'email', mail FROM k WHERE mail <> ''
  UNION ALL SELECT id, 'naam', naam FROM k WHERE length(naam) >= 3 AND naam NOT IN (${ALGEMENE_NAMEN.map(sqlTekst).join(', ')})
)
SELECT a.id AS a, b.id AS b, group_concat(a.soort) AS soorten
FROM s a JOIN s b ON b.soort = a.soort AND b.sleutel = a.sleutel AND b.id > a.id
WHERE NOT EXISTS (SELECT 1 FROM klant_dubbel_voorstellen v WHERE v.relation_a = a.id AND v.relation_b = b.id)
GROUP BY a.id, b.id
ORDER BY a.id, b.id
LIMIT ?`;

export type DubbelStatus = 'voorgesteld' | 'samengevoegd' | 'afgewezen';

export interface DubbelVoorstel {
  id: number;
  relation_a: number;
  relation_b: number;
  reden: string;
  status: DubbelStatus;
  gemaakt_op: number;
  beslist_op: number | null;
}

/** Wat de gebruiker van een klant moet zien om te kiezen: geen uuid, rekeningnummer of e-mailadres. */
export interface DubbeleKlant {
  id: number;
  naam: string;
  plaats: string | null;
  facturen: number;
  klussen: number;
}

export interface DubbelVoorstelMetKlanten extends DubbelVoorstel {
  a: DubbeleKlant;
  b: DubbeleKlant;
}

/** De stabiele sleutel van de taak op Vandaag voor dit paar. */
export const dubbelTaakKey = (v: Pick<DubbelVoorstel, 'relation_a' | 'relation_b'>): string => `klant-dubbel:${v.relation_a}-${v.relation_b}`;

/** De reden als gewone zin, uit de soorten overeenkomst (in vaste volgorde). */
function redenTekst(soorten: string[]): string {
  const delen = soorten.map((x) => SOORTEN[x]!.tekst);
  const lijst = delen.length > 1 ? `${delen.slice(0, -1).join(', ')} en ${delen.at(-1)}` : delen[0]!;
  return `zelfde ${lijst}`;
}

/** Een id uit de interface: een geheel getal groter dan 0, anders een Nederlandse fout. */
function controleerId(waarde: unknown, wat: string): number {
  if (typeof waarde !== 'number' || !Number.isInteger(waarde) || waarde <= 0) throw new ValidationError(`${wat} klopt niet`);
  return waarde;
}

/**
 * Zoekt dubbele klanten en bewaart per nieuw paar een voorstel (ON CONFLICT DO NOTHING: herhaald zoeken maakt geen tweede
 * rij en een beslist paar komt niet terug). Begrensd op MAX_NIEUWE_VOORSTELLEN per ronde; geeft het aantal nieuwe
 * voorstellen. Schrijft alleen in klant_dubbel_voorstellen, nooit in relations.
 */
export function zoekDubbelen(db: Db, nu: () => number = Date.now, grens: number = MAX_NIEUWE_VOORSTELLEN): number {
  const paren = db.prepare(ZOEK_SQL).all(grens) as { a: number; b: number; soorten: string }[];
  if (paren.length === 0) return 0;
  const voeg = db.prepare(
    `INSERT INTO klant_dubbel_voorstellen (relation_a, relation_b, reden, status, gemaakt_op) VALUES (?, ?, ?, 'voorgesteld', ?)
     ON CONFLICT(relation_a, relation_b) DO NOTHING`,
  );
  return db.transaction(() => {
    let nieuw = 0;
    const tijd = nu();
    for (const p of paren) {
      const soorten = [...new Set(p.soorten.split(','))].sort((x, y) => SOORTEN[x]!.volgorde - SOORTEN[y]!.volgorde);
      nieuw += voeg.run(p.a, p.b, redenTekst(soorten), tijd).changes;
    }
    return nieuw;
  })();
}

const ACTIEF_SQL = `v.status = 'voorgesteld' AND ra.archived = 0 AND rb.archived = 0 AND ra.type IN ('klant', 'beide') AND rb.type IN ('klant', 'beide')`;

function klantInfo(db: Db, id: number): DubbeleKlant {
  const r = db.prepare('SELECT id, name, city FROM relations WHERE id = ?').get(id) as { id: number; name: string; city: string | null };
  const aantal = (tabel: 'invoices' | 'jobs') => (db.prepare(`SELECT COUNT(*) AS n FROM ${tabel} WHERE relation_id = ?`).get(id) as { n: number }).n;
  return { id: r.id, naam: r.name, plaats: r.city, facturen: aantal('invoices'), klussen: aantal('jobs') };
}

/**
 * De openstaande voorstellen om te tonen, oudste eerst. Voorstellen die niet meer openstaan (afgehandeld, of een klant is
 * intussen gearchiveerd of een leverancier geworden) worden in SQL weggelaten vóór de grens, zodat het afwijzen van veel
 * voorstellen de volgende nooit verbergt. `meer` is het aantal openstaande voorstellen dat boven de grens valt.
 */
export function openVoorstellen(db: Db, grens: number = MAX_ZICHTBARE_VOORSTELLEN): { voorstellen: DubbelVoorstelMetKlanten[]; meer: number } {
  const van = `FROM klant_dubbel_voorstellen v JOIN relations ra ON ra.id = v.relation_a JOIN relations rb ON rb.id = v.relation_b WHERE ${ACTIEF_SQL}`;
  const rijen = db.prepare(`SELECT v.* ${van} ORDER BY v.id LIMIT ?`).all(grens) as DubbelVoorstel[];
  const totaal = rijen.length < grens ? rijen.length : (db.prepare(`SELECT COUNT(*) AS n ${van}`).get() as { n: number }).n;
  return { voorstellen: rijen.map((v) => ({ ...v, a: klantInfo(db, v.relation_a), b: klantInfo(db, v.relation_b) })), meer: totaal - rijen.length };
}

/**
 * Eén voorstel dat nog openstaat, opnieuw uit de databank (de gegevens van een taak uit de interface worden nooit
 * vertrouwd); anders een Nederlandse fout.
 */
export function huidigVoorstel(db: Db, voorstelId: unknown): DubbelVoorstel {
  const id = controleerId(voorstelId, 'Het nummer van dit voorstel');
  const v = db.prepare('SELECT * FROM klant_dubbel_voorstellen WHERE id = ?').get(id) as DubbelVoorstel | undefined;
  if (!v) throw new ValidationError('Dit voorstel bestaat niet (meer). Bekijk Vandaag opnieuw.');
  if (v.status !== 'voorgesteld') throw new ValidationError(v.status === 'samengevoegd' ? 'Deze klanten zijn al samengevoegd' : 'Dit voorstel is al afgewezen');
  return v;
}

/** "Verschillend": het paar wordt nooit meer voorgesteld. De klanten zelf veranderen niet. */
export function wijsVoorstelAf(db: Db, voorstelId: unknown, nu: () => number = Date.now): DubbelVoorstel {
  const v = huidigVoorstel(db, voorstelId);
  db.prepare(`UPDATE klant_dubbel_voorstellen SET status = 'afgewezen', beslist_op = ? WHERE id = ? AND status = 'voorgesteld'`).run(nu(), v.id);
  return { ...v, status: 'afgewezen' };
}

export interface SamenvoegUitslag {
  voorstelId: number;
  /** de klant die blijft */
  doel: { id: number; naam: string };
  /** de klant die gearchiveerd is */
  bron: { id: number; naam: string };
  /** is er een alias geschreven (alleen als de bron een sync-uuid had)? */
  aliasGeschreven: boolean;
}

/**
 * Voert een voorstel uit na een expliciete keuze: doelId is de klant die blijft (een van de twee van het voorstel), de
 * andere wordt de bron. Alles in een transactie: voegSamen en de status van het voorstel slagen samen of helemaal niet.
 * Roept zelf nooit iets aan zonder dat een aanroeper (de knop) doelId koos.
 */
export function voegVoorstelSamen(db: Db, relations: Pick<RelationsService, 'voegSamen' | 'get'>, voorstelId: unknown, doelId: unknown, nu: () => number = Date.now): SamenvoegUitslag {
  const doel = controleerId(doelId, 'De gekozen klant');
  return db.transaction(() => {
    const v = huidigVoorstel(db, voorstelId);
    if (doel !== v.relation_a && doel !== v.relation_b) throw new ValidationError('Kies een van de twee klanten van dit voorstel');
    const bron = doel === v.relation_a ? v.relation_b : v.relation_a;
    const { aliasGeschreven } = relations.voegSamen(bron, doel, v.reden);
    db.prepare(`UPDATE klant_dubbel_voorstellen SET status = 'samengevoegd', beslist_op = ? WHERE id = ? AND status = 'voorgesteld'`).run(nu(), v.id);
    return { voorstelId: v.id, doel: { id: doel, naam: relations.get(doel).name }, bron: { id: bron, naam: relations.get(bron).name }, aliasGeschreven };
  })();
}
