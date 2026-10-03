import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../src/db/database';
import { createServices, MemorySecretStore, type Services } from '../src/services';
import { BANK_FEED } from '../src/shared/bank-feed';
import { PontoError, type PontoAccount, type PontoCredentials, type PontoRead } from '../src/integrations/ponto';
import { BankFeedService, type BankFeedClient, type RoundSummary } from '../src/bankfeed/bankfeed';
import type { FetchLike } from '../src/integrations/types';
import type { NormalizedTransaction } from '../src/import/types';

/**
 * Ponto WP5 (#247): het handmatige "Nu bijwerken". Uitsluitend fictieve gegevens, een
 * nepclient, een nep-FetchLike voor de Cloudflare-trace en geïnjecteerde klok en wachttijd:
 * er wordt nooit echt geslapen en nooit echt netwerk gedaan. Wat #246/#253 bewaakten
 * (credentials in de veilige opslag, de ene service-lock, bewezen dekking) blijft hier
 * onaangetast en wordt rond het handmatig bijwerken opnieuw bewezen.
 */

const CREDS: PontoCredentials = { clientId: 'client-id-1234', clientSecret: 'geheim-wachtwoord' };
/** Vast moment van de klik: alle tijdstippen in de tests vertrekken hier. */
const NOW_MS = Date.parse('2026-10-12T16:00:00Z');
const IP_V4 = '203.0.113.7';
const IP_V6 = '2001:db8::1';
const TRACE_URL = 'https://www.cloudflare.com/cdn-cgi/trace';

const account = (over: Partial<PontoAccount> = {}): PontoAccount => ({
  id: 'acc-1',
  iban: 'NL91ABNA0417164300',
  referenceType: 'IBAN',
  name: 'Zakelijke rekening',
  holder: 'Voorbeeld Holding B.V.',
  currency: 'EUR',
  subtype: null,
  deprecated: false,
  availability: 'available',
  balance: 123456,
  balanceAt: '2026-10-12T12:00:00.000Z',
  detailsSynchronizedAt: '2026-10-12T12:00:00.000Z',
  expiresAt: '2026-11-17',
  ...over,
});

/** Een geslaagde, volledige transactielijst zoals de echte client die geeft. */
const pontoRead = (over: Partial<PontoRead> = {}): PontoRead => ({
  transactions: [],
  skippedForeign: 0,
  complete: true,
  pages: 1,
  synchronizedAt: '2026-10-12T12:00:00.000Z',
  latestSynchronization: { id: 'sync-1', status: 'success', subtype: 'accountTransactions', errors: [] },
  ...over,
});

const tx = (date: string, amount: number, bankId: string, over: Partial<NormalizedTransaction> = {}): NormalizedTransaction => ({
  date,
  amount,
  counterIban: 'NL44RABO0123456789',
  counterName: 'Koffiehoek',
  description: `Betaling ${bankId}`,
  reference: null,
  ownIban: 'NL91ABNA0417164300',
  bankId,
  ...over,
});

/** Een trace-antwoord zoals Cloudflare het geeft, met het gevraagde adres. */
const traceBody = (ip: string): string => `fl=7f4a2\nh=www.cloudflare.com\nip=${ip}\nts=2026-10-12T16:00:00Z\nvisit_scheme=https\nhttp=http/2`;

type SyncStatus = 'pending' | 'running' | 'success' | 'error';
type Subtype = 'accountTransactions' | 'accountDetails';
type RefreshResult = Awaited<ReturnType<BankFeedService['refreshNow']>>;

/** Wijst het `allowed: false`-geval af zodat een toevallig gegunde test niet stilletjes slaagt. */
function alsToegestaan(result: RefreshResult): RoundSummary {
  if (!result.allowed) throw new Error(`onverwacht geweigerd tot ${result.allowedAt}`);
  return result.summary;
}

interface Harness {
  s: Services;
  feed: BankFeedService;
  secrets: MemorySecretStore;
  /** de geïnjecteerde klok: de wait schuift haar per wachtronde verder */
  nowMs: number;
  fake: PontoAccount[];
  reads: Map<string, PontoRead>;
  /** status per synchronisatie-id, zoals Ponto die tijdens het poll rapporteert */
  syncs: Map<string, { status: SyncStatus; errors: string[] }>;
  /** de eindstatus die dit id op elke poll rapporteert zodra het gestart is (bv. 'error') */
  endStatus: Map<string, SyncStatus>;
  /** aantal polls dat dit id pending blijft vóór het op success valt; 1 = meteen succes */
  pollsUntilSuccess: Map<string, number>;
  /** laat het starten van dit subtype deze fout gooien */
  startFailure: Partial<Record<Subtype, Error>>;
  /** laat het poll van dit id deze fout gooien */
  pollFailure: Map<string, Error>;
  trace: { calls: number; urls: string[]; body: string | null; fail: 'network' | 'status' | 'hang' | null; aborted: number };
  customerIps: string[];
  calls: string[];
  clientCalls: number;
  transactionsCalls: number;
  lastReadArgs: { accountId: string; sinceDate?: string }[];
  polls: Map<string, number>;
  onPoll: ((id: string) => void) | null;
  waitCalls: number[];
  active: number;
  maxConcurrent: number;
}

function fakeClient(h: Harness): BankFeedClient {
  const enter = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    h.clientCalls += 1;
    h.calls.push(label);
    h.active += 1;
    h.maxConcurrent = Math.max(h.maxConcurrent, h.active);
    try {
      return await fn();
    } finally {
      h.active -= 1;
    }
  };
  return {
    accounts: () => enter('accounts', async () => {
      return { accounts: h.fake, scope: 'ai' };
    }),
    transactions: (accountId, opts = {}) => enter(`transactions:${accountId}`, async () => {
      h.transactionsCalls += 1;
      h.lastReadArgs.push({ accountId, sinceDate: opts.sinceDate });
      const read = h.reads.get(accountId);
      if (!read) throw new Error(`nepclient: geen transacties voor ${accountId}`);
      return read;
    }),
    startSynchronization: (accountId, subtype, customerIp) => enter(`start:${subtype}`, async () => {
      h.customerIps.push(customerIp);
      const failure = h.startFailure[subtype];
      if (failure) throw failure;
      const id = `${subtype}-id`;
      h.syncs.set(id, { status: 'pending', errors: [] });
      return { id };
    }),
    synchronization: (id) => enter(`poll:${id}`, async () => {
      h.polls.set(id, (h.polls.get(id) ?? 0) + 1);
      h.onPoll?.(id);
      const failure = h.pollFailure.get(id);
      if (failure) throw failure;
      const sync = h.syncs.get(id);
      if (!sync) throw new PontoError('Ponto: onbekende synchronisatie in de nepclient', 'bad-response');
      if (sync.status === 'pending' || sync.status === 'running') {
        const end = h.endStatus.get(id);
        if (end !== undefined) {
          sync.status = end;
        } else {
          const remaining = h.pollsUntilSuccess.get(id);
          if (remaining !== undefined) {
            if (remaining <= 1) {
              h.pollsUntilSuccess.delete(id);
              sync.status = 'success';
            } else {
              h.pollsUntilSuccess.set(id, remaining - 1);
            }
          }
        }
      }
      return { status: sync.status, errors: sync.errors };
    }),
  };
}

function fakeTraceFetch(h: Harness): FetchLike {
  return async (url, init) => {
    h.trace.calls += 1;
    h.trace.urls.push(url);
    h.calls.push('trace');
    if (h.trace.fail === 'network') throw new Error('netwerk weg');
    if (h.trace.fail === 'status') {
      return { ok: false, status: 503, json: async () => { throw new Error('geen json'); }, text: async () => '' };
    }
    if (h.trace.fail === 'hang') {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          h.trace.aborted += 1;
          reject(new Error('trace afgebroken'));
        }, { once: true });
      });
    }
    if (h.trace.body === null) throw new Error('geen trace-body geconfigureerd');
    const body = h.trace.body;
    return { ok: true, status: 200, json: async () => { throw new Error('geen json'); }, text: async () => body };
  };
}

function feedRow(db: Services['db'], pontoId = 'acc-1'): Record<string, unknown> {
  return db.prepare('SELECT * FROM bank_feed_accounts WHERE external_id = ?').get(pontoId) as Record<string, unknown>;
}

function bankTransactions(s: Services): { date: string; amount: number; bank_id: string | null }[] {
  return s.db.prepare('SELECT transaction_date AS date, amount, bank_id FROM bank_transactions ORDER BY transaction_date, id').all() as { date: string; amount: number; bank_id: string | null }[];
}

function dumpDatabase(db: Services['db']): string {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((t) => t.name);
  return tables.map((table) => JSON.stringify(db.prepare(`SELECT * FROM "${table}"`).all())).join('\n');
}

function setup(): Harness {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  const secrets = new MemorySecretStore();
  const s = createServices(db, {
    pdf: async () => Buffer.from('PDF'),
    mailerFactory: async () => { throw new Error('geen mail in tests'); },
    secrets,
    fetch: async () => { throw new Error('geen netwerk in tests'); },
    storeFile: async (name) => `/tmp/${name}`,
    licensePublicKey: '',
  });
  const h: Harness = {
    s,
    feed: undefined!,
    secrets,
    nowMs: NOW_MS,
    fake: [account()],
    reads: new Map([['acc-1', pontoRead()]]),
    syncs: new Map(),
    endStatus: new Map(),
    pollsUntilSuccess: new Map(),
    startFailure: {},
    pollFailure: new Map(),
    trace: { calls: 0, urls: [], body: traceBody(IP_V4), fail: null, aborted: 0 },
    customerIps: [],
    calls: [],
    clientCalls: 0,
    transactionsCalls: 0,
    lastReadArgs: [],
    polls: new Map(),
    onPoll: null,
    waitCalls: [],
    active: 0,
    maxConcurrent: 0,
  };
  h.feed = new BankFeedService({
    db,
    secrets,
    bank: s.bank,
    settings: s.settings,
    now: () => new Date(h.nowMs),
    client: () => fakeClient(h),
    fetch: fakeTraceFetch(h),
    // geïnjecteerde wachttijd: nooit echt slapen; de klok schuift met de wachtronde mee
    wait: async (ms: number) => {
      h.waitCalls.push(ms);
      h.nowMs += ms;
    },
  });
  return h;
}

/** Beide subtypes slagen op de eerste poll: de happy path. */
function happySyncs(h: Harness): void {
  h.pollsUntilSuccess.set('accountTransactions-id', 1);
  h.pollsUntilSuccess.set('accountDetails-id', 1);
}

/** Koppelt de standaardrekening actief aan een nieuwe bankrekening en wist de tellers. */
async function linkAccount(h: Harness): Promise<{ feedId: number; bankAccountId: number }> {
  await h.feed.test(CREDS);
  h.feed.saveLinks(CREDS, [{ pontoId: 'acc-1', bankAccountId: 'nieuw' }]);
  h.calls.length = 0;
  h.clientCalls = 0;
  h.transactionsCalls = 0;
  h.customerIps.length = 0;
  h.waitCalls.length = 0;
  h.polls.clear();
  const row = feedRow(h.s.db);
  return { feedId: row.id as number, bankAccountId: row.bank_account_id as number };
}

/** Een bestaand afschrift van de gebruiker zelf: bewijst de dekking t/m `to`. */
function bestaandAfschrift(h: Harness, bankAccountId: number, to: string, importedAt: string): void {
  h.s.bank.import({
    source: 'csv',
    warnings: [],
    transactions: [{ date: to, amount: -5000, description: 'Huurbetaling', counterIban: 'NL44RABO0123456789' }],
  }, { bankAccountId, importedAt });
}

/** Koppeling mét geboekt beginsaldo en bewezen dekking t/m 5 oktober: de basis voor saldocontrole. */
async function linkMetBewezenBasis(h: Harness): Promise<number> {
  const { bankAccountId } = await linkAccount(h);
  h.s.bank.setOpeningBalance(bankAccountId, 100000, '2026-09-30');
  bestaandAfschrift(h, bankAccountId, '2026-10-05', '2026-10-06 08:00:00');
  return bankAccountId;
}

let h: Harness;

beforeEach(() => {
  BANK_FEED.available = true;
  // vaste klok voor de bestaande diensten (bv. de importcontrole van vijf minuten); de
  // service zelf krijgt zijn eigen geïnjecteerde klok en wait, dus er wordt nooit echt
  // geslapen en geen valse timer hoeft te lopen
  vi.useFakeTimers({ now: new Date(NOW_MS) });
  h = setup();
});

afterEach(() => {
  BANK_FEED.available = false; // de vlag is een gedeeld object; netjes terugzetten
  vi.useRealTimers();
  vi.restoreAllMocks();
  h.s.db.close();
});

describe('het publieke IP via precies één Cloudflare-trace (#247)', () => {
  it('vraagt het IP precies één keer op en start beide synchronisaties met dat ene adres', async () => {
    const { feedId } = await linkAccount(h);
    happySyncs(h);
    const summary = alsToegestaan(await h.feed.refreshNow(feedId));
    expect(summary.failed).toEqual([]);
    expect(h.trace.calls).toBe(1);
    expect(h.trace.urls).toEqual([TRACE_URL]);
    // beide starts kregen hetzelfde, enige opgevraagde adres
    expect(h.customerIps).toEqual([IP_V4, IP_V4]);
  });

  it('accepteert een geldig IPv6-adres uit de trace', async () => {
    const { feedId } = await linkAccount(h);
    happySyncs(h);
    h.trace.body = traceBody(IP_V6);
    alsToegestaan(await h.feed.refreshNow(feedId));
    expect(h.customerIps).toEqual([IP_V6, IP_V6]);
    // ook dit adres staat nergens op schijf
    expect(dumpDatabase(h.s.db)).not.toContain(IP_V6);
  });

  it('geen synchronisatie, geen ronde en geen manual_sync_at bij een trace zonder ip=', async () => {
    const { feedId } = await linkAccount(h);
    h.trace.body = 'fl=7f4a2\nh=www.cloudflare.com\nts=2026-10-12T16:00:00Z\n';
    await expect(h.feed.refreshNow(feedId)).rejects.toThrow(/publieke IP/);
    expect(h.trace.calls).toBe(1); // de trace zelf is wel gedaan, precies één keer
    expect(h.clientCalls).toBe(0); // er is helemaal niets naar Ponto gegaan
    expect(h.transactionsCalls).toBe(0); // ook de afrondende ronde draaide niet
    expect(feedRow(h.s.db).manual_sync_at).toBeNull();
  });

  it('een ongeldig trace-IP wordt geweigerd alsof het ontbreekt', async () => {
    const { feedId } = await linkAccount(h);
    h.trace.body = traceBody('niet-een-ip-adres');
    await expect(h.feed.refreshNow(feedId)).rejects.toThrow(/publieke IP/);
    expect(h.clientCalls).toBe(0);
    expect(feedRow(h.s.db).manual_sync_at).toBeNull();
  });

  it('een mislukte trace (netwerk of foutstatus) start niets en lekt niets', async () => {
    const { feedId } = await linkAccount(h);
    h.trace.fail = 'network';
    await expect(h.feed.refreshNow(feedId)).rejects.toThrow(/publieke IP/);
    expect(h.clientCalls).toBe(0);
    expect(feedRow(h.s.db).manual_sync_at).toBeNull();
    h.trace.fail = 'status';
    await expect(h.feed.refreshNow(feedId)).rejects.toThrow(/publieke IP/);
    expect(h.trace.calls).toBe(2); // beide pogingen vragen het IP op, geen enkele Ponto-aanroep
    expect(h.clientCalls).toBe(0);
  });

  it('breekt een vastgelopen trace na dertig seconden af en geeft de service-lock vrij', async () => {
    const { feedId } = await linkAccount(h);
    h.trace.fail = 'hang';
    const refresh = h.feed.refreshNow(feedId);
    const rejected = expect(refresh).rejects.toThrow(/publieke IP/);
    const queued = h.feed.exclusive(async () => 'lock vrij');
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    await expect(queued).resolves.toBe('lock vrij');
    expect(h.trace.aborted).toBe(1);
    expect(h.clientCalls).toBe(0);
    expect(feedRow(h.s.db).manual_sync_at).toBeNull();
  });
});

describe('het venster van dertig minuten (#247)', () => {
  it('binnen 30 minuten sinds een gestarte synchronisatie: werkelijk nul netwerkcalls en allowed: false', async () => {
    const { feedId } = await linkAccount(h);
    happySyncs(h);
    const first = await h.feed.refreshNow(feedId);
    expect(first.allowed).toBe(true);
    const traceAfterFirst = h.trace.calls;
    const clientAfterFirst = h.clientCalls;
    const callsAfterFirst = [...h.calls];

    h.nowMs += 10 * 60_000; // tien minuten na de klik
    const second = await h.feed.refreshNow(feedId);
    expect(second).toEqual({ allowed: false, allowedAt: '2026-10-12T16:30:00.000Z' });
    // werkelijk nul netwerk: geen trace, geen Ponto, geen enkele aanroep
    expect(h.trace.calls).toBe(traceAfterFirst);
    expect(h.clientCalls).toBe(clientAfterFirst);
    expect(h.calls).toEqual(callsAfterFirst);
  });

  it('op exact de grens van 30 minuten mag het weer', async () => {
    const { feedId } = await linkAccount(h);
    happySyncs(h);
    await h.feed.refreshNow(feedId);
    h.nowMs = NOW_MS + 30 * 60_000;
    const result = await h.feed.refreshNow(feedId);
    expect(result.allowed).toBe(true);
    expect(h.trace.calls).toBe(2); // een nieuwe toegestane klik vraagt het IP opnieuw op
  });

  it('ver na het venster is het gewoon weer toegestaan', async () => {
    const { feedId } = await linkAccount(h);
    happySyncs(h);
    await h.feed.refreshNow(feedId);
    h.nowMs = NOW_MS + 31 * 60_000;
    const result = await h.feed.refreshNow(feedId);
    expect(result.allowed).toBe(true);
  });
});

describe('twee onafhankelijke synchronisaties (#247)', () => {
  it('start en polld twee afzonderlijke synchronisaties, elk om de drie seconden', async () => {
    const { feedId } = await linkAccount(h);
    happySyncs(h);
    // manual_sync_at moet al gezet zijn vóór de eerste poll: pas na een werkelijke start
    const manualAtDuringPolls: (string | null)[] = [];
    h.onPoll = () => manualAtDuringPolls.push(feedRow(h.s.db).manual_sync_at as string | null);
    // transacties blijft twee polls pending, details is meteen klaar: twee wachtrondes
    h.pollsUntilSuccess.set('accountTransactions-id', 3);
    alsToegestaan(await h.feed.refreshNow(feedId));
    expect(h.syncs.size).toBe(2); // twee afzonderlijke id's
    expect(h.polls.get('accountTransactions-id')).toBeGreaterThan(0);
    expect(h.polls.get('accountDetails-id')).toBeGreaterThan(0);
    // gezet direct na de starts, dus vóór én tijdens elke poll
    expect(manualAtDuringPolls.length).toBeGreaterThan(0);
    expect(manualAtDuringPolls.every((v) => v === '2026-10-12 16:00:00')).toBe(true);
    // pollinterval: precies drie seconden per wachtronde, nooit echt geslapen
    expect(h.waitCalls).toEqual([3000, 3000]);
    // de twee starts liepen daadwerkelijk naast elkaar
    expect(h.maxConcurrent).toBeGreaterThanOrEqual(2);
  });

  it('transacties slagen en accountDetails faalt: transacties worden wél geïmporteerd', async () => {
    const { feedId } = await linkAccount(h);
    happySyncs(h);
    h.endStatus.set('accountDetails-id', 'error');
    h.reads.set('acc-1', pontoRead({ transactions: [tx('2026-10-10', -3500, 'p1')] }));
    const summary = alsToegestaan(await h.feed.refreshNow(feedId));
    // de transacties staan erin
    expect(bankTransactions(h.s)).toEqual([{ date: '2026-10-10', amount: -3500, bank_id: 'p1' }]);
    // de mislukte detailsync is een afzonderlijk, veilig resultaat naast de geslaagde ronde
    expect(summary.failed).toEqual([{ pontoId: 'acc-1', errorKind: 'synchronization-error' }]);
    expect(summary.accounts).toEqual([{ pontoId: 'acc-1', bankAccountId: expect.any(Number), imported: 1 }]);
    expect(feedRow(h.s.db).manual_sync_at).toBe('2026-10-12 16:00:00');
  });

  it('een startfout bij accountTransactions laat accountDetails gewoon doorgaan', async () => {
    const { feedId } = await linkAccount(h);
    happySyncs(h);
    h.startFailure.accountTransactions = new PontoError('Ponto: te veel aanvragen (fout 429)', 'rate-limit', 429);
    const summary = alsToegestaan(await h.feed.refreshNow(feedId));
    expect(summary.failed).toEqual([{ pontoId: 'acc-1', errorKind: 'rate-limit' }]);
    // details is wél gestart en gepolld; transacties nooit
    expect(h.polls.has('accountDetails-id')).toBe(true);
    expect(h.polls.has('accountTransactions-id')).toBe(false);
    // minstens één echte start: manual_sync_at is gezet
    expect(feedRow(h.s.db).manual_sync_at).toBe('2026-10-12 16:00:00');
  });

  it('een 429 bij het starten geldt alleen voor dat subtype', async () => {
    const { feedId } = await linkAccount(h);
    happySyncs(h);
    h.startFailure.accountDetails = new PontoError('Ponto: te veel aanvragen (fout 429)', 'rate-limit', 429);
    h.reads.set('acc-1', pontoRead({ transactions: [tx('2026-10-10', -3500, 'p1')] }));
    const summary = alsToegestaan(await h.feed.refreshNow(feedId));
    expect(summary.failed).toEqual([{ pontoId: 'acc-1', errorKind: 'rate-limit' }]);
    expect(summary.accounts).toEqual([{ pontoId: 'acc-1', bankAccountId: expect.any(Number), imported: 1 }]);
    expect(h.polls.has('accountTransactions-id')).toBe(true);
    expect(h.polls.has('accountDetails-id')).toBe(false);
    expect(feedRow(h.s.db).manual_sync_at).toBe('2026-10-12 16:00:00');
  });

  it('een poll-error geldt alleen voor het betreffende subtype', async () => {
    const { feedId } = await linkAccount(h);
    happySyncs(h);
    h.pollFailure.set('accountDetails-id', new PontoError('Ponto: netwerkfout bij synchronisatie', 'network'));
    h.reads.set('acc-1', pontoRead({ transactions: [tx('2026-10-10', -3500, 'p1')] }));
    const summary = alsToegestaan(await h.feed.refreshNow(feedId));
    expect(summary.failed).toEqual([{ pontoId: 'acc-1', errorKind: 'network' }]);
    expect(summary.accounts).toEqual([{ pontoId: 'acc-1', bankAccountId: expect.any(Number), imported: 1 }]);
    expect(bankTransactions(h.s)).toEqual([{ date: '2026-10-10', amount: -3500, bank_id: 'p1' }]);
  });

  it('een time-out bij accountTransactions: poll om de drie seconden, maximaal twee minuten, geen retry', async () => {
    const { feedId } = await linkAccount(h);
    h.pollsUntilSuccess.set('accountDetails-id', 1); // details slagen; transacties blijven pending
    const start = h.nowMs;
    const summary = alsToegestaan(await h.feed.refreshNow(feedId));
    expect(summary.failed).toEqual([{ pontoId: 'acc-1', errorKind: 'timeout' }]);
    // elke wachtronde is exact drie seconden en het poll bleef binnen de twee minuten
    expect(h.waitCalls.every((ms) => ms === 3000)).toBe(true);
    expect(h.waitCalls).toHaveLength(40);
    expect(h.nowMs - start).toBe(120_000);
  });

  it('een time-out bij accountDetails laat de transacties gewoon doorgaan', async () => {
    const { feedId } = await linkAccount(h);
    h.pollsUntilSuccess.set('accountTransactions-id', 1); // transacties slagen; details blijven pending
    h.reads.set('acc-1', pontoRead({ transactions: [tx('2026-10-10', -3500, 'p1')] }));
    const summary = alsToegestaan(await h.feed.refreshNow(feedId));
    expect(summary.failed).toEqual([{ pontoId: 'acc-1', errorKind: 'timeout' }]);
    expect(summary.accounts).toEqual([{ pontoId: 'acc-1', bankAccountId: expect.any(Number), imported: 1 }]);
    expect(bankTransactions(h.s)).toEqual([{ date: '2026-10-10', amount: -3500, bank_id: 'p1' }]);
  });
});

describe('manual_sync_at pas na een werkelijke start (#247)', () => {
  it('allebei de starts falen: geen manual_sync_at, wel de veilige foutsoorten', async () => {
    const { feedId } = await linkAccount(h);
    happySyncs(h);
    h.startFailure.accountTransactions = new PontoError('Ponto: te veel aanvragen (fout 429)', 'rate-limit', 429);
    h.startFailure.accountDetails = new PontoError('Ponto: netwerkfout bij synchronisatie', 'network');
    const summary = alsToegestaan(await h.feed.refreshNow(feedId));
    expect(feedRow(h.s.db).manual_sync_at).toBeNull();
    expect(summary.failed).toEqual([
      { pontoId: 'acc-1', errorKind: 'rate-limit', subtype: 'accountTransactions' },
      { pontoId: 'acc-1', errorKind: 'network', subtype: 'accountDetails' },
    ]);
    // de ronde na afloop draaide wel (altijd opnieuw lezen), maar er is niets gestart
    expect(h.transactionsCalls).toBe(1);
  });

  it('zonder geldig IP is er geen start en dus geen manual_sync_at', async () => {
    const { feedId } = await linkAccount(h);
    h.trace.body = traceBody('niet-een-ip-adres');
    await expect(h.feed.refreshNow(feedId)).rejects.toThrow(/publieke IP/);
    expect(feedRow(h.s.db).manual_sync_at).toBeNull();
  });
});

describe('precies één gerichte ronde na afloop (#247/#253)', () => {
  it('leest de transacties daarna exact één keer opnieuw, alleen voor deze koppeling', async () => {
    const { feedId, bankAccountId } = await linkAccount(h);
    bestaandAfschrift(h, bankAccountId, '2026-10-05', '2026-10-06 08:00:00');
    happySyncs(h);
    h.reads.set('acc-1', pontoRead({ transactions: [tx('2026-10-08', -3500, 'p1')] }));
    const summary = alsToegestaan(await h.feed.refreshNow(feedId));
    // precies één gerichte ronde: één accountlijst, één transactieleesronde voor deze rekening
    expect(h.calls.filter((c) => c === 'accounts')).toHaveLength(1);
    expect(h.transactionsCalls).toBe(1);
    expect(h.lastReadArgs[0]).toEqual({ accountId: 'acc-1', sinceDate: '2026-09-28' });
    expect(bankTransactions(h.s)).toEqual([
      { date: '2026-10-05', amount: -5000, bank_id: null },
      { date: '2026-10-08', amount: -3500, bank_id: 'p1' },
    ]);
    expect(summary.accounts).toEqual([{ pontoId: 'acc-1', bankAccountId, imported: 1 }]);
  });

  it('bestaande #253-dekking blijft uitsluitend van transactiemetadata afhangen', async () => {
    const { feedId, bankAccountId } = await linkAccount(h);
    bestaandAfschrift(h, bankAccountId, '2026-10-05', '2026-10-06 08:00:00');
    happySyncs(h);
    // nieuwere details bij Ponto, mét saldo; de transactierespons geeft haar eigen nieuwere metadata
    h.fake = [account({ balance: 110000, balanceAt: '2026-10-12T18:00:00.000Z', detailsSynchronizedAt: '2026-10-12T18:00:00.000Z' })];
    h.reads.set('acc-1', pontoRead({ transactions: [tx('2026-10-08', -3500, 'p1')], synchronizedAt: '2026-10-12T14:00:00.000Z' }));
    alsToegestaan(await h.feed.refreshNow(feedId));
    // de dekking volgt uitsluitend het transactiesynchronisatijdstip (14:00), nooit de details (18:00)
    expect(feedRow(h.s.db).transactions_synchronized_at).toBe('2026-10-12T14:00:00.000Z');
    expect(feedRow(h.s.db).covered_to).toBe('2026-10-11');
    // de details zelf zijn wél apart bijgewerkt (bestaand #253-gedrag)
    expect(feedRow(h.s.db).details_synchronized_at).toBe('2026-10-12T18:00:00.000Z');
  });
});

describe('mislukte accountDetails voorkomt een nieuwe saldovergelijking (#247/#253)', () => {
  /** Maakt saldo- en transactiemetadata vergelijkbaar op één en hetzelfde moment. */
  const vergelijkbaar = (balance: number) => {
    const moment = '2026-10-12T12:00:00.000Z';
    h.fake = [account({ balance, balanceAt: moment, detailsSynchronizedAt: moment })];
    h.reads.set('acc-1', pontoRead({ transactions: [], synchronizedAt: moment }));
  };

  it('bij geslaagde details telt de ronde wél mee voor de saldocontrole', async () => {
    await linkMetBewezenBasis(h);
    happySyncs(h);
    // de app verwacht 100000 beginsaldo - 5000 afschrift = 95000; Ponto zegt 95000 + 10000
    vergelijkbaar(105000);
    const feedId = feedRow(h.s.db).id as number;
    const summary = alsToegestaan(await h.feed.refreshNow(feedId));
    expect(summary.failed).toEqual([]);
    expect(h.feed.balanceDifference(feedId)).toEqual({ difference: 10000, rounds: 1 });
  });

  it('bij een mislukte detailsync worden transacties geïmporteerd maar niet opnieuw vergeleken', async () => {
    await linkMetBewezenBasis(h);
    happySyncs(h);
    vergelijkbaar(105000);
    h.endStatus.set('accountDetails-id', 'error');
    const feedId = feedRow(h.s.db).id as number;
    const summary = alsToegestaan(await h.feed.refreshNow(feedId));
    // de ronde zelf is geslaagd (leeg maar volledig), de detailsync niet
    expect(summary.accounts).toEqual([{ pontoId: 'acc-1', bankAccountId: expect.any(Number), imported: 0 }]);
    expect(summary.failed).toEqual([{ pontoId: 'acc-1', errorKind: 'synchronization-error' }]);
    // géén nieuwe saldovergelijking: de afwijking is nooit vastgelegd
    expect(h.feed.balanceDifference(feedId)).toBeNull();
    expect(feedRow(h.s.db).balance_diff).toBeNull();
    expect(feedRow(h.s.db).balance_diff_rounds).toBe(0);
    // De succesvolle transactieronde mag de mislukte handmatige detailsync niet maskeren.
    expect(feedRow(h.s.db).last_error_kind).toBe('synchronization-error');
    // en een eerdere, al vastgelegde afwijking blijft onaangetast door zo'n ronde
    h.s.db.prepare('UPDATE bank_feed_accounts SET balance_diff = ?, balance_diff_rounds = 1 WHERE id = ?').run(7000, feedId);
    h.nowMs += 30 * 60_000; // voorbij het venster: de volgende klik is weer toegestaan
    vergelijkbaar(105000);
    const again = await h.feed.refreshNow(feedId);
    expect(again.allowed).toBe(true);
    expect(h.feed.balanceDifference(feedId)).toEqual({ difference: 7000, rounds: 1 });
  });
});

describe('privacy: het IP staat nergens (#247)', () => {
  it('geen IP, credential of ruwe response in database, resultaat, fout of log', async () => {
    const { feedId } = await linkAccount(h);
    happySyncs(h);
    h.reads.set('acc-1', pontoRead({ transactions: [tx('2026-10-10', -3500, 'p1')] }));
    const logged: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    }
    const summary = alsToegestaan(await h.feed.refreshNow(feedId));
    expect(summary.accounts).toEqual([{ pontoId: 'acc-1', bankAccountId: expect.any(Number), imported: 1 }]);
    // het resultaat
    expect(JSON.stringify(summary)).not.toContain(IP_V4);
    expect(JSON.stringify(summary)).not.toContain('geheim-wachtwoord');
    // de hele database
    const dump = dumpDatabase(h.s.db);
    expect(dump).not.toContain(IP_V4);
    expect(dump).not.toContain('2001:db8');
    expect(dump).not.toContain('geheim-wachtwoord');
    // het log
    expect(logged.join('\n')).not.toContain(IP_V4);
    // een geweigerde klik geeft alléén het toegestane moment terug
    h.nowMs += 10 * 60_000;
    h.trace.body = traceBody('198.51.100.23');
    const blocked = await h.feed.refreshNow(feedId);
    expect(blocked.allowed).toBe(false);
    expect(JSON.stringify(blocked)).not.toContain('198.51.100.23');
    // en een foutpad lekt evenmin: uitsluitend de vaste foutsoort
    h.nowMs += 21 * 60_000; // voorbij het venster
    h.pollsUntilSuccess.set('accountTransactions-id', 1); // de transactiesync lukt weer gewoon
    h.pollFailure.set('accountDetails-id', new PontoError('Ponto: serverstoring (fout 500)', 'server', 500));
    const withError = alsToegestaan(await h.feed.refreshNow(feedId));
    expect(withError.failed).toEqual([{ pontoId: 'acc-1', errorKind: 'server' }]);
    expect(JSON.stringify(withError)).not.toContain(IP_V4);
    expect(JSON.stringify(withError)).not.toContain('198.51.100.23');
    const dump2 = dumpDatabase(h.s.db);
    expect(dump2).not.toContain('198.51.100.23');
    expect(dump2).not.toContain(IP_V4);
    expect(logged.join('\n')).not.toContain('198.51.100.23');
  });
});

describe('gelijktijdigheid: dezelfde service-lock (#247/#253)', () => {
  it('een gewone round() tijdens refreshNow loopt door dezelfde lock: nooit door elkaar', async () => {
    const { feedId } = await linkAccount(h);
    happySyncs(h);
    h.reads.set('acc-1', pontoRead({ transactions: [tx('2026-10-10', -3500, 'p1')] }));
    const ronde = h.feed.round();
    const verversen = h.feed.refreshNow(feedId);
    const [rondeUitkomst, verversenUitkomst] = await Promise.all([ronde, verversen]);
    expect(verversenUitkomst.allowed).toBe(true);
    expect(rondeUitkomst.accounts).toHaveLength(1);
    // de gewone ronde draaide volledig vóór het handmatig verversen begon: nooit tegelijk
    expect(h.calls.slice(0, 2)).toEqual(['accounts', 'transactions:acc-1']);
    expect(h.calls.indexOf('trace')).toBeGreaterThan(h.calls.indexOf('transactions:acc-1'));
  });

  it('refreshNow deadlocks niet met een taak of een gewone ronde in dezelfde lock', async () => {
    const { feedId } = await linkAccount(h);
    happySyncs(h);
    const verversen = h.feed.refreshNow(feedId);
    const taak = h.feed.exclusive(async () => 'gewoon een taak');
    const ronde = h.feed.round();
    const [verversenUitkomst, taakUitkomst, rondeUitkomst] = await Promise.all([verversen, taak, ronde]);
    expect(verversenUitkomst.allowed).toBe(true);
    expect(taakUitkomst).toBe('gewoon een taak');
    expect(rondeUitkomst.accounts).toHaveLength(1); // alles is netjes uitgevoerd, niemand wacht eeuwig
  });
});
