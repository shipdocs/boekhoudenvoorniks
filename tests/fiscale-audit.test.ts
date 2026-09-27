import { describe, expect, it } from 'vitest';
import { estimateIncomeTax, representatieBijtelling, rulesFor, tariefsaanpassingFor } from '../src/tax/income-tax';
import { isStarter } from '../src/tax/overview';

/**
 * Regressietests uit de fiscale review (docs/fiscale-review.md, hoofdstuk 4). Elke test noemt het
 * vraagnummer uit dat document.
 */

const r2025 = rulesFor(2025).rules;
const r2026 = rulesFor(2026).rules;

describe('inkomstenbelasting (vragen 28–30)', () => {
  it('28: tariefsaanpassing op ondernemersaftrek en mkb-winstvrijstelling in de hoogste schijf', () => {
    // onder de hoogste schijf: geen aanpassing
    expect(estimateIncomeTax(50000, r2026, { urencriterium: true }).tariefsaanpassing).toBe(0);
    // ver erboven: de hele aftrek × (49,50% − 37,56%)
    const b = estimateIncomeTax(150000, r2026, { urencriterium: true });
    const aftrek = b.zelfstandigenaftrek + b.mkbWinstvrijstelling;
    expect(b.tariefsaanpassing).toBe(Math.round(aftrek * (0.495 - 0.3756)));
    expect(b.tariefsaanpassing).toBeGreaterThan(2300);
    // de aanpassing zit in het totaal
    const zonder = b.box1 - b.heffingskortingen + b.zvw;
    expect(b.total).toBe(Math.round(zonder + b.tariefsaanpassing));
    // 2025: verschil 49,50% − 37,48% = 12,02%
    const b25 = estimateIncomeTax(150000, r2025, { urencriterium: true });
    expect(b25.tariefsaanpassing).toBe(Math.round((b25.zelfstandigenaftrek + b25.mkbWinstvrijstelling) * 0.1202));
  });

  it('28: alleen het deel van de aftrek dat in de hoogste schijf valt', () => {
    const top = r2026.brackets[1]![0]!;
    // 1.000 boven de grens zonder aftrek, aftrek 5.000: aanpassing over 1.000
    expect(tariefsaanpassingFor(top - 4000, 5000, r2026)).toBeCloseTo(1000 * (0.495 - 0.3756));
    expect(tariefsaanpassingFor(top - 6000, 5000, r2026)).toBe(0);
  });

  it('29: starter met lage winst: zelfstandigen- en startersaftrek niet beperkt tot de winst', () => {
    const b = estimateIncomeTax(2000, r2026, { urencriterium: true, starter: true });
    expect(b.zelfstandigenaftrek).toBe(r2026.zelfstandigenaftrek);
    expect(b.startersaftrek).toBe(r2026.startersaftrek);
    const loss = 2000 - r2026.zelfstandigenaftrek - r2026.startersaftrek;
    expect(b.taxableProfit).toBe(Math.round(loss - loss * r2026.mkbWinstvrijstelling));
    expect(b.taxableProfit).toBeLessThan(0);
    expect(b.total).toBe(0);
    expect(b.zelfstandigenaftrekNietGerealiseerd).toBe(0);
  });

  it('29: geen starter: aftrek tot de winst, de rest is niet-gerealiseerd', () => {
    const b = estimateIncomeTax(500, r2026, { urencriterium: true });
    expect(b.zelfstandigenaftrek).toBe(500);
    expect(b.zelfstandigenaftrekNietGerealiseerd).toBe(r2026.zelfstandigenaftrek - 500);
    expect(b.taxableProfit).toBe(0);
  });

  it('29: niet-gerealiseerde zelfstandigenaftrek uit eerdere jaren alleen over winst boven de zelfstandigenaftrek', () => {
    const b = estimateIncomeTax(40000, r2026, { urencriterium: true, nietGerealiseerd: 3000 });
    expect(b.zelfstandigenaftrekVerrekend).toBe(3000);
    const krap = estimateIncomeTax(r2026.zelfstandigenaftrek + 800, r2026, { urencriterium: true, nietGerealiseerd: 3000 });
    expect(krap.zelfstandigenaftrekVerrekend).toBe(800);
    expect(estimateIncomeTax(40000, r2026, { urencriterium: false, nietGerealiseerd: 3000 }).zelfstandigenaftrekVerrekend).toBe(0);
  });

  it('30: verlies: mkb-winstvrijstelling verkleint het verlies', () => {
    const b = estimateIncomeTax(-10000, r2026, { urencriterium: true });
    expect(b.zelfstandigenaftrek).toBe(0);
    expect(b.mkbWinstvrijstelling).toBe(Math.round(-10000 * r2026.mkbWinstvrijstelling));
    expect(b.taxableProfit).toBe(Math.round(-10000 * (1 - r2026.mkbWinstvrijstelling)));
    expect(b.total).toBe(0);
  });

  it('23: startersaftrek per jaar opgegeven gaat boven de aanname', () => {
    const base = { startYear: 2023, startersaftrekUsed: { count: 0, asOfYear: 2023 } };
    // aanname: 2023, 2024, 2025 gebruikt → 2026 niet meer
    expect(isStarter(base, 2026)).toBe(false);
    // echt alleen 2023 en 2025 gebruikt → 2026 nog wel
    expect(isStarter({ ...base, startersaftrekYears: [2023, 2025] }, 2026)).toBe(true);
    expect(isStarter({ ...base, startersaftrekYears: [2023, 2024, 2025] }, 2026)).toBe(false);
  });
});

describe('drempels uit de jaartabel (vragen 22 en 31)', () => {
  it('22: representatiedrempel € 5.700 in 2025 en 2026', () => {
    expect(r2025.representatie.drempel).toBe(5700);
    expect(r2026.representatie.drempel).toBe(5700);
    expect(representatieBijtelling(40000, r2025.representatie)).toBe(5700);
    expect(representatieBijtelling(10000, r2025.representatie)).toBe(2000);
  });

  it('31: desinvesteringsdrempel € 2.900, gelijk aan de KIA-ondergrens', () => {
    for (const r of [r2025, r2026]) {
      expect(r.desinvesteringDrempel).toBe(2900);
      expect(r.kia.min - 1).toBe(r.desinvesteringDrempel);
    }
  });
});
