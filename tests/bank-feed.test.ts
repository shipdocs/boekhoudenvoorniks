import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../src/db/database';
import { createServices, MemorySecretStore, type Services } from '../src/services';
import { BANK_FEED, BANK_FEED_SECRET_KEYS } from '../src/shared/bank-feed';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import { PontoError, type PontoAccount, type PontoCredentials, type PontoRead } from '../src/integrations/ponto';
import { BankFeedService, type BankFeedDeps, type FeedLink, type RoundSummary } from '../src/bankfeed/bankfeed';
import type { Db } from '../src/db/database';
import type { NormalizedTransaction } from '../src/import/types';

/**
 * Ponto WP4B (#253): de ophaalronde, bewezen dekking en de conservatieve saldocontrole.
 * Uitsluitend fictieve gegevens, nepclients en een geïnjecteerde klok: nooit een echte
 * netwerkaanroep, nooit echte credentials. Wat #246 bewaakte (credentials in de veilige
 * opslag, guards, de ene lock, `last_ok_at` pas na een geslaagde ronde) blijft hier
 * onaangetast en wordt rond de ronde opnieuw bewezen.
 */

const CREDS: PontoCredentials = { clientId: 'client-id-1234', clientSecret: 'geheim-wachtwoord' };
/** Vast moment: dit is het referentiemoment van alle synchronisatietijdstippen in de tests. */
const NOW = new Date('2026-10-12T12:00:00Z');

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

interface Harness {
  s: Services;
  feed: BankFeedService;
  secrets: MemorySecretStore;
  fake: PontoAccount[];
  /** de transactielijst per Ponto-id; zonder entry faalt die rekening met `onbekend` */
  reads: Map<string, PontoRead>;
  /** laat de volgende client-aanroep (accounts of transactions) deze fout gooien */
  failWith: Error | null;
  clientCalls: number;
  /** welke Ponto-id en venster de laatste `transactions()`-aanroepen hadden */
  lastReadArgs: { accountId: string; sinceDate?: string }[];
  /** de clientmethoden die zijn aangeroepen, in volgorde */
  calls: string[];
}

function makeFakeClient(h: Harness): (creds: PontoCredentials) => { accounts: () => Promise<{ accounts: PontoAccount[]; scope: string }>; transactions: (accountId: string, opts?: { sinceDate?: string }) => Promise<PontoRead> } {
  return () => ({
    accounts: async () => {
      h.clientCalls += 1;
      h.calls.push('accounts');
      if (h.failWith) throw h.failWith;
      return { accounts: h.fake, scope: 'ai' };
    },
    transactions: async (accountId: string, opts: { sinceDate?: string } = {}) => {
      h.clientCalls += 1;
      h.calls.push(`transactions:${accountId}`);
      h.lastReadArgs.push({ accountId, sinceDate: opts.sinceDate });
      if (h.failWith) throw h.failWith;
      const read = h.reads.get(accountId);
      if (!read) throw new Error(`nepclient: geen transacties voor ${accountId}`);
      return read;
    },
  });
}

function feedRow(db: Services['db'], pontoId = 'acc-1'): Record<string, unknown> {
  return db.prepare('SELECT * FROM bank_feed_accounts WHERE external_id = ?').get(pontoId) as Record<string, unknown>;
}

function bankTransactions(s: Services): { date: string; amount: number; description: string; bank_id: string | null }[] {
  return s.db.prepare('SELECT transaction_date AS date, amount, description, bank_id FROM bank_transactions ORDER BY transaction_date, id').all() as { date: string; amount: number; description: string; bank_id: string | null }[];
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
    feed: s.bankFeed,
    secrets,
    fake: [account()],
    reads: new Map([['acc-1', pontoRead()]]),
    failWith: null,
    clientCalls: 0,
    lastReadArgs: [],
    calls: [],
  };
  (h.feed as unknown as { makeClient: unknown }).makeClient = makeFakeClient(h);
  return h;
}

/**
 * Koppelt de standaardrekening actief aan een nieuwe bankrekening via het #246-pad
 * (test eerst, dan koppelen) en wist daarna de tellers, zodat elke test telt wat de
 * ronde zelf doet.
 */
async function linkAccount(h: Harness, link: FeedLink = { pontoId: 'acc-1', bankAccountId: 'nieuw' }): Promise<number> {
  await h.feed.test(CREDS);
  h.feed.saveLinks(CREDS, [link]);
  h.clientCalls = 0;
  h.calls.length = 0;
  h.lastReadArgs.length = 0;
  const row = feedRow(h.s.db, link.pontoId);
  return row.bank_account_id as number;
}

/** Een bestaand afschrift van de gebruiker zelf: bewijst de dekking t/m `to` (#226-regel van de app). */
function bestaandAfschrift(h: Harness, bankAccountId: number, to: string, importedAt: string): void {
  h.s.bank.import({
    source: 'csv',
    warnings: [],
    transactions: [{ date: to, amount: -5000, description: 'Huurbetaling', counterIban: 'NL44RABO0123456789' }],
  }, { bankAccountId, importedAt });
}

let h: Harness;

beforeEach(() => {
  BANK_FEED.available = true;
  vi.useFakeTimers({ now: NOW });
  h = setup();
});

afterEach(() => {
  BANK_FEED.available = false; // de vlag is een gedeeld object; netjes terugzetten
  vi.useRealTimers();
  h.s.db.close();
});

describe('nieuwe transacties en bewezen dekking (#253)', () => {
  it('importeert nieuwe transacties via de bestaande BankService.import (bron openbanking, expliciete rekening)', async () => {
    const bankAccountId = await linkAccount(h);
    h.reads.set('acc-1', pontoRead({ transactions: [tx('2026-10-10', -3500, 'p1'), tx('2026-10-11', 12000, 'p2')] }));
    const summary = await h.feed.round();
    expect(summary.importedAny).toBe(true);
    expect(summary.accounts).toEqual([{ pontoId: 'acc-1', bankAccountId, imported: 2 }]);
    expect(summary.skipped).toEqual([]);
    expect(summary.failed).toEqual([]);
    // de regels staan op de gekoppelde rekening met de bank-id van Ponto
    expect(bankTransactions(h.s)).toEqual([
      { date: '2026-10-10', amount: -3500, description: 'Betaling p1', bank_id: 'p1' },
      { date: '2026-10-11', amount: 12000, description: 'Betaling p2', bank_id: 'p2' },
    ]);
    // een tweede ronde met dezelfde regels importeert niets nieuws (hash op bank-id)
    const again = await h.feed.round();
    expect(again.accounts[0]!.imported).toBe(0);
    expect(bankTransactions(h.s)).toHaveLength(2);
  });

  it('een lege maar volledige ronde zet de dekking voort vanaf een reeds bewezen aansluiting', async () => {
    const bankAccountId = await linkAccount(h);
    // een bestaand afschrift van de gebruiker besloeg t/m 5 oktober
    bestaandAfschrift(h, bankAccountId, '2026-10-05', '2026-10-06 08:00:00');
    h.reads.set('acc-1', pontoRead({ transactions: [] }));
    const summary = await h.feed.round();
    expect(summary.importedAny).toBe(false);
    expect(summary.accounts).toEqual([{ pontoId: 'acc-1', bankAccountId: expect.any(Number), imported: 0 }]);
    // de lege ronde zette de bewezen dekking voort t/m de dag vóór het synchronisatiemoment
    expect(feedRow(h.s.db).covered_to).toBe('2026-10-11');
    expect(feedRow(h.s.db).transactions_synchronized_at).toBe('2026-10-12T12:00:00.000Z');
  });

  it('een nieuwe rekening zonder afschrift of openingsbewijs blijft expliciet incompleet', async () => {
    await linkAccount(h);
    h.reads.set('acc-1', pontoRead({ transactions: [tx('2026-10-10', -3500, 'p1')] }));
    await h.feed.round();
    // de transacties staan erin, maar zonder eerder bewijs is er geen covered_to
    expect(feedRow(h.s.db).covered_to).toBeNull();
    // en de app beweert ook geen feeddekking: de enige regels zijn de transacties zelf
    // (volgens de bestaande regel van de app telt zo'n regel haar eigen dag mee)
    const st = h.s.bank.importStatus().find((x) => x.bankAccountId === feedRow(h.s.db).bank_account_id)!;
    expect(st.completeTo).toBe('2026-10-10');
  });

  it('sluit gatloos aan op een bestaand afschrift: geen dubbel en geen gat', async () => {
    const bankAccountId = await linkAccount(h);
    // een eerdere afschriftimport besloeg t/m 5 oktober
    bestaandAfschrift(h, bankAccountId, '2026-10-05', '2026-10-06 08:00:00');
    // de Ponto-ronde leest vanaf het bewezen venster en bevat die oude regel ook (zelfde bank-id)
    h.reads.set('acc-1', pontoRead({
      transactions: [
        tx('2026-10-05', -5000, 'oud-1', { description: 'Huurbetaling' }),
        tx('2026-10-08', -3500, 'p1'),
      ],
    }));
    const summary = await h.feed.round();
    // de oude regel is een dubbel, de nieuwe gewoon erin
    expect(summary.accounts[0]!.imported).toBe(1);
    expect(bankTransactions(h.s)).toHaveLength(2);
    // dekking sluit gatloos aan op de vorige bewezen dag
    expect(feedRow(h.s.db).covered_to).toBe('2026-10-11');
    const st = h.s.bank.importStatus().find((x) => x.bankAccountId === bankAccountId)!;
    expect(st.gap).toBeNull();
  });

  it('leest uitsluitend vanaf max(link_from, covered_to - 7 dagen) terug', async () => {
    const bankAccountId = await linkAccount(h);
    // een bewezen dekkingsrij t/m 30 september en een koppelingsdag van 15 september
    bestaandAfschrift(h, bankAccountId, '2026-09-30', '2026-10-01 08:00:00');
    h.s.db.prepare('UPDATE bank_feed_accounts SET link_from = ? WHERE external_id = ?').run('2026-09-15', 'acc-1');
    h.reads.set('acc-1', pontoRead({ transactions: [tx('2026-10-05', -3500, 'p1')] }));
    await h.feed.round();
    // max(2026-09-15, 2026-09-30 - 7 = 2026-09-23) = 2026-09-23
    expect(h.lastReadArgs[0]).toEqual({ accountId: 'acc-1', sinceDate: '2026-09-23' });
    expect(feedRow(h.s.db).covered_to).toBe('2026-10-11');
  });

  it('zonder bewezen grenzen leest de ronde zonder venster; de eerste transactiedatum bewijst nooit begindekking', async () => {
    await linkAccount(h);
    h.reads.set('acc-1', pontoRead({ transactions: [tx('2026-10-01', 999, 'p0')] }));
    await h.feed.round();
    // geen link_from en geen covered_to: geen sinceDate
    expect(h.lastReadArgs[0]).toEqual({ accountId: 'acc-1', sinceDate: undefined });
    // maar ook geen dekking: 1 oktober als "eerste transactie" bewijst niets
    expect(feedRow(h.s.db).covered_to).toBeNull();
    // alleen de transactie zelf telt (bestaande app-regel), geen feeddekking ervóór
    expect(h.s.bank.importStatus().find((x) => x.bankAccountId === feedRow(h.s.db).bank_account_id)!.completeTo).toBe('2026-10-01');
  });
});

describe('synchronisatiemetadata bepaalt de dekking (#253)', () => {
  beforeEach(async () => {
    const bankAccountId = await linkAccount(h);
    // een bewezen basis: afschrift t/m 5 oktober
    bestaandAfschrift(h, bankAccountId, '2026-10-05', '2026-10-06 08:00:00');
    h.reads.set('acc-1', pontoRead({ transactions: [tx('2026-10-08', -3500, 'p1')] }));
  });

  it('hetzelfde transactiesynchronisatietijdstip tweemaal: geen nieuwe dekking, nieuwe transacties wél zonder period', async () => {
    const first = await h.feed.round();
    expect(first.accounts[0]!.imported).toBe(1);
    expect(feedRow(h.s.db).covered_to).toBe('2026-10-11');
    expect(feedRow(h.s.db).transactions_synchronized_at).toBe('2026-10-12T12:00:00.000Z');
    // tweede ronde: Ponto geeft hetzelfde synchronisatietijdstip terug, maar wel een nieuwe regel
    h.reads.set('acc-1', pontoRead({ transactions: [tx('2026-10-08', -3500, 'p1'), tx('2026-10-11', -1200, 'p2')] }));
    const second = await h.feed.round();
    expect(second.accounts[0]!.imported).toBe(1); // de nieuwe regel is gewoon geïmporteerd
    // dekking en tijdstip zijn niet vooruit: hetzelfde moment bewijst niets nieuws
    expect(feedRow(h.s.db).covered_to).toBe('2026-10-11');
    expect(feedRow(h.s.db).transactions_synchronized_at).toBe('2026-10-12T12:00:00.000Z');
  });

  it('onvolledige paginering importeert veilig maar geeft geen dekking', async () => {
    h.reads.set('acc-1', pontoRead({ complete: false, transactions: [tx('2026-10-08', -3500, 'p1')] }));
    const summary = await h.feed.round();
    expect(summary.accounts[0]!.imported).toBe(1); // de veilige regel is gewoon geïmporteerd
    expect(feedRow(h.s.db).covered_to).toBeNull();
    expect(feedRow(h.s.db).transactions_synchronized_at).toBeNull();
  });

  it('ontbrekende of mislukte transactiemetadata geeft geen dekking', async () => {
    // geen latestSynchronization in het antwoord
    h.reads.set('acc-1', pontoRead({ latestSynchronization: null }));
    await h.feed.round();
    expect(feedRow(h.s.db).covered_to).toBeNull();
    expect(feedRow(h.s.db).transactions_synchronized_at).toBeNull();
    // een mislukte laatste synchronisatie
    h.reads.set('acc-1', pontoRead({ latestSynchronization: { id: 'sync-2', status: 'error', subtype: 'accountTransactions', errors: [] } }));
    await h.feed.round();
    expect(feedRow(h.s.db).covered_to).toBeNull();
    // geen synchronizedAt
    h.reads.set('acc-1', pontoRead({ synchronizedAt: null }));
    await h.feed.round();
    expect(feedRow(h.s.db).transactions_synchronized_at).toBeNull();
  });

  it('een ouder synchronisatietijdstip schuift de dekking niet vooruit', async () => {
    await h.feed.round();
    expect(feedRow(h.s.db).covered_to).toBe('2026-10-11');
    expect(feedRow(h.s.db).transactions_synchronized_at).toBe('2026-10-12T12:00:00.000Z');
    // de volgende ronde meldt een ouder moment (kan bij een trage, herhaalde synchronisatie)
    h.reads.set('acc-1', pontoRead({ synchronizedAt: '2026-10-11T08:00:00.000Z' }));
    await h.feed.round();
    // niets is achteruitgegaan
    expect(feedRow(h.s.db).covered_to).toBe('2026-10-11');
    expect(feedRow(h.s.db).transactions_synchronized_at).toBe('2026-10-12T12:00:00.000Z');
  });

  it('gebruikt uitsluitend PontoRead.synchronizedAt voor importedAt en transactions_synchronized_at, nooit detailsSynchronizedAt', async () => {
    h.reads.set('acc-1', pontoRead({ transactions: [tx('2026-10-08', -3500, 'p1')], synchronizedAt: '2026-10-12T09:30:00.000Z' }));
    h.fake = [account({ detailsSynchronizedAt: '2026-10-12T14:00:00.000Z' })];
    await h.feed.round();
    // transactions_synchronized_at komt uit de transactierespons (09:30), niet uit de details (14:00)
    expect(feedRow(h.s.db).transactions_synchronized_at).toBe('2026-10-12T09:30:00.000Z');
    const batch = h.s.db.prepare('SELECT imported_at FROM import_batches ORDER BY id DESC LIMIT 1').get() as { imported_at: string };
    expect(batch.imported_at).toBe('2026-10-12 09:30:00');
    // de details zijn apart en later bijgewerkt
    expect(feedRow(h.s.db).details_synchronized_at).toBe('2026-10-12T14:00:00.000Z');
  });
});

describe('fouten per rekening (#253)', () => {
  it('deprecated: status weg met foutsoort account-gone, dekking en saldo blijven staan', async () => {
    await linkAccount(h);
    h.s.db.prepare('UPDATE bank_feed_accounts SET covered_to = ?, balance = ?, balance_at = ? WHERE external_id = ?').run('2026-10-05', 100000, '2026-10-05T10:00:00.000Z', 'acc-1');
    h.fake = [account({ deprecated: true })];
    const summary = await h.feed.round();
    expect(summary.failed).toEqual([{ pontoId: 'acc-1', errorKind: 'account-gone' }]);
    expect(summary.accounts).toEqual([]);
    expect(feedRow(h.s.db).status).toBe('weg');
    expect(feedRow(h.s.db).last_error_kind).toBe('account-gone');
    // de bestaande dekking en het saldo zijn niet gewist
    expect(feedRow(h.s.db).covered_to).toBe('2026-10-05');
    expect(feedRow(h.s.db).balance).toBe(100000);
  });

  it('ontbrekende rekening in de accountlijst: weg met account-gone', async () => {
    await linkAccount(h);
    h.fake = []; // Ponto geeft de rekening niet meer terug
    const summary = await h.feed.round();
    expect(summary.failed).toEqual([{ pontoId: 'acc-1', errorKind: 'account-gone' }]);
    expect(feedRow(h.s.db).status).toBe('weg');
    expect(feedRow(h.s.db).last_error_kind).toBe('account-gone');
  });

  it('readonly: overgeslagen zonder bestaande status, dekking, saldo of foutgegevens te overschrijven', async () => {
    await linkAccount(h);
    h.s.db.prepare('UPDATE bank_feed_accounts SET covered_to = ?, balance = ?, balance_at = ?, transactions_synchronized_at = ? WHERE external_id = ?')
      .run('2026-10-05', 100000, '2026-10-05T10:00:00.000Z', '2026-10-05T10:00:00.000Z', 'acc-1');
    h.fake = [account({ availability: 'readonly' })];
    const summary = await h.feed.round();
    expect(summary.skipped).toEqual([{ pontoId: 'acc-1' }]);
    expect(summary.accounts).toEqual([]);
    expect(summary.failed).toEqual([]);
    // niets is overschreven: geen last_ok_at, geen foutsoort, geen nieuwe tijden
    expect(feedRow(h.s.db).covered_to).toBe('2026-10-05');
    expect(feedRow(h.s.db).balance).toBe(100000);
    expect(feedRow(h.s.db).transactions_synchronized_at).toBe('2026-10-05T10:00:00.000Z');
    expect(feedRow(h.s.db).last_ok_at).toBeNull();
    expect(feedRow(h.s.db).last_error_kind).toBeNull();
    expect(h.lastReadArgs).toEqual([]); // er is niet eens transacties gevraagd
  });

  it('een fout bij één rekening stopt de overige rekeningen niet', async () => {
    h.fake = [account(), account({ id: 'acc-2', iban: 'NL85ABNA0000000000' })];
    await h.feed.test(CREDS);
    h.feed.saveLinks(CREDS, [{ pontoId: 'acc-1', bankAccountId: 'nieuw' }, { pontoId: 'acc-2', bankAccountId: 'nieuw' }]);
    h.reads.set('acc-1', pontoRead({ transactions: [tx('2026-10-10', -3500, 'p1')] }));
    h.reads.set('acc-2', pontoRead({ transactions: [tx('2026-10-10', -7200, 'p9')] }));
    // vervang de nepclient: alleen de transactieaanroep van acc-1 faalt met een echte PontoError
    (h.feed as unknown as { makeClient: unknown }).makeClient = () => ({
      accounts: async () => {
        h.clientCalls += 1;
        h.calls.push('accounts');
        return { accounts: h.fake, scope: 'ai' };
      },
      transactions: async (accountId: string, opts: { sinceDate?: string } = {}) => {
        h.clientCalls += 1;
        h.calls.push(`transactions:${accountId}`);
        h.lastReadArgs.push({ accountId, sinceDate: opts.sinceDate });
        if (accountId === 'acc-1') throw new PontoError('Ponto: serverstoring (fout 500)', 'server', 500);
        const read = h.reads.get(accountId);
        if (!read) throw new Error(`nepclient: geen transacties voor ${accountId}`);
        return read;
      },
    });
    const summary = await h.feed.round();
    expect(summary.failed).toEqual([{ pontoId: 'acc-1', errorKind: 'server' }]);
    expect(summary.accounts).toEqual([{ pontoId: 'acc-2', bankAccountId: expect.any(Number), imported: 1 }]);
    // de foutsoort staat alleen bij de mislukte rekening
    expect(feedRow(h.s.db, 'acc-1').last_error_kind).toBe('server');
    expect(feedRow(h.s.db, 'acc-2').last_error_kind).toBeNull();
    expect(feedRow(h.s.db, 'acc-2').last_ok_at).not.toBeNull();
  });

  it('bewaart geen ruwe providerresponse, token, credential, IP of gevoelige fouttekst', async () => {
    await linkAccount(h);
    (h.feed as unknown as { makeClient: unknown }).makeClient = () => ({
      accounts: async () => ({ accounts: h.fake, scope: 'ai' }),
      transactions: async () => { throw new PontoError('Ponto: onverwacht antwoord bij transacties', 'bad-response'); },
    });
    await h.feed.round();
    const row = JSON.stringify(feedRow(h.s.db));
    // geen secrets of ruwe data in de rij
    expect(row).not.toContain('geheim-wachtwoord');
    expect(row).not.toContain('client-id');
    expect(row).not.toContain('token');
    expect(row).not.toContain('Bearer');
    expect(row).not.toContain('192.168');
    expect(feedRow(h.s.db).last_error).toBeNull();
    expect(feedRow(h.s.db).last_error_kind).toBe('bad-response');
  });
});

describe('saldocontrole (#253)', () => {
  beforeEach(async () => {
    const bankAccountId = await linkAccount(h);
    h.s.bank.setOpeningBalance(bankAccountId, 100000, '2026-09-30');
  });

  /** Maakt de saldo-metadata vergelijkbaar: saldo en transacties op exact hetzelfde moment. */
  const vergelijkbaar = (balance: number) => {
    h.fake = [account({ balance, balanceAt: '2026-10-12T12:00:00.000Z' })];
    h.reads.set('acc-1', pontoRead({ transactions: [] }));
  };

  it('zonder geboekt beginsaldo is balanceDifference null', async () => {
    // een verse administratie met een koppeling maar zonder geboekt beginsaldo
    const db2 = new Database(':memory:');
    db2.pragma('foreign_keys = ON');
    migrate(db2);
    const s2 = createServices(db2, {
      pdf: async () => Buffer.from('PDF'),
      mailerFactory: async () => { throw new Error('geen mail in tests'); },
      secrets: new MemorySecretStore(),
      fetch: async () => { throw new Error('geen netwerk in tests'); },
      storeFile: async (name) => `/tmp/${name}`,
      licensePublicKey: '',
    });
    const h2: Harness = { ...h, s: s2, feed: s2.bankFeed, secrets: s2.db ? (h.secrets) : h.secrets, fake: [account()], reads: new Map([['acc-1', pontoRead()]]), failWith: null, clientCalls: 0, lastReadArgs: [], calls: [] };
    // de tweede service heeft zijn eigen secrets; maak een eigen harness-kloon met eigen tellers
    const secrets2 = new MemorySecretStore();
    const feed2 = s2.bankFeed;
    const h2tells = { clientCalls: 0, lastReadArgs: [] as { accountId: string; sinceDate?: string }[], calls: [] as string[] };
    (feed2 as unknown as { makeClient: unknown }).makeClient = () => ({
      accounts: async () => {
        h2tells.clientCalls += 1;
        if (h.failWith) throw h.failWith;
        return { accounts: h2.fake, scope: 'ai' };
      },
      transactions: async (accountId: string, opts: { sinceDate?: string } = {}) => {
        h2tells.clientCalls += 1;
        h2tells.lastReadArgs.push({ accountId, sinceDate: opts.sinceDate });
        const read = h2.reads.get(accountId);
        if (!read) throw new Error(`nepclient: geen transacties voor ${accountId}`);
        return read;
      },
    });
    await feed2.test(CREDS);
    feed2.saveLinks(CREDS, [{ pontoId: 'acc-1', bankAccountId: 'nieuw' }]);
    h2.fake = [account({ balance: 100000, balanceAt: '2026-10-12T12:00:00.000Z' })];
    await feed2.round();
    const row2 = db2.prepare('SELECT id FROM bank_feed_accounts').get() as { id: number };
    void secrets2;
    // geen beginsaldo geboekt: geen saldocontrole
    expect(feed2.balanceDifference(row2.id)).toBeNull();
    db2.close();
  });

  it('na één vergelijkbare volledige ronde met een niet-nulverschil: rounds 1; na de tweede dezelfde: rounds 2', async () => {
    // de app verwacht 100000 beginsaldo + 0 transacties = 100000; Ponto zegt 110000: verschil 10000
    vergelijkbaar(110000);
    await h.feed.round();
    const feedId = feedRow(h.s.db).id as number;
    expect(h.feed.balanceDifference(feedId)).toEqual({ difference: 10000, rounds: 1 });
    // tweede vergelijkbare volledige ronde met hetzelfde verschil
    await h.feed.round();
    expect(h.feed.balanceDifference(feedId)).toEqual({ difference: 10000, rounds: 2 });
    // een derde gelijke ronde telt gewoon door
    await h.feed.round();
    expect(h.feed.balanceDifference(feedId)).toEqual({ difference: 10000, rounds: 3 });
  });

  it('een ander verschil of een nulverschil reset de teller conservatief', async () => {
    vergelijkbaar(110000);
    await h.feed.round();
    const feedId = feedRow(h.s.db).id as number;
    expect(h.feed.balanceDifference(feedId)).toEqual({ difference: 10000, rounds: 1 });
    // een ander verschil: terug naar 1
    vergelijkbaar(120000);
    await h.feed.round();
    expect(h.feed.balanceDifference(feedId)).toEqual({ difference: 20000, rounds: 1 });
    // nulverschil: de teller is leeg
    vergelijkbaar(100000);
    await h.feed.round();
    expect(h.feed.balanceDifference(feedId)).toEqual({ difference: 0, rounds: 0 });
  });

  it('niet-vergelijkbare saldometadata geeft geen verschil en reset de teller', async () => {
    vergelijkbaar(110000);
    await h.feed.round();
    const feedId = feedRow(h.s.db).id as number;
    expect(h.feed.balanceDifference(feedId)).toEqual({ difference: 10000, rounds: 1 });
    // saldo op een ander moment dan de transacties: niet vergelijkbaar
    h.fake = [account({ balance: 130000, balanceAt: '2026-10-12T15:00:00.000Z' })];
    await h.feed.round();
    expect(h.feed.balanceDifference(feedId)).toBeNull();
  });

  it('saldo metadata zonder saldo of zonder tijdstip: geen verschil, teller reset', async () => {
    const feedId = feedRow(h.s.db).id as number;
    // geen saldo bekend
    h.fake = [account({ balance: null })];
    await h.feed.round();
    expect(h.feed.balanceDifference(feedId)).toBeNull();
    // wel saldo, maar geen balanceAt
    h.fake = [account({ balance: 110000, balanceAt: null })];
    await h.feed.round();
    expect(h.feed.balanceDifference(feedId)).toBeNull();
  });
});

describe('gelijktijdigheid en de service-lock (#253)', () => {
  it('twee overlappende gewone rondes delen precies één uitvoering', async () => {
    await linkAccount(h);
    h.reads.set('acc-1', pontoRead({ transactions: [tx('2026-10-10', -3500, 'p1')] }));
    // laat de transactie-aanroep op een poort wachten, zodat de tweede round() nog kan starten
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    (h.feed as unknown as { makeClient: unknown }).makeClient = () => ({
      accounts: async () => {
        h.clientCalls += 1;
        h.calls.push('accounts');
        return { accounts: h.fake, scope: 'ai' };
      },
      transactions: async (accountId: string, opts: { sinceDate?: string } = {}) => {
        h.clientCalls += 1;
        h.calls.push(`transactions:${accountId}`);
        h.lastReadArgs.push({ accountId, sinceDate: opts.sinceDate });
        await gate;
        const read = h.reads.get(accountId);
        if (!read) throw new Error(`nepclient: geen transacties voor ${accountId}`);
        return read;
      },
    });
    const first = h.feed.round();
    const second = h.feed.round();
    release();
    const [a, b] = await Promise.all([first, second]);
    // beide aanroepen krijgen hetzelfde resultaat van één gedeelde ronde
    expect(a).toEqual(b);
    expect(a.accounts).toHaveLength(1);
    // maar er is maar één keer de accountlijst en één keer transacties gelezen
    expect(h.calls.filter((c) => c === 'accounts')).toHaveLength(1);
    expect(h.calls.filter((c) => c.startsWith('transactions:'))).toHaveLength(1);
    // en er staat maar één batch in de database
    expect((h.s.db.prepare('SELECT COUNT(*) AS n FROM import_batches').get() as { n: number }).n).toBe(1);
  });

  it('save() bewaart en draait exact één ronde uit zonder deadlock', async () => {
    await h.feed.test(CREDS); // de bestaande servicebasis eist een testresultaat vóór opslag
    h.reads.set('acc-1', pontoRead({ transactions: [tx('2026-10-10', -3500, 'p1')] }));
    h.clientCalls = 0;
    h.calls.length = 0;
    const summary = await h.feed.save(CREDS, [{ pontoId: 'acc-1', bankAccountId: 'nieuw' }]);
    // de koppeling staat erin en de ronde heeft daarna precies één keer gedraaid
    expect(feedRow(h.s.db).status).toBe('actief');
    expect(summary.accounts).toEqual([{ pontoId: 'acc-1', bankAccountId: expect.any(Number), imported: 1 }]);
    // precies één accountlijst en één transactieaanroep: geen dubbele of geneste ronde
    expect(h.calls.filter((c) => c === 'accounts')).toHaveLength(1);
    expect(h.calls.filter((c) => c.startsWith('transactions:'))).toHaveLength(1);
    // credentials staan in de veilige opslag
    expect(h.secrets.get(BANK_FEED_SECRET_KEYS.clientId)).toBe('client-id-1234');
  });

  it('de ronde loopt door dezelfde lock: exclusive() en round() kunnen niet door elkaar', async () => {
    await linkAccount(h);
    h.reads.set('acc-1', pontoRead({ transactions: [tx('2026-10-10', -3500, 'p1')] }));
    let active = 0;
    let maxConcurrent = 0;
    const base = makeFakeClient(h)({ ...CREDS });
    (h.feed as unknown as { makeClient: unknown }).makeClient = () => ({
      accounts: async () => {
        active += 1;
        maxConcurrent = Math.max(maxConcurrent, active);
        try { return await base.accounts(); } finally { active -= 1; }
      },
      transactions: base.transactions,
    });
    const taak = h.feed.exclusive(async () => 'gewoon een taak');
    const ronde = h.feed.round();
    await expect(Promise.all([taak, ronde])).resolves.toEqual(['gewoon een taak', expect.anything()]);
    expect(maxConcurrent).toBe(1);
  });

  it('een fout in een eerdere ronde blokkeert de volgende niet', async () => {
    await linkAccount(h);
    h.failWith = new PontoError('Ponto: netwerkfout bij transacties', 'network');
    await h.feed.round(); // faalt niet: de foutsoort staat per rekening in het resultaat
    h.failWith = null;
    h.reads.set('acc-1', pontoRead({ transactions: [tx('2026-10-10', -3500, 'p1')] }));
    const summary = await h.feed.round();
    expect(summary.accounts[0]!.imported).toBe(1);
  });
});

describe('guards, vlag en grenzen van de ronde', () => {
  it('met de vlag uit wordt geen ronde gestart en geen client aangeroepen', async () => {
    await linkAccount(h);
    BANK_FEED.available = false;
    await expect(h.feed.round()).rejects.toThrow(/nog niet beschikbaar/);
    await expect(h.feed.save(CREDS, [])).rejects.toThrow(/nog niet beschikbaar/);
    expect(h.clientCalls).toBe(0);
  });

  it('demo: de ronde gaat niet naar buiten', async () => {
    await linkAccount(h);
    h.s.settings.update({ demoMode: true });
    await expect(h.feed.round()).rejects.toThrow(/demo/);
    expect(h.clientCalls).toBe(0);
  });

  it('read-only: geen ronde', async () => {
    await linkAccount(h);
    const ro = { readonly: true };
    const feed = new BankFeedService({ db: ro as unknown as Db, secrets: h.secrets, bank: h.s.bank, settings: h.s.settings, client: makeFakeClient(h) });
    await expect(feed.round()).rejects.toThrow(/alleen-lezen/);
    expect(h.clientCalls).toBe(0);
  });

  it('zonder credentials wordt de ronde geweigerd', async () => {
    await linkAccount(h);
    h.secrets.delete(BANK_FEED_SECRET_KEYS.clientId);
    await expect(h.feed.round()).rejects.toThrow(/veilige opslag|eerst/);
    expect(h.clientCalls).toBe(0);
  });

  it('een koppeling op "niet gebruiken" (bankAccountId null) wordt nooit geactiveerd of opgehaald', async () => {
    await h.feed.test(CREDS);
    h.feed.saveLinks(CREDS, [{ pontoId: 'acc-1', bankAccountId: null }]);
    expect(feedRow(h.s.db).status).toBe('niet-gebruiken');
    h.clientCalls = 0;
    h.calls.length = 0;
    const summary = await h.feed.round();
    expect(summary.accounts).toEqual([]);
    expect(summary.failed).toEqual([]);
    expect(summary.skipped).toEqual([]);
    expect(h.clientCalls).toBe(0); // er is helemaal niets opgevraagd
  });

  it('een koppeling met status weg wordt niet meer opgehaald', async () => {
    await linkAccount(h);
    h.s.db.prepare('UPDATE bank_feed_accounts SET status = \'weg\' WHERE external_id = ?').run('acc-1');
    h.clientCalls = 0;
    h.calls.length = 0;
    const summary = await h.feed.round();
    expect(summary.accounts).toEqual([]);
    expect(h.clientCalls).toBe(0);
  });

  it('round(accountId) beperkt de ronde tot die ene koppeling', async () => {
    h.fake = [account(), account({ id: 'acc-2', iban: 'NL85ABNA0000000000' })];
    await h.feed.test(CREDS);
    h.feed.saveLinks(CREDS, [{ pontoId: 'acc-1', bankAccountId: 'nieuw' }, { pontoId: 'acc-2', bankAccountId: 'nieuw' }]);
    h.reads.set('acc-1', pontoRead({ transactions: [tx('2026-10-10', -3500, 'p1')] }));
    h.reads.set('acc-2', pontoRead({ transactions: [tx('2026-10-10', -7200, 'p9')] }));
    const feedId2 = feedRow(h.s.db, 'acc-2').id as number;
    const summary = await h.feed.round(feedId2);
    expect(summary.accounts).toEqual([{ pontoId: 'acc-2', bankAccountId: expect.any(Number), imported: 1 }]);
    expect(h.calls.filter((c) => c.startsWith('transactions:'))).toEqual(['transactions:acc-2']);
  });

  it('geen autoProcess(), geen UI en geen featureflagwijziging in de ronde', async () => {
    await linkAccount(h);
    h.reads.set('acc-1', pontoRead({ transactions: [tx('2026-10-10', -3500, 'p1')] }));
    await h.feed.round();
    // de vlag is door de service zelf niet veranderd en de transacties zijn onverwerkt gebleven
    expect(BANK_FEED.available).toBe(true); // alleen de test zelf zette hem aan
    expect(h.s.bank.list({ status: 'nieuw' })).toHaveLength(1); // niets automatisch verwerkt
  });
});

describe('periode afsluiten en "via bank" werken pas na bewezen dekking (#239, #253)', () => {
  it('de periode kan pas t/m een dag worden afgesloten die de feed bewezen heeft gedekt', async () => {
    const bankAccountId = await linkAccount(h);
    h.s.bank.setOpeningBalance(bankAccountId, 100000, '2026-09-30');
    // een bewezen basis: afschrift t/m 5 oktober; de ronde bewijst daarna t/m 11 oktober
    bestaandAfschrift(h, bankAccountId, '2026-10-05', '2026-10-06 08:00:00');
    h.reads.set('acc-1', pontoRead({ transactions: [tx('2026-10-08', -3500, 'p1')] }));
    await h.feed.round();
    const st = h.s.bank.importStatus().find((x) => x.bankAccountId === bankAccountId)!;
    expect(st.completeTo).toBe('2026-10-11');
    // daarmee is de periode t/m 8 oktober gedekt: geen bank-afschriftcontrole meer voor die dag
    const checks = h.s.periods.checks('2026-10-08').filter((c) => c.key.startsWith('bank-afschrift'));
    expect(checks).toEqual([]);
  });

  it('"al betaald via je bank" telt pas mee zodra de betaling via bewezen dekking is ingelezen', async () => {
    const bankAccountId = await linkAccount(h);
    const leverancier = h.s.relations.findOrCreateSupplier('Printhuis');
    const aankoop = h.s.purchases.create({ relationId: leverancier.id, invoiceDate: '2026-10-01', dueDate: '2026-10-10', description: 'Drukwerk', lines: [{ account: ACCOUNTS.inkoopMaterialen, netAmount: 10000, vatCode: 'hoog' }] });
    h.s.purchases.expectOnBank(aankoop.id, bankAccountId, '2026-10-11');
    // vóór de ronde: de aankoop wacht op de bank
    expect(h.s.inbox.awaitingBank(h.s.purchases.listOpen()).get(aankoop.id)).toBe('Zakelijke rekening');
    // de ronde brengt de betaling binnen (met bewezen dekking op de bestaande app-regels)
    h.reads.set('acc-1', pontoRead({ transactions: [tx('2026-10-09', -12100, 'p-pay', { counterName: 'Printhuis', description: 'Drukwerk' })] }));
    await h.feed.round();
    const betaling = h.s.bank.list({ status: 'nieuw' }).find((t) => t.counter_name === 'Printhuis');
    expect(betaling).toBeDefined();
    h.s.bank.matchPurchase(betaling!.id, aankoop.id);
    expect(h.s.purchases.get(aankoop.id).status).toBe('betaald');
    expect(h.s.inbox.awaitingBank(h.s.purchases.listOpen()).size).toBe(0);
  });
});

describe('veranderde inhoud bij dezelfde Ponto-id volgt het conservatieve dubbelpad (#253/#184)', () => {
  it('een gewijzigde transactie met dezelfde Ponto-id wordt niet stil overschreven', async () => {
    await linkAccount(h);
    h.reads.set('acc-1', pontoRead({ transactions: [tx('2026-10-10', -3500, 'p1', { description: 'Koffiehoek' })] }));
    await h.feed.round();
    // dezelfde Ponto-id, maar een ander bedrag: de bank hergebruikte de id voor een andere betaling
    h.reads.set('acc-1', pontoRead({ transactions: [tx('2026-10-10', -9999, 'p1', { description: 'Koffiehoek' })] }));
    await h.feed.round();
    // de oorspronkelijke regel staat er nog ongemoeid bij; het conservatieve dubbelpad heeft beslist
    const rows = bankTransactions(h.s);
    expect(rows.some((r) => r.bank_id === 'p1' && r.amount === -3500)).toBe(true);
    expect(rows.some((r) => r.bank_id === 'p1' && r.amount === -9999)).toBe(false);
    // niets is stil verwijderd of overschreven
    expect((h.s.db.prepare('SELECT COUNT(*) AS n FROM bank_transactions').get() as { n: number }).n).toBeGreaterThanOrEqual(1);
  });
});

describe('ronsamenvatting RoundSummary (#253)', () => {
  it('geeft per rekening het werkelijk nieuwe aantal, overslagen en mislukte rekeningen, zonder geheimen', async () => {
    h.fake = [account(), account({ id: 'acc-2', iban: 'NL85ABNA0000000000', availability: 'readonly' })];
    await h.feed.test(CREDS);
    h.feed.saveLinks(CREDS, [{ pontoId: 'acc-1', bankAccountId: 'nieuw' }, { pontoId: 'acc-2', bankAccountId: 'nieuw' }]);
    h.reads.set('acc-1', pontoRead({ transactions: [tx('2026-10-10', -3500, 'p1')] }));
    h.reads.set('acc-2', pontoRead({ transactions: [] }));
    const summary: RoundSummary = await h.feed.round();
    expect(summary).toEqual({
      accounts: [{ pontoId: 'acc-1', bankAccountId: expect.any(Number), imported: 1 }],
      skipped: [{ pontoId: 'acc-2' }],
      failed: [],
      importedAny: true,
    });
    // het resultaat bevat nooit credentials of providerdata
    const json = JSON.stringify(summary);
    expect(json).not.toContain('geheim');
    expect(json).not.toContain('NL91ABNA');
  });
});
