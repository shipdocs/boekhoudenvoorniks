import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * De renderer draait in een sandbox zonder Node. Een waarde-import (geen `import type`) die
 * via bij better-sqlite3 of een node:-module uitkomt, breekt het hele scherm ("promisify is not a
 * function"). Deze test volgt alle waarde-imports vanuit src/renderer en weigert zulke modules.
 */
const ROOT = resolve(__dirname, '..', 'src');
const FORBIDDEN = /^(node:|better-sqlite3$|electron$|fs$|path$|crypto$|os$|child_process$|nodemailer|electron-updater)/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
}

function valueImports(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const m of src.matchAll(/^\s*(import|export)\s+(?!type\b)([^'"]*?)\s*from\s*['"]([^'"]+)['"]/gm)) {
    const clause = m[2]!;
    // import { type A, type B } from '…' is ook alleen types
    if (/^\{[^}]*\}$/.test(clause.trim()) && clause.replace(/[{}\s]/g, '').split(',').filter(Boolean).every((x) => x.startsWith('type'))) continue;
    out.push(m[3]!);
  }
  for (const m of src.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) out.push(m[1]!);
  return out;
}

function resolveLocal(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(from), spec);
  for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    try {
      if (statSync(c).isFile()) return c;
    } catch {
      /* volgende */
    }
  }
  return null;
}

describe('renderer-imports', () => {
  it('de renderer trekt geen Node- of databasecode binnen', () => {
    const problems: string[] = [];
    const seen = new Set<string>();
    const walk = (file: string, chain: string[]) => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const spec of valueImports(file)) {
        if (FORBIDDEN.test(spec)) problems.push([...chain, file.replace(ROOT, 'src'), spec].join(' → '));
        const next = resolveLocal(file, spec);
        if (next) walk(next, [...chain, file.replace(ROOT, 'src')]);
      }
    };
    for (const f of files(join(ROOT, 'renderer'))) walk(f, []);
    expect(problems).toEqual([]);
  });
});
