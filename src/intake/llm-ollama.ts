import type { FetchLike } from '../integrations/types';
import type { LlmClassifier } from './classify';

/**
 * Optionele lokale LLM via een Ollama-compatibele server op deze computer.
 * Geeft ALLEEN een categorievoorstel; de Classifier kapt de zekerheid af zodat er nooit
 * op basis van alleen een LLM automatisch geboekt wordt.
 */
export class OllamaClassifier implements LlmClassifier {
  readonly id = 'ollama';
  constructor(private readonly baseUrl: string, private readonly model: string, private readonly fetchImpl: FetchLike) {
    const u = new URL(baseUrl);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) throw new Error('De lokale AI moet op deze computer draaien (localhost)');
  }

  async classify(input: { supplier: string | null; lines: string[]; categories: { key: string; label: string; hint: string }[] }) {
    const prompt = [
      'Je classificeert een aankoop van een Nederlandse vakman (zzp) in precies één categorie.',
      'Antwoord uitsluitend met JSON: {"category": "<key>", "confidence": <0..1>, "explanation": "<kort>"}.',
      `Categorieën: ${input.categories.map((c) => `${c.key} (${c.label}${c.hint ? ': ' + c.hint : ''})`).join('; ')}`,
      `Leverancier: ${input.supplier ?? 'onbekend'}`,
      `Artikelen: ${input.lines.slice(0, 15).join(' | ') || 'onbekend'}`,
    ].join('\n');
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, '')}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, prompt, stream: false, format: 'json', options: { temperature: 0 } }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { response?: string };
    try {
      const parsed = JSON.parse(body.response ?? '{}') as { category?: string; confidence?: number; explanation?: string };
      if (!parsed.category) return null;
      return { categoryKey: parsed.category, confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0.5)), explanation: parsed.explanation ?? '' };
    } catch {
      return null;
    }
  }
}
