import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApi, type HostContext } from '../src/main/api';
import { BANK_FEED } from '../src/shared/bank-feed';
import type { Task, TaskKind } from '../src/inbox/inbox';
import { today } from '../src/shared/dates';
import { setup } from './helpers';

type Context = ReturnType<typeof setup>;

function context(): Context {
  const ctx = setup();
  ctx.s.settings.update({ onboardingDone: true });
  return ctx;
}

function addFeed(ctx: Context, changes: Record<string, unknown> = {}): number {
  const account = ctx.s.bank.listAccounts()[0]!;
  const values = {
    external_id: 'ponto-1',
    bank_account_id: account.id,
    name: 'Zakelijke rekening',
    status: 'actief',
    expires_at: '2026-12-01',
    balance: null,
    balance_at: null,
    balance_diff: null,
    balance_diff_rounds: 0,
    transactions_synchronized_at: null,
    last_ok_at: '2026-10-03 08:00:00',
    last_error_kind: null,
    last_round_at: '2026-10-03 08:00:00',
    created_at: '2026-10-03 08:00:00',
    ...changes,
  };
  return Number(ctx.db.prepare(
    `INSERT INTO bank_feed_accounts
      (external_id, bank_account_id, name, status, expires_at, balance, balance_at,
       balance_diff, balance_diff_rounds, transactions_synchronized_at, last_ok_at,
       last_error_kind, last_round_at, created_at)
     VALUES (@external_id, @bank_account_id, @name, @status, @expires_at, @balance,
       @balance_at, @balance_diff, @balance_diff_rounds, @transactions_synchronized_at,
       @last_ok_at, @last_error_kind, @last_round_at, @created_at)`,
  ).run(values).lastInsertRowid);
}

function feedTasks(ctx: Context, asOf = '2026-10-03'): Task[] {
  return ctx.s.inbox.tasks(asOf).filter((task) => task.kind.startsWith('feed-'));
}

function kind(ctx: Context, wanted: TaskKind, asOf = '2026-10-03'): Task {
  return ctx.s.inbox.tasks(asOf).find((task) => task.kind === wanted)!;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-03T12:00:00.000Z'));
  BANK_FEED.available = true;
});

afterEach(() => {
  BANK_FEED.available = false;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Ponto-taken op Vandaag (#248)', () => {
  it('laat zonder ingeschakelde relevante feed exact de bestaande taken staan', () => {
    const ctx = context();
    BANK_FEED.available = false;
    const before = ctx.s.inbox.tasks('2026-10-03');
    BANK_FEED.available = true;
    expect(ctx.s.inbox.tasks('2026-10-03')).toEqual(before);
    addFeed(ctx, { status: 'niet-gebruiken', bank_account_id: null });
    expect(ctx.s.inbox.tasks('2026-10-03')).toEqual(before);
  });

  it('waarschuwt op de grenzen 14 en 0 dagen en maakt daarna een verlopen taak', () => {
    const ctx = context();
    const id = addFeed(ctx, { expires_at: '2026-10-17' });
    let task = kind(ctx, 'feed-expiring');
    expect(task).toMatchObject({ priority: 2, actions: [{ id: 'ponto', label: 'Naar Ponto' }, { id: 'later', label: 'Later' }] });

    ctx.db.prepare('UPDATE bank_feed_accounts SET expires_at = ? WHERE id = ?').run('2026-10-18', id);
    expect(feedTasks(ctx)).toEqual([]);
    ctx.db.prepare('UPDATE bank_feed_accounts SET expires_at = ? WHERE id = ?').run('2026-10-03', id);
    expect(kind(ctx, 'feed-expiring')).toBeTruthy();
    ctx.db.prepare('UPDATE bank_feed_accounts SET expires_at = ? WHERE id = ?').run('2026-10-02', id);
    task = kind(ctx, 'feed-expired');
    expect(task).toMatchObject({ priority: 1, actions: [{ id: 'ponto', label: 'Naar Ponto' }, { id: 'afschrift', label: 'Afschrift inlezen' }] });
  });

  it('maakt taken voor bewezen verlopen, credentials en verdwenen rekening met de afgesproken acties', () => {
    const expired = context();
    addFeed(expired, { expires_at: null, last_error_kind: 'expired' });
    expect(kind(expired, 'feed-expired').actions.map((action) => action.id)).toEqual(['ponto', 'afschrift']);

    const credentials = context();
    addFeed(credentials, { last_error_kind: 'credentials' });
    expect(kind(credentials, 'feed-credentials')).toMatchObject({ priority: 1, actions: [{ id: 'opnieuw', label: 'Opnieuw plakken' }] });

    const gone = context();
    addFeed(gone, { status: 'weg', last_error_kind: 'account-gone' });
    expect(kind(gone, 'feed-account-gone').actions.map((action) => action.id)).toEqual(['bekijken', 'niet-gebruiken']);
  });

  it('wordt pas na meer dan drie dagen stil en toont geen silent naast een specifiekere fout', () => {
    const ctx = context();
    const id = addFeed(ctx, { last_ok_at: '2026-09-30 10:00:00', last_round_at: '2026-09-30 10:00:00' });
    expect(feedTasks(ctx, '2026-10-03')).toEqual([]);
    expect(kind(ctx, 'feed-silent', '2026-10-04')).toMatchObject({
      priority: 1,
      actions: [{ id: 'bank', label: 'Bank bekijken' }, { id: 'afschrift', label: 'Afschrift inlezen' }],
    });
    ctx.db.prepare('UPDATE bank_feed_accounts SET last_error_kind = ? WHERE id = ?').run('credentials', id);
    expect(feedTasks(ctx, '2026-10-04').map((task) => task.kind)).toEqual(['feed-credentials']);
  });

  it('vervangt bij een concrete feedstoring de dubbele bank-stale taak, maar niet bij incomplete gezonde dekking', () => {
    const ctx = context();
    const id = addFeed(ctx, { last_error_kind: 'credentials' });
    expect(ctx.s.inbox.tasks('2026-10-03').filter((task) => task.kind === 'bank-stale' || task.kind.startsWith('feed-')).map((task) => task.kind)).toEqual(['feed-credentials']);

    ctx.db.prepare('UPDATE bank_feed_accounts SET last_error_kind = NULL, last_ok_at = ? WHERE id = ?').run('2026-10-03 08:00:00', id);
    expect(ctx.s.inbox.tasks('2026-10-03').some((task) => task.kind === 'bank-stale')).toBe(true);
    expect(feedTasks(ctx)).toEqual([]);

    ctx.s.bank.import(
      { source: 'openbanking', warnings: [], transactions: [] },
      { bankAccountId: 1, period: { from: '2026-09-01', to: '2026-10-03' }, importedAt: '2026-10-03 12:00:00' },
    );
    expect(ctx.s.inbox.tasks('2026-10-03').some((task) => task.kind === 'bank-stale' || task.kind.startsWith('feed-'))).toBe(false);
  });

  it('maakt een saldotaak uitsluitend na twee vergelijkbare rondes met volledige metadata', () => {
    const ctx = context();
    const accountId = ctx.s.bank.listAccounts()[0]!.id;
    ctx.s.bank.setOpeningBalance(accountId, 100_000, '2026-09-01');
    const id = addFeed(ctx, {
      balance: 110_000,
      balance_at: '2026-10-03T08:00:00.000Z',
      transactions_synchronized_at: '2026-10-03T08:00:00.000Z',
      balance_diff: 10_000,
      balance_diff_rounds: 1,
    });
    expect(feedTasks(ctx).some((task) => task.kind === 'feed-balance')).toBe(false);
    ctx.db.prepare('UPDATE bank_feed_accounts SET balance_diff_rounds = 2 WHERE id = ?').run(id);
    expect(kind(ctx, 'feed-balance')).toMatchObject({ priority: 1, amount: 10_000, actions: [{ id: 'bank' }, { id: 'negeren' }] });

    ctx.db.prepare('UPDATE bank_feed_accounts SET transactions_synchronized_at = ? WHERE id = ?').run('2026-10-03T09:00:00.000Z', id);
    expect(feedTasks(ctx).some((task) => task.kind === 'feed-balance')).toBe(false);
    ctx.db.prepare('UPDATE bank_feed_accounts SET transactions_synchronized_at = NULL WHERE id = ?').run(id);
    expect(feedTasks(ctx).some((task) => task.kind === 'feed-balance')).toBe(false);
  });

  it('verandert de sleutel bij een nieuwe toestand en maakt uitstel/negeren dan ongeldig', () => {
    const expiring = context();
    const id = addFeed(expiring, { expires_at: '2026-10-10' });
    const old = kind(expiring, 'feed-expiring');
    expiring.s.inbox.skipTask(old.key, 'later');
    expect(feedTasks(expiring)).toEqual([]);
    expiring.db.prepare('UPDATE bank_feed_accounts SET expires_at = ? WHERE id = ?').run('2026-10-11', id);
    expect(kind(expiring, 'feed-expiring').key).not.toBe(old.key);

    const balance = context();
    const accountId = balance.s.bank.listAccounts()[0]!.id;
    balance.s.bank.setOpeningBalance(accountId, 100_000, '2026-09-01');
    const balanceId = addFeed(balance, { balance: 110_000, balance_at: '2026-10-03T08:00:00Z', transactions_synchronized_at: '2026-10-03T08:00:00Z', balance_diff: 10_000, balance_diff_rounds: 2 });
    const oldBalance = kind(balance, 'feed-balance');
    balance.s.inbox.skipTask(oldBalance.key, 'negeren');
    balance.db.prepare('UPDATE bank_feed_accounts SET balance_diff = ? WHERE id = ?').run(20_000, balanceId);
    expect(kind(balance, 'feed-balance').key).not.toBe(oldBalance.key);
  });

  it('zet de bankchecklist rood voor storingen en saldo, zonder betalingen te vervuilen', () => {
    const ctx = context();
    addFeed(ctx, { last_error_kind: 'credentials' });
    const checklist = new Map(ctx.s.inbox.home('2026-10-03').checklist.map((item) => [item.label, item.ok]));
    expect(checklist.get('Bankgegevens bijgewerkt')).toBe(false);
    expect(checklist.get('Alle betalingen verwerkt')).toBe(true);
  });

  it('toont geen feedtaken in demo of kantoorkopie', () => {
    const demo = context();
    addFeed(demo, { last_error_kind: 'credentials' });
    demo.s.settings.update({ demoMode: true });
    expect(feedTasks(demo)).toEqual([]);

    const office = context();
    addFeed(office, { last_error_kind: 'credentials' });
    office.s.settings.markOfficeCopy({ office: 'Kantoor', exchange: 1, endDate: '2026-09-30' });
    expect(office.s.inbox.tasks('2026-10-03')).toEqual([]);
  });
});

describe('veilige acties voor feedtaken', () => {
  function api(ctx: Context, opened: string[]) {
    return createApi(ctx.s, {
      appVersion: () => 'test',
      hasSmtpPassword: () => false,
      openExternal: async (url: string) => { opened.push(url); },
    } as unknown as HostContext);
  }

  it('weigert een verzonnen of verouderde taak en gebruikt nooit vervalste refs', async () => {
    const ctx = context();
    addFeed(ctx, { expires_at: '2026-10-10' });
    const actual = kind(ctx, 'feed-expiring', today());
    const opened: string[] = [];
    const home = api(ctx, opened).home;
    await expect(home.act({ ...actual, key: 'feed-expiring-verzonnen' }, 'ponto')).rejects.toThrow(/intussen veranderd/);
    await expect(home.act({ ...actual, actions: [{ id: 'kwaad', label: 'Kwaad' }] }, 'kwaad')).rejects.toThrow(/intussen veranderd/);
    await home.act({ ...actual, ref: { feedAccountId: 999_999, bankAccountId: 999_999 } }, 'ponto');
    expect(opened).toEqual(['https://dashboard.myponto.com']);
  });

  it('gebruikt skipsemantiek voor later en negeren, en niet-gebruiken herleest de actuele status', async () => {
    const expiring = context();
    addFeed(expiring, { expires_at: '2026-10-10' });
    await api(expiring, []).home.act(kind(expiring, 'feed-expiring', today()), 'later');
    expect(feedTasks(expiring, today())).toEqual([]);

    const gone = context();
    const id = addFeed(gone, { status: 'weg', last_error_kind: 'account-gone' });
    const task = kind(gone, 'feed-account-gone', today());
    gone.db.prepare(`UPDATE bank_feed_accounts SET status = 'actief', last_error_kind = NULL WHERE id = ?`).run(id);
    await expect(api(gone, []).home.act(task, 'niet-gebruiken')).rejects.toThrow(/intussen veranderd/);
    expect(gone.db.prepare('SELECT status, bank_account_id FROM bank_feed_accounts WHERE id = ?').get(id)).toMatchObject({ status: 'actief', bank_account_id: 1 });
  });

  it('stuurt herstel- en afschriftacties naar Bank en handelt niet-gebruiken en saldo-negeren af', async () => {
    const credentials = context();
    addFeed(credentials, { last_error_kind: 'credentials' });
    expect(await api(credentials, []).home.act(kind(credentials, 'feed-credentials', today()), 'opnieuw')).toEqual({
      navigate: { screen: 'bank', extra: { bankFeed: 'credentials', feedAccountId: 1 } },
    });

    const silent = context();
    addFeed(silent, { last_ok_at: '2026-09-29 08:00:00' });
    expect(await api(silent, []).home.act(kind(silent, 'feed-silent', today()), 'afschrift')).toEqual({
      navigate: { screen: 'bank', extra: { importStatement: true, bankAccountId: 1 } },
    });

    const gone = context();
    const goneId = addFeed(gone, { status: 'weg', last_error_kind: 'account-gone' });
    await api(gone, []).home.act(kind(gone, 'feed-account-gone', today()), 'niet-gebruiken');
    expect(gone.db.prepare('SELECT status, bank_account_id FROM bank_feed_accounts WHERE id = ?').get(goneId)).toEqual({ status: 'niet-gebruiken', bank_account_id: null });

    const balance = context();
    balance.s.bank.setOpeningBalance(1, 100_000, '2026-09-01');
    addFeed(balance, { balance: 110_000, balance_at: '2026-10-03T08:00:00Z', transactions_synchronized_at: '2026-10-03T08:00:00Z', balance_diff: 10_000, balance_diff_rounds: 2 });
    await api(balance, []).home.act(kind(balance, 'feed-balance', today()), 'negeren');
    expect(feedTasks(balance, today()).some((task) => task.kind === 'feed-balance')).toBe(false);
  });
});
