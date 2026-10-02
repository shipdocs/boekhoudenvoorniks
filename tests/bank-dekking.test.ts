import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toSqliteUtc } from '../src/shared/dates';
import type { NormalizedTransaction } from '../src/import/types';
import { ValidationError } from '../src/shared/validation';
import { setup } from './helpers';

/** Vaste tijd midden op de dag in SQLite-UTC: geen aanname over de tijdzone van de machine. */
const AT = (dag: string) => `${dag} 12:00:00`;

const csv = (transactions: NormalizedTransaction[]) => ({ source: 'csv' as const, warnings: [], transactions });
const feed = (transactions: NormalizedTransaction[]) => ({ source: 'openbanking' as const, warnings: [], transactions });

const scenario = () => {
  const { s, db } = setup();
  const account = s.bank.ensureDefaultAccount();
  const dekkingsrij = (batchId: number) =>
    db.prepare('SELECT period_from, period_to, transactions, imported, duplicates, closing_balance, closing_date FROM import_batch_accounts WHERE batch_id = ? AND bank_account_id = ?').get(batchId, account.id);
  return { s, db, account, dekkingsrij };
};

beforeEach(() => {
  // vaste geïnjecteerde tijd na alle testmomenten: geen machine-klok- of tijdzone-aanname (#245)
  vi.useFakeTimers({ now: new Date('2026-10-12T12:00:00Z') });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Ponto WP3: import-opties voor dekking (#245)', () => {
  it('een lege expliciete periode schuift completeTo volgens de bestaande regels op', () => {
    const { s, account } = scenario();
    s.bank.import(feed([]), { bankAccountId: account.id, period: { from: '2026-09-30', to: '2026-09-30' }, importedAt: AT('2026-09-30') });
    // de periode is op 30 september zelf bewezen: die dag telt pas na een ronde van een latere dag
    expect(s.bank.importStatus()[0]).toMatchObject({ completeTo: '2026-09-29', gap: null });
    s.bank.import(feed([]), { bankAccountId: account.id, period: { from: '2026-09-30', to: '2026-09-30' }, importedAt: AT('2026-10-01') });
    expect(s.bank.importStatus()[0]).toMatchObject({ completeTo: '2026-09-30', gap: null });
    // de lege dekkingsrijen zijn geen bekende periode voor echte betalingen: die worden gewoon toegevoegd
    const r = s.bank.import(csv([{ date: '2026-09-30', amount: 2500, description: 'Rente' }]), { bankAccountId: account.id, importedAt: AT('2026-10-02') });
    expect(r).toMatchObject({ imported: 1, addedInKnownPeriod: 0 });
    expect(s.bank.addedInKnownPeriod(r.batchId)).toEqual([]);
  });

  it('een gat blijft zichtbaar en wordt pas gedicht door een periode die de dag zelf beslaat', () => {
    const { s, account } = scenario();
    s.bank.import(feed([]), { bankAccountId: account.id, period: { from: '2026-09-01', to: '2026-09-30' }, importedAt: AT('2026-09-30') });
    s.bank.import(feed([]), { bankAccountId: account.id, period: { from: '2026-10-01', to: '2026-10-09' }, importedAt: AT('2026-10-10') });
    // 30 september is op die dag zelf bewezen en het volgende bewijs begint pas 1 oktober: een gat (#226)
    expect(s.bank.importStatus()[0]).toMatchObject({ completeTo: '2026-09-29', gap: '2026-09-30' });
    s.bank.import(feed([]), { bankAccountId: account.id, period: { from: '2026-09-30', to: '2026-10-01' }, importedAt: AT('2026-10-11') });
    expect(s.bank.importStatus()[0]).toMatchObject({ completeTo: '2026-10-09', gap: null });
  });

  it('met een expliciete periode is er altijd één dekkingsrij, ook bij nul transacties; zonder periode geen rij', () => {
    const { s, account, dekkingsrij } = scenario();
    const r = s.bank.import(feed([]), { bankAccountId: account.id, period: { from: '2026-09-01', to: '2026-09-05' }, importedAt: AT('2026-09-05') });
    expect(r).toMatchObject({ imported: 0, duplicates: 0, periods: [{ bankAccountId: account.id, from: '2026-09-01', to: '2026-09-05' }] });
    expect(dekkingsrij(r.batchId)).toEqual({ period_from: '2026-09-01', period_to: '2026-09-05', transactions: 0, imported: 0, duplicates: 0, closing_balance: null, closing_date: null });
    expect(s.bank.importStatus()[0]!.lastImport).toMatchObject({ transactions: 0, imported: 0, duplicates: 0, from: '2026-09-01', to: '2026-09-05' });
    // zonder periode maakt een lege import geen dekkingsrij
    const leeg = s.bank.import(feed([]), { bankAccountId: account.id, importedAt: AT('2026-09-06') });
    expect(s.db.prepare('SELECT COUNT(*) AS n FROM import_batch_accounts WHERE batch_id = ?').get(leeg.batchId)).toEqual({ n: 0 });
  });

  it('een periode naast transacties blijft één rij en breidt die uit; eindsaldo blijft zoals het afschrift hem gaf', () => {
    const { s, account, dekkingsrij } = scenario();
    const r = s.bank.import(csv([{ date: '2026-09-03', amount: 5000, description: 'Rente' }]), {
      bankAccountId: account.id,
      period: { from: '2026-09-01', to: '2026-09-05' },
      importedAt: AT('2026-09-05'),
    });
    expect(r.periods).toEqual([{ bankAccountId: account.id, from: '2026-09-01', to: '2026-09-05' }]);
    expect(dekkingsrij(r.batchId)).toMatchObject({ period_from: '2026-09-01', period_to: '2026-09-05', transactions: 1, imported: 1, duplicates: 0, closing_balance: null, closing_date: null });
  });

  it('nul transacties verandert addedInKnownPeriod niet: een lege dekkingsrij is geen bekende periode', () => {
    const { s, account } = scenario();
    s.bank.import(feed([]), { bankAccountId: account.id, period: { from: '2026-09-01', to: '2026-09-05' }, importedAt: AT('2026-09-05') });
    const r = s.bank.import(csv([{ date: '2026-09-03', amount: 5000, description: 'Rente' }]), { bankAccountId: account.id, importedAt: AT('2026-09-06') });
    expect(r).toMatchObject({ imported: 1, addedInKnownPeriod: 0 });
    expect(s.bank.addedInKnownPeriod(r.batchId)).toEqual([]);
  });

  it('ongeldig formaat, ongeldige datum en te ver in de toekomst worden geweigerd; verleden is goed', () => {
    const { s, account } = scenario();
    expect(() => s.bank.import(feed([]), { importedAt: '2026-09-30T12:00:00Z' })).toThrow(ValidationError);
    expect(() => s.bank.import(feed([]), { importedAt: '2026-09-30 12:00' })).toThrow(/YYYY-MM-DD HH:MM:SS/);
    expect(() => s.bank.import(feed([]), { importedAt: '2026-02-30 12:00:00' })).toThrow(/geldige datum/);
    expect(() => s.bank.import(feed([]), { importedAt: '2026-09-30 25:00:00' })).toThrow(/geldige datum/);
    expect(() => s.bank.import(feed([]), { importedAt: '2099-01-01 12:00:00' })).toThrow(/toekomst/);
    expect(() => s.bank.import(feed([]), { bankAccountId: account.id, importedAt: '2000-01-01 12:00:00' })).not.toThrow();
  });

  it('een periode zonder rekening, van na naar voor, of voor een onbekende rekening wordt geweigerd', () => {
    const { s, account } = scenario();
    expect(() => s.bank.import(feed([]), { period: { from: '2026-09-05', to: '2026-09-01' } })).toThrow(/bankrekening/);
    expect(() => s.bank.import(feed([]), { bankAccountId: account.id, period: { from: '2026-09-05', to: '2026-09-01' } })).toThrow(/begin van de periode/);
    expect(() => s.bank.import(feed([]), { bankAccountId: account.id, period: { from: 'niet-een-datum', to: '2026-09-01' } })).toThrow(/geldige datums/);
    expect(() => s.bank.import(feed([]), { bankAccountId: 9999, period: { from: '2026-09-01', to: '2026-09-05' } })).toThrow(/bestaat niet/);
  });

  it('ISO met Z of offset geeft de juiste UTC in SQLite-formaat, anders een fout', () => {
    expect(toSqliteUtc('2026-09-30T12:34:56Z')).toBe('2026-09-30 12:34:56');
    expect(toSqliteUtc('2026-09-30T00:30:00+02:00')).toBe('2026-09-29 22:30:00');
    expect(toSqliteUtc('2026-09-30T00:30:00+0200')).toBe('2026-09-29 22:30:00');
    expect(toSqliteUtc('2026-09-30T22:30:00-04:00')).toBe('2026-10-01 02:30:00');
    expect(toSqliteUtc('2026-09-30T12:34:56.123Z')).toBe('2026-09-30 12:34:56');
    expect(() => toSqliteUtc('2026-09-30 12:34:56')).toThrow(ValidationError);
    expect(() => toSqliteUtc('2026-02-30T12:34:56Z')).toThrow(ValidationError);
    expect(() => toSqliteUtc('gisteren')).toThrow(ValidationError);
  });

  it('alle bestaande importpaden zonder opties blijven gelijk', () => {
    const { s, db, account } = scenario();
    const nu = () => (db.prepare("SELECT datetime('now') AS t").get() as { t: string }).t;
    const voor = nu();
    const r = s.bank.import(csv([{ date: '2026-09-03', amount: 5000, description: 'Rente' }]));
    const na = nu();
    const row = db.prepare('SELECT imported_at FROM import_batches WHERE id = ?').get(r.batchId) as { imported_at: string };
    // datetime('now') schrijft UTC; de standaardwaarde komt van dezelfde SQLite-klok (de JS-klok staat op vaste tijd)
    expect(row.imported_at >= voor).toBe(true);
    expect(row.imported_at <= na).toBe(true);
    expect(r).toMatchObject({ imported: 1, addedInKnownPeriod: 0, knownFrom: [] });
    expect(s.bank.importStatus()[0]).toMatchObject({ bankAccountId: account.id, coverageFrom: '2026-09-03', coverageTo: '2026-09-03' });
    // een lege import zonder saldo of periode maakt ook zonder de nieuwe opties geen dekkingsrij
    const leeg = s.bank.import(csv([]));
    expect(db.prepare('SELECT COUNT(*) AS n FROM import_batch_accounts WHERE batch_id = ?').get(leeg.batchId)).toEqual({ n: 0 });
  });
});
