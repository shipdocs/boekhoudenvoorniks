/**
 * OCR-benchmark: meet hoe goed een OCR-engine Nederlandse bonnen/facturen leest.
 *
 * Gebruik:
 *   npm run build:main
 *   node dist/main/tools/ocr-benchmark.js <map-met-documenten> [ocr-url] [engine-naam]
 *
 * Engine "llamacpp:glm-ocr" praat met een llama-server (de ingebouwde herkenning), bv.
 *   llama-server -hf ggml-org/GLM-OCR-GGUF:Q8_0 --port 8080
 *   node dist/main/tools/ocr-benchmark.js ./benchmark http://127.0.0.1:8080 llamacpp:glm-ocr
 * Een synthetische set maak je met render-benchmark.ts (zie docs/ocr-benchmark.md).
 *
 * De map bevat per document een bestand (jpg/png/pdf/xml) en een gelijknamig .json met de juiste waarden:
 *   { "supplier": "Bouwmaat", "date": "2026-09-23", "total": 121.00, "vat": [{ "rate": 21, "amount": 21.00 }] }
 *
 * Uitvoer: nauwkeurigheid per veld, gemiddelde tijd per document, en per document de afwijkingen.
 */
import { readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from '../db/database';
import { createServices, MemorySecretStore } from '../services';
import { HttpOcrProvider } from '../intake/ocr';
import { LlamaCppOcrProvider } from '../intake/ocr-llamacpp';
import { scoreDocument } from './benchmark-score';
import type { Truth } from './synthetic-receipts';


async function main() {
  const [dir, ocrUrl, engine = 'ocr'] = process.argv.slice(2);
  if (!dir) {
    console.error('Gebruik: node dist/main/tools/ocr-benchmark.js <map> [ocr-url] [engine]');
    process.exit(1);
  }
  const db = new Database(':memory:');
  migrate(db);
  const s = createServices(db, {
    pdf: async () => Buffer.alloc(0),
    mailerFactory: async () => { throw new Error('geen mail'); },
    secrets: new MemorySecretStore(),
    fetch: (url, init) => fetch(url, init),
    storeFile: async (name) => name,
    // engine "llamacpp:<naam>" = een llama-server (zoals de ingebouwde herkenning), anders de sidecar-API
    ocr: !ocrUrl ? null : engine.startsWith('llamacpp') ? new LlamaCppOcrProvider(engine, ocrUrl, (url, init) => fetch(url, init)) : new HttpOcrProvider(engine, ocrUrl, (url, init) => fetch(url, init)),
  });
  const files = readdirSync(dir).filter((f) => ['.jpg', '.jpeg', '.png', '.webp', '.pdf', '.xml'].includes(extname(f).toLowerCase()));
  const score: Record<'supplier' | 'date' | 'total' | 'vat', [number, number]> = { supplier: [0, 0], date: [0, 0], total: [0, 0], vat: [0, 0] };
  const rows: string[] = [];
  let totalMs = 0;
  for (const f of files) {
    const truthPath = join(dir, basename(f, extname(f)) + '.json');
    if (!existsSync(truthPath)) continue;
    const truth = JSON.parse(readFileSync(truthPath, 'utf8')) as Partial<Truth>;
    const started = Date.now();
    let res;
    try {
      res = await s.intake.extract(f, new Uint8Array(readFileSync(join(dir, f))));
    } catch (e) {
      rows.push(`${f}: FOUT ${(e as Error).message}`);
      continue;
    }
    totalMs += Date.now() - started;
    const r = res.result;
    const { fields, diffs } = scoreDocument(r, truth);
    for (const [k, ok] of Object.entries(fields) as [keyof typeof score, boolean][]) {
      score[k][1]++;
      if (ok) score[k][0]++;
    }
    rows.push(`${f} [${res.source}]: ${diffs.length ? diffs.join('; ') : 'OK'}`);
  }
  const pct = ([a, b]: [number, number]) => (b ? `${Math.round((a / b) * 1000) / 10}% (${a}/${b})` : '—');
  const report = [
    `OCR-benchmark — engine: ${ocrUrl ? engine : 'geen (alleen UBL/PDF-tekst)'}`,
    `Documenten: ${rows.length}, gemiddeld ${rows.length ? Math.round(totalMs / rows.length) : 0} ms per document`,
    `Leverancier: ${pct(score.supplier)}`,
    `Datum:       ${pct(score.date)}`,
    `Totaal:      ${pct(score.total)}`,
    `BTW:         ${pct(score.vat)}`,
    '',
    ...rows,
  ].join('\n');
  console.log(report);
  writeFileSync(join(dir, `benchmark-${engine}-${new Date().toISOString().slice(0, 10)}.txt`), report);
}

void main();
