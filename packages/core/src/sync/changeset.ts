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
  | 'velden' // geen object, waarden die niet in JSON passen, of boven de WIJZIGING_LIMIETEN
  | 'bewerkt'; // een document (factuur, bon, foto) met meer dan één revisie

export type LeesWijzigingResult = { ok: true; wijziging: Wijziging } | { ok: false; fout: WijzigingsFout };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLEUTELS = ['entiteit', 'uuid', 'revisie', 'tijd', 'velden'] as const;

/**
 * De grenzen van `velden`: zo blijft een change-set bescheiden en veilig, wat een telefoon ook
 * stuurt. `velden` zelf is niveau 1: een sleutel direct in `velden` staat op diepte 1, een object of
 * array als waarde daarin op niveau 2, enzovoort. Een knoop is elke waarde binnen `velden` (object,
 * array of scalar) — de sleutels zelf niet, en `velden` zelf niet meegeteld.
 */
export const WIJZIGING_LIMIETEN = {
  /** sleutels per object, op elk niveau (ook `velden` zelf) */
  maxSleutels: 64,
  /** niveau 6 mag nog, niveau 7 niet */
  maxDiepte: 6,
  /** alle knopen binnen `velden` samen */
  maxKnopen: 4000,
  /** elementen per array */
  maxArray: 500,
  /** tekens per string */
  maxTekens: 4000,
  /** elke sleutel moet hieraan voldoen, op elk niveau */
  sleutelpatroon: /^[A-Za-z][A-Za-z0-9_]{0,39}$/,
  /** nooit als sleutel, op elk niveau (ook in objecten binnen arrays) */
  verboden: ['__proto__', 'constructor', 'prototype'],
} as const;

/** Een sleutel die op elk niveau verboden is, of niet aan het patroon voldoet. */
function goedeSleutel(sleutel: string): boolean {
  return !(WIJZIGING_LIMIETEN.verboden as readonly string[]).includes(sleutel) && WIJZIGING_LIMIETEN.sleutelpatroon.test(sleutel);
}

/** De stand tijdens het doorlopen van `velden`: hoeveel knopen er al gezien zijn. */
interface DoorloopStaat {
  knopen: number;
}

/**
 * Controleert één knoop binnen `velden`: een JSON-waarde (geen undefined, functie, NaN of oneindig)
 * die binnen de limieten past. Geeft false zodra er iets over is — de telling breekt dan direct af,
 * zonder de rest van de invoer nog te doorlopen, ook niet van een enorme array of string. `niveau`
 * is waar deze waarde staat als het een object of array is (velden zelf is niveau 1).
 */
function knoopOk(waarde: unknown, niveau: number, staat: DoorloopStaat): boolean {
  staat.knopen += 1;
  if (staat.knopen > WIJZIGING_LIMIETEN.maxKnopen) return false;
  if (typeof waarde === 'string') return waarde.length <= WIJZIGING_LIMIETEN.maxTekens;
  if (waarde === null || typeof waarde === 'boolean') return true;
  if (typeof waarde === 'number') return Number.isFinite(waarde);
  if (typeof waarde !== 'object') return false; // functie, symbool, bigint of undefined: geen JSON
  if (niveau > WIJZIGING_LIMIETEN.maxDiepte) return false;
  if (Array.isArray(waarde)) {
    if (waarde.length > WIJZIGING_LIMIETEN.maxArray) return false;
    for (const element of waarde) if (!knoopOk(element, niveau + 1, staat)) return false;
    return true;
  }
  const inhoud = waarde as Record<string, unknown>;
  const sleutels = Object.keys(inhoud);
  if (sleutels.length > WIJZIGING_LIMIETEN.maxSleutels) return false;
  for (const sleutel of sleutels) {
    if (!goedeSleutel(sleutel)) return false;
    if (!knoopOk(inhoud[sleutel], niveau + 1, staat)) return false;
  }
  return true;
}

/**
 * Leest en controleert een change-set die van buiten komt: elk veld wordt op type en bereik
 * gecontroleerd, en `velden` mag niet boven de WIJZIGING_LIMIETEN uitkomen. Streng: precies de vijf
 * velden van het formaat, niets erbij en niets eraf — wat de pc niet kent, kan hij ook niet
 * synchroniseren. Bij het overnemen van `velden` wordt de invoer nooit samengevoegd in een gewoon
 * object: de kern geeft een object zonder prototype terug, zodat een valse sleutel nooit via de
 * prototypeketen binnen kan sluipen.
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
  const veldSleutels = Object.keys(velden);
  if (veldSleutels.length > WIJZIGING_LIMIETEN.maxSleutels) return { ok: false, fout: 'velden' };
  const staat: DoorloopStaat = { knopen: 0 };
  for (const sleutel of veldSleutels) {
    if (!goedeSleutel(sleutel)) return { ok: false, fout: 'velden' };
    if (!knoopOk(velden[sleutel], 2, staat)) return { ok: false, fout: 'velden' };
  }
  // overnemen in een object zonder prototype: alle sleutels zijn hierboven gecontroleerd, dus zo kan
  // ook een eigen __proto__ van buiten nooit in de change-set terechtkomen
  const schoneVelden = Object.create(null) as Record<string, unknown>;
  for (const sleutel of veldSleutels) schoneVelden[sleutel] = velden[sleutel];
  const wijziging: Wijziging = { entiteit: d.entiteit as WijzigingEntiteit, uuid: d.uuid, revisie: d.revisie, tijd: d.tijd, velden: schoneVelden };
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
