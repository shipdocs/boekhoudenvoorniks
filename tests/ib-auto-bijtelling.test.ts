import { describe, expect, it } from 'vitest';
import { setup } from './helpers';

type S = ReturnType<typeof setup>['s'];
const car = (s: S, extra: Record<string, unknown> = {}) =>
  s.settings.update({ carUse: 'zakelijk', carPrivateUse: true, carCatalogValue: 5000000, carInUseSince: 2025, ...extra });
const fuel = (s: S, gross: number, date = '2026-03-10') =>
  s.quick.recordExpense({ date, supplierName: 'Garage', description: 'Onderhoud', categoryKey: 'auto', grossAmount: gross, vatCode: 'hoog', paidWith: 'kas' });

describe('IB-bijtelling privégebruik auto van de zaak', () => {
  it('22% van de cataloguswaarde, maximaal de autokosten (voorbeeld Belastingdienst: kosten lager dan bijtelling)', () => {
    const { s } = setup();
    car(s);
    fuel(s, 121000); // € 1.000 excl. btw
    const adj = s.taxOverview.adjustments(2026, '2026-12-31');
    expect(adj.carPrivate.state).toBe('bekend');
    expect(adj.carPrivate.pct).toBe(22);
    expect(adj.carPrivate.bijtelling).toBe(adj.carPrivate.costs);
    expect(adj.carPrivate.bijtelling).toBeGreaterThan(0);
  });
  it('bij hoge autokosten geldt 22% van de cataloguswaarde', () => {
    const { s } = setup();
    car(s);
    fuel(s, 121000 * 20); // € 20.000 kosten > € 11.000 bijtelling
    expect(s.taxOverview.adjustments(2026, '2026-12-31').carPrivate.bijtelling).toBe(1100000);
  });
  it('geen privégebruik (≤ 500 km): geen bijtelling', () => {
    const { s } = setup();
    car(s, { carPrivateUse: false });
    fuel(s, 121000 * 20);
    expect(s.taxOverview.adjustments(2026, '2026-12-31').carPrivate).toMatchObject({ state: 'n.v.t.', bijtelling: 0 });
  });
  it('ontbrekende cataloguswaarde: zichtbaar in de schatting en overzicht', () => {
    const { s } = setup();
    car(s, { carCatalogValue: null });
    expect(s.taxOverview.adjustments(2026, '2026-06-30').carPrivate.state).toBe('onbekend');
    const o = s.taxOverview.year(2026, '2026-06-30');
    expect(o.items.find((i) => i.key === 'auto-bijtelling')?.status).toBe('warn');
    expect(s.incomeTax.estimate('2026-06-30')!.notIncluded.join(' ')).toContain('auto van de zaak');
  });
  it('de bijtelling verhoogt de geschatte belasting', () => {
    const a = setup(); const b = setup();
    for (const x of [a, b]) fuel(x.s, 121000 * 20);
    car(a.s); car(b.s, { carPrivateUse: false });
    // beide hebben dezelfde winst; alleen a telt bij
    expect(a.s.incomeTax.estimate('2026-12-31')!.breakdown.bijtellingen).toBeGreaterThan(b.s.incomeTax.estimate('2026-12-31')!.breakdown.bijtellingen);
  });
});
