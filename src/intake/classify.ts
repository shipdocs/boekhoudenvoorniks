import { EXPENSE_CATEGORIES } from '../shared/categories';
import type { PurchaseVatCode } from '../shared/vat';
import type { DocumentResult } from './types';
import { DEVICE_KEYWORDS, KNOWN_SUPPLIERS, TOOL_KEYWORDS } from './suppliers';
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
  reasons: string[];
  /** true = gebruiker heeft dit al vaak genoeg bevestigd */
  automatic: boolean;
}

/** Optionele lokale LLM (bv. via Ollama/llama.cpp). Mag alleen een categorie voorstellen. */
export interface LlmClassifier {
  readonly id: string;
  classify(input: { supplier: string | null; lines: string[]; categories: { key: string; label: string; hint: string }[] }): Promise<{ categoryKey: string; confidence: number; explanation: string } | null>;
}

const EU_VAT_PREFIXES = new Set(['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'EL', 'ES', 'FI', 'FR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK', 'XI']);
/** EU-landen in een IBAN (Griekenland = GR). */
const EU_IBAN_PREFIXES = new Set([...EU_VAT_PREFIXES].filter((c) => c !== 'EL' && c !== 'XI').concat('GR'));

/**
 * Verlegde btw: waar zit de leverancier? Afgeleid uit het btw-nummer (landcode). NL of onbekend = 2a;
 * een ander EU-land = 4b; een btw-nummer van buiten de EU (bv. GB, CHE, NO) = 4a (#16).
 */
export function reverseChargeOrigin(supplierVatNumber: string | null, supplierIban: string | null = null): 'verlegd' | 'eu' | 'buiten-eu' {
  const prefix = supplierVatNumber?.replace(/[\s.-]/g, '').toUpperCase().match(/^([A-Z]{2,3})/)?.[1];
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
  if (doc.reverseCharge) return reverseChargeOrigin(doc.supplierVatNumber?.value ?? null, doc.supplierIban?.value ?? null);
  const rates = doc.vat.value.filter((v) => v.amount !== 0).map((v) => v.rate);
  if (rates.length === 0) return doc.vat.value.length > 0 ? 'nul' : null;
  if (rates.every((r) => r === 21)) return 'hoog';
  if (rates.every((r) => r === 9)) return 'laag';
  return null; // gemengd: per regel of door gebruiker
}

export class Classifier {
  constructor(private readonly memory: SupplierMemory, private llm: LlmClassifier | null = null) {}

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

    const rule = this.memory.get(supplier);
    if (rule) {
      const automatic = this.memory.isAutomatic(rule);
      return {
        categoryKey: rule.category_key,
        vatCode: (docVat ?? rule.vat_code) as Classification['vatCode'],
        business: Boolean(rule.business),
        confidence: automatic ? 0.97 : 0.8,
        source: 'geheugen',
        reasons: [`${rule.display_name}: eerder ${rule.confirmations}× zo bevestigd`],
        automatic,
      };
    }

    const known = supplier ? KNOWN_SUPPLIERS.find((s) => s.pattern.test(supplier)) : undefined;
    if (known) {
      let category = known.category;
      if (category === 'materiaal' && doc.lineDescriptions.some((l) => TOOL_KEYWORDS.test(l)) && !doc.lineDescriptions.every((l) => !TOOL_KEYWORDS.test(l))) {
        category = this.netTotal(doc, docVat) >= INVESTMENT_THRESHOLD ? 'investering' : 'gereedschap';
        reasons.push('artikel lijkt gereedschap');
      }
      reasons.push(`${known.name} is een bekende leverancier`);
      return { categoryKey: category, vatCode: docVat === 'verlegd' && known.vatCode === 'eu' ? 'eu' : docVat ?? known.vatCode, business: true, confidence: 0.75, source: 'regel', reasons, automatic: false };
    }

    if (doc.lineDescriptions.some((l) => DEVICE_KEYWORDS.test(l))) {
      const invest = this.netTotal(doc, docVat) >= INVESTMENT_THRESHOLD;
      return { categoryKey: invest ? 'investering' : 'kantoor', vatCode: docVat ?? 'hoog', business: true, confidence: 0.6, source: 'regel', reasons: [invest ? 'apparaat van € 450 of meer (excl. btw): gaat jaren mee' : 'apparaat'], automatic: false };
    }

    if (doc.lineDescriptions.some((l) => TOOL_KEYWORDS.test(l))) {
      return { categoryKey: this.netTotal(doc, docVat) >= INVESTMENT_THRESHOLD ? 'investering' : 'gereedschap', vatCode: docVat ?? 'hoog', business: true, confidence: 0.6, source: 'regel', reasons: ['artikel lijkt gereedschap'], automatic: false };
    }

    if (this.llm) {
      try {
        const r = await this.llm.classify({ supplier, lines: doc.lineDescriptions, categories: EXPENSE_CATEGORIES.map(({ key, label, hint }) => ({ key, label, hint })) });
        if (r && EXPENSE_CATEGORIES.some((c) => c.key === r.categoryKey)) {
          // LLM-zekerheid wordt bewust afgetopt: nooit automatisch boeken op alleen een LLM-voorstel
          return { categoryKey: r.categoryKey, vatCode: docVat ?? 'hoog', business: true, confidence: Math.min(0.7, r.confidence), source: 'llm', reasons: [`voorstel van de slimme herkenning: ${r.explanation}`], automatic: false };
        }
      } catch {
        // LLM is optioneel; val terug op standaard
      }
    }
    return { categoryKey: 'overig', vatCode: docVat ?? 'hoog', business: true, confidence: 0.3, source: 'standaard', reasons: ['onbekende leverancier'], automatic: false };
  }
}
