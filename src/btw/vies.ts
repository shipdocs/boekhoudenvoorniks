import type { Db } from '../db/database';
import type { FetchLike } from '../integrations/types';
import { normalizeVatNumber, ValidationError } from '../shared/validation';
import { volgendeSyncSeq } from '../sync/teller';

/**
 * Controle van een btw-nummer in VIES, de EU-dienst van de Europese Commissie (gratis, zonder sleutel).
 * Alleen op verzoek van de gebruiker, per btw-nummer: de app stuurt dan dat nummer naar ec.europa.eu.
 * Het resultaat met datum wordt bewaard als bewijs bij een 0%-levering of verlegde btw.
 */
export const VIES_API = 'https://ec.europa.eu/taxation_customs/vies/rest-api/ms';
const EU_PREFIXES = new Set(['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'EL', 'ES', 'FI', 'FR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK', 'XI']);

export interface ViesResult {
  vatNumber: string;
  /** true = geldig, false = ongeldig, null = geen uitslag (bv. de dienst van dat land is even niet bereikbaar) */
  valid: boolean | null;
  name: string | null;
  address: string | null;
  message: string | null;
  checkedAt: string;
}

export class ViesService {
  constructor(private readonly db: Db, private readonly fetch: FetchLike) {}

  /** Laatste controle van dit btw-nummer, of null. */
  latest(vatNumber: string): ViesResult | null {
    const row = this.db.prepare('SELECT * FROM vies_checks WHERE vat_number = ? ORDER BY id DESC LIMIT 1').get(normalizeVatNumber(vatNumber)) as
      | { vat_number: string; valid: number | null; name: string | null; address: string | null; message: string | null; checked_at: string }
      | undefined;
    return row ? { vatNumber: row.vat_number, valid: row.valid === null ? null : row.valid === 1, name: row.name, address: row.address, message: row.message, checkedAt: row.checked_at } : null;
  }

  async check(vatNumberInput: string, relationId: number | null = null): Promise<ViesResult> {
    const vatNumber = normalizeVatNumber(vatNumberInput ?? '');
    const prefix = vatNumber.slice(0, 2);
    if (!/^[A-Z]{2}[A-Z0-9+*]{2,13}$/.test(vatNumber)) throw new ValidationError('Vul een btw-nummer in met de landcode ervoor, bijvoorbeeld DE123456789');
    if (!EU_PREFIXES.has(prefix)) throw new ValidationError('VIES controleert alleen btw-nummers uit de EU (en Noord-Ierland)');
    let valid: boolean | null = null;
    let name: string | null = null;
    let address: string | null = null;
    let message: string | null = null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await this.fetch(`${VIES_API}/${prefix}/vat/${encodeURIComponent(vatNumber.slice(2))}`, { headers: { accept: 'application/json' }, signal: controller.signal });
      const body = (await res.json().catch(() => null)) as { isValid?: boolean; userError?: string; name?: string; address?: string } | null;
      if (res.ok && body && typeof body.isValid === 'boolean') {
        valid = body.isValid;
        name = clean(body.name);
        address = clean(body.address);
        if (!valid) message = 'VIES kent dit btw-nummer niet (of het is niet actief).';
      } else {
        message = `Geen uitslag van VIES${body?.userError ? ` (${body.userError})` : ''}. Probeer het later opnieuw; de dienst van een land is soms even niet bereikbaar.`;
      }
    } catch {
      message = 'VIES was niet bereikbaar (geen internet of de dienst reageert niet). Probeer het later opnieuw.';
    } finally {
      clearTimeout(timer);
    }
    // Controle en wijzigingsnummers in een transactie: slaagt het nummeren niet, dan is ook de controle niet bewaard.
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO vies_checks (vat_number, relation_id, valid, name, address, message) VALUES (?, ?, ?, ?, ?, ?)').run(vatNumber, relationId, valid === null ? null : valid ? 1 : 0, name, address, message);
      this.meldAanTelefoon(vatNumber);
    })();
    return this.latest(vatNumber)!;
  }

  /**
   * Een nieuwe VIES-controle moet bij de telefoons terechtkomen (de stamgegevens dragen per klant de
   * controledatum), maar is GEEN klantwijziging. Daarom krijgt elke klant (type klant of beide) met een uuid
   * en dit btw-nummer, zoals bij elke wijziging, een nieuw nummer uit de globale teller (volgendeSyncSeq, in
   * dezelfde transactie als de controle), en alleen relations.sync_seq verandert. Revisie, gewijzigd_op,
   * relation_changelog en relation_field_rev blijven onaangeroerd, dus er ontstaat geen nieuwe veldtijd en
   * geen conflict met een telefoonwijziging.
   *
   * Veilig voor de teller (R3): het nummer komt uit dezelfde teller als alle andere, dus strikt oplopend en
   * nooit hergebruikt; het komt pas na commit zichtbaar, en de bovengrens `tot` van een ronde is de stand van
   * de teller, dus een nummer dat tijdens een ronde wordt uitgegeven ligt erboven en komt in de volgende
   * ronde. Er ontstaan geen gaten onder `tot`. Een relatie zonder uuid of met sync_seq 0 (oudere
   * administratie, nog niet genummerd) wordt overgeslagen zonder fout; dan wordt de teller ook niet geraakt.
   * Het zoeken is begrensd door het aantal klanten met een btw-nummer, een keer per handmatige controle.
   */
  private meldAanTelefoon(vatNumber: string): void {
    const kandidaten = this.db
      .prepare(`SELECT id, vat_number FROM relations WHERE type IN ('klant', 'beide') AND uuid IS NOT NULL AND sync_seq > 0 AND vat_number IS NOT NULL AND vat_number <> '' ORDER BY id`)
      .all() as { id: number; vat_number: string }[];
    const zet = this.db.prepare('UPDATE relations SET sync_seq = ? WHERE id = ?');
    for (const k of kandidaten) {
      if (normalizeVatNumber(k.vat_number) === vatNumber) zet.run(volgendeSyncSeq(this.db), k.id);
    }
  }
}

/** VIES geeft '---' als de naam of het adres niet openbaar is. */
function clean(v: string | undefined): string | null {
  const t = (v ?? '').split('\n').map((x) => x.trim()).filter(Boolean).join(', ');
  return !t || t === '---' ? null : t;
}

/** Hoeveel klanten Vandaag hoogstens als taak krijgt; de rest staat in een telling. */
export const MAX_VIES_TAKEN = 50;
/** Hoeveel factuurnummers hoogstens in de tekst van een taak komen. */
const VIES_MAX_NUMMERS = 5;

export interface ViesKlantZonderControle {
  relationId: number;
  naam: string;
  /** genormaliseerd zoals ViesService.latest dat doet */
  vatNumber: string;
  toestand: 'onbekend' | 'ongeldig';
  /** het aantal telefoonfacturen met een icp- of icp-dienst-regel voor deze klant */
  aantal: number;
  /** de eerste nummers daarvan (hoogstens VIES_MAX_NUMMERS) */
  nummers: string[];
}

/**
 * Klanten met een telefoonfactuur (apparaat_code gevuld, geen concept, geen creditnota) met minstens een icp- of
 * icp-dienst-regel, waarvan het btw-nummer in VIES nog niet als geldig is gecontroleerd. Doet NOOIT een verzoek
 * naar VIES: het leest alleen de eigen databank (vies_checks). Per klant een rij, op volgorde van klant-id.
 *
 * Een begrenzing beslist nooit voordat alles is weggelaten wat niet meer telt: eerst valt weg wat al geldig is
 * (voorfilter in SQL en definitieve toets in JS) en wat de gebruiker heeft overgeslagen (`overslaan`, bv. 'Gezien');
 * pas daarna telt `klanten` (hoogstens MAX_VIES_TAKEN, met factuurnummers opgezocht) en telt `meer` de klanten die
 * echt een taak zouden zijn geweest. Er is dus geen vaste grens op het aantal bekeken klanten.
 *
 * Waarom Vandaag hierdoor niet traag wordt: dit is een enkele, gestreamde query (een keer groeperen per klant, in
 * klant-id-volgorde), dus de kosten zijn begrensd door het aantal klanten met telefoonfacturen met een EU-regel,
 * niet door het aantal rondes. Klanten met een geldige uitslag komen er in SQL al uit (NOT EXISTS-achtig op de
 * via de index op vies_checks.vat_number). Per klant die een taak wordt, komen er hoogstens MAX_VIES_TAKEN extra
 * kleine opzoekingen bij; voor de rest is het alleen tellen. Gemeten (VIESN-05): 5001 klanten kosten tientallen ms.
 * Met `relationId` wordt alleen die ene klant bekeken (voor de knop: opnieuw uit de databank).
 */
export function telefoonKlantenZonderControle(
  db: Db,
  opties: { relationId?: number; overslaan?: (k: Pick<ViesKlantZonderControle, 'relationId' | 'toestand' | 'vatNumber'>) => boolean } = {},
): { klanten: ViesKlantZonderControle[]; meer: number } {
  const gevonden: ViesKlantZonderControle[] = [];
  let meer = 0;
  // Het voorfilter normaliseert in SQL zwakker dan normalizeVatNumber (spaties, punten en streepjes eruit, hoofdletters):
  // het laat hooguit te veel klanten door, nooit te weinig; de JS-controle hieronder blijft de definitieve toets.
  const ronde = db.prepare(
    `SELECT i.relation_id AS relation_id, r.name AS naam, r.vat_number AS vat_number, COUNT(DISTINCT i.id) AS aantal
       FROM invoices i
       JOIN relations r ON r.id = i.relation_id
       JOIN invoice_lines l ON l.invoice_id = i.id AND l.vat_code IN ('icp', 'icp-dienst')
      WHERE i.apparaat_code IS NOT NULL AND i.status <> 'concept' AND i.credit_of_invoice_id IS NULL
        AND r.vat_number IS NOT NULL AND TRIM(r.vat_number) <> ''
        AND (? IS NULL OR i.relation_id = ?)
      GROUP BY i.relation_id
     HAVING (SELECT v.valid FROM vies_checks v
              WHERE v.vat_number = UPPER(REPLACE(REPLACE(REPLACE(REPLACE(r.vat_number, ' ', ''), '.', ''), '-', ''), CHAR(9), '')) AND v.valid IS NOT NULL
              ORDER BY v.id DESC LIMIT 1) IS NOT 1
      ORDER BY i.relation_id`,
  );
  const uitslag = db.prepare('SELECT valid FROM vies_checks WHERE vat_number = ? AND valid IS NOT NULL ORDER BY id DESC LIMIT 1');
  const nummers = db.prepare(
    `SELECT DISTINCT i.number AS number FROM invoices i
      WHERE i.relation_id = ? AND i.apparaat_code IS NOT NULL AND i.status <> 'concept' AND i.credit_of_invoice_id IS NULL
        AND EXISTS (SELECT 1 FROM invoice_lines l WHERE l.invoice_id = i.id AND l.vat_code IN ('icp', 'icp-dienst'))
      ORDER BY i.id LIMIT ?`,
  );
  const rel = opties.relationId ?? null;
  for (const r of ronde.iterate(rel, rel) as Iterable<{ relation_id: number; naam: string; vat_number: string; aantal: number }>) {
    const vat = normalizeVatNumber(r.vat_number);
    if (!vat) continue;
    const u = uitslag.get(vat) as { valid: number } | undefined;
    if (u?.valid === 1) continue;
    const toestand = u ? 'ongeldig' : 'onbekend';
    if (opties.overslaan?.({ relationId: r.relation_id, toestand, vatNumber: vat })) continue;
    if (gevonden.length >= MAX_VIES_TAKEN) {
      meer += 1;
      continue;
    }
    const lijst = (nummers.all(r.relation_id, VIES_MAX_NUMMERS) as { number: string | null }[]).map((x) => x.number).filter((x): x is string => !!x);
    gevonden.push({ relationId: r.relation_id, naam: r.naam, vatNumber: vat, toestand, aantal: r.aantal, nummers: lijst });
  }
  return { klanten: gevonden, meer };
}

/** De key van de taak voor deze klant, toestand en dit (genormaliseerde) btw-nummer. */
export function viesTaakKey(k: Pick<ViesKlantZonderControle, 'relationId' | 'toestand' | 'vatNumber'>): string {
  return `vies-klant:${k.relationId}-${k.toestand}-${k.vatNumber}`;
}
