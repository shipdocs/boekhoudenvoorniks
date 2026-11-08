import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { ACCOUNTS } from '../src/core-ledger/accounts';

/**
 * Een verkoopfactuur met de hand als betaald gezet ("Betaling ontvangen"), en later komt de echte betaling uit het
 * afschrift. De handmatige betaling kun je ongedaan maken, en bij Bank kan de bankbetaling ervoor in de plaats komen,
 * zonder dat de omzet of het geld dubbel telt.
 */
function factuur(s: ReturnType<typeof setup>['s'], relationId: number) {
  return s.invoices.finalize(s.invoices.createDraft({ relationId, invoiceDate: '2026-09-01', lines: [{ description: 'Werk', quantity: 1, unitPrice: 10000, vatCode: 'hoog' }] }).id);
}

describe('een met de hand ingevoerde betaling van een verkoopfactuur', () => {
  it('ongedaan maken zet de factuur weer open; de omzet blijft staan', () => {
    const { s, klant } = setup();
    const inv = factuur(s, klant.id);
    s.invoices.registerPayment(inv.id, { amount: 12100, date: '2026-09-05' });
    expect(s.invoices.get(inv.id).status).toBe('betaald');
    const [p] = s.invoices.manualPayments(inv.id);
    expect(p).toMatchObject({ amount: 12100, via: 'bank', date: '2026-09-05' });
    const omzet = s.ledger.balance(ACCOUNTS.omzetHoog);
    const after = s.invoices.undoManualPayment(inv.id, p!.journalEntryId, '2026-09-10');
    expect(after.status).toBe('verzonden');
    expect(after.open_amount).toBe(12100);
    expect(s.ledger.balance(ACCOUNTS.bank)).toBe(0);
    expect(s.ledger.balance(ACCOUNTS.omzetHoog)).toBe(omzet);
    expect(s.invoices.manualPayments(inv.id)).toEqual([]);
    expect(() => s.invoices.undoManualPayment(inv.id, p!.journalEntryId)).toThrow(/al ongedaan/);
  });

  it('contant ingevoerd kan ook ongedaan', () => {
    const { s, klant } = setup();
    const inv = factuur(s, klant.id);
    s.quick.customerPaidCash(inv.id, 12100, '2026-09-05');
    const [p] = s.invoices.manualPayments(inv.id);
    expect(p).toMatchObject({ via: 'kas' });
    s.invoices.undoManualPayment(inv.id, p!.journalEntryId);
    expect(s.ledger.balance(ACCOUNTS.kas)).toBe(0);
    expect(s.invoices.get(inv.id).open_amount).toBe(12100);
  });

  it('een betaling uit het afschrift telt niet als handmatig: die maak je ongedaan bij Bank', () => {
    const { s, klant } = setup();
    const inv = factuur(s, klant.id);
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-09-06', amount: 12100, description: `Factuur ${inv.number}`, counterName: klant.name }] });
    const t = s.bank.list({ status: 'nieuw' })[0]!;
    s.bank.matchInvoice(t.id, inv.id);
    expect(s.invoices.manualPayments(inv.id)).toEqual([]);
  });

  it('bij Bank komt de echte betaling in de plaats van de handmatige "op de bank": geen dubbel geld, niet te veel betaald', () => {
    const { s, klant } = setup();
    const inv = factuur(s, klant.id);
    s.invoices.registerPayment(inv.id, { amount: 12100, date: '2026-09-05' });
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-09-06', amount: 12100, description: `Factuur ${inv.number}`, counterName: klant.name, counterIban: klant.iban }] });
    const t = s.bank.list({ status: 'nieuw' })[0]!;
    // vanzelf koppelen gebeurt niet; op het scherm van de betaling staat hij wel als voorstel
    expect(s.matching.autoMatch().matched).toBe(0);
    expect(s.invoices.listManuallyPaidByBank().map((i) => i.id)).toEqual([inv.id]);
    expect(s.matching.suggest(t, undefined, undefined, { withManual: true })[0]).toMatchObject({ kind: 'factuur', invoiceId: inv.id });
    s.bank.matchInvoice(t.id, inv.id);
    const after = s.invoices.get(inv.id);
    expect(after.status).toBe('betaald');
    expect(after.open_amount).toBe(0);
    expect(s.ledger.balance(ACCOUNTS.debiteuren)).toBe(0);
    expect(s.invoices.overpaidCustomers()).toEqual([]);
    expect(s.invoices.manualPayments(inv.id)).toEqual([]);
    expect(s.bank.get(t.id).status).toBe('gematcht');
    // ontkoppelen bij Bank zet de factuur weer open (de handmatige betaling komt niet terug)
    s.bank.unmatch(t.id, '2026-09-10');
    expect(s.invoices.get(inv.id).open_amount).toBe(12100);
  });

  it('een factuur met een afboeking als oninbaar komt niet in de lijst om te vervangen (terugdraaien mag daar niet)', () => {
    const { s, klant } = setup();
    const inv = factuur(s, klant.id);
    s.invoices.registerPayment(inv.id, { amount: 6000, date: '2026-09-05' });
    s.invoices.writeOffBadDebt(inv.id, '2026-10-01');
    expect(s.invoices.manualPayments(inv.id)).toHaveLength(1);
    expect(s.invoices.listManuallyPaidByBank()).toEqual([]);
    expect(() => s.invoices.undoManualPayment(inv.id, s.invoices.manualPayments(inv.id)[0]!.journalEntryId)).toThrow(/oninbaar/);
  });
});
