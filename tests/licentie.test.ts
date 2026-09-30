import Database from 'better-sqlite3';
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addMonth, addMonths, authorizeAssistant, handle, inclVat, type Env, type LicenseDb, type LicenseStatement } from '../workers/licentie/src/app';
import { signLicense } from '../workers/licentie/src/token';
import { LICENSE_PUBLIC_KEY, LicenseService, verifyLicense } from '../src/license/license';
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
  // alle migraties op volgorde, zoals `wrangler d1 migrations apply`
  const dir = join(__dirname, '../workers/licentie/migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(readFileSync(join(dir, f), 'utf8'));
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
  const calls: { method: string; path: string; query: string; body: Record<string, unknown> | null; auth: string | null; key: string | null }[] = [];
  const subscriptions = new Map<string, { id: string; status: string; metadata: unknown }>();
  const byKey = new Map<string, string>();
  const invoiceByKey = new Map<string, string>();
  const customerByKey = new Map<string, string>();
  const paymentByKey = new Map<string, string>();
  const bodyByKey = new Map<string, string>();
  const paymentStatus = new Map<string, string>();
  const failures: RegExp[] = [];
  const conflicts: RegExp[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace('/v2', '');
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method, path, query: url.search, body, auth: headers.get('authorization'), key: headers.get('idempotency-key') });
    // een tik wachten, zodat gelijktijdige webhooks echt door elkaar lopen
    await new Promise((r) => setTimeout(r, 1));
    const i = failures.findIndex((r) => r.test(`${method} ${path}`));
    if (i >= 0) {
      failures.splice(i, 1);
      return new Response('{"detail":"storing"}', { status: 503 });
    }
    const conflict = conflicts.findIndex((r) => r.test(`${method} ${path}`));
    if (conflict >= 0) {
      conflicts.splice(conflict, 1);
      return new Response('{"detail":"nog bezig"}', { status: 409 });
    }
    const reply = (x: object) => new Response(JSON.stringify(x), { status: 200 });
    // zoals Mollie: dezelfde sleutel met andere inhoud is een 400
    const sameKeyOtherBody = (key: string) => {
      const seen = bodyByKey.get(key);
      if (seen !== undefined && seen !== JSON.stringify(body)) return true;
      bodyByKey.set(key, JSON.stringify(body));
      return false;
    };
    if (method === 'POST' && path === '/customers') {
      const key = headers.get('idempotency-key') ?? `geen-${calls.length}`;
      if (sameKeyOtherBody(key)) return new Response('{"detail":"andere inhoud bij dezelfde sleutel"}', { status: 400 });
      if (!customerByKey.has(key)) customerByKey.set(key, `cst_${customerByKey.size + 1}`);
      return reply({ id: customerByKey.get(key)! });
    }
    if (method === 'POST' && path === '/payments') {
      const key = headers.get('idempotency-key') ?? `geen-${calls.length}`;
      if (sameKeyOtherBody(key)) return new Response('{"detail":"andere inhoud bij dezelfde sleutel"}', { status: 400 });
      if (!paymentByKey.has(key)) paymentByKey.set(key, `tr_start_${paymentByKey.size + 1}`);
      const id = paymentByKey.get(key)!;
      const status = paymentStatus.get(id) ?? 'open';
      return reply({ id, status, ...(status === 'open' ? { _links: { checkout: { href: `https://www.mollie.com/checkout/${id}` } } } : {}) });
    }
    if (method === 'POST' && path === '/sales-invoices') {
      const key = headers.get('idempotency-key') ?? `geen-${calls.length}`;
      let id = invoiceByKey.get(key);
      if (!id) {
        id = `invoice_${invoiceByKey.size + 1}`;
        invoiceByKey.set(key, id);
      }
      return reply({ id, status: 'paid' });
    }
    const del = /^\/customers\/cst_1\/subscriptions\/(sub_\w+)$/.exec(path);
    if (method === 'DELETE' && del && subscriptions.has(del[1]!)) {
      subscriptions.get(del[1]!)!.status = 'canceled';
      return reply(subscriptions.get(del[1]!)!);
    }
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
  const invoices = () => calls.filter((c) => c.method === 'POST' && c.path === '/sales-invoices');
  return { calls, subscriptions, created, invoices, customerIds: () => new Set(customerByKey.values()), paymentIds: () => new Set(paymentByKey.values()), expirePayment: (id: string) => void paymentStatus.set(id, 'expired'), invoiceIds: () => new Set(invoiceByKey.values()), fetchImpl, failNext: (r: RegExp) => void failures.push(r), conflictNext: (r: RegExp) => void conflicts.push(r) };
}

function worker(payments: Record<string, object> = {}, extra: Partial<Env> = {}) {
  const k = keys();
  const db = fakeD1();
  const env: Env = { LICENTIES: db.d1, MOLLIE_API_KEY: 'test_abc', LICENSE_PRIVATE_KEY: k.privateJwk, PUBLIC_URL: 'https://licentie.example', PRICE_EXCL_VAT: '9.00', ...extra };
  const mollie = fakeMollie(payments);
  let today = TODAY;
  let nowMs = Date.parse(`${TODAY}T10:00:00Z`);
  const call = (method: string, path: string, body?: string, managementKey?: string) =>
    handle(new Request(`https://licentie.example${path}`, { method, body, headers: { ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...(managementKey ? { authorization: `Bearer ${managementKey}` } : {}) } }), env, { fetch: mollie.fetchImpl, today: () => today, now: () => nowMs });
  const hook = (id: string) => call('POST', '/mollie', `id=${id}`);
  const post = (path: string, body: unknown, managementKey?: string) =>
    handle(new Request(`https://licentie.example${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...(managementKey ? { authorization: `Bearer ${managementKey}` } : {}) } }), env, { fetch: mollie.fetchImpl, today: () => today, now: () => nowMs });
  const start = (body: Record<string, unknown> = {}) => post('/start', { administratie: ADMIN, email: 'piet@example.nl', bedrijf: BILLING, managementKey: MANAGEMENT_KEY, ...body });
  const license = (managementKey = MANAGEMENT_KEY) => call('GET', `/licentie?administratie=${ADMIN}`, undefined, managementKey);
  const cancel = (managementKey = MANAGEMENT_KEY) => post('/opzeggen', { administratie: ADMIN }, managementKey);
  return { ...k, db, env, mollie, call, hook, post, start, license, cancel, setToday: (d: string) => void (today = d), later: (minutes: number) => void (nowMs += minutes * 60_000) };
}

const ADMIN = '2c5bf9f4-1bd5-4fc9-a3b4-da8784765123';
const MANAGEMENT_KEY = 'A'.repeat(43);
const MANAGEMENT_KEY_HASH = createHash('sha256').update(MANAGEMENT_KEY).digest('hex');
const BILLING = { naam: 'Stukadoorsbedrijf Piet', adres: 'Kalkweg 1', postcode: '1234 AB', plaats: 'Utrecht', land: 'NL', kvk: '12345678', btw: 'NL123456789B01' };
const EUR = { currency: 'EUR', value: '10.89' };
const first = (id: string, paidAt = '2026-10-15T10:00:00+00:00') => ({ id, status: 'paid', amount: EUR, sequenceType: 'first', customerId: 'cst_1', paidAt, metadata: { administratie: ADMIN, email: 'piet@example.nl', billing: BILLING, managementKeyHash: MANAGEMENT_KEY_HASH } });
const recurring = (id: string, subscriptionId: string, paidAt: string) => ({ id, status: 'paid', amount: EUR, sequenceType: 'recurring', customerId: 'cst_1', subscriptionId, paidAt });

describe('licentie-Worker', () => {
  it('afrekenen: klant en eerste betaling bij Mollie, door naar de betaalpagina', async () => {
    const w = worker();
    const res = await w.start();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ checkout: 'https://www.mollie.com/checkout/tr_start_1', proefMaanden: 0 });
    const payment = w.mollie.calls.find((c) => c.path === '/payments')!;
    expect(payment.auth).toBe('Bearer test_abc');
    expect(payment.body).toMatchObject({ amount: { currency: 'EUR', value: '10.89' }, customerId: 'cst_1', sequenceType: 'first', webhookUrl: 'https://licentie.example/mollie', metadata: { administratie: ADMIN, billing: BILLING } });
    expect(payment.key).toMatch(new RegExp(`^start-${ADMIN}-0-[0-9a-f]{16}-\\d+$`));
    expect(w.mollie.calls.find((c) => c.path === '/customers')!.body).toMatchObject({ name: 'Stukadoorsbedrijf Piet', email: 'piet@example.nl' });
    expect(w.mollie.calls.find((c) => c.path === '/customers')!.key).toMatch(new RegExp(`^klant-${ADMIN}-[0-9a-f]{16}-\\d+$`));
    expect((await w.start({ administratie: 'iets' })).status).toBe(400);
    expect((await w.start({ email: 'geen-mail' })).status).toBe(400);
    // de factuur vraagt een adres en een KvK- of btw-nummer
    const incomplete = await w.start({ bedrijf: { ...BILLING, adres: '', kvk: '', btw: '' } });
    expect(incomplete.status).toBe(400);
    expect(((await incomplete.json()) as { fout: string }).fout).toBe('Voor de factuur ontbreekt: adres, KvK- of btw-nummer');
    expect((await w.post('/start', 'geen object')).status).toBe(400);
    const land = await w.start({ bedrijf: { ...BILLING, land: 'Nederland' } });
    expect(land.status).toBe(400);
    expect(((await land.json()) as { fout: string }).fout).toMatch(/landcode van twee letters/);
  });

  it('gelijktijdig starten geeft door Mollie-idempotentie één klant en één betaalpoging', async () => {
    const w = worker();
    const responses = await Promise.all([w.start(), w.start(), w.start()]);
    expect(await Promise.all(responses.map((r) => r.json()))).toEqual([
      { checkout: 'https://www.mollie.com/checkout/tr_start_1', proefMaanden: 0 },
      { checkout: 'https://www.mollie.com/checkout/tr_start_1', proefMaanden: 0 },
      { checkout: 'https://www.mollie.com/checkout/tr_start_1', proefMaanden: 0 },
    ]);
    expect(w.mollie.customerIds().size).toBe(1);
    expect(w.mollie.paymentIds().size).toBe(1);
  });

  it('afgebroken en opnieuw afsluiten, of andere gegevens: een nieuwe betaalpagina, geen 400 of 500', async () => {
    const w = worker();
    expect(await (await w.start()).json()).toEqual({ checkout: 'https://www.mollie.com/checkout/tr_start_1', proefMaanden: 0 });
    // de klant breekt af; de betaling verloopt. Binnen hetzelfde kwartier opnieuw: een nieuwe betaling
    w.mollie.expirePayment('tr_start_1');
    expect(await (await w.start()).json()).toEqual({ checkout: 'https://www.mollie.com/checkout/tr_start_2', proefMaanden: 0 });
    // ander e-mailadres binnen hetzelfde kwartier: andere sleutels, dus geen 400 van Mollie
    const other = await w.start({ email: 'kantoor@example.nl' });
    expect(other.status).toBe(200);
    expect(((await other.json()) as { checkout: string }).checkout).toMatch(/^https:\/\/www\.mollie\.com\/checkout\/tr_start_\d+$/);
    // en een half uur later een nieuwe poging: een nieuwe betaling, ook als de oude nog open staat
    w.later(30);
    const later = (await (await w.start()).json()) as { checkout: string };
    expect(later.checkout).not.toBe('https://www.mollie.com/checkout/tr_start_2');
  });

  it('een tijdelijke Mollie-conflict op dezelfde betaalpoging wordt veilig herhaald', async () => {
    const w = worker();
    w.mollie.conflictNext(/^POST \/payments$/);
    expect(await (await w.start()).json()).toEqual({ checkout: 'https://www.mollie.com/checkout/tr_start_1', proefMaanden: 0 });
    const calls = w.mollie.calls.filter((c) => c.method === 'POST' && c.path === '/payments');
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((c) => c.key)).size).toBe(1);
  });

  it('eerste betaling: abonnement vanaf volgende maand met Idempotency-Key, licentie t/m die maand plus marge', async () => {
    const w = worker({ tr_first: first('tr_first') });
    expect((await w.license()).status).toBe(404);
    expect((await w.hook('tr_first')).status).toBe(200);
    const sub = w.mollie.calls.find((c) => c.method === 'POST' && c.path === '/customers/cst_1/subscriptions')!;
    expect(sub.body).toMatchObject({ amount: { value: '10.89' }, interval: '1 month', startDate: '2026-11-15', webhookUrl: 'https://licentie.example/mollie', metadata: { administratie: ADMIN } });
    expect(sub.key).toBe('abonnement-tr_first');
    // dezelfde melding nog eens: niets verandert
    await w.hook('tr_first');
    expect(w.mollie.created()).toHaveLength(1);
    expect(w.db.license(ADMIN)).toMatchObject({ months: 1, subscription_id: 'sub_1', subscription_claim: null });

    const { token, validUntil } = (await (await w.license()).json()) as { token: string; validUntil: string };
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
    expect(((await (await w.license()).json()) as { validUntil: string }).validUntil).toBe('2027-01-22');
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
    const again = await w.start();
    expect(await again.json()).toEqual({ al: true });
    expect(w.mollie.calls.filter((c) => c.path === '/payments')).toHaveLength(0);

    // opgezegd; de licentie is intussen verlopen
    w.mollie.subscriptions.get('sub_1')!.status = 'canceled';
    expect(await (await w.start()).json()).toEqual({ checkout: 'https://www.mollie.com/checkout/tr_start_1', proefMaanden: 0 });
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

  it('met een API-sleutel: geen profileId of testmode (Mollie weigert die dan)', async () => {
    const w = worker({ tr_first: first('tr_first') });
    await w.start();
    await w.hook('tr_first');
    for (const c of w.mollie.calls) {
      expect(c.query).toBe('');
      expect(c.body ?? {}).not.toHaveProperty('profileId');
      expect(c.body ?? {}).not.toHaveProperty('testmode');
    }
  });

  it('met een organisatie-toegangstoken: testmode overal, profileId bij betaling en abonnement', async () => {
    const w = worker({ tr_first: first('tr_first') }, { MOLLIE_API_KEY: 'access_abc', MOLLIE_PROFILE_ID: 'pfl_test', MOLLIE_TESTMODE: 'true' });
    await w.start();
    await w.hook('tr_first');
    await w.start(); // haalt het abonnement op
    const post = (path: string) => w.mollie.calls.find((c) => c.method === 'POST' && c.path === path)!.body;
    expect(post('/customers')).toMatchObject({ testmode: true });
    expect(post('/customers')).not.toHaveProperty('profileId');
    expect(post('/payments')).toMatchObject({ profileId: 'pfl_test', testmode: true });
    expect(post('/customers/cst_1/subscriptions')).toMatchObject({ profileId: 'pfl_test', testmode: true });
    const gets = w.mollie.calls.filter((c) => c.method === 'GET');
    expect(gets.map((c) => c.path)).toEqual(expect.arrayContaining(['/payments/tr_first', '/customers/cst_1/subscriptions/sub_1']));
    for (const c of gets) expect(c.query).toBe('?testmode=true');
    expect(w.mollie.calls[0]!.auth).toBe('Bearer access_abc');
  });

  it('factuur bij elke betaling: betaald, op naam van het bedrijf, over het afgeschreven bedrag, één per betaling', async () => {
    const w = worker(
      { tr_first: first('tr_first'), tr_nov: recurring('tr_nov', 'sub_1', '2026-11-15T06:00:00+00:00') },
      { INVOICES: 'true', MOLLIE_API_KEY: 'access_abc', MOLLIE_PROFILE_ID: 'pfl_test', MOLLIE_TESTMODE: 'true' },
    );
    await Promise.all([w.hook('tr_first'), w.hook('tr_first')]);
    await w.hook('tr_first');
    await Promise.all([w.hook('tr_nov'), w.hook('tr_nov')]);
    // één factuur per betaling, ook bij dubbele en gelijktijdige meldingen
    expect(w.mollie.invoiceIds().size).toBe(2);
    expect(new Set(w.mollie.invoices().map((c) => c.key))).toEqual(new Set(['factuur-tr_first', 'factuur-tr_nov']));
    const body = w.mollie.invoices()[0]!.body!;
    expect(body).toMatchObject({
      status: 'paid',
      recipientIdentifier: `administratie:${ADMIN}`,
      recipient: { type: 'business', organizationName: 'Stukadoorsbedrijf Piet', organizationNumber: '12345678', vatNumber: 'NL123456789B01', email: 'piet@example.nl', streetAndNumber: 'Kalkweg 1', postalCode: '1234 AB', city: 'Utrecht', country: 'NL', locale: 'nl_NL' },
      lines: [{ quantity: 1, unitPrice: { currency: 'EUR', value: '10.89' }, vatRate: '21.00' }],
      vatScheme: 'standard',
      vatMode: 'inclusive',
      paymentDetails: { source: 'payment', sourceReference: 'tr_first' },
      profileId: 'pfl_test',
      testmode: true,
    });
    expect((body.lines as { description: string }[])[0]!.description).toMatch(/uitwisseling met je boekhouder \(oktober 2026\)/);
    const recurringInvoice = w.mollie.invoices().find((c) => (c.body?.paymentDetails as { sourceReference?: string })?.sourceReference === 'tr_nov')!;
    expect((recurringInvoice.body!.lines as { description: string }[])[0]!.description).toMatch(/\(november 2026\)/);
    expect(body.emailDetails).toMatchObject({ subject: expect.stringMatching(/factuur/) });
  });

  it('storing bij het maken van de factuur: 500, en de herhaling maakt hem één keer, zonder extra maand', async () => {
    const w = worker({ tr_first: first('tr_first') }, { INVOICES: 'true' });
    w.mollie.failNext(/^POST \/sales-invoices$/);
    expect((await w.hook('tr_first')).status).toBe(500);
    expect(w.db.license(ADMIN)).toMatchObject({ months: 1, subscription_id: 'sub_1' });
    // de factuur is gemaakt, maar het vastleggen mislukt: de herhaling krijgt dezelfde factuur terug
    w.db.failNext(/UPDATE payments SET invoice_id/);
    expect((await w.hook('tr_first')).status).toBe(500);
    expect((await w.hook('tr_first')).status).toBe(200);
    expect(w.mollie.invoiceIds().size).toBe(1);
    expect(w.db.license(ADMIN)!.months).toBe(1);
    expect(w.mollie.created()).toHaveLength(1);
  });

  it('facturen staan uit tot INVOICES aan staat', async () => {
    const w = worker({ tr_first: first('tr_first') });
    await w.hook('tr_first');
    expect(w.mollie.invoices()).toHaveLength(0);
  });

  it('een oude betaling zonder factuurgegevens wordt niet stil als verwerkt bevestigd', async () => {
    const old = { ...first('tr_old'), metadata: { administratie: ADMIN, email: 'piet@example.nl', managementKeyHash: MANAGEMENT_KEY_HASH } };
    const w = worker({ tr_old: old }, { INVOICES: 'true' });
    expect((await w.hook('tr_old')).status).toBe(500);
    expect(w.mollie.invoices()).toHaveLength(0);
    // Na operationeel herstel kan Mollie dezelfde webhook opnieuw aanbieden; hij is niet als factuur-klaar gemarkeerd.
    expect((await w.hook('tr_old')).status).toBe(500);
  });

  it('opzeggen: abonnement gestopt bij Mollie, licentie loopt af met "opgezegd"; opnieuw afsluiten mag', async () => {
    const w = worker({ tr_first: first('tr_first'), tr_again: first('tr_again', '2026-10-20T10:00:00+00:00') });
    expect((await w.cancel()).status).toBe(404);
    await w.hook('tr_first');
    expect((await w.call('GET', `/licentie?administratie=${ADMIN}`)).status).toBe(403);
    expect((await w.cancel('B'.repeat(43))).status).toBe(403);
    const res = await w.cancel();
    expect(await res.json()).toEqual({ ok: true, betaaldTot: '2026-11-15', geldigTot: '2026-11-22' });
    expect(w.mollie.calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual(['/customers/cst_1/subscriptions/sub_1']);
    expect(w.mollie.subscriptions.get('sub_1')!.status).toBe('canceled');
    // nog een keer: geen tweede DELETE, geen fout
    expect((await w.cancel()).status).toBe(200);
    expect(w.mollie.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
    const { token } = (await (await w.license()).json()) as { token: string };
    expect(verifyLicense(token, w.publicKey)).toMatchObject({ cancelled: true, validUntil: '2026-11-22' });
    // opnieuw afsluiten vóór het verloopt: een maand erbij, nieuw abonnement, niet meer opgezegd
    expect(await (await w.start()).json()).toEqual({ checkout: 'https://www.mollie.com/checkout/tr_start_1', proefMaanden: 0 });
    await w.hook('tr_again');
    expect(w.db.license(ADMIN)).toMatchObject({ months: 2, period_start: '2026-10-15', subscription_id: 'sub_2' });
    const again = verifyLicense(((await (await w.license()).json()) as { token: string }).token, w.publicKey);
    expect(again.cancelled).toBeUndefined();
    expect(again.validUntil).toBe('2026-12-22');
  });

  it('prijs komt uit de instellingen van de Worker; onbekende routes 404', async () => {
    const w = worker({}, { TRIAL_MONTHS: '4' });
    expect(await (await w.call('GET', '/prijs')).json()).toEqual({ bedrag: '9.00', inclusiefBtw: '10.89', valuta: 'EUR', per: 'maand', btw: 'exclusief', proefMaanden: 4 });
    expect(await (await worker().call('GET', '/prijs')).json()).toMatchObject({ proefMaanden: 0 });
    expect((await w.call('GET', '/iets')).status).toBe(404);
    expect((await w.call('GET', '/bedankt')).headers.get('content-type')).toMatch(/text\/html/);
  });

  it('btw erbij in hele centen', () => {
    expect(inclVat('9.00')).toBe('10.89');
    expect(inclVat('9')).toBe('10.89');
    expect(inclVat('7.50')).toBe('9.08');
    expect(inclVat('0.05')).toBe('0.06');
    expect(() => inclVat('niks')).toThrow(/Ongeldige prijs/);
  });

  it('proefperiode: € 0,01 voor de machtiging, 4 maanden licentie, abonnement daarna, geen factuur voor de cent', async () => {
    const trialPayment = (id: string, paidAt = '2026-10-15T10:00:00+00:00') => ({ ...first(id, paidAt), amount: { currency: 'EUR', value: '0.01' }, metadata: { ...first(id).metadata, proefMaanden: 4 } });
    const w = worker(
      { tr_proef: trialPayment('tr_proef'), tr_proef2: trialPayment('tr_proef2', '2026-10-15T10:01:00+00:00'), tr_feb: recurring('tr_feb', 'sub_1', '2027-02-15T06:00:00+00:00') },
      { TRIAL_MONTHS: '4', INVOICES: 'true' },
    );
    expect(await (await w.start()).json()).toEqual({ checkout: 'https://www.mollie.com/checkout/tr_start_1', proefMaanden: 4 });
    const payment = w.mollie.calls.find((c) => c.path === '/payments')!;
    expect(payment.body).toMatchObject({ amount: { currency: 'EUR', value: '0.01' }, sequenceType: 'first', metadata: { proefMaanden: 4 } });
    expect(payment.body!.description).toMatch(/4 maanden gratis, daarna € 10,89 per maand/);

    // twee proefbetalingen (twee keer geklikt, beide betaald): één keer 4 maanden, één abonnement
    await Promise.all([w.hook('tr_proef'), w.hook('tr_proef2')]);
    await w.hook('tr_proef');
    expect(w.db.license(ADMIN)).toMatchObject({ months: 4, period_start: '2026-10-15', subscription_id: 'sub_1' });
    expect(w.mollie.subscriptions.size).toBe(1);
    const sub = w.mollie.calls.find((c) => c.method === 'POST' && c.path === '/customers/cst_1/subscriptions')!;
    expect(sub.body).toMatchObject({ amount: { value: '10.89' }, interval: '1 month', startDate: '2027-02-15' });
    expect(((await (await w.license()).json()) as { validUntil: string }).validUntil).toBe('2027-02-22');
    expect(w.mollie.invoices()).toHaveLength(0);

    // de eerste incasso na de proefperiode: een maand erbij en een factuur van € 10,89 inclusief btw
    await w.hook('tr_feb');
    expect(w.db.license(ADMIN)!.months).toBe(5);
    expect(w.mollie.invoices()).toHaveLength(1);
    expect(w.mollie.invoices()[0]!.body).toMatchObject({ lines: [{ unitPrice: { value: '10.89' }, vatRate: '21.00' }], vatMode: 'inclusive' });
  });

  it('proefperiode alleen bij een eerste abonnement: niet opnieuw voor dezelfde administratie of hetzelfde e-mailadres', async () => {
    const w = worker({ tr_first: first('tr_first') }, { TRIAL_MONTHS: '4' });
    await w.hook('tr_first');
    w.mollie.subscriptions.get('sub_1')!.status = 'canceled';
    // dezelfde administratie opnieuw: een betaalde eerste maand
    expect(await (await w.start()).json()).toMatchObject({ proefMaanden: 0 });
    expect(w.mollie.calls.filter((c) => c.path === '/payments').pop()!.body).toMatchObject({ amount: { value: '10.89' } });
    // een nieuwe administratie met hetzelfde e-mailadres (andere hoofdletters): ook geen proef
    const other = await w.start({ administratie: '3d6c0a05-2ce6-4ad0-b4c5-eb9895876234', email: 'Piet@Example.nl' });
    expect(await other.json()).toMatchObject({ proefMaanden: 0 });
    // een ander e-mailadres en een nieuwe administratie: wel
    const fresh = await w.start({ administratie: '4e7d1b16-3df7-4be1-85d6-fc0906987345', email: 'nieuw@example.nl' });
    expect(await fresh.json()).toMatchObject({ proefMaanden: 4 });
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

describe('licentie-Worker: toegang tot de online hulp (workers/assistent, #132)', () => {
  const ADMIN = '11111111-2222-4333-8444-555555555555';
  const KEY = 'k'.repeat(43);
  const hash = (v: string) => createHash('sha256').update(v).digest('hex');
  const withLicense = async (row: { period_start: string; months: number; cancelled?: boolean; key?: string | null }) => {
    const f = fakeD1();
    await f.d1
      .prepare('INSERT INTO licenses (administratie, email, customer_id, period_start, months, cancelled_at, management_key_hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(ADMIN, 'piet@example.nl', 'cst_1', row.period_start, row.months, row.cancelled ? '2026-10-01' : null, row.key === null ? null : hash(row.key ?? KEY))
      .run();
    return f;
  };
  const ask = (d1: LicenseDb, over: Partial<{ administratie: string; managementKey: string; today: string; dailyLimit: number }> = {}) =>
    authorizeAssistant({ LICENTIES: d1 }, { administratie: ADMIN, managementKey: KEY, today: TODAY, dailyLimit: 3, ...over });

  it('alleen met de juiste beheersleutel en een abonnement dat betaald is t/m vandaag (plus marge)', async () => {
    const { d1 } = await withLicense({ period_start: '2026-10-01', months: 1 });
    expect(await ask(d1)).toEqual({ ok: true });
    expect(await ask(d1, { managementKey: 'x'.repeat(43) })).toEqual({ ok: false, reason: 'sleutel' });
    expect(await ask(d1, { managementKey: 'kort' })).toEqual({ ok: false, reason: 'sleutel' });
    expect(await ask(d1, { administratie: '99999999-2222-4333-8444-555555555555' })).toEqual({ ok: false, reason: 'sleutel' });
    // betaald t/m 1 november, plus 7 dagen marge
    expect(await ask(d1, { today: '2026-11-08' })).toEqual({ ok: true });
    expect(await ask(d1, { today: '2026-11-09' })).toEqual({ ok: false, reason: 'geen-abonnement' });
    // opgezegd maar nog betaald: mag tot het eind
    const cancelled = await withLicense({ period_start: '2026-10-01', months: 1, cancelled: true });
    expect(await ask(cancelled.d1)).toEqual({ ok: true });
    // nog niet betaald, of zonder beheersleutel: nee
    expect(await ask((await withLicense({ period_start: '2026-10-01', months: 0 })).d1)).toEqual({ ok: false, reason: 'geen-abonnement' });
    expect(await ask((await withLicense({ period_start: '2026-10-01', months: 1, key: null })).d1)).toEqual({ ok: false, reason: 'sleutel' });
  });

  it('dagquotum per administratie, ook bij gelijktijdige aanroepen; geweigerde aanroepen tellen niet', async () => {
    const f = await withLicense({ period_start: '2026-10-01', months: 1 });
    await ask(f.d1, { managementKey: 'x'.repeat(43) });
    const results = await Promise.all(Array.from({ length: 5 }, () => ask(f.d1)));
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'quotum' }, { ok: false, reason: 'quotum' }]);
    // de volgende dag weer ruimte; quotum 0 = uit
    expect(await ask(f.d1, { today: '2026-10-16' })).toEqual({ ok: true });
    expect(await ask(f.d1, { today: '2026-10-17', dailyLimit: 0 })).toEqual({ ok: false, reason: 'quotum' });
  });
});

describe('licentie in de app', () => {
  const token = (privateJwk: string, administratie: string, validUntil: string, cancelled = false) =>
    signLicense({ v: 1, product: 'uitwisseling', administratie, email: 'piet@example.nl', validUntil, issuedAt: TODAY, ...(cancelled ? { cancelled: true } : {}) }, privateJwk);

  it('de sleutel in de app is een geldige Ed25519-sleutel (die van de live licentie-Worker)', () => {
    // Op 30 september 2026 is een echte licentie van de live Worker met deze sleutel gecontroleerd. Die
    // licentie zelf staat bewust niet in de repo: hij is geldig. Hier: vorm en bruikbaarheid van de sleutel.
    expect(LICENSE_PUBLIC_KEY).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(LICENSE_PUBLIC_KEY, 'base64url')).toHaveLength(32);
    expect(() => createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: LICENSE_PUBLIC_KEY }, format: 'jwk' })).not.toThrow();
    expect(() => verifyLicense('e30.AAAA', LICENSE_PUBLIC_KEY)).toThrow(/handtekening/);
  });

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

    expect(license.install(await token(k.privateJwk, id, '2026-11-22'), TODAY)).toEqual({ state: 'actief', validUntil: '2026-11-22', email: 'piet@example.nl', cancelled: false });
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

  it('versturen haalt eerst de licentie op; zonder abonnement geweigerd; afsluiten met bedrijfsgegevens; opzeggen', async () => {
    const k = keys();
    const { s } = setup({ licensePublicKey: k.publicKey });
    const id = s.settings.administrationId();
    let served: string | null = null;
    const opened: string[] = [];
    const started: unknown[] = [];
    const fetched: { administratie: string; managementKey: string }[] = [];
    const cancelled: { administratie: string; managementKey: string }[] = [];
    let running = false;
    const api = createApi(s, {
      appVersion: () => '1.0.0',
      saveFile: async (name: string) => `/tmp/${name}`,
      openExternal: async (url: string) => void opened.push(url),
      hasSmtpPassword: () => false,
      licenseApi: {
        price: async () => ({ bedrag: '9.99', valuta: 'EUR', per: 'maand' }),
        fetch: async (administratie: string, managementKey: string) => {
          fetched.push({ administratie, managementKey });
          return served;
        },
        start: async (input: unknown) => {
          started.push(input);
          return running ? { al: true } : { checkout: 'https://www.mollie.com/checkout/test' };
        },
        cancel: async (administratie: string, managementKey: string) => {
          cancelled.push({ administratie, managementKey });
          served = await token(k.privateJwk, id, '2099-01-31', true);
          return { betaaldTot: '2099-01-24', geldigTot: '2099-01-31' };
        },
      },
      exchange: { bundle: async () => Buffer.from('bundel'), office: () => null, saveOffice: () => { throw new Error('x'); }, openClientExport: async () => { throw new Error('x'); } },
    } as unknown as HostContext);
    const { generateOfficeKeys } = await import('../src/exchange/crypto');
    const { ExchangeService } = await import('../src/exchange/exchange');
    s.exchange.link(ExchangeService.invite({ office: 'Kantoor', email: 'k@example.nl', ...generateOfficeKeys() }));

    await expect(api.exchange.send('2026-06-30', [], 'bestand')).rejects.toThrow(/hoort bij het abonnement/);
    expect(s.periods.status().exchange).toBeNull();

    // afsluiten: eerst de bedrijfsgegevens compleet (voor de factuur)
    s.settings.update({ company: { ...s.settings.get().company, kvkNumber: '  ', vatNumber: '' } });
    await expect(api.license.checkout('piet@example.nl')).rejects.toThrow(/ontbreekt nog: KvK- of btw-nummer/);
    expect(started).toHaveLength(0);
    s.settings.update({ company: { ...s.settings.get().company, kvkNumber: '12345678' } });
    expect(await api.license.checkout('piet@example.nl')).toEqual({ al: false });
    expect(started[0]).toEqual({ administratie: id, email: 'piet@example.nl', bedrijf: { naam: 'Stukadoorsbedrijf Piet', adres: 'Kalkweg 1', postcode: '1234 AB', plaats: 'Utrecht', land: 'NL', kvk: '12345678', btw: undefined }, managementKey: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    const managementKey = (started[0] as { managementKey: string }).managementKey;
    // de beheersleutel gaat niet mee naar het scherm
    expect(JSON.stringify(api.settings.get())).not.toContain(managementKey);
    expect(opened).toEqual(['https://www.mollie.com/checkout/test']);
    await expect(api.license.refresh()).rejects.toThrow(/Nog geen betaald abonnement/);

    // betaald: bij versturen wordt de licentie vanzelf opgehaald
    served = await token(k.privateJwk, id, '2099-01-31');
    running = true;
    expect(await api.exchange.send('2026-06-30', [], 'bestand')).toMatchObject({ exchange: expect.any(Number) });
    expect(s.license.status(TODAY)).toMatchObject({ state: 'actief', cancelled: false });
    // nog een keer afsluiten terwijl het loopt: geen betaalpagina
    expect(await api.license.checkout('piet@example.nl')).toEqual({ al: true });
    expect(opened).toHaveLength(1);

    // opzeggen: de licentie loopt af, versturen kan tot dan
    expect(await api.license.cancel()).toMatchObject({ state: 'actief', cancelled: true, validUntil: '2099-01-31' });
    expect(cancelled).toEqual([{ administratie: id, managementKey }]);
    expect(fetched).toEqual(fetched.map(() => ({ administratie: id, managementKey })));
    expect(s.license.needsRefresh(TODAY)).toBe(false);
    expect(await api.license.price()).toEqual({ bedrag: '9.99', valuta: 'EUR', per: 'maand' });
  });
});
