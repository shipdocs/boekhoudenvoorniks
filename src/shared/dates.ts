/** Datums worden opgeslagen als ISO 'YYYY-MM-DD' strings (lokale kalenderdatum, geen tijdzone). */
export type IsoDate = string;

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): value is IsoDate {
  if (!ISO_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function assertIsoDate(value: string, label = 'datum'): asserts value is IsoDate {
  if (!isIsoDate(value)) throw new Error(`${label} moet een geldige datum (JJJJ-MM-DD) zijn, kreeg: ${value}`);
}

export function today(): IsoDate {
  const now = new Date();
  return toIsoDate(now);
}

export function toIsoDate(d: Date): IsoDate {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function diffDays(from: IsoDate, to: IsoDate): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

export type PeriodType = 'maand' | 'kwartaal' | 'jaar';

export interface Period {
  type: PeriodType;
  /** bijv. '2026-Q3', '2026-09', '2026' */
  key: string;
  start: IsoDate;
  end: IsoDate;
  label: string;
}

const MONTHS = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function periodFor(date: IsoDate, type: PeriodType): Period {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  if (type === 'maand') {
    const mm = String(month).padStart(2, '0');
    return {
      type,
      key: `${year}-${mm}`,
      start: `${year}-${mm}-01`,
      end: `${year}-${mm}-${String(lastDayOfMonth(year, month)).padStart(2, '0')}`,
      label: `${MONTHS[month - 1]} ${year}`,
    };
  }
  if (type === 'kwartaal') {
    const q = Math.floor((month - 1) / 3) + 1;
    const startMonth = (q - 1) * 3 + 1;
    const endMonth = startMonth + 2;
    return {
      type,
      key: `${year}-Q${q}`,
      start: `${year}-${String(startMonth).padStart(2, '0')}-01`,
      end: `${year}-${String(endMonth).padStart(2, '0')}-${String(lastDayOfMonth(year, endMonth)).padStart(2, '0')}`,
      label: `${q}e kwartaal ${year}`,
    };
  }
  return { type, key: `${year}`, start: `${year}-01-01`, end: `${year}-12-31`, label: `${year}` };
}

export function periodFromKey(key: string): Period {
  let m = /^(\d{4})-Q([1-4])$/.exec(key);
  if (m) return periodFor(`${m[1]}-${String((Number(m[2]) - 1) * 3 + 1).padStart(2, '0')}-01`, 'kwartaal');
  m = /^(\d{4})-(\d{2})$/.exec(key);
  if (m) return periodFor(`${m[1]}-${m[2]}-01`, 'maand');
  m = /^(\d{4})$/.exec(key);
  if (m) return periodFor(`${m[1]}-01-01`, 'jaar');
  throw new Error(`Onbekende periode: ${key}`);
}

export function formatDateNl(date: IsoDate): string {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}
