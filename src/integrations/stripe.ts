import { getJson } from './http';
import type { ExternalPayout, FetchLike, IntegrationDefinition } from './types';

export const STRIPE: IntegrationDefinition = {
  id: 'stripe',
  label: 'Stripe',
  kind: 'betaalprovider',
  description: 'Boekt uitbetalingen (payouts) inclusief Stripe-kosten, zodat de bankbijschrijving vanzelf klopt.',
  fields: [{ key: 'apiKey', label: 'Restricted API key', type: 'secret', help: 'Stripe dashboard → Developers → API keys → restricted key met leesrechten op Balance en Payouts' }],
};

interface StripeBalanceTx {
  id: string;
  amount: number;
  fee: number;
  net: number;
  type: string;
}
interface StripePayout {
  id: string;
  amount: number;
  arrival_date: number;
  currency: string;
  status: string;
  statement_descriptor: string | null;
}

export async function fetchStripePayouts(fetchImpl: FetchLike, cfg: { apiKey: string }, knownIds: Set<string>): Promise<ExternalPayout[]> {
  const headers = { Authorization: `Bearer ${cfg.apiKey}` };
  const payouts = await getJson<{ data: StripePayout[] }>(fetchImpl, 'https://api.stripe.com/v1/payouts?limit=50&status=paid', headers);
  const out: ExternalPayout[] = [];
  for (const p of payouts.data) {
    if (knownIds.has(p.id)) continue;
    const txs = await getJson<{ data: StripeBalanceTx[] }>(fetchImpl, `https://api.stripe.com/v1/balance_transactions?payout=${encodeURIComponent(p.id)}&limit=100`, headers);
    let gross = 0;
    let fees = 0;
    for (const t of txs.data) {
      if (t.type === 'payout') continue;
      gross += t.amount;
      fees += t.fee;
    }
    // Stripe (Ierland) rekent zakelijke klanten geen btw: verlegd uit de EU, rubriek 4b (#16)
    out.push({
      externalId: p.id,
      date: new Date(p.arrival_date * 1000).toISOString().slice(0, 10),
      amount: p.amount,
      gross: gross || p.amount,
      feesNet: fees,
      feesVat: 0,
      feesReverseCharge: 'eu',
      currency: p.currency.toUpperCase(),
      reference: p.statement_descriptor ?? p.id,
    });
  }
  return out;
}
