/** Vreemde valuta (#74): welke munt staat op een document, en hoe heet die voor mensen. */

export const CURRENCY_NAMES: Record<string, { name: string; symbol: string }> = {
  EUR: { name: 'euro', symbol: '€' },
  USD: { name: 'dollars', symbol: '$' },
  GBP: { name: 'pond', symbol: '£' },
  CHF: { name: 'Zwitserse frank', symbol: 'CHF' },
  CAD: { name: 'Canadese dollars', symbol: 'CA$' },
  AUD: { name: 'Australische dollars', symbol: 'A$' },
  SEK: { name: 'Zweedse kronen', symbol: 'SEK' },
  NOK: { name: 'Noorse kronen', symbol: 'NOK' },
  DKK: { name: 'Deense kronen', symbol: 'DKK' },
  PLN: { name: 'zloty', symbol: 'PLN' },
  JPY: { name: 'yen', symbol: '¥' },
};

/**
 * Welke munt staat er op dit document? Gekeken wordt naar symbolen en codes; wat het vaakst
 * voorkomt wint, en bij twijfel is het euro. Een Nederlandse bon noemt vaak nergens "EUR".
 */
export function detectCurrency(text: string): { code: string; confidence: number } {
  const count = (re: RegExp) => (text.match(re) ?? []).length;
  const eur = count(/€|\bEUR\b|\beuro\b/gi);
  const cad = count(/\bCA\$|\bCAD\b/g);
  const aud = count(/\bA\$|\bAUD\b/g);
  const scores: Record<string, number> = {
    EUR: eur,
    // CA$ en A$ tellen ook als "$": niet dubbel als dollars
    USD: Math.max(0, count(/\bUS\$|\bUSD\b|(?<![A-Z])\$(?=\s?\d)/g) - cad - aud),
    GBP: count(/£|\bGBP\b/g),
    CHF: count(/\bCHF\b/g),
    CAD: cad,
    AUD: aud,
    SEK: count(/\bSEK\b/g),
    NOK: count(/\bNOK\b/g),
    DKK: count(/\bDKK\b/g),
    PLN: count(/\bPLN\b|\bzł/g),
    JPY: count(/¥|\bJPY\b/g),
  };
  const [best, n] = Object.entries(scores).sort((a, b) => b[1] - a[1])[0]!;
  if (n === 0 || best === 'EUR' || eur >= n) return { code: 'EUR', confidence: eur > 0 ? 0.95 : 0.6 };
  return { code: best, confidence: n >= 2 ? 0.95 : 0.8 };
}

/** "$ 90,00" of "£ 12,50" voor mensen. */
export function formatForeign(cents: number, currency: string): string {
  const sym = CURRENCY_NAMES[currency]?.symbol ?? currency;
  const n = (cents / 100).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sym} ${n}`;
}

/**
 * Past een bankafschrijving in euro's bij een bedrag dat met een koers is omgerekend? Banken en
 * kaartmaatschappijen rekenen een eigen koers plus een opslag: tot 5% (minstens 50 cent) verschil.
 */
export function withinFx(bankEuro: number, estimateEuro: number): boolean {
  return Math.abs(bankEuro - estimateEuro) <= Math.max(50, Math.round(Math.abs(estimateEuro) * 0.05));
}
