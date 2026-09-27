import { describe, expect, it } from 'vitest';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import { estimateIncomeTax, representatieBijtelling, rulesFor, tariefsaanpassingFor } from '../src/tax/income-tax';
import { isStarter } from '../src/tax/overview';
import { setup } from './helpers';

type S = ReturnType<typeof setup>['s'];
/** Investering via een bon: bruto incl. 21% btw. */
const buy = (s: S, date: string, gross: number, name = 'Steigermateriaal') =>
  s.quick.recordExpense({ date, supplierName: 'Bouwmaat', description: name, categoryKey: 'investering', grossAmount: gross, vatCode: 'hoog', paidWith: 'kas' });
const balance = (s: S, rgs: string) =>
  (s.db.prepare(`SELECT COALESCE(SUM(l.debit - l.credit), 0) AS b FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id WHERE a.rgs_code = ?`).get(rgs) as { b: number }).b;

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

describe('bedrijfsmiddelen (vragen 17, 20 en 31)', () => {
  it('17: afschrijving begint bij ingebruikname, niet bij aankoop', () => {
    const { s } = setup();
    buy(s, '2025-03-01', 3630_00); // 3.000 excl. btw, 60 maanden → 50 per maand
    const [a] = s.assets.list({}, '2025-03-02');
    s.assets.update(a!.id, { inUseOn: '2025-11-15' });
    // 2025: alleen november en december
    expect(s.assets.bookYear(2025, '2026-01-05').amount).toBe(100_00);
    expect(() => s.assets.update(a!.id, { inUseOn: '2025-12-01' })).toThrow(/al afschrijving/);
    expect(() => s.assets.update(a!.id, { inUseOn: '2025-01-01' })).toThrow();
  });

  it('31: naar privé telt als vervreemding: waarde als privé-opname, desinvesteringsbijtelling', () => {
    const { s } = setup();
    buy(s, '2025-07-10', 3630_00);
    const [a] = s.assets.list({}, '2026-01-10');
    s.assets.dispose(a!.id, '2026-04-15', 3000_00, 'prive');
    expect(balance(s, 'BEivPriPrv')).toBe(3000_00);
    // boekresultaat: boekwaarde 2.550 eraf, waarde 3.000 erbij
    expect(balance(s, 'WAfsRvmBei')).toBe(3000_00 - 450_00 - 3000_00);
    expect(s.ledger.checkIntegrity().balanced).toBe(true);
    expect(s.taxOverview.adjustments(2026, '2026-05-01').desinvesteringsbijtelling).toBe(840_00);
  });

  it('31: geen bijtelling tot en met de drempel van € 2.900', () => {
    const { s } = setup();
    buy(s, '2025-07-10', 3630_00);
    const [a] = s.assets.list({}, '2026-01-10');
    s.assets.dispose(a!.id, '2026-04-15', 2900_00);
    expect(s.taxOverview.adjustments(2026, '2026-05-01').desinvesteringsbijtelling).toBe(0);
  });

  it('20: KIA van een afgesloten jaar wordt vastgelegd en verandert niet meer door het register', () => {
    const { s } = setup();
    buy(s, '2025-02-01', 3630_00, 'Steiger');
    buy(s, '2025-03-01', 12100_00, 'Aanhanger');
    // 2025 afgesloten: 13.000 × 28%
    expect(s.taxOverview.adjustments(2025, '2026-02-01').kia).toBe(3640_00);
    // later wordt de aanhanger uitgesloten; de toegepaste KIA van 2025 blijft
    const aanhanger = s.assets.list({}, '2026-02-01').find((x) => x.name.includes('Aanhanger'))!;
    s.assets.update(aanhanger.id, { kiaExcluded: true });
    expect(s.taxOverview.adjustments(2025, '2026-03-01').kia).toBe(3640_00);
    const steiger = s.assets.list({}, '2026-03-01').find((x) => x.name.includes('Steiger'))!;
    s.assets.dispose(steiger.id, '2026-04-01', 3000_00);
    expect(s.taxOverview.adjustments(2026, '2026-05-01').desinvesteringsbijtelling).toBe(840_00);
  });
});

describe('KOR: geen aftrek van voorbelasting (vraag 27)', () => {
  const rubrieken = (s: S, key: string) => Object.fromEntries(s.vat.calculate(key).rubrieken.map((x) => [x.code, x]));

  it('27: inkoop met 21% onder de KOR: geen voorbelasting, btw bij de kosten', () => {
    const { s } = setup();
    s.settings.update({ kor: true });
    s.quick.recordExpense({ date: '2026-07-01', supplierName: 'Bouwmaat', description: 'Schuurpapier', categoryKey: 'materiaal', grossAmount: 121_00, vatCode: 'hoog', paidWith: 'kas' });
    expect(s.ledger.balance(ACCOUNTS.btwVoorbelasting)).toBe(0);
    expect(rubrieken(s, '2026-Q3')['5b']!.btw || 0).toBe(0);
    // winst: de volle 121 als kosten
    expect(s.taxOverview.year(2026, '2026-07-31').profitBooked).toBe(-121_00);
    expect(s.ledger.checkIntegrity().balanced).toBe(true);
  });

  it('27: verlegde buitenlandse dienst onder de KOR: 4b verschuldigd, geen aftrek in 5b', () => {
    const { s } = setup();
    s.settings.update({ kor: true });
    s.quick.recordExpense({ date: '2026-07-01', supplierName: 'Meta Platforms Ireland', description: 'Advertenties', categoryKey: 'reclame', grossAmount: 100_00, vatCode: 'eu', paidWith: 'bank' });
    const rub = rubrieken(s, '2026-Q3');
    expect(rub['4b']).toMatchObject({ omzet: 100_00, btw: 21_00 });
    expect(rub['5b']!.btw || 0).toBe(0);
    expect(s.vat.calculate('2026-Q3').summary.teBetalen).toBe(21_00);
    expect(s.vat.calculate('2026-Q3').warnings.join(' ')).toMatch(/verlegd.*aangeven en betalen/);
    expect(s.vat.korReverseCharge(2026)).toEqual([{ period: expect.objectContaining({ key: '2026-Q3' }), btw: 21_00 }]);
    // betaald: alleen netto; kosten: netto + niet-aftrekbare btw
    expect(s.purchases.list()[0]!.total).toBe(100_00);
    expect(s.taxOverview.year(2026, '2026-07-31').profitBooked).toBe(-121_00);
  });

  it('13: investering onder de KOR: kostprijs inclusief niet-aftrekbare btw, één bedrijfsmiddel', () => {
    const { s } = setup();
    s.settings.update({ kor: true });
    buy(s, '2026-03-01', 1210_00, 'Laptop');
    const assets = s.assets.list({}, '2026-03-02');
    expect(assets).toHaveLength(1);
    expect(assets[0]!.cost).toBe(1210_00);
    expect(s.ledger.balance(ACCOUNTS.btwVoorbelasting)).toBe(0);
  });

  it('27: bankbetaling op een kostenrekening onder de KOR', () => {
    const { s } = setup();
    s.settings.update({ kor: true });
    s.quick.recordExpense({ date: '2026-07-01', supplierName: 'KPN', description: 'Telefoon', categoryKey: 'telefoon', grossAmount: 60_50, vatCode: 'hoog', paidWith: 'bank' });
    expect(s.ledger.balance(ACCOUNTS.btwVoorbelasting)).toBe(0);
    // geen btw-correctie privégebruik telefoon: er is niets afgetrokken
    s.settings.update({ phoneInternetBusinessPct: 50 });
    expect(s.taxOverview.adjustments(2026, '2026-07-31').phonePrivate.vat).toBe(0);
  });

  it('27: zonder KOR verandert er niets', () => {
    const { s } = setup();
    s.quick.recordExpense({ date: '2026-07-01', supplierName: 'Bouwmaat', description: 'Schuurpapier', categoryKey: 'materiaal', grossAmount: 121_00, vatCode: 'hoog', paidWith: 'kas' });
    expect(rubrieken(s, '2026-Q3')['5b']!.btw).toBe(21_00);
  });
});

describe('buitenland (vragen 2, 3, 4 en 8)', () => {
  const rubrieken = (s: S, key: string) => Object.fromEntries(s.vat.calculate(key).rubrieken.map((x) => [x.code, x]));

  it('2: goederen buiten de EU in 3a, een dienst aan een bedrijf buiten de EU niet in de aangifte', () => {
    const { s } = setup();
    const ch = s.relations.create({ name: 'Bau AG', address: 'Bahnhofstrasse 1', postcode: '8001', city: 'Zürich', country: 'CH', vat_number: 'CHE253742182', email: 'info@bau.example' });
    s.invoices.finalize(s.invoices.createDraft({ relationId: ch.id, invoiceDate: '2026-02-10', lines: [{ description: 'Machine', quantity: 1, unitPrice: 80000, vatCode: 'export' }] }).id);
    const dienst = s.invoices.finalize(s.invoices.createDraft({ relationId: ch.id, invoiceDate: '2026-02-11', lines: [{ description: 'Advies', quantity: 1, unitPrice: 50000, vatCode: 'dienst-buiten-eu' }] }).id);
    const r = s.vat.calculate('2026-Q1');
    expect(rubrieken(s, '2026-Q1')['3a']).toMatchObject({ omzet: 80000 });
    expect(r.rubrieken.reduce((t, x) => t + (x.omzet ?? 0), 0)).toBe(80000);
    expect(r.summary.omzet).toBe(130000);
    expect(r.summary.teBetalen).toBe(0);
    // op de factuur: niet belast in Nederland
    const xml = s.invoices.ublXml(dienst.id);
    expect(xml).toContain('Dienst buiten de EU');
  });

  it('3/4: ICP goederen en diensten apart, met de juiste factuurtekst', () => {
    const { s } = setup();
    const de = s.relations.create({ name: 'Bau GmbH', address: 'Hauptstraße 1', postcode: '47533', city: 'Kleve', country: 'DE', vat_number: 'DE123456789', email: 'info@bau.example' });
    const goed = s.invoices.finalize(s.invoices.createDraft({ relationId: de.id, invoiceDate: '2026-07-10', lines: [{ description: 'Steigers', quantity: 1, unitPrice: 100000, vatCode: 'icp' }] }).id);
    const dienst = s.invoices.finalize(s.invoices.createDraft({ relationId: de.id, invoiceDate: '2026-07-11', lines: [{ description: 'Ontwerp', quantity: 1, unitPrice: 40000, vatCode: 'icp-dienst' }] }).id);
    expect(rubrieken(s, '2026-Q3')['3b']).toMatchObject({ omzet: 140000 });
    const icp = s.vat.icp('2026-Q3');
    expect(icp.lines.map((l) => [l.kind, l.amount])).toEqual([['goederen', 100000], ['diensten', 40000]]);
    expect(s.vat.icpCsv('2026-Q3')).toContain(';diensten;400.00;400');
    expect(s.invoices.ublXml(goed.id)).toContain('<cbc:ID>K</cbc:ID>');
    const dienstXml = s.invoices.ublXml(dienst.id);
    expect(dienstXml).toContain('<cbc:ID>AE</cbc:ID>');
    expect(dienstXml).not.toContain('<cbc:ID>K</cbc:ID>');
  });

  it('8: particulieren in andere EU-landen: altijd een controle, de drempel alleen voor goederen en digitale diensten', () => {
    const { s } = setup();
    const fr = s.relations.create({ name: 'Mme Dupont', address: 'Rue 1', postcode: '75001', city: 'Paris', country: 'FR' });
    s.invoices.finalize(s.invoices.createDraft({ relationId: fr.id, invoiceDate: '2026-03-10', lines: [{ description: 'Advies', quantity: 1, unitPrice: 60000, vatCode: 'hoog' }] }).id);
    const c = s.vat.checks('2026-Q1').find((x) => x.key === 'eu-particulier');
    expect(c?.detail).toMatch(/opstuurt en digitale diensten/);
    expect(c?.detail).toMatch(/gebouw/);
  });
});
