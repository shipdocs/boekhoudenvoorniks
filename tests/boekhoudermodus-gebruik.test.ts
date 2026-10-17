import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { createApi, type HostContext } from '../src/main/api';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import { advancedUsage, advancedUsageText } from '../src/core-ledger/advanced-actions';

/**
 * Schrijven in de boekhoudermodus wordt vastgelegd, kijken niet (#427). Zo is bij een vraag via de boekhouder te
 * zien of er buiten hem om rechtstreeks in de boekhouding is gewerkt.
 */
const OWN = 'NL91ABNA0417164300';

describe('boekhoudermodus: gebruik vastleggen', () => {
  it('kijken laat niets achter; boeken, terugdraaien, rekeningschema en afschrift weghalen wel', async () => {
    const { s } = setup();
    const api = createApi(s, { appVersion: () => 'test', safetyBackup: async () => null } as unknown as HostContext);
    s.settings.update({ advancedMode: true, advancedModeAgreedAt: '2026-10-15' });
    s.bank.updateAccount(s.bank.listAccounts()[0]!.id, { iban: OWN });
    const batch = s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-09-10', amount: -5000, counterName: 'Bol', counterIban: null, description: 'x', reference: null, ownIban: OWN }] }, { filename: 'bank.csv' });

    // kijken
    api.ledger.accounts();
    api.ledger.entries({});
    api.ledger.balances('2026-01-01', '2026-12-31');
    api.ledger.integrity();
    api.exports.accountantPackagePreview(2026);
    expect(api.app.advancedUsage()).toEqual({ count: 0, first: null, last: null });
    expect(advancedUsageText(advancedUsage(s.db))).toBe('Boekhoudermodus: er is nooit in geschreven.');

    // schrijven
    const entryId = api.ledger.manualEntry({ date: '2026-09-20', description: 'correctie', lines: [{ account: ACCOUNTS.vraagposten, debit: 1000 }, { account: ACCOUNTS.bank, credit: 1000 }] });
    api.ledger.reverse(entryId, '2026-09-21');
    const account = api.ledger.addAccount({ name: 'Eigen rekening', rgsRef: 'WBedKanSof' });
    api.ledger.renameAccount(account.id, 'Eigen rekening 2');
    api.ledger.archiveAccount(account.id);
    await api.bank.removeImport(batch.batchId);

    const usage = api.app.advancedUsage();
    expect(usage.count).toBe(6);
    expect(usage.first).not.toBeNull();
    expect(s.db.prepare('SELECT kind FROM advanced_actions ORDER BY id').all().map((r) => (r as { kind: string }).kind)).toEqual(['memoriaal', 'terugdraaien', 'rekening-toevoegen', 'rekening-hernoemen', 'rekening-weghalen', 'afschrift-weghalen']);
    expect(advancedUsageText(usage)).toMatch(/^Boekhoudermodus: 6 handelingen, eerste op \d{4}-\d{2}-\d{2}, laatste op/);

    // het pakket voor de boekhouder zegt het
    const check = api.exports.accountantPackagePreview(2026).checks.find((c) => c.label.includes('boekhoudermodus'))!;
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/6 handelingen/);
  });

  it('zonder handelingen is de pakketcontrole groen', () => {
    const { s } = setup();
    const api = createApi(s, { appVersion: () => 'test' } as unknown as HostContext);
    const check = api.exports.accountantPackagePreview(2026).checks.find((c) => c.label.includes('boekhoudermodus'))!;
    expect(check.ok).toBe(true);
  });
});
