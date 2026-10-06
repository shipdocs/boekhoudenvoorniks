/**
 * Het gedeelde wijzigingsformaat (change-set) van het bonnenscanner-protocol versie 2: zo meldt de
 * telefoon een wijziging aan de pc, en zo kan een latere Android-app hetzelfde doen. Dit bestand is
 * puur formaat en regels, zonder Node of database: het bewaren en synchroniseren zelf hoort elders.
 *
 * Een wijziging beschrijft precies één entiteit:
 * - `entiteit` — wat het is: klant, project, factuur, bon of foto;
 * - `uuid`     — het eigen ID van die entiteit, een UUID in kleine letters;
 * - `revisie`  — hoe vaak deze entiteit al gewijzigd is (1, 2, 3, …);
 * - `tijd`     — wanneer deze revisie gemaakt is, in milliseconden sinds 1-1-1970 UTC;
 * - `velden`   — wat er veranderd is: de velden van deze revisie met hun nieuwe waarde.
 *
 * Documenten (factuur, bon, foto) worden nooit bewerkt: die hebben precies één revisie.
 */

/** De entiteiten die voor nu in een change-set kunnen zitten. */
export const WIJZIGING_ENTITEITEN = ['klant', 'project', 'factuur', 'bon', 'foto'] as const;
export type WijzigingEntiteit = (typeof WIJZIGING_ENTITEITEN)[number];

/** Documenten worden nooit bewerkt: alleen een eerste (en enige) revisie. */
export const DOCUMENT_ENTITEITEN = ['factuur', 'bon', 'foto'] as const;
export type DocumentEntiteit = (typeof DOCUMENT_ENTITEITEN)[number];

export function isDocumentEntiteit(entiteit: WijzigingEntiteit): entiteit is DocumentEntiteit {
  return (DOCUMENT_ENTITEITEN as readonly string[]).includes(entiteit);
}

export interface Wijziging {
  entiteit: WijzigingEntiteit;
  /** UUID, in kleine letters */
  uuid: string;
  /** geheel getal vanaf 1 */
  revisie: number;
  /** milliseconden sinds 1-1-1970 UTC */
  tijd: number;
  /** de veranderde velden van deze revisie, met hun nieuwe waarde */
  velden: Record<string, unknown>;
}

/** Wat er aan een change-set niet klopte. */
export type WijzigingsFout =
  | 'vorm' // geen object, of een veld dat er niet in thuishoort
  | 'entiteit' // onbekende entiteit
  | 'uuid' // geen UUID, of niet in kleine letters
  | 'revisie' // geen geheel getal vanaf 1
  | 'tijd' // geen tijdstempel in milliseconden
  | 'velden' // geen object, of waarden die niet in JSON passen
  | 'bewerkt'; // een document (factuur, bon, foto) met meer dan één revisie

export type LeesWijzigingResult = { ok: true; wijziging: Wijziging } | { ok: false; fout: WijzigingsFout };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLEUTELS = ['entiteit', 'uuid', 'revisie', 'tijd', 'velden'] as const;
/** grens op de diepte van `velden`, tegen oneindig lange of kringlopende invoer */
const MAX_DIEPTE = 16;

/** Waarden die in JSON passen (geen undefined, functie, NaN of oneindig). */
function isJsonWaarde(waarde: unknown, diepte: number): boolean {
  if (waarde === null || typeof waarde === 'string' || typeof waarde === 'boolean') return true;
  if (typeof waarde === 'number') return Number.isFinite(waarde);
  if (diepte <= 0) return false;
  if (Array.isArray(waarde)) return waarde.every((w) => isJsonWaarde(w, diepte - 1));
  if (typeof waarde === 'object') {
    const d = waarde as Record<string, unknown>;
    return Object.keys(d).every((k) => k.length > 0 && isJsonWaarde(d[k], diepte - 1));
  }
  return false;
}

/**
 * Leest en controleert een change-set die van buiten komt: elk veld wordt op type en bereik
 * gecontroleerd. Streng: precies de vijf velden van het formaat, niets erbij en niets eraf — wat de
 * pc niet kent, kan hij ook niet synchroniseren.
 */
export function leesWijziging(raw: unknown): LeesWijzigingResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, fout: 'vorm' };
  const d = raw as Record<string, unknown>;
  const sleutels = Object.keys(d);
  if (sleutels.length !== SLEUTELS.length || !SLEUTELS.every((s) => sleutels.includes(s))) return { ok: false, fout: 'vorm' };
  if (typeof d.entiteit !== 'string' || !(WIJZIGING_ENTITEITEN as readonly string[]).includes(d.entiteit)) return { ok: false, fout: 'entiteit' };
  if (typeof d.uuid !== 'string' || !UUID.test(d.uuid)) return { ok: false, fout: 'uuid' };
  if (typeof d.revisie !== 'number' || !Number.isSafeInteger(d.revisie) || d.revisie < 1) return { ok: false, fout: 'revisie' };
  if (typeof d.tijd !== 'number' || !Number.isSafeInteger(d.tijd) || d.tijd <= 0) return { ok: false, fout: 'tijd' };
  if (typeof d.velden !== 'object' || d.velden === null || Array.isArray(d.velden)) return { ok: false, fout: 'velden' };
  const velden = d.velden as Record<string, unknown>;
  if (!Object.keys(velden).every((k) => k.length > 0 && isJsonWaarde(velden[k], MAX_DIEPTE))) return { ok: false, fout: 'velden' };
  const wijziging: Wijziging = { entiteit: d.entiteit as WijzigingEntiteit, uuid: d.uuid, revisie: d.revisie, tijd: d.tijd, velden };
  if (isDocumentEntiteit(wijziging.entiteit) && wijziging.revisie !== 1) return { ok: false, fout: 'bewerkt' };
  return { ok: true, wijziging };
}

export type WijzigingsBesluit = 'toepassen' | 'overgeslagen';

/**
 * De idempotentieregel: dezelfde uuid met dezelfde of lagere revisie is een no-op (die hadden we al),
 * een hogere revisie of een onbekende uuid moet toegepast worden. `vorige` is wat er al van deze
 * entiteit bekend is (null = nog niets); het opzoeken daarvan is het werk van de ontvanger.
 */
export function besluitWijziging(vorige: { uuid: string; revisie: number } | null, wijziging: Wijziging): WijzigingsBesluit {
  if (!vorige || vorige.uuid !== wijziging.uuid || wijziging.revisie > vorige.revisie) return 'toepassen';
  return 'overgeslagen';
}
