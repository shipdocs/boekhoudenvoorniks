import type { FetchLike } from '../integrations/types';
import type { LlmClassifier } from './classify';

/**
 * Online hulp bij categorievoorstellen: JEV (`typesafe/jev`) via onze assistent-Worker op Cloudflare
 * (#132; het ontwerp staat in de privé-repo boekhoudenvoorniks-server). Alleen met een actief abonnement en als de gebruiker het aanzette.
 *
 * Er gaat alleen de leveranciersnaam, maximaal 15 korte artikelomschrijvingen (zonder bedragen, IBAN of
 * e-mailadressen) en de lijst met categorieën van deze administratie mee. JEV kiest uitsluitend een
 * categorie; de Classifier kapt de zekerheid af en boekt nooit automatisch op dit voorstel.
 * Elke storing (offline, time-out, 401/402/403/429/5xx, rare respons) = geen voorstel.
 */

export const ASSISTANT_API_URL = 'https://assistent.boekhoudenvoorniks.nl';
export const JEV_SCHEMA_VERSION = 1;
export const JEV_MAX_LINES = 15;
export const JEV_MAX_LINE_LENGTH = 120;
export const JEV_MAX_SUPPLIER_LENGTH = 100;
export const JEV_MAX_CATEGORIES = 60;
/** Onder deze zekerheid geen voorstel (dan de standaardcategorie). Bij te stellen na de benchmark. */
export const JEV_MIN_CONFIDENCE = 0.5;
const TIMEOUT_MS = 8_000;

export interface JevCategory {
  key: string;
  label: string;
  hint: string;
}

export interface JevClassifyRequest {
  schemaVersion: 1;
  administrationId: string;
  appVersion: string;
  supplier: string | null;
  lines: string[];
  categories: JevCategory[];
}

export interface JevProposal {
  categoryKey: string;
  confidence: number;
  probabilities: Record<string, number>;
  model: string;
}

/** Haalt uit een artikelregel wat niet naar buiten mag: bedragen, IBAN, e-mail, lange nummers. */
export function scrubLine(line: string): string {
  return line
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, ' ')
    .replace(/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/gi, ' ')
    // Een regel die expliciet een btw-/VAT-nummer noemt heeft geen categorisatiewaarde en gaat geheel weg;
    // zo hoeven we niet ieder landspecifiek nummerformaat te raden.
    .replace(/^.*\b(?:btw(?:-?(?:id|nr|nummer))?|vat(?:-?(?:id|no|number))?)\b.*$/gi, ' ')
    .replace(/\bNL\s*\d{9}\s*B\s*\d{2}\b/gi, ' ')
    .replace(/(€|eur\b|euro\b)\s*-?\d[\d.,]*/gi, ' ')
    .replace(/-?\d[\d.,]*\s*(€|eur\b|euro\b)/gi, ' ')
    .replace(/-?\d+[.,]\d{2}\b/g, ' ')
    .replace(/\d{5,}/g, ' ')
    .replace(/[€]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Het verzoek met alleen de afgesproken velden, begrensd. Puur, zodat de tests het kunnen nagaan. */
export function minimizeJevRequest(input: { administrationId: string; appVersion: string; supplier: string | null; lines: string[]; categories: JevCategory[] }): JevClassifyRequest {
  const supplier = input.supplier ? scrubLine(input.supplier).slice(0, JEV_MAX_SUPPLIER_LENGTH) : '';
  return {
    schemaVersion: JEV_SCHEMA_VERSION,
    administrationId: input.administrationId,
    appVersion: String(input.appVersion).slice(0, 32),
    supplier: supplier || null,
    lines: input.lines.map(scrubLine).filter((l) => l.length > 1).slice(0, JEV_MAX_LINES).map((l) => l.slice(0, JEV_MAX_LINE_LENGTH)),
    categories: input.categories.slice(0, JEV_MAX_CATEGORIES).map((c) => ({ key: c.key.slice(0, 40), label: c.label.slice(0, 80), hint: (c.hint ?? '').slice(0, 200) })),
  };
}

const isProb = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;

/** Strikte controle van het antwoord van de Worker; alles wat niet klopt = geen voorstel. */
export function parseJevResponse(body: unknown, categories: JevCategory[]): JevProposal | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (b.schemaVersion !== JEV_SCHEMA_VERSION) return null;
  if (typeof b.categoryKey !== 'string' || typeof b.model !== 'string' || !b.model) return null;
  const keys = new Set(categories.map((c) => c.key));
  if (!keys.has(b.categoryKey)) return null;
  if (!isProb(b.confidence)) return null;
  const raw = b.probabilities;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const probabilities: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!keys.has(k) || !isProb(v)) return null;
    probabilities[k] = v;
  }
  return { categoryKey: b.categoryKey, confidence: b.confidence, probabilities, model: b.model.slice(0, 60) };
}

export class JevClassifier implements LlmClassifier {
  readonly id = 'jev' as const;

  constructor(
    private readonly deps: {
      fetch: FetchLike;
      /** mag er nu iets verstuurd worden? (opt-in én actief abonnement); nee = geen netwerkverzoek */
      allowed: () => boolean;
      /** administratie-ID en lokale beheersleutel, alleen opgevraagd als er echt verstuurd wordt */
      credentials: () => { administrationId: string; managementKey: string };
      appVersion: string;
      baseUrl?: string;
      timeoutMs?: number;
    },
  ) {}

  async classify(input: { supplier: string | null; lines: string[]; categories: JevCategory[] }) {
    if (!this.deps.allowed()) return null;
    const { administrationId, managementKey } = this.deps.credentials();
    const request = minimizeJevRequest({ administrationId, appVersion: this.deps.appVersion, ...input });
    if (request.categories.length === 0) return null;
    const timeoutMs = this.deps.timeoutMs ?? TIMEOUT_MS;
    let res: Awaited<ReturnType<FetchLike>>;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      res = await Promise.race([
        this.deps.fetch(`${(this.deps.baseUrl ?? ASSISTANT_API_URL).replace(/\/$/, '')}/v1/classificeren`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${managementKey}` },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(timeoutMs),
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('time-out')), timeoutMs);
        }),
      ]);
    } catch {
      return null; // offline of time-out
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return null;
    }
    const proposal = parseJevResponse(body, request.categories);
    if (!proposal || proposal.confidence < JEV_MIN_CONFIDENCE) return null;
    return { categoryKey: proposal.categoryKey, confidence: proposal.confidence, explanation: '', model: proposal.model };
  }
}
