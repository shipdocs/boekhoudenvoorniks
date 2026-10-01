import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ONLINE_HELP } from '../src/shared/online-help';
import { setup } from './helpers';
import { signLicense } from './license-token';
import { JevClassifier, minimizeJevRequest, parseJevResponse, scrubLine } from '../src/intake/llm-jev';
import { createApi, type HostContext } from '../src/main/api';
import type { FetchLike } from '../src/integrations/types';
import type { OcrProvider } from '../src/intake/ocr';
import { today } from '../src/shared/dates';

/**
 * Online hulp bij categorievoorstellen (JEV via de assistent-Worker, #132): pas na geheugen en regels,
 * alleen met opt-in en abonnement, minimale gegevens, strikte controle van het antwoord, nooit
 * automatisch boeken, en de eindkeuze van de gebruiker voedt het lokale leveranciersgeheugen.
 */

const items = (lines: string[]) => lines.map((text, i) => ({ text, page: 1, bbox: [10, 20 + i * 20, 300, 34 + i * 20] as [number, number, number, number], confidence: 0.97 }));

/** Een onbekende winkel met artikelen die geen vaste regel raken. */
const pennenwinkel = (day: number) => [
  'Pennenwinkel De Vulpen',
  `Datum: ${String(day).padStart(2, '0')}-09-2026`,
  'Notitieblokken A4 10,00',
  'Balpennen blauw 5,00',
  'Subtotaal 15,00',
  'BTW 21% 15,00 3,15',
  'Totaal 18,15',
];
const currentMonth = () => today().slice(0, 7);

type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

function world(opts: { respond?: (call: Call) => { status: number; body: unknown } | 'offline' | 'hang'; license?: 'actief' | 'geen'; optIn?: boolean } = {}) {
  const state = { lines: pennenwinkel(3) };
  const ocr: OcrProvider = { id: 'test', label: 'Test OCR', available: async () => true, recognize: async () => ({ items: items(state.lines) }) };
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' }) as { x: string; d: string };
  const { s, db } = setup({ ocr, licensePublicKey: jwk.x });
  s.settings.update({ onboardingDone: true, ocr: { ...s.settings.get().ocr, onlineCategoryHelp: opts.optIn ?? true } });
  const calls: Call[] = [];
  const respond = opts.respond ?? ((c: Call) => ({ status: 200, body: { schemaVersion: 1, model: 'jev-1.13.0', categoryKey: 'kantoor', confidence: 0.92, probabilities: { kantoor: 0.92, materiaal: 0.05, overig: 0.03 } } }));
  const fetch: FetchLike = async (url, init) => {
    const call = { url, headers: init?.headers ?? {}, body: JSON.parse(init?.body ?? '{}') as Record<string, unknown> };
    calls.push(call);
    const r = respond(call);
    if (r === 'offline') throw new Error('ENOTFOUND');
    if (r === 'hang') return new Promise(() => {});
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => (typeof r.body === 'string' ? JSON.parse(r.body) : r.body), text: async () => JSON.stringify(r.body) };
  };
  // zoals main.ts: per aanroep opnieuw opt-in én licentie controleren
  s.classifier.setLlm(
    new JevClassifier({
      fetch,
      allowed: () => s.settings.get().ocr.onlineCategoryHelp && s.license.status('2026-09-30').state === 'actief',
      credentials: () => ({ administrationId: s.settings.administrationId(), managementKey: s.license.managementKey() }),
      appVersion: '0.7.0',
      timeoutMs: 50,
    }),
  );
  const install = async () => s.license.install(await signLicense({ v: 1, product: 'uitwisseling', administratie: s.settings.administrationId(), email: 'piet@example.nl', validUntil: '2099-12-31', issuedAt: '2026-09-30' }, JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: jwk.x, d: jwk.d })), '2026-09-30');
  const api = createApi(s, { appVersion: () => '0.7.0', reconfigureLocalAi: () => {}, hasSmtpPassword: () => false } as unknown as HostContext);
  const add = async (name: string, lines = pennenwinkel(3)) => {
    state.lines = lines;
    return s.intake.add(name, new Uint8Array([name.length, ...Buffer.from(name)]), '2026-09-30');
  };
  const stats = () => db.prepare('SELECT proposed_by, model, accepted, corrected FROM proposal_stats ORDER BY proposed_by').all();
  return { s, db, api, calls, add, stats, install: opts.license === 'geen' ? async () => {} : install };
}

describe('JEV: minimaal verzoek en strikte controle', () => {
  it('haalt bedragen, IBAN, e-mail en lange nummers uit artikelregels', () => {
    expect(scrubLine('Schroeven 4x40 € 12,50')).toBe('Schroeven 4x40');
    expect(scrubLine('Betaald met NL91 ABNA 0417 1643 00 op 12-09')).toBe('Betaald met op 12-09');
    expect(scrubLine('Vragen? info@winkel.nl')).toBe('Vragen?');
    expect(scrubLine('Klantnr 123456789 Tape')).toBe('Klantnr Tape');
    expect(scrubLine('Balpennen blauw 5,00')).toBe('Balpennen blauw');
    expect(scrubLine('BTW-nummer NL123456789B01 Tape 12 EUR')).toBe('');
    expect(scrubLine('VAT ID DE 123 456 789 Hosting')).toBe('');
    expect(scrubLine('NL123456789B01 Tape 12 EUR')).toBe('Tape');
  });

  it('stuurt alleen de afgesproken velden, begrensd', () => {
    const req = minimizeJevRequest({
      administrationId: 'a',
      appVersion: '0.7.0',
      supplier: 'Winkel',
      lines: Array.from({ length: 30 }, (_, i) => `Artikel ${i} ${'x'.repeat(200)} 3,50`),
      categories: [{ key: 'kantoor', label: 'Kantoor', hint: 'papier' }],
    });
    expect(Object.keys(req).sort()).toEqual(['administrationId', 'appVersion', 'categories', 'lines', 'schemaVersion', 'supplier']);
    expect(req.lines).toHaveLength(15);
    expect(req.lines.every((l) => l.length <= 120 && !l.includes('3,50'))).toBe(true);
  });

  it('weigert elk antwoord dat niet precies klopt', () => {
    const cats = [{ key: 'kantoor', label: 'Kantoor', hint: '' }, { key: 'overig', label: 'Overig', hint: '' }];
    const ok = { schemaVersion: 1, model: 'jev-1.13.0', categoryKey: 'kantoor', confidence: 0.9, probabilities: { kantoor: 0.9, overig: 0.1 } };
    expect(parseJevResponse(ok, cats)).toMatchObject({ categoryKey: 'kantoor', model: 'jev-1.13.0' });
    expect(parseJevResponse({ ...ok, categoryKey: 'wapens' }, cats)).toBeNull();
    expect(parseJevResponse({ ...ok, schemaVersion: 2 }, cats)).toBeNull();
    expect(parseJevResponse({ ...ok, confidence: 1.5 }, cats)).toBeNull();
    expect(parseJevResponse({ ...ok, confidence: 'NaN' }, cats)).toBeNull();
    expect(parseJevResponse({ ...ok, confidence: Number.NaN }, cats)).toBeNull();
    expect(parseJevResponse({ ...ok, probabilities: { kantoor: 0.9, geheim: 0.1 } }, cats)).toBeNull();
    expect(parseJevResponse({ ...ok, probabilities: undefined }, cats)).toBeNull();
    expect(parseJevResponse({ ...ok, model: undefined }, cats)).toBeNull();
    expect(parseJevResponse({ schemaVersion: 1, model: null, categoryKey: null }, cats)).toBeNull();
    expect(parseJevResponse('kantoor', cats)).toBeNull();
    expect(parseJevResponse(null, cats)).toBeNull();
  });
});

describe('JEV in de documentstroom', () => {
  // standaard beschikbaar (sinds 0.7.4); de test "nog niet beschikbaar" zet de vlag tijdelijk uit
  beforeEach(() => {
    ONLINE_HELP.available = true;
  });
  afterEach(() => {
    ONLINE_HELP.available = true;
  });

  it('vlag uit (bv. als de Worker uit moet): niet aan te zetten, ook niet met abonnement', async () => {
    ONLINE_HELP.available = false;
    const w = world({ optIn: false });
    await w.install();
    expect(() => w.api.settings.update({ ocr: { ...w.s.settings.get().ocr, onlineCategoryHelp: true } })).toThrow(/nog niet beschikbaar/);
    expect(w.s.settings.get().ocr.onlineCategoryHelp).toBe(false);
  });

  it('pas na geheugen en vaste regels; alleen minimale gegevens; afgetopt en nooit automatisch', async () => {
    const w = world();
    await w.install();
    // bekende leverancier (vaste regel): geen aanroep
    const bouwmaat = await w.add('bouwmaat.jpg', ['Bouwmaat Utrecht', 'Datum: 02-09-2026', 'Gips 100,00', 'BTW 21% 100,00 21,00', 'Totaal 121,00']);
    expect(bouwmaat.classification).toMatchObject({ source: 'regel', proposedBy: 'regel' });
    expect(w.calls).toHaveLength(0);

    const d = await w.add('pen.jpg', [...pennenwinkel(3), 'IBAN NL91ABNA0417164300', 'Vragen: info@devulpen.nl']);
    expect(w.calls).toHaveLength(1);
    const call = w.calls[0]!;
    expect(call.url).toBe('https://assistent.boekhoudenvoorniks.nl/v1/classificeren');
    expect(call.headers.Authorization).toBe(`Bearer ${w.s.license.managementKey()}`);
    expect(Object.keys(call.body).sort()).toEqual(['administrationId', 'appVersion', 'categories', 'lines', 'schemaVersion', 'supplier']);
    const sent = JSON.stringify(call.body);
    for (const forbidden of ['18,15', '15,00', '3,15', '1815', 'NL91', 'info@', 'NL123456789B01', 'Kalkweg', 'piet@example.nl']) expect(sent).not.toContain(forbidden);
    expect(call.body.lines).toEqual(expect.arrayContaining(['Notitieblokken A4', 'Balpennen blauw']));

    expect(d.status).toBe('controle');
    expect(d.classification).toMatchObject({ categoryKey: 'kantoor', source: 'llm', proposedBy: 'jev', model: 'jev-1.13.0', automatic: false, confidence: 0.7 });
    expect(d.classification!.reasons.join(' ')).toContain('online hulp koos deze');
    const task = w.s.inbox.tasks('2026-09-30').find((t) => t.ref.documentId === d.id)!;
    expect(task.question).toContain('voorstel van online hulp');
    expect(task.actions.map((a) => a.label)).toEqual(['Ja', 'Aanpassen']);
  });

  it('OK: de eindkeuze gaat naar het leveranciersgeheugen; de volgende bon komt uit het geheugen zonder aanroep', async () => {
    const w = world();
    await w.install();
    const d = await w.add('pen1.jpg');
    const task = w.s.inbox.tasks('2026-09-30').find((t) => t.ref.documentId === d.id)!;
    await w.api.home.act(task, 'klopt');
    expect(w.s.intake.get(d.id).status).toBe('verwerkt');
    expect(w.s.intake.get(d.id).classification).toMatchObject({ proposedBy: 'jev', accepted: { categoryKey: 'kantoor', corrected: false } });
    expect(w.s.memory.get('Pennenwinkel De Vulpen')).toMatchObject({ category_key: 'kantoor', confirmations: 1 });
    expect(w.stats()).toEqual([{ proposed_by: 'jev', model: 'jev-1.13.0', accepted: 1, corrected: 0 }]);
    // wat de gebruiker deed staat in het logboek, met wie het voorstel deed
    expect(w.s.inbox.month(currentMonth(), '2026-09-30').byUser[0]!.reason).toContain('online hulp');

    const d2 = await w.add('pen2.jpg', pennenwinkel(10));
    expect(w.calls).toHaveLength(1);
    expect(d2.classification).toMatchObject({ categoryKey: 'kantoor', source: 'geheugen', proposedBy: 'geheugen', automatic: false });
    // één geaccepteerde JEV-suggestie maakt nooit een automatische regel
    expect(w.s.memory.isAutomatic(w.s.memory.get('Pennenwinkel De Vulpen'))).toBe(false);
  });

  it('Aanpassen: de aangepaste keuze wint en telt als correctie van JEV; bekijken of een mislukte verwerking verandert niets', async () => {
    const w = world();
    await w.install();
    const d = await w.add('pen1.jpg');
    const task = w.s.inbox.tasks('2026-09-30').find((t) => t.ref.documentId === d.id)!;
    // "Aanpassen" opent alleen het scherm
    expect(await w.api.home.act(task, 'open')).toEqual({ navigate: { screen: 'document', id: d.id } });
    expect(w.s.memory.get('Pennenwinkel De Vulpen')).toBeNull();
    // mislukte verwerking (geen bedrag): geen geheugen, geen teller
    expect(() => w.s.intake.confirm(d.id, { supplier: 'Pennenwinkel De Vulpen', date: '2026-09-03', total: 0, categoryKey: 'overig', vatCode: 'hoog', business: true, paidWith: 'kas' })).toThrow();
    expect(w.s.memory.get('Pennenwinkel De Vulpen')).toBeNull();
    expect(w.stats()).toEqual([]);

    w.s.intake.confirm(d.id, { supplier: 'Pennenwinkel De Vulpen', date: '2026-09-03', total: 1815, categoryKey: 'overig', vatCode: 'hoog', business: true, paidWith: 'kas' });
    expect(w.s.memory.get('Pennenwinkel De Vulpen')).toMatchObject({ category_key: 'overig' });
    expect(w.stats()).toEqual([{ proposed_by: 'jev', model: 'jev-1.13.0', accepted: 0, corrected: 1 }]);
    expect(w.s.inbox.month(currentMonth(), '2026-09-30').byUser[0]).toMatchObject({ summary: expect.stringContaining('aangepast'), reason: expect.stringContaining('jij koos overig') });

    const d2 = await w.add('pen2.jpg', pennenwinkel(10));
    expect(d2.classification).toMatchObject({ categoryKey: 'overig', source: 'geheugen' });
    expect(w.calls).toHaveLength(1);
  });

  it('een correctie zet een automatische leverancier weer uit', async () => {
    const w = world();
    await w.install();
    for (const day of [3, 10, 17]) {
      const d = await w.add(`pen${day}.jpg`, pennenwinkel(day));
      w.s.intake.confirm(d.id, { supplier: 'Pennenwinkel De Vulpen', date: `2026-09-${String(day).padStart(2, '0')}`, total: 1815, categoryKey: 'kantoor', vatCode: 'hoog', business: true, paidWith: 'kas' });
    }
    w.s.memory.setAutomatic(w.s.memory.get('Pennenwinkel De Vulpen')!.supplier_key, true);
    const d = await w.add('pen24.jpg', pennenwinkel(24));
    expect(d.classification).toMatchObject({ source: 'geheugen', automatic: true });
    expect(w.calls).toHaveLength(1);
    // de gebruiker kiest toch iets anders: correctie, automatisch staat weer uit
    w.s.intake.confirm(d.id, { supplier: 'Pennenwinkel De Vulpen', date: '2026-09-24', total: 1815, categoryKey: 'overig', vatCode: 'hoog', business: true, paidWith: 'kas' });
    expect(w.s.memory.get('Pennenwinkel De Vulpen')).toMatchObject({ category_key: 'overig', corrections: 1, auto_approved: 0 });
    expect(w.s.memory.isAutomatic(w.s.memory.get('Pennenwinkel De Vulpen'))).toBe(false);
  });

  it('"Ja" boekt alleen het getoonde voorstel: een intussen gewijzigd voorstel wordt geweigerd, dubbel klikken boekt niet dubbel', async () => {
    const w = world();
    await w.install();
    const d = await w.add('pen1.jpg');
    const task = w.s.inbox.tasks('2026-09-30').find((t) => t.ref.documentId === d.id)!;
    const stale = { ...task, ref: { ...task.ref, proposal: 'materiaal|hoog|zakelijk|-' } };
    await expect(w.api.home.act(stale, 'klopt')).rejects.toThrow(/intussen veranderd/);
    expect(w.s.intake.get(d.id).status).toBe('controle');
    expect(w.s.memory.get('Pennenwinkel De Vulpen')).toBeNull();
    const current = w.s.intake.get(d.id);
    w.db.prepare('UPDATE documents SET result = ? WHERE id = ?').run(JSON.stringify({ ...current.result, total: { ...current.result!.total!, value: 9999 } }), d.id);
    await expect(w.api.home.act(task, 'klopt')).rejects.toThrow(/intussen veranderd/);
    w.db.prepare('UPDATE documents SET result = ? WHERE id = ?').run(JSON.stringify(current.result), d.id);
    await w.api.home.act(task, 'klopt');
    await expect(w.api.home.act(task, 'klopt')).rejects.toThrow(/al verwerkt/);
    expect(w.stats()).toEqual([{ proposed_by: 'jev', model: 'jev-1.13.0', accepted: 1, corrected: 0 }]);
  });

  it.each([
    ['offline', () => 'offline' as const],
    ['time-out', () => 'hang' as const],
    ['401', () => ({ status: 401, body: { fout: 'x' } })],
    ['402 (geen abonnement)', () => ({ status: 402, body: { fout: 'x' } })],
    ['403', () => ({ status: 403, body: { fout: 'x' } })],
    ['429', () => ({ status: 429, body: { fout: 'x' } })],
    ['500', () => ({ status: 500, body: { fout: 'x' } })],
    ['503 (kill switch)', () => ({ status: 503, body: { fout: 'x' } })],
    ['geen voorstel', () => ({ status: 200, body: { schemaVersion: 1, model: 'jev-1.13.0', categoryKey: null } })],
    ['onbekende categorie', () => ({ status: 200, body: { schemaVersion: 1, model: 'jev-1.13.0', categoryKey: 'wapens', confidence: 0.9, probabilities: {} } })],
    ['te weinig zekerheid', () => ({ status: 200, body: { schemaVersion: 1, model: 'jev-1.13.0', categoryKey: 'kantoor', confidence: 0.3, probabilities: { kantoor: 0.3 } } })],
    ['kapotte JSON', () => ({ status: 200, body: '{"schemaVersion":' })],
  ])('%s: de gewone flow werkt door met de standaardcategorie', async (_name, respond) => {
    const w = world({ respond: respond as never });
    await w.install();
    const d = await w.add('pen1.jpg');
    expect(w.calls).toHaveLength(1);
    expect(d.status).toBe('controle');
    expect(d.classification).toMatchObject({ categoryKey: 'overig', source: 'standaard', proposedBy: 'standaard' });
  });

  it('opt-out of geen abonnement: geen netwerkverzoek; aanzetten kan alleen met abonnement', async () => {
    const off = world({ optIn: false });
    await off.install();
    await off.add('pen1.jpg');
    expect(off.calls).toHaveLength(0);

    const noLicense = world({ license: 'geen' });
    await noLicense.add('pen1.jpg');
    expect(noLicense.calls).toHaveLength(0);

    const fresh = world({ optIn: false, license: 'geen' });
    expect(() => fresh.api.settings.update({ ocr: { ...fresh.s.settings.get().ocr, onlineCategoryHelp: true } })).toThrow(/extra functie van het abonnement/);
    expect(fresh.s.settings.get().ocr.onlineCategoryHelp).toBe(false);
    // uitzetten kan altijd
    const on = world({ license: 'geen' });
    on.api.settings.update({ ocr: { ...on.s.settings.get().ocr, onlineCategoryHelp: false } });
    expect(on.s.settings.get().ocr.onlineCategoryHelp).toBe(false);
  });
});

describe('JEV-benchmarkset (fase 0)', () => {
  it('synthetisch, met voor elk geval een bestaande categorie en alle soorten gevallen', async () => {
    const { readFileSync } = await import('node:fs');
    const set = JSON.parse(readFileSync(new URL('./fixtures/jev-benchmark.json', import.meta.url), 'utf8')) as { gevallen: { verwacht: string; soort: string; artikelen: string[] }[] };
    const { s } = setup();
    const keys = new Set(s.categories.list().map((c) => c.key));
    expect(set.gevallen.length).toBeGreaterThanOrEqual(40);
    for (const g of set.gevallen) expect(keys.has(g.verwacht), g.verwacht).toBe(true);
    expect(new Set(set.gevallen.map((g) => g.soort))).toEqual(new Set(['bekend', 'onbekend', 'gemengd', 'misleidend', 'weinig-info']));
    // wat de benchmark naar JEV stuurt, is wat de app ook zou sturen: geen bedragen of IBAN
    for (const g of set.gevallen) for (const a of g.artikelen) expect(scrubLine(a)).toBe(a.replace(/\s+/g, ' ').trim());
  });
});
