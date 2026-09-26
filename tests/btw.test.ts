import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import { buildVatXbrl } from '../src/btw/xbrl';

describe('BTW-aangifte', () => {
  it('voorbeeld Piet de Schilder: factuur, verf en gereedschap', () => {
    const { s, klant } = setup();
    // Factuur schilderwerk € 1.000 + 21%
    s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-07-10', lines: [{ description: 'Schilderwerk', quantity: 1, unitPrice: 100000, vatCode: 'hoog' }] }).id);
    // Verf gekocht € 121 incl. btw (bonnetje, betaald met pin)
    s.quick.recordExpense({ date: '2026-07-12', supplierName: 'Gamma', description: 'Verf', categoryKey: 'materiaal', grossAmount: 12100, vatCode: 'hoog', paidWith: 'bank' });
    // Gereedschap € 605 incl. btw
    s.quick.recordExpense({ date: '2026-08-01', supplierName: 'Hornbach', description: 'Steigermateriaal', categoryKey: 'investering', grossAmount: 60500, vatCode: 'hoog', paidWith: 'kas' });

    const r = s.vat.calculate('2026-Q3');
    expect(r.summary).toMatchObject({ omzet: 100000, btwOverOmzet: 21000, voorbelasting: 12600, teBetalen: 8400, teBetalenEuro: 84 });
    const rub = Object.fromEntries(r.rubrieken.map((x) => [x.code, x]));
    expect(rub['1a']).toMatchObject({ omzet: 100000, btw: 21000, omzetEuro: 1000, btwEuro: 210 });
    expect(rub['5b']).toMatchObject({ btw: 12600, btwEuro: 126 });
    expect(rub['5g']!.btwEuro).toBe(84);
    expect(s.ledger.balance('WKprInkMat')).toBe(10000);
    expect(s.ledger.balance('BMvaBedIna')).toBe(50000);
    // buiten de periode telt niet mee
    expect(s.vat.calculate('2026-Q2').summary.teBetalen).toBe(0);
  });

  it('afronding in het voordeel van de ondernemer', () => {
    const { s, klant } = setup();
    s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-01-10', lines: [{ description: 'x', quantity: 1, unitPrice: 99999, vatCode: 'hoog' }] }).id);
    s.quick.recordExpense({ date: '2026-01-12', description: 'Verf', categoryKey: 'materiaal', grossAmount: 1001, vatCode: 'hoog', paidWith: 'kas' });
    const rub = Object.fromEntries(s.vat.calculate('2026-Q1').rubrieken.map((x) => [x.code, x]));
    expect(rub['1a']).toMatchObject({ omzetEuro: 999, btw: 21000, btwEuro: 210 });
    expect(rub['5b']).toMatchObject({ btw: 174, btwEuro: 2 }); // naar boven
    expect(rub['5g']!.btwEuro).toBe(208);
  });

  it('verlegde btw: verkoop in 1e, inkoop in 2a en 5b', () => {
    const { s, aannemer } = setup();
    s.invoices.finalize(s.invoices.createDraft({ relationId: aannemer.id, invoiceDate: '2026-04-10', lines: [{ description: 'Stucwerk nieuwbouw', quantity: 1, unitPrice: 500000, vatCode: 'verlegd' }] }).id);
    s.quick.recordExpense({ date: '2026-04-15', supplierName: 'Onderaannemer Klaas', description: 'Inhuur', categoryKey: 'onderaannemer', grossAmount: 100000, vatCode: 'verlegd', paidWith: 'bank' });
    const r = s.vat.calculate('2026-Q2');
    const rub = Object.fromEntries(r.rubrieken.map((x) => [x.code, x]));
    expect(rub['1e']!.omzet).toBe(500000);
    expect(rub['2a']).toMatchObject({ omzet: 100000, btw: 21000 });
    expect(rub['5b']!.btw).toBe(21000);
    expect(r.summary.teBetalen).toBe(0);
    // aan de onderaannemer wordt alleen netto betaald
    expect(s.purchases.list()[0]!.total).toBe(100000);
  });

  it('indienen sluit de periode af en boekt naar de afrekening', () => {
    const { s, klant } = setup();
    s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-07-10', lines: [{ description: 'x', quantity: 1, unitPrice: 100000, vatCode: 'hoog' }] }).id);
    const r = s.vat.markSubmitted('2026-Q3');
    expect(r.status).toBe('ingediend');
    expect(r.summary.teBetalen).toBe(21000); // rapport blijft gelijk na afsluitboeking
    expect(s.ledger.balance(ACCOUNTS.btwAfdragenHoog)).toBe(0);
    expect(s.ledger.balance(ACCOUNTS.btwAfrekening)).toBe(-21000);
    expect(() => s.vat.markSubmitted('2026-Q3')).toThrow(/al ingediend/);
    s.vat.reopen('2026-Q3');
    expect(s.ledger.balance(ACCOUNTS.btwAfdragenHoog)).toBe(-21000);
    expect(s.ledger.checkIntegrity().balanced).toBe(true);
  });

  it('een late factuur in een aangegeven periode telt mee in de volgende aangifte (#27)', () => {
    const { s, klant } = setup();
    s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-07-10', lines: [{ description: 'x', quantity: 1, unitPrice: 100000, vatCode: 'hoog' }] }).id);
    s.vat.markSubmitted('2026-Q3');
    const late = s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-08-01', lines: [{ description: 'y', quantity: 1, unitPrice: 10000, vatCode: 'hoog' }] });
    const inv = s.invoices.finalize(late.id);
    expect(inv.status).toBe('verzonden');
    expect(inv.invoice_date).toBe('2026-08-01'); // de factuur houdt haar echte datum

    const q3 = s.vat.calculate('2026-Q3');
    expect(q3.summary.teBetalen).toBe(21000); // ingediend blijft ingediend
    const q4 = s.vat.calculate('2026-Q4');
    expect(q4.summary.teBetalen).toBe(2100);
    expect(q4.corrections).toMatchObject([{ periodKey: '2026-Q3', btw: 2100, suppletie: false }]);
    expect(q4.warnings.join(' ')).not.toMatch(/suppletie/);
    // kleine correctie gaat mee in de gewone aangifte, niet via een suppletie
    expect(() => s.vat.markSuppletieSubmitted('2026-Q3')).toThrow(/volgende aangifte/);
    // de btw-toewijzing ligt vast
    expect(() => s.db.prepare(`UPDATE journal_entries SET vat_date = '2026-07-01' WHERE vat_correction_of IS NOT NULL`).run()).toThrow(/ligt vast/);
    // terugdraaien van de late boeking heft de correctie op
    const lateEntry = s.db.prepare(`SELECT id FROM journal_entries WHERE vat_correction_of = '2026-Q3'`).get() as { id: number };
    s.ledger.reverse(lateEntry.id, '2026-11-01');
    expect(s.vat.calculate('2026-Q4').corrections).toEqual([]);
    expect(s.vat.calculate('2026-Q4').summary.teBetalen).toBe(0);
    expect(s.ledger.checkIntegrity().balanced).toBe(true);
  });

  it('een correctie boven € 1.000 gaat via een suppletie, niet via de volgende aangifte', () => {
    const { s, klant } = setup();
    s.vat.markSubmitted('2026-Q3');
    s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-08-01', lines: [{ description: 'groot', quantity: 1, unitPrice: 1000000, vatCode: 'hoog' }] }).id);
    let q4 = s.vat.calculate('2026-Q4');
    expect(q4.corrections).toMatchObject([{ periodKey: '2026-Q3', btw: 210000, suppletie: true }]);
    expect(q4.summary.teBetalen).toBe(0); // niet in de gewone aangifte
    expect(q4.warnings.join(' ')).toMatch(/suppletie/);
    expect(s.inbox.tasks().some((t) => t.kind === 'vat-suppletie')).toBe(true);

    s.vat.markSuppletieSubmitted('2026-Q3');
    q4 = s.vat.calculate('2026-Q4');
    expect(q4.corrections).toEqual([]);
    expect(q4.summary.teBetalen).toBe(0);
    expect(s.ledger.balance(ACCOUNTS.btwAfdragenHoog)).toBe(0);
    expect(s.ledger.balance(ACCOUNTS.btwAfrekening)).toBe(-210000);
    expect(s.inbox.tasks().some((t) => t.kind === 'vat-suppletie')).toBe(false);
    expect(s.ledger.checkIntegrity().balanced).toBe(true);
  });

  it('waarschuwt voor onverwerkte banktransacties en exporteert CSV/XBRL', () => {
    const { s, klant } = setup();
    s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-07-10', lines: [{ description: 'x', quantity: 2, unitPrice: 50000, vatCode: 'hoog' }] }).id);
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-07-20', amount: -5000, description: 'iets' }] });
    const r = s.vat.calculate('2026-Q3');
    expect(s.vat.checks('2026-Q3').find((c) => c.key === 'bank-open')).toMatchObject({ count: 1, blocking: true });
    expect(s.vat.exportCsv('2026-Q3')).toContain('1a;');
    const xbrl = buildVatXbrl(r, s.settings.get().company);
    expect(xbrl).toContain('<bd-i:TurnoverSuppliesServicesGeneralTariff contextRef="Msg" unitRef="EUR" decimals="INF">1000</bd-i:TurnoverSuppliesServicesGeneralTariff>');
    expect(xbrl).toContain('NL123456789B01');
  });
});
