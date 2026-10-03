import { rmSync } from 'node:fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/database';
import { createServices, MemorySecretStore, type Services } from '../src/services';
import { BANK_FEED, BANK_FEED_SECRET_KEYS } from '../src/shared/bank-feed';
import { BankFeedService, type FeedLink } from '../src/bankfeed/bankfeed';
import type { PontoAccount, PontoCredentials } from '../src/integrations/ponto';

/**
 * WP4A (#246): servicebasis, veilige credentials en rekeningkoppeling. Uitsluitend
 * nep-PontoClient-antwoorden: nooit een echte API-call, nooit echte credentials.
 */

const CREDS: PontoCredentials = { clientId: 'client-id-1234', clientSecret: 'geheim-wachtwoord' };

/** Een Ponto-rekening zoals de gemergde client (`mapPontoAccount`) die teruggeeft. */
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
  balanceAt: '2026-03-17T08:00:00.000Z',
  detailsSynchronizedAt: '2026-03-17T08:00:00.000Z',
  expiresAt: '2026-04-17',
  ...over,
});

interface Harness {
  s: Services;
  feed: BankFeedService;
  secrets: MemorySecretStore;
  /** de rekeningen die de nepclient geeft; per test aan te passen */
  fake: PontoAccount[];
  scope: string;
  clientCalls: number;
}

function makeFakeClient(h: Harness): (creds: PontoCredentials) => { accounts: () => Promise<{ accounts: PontoAccount[]; scope: string }>; transactions: () => Promise<never> } {
  return () => ({
    accounts: async () => {
      h.clientCalls += 1;
      return { accounts: h.fake, scope: h.scope };
    },
    // WP4A testt alleen de basis; de ophaalronde (met transacties) komt in #253 en gebruikt
    // haar eigen nepclient. Hier wordt die methode nooit aangeroepen.
    transactions: async () => { throw new Error('geen transacties in de basistests'); },
  });
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
  const h: Harness = { s, feed: s.bankFeed, secrets, fake: [account()], scope: 'ai', clientCalls: 0 };
  // nep-PontoClient in plaats van de echte: uitsluitend nep-antwoorden
  (h.feed as unknown as { makeClient: unknown }).makeClient = makeFakeClient(h);
  return h;
}

let h: Harness;

beforeEach(() => {
  BANK_FEED.available = true;
  h = setup();
});

afterEach(() => {
  BANK_FEED.available = false; // de vlag is een gedeeld object; netjes terugzetten
  h.s.db.close();
});

describe('status (#246)', () => {
  it('zonder credentials: beschikbaar, veilige opslag aan, niet ingesteld, geen rekeningen', () => {
    expect(h.feed.status()).toEqual({ available: true, secureStorage: true, configured: false, clientIdLast4: null, accounts: [] });
  });

  it('met veilige opslag en credentials: ingesteld, alleen de laatste vier tekens van de Client ID', async () => {
    await h.feed.test(CREDS);
    h.feed.saveLinks(CREDS, [{ pontoId: 'acc-1', bankAccountId: 'nieuw' }]);
    const st = h.feed.status();
    expect(st.configured).toBe(true);
    expect(st.clientIdLast4).toBe('1234');
    expect(st.accounts).toHaveLength(1);
    expect(st.accounts[0]!.pontoId).toBe('acc-1');
    expect(st.accounts[0]!.status).toBe('actief');
    expect(st.accounts[0]!.bankAccountId).toBeGreaterThan(0);
    expect(st.accounts[0]!.iban).toBe('NL91ABNA0417164300');
    expect(st.accounts[0]!.balance).toBe(123456);
    expect(st.accounts[0]!.gap).toBeNull();
    // Een verbindingstest is nog geen financiële ophaalronde; #253 zet dit pas na succes.
    expect(st.accounts[0]!.lastOkAt).toBeNull();
    expect(st.accounts[0]!.lastErrorKind).toBeNull();
  });

  it('zonder veilige opslag: secureStorage false en niet ingesteld', () => {
    Object.defineProperty(h.secrets, 'available', { value: false, configurable: true });
    const st = h.feed.status();
    expect(st.secureStorage).toBe(false);
    expect(st.configured).toBe(false);
    Object.defineProperty(h.secrets, 'available', { value: true, configurable: true });
  });

  it('een kortere Client ID dan vier tekens blijft zo veel als hij is, nooit meer', async () => {
    await h.feed.test({ clientId: 'ab', clientSecret: 'geheim' });
    h.feed.saveLinks({ clientId: 'ab', clientSecret: 'geheim' }, []);
    expect(h.feed.status().clientIdLast4).toBe('ab');
  });
});

describe('credentials uitsluitend in de veilige opslag (#246 regel 2 en 3)', () => {
  it('beide credentials staan in secrets en nergens als plaintext in status of JSON', async () => {
    await h.feed.test(CREDS);
    h.feed.saveLinks(CREDS, [{ pontoId: 'acc-1', bankAccountId: 'nieuw' }]);
    expect(h.secrets.get(BANK_FEED_SECRET_KEYS.clientId)).toBe('client-id-1234');
    expect(h.secrets.get(BANK_FEED_SECRET_KEYS.clientSecret)).toBe('geheim-wachtwoord');
    const json = JSON.stringify(h.feed.status());
    expect(json).not.toContain('client-id-1234');
    expect(json).not.toContain('geheim-wachtwoord');
    // de generieke integratietabel blijft buiten de bankfeed
    expect(h.s.db.prepare('SELECT COUNT(*) AS n FROM integrations').get()).toEqual({ n: 0 });
  });

  it('een onleesbare (weggehaalde) credential betekent configured: false, geen terugval op plaintext', async () => {
    await h.feed.test(CREDS);
    h.feed.saveLinks(CREDS, [{ pontoId: 'acc-1', bankAccountId: 'nieuw' }]);
    h.secrets.delete(BANK_FEED_SECRET_KEYS.clientSecret);
    const st = h.feed.status();
    expect(st.configured).toBe(false);
    // geen betrouwbare credential meer: ook het laatste-vier-venster verdient geen vertrouwen
    expect(st.clientIdLast4).toBeNull();
  });
});

describe('test() bewaart niets en weigert pi (#246 regel 5)', () => {
  it('een geslaagde test maakt niets aan: geen rij, geen credential, status onveranderd', async () => {
    const before = h.feed.status();
    const result = await h.feed.test(CREDS);
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]!.usable).toBe(true);
    expect(h.clientCalls).toBe(1);
    expect(h.secrets.get(BANK_FEED_SECRET_KEYS.clientId)).toBeNull();
    expect(h.secrets.get(BANK_FEED_SECRET_KEYS.clientSecret)).toBeNull();
    expect(h.s.db.prepare('SELECT COUNT(*) AS n FROM bank_feed_accounts').get()).toEqual({ n: 0 });
    expect(h.feed.status()).toEqual(before);
  });

  it('een pi-scope wordt geweigerd en bewaart ook dan niets', async () => {
    h.scope = 'ai pi';
    await expect(h.feed.test(CREDS)).rejects.toThrow(/pi/);
    expect(h.secrets.get(BANK_FEED_SECRET_KEYS.clientId)).toBeNull();
    expect(h.s.db.prepare('SELECT COUNT(*) AS n FROM bank_feed_accounts').get()).toEqual({ n: 0 });
  });

  it('afgewezen inloggegevens komen als gewone melding zonder geheimen', async () => {
    (h.feed as unknown as { makeClient: unknown }).makeClient = () => ({
      accounts: async () => {
        const e = new Error('Ponto: inloggegevens geweigerd (fout 401)') as Error & { kind?: string };
        e.kind = 'credentials';
        throw e;
      },
    });
    await expect(h.feed.test(CREDS)).rejects.toThrow(/inloggegevens/);
    try {
      await h.feed.test(CREDS);
      expect.unreachable('test hoort te mislukken');
    } catch (e) {
      expect(String(e)).not.toContain('geheim-wachtwoord');
    }
  });

  it('lege of witruimte-credentials worden niet doorgestuurd naar de client', async () => {
    await expect(h.feed.test({ clientId: '  ', clientSecret: 'geheim' })).rejects.toThrow(/Client ID/);
    await expect(h.feed.test({ clientId: 'x', clientSecret: '' })).rejects.toThrow(/Client ID/);
    expect(h.clientCalls).toBe(0);
  });

  it('laat bij overlappende tests alleen het laatst gestarte resultaat bewaarbaar worden', async () => {
    let releaseFirst!: (accounts: PontoAccount[]) => void;
    const firstResult = new Promise<PontoAccount[]>((resolve) => { releaseFirst = resolve; });
    let call = 0;
    (h.feed as unknown as { makeClient: unknown }).makeClient = () => ({
      accounts: async () => {
        call += 1;
        return { accounts: call === 1 ? await firstResult : [account({ id: 'acc-nieuwste' })], scope: 'ai' };
      },
    });

    const ouder = h.feed.test(CREDS);
    const nieuwste = h.feed.test(CREDS);
    await expect(nieuwste).resolves.toMatchObject({ accounts: [{ pontoId: 'acc-nieuwste' }] });
    releaseFirst([account({ id: 'acc-ouder' })]);
    await expect(ouder).rejects.toThrow(/nieuwere verbindingstest/);

    expect(() => h.feed.saveLinks(CREDS, [{ pontoId: 'acc-ouder', bankAccountId: null }])).toThrow(/Onbekende Ponto-rekening/);
    h.feed.saveLinks(CREDS, [{ pontoId: 'acc-nieuwste', bankAccountId: null }]);
    expect(h.feed.status().accounts[0]!.pontoId).toBe('acc-nieuwste');
  });
});

describe('bruikbaarheid en IBAN-suggestie (#246 regel 5 en 6)', () => {
  it('stelt een bestaande rekening uitsluitend voor op exact genormaliseerd IBAN', async () => {
    const bestaand = h.s.bank.addAccount('Zakelijk', ' nl91 abna 0417 1643 00 ');
    const result = await h.feed.test(CREDS);
    expect(result.accounts[0]!.suggestedBankAccountId).toBe(bestaand.id);
    expect(result.accounts[0]!.link.proven).toBe(false);
    expect(result.accounts[0]!.link.completeTo).toBeNull();
    expect(result.accounts[0]!.link.note).not.toMatch(/Nieuwe rekening/);
  });

  it('geeft de bewezen completeTo van een exact gematchte bestaande rekening door', async () => {
    const bestaand = h.s.bank.addAccount('Zakelijk', 'NL91ABNA0417164300');
    h.s.bank.import({
      source: 'csv',
      warnings: [],
      transactions: [{ date: '2026-09-12', amount: -2500, description: 'Testbetaling' }],
    }, {
      bankAccountId: bestaand.id,
      importedAt: '2026-09-13 12:00:00',
      period: { from: '2026-09-01', to: '2026-09-12' },
    });

    const result = await h.feed.test(CREDS);
    expect(result.accounts[0]!.suggestedBankAccountId).toBe(bestaand.id);
    expect(result.accounts[0]!.link).toMatchObject({
      completeTo: '2026-09-12',
      from: '2026-09-12',
      proven: true,
    });
    expect(result.accounts[0]!.link.note).toMatch(/bewezen compleet t\/m 2026-09-12/);
  });

  it('vreemde valuta, geen IBAN en deprecated zijn onbruikbaar, elk met een reden', async () => {
    h.fake = [
      account({ id: 'acc-usd', currency: 'USD' }),
      account({ id: 'acc-geen-iban', iban: null, referenceType: 'OTHER' }),
      account({ id: 'acc-weg', deprecated: true }),
    ];
    const result = await h.feed.test(CREDS);
    expect(result.accounts.map((a) => a.usable)).toEqual([false, false, false]);
    expect(result.accounts[0]!.reason).toMatch(/euro/i);
    expect(result.accounts[1]!.reason).toMatch(/IBAN/i);
    expect(result.accounts[2]!.reason).toMatch(/buiten gebruik/i);
    expect(result.accounts.every((a) => a.suggestedBankAccountId === null)).toBe(true);
  });

  it('een nieuwe zakelijke rekening is nooit de standaardkeuze en zonder bewijs incompleet', async () => {
    h.fake = [account({ id: 'acc-nieuw', iban: 'NL85ABNA0000000000' })];
    const result = await h.feed.test(CREDS);
    expect(result.accounts[0]!.usable).toBe(true);
    expect(result.accounts[0]!.suggestedBankAccountId).toBeNull();
    expect(result.accounts[0]!.link.proven).toBe(false);
    expect(result.accounts[0]!.link.completeTo).toBeNull();
    expect(result.accounts[0]!.link.note).toMatch(/afschrift|openingssaldo/);
    // koppelen op "nieuw" maakt een echte bankrekening, maar bewijst niets
    h.feed.saveLinks(CREDS, [{ pontoId: 'acc-nieuw', bankAccountId: 'nieuw' }]);
    const st = h.feed.status();
    expect(st.accounts[0]!.bankAccountId).toBeGreaterThan(0);
    expect(h.s.bank.getAccount(st.accounts[0]!.bankAccountId!).iban).toBe('NL85ABNA0000000000');
    const rows = h.s.db.prepare('SELECT gap_from, gap_to, covered_to, link_from FROM bank_feed_accounts').all() as Record<string, unknown>[];
    expect(rows[0]!.gap_from).toBeNull();
    expect(rows[0]!.gap_to).toBeNull();
    expect(rows[0]!.covered_to).toBeNull();
    expect(rows[0]!.link_from).toBeNull();
  });

  it('een koppeling op een expliciet gekozen bestaande rekening bewaart die keuze exact', async () => {
    const bestaand = h.s.bank.addAccount('Bedrijfsrekening', 'NL91ABNA0417164300');
    await h.feed.test(CREDS);
    h.feed.saveLinks(CREDS, [{ pontoId: 'acc-1', bankAccountId: bestaand.id }]);
    expect(h.feed.status().accounts[0]!.bankAccountId).toBe(bestaand.id);
    // geen tweede rekening aangemaakt door de keuze
    expect(h.s.db.prepare('SELECT COUNT(*) AS n FROM bank_accounts').get()).toEqual({ n: 2 });
  });
});

describe('saveLinks valideert tegen het laatste expliciete testresultaat (#246 regel 7)', () => {
  it('onbekende Ponto-id wordt geweigerd', async () => {
    await h.feed.test(CREDS);
    expect(() => h.feed.saveLinks(CREDS, [{ pontoId: 'acc-onbekend', bankAccountId: 'nieuw' }])).toThrow(/Onbekende Ponto-rekening/);
  });

  it('dubbele Ponto-id wordt geweigerd', async () => {
    await h.feed.test(CREDS);
    const link: FeedLink = { pontoId: 'acc-1', bankAccountId: 'nieuw' };
    expect(() => h.feed.saveLinks(CREDS, [link, { ...link }])).toThrow(/één keer/);
  });

  it('een mislukte hertest maakt een ouder geslaagd testresultaat ongeldig', async () => {
    await h.feed.test(CREDS);
    h.scope = 'ai pi';
    await expect(h.feed.test(CREDS)).rejects.toThrow(/pi/);
    expect(() => h.feed.saveLinks(CREDS, [{ pontoId: 'acc-1', bankAccountId: 'nieuw' }])).toThrow(/Test eerst/);
  });

  it('bewaart geen andere credentials dan de credentials die bij het testresultaat horen', async () => {
    await h.feed.test(CREDS);
    expect(() => h.feed.saveLinks(
      { clientId: 'andere-client', clientSecret: 'ander-geheim' },
      [{ pontoId: 'acc-1', bankAccountId: 'nieuw' }],
    )).toThrow(/opnieuw/);
    expect(h.secrets.get(BANK_FEED_SECRET_KEYS.clientId)).toBeNull();
    expect(h.secrets.get(BANK_FEED_SECRET_KEYS.clientSecret)).toBeNull();
  });

  it('zonder eerder testresultaat wordt elke koppeling geweigerd, ook met bestaande credentials', () => {
    h.secrets.set(BANK_FEED_SECRET_KEYS.clientId, 'client-id-1234');
    h.secrets.set(BANK_FEED_SECRET_KEYS.clientSecret, 'geheim-wachtwoord');
    expect(() => h.feed.saveLinks(null, [{ pontoId: 'acc-1', bankAccountId: 'nieuw' }])).toThrow(/Test eerst/);
  });

  it('bestaande credentials worden behouden als creds === null (in een verse service-instantie)', async () => {
    await h.feed.test(CREDS);
    h.feed.saveLinks(CREDS, [{ pontoId: 'acc-1', bankAccountId: 'nieuw' }]);
    // een nieuwe instantie deelt de veilige opslag, maar niet het testresultaat
    const verse = new BankFeedService({ db: h.s.db, secrets: h.secrets, bank: h.s.bank, settings: h.s.settings, client: makeFakeClient(h) });
    expect(() => verse.saveLinks(null, [{ pontoId: 'acc-1', bankAccountId: 'nieuw' }])).toThrow(/Test eerst/);
    // de credentials zelf zijn niet gewist door de geweigerde koppeling
    expect(h.secrets.get(BANK_FEED_SECRET_KEYS.clientId)).toBe('client-id-1234');
    expect(h.secrets.get(BANK_FEED_SECRET_KEYS.clientSecret)).toBe('geheim-wachtwoord');
    // en mét expliciete credentials mag het wél
    await verse.test(CREDS);
    verse.saveLinks(null, [{ pontoId: 'acc-1', bankAccountId: 'nieuw' }]);
    expect(verse.status().accounts).toHaveLength(1);
  });

  it('een onbekend bestaand bankAccountId wordt geweigerd', async () => {
    await h.feed.test(CREDS);
    expect(() => h.feed.saveLinks(CREDS, [{ pontoId: 'acc-1', bankAccountId: 9999 }])).toThrow(/Onbekende bankrekening/);
  });

  it('creds === null zonder bestaande credentials wordt geweigerd', async () => {
    await h.feed.test(CREDS);
    h.secrets.delete(BANK_FEED_SECRET_KEYS.clientId);
    h.secrets.delete(BANK_FEED_SECRET_KEYS.clientSecret);
    expect(() => h.feed.saveLinks(null, [])).toThrow(/veilige opslag|eerst/);
  });

  it('weigert onbruikbare rekeningen en ongeldige runtime-keuzes vóór opslag', async () => {
    h.fake = [account({ currency: 'USD' })];
    await h.feed.test(CREDS);
    expect(() => h.feed.saveLinks(CREDS, [{ pontoId: 'acc-1', bankAccountId: 'nieuw' }])).toThrow(/niet bruikbaar/);
    expect(() => h.feed.saveLinks(CREDS, [{ pontoId: 'acc-1', bankAccountId: 'anders' as never }])).toThrow(/Onbekende bankrekening/);
    expect(h.secrets.get(BANK_FEED_SECRET_KEYS.clientId)).toBeNull();
    expect(h.s.db.prepare('SELECT COUNT(*) AS n FROM bank_feed_accounts').get()).toEqual({ n: 0 });

    // "Niet gebruiken" is juist wel een geldige, blijvende keuze voor zo'n rekening.
    h.feed.saveLinks(CREDS, [{ pontoId: 'acc-1', bankAccountId: null }]);
    expect(h.feed.status().accounts[0]).toMatchObject({ status: 'niet-gebruiken', bankAccountId: null });
  });
});

describe('rekeningkeuzes en verse accountmetadata', () => {
  it('zet een bestaande actieve koppeling echt op niet-gebruiken en kan haar weer activeren', async () => {
    const bestaand = h.s.bank.addAccount('Bedrijfsrekening', 'NL91ABNA0417164300');
    await h.feed.test(CREDS);
    h.feed.saveLinks(CREDS, [{ pontoId: 'acc-1', bankAccountId: bestaand.id }]);
    expect(h.feed.status().accounts[0]).toMatchObject({ status: 'actief', bankAccountId: bestaand.id });

    h.feed.saveLinks(CREDS, [{ pontoId: 'acc-1', bankAccountId: null }]);
    expect(h.feed.status().accounts[0]).toMatchObject({ status: 'niet-gebruiken', bankAccountId: null });

    h.feed.saveLinks(CREDS, [{ pontoId: 'acc-1', bankAccountId: bestaand.id }]);
    expect(h.feed.status().accounts[0]).toMatchObject({ status: 'actief', bankAccountId: bestaand.id });
  });

  it('ververst nieuwe niet-lege saldo- en syncmetadata maar bewaart bekende waarden bij null', async () => {
    const bestaand = h.s.bank.addAccount('Bedrijfsrekening', 'NL91ABNA0417164300');
    await h.feed.test(CREDS);
    h.feed.saveLinks(CREDS, [{ pontoId: 'acc-1', bankAccountId: bestaand.id }]);

    h.fake = [account({ balance: 222222, balanceAt: '2026-03-18T08:00:00.000Z', detailsSynchronizedAt: '2026-03-18T08:00:00.000Z' })];
    await h.feed.test(CREDS);
    h.feed.saveLinks(null, [{ pontoId: 'acc-1', bankAccountId: bestaand.id }]);
    expect(h.feed.status().accounts[0]).toMatchObject({
      balance: 222222,
      balanceAt: '2026-03-18T08:00:00.000Z',
      detailsSynchronizedAt: '2026-03-18T08:00:00.000Z',
    });

    h.fake = [account({ balance: null, balanceAt: null, detailsSynchronizedAt: null })];
    await h.feed.test(CREDS);
    h.feed.saveLinks(null, [{ pontoId: 'acc-1', bankAccountId: bestaand.id }]);
    expect(h.feed.status().accounts[0]).toMatchObject({
      balance: 222222,
      balanceAt: '2026-03-18T08:00:00.000Z',
      detailsSynchronizedAt: '2026-03-18T08:00:00.000Z',
    });
  });
});

describe('remove() (#246 regel 8)', () => {
  it('wist credentials en koppelingen, maar geen transacties of bankrekeningen', async () => {
    await h.feed.test(CREDS);
    h.feed.saveLinks(CREDS, [{ pontoId: 'acc-1', bankAccountId: 'nieuw' }]);
    const accountId = h.feed.status().accounts[0]!.bankAccountId!;
    h.s.db.prepare(`INSERT INTO bank_transactions (bank_account_id, transaction_date, amount, description, source, dedup_hash)
      VALUES (?, '2026-03-17', -100, 'Krantenkiosk', 'handmatig', 'hash-1')`).run(accountId);
    h.feed.remove();
    expect(h.secrets.get(BANK_FEED_SECRET_KEYS.clientId)).toBeNull();
    expect(h.secrets.get(BANK_FEED_SECRET_KEYS.clientSecret)).toBeNull();
    expect(h.s.db.prepare('SELECT COUNT(*) AS n FROM bank_feed_accounts').get()).toEqual({ n: 0 });
    expect(h.s.db.prepare('SELECT COUNT(*) AS n FROM bank_accounts').get()).toEqual({ n: 2 });
    expect(h.s.db.prepare('SELECT COUNT(*) AS n FROM bank_transactions').get()).toEqual({ n: 1 });
    expect(h.feed.status().configured).toBe(false);
    expect(h.feed.status().clientIdLast4).toBeNull();
  });
});

describe('guards (#246 regel 10)', () => {
  it('vlag uit: test, saveLinks en remove weigeren zonder ook maar één client-aanroep', async () => {
    BANK_FEED.available = false;
    await expect(h.feed.test(CREDS)).rejects.toThrow(/nog niet beschikbaar/);
    expect(() => h.feed.saveLinks(CREDS, [])).toThrow(/nog niet beschikbaar/);
    expect(() => h.feed.remove()).toThrow(/nog niet beschikbaar/);
    expect(h.clientCalls).toBe(0);
  });

  it('demo: er gaat niets naar buiten, ook niet configureren', async () => {
    h.s.settings.update({ demoMode: true });
    await expect(h.feed.test(CREDS)).rejects.toThrow(/demo/);
    expect(() => h.feed.saveLinks(CREDS, [])).toThrow(/demo/);
    expect(() => h.feed.remove()).toThrow(/demo/);
    expect(h.clientCalls).toBe(0);
  });

  it('kantoorkopie: geen configuratie en geen netwerk', async () => {
    h.s.settings.markOfficeCopy({ office: 'Kantoor De Vries', exchange: 1, endDate: '2026-09-30' });
    await expect(h.feed.test(CREDS)).rejects.toThrow(/kopie/);
    expect(() => h.feed.saveLinks(CREDS, [])).toThrow(/kopie/);
    expect(h.clientCalls).toBe(0);
  });

  it('read-only (MCP-koppeling): geen configuratie en geen netwerk', async () => {
    // een echte read-only database, zoals de koppeling voor Claude Code/Codex haar opent
    h.s.db.close();
    const file = `/tmp/gb-wp4a-readonly-${process.pid}.sqlite`;
    const bron = new Database(file);
    bron.pragma('journal_mode = WAL');
    migrate(bron);
    bron.close();
    const ro = new Database(file, { readonly: true });
    const secrets = h.secrets;
    const feed = new BankFeedService({ db: ro, secrets, bank: h.s.bank, settings: h.s.settings, client: makeFakeClient(h) });
    await expect(feed.test(CREDS)).rejects.toThrow(/alleen-lezen/);
    expect(() => feed.saveLinks(CREDS, [])).toThrow(/alleen-lezen/);
    expect(() => feed.remove()).toThrow(/alleen-lezen/);
    expect(h.clientCalls).toBe(0);
    ro.close();
    rmSync(file, { force: true });
    rmSync(`${file}-wal`, { force: true });
    rmSync(`${file}-shm`, { force: true });
  });

  it('zonder veilige opslag weigert saveLinks in gewone taal; test() blijft mogelijk (regel 4)', async () => {
    Object.defineProperty(h.secrets, 'available', { value: false, configurable: true });
    await expect(h.feed.test(CREDS)).resolves.toBeTruthy();
    expect(() => h.feed.saveLinks(CREDS, [])).toThrow(/veilige opslag/);
    Object.defineProperty(h.secrets, 'available', { value: true, configurable: true });
  });
});

describe('de gedeelde lock (#246 regel 9)', () => {
  it('voorkomt twee gelijktijdige callbacks: de tweede begint pas als de eerste klaar is', async () => {
    let active = 0;
    let maxConcurrent = 0;
    const task = async (value: number): Promise<number> => {
      active += 1;
      maxConcurrent = Math.max(maxConcurrent, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return value;
    };
    const first = h.feed.exclusive(() => task(1));
    const second = h.feed.exclusive(() => task(2));
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(maxConcurrent).toBe(1);
  });

  it('een fout in de gelockte taak blokkeert de volgende niet', async () => {
    await expect(h.feed.exclusive(async () => { throw new Error('eerste faalt'); })).rejects.toThrow('eerste faalt');
    await expect(h.feed.exclusive(async () => 'daarna werkt het gewoon')).resolves.toBe('daarna werkt het gewoon');
  });
});
