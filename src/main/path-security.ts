import path from 'node:path';

/**
 * Waar als candidate echt onder root ligt; voorkomt prefix-trucs zoals `bijlagen-oud`. Op Windows
 * telt hoofdlettergebruik niet (`C:\Users\Piet` en `c:\users\piet` zijn dezelfde map).
 */
export function isPathInside(root: string, candidate: string, platform: NodeJS.Platform = process.platform): boolean {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const fold = (value: string): string => (platform === 'win32' ? p.resolve(value).toLowerCase() : p.resolve(value));
  const rel = p.relative(fold(root), fold(candidate));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel);
}
