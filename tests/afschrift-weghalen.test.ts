import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { createApi, type HostContext } from '../src/main/api';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import type { NormalizedTransaction, ParseResult } from '../src/import/types';

/**
 * Een ingelezen afschrift weer weghalen (#408): weg is weg. Alles van dat bestand gaat eruit, alsof het nooit is
 * ingelezen, en wat er al mee gedaan was gaat eerst netjes terug. Hetzelfde bestand opnieuw inlezen is daarna
 * een eerste keer.
 */
const OWN = 'NL91ABNA0417164300';
const line = (date: string, amount: number, name: string): NormalizedTransaction => ({ date, amount, counterName: name, counterIban: null, description: `betaling ${name}`, reference: null, ownIban: OWN });
const statement = (transactions: NormalizedTransaction[], source: ParseResult['source'] = 'csv'): ParseResult => ({ source, warnings: [], transactions });

function ready() {
  const t = setup();
  t.s.bank.updateAccount(t.s.bank.listAccounts()[0]!.id, { name: 'Zakelijk', iban: OWN });
  return t;
}

describe('afschrift weghalen', () => {
  it('haalt alles van het bestand weg en daarna is opnieuw inlezen een eerste keer', () => {
    const { s, db } = ready();
    const a = s.bank.import(statement([line('2026-09-01', -1000, 'Bol'), line('2026-09-02', 2500, 'Klant')]), { filename: 'september.csv', contentHash: 'h1' });
    expect(a.imported).toBe(2);
    expect(s.bank.imports()).toMatchObject([{ id: a.batchId, filename: 'september.csv', lines: 2, processed: 0, blocked: null, from: '2026-09-01', to: '2026-09-02', accounts: 'Zakelijk' }]);

    expect(s.bank.removeImportPreview(a.batchId)).toMatchObject({ lines: 2, processed: [], evidence: 0, skippedElsewhere: 0, doubles: 0, blocked: null });
    expect(s.bank.removeImport(a.batchId)).toEqual({ lines: 2, kept: 0, undone: 0, restored: 0 });

    expect(s.bank.list()).toEqual([]);
    expect(s.bank.imports()).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM import_batch_accounts').get()).toEqual({ n: 0 });
    expect(s.bank.importStatus()[0]!.lastImport).toBeNull();

    const again = s.bank.import(statement([line('2026-09-01', -1000, 'Bol'), line('2026-09-02', 2500, 'Klant')]), { filename: 'september.csv', contentHash: 'h1' });
    expect(again.imported).toBe(2);
    expect(again.duplicates).toBe(0);
    expect(s.bank.list()).toHaveLength(2);
  });

  it('draait verwerkte regels eerst terug met een tegenboeking', () => {
    const { s, db } = ready();
    const a = s.bank.import(statement([line('2026-09-01', -1000, 'Bol'), line('2026-09-02', 2500, 'Klant')]), { filename: 'september.csv' });
    const bol = s.bank.list().find((t) => t.counter_name === 'Bol')!;
    const entryId = s.bank.bookToAccount(bol.id, { account: ACCOUNTS.vraagposten });
    expect(s.bank.imports()[0]).toMatchObject({ processed: 1 });

    const preview = s.bank.removeImportPreview(a.batchId);
    expect(preview.processed).toMatchObject([{ id: bol.id, amount: -1000, counterName: 'Bol' }]);
    expect(s.bank.removeImport(a.batchId)).toEqual({ lines: 2, kept: 0, undone: 1, restored: 0 });

    expect(db.prepare('SELECT status FROM journal_entries WHERE id = ?').get(entryId)).toEqual({ status: 'teruggedraaid' });
    expect(s.ledger.balance(ACCOUNTS.vraagposten)).toBe(0);
    expect(s.bank.list()).toEqual([]);
  });

  it('een regel uit een later afschrift die hierdoor was overgeslagen, komt er alsnog in', () => {
    const { s, db } = ready();
    const a = s.bank.import(statement([line('2026-09-01', -1000, 'Bol')]), { filename: 'week1.csv' });
    // dezelfde kaartbetaling in een CAMT-bestand, op de boekdatum een dag later: overgeslagen, want hij stond er al
    const b = s.bank.import(statement([{ ...line('2026-09-02', -1000, 'Bol'), bankId: 'X1' }, { ...line('2026-09-03', -500, 'Coolblue'), bankId: 'X2' }], 'camt'), { filename: 'week1-2.xml' });
    expect(b).toMatchObject({ imported: 1, skipped: 1 });
    expect(s.bank.skippedRows({ batchId: b.batchId })).toHaveLength(1);

    expect(s.bank.removeImportPreview(a.batchId)).toMatchObject({ skippedElsewhere: 1 });
    expect(s.bank.removeImport(a.batchId)).toEqual({ lines: 1, kept: 0, undone: 0, restored: 1 });

    // het geld stond alleen in het eerste bestand: nu via het tweede
    expect(s.bank.list().map((t) => [t.counter_name, t.amount, t.import_batch_id]).sort()).toEqual([['Bol', -1000, b.batchId], ['Coolblue', -500, b.batchId]]);
    expect(s.bank.skippedRows({ batchId: b.batchId })).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM import_skipped').get()).toEqual({ n: 0 });
    expect(s.bank.imports()).toMatchObject([{ id: b.batchId, lines: 2 }]);
  });

  it('dezelfde betaling in drie soorten afschrift: na het weghalen van het eerste staat hij er één keer', () => {
    const { s } = ready();
    const a = s.bank.import(statement([line('2026-09-01', -1000, 'Bol')]), { filename: 'a.csv' });
    const b = s.bank.import(statement([line('2026-09-02', -1000, 'Bol')], 'mt940'), { filename: 'b.sta' });
    const c = s.bank.import(statement([{ ...line('2026-09-03', -1000, 'Bol'), bankId: 'C1' }], 'camt'), { filename: 'c.xml' });
    expect([b.skipped, c.skipped]).toEqual([1, 1]);

    expect(s.bank.removeImportPreview(a.batchId)).toMatchObject({ skippedElsewhere: 1 });
    expect(s.bank.removeImport(a.batchId)).toEqual({ lines: 1, kept: 0, undone: 0, restored: 1 });
    // één keer, uit het oudste van de twee (MT940); de CAMT-regel blijft overgeslagen, nu tegen die ene
    expect(s.bank.list().map((t) => [t.amount, t.import_batch_id])).toEqual([[-1000, b.batchId]]);
    expect(s.bank.skippedRows({ batchId: c.batchId }).map((k) => k.existing.id)).toEqual(s.bank.list().map((t) => t.id));
    expect(s.bank.statementBalance()).toBe(-1000);
  });

  it('een betaling die ook in een bewaard overlappend afschrift staat, blijft staan en hoort bij dat afschrift', () => {
    const { s, db } = ready();
    const week = s.bank.import(statement([line('2026-09-01', -1000, 'Bol')]), { filename: 'week.csv' });
    const month = s.bank.import(statement([line('2026-09-01', -1000, 'Bol'), line('2026-09-30', -2000, 'Coolblue')]), { filename: 'maand.csv' });
    expect(month).toMatchObject({ imported: 1, duplicates: 1 });

    expect(s.bank.removeImportPreview(week.batchId)).toMatchObject({ lines: 1, kept: 1, processed: [], skippedElsewhere: 0 });
    expect(s.bank.removeImport(week.batchId)).toEqual({ lines: 1, kept: 1, undone: 0, restored: 0 });
    expect(s.bank.list().map((t) => [t.transaction_date, t.amount, t.import_batch_id]).sort()).toEqual([['2026-09-01', -1000, month.batchId], ['2026-09-30', -2000, month.batchId]]);
    expect(s.bank.statementBalance()).toBe(-3000);
    expect(s.bank.imports()).toMatchObject([{ id: month.batchId, lines: 2, from: '2026-09-01', to: '2026-09-30' }]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM import_returned').get()).toEqual({ n: 0 });
    // en de maand daarna weghalen haalt wél alles weg
    s.bank.removeImport(month.batchId);
    expect(s.bank.list()).toEqual([]);
  });

  it('een regel uit een ander afschrift die als dubbel hiervan weg was, komt terug', () => {
    const { s } = ready();
    const a = s.bank.import(statement([line('2026-09-01', -1000, 'Bol')]), { filename: 'bank.csv' });
    // hetzelfde bedrag twee dagen later uit een tweede CSV: twee regels, de gebruiker zei dat het één betaling was
    s.bank.import(statement([line('2026-09-03', -1000, 'Bol')]), { filename: 'bank2.csv' });
    const [first, second] = s.bank.list().sort((x, y) => x.id - y.id);
    expect(second).toBeDefined();
    s.bank.ignore(second!.id, first!.id);
    expect(s.bank.get(second!.id).duplicate_of).toBe(first!.id);

    expect(s.bank.removeImportPreview(a.batchId)).toMatchObject({ doubles: 1 });
    s.bank.removeImport(a.batchId);
    expect(s.bank.list().map((t) => [t.id, t.status, t.duplicate_of])).toEqual([[second!.id, 'nieuw', null]]);
  });

  it('bonnen die er als bewijs bij hingen gaan terug naar "Nog controleren"', () => {
    const { s, db } = ready();
    const a = s.bank.import(statement([line('2026-09-01', -1000, 'Bol')]), { filename: 'bank.csv' });
    const t = s.bank.list()[0]!;
    db.prepare(`INSERT INTO documents (file_path, original_name, mime_type, sha256, status) VALUES ('/x/bon.pdf', 'bon.pdf', 'application/pdf', 'abc', 'verwerkt')`).run();
    const docId = (db.prepare('SELECT id FROM documents').get() as { id: number }).id;
    db.prepare(`INSERT INTO document_links (document_id, bank_transaction_id, is_primary, origin) VALUES (?, ?, 1, 'bewijs')`).run(docId, t.id);

    expect(s.bank.removeImportPreview(a.batchId)).toMatchObject({ evidence: 1 });
    s.bank.removeImport(a.batchId);
    expect(db.prepare('SELECT status FROM documents WHERE id = ?').get(docId)).toEqual({ status: 'controle' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM document_links').get()).toEqual({ n: 0 });
  });

  it('niet bij een afschrift uit de bankkoppeling en niet in een afgesloten periode', () => {
    const { s } = ready();
    const feed = s.bank.import(statement([line('2026-09-01', -1000, 'Bol')], 'openbanking'));
    expect(s.bank.imports()[0]!.blocked).toMatch(/bankkoppeling/);
    expect(() => s.bank.removeImport(feed.batchId)).toThrow(/bankkoppeling/);

    const old = s.bank.import(statement([line('2026-03-01', -1000, 'Bol')]), { filename: 'maart.csv' });
    s.bank.bookToAccount(s.bank.list().find((t) => t.transaction_date === '2026-03-01')!.id, { account: ACCOUNTS.vraagposten });
    s.periods.close('2026-06-30', s.periods.checks('2026-06-30').map((c) => c.key), '2026-10-15');
    expect(s.bank.imports().find((i) => i.id === old.batchId)!.blocked).toMatch(/afgesloten periode/);
    expect(() => s.bank.removeImport(old.batchId)).toThrow(/afgesloten periode/);
  });

  it('via de app alleen met de boekhouding voor de boekhouder aan, en na een back-up', async () => {
    const { s } = ready();
    const backups: string[] = [];
    const api = createApi(s, { appVersion: () => 'test', safetyBackup: async (label: string) => { backups.push(label); return null; } } as unknown as HostContext);
    const a = s.bank.import(statement([line('2026-09-01', -1000, 'Bol')]), { filename: 'bank.csv' });
    await expect(api.bank.removeImport(a.batchId)).rejects.toThrow(/Toon de boekhouding/);
    expect(s.bank.list()).toHaveLength(1);

    s.settings.update({ advancedMode: true, advancedModeAgreedAt: '2026-10-15' });
    expect(await api.bank.removeImport(a.batchId)).toEqual({ lines: 1, kept: 0, undone: 0, restored: 0 });
    expect(backups).toEqual([`voor-weghalen-afschrift-${a.batchId}`]);
    expect(s.bank.list()).toEqual([]);
  });
});
