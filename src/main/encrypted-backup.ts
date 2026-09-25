import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/**
 * Versleutelde kopie van de administratie (bijvoorbeeld om aan je boekhouder te geven).
 * Formaat: MAGIC(8) | versie(1) | salt(16) | iv(12) | tag(16) | versleutelde SQLite-database
 * Sleutel: scrypt(wachtwoord, salt), AES-256-GCM. Zonder het wachtwoord is de inhoud onleesbaar.
 */
const MAGIC = Buffer.from('GBBACKUP');
const VERSION = 1;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export const MIN_PASSWORD_LENGTH = 10;

function key(password: string, salt: Buffer): Buffer {
  return scryptSync(password.normalize('NFC'), salt, 32, SCRYPT);
}

export function encryptBackup(plain: Buffer, password: string): Buffer {
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`Kies een wachtwoord van minimaal ${MIN_PASSWORD_LENGTH} tekens`);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(password, salt), iv);
  cipher.setAAD(MAGIC);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, Buffer.from([VERSION]), salt, iv, cipher.getAuthTag(), body]);
}

export function isEncryptedBackup(data: Buffer): boolean {
  return data.length > MAGIC.length && data.subarray(0, MAGIC.length).equals(MAGIC);
}

export function decryptBackup(data: Buffer, password: string): Buffer {
  if (!isEncryptedBackup(data)) throw new Error('Dit is geen versleutelde back-up van Gratis Boekhouden');
  const version = data[MAGIC.length];
  if (version !== VERSION) throw new Error(`Onbekende versie van het back-upformaat (${version})`);
  let o = MAGIC.length + 1;
  const salt = data.subarray(o, (o += 16));
  const iv = data.subarray(o, (o += 12));
  const tag = data.subarray(o, (o += 16));
  const decipher = createDecipheriv('aes-256-gcm', key(password, salt), iv);
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(data.subarray(o)), decipher.final()]);
  } catch {
    throw new Error('Onjuist wachtwoord of beschadigd bestand');
  }
}
