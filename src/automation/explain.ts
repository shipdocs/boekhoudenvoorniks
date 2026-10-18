import type { Decision, Signal } from './decisions';
import { pct } from './decisions';

/**
 * "Waarom?" (#28): een uitleg in gewone taal uit vaste sjablonen (geen LLM), zodat hij
 * reproduceerbaar is. Alleen signalen die echt zijn gebruikt komen erin.
 */
export interface Explanation {
  /** de zin voor de gebruiker */
  sentence: string;
  /** expertregel: signaal + percentage */
  expert: string;
  signals: Signal[];
  decisions?: Pick<Decision, 'kind' | 'label' | 'value' | 'confidence' | 'threshold' | 'ok'>[];
  /** wat er geraakt is, om "Klopt niet" precies terug te kunnen draaien */
  refs?: { bankTransactionId?: number };
}

function joinNl(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} en ${parts[parts.length - 1]}`;
}

export function explain(signals: Signal[], decisions?: Decision[]): Explanation {
  const used = signals.filter((s) => s.label.trim() !== '');
  const reasons = used.filter((s) => s.type !== 'extractie' && s.type !== 'validatie').map((s) => s.label);
  const sentence = reasons.length ? `Omdat ${joinNl(reasons)}.` : 'Omdat alle gegevens zeker genoeg waren.';
  const expert = used.map((s) => `${s.type} ${pct(s.value)}`).join(' · ');
  return {
    sentence,
    expert,
    signals: used,
    decisions: decisions?.map(({ kind, label, value, confidence, threshold, ok }) => ({ kind, label, value, confidence, threshold: Number.isFinite(threshold) ? threshold : 1, ok })),
  };
}
