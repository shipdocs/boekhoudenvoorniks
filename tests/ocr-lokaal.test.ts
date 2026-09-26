import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { LocalOcrRuntime, type DownloadFetch } from '../src/ocr-runtime/runtime';
import { GLM_OCR, llamaAssetPattern, type OcrModel } from '../src/ocr-runtime/manifest';
import { LlamaCppOcrProvider, textToItems } from '../src/intake/ocr-llamacpp';
import { parseDocumentText } from '../src/intake/text-parser';
import { setup } from './helpers';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const MODEL_A = Buffer.from('model-a'.repeat(1000));
const MODEL_B = Buffer.from('mmproj-b'.repeat(500));
const ARCHIVE = Buffer.from('zip-inhoud');
const model: OcrModel = {
  ...GLM_OCR,
  files: [
    { name: 'a.gguf', url: 'https://hf.example/a.gguf', size: MODEL_A.length, sha256: sha(MODEL_A) },
    { name: 'mmproj-b.gguf', url: 'https://hf.example/b.gguf', size: MODEL_B.length, sha256: sha(MODEL_B) },
  ],
};

function fakeFetch(opts: { corrupt?: boolean; ranges?: string[]; health?: boolean; chat?: (body: unknown) => string } = {}): DownloadFetch & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string, init?: { headers?: Record<string, string>; body?: string; method?: string }) => {
    calls.push(url);
    const bytes = (b: Buffer, status = 200) => ({ ok: true, status, headers: { get: () => null }, body: (async function* () { yield new Uint8Array(b); })(), json: async () => ({}) });
    if (url.includes('api.github.com')) {
      return { ok: true, status: 200, headers: { get: () => null }, body: null, json: async () => ({ tag_name: 'b9999', assets: [
        { name: 'llama-b9999-bin-win-cpu-x64.zip', size: ARCHIVE.length, browser_download_url: 'https://gh.example/win.zip', digest: `sha256:${sha(ARCHIVE)}` },
        { name: 'llama-b9999-bin-ubuntu-x64.zip', size: ARCHIVE.length, browser_download_url: 'https://gh.example/linux.zip', digest: `sha256:${sha(ARCHIVE)}` },
      ] }) };
    }
    if (url.endsWith('.zip')) return bytes(ARCHIVE);
    if (url.endsWith('a.gguf')) {
      const range = init?.headers?.Range;
      if (range) {
        opts.ranges?.push(range);
        const start = Number(/bytes=(\d+)-/.exec(range)![1]);
        return bytes(MODEL_A.subarray(start), 206);
      }
      return bytes(opts.corrupt ? Buffer.from('fout'.repeat(10)) : MODEL_A);
    }
    if (url.endsWith('b.gguf')) return bytes(MODEL_B);
    if (url.endsWith('/health')) return { ok: opts.health ?? true, status: 200, headers: { get: () => null }, body: null, json: async () => ({}) };
    if (url.endsWith('/v1/chat/completions')) {
      const content = opts.chat ? opts.chat(JSON.parse(init!.body!)) : '';
      return { ok: true, status: 200, headers: { get: () => null }, body: null, json: async () => ({ choices: [{ message: { content } }] }), text: async () => '' };
    }
    throw new Error(`onverwacht: ${url}`);
  }) as unknown as DownloadFetch & { calls: string[] };
  fn.calls = calls;
  return fn;
}

const fakeExtract = async (_archive: string, dest: string) => {
  mkdirSync(join(dest, 'build', 'bin'), { recursive: true });
  writeFileSync(join(dest, 'build', 'bin', 'llama-server'), '#!/bin/sh\n');
};

function fakeSpawn() {
  const spawned: { cmd: string; args: string[] }[] = [];
  const spawn = (cmd: string, args: string[]) => {
    spawned.push({ cmd, args });
    const child = new EventEmitter() as unknown as ChildProcess & { exitCode: number | null };
    (child as { exitCode: number | null }).exitCode = null;
    (child as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
    (child as unknown as { kill: () => boolean }).kill = () => {
      (child as { exitCode: number | null }).exitCode = 0;
      return true;
    };
    return child;
  };
  return { spawn, spawned };
}

describe('ingebouwde tekstherkenning: installeren (#9)', () => {
  it('downloadt runtime en model, controleert sha256 en is daarna geïnstalleerd', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ocr-'));
    const fetch = fakeFetch();
    const rt = new LocalOcrRuntime(dir, { fetch, extract: fakeExtract, platform: 'linux', arch: 'x64', model });
    expect(rt.status().state).toBe('niet-geinstalleerd');
    await rt.install();
    expect(rt.status()).toMatchObject({ state: 'geinstalleerd', llamaVersion: 'b9999', error: null });
    expect(fetch.calls).toContain('https://gh.example/linux.zip');
    expect(readFileSync(join(dir, 'models', 'a.gguf')).equals(MODEL_A)).toBe(true);
    expect(existsSync(join(dir, 'downloads'))).toBe(false); // archief opgeruimd
    // een nieuwe instantie (herstart van de app) ziet het ook
    expect(new LocalOcrRuntime(dir, { fetch, platform: 'linux', arch: 'x64', model }).isInstalled()).toBe(true);
    await rt.uninstall();
    expect(existsSync(dir)).toBe(false);
  });

  it('een beschadigde download wordt geweigerd', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ocr-'));
    const rt = new LocalOcrRuntime(dir, { fetch: fakeFetch({ corrupt: true }), extract: fakeExtract, platform: 'linux', arch: 'x64', model });
    await expect(rt.install()).rejects.toThrow(/controlegetal/);
    expect(rt.status()).toMatchObject({ state: 'fout' });
    expect(rt.isInstalled()).toBe(false);
  });

  it('een afgebroken download gaat verder waar hij was', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ocr-'));
    mkdirSync(join(dir, 'models'), { recursive: true });
    writeFileSync(join(dir, 'models', 'a.gguf.part'), MODEL_A.subarray(0, 3000));
    const ranges: string[] = [];
    const rt = new LocalOcrRuntime(dir, { fetch: fakeFetch({ ranges }), extract: fakeExtract, platform: 'linux', arch: 'x64', model });
    await rt.install();
    expect(ranges).toEqual(['bytes=3000-']);
    expect(readFileSync(join(dir, 'models', 'a.gguf')).equals(MODEL_A)).toBe(true);
  });

  it('review #46: een bestaand modelbestand met de juiste grootte maar verkeerde inhoud wordt opnieuw gedownload', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ocr-'));
    mkdirSync(join(dir, 'models'), { recursive: true });
    writeFileSync(join(dir, 'models', 'a.gguf'), Buffer.alloc(MODEL_A.length, 1)); // juiste grootte, verkeerde inhoud
    const fetch = fakeFetch();
    const rt = new LocalOcrRuntime(dir, { fetch, extract: fakeExtract, platform: 'linux', arch: 'x64', model });
    await rt.install();
    expect(fetch.calls).toContain('https://hf.example/a.gguf');
    expect(readFileSync(join(dir, 'models', 'a.gguf')).equals(MODEL_A)).toBe(true);
  });

  it('review #46: artikelregel met "21%" en één bedrag is geen btw-regel', () => {
    const doc = parseDocumentText([
      { text: 'GAMMA', page: 1, confidence: 1 },
      { text: 'Muurverf wit 21% 49,95', page: 1, confidence: 1 },
      { text: 'Totaal 49,95', page: 1, confidence: 1 },
    ], 'ocr:test');
    expect(doc.vat.value).toEqual([]);
  });

  it('niet-ondersteund platform: nette melding', async () => {
    const rt = new LocalOcrRuntime(mkdtempSync(join(tmpdir(), 'ocr-')), { fetch: fakeFetch(), platform: 'freebsd', arch: 'x64', model });
    await expect(rt.install()).rejects.toThrow(/niet beschikbaar/);
    expect(llamaAssetPattern('win32', 'x64')!.test('llama-b1-bin-win-cpu-x64.zip')).toBe(true);
    expect(llamaAssetPattern('win32', 'x64')!.test('llama-b1-bin-win-cuda-12.4-x64.zip')).toBe(false);
    expect(llamaAssetPattern('darwin', 'arm64')!.test('llama-b1-bin-macos-arm64.tar.gz')).toBe(true);
  });
});

describe('ingebouwde tekstherkenning: gebruiken (#9)', () => {
  it('start de server pas bij de eerste bon, lokaal, en leest de tekst', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ocr-'));
    let request: { messages: { content: { type: string; text?: string; image_url?: { url: string } }[] }[]; temperature: number } | null = null;
    const fetch = fakeFetch({ chat: (b) => { request = b as never; return 'BOUWMAAT UTRECHT\nDatum: 12-09-2026\n| Gipsplaat | 17,90 |\n|---|---|\nTotaal 17,90'; } });
    const { spawn, spawned } = fakeSpawn();
    const rt = new LocalOcrRuntime(dir, { fetch, extract: fakeExtract, spawn: spawn as never, platform: 'linux', arch: 'x64', model, idleMs: 50 });
    await rt.install();
    const provider = rt.provider(fetch as never);
    expect(await provider.available()).toBe(true);
    expect(spawned).toHaveLength(0);
    const out = await provider.recognize({ data: new Uint8Array([0xff, 0xd8]), mimeType: 'image/jpeg', filename: 'bon.jpg' });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.args).toEqual(expect.arrayContaining(['--host', '127.0.0.1', '--mmproj']));
    expect(rt.status().state).toBe('actief');
    expect(request!.temperature).toBe(0);
    expect(request!.messages[0]!.content[0]!.image_url!.url).toMatch(/^data:image\/jpeg;base64,/);
    expect(request!.messages[0]!.content[1]!.text).toBe('Text Recognition:');
    expect(out.items.map((i) => i.text)).toEqual(['BOUWMAAT UTRECHT', 'Datum: 12-09-2026', 'Gipsplaat 17,90', 'Totaal 17,90']);
    const doc = parseDocumentText(out.items, 'ocr:glm-ocr');
    expect(doc.total?.value).toBe(1790);
    // een tweede bon hergebruikt dezelfde server; na een tijd zonder bonnen stopt hij
    await provider.recognize({ data: new Uint8Array([1]), mimeType: 'image/png', filename: 'bon.png' });
    expect(spawned).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 120));
    expect(rt.status().state).toBe('geinstalleerd');
  });

  it('een gescande PDF of HEIC-foto: document blijft, gebruiker krijgt een duidelijke melding', async () => {
    const fetch = fakeFetch();
    const provider = new LlamaCppOcrProvider('glm-ocr', 'http://127.0.0.1:9', fetch as never);
    await expect(provider.recognize({ data: new Uint8Array([1]), mimeType: 'application/pdf', filename: 'scan.pdf' })).rejects.toThrow(/scan zonder tekst/);
    const { s } = setup({ ocr: provider });
    const r = await s.intake.extract('bon.heic', new Uint8Array([1]));
    expect(r.source).toBe('geen');
    expect(r.issues[0]!.message).toMatch(/jpg of png/);
    expect(() => new LlamaCppOcrProvider('x', 'http://example.com', fetch as never)).toThrow(/deze computer/);
  });

  it('markdown en HTML van het model worden gewone regels', () => {
    expect(textToItems('# GAMMA\n**Datum** 12-09-2026\n<table><tr><td>Verf</td><td>12,50</td></tr><tr><td>Totaal</td><td>12,50</td></tr></table>').map((i) => i.text)).toEqual([
      'GAMMA',
      'Datum 12-09-2026',
      'Verf 12,50',
      'Totaal 12,50',
    ]);
  });
});
