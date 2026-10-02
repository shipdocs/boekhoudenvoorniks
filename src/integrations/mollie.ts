import { parseEuro, roundHalfAwayFromZero, type Cents } from '../shared/money';
import { getJson } from './http';
import { lineAmount, linesFromInclusive, linesTotal, linesTotalWithVat } from './prices';
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
  /** KvK-nummer (alleen bij een bedrijf) */
  organizationNumber?: string | null;
  vatNumber?: string | null;
  email: string | null;
  streetAndNumber: string | null;
  streetAdditional?: string | null;
  postalCode: string | null;
  city: string | null;
  country: string | null;
}
/** Korting: een vast bedrag ('amount', in de munt van de factuur) of een percentage ('percentage'). */
interface MollieDiscount {
  type: string;
  value: string;
}
interface MollieSalesInvoiceLine {
  description: string;
  quantity: number;
  vatRate: string;
  unitPrice: MollieAmount;
  discount?: MollieDiscount | null;
}
interface MollieSalesInvoice {
  id: string;
  status: string;
  invoiceNumber: string | null;
  currency: string;
  /**
   * 'exclusive' (de standaard bij Mollie): de btw komt boven op de prijs per regel. 'inclusive': de prijs per
   * regel is al inclusief btw.
   */
  vatMode?: string | null;
  recipient: MollieSalesInvoiceRecipient;
  lines: MollieSalesInvoiceLine[];
  /** korting op de hele factuur, boven op de kortingen per regel */
  discount?: MollieDiscount | null;
  /** het totaal inclusief btw, zoals Mollie het uitrekende (na kortingen) */
  totalAmount?: MollieAmount | null;
  issuedAt: string | null;
  paidAt: string | null;
  createdAt: string;
}

/**
 * `vatMode` zegt of de prijs per regel inclusief of exclusief btw is (#228). Inclusief: terugrekenen naar
 * exclusief btw, zodat het totaal blijft wat de klant betaalde. Een waarde die de app niet kent: niet raden;
 * de regels gaan mee zoals Mollie ze gaf en de gebruiker krijgt de vraag (`pricesUnknown`). Dat geldt ook als
 * Mollie niets opgeeft (dan geldt de standaard, exclusief) terwijl het totaal alleen bij prijzen inclusief btw
 * past. Een korting (per regel of op de hele factuur) wordt een eigen regel met een negatief bedrag, tegen
 * hetzelfde btw-tarief. Het totaal van Mollie gaat mee ter controle: komt de app daar met de regels en de
 * kortingen niet op uit, dan boekt hij niets. Wat hij niet kan lezen (een btw-tarief, een onbekend soort
 * korting, een korting zonder totaal om hem mee te controleren) maakt de order `unreadable`: niet raden.
 */
export function mapMollieSalesInvoice(inv: MollieSalesInvoice): ExternalOrder {
  const r = inv.recipient;
  let unreadable: string | undefined;
  let discounted = false;
  const lines: ExternalOrder['lines'] = [];
  for (const l of inv.lines) {
    const rate = Math.round(parseFloat(l.vatRate));
    const readable = Number.isFinite(rate) && rate >= 0;
    if (!readable) unreadable ??= 'het btw-tarief van een regel is niet te lezen';
    const line = { description: l.description, quantity: l.quantity, unitPriceExVat: parseEuro(l.unitPrice.value), vatPercentage: readable ? rate : 0 };
    lines.push(line);
    const off = discountAmount(l.discount, lineAmount(line));
    if (off === null) unreadable ??= 'een korting op de factuur is niet te lezen';
    else if (off !== 0) {
      discounted = true;
      lines.push({ description: `Korting op ${l.description}`, quantity: 1, unitPriceExVat: -off, vatPercentage: line.vatPercentage });
    }
  }
  // korting op de hele factuur: per btw-tarief, naar verhouding van wat er na de kortingen per regel staat
  const perRate = new Map<number, Cents>();
  for (const l of lines) perRate.set(l.vatPercentage, (perRate.get(l.vatPercentage) ?? 0) + lineAmount(l));
  const whole = discountAmount(inv.discount, linesTotal(lines));
  if (whole === null) unreadable ??= 'een korting op de factuur is niet te lezen';
  else if (whole !== 0 && linesTotal(lines) === 0) unreadable ??= 'een korting op de factuur is niet te lezen';
  else if (whole !== 0) {
    discounted = true;
    const base = linesTotal(lines);
    let left = whole;
    [...perRate].forEach(([rate, amount], i, all) => {
      const share = i === all.length - 1 ? left : roundHalfAwayFromZero((whole * amount) / base);
      left -= share;
      if (share !== 0) lines.push({ description: 'Korting', quantity: 1, unitPriceExVat: -share, vatPercentage: rate });
    });
  }
  const stated = inv.totalAmount ? parseEuro(inv.totalAmount.value) : undefined;
  if (discounted && stated === undefined) unreadable ??= 'er staat een korting op de factuur, maar Mollie gaf geen totaal door om die mee te controleren';
  const contradicted = !inv.vatMode && stated !== undefined && stated === linesTotal(lines) && Math.abs(linesTotalWithVat(lines) - stated) > lines.length;
  const mode = contradicted ? 'niet opgegeven' : inv.vatMode || 'exclusive';
  const total = stated ?? (mode === 'inclusive' ? linesTotal(lines) : undefined);
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
      kvkNumber: r.type === 'business' ? (r.organizationNumber ?? null) : null,
    },
    lines: mode === 'inclusive' && !unreadable ? linesFromInclusive(lines) : lines,
    paid: inv.status === 'paid',
    currency: inv.currency,
    ...(total !== undefined ? { total } : {}),
    ...(mode === 'inclusive' || mode === 'exclusive' ? {} : { pricesUnknown: String(mode) }),
    ...(unreadable ? { unreadable } : {}),
  };
}

/** De korting in centen op een bedrag; 0 zonder korting, null als de app de opgave niet kan lezen. */
function discountAmount(d: MollieDiscount | null | undefined, base: Cents): Cents | null {
  if (!d) return 0;
  const value = parseFloat(d.value);
  if (!Number.isFinite(value) || value < 0) return null;
  if (d.type === 'percentage') return value <= 100 ? roundHalfAwayFromZero((base * value) / 100) : null;
  if (d.type === 'amount') return roundHalfAwayFromZero(value * 100);
  return null;
}

/**
 * Mollie sorteert nieuwste eerst (zoals bij settlements): stopt zodra een al bekende factuur
 * langskomt. De lijst kent geen datum- of statusfilter, dus overige statussen worden hier al geknipt.
 * `wanted`: facturen die in de app zijn teruggedraaid en opnieuw bekeken moeten worden (#228); die staan
 * verder terug, dus de app leest door tot hij ze heeft gehad.
 */
export async function fetchMollieSalesInvoices(fetchImpl: FetchLike, cfg: { apiKey: string }, knownIds: Set<string>, wanted: Set<string> = new Set()): Promise<ExternalOrder[]> {
  const out: ExternalOrder[] = [];
  const pending = new Set(wanted);
  let url: string | null = 'https://api.mollie.com/v2/sales-invoices?limit=50';
  for (let i = 0; url && i < 20; i++) {
    const page: { _embedded: { invoices: MollieSalesInvoice[] }; _links: { next: { href: string } | null } } = await getJson(fetchImpl, url, { Authorization: `Bearer ${cfg.apiKey}` });
    let reachedKnown = false;
    for (const inv of page._embedded.invoices) {
      if (knownIds.has(inv.id)) {
        reachedKnown = true;
        continue;
      }
      pending.delete(inv.id);
      if (inv.status === 'paid') out.push(mapMollieSalesInvoice(inv));
    }
    url = reachedKnown && pending.size === 0 ? null : page._links.next?.href ?? null;
  }
  return out;
}
