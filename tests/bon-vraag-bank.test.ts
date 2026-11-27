import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { createApi, type HostContext } from '../src/main/api';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import { RECEIPT_WAIT_DAYS } from '../src/inbox/inbox';

/**
 * Een afschrijving zonder bon: geen btw aftrekken op een gok. "Zakelijk" bij een bekende winkel boekt pas met één
 * klik als er een bon bij de betaling hangt of als er geen btw af te trekken valt; anders eerst de vraag of je de bon
 * hebt. "De bon komt nog" houdt de vraag een week tegen. Bedragen en tegenpartijen zijn verzonnen.
 */

type S = ReturnType<typeof setup>['s'];

const world = () => {
  const ctx = setup();
  ctx.s.settings.update({ onboardingDone: true, company: { ...ctx.s.settings.get().company, name: 'Testbedrijf' } });
  const api = createApi(ctx.s, { appVersion: () => '0.0.0', hasSmtpPassword: () => false } as unknown as HostContext);
  return { ...ctx, api };
};

const debit = (s: S, date: string, amount: number, counterName: string) => {
  s.bank.import({ source: 'csv', warnings: [], transactions: [{ date, amount: -amount, description: `${counterName} pinbetaling`, counterName }] });
  return s.bank.list().find((t) => t.transaction_date === date && t.amount === -amount && t.counter_name === counterName)!;
};

const taskFor = (s: S, txId: number, asOf = '2026-09-28') => s.inbox.tasks(asOf).find((t) => t.ref.bankTransactionId === txId);

describe('"Zakelijk" bij een afschrijving zonder bon', () => {
  it('bekende winkel met 21%: niet met één klik boeken, eerst de vraag naar de bon', async () => {
    const { s, api } = world();
    const t = debit(s, '2026-09-10', 6050, 'GAMMA VOORBEELDSTAD');
    const task = taskFor(s, t.id)!;
    expect(task).toMatchObject({ kind: 'bank-business', ref: { categoryKey: 'materiaal', vatCode: 'hoog' } });
    expect(task.ref.documentId).toBeUndefined();
    expect(await api.home.act(task, 'zakelijk')).toEqual({ navigate: { screen: 'categorie', id: t.id } });
    expect(s.bank.get(t.id).status).toBe('nieuw');
    expect(s.ledger.balance(ACCOUNTS.btwVoorbelasting)).toBe(0);
  });

  it('"Nee, geen bon": de kosten komen erin zonder btw-aftrek', async () => {
    const { s, api } = world();
    const t = debit(s, '2026-09-10', 6050, 'GAMMA VOORBEELDSTAD');
    await api.home.act(taskFor(s, t.id)!, 'zakelijk', { categoryKey: 'materiaal', vatCode: 'geen' });
    expect(s.bank.get(t.id).status).toBe('gematcht');
    expect(s.ledger.balance(ACCOUNTS.btwVoorbelasting)).toBe(0);
  });

  it('met een bon bij de betaling: één klik boekt met het tarief van de winkel', async () => {
    const { s, api } = world();
    const t = debit(s, '2026-09-10', 6050, 'GAMMA VOORBEELDSTAD');
    await api.documents.addEvidence('bon.jpg', new Uint8Array([7, 7, 7]), t.id);
    const task = taskFor(s, t.id)!;
    expect(task.ref.documentId).toBeTypeOf('number');
    expect(api.bank.receipt(t.id)).toMatchObject({ document_id: task.ref.documentId });
    expect(await api.home.act(task, 'zakelijk')).toBeUndefined();
    expect(s.bank.get(t.id).status).toBe('gematcht');
    expect(s.ledger.balance(ACCOUNTS.btwVoorbelasting)).toBe(1050);
  });

  it('een winkel zonder btw (verzekering): één klik blijft één klik', async () => {
    const { s, api } = world();
    const t = debit(s, '2026-09-10', 4200, 'INTERPOLIS');
    const task = taskFor(s, t.id)!;
    expect(task.ref.vatCode).toBe('geen');
    expect(await api.home.act(task, 'zakelijk')).toBeUndefined();
    expect(s.bank.get(t.id).status).toBe('gematcht');
  });
});

describe('"De bon komt nog"', () => {
  it('de vraag verdwijnt een week en komt daarna terug', () => {
    const { s, api } = world();
    const t = debit(s, '2026-09-10', 6050, 'GAMMA VOORBEELDSTAD');
    expect(s.inbox.waitForReceipt(t.id, '2026-09-28')).toBe('2026-10-05');
    expect(RECEIPT_WAIT_DAYS).toBe(7);
    expect(taskFor(s, t.id, '2026-09-28')).toBeUndefined();
    expect(taskFor(s, t.id, '2026-10-04')).toBeUndefined();
    expect(taskFor(s, t.id, '2026-10-05')).toMatchObject({ kind: 'bank-business' });
    // via de API: vanaf vandaag
    expect(api.bank.waitForReceipt(t.id)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('alleen bij een afschrijving die nog niet verwerkt is', async () => {
    const { s, api } = world();
    const t = debit(s, '2026-09-10', 4200, 'INTERPOLIS');
    await api.home.act(taskFor(s, t.id)!, 'zakelijk');
    expect(() => s.inbox.waitForReceipt(t.id, '2026-09-28')).toThrow('al verwerkt');
  });
});
