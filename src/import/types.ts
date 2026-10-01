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
  /** alleen bij een saldo dat niet in euro's is (CAMT, MT940): dat bewaren we niet, de saldocontrole rekent in euro's */
  currency?: string;
}

export interface ParseResult {
  source: BankSource;
  transactions: NormalizedTransaction[];
  warnings: string[];
  /** eindsaldi uit het bestand (CAMT/MT940); CSV heeft ze meestal niet */
  balances?: StatementBalance[];
  /** naam van de bank als het bestand geen eigen IBAN heeft (bv. Revolut): dan de rekening met die naam */
  bank?: string;
  /**
   * De indeling binnen de bron (CSV: kolommen en toewijzing). Bron en indeling samen zijn het soort
   * afschrift: binnen één soort heeft dezelfde betaling altijd dezelfde hash.
   */
  layout?: string;
}
