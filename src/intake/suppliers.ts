/**
 * Bekende Nederlandse leveranciers → naam en waarschijnlijke categorie.
 * Dit zijn deterministische regels (geen AI). De gebruiker kan altijd corrigeren;
 * die correcties gaan naar supplier_rules en winnen dan van deze lijst.
 */
export interface KnownSupplier {
  name: string;
  pattern: RegExp;
  category: string;
  vatCode: 'hoog' | 'laag' | 'nul' | 'geen';
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
  { name: 'Google', pattern: /\bgoogle\b/i, category: 'software', vatCode: 'hoog' },
];

/** Artikelomschrijvingen die op gereedschap wijzen (binnen een bouwmarktbon). */
export const TOOL_KEYWORDS = /\b(makita|dewalt|bosch\s*(professional|blauw)?|metabo|hilti|festool|milwaukee|ryobi|boor(machine)?|schroefmachine|zaag|slijper|accu|ladder|steiger|spaan|troffel|kwast|roller|mixer|garde)\b/i;
