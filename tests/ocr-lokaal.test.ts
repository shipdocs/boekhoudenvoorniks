import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn as echtProces, type ChildProcess } from 'node:child_process';
import { LocalOcrRuntime, leftoverVerdict, parsePsInfo, parseWindowsInfo, processInfo, type DownloadFetch, type PidRecord, type ProcessInfo, type ProcessLookup, type RuntimeDeps } from '../src/ocr-runtime/runtime';
import { GLM_OCR, llamaAssetPattern, type OcrModel } from '../src/ocr-runtime/manifest';
import { LlamaCppOcrProvider, OCR_REQUEST_TIMEOUT_MS, OcrTimeoutError, textToItems, OCR_MAX_PIXELS, ocrSize, type ImageShrinker } from '../src/intake/ocr-llamacpp';
import { READ_CONNECTION_MESSAGE, READ_TIMEOUT_MESSAGE } from '../src/shared/reading';
import { parseDocumentText } from '../src/intake/text-parser';
import { setup } from './helpers';
import { makeJpeg } from './fixtures/jpeg';
import { jpegsToPdf, pdfJpegs } from '../src/scanner/jpeg-pdf';

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

function fakeFetch(opts: { corrupt?: boolean; ranges?: string[]; health?: boolean; chat?: (body: unknown) => string; pointer?: string } = {}): DownloadFetch & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string, init?: { headers?: Record<string, string>; body?: string; method?: string }) => {
    calls.push(url);
    const bytes = (b: Buffer, status = 200) => ({ ok: true, status, headers: { get: () => null }, body: (async function* () { yield new Uint8Array(b); })(), json: async () => ({}) });
    // llama.cpp met versienummers: de laatste release bevat alleen een verwijzing naar de build
    if (opts.pointer && url.endsWith('/releases/latest')) {
      return { ok: true, status: 200, headers: { get: () => null }, body: null, json: async () => ({ tag_name: 'v0.5.0', assets: [{ name: 'nightly-tag.txt', size: 7, browser_download_url: 'https://gh.example/nightly-tag.txt' }] }) };
    }
    if (url.endsWith('nightly-tag.txt')) return bytes(Buffer.from(opts.pointer ?? ''));
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

/** Een nagebootst proces: onthoudt welke signalen het kreeg; met `negeertStop` eindigt het alleen op SIGKILL. */
type NepKind = ChildProcess & { exitCode: number | null; signalen: string[]; negeertStop: boolean };

function fakeSpawn() {
  const spawned: { cmd: string; args: string[] }[] = [];
  const kinderen: NepKind[] = [];
  const spawn = (cmd: string, args: string[]) => {
    spawned.push({ cmd, args });
    const child = new EventEmitter() as unknown as NepKind;
    child.exitCode = null;
    child.signalen = [];
    child.negeertStop = false;
    (child as { pid: number }).pid = 3_000_000 + kinderen.length;
    (child as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
    (child as unknown as { kill: (signal?: string) => boolean }).kill = (signal = 'SIGTERM') => {
      child.signalen.push(signal);
      if (child.exitCode !== null || (child.negeertStop && signal !== 'SIGKILL')) return true;
      child.exitCode = 0;
      child.emit('exit', 0, signal);
      return true;
    };
    kinderen.push(child);
    return child;
  };
  return { spawn, spawned, kinderen };
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

  it('laatste release met alleen een verwijzing (nightly-tag.txt): de genoemde build wordt opgehaald', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ocr-'));
    const fetch = fakeFetch({ pointer: 'b9999\n' });
    const rt = new LocalOcrRuntime(dir, { fetch, extract: fakeExtract, platform: 'linux', arch: 'x64', model });
    await rt.install();
    expect(rt.status()).toMatchObject({ state: 'geinstalleerd', llamaVersion: 'b9999' });
    expect(fetch.calls.some((u) => u.endsWith('/releases/tags/b9999'))).toBe(true);
  });

  it('een verwijzing die geen gewone buildnaam is, wordt niet gevolgd', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ocr-'));
    const fetch = fakeFetch({ pointer: '../../andere/repo' });
    const rt = new LocalOcrRuntime(dir, { fetch, extract: fakeExtract, platform: 'linux', arch: 'x64', model });
    await rt.install().catch(() => undefined);
    expect(rt.status()).toMatchObject({ state: 'fout', error: expect.stringContaining('Geen passende runtime') });
    expect(fetch.calls.some((u) => u.includes('/releases/tags/'))).toBe(false);
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

  it('een bon van de telefoon met meerdere pagina\'s (een PDF van foto\'s) wordt per pagina als jpg gelezen', async () => {
    const fotos = [makeJpeg('pagina een'), makeJpeg('pagina twee')];
    const pdf = jpegsToPdf(fotos);
    // de foto's komen er byte voor byte en in volgorde weer uit; elke andere PDF geeft null
    expect(pdfJpegs(pdf)!.map((f) => Buffer.from(f).toString('hex'))).toEqual(fotos.map((f) => Buffer.from(f).toString('hex')));
    expect(pdfJpegs(new Uint8Array(Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n', 'latin1')))).toBeNull();
    expect(pdfJpegs(pdf.subarray(0, pdf.length - 400))).toBeNull();
    expect(pdfJpegs(new Uint8Array([1, 2, 3]))).toBeNull();

    const gevraagd: string[] = [];
    const teksten = ['BOUWMAAT UTRECHT\nDatum: 12-09-2026\nGipsplaat 17,90', 'Totaal 17,90\nPin 17,90'];
    const fetch = fakeFetch({ chat: (b) => { gevraagd.push((b as { messages: { content: { image_url?: { url: string } }[] }[] }).messages[0]!.content[0]!.image_url!.url.slice(0, 23)); return teksten[gevraagd.length - 1]!; } });
    const provider = new LlamaCppOcrProvider('glm-ocr', 'http://127.0.0.1:9', fetch as never);
    const { s } = setup({ ocr: provider });
    const r = await s.intake.extract('bon-telefoon-2026-10-13-88b216dd.pdf', pdf);
    expect(gevraagd).toEqual(['data:image/jpeg;base64,', 'data:image/jpeg;base64,']);
    expect(r.source).toBe('ocr:glm-ocr');
    expect(r.result.total?.value).toBe(1790);
    expect(r.result.invoiceDate?.value).toBe('2026-09-12');
  });

  it('een grote foto gaat verkleind naar de herkenning; een kleine, of een die niet te verkleinen is, gaat zoals hij is', async () => {
    // de rekenregel: zelfde verhouding, hoogstens OCR_MAX_PIXELS beeldpunten
    expect(ocrSize(1000, 1000)).toBeNull();
    expect(ocrSize(1920, 2560)).toEqual({ width: 949, height: 1265 });
    expect(ocrSize(2560, 1920)).toEqual({ width: 1265, height: 949 });
    const lang = ocrSize(800, 2560)!;
    expect(lang.width * lang.height).toBeLessThanOrEqual(OCR_MAX_PIXELS * 1.01);
    expect(Math.abs(lang.height / lang.width - 3.2)).toBeLessThan(0.02);
    expect(ocrSize(0, 100)).toBeNull();

    const gestuurd: string[] = [];
    const fetch = fakeFetch({ chat: (b) => { gestuurd.push((b as { messages: { content: { image_url?: { url: string } }[] }[] }).messages[0]!.content[0]!.image_url!.url); return 'Totaal 1,00'; } });
    const klein = new Uint8Array([9, 9, 9]);
    const maak = (shrink: ImageShrinker) => new LlamaCppOcrProvider('glm-ocr', 'http://127.0.0.1:9', fetch as never, undefined, undefined, undefined, shrink);
    await maak(() => ({ data: klein, mimeType: 'image/jpeg' })).recognize({ data: new Uint8Array([1, 2, 3, 4]), mimeType: 'image/png', filename: 'groot.png' });
    expect(gestuurd.at(-1)).toBe(`data:image/jpeg;base64,${Buffer.from(klein).toString('base64')}`);
    await maak(() => null).recognize({ data: new Uint8Array([1, 2, 3, 4]), mimeType: 'image/png', filename: 'klein.png' });
    expect(gestuurd.at(-1)).toBe(`data:image/png;base64,${Buffer.from([1, 2, 3, 4]).toString('base64')}`);
    await maak(() => { throw new Error('kapot'); }).recognize({ data: new Uint8Array([5]), mimeType: 'image/png', filename: 'fout.png' });
    expect(gestuurd.at(-1)).toBe(`data:image/png;base64,${Buffer.from([5]).toString('base64')}`);
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

/** Het programma dat de app zelf is, zoals de nagebootste processenlijst het kent. */
const ZELF: ProcessInfo = { path: process.execPath, started: { at: 5_000, boot: 'opstart-1' }, sameUser: true };

/**
 * Een nagebootste processenlijst. Wat er niet in staat bestaat niet ('weg'), behalve het eigen programma
 * en de nagebootste servers (proces-ID vanaf 3.000.000): die draaien, als llama-server uit de eigen map.
 */
function nepProcessen(serverPath: () => string) {
  const tabel = new Map<number, ProcessLookup>();
  const info = async (pid: number): Promise<ProcessLookup> => {
    if (tabel.has(pid)) return tabel.get(pid)!;
    if (pid === process.pid) return ZELF;
    if (pid >= 3_000_000 && pid < 4_000_000) return { path: serverPath(), started: { at: pid, boot: 'opstart-1' }, sameUser: true };
    return 'weg';
  };
  return { tabel, info };
}

/** Een geïnstalleerde runtime in een eigen map, met een nagebootst proces. */
async function geinstalleerd(extra: Partial<RuntimeDeps> = {}, fetch: DownloadFetch = fakeFetch()) {
  const dir = mkdtempSync(join(tmpdir(), 'ocr-'));
  const nep = fakeSpawn();
  const serverPath = join(dir, 'llama', 'b9999', 'build', 'bin', 'llama-server');
  const processen = nepProcessen(() => serverPath);
  const deps: RuntimeDeps = { fetch, extract: fakeExtract, spawn: nep.spawn as never, platform: 'linux', arch: 'x64', model, processInfo: processen.info, ...extra };
  const rt = new LocalOcrRuntime(dir, deps);
  await rt.install();
  const pidFile = join(dir, 'llama-server.pid');
  /** wat er in het pid-bestand staat */
  const vastgelegd = (): PidRecord[] => (existsSync(pidFile) ? (JSON.parse(readFileSync(pidFile, 'utf8')) as { servers: PidRecord[] }).servers : []);
  /** een pid-bestand zoals een eerdere start van de app het achterliet; die app (proces 4.900.000) is er niet meer */
  const achtergelaten = (pid: number, over: Partial<PidRecord> = {}) => {
    const record: PidRecord = { pid, serverPath, started: { at: 77_000, boot: 'opstart-1' }, app: { pid: 4_900_000, started: { at: 60_000, boot: 'opstart-1' } }, ...over };
    writeFileSync(pidFile, JSON.stringify({ version: 2, servers: [record] }));
    return record;
  };
  /** het proces dat bij zo'n pid-bestand hoort, zoals het nu draait */
  const draait = (pid: number, over: Partial<ProcessInfo> = {}) => void processen.tabel.set(pid, { path: serverPath, started: { at: 77_000, boot: 'opstart-1' }, sameUser: true, ...over });
  return { dir, rt, deps, serverPath, pidFile, vastgelegd, achtergelaten, draait, processen, ...nep };
}

/** Een leesverzoek dat nooit antwoord krijgt, zoals een herkenning die blijft rekenen; het stopt alleen als het wordt afgebroken. */
function hangendeFetch(basis: DownloadFetch = fakeFetch()) {
  const signalen: AbortSignal[] = [];
  const fetch = ((url: string, init?: { signal?: AbortSignal }) => {
    if (!url.endsWith('/v1/chat/completions')) return basis(url, init as never);
    return new Promise((_resolve, reject) => {
      signalen.push(init!.signal!);
      init!.signal!.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')));
    });
  }) as unknown as DownloadFetch;
  return { fetch, signalen };
}

describe('ingebouwde tekstherkenning: tijdslimiet en melding', () => {
  it('de tijdslimiet is korter dan de vijf minuten waarna fetch zelf opgeeft', () => {
    expect(OCR_REQUEST_TIMEOUT_MS).toBe(240_000);
    expect(OCR_REQUEST_TIMEOUT_MS).toBeLessThan(300_000);
  });

  it('een leesverzoek dat blijft hangen wordt afgebroken, met een Nederlandse melding bij de bon', async () => {
    const { fetch, signalen } = hangendeFetch();
    const provider = new LlamaCppOcrProvider('glm-ocr', 'http://127.0.0.1:9', fetch as never, undefined, undefined, 40);
    const fout = await provider.recognize({ data: makeJpeg(), mimeType: 'image/jpeg', filename: 'bon.jpg' }).catch((e: Error) => e);
    expect(fout).toBeInstanceOf(OcrTimeoutError);
    expect((fout as Error).message).toBe('Het lezen van deze bon duurde te lang. Probeer het opnieuw met Nu lezen, of vul de gegevens zelf in.');
    // het verzoek zelf is echt afgebroken, niet alleen losgelaten
    expect(signalen.map((s) => s.aborted)).toEqual([true]);
    // en zo komt het bij de gebruiker: het document staat er, met die melding
    const { s } = setup({ ocr: provider });
    const doc = await s.intake.add('bon.jpg', makeJpeg('hangt'), '2026-10-13');
    expect(doc).toMatchObject({ status: 'controle', extraction_source: 'geen' });
    expect(doc.issues.find((i) => i.field === 'document')!.message).toBe(READ_TIMEOUT_MESSAGE);
  });

  it('een verbroken verbinding met de lokale server geeft geen kale "fetch failed"', async () => {
    // de server leek er te zijn, maar het leesverzoek zelf krijgt geen antwoord (zoals fetch na vijf minuten deed)
    const weg = (async (url: string) => {
      if (url.endsWith('/health')) return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
      throw new TypeError('fetch failed');
    }) as never;
    const provider = new LlamaCppOcrProvider('glm-ocr', 'http://127.0.0.1:9', weg);
    await expect(provider.recognize({ data: makeJpeg(), mimeType: 'image/jpeg', filename: 'bon.jpg' })).rejects.toThrow(READ_CONNECTION_MESSAGE);
    // ook als de verbinding wegvalt terwijl het antwoord binnenkomt
    const halverwege = (async () => ({ ok: true, status: 200, json: async () => { throw new TypeError('terminated'); }, text: async () => '' })) as never;
    await expect(new LlamaCppOcrProvider('glm-ocr', 'http://127.0.0.1:9', halverwege).recognize({ data: makeJpeg(), mimeType: 'image/jpeg', filename: 'bon.jpg' })).rejects.toThrow(READ_CONNECTION_MESSAGE);
    const { s } = setup({ ocr: provider });
    const doc = await s.intake.add('bon.jpg', makeJpeg('weg'), '2026-10-13');
    expect(doc.issues.map((i) => i.message).join(' ')).not.toMatch(/fetch failed/);
    expect(doc.issues.find((i) => i.field === 'document')!.message).toBe(READ_CONNECTION_MESSAGE);
    // een foutcode van de server houdt zijn eigen melding
    const stuk = (async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => '' })) as never;
    await expect(new LlamaCppOcrProvider('glm-ocr', 'http://127.0.0.1:9', stuk).recognize({ data: makeJpeg(), mimeType: 'image/jpeg', filename: 'bon.jpg' })).rejects.toThrow(/fout 500/);
  });

  it('na de tijdslimiet stopt de server, zodat hij niet doorrekent; de volgende bon start hem opnieuw', async () => {
    const hangend = hangendeFetch();
    const t = await geinstalleerd({ requestTimeoutMs: 40 }, hangend.fetch);
    const provider = t.rt.provider(hangend.fetch as never);
    await expect(provider.recognize({ data: makeJpeg(), mimeType: 'image/jpeg', filename: 'bon.jpg' })).rejects.toThrow(READ_TIMEOUT_MESSAGE);
    expect(t.spawned).toHaveLength(1);
    expect(t.kinderen[0]!.signalen.length).toBeGreaterThan(0);
    expect(t.rt.status().state).toBe('geinstalleerd');
    await expect(provider.recognize({ data: makeJpeg(), mimeType: 'image/jpeg', filename: 'bon.jpg' })).rejects.toThrow(READ_TIMEOUT_MESSAGE);
    expect(t.spawned).toHaveLength(2);
    t.rt.stopNow();
  });
});

describe('ingebouwde tekstherkenning: de server stopt met de app', () => {
  const lees = (rt: LocalOcrRuntime, fetch: DownloadFetch = fakeFetch()) => rt.provider(fetch as never).recognize({ data: makeJpeg(), mimeType: 'image/jpeg', filename: 'bon.jpg' });

  it('bij afsluiten wordt de server meteen hard beëindigd, ook als hij op een gewoon stopsignaal niet reageert', async () => {
    // een server die midden in een bon zit, reageert niet op het gewone stopsignaal
    const t = await geinstalleerd();
    await lees(t.rt);
    const kind = t.kinderen[0]!;
    kind.negeertStop = true;
    // vastgelegd: welk proces, wanneer het begon, en welk programma het startte
    expect(t.vastgelegd()).toEqual([{ pid: kind.pid, serverPath: t.serverPath, started: { at: kind.pid, boot: 'opstart-1' }, app: { pid: process.pid, started: ZELF.started } }]);
    t.rt.stopNow();
    expect(kind.signalen).toContain('SIGKILL');
    expect(kind.exitCode).not.toBeNull();
    expect(existsSync(t.pidFile)).toBe(false);
    expect(t.rt.status().state).toBe('geinstalleerd');
  });

  it('een gewone stop (bv. na een tijd zonder bonnen) wacht kort en beëindigt de server dan hard', async () => {
    const t = await geinstalleerd({ stopGraceMs: 30 });
    await lees(t.rt);
    const kind = t.kinderen[0]!;
    kind.negeertStop = true;
    t.rt.stop();
    expect(kind.signalen).toEqual(['SIGTERM']);
    await new Promise((r) => setTimeout(r, 90));
    expect(kind.signalen).toEqual(['SIGTERM', 'SIGKILL']);
    expect(existsSync(t.pidFile)).toBe(false);
  });

  it('sluit de app af terwijl een gestopte server nog niet weg is, dan gaat die ook meteen', async () => {
    const t = await geinstalleerd({ stopGraceMs: 60_000 });
    await lees(t.rt);
    const kind = t.kinderen[0]!;
    kind.negeertStop = true;
    t.rt.stop();
    expect(kind.exitCode).toBeNull();
    t.rt.stopNow();
    expect(kind.signalen).toEqual(['SIGTERM', 'SIGKILL']);
    expect(existsSync(t.pidFile)).toBe(false);
  });

  it('een server van een vorige keer wordt bij de start gestopt, maar alleen als alles klopt', async () => {
    const gestopt: [number, string][] = [];
    const kill = (pid: number, signal: NodeJS.Signals) => void gestopt.push([pid, signal]);
    // 1. de llama-server uit de eigen map, begonnen op het vastgelegde moment, van dezelfde gebruiker, en de app die hem startte is weg: stoppen
    let t = await geinstalleerd({ kill });
    t.achtergelaten(4_000_001);
    t.draait(4_000_001);
    expect(await t.rt.stopLeftover()).toBe(true);
    expect(gestopt).toEqual([[4_000_001, 'SIGKILL']]);
    expect(existsSync(t.pidFile)).toBe(false);

    // 2. hetzelfde proces-ID hoort intussen bij een ander programma: met rust laten
    gestopt.length = 0;
    t = await geinstalleerd({ kill });
    t.achtergelaten(4_000_002);
    t.draait(4_000_002, { path: '/usr/bin/firefox' });
    expect(await t.rt.stopLeftover()).toBe(false);
    expect(gestopt).toEqual([]);
    expect(existsSync(t.pidFile)).toBe(false);

    // 3. een llama-server van iemand anders (zelfde naam, andere map), ook als het pid-bestand daarnaar wijst: met rust laten
    t = await geinstalleerd({ kill });
    t.achtergelaten(4_000_003, { serverPath: '/opt/eigen/llama-server' });
    t.draait(4_000_003, { path: '/opt/eigen/llama-server' });
    expect(await t.rt.stopLeftover()).toBe(false);
    expect(gestopt).toEqual([]);

    // 4. het proces is er niet meer: alleen het bestand opruimen
    t = await geinstalleerd({ kill });
    t.achtergelaten(4_000_004);
    expect(await t.rt.stopLeftover()).toBe(false);
    expect(gestopt).toEqual([]);
    expect(existsSync(t.pidFile)).toBe(false);

    // 5. geen pid-bestand, of onzin erin: niets doen
    t = await geinstalleerd({ kill });
    expect(await t.rt.stopLeftover()).toBe(false);
    writeFileSync(t.pidFile, '{"pid":"alles"}');
    expect(await t.rt.stopLeftover()).toBe(false);
    expect(gestopt).toEqual([]);
  });

  it('een andere uitvoering van hetzelfde programma met hetzelfde proces-ID is geen achterblijver', async () => {
    const gestopt: number[] = [];
    const kill = (pid: number) => void gestopt.push(pid);
    // het pid-bestand is oud: het proces van toen is weg en het proces-ID is opnieuw uitgegeven aan een
    // llama-server uit dezelfde map die later begon. Pad en map kloppen dus; het begin niet.
    let t = await geinstalleerd({ kill });
    t.achtergelaten(4_000_010);
    t.draait(4_000_010, { started: { at: 77_000 + 60_000, boot: 'opstart-1' } });
    expect(await t.rt.stopLeftover()).toBe(false);
    expect(gestopt).toEqual([]);
    // het proces van toen bestaat niet meer: de regel mag weg
    expect(existsSync(t.pidFile)).toBe(false);

    // zelfde tikken, maar de computer is intussen opnieuw opgestart: een ander proces
    t = await geinstalleerd({ kill });
    t.achtergelaten(4_000_011);
    t.draait(4_000_011, { started: { at: 77_000, boot: 'opstart-2' } });
    expect(await t.rt.stopLeftover()).toBe(false);
    expect(gestopt).toEqual([]);

    // een pid-bestand zonder begin van het proces (zoals een eerdere versie het schreef) bewijst niets
    t = await geinstalleerd({ kill });
    writeFileSync(t.pidFile, JSON.stringify({ pid: 4_000_012, serverPath: t.serverPath }));
    t.draait(4_000_012);
    expect(await t.rt.stopLeftover()).toBe(false);
    expect(gestopt).toEqual([]);
  });

  it('krijgt een ander proces het proces-ID terwijl de app nog aan het nakijken is, dan wordt dat niet gestopt', async () => {
    // de server klopt bij de eerste blik; tijdens het opzoeken van de app die hem startte eindigt hij en
    // krijgt een ander proces zijn proces-ID. Vlak vóór het stoppen wordt daarom opnieuw gekeken.
    const wissel = async (worden: (serverPath: string) => ProcessLookup) => {
      const gestopt: number[] = [];
      const t = await geinstalleerd({ kill: (pid) => void gestopt.push(pid) });
      t.achtergelaten(4_000_060);
      t.draait(4_000_060);
      const basis = t.deps.processInfo!;
      const gevraagd: number[] = [];
      const rt = new LocalOcrRuntime(t.dir, {
        ...t.deps,
        processInfo: async (pid) => {
          gevraagd.push(pid);
          const antwoord = await basis(pid);
          // tijdens het opzoeken van de starter (proces 4.900.000) wisselt het proces achter het proces-ID van de server
          if (pid === 4_900_000) t.processen.tabel.set(4_000_060, worden(t.serverPath));
          return antwoord;
        },
      });
      return { gestopt, gevraagd, uitkomst: await rt.stopLeftover(), t };
    };
    // een heel ander programma
    let r = await wissel(() => ({ path: '/usr/bin/unrelated', started: { at: 99_000, boot: 'opstart-1' }, sameUser: true }));
    expect(r.gestopt).toEqual([]);
    expect(r.uitkomst).toBe(false);
    // de server is als laatste nog een keer bekeken, ná de starter
    expect(r.gevraagd).toEqual([4_000_060, 4_900_000, 4_000_060]);
    // het proces van toen is er niet meer: de regel is weg
    expect(existsSync(r.t.pidFile)).toBe(false);
    // een andere llama-server uit dezelfde map, een tel later begonnen
    r = await wissel((serverPath) => ({ path: serverPath, started: { at: 77_010, boot: 'opstart-1' }, sameUser: true }));
    expect(r.gestopt).toEqual([]);
    // hetzelfde programma en hetzelfde begin, maar intussen van een andere gebruiker: niets doen, de regel blijft
    r = await wissel((serverPath) => ({ path: serverPath, started: { at: 77_000, boot: 'opstart-1' }, sameUser: false }));
    expect(r.gestopt).toEqual([]);
    expect(r.t.vastgelegd()).toHaveLength(1);
    // niet meer vast te stellen: niets doen en de regel laten staan
    r = await wissel(() => null);
    expect(r.gestopt).toEqual([]);
    expect(r.t.vastgelegd()).toHaveLength(1);
    // intussen weg: niets te stoppen
    r = await wissel(() => 'weg');
    expect(r.gestopt).toEqual([]);
    expect(existsSync(r.t.pidFile)).toBe(false);
    // nog precies hetzelfde proces: de achterblijver stopt
    r = await wissel((serverPath) => ({ path: serverPath, started: { at: 77_000, boot: 'opstart-1' }, sameUser: true }));
    expect(r.gestopt).toEqual([4_000_060]);
    expect(r.uitkomst).toBe(true);
  });

  it('is iets niet vast te stellen, of is het proces van een andere gebruiker, dan gebeurt er niets', async () => {
    const gestopt: number[] = [];
    const kill = (pid: number) => void gestopt.push(pid);
    // van een andere gebruiker
    let t = await geinstalleerd({ kill });
    const regel = t.achtergelaten(4_000_020);
    t.draait(4_000_020, { sameUser: false });
    expect(await t.rt.stopLeftover()).toBe(false);
    expect(t.vastgelegd()).toEqual([regel]);
    // het proces is er, maar pad, begin of eigenaar is niet op te vragen
    t = await geinstalleerd({ kill });
    t.achtergelaten(4_000_021);
    t.processen.tabel.set(4_000_021, null);
    expect(await t.rt.stopLeftover()).toBe(false);
    expect(t.vastgelegd()).toHaveLength(1);
    // van de app die hem startte is niet vast te stellen of hij nog draait
    t = await geinstalleerd({ kill });
    t.achtergelaten(4_000_022);
    t.draait(4_000_022);
    t.processen.tabel.set(4_900_000, null);
    expect(await t.rt.stopLeftover()).toBe(false);
    expect(t.vastgelegd()).toHaveLength(1);
    expect(gestopt).toEqual([]);
  });

  it('draait het programma dat de server startte nog, dan is het zijn server en geen achterblijver', async () => {
    // twee programma's gebruiken dezelfde gegevensmap: het ene mag de actieve server van het andere niet beëindigen
    const gestopt: number[] = [];
    const t = await geinstalleerd({ kill: (pid) => void gestopt.push(pid) });
    const regel = t.achtergelaten(4_000_030);
    t.draait(4_000_030);
    t.processen.tabel.set(4_900_000, { path: '/opt/BoekhoudenVoorNiks/boekhoudenvoorniks', started: { at: 60_000, boot: 'opstart-1' }, sameUser: true });
    expect(await t.rt.stopLeftover()).toBe(false);
    // ook een nieuwe start laat hem met rust, en legt de eigen server ernaast vast
    await lees(t.rt);
    expect(gestopt).toEqual([]);
    expect(t.vastgelegd()).toEqual([regel, expect.objectContaining({ pid: t.kinderen[0]!.pid })]);
    t.rt.stopNow();
    expect(t.vastgelegd()).toEqual([regel]);

    // dat proces-ID is intussen van een ander programma (het begon op een ander moment): de app van toen is weg, de server is een achterblijver
    t.processen.tabel.set(4_900_000, { path: '/usr/bin/firefox', started: { at: 900_000, boot: 'opstart-1' }, sameUser: true });
    expect(await t.rt.stopLeftover()).toBe(true);
    expect(gestopt).toEqual([4_000_030]);
  });

  it('de regel waarmee een achterblijver wordt herkend', () => {
    const dir = '/data/ocr';
    const serverPath = '/data/ocr/llama/b1/llama-server';
    const record: PidRecord = { pid: 10, serverPath, started: { at: 1_000, boot: 'a' }, app: { pid: 20, started: { at: 500, boot: 'a' } } };
    const server: ProcessInfo = { path: serverPath, started: { at: 1_000, boot: 'a' }, sameUser: true };
    const oordeel = (over: Partial<Parameters<typeof leftoverVerdict>[0]> = {}) => leftoverVerdict({ record, server, starter: 'weg', dir, platform: 'linux', ...over });
    expect(oordeel()).toBe('stoppen');
    // het begin moet precies gelijk zijn: vastleggen en nakijken meten op dezelfde manier, dus elk verschil is een ander proces
    expect(oordeel({ server: { ...server, started: { at: 1_001, boot: 'a' } } })).toBe('vergeten');
    expect(oordeel({ server: { ...server, started: { at: 2_900, boot: 'a' } } })).toBe('vergeten');
    expect(oordeel({ server: { ...server, started: { at: 999, boot: 'a' } } })).toBe('vergeten');
    // hetzelfde proces-ID binnen een seconde opnieuw uitgegeven aan een andere llama-server uit dezelfde map
    expect(leftoverVerdict({ record: { ...record, started: { at: 10_000, boot: 'a' } }, server: { ...server, started: { at: 11_000, boot: 'a' } }, starter: 'weg', dir, platform: 'linux' })).toBe('vergeten');
    // ook bij de app die hem startte: een ander begin is een ander programma, dus die app is weg
    expect(oordeel({ starter: { path: '/app', started: { at: 501, boot: 'a' }, sameUser: true } })).toBe('stoppen');
    expect(oordeel({ server: { ...server, started: { at: 1_000, boot: 'b' } } })).toBe('vergeten');
    expect(oordeel({ server: { ...server, started: { at: 1_000 } } })).toBe('vergeten');
    expect(oordeel({ server: 'weg' })).toBe('vergeten');
    expect(oordeel({ server: null })).toBe('laten');
    expect(oordeel({ server: { ...server, sameUser: false } })).toBe('laten');
    expect(oordeel({ server: { ...server, path: '/usr/bin/llama-server' } })).toBe('vergeten');
    expect(oordeel({ server: { ...server, path: '/data/ocr/llama/b1/iets-anders' }, record: { ...record, serverPath: '/data/ocr/llama/b1/iets-anders' } })).toBe('vergeten');
    // de app die hem startte
    expect(oordeel({ starter: null })).toBe('laten');
    expect(oordeel({ starter: { path: '/app', started: { at: 500, boot: 'a' }, sameUser: true } })).toBe('laten');
    expect(oordeel({ starter: { path: '/app', started: { at: 9_500, boot: 'a' }, sameUser: true } })).toBe('stoppen');
    // Windows: hoofdletters in het pad maken niet uit
    const win = 'C:\\Data\\ocr\\llama\\b1\\llama-server.exe';
    expect(leftoverVerdict({ record: { ...record, serverPath: win }, server: { ...server, path: win.toUpperCase() }, starter: 'weg', dir: 'C:\\Data\\ocr', platform: 'win32' })).toBe(process.platform === 'win32' ? 'stoppen' : 'vergeten');
  });

  it('de server die nu zelf draait is geen achterblijver; een nieuwe start ruimt eerst een oude op', async () => {
    const gestopt: number[] = [];
    const t = await geinstalleerd({ kill: (pid) => void gestopt.push(pid) });
    t.achtergelaten(4_000_005);
    t.draait(4_000_005);
    await lees(t.rt);
    expect(gestopt).toEqual([4_000_005]);
    expect(t.vastgelegd().map((r) => r.pid)).toEqual([t.kinderen[0]!.pid]);
    expect(await t.rt.stopLeftover()).toBe(false);
    expect(gestopt).toEqual([4_000_005]);
    t.rt.stopNow();
  });

  it('een tweede runtime op dezelfde map (bv. na het wisselen van administratie) laat de actieve server van de eerste met rust', async () => {
    const gestopt: number[] = [];
    const t = await geinstalleerd({ kill: (pid) => void gestopt.push(pid) });
    await lees(t.rt);
    const eerste = t.kinderen[0]!;
    const tweede = new LocalOcrRuntime(t.dir, t.deps);
    expect(await tweede.stopLeftover()).toBe(false);
    await lees(tweede);
    expect(gestopt).toEqual([]);
    expect(eerste.signalen).toEqual([]);
    expect(t.kinderen).toHaveLength(2);
    expect(t.vastgelegd().map((r) => r.pid)).toEqual([eerste.pid, t.kinderen[1]!.pid]);
    // ieder stopt zijn eigen server en haalt alleen zijn eigen regel weg
    t.rt.stopNow();
    expect(eerste.exitCode).not.toBeNull();
    expect(t.kinderen[1]!.signalen).toEqual([]);
    expect(t.vastgelegd().map((r) => r.pid)).toEqual([t.kinderen[1]!.pid]);
    tweede.stopNow();
    expect(existsSync(t.pidFile)).toBe(false);
  });

  it('wordt de runtime gestopt terwijl hij aan het starten is, dan start er geen server meer', async () => {
    // de app sluit af (of wisselt van administratie) terwijl de start nog op het opruimen of een vrije poort wacht
    const t = await geinstalleerd();
    const start = lees(t.rt);
    t.rt.stopNow();
    await expect(start).rejects.toThrow('De tekstherkenning is gestopt.');
    expect(t.spawned).toHaveLength(0);
    expect(existsSync(t.pidFile)).toBe(false);
    expect(t.rt.status().state).toBe('geinstalleerd');
    // daarna werkt hij gewoon weer
    await lees(t.rt);
    expect(t.spawned).toHaveLength(1);
    t.rt.stopNow();
  });

  it('ook een stop tijdens het opruimen van een achterblijver, of tijdens het wachten op de server, breekt de start af', async () => {
    // 1. het opruimen wacht op de processenlijst; intussen stopt de runtime
    let klaar: (i: ProcessLookup) => void = () => undefined;
    const bezig = new Promise<ProcessLookup>((r) => (klaar = r));
    let gevraagd: () => void = () => undefined;
    const vraag = new Promise<void>((r) => (gevraagd = r));
    const gestopt: number[] = [];
    let t = await geinstalleerd({ kill: (pid) => void gestopt.push(pid), processInfo: async (pid) => (pid === 4_000_040 ? (gevraagd(), bezig) : 'weg') });
    t.achtergelaten(4_000_040);
    const start = lees(t.rt);
    await vraag;
    t.rt.stopNow();
    klaar({ path: t.serverPath, started: { at: 77_000, boot: 'opstart-1' }, sameUser: true });
    await expect(start).rejects.toThrow('De tekstherkenning is gestopt.');
    expect(t.spawned).toHaveLength(0);

    // 2. de server is gestart maar nog niet klaar (het model laadt); een stop beëindigt hem en de start geeft geen adres meer
    const fetch = fakeFetch({ health: false });
    t = await geinstalleerd({}, fetch);
    const laden = lees(t.rt, fetch);
    for (let i = 0; i < 200 && t.kinderen.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(t.kinderen).toHaveLength(1);
    t.rt.stopNow();
    await expect(laden).rejects.toThrow('De tekstherkenning is gestopt.');
    expect(t.kinderen[0]!.exitCode).not.toBeNull();
    expect(t.rt.status()).toMatchObject({ state: 'geinstalleerd', error: null });
    expect(existsSync(t.pidFile)).toBe(false);
  });

  it('opruimen en starten kruisen elkaar niet: twee runtimes op dezelfde map doen het na elkaar', async () => {
    // de eerste is bezig met opruimen (wacht op de processenlijst); de tweede start pas als de eerste klaar is
    let klaar: (i: ProcessLookup) => void = () => undefined;
    const bezig = new Promise<ProcessLookup>((r) => (klaar = r));
    let gevraagd: () => void = () => undefined;
    const vraag = new Promise<void>((r) => (gevraagd = r));
    const t = await geinstalleerd();
    t.achtergelaten(4_000_050);
    const basis = t.deps.processInfo!;
    const eerste = new LocalOcrRuntime(t.dir, { ...t.deps, kill: () => undefined, processInfo: async (pid) => (pid === 4_000_050 ? (gevraagd(), bezig) : basis(pid)) });
    const opruimen = eerste.stopLeftover();
    await vraag;
    const start = lees(t.rt);
    await new Promise((r) => setTimeout(r, 60));
    expect(t.spawned).toHaveLength(0);
    klaar({ path: t.serverPath, started: { at: 77_000, boot: 'opstart-1' }, sameUser: true });
    expect(await opruimen).toBe(true);
    await start;
    expect(t.spawned).toHaveLength(1);
    expect(t.vastgelegd().map((r) => r.pid)).toEqual([t.kinderen[0]!.pid]);
    t.rt.stopNow();
  });

  it('het begin en de eigenaar van een proces uit de uitvoer van ps (macOS) en PowerShell (Windows)', () => {
    // macOS: ps -p <pid> -o uid= -o lstart= -o comm=, met LC_ALL=C en TZ=UTC
    expect(parsePsInfo('  501 Tue Oct 13 22:04:04 2026 /Users/piet/Library/Application Support/BoekhoudenVoorNiks/ocr/llama/b1/llama-server\n', 501)).toEqual({
      path: '/Users/piet/Library/Application Support/BoekhoudenVoorNiks/ocr/llama/b1/llama-server',
      started: { at: Date.UTC(2026, 9, 13, 22, 4, 4) },
      sameUser: true,
    });
    expect(parsePsInfo('    0 Sat Oct  3 08:00:00 2026 /usr/sbin/cupsd\n', 501)).toEqual({ path: '/usr/sbin/cupsd', started: { at: Date.UTC(2026, 9, 3, 8, 0, 0) }, sameUser: false });
    expect(parsePsInfo('', 501)).toBeNull();
    expect(parsePsInfo('  501 gisteren /bin/sh', 501)).toBeNull();
    // Windows: begin als FILETIME (100 ns sinds 1601), eigen proces ja/nee, pad
    const filetime = (BigInt(Date.UTC(2026, 9, 13, 22, 4, 4)) + 11_644_473_600_000n) * 10_000n;
    expect(parseWindowsInfo(`${filetime}|True|C:\\Users\\Piet\\AppData\\Roaming\\BoekhoudenVoorNiks\\ocr\\llama\\b1\\llama-server.exe\r\n`)).toEqual({
      path: 'C:\\Users\\Piet\\AppData\\Roaming\\BoekhoudenVoorNiks\\ocr\\llama\\b1\\llama-server.exe',
      started: { at: Date.UTC(2026, 9, 13, 22, 4, 4) },
      sameUser: true,
    });
    expect(parseWindowsInfo(`${filetime}|False|C:\\x\\llama-server.exe`)).toMatchObject({ sameUser: false });
    expect(parseWindowsInfo(`${filetime}|True|`)).toBeNull();
    expect(parseWindowsInfo('|True|C:\\x.exe')).toBeNull();
    expect(parseWindowsInfo('')).toBeNull();
  });

  it.runIf(process.platform === 'linux')('met echte processen: het begin en de eigenaar van een proces zijn op te vragen', async () => {
    const zelf = await processInfo(process.pid);
    expect(zelf).toMatchObject({ path: realpathSync(process.execPath), sameUser: true });
    const begin = (zelf as ProcessInfo).started;
    expect(begin.boot).toMatch(/^[0-9a-f-]{36}$/);
    // twee keer vragen geeft hetzelfde begin; een ander proces een ander
    expect((await processInfo(process.pid) as ProcessInfo).started).toEqual(begin);
    await new Promise((r) => setTimeout(r, 30));
    const kind = echtProces('/bin/sleep', ['60'], { stdio: 'ignore' });
    try {
      const k = await processInfo(kind.pid!) as ProcessInfo;
      expect(k.path).toBe(realpathSync('/bin/sleep'));
      expect(k.started.at).toBeGreaterThan(begin.at);
      expect(k.sameUser).toBe(true);
    } finally {
      kind.kill('SIGKILL');
    }
    await new Promise<void>((resolve) => kind.once('exit', () => resolve()));
    expect(await processInfo(kind.pid!)).toBe('weg');
    // een proces van een andere gebruiker (proces 1, als de tests niet als beheerder draaien): niets vast te stellen, dus nooit stoppen
    if (process.getuid?.() !== 0) expect(await processInfo(1)).toBeNull();
  });

  it.runIf(process.platform === 'linux')('met een echt proces: de start legt het begin van de server en van het eigen programma vast', async () => {
    const t = await geinstalleerd({ spawn: undefined, processInfo: undefined });
    // een programma dat blijft draaien op de plek van llama-server
    writeFileSync(t.serverPath, '#!/bin/sh\nexec sleep 60\n');
    await lees(t.rt);
    const [regel] = t.vastgelegd();
    try {
      const server = await processInfo(regel!.pid) as ProcessInfo;
      const zelf = await processInfo(process.pid) as ProcessInfo;
      expect(regel).toEqual({ pid: regel!.pid, serverPath: t.serverPath, started: server.started, app: { pid: process.pid, started: zelf.started } });
      // de app draait nog: haar eigen server is geen achterblijver, ook niet voor een tweede runtime op dezelfde map
      expect(await new LocalOcrRuntime(t.dir, { ...t.deps, spawn: undefined, processInfo: undefined }).stopLeftover()).toBe(false);
      expect(await processInfo(regel!.pid)).not.toBe('weg');
    } finally {
      t.rt.stopNow();
    }
    for (let i = 0; i < 200 && (await processInfo(regel!.pid)) !== 'weg'; i++) await new Promise((r) => setTimeout(r, 10));
    expect(await processInfo(regel!.pid)).toBe('weg');
    expect(existsSync(t.pidFile)).toBe(false);
  });

  it.runIf(process.platform === 'linux')('met echte processen: alleen de eigen achterblijver stopt', async () => {
    const t = await geinstalleerd({ processInfo: undefined });
    // een echt programma op de plek van llama-server (de nagebootste download is een script)
    copyFileSync('/bin/sleep', t.serverPath);
    chmodSync(t.serverPath, 0o755);
    const weg = (kind: ChildProcess) => new Promise<void>((resolve) => (kind.exitCode !== null || kind.signalCode !== null ? resolve() : kind.once('exit', () => resolve())));
    const draaitNog = async (kind: ChildProcess) => {
      await new Promise((r) => setTimeout(r, 100));
      return kind.exitCode === null && kind.signalCode === null;
    };
    // een programma dat er niet meer is, als de app van een vorige keer
    const vorige = echtProces('/bin/sleep', ['60'], { stdio: 'ignore' });
    const vorigeApp = { pid: vorige.pid!, started: (await processInfo(vorige.pid!) as ProcessInfo).started };
    vorige.kill('SIGKILL');
    await weg(vorige);
    const eigen = echtProces(t.serverPath, ['60'], { stdio: 'ignore' });
    const tweede = echtProces(t.serverPath, ['60'], { stdio: 'ignore' });
    const ander = echtProces('/bin/sleep', ['60'], { stdio: 'ignore' });
    const schrijf = (record: PidRecord) => writeFileSync(t.pidFile, JSON.stringify({ version: 2, servers: [record] }));
    try {
      const begin = (await processInfo(eigen.pid!) as ProcessInfo).started;
      // 1. het pid-bestand wijst naar een ander programma: dat blijft draaien
      schrijf({ pid: ander.pid!, serverPath: t.serverPath, started: begin, app: vorigeApp });
      expect(await t.rt.stopLeftover()).toBe(false);
      expect(await draaitNog(ander)).toBe(true);
      // 2. het wijst naar een andere uitvoering van dezelfde llama-server, die op een ander moment begon: die blijft draaien
      schrijf({ pid: tweede.pid!, serverPath: t.serverPath, started: { ...begin, at: begin.at - 60_000 }, app: vorigeApp });
      expect(await t.rt.stopLeftover()).toBe(false);
      expect(await draaitNog(tweede)).toBe(true);
      // 3. een pid-bestand zonder begin (zoals een eerdere versie het schreef): niets
      writeFileSync(t.pidFile, JSON.stringify({ pid: tweede.pid, serverPath: t.serverPath }));
      expect(await t.rt.stopLeftover()).toBe(false);
      expect(await draaitNog(tweede)).toBe(true);
      // 4. alles klopt, maar het programma dat hem startte draait nog (hier: deze test zelf): niets
      const zelf = await processInfo(process.pid) as ProcessInfo;
      schrijf({ pid: eigen.pid!, serverPath: t.serverPath, started: begin, app: { pid: process.pid, started: zelf.started } });
      expect(await t.rt.stopLeftover()).toBe(false);
      expect(await draaitNog(eigen)).toBe(true);
      // 5. alles klopt en het programma dat hem startte is weg: de achterblijver stopt
      schrijf({ pid: eigen.pid!, serverPath: t.serverPath, started: begin, app: vorigeApp });
      expect(await t.rt.stopLeftover()).toBe(true);
      await weg(eigen);
      expect(eigen.signalCode).toBe('SIGKILL');
      expect(existsSync(t.pidFile)).toBe(false);
      expect(await draaitNog(tweede)).toBe(true);
    } finally {
      eigen.kill('SIGKILL');
      tweede.kill('SIGKILL');
      ander.kill('SIGKILL');
    }
  });
});
