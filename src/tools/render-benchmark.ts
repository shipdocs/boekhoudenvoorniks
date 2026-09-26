/**
 * Maakt de synthetische benchmarkset (#8) als afbeeldingen: per document een .jpg (zoals een
 * telefoonfoto) en een .json met de juiste waarden, klaar voor ocr-benchmark.ts.
 *
 * Er verschijnt kort een venster (verborgen vensters worden niet getekend).
 *
 * Gebruik (Electron zit al in de ontwikkelomgeving):
 *   npm run build:main
 *   npx electron dist/main/tools/render-benchmark.js ./benchmark-synthetisch 200
 */
import { app, BrowserWindow } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateDocs } from './synthetic-receipts';

async function main() {
  const [dir = 'benchmark-synthetisch', countArg = '200', seedArg = '2026'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  mkdirSync(dir, { recursive: true });
  await app.whenReady();
  const win = new BrowserWindow({ show: true, x: 0, y: 0, width: 800, height: 1400, title: 'Benchmark maken…' });
  const docs = generateDocs(Number(countArg), Number(seedArg));
  for (const d of docs) {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(d.html)}`);
    const size = (await win.webContents.executeJavaScript('({ w: document.body.scrollWidth + 40, h: document.body.scrollHeight + 40 })', true).catch(() => null)) as { w: number; h: number } | null;
    const image = await win.webContents.capturePage(size ? { x: 0, y: 0, width: Math.min(800, size.w), height: Math.min(1400, size.h) } : undefined);
    writeFileSync(join(dir, `${d.id}.jpg`), image.toJPEG(d.distortion === 'weinig-contrast' ? 55 : 80));
    writeFileSync(join(dir, `${d.id}.json`), JSON.stringify({ ...d.truth, kind: d.kind, distortion: d.distortion }, null, 2));
  }
  console.log(`${docs.length} documenten in ${dir}`);
  app.quit();
}

void main();
