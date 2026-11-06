import type { Cents } from '../shared/money';

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export interface SecretStore {
  /** staat de veilige opslag op dit systeem aan? (bv. false zonder sleutelbeheer of bij MCP) */
  readonly available: boolean;
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
}

export interface ConfigField {
  key: string;
  label: string;
  type: 'text' | 'url' | 'secret' | 'select';
  options?: { value: string; label: string }[];
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
  /** de factuurdatum; bij een webshoporder de dag van de verkoop */
  date: string;
  /** wanneer er betaald is, als dat een andere dag is dan `date` (bv. een Mollie-factuur die later betaald werd) */
  paidDate?: string;
  /** de vervaldatum, als de bron die opgeeft */
  dueDate?: string;
  /**
   * De order is al een verstuurde factuur buiten de app (Mollie Facturen): een document met eigen nummer en datum.
   * De app neemt hem over zoals hij is, ook als hij nog niet betaald is, en geeft hem geen nummer uit de eigen
   * reeks. Bij een webshoporder maakt de app zelf de factuur, en alleen van een betaalde order.
   */
  document?: boolean;
  /**
   * Bij een betaalde `document`-factuur: hoe er betaald is. 'betaaldienst' = het geld kwam binnen bij de betaaldienst
   * (die het later uitbetaalt), 'elders' = de factuur is daar alleen op betaald gezet (bv. na een overboeking op je
   * bank). Onbekend: de app gaat ervan uit dat het geld nog op de bank moet binnenkomen.
   */
  paidVia?: 'betaaldienst' | 'elders';
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
  /**
   * Klant buiten de EU, zonder btw op de order: welke btw-soort de regels krijgen, zoals de gebruiker koos (een dienst
   * of goederen). Zonder deze keuze boekt de app niets: de bron zegt niet wat er verkocht is.
   */
  vatCode?: 'dienst-buiten-eu' | 'export';
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
  /** Onbekende fiscale behandeling: niet boeken alsof btw afwezig of verlegd is. */
  feesTaxUnconfirmed?: boolean;
  currency: string;
  reference: string;
}
