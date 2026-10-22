import { describe, expect, it } from 'vitest';
import { BankPurchaseMatcher } from '../src/documents/bank-purchase-match';
import { setup } from './helpers';
import { createApi, type HostContext } from '../src/main/api';
import type { Task } from '../src/inbox/inbox';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import { allocateCents, defaultPartners, ownProfitSharePct, partnerAccounts, partnersProblem, type Partner } from '../src/shared/partners';
import { partnerEquityFrom } from '../src/onboarding/xaf-import';
import rgs from '../src/core-ledger/rgs-codes.json';
import { supplierKey } from '../src/intake/supplier-memory';
import { formatEuro } from '../src/shared/money';
import { sharesForYear, vofSetup } from '../src/closing/profit-allocation';

/**
 * Vof of maatschap met eigen vermogen per vennoot: instellen, privé per vennoot, winstverdeling bij de jaarafsluiting
 * en de balans per vennoot. Plus: een eenmanszaak en een bv blijven precies zoals ze waren.
 */

const ANNA_BRAM: Partner[] = [
  { no: 1, name: 'Anna', sharePct: 60 },
  { no: 2, name: 'Bram', sharePct: 40 },
];

type Ctx = ReturnType<typeof setup>;

function start(legalForm: 'vof' | 'eenmanszaak' | 'bv') {
  const ctx = setup();
  const api = createApi(ctx.s, { appVersion: () => 'test', reconfigureLocalAi: () => {}, updates: null } as unknown as HostContext);
  ctx.s.settings.update({ onboardingDone: true, legalForm, ...(legalForm === 'vof' ? { profitSharePct: 60 } : {}) });
  const bank = ctx.s.bank.ensureDefaultAccount();
  return { ...ctx, api, bank };
}

function tx(ctx: Ctx, date: string, amount: number, name: string) {
  ctx.s.bank.import({ source: 'csv', warnings: [], transactions: [{ date, amount, description: name, counterName: name }] });
  return ctx.s.bank.list().find((t) => t.transaction_date === date && t.amount === amount && t.counter_name === name)!;
}

/** de echte inbox-taak bij een bankregel: "Is dit zakelijk?" met de knop Privé */
function task(ctx: Ctx, bankTransactionId: number): Task {
  const t = ctx.s.inbox.tasks().find((x) => x.ref.bankTransactionId === bankTransactionId);
  expect(t?.kind).toBe('bank-business');
  expect(t!.actions.map((a) => a.id)).toContain('prive');
  return t!;
}

/** een jaar met omzet en kosten zonder btw-ruis: 10.000 omzet, 2.000 kosten = 8.000 winst */
function year(ctx: Ctx, y: number, omzet = 1_000_000, kosten = 200_000) {
  ctx.s.ledger.post({ date: `${y}-03-01`, description: 'Omzet', source: 'handmatig', lines: [{ account: ACCOUNTS.bank, debit: omzet }, { account: ACCOUNTS.omzetNul, credit: omzet }] });
  if (kosten) ctx.s.ledger.post({ date: `${y}-04-01`, description: 'Kosten', source: 'handmatig', lines: [{ account: ACCOUNTS.inkoopMaterialen, debit: kosten }, { account: ACCOUNTS.bank, credit: kosten }] });
}

const opening = (ctx: Ctx, date: string) => new Map(ctx.s.exports.openingBalance(date).map((o) => [o.code, o.amount]));
const code = (ctx: Ctx, rgsCode: string) => ctx.s.ledger.getAccount(rgsCode).code;
const balance = (ctx: Ctx, rgsCode: string, to?: string) => ctx.s.ledger.balances(to ? { to } : {}).find((b) => b.rgs_code === rgsCode)?.balance ?? 0;
const frozen = (ctx: Ctx) => ctx.db.prepare('SELECT jaar, vennoot, aandeel_bp AS bp FROM vof_winstverdeling ORDER BY jaar, vennoot').all();
const closeYear = (ctx: Ctx, y: number) => ctx.s.periods.close(`${y}-12-31`, ctx.s.periods.checks(`${y}-12-31`).map((c) => c.key), `${y + 1}-02-01`);

describe('vennoten instellen', () => {
  it('controleert aantal, namen en dat de aandelen samen 100% zijn', () => {
    expect(partnersProblem(ANNA_BRAM)).toBeNull();
    expect(partnersProblem([{ no: 1, name: 'Anna', sharePct: 60 }, { no: 2, name: 'Bram', sharePct: 39.99 }])).toMatch(/100/);
    expect(partnersProblem([{ no: 1, name: 'Anna', sharePct: 100 }])).toMatch(/2/);
    expect(partnersProblem(Array.from({ length: 6 }, (_, i) => ({ no: i + 1, name: `V${i + 1}`, sharePct: i < 5 ? 16 : 20 })))).toMatch(/5/);
    expect(partnersProblem([{ no: 1, name: 'Anna', sharePct: 50 }, { no: 2, name: 'anna', sharePct: 50 }])).not.toBeNull();
    expect(partnersProblem([{ no: 1, name: 'Anna', sharePct: 33.333 }, { no: 2, name: 'Bram', sharePct: 66.667 }])).not.toBeNull();
    expect(partnersProblem([{ no: 1, name: '', sharePct: 50 }, { no: 2, name: 'Bram', sharePct: 50 }])).not.toBeNull();
    expect(partnersProblem([{ no: 1, name: 'Anna', sharePct: 33.33 }, { no: 2, name: 'Bram', sharePct: 33.33 }, { no: 3, name: 'Cas', sharePct: 33.34 }])).toBeNull();
  });

  it('weigert vennoten bij een eenmanszaak of bv en een verdeling die niet optelt', () => {
    const t = start('vof');
    expect(() => t.s.settings.update({ partners: [{ no: 1, name: 'Anna', sharePct: 60 }, { no: 2, name: 'Bram', sharePct: 30 }], partnerAllocationFromYear: 2025 })).toThrow(/100/);
    expect(t.s.settings.get().partners).toEqual([]);
    const e = start('eenmanszaak');
    e.s.settings.update({ partners: ANNA_BRAM, partnerAllocationFromYear: 2025 });
    expect(e.s.settings.get().partners).toEqual([]);
  });

  it('neemt het oude winstaandeel over als voorstel', () => {
    expect(defaultPartners({ profitSharePct: 60, profile: { firstName: 'Anna' } })).toEqual([{ no: 1, name: 'Anna', sharePct: 60 }, { no: 2, name: 'Vennoot 2', sharePct: 40 }]);
    expect(defaultPartners({ profitSharePct: 100 }).map((p) => p.sharePct)).toEqual([50, 50]);
  });

  it('verdeelt centen exact, zonder dat er een cent bij komt of af gaat', () => {
    expect(allocateCents(10000, [3333, 3333, 3334])).toEqual([3333, 3333, 3334]);
    expect(allocateCents(1, [5000, 5000])).toEqual([1, 0]);
    expect(allocateCents(-1, [5000, 5000])).toEqual([-1, 0]);
    expect(allocateCents(100, [3333, 3333, 3334])).toEqual([33, 33, 34]);
    for (const amount of [0, 1, 7, 99, 100_001, -12_345, 987_654_321]) {
      for (const bps of [[6000, 4000], [3333, 3333, 3334], [1, 9999], [2000, 2000, 2000, 2000, 2000]]) {
        expect(allocateCents(amount, bps).reduce((a, b) => a + b, 0)).toBe(amount);
      }
    }
  });

  it('gebruikt de RGS-codes voor firmant 2 tot en met 5 en de bestaande rekeningen voor de eerste vennoot', () => {
    const codes = (rgs as { codes: Record<string, string> }).codes;
    expect(partnerAccounts(1)).toMatchObject({ capital: ACCOUNTS.eigenVermogen, drawings: ACCOUNTS.priveOpnamen, contributions: ACCOUNTS.priveStortingen });
    for (let no = 2; no <= 5; no++) {
      const k = partnerAccounts(no);
      expect(k).toMatchObject({ capital: `BEivKa${no}Ond`, drawings: `BEivKa${no}ProOvp`, contributions: `BEivKa${no}PrsOps` });
      expect(codes[`BEivKa${no}`]).toBe(`Eigen vermogen firmant ${no}`);
      for (const ref of [k.capitalRef, k.drawingsRef, k.contributionsRef]) expect(codes[ref], ref).toMatch(/eigen vermogen onderneming natuurlijke personen/);
    }
    for (const ref of ['BEivKapOnd', 'BEivKapProOvp', 'BEivKapPrsOps']) expect(codes[ref], ref).toBeTruthy();
    expect(codes.BEivKa1Ond).toBeUndefined();
    expect(() => partnerAccounts(6)).toThrow();
  });
});

describe('vof met twee vennoten (60/40), van instellen tot balans per vennoot', () => {
  it('instellen, privé per vennoot, jaarafsluiting met winstverdeling en eigen vermogen per vennoot', async () => {
    const t = start('vof');
    // bestaande administratie: één eigen vermogen, beginbalans 10.000
    t.s.ledger.post({ date: '2025-01-01', description: 'Beginbalans', source: 'opening', lines: [{ account: ACCOUNTS.bank, debit: 1_000_000 }, { account: ACCOUNTS.eigenVermogen, credit: 1_000_000 }] });
    expect(t.s.ledger.listAccounts().some((a) => a.rgs_code.startsWith('BEivKa2'))).toBe(false);

    // 1. instellen (zoals het scherm: het hele concept als patch)
    await t.api.settings.update({ ...t.s.settings.get(), partners: ANNA_BRAM, partnerAllocationFromYear: 2025, ibPartnerNo: 2 });
    const bram = partnerAccounts(2);
    for (const [key, c, name] of [[bram.capital, '0502', 'Eigen vermogen Bram'], [bram.drawings, '0512', 'Privé-opnamen Bram'], [bram.contributions, '0522', 'Privé-stortingen Bram']] as const) {
      expect(t.s.ledger.getAccount(key)).toMatchObject({ code: c, name, rgs_code: key, rgs_ref: key });
    }
    expect(t.s.ledger.getAccount(ACCOUNTS.eigenVermogen).name).toMatch(/Anna/);
    expect(t.s.settings.get().profitSharePct).toBe(40);
    // niets verschoven: het bestaande vermogen staat nog bij vennoot 1
    expect(balance(t, ACCOUNTS.eigenVermogen)).toBe(-1_000_000);
    expect(balance(t, bram.capital)).toBe(0);

    // expliciete keuze: 4.000 van het beginvermogen is van Bram (memoriaal)
    t.s.ledger.post({ date: '2025-01-01', description: 'Kapitaal Bram', source: 'handmatig', lines: [{ account: ACCOUNTS.eigenVermogen, debit: 400_000 }, { account: bram.capital, credit: 400_000 }] });
    year(t, 2025);

    // 2. privé per vennoot via de bank
    const annaOpname = tx(t, '2025-06-01', -150_000, 'Anna prive');
    expect(await t.api.home.act(task(t, annaOpname.id), 'prive')).toEqual({ navigate: { screen: 'vennoot-kiezen', id: annaOpname.id, extra: { actionId: 'prive' } } });
    expect(balance(t, ACCOUNTS.priveOpnamen)).toBe(0);
    await t.api.home.act(task(t, annaOpname.id), 'prive', { partnerNo: 1 });
    const bramOpname = tx(t, '2025-06-02', -50_000, 'Bram prive');
    await t.api.home.act(task(t, bramOpname.id), 'prive', { partnerNo: 2 });
    const bramStorting = tx(t, '2025-06-03', 25_000, 'Bram storting');
    await t.api.bank.book(bramStorting.id, { account: bram.contributions });
    expect(balance(t, ACCOUNTS.priveOpnamen)).toBe(150_000);
    expect(balance(t, bram.drawings)).toBe(50_000);
    expect(balance(t, bram.contributions)).toBe(-25_000);
    const wie = tx(t, '2025-06-04', -1_000, 'Wie');
    expect(() => t.s.inbox.answerBank(wie.id, { business: false, categoryKey: 'overig', vatCode: 'geen' })).toThrow(/vennoot/);
    t.s.inbox.answerBank(wie.id, { business: false, categoryKey: 'overig', vatCode: 'geen', partnerNo: 1 });
    expect(balance(t, ACCOUNTS.priveOpnamen)).toBe(151_000);

    // 3. jaarafsluiting: checklist noemt de verdeling, en het aandeel ligt daarna vast
    const checks = t.s.periods.checks('2025-12-31');
    expect(checks.map((c) => c.key)).toEqual(expect.arrayContaining(['prive-vennoten', 'winstverdeling']));
    closeYear(t, 2025);
    expect(frozen(t)).toEqual([{ jaar: 2025, vennoot: 1, bp: 6000 }, { jaar: 2025, vennoot: 2, bp: 4000 }]);

    // 4. beginbalans 2026: winst 8.000 verdeeld 4.800 / 3.200, privé naar de eigen kapitaalrekening
    // Anna 10.000 - 4.000 + 4.800 - 1.510 = 9.290; Bram 4.000 + 3.200 - 500 + 250 = 6.950
    const ob = opening(t, '2026-01-01');
    expect(ob.get(code(t, ACCOUNTS.eigenVermogen))).toBe(-929_000);
    expect(ob.get(code(t, bram.capital))).toBe(-695_000);
    for (const k of [ACCOUNTS.priveOpnamen, ACCOUNTS.priveStortingen, bram.drawings, bram.contributions]) expect(ob.get(code(t, k)) ?? 0).toBe(0);
    expect([...ob.values()].reduce((a, b) => a + b, 0)).toBe(0);
    const tb = t.s.ledgerReports.trialBalance('2026-01-01', '2026-12-31');
    expect(tb.rows.reduce((a, r) => a + r.opening, 0)).toBe(0);

    // 5. eigen vermogen per vennoot over 2025; eind = begin 2026
    const pe = t.s.ledgerReports.partnerEquity(2025)!;
    expect(pe.result).toBe(800_000);
    expect(pe.rows.map(({ no, name, sharePct, fixed, opening: o, other, contributions, drawings, profitShare, closing }) => ({ no, name, sharePct, fixed, o, other, contributions, drawings, profitShare, closing }))).toEqual([
      { no: 1, name: 'Anna', sharePct: 60, fixed: true, o: 1_000_000, other: -400_000, contributions: 0, drawings: 151_000, profitShare: 480_000, closing: 929_000 },
      { no: 2, name: 'Bram', sharePct: 40, fixed: true, o: 0, other: 400_000, contributions: 25_000, drawings: 50_000, profitShare: 320_000, closing: 695_000 },
    ]);
    expect(pe.totals.profitShare).toBe(pe.result);
    const next = t.s.ledgerReports.partnerEquity(2026)!;
    expect(next.rows.map((r) => r.opening)).toEqual([929_000, 695_000]);
    expect(next.rows[0]!.fixed).toBe(false);

    // 6. aandelen wijzigen raakt het afgesloten jaar niet; 2026 gaat met de nieuwe verdeling
    await t.api.settings.update({ ...t.s.settings.get(), partners: [{ no: 1, name: 'Anna', sharePct: 50 }, { no: 2, name: 'Bram', sharePct: 50 }] });
    expect(opening(t, '2026-01-01').get(code(t, bram.capital))).toBe(-695_000);
    year(t, 2026, 300_001, 0);
    const ob27 = opening(t, '2027-01-01');
    expect(ob27.get(code(t, ACCOUNTS.eigenVermogen))).toBe(-(929_000 + 150_001));
    expect(ob27.get(code(t, bram.capital))).toBe(-(695_000 + 150_000));
    expect(t.s.ledgerReports.partnerEquity(2026)!.rows.map((r) => r.closing)).toEqual([1_079_001, 845_000]);

    // 7. IB-schatting met het deel van de gekozen vennoot
    expect(ownProfitSharePct(t.s.settings.get())).toBe(50);
    const est = t.s.incomeTax.estimate('2026-06-30');
    expect(est!.assumptions.join(' ')).toMatch(/Bram/);
    expect(est!.profitToDate).toBe(Math.round(300_001 * 0.5));

    // 8. een vennoot met geschiedenis gaat er niet stilletjes uit, en de rechtsvorm wisselt niet zomaar
    expect(() => t.s.settings.update({ partners: [{ no: 1, name: 'Anna', sharePct: 100 }] })).toThrow();
    expect(() => t.s.settings.update({ legalForm: 'eenmanszaak' })).toThrow(/vennoot|boekhouder/i);
    expect(t.s.settings.get().partners).toHaveLength(2);
  });

  it('winst van jaren vóór "verdelen vanaf" blijft bij de eerste vennoot', async () => {
    const t = start('vof');
    year(t, 2025);
    await t.api.settings.update({ ...t.s.settings.get(), partners: ANNA_BRAM, partnerAllocationFromYear: 2026 });
    const ob = opening(t, '2026-01-01');
    expect(ob.get(code(t, ACCOUNTS.eigenVermogen))).toBe(-800_000);
    expect(ob.get(code(t, partnerAccounts(2).capital)) ?? 0).toBe(0);
    // een vennoot zonder boekingen en zonder winstdeel kan er nog uit
    await t.api.settings.update({ ...t.s.settings.get(), partners: [{ no: 1, name: 'Anna', sharePct: 100 }, { no: 2, name: 'Bram', sharePct: 0 }] });
    await t.api.settings.update({ ...t.s.settings.get(), legalForm: 'eenmanszaak' });
    expect(t.s.settings.get().partners).toEqual([]);
  });

  it('een vof zonder vennoten werkt precies als voorheen', async () => {
    const t = start('vof');
    year(t, 2025);
    const opname = tx(t, '2025-06-01', -150_000, 'Prive');
    expect(await t.api.home.act(task(t, opname.id), 'prive')).toBeUndefined();
    expect(balance(t, ACCOUNTS.priveOpnamen)).toBe(150_000);
    expect(opening(t, '2026-01-01').get(code(t, ACCOUNTS.eigenVermogen))).toBe(-650_000);
    expect(t.s.ledgerReports.partnerEquity(2025)).toBeNull();
    expect(ownProfitSharePct(t.s.settings.get())).toBe(60);
    closeYear(t, 2025);
    expect(frozen(t)).toEqual([]);
  });

  it('overstappen: beginkapitaal per vennoot, opnieuw opslaan draait terug', async () => {
    const t = start('vof');
    await t.api.settings.update({ ...t.s.settings.get(), partners: ANNA_BRAM, partnerAllocationFromYear: 2026 });
    t.s.switchover.setMode('overstapper', '2026-01-01');
    t.s.switchover.setBankOpening(t.bank.id, 500_000);
    await t.api.switchover.setPartnerEquity([{ no: 2, amount: 200_000 }]);
    let pos = t.s.switchover.position();
    expect(pos!.perVennoot).toEqual([{ no: 1, name: 'Anna', amount: 300_000 }, { no: 2, name: 'Bram', amount: 200_000 }]);
    t.s.switchover.setPartnerEquity([{ no: 2, amount: 100_000 }]);
    pos = t.s.switchover.position();
    expect(pos!.perVennoot).toEqual([{ no: 1, name: 'Anna', amount: 400_000 }, { no: 2, name: 'Bram', amount: 100_000 }]);
    expect(balance(t, ACCOUNTS.eigenVermogen) + balance(t, partnerAccounts(2).capital)).toBe(-500_000);
    expect(() => t.s.switchover.setPartnerEquity([{ no: 1, amount: 1 }])).toThrow();
    expect(() => t.s.switchover.setPartnerEquity([{ no: 3, amount: 1 }])).toThrow();
  });

  it('auditfile: kapitaal van firmant 2 en verder herkend op RGS-code', () => {
    expect(partnerEquityFrom([
      { rgs: 'BEivKapOnd', balance: -500_000 },
      { rgs: 'BEivKa2Ond', balance: -300_000 },
      { rgs: 'BEivKa2ProOvp', balance: 20_000 },
      { rgs: 'BEivKa3Ond', balance: 0 },
      { rgs: null, balance: 5 },
    ])).toEqual([{ no: 2, amount: 280_000 }]);
  });
});

describe('vof met vennoten: randgevallen uit de review', () => {
  it('een leverancier die "voortaan automatisch privé" is, blijft een vraag: de app weet niet welke vennoot', async () => {
    const t = start('vof');
    await t.api.settings.update({ ...t.s.settings.get(), partners: ANNA_BRAM, partnerAllocationFromYear: 2025, autopilot: 'maximaal' });
    for (const [date, amount] of [['2025-05-01', -1_000], ['2025-05-02', -1_100]] as const) {
      const b = tx(t, date, amount, 'Bakker');
      t.s.inbox.answerBank(b.id, { business: false, categoryKey: 'overig', vatCode: 'geen', partnerNo: 2 });
    }
    // geen aanbod om privé voortaan vanzelf te doen
    expect(t.s.inbox.tasks('2025-05-03').some((x) => x.kind === 'supplier-auto')).toBe(false);
    // ook als de regel (bv. van vóór de vennoten) al automatisch staat: niet stil overgeslagen, maar de vraag
    t.s.memory.setAutomatic(supplierKey('Bakker'), true);
    const next = tx(t, '2025-05-10', -1_200, 'Bakker');
    expect(t.s.inbox.autoProcess('2025-05-11').booked).toBe(0);
    expect(t.s.bank.get(next.id).status).toBe('nieuw');
    expect(t.s.inbox.tasks('2025-05-11').some((x) => x.ref.bankTransactionId === next.id)).toBe(true);
    expect(balance(t, partnerAccounts(2).drawings)).toBe(2_100);
  });

  it('een uitwisseling die wordt afgebroken, legt de winstverdeling van het weer open jaar niet vast', async () => {
    const t = start('vof');
    await t.api.settings.update({ ...t.s.settings.get(), partners: ANNA_BRAM, partnerAllocationFromYear: 2024 });
    year(t, 2024);
    year(t, 2025);
    closeYear(t, 2024);
    t.s.periods.startExchange('2025-12-31', 1, t.s.periods.checks('2025-12-31').map((c) => c.key), '2026-02-01');
    expect(frozen(t)).toEqual([{ jaar: 2024, vennoot: 1, bp: 6000 }, { jaar: 2024, vennoot: 2, bp: 4000 }, { jaar: 2025, vennoot: 1, bp: 6000 }, { jaar: 2025, vennoot: 2, bp: 4000 }]);
    t.s.periods.abortExchange();
    // 2024 is afgesloten en blijft vast; 2025 is weer open
    expect(frozen(t)).toEqual([{ jaar: 2024, vennoot: 1, bp: 6000 }, { jaar: 2024, vennoot: 2, bp: 4000 }]);
    await t.api.settings.update({ ...t.s.settings.get(), partners: [{ no: 1, name: 'Anna', sharePct: 50 }, { no: 2, name: 'Bram', sharePct: 50 }] });
    expect(sharesForYear(t.db, vofSetup(t.db), 2025)).toEqual([{ no: 1, bp: 5000 }, { no: 2, bp: 5000 }]);
    expect(sharesForYear(t.db, vofSetup(t.db), 2024)).toEqual([{ no: 1, bp: 6000 }, { no: 2, bp: 4000 }]);
  });

  it('vennoten met geschiedenis kunnen niet van plaats wisselen; een naam aanpassen kan wel', async () => {
    const t = start('vof');
    const three: Partner[] = [{ no: 1, name: 'Anna', sharePct: 50 }, { no: 2, name: 'Bram', sharePct: 25 }, { no: 3, name: 'Carla', sharePct: 25 }];
    await t.api.settings.update({ ...t.s.settings.get(), partners: three, partnerAllocationFromYear: 2025 });
    const b = tx(t, '2025-06-02', -50_000, 'Bram prive');
    t.s.inbox.answerBank(b.id, { business: false, categoryKey: 'overig', vatCode: 'geen', partnerNo: 2 });
    const swapped = [three[0]!, { ...three[1]!, name: 'Carla' }, { ...three[2]!, name: 'Bram' }];
    expect(() => t.s.settings.update({ partners: swapped })).toThrow(/vennoot 2/);
    // alleen Carla's naam op plaats 2 zetten (Bram "weghalen" door overschrijven) kan ook niet
    expect(() => t.s.settings.update({ partners: [three[0]!, { ...three[1]!, name: 'Carla' }, { ...three[2]!, name: 'Dirk' }] })).toThrow(/vennoot 2/);
    expect(t.s.settings.get().partners.map((p) => p.name)).toEqual(['Anna', 'Bram', 'Carla']);
    await t.api.settings.update({ ...t.s.settings.get(), partners: [three[0]!, { ...three[1]!, name: 'Bram de Vries' }, three[2]!] });
    expect(t.s.ledger.getAccount(partnerAccounts(2).drawings).name).toBe('Privé-opnamen Bram de Vries');
  });

  it('een naam die tijdens een uitwisseling verandert, komt daarna op de rekeningen', async () => {
    const t = start('vof');
    await t.api.settings.update({ ...t.s.settings.get(), partners: ANNA_BRAM, partnerAllocationFromYear: 2025 });
    year(t, 2025);
    t.s.periods.startExchange('2025-12-31', 1, t.s.periods.checks('2025-12-31').map((c) => c.key), '2026-02-01');
    await t.api.settings.update({ ...t.s.settings.get(), partners: [ANNA_BRAM[0]!, { ...ANNA_BRAM[1]!, name: 'Bram de Vries' }] });
    expect(t.s.ledger.getAccount(partnerAccounts(2).capital).name).toBe('Eigen vermogen Bram');
    t.s.periods.abortExchange();
    expect(t.s.ledger.getAccount(partnerAccounts(2).capital).name).toBe('Eigen vermogen Bram de Vries');
    // en ook na een afgeronde uitwisseling
    t.s.periods.startExchange('2025-12-31', 2, t.s.periods.checks('2025-12-31').map((c) => c.key), '2026-02-01');
    await t.api.settings.update({ ...t.s.settings.get(), partners: [ANNA_BRAM[0]!, { ...ANNA_BRAM[1]!, name: 'Bram' }] });
    t.s.periods.finishExchange(2);
    expect(t.s.ledger.getAccount(partnerAccounts(2).capital).name).toBe('Eigen vermogen Bram');
  });

  it('de afsluitcheck en het overzicht per vennoot noemen dezelfde winst en dezelfde delen', async () => {
    const t = start('vof');
    await t.api.settings.update({ ...t.s.settings.get(), partners: [{ no: 1, name: 'Anna', sharePct: 33.33 }, { no: 2, name: 'Bram', sharePct: 33.33 }, { no: 3, name: 'Carla', sharePct: 33.34 }], partnerAllocationFromYear: 2025 });
    year(t, 2025, 1_000_001, 0);
    const check = t.s.periods.checks('2025-12-31').find((c) => c.key === 'winstverdeling')!;
    const pe = t.s.ledgerReports.partnerEquity(2025)!;
    expect(pe.result).toBe(1_000_001);
    expect(pe.rows.map((r) => r.profitShare)).toEqual([333_300, 333_300, 333_401]);
    expect(check.title).toContain(formatEuro(1_000_001));
    expect(check.title).toContain('winst');
    for (const r of pe.rows) expect(check.detail).toContain(`${r.name} ${r.sharePct.toLocaleString('nl-NL')}%: ${formatEuro(r.profitShare)}`);
    // verlies: zelfde verdeling met het andere teken
    const v = start('vof');
    await v.api.settings.update({ ...v.s.settings.get(), partners: ANNA_BRAM, partnerAllocationFromYear: 2025 });
    year(v, 2025, 100_000, 200_001);
    const loss = v.s.periods.checks('2025-12-31').find((c) => c.key === 'winstverdeling')!;
    expect(loss.title).toContain('verlies');
    expect(v.s.ledgerReports.partnerEquity(2025)!.rows.map((r) => r.profitShare)).toEqual([-60_001, -40_000]);
    expect(loss.detail).toContain(`Anna 60%: ${formatEuro(-60_001)}`);
  });

  it('zonder "verdelen vanaf" in de administratie blijft alle winst bij de eerste vennoot, los van de datum van vandaag', async () => {
    const t = start('vof');
    await t.api.settings.update({ ...t.s.settings.get(), partners: ANNA_BRAM, partnerAllocationFromYear: 2025 });
    t.db.prepare(`UPDATE settings SET value = 'null' WHERE key = 'partnerAllocationFromYear'`).run();
    year(t, 2025);
    expect(sharesForYear(t.db, vofSetup(t.db), 2025)).toEqual([{ no: 1, bp: 10000 }]);
    expect(sharesForYear(t.db, vofSetup(t.db), new Date().getFullYear())).toEqual([{ no: 1, bp: 10000 }]);
  });

  it('betaling aan je eigen bedrijf zonder factuur kan privé van elke vennoot zijn', async () => {
    const t = start('vof');
    await t.api.settings.update({ ...t.s.settings.get(), partners: ANNA_BRAM, partnerAllocationFromYear: 2025 });
    const own = tx(t, '2025-06-05', -1_089, 'STUKADOORSBEDRIJF PIET');
    expect(t.s.inbox.needsPartnerChoice()).toBe(true);
    await t.api.bank.book(own.id, { account: partnerAccounts(2).drawings });
    expect(t.s.bank.get(own.id).status).toBe('gematcht');
    expect(balance(t, partnerAccounts(2).drawings)).toBe(1_089);
  });
});

describe('privé per vennoot ook buiten de bank: nooit stil bij de eerste vennoot', () => {
  const bram = partnerAccounts(2);
  /** vof met Anna en Bram; het totaal aan journaalregels, om te zien dat een weigering niets boekt */
  async function vof() {
    const t = start('vof');
    await t.api.settings.update({ ...t.s.settings.get(), partners: ANNA_BRAM, partnerAllocationFromYear: 2026 });
    const lines = () => (t.db.prepare('SELECT COUNT(*) AS n FROM journal_lines').get() as { n: number }).n;
    return { ...t, lines };
  }

  it('oude gemengde aankopen: omrekenen weigert zonder vennoot en behoudt een gekozen vennoot', async () => {
    const t = start('vof');
    const p = t.s.purchases.create({ invoiceDate: '2026-03-01', description: 'Oude aankoop', businessPct: 50, lines: [{ account: ACCOUNTS.inkoopMaterialen, netAmount: 10000, vatCode: 'geen' }] });
    await t.api.settings.update({ ...t.s.settings.get(), partners: ANNA_BRAM, partnerAllocationFromYear: 2026 });
    const entries = t.db.prepare('SELECT * FROM journal_entries').all();
    expect(() => t.s.purchases.revalue(p.id, 20000, { currency: 'USD', total: 25000 })).toThrow(/vennoot/);
    expect(t.db.prepare('SELECT * FROM journal_entries').all()).toEqual(entries);
    expect(t.s.purchases.get(p.id).total).toBe(10000);
    t.s.purchases.setBusinessPct(p.id, 50, undefined, 2);
    t.s.purchases.revalue(p.id, 20000, { currency: 'USD', total: 25000 });
    expect(balance(t, bram.drawings)).toBe(10000);
    expect(balance(t, ACCOUNTS.priveOpnamen)).toBe(0);
  });

  it('oude gemengde bankboeking: herindelen vraagt ook zonder nieuw percentage een vennoot', async () => {
    const t = start('vof');
    const b = tx(t, '2026-03-01', -10000, 'Testwinkel');
    t.s.bank.bookToAccount(b.id, { account: ACCOUNTS.inkoopMaterialen, vatCode: 'geen', businessPct: 50 });
    await t.api.settings.update({ ...t.s.settings.get(), partners: ANNA_BRAM, partnerAllocationFromYear: 2026 });
    const entries = t.db.prepare('SELECT * FROM journal_entries').all();
    expect(() => t.s.bank.reclassify(b.id, { account: ACCOUNTS.inkoopMaterialen, description: 'Correctie' })).toThrow(/vennoot/);
    expect(t.db.prepare('SELECT * FROM journal_entries').all()).toEqual(entries);
    t.s.bank.reclassify(b.id, { account: ACCOUNTS.inkoopMaterialen, partnerNo: 2 });
    expect(balance(t, bram.drawings)).toBe(5000);
    expect(balance(t, ACCOUNTS.priveOpnamen)).toBe(0);
  });

  it.each([1, 2, 3, 4, 5])('privé betaald door vennoot %i blijft herkenbaar en kan met de bank worden samengevoegd', async (partnerNo) => {
    const t = start('vof');
    await t.api.settings.update({ ...t.s.settings.get(), partners: Array.from({ length: 5 }, (_, i) => ({ no: i + 1, name: `Vennoot ${i + 1}`, sharePct: 20 })), partnerAllocationFromYear: 2026 });
    const p = t.s.quick.recordExpense({ date: '2026-03-05', supplierName: 'Testwinkel', description: 'Verf', categoryKey: 'materiaal', grossAmount: 12100, vatCode: 'hoog', paidWith: 'prive', partnerNo });
    const matcher = new BankPurchaseMatcher(t.db);
    expect(matcher.elsewherePayments(p.id)).toHaveLength(1);
    expect(matcher.entry(p.id)?.state).toBe('elders');
    const b = tx(t, '2026-03-05', -12100, 'Testwinkel');
    t.s.bank.bookToAccount(b.id, { account: ACCOUNTS.inkoopMaterialen, vatCode: 'hoog' });
    expect(t.s.bookedPayments.candidates().map((c) => c.purchase.id)).toContain(p.id);
    t.s.bookedPayments.resolve(p.id, b.id, '2026-03-05');
    expect(balance(t, ACCOUNTS.inkoopMaterialen)).toBe(10000);
    expect(balance(t, partnerAccounts(partnerNo).contributions)).toBe(0);
    expect(t.s.bookedPayments.candidates()).toEqual([]);
  });

  it('weer volledig zakelijk verwijdert ook de onthouden vennoot', async () => {
    const t = await vof();
    t.s.businessShare.set('Testwinkel', 50, { partnerNo: 1 });
    t.s.businessShare.set('Testwinkel', 100);
    expect(t.db.prepare('SELECT * FROM supplier_business_share_partner').all()).toEqual([]);
    expect(() => t.s.businessShare.set('Testwinkel', 50)).toThrow(/vennoot/);
    t.s.businessShare.set('Testwinkel', 50, { partnerNo: 2 });
    t.s.quick.recordExpense({ date: '2026-03-05', supplierName: 'Testwinkel', description: 'Verf', categoryKey: 'materiaal', grossAmount: 10000, vatCode: 'geen', paidWith: 'bank' });
    expect(balance(t, bram.drawings)).toBe(5000);
    expect(balance(t, ACCOUNTS.priveOpnamen)).toBe(0);
  });

  it('kilometers: de vergoeding is een privé-storting van wie reed', async () => {
    const t = await vof();
    const before = t.lines();
    expect(() => t.s.mileage.add({ date: '2026-03-02', km: 100, description: 'Klant Utrecht' })).toThrow(/vennoot/);
    expect(t.lines()).toBe(before);
    const trip = await t.api.mileage.add({ date: '2026-03-02', km: 100, description: 'Klant Utrecht', partnerNo: 2 });
    expect(balance(t, bram.contributions)).toBe(-trip.amount);
    expect(balance(t, ACCOUNTS.priveStortingen)).toBe(0);
  });

  it('snelle invoer: privé betaald, betaald met privégeld en privé opname of storting', async () => {
    const t = await vof();
    const input = { date: '2026-03-05', supplierName: 'Gamma', description: 'Verf', categoryKey: 'materiaal', grossAmount: 12100, vatCode: 'hoog' as const, paidWith: 'prive' as const };
    const before = t.lines();
    expect(() => t.s.quick.recordExpense(input)).toThrow(/vennoot/);
    expect(t.lines()).toBe(before);
    expect(t.s.purchases.list()).toEqual([]);
    t.s.quick.recordExpense({ ...input, partnerNo: 2 });
    expect(balance(t, bram.contributions)).toBe(-12100);
    // een open aankoop "privé betaald, voortaan altijd": de vennoot wordt bij de leverancier onthouden
    const open = t.s.quick.recordExpense({ ...input, supplierName: 'KPN', grossAmount: 6050, paidWith: 'bank' });
    expect(() => t.s.quick.payPurchaseWith(open.id, 'prive')).toThrow(/vennoot/);
    t.s.quick.payPurchaseWith(open.id, 'prive', { always: true, partnerNo: 2 });
    expect(balance(t, bram.contributions)).toBe(-(12100 + 6050));
    expect(t.s.relations.paidWithPartner(open.relation_id!)).toBe(2);
    // geld uit de kas privé opgenomen
    expect(() => t.s.quick.recordPrivate('opname', 5000, '2026-03-06', 'kas')).toThrow(/vennoot/);
    await t.api.quick.privateTransfer('opname', 5000, '2026-03-06', 'kas', 2);
    expect(balance(t, bram.drawings)).toBe(5000);
    expect(balance(t, ACCOUNTS.priveOpnamen) + balance(t, ACCOUNTS.priveStortingen)).toBe(0);
  });

  it('gemengd gebruik: het privédeel gaat naar de vennoot die bij de leverancier onthouden is', async () => {
    const t = await vof();
    const telefoon = (businessPct?: number, partnerNo?: number) =>
      t.s.purchases.create({ relationId: t.s.relations.findOrCreateSupplier('Telefoonwinkel').id, invoiceDate: '2026-04-01', description: 'Telefoon', lines: [{ account: ACCOUNTS.inkoopMaterialen, netAmount: 10000, vatCode: 'hoog' }], ...(businessPct !== undefined ? { businessPct } : {}), ...(partnerNo !== undefined ? { partnerNo } : {}) });
    expect(() => telefoon(60)).toThrow(/vennoot/);
    expect(t.s.purchases.list()).toEqual([]);
    telefoon(60, 2);
    // 40% privé van 100 + 21 btw = 48,40 op de privé-opnamen van Bram
    expect(balance(t, bram.drawings)).toBe(4840);
    // de volgende aankoop bij die leverancier: hetzelfde zakelijke deel en dezelfde vennoot, zonder te vragen
    telefoon();
    expect(balance(t, bram.drawings)).toBe(9680);
    expect(balance(t, ACCOUNTS.priveOpnamen)).toBe(0);
    // een ander zakelijk deel voor een geboekte aankoop houdt de vennoot
    const first = t.s.purchases.list().sort((a, b) => a.id - b.id)[0]!;
    t.s.purchases.setBusinessPct(first.id, 50);
    expect(balance(t, bram.drawings)).toBe(4840 + 6050);
    expect(balance(t, ACCOUNTS.priveOpnamen)).toBe(0);
  });

  it('een bedrijfsmiddel naar privé: van welke vennoot', async () => {
    const t = await vof();
    t.s.purchases.create({ invoiceDate: '2026-01-10', description: 'Laptop', lines: [{ account: ACCOUNTS.inventaris, netAmount: 200000, vatCode: 'geen' }] });
    const asset = t.s.assets.list()[0]!;
    expect(() => t.s.assets.dispose(asset.id, '2026-06-30', 50000, 'prive')).toThrow(/vennoot/);
    await t.api.assets.dispose(asset.id, '2026-06-30', 50000, 'prive', 2);
    expect(balance(t, bram.drawings)).toBe(50000);
    expect(balance(t, ACCOUNTS.priveOpnamen)).toBe(0);
  });

  it('een bon: privé betaald en een privé-deel van de bon gaan naar de gekozen vennoot', async () => {
    let lines = ['Bouwmaat Utrecht', 'Datum: 02-03-2026', 'Gips 100,00', 'Subtotaal 100,00', 'BTW 21% 100,00 21,00', 'Totaal 121,00'];
    const provider = { id: 'test', label: 'Test', available: async () => true, recognize: async () => ({ items: lines.map((text, i) => ({ text, page: 1, bbox: [10, 20 + i * 20, 300, 34 + i * 20] as [number, number, number, number], confidence: 0.97 })) }) };
    const ctx = setup({ ocr: provider });
    const api = createApi(ctx.s, { appVersion: () => 'test', reconfigureLocalAi: () => {}, updates: null } as unknown as HostContext);
    ctx.s.settings.update({ onboardingDone: true, legalForm: 'vof' });
    await api.settings.update({ ...ctx.s.settings.get(), partners: ANNA_BRAM, partnerAllocationFromYear: 2026 });
    const c = { supplier: 'Bouwmaat', date: '2026-03-02', total: 12100, categoryKey: 'materiaal', vatCode: 'hoog' as const, business: true, paidWith: 'prive' as const };
    const d = await ctx.s.intake.add('bon.jpg', new Uint8Array([1]), '2026-03-03');
    expect(() => ctx.s.intake.confirm(d.id, c)).toThrow(/vennoot/);
    expect(ctx.s.purchases.list()).toEqual([]);
    ctx.s.intake.confirm(d.id, { ...c, partnerNo: 2 });
    expect(ctx.s.ledger.balance(bram.contributions)).toBe(-12100);
    // een bon met een privé-deel
    lines = ['Praxis Zeist', 'Datum: 09-03-2026', 'Verf 100,00', 'Subtotaal 100,00', 'BTW 21% 100,00 21,00', 'Totaal 121,00'];
    const e = await ctx.s.intake.add('bon2.jpg', new Uint8Array([2]), '2026-03-10');
    ctx.s.intake.confirm(e.id, { ...c, supplier: 'Praxis', date: '2026-03-09', paidWith: 'kas', splits: [{ categoryKey: 'materiaal', gross: 10000 }, { categoryKey: 'prive', gross: 2100 }], partnerNo: 2 });
    expect(ctx.s.ledger.balance(bram.drawings)).toBe(2100);
    expect(ctx.s.ledger.balance(ACCOUNTS.priveOpnamen) + ctx.s.ledger.balance(ACCOUNTS.priveStortingen)).toBe(0);

    // "deze betaal ik altijd privé": zonder onthouden vennoot blijft de aankoop open, met vennoot is hij betaald door die vennoot
    const hornbach = ctx.s.relations.findOrCreateSupplier('Hornbach');
    ctx.s.relations.setPaidWith(hornbach.id, 'prive');
    const bonVan = async (day: string, file: string, euro: number) => {
      lines = ['Hornbach', `Datum: ${day}-03-2026`, `Hout ${euro},00`, `Subtotaal ${euro},00`, `BTW 21% ${euro},00 ${euro * 0.21},00`, `Totaal ${euro * 1.21},00`];
      const doc = await ctx.s.intake.add(file, new Uint8Array([Number(day)]), '2026-03-20');
      ctx.s.intake.confirm(doc.id, { ...c, supplier: 'Hornbach', date: `2026-03-${day}`, total: euro * 121, paidWith: 'later' });
      return ctx.s.purchases.list().find((p) => p.document_id === doc.id)!;
    };
    expect((await bonVan('11', 'h1.jpg', 100)).status).toBe('open');
    ctx.s.relations.setPaidWith(hornbach.id, 'prive', 2);
    expect((await bonVan('12', 'h2.jpg', 200)).status).toBe('betaald');
    expect(ctx.s.ledger.balance(bram.contributions)).toBe(-(12100 + 24200));
  });

  it('verlegde btw met een privédeel: telt in de btw-aangifte mee, welke vennoot het ook is', async () => {
    const run = async (partnerNo: number) => {
      const t = await vof();
      t.s.quick.recordExpense({ date: '2026-04-15', supplierName: 'Onderaannemer Klaas', description: 'Inhuur', categoryKey: 'onderaannemer', grossAmount: 100000, vatCode: 'verlegd', paidWith: 'bank', businessPct: 50, partnerNo });
      const r = t.s.vat.calculate('2026-Q2');
      return Object.fromEntries(r.rubrieken.map((x) => [x.code, { omzet: x.omzet, btw: x.btw }]));
    };
    expect(await run(2)).toEqual(await run(1));
    expect((await run(2))['2a']).toEqual({ omzet: 100000, btw: 21000 });
  });

  it('op Vandaag: privé bij een verkoop aan je eigen bedrijf of een factuur van je eigen bedrijf vraagt eerst welke vennoot', async () => {
    const t = await vof();
    const own = tx(t, '2026-03-01', -1_089, 'STUKADOORSBEDRIJF PIET');
    for (const [kind, actionId] of [['sale-own-company', 'neutraal'], ['document-review', 'prive'], ['bank-own-company', 'prive']] as const) {
      const ref = kind === 'bank-own-company' ? { bankTransactionId: own.id } : { questionId: 1, documentId: 1 };
      const r = await t.api.home.act({ key: 'x', kind, icon: '', title: '', question: '', actions: [], ref } as Task, actionId);
      expect(r).toEqual({ navigate: { screen: 'vennoot-kiezen', ...(kind === 'bank-own-company' ? { id: own.id } : {}), extra: { actionId } } });
    }
    // met de keuze: privé van Bram
    await t.api.home.act({ key: 'x', kind: 'bank-own-company', icon: '', title: '', question: '', actions: [], ref: { bankTransactionId: own.id } } as Task, 'prive', { partnerNo: 2 });
    expect(balance(t, bram.drawings)).toBe(1_089);
  });

  it('eenmanszaak: alles zoals altijd, zonder vennoot', async () => {
    const t = start('eenmanszaak');
    t.s.mileage.add({ date: '2026-03-02', km: 10, description: 'Rit' });
    t.s.quick.recordExpense({ date: '2026-03-05', supplierName: 'Gamma', description: 'Verf', categoryKey: 'materiaal', grossAmount: 12100, vatCode: 'hoog', paidWith: 'prive' });
    t.s.quick.recordPrivate('opname', 5000, '2026-03-06', 'kas');
    t.s.purchases.create({ relationId: t.s.relations.findOrCreateSupplier('Telefoonwinkel').id, invoiceDate: '2026-04-01', description: 'Telefoon', lines: [{ account: ACCOUNTS.inkoopMaterialen, netAmount: 10000, vatCode: 'hoog' }], businessPct: 60 });
    expect(balance(t, ACCOUNTS.priveStortingen)).toBe(-(t.s.mileage.list(2026)[0]!.amount + 12100));
    expect(balance(t, ACCOUNTS.priveOpnamen)).toBe(5000 + 4840);
    const event = t.db.prepare(`SELECT payload FROM events WHERE type = 'inkoop' ORDER BY id DESC LIMIT 1`).get() as { payload: string };
    expect(JSON.parse(event.payload).privateAccount).toBeUndefined();
  });
});

describe('eenmanszaak en bv blijven ongewijzigd', () => {
  for (const legalForm of ['eenmanszaak', 'bv'] as const) {
    it(`${legalForm}: geen vennootrekeningen, privé direct, één eigen vermogen, niets vastgelegd`, async () => {
      const t = start(legalForm);
      await t.api.settings.update({ ...t.s.settings.get() });
      const before = t.s.ledger.listAccounts(true).map((a) => [a.code, a.rgs_code, a.name]);
      await t.api.settings.update({ ...t.s.settings.get(), partners: ANNA_BRAM, partnerAllocationFromYear: 2025 });
      expect(t.s.settings.get().partners).toEqual([]);
      expect(t.s.ledger.listAccounts(true).map((a) => [a.code, a.rgs_code, a.name])).toEqual(before);
      expect(t.s.inbox.needsPartnerChoice()).toBe(false);
      t.s.ledger.post({ date: '2025-01-01', description: 'Beginbalans', source: 'opening', lines: [{ account: ACCOUNTS.bank, debit: 1_000_000 }, { account: ACCOUNTS.eigenVermogen, credit: 1_000_000 }] });
      year(t, 2025);
      if (legalForm === 'eenmanszaak') {
        const opname = tx(t, '2025-06-01', -150_000, 'Prive');
        expect(await t.api.home.act(task(t, opname.id), 'prive')).toBeUndefined();
        expect(balance(t, ACCOUNTS.priveOpnamen)).toBe(150_000);
      }
      closeYear(t, 2025);
      expect(frozen(t)).toEqual([]);
      const ob = opening(t, '2026-01-01');
      const equity = legalForm === 'eenmanszaak' ? -(1_000_000 + 800_000 - 150_000) : -(1_000_000 + 800_000);
      const equityCodes = [...ob.entries()].filter(([c]) => c.startsWith('05'));
      expect(equityCodes.reduce((a, [, v]) => a + v, 0)).toBe(equity);
      expect([...ob.values()].reduce((a, b) => a + b, 0)).toBe(0);
      expect(t.s.ledgerReports.partnerEquity(2025)).toBeNull();
      expect(t.s.periods.checks('2025-12-31').map((c) => c.key)).not.toContain('winstverdeling');
    });
  }
});
