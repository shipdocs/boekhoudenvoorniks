import { describe, expect, it } from 'vitest';
import { carBijtellingForYear, type IbCar } from '../src/tax/car-ib';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import { setup } from './helpers';

const car = (extra: Partial<IbCar> = {}): IbCar => ({ name: 'Auto', catalogValue: 5000000, pct: null, inUseFrom: '2020-01-01', inUseUntil: null, registeredOn: null, marketValue: null, ...extra });

describe('Bijtelling auto van de zaak: pure berekening', () => {
  it('heel jaar: 22% van de cataloguswaarde', () => {
    expect(carBijtellingForYear([car()], 2026)).toEqual({ annual: 1100000, incomplete: [] });
  });
  it('een deel van het jaar: naar rato (voorbeeld Belastingdienst, € 20.000 vanaf 1 oktober, op maandbasis)', () => {
    expect(carBijtellingForYear([car({ catalogValue: 2000000, inUseFrom: '2026-10-01' })], 2026).annual).toBe(110000);
  });
  it('auto ouder dan 16 jaar: 35% van de dagwaarde vanaf de maand van 16 jaar (16 jaar op 1 mei: 4 maanden catalogus)', () => {
    const r = carBijtellingForYear([car({ catalogValue: 3000000, registeredOn: '2010-05-01', marketValue: 400000 })], 2026);
    expect(r.annual).toBe(Math.round((3000000 * 22 * 4) / 1200 + (400000 * 35 * 8) / 1200));
  });
  it('ouder dan 16 jaar zonder dagwaarde: gegevens ontbreken', () => {
    expect(carBijtellingForYear([car({ registeredOn: '2005-01-01' })], 2026).incomplete).toEqual(['Auto']);
  });
  it('twee auto\'s in één jaar (vervanging): ieder naar rato', () => {
    const r = carBijtellingForYear([car({ inUseFrom: '2020-01-01', inUseUntil: '2026-06-30' }), car({ name: 'Nieuw', catalogValue: 4000000, inUseFrom: '2026-07-01' })], 2026);
    expect(r.annual).toBe(Math.round((5000000 * 22 * 6) / 1200 + (4000000 * 22 * 6) / 1200));
  });
});

describe('Bijtelling in de schatting met meerdere auto\'s', () => {
  it('een extra auto telt mee; de bijtelling blijft begrensd door de autokosten', () => {
    const { s } = setup();
    s.settings.update({ carUse: 'zakelijk', carPrivateUse: true, carCatalogValue: 5000000, carInUseSince: 2025, carInUseUntil: '2026-06-30',
      carsExtra: [car({ name: 'Tweede', catalogValue: 4000000, inUseFrom: '2026-07-01' })] });
    s.quick.recordExpense({ date: '2026-03-10', supplierName: 'Garage', description: 'Onderhoud', categoryKey: 'auto', grossAmount: 121000 * 30, vatCode: 'hoog', paidWith: 'kas' });
    const adj = s.taxOverview.adjustments(2026, '2026-12-31');
    expect(adj.carPrivate.state).toBe('bekend');
    expect(adj.carPrivate.bijtelling).toBe(Math.round((5000000 * 22 * 6) / 1200 + (4000000 * 22 * 6) / 1200));
    void ACCOUNTS;
  });
});
