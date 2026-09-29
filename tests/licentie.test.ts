import Database from 'better-sqlite3';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addMonth, addMonths, handle, type Env, type LicenseDb, type LicenseStatement } from '../workers/licentie/src/app';
import { signLicense } from '../workers/licentie/src/token';
import { LicenseService, verifyLicense } from '../src/license/license';
import { createApi, type HostContext } from '../src/main/api';
import { setup } from './helpers';

const TODAY = '2026-10-15';

function keys() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' }) as { x: string; d: string };
  return { publicKey: jwk.x, privateJwk: JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: jwk.x, d: jwk.d }) };
}

/**
 * D1 nagebootst met een echte SQLite-database: hetzelfde migratiebestand, dezelfde SQL, een batch is één
 * transactie. `failNext` laat de eerstvolgende query die past mislukken (een storing midden in de verwerking).
 */
function fakeD1() {
  const db = new Database(':memory:');
  db.exec(readFileSync(join(__dirname, '../workers/licentie/migrations/0001_licenties.sql'), 'utf8'));
  const failures: RegExp[] = [];
  const check = (sql: string) => {
    const i = failures.findIndex((r) => r.test(sql));
    if (i >= 0) {
      failures.splice(i, 1);
      throw new Error('D1 tijdelijk niet beschikbaar');
    }
  };
  // D1 bindt ?1, ?2 … op volgorde; better-sqlite3 wil ze als object
  const args = (sql: string, params: unknown[]) => (/\?\d/.test(sql) ? [Object.fromEntries(params.map((v, i) => [i + 1, v]))] : params);
  type Exec = LicenseStatement & { exec(): { meta: { changes: number } } };
  const stmt = (sql: string, params: unknown[] = []): Exec => ({
    bind: (...values) => stmt(sql, values),
    first: async <T,>() => {
      check(sql);
      return ((db.prepare(sql).get(...args(sql, params)) as T | undefined) ?? null);
    },
    run: async () => {
      check(sql);
      return { meta: { changes: db.prepare(sql).run(...args(sql, params)).changes } };
    },
    exec: () => {
      check(sql);
      return { meta: { changes: db.prepare(sql).run(...args(sql, params)).changes } };
    },
  });
  const d1: LicenseDb = { prepare: (sql) => stmt(sql), batch: async (stmts) => db.transaction(() => stmts.map((x) => (x as Exec).exec()))() };
  const license = (administratie: string) => db.prepare('SELECT * FROM licenses WHERE administratie = ?').get(administratie) as { months: number; period_start: string; subscription_id: string | null; subscription_claim: string | null } | undefined;
  return { d1, license, failNext: (r: RegExp) => void failures.push(r) };
}

/**
 * Een nagebootste Mollie: onthoudt wat de Worker vroeg. Abonnement aanmaken respecteert de
 * Idempotency-Key (zelfde sleutel → zelfde abonnement), zoals Mollie. `failNext` laat een aanroep mislukken.
 */
function fakeMollie(payments: Record<string, object>) {
  const calls: { method: string; path: string; body: Record<string, unknown> | null; auth: string | null; key: string | null }[] = [];
  const subscriptions = new Map<string, { id: string; status: string; metadata: unknown }>();
  const byKey = new Map<string, string>();
  const failures: RegExp[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace('/v2', '');
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method, path, body, auth: headers.get('authorization'), key: headers.get('idempotency-key') });
    // een tik wachten, zodat gelijktijdige webhooks echt door elkaar lopen
    await new Promise((r) => setTimeout(r, 1));
    const i = failures.findIndex((r) => r.test(`${method} ${path}`));
    if (i >= 0) {
      failures.splice(i, 1);
      return new Response('{"detail":"storing"}', { status: 503 });
    }
    const reply = (x: object) => new Response(JSON.stringify(x), { status: 200 });
    if (path === '/customers') return reply({ id: 'cst_1' });
    if (path === '/payments') return reply({ id: 'tr_first', _links: { checkout: { href: 'https://www.mollie.com/checkout/test' } } });
    if (method === 'POST' && path === '/customers/cst_1/subscriptions') {
      const key = headers.get('idempotency-key') ?? `geen-${calls.length}`;
      let id = byKey.get(key);
      if (!id) {
        id = `sub_${subscriptions.size + 1}`;
        byKey.set(key, id);
        subscriptions.set(id, { id, status: 'active', metadata: body?.metadata ?? null });
      }
      return reply(subscriptions.get(id)!);
    }
    const sub = /^\/customers\/cst_1\/subscriptions\/(sub_\w+)$/.exec(path);
    if (sub && subscriptions.has(sub[1]!)) return reply(subscriptions.get(sub[1]!)!);
    const m = /^\/payments\/(tr_\w+)$/.exec(path);
    if (m && payments[m[1]!]) return reply(payments[m[1]!]!);
    return new Response('{"detail":"not found"}', { status: 404 });
  }) as typeof fetch;
  const created = () => calls.filter((c) => c.method === 'POST' && c.path === '/customers/cst_1/subscriptions').map((c) => c.key);
  return { calls, subscriptions, created, fetchImpl, failNext: (r: RegExp) => void failures.push(r) };
}

function worker(payments: Record<string, object> = {}) {
  const k = keys();
  const db = fakeD1();
  const env: Env = { LICENTIES: db.d1, MOLLIE_API_KEY: 'test_abc', LICENSE_PRIVATE_KEY: k.privateJwk, PUBLIC_URL: 'https://licentie.example', PRICE_EUR: '9.99' };
  const mollie = fakeMollie(payments);
  let today = TODAY;
  const call = (method: string, path: string, body?: string) =>
    handle(new Request(`https://licentie.example${path}`, { method, body, headers: body ? { 'content-type': 'application/x-www-form-urlencoded' } : undefined }), env, { fetch: mollie.fetchImpl, today: () => today });
  const hook = (id: string) => call('POST', '/mollie', `id=${id}`);
  return { ...k, db, env, mollie, call, hook, setToday: (d: string) => void (today = d) };
}

const ADMIN = '2c5bf9f4-1bd5-4fc9-a3b4-da8784765123';
const first = (id: string, paidAt = '2026-10-15T10:00:00+00:00') => ({ id, status: 'paid', sequenceType: 'first', customerId: 'cst_1', paidAt, metadata: { administratie: ADMIN, email: 'piet@example.nl' } });
const recurring = (id: string, subscriptionId: string, paidAt: string) => ({ id, status: 'paid', sequenceType: 'recurring', customerId: 'cst_1', subscriptionId, paidAt });

describe('licentie-Worker', () => {
  it('afrekenen: klant en eerste betaling bij Mollie, door naar de betaalpagina', async () => {
    const w = worker();
    const res = await w.call('GET', `/start?administratie=${ADMIN}&email=piet@example.nl`);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://www.mollie.com/checkout/test');
    const payment = w.mollie.calls.find((c) => c.path === '/payments')!;
    expect(payment.auth).toBe('Bearer test_abc');
    expect(payment.body).toMatchObject({ amount: { currency: 'EUR', value: '9.99' }, customerId: 'cst_1', sequenceType: 'first', webhookUrl: 'https://licentie.example/mollie', metadata: { administratie: ADMIN } });
    expect((await w.call('GET', '/start?administratie=iets&email=piet@example.nl')).status).toBe(400);
    expect((await w.call('GET', `/start?administratie=${ADMIN}&email=geen-mail`)).status).toBe(400);
  });

  it('eerste betaling: abonnement vanaf volgende maand met Idempotency-Key, licentie t/m die maand plus marge', async () => {
    const w = worker({ tr_first: first('tr_first') });
    expect((await w.call('GET', `/licentie?administratie=${ADMIN}`)).status).toBe(404);
    expect((await w.hook('tr_first')).status).toBe(200);
    const sub = w.mollie.calls.find((c) => c.method === 'POST' && c.path === '/customers/cst_1/subscriptions')!;
    expect(sub.body).toMatchObject({ amount: { value: '9.99' }, interval: '1 month', startDate: '2026-11-15', webhookUrl: 'https://licentie.example/mollie', metadata: { administratie: ADMIN } });
    expect(sub.key).toBe('abonnement-tr_first');
    // dezelfde melding nog eens: niets verandert
    await w.hook('tr_first');
    expect(w.mollie.created()).toHaveLength(1);
    expect(w.db.license(ADMIN)).toMatchObject({ months: 1, subscription_id: 'sub_1', subscription_claim: null });

    const { token, validUntil } = (await (await w.call('GET', `/licentie?administratie=${ADMIN}`)).json()) as { token: string; validUntil: string };
    expect(validUntil).toBe('2026-11-22');
    // de app keurt de handtekening van de Worker goed
    expect(verifyLicense(token, w.publicKey)).toMatchObject({ administratie: ADMIN, email: 'piet@example.nl', validUntil: '2026-11-22', product: 'uitwisseling' });
  });

  it('gelijktijdig: dezelfde melding twee keer, of twee eerste betalingen (twee keer geklikt): één abonnement', async () => {
    const w = worker({ tr_a: first('tr_a'), tr_b: first('tr_b', '2026-10-15T10:01:00+00:00') });
    const r = await Promise.all([w.hook('tr_a'), w.hook('tr_a'), w.hook('tr_b'), w.hook('tr_b')]);
    expect(r.map((x) => x.status)).toEqual([200, 200, 200, 200]);
    expect(w.mollie.subscriptions.size).toBe(1);
    // twee keer betaald = twee maanden
    expect(w.db.license(ADMIN)).toMatchObject({ months: 2, period_start: '2026-10-15', subscription_claim: null });
    expect(w.db.license(ADMIN)!.subscription_id).toMatch(/^sub_/);
  });

  it('maandelijkse incasso: precies een maand erbij, ook bij gelijktijdige of herhaalde meldingen', async () => {
    const w = worker({
      tr_first: first('tr_first'),
      tr_nov: recurring('tr_nov', 'sub_1', '2026-11-15T06:00:00+00:00'),
      tr_dec: recurring('tr_dec', 'sub_1', '2026-12-15T06:00:00+00:00'),
      tr_open: { id: 'tr_open', status: 'open', subscriptionId: 'sub_1', customerId: 'cst_1' },
    });
    await w.hook('tr_first');
    await w.hook('tr_open');
    expect(w.db.license(ADMIN)!.months).toBe(1);
    await Promise.all([w.hook('tr_nov'), w.hook('tr_nov'), w.hook('tr_dec')]);
    await w.hook('tr_nov');
    expect(w.db.license(ADMIN)!.months).toBe(3);
    expect(((await (await w.call('GET', `/licentie?administratie=${ADMIN}`)).json()) as { validUntil: string }).validUntil).toBe('2027-01-22');
    expect((await w.hook('iets; drop')).status).toBe(400);
  });

  it('storing na het aanmaken van het abonnement: de herhaling herstelt, zonder tweede abonnement of extra maand', async () => {
    const w = worker({ tr_first: first('tr_first'), tr_nov: recurring('tr_nov', 'sub_1', '2026-11-15T06:00:00+00:00') });
    w.db.failNext(/SET subscription_id = \?, subscription_claim = NULL/);
    expect((await w.hook('tr_first')).status).toBe(500);
    expect(w.mollie.subscriptions.size).toBe(1);
    expect(w.db.license(ADMIN)).toMatchObject({ months: 1, subscription_id: null, subscription_claim: 'tr_first' });
    // een incasso komt binnen vóór de herhaling: de administratie komt uit het abonnement zelf
    expect((await w.hook('tr_nov')).status).toBe(200);
    expect(w.db.license(ADMIN)!.months).toBe(2);
    // de herhaling van de eerste betaling: zelfde Idempotency-Key → zelfde abonnement, geen extra maand
    expect((await w.hook('tr_first')).status).toBe(200);
    expect(w.mollie.subscriptions.size).toBe(1);
    expect(w.mollie.created()).toEqual(['abonnement-tr_first', 'abonnement-tr_first']);
    expect(w.db.license(ADMIN)).toMatchObject({ months: 2, subscription_id: 'sub_1', subscription_claim: null });
  });

  it('storing bij Mollie of in de database: 500 (Mollie probeert opnieuw) en daarna klopt het', async () => {
    const w = worker({ tr_first: first('tr_first'), tr_nov: recurring('tr_nov', 'sub_1', '2026-11-15T06:00:00+00:00') });
    w.mollie.failNext(/^POST \/customers\/cst_1\/subscriptions$/);
    expect((await w.hook('tr_first')).status).toBe(500);
    expect(w.db.license(ADMIN)).toMatchObject({ months: 1, subscription_id: null });
    expect((await w.hook('tr_first')).status).toBe(200);
    expect(w.db.license(ADMIN)).toMatchObject({ months: 1, subscription_id: 'sub_1' });
    // de database valt uit tijdens de incasso: niets half, en de herhaling telt de maand één keer
    w.db.failNext(/INSERT OR IGNORE INTO payments/);
    expect((await w.hook('tr_nov')).status).toBe(500);
    expect(w.db.license(ADMIN)!.months).toBe(1);
    expect((await w.hook('tr_nov')).status).toBe(200);
    expect(w.db.license(ADMIN)!.months).toBe(2);
  });

  it('opnieuw afrekenen terwijl het abonnement loopt: geen nieuwe betaling; na opzeggen en verlopen: nieuwe periode', async () => {
    const w = worker({ tr_first: first('tr_first'), tr_later: first('tr_later', '2027-01-10T09:00:00+00:00') });
    await w.hook('tr_first');
    const again = await w.call('GET', `/start?administratie=${ADMIN}&email=piet@example.nl`);
    expect(again.status).toBe(200);
    expect(await again.text()).toMatch(/al een abonnement/);
    expect(w.mollie.calls.filter((c) => c.path === '/payments')).toHaveLength(0);

    // opgezegd; de licentie is intussen verlopen
    w.mollie.subscriptions.get('sub_1')!.status = 'canceled';
    expect((await w.call('GET', `/start?administratie=${ADMIN}&email=piet@example.nl`)).status).toBe(303);
    w.setToday('2027-01-10');
    await w.hook('tr_later');
    expect(w.db.license(ADMIN)).toMatchObject({ months: 1, period_start: '2027-01-10', subscription_id: 'sub_2' });
    expect(w.mollie.calls.filter((c) => c.method === 'POST' && c.path === '/customers/cst_1/subscriptions').pop()!.body).toMatchObject({ startDate: '2027-02-10' });
  });

  it('een incasso van een onbekend abonnement wordt genegeerd; een van ons zonder licentie geeft 500', async () => {
    const w = worker({ tr_x: recurring('tr_x', 'sub_9', '2026-11-15T06:00:00+00:00') });
    expect(await (await w.hook('tr_x')).json()).toMatchObject({ genegeerd: 'tr_x' });
    w.mollie.subscriptions.set('sub_9', { id: 'sub_9', status: 'active', metadata: { administratie: ADMIN } });
    expect((await w.hook('tr_x')).status).toBe(500);
  });

  it('prijs komt uit de instellingen van de Worker; onbekende routes 404', async () => {
    const w = worker();
    expect(await (await w.call('GET', '/prijs')).json()).toEqual({ bedrag: '9.99', valuta: 'EUR', per: 'maand' });
    expect((await w.call('GET', '/iets')).status).toBe(404);
    expect((await w.call('GET', '/bedankt')).headers.get('content-type')).toMatch(/text\/html/);
  });

  it('maanden optellen vanaf het begin, ook aan het eind van de maand', () => {
    expect(addMonth('2026-01-31')).toBe('2026-02-28');
    expect(addMonth('2028-01-31')).toBe('2028-02-29');
    expect(addMonth('2026-12-15')).toBe('2027-01-15');
    // vanaf 31 januari: februari afgekapt, maar maart weer de 31e (niet de 28e)
    expect(addMonths('2026-01-31', 2)).toBe('2026-03-31');
    expect(addMonths('2026-01-31', 13)).toBe('2027-02-28');
  });
});

describe('licentie in de app', () => {
  const token = (privateJwk: string, administratie: string, validUntil: string) =>
    signLicense({ v: 1, product: 'uitwisseling', administratie, email: 'piet@example.nl', validUntil, issuedAt: TODAY }, privateJwk);

  it('zonder sleutel staan licenties uit: alles mag', () => {
    const { s } = setup();
    expect(s.license.status(TODAY)).toEqual({ state: 'uit' });
    expect(() => s.license.requireActive(TODAY)).not.toThrow();
  });

  it('geen, actief, verlopen, andere administratie, vervalst', async () => {
    const k = keys();
    const { s } = setup();
    const license = new LicenseService(s.db, s.settings, k.publicKey);
    const id = s.settings.administrationId();
    expect(license.status(TODAY)).toEqual({ state: 'geen' });
    expect(() => license.requireActive(TODAY)).toThrow(/hoort bij het abonnement/);

    expect(license.install(await token(k.privateJwk, id, '2026-11-22'), TODAY)).toEqual({ state: 'actief', validUntil: '2026-11-22', email: 'piet@example.nl' });
    expect(() => license.requireActive(TODAY)).not.toThrow();
    expect(license.needsRefresh(TODAY)).toBe(false);
    expect(license.needsRefresh('2026-11-16')).toBe(true);
    expect(license.status('2026-11-23')).toMatchObject({ state: 'verlopen' });
    expect(() => license.requireActive('2026-11-23')).toThrow(/liep tot 22 november 2026/);

    await expect(async () => license.install(await token(k.privateJwk, '00000000-0000-4000-8000-000000000000', '2027-01-01'), TODAY)).rejects.toThrow(/andere administratie/);
    await expect(async () => license.install(await token(keys().privateJwk, id, '2099-01-01'), TODAY)).rejects.toThrow(/handtekening/);
    const good = await token(k.privateJwk, id, '2026-11-22');
    const [body, sig] = good.split('.');
    const forged = `${Buffer.from(Buffer.from(body!, 'base64url').toString().replace('2026-11-22', '2099-12-31')).toString('base64url')}.${sig}`;
    expect(() => license.install(forged, TODAY)).toThrow(/handtekening/);
  });

  it('versturen haalt eerst de licentie op; zonder abonnement geweigerd; inlezen kan altijd', async () => {
    const k = keys();
    const { s } = setup({ licensePublicKey: k.publicKey });
    let served: string | null = null;
    const opened: string[] = [];
    const api = createApi(s, {
      appVersion: () => '1.0.0',
      saveFile: async (name: string) => `/tmp/${name}`,
      openExternal: async (url: string) => void opened.push(url),
      licenseApi: { price: async () => ({ bedrag: '9.99', valuta: 'EUR', per: 'maand' }), fetch: async () => served },
      exchange: { bundle: async () => Buffer.from('bundel'), office: () => null, saveOffice: () => { throw new Error('x'); }, openClientExport: async () => { throw new Error('x'); } },
    } as unknown as HostContext);
    const { generateOfficeKeys } = await import('../src/exchange/crypto');
    const { ExchangeService } = await import('../src/exchange/exchange');
    s.exchange.link(ExchangeService.invite({ office: 'Kantoor', email: 'k@example.nl', ...generateOfficeKeys() }));

    await expect(api.exchange.send('2026-06-30', [], 'bestand')).rejects.toThrow(/hoort bij het abonnement/);
    expect(s.periods.status().exchange).toBeNull();

    await api.license.checkout('piet@example.nl');
    expect(opened[0]).toBe(`https://licentie.boekhoudenvoorniks.nl/start?administratie=${s.settings.administrationId()}&email=piet%40example.nl`);
    await expect(api.license.refresh()).rejects.toThrow(/Nog geen betaald abonnement/);

    // betaald: bij versturen wordt de licentie vanzelf opgehaald
    served = await token(k.privateJwk, s.settings.administrationId(), '2099-01-31');
    expect(await api.exchange.send('2026-06-30', [], 'bestand')).toMatchObject({ exchange: expect.any(Number) });
    expect(s.license.status(TODAY)).toMatchObject({ state: 'actief' });
    expect(await api.license.price()).toEqual({ bedrag: '9.99', valuta: 'EUR', per: 'maand' });
  });
});
