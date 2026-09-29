import { signLicense, type LicensePayload } from './token';

/**
 * Licentie-Worker van BoekhoudenVoorNiks: het enige online onderdeel. Een klant neemt via Mollie een
 * abonnement voor de uitwisseling met zijn boekhouder; de app haalt daarna een ondertekende licentie op.
 * Hier staat alleen wat nodig is om te betalen en te factureren: administratie-ID, e-mailadres,
 * bedrijfsgegevens voor de factuur en de Mollie-nummers. Geen boekhouding.
 *
 *   GET  /prijs                  prijs per maand (uit de instellingen van de Worker)
 *   POST /start                  (JSON) klant en eerste betaling bij Mollie; geeft de betaallink terug
 *   POST /mollie                 webhook: betaling opzoeken bij Mollie en verwerken, met factuur
 *   GET  /licentie?administratie=…   ondertekende licentie t/m de betaalde periode (+ marge)
 *   POST /opzeggen               (JSON) abonnement stoppen; de betaalde periode loopt af
 *   GET  /bedankt                terugkeerpagina na het afrekenen
 *
 * De webhook is idempotent en herstelbaar (Mollie herhaalt hem bij een fout): opslag in D1 (sterk
 * consistent, transacties), elke betaling telt één keer (unieke payment_id, in dezelfde transactie als
 * de extra maand), maar één webhook maakt het abonnement aan (claim), en Mollie krijgt bij elke POST een
 * Idempotency-Key, zodat een herhaling na een half gelukte verwerking hetzelfde abonnement of dezelfde
 * factuur terugkrijgt.
 */

/** De D1-functies die we gebruiken (binding LICENTIES); D1Database voldoet hieraan. */
export interface LicenseDb {
  prepare(sql: string): LicenseStatement;
  batch(statements: LicenseStatement[]): Promise<unknown[]>;
}
export interface LicenseStatement {
  bind(...values: (string | number | null)[]): LicenseStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<{ meta: { changes: number } }>;
}

export interface Env {
  LICENTIES: LicenseDb;
  /**
   * secret: organisatie-toegangstoken (access_…) met alleen de rechten customers.write, payments.read,
   * payments.write, subscriptions.read, subscriptions.write en sales-invoices.write; of een API-sleutel
   */
  MOLLIE_API_KEY: string;
  /** var: profiel-ID (pfl_…); alleen bij een organisatie-toegangstoken (bij een API-sleutel juist weglaten) */
  MOLLIE_PROFILE_ID?: string;
  /** var: "true" = testmodus; alleen bij een organisatie-toegangstoken */
  MOLLIE_TESTMODE?: string;
  /** var: "true" = bij elke betaling een factuur via Mollie (vraagt het recht sales-invoices.write) */
  INVOICES?: string;
  /** secret: privésleutel voor licenties, JWK (Ed25519) */
  LICENSE_PRIVATE_KEY: string;
  /** var: bv. https://licentie.boekhoudenvoorniks.nl */
  PUBLIC_URL: string;
  /** secret of var: prijs per maand inclusief btw, bv. "7.50" */
  PRICE_EUR: string;
}

export interface Deps {
  fetch: typeof fetch;
  /** vandaag, JJJJ-MM-DD (te vervangen in tests) */
  today: () => string;
}

/** Bedrijfsgegevens voor de factuur (uit de app: Instellingen > Je bedrijf). */
export interface Billing {
  naam: string;
  adres: string;
  postcode: string;
  plaats: string;
  /** ISO 3166-1 alpha-2 */
  land: string;
  kvk?: string;
  btw?: string;
}

interface LicenseRow {
  administratie: string;
  email: string;
  customer_id: string;
  subscription_id: string | null;
  period_start: string;
  months: number;
  subscription_claim: string | null;
  billing: string | null;
  cancelled_at: string | null;
}

/** Marge na de betaalde periode: een incasso kan een paar dagen duren. */
export const GRACE_DAYS = 7;
/** Btw op het abonnement (de prijs is inclusief). */
const VAT_RATE = '21.00';
const MOLLIE = 'https://api.mollie.com/v2';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface MolliePayment {
  id: string;
  status: string;
  amount?: { currency: string; value: string };
  sequenceType?: string;
  customerId?: string;
  subscriptionId?: string;
  paidAt?: string;
  metadata?: { administratie?: string; email?: string; billing?: Billing } | null;
  _links?: { checkout?: { href: string } };
}

interface MollieSubscription {
  id: string;
  status: string;
  metadata?: { administratie?: string } | null;
}

/** Fout van de Mollie-API, met de HTTP-status (404 = bestaat niet; al het andere: later opnieuw). */
class MollieError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Fout in wat de app stuurde (400). */
class BadRequest extends Error {}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const page = (html: string) => new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** `n` maanden later, afgekapt op het eind van de maand: 31 januari + 1 → 28/29 februari. */
export function addMonths(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))).toISOString().slice(0, 10);
}

export const addMonth = (date: string): string => addMonths(date, 1);

/** Betaald t/m: vanaf het begin van de doorlopende periode (geen afwijking door korte maanden). */
const paidUntil = (row: LicenseRow): string => addMonths(row.period_start, row.months);

/**
 * Een aanroep naar Mollie. Met een organisatie-toegangstoken moet elke aanroep `testmode` meesturen
 * (bij GET in de URL, anders in de body) en het aanmaken van een betaling, abonnement of factuur ook
 * `profileId` (`withProfile`); met een API-sleutel mag dat juist niet, dus alleen als het ingesteld is.
 */
async function mollie<T>(env: Env, deps: Deps, method: 'GET' | 'POST' | 'DELETE', path: string, body?: Record<string, unknown>, opts: { idempotencyKey?: string; withProfile?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${env.MOLLIE_API_KEY}`, 'content-type': 'application/json' };
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
  const testmode = env.MOLLIE_TESTMODE === 'true';
  let url = `${MOLLIE}${path}`;
  let payload: Record<string, unknown> | undefined;
  if (method === 'GET') {
    if (testmode) url += `${path.includes('?') ? '&' : '?'}testmode=true`;
  } else {
    payload = { ...(body ?? {}), ...(opts.withProfile && env.MOLLIE_PROFILE_ID ? { profileId: env.MOLLIE_PROFILE_ID } : {}), ...(testmode ? { testmode: true } : {}) };
    if (Object.keys(payload).length === 0) payload = undefined;
  }
  const res = await deps.fetch(url, { method, headers, body: payload === undefined ? undefined : JSON.stringify(payload) });
  if (!res.ok) throw new MollieError(`Mollie ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`, res.status);
  return (await res.json()) as T;
}

function getLicense(env: Env, administratie: string): Promise<LicenseRow | null> {
  return env.LICENTIES.prepare('SELECT * FROM licenses WHERE administratie = ?').bind(administratie).first<LicenseRow>();
}

/** Loopt het abonnement van deze licentie nog bij Mollie? Dan nooit een tweede aanmaken (dubbele incasso). */
async function subscriptionRunning(env: Env, deps: Deps, row: LicenseRow | null): Promise<boolean> {
  if (!row?.subscription_id) return false;
  const sub = await mollie<MollieSubscription>(env, deps, 'GET', `/customers/${row.customer_id}/subscriptions/${row.subscription_id}`);
  return sub.status === 'active' || sub.status === 'pending';
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (Number(request.headers.get('content-length') ?? '0') > 8192) throw new BadRequest('Te groot');
  try {
    const body = (await request.json()) as unknown;
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    /* hieronder */
  }
  throw new BadRequest('Ongeldig verzoek');
}

const text = (v: unknown, max = 200): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Bedrijfsgegevens voor de factuur; Mollie vraagt naam, adres en een KvK- of btw-nummer. */
function parseBilling(raw: unknown): Billing {
  const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const billing: Billing = { naam: text(b.naam), adres: text(b.adres), postcode: text(b.postcode, 20), plaats: text(b.plaats, 100), land: (text(b.land, 2) || 'NL').toUpperCase(), kvk: text(b.kvk, 20) || undefined, btw: text(b.btw, 20) || undefined };
  const missing = [!billing.naam && 'bedrijfsnaam', !billing.adres && 'adres', !billing.postcode && 'postcode', !billing.plaats && 'plaats', !billing.kvk && !billing.btw && 'KvK- of btw-nummer'].filter(Boolean);
  if (missing.length > 0) throw new BadRequest(`Voor de factuur ontbreekt: ${missing.join(', ')}`);
  if (!/^[A-Z]{2}$/.test(billing.land)) throw new BadRequest('Onbekend land');
  return billing;
}

/** Klant en eerste betaling; de app opent daarna de betaallink. */
async function start(request: Request, env: Env, deps: Deps): Promise<Response> {
  const body = await readJson(request);
  const administratie = text(body.administratie, 36);
  const email = text(body.email);
  if (!UUID.test(administratie)) throw new BadRequest('Onbekende administratie');
  if (!EMAIL.test(email)) throw new BadRequest('Vul een geldig e-mailadres in');
  const billing = parseBilling(body.bedrijf);
  if (await subscriptionRunning(env, deps, await getLicense(env, administratie))) return json({ al: true });
  const customer = await mollie<{ id: string }>(env, deps, 'POST', '/customers', { name: billing.naam, email, metadata: { administratie } });
  const payment = await mollie<MolliePayment>(
    env,
    deps,
    'POST',
    '/payments',
    {
      amount: { currency: 'EUR', value: env.PRICE_EUR },
      customerId: customer.id,
      sequenceType: 'first',
      description: 'BoekhoudenVoorNiks: uitwisseling met je boekhouder (eerste maand)',
      redirectUrl: `${env.PUBLIC_URL}/bedankt`,
      webhookUrl: `${env.PUBLIC_URL}/mollie`,
      metadata: { administratie, email, billing },
    },
    { withProfile: true },
  );
  const checkout = payment._links?.checkout?.href;
  if (!checkout) throw new Error('Mollie gaf geen betaallink');
  return json({ checkout });
}

/**
 * Eerste betaling: een maand erbij (of een nieuwe periode als de vorige verlopen was) en de betaling
 * vastleggen, in één transactie; daarna zorgen dat er een abonnement loopt en dat er een factuur is.
 */
async function firstPayment(env: Env, deps: Deps, payment: MolliePayment, paidOn: string): Promise<void> {
  const administratie = payment.metadata!.administratie!;
  const existing = await getLicense(env, administratie);
  const lapsed = existing && existing.months > 0 && paidUntil(existing) < paidOn ? 1 : 0;
  const billing = payment.metadata?.billing ? JSON.stringify(payment.metadata.billing) : null;
  await env.LICENTIES.batch([
    env.LICENTIES.prepare(
      `INSERT INTO licenses (administratie, email, customer_id, period_start, months, billing)
       SELECT ?1, ?2, ?3, ?4, 1, ?7 WHERE NOT EXISTS (SELECT 1 FROM payments WHERE payment_id = ?5)
       ON CONFLICT (administratie) DO UPDATE SET
         email = excluded.email,
         customer_id = excluded.customer_id,
         billing = COALESCE(excluded.billing, billing),
         cancelled_at = NULL,
         period_start = CASE WHEN ?6 = 1 THEN excluded.period_start ELSE period_start END,
         months = CASE WHEN ?6 = 1 THEN 1 ELSE months + 1 END`,
    ).bind(administratie, payment.metadata!.email ?? '', payment.customerId!, paidOn, payment.id, lapsed, billing),
    env.LICENTIES.prepare('INSERT OR IGNORE INTO payments (payment_id, administratie, processed_at, amount) VALUES (?, ?, ?, ?)').bind(payment.id, administratie, deps.today(), payment.amount?.value ?? env.PRICE_EUR),
  ]);
  await ensureSubscription(env, deps, administratie, payment.id);
  await ensureInvoice(env, deps, administratie, payment.id);
}

/**
 * Zorgt dat er precies één abonnement loopt. Herstelbaar: na een half gelukte verwerking maakt de
 * herhaling van dezelfde betaling het af (zelfde claim, zelfde Idempotency-Key bij Mollie).
 */
async function ensureSubscription(env: Env, deps: Deps, administratie: string, paymentId: string): Promise<void> {
  const row = await getLicense(env, administratie);
  if (!row) throw new Error(`Licentie ${administratie} ontbreekt`);
  if (row.subscription_id) {
    if (await subscriptionRunning(env, deps, row)) return;
    // opgezegd of verlopen abonnement: vrijgeven, zodat er een nieuw kan komen
    await env.LICENTIES.prepare('UPDATE licenses SET subscription_id = NULL, subscription_claim = NULL WHERE administratie = ? AND subscription_id = ?').bind(administratie, row.subscription_id).run();
  }
  const claim = await env.LICENTIES.prepare(
    'UPDATE licenses SET subscription_claim = ?1 WHERE administratie = ?2 AND subscription_id IS NULL AND (subscription_claim IS NULL OR subscription_claim = ?1)',
  ).bind(paymentId, administratie).run();
  if (claim.meta.changes === 0) return; // een andere betaling maakt het abonnement al aan
  const current = await getLicense(env, administratie);
  if (!current) throw new Error(`Licentie ${administratie} ontbreekt`);
  const subscription = await mollie<MollieSubscription>(
    env,
    deps,
    'POST',
    `/customers/${current.customer_id}/subscriptions`,
    {
      amount: { currency: 'EUR', value: env.PRICE_EUR },
      interval: '1 month',
      startDate: paidUntil(current),
      description: 'BoekhoudenVoorNiks: uitwisseling met je boekhouder',
      webhookUrl: `${env.PUBLIC_URL}/mollie`,
      metadata: { administratie },
    },
    { idempotencyKey: `abonnement-${paymentId}`, withProfile: true },
  );
  await env.LICENTIES.prepare('UPDATE licenses SET subscription_id = ?, subscription_claim = NULL WHERE administratie = ? AND subscription_claim = ?')
    .bind(subscription.id, administratie, paymentId)
    .run();
}

/**
 * Een betaalde factuur bij Mollie voor deze betaling (Sales Invoices-API): Mollie nummert hem en mailt
 * hem naar de klant. Eén per betaling: vastgelegd in `payments.invoice_id`, en Mollie krijgt een
 * Idempotency-Key, zodat een herhaling na een storing dezelfde factuur terugkrijgt.
 */
async function ensureInvoice(env: Env, deps: Deps, administratie: string, paymentId: string): Promise<void> {
  if (env.INVOICES !== 'true') return;
  const done = await env.LICENTIES.prepare('SELECT invoice_id, amount, processed_at FROM payments WHERE payment_id = ?').bind(paymentId).first<{ invoice_id: string | null; amount: string | null; processed_at: string }>();
  if (!done || done.invoice_id) return;
  const row = await getLicense(env, administratie);
  if (!row?.billing) {
    console.error(JSON.stringify({ factuur: 'geen bedrijfsgegevens', administratie, betaling: paymentId }));
    return;
  }
  const billing = JSON.parse(row.billing) as Billing;
  const period = new Intl.DateTimeFormat('nl-NL', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${done.processed_at}T00:00:00Z`));
  const invoice = await mollie<{ id: string }>(
    env,
    deps,
    'POST',
    '/sales-invoices',
    {
      status: 'paid',
      // vast per klant, zodat Mollie zijn facturen bij elkaar houdt
      recipientIdentifier: `administratie:${administratie}`,
      recipient: {
        type: 'business',
        organizationName: billing.naam,
        ...(billing.kvk ? { organizationNumber: billing.kvk } : {}),
        ...(billing.btw ? { vatNumber: billing.btw } : {}),
        email: row.email,
        streetAndNumber: billing.adres,
        postalCode: billing.postcode,
        city: billing.plaats,
        country: billing.land,
        locale: billing.land === 'BE' ? 'nl_BE' : 'nl_NL',
      },
      lines: [{ description: `BoekhoudenVoorNiks: uitwisseling met je boekhouder (${period})`, quantity: 1, unitPrice: { currency: 'EUR', value: done.amount ?? env.PRICE_EUR }, vatRate: VAT_RATE }],
      vatScheme: 'standard',
      // de prijs is inclusief btw: de factuur telt op tot wat er is afgeschreven
      vatMode: 'inclusive',
      paymentTerm: '30 days',
      paymentDetails: { source: 'payment', sourceReference: paymentId },
      emailDetails: {
        subject: 'Je factuur van BoekhoudenVoorNiks',
        body: `Beste ${billing.naam},\n\nIn de bijlage vind je de factuur voor je abonnement op de uitwisseling met je boekhouder. Het bedrag is al betaald.\n\nMet vriendelijke groet,\nBoekhoudenVoorNiks`,
      },
      metadata: { administratie, betaling: paymentId },
    },
    { idempotencyKey: `factuur-${paymentId}`, withProfile: true },
  );
  await env.LICENTIES.prepare('UPDATE payments SET invoice_id = ? WHERE payment_id = ? AND invoice_id IS NULL').bind(invoice.id, paymentId).run();
}

/** Maandelijkse incasso: een maand erbij, precies één keer per betaling, en een factuur. */
async function recurringPayment(env: Env, deps: Deps, payment: MolliePayment): Promise<Response> {
  const known = await env.LICENTIES.prepare('SELECT administratie FROM licenses WHERE subscription_id = ?').bind(payment.subscriptionId!).first<{ administratie: string }>();
  let administratie = known?.administratie;
  if (!administratie && payment.customerId) {
    // koppeling nog niet vastgelegd (bv. na een half gelukte eerste verwerking): het abonnement zelf weet het
    try {
      const sub = await mollie<MollieSubscription>(env, deps, 'GET', `/customers/${payment.customerId}/subscriptions/${payment.subscriptionId}`);
      administratie = sub.metadata?.administratie;
    } catch (e) {
      if (!(e instanceof MollieError && e.status === 404)) throw e;
    }
  }
  if (!administratie || !UUID.test(administratie)) return json({ ok: true, genegeerd: payment.id }); // geen abonnement van ons
  if (!(await getLicense(env, administratie))) throw new Error(`Licentie ${administratie} ontbreekt`); // 500: Mollie probeert het later opnieuw
  await env.LICENTIES.batch([
    env.LICENTIES.prepare('UPDATE licenses SET months = months + 1 WHERE administratie = ? AND NOT EXISTS (SELECT 1 FROM payments WHERE payment_id = ?)').bind(administratie, payment.id),
    env.LICENTIES.prepare('INSERT OR IGNORE INTO payments (payment_id, administratie, processed_at, amount) VALUES (?, ?, ?, ?)').bind(payment.id, administratie, deps.today(), payment.amount?.value ?? env.PRICE_EUR),
  ]);
  await ensureInvoice(env, deps, administratie, payment.id);
  return json({ ok: true });
}

/** Mollie meldt alleen een betalings-ID; de status halen we zelf op (de melding zelf is niet te vertrouwen). */
async function webhook(request: Request, env: Env, deps: Deps): Promise<Response> {
  const id = new URLSearchParams(await request.text()).get('id') ?? '';
  if (!/^tr_[A-Za-z0-9]+$/.test(id)) return json({ fout: 'Onbekende betaling' }, 400);
  const payment = await mollie<MolliePayment>(env, deps, 'GET', `/payments/${id}`);
  if (payment.status !== 'paid') return json({ ok: true, status: payment.status });
  if (payment.subscriptionId) return recurringPayment(env, deps, payment);
  const administratie = payment.metadata?.administratie;
  if (payment.sequenceType === 'first' && payment.customerId && administratie && UUID.test(administratie)) {
    await firstPayment(env, deps, payment, (payment.paidAt ?? deps.today()).slice(0, 10));
    return json({ ok: true });
  }
  return json({ ok: true, genegeerd: id });
}

/**
 * Opzeggen: het abonnement bij Mollie stoppen; er wordt niets meer afgeschreven, en de licentie loopt
 * af na de betaalde periode. Nog een keer opzeggen kan geen kwaad.
 */
async function cancel(request: Request, env: Env, deps: Deps): Promise<Response> {
  const body = await readJson(request);
  const administratie = text(body.administratie, 36);
  if (!UUID.test(administratie)) throw new BadRequest('Onbekende administratie');
  const row = await getLicense(env, administratie);
  if (!row || row.months === 0) return json({ fout: 'Geen abonnement gevonden voor deze administratie' }, 404);
  if (await subscriptionRunning(env, deps, row)) {
    try {
      await mollie(env, deps, 'DELETE', `/customers/${row.customer_id}/subscriptions/${row.subscription_id}`);
    } catch (e) {
      if (!(e instanceof MollieError && e.status === 404)) throw e;
    }
  }
  await env.LICENTIES.prepare('UPDATE licenses SET cancelled_at = COALESCE(cancelled_at, ?) WHERE administratie = ?').bind(deps.today(), administratie).run();
  return json({ ok: true, betaaldTot: paidUntil(row), geldigTot: addDays(paidUntil(row), GRACE_DAYS) });
}

async function license(url: URL, env: Env, deps: Deps): Promise<Response> {
  const administratie = url.searchParams.get('administratie') ?? '';
  if (!UUID.test(administratie)) return json({ fout: 'Onbekende administratie' }, 400);
  const row = await getLicense(env, administratie);
  if (!row || row.months === 0) return json({ fout: 'Geen abonnement gevonden voor deze administratie' }, 404);
  const payload: LicensePayload = {
    v: 1,
    product: 'uitwisseling',
    administratie,
    email: row.email,
    validUntil: addDays(paidUntil(row), GRACE_DAYS),
    issuedAt: deps.today(),
    ...(row.cancelled_at ? { cancelled: true } : {}),
  };
  return json({ token: await signLicense(payload, env.LICENSE_PRIVATE_KEY), validUntil: payload.validUntil });
}

const STYLE = '<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 16px;line-height:1.5;color:#1b1f24;background:#f6f7f9}</style>';

const THANKS = `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bedankt</title>${STYLE}</head>
<body><h1>Bedankt!</h1><p>Zodra je betaling binnen is, kun je in BoekhoudenVoorNiks op <strong>Ik heb betaald: licentie ophalen</strong> klikken (Hoe gaat het? &gt; Uitwisseling met je boekhouder). Daarna kun je versturen naar je boekhouder. De factuur krijg je per e-mail.</p>
<p>Je kunt dit venster sluiten.</p></body></html>`;

export async function handle(request: Request, env: Env, deps: Deps): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (request.method === 'GET' && url.pathname === '/prijs') return json({ bedrag: env.PRICE_EUR, valuta: 'EUR', per: 'maand', btw: 'inclusief' });
    if (request.method === 'POST' && url.pathname === '/start') return await start(request, env, deps);
    if (request.method === 'POST' && url.pathname === '/mollie') return await webhook(request, env, deps);
    if (request.method === 'GET' && url.pathname === '/licentie') return await license(url, env, deps);
    if (request.method === 'POST' && url.pathname === '/opzeggen') return await cancel(request, env, deps);
    if (request.method === 'GET' && url.pathname === '/bedankt') return page(THANKS);
    return json({ fout: 'Niet gevonden' }, 404);
  } catch (e) {
    if (e instanceof BadRequest) return json({ fout: e.message }, 400);
    console.error(JSON.stringify({ route: url.pathname, fout: (e as Error).message }));
    // 500: Mollie probeert een webhook dan opnieuw, en de verwerking is herstelbaar
    return json({ fout: 'Er ging iets mis; probeer het later opnieuw' }, 500);
  }
}
