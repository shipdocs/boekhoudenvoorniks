import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Versleuteling van de uitwisseling met de boekhouder (docs/uitwisseling.md, "Sleutels en pakketformaat").
 *
 * - Het kantoor heeft één sleutelpaar (X25519). De publieke sleutel staat in de uitnodiging; die is geen geheim.
 * - Export (klant → boekhouder): versleuteld naar de publieke sleutel van het kantoor (eenmalig
 *   sleutelpaar, ECDH, HKDF-SHA256, AES-256-GCM). Alleen dat kantoor kan hem openen.
 * - Antwoord (boekhouder → klant): AES-256-GCM met de sleutel K die in de export zat. Alleen de klant
 *   heeft K, en alleen het kantoor kon K uit de export halen: een antwoord dat opent, is echt.
 *
 * Formaat: MAGIC "GBPAKKET" | kopregel-lengte (u32) | kopregel (JSON) | nonce (12) | tag (16) | inhoud.
 * De kopregel is leesbaar (de app kan zonder sleutel zeggen waarom hij een pakket weigert) en is als
 * AAD aan de versleuteling gebonden: een gewijzigde kopregel maakt het pakket onleesbaar.
 */
export const PACKAGE_MAGIC = Buffer.from('GBPAKKET');
const HKDF_INFO = Buffer.from('boekhoudenvoorniks-pakket-v1');
const MAX_HEADER = 64 * 1024;

export interface PackageHeader {
  richting: 'naar-boekhouder' | 'naar-klant';
  /** administratie-ID van de klant */
  administratie: string;
  uitwisseling: number;
  einddatum: string;
  appVersie: string;
  /** eenmalige publieke sleutel (alleen bij een export naar de boekhouder) */
  ephemeral?: string;
}

export interface OfficeKeys {
  /** X25519, base64url (JWK "x") */
  publicKey: string;
  /** X25519, base64url (JWK "d"); geheim */
  privateKey: string;
}

const b64u = (b: Buffer) => b.toString('base64url');
const unb64u = (s: string) => Buffer.from(s, 'base64url');

export function generateOfficeKeys(): OfficeKeys {
  const { privateKey } = generateKeyPairSync('x25519');
  const jwk = privateKey.export({ format: 'jwk' }) as { x: string; d: string };
  return { publicKey: jwk.x, privateKey: jwk.d };
}

function publicKeyObject(x: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(x) || unb64u(x).length !== 32) throw new Error('Ongeldige sleutel van het kantoor');
  return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x }, format: 'jwk' });
}

/** Is dit een bruikbare publieke sleutel van een kantoor? Gooit anders. */
export function assertOfficePublicKey(x: string): void {
  publicKeyObject(x);
}

function privateKeyObject(keys: OfficeKeys) {
  return createPrivateKey({ key: { kty: 'OKP', crv: 'X25519', x: keys.publicKey, d: keys.privateKey }, format: 'jwk' });
}

/** Controlecode om een uitnodiging telefonisch te vergelijken: 8 tekens uit de publieke sleutel. */
export function checkCode(publicKey: string): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const digest = createHash('sha256').update(unb64u(publicKey)).digest();
  const chars = [...digest.subarray(0, 8)].map((b) => alphabet[b % alphabet.length]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

function frame(header: PackageHeader, key: Buffer, plain: Buffer): Buffer {
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(headerBytes.length);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.concat([PACKAGE_MAGIC, headerBytes]));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([PACKAGE_MAGIC, len, headerBytes, nonce, cipher.getAuthTag(), body]);
}

export function isPackage(data: Uint8Array): boolean {
  return data.length > PACKAGE_MAGIC.length + 4 && Buffer.from(data.subarray(0, PACKAGE_MAGIC.length)).equals(PACKAGE_MAGIC);
}

function split(data: Uint8Array): { header: PackageHeader; headerBytes: Buffer; nonce: Buffer; tag: Buffer; body: Buffer } {
  const buf = Buffer.from(data);
  if (!isPackage(buf)) throw new Error('Dit is geen uitwisselingspakket van BoekhoudenVoorNiks');
  const len = buf.readUInt32BE(PACKAGE_MAGIC.length);
  const start = PACKAGE_MAGIC.length + 4;
  if (len === 0 || len > MAX_HEADER || start + len + 28 > buf.length) throw new Error('Het pakket is beschadigd');
  const headerBytes = buf.subarray(start, start + len);
  let header: PackageHeader;
  try {
    header = JSON.parse(headerBytes.toString('utf8')) as PackageHeader;
  } catch {
    throw new Error('Het pakket is beschadigd');
  }
  if (header.richting !== 'naar-boekhouder' && header.richting !== 'naar-klant') throw new Error('Het pakket is beschadigd');
  let o = start + len;
  const nonce = buf.subarray(o, (o += 12));
  const tag = buf.subarray(o, (o += 16));
  return { header, headerBytes, nonce, tag, body: buf.subarray(o) };
}

/** De kopregel, zonder te ontsleutelen: om te zeggen waarom een pakket niet past. */
export function readHeader(data: Uint8Array): PackageHeader {
  return split(data).header;
}

function open(data: Uint8Array, key: Buffer): { header: PackageHeader; plain: Buffer } {
  const { header, headerBytes, nonce, tag, body } = split(data);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(Buffer.concat([PACKAGE_MAGIC, headerBytes]));
    decipher.setAuthTag(tag);
    return { header, plain: Buffer.concat([decipher.update(body), decipher.final()]) };
  } catch {
    throw new Error('Dit pakket kan niet geopend worden: het is niet voor deze administratie of dit kantoor bedoeld, of het is onderweg veranderd');
  }
}

function derive(shared: Buffer, ephemeral: string, officePublic: string): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, Buffer.concat([unb64u(ephemeral), unb64u(officePublic)]), HKDF_INFO, 32));
}

/** Export naar de boekhouder: alleen het kantoor met deze publieke sleutel kan hem openen. */
export function sealForOffice(officePublicKey: string, header: Omit<PackageHeader, 'richting' | 'ephemeral'>, plain: Buffer): Buffer {
  const officeKey = publicKeyObject(officePublicKey);
  const eph = generateKeyPairSync('x25519');
  const ephemeral = (eph.publicKey.export({ format: 'jwk' }) as { x: string }).x;
  const key = derive(diffieHellman({ privateKey: eph.privateKey, publicKey: officeKey }), ephemeral, officePublicKey);
  return frame({ ...header, richting: 'naar-boekhouder', ephemeral }, key, plain);
}

export function openAsOffice(keys: OfficeKeys, data: Uint8Array): { header: PackageHeader; plain: Buffer } {
  const { header } = split(data);
  if (header.richting !== 'naar-boekhouder' || !header.ephemeral) throw new Error('Dit is geen export van een klant');
  let key: Buffer;
  try {
    key = derive(diffieHellman({ privateKey: privateKeyObject(keys), publicKey: publicKeyObject(header.ephemeral) }), header.ephemeral, keys.publicKey);
  } catch {
    throw new Error('Dit pakket kan niet geopend worden: het is niet voor dit kantoor bedoeld');
  }
  return open(data, key);
}

/** Antwoord naar de klant, met de sleutel uit zijn export. */
export function sealWithKey(key: Buffer, header: Omit<PackageHeader, 'richting' | 'ephemeral'>, plain: Buffer): Buffer {
  if (key.length !== 32) throw new Error('Ongeldige sleutel');
  return frame({ ...header, richting: 'naar-klant' }, key, plain);
}

export function openWithKey(key: Buffer, data: Uint8Array): { header: PackageHeader; plain: Buffer } {
  return open(data, key);
}

export function newExchangeKey(): Buffer {
  return randomBytes(32);
}
