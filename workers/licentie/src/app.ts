import { signLicense, type LicensePayload } from './token';

/**
 * Licentie-Worker van BoekhoudenVoorNiks: het enige online onderdeel. Een klant neemt via Mollie een
 * abonnement voor de uitwisseling met zijn boekhouder; de app haalt daarna een ondertekende licentie op.
 * Hier staat alleen wat nodig is om te betalen: administratie-ID, e-mailadres en de Mollie-nummers. Geen
 * boekhouding.
 *
 *   GET  /prijs                             prijs per maand (uit de instellingen van de Worker)
 *   GET  /start?administratie=…&email=…     klant en eerste betaling bij Mollie, door naar het afrekenen
 *   POST /mollie                            webhook: betaling opzoeken bij Mollie; eerste betaling → abonnement
 *   GET  /licentie?administratie=…          ondertekende licentie t/m de betaalde periode (+ marge)
 *   GET  /bedankt                           terugkeerpagina na het afrekenen
 */

/** De KV-functies die we gebruiken (binding LICENTIES). */
export interface LicenseStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export interface Env {
  LICENTIES: LicenseStore;
  /** secret: API-sleutel van Mollie (test_… of live_…) */
  MOLLIE_API_KEY: string;
  /** secret: privésleutel voor licenties, JWK (Ed25519) */
  LICENSE_PRIVATE_KEY: string;
  /** var: bv. https://licentie.boekhoudenvoorniks.nl */
  PUBLIC_URL: string;
  /** secret of var: prijs per maand, bv. "7.50" */
  PRICE_EUR: string;
}

export interface Deps {
  fetch: typeof fetch;
  /** vandaag, JJJJ-MM-DD (te vervangen in tests) */
  today: () => string;
}

export interface LicenseRecord {
  administratie: string;
  email: string;
  customerId: string;
  subscriptionId: string | null;
  /** betaald t/m (JJJJ-MM-DD) */
  paidUntil: string;
}

/** Marge na de betaalde periode: een incasso kan een paar dagen duren. */
export const GRACE_DAYS = 7;
const MOLLIE = 'https://api.mollie.com/v2';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface MolliePayment {
  id: string;
  status: string;
  sequenceType?: string;
  customerId?: string;
  subscriptionId?: string;
  paidAt?: string;
  metadata?: { administratie?: string; email?: string } | null;
  _links?: { checkout?: { href: string } };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Een maand later; 31 januari → 28/29 februari (niet 3 maart). */
export function addMonth(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d, last))).toISOString().slice(0, 10);
}

async function mollie<T>(env: Env, deps: Deps, path: string, body?: unknown): Promise<T> {
  const res = await deps.fetch(`${MOLLIE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${env.MOLLIE_API_KEY}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Mollie ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

const recordKey = (administratie: string) => `lic:${administratie}`;

async function getRecord(env: Env, administratie: string): Promise<LicenseRecord | null> {
  const raw = await env.LICENTIES.get(recordKey(administratie));
  return raw ? (JSON.parse(raw) as LicenseRecord) : null;
}

/** Loopt het abonnement van deze administratie nog bij Mollie? Dan nooit een tweede aanmaken (dubbele incasso). */
async function hasRunningSubscription(env: Env, deps: Deps, record: LicenseRecord | null): Promise<boolean> {
  if (!record?.subscriptionId) return false;
  const sub = await mollie<{ status: string }>(env, deps, `/customers/${record.customerId}/subscriptions/${record.subscriptionId}`);
  return sub.status === 'active' || sub.status === 'pending';
}

async function start(url: URL, env: Env, deps: Deps): Promise<Response> {
  const administratie = url.searchParams.get('administratie') ?? '';
  const email = (url.searchParams.get('email') ?? '').trim();
  if (!UUID.test(administratie)) return json({ fout: 'Onbekende administratie' }, 400);
  if (!EMAIL.test(email)) return json({ fout: 'Vul een geldig e-mailadres in' }, 400);
  if (await hasRunningSubscription(env, deps, await getRecord(env, administratie))) return page(ALREADY);
  const customer = await mollie<{ id: string }>(env, deps, '/customers', { name: email, email, metadata: { administratie } });
  const payment = await mollie<MolliePayment>(env, deps, '/payments', {
    amount: { currency: 'EUR', value: env.PRICE_EUR },
    customerId: customer.id,
    sequenceType: 'first',
    description: 'BoekhoudenVoorNiks: uitwisseling met je boekhouder (eerste maand)',
    redirectUrl: `${env.PUBLIC_URL}/bedankt`,
    webhookUrl: `${env.PUBLIC_URL}/mollie`,
    metadata: { administratie, email },
  });
  const checkout = payment._links?.checkout?.href;
  if (!checkout) throw new Error('Mollie gaf geen betaallink');
  return Response.redirect(checkout, 303);
}

/**
 * Mollie meldt alleen een betalings-ID; de status halen we zelf op (de melding zelf is niet te
 * vertrouwen). Idempotent: dezelfde betaling twee keer verwerkt verlengt niet twee keer.
 */
async function webhook(request: Request, env: Env, deps: Deps): Promise<Response> {
  const id = new URLSearchParams(await request.text()).get('id') ?? '';
  if (!/^tr_[A-Za-z0-9]+$/.test(id)) return json({ fout: 'Onbekende betaling' }, 400);
  const payment = await mollie<MolliePayment>(env, deps, `/payments/${id}`);
  if (payment.status !== 'paid') return json({ ok: true, status: payment.status });
  if (await env.LICENTIES.get(`betaald:${id}`)) return json({ ok: true, al: true });
  const paidOn = (payment.paidAt ?? deps.today()).slice(0, 10);

  if (payment.subscriptionId) {
    // maandelijkse incasso van een lopend abonnement: een maand erbij
    const administratie = await env.LICENTIES.get(`sub:${payment.subscriptionId}`);
    const record = administratie ? await getRecord(env, administratie) : null;
    if (!record) return json({ ok: true, onbekend: payment.subscriptionId });
    const from = record.paidUntil > paidOn ? record.paidUntil : paidOn;
    await env.LICENTIES.put(recordKey(record.administratie), JSON.stringify({ ...record, paidUntil: addMonth(from) } satisfies LicenseRecord));
  } else if (payment.sequenceType === 'first' && payment.customerId && payment.metadata?.administratie) {
    // eerste betaling: de eerste maand is betaald; het abonnement begint over een maand
    const { administratie, email } = payment.metadata;
    const existing = await getRecord(env, administratie);
    if (await hasRunningSubscription(env, deps, existing)) {
      // tweede eerste betaling terwijl het abonnement al loopt (bv. twee keer geklikt): een maand erbij, geen tweede abonnement
      const from = existing!.paidUntil > paidOn ? existing!.paidUntil : paidOn;
      await env.LICENTIES.put(recordKey(administratie), JSON.stringify({ ...existing!, paidUntil: addMonth(from) } satisfies LicenseRecord));
      await env.LICENTIES.put(`betaald:${id}`, deps.today());
      return json({ ok: true, verlengd: true });
    }
    const paidUntil = addMonth(paidOn);
    const subscription = await mollie<{ id: string }>(env, deps, `/customers/${payment.customerId}/subscriptions`, {
      amount: { currency: 'EUR', value: env.PRICE_EUR },
      interval: '1 month',
      startDate: paidUntil,
      description: 'BoekhoudenVoorNiks: uitwisseling met je boekhouder',
      webhookUrl: `${env.PUBLIC_URL}/mollie`,
      metadata: { administratie },
    });
    const record: LicenseRecord = { administratie, email: email ?? '', customerId: payment.customerId, subscriptionId: subscription.id, paidUntil };
    await env.LICENTIES.put(recordKey(administratie), JSON.stringify(record));
    await env.LICENTIES.put(`sub:${subscription.id}`, administratie);
  } else {
    return json({ ok: true, genegeerd: id });
  }
  await env.LICENTIES.put(`betaald:${id}`, deps.today());
  return json({ ok: true });
}

async function license(url: URL, env: Env, deps: Deps): Promise<Response> {
  const administratie = url.searchParams.get('administratie') ?? '';
  if (!UUID.test(administratie)) return json({ fout: 'Onbekende administratie' }, 400);
  const record = await getRecord(env, administratie);
  if (!record) return json({ fout: 'Geen abonnement gevonden voor deze administratie' }, 404);
  const payload: LicensePayload = { v: 1, product: 'uitwisseling', administratie, email: record.email, validUntil: addDays(record.paidUntil, GRACE_DAYS), issuedAt: deps.today() };
  return json({ token: await signLicense(payload, env.LICENSE_PRIVATE_KEY), validUntil: payload.validUntil });
}

const page = (html: string) => new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });

const ALREADY = `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Je hebt al een abonnement</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 16px;line-height:1.5;color:#1b1f24;background:#f6f7f9}</style></head>
<body><h1>Je hebt al een abonnement</h1><p>Voor deze administratie loopt al een abonnement; je betaalt niet dubbel. Klik in BoekhoudenVoorNiks op <strong>Ik heb betaald: licentie ophalen</strong>.</p>
<p>Je kunt dit venster sluiten.</p></body></html>`;

const THANKS = `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bedankt</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 16px;line-height:1.5;color:#1b1f24;background:#f6f7f9}</style></head>
<body><h1>Bedankt!</h1><p>Zodra je betaling binnen is, kun je in BoekhoudenVoorNiks op <strong>Licentie ophalen</strong> klikken (Hoe gaat het? &gt; Uitwisseling met je boekhouder). Daarna kun je versturen naar je boekhouder.</p>
<p>Je kunt dit venster sluiten.</p></body></html>`;

export async function handle(request: Request, env: Env, deps: Deps): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (request.method === 'GET' && url.pathname === '/prijs') return json({ bedrag: env.PRICE_EUR, valuta: 'EUR', per: 'maand' });
    if (request.method === 'GET' && url.pathname === '/start') return await start(url, env, deps);
    if (request.method === 'POST' && url.pathname === '/mollie') return await webhook(request, env, deps);
    if (request.method === 'GET' && url.pathname === '/licentie') return await license(url, env, deps);
    if (request.method === 'GET' && url.pathname === '/bedankt') return page(THANKS);
    return json({ fout: 'Niet gevonden' }, 404);
  } catch (e) {
    console.error(JSON.stringify({ route: url.pathname, fout: (e as Error).message }));
    // Mollie probeert een webhook opnieuw bij een fout; dat is wat we willen
    return json({ fout: 'Er ging iets mis; probeer het later opnieuw' }, 500);
  }
}
