/**
 * Bij de vraag "Download een nieuw afschrift" (#184): waar je het afschrift bij je bank vindt.
 *
 * De uitleg per bank (welk menu, welke knop) staat hier pas als hij bij die bank is nagelopen: een
 * verkeerde aanwijzing is erger dan geen. Tot die tijd krijgt elke bank de algemene uitleg.
 */
export type KnownBank = 'ING' | 'Rabobank' | 'ABN AMRO' | 'bunq' | 'Knab' | 'Triodos' | 'Revolut';

/** De bankcode in een Nederlands rekeningnummer (positie 5 t/m 8). */
const BANK_CODES: Record<string, KnownBank> = { INGB: 'ING', RABO: 'Rabobank', ABNA: 'ABN AMRO', BUNQ: 'bunq', KNAB: 'Knab', TRIO: 'Triodos', REVO: 'Revolut' };

export function bankOfIban(iban: string | null | undefined): KnownBank | null {
  const clean = (iban ?? '').replace(/\s+/g, '').toUpperCase();
  return /^NL\d{2}[A-Z]{4}/.test(clean) ? (BANK_CODES[clean.slice(4, 8)] ?? null) : null;
}

/** Per bank waar je het afschrift vindt. Alleen nagelopen teksten; leeg = de algemene uitleg. */
export const STATEMENT_HELP: Partial<Record<KnownBank, string>> = {};

export const GENERAL_STATEMENT_HELP = 'Kies CAMT.053 als je bank dat heeft: daar staat ook je saldo in, zodat de app kan controleren of er niets ontbreekt. Anders MT940 of CSV.';

export function statementHelp(iban: string | null | undefined): string {
  const bank = bankOfIban(iban);
  return (bank && STATEMENT_HELP[bank]) || GENERAL_STATEMENT_HELP;
}
