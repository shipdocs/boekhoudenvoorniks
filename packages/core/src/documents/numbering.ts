/**
 * Documentnummers. Ondersteunde tokens:
 *   {JJJJ} jaar, {JJ} jaar 2 cijfers, {MM} maand, {N…} volgnummer met zoveel cijfers als N's.
 * Factuurnummers moeten wettelijk een doorlopende, unieke reeks vormen; de teller wordt
 * daarom pas opgehoogd bij het definitief maken (in dezelfde transactie).
 */
export function formatDocumentNumber(format: string, date: string, sequence: number): string {
  if (!/\{N+\}/.test(format)) throw new Error('Nummerformaat moet een volgnummer bevatten, bv. {NNNN}');
  return format
    .replace(/\{JJJJ\}/g, date.slice(0, 4))
    .replace(/\{JJ\}/g, date.slice(2, 4))
    .replace(/\{MM\}/g, date.slice(5, 7))
    .replace(/\{(N+)\}/g, (_m, ns: string) => String(sequence).padStart(ns.length, '0'));
}

/** Teller-sleutel: per jaar als het formaat een jaartal bevat, anders doorlopend. */
export function counterKey(kind: 'factuur' | 'offerte', format: string, date: string): string {
  return /\{JJ(JJ)?\}/.test(format) ? `${kind}:${date.slice(0, 4)}` : kind;
}

const TOKENS = /\{(JJJJ|JJ|MM|N+)\}/g;

/**
 * Controleert een nummerformaat voordat het wordt opgeslagen. Geeft een foutmelding in gewone taal,
 * of null als het formaat bruikbaar is. Zonder deze controle bleek "JJ NNN" (zonder accolades) pas
 * bij het definitief maken van een factuur fout te gaan.
 */
export function checkNumberFormat(format: string): string | null {
  if (!format.trim()) return 'Vul een nummerformaat in, bv. {JJJJ}-{NNNN}';
  const sequences = format.match(/\{N+\}/g) ?? [];
  const rest = format.replace(TOKENS, '');
  if (sequences.length === 0 || /JJ|MM|NN/.test(rest)) {
    return /[JMN]{2}/.test(rest) ? 'Zet de codes tussen accolades, bv. {JJ}{NNN} in plaats van JJ NNN' : 'Het formaat moet een volgnummer bevatten, bv. {NNNN}';
  }
  if (sequences.length > 1) return 'Gebruik maar één volgnummer, bv. {NNNN}';
  if (/[{}]/.test(rest)) return 'Onbekende code tussen accolades. Je kunt {JJJJ}, {JJ}, {MM} en {NNNN} gebruiken';
  return null;
}

/**
 * Leest een bestaand nummer terug volgens het formaat: het volgnummer en (als het formaat een jaartal
 * heeft) het jaar. Null als het nummer niet bij het formaat past.
 */
export function parseDocumentNumber(format: string, number: string): { year: number | null; sequence: number } | null {
  if (checkNumberFormat(format)) return null;
  const parts: string[] = [];
  const kinds: string[] = [];
  let last = 0;
  for (const m of format.matchAll(TOKENS)) {
    parts.push(escapeRegExp(format.slice(last, m.index)));
    const token = m[1]!;
    parts.push(token === 'JJJJ' ? '(\\d{4})' : token === 'JJ' || token === 'MM' ? '(\\d{2})' : '(\\d+)');
    kinds.push(token.startsWith('N') ? 'N' : token);
    last = m.index! + m[0].length;
  }
  parts.push(escapeRegExp(format.slice(last)));
  const match = new RegExp(`^${parts.join('')}$`).exec(number.trim());
  if (!match) return null;
  let year: number | null = null;
  let sequence = 0;
  kinds.forEach((kind, i) => {
    const value = Number(match[i + 1]);
    if (kind === 'JJJJ') year = value;
    else if (kind === 'JJ') year = 2000 + value;
    else if (kind === 'N') sequence = value;
  });
  return { year, sequence };
}

/**
 * Raadt het formaat bij een nummer uit een vorig pakket, bv. "26100" → {JJ}{NNN} en "2026-037" → {JJJJ}-{NNN}.
 * Null als er geen volgnummer in te herkennen is.
 */
export function guessNumberFormat(number: string, year: number): string | null {
  const n = number.trim();
  // het nummer kan van dit of vorig jaar zijn ("laatste factuur" in januari)
  const years = [year, year - 1];
  let prefix = '';
  let rest = n;
  const full = years.map((y) => ({ y, at: n.indexOf(String(y)) })).find((f) => f.at >= 0);
  if (full) {
    prefix = `${n.slice(0, full.at)}{JJJJ}`;
    rest = n.slice(full.at + 4);
  } else {
    const m = /^(\D*)(\d{2})(\D*)(\d+)(\D*)$/.exec(n);
    if (m && years.some((y) => String(y).slice(2) === m[2])) {
      prefix = `${m[1]}{JJ}${m[3]}`;
      rest = `${m[4]}${m[5]}`;
    }
  }
  const tail = /^(\D*)(\d+)(\D*)$/.exec(rest);
  if (!tail) return null;
  const format = `${prefix}${tail[1]}{${'N'.repeat(tail[2]!.length)}}${tail[3]}`;
  return checkNumberFormat(format) ? null : format;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
