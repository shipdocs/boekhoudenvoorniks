import type { DocumentResult, LineItem } from './types';
import type { Cents } from '../shared/money';
import { formatEuro } from '../shared/money';
import { EXPENSE_CATEGORIES } from '../shared/categories';

/**
 * Regels van één bon over categorieën verdelen (#23): vaste trefwoorden (geen AI) per regel.
 * Alleen als de regels precies optellen tot het totaal; anders boeken we op totaalniveau.
 */
export type LineCategory = string; // een EXPENSE_CATEGORIES-key of 'prive'

const RULES: [RegExp, LineCategory][] = [
  [/werk(broek|jas|jack|schoen|kleding|shirt|trui|handschoen)|veiligheidsschoen|kniebeschermer|overall|handschoen|softshell|fleece|bodywarmer|oorbescherm|stofmasker|veiligheidsbril/i, 'werkkleding'],
  [/boormachine|klopboor|schroefmachine|zaagmachine|haakse slijper|slijptol|multitool|laser|accu\b|accuset|machine|compressor|steigerbok|ladder|trap\b/i, 'gereedschap'],
  [/\b(boor|boren|bit|bits|zaag|zaagblad|beitel|hamer|tang|waterpas|troffel|spaan|plakspaan|kwast|roller|schroevendraaier|rolmaat|mes|cutter|kitspuit|mixer|garde|emmer|kuip)\b/i, 'gereedschap'],
  [/chips|snoep|chocola|cola|frisdrank|bier|wijn|koffiebonen|bloemen|plant(en)?\b|speelgoed|kaars|servet|shampoo|tijdschrift/i, 'prive'],
];

/** Vanaf dit bedrag (excl. btw) per stuk is gereedschap een bedrijfsmiddel (investering). */
export const INVESTMENT_THRESHOLD: Cents = 45000;

export function classifyLine(item: LineItem, basis: 'incl' | 'excl', vatRate = 21): LineCategory {
  for (const [re, cat] of RULES) {
    if (!re.test(item.description)) continue;
    if (cat === 'gereedschap') {
      const each = item.unitPrice ?? (item.quantity && item.quantity > 0 ? Math.round(item.amount / item.quantity) : item.amount);
      const rate = item.vatRate ?? vatRate;
      const excl = basis === 'incl' ? Math.round((each * 100) / (100 + rate)) : each;
      if (excl >= INVESTMENT_THRESHOLD) return 'investering';
    }
    return cat;
  }
  return 'materiaal';
}

/** Tellen de regels op tot het totaal (incl.) of het subtotaal (excl.)? Anders null: niet splitsen. */
export function computeLinesBasis(doc: DocumentResult): 'incl' | 'excl' | null {
  const lines = doc.lines ?? [];
  if (!lines.length) return null;
  const sum = lines.reduce((s, l) => s + l.value.amount, 0);
  if (doc.total && sum === doc.total.value) return 'incl';
  if (doc.subtotal && sum === doc.subtotal.value) return 'excl';
  return null;
}

export interface SplitPart {
  categoryKey: LineCategory;
  /** bedrag inclusief btw */
  gross: Cents;
  items: string[];
  /** btw-tarief van deze regels (als het document dat per regel vermeldt) */
  vatRate?: number;
}

/**
 * Stelt een splitsing voor als de regels kloppen en er meer dan één soort in zit.
 * Geeft null als er niets te splitsen valt of als de regels niet optellen.
 */
export function suggestSplit(doc: DocumentResult): SplitPart[] | null {
  const lines = doc.lines ?? [];
  if (!doc.linesBasis || lines.length < 2 || !doc.total) return null;
  const rate = doc.vat.value.length === 1 ? doc.vat.value[0]!.rate : 21;
  // per soort én per btw-tarief: elk deel wordt met zijn eigen tarief geboekt
  const parts = new Map<string, SplitPart>();
  for (const l of lines) {
    const cat = classifyLine(l.value, doc.linesBasis, rate);
    const lineRate = l.value.vatRate ?? undefined;
    const gross = doc.linesBasis === 'incl' ? l.value.amount : Math.round((l.value.amount * (100 + (lineRate ?? rate))) / 100);
    const key = `${cat}|${lineRate ?? ''}`;
    const p = parts.get(key) ?? { categoryKey: cat, gross: 0, items: [], ...(lineRate !== undefined ? { vatRate: lineRate } : {}) };
    p.gross += gross;
    p.items.push(l.value.description);
    parts.set(key, p);
  }
  if (new Set([...parts.values()].map((p) => p.categoryKey)).size < 2) return null;
  const list = [...parts.values()].sort((a, b) => b.gross - a.gross);
  // afronding bij excl.-regels: het verschil gaat naar het grootste deel, zodat de som = totaal
  const diff = doc.total.value - list.reduce((s, p) => s + p.gross, 0);
  if (Math.abs(diff) > list.length) return null;
  list[0]!.gross += diff;
  return list;
}

export function splitQuestion(parts: SplitPart[]): string {
  const [main, ...rest] = parts;
  const label = (k: string) => (k === 'prive' ? 'privé' : EXPENSE_CATEGORIES.find((c) => c.key === k)?.label.toLowerCase() ?? k);
  return `Deze bon bevat ook ${rest.map((p) => `${p.items.slice(0, 2).join(', ')} (${formatEuro(p.gross)}, ${label(p.categoryKey)})`).join(' en ')}. Apart boeken? De rest (${formatEuro(main!.gross)}) is ${label(main!.categoryKey)}.`;
}
