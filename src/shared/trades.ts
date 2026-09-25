/**
 * Beroepsprofielen voor onboarding: verstandige standaarden per vak, zodat de gebruiker
 * zo min mogelijk hoeft in te stellen. Tarieven zijn VOORSTELLEN die de gebruiker per regel ziet.
 *
 * LET OP: het 9%-tarief voor arbeid bij schilderen/stukadoren/behangen van woningen ouder dan
 * 2 jaar moet meegenomen worden in de fiscale review (zie GitHub-issue).
 */
export interface TradePreset {
  key: string;
  label: string;
  items: { description: string; unit: string; vatCode: 'hoog' | 'laag'; note?: string }[];
}

const RENOVATIE_NOTE = '9% geldt voor het arbeidsloon bij woningen die ouder zijn dan 2 jaar; materiaal is 21%.';

export const TRADES: TradePreset[] = [
  {
    key: 'stukadoor',
    label: 'Stukadoor',
    items: [
      { description: 'Stucwerk wanden (arbeid)', unit: 'm²', vatCode: 'laag', note: RENOVATIE_NOTE },
      { description: 'Plafond spuiten (arbeid)', unit: 'm²', vatCode: 'laag', note: RENOVATIE_NOTE },
      { description: 'Materiaal', unit: 'post', vatCode: 'hoog' },
      { description: 'Voorrijkosten', unit: 'keer', vatCode: 'hoog' },
    ],
  },
  {
    key: 'schilder',
    label: 'Schilder',
    items: [
      { description: 'Schilderwerk binnen (arbeid)', unit: 'm²', vatCode: 'laag', note: RENOVATIE_NOTE },
      { description: 'Schilderwerk buiten (arbeid)', unit: 'uur', vatCode: 'laag', note: RENOVATIE_NOTE },
      { description: 'Verf en materiaal', unit: 'post', vatCode: 'hoog' },
    ],
  },
  { key: 'timmerman', label: 'Timmerman', items: [{ description: 'Timmerwerk', unit: 'uur', vatCode: 'hoog' }, { description: 'Materiaal', unit: 'post', vatCode: 'hoog' }] },
  { key: 'loodgieter', label: 'Loodgieter', items: [{ description: 'Arbeid', unit: 'uur', vatCode: 'hoog' }, { description: 'Materiaal', unit: 'post', vatCode: 'hoog' }, { description: 'Voorrijkosten', unit: 'keer', vatCode: 'hoog' }] },
  { key: 'elektricien', label: 'Elektricien', items: [{ description: 'Arbeid', unit: 'uur', vatCode: 'hoog' }, { description: 'Materiaal', unit: 'post', vatCode: 'hoog' }] },
  { key: 'klusbedrijf', label: 'Klusbedrijf', items: [{ description: 'Klussen', unit: 'uur', vatCode: 'hoog' }, { description: 'Materiaal', unit: 'post', vatCode: 'hoog' }] },
  { key: 'anders', label: 'Iets anders', items: [{ description: 'Werkzaamheden', unit: 'uur', vatCode: 'hoog' }] },
];
