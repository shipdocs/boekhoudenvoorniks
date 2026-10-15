import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HANDLEIDING_PAGINAS, HANDLEIDING_URL, handleidingUrl } from '../src/shared/handleiding';

/**
 * De knop "Hulp" (#420) wijst per scherm naar een pagina van de handleiding. Elke pagina en elk anker moet
 * bestaan in docs/handleiding, anders opent de knop een lege of verkeerde plek.
 */
const DOCS = join(__dirname, '..', 'docs', 'handleiding');
const slug = (s: string) =>
  s.toLowerCase().replace(/[àáâä]/g, 'a').replace(/[èéêë]/g, 'e').replace(/[ìíîï]/g, 'i').replace(/[òóôö]/g, 'o').replace(/[ùúûü]/g, 'u').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

describe('handleiding-links', () => {
  const pages = new Map<string, Set<string>>();
  for (const f of readdirSync(DOCS).filter((f) => f.endsWith('.md'))) {
    const md = readFileSync(join(DOCS, f), 'utf8');
    const anchors = new Set([...md.matchAll(/^(?:##|###) (.+)$/gm)].map((m) => slug(m[1]!)));
    pages.set(f.replace(/\.md$/, '.html'), anchors);
  }
  pages.set('index.html', new Set());

  it('elke schermverwijzing wijst naar een bestaande pagina en een bestaand anker', () => {
    for (const [screen, target] of Object.entries(HANDLEIDING_PAGINAS)) {
      const [page, anchor] = target.split('#');
      expect(pages.has(page!), `${screen}: pagina ${page} ontbreekt`).toBe(true);
      if (anchor) expect(pages.get(page!)!.has(anchor), `${screen}: anker #${anchor} ontbreekt in ${page}`).toBe(true);
    }
  });

  it('alle schermen van de app staan erin, en een onbekend scherm gaat naar de index', () => {
    const ui = readFileSync(join(__dirname, '..', 'src', 'renderer', 'ui.ts' + 'x'), 'utf8');
    const union = ui.match(/export type Screen =([\s\S]*?);/)![1]!;
    const screens = [...union.matchAll(/'([a-z]+)'/g)].map((m) => m[1]!);
    expect(screens.length).toBeGreaterThan(10);
    for (const s of screens) expect(HANDLEIDING_PAGINAS[s], `scherm ${s} heeft geen handleidingpagina`).toBeDefined();
    expect(handleidingUrl('bank')).toBe(`${HANDLEIDING_URL}bank.html`);
    expect(handleidingUrl('bestaat-niet')).toBe(`${HANDLEIDING_URL}index.html`);
  });
});
