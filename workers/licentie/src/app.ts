import { signLicense, type LicensePayload } from './token';

/**
 * Licentie-Worker van BoekhoudenVoorNiks: het enige online onderdeel. Een klant neemt via Mollie een
 * abonnement voor de uitwisseling met zijn boekhouder; de app haalt daarna een ondertekende licentie op.
 * Hier staat alleen wat nodig is om te betalen en te factureren: administratie-ID, e-mailadres,
 * bedrijfsgegevens voor de factuur en de Mollie-nummers. Geen boekhouding.
 *
 *   GET  /prijs                  prijs per maand en proefperiode (uit de instellingen van de Worker)
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
  /** var: prijs per maand exclusief btw, bv. "9.00"; afgeschreven wordt dit plus 21% btw */
  PRICE_EXCL_VAT: string;
  /** var: gratis maanden bij een eerste abonnement, bv. "4"; "0" of leeg = geen proefperiode */
  TRIAL_MONTHS?: string;
}

export interface Deps {
  fetch: typeof fetch;
  /** vandaag, JJJJ-MM-DD (te vervangen in tests) */
  today: () => string;
  /** nu, in milliseconden (te vervangen in tests); standaard Date.now() */
  now?: () => number;
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
  management_key_hash: string | null;
}

/** Marge na de betaalde periode: een incasso kan een paar dagen duren. */
export const GRACE_DAYS = 7;
/** Btw op het abonnement. */
const VAT_RATE = '21.00';
/**
 * Eerste betaling bij een proefperiode: alleen voor de machtiging voor de incasso daarna. Mollie kan
 * € 0 alleen met creditcard of PayPal; iDEAL vraagt minstens € 0,01.
 */
export const TRIAL_AMOUNT = '0.01';

/** Prijs exclusief btw ("9.00") → wat er wordt afgeschreven, inclusief 21% btw ("10.89"), in hele centen. */
export function inclVat(exclVat: string): string {
  const cents = Math.round(Number(exclVat) * 100);
  if (!Number.isFinite(cents) || cents <= 0) throw new Error(`Ongeldige prijs: ${exclVat}`);
  return (Math.round((cents * 121) / 100) / 100).toFixed(2);
}

const trialMonths = (env: Env): number => Math.max(0, Math.floor(Number(env.TRIAL_MONTHS ?? '0')) || 0);
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
  metadata?: { administratie?: string; email?: string; billing?: Billing; managementKeyHash?: string; proefMaanden?: number } | null;
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

/** De administratie bestaat, maar de lokale beheersleutel klopt niet (403). */
class Forbidden extends Error {}

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
  let res: Response;
  for (let attempt = 0; ; attempt += 1) {
    res = await deps.fetch(url, { method, headers, body: payload === undefined ? undefined : JSON.stringify(payload) });
    // Mollie kan bij twee gelijktijdige verzoeken met dezelfde sleutel kort 409 geven terwijl het
    // eerste nog loopt. Dezelfde POST met dezelfde sleutel mag daarna veilig opnieuw.
    if (res.status !== 409 || method !== 'POST' || !opts.idempotencyKey || attempt >= 3) break;
    await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
  }
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
const MANAGEMENT_KEY = /^[A-Za-z0-9_-]{43}$/;

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

const managementKeyHash = sha256Hex;

/** Mollie onthoudt een Idempotency-Key 1 uur; dezelfde sleutel met andere inhoud geeft een 400. */
const IDEMPOTENCY_WINDOW_MS = 10 * 60 * 1000;

function managementKeyFrom(request: Request): string {
  const value = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1] ?? '';
  if (!value) throw new Forbidden('Geen geldige beheersleutel voor dit abonnement');
  return value;
}

async function authorize(request: Request, row: LicenseRow): Promise<void> {
  if (!row.management_key_hash || (await managementKeyHash(managementKeyFrom(request))) !== row.management_key_hash) {
    throw new Forbidden('Geen toegang tot dit abonnement; neem contact op met info@shipdocs.app als je administratie is hersteld');
  }
}

/** Bedrijfsgegevens voor de factuur; Mollie vraagt naam, adres en een KvK- of btw-nummer. */
function parseBilling(raw: unknown): Billing {
  const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const billing: Billing = { naam: text(b.naam), adres: text(b.adres), postcode: text(b.postcode, 20), plaats: text(b.plaats, 100), land: (text(b.land, 20) || 'NL').toUpperCase(), kvk: text(b.kvk, 20) || undefined, btw: text(b.btw, 20) || undefined };
  const missing = [!billing.naam && 'bedrijfsnaam', !billing.adres && 'adres', !billing.postcode && 'postcode', !billing.plaats && 'plaats', !billing.kvk && !billing.btw && 'KvK- of btw-nummer'].filter(Boolean);
  if (missing.length > 0) throw new BadRequest(`Voor de factuur ontbreekt: ${missing.join(', ')}`);
  // niet afkappen: "Nederland" wordt geen "NE", maar een duidelijke fout
  if (!/^[A-Z]{2}$/.test(billing.land)) throw new BadRequest('Het land moet een landcode van twee letters zijn, bv. NL');
  return billing;
}

/** Klant en eerste betaling; de app opent daarna de betaallink. */
async function start(request: Request, env: Env, deps: Deps): Promise<Response> {
  const body = await readJson(request);
  const administratie = text(body.administratie, 36);
  const email = text(body.email);
  const managementKey = text(body.managementKey, 100);
  if (!UUID.test(administratie)) throw new BadRequest('Onbekende administratie');
  if (!EMAIL.test(email)) throw new BadRequest('Vul een geldig e-mailadres in');
  if (!MANAGEMENT_KEY.test(managementKey)) throw new BadRequest('Ongeldige beheersleutel');
  const billing = parseBilling(body.bedrijf);
  const hash = await managementKeyHash(managementKey);
  const existing = await getLicense(env, administratie);
  if (existing) {
    if (!existing.management_key_hash || existing.management_key_hash !== hash) throw new Forbidden('Geen toegang tot dit abonnement; neem contact op met info@shipdocs.app');
    await env.LICENTIES.prepare('UPDATE licenses SET email = ?, billing = ? WHERE administratie = ?').bind(email, JSON.stringify(billing), administratie).run();
    if (await subscriptionRunning(env, deps, existing)) return json({ al: true });
  }
  // Idempotency-Key voor klant en eerste betaling: dezelfde inhoud binnen hetzelfde tijdvak van 10 minuten
  // geeft dezelfde sleutel, dus dubbel klikken levert één betaalpagina op. Andere gegevens (e-mail,
  // bedrijf, prijs) geven een andere sleutel, want Mollie weigert dezelfde sleutel met andere inhoud.
  const window = Math.floor((deps.now?.() ?? Date.now()) / IDEMPOTENCY_WINDOW_MS);
  const customer = existing
    ? { id: existing.customer_id }
    : await mollie<{ id: string }>(env, deps, 'POST', '/customers', { name: billing.naam, email, metadata: { administratie } }, {
        idempotencyKey: `klant-${administratie}-${(await sha256Hex(JSON.stringify([billing.naam, email]))).slice(0, 16)}-${window}`,
      });
  const attempt = existing?.months ?? 0;
  // Proefperiode alleen bij een eerste abonnement: deze administratie en dit e-mailadres hadden er nog geen.
  const trial = !existing && (await usedTrial(env, email)) === false ? trialMonths(env) : 0;
  const price = inclVat(env.PRICE_EXCL_VAT);
  const paymentBody = {
    amount: { currency: 'EUR', value: trial > 0 ? TRIAL_AMOUNT : price },
    customerId: customer.id,
    sequenceType: 'first',
    description: trial > 0
      ? `BoekhoudenVoorNiks: machtiging, ${trial} maanden gratis, daarna € ${price.replace('.', ',')} per maand`
      : 'BoekhoudenVoorNiks: uitwisseling met je boekhouder (eerste maand)',
    redirectUrl: `${env.PUBLIC_URL}/bedankt`,
    webhookUrl: `${env.PUBLIC_URL}/mollie`,
    metadata: { administratie, email, billing, managementKeyHash: hash, ...(trial > 0 ? { proefMaanden: trial } : {}) },
  };
  const key = `start-${administratie}-${attempt}-${(await sha256Hex(JSON.stringify(paymentBody))).slice(0, 16)}-${window}`;
  let payment = await mollie<MolliePayment>(env, deps, 'POST', '/payments', paymentBody, { idempotencyKey: key, withProfile: true });
  if (payment.status !== 'open' || !payment._links?.checkout?.href) {
    // dezelfde sleutel gaf een betaling die niet meer open is (afgebroken of verlopen): één nieuwe
    payment = await mollie<MolliePayment>(env, deps, 'POST', '/payments', paymentBody, { idempotencyKey: `${key}-${crypto.randomUUID()}`, withProfile: true });
  }
  const checkout = payment._links?.checkout?.href;
  if (!checkout) throw new Error('Mollie gaf geen betaallink');
  return json({ checkout, proefMaanden: trial });
}

/** Had dit e-mailadres al een abonnement (en dus een proefperiode)? */
async function usedTrial(env: Env, email: string): Promise<boolean> {
  return (await env.LICENTIES.prepare('SELECT 1 AS x FROM licenses WHERE lower(email) = lower(?) LIMIT 1').bind(email).first()) !== null;
}

/**
 * Eerste betaling: een maand erbij (of een nieuwe periode als de vorige verlopen was) en de betaling
 * vastleggen, in één transactie; daarna zorgen dat er een abonnement loopt en dat er een factuur is.
 * Bij een proefperiode telt de machtigingsbetaling voor de gratis maanden; het abonnement begint daarna.
 * Een proefperiode telt alleen voor een nieuwe licentie: twee proefbetalingen tegelijk geven er één.
 */
async function firstPayment(env: Env, deps: Deps, payment: MolliePayment, paidOn: string): Promise<void> {
  const administratie = payment.metadata!.administratie!;
  const existing = await getLicense(env, administratie);
  const lapsed = existing && existing.months > 0 && paidUntil(existing) < paidOn ? 1 : 0;
  const trial = Math.max(0, Math.floor(Number(payment.metadata?.proefMaanden ?? 0)) || 0);
  // proef: ?9 maanden voor een nieuwe licentie, 0 als er al een is; anders een betaalde maand
  const credit = trial > 0 ? 0 : 1;
  const billing = payment.metadata?.billing ? JSON.stringify(payment.metadata.billing) : null;
  await env.LICENTIES.batch([
    env.LICENTIES.prepare(
      `INSERT INTO licenses (administratie, email, customer_id, period_start, months, billing, management_key_hash)
       SELECT ?1, ?2, ?3, ?4, CASE WHEN ?9 > 0 THEN ?9 ELSE 1 END, ?7, ?8 WHERE NOT EXISTS (SELECT 1 FROM payments WHERE payment_id = ?5)
       ON CONFLICT (administratie) DO UPDATE SET
         email = excluded.email,
         customer_id = excluded.customer_id,
         billing = COALESCE(excluded.billing, billing),
         management_key_hash = COALESCE(management_key_hash, excluded.management_key_hash),
         cancelled_at = NULL,
         period_start = CASE WHEN ?6 = 1 THEN excluded.period_start ELSE period_start END,
         months = CASE WHEN ?6 = 1 THEN ?10 ELSE months + ?10 END`,
    ).bind(administratie, payment.metadata!.email ?? '', payment.customerId!, paidOn, payment.id, lapsed, billing, payment.metadata?.managementKeyHash ?? null, trial, credit),
    // processed_at = betaaldatum: daarop is de factuurmaand gebaseerd
    env.LICENTIES.prepare('INSERT OR IGNORE INTO payments (payment_id, administratie, processed_at, amount, trial) VALUES (?, ?, ?, ?, ?)').bind(payment.id, administratie, paidOn, payment.amount?.value ?? '', trial > 0 ? 1 : 0),
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
      amount: { currency: 'EUR', value: inclVat(env.PRICE_EXCL_VAT) },
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
  const done = await env.LICENTIES.prepare('SELECT invoice_id, amount, processed_at, trial FROM payments WHERE payment_id = ?').bind(paymentId).first<{ invoice_id: string | null; amount: string | null; processed_at: string; trial: number }>();
  // de machtigingsbetaling van de proefperiode is geen levering: geen factuur
  if (!done || done.invoice_id || done.trial) return;
  const row = await getLicense(env, administratie);
  if (!row?.billing) {
    // Niet stil als geslaagd markeren: na operationeel herstel kan Mollie dezelfde webhook herhalen.
    throw new Error(`Factuurgegevens ontbreken voor ${administratie}; herstel de licentie vóór de webhook opnieuw wordt verwerkt`);
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
      lines: [{ description: `BoekhoudenVoorNiks: uitwisseling met je boekhouder (${period})`, quantity: 1, unitPrice: { currency: 'EUR', value: done.amount || inclVat(env.PRICE_EXCL_VAT) }, vatRate: VAT_RATE }],
      vatScheme: 'standard',
      // het afgeschreven bedrag, inclusief btw: de factuur telt precies op tot wat er is betaald
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
    env.LICENTIES.prepare('INSERT OR IGNORE INTO payments (payment_id, administratie, processed_at, amount) VALUES (?, ?, ?, ?)').bind(payment.id, administratie, (payment.paidAt ?? deps.today()).slice(0, 10), payment.amount?.value ?? ''),
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
  await authorize(request, row);
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

async function license(request: Request, url: URL, env: Env, deps: Deps): Promise<Response> {
  const administratie = url.searchParams.get('administratie') ?? '';
  if (!UUID.test(administratie)) return json({ fout: 'Onbekende administratie' }, 400);
  const row = await getLicense(env, administratie);
  if (!row || row.months === 0) return json({ fout: 'Geen abonnement gevonden voor deze administratie' }, 404);
  await authorize(request, row);
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

/** Uitkomst van de controle voor de assistent-Worker (RPC via een Service Binding, zie index.ts). */
export type AssistantAuthorization = { ok: true } | { ok: false; reason: 'sleutel' | 'geen-abonnement' | 'quotum' };

/**
 * Mag deze administratie de online hulp (workers/assistent) gebruiken? Alleen met een abonnement dat
 * betaald is t/m vandaag (plus de marge, zoals de licentie), de juiste lokale beheersleutel, en zolang
 * het dagquotum niet op is. Het quotum wordt in één statement opgehoogd, dus ook bij gelijktijdige
 * aanroepen nooit meer dan `dailyLimit`. Een geweigerde aanroep telt niet mee.
 */
export async function authorizeAssistant(env: Pick<Env, 'LICENTIES'>, input: { administratie: string; managementKey: string; today: string; dailyLimit: number }): Promise<AssistantAuthorization> {
  if (!UUID.test(input.administratie) || !MANAGEMENT_KEY.test(input.managementKey)) return { ok: false, reason: 'sleutel' };
  const row = await getLicense(env as Env, input.administratie);
  if (!row || !row.management_key_hash || (await managementKeyHash(input.managementKey)) !== row.management_key_hash) return { ok: false, reason: 'sleutel' };
  if (row.months === 0 || addDays(paidUntil(row), GRACE_DAYS) < input.today) return { ok: false, reason: 'geen-abonnement' };
  const limit = Math.max(0, Math.floor(input.dailyLimit));
  const used = await env.LICENTIES
    .prepare(
      `INSERT INTO assistant_usage (administratie, day, calls) SELECT ?1, ?2, 1 WHERE ?3 > 0
       ON CONFLICT(administratie, day) DO UPDATE SET calls = calls + 1 WHERE calls < ?3`,
    )
    .bind(input.administratie, input.today, limit)
    .run();
  return used.meta.changes === 1 ? { ok: true } : { ok: false, reason: 'quotum' };
}

const STYLE = '<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 16px;line-height:1.5;color:#1b1f24;background:#f6f7f9}</style>';

const THANKS = `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bedankt</title>${STYLE}</head>
<body><h1>Bedankt!</h1><p>Zodra je betaling binnen is, kun je in BoekhoudenVoorNiks op <strong>Ik heb betaald: licentie ophalen</strong> klikken (Hoe gaat het? &gt; Uitwisseling met je boekhouder). Daarna kun je versturen naar je boekhouder. Bij een proefperiode betaal je nu alleen € 0,01 voor de machtiging; de eerste afschrijving is na de gratis maanden. Van elke betaalde maand krijg je een factuur per e-mail.</p>
<p>Je kunt dit venster sluiten.</p></body></html>`;

export async function handle(request: Request, env: Env, deps: Deps): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (request.method === 'GET' && url.pathname === '/prijs') {
      return json({ bedrag: env.PRICE_EXCL_VAT, inclusiefBtw: inclVat(env.PRICE_EXCL_VAT), valuta: 'EUR', per: 'maand', btw: 'exclusief', proefMaanden: trialMonths(env) });
    }
    if (request.method === 'POST' && url.pathname === '/start') return await start(request, env, deps);
    if (request.method === 'POST' && url.pathname === '/mollie') return await webhook(request, env, deps);
    if (request.method === 'GET' && url.pathname === '/licentie') return await license(request, url, env, deps);
    if (request.method === 'POST' && url.pathname === '/opzeggen') return await cancel(request, env, deps);
    if (request.method === 'GET' && url.pathname === '/bedankt') return page(THANKS);
    return json({ fout: 'Niet gevonden' }, 404);
  } catch (e) {
    if (e instanceof BadRequest) return json({ fout: e.message }, 400);
    if (e instanceof Forbidden) return json({ fout: e.message }, 403);
    console.error(JSON.stringify({ route: url.pathname, fout: (e as Error).message }));
    // 500: Mollie probeert een webhook dan opnieuw, en de verwerking is herstelbaar
    return json({ fout: 'Er ging iets mis; probeer het later opnieuw' }, 500);
  }
}
