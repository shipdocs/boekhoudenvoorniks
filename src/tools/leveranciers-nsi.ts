/**
 * Maakt src/intake/brand-index.json uit de Name Suggestion Index van OpenStreetMap
 * (https://github.com/osmlab/name-suggestion-index, BSD-3-Clause): merken per soort winkel, voor
 * Nederland, de rest van Europa, Noord-Amerika en wereldwijde merken, omgezet naar onze categorie.
 *
 * Gebruik (af en toe opnieuw, het resultaat gaat in git):
 *   npm run leveranciers:nsi
 *
 * Alleen soorten winkels die eenduidig bij één categorie horen. Kleding en supermarkten niet: dat kan
 * zakelijk of privé zijn. Een naam die bij twee categorieën hoort, of die te kort of te algemeen is
 * ("total", "station"), gaat eruit; de uitvoer noemt ze, zodat je ze kunt nalopen.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeBrand } from '../intake/brand-index';

const REPO = 'osmlab/name-suggestion-index';

/** soort winkel in de index → onze categorie (src/shared/categories.ts) */
const KINDS: Record<string, string> = {
  'shop/doityourself': 'materiaal',
  'shop/hardware': 'materiaal',
  'shop/trade': 'materiaal',
  'shop/paint': 'materiaal',
  'shop/building_materials': 'materiaal',
  'shop/flooring': 'materiaal',
  'shop/tiles': 'materiaal',
  'shop/bathroom_furnishing': 'materiaal',
  'shop/electrical': 'materiaal',
  'shop/glaziery': 'materiaal',
  'shop/doors': 'materiaal',
  'shop/tool_hire': 'gereedschap',
  'amenity/fuel': 'brandstof',
  'amenity/charging_station': 'brandstof',
  'amenity/parking': 'brandstof',
  'shop/car_repair': 'auto',
  'shop/car_parts': 'auto',
  'shop/tyres': 'auto',
  'amenity/car_wash': 'auto',
  'amenity/car_rental': 'auto',
  'shop/mobile_phone': 'telefoon',
  'office/telecommunication': 'telefoon',
  'shop/stationery': 'kantoor',
  'shop/copyshop': 'kantoor',
  'shop/computer': 'kantoor',
  'shop/electronics': 'kantoor',
  'office/insurance': 'verzekering',
  'amenity/restaurant': 'representatie',
  'amenity/fast_food': 'representatie',
  'amenity/cafe': 'representatie',
};

/** Nederland en buurlanden, de rest van Europa, VK, VS en Canada, plus Europa (150 e.d.) en wereldwijd (001). */
const LOCATIONS = new Set([
  '001', '150', '151', '154', '155', '039',
  'nl', 'be', 'de', 'lu', 'fr', 'gb', 'ie', 'at', 'ch', 'dk', 'se', 'no', 'fi', 'is', 'es', 'pt', 'it', 'mt', 'gr', 'cy',
  'pl', 'cz', 'sk', 'hu', 'si', 'hr', 'ro', 'bg', 'ee', 'lv', 'lt', 'us', 'ca',
]);

/**
 * Ketens die in Nederland iets anders zijn dan in de index, of die vooral iets anders verkopen: elke naam
 * die ermee begint gaat eruit ("Carrefour Market", "IKEA Restaurant"). Jumbo is hier een supermarkt, IKEA
 * meestal geen etentje; supermarkten en energiebedrijven met een tankstation of laadpaal geven meestal
 * geen bon voor brandstof.
 */
const OTHER_HERE = new Set([
  'jumbo', 'ikea', 'alcampo', 'auchan', 'carrefour', 'casino', 'coles', 'kroger', 'safeway', 'weis', 'hofer', 'leclerc',
  'cora', 'giant', 'vattenfall', 'innogy', 'enel', 'fortum', 'eviny', 'raiffeisen', 'porsche', 'mercedes', 'tesla', 'aldi',
  'lidl', 'spar', 'edeka', 'rewe', 'tesco', 'sainsbury', 'sainsburys', 'asda', 'morrisons', 'walmart', 'target', 'costco',
  'intermarche', 'esselunga', 'coop', 'migros', 'delhaize', 'colruyt', 'albert',
]);

/** Te algemeen om op te vertrouwen als (begin van een) leveranciersnaam. */
const STOP = new Set([
  'total', 'station', 'garage', 'cafe', 'restaurant', 'service', 'services', 'shop', 'store', 'market', 'express', 'city',
  'center', 'centre', 'central', 'energy', 'auto', 'autos', 'car', 'cars', 'fuel', 'benzine', 'tank', 'parking', 'bistro',
  'grill', 'pizza', 'burger', 'burgers', 'coffee', 'kebab', 'snack', 'friet', 'sushi', 'home', 'house', 'best', 'first',
  'star', 'union', 'national', 'general', 'direct', 'online', 'mobile', 'phone', 'telecom', 'insurance', 'office', 'euro',
  'europa', 'europe', 'global', 'international', 'group', 'company', 'food', 'foods', 'kitchen', 'grand', 'royal', 'golden',
  'green', 'blue', 'red', 'black', 'white', 'super', 'smart', 'easy', 'quick', 'fast', 'plus', 'basic', 'classic', 'local',
  'metro', 'urban', 'point', 'corner', 'world', 'max', 'prime', 'eco', 'tapas', 'wok', 'doner', 'noodles', 'chicken',
  'bakker', 'visser', 'jansen', 'smit', 'meijer', 'bosch', 'hertz', 'apple', 'orange', 'shell', 'mega', 'maxi', 'mini',
  // gewone woorden, voor- en achternamen
  'diego', 'hammer', 'beacon', 'crawford', 'monter', 'bite', 'boost', 'freedom', 'play', 'save', 'three', 'fido',
  'holiday', 'pilot', 'delta', 'liberty', 'loop', 'pace', 'tempo', 'vega', 'zest', 'prim', 'astro', 'avanti', 'elan',
  'emotion', 'flyers', 'markant', 'indigo', 'octa', 'tops', 'petrol', 'recharge', 'certified', 'clark', 'domo', 'volta',
  'witty', 'stripes', 'haan', 'maes', 'krist', 'hele', 'peut', 'alex', 'alice', 'leon', 'joey', 'mikes', 'marcos', 'ginos',
  'mikel', 'egon', 'notes', 'pure', 'hell', 'neat', 'scores', 'cultures', 'islands', 'lounges', 'valentine', 'thyme',
  'yolk', 'tortilla', 'udon', 'wasabi', 'momo', 'quickly', 'twisters', 'rolls', 'ribs', 'tossed', 'pressed', 'grind',
  'cosmo', 'coco', 'bravo', 'gusto', 'aroma', 'bonanza', 'caravan', 'everest', 'pumpkin', 'pausa', 'sumo', 'taro',
  'amici', 'amigos', 'sphinx', 'costa', 'milestones', 'roadhouse', 'harvester', 'cappuccino', 'arabica', 'browns',
  'earls', 'wards', 'mortons', 'alliance', 'budget', 'cargo', 'dollar', 'enterprise', 'payless', 'practical', 'premio',
  'profile', 'wash', 'oficina', 'automat', 'farmers', 'progressive', 'nationwide', 'operators', 'ergo', 'beep', 'comet',
  'commet', 'expert', 'folder', 'okay', 'public', 'titi', 'zora',
]);

interface Item {
  displayName: string;
  locationSet?: { include?: string[]; exclude?: string[] };
  matchNames?: string[];
  tags?: Record<string, string>;
}

const inScope = (item: Item) => {
  const inc = (item.locationSet?.include ?? []).map((c) => String(c).toLowerCase());
  const exc = (item.locationSet?.exclude ?? []).map((c) => String(c).toLowerCase());
  return !exc.includes('nl') && inc.some((c) => LOCATIONS.has(c.split('-')[0]!));
};

const usable = (key: string) => key.replace(/ /g, '').length >= 4 && !/^\d+$/.test(key.replace(/ /g, '')) && !STOP.has(key) && !OTHER_HERE.has(key.split(' ')[0]!);

async function getJson<T>(url: string): Promise<T | null> {
  const res = await fetch(url, { headers: { 'user-agent': 'boekhoudenvoorniks-leveranciers-nsi' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return (await res.json()) as T;
}

async function main() {
  const commit = (await getJson<{ sha: string }>(`https://api.github.com/repos/${REPO}/commits/main`))!.sha;
  const raw = (path: string) => `https://raw.githubusercontent.com/${REPO}/${commit}/${path}`;
  const licenseRes = await fetch(raw('LICENSE.md'));
  if (!licenseRes.ok) throw new Error(`Licentie niet gevonden (${licenseRes.status}); zonder licentietekst geen index`);
  const license = await licenseRes.text();

  const byKey = new Map<string, { name: string; category: string; kind: string }[]>();
  const dropped: string[] = [];
  for (const [kind, category] of Object.entries(KINDS)) {
    const file = await getJson<{ items: Item[] }>(raw(`data/brands/${kind}.json`));
    if (!file) {
      console.warn(`(geen bestand voor ${kind})`);
      continue;
    }
    let n = 0;
    for (const item of file.items.filter(inScope)) {
      const t = item.tags ?? {};
      const names = [item.displayName, t.name, t.brand, t['name:nl'], t['brand:nl'], t['name:en'], t['brand:en'], ...(item.matchNames ?? [])].filter(Boolean) as string[];
      for (const key of new Set(names.map(normalizeBrand))) {
        if (!usable(key)) {
          if (key) dropped.push(`${key} (te kort of te algemeen)`);
          continue;
        }
        const list = byKey.get(key) ?? [];
        if (!list.some((x) => x.category === category)) list.push({ name: item.displayName, category, kind });
        byKey.set(key, list);
        n++;
      }
    }
    console.log(`${kind}: ${n} namen → ${category}`);
  }

  const merken: [string, string, string, string][] = [];
  for (const [key, list] of [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (list.length > 1) {
      dropped.push(`${key} (${list.map((x) => `${x.name}: ${x.category}`).join(' / ')})`);
      continue;
    }
    merken.push([key, list[0]!.name, list[0]!.category, list[0]!.kind]);
  }

  const out = {
    bron: `https://github.com/${REPO} (data/brands), commit ${commit}`,
    licentie: license.trim(),
    gegenereerd: new Date().toISOString().slice(0, 10),
    uitleg: 'Gegenereerd door src/tools/leveranciers-nsi.ts; niet met de hand aanpassen. merken: [genormaliseerde naam, weergavenaam, categorie, soort winkel]',
    merken,
  };
  const target = join(process.cwd(), 'src/intake/brand-index.json');
  writeFileSync(target, `${JSON.stringify(out, null, 0).replace(/\],\[/g, '],\n[')}\n`);
  console.log(`\n${merken.length} namen geschreven naar ${target}`);
  console.log(`${dropped.length} weggelaten; eerste 40:\n  ${dropped.slice(0, 40).join('\n  ')}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
