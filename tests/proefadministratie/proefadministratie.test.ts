import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { setup } from '../helpers';
import { parseCamt053 } from '../../src/import/camt053';

type Scenario = {
  startDate: string;
  period: { from: string; to: string; vat: string };
  sales: { key: string; customer: string; invoiceDate: string; description: string; unitPrice: number; vatCode: 'hoog' | 'laag' }[];
  purchases: { file: string; categoryKey: string; vatCode: 'hoog' | 'verlegd'; paidWith: 'prive' | 'later' }[];
  bankActions: (
    | { bankId: string; action: 'match-opening-sale' | 'match-opening-purchase' | 'match-sale' | 'match-purchase'; reference: string }
    | { bankId: string; action: 'book-account'; account: string; vatCode: string }
  )[];
};

type Expected = {
  opening: { bank: number; receivable: number; payable: number; vatPayable: number; equity: number };
  accounts: Record<string, number>;
  reports: { revenue: number; costs: number; profit: number };
  vat: { summary: Record<string, number>; rubrieken: Record<string, Record<string, number>> };
  openItems: { salesCount: number; salesAmount: number; purchaseCount: number; purchaseAmount: number };
  bank: { closingBalance: number; movementTotal: number; transactions: number; unprocessed: number };
  documents: { processed: number };
};

const root = __dirname;
const text = (path: string) => readFileSync(join(root, path), 'utf8');
const scenario = JSON.parse(text('scenario.json')) as Scenario;
const expected = JSON.parse(text('expected.json')) as Expected;

describe('vaste proefadministratie', () => {
  it('levert vanuit XAF, UBL en CAMT exact de afgesproken saldi op', async () => {
    const { s } = setup();
    s.settings.update({ onboardingDone: true, vatPeriod: 'kwartaal' });
    s.switchover.setMode('overstapper', scenario.startDate);

    const xaf = text('opening/administratie-2025.xaf');
    const plan = s.xafImport.analyze(xaf);
    expect(plan.banks).toHaveLength(1);
    expect(plan.banks[0]!.amount).toBe(expected.opening.bank);
    expect(plan.proposals.find((p) => p.input.kind === 'klant')?.amount).toBe(expected.opening.receivable);
    expect(plan.proposals.find((p) => p.input.kind === 'leverancier')?.amount).toBe(-expected.opening.payable);
    expect(plan.proposals.find((p) => p.input.kind === 'btw')?.amount).toBe(-expected.opening.vatPayable);
    expect(plan.equity).toBe(expected.opening.equity);

    const bankAccount = s.bank.ensureDefaultAccount();
    s.xafImport.apply(xaf, {
      include: plan.proposals.map((p) => p.key),
      banks: { [plan.banks[0]!.accountId]: bankAccount.id },
      relations: true,
    });

    const sales = new Map<string, number>();
    for (const sale of scenario.sales) {
      const relation = s.relations.list().find((r) => r.name === sale.customer);
      if (!relation) throw new Error(`Klant ontbreekt: ${sale.customer}`);
      const invoice = s.invoices.finalize(
        s.invoices.createDraft({
          relationId: relation.id,
          invoiceDate: sale.invoiceDate,
          lines: [{ description: sale.description, quantity: 1, unitPrice: sale.unitPrice, vatCode: sale.vatCode }],
        }).id,
      );
      sales.set(sale.key, invoice.id);
    }

    const purchases = new Map<string, number>();
    for (const choice of scenario.purchases) {
      const document = await s.intake.add(choice.file, readFileSync(join(root, 'inkopen', choice.file)), scenario.period.to);
      expect(document.status).toBe('controle');
      if (!document.result?.supplier || !document.result.invoiceDate || !document.result.total || !document.result.invoiceNumber) {
        throw new Error(`UBL mist verplichte proefgegevens: ${choice.file}`);
      }
      const confirmed = s.intake.confirm(document.id, {
        supplier: document.result.supplier.value,
        date: document.result.invoiceDate.value,
        total: document.result.total.value,
        invoiceNumber: document.result.invoiceNumber.value,
        categoryKey: choice.categoryKey,
        vatCode: choice.vatCode,
        business: true,
        paidWith: choice.paidWith,
      });
      if (!confirmed.purchase_invoice_id) throw new Error(`Inkoop niet verwerkt: ${choice.file}`);
      purchases.set(document.result.invoiceNumber.value, confirmed.purchase_invoice_id);
    }

    const camt = text('bank/afschrift-2026-q1.camt053.xml');
    const parsed = parseCamt053(camt);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.transactions).toHaveLength(expected.bank.transactions);
    expect(parsed.balances).toEqual([{ ownIban: 'NL91ABNA0417164300', date: scenario.period.to, amount: expected.bank.closingBalance }]);
    const imported = s.bank.import(parsed, { filename: 'afschrift-2026-q1.camt053.xml' });
    expect(imported).toMatchObject({ imported: expected.bank.transactions, duplicates: 0 });

    const transaction = (bankId: string) => {
      const found = s.bank.list().find((t) => t.reference === bankId);
      if (!found) throw new Error(`Bankregel ontbreekt: ${bankId}`);
      return found;
    };
    for (const action of scenario.bankActions) {
      const tx = transaction(action.bankId);
      if (action.action === 'book-account') {
        s.bank.bookToAccount(tx.id, { account: action.account, vatCode: action.vatCode });
      } else if (action.action === 'match-sale') {
        s.bank.matchInvoice(tx.id, sales.get(action.reference)!);
      } else if (action.action === 'match-purchase') {
        s.bank.matchPurchase(tx.id, purchases.get(action.reference)!);
      } else if (action.action === 'match-opening-sale') {
        const invoice = s.invoices.list().find((i) => i.number === action.reference);
        if (!invoice || !s.invoices.get(invoice.id).is_opening) throw new Error(`Openingsfactuur ontbreekt: ${action.reference}`);
        s.bank.matchInvoice(tx.id, invoice.id);
      } else {
        const purchase = s.purchases.list().find((p) => p.is_opening && p.supplier_reference === action.reference);
        if (!purchase) throw new Error(`Openingsinkoop ontbreekt: ${action.reference}`);
        s.bank.matchPurchase(tx.id, purchase.id);
      }
    }

    const actualAccounts = Object.fromEntries(
      s.ledger.balances().filter((a) => a.balance !== 0).map((a) => [a.rgs_code, a.balance]),
    );
    expect(actualAccounts).toEqual(expected.accounts);
    expect(s.ledger.checkIntegrity()).toMatchObject({ balanced: true, unbalancedEntries: [] });

    const reports = s.dashboard.reports(scenario.period.from, scenario.period.to);
    expect({ revenue: reports.revenue, costs: reports.costs, profit: reports.profit }).toEqual(expected.reports);

    const vat = s.vat.calculate(scenario.period.vat);
    expect(vat.summary).toMatchObject(expected.vat.summary);
    const rubrieken = Object.fromEntries(vat.rubrieken.map((r) => [r.code, r]));
    for (const [code, values] of Object.entries(expected.vat.rubrieken)) expect(rubrieken[code]).toMatchObject(values);

    const openSales = s.invoices.listOpen(scenario.period.to).filter((i) => i.open_amount !== 0);
    const openPurchases = s.purchases.listOpen();
    expect({
      salesCount: openSales.length,
      salesAmount: openSales.reduce((sum, invoice) => sum + invoice.open_amount, 0),
      purchaseCount: openPurchases.length,
      purchaseAmount: openPurchases.reduce((sum, purchase) => sum + purchase.open_amount, 0),
    }).toEqual(expected.openItems);

    const dashboard = s.dashboard.get(scenario.period.to);
    expect({
      closingBalance: dashboard.bank.ledgerBalance,
      movementTotal: dashboard.bank.statementBalance,
      transactions: s.bank.list({ limit: 100 }).length,
      unprocessed: dashboard.bank.unprocessed,
    }).toEqual(expected.bank);
    expect(expected.opening.bank + dashboard.bank.statementBalance).toBe(expected.bank.closingBalance);
    expect(s.switchover.state().banks[0]!.balanceCheck).toMatchObject({
      bank: expected.bank.closingBalance,
      computed: expected.bank.closingBalance,
      source: 'afschrift',
    });
    expect(s.intake.list('verwerkt')).toHaveLength(expected.documents.processed);

    expect(s.bank.import(parsed, { filename: 'afschrift-2026-q1.camt053.xml' })).toMatchObject({ imported: 0, duplicates: expected.bank.transactions });
    const firstPurchase = scenario.purchases[0]!;
    const sameDocument = await s.intake.add(firstPurchase.file, readFileSync(join(root, 'inkopen', firstPurchase.file)), scenario.period.to);
    expect(sameDocument.purchase_invoice_id).toBe(purchases.get('BM-2026-001'));
    expect(s.purchases.list()).toHaveLength(5);
    expect(Object.fromEntries(s.ledger.balances().filter((a) => a.balance !== 0).map((a) => [a.rgs_code, a.balance]))).toEqual(expected.accounts);
  });
});
