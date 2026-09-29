import { describe, expect, it } from 'vitest';
import { setup } from './helpers';

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

  it('csv heeft dezelfde totalen', () => {
    const { s } = scenario();
    const csv = s.ledgerReports.trialBalanceCsv('2026-01-01', '2026-12-31');
    expect(csv.split('\r\n')[0]).toBe('Code;Omschrijving;RGS;Soort;Beginbalans;Debet;Credit;Eindsaldo');
    expect(csv).toContain(';Totaal;');
  });
});
