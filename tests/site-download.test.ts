import { describe, expect, it } from 'vitest';
import worker, { download } from '../workers/site/src/index';

/** De vaste downloadadressen van de website (/download/...): doorsturen naar het bestand van de nieuwste release. */

const PAGE = 'https://github.com/shipdocs/boekhoudenvoorniks/releases/latest';
const TAG = 'https://github.com/shipdocs/boekhoudenvoorniks/releases/download';
const yml = (version: string) => `version: ${version}\nfiles:\n  - url: BoekhoudenVoorNiks-Setup-${version}.exe\n    sha512: abc\npath: BoekhoudenVoorNiks-Setup-${version}.exe\n`;
const ok = (text: string): typeof fetch => (async () => new Response(text, { status: 200 })) as unknown as typeof fetch;
const failing = (status = 500): typeof fetch => (async () => new Response('nee', { status })) as unknown as typeof fetch;
const broken: typeof fetch = (async () => { throw new Error('geen netwerk'); }) as unknown as typeof fetch;

/** Een heel eenvoudige Cache, zoals Cloudflare die aanbiedt. */
function fakeCache(): Cache {
  const data = new Map<string, string>();
  return {
    match: async (req: Request) => (data.has(req.url) ? new Response(data.get(req.url)) : undefined),
    put: async (req: Request, res: Response) => void data.set(req.url, await res.text()),
  } as unknown as Cache;
}

describe('downloadadressen op de website', () => {
  it.each([
    ['windows', 'BoekhoudenVoorNiks-Setup-1.0.1.exe'],
    ['appimage', 'BoekhoudenVoorNiks-1.0.1.AppImage'],
    ['deb', 'gratis-boekhouden_1.0.1_amd64.deb'],
  ])('/download/%s stuurt naar %s van de nieuwste versie', async (kind, file) => {
    const res = await download(kind, ok(yml('1.0.1')), null);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${TAG}/v1.0.1/${file}`);
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
  });

  it('de controlegetallen hebben een vaste naam en vragen niets op', async () => {
    const res = await download('sha256-windows', broken, null);
    expect(res.headers.get('location')).toBe(`${PAGE}/download/SHA256SUMS-Windows.txt`);
    expect((await download('sha256-linux', broken, null)).headers.get('location')).toBe(`${PAGE}/download/SHA256SUMS-Linux.txt`);
  });

  it('een nieuwe versie hoeft niets op de website te veranderen', async () => {
    expect((await download('windows', ok(yml('1.2.0')), null)).headers.get('location')).toBe(`${TAG}/v1.2.0/BoekhoudenVoorNiks-Setup-1.2.0.exe`);
  });

  it('vraagt GitHub niet bij elk bezoek: tien minuten onthouden, en bij een storing de laatste bekende versie', async () => {
    const store = fakeCache();
    let calls = 0;
    const counting = (async () => (calls++, new Response(yml('1.0.1')))) as unknown as typeof fetch;
    await download('windows', counting, store);
    await download('appimage', counting, store);
    await download('deb', counting, store);
    expect(calls).toBe(1);
    // de "tien minuten" zijn voorbij (alleen de korte kopie weg), GitHub doet even niet mee: de laatste bekende versie
    const short = new Map<string, string>();
    const withExpiry = { match: async (r: Request) => (r.url.includes('laatste-bekende') ? await store.match(r) : undefined), put: async () => undefined } as unknown as Cache;
    void short;
    expect((await download('windows', failing(403), withExpiry)).headers.get('location')).toBe(`${TAG}/v1.0.1/BoekhoudenVoorNiks-Setup-1.0.1.exe`);
  });

  it('GitHub onbereikbaar of een vreemd antwoord, en niets onthouden: de releasepagina als noodgreep', async () => {
    for (const fetcher of [failing(500), failing(403), broken, ok('geen versie hier'), ok('version: ../../kwaad\n'), ok('version: 1.0\n')]) {
      expect((await download('windows', fetcher, null)).headers.get('location')).toBe(PAGE);
    }
  });

  it('een onbekende download geeft 404', async () => {
    expect((await download('../../etc/passwd', ok(yml('1.0.1')), null)).status).toBe(404);
    expect((await download('mac', ok(yml('1.0.1')), null)).status).toBe(404);
  });

  it('de Worker zelf: /download/windows verwijst door en /download gaat naar de downloadpagina', async () => {
    const env = { ASSETS: { fetch: async () => new Response('pagina') } };
    const real = globalThis.fetch;
    globalThis.fetch = ok(yml('1.0.1'));
    try {
      const res = await worker.fetch(new Request('https://boekhoudenvoorniks.nl/download/windows'), env);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(`${TAG}/v1.0.1/BoekhoudenVoorNiks-Setup-1.0.1.exe`);
    } finally {
      globalThis.fetch = real;
    }
    const index = await worker.fetch(new Request('https://boekhoudenvoorniks.nl/download'), env);
    expect(index.headers.get('location')).toBe('https://boekhoudenvoorniks.nl/downloaden.html');
    const post = await worker.fetch(new Request('https://boekhoudenvoorniks.nl/download/windows', { method: 'POST' }), env);
    expect(post.status).not.toBe(302);
  });
});
