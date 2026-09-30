/**
 * Assistent-Worker van BoekhoudenVoorNiks (#132, docs/jev-assistent.md): online hulp bij
 * categorievoorstellen. Eén smalle route, geen generieke "voer een AI-opdracht uit":
 *
 *   POST /v1/classificeren   (JSON, Bearer = lokale beheersleutel) → JEV kiest één categorie uit de
 *                            meegestuurde lijst, met zekerheid en kansen; of "geen voorstel"
 *
 * Alleen voor een administratie met een actief abonnement: dat, de beheersleutel en het dagquotum
 * controleert de licentie-Worker (Service Binding LICENTIE). JEV loopt via AI Gateway zonder cache en
 * zonder logging van de inhoud. Wij loggen alleen status, versies en een latency-bucket: nooit de
 * inhoud, de sleutel of het administratie-ID.
 */

export const SCHEMA_VERSION = 1;
export const MAX_BODY_BYTES = 16 * 1024;
export const MAX_LINES = 15;
export const MAX_LINE_LENGTH = 120;
export const MAX_SUPPLIER_LENGTH = 100;
export const MAX_CATEGORIES = 60;
const CATEGORY_KEY = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MANAGEMENT_KEY = /^[A-Za-z0-9_-]{43}$/;
const QUESTION = 'categorie';

/** De Workers AI-functie die we gebruiken (binding AI). */
export interface AiBinding {
  run(model: string, inputs: Record<string, unknown>, options: { gateway: { id: string; skipCache: boolean; collectLog: boolean } }): Promise<unknown>;
}
/** Workers Rate Limiting (binding PER_ADMINISTRATIE). */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}
/** RPC-entrypoint `Controle` van de licentie-Worker (Service Binding LICENTIE). */
export interface LicentieControle {
  assistent(input: { administratie: string; managementKey: string; today: string; dailyLimit: number }): Promise<{ ok: true } | { ok: false; reason: 'sleutel' | 'geen-abonnement' | 'quotum' }>;
}

export interface Env {
  AI: AiBinding;
  LICENTIE: LicentieControle;
  PER_ADMINISTRATIE: RateLimiter;
  /** var: kill switch; alleen "true" = aan */
  ENABLED?: string;
  /** var: naam van de AI Gateway */
  GATEWAY_ID: string;
  /** var: model, standaard typesafe/jev */
  MODEL?: string;
  /** var: aanroepen per administratie per dag */
  DAILY_QUOTA?: string;
  /** var: time-out naar het model in ms */
  TIMEOUT_MS?: string;
}

export interface Deps {
  /** vandaag, JJJJ-MM-DD */
  today: () => string;
  /** nu in ms (latency) */
  now: () => number;
  /** operationeel log (één regel JSON); standaard console.log */
  log?: (line: string) => void;
}

export interface ClassifyRequest {
  schemaVersion: 1;
  administrationId: string;
  appVersion: string;
  supplier: string | null;
  lines: string[];
  categories: { key: string; label: string; hint: string }[];
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

const str = (v: unknown, max: number, field: string): string => {
  if (typeof v !== 'string') throw new HttpError(400, `${field} ontbreekt`);
  const s = v.trim();
  if (s.length > max) throw new HttpError(400, `${field} is te lang`);
  return s;
};

/** Strikt: onbekende velden, te veel of te lange waarden = 400. */
export function parseRequest(raw: unknown): ClassifyRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'Ongeldig verzoek');
  const b = raw as Record<string, unknown>;
  const allowed = new Set(['schemaVersion', 'administrationId', 'appVersion', 'supplier', 'lines', 'categories']);
  if (Object.keys(b).some((k) => !allowed.has(k))) throw new HttpError(400, 'Onbekend veld in het verzoek');
  if (b.schemaVersion !== SCHEMA_VERSION) throw new HttpError(400, 'Onbekende schemaversie; werk de app bij');
  const administrationId = str(b.administrationId, 36, 'administrationId');
  if (!UUID.test(administrationId)) throw new HttpError(400, 'Onbekende administratie');
  const appVersion = str(b.appVersion, 32, 'appVersion');
  const supplier = b.supplier === null ? null : str(b.supplier, MAX_SUPPLIER_LENGTH, 'supplier') || null;
  if (!Array.isArray(b.lines) || b.lines.length > MAX_LINES) throw new HttpError(400, `Maximaal ${MAX_LINES} regels`);
  const lines = b.lines.map((l, i) => str(l, MAX_LINE_LENGTH, `lines[${i}]`)).filter(Boolean);
  if (!Array.isArray(b.categories) || b.categories.length === 0 || b.categories.length > MAX_CATEGORIES) throw new HttpError(400, `1 tot ${MAX_CATEGORIES} categorieën`);
  const seen = new Set<string>();
  const categories = b.categories.map((c, i) => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw new HttpError(400, `categories[${i}] ongeldig`);
    const o = c as Record<string, unknown>;
    const key = str(o.key, 40, `categories[${i}].key`);
    if (!CATEGORY_KEY.test(key) || seen.has(key)) throw new HttpError(400, `categories[${i}].key ongeldig of dubbel`);
    seen.add(key);
    return { key, label: str(o.label, 80, `categories[${i}].label`), hint: o.hint === undefined ? '' : str(o.hint, 200, `categories[${i}].hint`) };
  });
  if (!supplier && lines.length === 0) throw new HttpError(400, 'Geen leverancier en geen artikelen');
  return { schemaVersion: 1, administrationId, appVersion, supplier, lines, categories };
}

/** De vraag aan JEV: één gesloten `choice`, met als opties uitsluitend de meegestuurde categorieën. */
export function jevInput(req: ClassifyRequest): Record<string, unknown> {
  return {
    state: { leverancier: req.supplier ?? 'onbekend', artikelen: req.lines },
    questions: {
      [QUESTION]: {
        type: 'choice',
        instructions: 'In welke kostencategorie hoort deze aankoop van een Nederlandse zzp-ondernemer? Kies precies één categorie.',
        criteria: Object.fromEntries(req.categories.map((c) => [c.key, c.hint ? `${c.label}: ${c.hint}` : c.label])),
      },
    },
  };
}

export type Proposal = { categoryKey: string; confidence: number; probabilities: Record<string, number>; model: string };

const isProb = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;

/** Controleert het antwoord van JEV opnieuw; alles wat niet klopt = null (geen voorstel). */
export function parseJevOutput(out: unknown, req: ClassifyRequest): Proposal | null {
  if (!out || typeof out !== 'object') return null;
  const o = out as { model?: unknown; answers?: Record<string, unknown> };
  const a = o.answers?.[QUESTION] as { type?: unknown; choice?: unknown; confidence?: unknown; probabilities?: unknown } | undefined;
  if (!a || a.type !== 'choice' || typeof a.choice !== 'string') return null;
  const keys = new Set(req.categories.map((c) => c.key));
  if (!keys.has(a.choice) || !isProb(a.confidence)) return null;
  if (!a.probabilities || typeof a.probabilities !== 'object' || Array.isArray(a.probabilities)) return null;
  const probabilities: Record<string, number> = {};
  for (const [k, v] of Object.entries(a.probabilities as Record<string, unknown>)) {
    if (!keys.has(k) || !isProb(v)) return null;
    probabilities[k] = v;
  }
  return { categoryKey: a.choice, confidence: a.confidence, probabilities, model: typeof o.model === 'string' && o.model ? o.model.slice(0, 60) : 'onbekend' };
}

const latencyBucket = (ms: number) => (ms < 250 ? '<250ms' : ms < 1000 ? '<1s' : ms < 3000 ? '<3s' : ms < 8000 ? '<8s' : '>=8s');

async function readBody(request: Request): Promise<unknown> {
  if (Number(request.headers.get('content-length') ?? '0') > MAX_BODY_BYTES) throw new HttpError(413, 'Verzoek te groot');
  const buf = await request.arrayBuffer();
  if (buf.byteLength > MAX_BODY_BYTES) throw new HttpError(413, 'Verzoek te groot');
  try {
    return JSON.parse(new TextDecoder().decode(buf)) as unknown;
  } catch {
    throw new HttpError(400, 'Ongeldig verzoek');
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new HttpError(504, 'Het model reageerde niet op tijd')), ms)))]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function classify(request: Request, env: Env, deps: Deps, meta: Record<string, unknown>): Promise<Response> {
  if (env.ENABLED !== 'true') throw new HttpError(503, 'Online hulp staat tijdelijk uit');
  const managementKey = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1] ?? '';
  if (!MANAGEMENT_KEY.test(managementKey)) throw new HttpError(401, 'Geen geldige sleutel');
  const req = parseRequest(await readBody(request));
  meta.appVersion = req.appVersion;
  meta.categories = req.categories.length;
  meta.lines = req.lines.length;

  // eerst goedkoop per administratie begrenzen, dan de licentie en het dagquotum
  const { success } = await env.PER_ADMINISTRATIE.limit({ key: req.administrationId });
  if (!success) throw new HttpError(429, 'Te veel verzoeken; probeer het zo opnieuw');
  const auth = await env.LICENTIE.assistent({ administratie: req.administrationId, managementKey, today: deps.today(), dailyLimit: Number(env.DAILY_QUOTA ?? '200') || 0 });
  if (!auth.ok) {
    if (auth.reason === 'quotum') throw new HttpError(429, 'Het maximum voor vandaag is bereikt');
    if (auth.reason === 'geen-abonnement') throw new HttpError(402, 'Online hulp hoort bij het abonnement');
    throw new HttpError(401, 'Geen geldige sleutel');
  }

  let out: unknown;
  try {
    // geen metadata: het administratie-ID komt niet in AI Gateway
    out = await withTimeout(env.AI.run(env.MODEL || 'typesafe/jev', jevInput(req), { gateway: { id: env.GATEWAY_ID, skipCache: true, collectLog: false } }), Number(env.TIMEOUT_MS ?? '6000') || 6000);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, 'Het model gaf een fout');
  }
  const proposal = parseJevOutput(out, req);
  meta.model = proposal?.model ?? (typeof (out as { model?: unknown })?.model === 'string' ? (out as { model: string }).model.slice(0, 60) : null);
  meta.voorstel = proposal !== null;
  if (!proposal) return json({ schemaVersion: SCHEMA_VERSION, model: meta.model ?? null, categoryKey: null });
  return json({ schemaVersion: SCHEMA_VERSION, ...proposal });
}

export async function handle(request: Request, env: Env, deps: Deps): Promise<Response> {
  const url = new URL(request.url);
  const started = deps.now();
  const meta: Record<string, unknown> = { route: url.pathname, schemaVersion: SCHEMA_VERSION };
  let response: Response;
  try {
    if (request.method === 'POST' && url.pathname === '/v1/classificeren') response = await classify(request, env, deps, meta);
    else response = json({ fout: 'Niet gevonden' }, 404);
  } catch (e) {
    if (e instanceof HttpError) response = json({ fout: e.message }, e.status);
    else {
      meta.fout = 'intern';
      response = json({ fout: 'Er ging iets mis; probeer het later opnieuw' }, 500);
    }
  }
  // alleen niet-herleidbare operationele gegevens: geen inhoud, sleutel of administratie-ID
  (deps.log ?? console.log)(JSON.stringify({ ...meta, status: response.status, latency: latencyBucket(deps.now() - started) }));
  return response;
}
