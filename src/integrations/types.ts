import type { Cents } from '../shared/money';

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

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
  id: 'woocommerce' | 'shopify' | 'mollie' | 'mollie-facturen' | 'stripe';
  label: string;
  kind: 'webshop' | 'betaalprovider';
  description: string;
  fields: ConfigField[];
}

/** Een webshop-order, genormaliseerd. Bedragen in centen, exclusief BTW per regel (tenzij `pricesUnknown`). */
export interface ExternalOrder {
  externalId: string;
  number: string;
  date: string;
  customer: { name: string; email: string | null; address: string | null; postcode: string | null; city: string | null; country: string | null; vatNumber: string | null; kvkNumber?: string | null };
  lines: { description: string; quantity: number; unitPriceExVat: Cents; vatPercentage: number }[];
  paid: boolean;
  currency: string;
  /**
   * Wat de klant betaalde, inclusief btw, als de bron dat zelf opgeeft. De factuur in de app moet daarop
   * uitkomen: een cent verschil door afronden boekt de app als afrondingsverschil, bij meer raadt hij niet (#228).
   */
  total?: Cents;
  /**
   * De bron zegt op een onbekende manier of de prijzen inclusief of exclusief btw zijn (hier: wat hij opgaf).
   * De regels staan er dan in zoals de bron ze gaf en de app boekt niets voordat de gebruiker het zegt (#228).
   */
  pricesUnknown?: string;
  /**
   * De app kan deze order niet betrouwbaar inlezen (hier: waarom, in gewone woorden), bv. een btw-tarief of een
   * korting die hij niet kan lezen. Dan boekt hij niets en meldt hij het op Vandaag: de gebruiker boekt de
   * verkoop zelf (#228).
   */
  unreadable?: string;
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
  /** 'eu': de provider zit in een ander EU-land en rekent geen btw; de btw is naar jou verlegd (4b, #16) */
  feesReverseCharge?: 'eu';
  currency: string;
  reference: string;
}
