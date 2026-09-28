/**
 * Dezelfde bank, ook als je vorige programma hem anders noemt: "Bank Knab" en "KNAB", "Rabo zakelijk" en
 * "Rabobank zakelijk". Woorden als bank, rekening en zakelijk tellen niet mee.
 */
export function sameBankName(a: string, b: string): boolean {
  const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w && !['bank', 'rekening', 'zakelijk', 'zakelijke', 'betaalrekening', 'nl', 'bv', 'b', 'v'].includes(w));
  const x = words(a);
  const y = words(b);
  if (x.length === 0 || y.length === 0) return a.trim().toLowerCase() === b.trim().toLowerCase();
  // elk woord van de kortste naam komt (als begin van een woord) in de andere voor: rabo ~ rabobank
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.every((w) => long.some((v) => v.startsWith(w) || w.startsWith(v)));
}
