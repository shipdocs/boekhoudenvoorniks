import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { PontoClient, PontoError, PONTO_BASE_URL, mapPontoTransaction } from '../src/integrations/ponto';
import type { FetchLike } from '../src/integrations/types';
import pontoFixture from './fixtures/ponto-transaction.json';

/**
 * Nep-antwoorden only (#244): er wordt nooit een echte API-call gedaan en er staan nooit echte
 * credentials of rekeningnummers in dit bestand.
 */
const CLIENT_ID = 'probe-client-id';
const CLIENT_SECRET = 'probe-client-secret';
const CREDS = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET };

type FakeResponse = { ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> };
interface RecordedCall {
  url: string;
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal };
}
type Responder = (url: string) => FakeResponse;

function jsonResponse(status: number, body: unknown): FakeResponse {
  const text = JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(text), text: async () => text };
}

function textResponse(status: number, text: string): FakeResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(text), text: async () => text };
}

/** Nep-fetch: sleutel is "METHODE pad-eindigt-met"; niet gevonden → 404. Alle aanroepen worden genoteerd. */
function routeFetch(map: Record<string, Responder>, calls: RecordedCall[] = []): FetchLike {
  return async (url, init) => {
    const method = init?.method ?? 'GET';
    calls.push({ url: String(url), init });
    for (const [key, respond] of Object.entries(map)) {
      const space = key.indexOf(' ');
      const keyMethod = key.slice(0, space);
      const keyPath = key.slice(space + 1);
      if (method === keyMethod && String(url).split('?')[0]!.endsWith(keyPath)) return respond(String(url));
    }
    return jsonResponse(404, { error: 'geen route in de nep-server' });
  };
}

const tokenOk = (scope = 'ai', expiresIn = 1800): Responder => () =>
  jsonResponse(200, { access_token: 'fake-token', token_type: 'Bearer', expires_in: expiresIn, scope });

const ACCOUNT_PATH = '/accounts/acc-1';

const accountResource = (over: Record<string, unknown> = {}, metaOver: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'acc-1',
  type: 'account',
  attributes: {
    referenceType: 'IBAN',
    reference: 'NL91ABNA0417164300',
    description: 'Zakelijke rekening',
    currency: 'EUR',
    ...over,
  },
  meta: {
    account: {
      reference: 'NL91ABNA0417164300',
      referenceType: 'IBAN',
      holder: 'Voorbeeld Holding B.V.',
      currency: 'EUR',
      availability: 'AVAILABLE',
      detailsSynchronizedAt: '2026-03-17T08:00:00.000Z',
      expiresAt: '2026-04-17',
      ...metaOver,
    },
  },
});

const TX_META = {
  synchronizedAt: '2026-03-17T08:05:00.000Z',
  latestSynchronization: { id: 'sync-9', status: 'success', subtype: 'accountTransactions', errors: [] },
};

const tx = (id: string, attrs: Record<string, unknown>): Record<string, unknown> => ({ id, type: 'transaction', attributes: attrs });

const baseTx = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  executionDate: '2026-03-10T10:00:00.000Z',
  valueDate: '2026-03-10',
  amount: '-42.10',
  currency: 'EUR',
  remittanceInformationType: 'unstructured',
  remittanceInformation: 'Krantenkiosk',
  endToEndId: 'E2E-1',
  counterpartName: 'Kiosk De Waag',
  counterpartReference: 'NL44RABO0123456789',
  ...over,
});

const txPage = (transactions: Record<string, unknown>[], next?: string, meta: unknown = TX_META): Record<string, unknown> => ({
  data: transactions,
  meta,
  ...(next === undefined ? {} : { links: { next } }),
});

const CLIENT = 'https://ponto.example.internal';
const NEXT = (cursor: string): string => `${CLIENT}/accounts/acc-1/transactions?page[limit]=100&page[cursor]=${cursor}`;

function makeClient(fetchImpl: FetchLike, now?: () => Date, baseUrl: string = CLIENT): PontoClient {
  return new PontoClient(fetchImpl, CREDS, { baseUrl, now });
}

describe('Ponto', () => {
  describe('token', () => {
    it('stuurt Basic-auth met form-body en zonder het secret in fouten', async () => {
      const calls: RecordedCall[] = [];
      const client = makeClient(routeFetch({
        'POST /oauth2/token': () => jsonResponse(401, { error: `invalid_client secret=${CLIENT_SECRET} iban=NL91ABNA0417164300 token=fake-token` }),
      }, calls));
      const err = await client.accounts().catch((e: unknown) => e as PontoError);
      expect(err).toBeInstanceOf(PontoError);
      expect((err as PontoError).kind).toBe('credentials');
      expect((err as PontoError).status).toBe(401);
      expect((err as Error).message).not.toContain(CLIENT_SECRET);
      expect((err as Error).message).not.toContain(CLIENT_ID);
      expect((err as Error).message).not.toContain('NL91ABNA0417164300');
      expect((err as Error).message).not.toContain('fake-token');
      const first = calls[0]!;
      expect(first.url).toBe(`${CLIENT}/oauth2/token`);
      expect(first.init?.method).toBe('POST');
      expect(first.init?.body).toBe('grant_type=client_credentials');
      expect(first.init?.headers?.['Content-Type']).toBe('application/x-www-form-urlencoded');
      expect(first.init?.headers?.Accept).toBe('application/json');
      expect(first.init?.headers?.Authorization).toMatch(/^Basic [A-Za-z0-9+/=]+$/);
    });

    it('hergebruikt het token in het geheugen en vernieuwt vóór expires_in', async () => {
      const calls: RecordedCall[] = [];
      let nowMs = 1_750_000_000_000;
      const client = makeClient(routeFetch({
        'POST /oauth2/token': tokenOk(),
        'GET /accounts': () => jsonResponse(200, { data: [accountResource()] }),
      }, calls), () => new Date(nowMs));
      await client.accounts();
      await client.accounts();
      const tokenCalls = calls.filter((c) => c.url.endsWith('/oauth2/token')).length;
      expect(tokenCalls).toBe(1); // hergebruikt
      nowMs += 1_750_000; // voorbij now + expires_in(1800 s) − marge(60 s)
      await client.accounts();
      expect(calls.filter((c) => c.url.endsWith('/oauth2/token')).length).toBe(2);
    });

    it('harcodeert geen 30 minuten maar volgt expires_in', async () => {
      const calls: RecordedCall[] = [];
      let nowMs = 1_750_000_000_000;
      const client = makeClient(routeFetch({
        'POST /oauth2/token': tokenOk('ai', 120),
        'GET /accounts': () => jsonResponse(200, { data: [accountResource()] }),
      }, calls), () => new Date(nowMs));
      await client.accounts();
      nowMs += 61_000; // 120 s − marge 60 s is verstreken
      await client.accounts();
      expect(calls.filter((c) => c.url.endsWith('/oauth2/token')).length).toBe(2);
    });

    it('eist scope ai en weigert pi of ontbrekende ai', async () => {
      const calls: RecordedCall[] = [];
      for (const scope of ['ai pi', 'pi', 'fr', 'ai pi fr']) {
        const client = makeClient(routeFetch({ 'POST /oauth2/token': tokenOk(scope) }, calls));
        const err = await client.accounts().catch((e: unknown) => e as PontoError);
        expect((err as PontoError).kind).toBe('forbidden');
      }
      const ok = makeClient(routeFetch({
        'POST /oauth2/token': tokenOk('ai fr'),
        'GET /accounts': () => jsonResponse(200, { data: [] }),
      }));
      await expect(ok.accounts()).resolves.toEqual({ accounts: [], scope: 'ai fr' });
      expect(calls.every((c) => !JSON.stringify(c.init?.headers ?? {}).includes(CLIENT_SECRET))).toBe(true);
    });
  });

  describe('foutsoorten', () => {
    const cases: Array<[string, number, string, number | undefined]> = [
      ['token 401', 401, 'credentials', 401],
      ['token 403', 403, 'credentials', 403],
      ['rekeningen 403', 403, 'forbidden', 403],
      ['429', 429, 'rate-limit', 429],
      ['500', 500, 'server', 500],
      ['503', 503, 'server', 503],
      ['400', 400, 'bad-response', 400],
    ];
    for (const [label, status, kind, expectedStatus] of cases) {
      it(`mapt ${label} op ${kind}`, async () => {
        const isToken = label.startsWith('token');
        // bij een niet-tokengeval slaagt het token en faalt alleen het dataroute-antwoord
        const client = makeClient(routeFetch({
          'POST /oauth2/token': isToken ? () => textResponse(status, '{"error":"x"}') : tokenOk(),
          [`GET ${ACCOUNT_PATH}`]: () => textResponse(status, '{"error":"x"}'),
          'GET /accounts': () => textResponse(status, '{"error":"x"}'),
          [`GET ${ACCOUNT_PATH}/transactions`]: () => textResponse(status, '{"error":"x"}'),
        }));
        const result = await (isToken ? client.accounts() : client.transactions('acc-1')).catch((e: unknown) => e as PontoError);
        expect(result).toBeInstanceOf(PontoError);
        expect((result as PontoError).kind).toBe(kind);
        expect((result as PontoError).status).toBe(expectedStatus);
      });
    }

    it('mapt een netwerkstoring op network', async () => {
      const client = makeClient((async () => { throw new Error('netwerk weg'); }) as unknown as FetchLike);
      await expect(client.accounts()).rejects.toMatchObject({ kind: 'network' });
    });

    it('geeft een time-out bij een antwoord dat te lang duurt', async () => {
      const hanging: FetchLike = (url, init) => new Promise((_, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) { reject(new Error('aborted')); return; }
        signal?.addEventListener('abort', () => reject(new Error('the operation was aborted')));
      });
      const client = new PontoClient(hanging, CREDS, { timeoutMs: 25 });
      await expect(client.accounts()).rejects.toMatchObject({ kind: 'timeout' });
    });

    it('geeft bad-response bij ongeldige JSON of een afwijkende vorm', async () => {
      const invalidJson = makeClient(routeFetch({ 'POST /oauth2/token': () => textResponse(200, '<html>geen json</html>') }));
      await expect(invalidJson.accounts()).rejects.toMatchObject({ kind: 'bad-response' });
      const missingFields = makeClient(routeFetch({ 'POST /oauth2/token': () => jsonResponse(200, { token_type: 'Bearer' }) }));
      await expect(missingFields.accounts()).rejects.toMatchObject({ kind: 'bad-response' });
      const weirdData = makeClient(routeFetch({
        'POST /oauth2/token': tokenOk(),
        'GET /accounts': () => jsonResponse(200, { data: 'geen-lijst' }),
      }));
      await expect(weirdData.accounts()).rejects.toMatchObject({ kind: 'bad-response' });
      const weirdTx = makeClient(routeFetch({
        'POST /oauth2/token': tokenOk(),
        [`GET ${ACCOUNT_PATH}/transactions`]: () => jsonResponse(200, { data: {} }),
      }));
      await expect(weirdTx.transactions('acc-1')).rejects.toMatchObject({ kind: 'bad-response' });
    });

    it('nooit credentials, rekeninggegevens of responses in foutteksten', async () => {
      const leakyBody = `{"error":"invalid_client","detail":"secret=${CLIENT_SECRET} iban=NL91ABNA0417164300 name=Voorbeeld Holding B.V."}`;
      const client = makeClient(routeFetch({
        'POST /oauth2/token': () => textResponse(401, leakyBody),
        'GET /accounts': () => textResponse(500, leakyBody),
      }));
      const err1 = await client.accounts().catch((e: unknown) => e as PontoError);
      for (const err of [err1]) {
        const message = (err as Error).message;
        expect(message).not.toContain(CLIENT_SECRET);
        expect(message).not.toContain(CLIENT_ID);
        expect(message).not.toContain('NL91ABNA0417164300');
        expect(message).not.toContain('Voorbeeld Holding B.V.');
        expect(message).not.toContain('invalid_client');
      }
    });
  });

  describe('accounts', () => {
    it('leest attributes én account-meta defensief', async () => {
      const client = makeClient(routeFetch({
        'POST /oauth2/token': tokenOk('ai fr'),
        'GET /accounts': () => jsonResponse(200, { data: [accountResource()] }),
      }));
      const { accounts, scope } = await client.accounts();
      expect(scope).toBe('ai fr');
      expect(accounts).toEqual([{
        id: 'acc-1',
        iban: 'NL91ABNA0417164300',
        referenceType: 'IBAN',
        name: '',
        holder: 'Voorbeeld Holding B.V.',
        currency: 'EUR',
        subtype: null,
        deprecated: false,
        availability: 'AVAILABLE',
        balance: null,
        balanceAt: null,
        detailsSynchronizedAt: '2026-03-17T08:00:00.000Z', // uit de account-meta, niet het account
        expiresAt: '2026-04-17',
      }]);
    });

    it('laat het IBAN weg bij een andere referenceType of ongeldig IBAN', async () => {
      const client = makeClient(routeFetch({
        'POST /oauth2/token': tokenOk(),
        'GET /accounts': () => jsonResponse(200, { data: [
          accountResource({ reference: 'Niet-een-IBAN' }, { reference: 'Niet-een-IBAN' }),
          accountResource({ referenceType: 'BBAN' }, { referenceType: 'BBAN' }),
          { id: 'acc-2', attributes: { referenceType: 'IBAN' }, meta: { account: { reference: 'nl91 abna 0417 1643 00' } } },
        ] }),
      }));
      const { accounts } = await client.accounts();
      expect(accounts.map((a) => a.iban)).toEqual([null, null, 'NL91ABNA0417164300']);
    });

    it('valt terug op top-level meta en slaat resources zonder id over', async () => {
      const client = makeClient(routeFetch({
        'POST /oauth2/token': tokenOk(),
        'GET /accounts': () => jsonResponse(200, { data: [
          {
            id: 'acc-9',
            attributes: { subtype: 'checking', deprecated: 'true', balance: '1234.56', balanceAt: '2026-03-17T08:00:00.000Z' },
            meta: { reference: 'NL44RABO0123456789', referenceType: 'IBAN', name: 'Derde rekening', holderName: 'Voorbeeld Holding B.V.', availability: 'AVAILABLE', detailsSynchronizedAt: '2026-03-17T07:00:00.000Z', expiresAt: 'onbruikbaar' },
          },
          { attributes: { referenceType: 'IBAN' } }, // geen id → overslaan
          'geen object', // misvormd → overslaan
        ] }),
      }));
      const { accounts } = await client.accounts();
      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({
        id: 'acc-9',
        iban: 'NL44RABO0123456789',
        name: 'Derde rekening',
        holder: 'Voorbeeld Holding B.V.',
        subtype: 'checking',
        deprecated: true,
        balance: 123456,
        balanceAt: '2026-03-17T08:00:00.000Z',
        detailsSynchronizedAt: '2026-03-17T07:00:00.000Z',
        expiresAt: null, // onbruikbare verloopdatum blijft null
      });
    });
  });

  describe('transacties paginering', () => {
      /** Cursorwaarde zoals de client haar ziet (URL-encoding gecorrigeerd). */
      const cursorOfUrl = (url: string): string | null => {
        try {
          return new URL(url).searchParams.get('page[cursor]');
        } catch {
          return null;
        }
      };
  
      it('volgt cursorpaginering binnen dezelfde origin tot het einde', async () => {
        const calls: RecordedCall[] = [];
        const client = makeClient(routeFetch({
          'POST /oauth2/token': tokenOk(),
          [`GET ${ACCOUNT_PATH}`]: () => jsonResponse(200, { data: accountResource() }),
          [`GET ${ACCOUNT_PATH}/transactions`]: (url) => cursorOfUrl(url) === 'c2'
            ? jsonResponse(200, txPage([tx('tx-3', baseTx()), tx('tx-4', baseTx())]))
            : jsonResponse(200, txPage([tx('tx-1', baseTx()), tx('tx-2', baseTx())], NEXT('c2'))),
        }, calls));
      const read = await client.transactions('acc-1');
      expect(read.pages).toBe(2);
      expect(read.complete).toBe(true);
      expect(read.transactions).toHaveLength(4);
      expect(read.transactions.every((t) => t.ownIban === 'NL91ABNA0417164300')).toBe(true);
      expect(read.synchronizedAt).toBe('2026-03-17T08:05:00.000Z');
      expect(read.latestSynchronization).toEqual({ id: 'sync-9', status: 'success', subtype: 'accountTransactions', errors: [] });
      expect(calls.filter((c) => c.url.includes('/transactions')).every((c) => c.url.startsWith(CLIENT))).toBe(true);
    });

    it('volgt een externe of niet-HTTPS next-URL niet', async () => {
      for (const next of ['https://kwaad.example/next', 'http://ponto.example.internal/next', 'niet-een-url']) {
        const client = makeClient(routeFetch({
          'POST /oauth2/token': tokenOk(),
          [`GET ${ACCOUNT_PATH}/transactions`]: () => jsonResponse(200, txPage([tx('tx-1', baseTx())], next)),
        }));
        const read = await client.transactions('acc-1');
        expect(read.pages).toBe(1);
        expect(read.transactions).toHaveLength(1);
        expect(read.complete).toBe(false);
      }
    });

    it('volgt een next-URL op een andere origin niet, ook niet bij een eigenaardige hostname', async () => {
      const client = makeClient(routeFetch({
        'POST /oauth2/token': tokenOk(),
        [`GET ${ACCOUNT_PATH}/transactions`]: () => jsonResponse(200, txPage([tx('tx-1', baseTx())], 'https://ponto.example.internal.kwaad.example/next')),
      }));
      const read = await client.transactions('acc-1');
      expect(read.complete).toBe(false);
      expect(read.pages).toBe(1);
    });

    it('ziet een URL-lus en geeft complete=false', async () => {
      const self = NEXT('c1');
      const client = makeClient(routeFetch({
        'POST /oauth2/token': tokenOk(),
        [`GET ${ACCOUNT_PATH}/transactions`]: () => jsonResponse(200, txPage([tx('tx-1', baseTx())], self)),
      }));
      const read = await client.transactions('acc-1');
      // de lus wordt pas zichtbaar als dezelfde URL/cursor opduikt: de cursorpagina is één keer
      // ge-lezen (twee keer dezelfde inhoud), daarna wordt niet opnieuw gezocht
      expect(read.pages).toBe(2);
      expect(read.complete).toBe(false);
      expect(read.transactions).toHaveLength(2);
    });

    it('ziet een cursorlus via een andere URL met dezelfde cursor', async () => {
      const client = makeClient(routeFetch({
        'POST /oauth2/token': tokenOk(),
        [`GET ${ACCOUNT_PATH}/transactions`]: (url) => jsonResponse(200, txPage(
          [tx('tx-1', baseTx())],
          url.includes('x=1') ? `${NEXT('c2')}&x=2` : `${NEXT('c2')}&x=1`,
        )),
      }));
      const read = await client.transactions('acc-1');
      expect(read.pages).toBe(2);
      expect(read.complete).toBe(false);
    });

    it('stopt bij maxPages en geeft complete=false', async () => {
      const client = makeClient(routeFetch({
        'POST /oauth2/token': tokenOk(),
        [`GET ${ACCOUNT_PATH}/transactions`]: (url) => jsonResponse(200, txPage(
          [tx(cursorOfUrl(url) === 'c2' ? 'tx-3' : 'tx-1', baseTx())],
          cursorOfUrl(url) === 'c2' ? NEXT('c3') : NEXT('c2'),
        )),
      }));
      const read = await client.transactions('acc-1', { maxPages: 2 });
      expect(read.pages).toBe(2);
      expect(read.transactions).toHaveLength(2);
      expect(read.complete).toBe(false);
      const empty = await client.transactions('acc-1', { maxPages: 0 });
      expect(empty.pages).toBe(0);
      expect(empty.transactions).toHaveLength(0);
      expect(empty.complete).toBe(false);
    });

    it('geeft complete=false bij ontbrekende of mislukte transactiemeta', async () => {
      const base = {
        'POST /oauth2/token': tokenOk(),
        [`GET ${ACCOUNT_PATH}/transactions`]: () => jsonResponse(200, txPage([tx('tx-1', baseTx())])),
      };
      const noMeta = makeClient(routeFetch({ ...base, [`GET ${ACCOUNT_PATH}/transactions`]: () => jsonResponse(200, txPage([tx('tx-1', baseTx())], undefined, {})) }));
      const noMetaRead = await noMeta.transactions('acc-1');
      expect(noMetaRead.complete).toBe(false);
      expect(noMetaRead.synchronizedAt).toBeNull();
      expect(noMetaRead.latestSynchronization).toBeNull();
      expect(noMetaRead.transactions).toHaveLength(1); // de regels zelf blijven bruikbaar
      const errorSync = makeClient(routeFetch({ ...base, [`GET ${ACCOUNT_PATH}/transactions`]: () => jsonResponse(200, txPage([tx('tx-1', baseTx())], undefined, { synchronizedAt: '2026-03-17T08:05:00.000Z', latestSynchronization: { id: 'sync-8', status: 'error', subtype: 'accountTransactions', errors: ['inloggen bij de bank mislukt'] } })) }));
      const errorRead = await errorSync.transactions('acc-1');
      expect(errorRead.complete).toBe(false);
      expect(errorRead.latestSynchronization).toEqual({ id: 'sync-8', status: 'error', subtype: 'accountTransactions', errors: ['inloggen bij de bank mislukt'] });
      const malformed = makeClient(routeFetch({ ...base, [`GET ${ACCOUNT_PATH}/transactions`]: () => jsonResponse(200, txPage([tx('tx-1', baseTx())], undefined, { synchronizedAt: '2026-03-17T08:05:00.000Z', latestSynchronization: { id: 'sync-7', status: 'running' } })) }));
      const malformedRead = await malformed.transactions('acc-1');
      expect(malformedRead.complete).toBe(false);
      expect(malformedRead.latestSynchronization).toBeNull();
    });

    it('houdt binnen één pagina de ontvangen (ongesorteerde) volgorde aan', async () => {
      const client = makeClient(routeFetch({
        'POST /oauth2/token': tokenOk(),
        [`GET ${ACCOUNT_PATH}/transactions`]: () => jsonResponse(200, txPage([
          tx('tx-1', baseTx({ executionDate: '2026-03-10T10:00:00.000Z' })),
          tx('tx-2', baseTx({ executionDate: '2026-03-05T10:00:00.000Z' })),
          tx('tx-3', baseTx({ executionDate: '2026-03-08T10:00:00.000Z' })),
        ])),
      }));
      const read = await client.transactions('acc-1');
      expect(read.transactions.map((t) => t.date)).toEqual(['2026-03-10', '2026-03-05', '2026-03-08']);
    });

    it('behoudt gemengde volgorde over pagina’s heen', async () => {
      const client = makeClient(routeFetch({
        'POST /oauth2/token': tokenOk(),
        [`GET ${ACCOUNT_PATH}/transactions`]: (url) => cursorOfUrl(url) === 'c2'
          ? jsonResponse(200, txPage([
              tx('tx-3', baseTx({ executionDate: '2026-03-12T10:00:00.000Z' })),
              tx('tx-4', baseTx({ executionDate: '2026-03-01T10:00:00.000Z' })),
            ]))
          : jsonResponse(200, txPage([
              tx('tx-1', baseTx({ executionDate: '2026-03-10T10:00:00.000Z' })),
              tx('tx-2', baseTx({ executionDate: '2026-03-05T10:00:00.000Z' })),
            ], NEXT('c2'))),
      }));
      const read = await client.transactions('acc-1');
      expect(read.transactions.map((t) => t.date)).toEqual(['2026-03-10', '2026-03-05', '2026-03-12', '2026-03-01']);
      expect(read.complete).toBe(true);
    });

    it('filtert op sinceDate en weigert een ongeldige sinceDate', async () => {
      const client = makeClient(routeFetch({
        'POST /oauth2/token': tokenOk(),
        [`GET ${ACCOUNT_PATH}/transactions`]: (url) => cursorOfUrl(url) === 'c2'
          ? jsonResponse(200, txPage([
              tx('tx-3', baseTx({ executionDate: '2026-03-12T10:00:00.000Z' })),
              tx('tx-4', baseTx({ executionDate: '2026-03-01T10:00:00.000Z' })),
            ]))
          : jsonResponse(200, txPage([
              tx('tx-1', baseTx({ executionDate: '2026-03-10T10:00:00.000Z' })),
              tx('tx-2', baseTx({ executionDate: '2026-03-05T10:00:00.000Z' })),
            ], NEXT('c2'))),
      }));
      const read = await client.transactions('acc-1', { sinceDate: '2026-03-06' });
      expect(read.transactions.map((t) => t.date)).toEqual(['2026-03-10', '2026-03-12']);
      await expect(client.transactions('acc-1', { sinceDate: '17-03-2026' as never })).rejects.toMatchObject({ kind: 'bad-response' });
      await expect(client.transactions('')).rejects.toMatchObject({ kind: 'bad-response' });
    });

    it('telt niet-EUR-regels als skippedForeign en blijft de rest lezen', async () => {
      const client = makeClient(routeFetch({
        'POST /oauth2/token': tokenOk(),
        [`GET ${ACCOUNT_PATH}/transactions`]: () => jsonResponse(200, txPage([
          tx('tx-1', baseTx()),
          tx('tx-2', baseTx({ currency: 'USD', amount: '10.00' })),
          tx('tx-3', baseTx({ currency: 'gbp', amount: '5.00' })),
        ])),
      }));
      const read = await client.transactions('acc-1');
      expect(read.skippedForeign).toBe(2);
      expect(read.transactions).toHaveLength(1);
    });

    it('leest verder als de eigen rekening (voor het eigen IBAN) niet leesbaar is', async () => {
      const client = makeClient(routeFetch({
        'POST /oauth2/token': tokenOk(),
        [`GET ${ACCOUNT_PATH}`]: () => textResponse(404, '{"error":"ontbreekt"}'),
        [`GET ${ACCOUNT_PATH}/transactions`]: () => jsonResponse(200, txPage([tx('tx-1', baseTx())])),
      }));
      const read = await client.transactions('acc-1');
      expect(read.transactions).toHaveLength(1);
      expect(read.transactions[0]?.ownIban ?? null).toBeNull();
      expect(read.complete).toBe(true);
    });
  });

  describe('mapPontoTransaction', () => {
    it('mapt het geanonimiseerde fixturevoorbeeld volledig', () => {
      const mapped = mapPontoTransaction(pontoFixture.data, 'NL91ABNA0417164300');
      expect(mapped).toEqual({
        date: '2026-03-17',
        amount: 24675,
        counterIban: 'NL02ABNA0123456789',
        counterName: 'Voorbeeldklant B.V.',
        description: 'Factuur 2026-0042',
        reference: '+++042/2026/00042+++',
        ownIban: 'NL91ABNA0417164300',
        bankId: '8b1f0c2e-0000-4000-8000-000000000001',
      });
    });

    it('gebruikt executionDate, anders valueDate, anders overslaan', () => {
      expect(mapPontoTransaction(tx('t', baseTx({ executionDate: undefined })), null)?.date).toBe('2026-03-10');
      expect(mapPontoTransaction(tx('t', baseTx({ executionDate: 'garbage', valueDate: '2026-03-11' })), null)?.date).toBe('2026-03-11');
      expect(mapPontoTransaction(tx('t', baseTx({ executionDate: undefined, valueDate: undefined })), null)).toBeNull();
      expect(mapPontoTransaction(tx('t', baseTx({ executionDate: 'niet-een-datum', valueDate: 'ook-niet' })), null)).toBeNull();
    });

    it('kiest gestructureerde remittance als reference, anders endToEndId behalve NOTPROVIDED', () => {
      const structured = tx('t', baseTx({ remittanceInformationType: 'structured', structuredRemittanceInformation: { creditorReference: '+++042/2026/00042+++' } }));
      expect(mapPontoTransaction(structured, null)?.reference).toBe('+++042/2026/00042+++');
      expect(mapPontoTransaction(tx('t', baseTx({ endToEndId: 'NOTPROVIDED' })), null)?.reference).toBeNull();
      expect(mapPontoTransaction(tx('t', baseTx({ endToEndId: undefined })), null)?.reference).toBeNull();
    });

    it('slaat niet-EUR, onbruikbare bedragen en misvormde regels over', () => {
      expect(mapPontoTransaction(tx('t', baseTx({ currency: 'USD' })), null)).toBeNull();
      expect(mapPontoTransaction(tx('t', baseTx({ currency: undefined })), null)).toBeNull();
      expect(mapPontoTransaction(tx('t', baseTx({ amount: 'geen-bedrag' })), null)).toBeNull();
      expect(mapPontoTransaction(tx('t', baseTx({ amount: null })), null)).toBeNull();
      expect(mapPontoTransaction('geen object', null)).toBeNull();
      expect(mapPontoTransaction(null, null)).toBeNull();
      expect(mapPontoTransaction(['lijst'], null)).toBeNull();
    });

    it('behoudt het teken en accepteert bedragen als string of number', () => {
      expect(mapPontoTransaction(tx('t', baseTx({ amount: '-42.10' })), null)?.amount).toBe(-4210);
      expect(mapPontoTransaction(tx('t', baseTx({ amount: 246.75 })), null)?.amount).toBe(24675);
      expect(mapPontoTransaction(tx('t', baseTx({ amount: '1.234,56' })), null)?.amount).toBe(123456);
    });

    it('normaliseert de tegen-IBAN en laat een lege tegenpartij toe', () => {
      expect(mapPontoTransaction(tx('t', baseTx({ counterpartReference: 'nl44 rabo 0123 4567 89' })), null)?.counterIban).toBe('NL44RABO0123456789');
      expect(mapPontoTransaction(tx('t', baseTx({ counterpartReference: 'NL00ONGELDIG99' })), null)?.counterIban).toBeNull();
      expect(mapPontoTransaction(tx('t', baseTx({ counterpartReference: undefined, counterpartName: undefined })), null)).toMatchObject({ counterIban: null, counterName: null });
    });

    it('valt voor de description terug op de tegenpartij en anders een lege string', () => {
      expect(mapPontoTransaction(tx('t', baseTx({ remittanceInformation: undefined })), null)?.description).toBe('Kiosk De Waag');
      expect(mapPontoTransaction(tx('t', baseTx({ remittanceInformation: undefined, counterpartName: undefined })), null)?.description).toBe('');
    });

    it('geeft het Ponto-id als bankId en het meegegeven eigen IBAN door', () => {
      const mapped = mapPontoTransaction(tx('ponto-id-1', baseTx()), null);
      expect(mapped?.bankId).toBe('ponto-id-1');
      expect(mapped?.ownIban).toBeNull();
    });
  });

  describe('synchronisaties', () => {
    it('start een synchronisatie met het juiste lichaam en geeft het id terug', async () => {
      const calls: RecordedCall[] = [];
      const client = makeClient(routeFetch({
        'POST /oauth2/token': tokenOk(),
        'POST /synchronizations': () => jsonResponse(200, { data: { id: 'sync-1', type: 'synchronization' } }),
      }, calls));
      await expect(client.startSynchronization('acc-1', 'accountTransactions', '198.51.100.7')).resolves.toEqual({ id: 'sync-1' });
      const call = calls.find((c) => c.url.endsWith('/synchronizations'))!;
      expect(call.init?.method).toBe('POST');
      expect(JSON.parse(call.init?.body ?? '{}')).toEqual({
        data: { type: 'synchronization', attributes: { resourceType: 'account', resourceId: 'acc-1', subtype: 'accountTransactions', customerIp: '198.51.100.7' } },
      });
      expect(call.init?.headers?.Authorization).toBe('Bearer fake-token');
    });

    it('leest de synchronisatiestatus en fouten defensief', async () => {
      const client = makeClient(routeFetch({
        'POST /oauth2/token': tokenOk(),
        'GET /synchronizations/sync-1': () => jsonResponse(200, { data: { id: 'sync-1', attributes: { status: 'running' } } }),
        'GET /synchronizations/sync-2': () => jsonResponse(200, { data: { id: 'sync-2', attributes: { status: 'success' } } }),
        'GET /synchronizations/sync-3': () => jsonResponse(200, { data: { id: 'sync-3', attributes: { status: 'error', errors: ['inloggen bij de bank mislukt'] } } }),
        'GET /synchronizations/sync-4': () => jsonResponse(200, { data: { id: 'sync-4', attributes: { status: 'onzin' } } }),
        'GET /synchronizations/sync-5': () => jsonResponse(200, { data: 'geen object' }),
      }));
      await expect(client.synchronization('sync-1')).resolves.toEqual({ status: 'running', errors: [] });
      await expect(client.synchronization('sync-2')).resolves.toEqual({ status: 'success', errors: [] });
      await expect(client.synchronization('sync-3')).resolves.toEqual({ status: 'error', errors: ['inloggen bij de bank mislukt'] });
      await expect(client.synchronization('sync-4')).rejects.toMatchObject({ kind: 'bad-response' });
      await expect(client.synchronization('sync-5')).rejects.toMatchObject({ kind: 'bad-response' });
      await expect(client.synchronization('')).rejects.toMatchObject({ kind: 'bad-response' });
      await expect(client.startSynchronization('acc-1', 'accountDetails', '198.51.100.7')).rejects.toMatchObject({ kind: 'bad-response' }); // nep-server heeft geen POST-route
    });
  });

  describe('probe-script', () => {
    interface ProbeSync { id: string | null; subtype: string; status: string; errors: string[] }
    const probe = createRequire(import.meta.url)('../scripts/ponto-probe.cjs') as {
      maskIban(iban: unknown): string;
      maskIbansInText(text: unknown): string;
      nullFields(account: Record<string, unknown>): string[];
      formatSync(label: string, sync: ProbeSync | null): string[];
      formatRead(entry: { read: unknown; error?: string | null }): string[];
      buildReport(input: {
        scope: string;
        accounts: Record<string, unknown>[];
        syncs: { details: ProbeSync | null; transactions: ProbeSync | null }[];
        reads: { read: unknown; error?: string | null }[];
        fixtureExample?: string | null;
      }): string;
    };

    it('maskt IBAN’s tot de laatste vier tekens', () => {
      expect(probe.maskIban('NL91ABNA0417164300')).toBe('…4300');
      expect(probe.maskIban('nl91 abna 0417 1643 00')).toBe('…4300');
      expect(probe.maskIban(null)).toBe('null');
      expect(probe.maskIban(undefined)).toBe('null');
      expect(probe.maskIban('kort')).toBe('null'); // geen IBAN-vorm → niets tonen
      const masked = probe.maskIbansInText('betaling naar NL44RABO0123456789 of NL91ABNA0417164300');
      expect(masked).not.toContain('NL44RABO0123456789');
      expect(masked).not.toContain('NL91ABNA0417164300');
      expect(masked).toContain('…6789');
      expect(masked).toContain('…4300');
    });

    it('noemt de null-velden van een rekening', () => {
      expect(probe.nullFields({ iban: null, holder: 'X', balance: null, subtype: undefined })).toEqual(['iban', 'subtype', 'availability', 'balance', 'balanceAt', 'detailsSynchronizedAt', 'expiresAt']);
      expect(probe.nullFields({ iban: '…', holder: 'X', balance: 1, subtype: 'y', availability: 'a', balanceAt: 'b', detailsSynchronizedAt: 'c', expiresAt: 'd' })).toEqual([]);
    });

    it('printt synchronisatiemetadata en leesresultaten zonder geheimen', () => {
      const sync: ProbeSync = { id: 'sync-1', subtype: 'accountTransactions', status: 'success', errors: [] };
      expect(probe.formatSync('Synchronisatie transacties', sync)).toEqual(['Synchronisatie transacties: id=sync-1 status=success subtype=accountTransactions errors=geen']);
      expect(probe.formatSync('Synchronisatie accountDetails', null)).toEqual(['Synchronisatie accountDetails: niet beschikbaar']);
      const failed = probe.formatRead({ read: null, error: 'Ponto: inloggegevens geweigerd (fout 401)' });
      expect(failed[0]).toContain('mislukt');
      const read = probe.formatRead({
        read: {
          transactions: [{ date: '2026-03-10' }, { date: '2026-03-05' }],
          skippedForeign: 3,
          complete: true,
          pages: 2,
          synchronizedAt: '2026-03-17T08:05:00.000Z',
          latestSynchronization: { id: 'sync-9', status: 'success', subtype: 'accountTransactions', errors: [] },
        },
      });
      expect(read.join('\n')).toContain('2 pagina');
      expect(read.join('\n')).toContain('2026-03-10');
    });

    it('bevat geen credentials of volledige IBAN’s in de probe-output', () => {
      const report = probe.buildReport({
        scope: 'ai fr',
        accounts: [{
          name: 'Voorbeeld Holding B.V. - zakelijk',
          iban: 'NL91ABNA0417164300',
          balance: 123456,
          balanceAt: '2026-03-17T08:00:00.000Z',
          expiresAt: '2026-04-17',
          availability: 'AVAILABLE',
          detailsSynchronizedAt: '2026-03-17T08:00:00.000Z',
          holder: 'Voorbeeld Holding B.V.',
          subtype: null,
        }],
        syncs: [
          { details: { id: 'sync-1', subtype: 'accountDetails', status: 'success', errors: [] }, transactions: { id: 'sync-2', subtype: 'accountTransactions', status: 'error', errors: ['inloggen bij de bank mislukt'] } },
        ],
        reads: [{
          read: {
            transactions: [{ date: '2026-03-10' }, { date: '2026-03-05' }],
            skippedForeign: 1,
            complete: false,
            pages: 1,
            synchronizedAt: null,
            latestSynchronization: null,
          },
        }],
        fixtureExample: JSON.stringify(pontoFixture, null, 2),
      });
      expect(report).toContain('Scope: ai fr');
      expect(report).toContain('…4300'); // laatste vier IBAN-tekens, bewust gemaskerd
      expect(report).not.toContain(CLIENT_SECRET);
      expect(report).not.toContain(CLIENT_ID);
      expect(report).not.toContain('NL91ABNA0417164300'); // nooit een volledig IBAN
      expect(report).not.toContain('NL02ABNA0123456789');
      expect(report).not.toContain('fake-token');
      expect(report).toContain('accountDetails'); // metadata apart per subtype
      expect(report).toContain('accountTransactions');
      expect(report).toContain('inloggen bij de bank mislukt');
      expect(report).toContain('Null-velden');
      expect(report).toContain('geen conclusie'); // geen dekkingsconclusie uit de eerste datum
    });

    it('meldt een mislukte lezing zonder te crashen', () => {
      const report = probe.buildReport({
        scope: 'ai',
        accounts: [{ name: 'Rekening', iban: 'NL91ABNA0417164300' }],
        syncs: [{ details: null, transactions: null }],
        reads: [{ read: null, error: 'Ponto: netwerkfout bij transacties' }],
        fixtureExample: null,
      });
      expect(report).toContain('mislukt');
      expect(report).toContain('niet beschikbaar');
    });

    it('heeft een geldig geanonimiseerd fixture dat mapt', () => {
      expect(pontoFixture).toBeTruthy();
      const mapped = mapPontoTransaction(pontoFixture.data, null);
      expect(mapped?.reference).toBe('+++042/2026/00042+++');
    });
  });

  describe('publiek contract', () => {
    it('exporteert de afgesproken basis-URL en foutvorm', () => {
      expect(PONTO_BASE_URL).toBe('https://api.myponto.com');
      const err = new PontoError('test', 'server', 500);
      expect(err).toBeInstanceOf(Error);
      expect(err.kind).toBe('server');
      expect(err.status).toBe(500);
      expect(err.name).toBe('PontoError');
      const client = new PontoClient((async () => jsonResponse(200, {})) as unknown as FetchLike, CREDS);
      expect(client).toBeInstanceOf(PontoClient);
    });
  });
});
