import type { Cents } from '../shared/money';
import type { IsoDate } from '../shared/dates';

/** Genormaliseerde banktransactie, onafhankelijk van het bronformaat. */
export interface NormalizedTransaction {
  date: IsoDate;
  /** positief = bij (ontvangst), negatief = af (betaling) */
  amount: Cents;
  counterIban?: string | null;
  counterName?: string | null;
  description: string;
  /** betalingskenmerk / end-to-end-id */
  reference?: string | null;
  /** IBAN van de eigen rekening, als het bestand die bevat */
  ownIban?: string | null;
  /** unieke id van de bank, als beschikbaar (beter voor ontdubbelen) */
  bankId?: string | null;
}

export type BankSource = 'csv' | 'mt940' | 'camt' | 'openbanking' | 'handmatig';

export interface ParseResult {
  source: BankSource;
  transactions: NormalizedTransaction[];
  warnings: string[];
}
