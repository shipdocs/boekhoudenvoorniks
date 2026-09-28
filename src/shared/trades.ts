/**
 * Beroepsprofielen voor onboarding: verstandige standaarden per vak, zodat de gebruiker
 * zo min mogelijk hoeft in te stellen. Tarieven zijn VOORSTELLEN die de gebruiker per regel ziet.
 *
 * LET OP: het 9%-tarief voor arbeid bij schilderen/stukadoren/behangen van woningen ouder dan
 * 2 jaar moet meegenomen worden in de fiscale review (zie GitHub-issue).
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
  items: { description: string; unit: string; vatCode: 'hoog' | 'laag'; note?: string }[];
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

const RENOVATIE_NOTE = '9% geldt voor het arbeidsloon bij woningen die ouder zijn dan 2 jaar; materiaal is 21%.';

export const TRADES: TradePreset[] = [
  {
    key: 'stukadoor',
    label: 'Stukadoor',
    items: [
      { description: 'Stucwerk wanden (arbeid)', unit: 'm²', vatCode: 'laag', note: RENOVATIE_NOTE },
      { description: 'Plafond spuiten (arbeid)', unit: 'm²', vatCode: 'laag', note: RENOVATIE_NOTE },
      { description: 'Materiaal', unit: 'totaal', vatCode: 'hoog' },
      { description: 'Voorrijkosten', unit: 'keer', vatCode: 'hoog' },
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
      { description: 'Verf en materiaal', unit: 'totaal', vatCode: 'hoog' },
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
