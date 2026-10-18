import type { Db } from '../db/database';
import type { FetchLike } from '../integrations/types';
import { addDays, type IsoDate } from '../shared/dates';

/**
 * Wisselkoersen van de Europese Centrale Bank (#74). Alleen opgehaald als er echt een bon in een
 * andere munt is; daarna bewaard, zodat dezelfde koers niet opnieuw opgehaald wordt en de app
 * zonder internet blijft werken voor wat er al is. De ECB-koers is "zoveel vreemde munt per 1 euro".
 * Er gaat alleen een munt en een datum naar de ECB, niets van de administratie.
 */
export interface FxRate {
  currency: string;
  /** vreemde munt per 1 euro, bv. 1,0825 dollar */
  rate: number;
  /** de dag waarvan de koers is (de laatste werkdag op of vóór de gevraagde datum) */
  date: IsoDate;
}

export class FxService {
  constructor(
    private readonly db: Db,
    private readonly fetch: FetchLike,
  ) {}

  private cached(currency: string, date: IsoDate): FxRate | null {
    const row = this.db
      .prepare('SELECT rate, rate_date FROM fx_rates WHERE currency = ? AND rate_date <= ? AND rate_date >= ? ORDER BY rate_date DESC LIMIT 1')
      .get(currency, date, addDays(date, -7)) as { rate: number; rate_date: IsoDate } | undefined;
    return row ? { currency, rate: row.rate, date: row.rate_date } : null;
  }

  /** De koers op (of vlak vóór) deze datum; null als hij er niet is en niet op te halen is (geen internet). */
  async rateFor(currency: string, date: IsoDate): Promise<FxRate | null> {
    const code = currency.toUpperCase();
    if (code === 'EUR') return { currency: 'EUR', rate: 1, date };
    if (!/^[A-Z]{3}$/.test(code)) return null;
    const hit = this.cached(code, date);
    if (hit) return hit;
    try {
      const url = `https://data-api.ecb.europa.eu/service/data/EXR/D.${code}.EUR.SP00.A?startPeriod=${addDays(date, -10)}&endPeriod=${date}&format=csvdata`;
      const res = await this.fetch(url, { method: 'GET', headers: { Accept: 'text/csv' } });
      if (!res.ok) return null;
      const rows = parseEcbCsv(await res.text());
      const insert = this.db.prepare('INSERT OR REPLACE INTO fx_rates (currency, rate_date, rate) VALUES (?, ?, ?)');
      for (const r of rows) insert.run(code, r.date, r.rate);
    } catch {
      return null;
    }
    return this.cached(code, date);
  }
}

/** ECB SDMX-CSV: kolommen TIME_PERIOD en OBS_VALUE. */
export function parseEcbCsv(csv: string): { date: IsoDate; rate: number }[] {
  const lines = csv.trim().split(/\r?\n/);
  const head = (lines.shift() ?? '').split(',');
  const di = head.indexOf('TIME_PERIOD');
  const vi = head.indexOf('OBS_VALUE');
  if (di < 0 || vi < 0) return [];
  return lines
    .map((l) => l.split(','))
    .map((c) => ({ date: c[di] as IsoDate, rate: Number(c[vi]) }))
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && Number.isFinite(r.rate) && r.rate > 0);
}

/** Vreemd bedrag naar euro's met een ECB-koers. */
export const toEuro = (foreignCents: number, rate: number): number => Math.round(foreignCents / rate);
