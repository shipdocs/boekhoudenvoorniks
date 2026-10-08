import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { leesWijziging, type Wijziging } from '@gratis-boekhouden/kern';

/**
 * Het protocol tussen de bonnenscanner (telefoon) en de desktop-app (#48). Dit bestand is de
 * uitvoerbare versie van docs/bonnenscanner-protocol.md: wie hier iets verandert, past ook dat
 * document aan (en hoogt bij een onverenigbare wijziging PROTOCOL_VERSION op).
 *
 * Verzoek (telefoon → pc), de hele HTTP-body:
 *   "BVNS" | versie (1 of 2) | richting (1 = verzoek) | apparaat-ID (16) | nonce (12) | cijfertekst | tag (16)
 * Antwoord (pc → telefoon) na een geslaagde ontsleuteling: zelfde opbouw met richting 2.
 * AES-256-GCM; de eerste 22 bytes zijn de extra te controleren gegevens (AAD), bij een antwoord
 * gevolgd door de nonce van het verzoek. Zo hoort een antwoord bij precies één verzoek.
 *
 * Versie 2 (naast versie 1, die blijft werken) voegt drie berichten toe: het hallo-antwoord zegt van
 * welke versie de btw-regeltabel is (rulesVersion) en welke protocolversies de pc begrijpt, een
 * `wijziging` draagt een change-set (het gedeelde wijzigingsformaat uit packages/core) en
 * `stamgegevens` vraagt om de stamgegevens van de administratie (klanten, projecten en aliassen, per
 * pagina; zie src/sync/stamgegevens.ts).
 */
export const PROTOCOL_VERSION = 1;
/** De versies die deze pc begrijpt; een envelop met een ander versienummer wordt geweigerd. */
export const PROTOCOL_VERSIONS = [1, 2] as const;
export type ProtocolVersion = (typeof PROTOCOL_VERSIONS)[number];
/** Versienummer van de btw-regeltabel, in het hallo-antwoord van versie 2 (`regels`). De tabel zelf volgt. */
export const RULES_VERSION = 1;
export const MAGIC = Buffer.from('BVNS', 'ascii');
export const DIRECTION = { request: 1, response: 2 } as const;
export const DEVICE_ID_BYTES = 16;
export const NONCE_BYTES = 12;
export const KEY_BYTES = 32;
export const TAG_BYTES = 16;
/** magic + versie + richting + apparaat-ID: ook de AAD */
export const PREFIX_BYTES = MAGIC.length + 2 + DEVICE_ID_BYTES;
export const HEADER_BYTES = PREFIX_BYTES + NONCE_BYTES;

export const CONTENT_TYPE = 'application/vnd.boekhoudenvoorniks.scanner';
export const ENDPOINT_PATH = '/v1/bericht';
export const MDNS_SERVICE = '_gratisboekhouden._tcp';

export const LIMITS = {
  /** grootste HTTP-body (alles bij elkaar, versleuteld) */
  maxBodyBytes: 20 * 1024 * 1024,
  /** alle foto's van één bon samen; past daarmee als één bijlage in de administratie (max 20 MB) */
  maxPhotoBytes: 19 * 1024 * 1024,
  maxPhotos: 10,
  maxJsonBytes: 16 * 1024,
  /** JSON van een `wijziging`-bericht: een change-set mag groter zijn dan de rest (limieten van de kern) */
  maxWijzigingJsonBytes: 128 * 1024,
  maxNoteChars: 1000,
  maxNameChars: 60,
  /** zoveel mag de klok van de telefoon afwijken van die van de pc (ms) */
  clockWindowMs: 5 * 60 * 1000,
};

export const PAYMENT_METHODS = ['pin', 'contant', 'prive', 'later'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Foutcodes in het veld `fout` van een antwoord. */
export type ErrorCode =
  | 'ongeldig'
  | 'niet-gekoppeld'
  | 'klok'
  | 'herhaald'
  | 'id-botst'
  | 'te-groot'
  | 'verkeerd-type'
  | 'lengte'
  | 'te-druk'
  | 'opslaan-mislukt'
  | 'veld-ongeldig'
  | 'klant-onbekend'
  | 'project-onbekend'
  | 'wachtrij-vol'
  | 'onbekend';

export interface HelloMessage {
  soort: 'hallo';
  tijd: number;
  naam: string;
  app: string | null;
}

export interface ReceiptMessage {
  soort: 'bon';
  tijd: number;
  /** eigen ID van de telefoon voor deze bon (UUID, kleine letters) */
  id: string;
  betaalwijze: PaymentMethod;
  notitie: string | null;
  locatie: { lat: number; lon: number } | null;
  /** de foto's, in volgorde */
  fotos: Buffer[];
}

/** Een change-set: het gedeelde wijzigingsformaat van versie 2, gecontroleerd door de kern. */
export interface WijzigingMessage {
  soort: 'wijziging';
  tijd: number;
  wijziging: Wijziging;
}

/**
 * Vraag om de stamgegevens van de administratie. `sinds` is een sync_seq van de pc (items met een
 * strikt groter nummer; ontbreekt het, dan alles) en `na` de cursor `volgende` uit het vorige
 * antwoord. Een sleutel die niet is meegestuurd ontbreekt ook hier (nooit null).
 */
export interface StamgegevensMessage {
  soort: 'stamgegevens';
  tijd: number;
  sinds?: number;
  na?: string;
}

/**
 * Vraag om de bevestigingen van wijzigingen die eerst wachtten (alleen lezen). `na` is het hoogste
 * bevestigingsnummer dat de telefoon al heeft (geheel getal, standaard 0).
 */
export interface BevestigingenMessage {
  soort: 'bevestigingen';
  tijd: number;
  na?: number;
}

export type ScannerMessage = HelloMessage | ReceiptMessage | WijzigingMessage | StamgegevensMessage | BevestigingenMessage;

export class ProtocolError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
  }
}

const B64URL = /^[A-Za-z0-9_-]+$/;

export function toBase64Url(data: Uint8Array): string {
  return Buffer.from(data).toString('base64url');
}

/** Alleen strikte base64url van precies `bytes` bytes; anders null. */
export function fromBase64Url(text: unknown, bytes: number): Buffer | null {
  if (typeof text !== 'string' || !B64URL.test(text)) return null;
  const buf = Buffer.from(text, 'base64url');
  return buf.length === bytes && buf.toString('base64url') === text ? buf : null;
}

// ---------- koppelen: wat er in de QR-code staat ----------

export interface PairingPayload {
  /** de ontvanger van deze administratie op deze pc */
  pc: string;
  /** het ID van deze telefoon, door de pc bedacht */
  apparaat: string;
  /** 32 bytes, base64url */
  sleutel: string;
  poort: number;
  /** IPv4-adressen van de pc op het thuisnetwerk, het waarschijnlijkste eerst */
  adressen: string[];
}

export function encodePairing(p: PairingPayload): string {
  return JSON.stringify({ bvn: 'scanner', v: PROTOCOL_VERSION, pc: p.pc, apparaat: p.apparaat, sleutel: p.sleutel, poort: p.poort, adressen: p.adressen });
}

/** Leest de tekst uit de QR-code terug (voor tests, en als voorbeeld voor de telefoon-app). */
export function decodePairing(text: string): PairingPayload {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new ProtocolError('ongeldig', 'Dit is geen QR-code van BoekhoudenVoorNiks');
  }
  if (!raw || raw.bvn !== 'scanner') throw new ProtocolError('ongeldig', 'Dit is geen QR-code van BoekhoudenVoorNiks');
  if (raw.v !== PROTOCOL_VERSION) throw new ProtocolError('ongeldig', 'Deze QR-code hoort bij een andere versie van de app');
  const ok =
    fromBase64Url(raw.pc, DEVICE_ID_BYTES) &&
    fromBase64Url(raw.apparaat, DEVICE_ID_BYTES) &&
    fromBase64Url(raw.sleutel, KEY_BYTES) &&
    Number.isInteger(raw.poort) &&
    (raw.poort as number) > 0 &&
    (raw.poort as number) < 65536 &&
    Array.isArray(raw.adressen) &&
    raw.adressen.every((a) => typeof a === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(a));
  if (!ok) throw new ProtocolError('ongeldig', 'De QR-code is niet compleet');
  return { pc: raw.pc as string, apparaat: raw.apparaat as string, sleutel: raw.sleutel as string, poort: raw.poort as number, adressen: raw.adressen as string[] };
}

// ---------- envelop: versleutelen en ontsleutelen ----------

function prefix(versie: number, direction: number, deviceId: Buffer): Buffer {
  return Buffer.concat([MAGIC, Buffer.from([versie, direction]), deviceId]);
}

function seal(versie: number, direction: number, deviceId: Buffer, key: Buffer, plaintext: Buffer, aadExtra: Buffer | null, nonce: Buffer): Buffer {
  if (deviceId.length !== DEVICE_ID_BYTES || key.length !== KEY_BYTES || nonce.length !== NONCE_BYTES) throw new Error('Ongeldige sleutel, nonce of apparaat-ID');
  const head = prefix(versie, direction, deviceId);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aadExtra ? Buffer.concat([head, aadExtra]) : head);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([head, nonce, body, cipher.getAuthTag()]);
}

/** De kop van een envelop, zonder iets te ontsleutelen; null als het ons formaat niet is. */
export function readHeader(body: Buffer, direction: number): { versie: ProtocolVersion; deviceId: Buffer; nonce: Buffer } | null {
  if (body.length < HEADER_BYTES + TAG_BYTES) return null;
  if (!body.subarray(0, MAGIC.length).equals(MAGIC) || body[MAGIC.length + 1] !== direction) return null;
  const versie = body[MAGIC.length]!;
  if (!(PROTOCOL_VERSIONS as readonly number[]).includes(versie)) return null;
  return { versie: versie as ProtocolVersion, deviceId: body.subarray(MAGIC.length + 2, PREFIX_BYTES), nonce: body.subarray(PREFIX_BYTES, HEADER_BYTES) };
}

function open(direction: number, body: Buffer, key: Buffer, aadExtra: Buffer | null): Buffer | null {
  if (!readHeader(body, direction) || key.length !== KEY_BYTES) return null;
  const head = body.subarray(0, PREFIX_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, body.subarray(PREFIX_BYTES, HEADER_BYTES));
  decipher.setAAD(aadExtra ? Buffer.concat([head, aadExtra]) : head);
  decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
  try {
    return Buffer.concat([decipher.update(body.subarray(HEADER_BYTES, body.length - TAG_BYTES)), decipher.final()]);
  } catch {
    return null;
  }
}

/** Verzoek van de telefoon. `nonce` en `versie` alleen meegeven in tests (anders willekeurig, versie 1). */
export function sealRequest(deviceId: Buffer, key: Buffer, plaintext: Buffer, nonce: Buffer = randomBytes(NONCE_BYTES), versie: ProtocolVersion = PROTOCOL_VERSION): Buffer {
  return seal(versie, DIRECTION.request, deviceId, key, plaintext, null, nonce);
}

/** Ontsleutelt een verzoek; null als de sleutel niet past of er iets aan veranderd is. */
export function openRequest(body: Buffer, key: Buffer): Buffer | null {
  return open(DIRECTION.request, body, key, null);
}

/** Antwoord van de pc, vastgemaakt aan de nonce van het verzoek, in de versie van het verzoek. */
export function sealResponse(deviceId: Buffer, key: Buffer, requestNonce: Buffer, json: unknown, nonce: Buffer = randomBytes(NONCE_BYTES), versie: ProtocolVersion = PROTOCOL_VERSION): Buffer {
  return seal(versie, DIRECTION.response, deviceId, key, Buffer.from(JSON.stringify(json), 'utf8'), requestNonce, nonce);
}

/** Zo leest de telefoon het antwoord (voor tests, en als voorbeeld). */
export function openResponse(body: Buffer, key: Buffer, requestNonce: Buffer): Record<string, unknown> | null {
  const plain = open(DIRECTION.response, body, key, requestNonce);
  if (!plain) return null;
  try {
    return JSON.parse(plain.toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ---------- de inhoud: JSON met daarachter de foto's ----------

/** lengte van de JSON (4 bytes, big-endian) | JSON (UTF-8) | foto 1 | foto 2 | … */
export function encodeFrame(json: Record<string, unknown>, blobs: Uint8Array[] = []): Buffer {
  const text = Buffer.from(JSON.stringify(json), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(text.length, 0);
  return Buffer.concat([len, text, ...blobs.map((b) => Buffer.from(b))]);
}

function bad(why: string): never {
  throw new ProtocolError('ongeldig', why);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Hoeveel tekens een cursor (`na` in een stamgegevens-verzoek) hoogstens heeft. */
const MAX_CURSOR_TEKENS = 200;

/** Tekst van buiten: geen stuurtekens (wel regeleinden als dat mag), begrensd in lengte. */
function cleanText(value: unknown, max: number, multiline: boolean): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(multiline ? /[\u0000-\u0009\u000b-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g, ' ').trim();
  return [...text].slice(0, max).join('');
}

/**
 * Leest de ontsleutelde inhoud van een verzoek. Alles is invoer van buiten: elk veld wordt op type
 * en bereik gecontroleerd, en de foto's moeten precies de rest van het bericht vullen. Onbekende
 * velden worden genegeerd, zodat een nieuwere telefoon-app met een oudere pc blijft werken — behalve
 * bij `wijziging`: dat bericht heeft precies de sleutels soort, tijd en wijziging, precies één
 * change-set per bericht, en bij `stamgegevens`: daar zijn alleen soort, tijd, sinds en na toegestaan, en bij `bevestigingen`: alleen soort, tijd en na.
 *
 * De JSON van `hallo`, `bon` en `stamgegevens` is hooguit 16 KiB; alleen een `wijziging` in een
 * v2-envelop mag tot 128 KiB. Daarboven (en voor elk ander soort boven 16 KiB): `te-groot`.
 *
 * De protocolversie van de envelop bepaalt welke berichten erin kunnen: versie 1 kent alleen `hallo`
 * en `bon`; versie 2 kent daarnaast `wijziging`, `stamgegevens` en `bevestigingen`.
 */
export function parseFrame(plain: Buffer, versie: ProtocolVersion = PROTOCOL_VERSION): ScannerMessage {
  if (plain.length < 4) bad('bericht te kort');
  const jsonLength = plain.readUInt32BE(0);
  if (jsonLength < 2 || 4 + jsonLength > plain.length) bad('ongeldige lengte van de gegevens');
  if (jsonLength > LIMITS.maxWijzigingJsonBytes) throw new ProtocolError('te-groot', 'de gegevens zijn te groot');
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(plain.subarray(4, 4 + jsonLength).toString('utf8')) as Record<string, unknown>;
  } catch {
    bad('gegevens zijn geen JSON');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('gegevens zijn geen object');
  // Boven 16 KiB past alleen een `wijziging` in een v2-envelop (tot 128 KiB); elk ander bericht is
  // te groot, ook als de inhoud zelf zou passen. Zo blijft hallo, bon en stamgegevens bescheiden.
  if (jsonLength > LIMITS.maxJsonBytes && !(versie >= 2 && raw.soort === 'wijziging')) throw new ProtocolError('te-groot', 'deze gegevens zijn te groot voor dit soort bericht');
  const tijd = raw.tijd;
  if (typeof tijd !== 'number' || !Number.isSafeInteger(tijd) || tijd <= 0) bad('tijd ontbreekt');
  const rest = plain.subarray(4 + jsonLength);

  if (raw.soort === 'hallo') {
    if (rest.length > 0) bad('bij hallo horen geen foto\'s');
    const naam = cleanText(raw.naam, LIMITS.maxNameChars, false);
    if (!naam) bad('naam ontbreekt');
    return { soort: 'hallo', tijd, naam, app: cleanText(raw.app, 20, false) || null };
  }
  if (versie >= 2 && raw.soort === 'stamgegevens') {
    if (rest.length > 0) bad('bij stamgegevens horen geen foto\'s');
    // Streng: alleen soort, tijd en (optioneel) sinds en na. Een onbekende sleutel, ook __proto__, geeft
    // ongeldig. Of `na` een echte cursor is controleert de pc bij het antwoorden (src/sync/stamgegevens.ts).
    const bericht: StamgegevensMessage = { soort: 'stamgegevens', tijd };
    for (const sleutel of Object.keys(raw)) if (!['soort', 'tijd', 'sinds', 'na'].includes(sleutel)) bad('een stamgegevens-bericht heeft alleen de sleutels soort, tijd, sinds en na');
    if (Object.hasOwn(raw, 'sinds')) {
      const sinds = raw.sinds;
      if (typeof sinds !== 'number' || !Number.isSafeInteger(sinds) || sinds < 0) bad('sinds moet een geheel getal van 0 of meer zijn');
      bericht.sinds = sinds as number;
    }
    if (Object.hasOwn(raw, 'na')) {
      const na = raw.na;
      if (typeof na !== 'string' || na.length === 0 || na.length > MAX_CURSOR_TEKENS) bad('na moet een tekst van hoogstens 200 tekens zijn');
      bericht.na = na as string;
    }
    return bericht;
  }
  if (versie >= 2 && raw.soort === 'bevestigingen') {
    if (rest.length > 0) bad('bij bevestigingen horen geen foto\'s');
    // Streng: alleen soort, tijd en (optioneel) na; een onbekende sleutel, ook __proto__, geeft ongeldig.
    for (const sleutel of Object.keys(raw)) if (!['soort', 'tijd', 'na'].includes(sleutel)) bad('een bevestigingen-bericht heeft alleen de sleutels soort, tijd en na');
    const bericht: BevestigingenMessage = { soort: 'bevestigingen', tijd };
    if (Object.hasOwn(raw, 'na')) {
      const na = raw.na;
      if (typeof na !== 'number' || !Number.isSafeInteger(na) || na < 0) bad('na moet een geheel getal van 0 of meer zijn');
      bericht.na = na as number;
    }
    return bericht;
  }
  if (versie >= 2 && raw.soort === 'wijziging') {
    if (rest.length > 0) bad('bij een wijziging horen geen foto\'s');
    // Precies één wijziging per bericht: naast `soort` en `tijd` hoort alleen de sleutel `wijziging`,
    // met daarbinnen de change-set in het vijf-velden-formaat (die haar eigen, oudere `tijd` mag
    // dragen). De controle van die change-set doet de kern.
    const sleutels = Object.keys(raw);
    if (sleutels.length !== 3 || !sleutels.includes('wijziging')) bad('een wijziging-bericht heeft precies de sleutels soort, tijd en wijziging');
    const gelezen = leesWijziging(raw.wijziging);
    if (!gelezen.ok) bad('ongeldige change-set');
    return { soort: 'wijziging', tijd, wijziging: gelezen.wijziging };
  }
  if (raw.soort !== 'bon') bad('onbekend soort bericht');

  const id = typeof raw.id === 'string' ? raw.id.toLowerCase() : '';
  if (!UUID.test(id)) bad('id is geen UUID');
  if (!PAYMENT_METHODS.includes(raw.betaalwijze as PaymentMethod)) bad('onbekende betaalwijze');
  let notitie: string | null = null;
  if (raw.notitie !== undefined && raw.notitie !== null) {
    if (typeof raw.notitie !== 'string') bad('notitie is geen tekst');
    notitie = cleanText(raw.notitie, LIMITS.maxNoteChars, true) || null;
  }
  let locatie: ReceiptMessage['locatie'] = null;
  if (raw.locatie !== undefined && raw.locatie !== null) {
    const l = raw.locatie as { lat?: unknown; lon?: unknown };
    const ok = typeof l === 'object' && typeof l.lat === 'number' && typeof l.lon === 'number' && Number.isFinite(l.lat) && Number.isFinite(l.lon) && Math.abs(l.lat) <= 90 && Math.abs(l.lon) <= 180;
    if (!ok) bad('ongeldige locatie');
    locatie = { lat: l.lat as number, lon: l.lon as number };
  }
  const sizes = raw.fotos;
  if (!Array.isArray(sizes) || sizes.length < 1 || sizes.length > LIMITS.maxPhotos) bad(`een bon heeft 1 tot ${LIMITS.maxPhotos} foto's`);
  const fotos: Buffer[] = [];
  let offset = 0;
  for (const s of sizes as unknown[]) {
    const size = (s as { grootte?: unknown } | null)?.grootte;
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1 || offset + size > rest.length) bad('de groottes van de foto\'s kloppen niet');
    fotos.push(rest.subarray(offset, offset + size));
    offset += size;
  }
  if (offset !== rest.length) bad('er staat meer in het bericht dan de foto\'s');
  if (offset > LIMITS.maxPhotoBytes) throw new ProtocolError('te-groot', 'de foto\'s zijn samen te groot');
  return { soort: 'bon', tijd, id, betaalwijze: raw.betaalwijze as PaymentMethod, notitie, locatie, fotos };
}
