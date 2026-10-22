import { describe, expect, it } from 'vitest';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import { setup } from './helpers';

const purchase = (s: ReturnType<typeof setup>['s'], date: string, amount: number) => s.purchases.create({
  invoiceDate: date, description: 'Machine',
  lines: [{ account: ACCOUNTS.inventaris, netAmount: amount, vatCode: 'hoog', vatAmount: Math.round(amount * 0.21) }],
});
const find = (s: ReturnType<typeof setup>['s'], period: string, key: string) => s.vat.checks(period).find((c) => c.key === key);

describe('Bijzondere investeringssituaties: beoordelingstaken', () => {
  it('KOR: een vijfde van de afgetrokken btw per jaar terug, pas vanaf € 500 (voorbeeld Belastingdienst)', () => {
    const { s } = setup();
    // auto in 2024 met € 4.500 btw (21% van € 21.428,57): 4.500 / 5 = 900 per jaar
    s.purchases.create({ invoiceDate: '2024-01-10', description: 'Bus', lines: [{ account: ACCOUNTS.vervoermiddelen, netAmount: 2142857, vatCode: 'hoog', vatAmount: 450000 }] });
    s.assets.sync('2024-01-11');
    expect(find(s, '2026-Q2', 'kor-herziening')).toBeUndefined(); // zonder KOR niets
    s.settings.update({ kor: true });
    const c = find(s, '2026-Q2', 'kor-herziening')!;
    expect(c.title).toMatch(/900,00/);
    expect(c.items![0]!.amount).toBe(450000);
  });
  // Primaire bron, geraadpleegd 2026-10-21: Uitvoeringsbeschikking omzetbelasting 1968, art. 13 (BWBR0002634, toestand 2026-01-01).
  // Lid 3: roerende zaken 4 boekjaren na ingebruikname, telkens een vijfde. Lid 2: onroerende zaken 9 boekjaren, telkens een tiende.
  // De app rekent alleen de roerende regel uit; de melding noemt de afwijkende periode voor een pand of grond.
  it('KOR: de melding zegt dat de 5 jaar voor roerende zaken gelden en dat een pand of grond 10 jaar en een tiende per jaar heeft', () => {
    const { s } = setup();
    s.purchases.create({ invoiceDate: '2024-01-10', description: 'Bus', lines: [{ account: ACCOUNTS.vervoermiddelen, netAmount: 2142857, vatCode: 'hoog', vatAmount: 450000 }] });
    s.assets.sync('2024-01-11');
    s.settings.update({ kor: true });
    const c = find(s, '2026-Q2', 'kor-herziening')!;
    expect(c.detail).toContain('roerend bedrijfsmiddel');
    expect(c.detail).toContain('5 jaar gebruik');
    expect(c.detail).toContain('pand of grond');
    expect(c.detail).toContain('10 jaar (het jaar van ingebruikname en de 9 jaren daarna)');
    expect(c.detail).toContain('een tiende');
  });
  it('KOR: onder € 500 per jaar geen herziening', () => {
    const { s } = setup();
    purchase(s, '2024-03-01', 500000); // btw € 1.050, een vijfde = € 210
    s.assets.sync('2024-03-02');
    s.settings.update({ kor: true });
    expect(find(s, '2026-Q2', 'kor-herziening')).toBeUndefined();
  });
  // Primaire bron, geraadpleegd 2026-10-17:
  // https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/zakelijk/btw/hoe_werkt_de_btw/kleineondernemersregeling/wat-betekent-meedoen-met-de-kleineondernemersregeling/moet-ik-mijn-btw-aftrek-herzien-vanwege-de-kleineondernemersregeling
  // De vijfjaarsperiode begint bij ingebruikname. € 4.500 / 5 = € 900 per later jaar;
  // in het eerste gebruiksjaar wordt de volledige € 4.500 beoordeeld, niet een vijfde.
  // Dit controleert het signaal; het berekent geen definitieve herziening bij gemengd gebruik.
  const delayedUse = (acquiredOn: string, inUseOn: string) => {
    const { s } = setup();
    s.purchases.create({ invoiceDate: acquiredOn, description: 'Bus', lines: [{ account: ACCOUNTS.vervoermiddelen, netAmount: 2142857, vatCode: 'hoog', vatAmount: 450000 }] });
    const asset = s.assets.list({}, acquiredOn)[0]!;
    s.assets.update(asset.id, { inUseOn });
    s.settings.update({ kor: true });
    return s;
  };
  it('KOR: een oude aankoop met latere ingebruikname telt nog mee', () => {
    const s = delayedUse('2020-01-10', '2024-01-01');
    const check = find(s, '2026-Q4', 'kor-herziening')!;
    expect(check.title).toContain('900,00');
    expect(check.items).toHaveLength(1);
    expect(check.items![0]).toMatchObject({ date: '2024-01-01', amount: 450000 });
  });
  it('KOR: latere ingebruikname in het aangiftejaar vraagt beoordeling van de volledige aftrek', () => {
    const s = delayedUse('2025-01-10', '2026-01-01');
    const check = find(s, '2026-Q4', 'kor-herziening')!;
    expect(check.title).toContain('van dit jaar');
    expect(check.detail).toContain('4.500,00');
    expect(check.detail).toContain('volledige afgetrokken btw');
  });
  it('KOR: het vijfde gebruiksjaar telt mee, het zesde niet', () => {
    const s = delayedUse('2020-01-10', '2022-01-01');
    expect(find(s, '2026-Q4', 'kor-herziening')!.title).toContain('900,00');
    expect(find(s, '2027-Q4', 'kor-herziening')).toBeUndefined();
  });
  it('KOR: een bedrijfsmiddel dat pas volgend jaar in gebruik komt telt nog niet mee', () => {
    const s = delayedUse('2025-01-10', '2027-01-01');
    expect(find(s, '2026-Q4', 'kor-herziening')).toBeUndefined();
  });
  it('een bedrijfsmiddel naar privé geeft een vraag over de btw op de onttrekking', () => {
    const { s } = setup();
    purchase(s, '2026-01-10', 500000);
    s.assets.sync('2026-01-11');
    const a = s.assets.list({}, '2026-05-01')[0]!;
    s.assets.dispose(a.id, '2026-05-01', 300000, 'prive');
    expect(find(s, '2026-Q2', 'investering-prive')).toMatchObject({ blocking: false, count: 1 });
    expect(find(s, '2026-Q1', 'investering-prive')).toBeUndefined();
  });
  it('een credit in een later jaar dan de aanschaf geeft een beoordelingstaak', () => {
    const { s } = setup();
    purchase(s, '2025-11-01', 500000);
    s.assets.sync('2025-11-02');
    purchase(s, '2026-02-01', -50000);
    s.assets.sync('2026-02-02');
    expect(find(s, '2026-Q1', 'investering-credit-later')).toMatchObject({ blocking: false, count: 1 });
    expect(find(s, '2025-Q4', 'investering-credit-later')).toBeUndefined();
  });
});
