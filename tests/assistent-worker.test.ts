import { describe, expect, it } from 'vitest';
import { handle, MAX_BODY_BYTES, type Env, type LicentieControle } from '../workers/assistent/src/app';

/**
 * Assistent-Worker (workers/assistent, #132): auth via de licentie-Worker, strikte invoer, kill switch,
 * rate limit, JEV via AI Gateway zonder cache/logs/metadata, strikte controle van het antwoord, en logs
 * zonder inhoud, sleutel of administratie-ID.
 */

const ADMIN = '11111111-2222-4333-8444-555555555555';
const KEY = 'Q'.repeat(43);
const CATS = [
  { key: 'kantoor', label: 'Kantoorartikelen', hint: 'papier, pennen' },
  { key: 'materiaal', label: 'Materiaal', hint: 'bouwmateriaal' },
  { key: 'overig', label: 'Overig', hint: '' },
];
const body = (over: Record<string, unknown> = {}) => ({ schemaVersion: 1, administrationId: ADMIN, appVersion: '0.7.0', supplier: 'Pennenwinkel De Vulpen', lines: ['Notitieblokken A4', 'Balpennen blauw'], categories: CATS, ...over });
const JEV_OK = {
  model: 'jev-1.13.0',
  answers: { categorie: { type: 'choice', choice: 'kantoor', confidence: 0.93, probabilities: { kantoor: 0.93, materiaal: 0.04, overig: 0.03 } } },
  usage: { input_tokens: 380, output_tokens: 45 },
};

function worker(opts: { ai?: (model: string, inputs: Record<string, unknown>, options: unknown) => Promise<unknown>; auth?: Awaited<ReturnType<LicentieControle['assistent']>>; rate?: boolean; env?: Partial<Env> } = {}) {
  const aiCalls: { model: string; inputs: Record<string, unknown>; options: unknown }[] = [];
  const authCalls: unknown[] = [];
  const rateKeys: string[] = [];
  const logs: string[] = [];
  const env: Env = {
    ENABLED: 'true',
    GATEWAY_ID: 'boekhoudenvoorniks-assistent',
    MODEL: 'typesafe/jev',
    DAILY_QUOTA: '200',
    TIMEOUT_MS: '50',
    AI: {
      run: async (model, inputs, options) => {
        aiCalls.push({ model, inputs, options });
        return opts.ai ? opts.ai(model, inputs, options) : JEV_OK;
      },
    },
    LICENTIE: {
      assistent: async (input) => {
        authCalls.push(input);
        return opts.auth ?? { ok: true };
      },
    },
    PER_ADMINISTRATIE: {
      limit: async ({ key }) => {
        rateKeys.push(key);
        return { success: opts.rate ?? true };
      },
    },
    ...opts.env,
  };
  const call = async (b: unknown, headers: Record<string, string> = { authorization: `Bearer ${KEY}` }, path = '/v1/classificeren', method = 'POST') => {
    const res = await handle(new Request(`https://assistent.boekhoudenvoorniks.nl${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: method === 'POST' ? (typeof b === 'string' ? b : JSON.stringify(b)) : undefined }), env, {
      today: () => '2026-10-15',
      now: () => 0,
      log: (l) => void logs.push(l),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  return { call, aiCalls, authCalls, rateKeys, logs };
}

describe('assistent-Worker', () => {
  it('geldige vraag: één gesloten JEV-keuze uit precies de meegestuurde categorieën, via de Gateway zonder cache, logs of metadata', async () => {
    const w = worker();
    const r = await w.call(body());
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ schemaVersion: 1, categoryKey: 'kantoor', confidence: 0.93, probabilities: { kantoor: 0.93, materiaal: 0.04, overig: 0.03 }, model: 'jev-1.13.0' });
    expect(w.authCalls).toEqual([{ administratie: ADMIN, managementKey: KEY, today: '2026-10-15', dailyLimit: 200 }]);
    expect(w.rateKeys).toHaveLength(1);
    expect(w.rateKeys[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(w.rateKeys[0]).not.toContain(ADMIN);
    expect(w.rateKeys[0]).not.toContain(KEY);
    expect(w.aiCalls).toHaveLength(1);
    const { model, inputs, options } = w.aiCalls[0]!;
    expect(model).toBe('typesafe/jev');
    expect(options).toEqual({ gateway: { id: 'boekhoudenvoorniks-assistent', skipCache: true, collectLog: false } });
    expect(inputs.state).toEqual({ leverancier: 'Pennenwinkel De Vulpen', artikelen: ['Notitieblokken A4', 'Balpennen blauw'] });
    const q = (inputs.questions as Record<string, { type: string; criteria: Record<string, string> }>).categorie!;
    expect(q.type).toBe('choice');
    expect(Object.keys(q.criteria)).toEqual(['kantoor', 'materiaal', 'overig']);
    // geen administratie-ID of sleutel richting het model
    expect(JSON.stringify(w.aiCalls)).not.toContain(ADMIN);
    expect(JSON.stringify(w.aiCalls)).not.toContain(KEY);
  });

  it('auth: ontbrekend, ongeldig, geen abonnement, quotum en rate limit; het model wordt dan niet aangeroepen', async () => {
    expect((await worker().call(body(), {})).status).toBe(401);
    expect((await worker().call(body(), { authorization: 'Bearer kort' })).status).toBe(401);
    expect((await worker({ auth: { ok: false, reason: 'sleutel' } }).call(body())).status).toBe(401);
    expect((await worker({ auth: { ok: false, reason: 'geen-abonnement' } }).call(body())).status).toBe(402);
    expect((await worker({ auth: { ok: false, reason: 'quotum' } }).call(body())).status).toBe(429);
    const limited = worker({ rate: false });
    expect((await limited.call(body())).status).toBe(429);
    expect(limited.authCalls).toHaveLength(0);
    for (const reason of ['sleutel', 'geen-abonnement', 'quotum'] as const) {
      const w = worker({ auth: { ok: false, reason } });
      await w.call(body());
      expect(w.aiCalls).toHaveLength(0);
    }
  });

  it('bindt de minuutlimiet aan de geheime sleutel, zodat een bekende administratie-ID de echte limiet niet kan uitputten', async () => {
    const w = worker();
    await w.call(body());
    await w.call(body(), { authorization: `Bearer ${'R'.repeat(43)}` });
    expect(w.rateKeys).toHaveLength(2);
    expect(w.rateKeys[0]).not.toBe(w.rateKeys[1]);
  });

  it('kill switch: alles behalve ENABLED "true" = 503, zonder licentie- of modelaanroep', async () => {
    for (const ENABLED of ['false', '', undefined, 'TRUE']) {
      const w = worker({ env: { ENABLED } });
      expect((await w.call(body())).status).toBe(503);
      expect(w.authCalls).toHaveLength(0);
      expect(w.aiCalls).toHaveLength(0);
    }
  });

  it('strikte invoer: te groot, te veel of te lange waarden, onbekende velden, dubbele of rare categorieën', async () => {
    const w = worker();
    expect((await w.call('x'.repeat(MAX_BODY_BYTES + 1))).status).toBe(413);
    expect((await w.call('{kapot')).status).toBe(400);
    expect((await w.call(body({ lines: Array.from({ length: 16 }, () => 'a') }))).status).toBe(400);
    expect((await w.call(body({ lines: ['a'.repeat(121)] }))).status).toBe(400);
    expect((await w.call(body({ supplier: 'a'.repeat(101) }))).status).toBe(400);
    expect((await w.call(body({ categories: [] }))).status).toBe(400);
    expect((await w.call(body({ categories: Array.from({ length: 61 }, (_, i) => ({ key: `c${i}`, label: 'x', hint: '' })) }))).status).toBe(400);
    expect((await w.call(body({ categories: [CATS[0], CATS[0]] }))).status).toBe(400);
    expect((await w.call(body({ categories: [{ key: 'Hoofd Letters!', label: 'x', hint: '' }] }))).status).toBe(400);
    expect((await w.call(body({ total: 1815 }))).status).toBe(400);
    expect((await w.call(body({ iban: 'NL91ABNA0417164300' }))).status).toBe(400);
    expect((await w.call(body({ schemaVersion: 2 }))).status).toBe(400);
    expect((await w.call(body({ administrationId: 'niet-een-uuid' }))).status).toBe(400);
    expect((await w.call(body({ supplier: null, lines: [] }))).status).toBe(400);
    expect((await w.call(body(), undefined, '/v1/iets-anders')).status).toBe(404);
    expect((await w.call(body(), undefined, '/v1/classificeren', 'GET')).status).toBe(404);
    expect(w.aiCalls).toHaveLength(0);
  });

  it.each([
    ['onbekende keuze', { ...JEV_OK, answers: { categorie: { ...JEV_OK.answers.categorie, choice: 'wapens' } } }],
    ['ontbrekende kansen', { ...JEV_OK, answers: { categorie: { ...JEV_OK.answers.categorie, probabilities: undefined } } }],
    ['kans met onbekende sleutel', { ...JEV_OK, answers: { categorie: { ...JEV_OK.answers.categorie, probabilities: { geheim: 1 } } } }],
    ['zekerheid buiten 0..1', { ...JEV_OK, answers: { categorie: { ...JEV_OK.answers.categorie, confidence: 7 } } }],
    ['ander soort antwoord', { ...JEV_OK, answers: { categorie: { ...JEV_OK.answers.categorie, type: 'score' } } }],
    ['geen antwoorden', { model: 'jev-1.13.0' }],
    ['tekst', 'kantoor'],
  ])('%s: veilig "geen voorstel"', async (_name, out) => {
    const r = await worker({ ai: async () => out }).call(body());
    expect(r.status).toBe(200);
    expect(r.json.categoryKey).toBeNull();
    expect(r.json.schemaVersion).toBe(1);
  });

  it('time-out en storing van het model: 504 en 502', async () => {
    expect((await worker({ ai: () => new Promise(() => {}) }).call(body())).status).toBe(504);
    expect((await worker({ ai: async () => { throw new Error('upstream 500: interne details'); } }).call(body())).status).toBe(502);
  });

  it('logs: alleen status, versies en latency; nooit inhoud, sleutel of administratie-ID', async () => {
    const w = worker();
    await w.call(body());
    await w.call(body(), { authorization: `Bearer ${'Z'.repeat(43)}` });
    await worker({ ai: async () => { throw new Error('Pennenwinkel'); } }).call(body());
    const failing = worker({ auth: { ok: false, reason: 'geen-abonnement' } });
    await failing.call(body());
    const all = [...w.logs, ...failing.logs].join('\n');
    expect(w.logs).toHaveLength(2);
    expect(JSON.parse(w.logs[0]!)).toEqual({ route: '/v1/classificeren', schemaVersion: 1, appVersion: '0.7.0', categories: 3, lines: 2, model: 'jev-1.13.0', voorstel: true, status: 200, latency: '<250ms' });
    for (const secret of [ADMIN, KEY, 'Z'.repeat(43), 'Pennenwinkel', 'Notitieblokken', 'Balpennen', 'Kantoorartikelen']) expect(all).not.toContain(secret);
  });
});
