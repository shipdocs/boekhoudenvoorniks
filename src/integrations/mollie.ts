import { parseEuro, roundHalfAwayFromZero } from '../shared/money';
import { getJson } from './http';
import type { ExternalOrder, ExternalPayout, FetchLike, IntegrationDefinition } from './types';

export const MOLLIE: IntegrationDefinition = {
  id: 'mollie',
  label: 'Mollie (uitbetalingen)',
  kind: 'betaalprovider',
  description: 'Boekt de uitbetalingen (settlements) van Mollie naar je bank, met de transactiekosten en de btw daarover, zodat de bijschrijving op je bank vanzelf klopt. Boekt zelf geen omzet: daarvoor heb je "Mollie Facturen" hieronder nodig, of een webshopkoppeling (WooCommerce/Shopify). Gebruik je geen van die twee, zet deze koppeling dan niet aan: je tussenrekening bij de betaalprovider loopt dan alsmaar verder in de min.',
  fields: [{ key: 'apiKey', label: 'Organisatie-access-token', type: 'secret', help: 'Mollie dashboard → Ontwikkelaars → Organisatie-access-tokens (settlements.read)' }],
};

/**
 * Mollie Facturen (mollie.com/producten/facturen, Sales Invoices API): je maakt en verstuurt de
 * factuur zelf in Mollie, niet in deze app. Hier alleen inlezen wat betaald is, als gewone factuur
 * met betaling op de tussenrekening — net als een webshoporder. De uitbetaling (hierboven) trekt dat
 * bedrag er later weer af, met de kosten erbij; dan klopt de bijschrijving op je bank vanzelf.
 */
export const MOLLIE_FACTUREN: IntegrationDefinition = {
  id: 'mollie-facturen',
  label: 'Mollie Facturen',
  kind: 'webshop',
  description: 'Leest betaalde facturen uit Mollie Facturen (mollie.com/producten/facturen) en maakt er automatisch gewone, betaalde facturen van, met klant en btw. Alleen lezen: de factuur zelf maak en verstuur je in Mollie, niet in deze app, en er gaat niets terug naar Mollie. Voeg ook "Mollie (uitbetalingen)" hierboven toe, anders klopt de bijschrijving op je bank niet vanzelf met het bedrag.',
  fields: [{ key: 'apiKey', label: 'Advanced-access-token', type: 'secret', help: 'Mollie dashboard → Ontwikkelaars → Access-tokens, met scope "sales-invoices.read"' }],
};

interface MollieAmount {
  value: string;
  currency: string;
}
interface MollieSettlement {
  id: string;
  reference: string;
  settledAt: string | null;
  status: string;
  amount: MollieAmount;
  periods?: Record<string, Record<string, { revenue?: { amountGross: MollieAmount }[]; costs?: { amountNet: MollieAmount; amountVat: MollieAmount | null; amountGross: MollieAmount }[] }>>;
}

export function mapMollieSettlement(s: MollieSettlement): ExternalPayout {
  let gross = 0;
  let feesNet = 0;
  let feesVat = 0;
  for (const year of Object.values(s.periods ?? {})) {
    for (const month of Object.values(year)) {
      for (const r of month.revenue ?? []) gross += parseEuro(r.amountGross.value);
      for (const c of month.costs ?? []) {
        feesNet += parseEuro(c.amountNet.value);
        feesVat += c.amountVat ? parseEuro(c.amountVat.value) : 0;
      }
    }
  }
  const amount = parseEuro(s.amount.value);
  // Als de periodes ontbreken: bruto = netto (kosten onbekend)
  if (gross === 0) gross = amount + feesNet + feesVat;
  return { externalId: s.id, date: (s.settledAt ?? '').slice(0, 10), amount, gross, feesNet, feesVat, currency: s.amount.currency, reference: s.reference };
}

export async function fetchMollieSettlements(fetchImpl: FetchLike, cfg: { apiKey: string }, knownIds: Set<string>): Promise<ExternalPayout[]> {
  const out: ExternalPayout[] = [];
  let url: string | null = 'https://api.mollie.com/v2/settlements?limit=50';
  for (let i = 0; url && i < 20; i++) {
    const page: { _embedded: { settlements: MollieSettlement[] }; _links: { next: { href: string } | null } } = await getJson(fetchImpl, url, { Authorization: `Bearer ${cfg.apiKey}` });
    let reachedKnown = false;
    for (const s of page._embedded.settlements) {
      if (knownIds.has(s.id)) {
        reachedKnown = true;
        continue;
      }
      if (s.status === 'paidout' && s.settledAt) out.push(mapMollieSettlement(s));
    }
    url = reachedKnown ? null : page._links.next?.href ?? null;
  }
  return out;
}

interface MollieSalesInvoiceRecipient {
  type: 'consumer' | 'business';
  givenName?: string;
  familyName?: string;
  organizationName?: string;
  vatNumber?: string | null;
  email: string | null;
  streetAndNumber: string | null;
  streetAdditional?: string | null;
  postalCode: string | null;
  city: string | null;
  country: string | null;
}
interface MollieSalesInvoiceLine {
  description: string;
  quantity: number;
  vatRate: string;
  unitPrice: MollieAmount;
}
interface MollieSalesInvoice {
  id: string;
  status: string;
  invoiceNumber: string | null;
  currency: string;
  recipient: MollieSalesInvoiceRecipient;
  lines: MollieSalesInvoiceLine[];
  /** 'exclusive' (standaard bij Mollie) of 'inclusive': of unitPrice exclusief of inclusief btw is */
  vatMode?: string;
  issuedAt: string | null;
  paidAt: string | null;
  createdAt: string;
}

export function mapMollieSalesInvoice(inv: MollieSalesInvoice): ExternalOrder {
  const mode = inv.vatMode ?? 'exclusive';
  if (mode !== 'exclusive' && mode !== 'inclusive') {
    // niet raden: een verkeerd bedrag zou in de btw-aangifte terechtkomen
    throw new Error(`Factuur ${inv.invoiceNumber ?? inv.id} heeft een onbekende btw-instelling (${mode}); controleer deze factuur in Mollie`);
  }
  const r = inv.recipient;
  const name = r.type === 'business' ? r.organizationName || r.email || 'Klant' : [r.givenName, r.familyName].filter(Boolean).join(' ') || r.email || 'Klant';
  return {
    externalId: inv.id,
    number: inv.invoiceNumber ?? inv.id,
    date: (inv.paidAt ?? inv.issuedAt ?? inv.createdAt).slice(0, 10),
    customer: {
      name,
      email: r.email,
      address: [r.streetAndNumber, r.streetAdditional].filter(Boolean).join(' ') || null,
      postcode: r.postalCode,
      city: r.city,
      country: r.country,
      vatNumber: r.type === 'business' ? (r.vatNumber ?? null) : null,
    },
    lines: inv.lines.map((l) => {
      const vatPercentage = Math.round(parseFloat(l.vatRate));
      const price = parseEuro(l.unitPrice.value);
      const unitPriceExVat = mode === 'inclusive' ? roundHalfAwayFromZero((price * 100) / (100 + vatPercentage)) : price;
      return { description: l.description, quantity: l.quantity, unitPriceExVat, vatPercentage };
    }),
    paid: inv.status === 'paid',
    currency: inv.currency,
  };
}

/**
 * Mollie sorteert nieuwste eerst (zoals bij settlements): stopt zodra een al bekende factuur
 * langskomt. De lijst kent geen datum- of statusfilter, dus overige statussen worden hier al geknipt.
 */
export async function fetchMollieSalesInvoices(fetchImpl: FetchLike, cfg: { apiKey: string }, knownIds: Set<string>): Promise<ExternalOrder[]> {
  const out: ExternalOrder[] = [];
  let url: string | null = 'https://api.mollie.com/v2/sales-invoices?limit=50';
  for (let i = 0; url && i < 20; i++) {
    const page: { _embedded: { invoices: MollieSalesInvoice[] }; _links: { next: { href: string } | null } } = await getJson(fetchImpl, url, { Authorization: `Bearer ${cfg.apiKey}` });
    let reachedKnown = false;
    for (const inv of page._embedded.invoices) {
      if (knownIds.has(inv.id)) {
        reachedKnown = true;
        continue;
      }
      if (inv.status === 'paid') out.push(mapMollieSalesInvoice(inv));
    }
    url = reachedKnown ? null : page._links.next?.href ?? null;
  }
  return out;
}
