import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from '../src/db/database';
import { createServices, MemorySecretStore } from '../src/services';
import { cumulativeDepreciation } from '../src/tax/assets';
import { estimateIncomeTax, kiaFor, meewerkaftrekFor, representatieBijtelling, rulesFor } from '../src/tax/income-tax';
import { mightBeInvestment } from '../src/shared/investment';
import type { DocumentResult } from '../src/intake/types';
import { isStarter } from '../src/tax/overview';
import { setup } from './helpers';

const r2026 = rulesFor(2026).rules;
const r2025 = rulesFor(2025).rules;

/** Investering via een bon: bruto incl. 21% btw. */
function buy(s: ReturnType<typeof setup>['s'], date: string, gross: number, name = 'Steigermateriaal') {
  return s.quick.recordExpense({ date, supplierName: 'Bouwmaat', description: name, categoryKey: 'investering', grossAmount: gross, vatCode: 'hoog', paidWith: 'kas' });
}

const balance = (s: ReturnType<typeof setup>['s'], rgs: string) =>
  (s.db.prepare(`SELECT COALESCE(SUM(l.debit - l.credit), 0) AS b FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id WHERE a.rgs_code = ?`).get(rgs) as { b: number }).b;

describe('KIA en beperkt aftrekbare kosten', () => {
  it('KIA volgens de tabel van 2026', () => {
    expect(kiaFor(2900, r2026.kia)).toBe(0);
    expect(kiaFor(10000, r2026.kia)).toBe(2800);
    expect(kiaFor(71683, r2026.kia)).toBe(Math.round(71683 * 0.28));
    expect(kiaFor(80000, r2026.kia)).toBe(20072);
    expect(kiaFor(200000, r2026.kia)).toBe(Math.round(20072 - (200000 - 132746) * 0.0756));
    expect(kiaFor(400000, r2026.kia)).toBe(0);
    expect(kiaFor(80000, r2025.kia)).toBe(19769);
  });

  it('representatie: 20% bij, of de drempel als dat minder is', () => {
    expect(representatieBijtelling(1000, r2026.representatie)).toBe(200);
    expect(representatieBijtelling(40000, r2026.representatie)).toBe(5700);
    expect(representatieBijtelling(0, r2026.representatie)).toBe(0);
  });

  it('latere jaren: bekende wetswijzigingen gaan voor (zelfstandigenaftrek 2027 € 900, startersaftrek weg)', () => {
    expect(rulesFor(2027)).toMatchObject({ fallback: true, rules: { zelfstandigenaftrek: 900, startersaftrek: 10 } });
    expect(rulesFor(2029).rules).toMatchObject({ zelfstandigenaftrek: 900, startersaftrek: 0 });
    expect(rulesFor(2026).rules.zelfstandigenaftrek).toBe(1200);
  });

  it('startersaftrek: max 3× in de eerste 5 jaar, niet meer vanaf 2028', () => {
    const s = { startYear: 2025, startersaftrekUsed: { count: 0, asOfYear: 2026 } };
    expect(isStarter(s, 2026)).toBe(true);
    expect(isStarter(s, 2027)).toBe(true);
    expect(isStarter(s, 2028)).toBe(false);
    expect(isStarter({ startYear: 2024, startersaftrekUsed: { count: 3, asOfYear: 2026 } }, 2026)).toBe(false);
    expect(isStarter({ startYear: 2019, startersaftrekUsed: { count: 0, asOfYear: 2026 } }, 2026)).toBe(false);
    expect(isStarter({ startYear: null, startersaftrekUsed: { count: 0, asOfYear: 0 } }, 2026)).toBe(false);
  });
});

describe('bedrijfsmiddelen en afschrijving', () => {
  it('lineair per maand, cumulatief afgerond', () => {
    const a = { acquired_on: '2025-07-10', cost: 300000, residual: 0, lifetime_months: 60 };
    expect(cumulativeDepreciation(a, 2025, 6)).toBe(0);
    expect(cumulativeDepreciation(a, 2025, 12)).toBe(30000);
    expect(cumulativeDepreciation(a, 2030, 6)).toBe(300000);
    expect(cumulativeDepreciation(a, 2035, 12)).toBe(300000);
  });

  it('aankoop wordt bedrijfsmiddel; afgesloten jaar wordt geboekt, en maar één keer', () => {
    const { s } = setup();
    buy(s, '2025-07-10', 3630_00);
    const [a] = s.assets.list({}, '2026-02-01');
    expect(a).toMatchObject({ cost: 3000_00, lifetime_months: 60, name: 'Steigermateriaal', perYear: 600_00, belowThreshold: false });

    expect(s.assets.bookDue('2026-02-01')).toEqual({ years: [2025], amount: 300_00 });
    expect(s.assets.bookDue('2026-02-01')).toEqual({ years: [], amount: 0 });
    expect(balance(s, 'BMvaBedCae')).toBe(-300_00);
    expect(balance(s, 'WAfsAmvBei')).toBe(300_00);
    expect(s.assets.get(a!.id).bookValue).toBe(2700_00);
    expect(s.assets.projected(2026)).toBe(600_00);
    expect(() => s.assets.bookYear(2026, '2026-02-01')).toThrow(/nog niet voorbij/);
    expect(s.ledger.checkIntegrity().balanced).toBe(true);
  });

  it('bestaande administratie: jaren vóór de update niet vanzelf boeken, wel als de gebruiker dat kiest', () => {
    const { s } = setup();
    s.db.prepare(`INSERT INTO settings (key, value) VALUES ('counter:depreciation-since', '2026')`).run();
    buy(s, '2025-07-10', 3630_00);
    const [a] = s.assets.list({}, '2026-02-01');
    expect(a!.booked_elsewhere_until).toBe(2025);
    expect(a!.bookValue).toBe(2700_00);
    expect(s.assets.bookDue('2026-02-01').years).toEqual([]);
    expect(s.assets.projected(2026)).toBe(600_00); // alleen 2026, geen inhaalslag
    s.assets.update(a!.id, { bookInApp: true });
    expect(s.assets.bookDue('2026-02-01')).toEqual({ years: [2025], amount: 300_00 });
  });

  it('levensduur korter dan 5 jaar kan niet (fiscaal max 20% per jaar)', () => {
    const { s } = setup();
    buy(s, '2026-03-01', 1210_00);
    const [a] = s.assets.list();
    expect(() => s.assets.update(a!.id, { lifetimeMonths: 24 })).toThrow(/5 jaar/);
    expect(s.assets.update(a!.id, { lifetimeMonths: 84, residual: 100_00 }).perYear).toBe(Math.round((900_00 * 12) / 84));
  });

  it('verkopen: afschrijving tot de verkoopmaand, rest naar boekresultaat, KIA deels terug', () => {
    const { s } = setup();
    buy(s, '2025-07-10', 3630_00);
    const [a] = s.assets.list({}, '2026-01-10');
    const sold = s.assets.dispose(a!.id, '2026-04-15', 3000_00);
    expect(sold.status).toBe('verkocht');
    expect(sold.booked).toBe(300_00 + 150_00); // 2025: 6 mnd, 2026: jan–mrt
    expect(balance(s, 'BMvaBedIna')).toBe(0);
    expect(balance(s, 'BMvaBedCae')).toBe(0);
    expect(balance(s, 'WAfsRvmBei')).toBe(3000_00 - 450_00);
    expect(s.ledger.checkIntegrity().balanced).toBe(true);

    const o2025 = s.taxOverview.adjustments(2025, '2026-05-01');
    expect(o2025.kia).toBe(840_00);
    // 2026: verkocht binnen 5 jaar voor meer dan € 2.500 → 28% van de verkoopprijs terug
    expect(s.taxOverview.adjustments(2026, '2026-05-01').desinvesteringsbijtelling).toBe(840_00);
  });

  it('verkoop in een jaar dat al geboekt is: het teveel aan afschrijving gaat terug', () => {
    const { s } = setup();
    buy(s, '2024-01-05', 3630_00);
    s.assets.bookDue('2026-01-10'); // 2024 en 2025 volledig: 2 × 600
    const [a] = s.assets.list({}, '2026-01-10');
    const sold = s.assets.dispose(a!.id, '2025-07-01', 0);
    expect(sold.booked).toBe(600_00 + 300_00); // 2025 alleen jan–jun
    expect(balance(s, 'BMvaBedCae')).toBe(0);
    expect(balance(s, 'WAfsRvmBei')).toBe(3000_00 - 900_00);
    expect(s.ledger.checkIntegrity().balanced).toBe(true);
  });

  it('beginbalans op inventaris wordt geen nieuw bedrijfsmiddel', () => {
    const { s } = setup();
    s.ledger.post({ date: '2026-01-01', description: 'Beginbalans', source: 'opening', lines: [{ account: 'BMvaBedIna', debit: 5000_00 }, { account: 'BEivKap', credit: 5000_00 }] });
    expect(s.assets.list({}, '2026-02-01')).toEqual([]);
  });

  it('aankoop teruggedraaid: bedrijfsmiddel vervalt, geboekte afschrijving gaat terug', () => {
    const { s } = setup();
    const p = buy(s, '2025-07-10', 3630_00);
    s.assets.bookDue('2026-02-01');
    s.purchases.reclassify(p.id, [{ account: 'WBedAlkGer', netAmount: 3000_00, vatCode: 'hoog', vatAmount: 630_00, description: 'toch klein gereedschap' }]);
    expect(s.assets.list({}, '2026-02-02')).toEqual([]);
    expect(balance(s, 'BMvaBedCae')).toBe(0);
    expect(balance(s, 'WAfsAmvBei')).toBe(0);
  });

  it('nieuwe standaardrekening met een al bezet nummer krijgt het volgende vrije nummer', () => {
    const db = new Database(':memory:');
    migrate(db);
    db.prepare(`INSERT INTO chart_of_accounts (rgs_code, code, name, category) VALUES ('EigenRek', '4600', 'Eigen rekening', 'kosten')`).run();
    const s = createServices(db, { pdf: async () => Buffer.from(''), mailerFactory: async () => ({ send: async () => ({ messageId: '' }) }), secrets: new MemorySecretStore(), fetch: async () => { throw new Error('x'); }, storeFile: async (n) => n });
    expect(s.ledger.getAccount('WAfsAmvBei').code).toBe('4601');
  });
});

describe('kilometers, uren en privéauto', () => {
  it('rit: € 0,25 per km als kosten, tegen privé gestort; verwijderen draait terug', () => {
    const { s } = setup();
    const t = s.mileage.add({ date: '2026-03-02', km: 120, description: 'Klant Utrecht → Amersfoort' });
    expect(t.amount).toBe(30_00);
    expect(balance(s, 'WBedAutKil')).toBe(30_00);
    expect(balance(s, 'BEivPriStr')).toBe(-30_00);
    expect(s.mileage.add({ date: '2025-12-01', km: 10, description: 'x' }).amount).toBe(2_30);
    s.mileage.remove(t.id);
    expect(balance(s, 'WBedAutKil')).toBe(2_30);
    expect(s.mileage.totals(2026)).toEqual({ km: 0, amount: 0, trips: 0 });
  });

  it('privéauto: ook onderhoud en verzekering worden als privé voorgesteld', () => {
    const { s } = setup();
    s.settings.update({ carUse: 'prive' });
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-03-01', amount: -250_00, counterName: 'Garage Pietersen', description: 'APK en onderhoud' }] });
    s.memory.learn('Garage Pietersen', { categoryKey: 'auto', vatCode: 'hoog', business: true });
    expect(s.inbox.tasks('2026-03-02').find((t) => t.kind === 'bank-business')?.actions[0]).toMatchObject({ id: 'prive', primary: true });
  });

  it('urencriterium: uren van werkbonnen plus losse uren', () => {
    const { s, klant } = setup();
    const job = s.jobs.create({ relationId: klant.id, title: 'Badkamer' });
    s.jobs.addWorkItem(job.id, { date: '2026-02-03', description: 'Stucen', quantity: 7.5, unit: 'uur', unitPrice: 5000, vatCode: 'hoog' });
    s.jobs.addWorkItem(job.id, { date: '2026-02-03', description: 'Gips', quantity: 10, unit: 'zak', unitPrice: 1000, vatCode: 'hoog' });
    s.hours.add({ date: '2026-02-04', hours: 2, description: 'Administratie' });
    expect(s.hours.totals(2026)).toEqual({ workOrders: 7.5, other: 2, total: 9.5 });
  });

  it('privéauto: tanken wordt een privé-vraag, nooit automatisch zakelijk', () => {
    const { s } = setup();
    s.settings.update({ carUse: 'prive' });
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-03-01', amount: -60_00, counterName: 'Shell Utrecht', description: 'Tanken' }] });
    const task = s.inbox.tasks('2026-03-02').find((t) => t.kind === 'bank-business');
    expect(task?.actions[0]).toMatchObject({ id: 'prive', primary: true });
    expect(task?.why).toMatch(/privéauto/);

    // zelfs een geleerde, automatische regel boekt tanken niet als zakelijk
    s.memory.learn('Shell Utrecht', { categoryKey: 'brandstof', vatCode: 'hoog', business: true });
    s.memory.learn('Shell Utrecht', { categoryKey: 'brandstof', vatCode: 'hoog', business: true });
    s.memory.setAutomatic('Shell Utrecht', true);
    expect(s.inbox.tasks('2026-03-02').find((t) => t.kind === 'bank-business')?.actions[0]?.id).toBe('prive');
    s.settings.update({ autopilot: 'maximaal' });
    s.inbox.autoProcess('2026-03-02');
    expect(s.bank.list({ status: 'nieuw' }).length).toBe(1);
  });
});

describe('jaaroverzicht en schatting', () => {
  it('KIA, representatie en waarschuwing voor brandstof bij een privéauto', () => {
    const { s } = setup();
    s.settings.update({ carUse: 'prive', startYear: 2025, startersaftrekUsed: { count: 1, asOfYear: 2026 } });
    s.quick.recordCashSale({ date: '2026-01-15', description: 'Stucwerk', grossAmount: 36300_00, vatCode: 'hoog', receivedWith: 'bank' });
    buy(s, '2026-02-10', 6050_00, 'Steigerwagen');
    s.quick.recordExpense({ date: '2026-03-01', supplierName: 'Café De Hoek', description: 'Lunch met klant', categoryKey: 'representatie', grossAmount: 100_00, vatCode: 'geen', paidWith: 'kas' });
    s.quick.recordExpense({ date: '2026-03-02', supplierName: 'Shell', description: 'Tanken', categoryKey: 'brandstof', grossAmount: 60_50, vatCode: 'hoog', paidWith: 'kas' });
    const o = s.taxOverview.year(2026, '2026-06-30');
    const item = (k: string) => o.items.find((i) => i.key === k);
    expect(item('kia')?.amount).toBe(-1400_00);
    expect(item('representatie')?.amount).toBe(20_00);
    expect(item('brandstof')?.status).toBe('warn');
    expect(item('startersaftrek')?.status).toBe('ok');
    expect(o.breakdown.kia).toBe(1400);
    expect(o.breakdown.startersaftrek).toBeGreaterThan(0);
    // afschrijving jan (feb–jun) zit al in de winst van het overzicht, niet geboekt
    expect(o.profitBooked - item('winst')!.amount!).toBe(Math.round((5000_00 * 5) / 60));

    const est = s.incomeTax.estimate('2026-06-30')!;
    expect(est.breakdown.kia).toBe(1400);
    expect(est.breakdown.startersaftrek).toBeGreaterThan(0);
  });

  it('signaal voor energie-investeringen met de RVO-termijn', () => {
    const { s } = setup();
    buy(s, '2026-05-01', 12100_00, 'Zonnepanelen werkplaats');
    const o = s.taxOverview.year(2026, '2026-06-01');
    expect(o.items.find((i) => i.key.startsWith('energie-'))?.explain).toMatch(/RVO/);
  });
});

describe('investeringen herkennen en aanbieden', () => {
  const f = <T,>(value: T) => ({ value, confidence: 0.9, source: 'ocr' as const });
  const doc = (supplier: string | null, lines: string[], total: number): DocumentResult => ({
    documentType: f('bon' as never),
    supplier: supplier ? f(supplier) : null,
    supplierVatNumber: null,
    supplierIban: null,
    invoiceNumber: null,
    invoiceDate: f('2026-03-01'),
    dueDate: null,
    currency: f('EUR'),
    subtotal: null,
    vat: f([{ rate: 21, base: null, amount: Math.round(total - (total * 100) / 121) }]),
    total: f(total),
    lineDescriptions: lines,
    reverseCharge: false,
    rawText: lines.join('\n'),
  });

  it('grens van € 450 is excl. btw (niet het bedrag op de bon)', async () => {
    const { s } = setup();
    // € 500 incl. = € 413 excl.: klein gereedschap
    expect((await s.classifier.classify(doc('Gamma', ['Makita boormachine'], 500_00))).categoryKey).toBe('gereedschap');
    // € 600 incl. = € 496 excl.: investering
    expect((await s.classifier.classify(doc('Gamma', ['Makita boormachine'], 600_00))).categoryKey).toBe('investering');
  });

  it('apparaten zoals een laptop worden herkend', async () => {
    const { s } = setup();
    expect((await s.classifier.classify(doc(null, ['Lenovo laptop 15 inch'], 900_00))).categoryKey).toBe('investering');
    expect((await s.classifier.classify(doc(null, ['Printer inktjet'], 120_00))).categoryKey).toBe('kantoor');
  });

  it('hint bij invoer: alleen vanaf € 450 excl. btw in een kandidaat-categorie', () => {
    expect(mightBeInvestment('kantoor', 600_00, 'hoog')).toBe(true);
    expect(mightBeInvestment('kantoor', 500_00, 'hoog')).toBe(false);
    expect(mightBeInvestment('materiaal', 2000_00, 'hoog')).toBe(false);
    expect(mightBeInvestment('overig', 450_00, 'geen')).toBe(true);
  });

  it('vangnet op Vandaag: € 450+ als kosten geboekt → "Was dit een investering?" → omzetten', () => {
    const { s } = setup();
    const p = s.quick.recordExpense({ date: '2026-03-01', supplierName: 'Coolblue', description: 'Laptop', categoryKey: 'kantoor', grossAmount: 1089_00, vatCode: 'hoog', paidWith: 'kas' });
    s.quick.recordExpense({ date: '2026-03-01', supplierName: 'Bruna', description: 'Papier', categoryKey: 'kantoor', grossAmount: 30_00, vatCode: 'hoog', paidWith: 'kas' });
    const tasks = s.inbox.tasks('2026-03-02').filter((t) => t.kind === 'investment-check');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.ref.purchaseId).toBe(p.id);

    s.investments.convert({ lineId: tasks[0]!.ref.lineId!, purchaseId: p.id, bankTransactionId: null });
    expect(s.inbox.tasks('2026-03-02').filter((t) => t.kind === 'investment-check')).toHaveLength(0);
    const [asset] = s.assets.list({}, '2026-03-02');
    expect(asset).toMatchObject({ cost: 900_00, name: 'Laptop' });
    expect(s.ledger.checkIntegrity().balanced).toBe(true);
  });

  it('vangnet werkt ook voor een banktransactie, en "nee" komt niet terug', () => {
    const { s } = setup();
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-03-01', amount: -726_00, counterName: 'Apple', description: 'iPhone' }] });
    const tx = s.bank.list({ status: 'nieuw' })[0]!;
    s.inbox.answerBank(tx.id, { business: true, categoryKey: 'telefoon', vatCode: 'hoog' });
    const task = s.inbox.tasks('2026-03-02').find((t) => t.kind === 'investment-check')!;
    expect(task.ref.bankTransactionId).toBe(tx.id);
    s.inbox.skipTask(task.key, 'gewone kosten');
    expect(s.inbox.tasks('2026-03-02').find((t) => t.kind === 'investment-check')).toBeUndefined();
  });
});

describe('thuis werken, meewerkende partner en AOV', () => {
  it('privédeel telefoon & internet telt bij de winst, met de btw-correctie', () => {
    const { s } = setup();
    s.settings.update({ phoneInternetBusinessPct: 50 });
    s.quick.recordExpense({ date: '2026-02-01', supplierName: 'KPN', description: 'Internet en mobiel', categoryKey: 'telefoon', grossAmount: 121_00, vatCode: 'hoog', paidWith: 'kas' });
    const adj = s.taxOverview.adjustments(2026, '2026-06-30');
    expect(adj.phonePrivate).toMatchObject({ costs: 100_00, pct: 50, bijtelling: 50_00, vat: 10_50 });
    const item = s.taxOverview.year(2026, '2026-06-30').items.find((i) => i.key === 'telefoon-prive');
    expect(item?.amount).toBe(50_00);
    expect(item?.explain).toMatch(/btw/);
  });

  it('meewerkaftrek naar uren van de partner, alleen met urencriterium', () => {
    const r = rulesFor(2026).rules;
    expect(meewerkaftrekFor(50000, 500, r)).toBe(0);
    expect(meewerkaftrekFor(50000, 600, r)).toBe(625);
    expect(meewerkaftrekFor(50000, 1800, r)).toBe(2000);
    expect(estimateIncomeTax(50000, r, { urencriterium: true, partnerHours: 900 }).meewerkaftrek).toBe(1000);
    expect(estimateIncomeTax(50000, r, { urencriterium: false, partnerHours: 900 }).meewerkaftrek).toBe(0);
  });

  it('AOV/pensioen: altijd de uitleg dat het privé is maar wel aftrekbaar in de aangifte', () => {
    const { s } = setup();
    expect(s.taxOverview.year(2026, '2026-06-30').items.find((i) => i.key === 'aov')?.explain).toMatch(/geen bedrijfskosten/);
  });
});
