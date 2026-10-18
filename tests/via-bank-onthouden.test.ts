import { describe, expect, it } from 'vitest';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import { setup } from './helpers';

const ASOF = '2026-10-02';

/** Een aankoop die sinds 23 september betaald had moeten zijn, en een bankrekening met een afschrift t/m 29 september. */
function scenario() {
  const ctx = setup();
  const { s } = ctx;
  const leverancier = s.relations.findOrCreateSupplier('Printhuis');
  const aankoop = s.purchases.create({ relationId: leverancier.id, invoiceDate: '2026-09-09', dueDate: '2026-09-23', description: 'Drukwerk', lines: [{ account: ACCOUNTS.inkoopMaterialen, netAmount: 10000, vatCode: 'hoog' }] });
  const lees = (at: string, transactions: { date: string; amount: number; description: string; counterName?: string }[]) => {
    const batch = s.bank.import({ source: 'csv', warnings: [], transactions }).batchId;
    for (const t of s.bank.list({ status: 'nieuw' })) s.bank.bookToAccount(t.id, { account: ACCOUNTS.bankkosten, description: 'Rente' });
    s.db.prepare('UPDATE import_batches SET imported_at = ? WHERE id = ?').run(at, batch);
  };
  lees('2026-09-30 10:00:00', [{ date: '2026-09-29', amount: 5000, description: 'Rente' }]);
  const rekening = s.bank.listAccounts()[0]!;
  const kinds = () => s.inbox.tasks(ASOF).filter((t) => t.ref.purchaseId === aankoop.id).map((t) => t.kind);
  return { ...ctx, aankoop, rekening, lees, kinds };
}

describe('Al betaald via je bank onthouden (#239)', () => {
  it('zonder keuze zegt Vandaag dat de rekening te laat betaald is', () => {
    const { kinds } = scenario();
    expect(kinds()).toEqual(['purchase-due']);
  });

  it('na de keuze: geen "te laat betalen", wel een rustige melding dat het afschrift ontbreekt; er is niets geboekt', () => {
    const { s, aankoop, rekening, kinds } = scenario();
    const entries = (s.db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get() as { n: number }).n;
    s.purchases.expectOnBank(aankoop.id, rekening.id, '2026-10-01');
    expect(kinds()).toEqual(['purchase-awaiting-bank']);
    const taak = s.inbox.tasks(ASOF).find((t) => t.kind === 'purchase-awaiting-bank')!;
    expect(taak.question).toContain(rekening.name);
    expect(taak.priority).toBeGreaterThan(2);
    expect(s.purchases.get(aankoop.id)).toMatchObject({ status: 'open', amount_paid: 0, expected_on_bank_account_id: rekening.id });
    expect((s.db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get() as { n: number }).n).toBe(entries);
    expect(s.inbox.awaitingBank(s.purchases.listOpen()).get(aankoop.id)).toBe(rekening.name);
  });

  it('staat de betaling na een compleet afschrift nog niet in, dan telt de aankoop weer als gewoon open', () => {
    const { s, aankoop, rekening, lees, kinds } = scenario();
    s.purchases.expectOnBank(aankoop.id, rekening.id, '2026-10-01');
    lees('2026-10-02 08:00:00', [{ date: '2026-10-01', amount: 100, description: 'Rente' }]);
    expect(s.bank.importStatus()[0]!.completeTo! >= '2026-10-01').toBe(true);
    expect(kinds()).toEqual(['purchase-due']);
    expect(s.inbox.awaitingBank(s.purchases.listOpen()).size).toBe(0);
  });

  it('een gekoppelde betaling zet de aankoop op betaald: geen wachtmelding meer', () => {
    const { s, aankoop, rekening, kinds } = scenario();
    s.purchases.expectOnBank(aankoop.id, rekening.id, '2026-10-01');
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-09-25', amount: -12100, description: 'Printhuis', counterName: 'Printhuis' }] });
    const betaling = s.bank.list({ status: 'nieuw' }).find((t) => t.counter_name === 'Printhuis')!;
    s.bank.matchPurchase(betaling.id, aankoop.id);
    expect(s.purchases.get(aankoop.id).status).toBe('betaald');
    expect(s.inbox.awaitingBank(s.purchases.list())).toEqual(new Map());
    expect(kinds()).toEqual([]);
  });

  it('"Toch niet via de bank betaald" haalt de markering weg', () => {
    const { s, aankoop, rekening, kinds } = scenario();
    s.purchases.expectOnBank(aankoop.id, rekening.id, '2026-10-01');
    s.purchases.clearExpectedOnBank(aankoop.id);
    expect(kinds()).toEqual(['purchase-due']);
  });

  it('een aankoop die al betaald is, kun je niet nog eens als "via bank" aangeven', () => {
    const { s, aankoop, rekening } = scenario();
    s.purchases.registerPayment(aankoop.id, { amount: aankoop.open_amount, date: '2026-09-20' });
    expect(() => s.purchases.expectOnBank(aankoop.id, rekening.id, '2026-10-01')).toThrow(/al op betaald/);
  });
});
