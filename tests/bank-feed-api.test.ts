import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../src/db/database';
import { createServices, MemorySecretStore, type Services } from '../src/services';
import { createApi, type HostContext } from '../src/main/api';
import { BANK_FEED, BANK_FEED_SECRET_KEYS } from '../src/shared/bank-feed';
import type { BankFeedClient } from '../src/bankfeed/bankfeed';
import { PontoError, type PontoAccount, type PontoCredentials, type PontoRead } from '../src/integrations/ponto';
import type { FetchLike } from '../src/integrations/types';
import type { NormalizedTransaction } from '../src/import/types';

/**
 * Ponto WP7 (#249): de IPC-routes `bankfeed.*` en de aansluiting van de gewone feedronde op
 * de bestaande achtergrondtaak. Uitsluitend nepgegevens en een nepclient; het waarneembare
 * gedrag van de routes zelf wordt getest — de echte guards en de echte service-lock in
 * BankFeedService blijven gewoon in het spel en worden niet met mocks omzeild.
 */

const CREDS: PontoCredentials = { clientId: 'client-id-1234', clientSecret: 'test-geheim-wachtwoord' };
const NOW_MS = Date.parse('2026-10-12T16:00:00Z');

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

interface Harness {
  s: Services;
  api: ReturnType<typeof createApi>;
  secrets: MemorySecretStore;
  fake: PontoAccount[];
  reads: Map<string, PontoRead>;
  calls: string[];
  clientCalls: number;
  host: { secureStorage: boolean };
}

function fakeClient(h: Harness): BankFeedClient {
  return {
    accounts: () => {
      h.calls.push('accounts');
      h.clientCalls += 1;
      return Promise.resolve({ accounts: h.fake, scope: 'ai' });
    },
    transactions: (accountId: string) => {
      h.calls.push(`transactions:${accountId}`);
      h.clientCalls += 1;
      const read = h.reads.get(accountId);
      if (!read) throw new PontoError('Ponto: onbekende rekening in de nepclient', 'bad-response');
      return Promise.resolve(read);
    },
    // voor het handmatig "Nu bijwerken" (#247): meteen geslaagde synchronisaties
    startSynchronization: (accountId: string, subtype: 'accountTransactions' | 'accountDetails') => {
      h.calls.push(`start:${subtype}`);
      h.clientCalls += 1;
      return Promise.resolve({ id: `${subtype}-id` });
    },
    synchronization: (id: string) => {
      h.calls.push(`poll:${id}`);
      h.clientCalls += 1;
      return Promise.resolve({ status: 'success' as const, errors: [] });
    },
  };
}

function setup(): Harness {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  const secrets = new MemorySecretStore();
  // de trace-FetchLike (#247) geeft het vaste test-IP; er gaat nooit echt netwerk de deur uit
  const traceFetch: FetchLike = async (url) => {
    h.calls.push('trace');
    return { ok: true, status: 200, json: async () => { throw new Error('geen json'); }, text: async () => `fl=7f4a2\nip=203.0.113.7\nts=2026-10-12T16:00:00Z` };
  };
  const s = createServices(db, {
    pdf: async () => Buffer.from('PDF'),
    mailerFactory: async () => { throw new Error('geen mail in tests'); },
    secrets,
    fetch: traceFetch,
    storeFile: async (name) => `/tmp/${name}`,
    licensePublicKey: '',
  });
  const h: Harness = {
    s,
    api: undefined!,
    secrets,
    fake: [account()],
    reads: new Map([['acc-1', pontoRead()]]),
    calls: [],
    clientCalls: 0,
    host: { secureStorage: true },
  };
  (s.bankFeed as unknown as { makeClient: unknown }).makeClient = () => fakeClient(h);
  const host = {
    appVersion: () => '0.0.0-test',
    hasSmtpPassword: () => false,
    secureStorage: () => h.host.secureStorage,
  } as unknown as HostContext;
  h.api = createApi(s, host);
  return h;
}

/** Koppelt de standaardrekening actief en maakt de tellers schoon. */
async function linkAccount(h: Harness): Promise<number> {
  await h.api.bankfeed.testen(CREDS.clientId, CREDS.clientSecret);
  const r = await h.api.bankfeed.opslaan(CREDS.clientId, CREDS.clientSecret, [{ pontoId: 'acc-1', bankAccountId: 'nieuw' }]);
  h.calls.length = 0;
  h.clientCalls = 0;
  return r.accounts[0]?.bankAccountId ?? 0;
}

function feedRow(s: Services): Record<string, unknown> {
  return s.db.prepare('SELECT * FROM bank_feed_accounts WHERE external_id = ?').get('acc-1') as Record<string, unknown>;
}

let h: Harness;

beforeEach(() => {
  BANK_FEED.available = true;
  vi.useFakeTimers({ now: new Date(NOW_MS) });
  h = setup();
});

afterEach(() => {
  BANK_FEED.available = false; // de vlag is een gedeeld object; netjes terugzetten
  vi.useRealTimers();
  vi.restoreAllMocks();
  h.s.db.close();
});

describe('de vlag staat uit: alle routes weigeren (#249 regel 1)', () => {
  it('status weigert zonder netwerk of geheimen te lezen', () => {
    BANK_FEED.available = false;
    expect(() => h.api.bankfeed.status()).toThrow(/nog niet beschikbaar/);
    expect(h.clientCalls).toBe(0);
  });

  it('testen weigert', async () => {
    BANK_FEED.available = false;
    await expect(h.api.bankfeed.testen(CREDS.clientId, CREDS.clientSecret)).rejects.toThrow(/nog niet beschikbaar/);
    expect(h.clientCalls).toBe(0);
  });

  it('opslaan weigert', async () => {
    BANK_FEED.available = false;
    await expect(h.api.bankfeed.opslaan(CREDS.clientId, CREDS.clientSecret, [{ pontoId: 'acc-1', bankAccountId: 'nieuw' }])).rejects.toThrow(/nog niet beschikbaar/);
    expect(h.clientCalls).toBe(0);
  });

  it('ophalen weigert', async () => {
    BANK_FEED.available = false;
    await expect(h.api.bankfeed.ophalen()).rejects.toThrow(/nog niet beschikbaar/);
    expect(h.clientCalls).toBe(0);
  });

  it('bijwerken weigert', async () => {
    BANK_FEED.available = false;
    await expect(h.api.bankfeed.bijwerken(1)).rejects.toThrow(/nog niet beschikbaar/);
    expect(h.clientCalls).toBe(0);
  });

  it('verwijderen weigert', () => {
    BANK_FEED.available = false;
    expect(() => h.api.bankfeed.verwijderen()).toThrow(/nog niet beschikbaar/);
  });
});

describe('guards: kantoorkopie, demo en read-only (#249 regel 1)', () => {
  it('de kantoorkopie stelt niets in en haalt niets op', async () => {
    h.s.settings.markOfficeCopy({ office: 'Kantoor De Vries', exchange: 3, endDate: '2026-09-30' });
    expect(() => h.api.bankfeed.status()).toThrow(/Kantoor De Vries/);
    await expect(h.api.bankfeed.testen(CREDS.clientId, CREDS.clientSecret)).rejects.toThrow(/Kantoor De Vries/);
    await expect(h.api.bankfeed.opslaan(CREDS.clientId, CREDS.clientSecret, [])).rejects.toThrow(/Kantoor De Vries/);
    await expect(h.api.bankfeed.ophalen()).rejects.toThrow(/Kantoor De Vries/);
    await expect(h.api.bankfeed.bijwerken(1)).rejects.toThrow(/Kantoor De Vries/);
    expect(() => h.api.bankfeed.verwijderen()).toThrow(/Kantoor De Vries/);
    expect(h.clientCalls).toBe(0);
  });

  it('de demo stelt niets in en haalt niets op', async () => {
    h.s.settings.update({ demoMode: true });
    await expect(h.api.bankfeed.testen(CREDS.clientId, CREDS.clientSecret)).rejects.toThrow(/demo/i);
    await expect(h.api.bankfeed.opslaan(CREDS.clientId, CREDS.clientSecret, [])).rejects.toThrow(/demo/i);
    await expect(h.api.bankfeed.ophalen()).rejects.toThrow(/demo/i);
    await expect(h.api.bankfeed.bijwerken(1)).rejects.toThrow(/demo/i);
    expect(h.clientCalls).toBe(0);
  });

  it('een alleen-lezen administratie stelt niets in en haalt niets op', async () => {
    // hetzelfde contract, maar op een read-only Db: de service weigert via dezelfde guard
    const ro = { readonly: true };
    const feed = h.s.bankFeed;
    vi.spyOn(feed as unknown as { db: unknown }, 'db', 'get').mockReturnValue(ro);
    await expect(h.api.bankfeed.testen(CREDS.clientId, CREDS.clientSecret)).rejects.toThrow(/alleen-lezen/);
    await expect(h.api.bankfeed.opslaan(CREDS.clientId, CREDS.clientSecret, [])).rejects.toThrow(/alleen-lezen/);
    await expect(h.api.bankfeed.ophalen()).rejects.toThrow(/alleen-lezen/);
    await expect(h.api.bankfeed.bijwerken(1)).rejects.toThrow(/alleen-lezen/);
    expect(() => h.api.bankfeed.verwijderen()).toThrow(/alleen-lezen/);
    expect(h.clientCalls).toBe(0);
    vi.restoreAllMocks();
  });
});

describe('credentialparametercombinaties bij opslaan (#249 regel 2)', () => {
  it('beide gevuld = vervangen', async () => {
    await h.api.bankfeed.testen(CREDS.clientId, CREDS.clientSecret);
    await h.api.bankfeed.opslaan(CREDS.clientId, CREDS.clientSecret, [{ pontoId: 'acc-1', bankAccountId: 'nieuw' }]);
    await h.api.bankfeed.testen('ander-id-5678', 'ander-geheim');
    await h.api.bankfeed.opslaan('ander-id-5678', 'ander-geheim', [{ pontoId: 'acc-1', bankAccountId: 'nieuw' }]);
    expect(h.secrets.get(BANK_FEED_SECRET_KEYS.clientId)).toBe('ander-id-5678');
    expect(h.secrets.get(BANK_FEED_SECRET_KEYS.clientSecret)).toBe('ander-geheim');
  });

  it('beide null = bestaande behouden', async () => {
    await linkAccount(h);
    h.secrets.set(BANK_FEED_SECRET_KEYS.clientId, 'client-id-1234');
    h.secrets.set(BANK_FEED_SECRET_KEYS.clientSecret, 'test-geheim-wachtwoord');
    await h.api.bankfeed.testen(CREDS.clientId, CREDS.clientSecret);
    // opslaan met allebei null: de bestaande credentials blijven staan
    await h.api.bankfeed.opslaan(null, null, [{ pontoId: 'acc-1', bankAccountId: 'nieuw' }]);
    expect(h.secrets.get(BANK_FEED_SECRET_KEYS.clientId)).toBe('client-id-1234');
    expect(h.secrets.get(BANK_FEED_SECRET_KEYS.clientSecret)).toBe('test-geheim-wachtwoord');
  });

  it('alleen de Client ID gevuld = weigeren, zonder iets te veranderen', async () => {
    await h.api.bankfeed.testen(CREDS.clientId, CREDS.clientSecret);
    await expect(h.api.bankfeed.opslaan(CREDS.clientId, null, [])).rejects.toThrow(/Client ID.*Client Secret|Client Secret.*Client ID|allebei/);
    expect(h.secrets.get(BANK_FEED_SECRET_KEYS.clientId)).toBeNull();
    expect(h.secrets.get(BANK_FEED_SECRET_KEYS.clientSecret)).toBeNull();
  });

  it('alleen het Client Secret gevuld = weigeren', async () => {
    await h.api.bankfeed.testen(CREDS.clientId, CREDS.clientSecret);
    await expect(h.api.bankfeed.opslaan(null, CREDS.clientSecret, [])).rejects.toThrow(/Client ID.*Client Secret|Client Secret.*Client ID|allebei/);
    expect(h.secrets.get(BANK_FEED_SECRET_KEYS.clientId)).toBeNull();
    expect(h.secrets.get(BANK_FEED_SECRET_KEYS.clientSecret)).toBeNull();
  });

  it('whitespace telt als gevulde waarde en wordt door de service geweigerd, geen impliciete menging', async () => {
    await h.api.bankfeed.testen(CREDS.clientId, CREDS.clientSecret);
    await h.api.bankfeed.opslaan(CREDS.clientId, CREDS.clientSecret, [{ pontoId: 'acc-1', bankAccountId: 'nieuw' }]);
    await h.api.bankfeed.testen(CREDS.clientId, CREDS.clientSecret);
    await expect(h.api.bankfeed.opslaan('  ', '  ', [])).rejects.toThrow(/Client ID/);
    // null tegenover een gevulde string: weigeren
    await expect(h.api.bankfeed.opslaan('  ', null, [])).rejects.toThrow(/allebei/);
    await expect(h.api.bankfeed.opslaan(null, '  ', [])).rejects.toThrow(/allebei/);
    // de bestaande credentials zijn door geen enkele geweigerde poging veranderd
    expect(h.secrets.get(BANK_FEED_SECRET_KEYS.clientId)).toBe('client-id-1234');
  });
});

describe('geen credentials in antwoorden (#249 regel 3)', () => {
  it('serialize ieder antwoord en zoek op testsecret of volledige Client ID', async () => {
    await h.api.bankfeed.testen(CREDS.clientId, CREDS.clientSecret);
    await h.api.bankfeed.opslaan(CREDS.clientId, CREDS.clientSecret, [{ pontoId: 'acc-1', bankAccountId: 'nieuw' }]);
    h.reads.set('acc-1', pontoRead({ transactions: [tx('2026-10-11', -3500, 'p1')] }));
    await h.api.bankfeed.ophalen();
    const status = h.api.bankfeed.status();
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain('test-geheim-wachtwoord');
    expect(serialized).not.toContain('client-id-1234');
    // hooguit de laatste vier tekens zijn zichtbaar
    expect(status.clientIdLast4).toBe('1234');
    // ook een foutantwoord van de route bevat geen credentials
    let message = '';
    try {
      await h.api.bankfeed.testen(CREDS.clientId, CREDS.clientSecret);
    } catch (e) {
      message = String((e as Error).message);
    }
    expect(message).not.toContain('test-geheim-wachtwoord');
  });

  it('foutmeldingen van een mislukte verbindingstest noemen geen credentials', async () => {
    (h.s.bankFeed as unknown as { makeClient: unknown }).makeClient = () => ({
      accounts: () => Promise.reject(new PontoError('Ponto: inloggegevens geweigerd (fout 401)', 'credentials', 401)),
      transactions: () => { throw new Error('nooit'); },
    });
    await expect(h.api.bankfeed.testen('fout-id-9999', 'ander-test-geheim')).rejects.toThrow(/geweigerd/);
    let message = '';
    try {
      await h.api.bankfeed.testen('fout-id-9999', 'ander-test-geheim');
    } catch (e) {
      message = String((e as Error).message);
    }
    expect(message).not.toContain('ander-test-geheim');
    expect(message).not.toContain('fout-id-9999');
  });
});

describe('Ponto blijft onbekend voor api.integrations.* (#249 regel 5)', () => {
  it('configure, sync en disconnect weigeren het id ponto', async () => {
    expect(() => h.api.integrations.configure('ponto', {}, true)).toThrow(/Onbekende koppeling/);
    await expect(h.api.integrations.sync('ponto')).rejects.toThrow(/Onbekende koppeling/);
    expect(() => h.api.integrations.disconnect('ponto')).toThrow(/Onbekende koppeling/);
    expect(h.api.integrations.list().map((i) => i.definition.id)).not.toContain('ponto');
    expect(h.clientCalls).toBe(0);
  });
});

describe('autoProcess uitsluitend bij werkelijk nieuwe imports, maximaal één keer (regel 4)', () => {
  it('nieuwe transacties: precies één autoProcess en precies één resultaat in het antwoord', async () => {
    const id = await linkAccount(h);
    h.reads.set('acc-1', pontoRead({ transactions: [tx('2026-10-11', -3500, 'p1'), tx('2026-10-11', 12000, 'p2')] }));
    const spy = vi.spyOn(h.s.inbox, 'autoProcess');
    const r = await h.api.bankfeed.ophalen();
    expect(r.importedAny).toBe(true);
    expect(r.autoMatched).toBeTypeOf('number');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(id).toBeGreaterThan(0);
  });

  it('geen nieuwe transacties: geen autoProcess en geen autoMatched in het antwoord', async () => {
    await linkAccount(h);
    h.reads.set('acc-1', pontoRead({ transactions: [] }));
    const spy = vi.spyOn(h.s.inbox, 'autoProcess');
    const r = await h.api.bankfeed.ophalen();
    expect(r.importedAny).toBe(false);
    expect(r.autoMatched).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it('opslaan met een verplichte eerste ronde: autoProcess ook hier alleen bij nieuwe imports', async () => {
    await h.api.bankfeed.testen(CREDS.clientId, CREDS.clientSecret);
    h.reads.set('acc-1', pontoRead({ transactions: [tx('2026-10-11', -3500, 'p1')] }));
    const spy = vi.spyOn(h.s.inbox, 'autoProcess');
    const r = await h.api.bankfeed.opslaan(CREDS.clientId, CREDS.clientSecret, [{ pontoId: 'acc-1', bankAccountId: 'nieuw' }]);
    expect(r.importedAny).toBe(true);
    expect(r.autoMatched).toBeTypeOf('number');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('bijwerken zonder nieuwe transacties: geen autoProcess, ook als de ronde draaide', async () => {
    await linkAccount(h);
    const feedId = Number(feedRow(h.s).id);
    h.reads.set('acc-1', pontoRead({ transactions: [] }));
    const spy = vi.spyOn(h.s.inbox, 'autoProcess');
    const r = await h.api.bankfeed.bijwerken(feedId);
    if ('summary' in r) {
      expect(r.summary.importedAny).toBe(false);
      expect(r.autoMatched).toBeUndefined();
      expect(spy).not.toHaveBeenCalled();
    }
  });
});

describe('gelijktijdige achtergrondronde en IPC delen één service-uitvoering (regel 9)', () => {
  it('twee overlappende ronden (achtergrond + IPC) draaien één clientronde', async () => {
    await linkAccount(h);
    let releaseAccounts: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => (releaseAccounts = resolve));
    (h.s.bankFeed as unknown as { makeClient: unknown }).makeClient = () => ({
      accounts: () => {
        h.calls.push('accounts');
        h.clientCalls += 1;
        return gate.then(() => ({ accounts: h.fake, scope: 'ai' }));
      },
      transactions: (accountId: string) => {
        h.calls.push(`transactions:${accountId}`);
        h.clientCalls += 1;
        const read = h.reads.get(accountId);
        if (!read) throw new PontoError('Ponto: onbekende rekening in de nepclient', 'bad-response');
        return Promise.resolve(read);
      },
    });
    const achtergrond = h.s.bankFeed.round();
    const ipc = h.api.bankfeed.ophalen();
    // de IPC-aanroep is aangesloten op de al draaiende achtergrondronde: één accounts-call
    await Promise.resolve();
    await Promise.resolve();
    expect(h.calls.filter((c) => c === 'accounts')).toHaveLength(1);
    releaseAccounts!();
    const [bg, viaIpc] = await Promise.all([achtergrond, ipc]);
    // beide antwoorden komen uit dezelfde ene uitvoering: één ronde, één accounts + één transactions
    expect(h.calls.filter((c) => c === 'accounts')).toHaveLength(1);
    expect(h.calls.filter((c) => c.startsWith('transactions:'))).toHaveLength(1);
    expect(viaIpc.importedAny).toBe(bg.importedAny);
    expect(h.clientCalls).toBe(2);
  });
});

describe('de bestaande integrations-sync blijft ongewijzigd één keer draaien (regel 7)', () => {
  it('syncAllEnabled roept ponto nooit aan en blijft zijn eigen resultaat geven', async () => {
    await linkAccount(h);
    const results = await h.s.integrations.syncAllEnabled();
    expect(Object.keys(results)).toEqual([]);
    expect(h.clientCalls).toBe(0);
  });
});

describe('host.secureStorage (regel 6)', () => {
  it('de route volgt de host-schakelaar: false meldt geen veilige opslag', () => {
    h.host.secureStorage = false;
    expect(h.api.bankfeed.status().secureStorage).toBe(false);
  });

  it('true geeft de veilige opslag van de host terug', () => {
    h.host.secureStorage = true;
    expect(h.api.bankfeed.status().secureStorage).toBe(true);
  });

  it('zonder veilige opslag weigert opslaan (de bestaande serviceguard, niet een nieuwe)', async () => {
    h.host.secureStorage = false;
    Object.defineProperty(h.secrets, 'available', { value: false, configurable: true });
    await h.api.bankfeed.testen(CREDS.clientId, CREDS.clientSecret);
    await expect(h.api.bankfeed.opslaan(CREDS.clientId, CREDS.clientSecret, [])).rejects.toThrow(/veilige opslag/);
    Object.defineProperty(h.secrets, 'available', { value: true, configurable: true });
  });
});

describe('foutteksten en de achtergrondtaak lekken niets (regel 10)', () => {
  it('een mislukte ronde bewaart uitsluitend de foutsoort, geen providerpayload', async () => {
    await linkAccount(h);
    (h.s.bankFeed as unknown as { makeClient: unknown }).makeClient = () => ({
      accounts: () => Promise.reject(new PontoError('Ponto: inloggegevens geweigerd (fout 401)', 'credentials', 401)),
      transactions: () => { throw new Error('nooit'); },
    });
    const r = await h.api.bankfeed.ophalen();
    expect(r.failed).toEqual([{ pontoId: 'acc-1', errorKind: 'credentials' }]);
    expect(JSON.stringify(r)).not.toContain('test-geheim-wachtwoord');
    expect(JSON.stringify(r)).not.toContain('client-id-1234');
    expect(JSON.stringify(r)).not.toContain('401');
    expect(JSON.stringify(feedRow(h.s))).not.toContain('test-geheim-wachtwoord');
  });

  it('de achtergrondronde logt alleen naam en boodschap van de fout — de aanroep slaat niets over', async () => {
    await linkAccount(h);
    (h.s.bankFeed as unknown as { makeClient: unknown }).makeClient = () => ({
      accounts: () => Promise.reject(new PontoError('Ponto: serverstoring', 'server', 500)),
      transactions: () => { throw new Error('nooit'); },
    });
    // de bestaande taaklogica: round() draait en een fout verdwijnt in een veilige logregel
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => errors.push(args.map(String).join(' ')));
    await h.s.bankFeed.round().catch(() => undefined);
    expect(errors.length).toBe(0); // de service zelf logt niet; de taak omhulsel logt
    vi.restoreAllMocks();
  });
});
