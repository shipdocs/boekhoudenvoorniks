import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { addMonth, handle, type Env, type LicenseStore } from '../workers/licentie/src/app';
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

/** Een nagebootste Mollie: onthoudt wat de Worker vroeg en geeft vaste antwoorden. */
function fakeMollie(payments: Record<string, object>) {
  const calls: { method: string; path: string; body: Record<string, unknown> | null; auth: string | null }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace('/v2', '');
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method: init?.method ?? 'GET', path, body, auth: new Headers(init?.headers).get('authorization') });
    const reply = (x: object) => new Response(JSON.stringify(x), { status: 200 });
    if (path === '/customers') return reply({ id: 'cst_1' });
    if (path === '/payments') return reply({ id: 'tr_first', _links: { checkout: { href: 'https://www.mollie.com/checkout/test' } } });
    if (/^\/customers\/cst_1\/subscriptions$/.test(path)) return reply({ id: 'sub_1' });
    const m = /^\/payments\/(tr_\w+)$/.exec(path);
    if (m && payments[m[1]!]) return reply(payments[m[1]!]!);
    return new Response('{"detail":"not found"}', { status: 404 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function worker(payments: Record<string, object> = {}) {
  const k = keys();
  const kv = new Map<string, string>();
  const store: LicenseStore = { get: async (key) => kv.get(key) ?? null, put: async (key, value) => void kv.set(key, value) };
  const env: Env = { LICENTIES: store, MOLLIE_API_KEY: 'test_abc', LICENSE_PRIVATE_KEY: k.privateJwk, PUBLIC_URL: 'https://licentie.example', PRICE_EUR: '9.99' };
  const mollie = fakeMollie(payments);
  const call = (method: string, path: string, body?: string) =>
    handle(new Request(`https://licentie.example${path}`, { method, body, headers: body ? { 'content-type': 'application/x-www-form-urlencoded' } : undefined }), env, { fetch: mollie.fetchImpl, today: () => TODAY });
  return { ...k, kv, env, mollie, call };
}

const ADMIN = '2c5bf9f4-1bd5-4fc9-a3b4-da8784765123';
const firstPaid = { id: 'tr_first', status: 'paid', sequenceType: 'first', customerId: 'cst_1', paidAt: '2026-10-15T10:00:00+00:00', metadata: { administratie: ADMIN, email: 'piet@example.nl' } };

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

  it('eerste betaling binnen: abonnement vanaf volgende maand, licentie t/m die maand plus marge', async () => {
    const w = worker({ tr_first: firstPaid });
    expect((await w.call('GET', `/licentie?administratie=${ADMIN}`)).status).toBe(404);
    expect((await w.call('POST', '/mollie', 'id=tr_first')).status).toBe(200);
    const sub = w.mollie.calls.find((c) => c.path === '/customers/cst_1/subscriptions')!;
    expect(sub.body).toMatchObject({ amount: { value: '9.99' }, interval: '1 month', startDate: '2026-11-15', webhookUrl: 'https://licentie.example/mollie' });
    // dezelfde melding nog eens: geen tweede abonnement
    await w.call('POST', '/mollie', 'id=tr_first');
    expect(w.mollie.calls.filter((c) => c.path === '/customers/cst_1/subscriptions')).toHaveLength(1);

    const res = await w.call('GET', `/licentie?administratie=${ADMIN}`);
    const { token, validUntil } = (await res.json()) as { token: string; validUntil: string };
    expect(validUntil).toBe('2026-11-22');
    // de app keurt de handtekening van de Worker goed
    expect(verifyLicense(token, w.publicKey)).toMatchObject({ administratie: ADMIN, email: 'piet@example.nl', validUntil: '2026-11-22', product: 'uitwisseling' });
  });

  it('maandelijkse incasso verlengt met een maand; niet-betaald of onbekend doet niets', async () => {
    const w = worker({
      tr_first: firstPaid,
      tr_nov: { id: 'tr_nov', status: 'paid', subscriptionId: 'sub_1', sequenceType: 'recurring', paidAt: '2026-11-15T06:00:00+00:00' },
      tr_open: { id: 'tr_open', status: 'open', subscriptionId: 'sub_1' },
      tr_other: { id: 'tr_other', status: 'paid', subscriptionId: 'sub_onbekend' },
    });
    await w.call('POST', '/mollie', 'id=tr_first');
    await w.call('POST', '/mollie', 'id=tr_open');
    await w.call('POST', '/mollie', 'id=tr_other');
    expect(JSON.parse(w.kv.get(`lic:${ADMIN}`)!).paidUntil).toBe('2026-11-15');
    await w.call('POST', '/mollie', 'id=tr_nov');
    await w.call('POST', '/mollie', 'id=tr_nov');
    expect(JSON.parse(w.kv.get(`lic:${ADMIN}`)!).paidUntil).toBe('2026-12-15');
    expect((await w.call('POST', '/mollie', 'id=iets; drop')).status).toBe(400);
  });

  it('prijs komt uit de instellingen van de Worker; onbekende routes 404', async () => {
    const w = worker();
    expect(await (await w.call('GET', '/prijs')).json()).toEqual({ bedrag: '9.99', valuta: 'EUR', per: 'maand' });
    expect((await w.call('GET', '/iets')).status).toBe(404);
    expect((await w.call('GET', '/bedankt')).headers.get('content-type')).toMatch(/text\/html/);
  });

  it('een maand later, ook aan het eind van de maand', () => {
    expect(addMonth('2026-01-31')).toBe('2026-02-28');
    expect(addMonth('2028-01-31')).toBe('2028-02-29');
    expect(addMonth('2026-12-15')).toBe('2027-01-15');
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
