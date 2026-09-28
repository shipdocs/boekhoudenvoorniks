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

/** Eindsaldo van een afschrift: het saldo aan het eind van `date`. */
export interface StatementBalance {
  ownIban: string | null;
  date: IsoDate;
  amount: Cents;
}

export interface ParseResult {
  source: BankSource;
  transactions: NormalizedTransaction[];
  warnings: string[];
  /** eindsaldi uit het bestand (CAMT/MT940); CSV heeft ze meestal niet */
  balances?: StatementBalance[];
  /** naam van de bank als het bestand geen eigen IBAN heeft (bv. Revolut): dan de rekening met die naam */
  bank?: string;
}
