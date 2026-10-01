import { describe, expect, it } from 'vitest';
import worker, { download } from '../workers/site/src/index';

/** De vaste downloadadressen van de website (/download/...): doorsturen naar het bestand van de nieuwste release. */

const BASE = 'https://github.com/shipdocs/boekhoudenvoorniks/releases/download/v1.0.0';
const release = {
  draft: false,
  prerelease: false,
  assets: [
    { name: 'BoekhoudenVoorNiks-1.0.0.AppImage', browser_download_url: `${BASE}/BoekhoudenVoorNiks-1.0.0.AppImage` },
    { name: 'BoekhoudenVoorNiks-Setup-1.0.0.exe', browser_download_url: `${BASE}/BoekhoudenVoorNiks-Setup-1.0.0.exe` },
    { name: 'BoekhoudenVoorNiks-Setup-1.0.0.exe.blockmap', browser_download_url: `${BASE}/BoekhoudenVoorNiks-Setup-1.0.0.exe.blockmap` },
    { name: 'gratis-boekhouden_1.0.0_amd64.deb', browser_download_url: `${BASE}/gratis-boekhouden_1.0.0_amd64.deb` },
    { name: 'latest.yml', browser_download_url: `${BASE}/latest.yml` },
    { name: 'SHA256SUMS-Windows.txt', browser_download_url: `${BASE}/SHA256SUMS-Windows.txt` },
    { name: 'SHA256SUMS-Linux.txt', browser_download_url: `${BASE}/SHA256SUMS-Linux.txt` },
  ],
};
const ok = (body: unknown): typeof fetch => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

describe('downloadadressen op de website', () => {
  it.each([
    ['windows', 'BoekhoudenVoorNiks-Setup-1.0.0.exe'],
    ['appimage', 'BoekhoudenVoorNiks-1.0.0.AppImage'],
    ['deb', 'gratis-boekhouden_1.0.0_amd64.deb'],
    ['sha256-windows', 'SHA256SUMS-Windows.txt'],
    ['sha256-linux', 'SHA256SUMS-Linux.txt'],
  ])('/download/%s stuurt naar %s, niet naar het blockmap-bestand of de updater', async (kind, file) => {
    const res = await download(kind, ok(release));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${BASE}/${file}`);
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
  });

  it('een nieuwe versie hoeft niets op de website te veranderen', async () => {
    const next = { ...release, assets: release.assets.map((a) => ({ ...a, name: a.name.replace('1.0.0', '1.2.0'), browser_download_url: a.browser_download_url.replace(/1\.0\.0/g, '1.2.0') })) };
    expect((await download('windows', ok(next))).headers.get('location')).toContain('BoekhoudenVoorNiks-Setup-1.2.0.exe');
  });

  it('GitHub onbereikbaar, een concept of een vooruitgeschoven release: de releasepagina als noodgreep', async () => {
    const page = 'https://github.com/shipdocs/boekhoudenvoorniks/releases/latest';
    const failing = (async () => new Response('nee', { status: 500 })) as unknown as typeof fetch;
    const broken = (async () => { throw new Error('geen netwerk'); }) as unknown as typeof fetch;
    expect((await download('windows', failing)).headers.get('location')).toBe(page);
    expect((await download('windows', broken)).headers.get('location')).toBe(page);
    expect((await download('windows', ok({ ...release, draft: true }))).headers.get('location')).toBe(page);
    expect((await download('windows', ok({ ...release, prerelease: true }))).headers.get('location')).toBe(page);
  });

  it('stuurt nooit naar een adres buiten de releases van dit project', async () => {
    const evil = { ...release, assets: [{ name: 'BoekhoudenVoorNiks-Setup-9.9.9.exe', browser_download_url: 'https://example.com/virus.exe' }] };
    expect((await download('windows', ok(evil))).headers.get('location')).toBe('https://github.com/shipdocs/boekhoudenvoorniks/releases/latest');
  });

  it('een onbekende download geeft 404', async () => {
    expect((await download('../../etc/passwd', ok(release))).status).toBe(404);
    expect((await download('mac', ok(release))).status).toBe(404);
  });

  it('de Worker zelf: /download/windows verwijst door en /download gaat naar de downloadpagina', async () => {
    const env = { ASSETS: { fetch: async () => new Response('pagina') } };
    const real = globalThis.fetch;
    globalThis.fetch = ok(release);
    try {
      const res = await worker.fetch(new Request('https://boekhoudenvoorniks.nl/download/windows'), env);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(`${BASE}/BoekhoudenVoorNiks-Setup-1.0.0.exe`);
    } finally {
      globalThis.fetch = real;
    }
    const index = await worker.fetch(new Request('https://boekhoudenvoorniks.nl/download'), env);
    expect(index.headers.get('location')).toBe('https://boekhoudenvoorniks.nl/downloaden.html');
    const post = await worker.fetch(new Request('https://boekhoudenvoorniks.nl/download/windows', { method: 'POST' }), env);
    expect(post.status).not.toBe(302);
  });
});
