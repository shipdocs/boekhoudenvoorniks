import type { Classification } from './classify';
import type { ConfidenceLevel, DocumentResult, Issue } from './types';

export interface ConfidenceInput {
  document: DocumentResult;
  issues: Issue[];
  classification: Classification;
  /** is er een banktransactie gevonden met hetzelfde bedrag en een passende datum/naam? */
  bankMatch: boolean;
}

export interface ConfidenceOutcome {
  level: ConfidenceLevel;
  score: number;
  signals: string[];
}

/**
 * Gecombineerde zekerheid uit meerdere signalen — niet alleen de OCR-score.
 *   HIGH   → automatisch verwerken
 *   MEDIUM → één simpele vraag stellen
 *   LOW    → handmatige controle
 */
export function assessConfidence(input: ConfidenceInput): ConfidenceOutcome {
  const { document: d, issues, classification: c, bankMatch } = input;
  const signals: string[] = [];
  if (issues.some((i) => i.severity === 'fout')) {
    return { level: 'LOW', score: 0, signals: issues.filter((i) => i.severity === 'fout').map((i) => i.message) };
  }
  const key = [d.total, d.invoiceDate, d.supplier].map((f) => f?.confidence ?? 0);
  let score = Math.min(...key);
  signals.push(`extractie ${Math.round(score * 100)}%`);
  if (d.total?.source === 'ubl') signals.push('gestructureerde e-factuur');
  if (d.vat.value.length > 0 && d.subtotal) {
    score += 0.05;
    signals.push('netto + BTW = totaal');
  }
  if (bankMatch) {
    score += 0.15;
    signals.push('betaling gevonden op de bank');
  }
  score = Math.min(1, score) * (0.5 + 0.5 * c.confidence);
  signals.push(`categorie ${Math.round(c.confidence * 100)}% (${c.source})`);
  if (issues.length > 0) score -= 0.1 * issues.length;

  let level: ConfidenceLevel = score >= 0.85 ? 'HIGH' : score >= 0.55 ? 'MEDIUM' : 'LOW';
  // Automatisch boeken alleen als de gebruiker deze leverancier al bevestigd heeft
  if (level === 'HIGH' && !c.automatic) level = 'MEDIUM';
  return { level, score: Math.max(0, score), signals };
}
