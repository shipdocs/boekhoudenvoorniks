import type { CategoryLookup } from '../shared/categories';
import type { PurchaseVatCode } from '../shared/vat';
import type { DocumentResult } from './types';
import { DEVICE_KEYWORDS, findKnownSupplier, TOOL_KEYWORDS } from './suppliers';
import { INVESTMENT_THRESHOLD, netAmount } from '../shared/investment';
import type { SupplierMemory } from './supplier-memory';

/**
 * CLASSIFICATIE: wat is dit waarschijnlijk? Levert een VOORSTEL; de boeking zelf wordt
 * later door deterministische regels gemaakt. Volgorde: geheugen → vaste regels → (optioneel) lokale LLM.
 */
export interface Classification {
  categoryKey: string;
  vatCode: PurchaseVatCode;
  business: boolean;
  /** 0..1 */
  confidence: number;
  source: 'geheugen' | 'regel' | 'llm' | 'standaard';
  /** wie het voorstel deed (voor audit en evaluatie); bij `llm` welke: lokale Ollama of online JEV */
  proposedBy?: ProposedBy;
  /** modelversie van het LLM-voorstel, zoals de dienst hem teruggaf */
  model?: string;
  reasons: string[];
  /** true = gebruiker heeft dit al vaak genoeg bevestigd */
  automatic: boolean;
  /** de uiteindelijke keuze van de gebruiker (na bevestigen), los van het voorstel */
  accepted?: { categoryKey: string; vatCode: string; business: boolean; corrected: boolean };
}

export type ProposedBy = 'geheugen' | 'regel' | 'ollama' | 'jev' | 'standaard';

/** Vaste uitleg per voorsteller: geen vrije modeltekst als boekhoudreden (#132). */
export const PROPOSED_BY_LABEL: Record<ProposedBy, string> = {
  geheugen: 'eerder door jou bevestigd',
  regel: 'vaste regel',
  ollama: 'lokale AI',
  jev: 'online hulp',
  standaard: 'standaard',
};

/**
 * Optionele LLM: lokaal (Ollama) of online (JEV, alleen met abonnement en opt-in). Mag alleen een
 * categorie voorstellen; `explanation` wordt alleen getoond bij de lokale AI.
 */
export interface LlmClassifier {
  readonly id: 'ollama' | 'jev';
  classify(input: { supplier: string | null; lines: string[]; categories: { key: string; label: string; hint: string }[] }): Promise<{ categoryKey: string; confidence: number; explanation: string; model?: string } | null>;
}

const EU_VAT_PREFIXES = new Set(['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'EL', 'ES', 'FI', 'FR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK', 'XI']);
/** EU-landen in een IBAN (Griekenland = GR). */
const EU_IBAN_PREFIXES = new Set([...EU_VAT_PREFIXES].filter((c) => c !== 'EL' && c !== 'XI').concat('GR'));

/**
 * Verlegde btw: waar zit de leverancier? Afgeleid uit het btw-nummer (landcode). NL of onbekend = 2a;
 * een ander EU-land = 4b; een btw-nummer van buiten de EU (bv. GB, CHE, NO) = 4a (#16).
 */
export function reverseChargeOrigin(supplierVatNumber: string | null, supplierIban: string | null = null, supplierCountry: string | null = null): 'verlegd' | 'eu' | 'buiten-eu' {
  const prefix = supplierVatNumber?.replace(/[\s.-]/g, '').toUpperCase().match(/^([A-Z]{2,3})/)?.[1];
  // een NL-nummer bij een leverancier uit het buitenland is dat van de klant (jij): het land telt
  if (supplierCountry && (!prefix || (prefix === 'NL' && supplierCountry !== 'NL'))) {
    // geen btw-nummer, wel een land in het adres (bv. "United States" op een factuur van Stripe)
    if (supplierCountry === 'NL') return 'verlegd';
    return EU_IBAN_PREFIXES.has(supplierCountry) ? 'eu' : 'buiten-eu';
  }
  if (!prefix) {
    // geen btw-nummer gevonden: dan het land van het rekeningnummer als aanwijzing
    const iban = supplierIban?.replace(/\s/g, '').toUpperCase().slice(0, 2);
    if (!iban || iban === 'NL') return 'verlegd';
    return EU_IBAN_PREFIXES.has(iban) ? 'eu' : 'buiten-eu';
  }
  if (prefix === 'NL') return 'verlegd';
  if (EU_VAT_PREFIXES.has(prefix.slice(0, 2))) return 'eu';
  return 'buiten-eu';
}

export function vatFromDocument(doc: DocumentResult): Classification['vatCode'] | null {
  const country = doc.supplierCountry?.value ?? null;
  if (doc.reverseCharge) return reverseChargeOrigin(doc.supplierVatNumber?.value ?? null, doc.supplierIban?.value ?? null, country);
  const rates = doc.vat.value.filter((v) => v.amount !== 0).map((v) => v.rate);
  // Geen btw op een buitenlandse factuur bewijst geen verlegging (bv. vrijgestelde financiële dienst).
  if (rates.length === 0 && country && country !== 'NL') return null;
  if (rates.length === 0) return doc.vat.value.length > 0 ? 'nul' : null;
  if (rates.every((r) => r === 21)) return 'hoog';
  if (rates.every((r) => r === 9)) return 'laag';
  return null; // gemengd: per regel of door gebruiker
}

export class Classifier {
  constructor(private readonly memory: SupplierMemory, private readonly categories: CategoryLookup, private llm: LlmClassifier | null = null) {}

  /** Totaal excl. btw: het subtotaal van de bon, of teruggerekend uit het totaal. De grens van € 450 is excl. btw. */
  private netTotal(doc: DocumentResult, docVat: Classification['vatCode'] | null): number {
    if (doc.subtotal?.value) return doc.subtotal.value;
    return netAmount(doc.total?.value ?? 0, docVat ?? 'hoog');
  }

  setLlm(llm: LlmClassifier | null): void {
    this.llm = llm;
  }

  async classify(doc: DocumentResult, context: { supplierName?: string | null } = {}): Promise<Classification> {
    const supplier = doc.supplier?.value ?? context.supplierName ?? null;
    const docVat = vatFromDocument(doc);
    const reasons: string[] = [];
    const supplierCountry = doc.supplierCountry?.value?.toUpperCase();
    const vatCountry = doc.supplierVatNumber?.value?.replace(/\s/g, '').toUpperCase().match(/^([A-Z]{2})/)?.[1];
    const foreign = supplierCountry ? supplierCountry !== 'NL' : !!vatCountry && vatCountry !== 'NL';
    const propertyService = /\b(stuc|schilder|bouwwerk|bouwkund|verbouw|onroerend|pand|gebouw|construction|painting|property)\w*/i.test(doc.lineDescriptions.join(' '));
    const needsVatReview = (foreign && (docVat === null || propertyService || (doc.vat.value.some((v) => v.amount !== 0)))) || (doc.reverseCharge && !doc.supplierCountry?.value && !doc.supplierVatNumber?.value);
    // Zonder btw op een buitenlandse factuur is Nederlandse voorbelasting (21%) geen redelijk voorstel: laat de btw leeg tot de gebruiker kiest.
    const fallbackVat: NonNullable<Classification['vatCode']> = needsVatReview && docVat === null ? 'geen' : 'hoog';
    if (needsVatReview) reasons.push('Controleer de btw op de factuur en waar de prestatie belast is. Buitenlandse btw is geen Nederlandse voorbelasting; werk aan een Nederlands pand kan onder binnenlandse verlegging vallen.');

    const rule = this.memory.get(supplier);
    if (rule) {
      const automatic = this.memory.isAutomatic(rule) && !needsVatReview;
      return {
        categoryKey: rule.category_key,
        vatCode: (docVat ?? rule.vat_code) as Classification['vatCode'],
        business: Boolean(rule.business),
        confidence: automatic ? 0.97 : 0.8,
        source: 'geheugen',
        proposedBy: 'geheugen',
        reasons: [...reasons, `${rule.display_name}: eerder ${rule.confirmations}× zo bevestigd`],
        automatic,
      };
    }

    const known = findKnownSupplier(supplier);
    if (known) {
      let category = known.category;
      if (category === 'materiaal' && doc.lineDescriptions.some((l) => TOOL_KEYWORDS.test(l)) && !doc.lineDescriptions.every((l) => !TOOL_KEYWORDS.test(l))) {
        category = this.netTotal(doc, docVat ?? fallbackVat) >= INVESTMENT_THRESHOLD ? 'investering' : 'gereedschap';
        reasons.push('artikel lijkt gereedschap');
      }
      reasons.push(known.source === 'index' ? `${known.name} is een bekende winkelketen (lijst van OpenStreetMap)` : `${known.name} is een bekende leverancier`);
      // horeca: de btw op eten en drinken is niet aftrekbaar, ook als hij op de bon staat
      const vatCode = known.source === 'index' && known.vatCode === 'geen' ? 'geen' : docVat ?? known.vatCode;
      return { categoryKey: category, vatCode, business: true, confidence: known.source === 'index' ? 0.65 : 0.75, source: 'regel', proposedBy: 'regel', reasons, automatic: false };
    }

    if (doc.lineDescriptions.some((l) => DEVICE_KEYWORDS.test(l))) {
      const invest = this.netTotal(doc, docVat ?? fallbackVat) >= INVESTMENT_THRESHOLD;
      return { categoryKey: invest ? 'investering' : 'kantoor', vatCode: docVat ?? fallbackVat, business: true, confidence: 0.6, source: 'regel', proposedBy: 'regel', reasons: [...reasons, invest ? 'apparaat van € 450 of meer (excl. btw): gaat jaren mee' : 'apparaat'], automatic: false };
    }

    if (doc.lineDescriptions.some((l) => TOOL_KEYWORDS.test(l))) {
      return { categoryKey: this.netTotal(doc, docVat ?? fallbackVat) >= INVESTMENT_THRESHOLD ? 'investering' : 'gereedschap', vatCode: docVat ?? fallbackVat, business: true, confidence: 0.6, source: 'regel', proposedBy: 'regel', reasons: [...reasons, 'artikel lijkt gereedschap'], automatic: false };
    }

    if (this.llm) {
      try {
        const r = await this.llm.classify({ supplier, lines: doc.lineDescriptions, categories: this.categories.list().map(({ key, label, hint }) => ({ key, label, hint })) });
        if (r && this.categories.list().some((c) => c.key === r.categoryKey)) {
          // LLM-zekerheid wordt bewust afgetopt: nooit automatisch boeken op alleen een LLM-voorstel
          const reason = this.llm.id === 'jev' ? 'online hulp koos deze uit jouw categorieën' : `voorstel van de slimme herkenning: ${r.explanation}`;
          return { categoryKey: r.categoryKey, vatCode: docVat ?? fallbackVat, business: true, confidence: Math.min(0.7, r.confidence), source: 'llm', proposedBy: this.llm.id, ...(r.model ? { model: r.model } : {}), reasons: [...reasons, reason], automatic: false };
        }
      } catch {
        // LLM is optioneel; val terug op standaard
      }
    }
    return { categoryKey: 'overig', vatCode: docVat ?? fallbackVat, business: true, confidence: 0.3, source: 'standaard', proposedBy: 'standaard', reasons: [...reasons, 'onbekende leverancier'], automatic: false };
  }
}
