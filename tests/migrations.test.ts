import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from '../src/db/database';
import { migrations } from '../src/db/migrations';

describe('migraties', () => {
  it('vult de importperiodes aan voor afschriften die vóór migratie 4 zijn ingelezen', () => {
    const db = new Database(':memory:');
    for (const m of migrations.slice(0, 3)) db.exec(m);
    db.pragma('user_version = 3');
    db.exec(`INSERT INTO chart_of_accounts (id, rgs_code, code, name, category) VALUES (1, 'BLiqBanRba', '1100', 'Bank', 'activa');
      INSERT INTO bank_accounts (id, name, account_id) VALUES (1, 'Zakelijk', 1);
      INSERT INTO import_batches (id, filename, source) VALUES (7, 'oud.csv', 'csv');
      INSERT INTO bank_transactions (bank_account_id, transaction_date, amount, source, import_batch_id, dedup_hash) VALUES
        (1, '2026-03-02', 100, 'csv', 7, 'a'), (1, '2026-03-28', 200, 'csv', 7, 'b');`);
    migrate(db);
    expect(db.prepare('SELECT * FROM import_batch_accounts').all()).toEqual([
      { batch_id: 7, bank_account_id: 1, period_from: '2026-03-02', period_to: '2026-03-28', transactions: 2, imported: 2, duplicates: 0 },
    ]);
    expect(db.pragma('user_version', { simple: true })).toBe(migrations.length);
  });
});
