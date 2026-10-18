import brandIndex from './brand-index.json';

/**
 * Winkelketens en merken uit de Name Suggestion Index van OpenStreetMap (BSD-3-Clause, zie
 * brand-index.json), per soort winkel omgezet naar onze categorie. Gegenereerd met
 * `npm run leveranciers:nsi` (src/tools/leveranciers-nsi.ts); de app haalt niets online op.
 *
 * Een treffer is een VOORSTEL met dezelfde lage zekerheid als de vaste regels: de gebruiker bevestigt
 * of past aan, en die keuze gaat naar het leveranciersgeheugen (dat altijd wint). Vergeleken wordt de
 * hele genormaliseerde naam of het begin ervan ("Kwik Fit Amersfoort" → "kwik fit"), nooit een stukje
 * midden in een naam, zodat een lokale zaak niet per ongeluk op een merk lijkt.
 */

export interface BrandHit {
  name: string;
  category: string;
  /** soort winkel in OpenStreetMap, bv. shop/doityourself */
  kind: string;
}

/** Rechtsvormen en tussenvoegsels van betaalterminals die niets over de winkel zeggen. */
const NOISE = new Set(['bv', 'nv', 'vof', 'gmbh', 'ag', 'ltd', 'limited', 'inc', 'llc', 'sa', 'sas', 'srl', 'bvba', 'plc', 'co', 'kg', 'holding', 'nederland', 'nl']);
/** Voorvoegsels van pintransacties op het bankafschrift ("CCV*GAMMA UTRECHT", "SumUp *Café X"). */
const PAYMENT_PREFIXES = new Set(['ccv', 'sumup', 'zettle', 'izettle', 'sq', 'bck', 'adyen', 'pay', 'nl', 'betaalautomaat']);

/** "Kwik-Fit B.V. (Amersfoort)" → "kwik fit amersfoort". Zelfde functie in de generator. */
export function normalizeBrand(name: string): string {
  const tokens = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' en ')
    .replace(/\b([a-z])\.(?=[a-z]\.)/g, '$1') // b.v. → bv
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((t) => t && !NOISE.has(t));
  while (tokens.length > 1 && PAYMENT_PREFIXES.has(tokens[0]!)) tokens.shift();
  return tokens.join(' ');
}

/** merken: [genormaliseerde naam, weergavenaam, categorie, soort winkel] */
type IndexFile = { merken: [string, string, string, string][] };
let index: Map<string, BrandHit> | null = null;

function load(): Map<string, BrandHit> {
  if (!index) {
    index = new Map();
    for (const [key, name, category, kind] of (brandIndex as unknown as IndexFile).merken) index.set(key, { name, category, kind });
  }
  return index;
}

/** Zoekt een leverancier op: de hele naam, of de eerste 4…1 woorden ervan (langste eerst). */
export function findBrand(supplier: string | null | undefined): BrandHit | null {
  if (!supplier) return null;
  const tokens = normalizeBrand(supplier).split(' ').filter(Boolean);
  const map = load();
  for (let n = Math.min(tokens.length, 4); n >= 1; n--) {
    const hit = map.get(tokens.slice(0, n).join(' '));
    if (hit) return hit;
  }
  return null;
}
