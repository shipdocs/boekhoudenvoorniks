/**
 * Betaaldiensten: één lijst voor de hele app (#227). Op een factuur staat zo'n naam vaak als "paid via
 * Stripe" en is hij niet de leverancier; op de bank is geld van zo'n dienst meestal de uitbetaling van
 * verkopen, niet zelf een verkoop.
 */
export const PAYMENT_PROVIDERS = ['Mollie', 'Stripe', 'PayPal', 'Adyen', 'SumUp', 'Klarna'] as const;

export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];

/** Als los woord, ook achter of voor een leesteken of cijfer ("PAYPAL *WINKEL", "SumUp_payout"); "Stripes" telt niet. */
const PATTERN = new RegExp(`(?<![a-z])(${PAYMENT_PROVIDERS.join('|')})(?![a-z])`, 'i');

/** Is dit de naam van een betaaldienst, precies zoals in de lijst? */
export function isPaymentProvider(name: string): name is PaymentProvider {
  return (PAYMENT_PROVIDERS as readonly string[]).includes(name);
}

/** De betaaldienst die in deze tekst staat (naam van de tegenpartij, omschrijving van de bank), of null. */
export function paymentProviderIn(text: string | null | undefined): PaymentProvider | null {
  const found = text ? PATTERN.exec(text)?.[1]?.toLowerCase() : undefined;
  return found ? PAYMENT_PROVIDERS.find((p) => p.toLowerCase() === found) ?? null : null;
}
