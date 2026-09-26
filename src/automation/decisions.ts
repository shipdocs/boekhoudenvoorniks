/**
 * Zekerheid per veld en per beslissing (#21). Automatisch verwerken mag alleen als álle
 * vereiste velden en beslissingen boven hun drempel zitten; één twijfelgeval = vragen.
 */
export type AutopilotLevel = 'voorzichtig' | 'normaal' | 'maximaal';

export type DecisionKind =
  | 'veld:leverancier'
  | 'veld:datum'
  | 'veld:totaal'
  | 'veld:btw'
  | 'categorie'
  | 'btw-behandeling'
  | 'zakelijk'
  | 'bankkoppeling';

/** Eén signaal achter een beslissing: wat we zagen en hoe zwaar het meewoog. */
export interface Signal {
  type: 'extractie' | 'e-factuur' | 'validatie' | 'leveranciersregel' | 'document-btw' | 'bankbetaling' | 'matching' | 'standaard';
  /** korte omschrijving in mensentaal, zonder jargon */
  label: string;
  /** 0..1 */
  value: number;
}

export interface Decision {
  kind: DecisionKind;
  /** in mensentaal, bv. "Totaal" of "Categorie" */
  label: string;
  /** het veld in de controleweergave waar dit bij hoort */
  field?: string;
  value: string;
  confidence: number;
  threshold: number;
  ok: boolean;
  signals: Signal[];
}

/** Behoudende standaarddrempels (normaal). */
export const THRESHOLDS: Record<DecisionKind, number> = {
  'veld:leverancier': 0.8,
  'veld:datum': 0.8,
  'veld:totaal': 0.85,
  'veld:btw': 0.8,
  categorie: 0.9,
  'btw-behandeling': 0.9,
  zakelijk: 0.9,
  bankkoppeling: 0.9,
};

/** Drempel voor een beslissing bij een autopilotstand. Voorzichtig = nooit automatisch. */
export function thresholdFor(kind: DecisionKind, level: AutopilotLevel): number {
  if (level === 'voorzichtig') return Number.POSITIVE_INFINITY;
  return level === 'maximaal' ? THRESHOLDS[kind] - 0.05 : THRESHOLDS[kind];
}

export function decide(kind: DecisionKind, label: string, value: string, confidence: number, signals: Signal[], level: AutopilotLevel, field?: string): Decision {
  const threshold = thresholdFor(kind, level);
  const c = Math.max(0, Math.min(1, confidence));
  return { kind, label, field, value, confidence: c, threshold, ok: c >= threshold, signals };
}

/** Automatisch alleen als elke beslissing boven de drempel zit. */
export function allCertain(decisions: Decision[]): boolean {
  return decisions.length > 0 && decisions.every((d) => d.ok);
}

export const pct = (v: number) => `${Math.round(v * 1000) / 10}`.replace('.', ',') + '%';
