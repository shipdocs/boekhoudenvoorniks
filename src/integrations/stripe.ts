import { getJson } from './http';
import type { ExternalPayout, FetchLike, IntegrationDefinition } from './types';

export const STRIPE: IntegrationDefinition = {
  id: 'stripe',
  label: 'Stripe',
  kind: 'betaalprovider',
  description: 'Boekt de uitbetalingen (payouts) van Stripe naar je bank, met de Stripe-kosten, zodat de bijschrijving op je bank vanzelf klopt. Boekt zelf geen omzet: gebruik je Stripe niet via een gekoppelde webshop, boek de omzet dan zelf bij die bijschrijving met "Verkoop via een ander systeem".',
  fields: [
    { key: 'apiKey', label: 'Restricted API key', type: 'secret', help: 'Stripe dashboard → Developers → API keys → restricted key met leesrechten op Balance en Payouts' },
    { key: 'feesTax', label: 'Welke btw geldt voor je Stripe-kosten?', type: 'select', help: 'Controleer je kostenfactuur met je boekhouder. Geen btw op de factuur betekent niet vanzelf verlegd. Bij gemengde kosten boek je de uitbetaling en de kosten apart; de app past niet één btw-keuze op alles toe.', options: [
      { value: 'onbekend', label: 'Nog uitzoeken of gemengde kosten: zelf verwerken' },
      { value: 'eu', label: 'Bevestigd: alle kosten 21% btw verlegd uit Ierland' },
      { value: 'vrijgesteld', label: 'Bevestigd: alle kosten vrijgesteld van btw' },
    ] },
  ],
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

export async function fetchStripePayouts(fetchImpl: FetchLike, cfg: { apiKey: string; feesTax?: string }, knownIds: Set<string>): Promise<ExternalPayout[]> {
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
    // De payout-API bewijst niet of de prestaties vrijgesteld of belast zijn (#44).
    out.push({
      externalId: p.id,
      date: new Date(p.arrival_date * 1000).toISOString().slice(0, 10),
      amount: p.amount,
      gross: gross || p.amount,
      feesNet: fees,
      feesVat: 0,
      ...(cfg.feesTax === 'eu' ? { feesReverseCharge: 'eu' as const } : {}),
      ...(cfg.feesTax !== 'eu' && cfg.feesTax !== 'vrijgesteld' && fees !== 0 ? { feesTaxUnconfirmed: true } : {}),
      currency: p.currency.toUpperCase(),
      reference: p.statement_descriptor ?? p.id,
    });
  }
  return out;
}
