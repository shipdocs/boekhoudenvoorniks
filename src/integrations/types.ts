import type { Cents } from '../shared/money';

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export interface SecretStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
}

export interface ConfigField {
  key: string;
  label: string;
  type: 'text' | 'url' | 'secret';
  placeholder?: string;
  help?: string;
}

export interface SyncResult {
  created: number;
  skipped: number;
  messages: string[];
}

export interface IntegrationDefinition {
  id: 'woocommerce' | 'shopify' | 'mollie' | 'stripe';
  label: string;
  kind: 'webshop' | 'betaalprovider';
  description: string;
  fields: ConfigField[];
}

/** Een webshop-order, genormaliseerd. Bedragen in centen, exclusief BTW per regel. */
export interface ExternalOrder {
  externalId: string;
  number: string;
  date: string;
  customer: { name: string; email: string | null; address: string | null; postcode: string | null; city: string | null; country: string | null; vatNumber: string | null };
  lines: { description: string; quantity: number; unitPriceExVat: Cents; vatPercentage: number }[];
  paid: boolean;
  currency: string;
}

/** Een uitbetaling van een betaalprovider naar de bank. */
export interface ExternalPayout {
  externalId: string;
  date: string;
  /** uitbetaald bedrag (netto) */
  amount: Cents;
  /** som van de ontvangen betalingen (bruto) */
  gross: Cents;
  /** transactiekosten exclusief BTW */
  feesNet: Cents;
  /** BTW op transactiekosten (0 bij buitenlandse provider) */
  feesVat: Cents;
  currency: string;
  reference: string;
}
