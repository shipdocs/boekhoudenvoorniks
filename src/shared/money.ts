/**
 * Alle bedragen worden intern opgeslagen als gehele centen (integer).
 * Nooit rekenen met floats voor geld.
 */
export type Cents = number;

export function assertCents(value: number, label = 'bedrag'): asserts value is Cents {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} moet een geheel aantal centen zijn, kreeg: ${value}`);
  }
}

/** Rondt half-van-nul af (commercieel afronden), zoals gebruikelijk op facturen. */
export function roundHalfAwayFromZero(value: number): number {
  const sign = value < 0 ? -1 : 1;
  // kleine epsilon vangt float-artefacten als 1.005 * 100 = 100.49999
  return sign * Math.round(Math.abs(value) + 1e-9);
}

/** Converteert een euro-bedrag (number of string, NL of EN notatie) naar centen. */
export function parseEuro(input: string | number): Cents {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new Error(`Ongeldig bedrag: ${input}`);
    return roundHalfAwayFromZero(input * 100);
  }
  let s = input.trim().replace(/[€\s]/g, '').replace(/^EUR/i, '');
  if (s === '') throw new Error('Leeg bedrag');
  let negative = false;
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  if (s.endsWith('-')) {
    negative = !negative;
    s = s.slice(0, -1);
  }
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    // de laatste scheider is het decimaalteken
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma > -1) {
    // één komma = decimaalteken (NL-notatie), meerdere komma's = duizendtalscheiders
    const commaCount = s.split(',').length - 1;
    s = commaCount > 1 ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (lastDot > -1) {
    const dotCount = s.split('.').length - 1;
    if (dotCount > 1) s = s.replace(/\./g, '');
  }
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Ongeldig bedrag: ${input}`);
  const [whole, frac = ''] = s.split('.');
  const cents = Number(whole) * 100 + Number((frac + '00').slice(0, 2)) + (Number(frac[2] ?? '0') >= 5 ? 1 : 0);
  return negative ? -cents : cents;
}

const formatter = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' });

export function formatEuro(cents: Cents): string {
  return formatter.format(cents / 100);
}

/** "1234.50" — voor exports/CSV. */
export function centsToDecimalString(cents: Cents): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function sum(values: Iterable<Cents>): Cents {
  let total = 0;
  for (const v of values) total += v;
  return total;
}
