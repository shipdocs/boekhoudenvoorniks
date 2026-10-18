/**
 * Het bon- en fotoschema van de sync: wat een telefoon in een wijziging van de entiteit `bon` (of
 * `foto`, zie hieronder) mag meesturen. Puur schema en vormcontrole, zonder Node of database: de
 * JPEG's zelf komen als bijlage achter de JSON; hier staat alleen wat daarover in de velden staat
 * (grootte en sha256 per foto). Of de bijlage er echt bij past (grootte, sha256, JPEG) controleert de
 * pc, want de sha256 uitrekenen kan alleen met Node.
 *
 * De regels van betaalwijze, notitie en locatie zijn gelijk aan die van het bon-bericht van het
 * protocol (src/scanner/protocol.ts); de grenzen staan in BON_LIMIETEN en moeten gelijk blijven aan
 * LIMITS daar (een test bewaakt dat).
 */

/** De grenzen van een bon of fotowijziging: gelijk aan LIMITS in src/scanner/protocol.ts. */
export const BON_LIMIETEN = {
  /** alle foto's van één bon samen (bytes) */
  maxFotoBytes: 19 * 1024 * 1024,
  maxFotos: 10,
  minFotos: 1,
  maxNotitieTekens: 1000,
} as const;

/** De betaalwijzen van een bon, gelijk aan PAYMENT_METHODS in het protocol. */
export const BON_BETAALWIJZEN = ['pin', 'contant', 'prive', 'later'] as const;
export type BonBetaalwijze = (typeof BON_BETAALWIJZEN)[number];

export interface BonFoto {
  /** het aantal bytes van de JPEG, vanaf 1 */
  grootte: number;
  /** sha256 van de JPEG, 64 kleine hexcijfers */
  sha256: string;
}

export interface BonVelden {
  betaalwijze: BonBetaalwijze;
  notitie: string | null;
  locatie: { lat: number; lon: number } | null;
  fotos: BonFoto[];
}

export interface FotoVelden {
  /** het project (UUID, kleine letters) waar de foto's bij horen */
  project_uuid: string;
  notitie: string | null;
  fotos: BonFoto[];
}

export type LeesBonVeldenResult = { ok: true; velden: BonVelden } | { ok: false; veld: string; melding: string };
export type LeesFotoVeldenResult = { ok: true; velden: FotoVelden } | { ok: false; veld: string; melding: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** Stuurtekens, behalve het regeleinde (\n): die horen niet in een notitie. */
const STUURTEKENS = /[\u0000-\u0009\u000b-\u001f\u007f]/;

type Fout = { ok: false; veld: string; melding: string };
const fout = (veld: string, melding: string): Fout => ({ ok: false, veld, melding });

function isObject(waarde: unknown): waarde is Record<string, unknown> {
  return typeof waarde === 'object' && waarde !== null && !Array.isArray(waarde);
}

/** De lijst foto's: 1 tot en met 10 objecten met precies grootte en sha256, samen hoogstens maxFotoBytes. */
function leesFotos(waarde: unknown): { ok: true; fotos: BonFoto[] } | Fout {
  if (!Array.isArray(waarde)) return fout('fotos', 'Het veld fotos moet een lijst zijn');
  if (waarde.length < BON_LIMIETEN.minFotos || waarde.length > BON_LIMIETEN.maxFotos) {
    return fout('fotos', `Het veld fotos moet ${BON_LIMIETEN.minFotos} tot ${BON_LIMIETEN.maxFotos} foto's bevatten`);
  }
  const fotos: BonFoto[] = [];
  let totaal = 0;
  for (const element of waarde as unknown[]) {
    if (!isObject(element)) return fout('fotos', 'Elke foto in fotos moet een object zijn met grootte en sha256');
    for (const sleutel of Object.keys(element)) {
      if (sleutel !== 'grootte' && sleutel !== 'sha256') return fout('fotos', 'Een foto in fotos heeft alleen de sleutels grootte en sha256');
    }
    const grootte = element.grootte;
    const sha256 = element.sha256;
    if (typeof grootte !== 'number' || !Number.isSafeInteger(grootte) || grootte < 1) return fout('fotos', 'De grootte van een foto moet een geheel aantal bytes vanaf 1 zijn');
    if (typeof sha256 !== 'string' || !SHA256.test(sha256)) return fout('fotos', 'De sha256 van een foto moet uit 64 kleine hexcijfers bestaan');
    totaal += grootte;
    if (totaal > BON_LIMIETEN.maxFotoBytes) return fout('fotos', "De foto's zijn samen te groot");
    fotos.push({ grootte, sha256 });
  }
  return { ok: true, fotos };
}

/** Notitie: tekst zonder stuurtekens, hoogstens 1000 tekens; leeg (of alleen spaties) telt als geen notitie. */
function leesNotitie(waarde: unknown): { ok: true; notitie: string | null } | Fout {
  if (waarde === undefined || waarde === null) return { ok: true, notitie: null };
  if (typeof waarde !== 'string') return fout('notitie', 'Het veld notitie moet tekst zijn');
  if (STUURTEKENS.test(waarde)) return fout('notitie', 'Het veld notitie mag geen stuurtekens bevatten');
  const tekst = waarde.trim();
  if ([...tekst].length > BON_LIMIETEN.maxNotitieTekens) return fout('notitie', `Het veld notitie is te lang (hoogstens ${BON_LIMIETEN.maxNotitieTekens} tekens)`);
  return { ok: true, notitie: tekst === '' ? null : tekst };
}

function leesLocatie(waarde: unknown): { ok: true; locatie: BonVelden['locatie'] } | Fout {
  if (waarde === undefined || waarde === null) return { ok: true, locatie: null };
  if (!isObject(waarde)) return fout('locatie', 'Het veld locatie moet een object zijn met lat en lon');
  for (const sleutel of Object.keys(waarde)) if (sleutel !== 'lat' && sleutel !== 'lon') return fout('locatie', 'Het veld locatie heeft alleen de sleutels lat en lon');
  const { lat, lon } = waarde;
  const ok = typeof lat === 'number' && typeof lon === 'number' && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  if (!ok) return fout('locatie', 'Het veld locatie klopt niet: lat hoogstens 90 en lon hoogstens 180 (in graden)');
  return { ok: true, locatie: { lat: lat as number, lon: lon as number } };
}

/** Een sleutel die niet in `toegestaan` staat (ook __proto__): de eerste die niet klopt, of null. */
function onbekendeSleutel(velden: Record<string, unknown>, toegestaan: readonly string[]): string | null {
  for (const sleutel of Object.keys(velden)) if (!toegestaan.includes(sleutel)) return sleutel;
  return null;
}

/**
 * Controleert de velden van een bonwijziging: { betaalwijze, notitie?, locatie?, fotos: [{ grootte, sha256 }] }.
 * Streng: een onbekend veld (ook __proto__) wordt geweigerd. Geeft bij succes de gecontroleerde velden
 * (notitie en locatie als null als ze ontbreken); bij een fout het veld en een Nederlandse melding. Gooit nooit.
 */
export function leesBonVelden(velden: unknown): LeesBonVeldenResult {
  if (!isObject(velden)) return fout('velden', 'De velden van een bon moeten een object zijn');
  const onbekend = onbekendeSleutel(velden, ['betaalwijze', 'notitie', 'locatie', 'fotos']);
  if (onbekend !== null) return fout(onbekend, `Het veld ${onbekend} bestaat niet voor een bon en wordt niet bewaard`);
  const betaalwijze = Object.hasOwn(velden, 'betaalwijze') ? velden.betaalwijze : undefined;
  if (typeof betaalwijze !== 'string' || !(BON_BETAALWIJZEN as readonly string[]).includes(betaalwijze)) {
    return fout('betaalwijze', `Het veld betaalwijze moet ${BON_BETAALWIJZEN.join(', ')} zijn`);
  }
  const notitie = leesNotitie(Object.hasOwn(velden, 'notitie') ? velden.notitie : undefined);
  if (!notitie.ok) return notitie;
  const locatie = leesLocatie(Object.hasOwn(velden, 'locatie') ? velden.locatie : undefined);
  if (!locatie.ok) return locatie;
  const fotos = leesFotos(Object.hasOwn(velden, 'fotos') ? velden.fotos : undefined);
  if (!fotos.ok) return fotos;
  return { ok: true, velden: { betaalwijze: betaalwijze as BonBetaalwijze, notitie: notitie.notitie, locatie: locatie.locatie, fotos: fotos.fotos } };
}

/**
 * Controleert de velden van een fotowijziging: { project_uuid, notitie?, fotos: [{ grootte, sha256 }] }.
 * Zelfde vorm en regels als bij een bon; in plaats van betaalwijze staat er het project. Gooit nooit.
 */
export function leesFotoVelden(velden: unknown): LeesFotoVeldenResult {
  if (!isObject(velden)) return fout('velden', 'De velden van een foto moeten een object zijn');
  const onbekend = onbekendeSleutel(velden, ['project_uuid', 'notitie', 'fotos']);
  if (onbekend !== null) return fout(onbekend, `Het veld ${onbekend} bestaat niet voor een foto en wordt niet bewaard`);
  const project = Object.hasOwn(velden, 'project_uuid') ? velden.project_uuid : undefined;
  if (typeof project !== 'string' || !UUID.test(project)) return fout('project_uuid', 'Het veld project_uuid moet een UUID in kleine letters zijn');
  const notitie = leesNotitie(Object.hasOwn(velden, 'notitie') ? velden.notitie : undefined);
  if (!notitie.ok) return notitie;
  const fotos = leesFotos(Object.hasOwn(velden, 'fotos') ? velden.fotos : undefined);
  if (!fotos.ok) return fotos;
  return { ok: true, velden: { project_uuid: project, notitie: notitie.notitie, fotos: fotos.fotos } };
}
