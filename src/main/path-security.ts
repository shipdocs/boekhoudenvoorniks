import { isAbsolute, relative, resolve, sep } from 'node:path';

/** Waar als candidate echt onder root ligt; voorkomt prefix-trucs zoals `bijlagen-oud`. */
export function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
