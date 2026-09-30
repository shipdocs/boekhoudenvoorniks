/**
 * Benchmark voor online hulp bij categorievoorstellen (#132, fase 0): voegt JEV iets toe boven de
 * vaste regels (en eventueel de lokale AI)?
 *
 * Gebruik:
 *   npm run benchmark:jev                               # alleen de vaste regels
 *   OLLAMA_URL=http://127.0.0.1:11434 OLLAMA_MODEL=qwen2.5:3b npm run benchmark:jev
 *   JEV_ACCOUNT_ID=… JEV_API_TOKEN=… npm run benchmark:jev   # JEV rechtstreeks via de Workers AI REST-API
 *
 * Alleen met de synthetische set (tests/fixtures/jev-benchmark.json); nooit met echte klantdocumenten.
 * Het API-token is alleen voor deze meting en hoort nooit in de app. Optioneel tweede argument: een pad
 * voor de uitkomst als JSON.
 *
 * Gemeten: top-1 en top-2 (goed / alle gevallen; "geen voorstel" telt als fout), dekking (er is een
 * voorstel), precisie binnen de dekking en in de hoge-zekerheidsgroep (≥ 0,7), ongeldige antwoorden,
 * p50/p95-latency, tokens, en voor JEV los de calibratie per zekerheidsband.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { migrate } from '../db/database';
import { CategoryService } from '../settings/categories';
import { SupplierMemory } from '../intake/supplier-memory';
import { Classifier, type LlmClassifier } from '../intake/classify';
import { OllamaClassifier } from '../intake/llm-ollama';
import { minimizeJevRequest } from '../intake/llm-jev';
import type { DocumentResult } from '../intake/types';

interface Case {
  id: number;
  leverancier: string;
  artikelen: string[];
  verwacht: string;
  soort: string;
}

interface Outcome {
  id: number;
  soort: string;
  verwacht: string;
  /** null = geen voorstel (standaard) */
  voorstel: string | null;
  tweede: string | null;
  zekerheid: number | null;
  ongeldig: boolean;
  ms: number;
  tokens: number;
}

type Category = { key: string; label: string; hint: string };

/** Zelfde vraag als workers/assistent/src/app.ts (jevInput). */
function jevInput(supplier: string | null, lines: string[], categories: Category[]) {
  return {
    state: { leverancier: supplier ?? 'onbekend', artikelen: lines },
    questions: {
      categorie: {
        type: 'choice',
        instructions: 'In welke kostencategorie hoort deze aankoop van een Nederlandse zzp-ondernemer? Kies precies één categorie.',
        criteria: Object.fromEntries(categories.map((c) => [c.key, c.hint ? `${c.label}: ${c.hint}` : c.label])),
      },
    },
  };
}

async function jevRaw(accountId: string, token: string, supplier: string | null, lines: string[], categories: Category[]) {
  const started = Date.now();
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/typesafe/jev`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(jevInput(supplier, lines, categories)),
    signal: AbortSignal.timeout(20_000),
  });
  const ms = Date.now() - started;
  const body = (await res.json().catch(() => null)) as { result?: { model?: string; answers?: { categorie?: { choice?: unknown; confidence?: unknown; probabilities?: Record<string, unknown> } }; usage?: { input_tokens?: number } } } | null;
  const a = body?.result?.answers?.categorie;
  const keys = new Set(categories.map((c) => c.key));
  const valid = res.ok && typeof a?.choice === 'string' && keys.has(a.choice) && typeof a.confidence === 'number' && a.confidence >= 0 && a.confidence <= 1;
  const ranked = Object.entries(a?.probabilities ?? {}).filter(([k, v]) => keys.has(k) && typeof v === 'number').sort((x, y) => (y[1] as number) - (x[1] as number));
  return { valid, choice: valid ? (a!.choice as string) : null, second: ranked[1]?.[0] ?? null, confidence: valid ? (a!.confidence as number) : null, ms, tokens: body?.result?.usage?.input_tokens ?? 0, model: body?.result?.model ?? null };
}

const doc = (c: Case): DocumentResult =>
  ({
    documentType: { value: 'bon', confidence: 1, source: 'bench' },
    supplier: { value: c.leverancier, confidence: 1, source: 'bench' },
    supplierVatNumber: null,
    supplierIban: null,
    invoiceNumber: null,
    invoiceDate: { value: '2026-09-30', confidence: 1, source: 'bench' },
    dueDate: null,
    currency: { value: 'EUR', confidence: 1, source: 'bench' },
    subtotal: { value: 5000, confidence: 1, source: 'bench' },
    vat: { value: [{ rate: 21, base: 5000, amount: 1050 }], confidence: 1, source: 'bench' },
    total: { value: 6050, confidence: 1, source: 'bench' },
    lineDescriptions: c.artikelen,
    reverseCharge: false,
    rawText: '',
  }) as unknown as DocumentResult;

function pct(n: number, d: number): string {
  return d === 0 ? '–' : `${Math.round((100 * n) / d)}%`;
}

function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
}

function summarize(name: string, outs: Outcome[]) {
  const n = outs.length;
  const covered = outs.filter((o) => o.voorstel !== null);
  const high = covered.filter((o) => (o.zekerheid ?? 0) >= 0.7);
  const good = (o: Outcome) => o.voorstel === o.verwacht;
  const row = {
    methode: name,
    top1: pct(outs.filter(good).length, n),
    top2: pct(outs.filter((o) => good(o) || o.tweede === o.verwacht).length, n),
    dekking: pct(covered.length, n),
    precisie: pct(covered.filter(good).length, covered.length),
    hoogZeker: `${pct(high.filter(good).length, high.length)} (${high.length})`,
    ongeldig: outs.filter((o) => o.ongeldig).length,
    p50: `${quantile(outs.map((o) => o.ms), 0.5)} ms`,
    p95: `${quantile(outs.map((o) => o.ms), 0.95)} ms`,
    tokens: outs.reduce((s, o) => s + o.tokens, 0),
  };
  return row;
}

async function viaClassifier(cases: Case[], classifier: Classifier): Promise<Outcome[]> {
  const outs: Outcome[] = [];
  for (const c of cases) {
    const started = Date.now();
    const r = await classifier.classify(doc(c));
    outs.push({ id: c.id, soort: c.soort, verwacht: c.verwacht, voorstel: r.source === 'standaard' ? null : r.categoryKey, tweede: null, zekerheid: r.source === 'standaard' ? null : r.confidence, ongeldig: false, ms: Date.now() - started, tokens: 0 });
  }
  return outs;
}

async function main() {
  const [file = 'tests/fixtures/jev-benchmark.json', out] = process.argv.slice(2);
  const cases = (JSON.parse(readFileSync(file, 'utf8')) as { gevallen: Case[] }).gevallen;
  const db = new Database(':memory:');
  migrate(db);
  const categories = new CategoryService(db);
  const cats: Category[] = categories.list().map(({ key, label, hint }) => ({ key, label, hint }));
  const memory = new SupplierMemory(db);
  const results: Record<string, Outcome[]> = {};

  results['regels'] = await viaClassifier(cases, new Classifier(memory, categories));

  if (process.env.OLLAMA_URL && process.env.OLLAMA_MODEL) {
    const ollama = new OllamaClassifier(process.env.OLLAMA_URL, process.env.OLLAMA_MODEL, (url, init) => fetch(url, init));
    results['regels + ollama'] = await viaClassifier(cases, new Classifier(memory, categories, ollama));
  }

  const { JEV_ACCOUNT_ID: account, JEV_API_TOKEN: token } = process.env;
  let model: string | null = null;
  if (account && token) {
    const raw: Outcome[] = [];
    for (const c of cases) {
      // precies wat de app zou versturen (zelfde filter en grenzen)
      const req = minimizeJevRequest({ administrationId: 'benchmark', appVersion: 'benchmark', supplier: c.leverancier, lines: c.artikelen, categories: cats });
      const r = await jevRaw(account, token, req.supplier, req.lines, req.categories).catch(() => ({ valid: false, choice: null, second: null, confidence: null, ms: 20_000, tokens: 0, model: null }));
      model ??= r.model;
      raw.push({ id: c.id, soort: c.soort, verwacht: c.verwacht, voorstel: r.choice, tweede: r.second, zekerheid: r.confidence, ongeldig: !r.valid, ms: r.ms, tokens: r.tokens });
    }
    results['jev los'] = raw;
    // zoals in de app: regels eerst, JEV alleen als die niets weten, met dezelfde ondergrens (0,5)
    const byId = new Map(raw.map((o) => [o.id, o]));
    const combined: LlmClassifier = {
      id: 'jev',
      classify: async (input) => {
        const o = [...byId.values()].find((x) => cases.find((c) => c.id === x.id)!.leverancier === input.supplier);
        return o?.voorstel && (o.zekerheid ?? 0) >= 0.5 ? { categoryKey: o.voorstel, confidence: o.zekerheid!, explanation: '' } : null;
      },
    };
    results['regels + jev'] = (await viaClassifier(cases, new Classifier(memory, categories, combined))).map((o) => ({ ...o, ms: o.ms + (results['regels']!.find((x) => x.id === o.id)!.voorstel === null ? byId.get(o.id)!.ms : 0), tokens: results['regels']!.find((x) => x.id === o.id)!.voorstel === null ? byId.get(o.id)!.tokens : 0 }));
  }

  const rows = Object.entries(results).map(([name, outs]) => summarize(name, outs));
  console.log(`Benchmark categorievoorstellen: ${cases.length} synthetische gevallen (${file})${model ? `, JEV-model ${model}` : ''}\n`);
  console.log('| methode | top-1 | top-2 | dekking | precisie | hoog zeker (n) | ongeldig | p50 | p95 | tokens |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.methode} | ${r.top1} | ${r.top2} | ${r.dekking} | ${r.precisie} | ${r.hoogZeker} | ${r.ongeldig} | ${r.p50} | ${r.p95} | ${r.tokens} |`);

  const soorten = [...new Set(cases.map((c) => c.soort))];
  console.log('\nTop-1 per soort geval:\n');
  console.log(`| methode | ${soorten.join(' | ')} |`);
  console.log(`|---|${soorten.map(() => '---').join('|')}|`);
  for (const [name, outs] of Object.entries(results)) {
    console.log(`| ${name} | ${soorten.map((s) => { const g = outs.filter((o) => o.soort === s); return pct(g.filter((o) => o.voorstel === o.verwacht).length, g.length); }).join(' | ')} |`);
  }

  const jev = results['jev los'];
  if (jev) {
    console.log('\nCalibratie JEV (zekerheid → werkelijk goed):\n');
    for (const [lo, hi] of [[0, 0.5], [0.5, 0.7], [0.7, 0.9], [0.9, 1.01]] as const) {
      const g = jev.filter((o) => o.zekerheid !== null && o.zekerheid >= lo && o.zekerheid < hi);
      console.log(`- ${lo.toFixed(1)}–${Math.min(hi, 1).toFixed(1)}: ${pct(g.filter((o) => o.voorstel === o.verwacht).length, g.length)} goed (${g.length} gevallen)`);
    }
    console.log('\nKosten: vermenigvuldig het tokenaantal hierboven met de actuele JEV-prijs in het Cloudflare-dashboard; de openbare modelpagina noemt geen vast tarief.');
  }
  if (out) writeFileSync(out, JSON.stringify({ file, model, rows, results }, null, 1));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
