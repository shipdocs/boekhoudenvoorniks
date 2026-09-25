import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrations } from '../src/db/migrations';
import { DEFAULT_ACCOUNTS } from '../src/core-ledger/accounts';
import { EXPENSE_CATEGORIES, OTHER_DESTINATIONS } from '../src/shared/categories';
import { rgsLabel, RGS_VERSION } from '../src/core-ledger/ledger';
import { setup } from './helpers';

describe('RGS-referentiecodes (#2)', () => {
  it('elke standaardrekening verwijst naar een bestaande officiële RGS-code', () => {
    expect(RGS_VERSION).toBe('20251210');
    for (const a of DEFAULT_ACCOUNTS) {
      expect(rgsLabel(a.ref), `${a.code} ${a.name} → ${a.ref}`).toBeTruthy();
    }
  });

  it('categorieën en bestemmingen verwijzen naar bestaande rekeningen', () => {
    const keys = new Set(DEFAULT_ACCOUNTS.map((a) => a.rgs));
    for (const c of [...EXPENSE_CATEGORIES, ...OTHER_DESTINATIONS]) expect(keys.has(c.account), c.key).toBe(true);
  });

  it('migratie vult rgs_ref in een bestaande administratie (van vóór v3)', () => {
    const db = new Database(':memory:');
    db.exec(migrations[0]!);
    db.exec(migrations[1]!);
    db.pragma('user_version = 2');
    const ins = db.prepare('INSERT INTO chart_of_accounts (rgs_code, code, name, category, is_system) VALUES (?, ?, ?, ?, 1)');
    ins.run('BLiqBanRba', '1100', 'Bank', 'activa');
    ins.run('BLiqBanRba2', '1101', 'Bank spaar', 'activa');
    ins.run('WOmzNopOlh', '8000', 'Omzet 21%', 'omzet');
    db.exec(migrations[2]!);
    const refs = Object.fromEntries((db.prepare('SELECT rgs_code, rgs_ref FROM chart_of_accounts').all() as { rgs_code: string; rgs_ref: string }[]).map((r) => [r.rgs_code, r.rgs_ref]));
    expect(refs).toEqual({ BLiqBanRba: 'BLimBanRba', BLiqBanRba2: 'BLimBanRbb', WOmzNopOlh: 'WOmzNodOdh' });
  });

  it('auditfile en exports gebruiken de officiële code; eigen rekening met ongeldige code wordt geweigerd', () => {
    const { s, klant } = setup();
    s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-03-01', lines: [{ description: 'x', quantity: 1, unitPrice: 1000, vatCode: 'hoog' }] }).id);
    const xaf = s.exports.auditfile('2026-01-01', '2026-12-31', s.settings.get().company, '0.1.0');
    expect(xaf).toContain('<txLink>WOmzNodOdh</txLink>');
    expect(xaf).not.toContain('<txLink>WOmzNopOlh</txLink>');
    expect(() => s.ledger.createAccount({ code: '4999', rgs: 'eigen-1', rgsRef: 'BestaatNiet', name: 'X', category: 'kosten' })).toThrow(/geen officiële RGS-code/);
    const ok = s.ledger.createAccount({ code: '4999', rgs: 'eigen-1', rgsRef: 'WBedHuiGwe', name: 'Energie werkplaats', category: 'kosten' });
    expect(ok.rgs_ref).toBe('WBedHuiGwe');
  });

  it('onderaannemer wordt op uitbesteed werk geboekt en telt mee in rubriek 2a', () => {
    const { s } = setup();
    s.quick.recordExpense({ date: '2026-04-15', supplierName: 'Klaas', description: 'Inhuur', categoryKey: 'onderaannemer', grossAmount: 100000, vatCode: 'verlegd', paidWith: 'bank' });
    expect(s.ledger.balance('WKprKuwKuw')).toBe(100000);
    expect(s.vat.calculate('2026-Q2').rubrieken.find((r) => r.code === '2a')).toMatchObject({ omzet: 100000, btw: 21000 });
  });
});
