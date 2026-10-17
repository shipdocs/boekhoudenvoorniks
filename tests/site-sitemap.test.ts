import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import worker from '../workers/site/src/index';

/**
 * De sitemap van de website (#460): elke URL is een bestaande, indexeerbare pagina met dezelfde canonical, en elke
 * publieke HTML-pagina staat erin óf staat hieronder bewust uitgesloten. Zo valt een nieuwe pagina die vergeten is,
 * of een URL die de Worker doorstuurt, meteen op in CI in plaats van maanden later in Search Console.
 *
 * `lastmod` wordt hier alleen op vorm gecontroleerd: zet hem met de hand pas als de inhoud van een pagina echt
 * verandert (geen opmaak, menu of tikfout), en dan op de datum van die wijziging. De datum van / en wijzigingen.html
 * zet `npm run site:wijzigingen` bij elke release.
 */

const ROOT = path.join(__dirname, '..');
const SITE = path.join(ROOT, 'site');
const ORIGIN = 'https://boekhoudenvoorniks.nl';

/** Publieke HTML-pagina's die bewust niet in de sitemap staan, met de reden. Een nieuwe uitzondering hoort hier. */
const NIET_IN_SITEMAP: Record<string, string> = {
  'android-review.html': 'testpagina voor de Play Store-review, noindex',
};

function htmlFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return htmlFiles(full);
    return e.name.endsWith('.html') ? [path.relative(SITE, full).split(path.sep).join('/')] : [];
  });
}

/** site/... bij een sitemap-URL: een map is zijn index.html. */
function fileFor(loc: string): string {
  const p = new URL(loc).pathname.slice(1);
  return p === '' || p.endsWith('/') ? `${p}index.html` : p;
}

const sitemap = fs.readFileSync(path.join(SITE, 'sitemap.xml'), 'utf8');
const entries = [...sitemap.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => ({
  loc: /<loc>([^<]*)<\/loc>/.exec(m[1] ?? '')?.[1]?.trim() ?? '',
  lastmod: /<lastmod>([^<]*)<\/lastmod>/.exec(m[1] ?? '')?.[1]?.trim(),
}));
const locs = entries.map((e) => e.loc);
const attr = (html: string, re: RegExp) => re.exec(html)?.[1];

/** De Worker met de bestanden uit site/ als ASSETS: zo krijgt de test dezelfde doorverwijzingen als de echte site. */
const env = {
  ASSETS: {
    async fetch(request: Request) {
      const file = path.join(SITE, decodeURIComponent(new URL(request.url).pathname));
      if (!file.startsWith(SITE) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return new Response('niet gevonden', { status: 404 });
      return new Response(fs.readFileSync(file), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    },
  },
};

describe('sitemap.xml', () => {
  it('is een geldige urlset met unieke URLs', () => {
    expect(sitemap.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(sitemap).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(sitemap.trimEnd().endsWith('</urlset>')).toBe(true);
    // elk <url>-blok heeft precies één <loc>; geen losse tekst of blokken buiten <url>
    expect((sitemap.match(/<url>/g) ?? []).length).toBe((sitemap.match(/<\/url>/g) ?? []).length);
    expect((sitemap.match(/<loc>/g) ?? []).length).toBe(entries.length);
    expect(entries.length).toBeGreaterThan(0);
    const dubbel = locs.filter((l, i) => locs.indexOf(l) !== i);
    expect(dubbel, 'dubbele URLs in site/sitemap.xml').toEqual([]);
  });

  it('heeft alleen https-URLs op het hoofddomein, zonder query of #', () => {
    const fout = locs.filter((l) => {
      try {
        const u = new URL(l);
        return u.origin !== ORIGIN || u.search !== '' || u.hash !== '' || u.href !== l;
      } catch {
        return true;
      }
    });
    expect(fout, 'ongeldige URLs in site/sitemap.xml').toEqual([]);
  });

  it('heeft een geldige lastmod (JJJJ-MM-DD, niet in de toekomst)', () => {
    const morgen = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
    const fout = entries.filter((e) => !e.lastmod || !/^\d{4}-\d{2}-\d{2}$/.test(e.lastmod) || Number.isNaN(Date.parse(e.lastmod)) || e.lastmod > morgen);
    expect(fout.map((e) => `${e.loc}: ${e.lastmod ?? 'geen lastmod'}`), 'lastmod in site/sitemap.xml').toEqual([]);
  });

  it.each(locs)('%s is een bestaande, indexeerbare pagina met dezelfde canonical', async (loc) => {
    const file = fileFor(loc);
    const full = path.join(SITE, file);
    expect(fs.existsSync(full), `site/${file} bestaat niet`).toBe(true);
    const html = fs.readFileSync(full, 'utf8');
    const robots = attr(html, /<meta\s+name="robots"\s+content="([^"]*)"/i) ?? '';
    expect(robots, `site/${file} staat op noindex`).not.toMatch(/noindex/i);
    expect(attr(html, /<link\s+rel="canonical"\s+href="([^"]*)"/i), `canonical van site/${file}`).toBe(loc);

    // de echte Worker geeft de pagina zelf (200), zonder doorverwijzing en zonder noindex-header
    const res = await worker.fetch(new Request(loc), env);
    expect(res.status, `${loc} geeft geen 200 (doorverwijzing naar ${res.headers.get('location')})`).toBe(200);
    expect(res.headers.get('x-robots-tag') ?? '', `${loc}: x-robots-tag`).not.toMatch(/noindex/i);
  });

  it('elke publieke HTML-pagina staat in de sitemap of is bewust uitgesloten', () => {
    const inSitemap = new Set(locs.map(fileFor));
    const vergeten = htmlFiles(SITE).filter((f) => !inSitemap.has(f) && !(f in NIET_IN_SITEMAP));
    expect(vergeten, 'niet in site/sitemap.xml: voeg toe, of zet in NIET_IN_SITEMAP met de reden').toEqual([]);
    const overbodig = Object.keys(NIET_IN_SITEMAP).filter((f) => inSitemap.has(f) || !fs.existsSync(path.join(SITE, f)));
    expect(overbodig, 'NIET_IN_SITEMAP noemt een pagina die in de sitemap staat of niet meer bestaat').toEqual([]);
  });

  it('een noindex-pagina staat altijd bewust bij de uitzonderingen', () => {
    const noindex = htmlFiles(SITE).filter((f) => /<meta\s+name="robots"\s+content="[^"]*noindex/i.test(fs.readFileSync(path.join(SITE, f), 'utf8')));
    expect(noindex.filter((f) => !(f in NIET_IN_SITEMAP)), 'noindex-pagina zonder uitzondering').toEqual([]);
  });
});

describe('robots.txt', () => {
  const robots = fs.readFileSync(path.join(SITE, 'robots.txt'), 'utf8');

  it('verwijst naar de sitemap', () => {
    const lines = robots.split(/\r?\n/).filter((l) => /^sitemap:/i.test(l)).map((l) => l.slice('sitemap:'.length).trim());
    expect(lines).toEqual([`${ORIGIN}/sitemap.xml`]);
  });

  it('blokkeert geen URL uit de sitemap', () => {
    const disallow = robots.split(/\r?\n/).filter((l) => /^disallow:/i.test(l)).map((l) => l.slice('disallow:'.length).trim()).filter(Boolean);
    const geblokkeerd = locs.filter((l) => disallow.some((d) => new URL(l).pathname.startsWith(d)));
    expect(geblokkeerd, 'sitemap-URLs die robots.txt blokkeert').toEqual([]);
  });
});
