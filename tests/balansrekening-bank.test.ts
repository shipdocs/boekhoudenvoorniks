import { describe, expect, it } from 'vitest';
import { ACCOUNTS, BV_LOON } from '../src/core-ledger/accounts';
import { setBusinessShare } from '../src/intake/business-share';
import { setup } from './helpers';

/**
 * Boekhoudermodus: een betaling op een balansrekening zetten (dev: verzoek van een bv-gebruiker die het nettoloon en de
 * loonheffing vanaf de bank op de balans wil boeken). Alleen rekeningen zonder eigen stroom in de app; zonder btw en
 * zonder zakelijk deel. De gewone gebruiker ziet deze keuze niet (scherm), de service weigert de rest (hier).
 */
const importOne = (s: ReturnType<typeof setup>['s'], amount: number, counterName = 'P. Jansen', date = '2026-10-01') => {
  s.bank.import({ source: 'csv', warnings: [], transactions: [{ date, amount, description: `Betaling ${counterName}`, counterName }] });
  return s.bank.list().find((t) => t.counter_name === counterName && t.amount === amount)!;
};
const lines = (s: ReturnType<typeof setup>['s'], entryId: number) =>
  s.db
    .prepare(`SELECT a.rgs_code AS rgs, l.debit, l.credit, l.vat_code AS vat FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id WHERE l.journal_entry_id = ? ORDER BY l.id`)
    .all(entryId) as { rgs: string; debit: number; credit: number; vat: string | null }[];

describe('balansrekening kiezen op het bankscherm', () => {
  it('de lijst bevat alleen balansrekeningen zonder eigen stroom', () => {
    const { s } = setup();
    s.ledger.seedBvAccounts();
    const rgs = s.bank.balanceAccounts().map((a) => a.rgs_code);
    for (const ok of [ACCOUNTS.leningen, ACCOUNTS.overigeVorderingen, ACCOUNTS.nogTeBetalenKosten, ACCOUNTS.overigeSchulden, BV_LOON.nettoloon, BV_LOON.loonheffing, BV_LOON.vpb, 'BVorOvrRca']) expect(rgs, ok).toContain(ok);
    for (const nope of [ACCOUNTS.bank, ACCOUNTS.kas, ACCOUNTS.kruisposten, ACCOUNTS.tussenrekeningPsp, ACCOUNTS.debiteuren, ACCOUNTS.crediteuren, ACCOUNTS.vraagposten, ACCOUNTS.priveOpnamen, ACCOUNTS.priveStortingen, ACCOUNTS.eigenVermogen, ACCOUNTS.inventaris, ACCOUNTS.vervoermiddelen, ACCOUNTS.voorraad, ACCOUNTS.omzetHoog, ACCOUNTS.btwVoorbelasting, ACCOUNTS.inkoopMaterialen]) expect(rgs, nope).not.toContain(nope);
  });

  it('een betaling op een balansrekening: zonder btw, zonder zakelijk deel, ook als er voor deze partij een zakelijk deel onthouden is', () => {
    const { s } = setup();
    s.ledger.seedBvAccounts();
    // 60% zakelijk onthouden voor deze naam: dat geldt voor kosten, niet voor een balansboeking
    setBusinessShare(s.db, 'P. Jansen', 60);
    const t = importOne(s, -350000);
    const entryId = s.bank.bookBalance(t.id, BV_LOON.nettoloon, 'Nettoloon oktober');
    const l = lines(s, entryId);
    expect(l.find((x) => x.rgs === BV_LOON.nettoloon)).toMatchObject({ debit: 350000, credit: 0 });
    expect(l.find((x) => x.rgs === ACCOUNTS.bank)).toMatchObject({ debit: 0, credit: 350000 });
    expect(l.some((x) => x.rgs === ACCOUNTS.btwVoorbelasting || x.rgs === ACCOUNTS.priveOpnamen)).toBe(false);
    expect(s.ledger.balance(BV_LOON.nettoloon)).toBe(350000);
    expect(s.bank.get(t.id).status).toBe('gematcht');
    const entry = s.ledger.listEntries({ source: 'bank' }).find((e) => e.id === entryId)!;
    expect(entry.description).toContain('Nettoloon oktober');
  });

  it('geld dat binnenkomt kan ook op een balansrekening (bv. een lening ontvangen)', () => {
    const { s } = setup();
    const t = importOne(s, 1000000, 'Bank Lening BV');
    const entryId = s.bank.bookBalance(t.id, ACCOUNTS.leningen);
    const l = lines(s, entryId);
    expect(l.find((x) => x.rgs === ACCOUNTS.leningen)).toMatchObject({ credit: 1000000 });
    expect(s.ledger.balance(ACCOUNTS.leningen)).toBe(-1000000);
  });

  it('rekeningen met een eigen stroom worden geweigerd', () => {
    const { s } = setup();
    const t = importOne(s, -5000);
    for (const rgs of [ACCOUNTS.kas, ACCOUNTS.debiteuren, ACCOUNTS.priveOpnamen, ACCOUNTS.vraagposten, ACCOUNTS.inkoopMaterialen, 'bestaat-niet']) {
      expect(() => s.bank.bookBalance(t.id, rgs), rgs).toThrow(/balansrekening uit de lijst/);
    }
    expect(s.bank.get(t.id).status).toBe('nieuw');
  });

  it('een bv-rekening die nog niet in het schema staat, staat ook niet in de lijst', () => {
    const { s } = setup();
    expect(s.bank.balanceAccounts().some((a) => a.rgs_code === BV_LOON.nettoloon)).toBe(false);
    const t = importOne(s, -350000);
    expect(() => s.bank.bookBalance(t.id, BV_LOON.nettoloon)).toThrow(/balansrekening uit de lijst/);
  });
});
