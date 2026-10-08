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
