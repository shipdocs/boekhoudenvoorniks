import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { ACCOUNTS } from '../src/core-ledger/accounts';

describe('rapporten voor de boekhouder', () => {
  function scenario() {
    const { s, klant } = setup();
    // factuur 1.000 + 21%, betaald; inkoop 200 + 21%, onbetaald
    const inv = s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-02-10', lines: [{ description: 'x', quantity: 1, unitPrice: 100000, vatCode: 'hoog' }] }).id);
    s.invoices.registerPayment(inv.id, { amount: 121000, date: '2026-03-05' });
    const rel = s.relations.findOrCreateSupplier('Gamma');
    s.purchases.create({ relationId: rel.id, invoiceDate: '2026-04-02', description: 'Materiaal', lines: [{ account: 'WKprInkMat', netAmount: 20000, vatCode: 'hoog' }] });
    return { s, klant, rel, inv };
  }

  it('kolommenbalans: debet = credit, beginbalans en eindsaldo per rekening', () => {
    const { s } = scenario();
    const tb = s.ledgerReports.trialBalance('2026-04-01', '2026-06-30');
    expect(tb.balanced).toBe(true);
    const bank = tb.rows.find((r) => r.name === 'Bank')!;
    // 1e kwartaal: 1.210 ontvangen = beginbalans van Q2
    expect(bank).toMatchObject({ kind: 'balans', opening: 121000, debit: 0, credit: 0, closing: 121000 });
    const omzet = tb.rows.find((r) => r.category === 'omzet');
    expect(omzet).toBeUndefined(); // niets omgezet in Q2
    const kosten = tb.rows.find((r) => r.rgs === 'WKprInkMat')!;
    // resultaatrekeningen beginnen elke periode op nul
    expect(kosten).toMatchObject({ kind: 'resultaat', opening: 0, debit: 20000, closing: 20000 });
    const jaar = s.ledgerReports.trialBalance('2026-01-01', '2026-12-31');
    expect(jaar.rows.find((r) => r.category === 'omzet')).toMatchObject({ credit: 100000, closing: -100000 });
    expect(jaar.totals.debit).toBe(jaar.totals.credit);
  });

  it('meerdere jaren: de beginbalans in de app is dezelfde als in het pakket en telt op tot nul', () => {
    const { s, klant } = setup();
    // 2025: factuur 500 + 105 btw, en 200 privé opgenomen
    s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2025-11-10', lines: [{ description: 'Stucwerk', quantity: 1, unitPrice: 50000, vatCode: 'hoog' }] }).id);
    s.ledger.post({ date: '2025-12-01', description: 'Privé', source: 'handmatig', lines: [{ account: ACCOUNTS.priveOpnamen, debit: 20000 }, { account: ACCOUNTS.bank, credit: 20000 }] });
    s.ledger.post({ date: '2026-03-01', description: 'Privé', source: 'handmatig', lines: [{ account: ACCOUNTS.priveOpnamen, debit: 7000 }, { account: ACCOUNTS.bank, credit: 7000 }] });
    const equity = s.ledger.getAccount(ACCOUNTS.eigenVermogen);
    const prive = s.ledger.getAccount(ACCOUNTS.priveOpnamen);
    const pakket = new Map(s.exports.openingBalance('2026-01-01').map((o) => [o.code, o.amount]));

    const tb = s.ledgerReports.trialBalance('2026-01-01', '2026-12-31');
    expect(tb.totals.opening).toBe(0);
    expect(new Map(tb.rows.filter((r) => r.opening !== 0).map((r) => [r.code, r.opening]))).toEqual(pakket);
    // resultaat 2025 (500, credit) min 200 privé (debet)
    expect(tb.rows.find((r) => r.accountId === equity.id)).toMatchObject({ opening: -50000 + 20000, closing: -30000 });
    expect(tb.rows.find((r) => r.accountId === prive.id)).toMatchObject({ opening: 0, debit: 7000, closing: 7000 });

    expect(s.ledgerReports.ledgerCard(equity.id, '2026-01-01', '2026-12-31').opening).toBe(-30000);
    expect(s.ledgerReports.ledgerCard(prive.id, '2026-01-01', '2026-12-31')).toMatchObject({ opening: 0, closing: 7000 });

    const pb = s.ledgerReports.periodBalance(2026, 'kwartaal');
    expect(pb.rows.reduce((t, r) => t + r.opening, 0)).toBe(0);
    expect(pb.rows.find((r) => r.accountId === equity.id)!.opening).toBe(-30000);

    // balans in de expertmodus: eigen vermogen met het resultaat van 2025, privé alleen 2026;
    // de balans plus het resultaat van 2026 (nul) telt op tot nul
    const r = s.dashboard.reports('2026-01-01', '2026-12-31');
    expect(r.balance.find((b) => b.account_id === equity.id)!.balance).toBe(-30000);
    expect(r.balance.find((b) => b.account_id === prive.id)!.balance).toBe(7000);
    expect(r.balance.reduce((t, b) => t + b.balance, 0) - r.profit).toBe(0);
  });

  it('een beginbalansboeking op de eerste dag telt als beginbalans, niet als mutatie', () => {
    const { s } = setup();
    s.ledger.post({ date: '2026-01-01', description: 'Beginbalans', source: 'opening', lines: [{ account: ACCOUNTS.bank, debit: 150000 }, { account: ACCOUNTS.eigenVermogen, credit: 150000 }] });
    const bank = s.ledger.getAccount(ACCOUNTS.bank);
    const tb = s.ledgerReports.trialBalance('2026-01-01', '2026-12-31');
    expect(tb.rows.find((r) => r.accountId === bank.id)).toMatchObject({ opening: 150000, debit: 0, credit: 0, closing: 150000 });
    expect(tb.totals.opening).toBe(0);
    const card = s.ledgerReports.ledgerCard(bank.id, '2026-01-01', '2026-12-31');
    expect(card).toMatchObject({ opening: 150000, closing: 150000 });
    expect(card.lines).toHaveLength(0);
    expect(s.ledgerReports.periodBalance(2026, 'maand').rows.find((r) => r.accountId === bank.id)).toMatchObject({ opening: 150000, closing: 150000 });
    // vanaf een latere dag is het een gewone boeking uit het verleden
    expect(s.ledgerReports.trialBalance('2026-02-01', '2026-12-31').rows.find((r) => r.accountId === bank.id)!.opening).toBe(150000);
  });

  it('grootboekkaart: beginsaldo, regels met wederpartij en oplopend saldo', () => {
    const { s } = scenario();
    const bank = s.ledger.getAccount('BLiqBanRba');
    const card = s.ledgerReports.ledgerCard(bank.id, '2026-01-01', '2026-12-31');
    expect(card.opening).toBe(0);
    expect(card.lines).toHaveLength(1);
    expect(card.lines[0]).toMatchObject({ date: '2026-03-05', debit: 121000, balance: 121000 });
    expect(card.closing).toBe(121000);
    const deb = s.ledgerReports.ledgerCard(s.ledger.getAccount('BVorDebHad').id, '2026-03-01', '2026-12-31');
    // factuur (10 feb) is beginsaldo, de betaling van 5 maart loopt het af
    expect(deb.opening).toBe(121000);
    expect(deb.lines[0]).toMatchObject({ credit: 121000, balance: 0, counterparty: 'Familie Jansen' });
  });

  it('relatiekaart: klant en leverancier met wat er nog openstaat', () => {
    const { s, klant, rel } = scenario();
    const list = s.ledgerReports.relations('2026-12-31');
    expect(list.find((r) => r.relationId === klant.id)).toMatchObject({ receivable: 0, balance: 0 });
    expect(list.find((r) => r.relationId === rel.id)).toMatchObject({ payable: -24200, balance: -24200 });
    const card = s.ledgerReports.relationCard(rel.id, '2026-01-01', '2026-12-31');
    expect(card.lines).toHaveLength(1);
    expect(card.lines[0]).toMatchObject({ account: 'Crediteuren', credit: 24200, balance: -24200 });
  });

  it('periodebalans per maand en per kwartaal', () => {
    const { s } = scenario();
    const m = s.ledgerReports.periodBalance(2026, 'maand');
    const omzet = m.rows.find((r) => r.name.toLowerCase().includes('omzet'))!;
    expect(omzet.periods[1]).toBe(-100000);
    const q = s.ledgerReports.periodBalance(2026, 'kwartaal');
    expect(q.labels).toEqual(['Q1', 'Q2', 'Q3', 'Q4']);
    expect(q.rows.find((r) => r.name === 'Bank')!.periods).toEqual([121000, 0, 0, 0]);
    // vorig jaar: alleen de balans loopt door
    expect(s.ledgerReports.periodBalance(2027, 'maand').rows.find((r) => r.name === 'Bank')!.opening).toBe(121000);
  });
});
