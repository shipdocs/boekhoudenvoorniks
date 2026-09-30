import { findBrand } from './brand-index';

/**
 * Bekende Nederlandse leveranciers → naam en waarschijnlijke categorie.
 * Dit zijn deterministische regels (geen AI). De gebruiker kan altijd corrigeren;
 * die correcties gaan naar supplier_rules en winnen dan van deze lijst.
 */
export interface KnownSupplier {
  name: string;
  pattern: RegExp;
  category: string;
  vatCode: 'hoog' | 'laag' | 'nul' | 'geen' | 'eu' | 'buiten-eu';
}

export const KNOWN_SUPPLIERS: KnownSupplier[] = [
  { name: 'Gamma', pattern: /\bgamma\b/i, category: 'materiaal', vatCode: 'hoog' },
  { name: 'Praxis', pattern: /\bpraxis\b/i, category: 'materiaal', vatCode: 'hoog' },
  { name: 'Karwei', pattern: /\bkarwei\b/i, category: 'materiaal', vatCode: 'hoog' },
  { name: 'Hornbach', pattern: /\bhornbach\b/i, category: 'materiaal', vatCode: 'hoog' },
  { name: 'Hubo', pattern: /\bhubo\b/i, category: 'materiaal', vatCode: 'hoog' },
  { name: 'Bouwmaat', pattern: /\bbouwmaat\b/i, category: 'materiaal', vatCode: 'hoog' },
  { name: 'Toolstation', pattern: /\btoolstation\b/i, category: 'materiaal', vatCode: 'hoog' },
  { name: 'Sigma', pattern: /\bsigma\s*coatings?\b/i, category: 'materiaal', vatCode: 'hoog' },
  { name: 'Sikkens', pattern: /\bsikkens\b/i, category: 'materiaal', vatCode: 'hoog' },
  { name: 'Wijnen Bouwmaterialen', pattern: /\bwijnen\b/i, category: 'materiaal', vatCode: 'hoog' },
  { name: 'Technische Unie', pattern: /technische\s+unie/i, category: 'materiaal', vatCode: 'hoog' },
  { name: 'Rexel', pattern: /\brexel\b/i, category: 'materiaal', vatCode: 'hoog' },
  { name: 'Wasco', pattern: /\bwasco\b/i, category: 'materiaal', vatCode: 'hoog' },
  { name: 'Shell', pattern: /\bshell\b/i, category: 'brandstof', vatCode: 'hoog' },
  { name: 'BP', pattern: /\bbp\b/i, category: 'brandstof', vatCode: 'hoog' },
  { name: 'Esso', pattern: /\besso\b/i, category: 'brandstof', vatCode: 'hoog' },
  { name: 'TotalEnergies', pattern: /\btotal\s*energies\b/i, category: 'brandstof', vatCode: 'hoog' },
  { name: 'Tango', pattern: /\btango\b/i, category: 'brandstof', vatCode: 'hoog' },
  { name: 'TinQ', pattern: /\btinq\b/i, category: 'brandstof', vatCode: 'hoog' },
  { name: 'Tamoil', pattern: /\btamoil\b/i, category: 'brandstof', vatCode: 'hoog' },
  { name: 'Q-Park', pattern: /\bq-?park\b/i, category: 'brandstof', vatCode: 'hoog' },
  { name: 'KPN', pattern: /\bkpn\b/i, category: 'telefoon', vatCode: 'hoog' },
  { name: 'Vodafone', pattern: /\bvodafone\b/i, category: 'telefoon', vatCode: 'hoog' },
  { name: 'Odido', pattern: /\bodido\b|t-mobile/i, category: 'telefoon', vatCode: 'hoog' },
  { name: 'Ziggo', pattern: /\bziggo\b/i, category: 'telefoon', vatCode: 'hoog' },
  { name: 'Coolblue', pattern: /\bcoolblue\b/i, category: 'kantoor', vatCode: 'hoog' },
  { name: 'Bol.com', pattern: /\bbol\.com\b/i, category: 'kantoor', vatCode: 'hoog' },
  { name: 'Microsoft', pattern: /\bmicrosoft\b/i, category: 'software', vatCode: 'hoog' },
  // Amerikaans bedrijf, factureert zonder btw met "reverse charge": jij rekent de btw zelf af (4a)
  { name: 'Anthropic', pattern: /\banthropic\b/i, category: 'software', vatCode: 'buiten-eu' },
  { name: 'Google', pattern: /\bgoogle\b/i, category: 'software', vatCode: 'hoog' },
  // Ierse vestigingen factureren zakelijke klanten met btw-nummer zonder btw: verlegd uit de EU (4b, #16)
  { name: 'Meta', pattern: /\bmeta\s+platforms\b|\bfacebook\b/i, category: 'reclame', vatCode: 'eu' },
  { name: 'Stripe', pattern: /\bstripe\b/i, category: 'bank', vatCode: 'eu' },
  { name: 'LinkedIn', pattern: /\blinkedin\b/i, category: 'reclame', vatCode: 'eu' },
  // Software en hosting: staan niet in de winkelindex (brand-index.ts). Nederlandse aanbieders met btw.
  { name: 'Hostnet', pattern: /\bhostnet\b/i, category: 'software', vatCode: 'hoog' },
  { name: 'TransIP', pattern: /\btransip\b/i, category: 'software', vatCode: 'hoog' },
  { name: 'Mijndomein', pattern: /\bmijndomein\b/i, category: 'software', vatCode: 'hoog' },
  { name: 'Vimexx', pattern: /\bvimexx\b/i, category: 'software', vatCode: 'hoog' },
  { name: 'Moneybird', pattern: /\bmoneybird\b/i, category: 'software', vatCode: 'hoog' },
  { name: 'e-Boekhouden', pattern: /\be-?boekhouden\b/i, category: 'software', vatCode: 'hoog' },
  { name: 'SnelStart', pattern: /\bsnelstart\b/i, category: 'software', vatCode: 'hoog' },
  // Ierse/Luxemburgse vestigingen factureren zakelijke klanten met btw-nummer zonder btw: verlegd uit de EU (4b)
  { name: 'Adobe', pattern: /\badobe\b/i, category: 'software', vatCode: 'eu' },
  { name: 'Dropbox', pattern: /\bdropbox\b/i, category: 'software', vatCode: 'eu' },
  { name: 'Slack', pattern: /\bslack\s+technologies\b/i, category: 'software', vatCode: 'eu' },
  { name: 'Amazon Web Services', pattern: /amazon\s+web\s+services|\baws\s+emea\b/i, category: 'software', vatCode: 'eu' },
  { name: 'OpenAI', pattern: /\bopenai\b/i, category: 'software', vatCode: 'eu' },
  // Amerikaans, factureert zonder btw: verlegd van buiten de EU (4a)
  { name: 'GitHub', pattern: /\bgithub\b/i, category: 'software', vatCode: 'buiten-eu' },
  // Verzekeraars: vrijgesteld van btw. Let op: niet elke polis is zakelijk (AOV en zorg zijn privé).
  { name: 'Interpolis', pattern: /\binterpolis\b/i, category: 'verzekering', vatCode: 'geen' },
  { name: 'Centraal Beheer', pattern: /centraal\s+beheer/i, category: 'verzekering', vatCode: 'geen' },
  { name: 'Nationale-Nederlanden', pattern: /nationale[\s-]+nederlanden/i, category: 'verzekering', vatCode: 'geen' },
  { name: 'a.s.r.', pattern: /\ba\.s\.r\.|\basr\s+(schade)?verzekeringen\b/i, category: 'verzekering', vatCode: 'geen' },
  { name: 'Allianz', pattern: /\ballianz\b/i, category: 'verzekering', vatCode: 'geen' },
  { name: 'OHRA', pattern: /\bohra\b/i, category: 'verzekering', vatCode: 'geen' },
  { name: 'Univé', pattern: /\buniv[eé](?![a-z])/i, category: 'verzekering', vatCode: 'geen' },
  { name: 'Achmea', pattern: /\bachmea\b/i, category: 'verzekering', vatCode: 'geen' },
  { name: 'Klaverblad', pattern: /\bklaverblad\b/i, category: 'verzekering', vatCode: 'geen' },
  { name: 'De Goudse', pattern: /\bde\s+goudse\b/i, category: 'verzekering', vatCode: 'geen' },
  // Drukwerk
  { name: 'Vistaprint', pattern: /\bvistaprint\b/i, category: 'reclame', vatCode: 'hoog' },
  { name: 'Drukwerkdeal', pattern: /\bdrukwerkdeal\b/i, category: 'reclame', vatCode: 'hoog' },
];

/**
 * Een bekende leverancier: eerst deze handmatige lijst (wint altijd), dan de winkelindex uit
 * OpenStreetMap (brand-index.ts). Horeca uit de index krijgt geen btw: die op eten en drinken is niet
 * aftrekbaar.
 */
export function findKnownSupplier(name: string | null | undefined): (KnownSupplier & { source: 'lijst' | 'index' }) | null {
  if (!name) return null;
  const listed = KNOWN_SUPPLIERS.find((s) => s.pattern.test(name));
  if (listed) return { ...listed, source: 'lijst' };
  const brand = findBrand(name);
  if (!brand) return null;
  return { name: brand.name, pattern: /$^/, category: brand.category, vatCode: brand.category === 'representatie' || brand.category === 'verzekering' ? 'geen' : 'hoog', source: 'index' };
}

/** Apparaten die (vanaf € 450 excl. btw) meestal een investering zijn; daaronder kantoorkosten. */
export const DEVICE_KEYWORDS = /\b(laptop|notebook|macbook|imac|computer|desktop|monitor|beeldscherm|printer|iphone|smartphone|telefoon|galaxy|tablet|ipad|aanhanger|aanhangwagen)\b/i;

/** Artikelomschrijvingen die op gereedschap wijzen (binnen een bouwmarktbon). */
export const TOOL_KEYWORDS = /\b(makita|dewalt|bosch\s*(professional|blauw)?|metabo|hilti|festool|milwaukee|ryobi|boor(machine)?|schroefmachine|zaag|slijper|accu|ladder|steiger|spaan|troffel|kwast|roller|mixer|garde)\b/i;
