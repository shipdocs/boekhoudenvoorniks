import type { NormalizedTransaction } from '../import/types';

/**
 * Open banking (PSD2 AIS) — live bankfeed. Vereist een gelicentieerde AISP-partner
 * (bv. Enable Banking, Tink, GoCardless Bank Account Data, Yapily) met eigen contract en API-sleutels.
 * De keuze voor een partner is een zakelijke beslissing (kosten, voorwaarden, DPA) — zie GitHub-issue.
 *
 * Elke provider-implementatie levert genormaliseerde transacties; die gaan door exact dezelfde
 * import- en matchingstraat als CSV/MT940/CAMT (BankService.import met source 'openbanking').
 */
export interface OpenBankingProvider {
  readonly id: string;
  readonly label: string;
  /** Start de toestemmingsflow bij de bank; retourneert de URL die de gebruiker opent. */
  startConsent(bankId: string, redirectUrl: string): Promise<{ consentId: string; authUrl: string }>;
  /** Rondt de toestemming af na de redirect. */
  completeConsent(consentId: string, callbackParams: Record<string, string>): Promise<{ accounts: { id: string; iban: string; name: string }[] }>;
  /** Haalt transacties op sinds een datum. */
  fetchTransactions(accountId: string, since: string): Promise<NormalizedTransaction[]>;
  /** Toestemming verloopt (PSD2: max. 180 dagen); datum waarop opnieuw toestemming nodig is. */
  consentExpiresAt(consentId: string): Promise<string | null>;
  listBanks(country: string): Promise<{ id: string; name: string; logo?: string }[]>;
}

export const OPEN_BANKING_PROVIDERS: OpenBankingProvider[] = [];
