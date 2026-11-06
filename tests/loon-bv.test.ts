import { describe, expect, it } from 'vitest';
import { ACCOUNTS, BV_LOON } from '../src/core-ledger/accounts';
import { setup } from './helpers';

/**
 * Loon bij een bv: maandvoorstel op Vandaag, boeking na bevestiging (nooit vanzelf), betalingen via het bankscherm.
 * Verwachtingen met de hand: loonstrook bruto € 5.000, loonheffing € 1.500, netto € 3.500 →
 * Loon DGA 5.000 (debet) aan Af te dragen loonheffing 1.500 en Nog te betalen nettoloon 3.500 (credit).
 * Na "Nettoloon betaald" € 3.500 en "Loonheffing betaald" € 1.500 staan beide schulden op nul.
 */
const LOON = { bruto: 500000, loonheffing: 150000, netto: 350000, vanaf: '2026-08' };
const bv = (s: ReturnType<typeof setup>['s']) => s.settings.update({ legalForm: 'bv', loon: LOON });
const lines = (s: ReturnType<typeof setup>['s'], entryId: number) =>
  s.db
    .prepare(`SELECT a.rgs_code AS rgs, l.debit, l.credit FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id WHERE l.journal_entry_id = ? ORDER BY l.id`)
    .all(entryId) as { rgs: string; debit: number; credit: number }[];

describe('loon bij een bv', () => {
  it('de instelling hoort bij een bv en bruto moet gelijk zijn aan loonheffing plus netto', () => {
    const { s } = setup();
    expect(() => s.settings.update({ legalForm: 'eenmanszaak', loon: LOON })).toThrow(/hoort bij een bv/);
    expect(() => s.settings.update({ legalForm: 'bv', loon: { ...LOON, netto: 340000 } })).toThrow(/gelijk zijn aan loonheffing plus netto/);
    expect(() => s.settings.update({ legalForm: 'bv', loon: { ...LOON, vanaf: '2026-13' } })).toThrow(/vanaf welke maand/);
    expect(bv(s).loon).toEqual(LOON);
    expect(s.loon.active()).toEqual(LOON);
  });

  it('zonder bv of zonder instelling is er geen voorstel', () => {
    const { s } = setup();
    expect(s.loon.pendingMonths('2026-10-25')).toEqual([]);
    expect(s.inbox.tasks('2026-10-25').some((t) => t.kind === 'loon')).toBe(false);
    s.settings.update({ legalForm: 'bv' });
    expect(s.loon.pendingMonths('2026-10-25')).toEqual([]);
  });

  it('voorstellen vanaf de eerste maand; de lopende maand pas vanaf de 20e', () => {
    const { s } = setup();
    bv(s);
    expect(s.loon.pendingMonths('2026-10-15').map((m) => m.month)).toEqual(['2026-08', '2026-09']);
    expect(s.loon.pendingMonths('2026-10-25').map((m) => m.month)).toEqual(['2026-08', '2026-09', '2026-10']);
    expect(s.loon.pendingMonths('2026-10-25')[2]).toMatchObject({ label: 'oktober 2026' });
    const task = s.inbox.tasks('2026-10-25').find((t) => t.key === 'loon-2026-10')!;
    expect(task).toMatchObject({ kind: 'loon', ref: { periodKey: '2026-10' } });
    expect(task.question).toContain('5.000,00');
    expect(task.question).toContain('1.500,00');
    expect(task.question).toContain('3.500,00');
    expect(task.actions.map((a) => a.id)).toEqual(['ja', 'aanpassen']);
  });

  it('boeken: Loon DGA aan loonheffing en nettoloon op de laatste dag van de maand, één keer per maand', () => {
    const { s } = setup();
    bv(s);
    const entryId = s.loon.book('2026-09');
    const entry = s.ledger.listEntries({ source: 'handmatig' }).find((e) => e.id === entryId)!;
    expect(entry.entry_date).toBe('2026-09-30');
    expect(entry.description).toContain('Loon september 2026');
    expect(lines(s, entryId)).toEqual([
      { rgs: BV_LOON.loonDga, debit: 500000, credit: 0 },
      { rgs: BV_LOON.loonheffing, debit: 0, credit: 150000 },
      { rgs: BV_LOON.nettoloon, debit: 0, credit: 350000 },
    ]);
    expect(s.loon.isBooked('2026-09')).toBe(true);
    expect(s.loon.bookedMonths()).toEqual(['2026-09']);
    expect(s.loon.pendingMonths('2026-10-25').map((m) => m.month)).toEqual(['2026-08', '2026-10']);
    expect(s.inbox.tasks('2026-10-25').some((t) => t.key === 'loon-2026-09')).toBe(false);
    expect(() => s.loon.book('2026-09')).toThrow(/al geboekt/);
    // teruggedraaid: dan mag het opnieuw
    s.ledger.reverse(entryId, '2026-10-01');
    expect(s.loon.isBooked('2026-09')).toBe(false);
  });

  it('afwijkende bedragen voor één maand, zonder de instelling te veranderen', () => {
    const { s } = setup();
    bv(s);
    const entryId = s.loon.book('2026-08', { bruto: 520000, loonheffing: 160000, netto: 360000 });
    expect(lines(s, entryId).map((l) => l.debit || -l.credit)).toEqual([520000, -160000, -360000]);
    expect(() => s.loon.book('2026-09', { bruto: 520000, loonheffing: 160000, netto: 350000 })).toThrow(/gelijk zijn aan loonheffing plus netto/);
    expect(s.settings.get().loon).toEqual(LOON);
  });

  it('nettoloon en loonheffing betaald vanaf de bank halen de schulden weg; geen kosten en geen btw', () => {
    const { s } = setup();
    bv(s);
    s.loon.book('2026-09');
    s.bank.import({ source: 'csv', warnings: [], transactions: [
      { date: '2026-09-25', amount: -350000, description: 'Salaris september', counterName: 'P. Jansen' },
      { date: '2026-10-28', amount: -150000, description: 'Loonheffingen 2026-09', counterName: 'Belastingdienst' },
    ] });
    const netto = s.bank.list().find((t) => t.amount === -350000)!;
    const heffing = s.bank.list().find((t) => t.amount === -150000)!;
    s.bank.bookBalance(netto.id, BV_LOON.nettoloon, 'Nettoloon betaald');
    s.bank.bookBalance(heffing.id, BV_LOON.loonheffing, 'Loonheffing betaald');
    expect(s.ledger.balance(BV_LOON.nettoloon)).toBe(0);
    expect(s.ledger.balance(BV_LOON.loonheffing)).toBe(0);
    expect(s.ledger.balance(BV_LOON.loonDga)).toBe(500000);
    expect(s.ledger.balance(ACCOUNTS.btwVoorbelasting)).toBe(0);
    // de betalingen tellen niet als kosten: de kosten zitten al in de loonboeking
    const kosten = s.ledger.balances().filter((b) => b.category === 'kosten').reduce((n, b) => n + b.balance, 0);
    expect(kosten).toBe(500000);
  });

  it('zonder bv-rekeningen in het schema (oude administratie) worden ze bij het boeken toegevoegd', () => {
    const { s } = setup();
    // de instelling via de service zet de rekeningen niet klaar (dat doet de app-laag); boeken doet het alsnog
    bv(s);
    expect(s.ledger.listAccounts().some((a) => a.rgs_code === BV_LOON.nettoloon)).toBe(false);
    s.loon.book('2026-08');
    expect(s.ledger.listAccounts().some((a) => a.rgs_code === BV_LOON.nettoloon)).toBe(true);
  });
});
