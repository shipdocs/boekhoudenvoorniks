import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { migrate } from '../src/db/database';
import { migrations } from '../src/db/migrations';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import { compile, type BankCategoriePayload } from '../src/core-ledger/rules';

/** Journaalregels vergelijkbaar maken (volgorde en inhoud). */
const norm = (lines: { account?: string; rgs_code?: string; debit?: number | null; credit?: number | null; vatCode?: string | null; vat_code?: string | null }[]) =>
  lines.map((l) => [l.account ?? l.rgs_code, l.debit ?? 0, l.credit ?? 0, l.vatCode ?? l.vat_code ?? null]);

function scenario() {
  const ctx = setup();
  const { s, klant } = ctx;
  s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-07-10', lines: [{ description: 'Stucwerk', quantity: 1, unitPrice: 100000, vatCode: 'hoog' }] }).id);
  s.quick.recordExpense({ date: '2026-07-12', supplierName: 'Gamma', description: 'Verf', categoryKey: 'materiaal', grossAmount: 12100, vatCode: 'hoog', paidWith: 'kas' });
  s.purchases.create({ invoiceDate: '2026-07-15', description: 'Steiger', lines: [{ account: ACCOUNTS.inkoopMaterialen, netAmount: 50000, vatCode: 'hoog' }, { account: 'WBedKanKan', netAmount: 1000, vatCode: 'laag' }] });
  s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-07-20', amount: -6050, description: 'Tank', counterName: 'SHELL' }, { date: '2026-07-21', amount: -20000, description: 'Opname', counterName: 'Piet' }] });
  const [shell, prive] = s.bank.list({ status: 'nieuw' }).sort((a, b) => a.amount - b.amount).reverse();
  s.bank.bookToAccount(shell!.id, { account: ACCOUNTS.inkoopMaterialen, vatCode: 'hoog' });
  s.bank.bookToAccount(prive!.id, { account: ACCOUNTS.priveOpnamen });
  return { ...ctx, shell: shell!, prive: prive! };
}

describe('gebeurtenissen als bron van waarheid (#19)', () => {
  it('elke journaalpost is terug te voeren op precies één gebeurtenis met bewijs', () => {
    const { db, s, shell } = scenario();
    s.bank.unmatch(shell.id, '2026-07-25'); // tegenboeking hoort bij dezelfde gebeurtenis
    const missing = db.prepare('SELECT COUNT(*) AS n FROM journal_entries WHERE event_id IS NULL').get() as { n: number };
    expect(missing.n).toBe(0);
    const reversal = db.prepare('SELECT event_id, reverses_entry_id FROM journal_entries WHERE reverses_entry_id IS NOT NULL').get() as { event_id: number; reverses_entry_id: number };
    const original = db.prepare('SELECT event_id FROM journal_entries WHERE id = ?').get(reversal.reverses_entry_id) as { event_id: number };
    expect(reversal.event_id).toBe(original.event_id);
    // ook de regelversie van de tegenboeking is die van het origineel
    const versions = db.prepare('SELECT DISTINCT rules_version FROM journal_entries WHERE event_id = ?').all(reversal.event_id);
    expect(versions).toHaveLength(1);
    const bankEvent = s.events.forEntry(reversal.reverses_entry_id)!;
    expect(bankEvent.type).toBe('bank-categorie');
    expect(bankEvent.evidence).toEqual([expect.objectContaining({ kind: 'bank', refId: shell.id })]);
    expect(() => db.prepare('UPDATE journal_entries SET event_id = 999 WHERE id = ?').run(reversal.reverses_entry_id)).toThrow(/ligt vast/);
  });

  it('hercompileren met dezelfde regelversie levert exact dezelfde journaalregels op', () => {
    const { db, s } = scenario();
    const events = db.prepare(`SELECT id FROM events WHERE type IN ('bank-categorie', 'inkoop')`).all() as { id: number }[];
    expect(events.length).toBe(4); // bonnetje (inkoop), inkoopfactuur, twee bankboekingen
    for (const { id } of events) {
      const ev = s.events.get(id);
      const entry = s.ledger.getEntry(ev.entryIds[0]!);
      expect(norm(s.events.recompile(id).lines)).toEqual(norm(entry.lines));
      expect(entry.rules_version).toBe(ev.rules_version);
    }
    // eigenschaptest: willekeurige gebeurtenissen, twee keer compileren = identiek, en altijd in balans
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const targets: [string, 'kosten' | 'passiva' | 'omzet', string[]][] = [
      [ACCOUNTS.inkoopMaterialen, 'kosten', ['hoog', 'laag', 'nul', 'verlegd', 'geen']],
      [ACCOUNTS.priveOpnamen, 'passiva', ['geen']],
      [ACCOUNTS.omzetHoog, 'omzet', ['hoog', 'laag', 'nul']],
    ];
    for (let i = 0; i < 300; i++) {
      const [account, accountCategory, codes] = targets[Math.floor(rnd() * targets.length)]!;
      const amount = Math.round((rnd() - (accountCategory === 'omzet' ? 0 : 0.8)) * 500000) || 1;
      const payload: BankCategoriePayload = { bankTransactionId: i, date: '2026-07-01', amount, bankAccount: ACCOUNTS.bank, account, accountCategory, vatCode: codes[Math.floor(rnd() * codes.length)]!, relationId: null, description: `t${i}` };
      const a = compile({ type: 'bank-categorie', payload });
      const b = compile({ type: 'bank-categorie', payload: JSON.parse(JSON.stringify(payload)) });
      expect(b).toEqual(a);
      const debit = a.lines.reduce((x, l) => x + (l.debit ?? 0), 0);
      const credit = a.lines.reduce((x, l) => x + (l.credit ?? 0), 0);
      expect(debit).toBe(credit);
    }
  });

  it('een gecorrigeerde classificatie = tegenboeking + nieuwe boeking, geen wijziging van de bestaande post', () => {
    const { db, s, shell } = scenario();
    const before = s.bank.get(shell.id).matched_journal_entry_id!;
    const oldLines = JSON.stringify(s.ledger.getEntry(before).lines);
    const newEntry = s.bank.reclassify(shell.id, { account: 'WBedKanKan', vatCode: 'hoog' }, 'was kantoor');
    expect(JSON.stringify(s.ledger.getEntry(before).lines)).toBe(oldLines); // oude post onveranderd
    expect(s.ledger.getEntry(before).status).toBe('teruggedraaid');
    expect(s.bank.get(shell.id).matched_journal_entry_id).toBe(newEntry);
    expect(s.ledger.balance(ACCOUNTS.inkoopMaterialen)).toBe(10000 + 50000); // alleen verf + steiger
    expect(s.ledger.balance('WBedKanKan')).toBe(1000 + 5000);
    const next = s.events.forEntry(newEntry)!;
    expect(next).toMatchObject({ type: 'bank-categorie', status: 'actief' });
    expect(s.events.get(next.supersedes_event_id!).status).toBe('vervangen');
    expect(next.evidence.map((e) => e.kind)).toEqual(['bank', 'antwoord']);
    expect(() => s.events.replace(next.supersedes_event_id!, { type: 'bank-categorie', payload: next.payload as BankCategoriePayload }, 'x')).toThrow(/al vervangen/);
    expect(s.ledger.checkIntegrity().balanced).toBe(true);
    void db;
  });

  it('een al aangegeven btw-periode verandert nooit; het verschil landt in de volgende open periode', () => {
    const { s, shell } = scenario();
    for (const c of s.vat.checks('2026-Q3')) s.vat.skipCheck('2026-Q3', c.key, 'test');
    s.vat.markSubmitted('2026-Q3');
    const q3 = s.vat.calculate('2026-Q3').summary;
    s.bank.reclassify(shell.id, { account: ACCOUNTS.inkoopMaterialen, vatCode: 'nul' }, 'geen btw op de bon');
    expect(s.vat.calculate('2026-Q3').summary).toEqual(q3);
    const q4 = s.vat.calculate('2026-Q4');
    expect(q4.corrections).toEqual([expect.objectContaining({ periodKey: '2026-Q3', btw: 1050 })]); // 1050 minder voorbelasting
    expect(q4.summary.teBetalen).toBe(1050);
  });

  it('inkoop: andere kostensoort via vervanging; bedrag mag niet veranderen na betaling', () => {
    const { s } = scenario();
    const p = s.purchases.list().find((x) => x.description === 'Steiger')!;
    const updated = s.purchases.reclassify(p.id, [{ account: 'BMvaBedIna', netAmount: 50000, vatCode: 'hoog' }, { account: 'WBedKanKan', netAmount: 1000, vatCode: 'laag' }], 'investering');
    expect(updated.total).toBe(p.total);
    expect(s.ledger.balance('BMvaBedIna')).toBe(50000);
    expect(s.ledger.balance(ACCOUNTS.inkoopMaterialen)).toBe(10000 + 5000);
    s.purchases.registerPayment(p.id, { amount: 10000, date: '2026-07-30' });
    expect(() => s.purchases.reclassify(p.id, [{ account: 'BMvaBedIna', netAmount: 40000, vatCode: 'hoog' }], 'x')).toThrow(/betaling/);
    expect(s.ledger.checkIntegrity().balanced).toBe(true);
  });

  it('migratie: bestaande posten krijgen een gebeurtenis, saldi veranderen niet', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    for (const m of migrations.slice(0, 6)) db.exec(m);
    db.pragma('user_version = 6');
    db.exec(`
      INSERT INTO chart_of_accounts (id, rgs_code, code, name, category) VALUES (1, 'BLiqBanRba', '1100', 'Bank', 'activa'), (2, 'WKprInkMat', '7000', 'Inkoop', 'kosten'), (3, 'BSchBepBtwVoo', '1740', 'Voorbelasting', 'btw');
      INSERT INTO journal_entries (id, entry_date, description, source, source_ref) VALUES (1, '2026-03-02', 'Gamma', 'bank', 'bank:7'), (2, '2026-03-05', 'Memoriaal', 'handmatig', NULL);
      INSERT INTO journal_lines (journal_entry_id, account_id, debit, credit, vat_code) VALUES (1, 2, 10000, 0, 'hoog'), (1, 3, 2100, 0, 'hoog'), (1, 1, 0, 12100, NULL), (2, 2, 500, 0, NULL), (2, 1, 0, 500, NULL);
      INSERT INTO journal_entries (id, entry_date, description, source, source_ref, reverses_entry_id) VALUES (3, '2026-03-06', 'Tegenboeking', 'handmatig', NULL, 2);
      INSERT INTO journal_lines (journal_entry_id, account_id, debit, credit) VALUES (3, 1, 500, 0), (3, 2, 0, 500);`);
    const balances = () => db.prepare('SELECT account_id, SUM(debit) - SUM(credit) AS b FROM journal_lines GROUP BY account_id ORDER BY account_id').all();
    const before = balances();
    migrate(db);
    expect(balances()).toEqual(before);
    const entries = db.prepare('SELECT id, event_id, rules_version FROM journal_entries ORDER BY id').all() as { id: number; event_id: number; rules_version: string }[];
    expect(entries.map((e) => e.event_id)).toEqual([1, 2, 2]); // tegenboeking bij de gebeurtenis van het origineel
    expect(entries.every((e) => e.rules_version === 'backfill')).toBe(true);
    const payload = JSON.parse((db.prepare('SELECT payload FROM events WHERE id = 1').get() as { payload: string }).payload);
    expect(payload.lines).toHaveLength(3);
    expect(db.prepare('SELECT kind, ref_id FROM event_evidence WHERE event_id = 1').all()).toEqual([{ kind: 'bank', ref_id: 7 }]);
  });
});
