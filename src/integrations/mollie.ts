import { parseEuro } from '../shared/money';
import { getJson } from './http';
import type { ExternalPayout, FetchLike, IntegrationDefinition } from './types';

export const MOLLIE: IntegrationDefinition = {
  id: 'mollie',
  label: 'Mollie',
  kind: 'betaalprovider',
  description: 'Boekt uitbetalingen (settlements) inclusief transactiekosten, zodat de bankbijschrijving vanzelf klopt.',
  fields: [{ key: 'apiKey', label: 'Organisatie-access-token', type: 'secret', help: 'Mollie dashboard → Ontwikkelaars → Organisatie-access-tokens (settlements.read)' }],
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
