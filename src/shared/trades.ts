/**
 * Beroepsprofielen voor onboarding: verstandige standaarden per vak, zodat de gebruiker
 * zo min mogelijk hoeft in te stellen. Tarieven zijn VOORSTELLEN die de gebruiker per regel ziet.
 *
 * Schilderen en stukadoren van woningen ouder dan 2 jaar valt onder 9%, inclusief de gebruikte
 * materialen, het voorbereiden en de voorbehandeling (Belastingdienst, "Btw-tarief schilderen" en
 * "Btw-tarief stukadoren"). Werk dat daar te ver van afstaat is 21%; de gebruiker kiest per regel.
 */
import type { PurchaseVatCode } from './vat';

/**
 * Een kostenpost die bij een vak hoort, als voorstel voor een eigen categorie (zie
 * settings/categories.ts). Hij boekt op de grootboekrekening van `groupKey`, zodat de boekhouder
 * alles terugvindt; `defaultVat` is wat er meestal op de bon staat.
 */
export interface TradeCost {
  label: string;
  hint: string;
  groupKey: string;
  defaultVat?: PurchaseVatCode;
}

export interface TradePreset {
  key: string;
  label: string;
  items: {
    description: string;
    unit: string;
    vatCode: 'hoog' | 'laag';
    note?: string;
    /** neemt het tarief over van de regels die al op de factuur staan (bijkomende kosten van het werk) */
    followsMain?: boolean;
  }[];
  /** kostenposten die we in de onboarding voorstellen (aangevinkt) */
  costs: TradeCost[];
  /** ingebouwde categorieën die dit vak zelden gebruikt: voorstel om te verbergen */
  hide: string[];
}

const BUITENLAND_HINT = 'meestal zonder btw op de factuur (leverancier buiten de EU)';

const BOUW_COSTS: TradeCost[] = [
  { label: 'Steiger- en machinehuur', hint: 'steigers, hoogwerker, bouwdroger: gehuurd voor een klus', groupKey: 'materiaal' },
  { label: 'Afval en stortkosten', hint: 'container, milieustraat', groupKey: 'materiaal' },
  { label: 'Cursussen en vakliteratuur', hint: 'opleiding, certificaten, vakbladen', groupKey: 'overig' },
];

const TECHNIEK_COSTS: TradeCost[] = [
  { label: 'Keuringen en certificaten', hint: 'keuring van gereedschap en meetapparatuur, erkenningen', groupKey: 'overig' },
  { label: 'Cursussen en vakliteratuur', hint: 'opleiding, bijscholing, vakbladen', groupKey: 'overig' },
];

const RENOVATIE_NOTE =
  '9% geldt voor schilder- en stukadoorswerk aan woningen die ouder zijn dan 2 jaar, ook over de gebruikte materialen, het voorbereiden en de voorbehandeling. ' +
  'Werk dat daar te ver van afstaat, zoals ramen, deuren en kozijnen vervangen of gipswanden plaatsen, is 21%: kies dan zelf 21% voor die regel. ' +
  "Voorrijkosten bij zo'n klus volgen hetzelfde tarief; een losse rekening voor alleen voorrijden valt daar niet onder (vraag je boekhouder).";

export const TRADES: TradePreset[] = [
  {
    key: 'stukadoor',
    label: 'Stukadoor',
    items: [
      { description: 'Stucwerk wanden (arbeid)', unit: 'm²', vatCode: 'laag', note: RENOVATIE_NOTE },
      { description: 'Plafond spuiten (arbeid)', unit: 'm²', vatCode: 'laag', note: RENOVATIE_NOTE },
      { description: 'Materiaal', unit: 'totaal', vatCode: 'laag', note: RENOVATIE_NOTE },
      { description: 'Voorrijkosten', unit: 'keer', vatCode: 'laag', note: RENOVATIE_NOTE, followsMain: true },
    ],
    costs: BOUW_COSTS,
    hide: [],
  },
  {
    key: 'schilder',
    label: 'Schilder',
    items: [
      { description: 'Schilderwerk binnen (arbeid)', unit: 'm²', vatCode: 'laag', note: RENOVATIE_NOTE },
      { description: 'Schilderwerk buiten (arbeid)', unit: 'uur', vatCode: 'laag', note: RENOVATIE_NOTE },
      { description: 'Verf en materiaal', unit: 'totaal', vatCode: 'laag', note: RENOVATIE_NOTE },
    ],
    costs: BOUW_COSTS,
    hide: [],
  },
  { key: 'timmerman', label: 'Timmerman', items: [{ description: 'Timmerwerk', unit: 'uur', vatCode: 'hoog' }, { description: 'Materiaal', unit: 'totaal', vatCode: 'hoog' }], costs: BOUW_COSTS, hide: [] },
  { key: 'loodgieter', label: 'Loodgieter', items: [{ description: 'Arbeid', unit: 'uur', vatCode: 'hoog' }, { description: 'Materiaal', unit: 'totaal', vatCode: 'hoog' }, { description: 'Voorrijkosten', unit: 'keer', vatCode: 'hoog' }], costs: TECHNIEK_COSTS, hide: [] },
  { key: 'elektricien', label: 'Elektricien', items: [{ description: 'Arbeid', unit: 'uur', vatCode: 'hoog' }, { description: 'Materiaal', unit: 'totaal', vatCode: 'hoog' }], costs: TECHNIEK_COSTS, hide: [] },
  { key: 'klusbedrijf', label: 'Klusbedrijf', items: [{ description: 'Klussen', unit: 'uur', vatCode: 'hoog' }, { description: 'Materiaal', unit: 'totaal', vatCode: 'hoog' }], costs: BOUW_COSTS, hide: [] },
  {
    key: 'webdev',
    label: 'Webdeveloper / ICT',
    items: [
      { description: 'Ontwikkeling', unit: 'uur', vatCode: 'hoog' },
      { description: 'Hosting en onderhoud', unit: 'maand', vatCode: 'hoog' },
      { description: 'Licenties en domeinnamen', unit: 'totaal', vatCode: 'hoog' },
    ],
    costs: [
      { label: 'AI-tools', hint: `ChatGPT, Claude, Copilot, Cursor; ${BUITENLAND_HINT}`, groupKey: 'software', defaultVat: 'buiten-eu' },
      { label: 'Hosting en servers', hint: 'webhosting, VPS, cloudservers', groupKey: 'software' },
      { label: 'Domeinnamen', hint: 'registratie en verlenging', groupKey: 'software' },
      { label: 'Developer-tools en licenties', hint: `GitHub, JetBrains, Figma, Adobe; ${BUITENLAND_HINT}`, groupKey: 'software', defaultVat: 'buiten-eu' },
      { label: 'Computer en randapparatuur', hint: 'monitor, toetsenbord, dock (tot € 450 per stuk; een laptop daarboven is een investering)', groupKey: 'gereedschap' },
      { label: 'Cursussen, boeken en congressen', hint: 'opleiding, vakboeken, conferentietickets', groupKey: 'overig' },
      { label: 'Flexplek en coworking', hint: 'huur van een werkplek buiten de deur', groupKey: 'huur' },
    ],
    hide: ['materiaal', 'werkkleding', 'onderaannemer'],
  },
  {
    key: 'anders',
    label: 'Iets anders',
    items: [{ description: 'Werkzaamheden', unit: 'uur', vatCode: 'hoog' }],
    costs: [{ label: 'Cursussen en vakliteratuur', hint: 'opleiding, vakboeken, vakbladen', groupKey: 'overig' }],
    hide: [],
  },
];

/** De verschillende tarieven van het echte werk op de factuur; bijkomende kosten (zoals voorrijkosten) tellen niet mee. */
export function workVatCodes<V extends string>(trade: TradePreset, lines: { description: string; vatCode: V }[]): V[] {
  const work = lines.filter((l) => l.description && !trade.items.some((x) => x.followsMain && x.description === l.description));
  return [...new Set(work.map((l) => l.vatCode))];
}

/**
 * Het tarief waarmee een voorstelregel op de factuur komt. Bijkomende kosten (zoals voorrijkosten)
 * nemen het tarief over van het werk dat al op de factuur staat. Staat er nog niets, of staat er werk
 * tegen verschillende tarieven, dan geldt het voorgestelde tarief van de regel zelf: de app kiest dan
 * niet en DocumentEditor vraagt de gebruiker het tarief na te kijken.
 */
export function presetVatCode<V extends string>(
  trade: TradePreset,
  item: TradePreset['items'][number],
  existing: { description: string; vatCode: V }[],
): V | TradePreset['items'][number]['vatCode'] {
  if (!item.followsMain) return item.vatCode;
  const codes = workVatCodes(trade, existing);
  return codes.length === 1 ? codes[0]! : item.vatCode;
}
