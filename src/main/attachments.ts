import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ATTACHMENTS_DIR, isStoredAttachmentPath } from '../db/attachment-paths';
import { isPathInside } from './path-security';

export const ALLOWED_ATTACHMENTS = ['.pdf', '.jpg', '.jpeg', '.png', '.heic', '.webp', '.xml'];

/**
 * Bewaart een bijlage in `bijlagen/<jaar>/` van de administratie in `adminDir`. Geeft het pad zoals het
 * in de database komt: relatief aan die map en met `/`, bv. `bijlagen/2026/2026-10-01-1a2b3c4d-bon.pdf`.
 */
export function saveAttachment(adminDir: string, name: string, data: Uint8Array, now: Date = new Date()): string {
  const ext = path.extname(name).toLowerCase();
  if (!ALLOWED_ATTACHMENTS.includes(ext)) throw new Error('Alleen PDF, e-factuur (XML) of foto (jpg, png, heic, webp) als bijlage');
  if (data.byteLength > 20 * 1024 * 1024) throw new Error('Bijlage is te groot (max 20 MB)');
  const year = String(now.getFullYear());
  const file = `${now.toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}-${path.basename(name).replace(/[^\w.-]+/g, '_')}`;
  const dir = path.join(adminDir, ATTACHMENTS_DIR, year);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, file), Buffer.from(data));
  return `${ATTACHMENTS_DIR}/${year}/${file}`;
}

/**
 * De enige plek waar een opgeslagen bijlagepad een pad op schijf wordt; alles wat een bijlage leest of
 * opent gaat hierlangs. Het resultaat ligt altijd in `bijlagen/` van de administratie in `adminDir`,
 * anders een fout: geen `..`, geen pad naar elders en geen map die er alleen op lijkt (`bijlagen-oud`).
 * Een absoluut pad uit een oudere versie telt alleen als het in diezelfde map ligt.
 */
export function resolveAttachmentPath(adminDir: string, stored: string, platform: NodeJS.Platform = process.platform): string {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const root = p.join(adminDir, ATTACHMENTS_DIR);
  let file: string | null = null;
  if (typeof stored === 'string') {
    if (isStoredAttachmentPath(stored)) file = p.join(adminDir, ...stored.split('/'));
    else if (p.isAbsolute(stored) && !stored.includes('\0')) file = stored;
  }
  if (file === null || !isPathInside(root, file, platform)) throw new Error('Alleen bijlagen van de administratie kunnen geopend worden');
  return file;
}
